// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Assembles THE canonical admin status payload (admin IA redesign, spec §5).
 *
 * One GET (/api/admin/status) now serves what used to be three endpoints
 * (/api/admin/status, /api/admin/status/extras, GET /api/admin/attention).
 * Every admin surface — bell, Home, Health, nav status dots — reads this one
 * payload, so no two surfaces can ever disagree.
 *
 * Caching strategy (all single-flight, all pre-existing):
 *  - system block:   per-replica cache (admin-status-cache, 20 s TTL) because it
 *                     embeds replica-local diagnostics (workerState, watcher).
 *  - attention:      global cache (attention-cache, 20 s TTL), with plugin
 *                     lifecycle notices joined locally AFTER the cache.
 *  - extras block:   global cache here (60 s TTL) — versions barely change and
 *                     the underlying probes carry their own 5–10 min caches.
 *  - counters/sessions: computed inline per call — cheap indexed aggregates.
 */

import { joinUpstreamUrl } from '$lib/shared/upstream-url.js';
import { buildJellyfinAuthHeaders } from '$lib/server/jellyfin/auth-headers.js';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import { config, shouldStartWorkers } from '$lib/server/config.js';
import { getAiConfig } from '$lib/server/config/domains/ai.js';
import { getAdminDb } from '$lib/server/database/connection.js';
import { connectValkey, getValkeyClient, getCoordinationClient } from '$lib/server/cache/valkey.js';
import { InfoOptions } from '@valkey/valkey-glide';
import { operationMode } from '$lib/server/operation-mode.js';
import { canCallJellyfin } from '$lib/server/jellyfin/runtime-gate.js';
import { checkBinary } from '$lib/server/health/playback-health.js';
import { getCachedDependencyChecks } from '$lib/server/preflight/dependency-checks-cache.js';
import type { DependencyFinding } from '$lib/server/preflight/dependency-checks.js';
import { countActiveUsers } from '$lib/server/database/queries/active-users.queries.js';
import { getSystemStatusStats } from '$lib/server/database/queries/system-status.queries.js';
import { getMediaBrowserStats } from '$lib/server/database/queries/admin-media.queries.js';
import {
    getAllActiveSessionsWithMedia,
    getLastEndedSession,
} from '$lib/server/database/queries/play-sessions.queries.js';
import { bandwidthTracker } from '$lib/server/services/bandwidth-tracker.service.js';
import { glanceSessions } from '$lib/shared/session-state.js';
import type { AdminPlaySession } from '$lib/schemas/api-admin-responses';
import type { FFmpegJobInfo } from '$lib/types/admin-metrics';
import {
    getTaskCounters,
    getLibraryTotalSizeBytes,
} from '$lib/server/database/queries/admin-status-payload.queries.js';
import { getOrComputeAdminStatus } from '$lib/server/services/admin-status-cache.js';
import {
    getClusterCore,
    type ClusterCore,
} from '$lib/server/services/admin-cluster-core.service.js';
import { loadUncleanExits } from '$lib/server/database/queries/attention.queries.js';
import { summarizeCluster } from '$lib/utils/admin/cluster-glance.js';
import { getOrComputeAttention } from '$lib/server/services/attention/attention-cache.js';
import { getAttention } from '$lib/server/services/attention/attention-service.js';
import { readPluginRestartAttention } from './attention/plugin-restart.js';
import { summarize } from './attention/reconcile.js';
import { PLUGIN_RESTART_ATTENTION_ID } from '$lib/shared/attention-persistent.js';
import { getSessionReadModel } from '$lib/server/services/session-read-model.service.js';
import { detectFormFactor } from '$lib/utils/user-agent.js';
import { getOrComputeSingleFlight } from '$lib/server/cache/single-flight.js';
import {
    type LumastraChecks,
    type AdminStatusResponse,
    type AdminStatusExtrasResponse,
} from '$lib/schemas/api-admin-responses.js';
import type {
    AttentionResponse,
    AttentionItem,
    AttentionVerdict,
} from '$lib/schemas/api-attention-responses.js';
import type {
    AdminStatusPayload,
    AdminSectionId,
    ClusterGlance,
    NowPlayingRow,
} from '$lib/schemas/api-admin-status-payload.js';
import { sectionForItem } from '$lib/shared/attention-section-map.js';
import { withAttentionDomain } from '$lib/shared/attention-domain.js';

const logger = Logger.for('admin-status-payload');

// ============================================================================
// System block (moved verbatim from defs/admin/ops/status.ts)
// ============================================================================

/**
 * Attach the cached dependency-check result to each service it probes (finding
 * ids equal the service keys). Never blocks on a cold cache: a service without a
 * probe result simply has none, and the UI shows it as "configured, not checked".
 */
async function attachServiceProbes(
    services: Record<string, { configured: boolean; probe?: { status: 'pass' | 'warn' } }>,
    sql: postgres.Sql | null,
): Promise<void> {
    let findings: DependencyFinding[];
    try {
        findings = await getCachedDependencyChecks(sql ?? undefined);
    } catch {
        return; // warming or failed: no probe data this round
    }
    for (const f of findings) {
        const service = services[f.id];
        if (service?.configured) service.probe = { status: f.status };
    }
}

async function runLumastraChecks(sql: postgres.Sql | null): Promise<LumastraChecks> {
    const ffmpeg = checkBinary(config.FFMPEG_PATH);
    const ffprobe = checkBinary(config.FFPROBE_PATH);
    const essentia = checkBinary(
        process.env.ESSENTIA_EXTRACTOR_PATH || '/usr/local/bin/essentia_streaming_extractor_music',
    );
    const hlsAvailable = true;

    let fileAccess = {
        ok: false,
        accessible: 0,
        total: 0,
        message: 'No files in DB',
    };
    if (sql) {
        try {
            let rows = await sql<{ file_path: string }[]>`
                SELECT file_path FROM media_files TABLESAMPLE SYSTEM (1) LIMIT 10
            `;
            if (rows.length === 0) {
                rows = await sql<{ file_path: string }[]>`
                    SELECT file_path FROM media_files LIMIT 10
                `;
            }
            if (rows.length > 0) {
                const accessible = rows.filter((r) => {
                    try {
                        fs.accessSync(r.file_path, fs.constants.R_OK);
                        return true;
                    } catch {
                        return false;
                    }
                }).length;
                fileAccess = {
                    ok: accessible > 0,
                    accessible,
                    total: rows.length,
                    message:
                        accessible === rows.length
                            ? 'All sampled files accessible'
                            : accessible === 0
                              ? 'No sampled files accessible — check volume mounts'
                              : `${accessible}/${rows.length} sampled files accessible`,
                };
            }
        } catch (err) {
            logger.warn('Lumastra file access check failed', { err });
            fileAccess = {
                ok: false,
                accessible: 0,
                total: 0,
                message: 'Check failed',
            };
        }
    }

    let watcher: LumastraChecks['watcher'];
    try {
        const { fileScannerMediaSource } =
            await import('$lib/server/tasks/builtin/native/media-sources/file-scanner.js');
        const { buildPluginContext } = await import('$lib/server/tasks/plugin-context.js');
        const getWatcherStatus = async () => {
            const ctx = buildPluginContext('file-scanner');
            return fileScannerMediaSource.getWatcherStatus!(ctx);
        };
        const status = await getWatcherStatus();
        watcher = {
            active: status.active,
            paths: status.paths,
            lastEventAt: status.lastEventAt?.toISOString(),
            lastEventFile: status.lastEventFile,
            leaderElsewhere: status.leaderElsewhere,
            leaderHeartbeatAt: status.leaderHeartbeatAt,
            leaderError: status.leaderError,
            coverage: status.coverage,
            limitations: status.limitations,
            networkReconcileSecs: status.networkReconcileSecs,
        };
    } catch {
        // File scanner plugin may not be loaded
    }

    let inotifyLimit: LumastraChecks['inotifyLimit'];
    if (process.platform === 'linux') {
        try {
            const maxWatches = parseInt(
                fs.readFileSync('/proc/sys/fs/inotify/max_user_watches', 'utf8').trim(),
            );
            const recommended = 524288;
            inotifyLimit = {
                ok: maxWatches >= recommended,
                current: maxWatches,
                recommended,
                message:
                    maxWatches >= recommended
                        ? `inotify limit configured (${maxWatches.toLocaleString()}) — actual availability depends on host-wide usage across all processes`
                        : `inotify limit low (${maxWatches.toLocaleString()}) — set fs.inotify.max_user_watches=${recommended} for large libraries`,
            };
        } catch {
            // Not Linux or no access to /proc — skip silently
        }
    }

    const overallHealthy = ffmpeg.ok && ffprobe.ok && hlsAvailable && fileAccess.ok;

    return {
        ffmpeg,
        ffprobe,
        essentia,
        hlsAvailable,
        fileAccess,
        watcher,
        inotifyLimit,
        overallHealthy,
    };
}

/** Compute the (serialized) system block — the pre-redesign /api/admin/status body. */
export async function computeSystemStatusBody(): Promise<string> {
    const sql = getAdminDb();

    let databaseHealthy = false;
    let databaseVersion = '';
    let systemStats = {
        totalMediaItems: 0,
        libraryEmbeddings: 0,
        primaryProviderEmbeddings: 0,
        bothEmbeddings: 0,
        totalUsers: 0,
        totalSuggestions: 0,
    };

    if (sql) {
        try {
            const versionResult = await sql<{ version: string }[]>`SELECT version()`;
            databaseHealthy = true;
            const fullVersion = versionResult[0]?.version || '';
            const versionMatch = fullVersion.match(/^PostgreSQL [\d.]+/);
            databaseVersion = versionMatch ? versionMatch[0] : fullVersion.split(' on ')[0];

            try {
                const pgvectorResult = await sql<{ extversion: string }[]>`
                    SELECT extversion FROM pg_extension WHERE extname = 'vector'
                `;
                if (pgvectorResult[0]?.extversion) {
                    databaseVersion += ` + pgvector ${pgvectorResult[0].extversion}`;
                }
            } catch {
                // pgvector may not be installed
            }

            systemStats = await getSystemStatusStats(sql);
        } catch (dbError) {
            logger.warn('Database health check failed', { error: dbError });
            databaseHealthy = false;
        }
    }

    const aiHealthy = databaseHealthy;

    let valkeyHealthy = false;
    let valkeyVersion = '';
    try {
        // connectValkey() reports the required task Valkey; the cache is optional.
        valkeyHealthy = await connectValkey();
        if (valkeyHealthy) {
            const client = getCoordinationClient() ?? getValkeyClient();
            if (client) {
                const info = await client.info([InfoOptions.Server]);
                const infoStr = typeof info === 'string' ? info : String(info || '');
                const valkeyMatch = infoStr.match(/valkey_version:(\S+)/);
                const redisMatch = infoStr.match(/redis_version:(\S+)/);
                if (valkeyMatch) {
                    valkeyVersion = `Valkey ${valkeyMatch[1]}`;
                } else if (redisMatch) {
                    valkeyVersion = `Redis ${redisMatch[1]}`;
                }
            }
        }
    } catch (valkeyError) {
        logger.warn('Valkey health check failed', { error: valkeyError });
    }

    const lumastraChecks = await runLumastraChecks(sql);

    const ai = getAiConfig();
    const services = {
        jellyfin: { configured: operationMode.isJellyfinEnabled, label: 'Jellyfin' },
        tmdb: { configured: !!config.TMDB_API_KEY, label: 'TMDB' },
        mdblist: { configured: !!config.MDBLIST_API_KEY, label: 'MDBList' },
        jellyseerr: {
            configured: !!config.SEERRURL && !!config.SEERRAPIKEY,
            label: 'Seerr',
        },
        sonarr: { configured: !!config.SONARRURL && !!config.SONARRAPIKEY, label: 'Sonarr' },
        radarr: { configured: !!config.RADARRURL && !!config.RADARRAPIKEY, label: 'Radarr' },
        audiobookshelf: {
            configured: !!config.AUDIOURL && !!config.AUDIOAPIKEY,
            label: 'Audiobookshelf',
        },
        openai: { configured: ai.hasOpenai, label: 'OpenAI' },
        voyage: { configured: ai.hasVoyage, label: 'Voyage AI' },
        trickplay: { configured: config.TRICKPLAY_ENABLED, label: 'Self-Generated Trickplay' },
    };
    await attachServiceProbes(services, sql);

    const statusData = {
        aiHealthy,
        databaseHealthy,
        databaseVersion,
        valkeyHealthy,
        valkeyVersion,
        totalMediaItems: systemStats.totalMediaItems,
        libraryEmbeddings: systemStats.libraryEmbeddings,
        primaryProviderEmbeddings: systemStats.primaryProviderEmbeddings,
        bothEmbeddings: systemStats.bothEmbeddings,
        totalUsers: systemStats.totalUsers,
        totalSuggestions: systemStats.totalSuggestions,
        services,
        databaseUrlConfigured: !!process.env.DATABASE_URL,
        databaseConnectionAvailable: !!sql,
        tablesChecked: !!sql,
        trickplayStats: null,
        lumastraChecks,
        workerState: {
            configured: config.WORKER_MODE,
            workersActive: shouldStartWorkers(),
        },
        setupInstructions:
            !aiHealthy || !databaseHealthy
                ? {
                      databaseNotConnected: !sql
                          ? 'Please ensure DATABASE_URL is configured and PostgreSQL is running'
                          : null,
                      missingTables:
                          sql && !databaseHealthy
                              ? 'Run npm run startup-migration to initialize database tables'
                              : null,
                      exampleDatabaseUrl: 'postgresql://lumastra:password@localhost:5432/lumastra',
                  }
                : null,
    };

    return JSON.stringify(statusData);
}

// ============================================================================
// Extras block (moved from defs/admin/ops/status-extras.ts, now served inline)
// ============================================================================

const versionCache = new Map<string, { version: string | undefined; ts: number }>();
const VERSION_CACHE_TTL = 300_000; // 5 minutes

function getCachedBinaryVersion(
    binPath: string,
    parser?: (output: string) => string | undefined,
): string | undefined {
    const cached = versionCache.get(binPath);
    if (cached && Date.now() - cached.ts < VERSION_CACHE_TTL) return cached.version;

    let version: string | undefined;
    try {
        const output = execFileSync(binPath, ['-version'], { encoding: 'utf-8', timeout: 3000 });
        const firstLine = output.split('\n')[0]?.trim() ?? '';
        version = parser ? parser(firstLine) : firstLine || undefined;
    } catch {
        version = undefined;
    }
    versionCache.set(binPath, { version, ts: Date.now() });
    return version;
}

const serviceVersionCache = new Map<string, { version: string | undefined; ts: number }>();
const SERVICE_VERSION_TTL = 600_000; // 10 minutes

async function getServiceVersion(
    key: string,
    fetcher: () => Promise<string | undefined>,
): Promise<string | undefined> {
    const cached = serviceVersionCache.get(key);
    if (cached && Date.now() - cached.ts < SERVICE_VERSION_TTL) return cached.version;

    let version: string | undefined;
    try {
        version = await fetcher();
    } catch {
        version = undefined;
    }
    serviceVersionCache.set(key, { version, ts: Date.now() });
    return version;
}

/**
 * Serves Jellyfin (`Authorization: MediaBrowser`), Jellyseerr/Sonarr/Radarr (`X-Api-Key`),
 * and Audiobookshelf (`Bearer`) — every one of them an admin-configured,
 * credentialed host. Routed through the
 * same-origin-only redirect guard (C22 fix-plan finding).
 */
async function fetchJsonVersion(
    url: string,
    headers: Record<string, string>,
    extract: (data: Record<string, unknown>) => string | undefined,
): Promise<string | undefined> {
    const res = await fetchWithTimeout(url, { headers }, 5000);
    if (!res.ok) return undefined;
    const data = (await res.json()) as Record<string, unknown>;
    return extract(data);
}

export async function fetchServiceVersions(): Promise<Record<string, string | undefined>> {
    const versions: Record<string, string | undefined> = {};

    const tasks: Array<{ key: string; fn: () => Promise<string | undefined> }> = [];

    // Only when the optional Jellyfin sync is on and Jellyfin is reachable:
    // a configured URL + key alone must not make the admin dashboard call it.
    if (canCallJellyfin()) {
        tasks.push({
            key: 'jellyfin',
            fn: () =>
                fetchJsonVersion(
                    joinUpstreamUrl(config.JELLYFINURL, `/System/Info`),
                    buildJellyfinAuthHeaders({ token: config.JELLYFINAPIKEY }),
                    (d) => (d.Version as string) || undefined,
                ),
        });
    }

    if (config.SEERRURL && config.SEERRAPIKEY) {
        tasks.push({
            key: 'jellyseerr',
            fn: () =>
                fetchJsonVersion(
                    `${config.SEERRURL}/api/v1/status`,
                    { 'X-Api-Key': config.SEERRAPIKEY },
                    (d) => (d.version as string) || undefined,
                ),
        });
    }

    if (config.SONARRURL && config.SONARRAPIKEY) {
        tasks.push({
            key: 'sonarr',
            fn: () =>
                fetchJsonVersion(
                    `${config.SONARRURL}/api/v3/system/status`,
                    { 'X-Api-Key': config.SONARRAPIKEY },
                    (d) => (d.version as string) || undefined,
                ),
        });
    }

    if (config.RADARRURL && config.RADARRAPIKEY) {
        tasks.push({
            key: 'radarr',
            fn: () =>
                fetchJsonVersion(
                    `${config.RADARRURL}/api/v3/system/status`,
                    { 'X-Api-Key': config.RADARRAPIKEY },
                    (d) => (d.version as string) || undefined,
                ),
        });
    }

    if (config.AUDIOURL && config.AUDIOAPIKEY) {
        tasks.push({
            key: 'audiobookshelf',
            fn: () =>
                fetchJsonVersion(
                    joinUpstreamUrl(config.AUDIOURL, `/status`),
                    { Authorization: `Bearer ${config.AUDIOAPIKEY}` },
                    (d) => (d.serverVersion as string) || (d.version as string) || undefined,
                ),
        });
    }

    await Promise.all(
        tasks.map(async ({ key, fn }) => {
            versions[key] = await getServiceVersion(key, fn);
        }),
    );

    return versions;
}

async function computeExtrasBody(sql: postgres.Sql | null): Promise<string> {
    const [serviceVersions, mediaBrowserStats] = await Promise.all([
        fetchServiceVersions(),
        sql ? getMediaBrowserStats(sql).catch(() => undefined) : Promise.resolve(undefined),
    ]);

    const binaryVersions: Record<string, string | undefined> = {
        ffmpeg: getCachedBinaryVersion(config.FFMPEG_PATH, (out) => {
            const m = out.match(/ffmpeg version (\S+)/);
            return m ? m[1] : undefined;
        }),
        ffprobe: getCachedBinaryVersion(config.FFPROBE_PATH, (out) => {
            const m = out.match(/ffprobe version (\S+)/);
            return m ? m[1] : undefined;
        }),
        essentia: getCachedBinaryVersion(
            process.env.ESSENTIA_EXTRACTOR_PATH ||
                '/usr/local/bin/essentia_streaming_extractor_music',
            (out) => {
                const m = out.match(/[Ee]ssentia.*?(\d+\.\d+[\w.-]*)/);
                return m ? m[1] : undefined;
            },
        ),
    };

    const extras: AdminStatusExtrasResponse = {
        serviceVersions,
        binaryVersions,
        libraryCounts: mediaBrowserStats
            ? {
                  movies: mediaBrowserStats.movies,
                  series: mediaBrowserStats.series,
                  musicTracks: mediaBrowserStats.tracks,
              }
            : undefined,
    };
    return JSON.stringify(extras);
}

/** Extras change slowly (versions, coarse library counts) — 60 s shared cache. */
const EXTRAS_CACHE_KEY = 'v2:admin:status-extras';
const EXTRAS_CACHE_TTL_S = 60;
/**
 * Library size is a SUM over every row of `media_files` — a full scan that used
 * to run on every 30 s poll from every open admin tab. It moves only as scans
 * land, so a few minutes of staleness on one Home tile is the right trade.
 */
const LIBRARY_SIZE_CACHE_KEY = 'v1:admin:status:library-size-bytes';
const LIBRARY_SIZE_CACHE_TTL_S = 300;

// ============================================================================
// Section status derivation (nav dots)
// ============================================================================

const SEVERITY_TO_VERDICT: Record<string, AttentionVerdict> = {
    critical: 'critical',
    warning: 'degraded',
};

const VERDICT_RANK: Record<AttentionVerdict, number> = {
    healthy: 0,
    degraded: 1,
    critical: 2,
};

// `sectionForItem` moved to `$lib/shared/attention-section-map.js` (pure,
// dependency-free) so the client can filter attention items to a section
// landing page using the SAME mapping this module uses to derive
// `sectionStatus`. Re-exported here for backward compatibility with existing
// importers of this module.
export { sectionForItem };

/**
 * Per-nav-section worst verdict, derived from the open attention items.
 * Mirrors the global verdict semantics (reconcile.ts): acked or snoozed items
 * don't light dots, and `info` never degrades.
 */
export function deriveSectionStatus(
    items: AttentionItem[],
): Record<AdminSectionId, AttentionVerdict> {
    const status: Record<AdminSectionId, AttentionVerdict> = {
        home: 'healthy',
        library: 'healthy',
        tasks: 'healthy',
        system: 'healthy',
        users: 'healthy',
        settings: 'healthy',
        developer: 'healthy',
    };
    for (const item of items) {
        if (item.acked || item.snoozed) continue;
        const verdict = SEVERITY_TO_VERDICT[item.severity];
        if (!verdict) continue; // info never degrades
        const section = sectionForItem(item);
        if (VERDICT_RANK[verdict] > VERDICT_RANK[status[section]]) {
            status[section] = verdict;
        }
    }
    return status;
}

// ============================================================================
// Payload assembly
// ============================================================================

/** Coarse delivery chip: anything that isn't full direct play reads as transcode. */
function coarsePlayMethod(playMethod: string | undefined): 'direct' | 'transcode' | undefined {
    if (!playMethod) return undefined;
    return playMethod === 'direct' ? 'direct' : 'transcode';
}

/**
 * Measured throughput when the tracker has it; otherwise the declared stream
 * bitrate of a PLAYING session. The tracker only sees bytes this app proxies,
 * so a Jellyfin direct play (or an idle gap between segment fetches) reads as
 * nothing and the tile said "0.0 Mbps out" beside a table row showing 11.2 Mbps
 * — same fallback as buildStreamingSummary.
 */
export function glanceBandwidthMbps(
    measured: number | undefined,
    s: { isPlaying: boolean; bitrateKbps?: number | null },
): number | undefined {
    if (measured != null && measured > 0) return measured;
    if (s.isPlaying && s.bitrateKbps != null && s.bitrateKbps > 0) {
        return Math.round(s.bitrateKbps / 100) / 10;
    }
    return measured ?? undefined;
}

/**
 * Per-session glance for Home's tile + strip, computed with the SAME rules the
 * Active sessions table uses (glanceSessions → isStruggling), from the same
 * inputs the admin play-sessions endpoint enriches with: the DB row (buffer,
 * plan), the cross-pod bandwidth tracker, and the FFmpeg job list. Home keeps
 * making no fetches of its own; a failure here only drops the glance fields.
 */
async function computeSessionGlance(
    live: Awaited<ReturnType<ReturnType<typeof getSessionReadModel>['getAllActive']>>,
): Promise<ReturnType<typeof glanceSessions> | null> {
    const sql = getAdminDb();
    if (!sql || live.length === 0) return null;
    const [rows, jobs] = await Promise.all([
        getAllActiveSessionsWithMedia(sql),
        import('$lib/server/services/ffmpeg-transcode.service.js')
            .then(({ getFFmpegTranscodeService }) =>
                getFFmpegTranscodeService().getAllActiveJobsInfoMultiPod(),
            )
            .catch((): FFmpegJobInfo[] => []),
    ]);
    const rowById = new Map(rows.map((r) => [r.id, r]));
    const bandwidth = await bandwidthTracker.getAggregatedSessionBandwidthMap();
    // Only the fields the derivations read; the rest of AdminPlaySession is
    // presentation the glance never looks at.
    const asAdminSessions = live.map((s): AdminPlaySession => {
        const row = rowById.get(s.sessionId);
        return {
            __id: s.sessionId,
            username: s.username,
            title: s.title ?? '',
            clientname: '',
            browsername: '',
            playIsPlaying: s.isPlaying,
            playCurrentTime: s.positionMs / 1000,
            playMethod: s.playMethod,
            plan_mode: row?.plan_mode ?? undefined,
            buffer_health_sec: row?.buffer_health_sec ?? undefined,
            bandwidth_mbps: glanceBandwidthMbps(bandwidth.get(s.sessionId), s),
        };
    });
    return glanceSessions(asAdminSessions, jobs, config.FFMPEG_SEGMENT_DURATION);
}

export async function getSessionsBlock(): Promise<AdminStatusPayload['sessions']> {
    const sessions = await getSessionReadModel().getAllActive({ admin: true, includeStale: false });
    const glance = await computeSessionGlance(sessions).catch((err: unknown) => {
        logger.warn('session glance failed; serving rows without load/struggling', { err });
        return null;
    });
    const preview: NowPlayingRow[] = sessions.map((s) => ({
        sessionId: s.sessionId,
        username: s.username,
        title: s.title ?? '',
        progressPercent:
            s.runtimeMs != null && s.runtimeMs > 0
                ? Math.min(100, Math.max(0, (s.positionMs / s.runtimeMs) * 100))
                : undefined,
        playMethod: coarsePlayMethod(s.playMethod),
        source: s.source,
        isCompat:
            s.source === 'lumastra' &&
            (s.device?.deviceId?.startsWith('jellyfin-compat-') ?? false),
        formFactor: detectFormFactor(s.device?.name, s.device?.client),
        bitrateKbps: s.bitrateKbps,
        resolution: s.resolution,
        seriesName: s.seriesName,
        seasonNumber: s.seasonNumber,
        episodeNumber: s.episodeNumber,
        isPaused: !s.isPlaying,
        posterMediaId: s.seriesId ?? s.mediaId,
        struggling: glance?.bySession.get(s.sessionId)?.struggling,
        transcoding: glance?.bySession.get(s.sessionId)?.transcoding,
        bandwidthMbps: glance?.bySession.get(s.sessionId)?.bandwidthMbps,
        encodeSpeed: glance?.bySession.get(s.sessionId)?.delivery.encodeSpeed,
    }));
    if (sessions.length > 0) {
        return {
            count: sessions.length,
            preview,
            load: glance
                ? {
                      transcoding: glance.totals.transcoding,
                      struggling: glance.totals.struggling,
                      bandwidthMbps: glance.totals.bandwidthMbps,
                  }
                : undefined,
        };
    }
    // Idle: say who watched last instead of an empty line.
    const sql = getAdminDb();
    const last = sql
        ? await getLastEndedSession(sql).catch((err: unknown) => {
              logger.warn('last-ended session lookup failed; omitting', { err });
              return null;
          })
        : null;
    return {
        count: 0,
        preview,
        lastEnded: last
            ? {
                  username: last.username,
                  title: last.title ?? undefined,
                  endedAt: last.stopped_at.toISOString(),
              }
            : undefined,
    };
}

/**
 * The cluster core recomputes at most once per 15 s cluster-wide, but a cold
 * recompute waits on the sidecar probe (2 s timeout). Home must not wait on it,
 * so a slow read drops the tile for one poll instead of delaying the payload.
 */
const CLUSTER_GLANCE_TIMEOUT_MS = 1_500;
const UNCLEAN_EXITS_CACHE_KEY = 'v1:admin:status:unclean-exits-24h';
const UNCLEAN_EXITS_CACHE_TTL_S = 60;

/**
 * Unclean exits of live services in 24 h, deploy waves excluded — the same rule
 * (and query) as the `unclean-exits:` attention items, so the tile and the
 * attention list never disagree about whether a deploy was a crash. 0 when unknown.
 */
async function readUncleanExitCount(): Promise<number> {
    const sql = getAdminDb();
    if (!sql) return 0;
    return getOrComputeSingleFlight({
        cacheKey: UNCLEAN_EXITS_CACHE_KEY,
        ttlSeconds: UNCLEAN_EXITS_CACHE_TTL_S,
        compute: async () =>
            String((await loadUncleanExits(sql, 1)).reduce((n, r) => n + r.cnt, 0)),
    })
        .then(Number)
        .catch((err: unknown) => {
            logger.warn('unclean exit count failed; showing none', { err });
            return 0;
        });
}

export interface ClusterGlanceDeps {
    readCore: () => Promise<ClusterCore>;
    readUncleanExits: () => Promise<number>;
    timeoutMs: number;
}

const DEFAULT_GLANCE_DEPS: ClusterGlanceDeps = {
    readCore: getClusterCore,
    readUncleanExits: readUncleanExitCount,
    timeoutMs: CLUSTER_GLANCE_TIMEOUT_MS,
};

/** Last summary, by the core it came from: every tab's poll inside one 15 s core reuses it. */
let lastGlance: { key: string; glance: ClusterGlance } | null = null;

/** Home's cluster tile, from the cluster view's shared cache; undefined when unreadable. */
export async function getClusterGlance(
    deps: ClusterGlanceDeps = DEFAULT_GLANCE_DEPS,
): Promise<ClusterGlance | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), deps.timeoutMs);
    });
    // The race does not cancel the losing read: give it its own catch so a late
    // rejection after a timeout is not an unhandled rejection.
    try {
        const read = Promise.all([deps.readCore(), deps.readUncleanExits()]);
        read.catch(() => undefined);
        const result = await Promise.race([read, timeout]);
        if (!result) {
            logger.debug('cluster glance timed out; omitting this poll');
            return undefined;
        }
        const [core, unclean] = result;
        // An empty core is "could not see the cluster" (unparseable cache entry,
        // Valkey down) — we are a live node ourselves — never a calm 0/0.
        if (core.nodes.length === 0) return undefined;
        const key = `${core.generatedAt ?? ''}|${unclean}`;
        if (lastGlance?.key === key) return lastGlance.glance;
        const glance = summarizeCluster({ ...core, selfInstanceId: config.INSTANCE_ID }, unclean);
        lastGlance = { key, glance };
        return glance;
    } catch (err) {
        logger.warn('cluster glance failed; omitting', { err });
        return undefined;
    } finally {
        clearTimeout(timer);
    }
}

/** Test seam. */
export function resetClusterGlanceForTests(): void {
    lastGlance = null;
}

/**
 * Assemble the canonical admin status payload. Throws when the underlying
 * system-status computation fails entirely (the route maps that to 503);
 * supplementary blocks degrade gracefully to zeros/undefined instead.
 */
export async function getAdminStatusPayload(): Promise<AdminStatusPayload> {
    const sql = getAdminDb();
    const nowIso = new Date().toISOString();

    const [
        systemBody,
        attentionBody,
        extrasBody,
        sessionsBlock,
        taskCounters,
        librarySizeBytes,
        clusterGlance,
        activeUsers30d,
        pluginRestarts,
    ] = await Promise.all([
        getOrComputeAdminStatus(config.INSTANCE_ID, computeSystemStatusBody),
        sql
            ? getOrComputeAttention(true, async () =>
                  JSON.stringify(
                      await getAttention(sql, { includeOps: true, includePluginRestarts: false }),
                  ),
              ).catch((err: unknown) => {
                  logger.warn('attention block failed; serving empty attention', { err });
                  return null;
              })
            : Promise.resolve(null),
        getOrComputeSingleFlight({
            cacheKey: EXTRAS_CACHE_KEY,
            ttlSeconds: EXTRAS_CACHE_TTL_S,
            compute: () => computeExtrasBody(sql),
        }).catch((err: unknown) => {
            logger.warn('extras block failed; omitting', { err });
            return null;
        }),
        getSessionsBlock().catch((err: unknown) => {
            logger.warn('sessions block failed; serving empty preview', { err });
            return { count: 0, preview: [] as NowPlayingRow[] };
        }),
        sql
            ? getTaskCounters(sql).catch((err: unknown) => {
                  logger.warn('task counters failed; serving zeros', { err });
                  return { running: 0, ranToday: 0, failedRuns24h: 0 };
              })
            : Promise.resolve({ running: 0, ranToday: 0, failedRuns24h: 0 }),
        sql
            ? getOrComputeSingleFlight({
                  cacheKey: LIBRARY_SIZE_CACHE_KEY,
                  ttlSeconds: LIBRARY_SIZE_CACHE_TTL_S,
                  compute: async () => String(await getLibraryTotalSizeBytes(sql)),
              })
                  .then(Number)
                  .catch((err: unknown) => {
                      logger.warn('library size failed; omitting', { err });
                      return undefined;
                  })
            : Promise.resolve(undefined),
        getClusterGlance(),
        sql
            ? countActiveUsers(sql, 30).catch((err: unknown) => {
                  logger.warn('monthly active user count failed; omitting', { err });
                  return undefined;
              })
            : Promise.resolve(undefined),
        sql
            ? readPluginRestartAttention(sql, nowIso).catch((err: unknown) => {
                  logger.warn('local plugin state unavailable', { err });
                  return null;
              })
            : Promise.resolve([]),
    ]);

    const system = JSON.parse(systemBody) as AdminStatusResponse;
    // Attention unavailable must NEVER render as "healthy" — that's the
    // false-all-clear the attention service itself guards against. When the
    // block can't be computed (no DB / derive blew up), the payload assembler
    // is the one legitimate place to state a verdict: critical without a
    // database, degraded otherwise ("we can't see" ≠ "all is well").
    const attention: AttentionResponse = attentionBody
        ? (JSON.parse(attentionBody) as AttentionResponse)
        : {
              verdict: system.databaseHealthy ? 'degraded' : 'critical',
              items: [],
              unreadCount: 0,
              unavailable: true,
          };
    // A shared cache cannot describe what is loaded on this server. Always
    // replace that one notice with the live comparison, including on cache hits
    // and during a rolling upgrade with an older cached response. Summarize the
    // combined board so badge, verdict and section status all agree.
    const wasCritical = attention.verdict === 'critical';
    const items = [
        ...attention.items.filter((item) => item.id !== PLUGIN_RESTART_ATTENTION_ID),
        ...(pluginRestarts ?? []),
    ];
    const local = { items, ...summarize(items) };
    Object.assign(attention, local);
    if (attention.unavailable || pluginRestarts === null) {
        attention.unavailable = true;
        attention.verdict = wasCritical || local.verdict === 'critical' ? 'critical' : 'degraded';
    }
    const extras = extrasBody ? (JSON.parse(extrasBody) as AdminStatusExtrasResponse) : undefined;

    return {
        generatedAt: new Date().toISOString(),
        verdict: attention.verdict,
        attention: {
            // `domain` is required on the wire and optional on the producing
            // side (see the note on `AttentionItem`). This is the boundary that
            // resolves it, so a client always receives a real domain rather than
            // the `system` schema default — and the type checker enforces that
            // it happens, because `AdminStatusPayload` requires the field.
            items: attention.items.map(withAttentionDomain),
            unreadCount: attention.unreadCount,
            activity: attention.activity,
            recentlyAdded: attention.recentlyAdded,
            resolvedHistory: attention.resolvedHistory?.map(withAttentionDomain),
            unavailable: attention.unavailable,
        },
        system,
        extras,
        sessions: sessionsBlock,
        tasks: taskCounters,
        library: {
            totalItems: system.totalMediaItems,
            totalSizeBytes: librarySizeBytes,
        },
        users: { total: system.totalUsers, active30d: activeUsers30d },
        cluster: clusterGlance,
        sectionStatus: deriveSectionStatus(attention.items),
    };
}
