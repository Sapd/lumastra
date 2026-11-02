// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import type { AttentionResponse } from '$lib/schemas/api-attention-responses';
import { getCircuitFleet } from '$lib/server/tasks/observability/circuit-fleet.service.js';
import {
    LIVENESS_DOMAIN_PREFIXES,
    adaptJellyfinUnlinkedUsers,
    adaptAudiobookshelfUnlinkedUsers,
    adaptPublicBaseUrl,
} from './adapters.js';
import { checkAudiobookshelfUserMatches } from '../audiobookshelf-user-matches.js';
import { loadJellyfinUnlinkedUsers } from '$lib/server/database/queries/attention.queries.js';
import { countMusicHygieneFindings } from '$lib/server/database/queries/music-hygiene.queries.js';
import { DependencyChecksWarmingError } from '$lib/server/preflight/dependency-checks-cache.js';
import {
    loadStuckItems,
    loadDeadLetterItems,
    countReidentifyItems,
} from '$lib/server/database/queries/ingest-map.queries.js';
import {
    loadDeclineLoopRows,
    countDeclineLoopRowsByStage,
} from '$lib/server/database/queries/attention.queries.js';
import { countPersonalMediaItems } from '$lib/server/database/queries/media-items.queries.js';
import { countFilesWithHealthIssues } from '$lib/server/database/queries/media-files.queries.js';
import { summarizeOpenViolationsByRule } from '$lib/server/database/queries/integrity-violations.queries.js';
import {
    getLatestCompletedScannerRunPerLibrary,
    getStaleInFlightScannerRuns,
} from '$lib/server/database/queries/file-scanner-runs.queries.js';
import { getLiveTvAvailability } from '$lib/server/services/livetv/availability.service.js';
import { getLiveTvProvider } from '$lib/server/services/livetv/index.js';
import { getAllSources } from '$lib/server/database/queries/livetv-sources.queries.js';
import { summarizeDeadLetterEvents } from '$lib/server/database/queries/event-outbox.queries.js';
import { getOnboardingState } from '$lib/server/database/queries/onboarding.queries.js';
import { buildComponentHealth } from '$lib/server/health/component-health.js';
import { checkPlaybackHealth } from '$lib/server/health/playback-health.js';
import { listAllScheduledTasks } from '$lib/server/tasks/scheduler-state.js';
import { registry } from '$lib/server/tasks/registry.js';
import { computeScheduleOverdue } from '$lib/server/tasks/observability/schedule-overdue.js';
import { readHeartbeats } from '$lib/server/tasks/observability/heartbeat.js';
import { readClassLeaders } from '$lib/server/tasks/observability/leaders.js';
import { listFindings } from '$lib/server/database/queries/health-check-findings.queries.js';
import {
    computeHealthVerdict,
    deriveValkeyAvailable,
} from '$lib/server/tasks/observability/health-verdict.js';
import {
    adaptCircuits,
    adaptDeadLetter,
    adaptOutboxDeadLetter,
    adaptStuck,
    adaptDeclineLoop,
    adaptComponentHealth,
    adaptOnboarding,
    adaptFailedRunSpikes,
    adaptOverdueSchedules,
    adaptTaskLiveness,
    adaptLumastraPlayback,
    adaptOptionalIntegrations,
    selectMissingIntegrations,
    adaptDependencyChecks,
    adaptUnmatched,
    adaptGaveUp,
    adaptFileHealth,
    adaptIntegrity,
    adaptMusicHygiene,
    adaptScanRun,
    adaptPluginFailures,
    adaptPluginUpdates,
    adaptLumastraUpdate,
    adaptStorageCapacity,
    adaptStorageForecast,
    adaptLiveTvAvailability,
    adaptRepeatedRecovery,
    adaptClusterKeyMismatch,
    adaptMasterKey,
    adaptResourcePressure,
    adaptUncleanExits,
    resourcePressureConditions,
    UNCLEAN_EXIT_THRESHOLD,
    adaptLiveTvProxyCompat,
    OPTIONAL_INTEGRATIONS,
    RECOVERY_AUDIT_ACTIONS,
} from './adapters.js';
import { readClusterNodes } from '$lib/server/services/cluster-heartbeat.service.js';
import { appProxyExpectation } from '$lib/server/services/livetv/proxy-compat.js';
import { isCoordinationValkeyReady } from '$lib/server/cache/valkey.js';
import { trackPressureSince } from './pressure-since.js';
import { getCachedDependencyChecks } from '$lib/server/preflight/dependency-checks-cache.js';
import { listPluginSecretKeys } from '$lib/server/database/queries/plugin-secrets.queries.js';
import { hasMusicLibraryOrContent } from '$lib/server/database/queries/music.queries.js';
import { reconcile, itemFromRow, projectPersisted } from './reconcile.js';
import { publishAttentionRender, readAttentionRender } from './attention-cache.js';
import {
    readAllAlerts,
    upsertAlerts,
    resolveAlerts,
    ackAlert,
    snoozeAlert,
    countActiveManualRuns,
    getRecentlyAddedForOps,
    readResolvedHistory,
    loadFailedRunSpikes,
    listRecentlyActiveTaskIds,
    countDeadLetterItemsByStage,
    loadRepeatedSubsystemEvents,
    loadUncleanExits,
} from '$lib/server/database/queries/attention.queries.js';
import type { AttentionRenderMap, DerivedAlert, DeriveOutcome } from './types.js';
import { checkArtworkDiskHeadroom } from '$lib/server/utils/artwork-volume-headroom.js';
import { getLibraryStorageGrowth } from '$lib/server/services/library-storage/library-storage-growth.service.js';
import { listPluginsWithAvailableUpdate } from '$lib/server/database/queries/plugin-repositories.queries.js';
import { countUnresolvedFailuresByPlugin } from '$lib/server/database/queries/plugin-failure-events.queries.js';
import { taskName } from './task-names.js';
import { groupRecentlyAdded } from './recently-added-grouping.js';
import { config } from '$lib/server/config.js';
import { get as getConfigValue } from '$lib/server/config/index.js';
import { isPersistentAttentionId } from '$lib/shared/attention-persistent.js';
import { readPluginRestartAttention } from './plugin-restart.js';
import {
    evaluateStoredUpdate,
    readUpdateState,
} from '$lib/server/services/lumastra-update/check.js';

const logger = Logger.for('AttentionService');

/**
 * A cold cache right after boot is expected, not a failure: the source still
 * protects its alerts (the caller records the prefix), but nothing is wrong.
 */
function isWarmingError(err: unknown): boolean {
    return err instanceof DependencyChecksWarmingError;
}

/**
 * Log a failed signal source and report whether it failed only because it is
 * still warming up (debug) or for a real reason (warn).
 */
function logSourceFailure(prefix: string, reason: unknown): boolean {
    const warming = isWarmingError(reason);
    const meta = { prefix, err: reason instanceof Error ? reason.message : String(reason) };
    if (warming) {
        logger.debug(
            'attention signal source warming up; protecting its alerts from resolution',
            meta,
        );
    } else {
        logger.warn('attention signal source failed; protecting its alerts from resolution', meta);
    }
    return warming;
}

// Fix 12 (OSS): raised from 5 to 10 — a large cold-start routinely produces
// 5+ scattered transient provider retries (TMDB 429s, probe timeouts) per task
// per day, which is normal rather than actionable.
const FAILED_RUN_SPIKE_THRESHOLD = 10;

/**
 * Repeated-recovery auto-promotion threshold: the same autonomous recovery
 * action (orphan reclaim, event requeue, …) firing this many times inside 24 h
 * promotes to a warning — each individual recovery "succeeds", so nothing else
 * ever surfaces the recurring fault it keeps papering over.
 */
const REPEATED_RECOVERY_THRESHOLD = 10;

/**
 * Maximum age of the newest library path (in milliseconds) for the install to be
 * considered "initializing". 48 h is generous enough to cover a large initial ingest
 * (tens-of-thousands of items) while being tight enough that it can NEVER mask a
 * steady-state problem: once the window expires the threshold is irreversibly past.
 */
const INITIALIZING_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Bell-specific overdue grace: wider than the 60s default so a single missed tick
 *  (the bell itself polls every 60s) doesn't light the alert. */
const ATTENTION_OVERDUE_GRACE_MS = 5 * 60 * 1000;
/** A task that started any run within this window is "clearly working" — its
 *  overdue-schedule alert is suppressed (see adaptOverdueSchedules). 90 min covers
 *  short-interval schedules without masking a genuinely dead daily/weekly one. */
const OVERDUE_RECENT_ACTIVITY_MINUTES = 90;

interface AttentionSource {
    prefix: string;
    /**
     * Reuse the last successful result for this long instead of querying every
     * derive cycle. For counts that only move when a scan or an operator writes
     * rows. A failed run caches nothing, so the next cycle retries and the
     * prefix is protected meanwhile exactly as without an interval.
     */
    minIntervalMs?: number;
    run: (sql: postgres.Sql) => Promise<DerivedAlert[]>;
}

/** Last successful result per interval-limited source, keyed by prefix. */
const sourceResultMemo = new Map<string, { at: number; alerts: DerivedAlert[] }>();

/** Test hook: forget memoised source results. */
export function resetAttentionSourceMemo(): void {
    sourceResultMemo.clear();
}

async function runSource(source: AttentionSource, sql: postgres.Sql): Promise<DerivedAlert[]> {
    const interval = source.minIntervalMs;
    if (interval === undefined) return source.run(sql);
    const memo = sourceResultMemo.get(source.prefix);
    if (memo && Date.now() - memo.at < interval) return memo.alerts;
    const alerts = await source.run(sql);
    sourceResultMemo.set(source.prefix, { at: Date.now(), alerts });
    return alerts;
}

/**
 * Each signal source owns an id-namespace prefix. If a source fails, alerts under
 * its prefix are protected from resolution (see reconcile) — "couldn't read" must
 * never be mistaken for "resolved".
 *
 * Sources that need cross-source context (isInitializing, openCircuitTaskIds,
 * activeSpikeTaskIds) are handled separately in `deriveAttention` so the shared
 * state can be computed once and threaded in without restructuring this shape.
 * `overdue-schedule:` and the liveness bridge (LIVENESS_DOMAIN_PREFIXES) are
 * handled separately to receive openCircuitTaskIds / activeSpikeTaskIds
 * (Fix 11, Fix 7).
 */
const SOURCES: readonly AttentionSource[] = [
    {
        prefix: 'settings:master-key:',
        run: async () => deriveMasterKeyAlerts(),
    },
    {
        prefix: 'circuit:',
        run: async (sql: postgres.Sql) => adaptCircuits(await getCircuitFleet(sql)),
    },
    {
        // Disk pressure. Registered here rather than left to /admin/fix alone:
        // a page only answers when someone navigates to it and picks the right
        // symptom, so a volume at 98% would leave the bell silent and /admin
        // green while writes were about to start failing. Running out of disk is
        // the #1 self-hoster failure mode and was, until now, entirely absent
        // from the attention spine.
        //
        // The prefix is narrowed to `:disk:` so this source resolves only its own
        // alerts — `degraded-component:` is shared with component health, and a
        // broader prefix would let a successful disk read false-resolve someone
        // else's finding.
        //
        // Severity is earned inside the adapter (percentage AND absolute free
        // space together, so 5% of a 20TB array stays quiet), which is the whole
        // reason this can be registered without the bell reading nonzero forever.
        prefix: 'degraded-component:disk:',
        // Imported lazily, not at module scope. `problem-derive` is a registered
        // builtin, and scripts/build-sandbox.ts bundles loadBuiltins() for the
        // plugin worker — so a static import here drags host-pressure.ts ->
        // config.service.ts -> `$env/dynamic/private` into that bundle, where the
        // virtual module does not exist after `npm prune --production`. The
        // sandbox prod-import guard fails the build on exactly this, by design.
        run: async () => {
            const [{ readHostPressure }, { adaptDiskPressure }] = await Promise.all([
                import('$lib/server/api/defs/admin/fix/host-pressure.js'),
                import('$lib/server/api/defs/admin/fix/disk-pressure-attention.js'),
            ]);
            return adaptDiskPressure(await readHostPressure());
        },
    },
    {
        // Fix 13 (OSS): fetch true per-stage total count alongside the 20-row
        // sample. The sample is used for detail/firstError only; the total drives
        // the displayed count and countBucket fingerprint so the ack watermark
        // reflects the real population rather than being capped at 20.
        prefix: 'dead-letter:',
        run: async (sql: postgres.Sql) => {
            const [rows, totalCountByStage] = await Promise.all([
                loadDeadLetterItems(sql, 20),
                countDeadLetterItemsByStage(sql),
            ]);
            return adaptDeadLetter(rows, totalCountByStage);
        },
    },
    {
        // Distinct from the ingest-map 'dead-letter:' source above: this one
        // counts dead-lettered pipeline EVENTS (event_outbox), whose silent
        // exhaustion otherwise only shows in the dispatcher logs.
        prefix: 'outbox-dead-letter:',
        run: async (sql: postgres.Sql) =>
            adaptOutboxDeadLetter(await summarizeDeadLetterEvents(sql)),
    },
    {
        prefix: 'degraded-component:',
        run: async (_sql: postgres.Sql) => adaptComponentHealth(await buildComponentHealth()),
    },
    {
        prefix: 'setup-incomplete',
        run: async (sql: postgres.Sql) => adaptOnboarding(await getOnboardingState(sql)),
    },
    {
        prefix: 'settings:public-base-url',
        run: async (_sql: postgres.Sql) =>
            adaptPublicBaseUrl(
                getConfigValue('PUBLIC_BASE_URL'),
                Boolean(config.TRAKT_CLIENT_ID || config.MAL_CLIENT_ID),
            ),
    },
    {
        // Jellyfin accounts the watch-sync pull skipped because no Lumastra user
        // has the same name. Read from the newest pull run (see
        // loadJellyfinUnlinkedUsers), so an empty answer means "none right now".
        prefix: 'settings:jellyfin-unlinked-users',
        run: async (sql: postgres.Sql) => {
            const { count, names } = await loadJellyfinUnlinkedUsers(sql);
            return adaptJellyfinUnlinkedUsers(count, names);
        },
    },
    {
        prefix: 'settings:audiobookshelf-unlinked-users',
        run: async (sql: postgres.Sql) => {
            if (!config.FEATURE_AUDIOBOOKS || !config.AUDIOURL || !config.AUDIOAPIKEY) return [];
            const { unmatchedUsernames } = await checkAudiobookshelfUserMatches(
                sql,
                config.AUDIOURL,
                config.AUDIOAPIKEY,
            );
            return adaptAudiobookshelfUnlinkedUsers(unmatchedUsernames.length, unmatchedUsernames);
        },
    },
    {
        // Optional third-party integrations (Last.fm / Discogs / MDBList) and
        // the optional AI embeddings provider. A correctly-set-up install with
        // NONE of these keys must stay healthy:
        // each missing key emits at most a single `info` nudge (which never
        // degrades the verdict), with a constant `'missing'` fingerprint so an
        // operator ack sticks until the key is actually added. A key supplied
        // via plugin_secrets OR an env/config fallback (MDBList) counts as
        // configured and emits nothing. Music-scoped integrations (Last.fm,
        // Discogs — `scope: 'music'`) are additionally suppressed on installs
        // with no music library/content: a Movies & TV-only install has no
        // use for them, so nagging is noise rather than signal.
        // Entries may also declare `relevantWhen` — the embeddings nudge is
        // suppressed outright when FEATURE_AI_RECOMMENDATIONS is off.
        prefix: 'optional-integration:',
        run: async (sql: postgres.Sql) => {
            const [present, hasMusic] = await Promise.all([
                listPluginSecretKeys(sql).then(
                    (rows) => new Set(rows.map((r) => `${r.pluginId}:${r.key}`)),
                ),
                hasMusicLibraryOrContent(sql),
            ]);
            const missing = selectMissingIntegrations(OPTIONAL_INTEGRATIONS, {
                presentSecretKeys: present,
                hasMusic,
            });
            return adaptOptionalIntegrations(missing);
        },
    },
    {
        // Optional-dependency reachability (sonic-embedder, Live TV proxy, *arr /
        // download / request services, media-library-path readability, config
        // volume). SWR-cached so this 60s derive cycle never runs the live probes
        // inline; a cold cache throws → prefix protected (no false "all clear").
        // An unreachable configured dependency emits a `warning` → verdict degraded.
        prefix: 'optional-dependency:',
        run: async (sql: postgres.Sql) =>
            adaptDependencyChecks(await getCachedDependencyChecks(sql)),
    },
    {
        // Playback binaries (ffmpeg / ffprobe). checkPlaybackHealth caches its
        // X_OK probe for ~5min so this source does NOT spawn the binaries every
        // 60s derive cycle — availability is effectively static per deployment.
        prefix: 'lumastra-playback:',
        run: async (_sql: postgres.Sql) => adaptLumastraPlayback(await checkPlaybackHealth()),
    },
    {
        // Never-matched personal files → one aggregate `info` nudge (a doorway
        // to the Fix-matches workbench, never a verdict-degrading alarm).
        prefix: 'unmatched:',
        // Moves when someone matches or adds files; a few minutes of lag on an
        // `info` nudge is invisible, a 75 ms count every 60 s is not free.
        minIntervalMs: 5 * 60 * 1000,
        run: async (sql: postgres.Sql) => adaptUnmatched(await countPersonalMediaItems(sql)),
    },
    {
        // "Gave up" (permanently unmatchable) items → one aggregate warning.
        // Owns the population the old per-stage dead-letter:reidentify items
        // double-reported; adaptDeadLetter now emits transient failures only.
        prefix: 'gave-up:',
        run: async (sql: postgres.Sql) => adaptGaveUp(await countReidentifyItems(sql)),
    },
    {
        // File-health findings (truncated/corrupt files) → aggregate warning.
        prefix: 'file-health:',
        run: async (sql: postgres.Sql) => adaptFileHealth(await countFilesWithHealthIssues(sql)),
    },
    {
        // Open library-integrity violations → aggregate severity-aware alert.
        prefix: 'integrity:',
        run: async (sql: postgres.Sql) => {
            const { counts, severities } = await summarizeOpenViolationsByRule(sql);
            return adaptIntegrity(counts, severities);
        },
    },
    {
        // Music tagging hygiene → one calm `info` item per non-zero finding.
        //
        // The title-from-filename finding reads `media_items.title_source`, but
        // the track-without-artist count still visits every track (~150 ms on a
        // 31.7k-track catalogue). The numbers only move when a scan writes rows,
        // so it is counted every 15 min rather than every cycle. A count that
        // throws lands this prefix in `failedPrefixes`, which protects the
        // persisted `music-hygiene:` alerts instead of resolving them.
        prefix: 'music-hygiene:',
        minIntervalMs: 15 * 60 * 1000,
        run: async (sql: postgres.Sql) =>
            adaptMusicHygiene(await countMusicHygieneFindings(sql, true)),
    },
    {
        // "What did that scan actually do" (design task 2) — one item per
        // library path's latest scanner run. Two queries, not one: the latest
        // COMPLETED run answers "what did it do", and a separately-detected
        // stale in-flight run (open past the same 2h grace window
        // markAbandonedScannerRuns uses) is what makes a crashed scan
        // reportable at all before the next scan attempt formally marks it —
        // see adaptScanRun's own doc comment for why one query cannot do both.
        prefix: 'scan-run:',
        run: async (sql: postgres.Sql) => {
            const [completed, stale] = await Promise.all([
                getLatestCompletedScannerRunPerLibrary(sql),
                getStaleInFlightScannerRuns(sql),
            ]);
            return adaptScanRun(completed, stale);
        },
    },
    {
        // Items a task itself reported it could not process (design §9 Slice 4,
        // "plugins from plugin_failure_events"). A different population from
        // the dead-letter source above, which counts failed_permanent STAGE
        // rows — measured on preprod, the two overlapped in nothing.
        prefix: 'plugin-failures:',
        run: async (sql: postgres.Sql) =>
            adaptPluginFailures(await countUnresolvedFailuresByPlugin(sql), taskName, (id) => {
                const task = registry.getTask(id);
                return (
                    typeof task?.failures?.retry === 'function' ||
                    (task?.coversStages?.length ?? 0) > 0
                );
            }),
    },
    {
        // Installed plugins with a newer version advertised (design §9 Slice 4,
        // "updates — poll, always info"). The update CHECK task has been
        // writing `available_version` since it shipped with nothing reading it.
        prefix: 'plugin-update:',
        run: async (sql: postgres.Sql) =>
            adaptPluginUpdates(await listPluginsWithAvailableUpdate(sql)),
    },
    {
        // A newer Lumastra release; red while a security release is pending.
        // Evaluated against the running build every cycle, so it clears as
        // soon as an upgraded build is up. Opted out = nothing to show.
        prefix: 'lumastra-update:',
        run: async (sql: postgres.Sql) => deriveLumastraUpdateAlerts(sql),
    },
    {
        // Free space on the volumes we write to (design §4.4's first missing
        // producer). Reuses the memoized headroom check the artwork backfill
        // already gates on, so this adds no extra statfs beyond its 60s cache.
        // No trailing colon: the alert id is exactly 'storage:capacity', and a
        // failed run protects only ids that START WITH the prefix. With the
        // colon a statfs/DB blip resolved the alert and lost its ack.
        prefix: 'storage:capacity',
        run: async (sql: postgres.Sql) => {
            // Its OWN threshold, not the artwork gate's. Sharing one number
            // meant setting the artwork gate to 0 ("download regardless of free
            // space") also switched off the disk-full alert — the alert for the
            // most common real-world self-host failure, disabled as a side
            // effect of an unrelated tuning decision.
            const minFreeGb = Number(config.STORAGE_LOW_SPACE_WARN_GB) || 0;
            if (minFreeGb <= 0) return [];
            const { volumes } = await checkArtworkDiskHeadroom(sql, minFreeGb * 1024 ** 3);
            return adaptStorageCapacity(volumes);
        },
    },
    {
        // A library disk that fills within ~2 months at the current pace. Reads
        // the daily snapshots the worker writes (no statfs here) through the
        // same cached answer the admin home sparkline uses.
        // No trailing colon, for the same reason as storage:capacity above.
        prefix: 'storage:forecast',
        // Snapshots move once a day; the answer behind it is cached 15 min.
        minIntervalMs: 15 * 60_000,
        run: async (sql: postgres.Sql) =>
            adaptStorageForecast((await getLibraryStorageGrowth(sql)).volumes),
    },
    {
        // Live TV source import failures / parse warnings → one item per source.
        prefix: 'livetv-import:',
        run: async (sql: postgres.Sql) => {
            const sources = await getAllSources(sql);
            const provider = await getLiveTvProvider();
            const availability = await getLiveTvAvailability(
                await provider.getChannels(),
                sources.map((s) => s.id),
            );
            if (availability.evidenceUnavailable) throw new Error('Live TV evidence unavailable');
            return adaptLiveTvAvailability(sources, availability);
        },
    },
    {
        // Replicas holding different master keys. Reads Valkey heartbeats
        // rather than `sql` — the only source in this list that does.
        //
        // readClusterNodes() is built on getKeysByPattern, which SWALLOWS a
        // Valkey failure into `[]`. Left alone, an outage would look like "no
        // nodes, therefore no disagreement" and silently RESOLVE a firing
        // critical alert — the exact false-resolve failedPrefixes exists to
        // prevent. So probe liveness first and throw, which puts this prefix
        // in failedPrefixes and protects its alert instead.
        prefix: 'cluster-key-mismatch',
        run: async () => {
            if (!isCoordinationValkeyReady()) {
                throw new Error('Valkey unavailable — cannot read cluster heartbeats');
            }
            const nodes = await readClusterNodes();
            // We are ourselves a live node, so an empty set means the read did
            // not actually observe the cluster. Treat as unknown, not as
            // agreement.
            if (nodes.length === 0) {
                throw new Error('cluster heartbeat read returned no nodes, including self');
            }
            return adaptClusterKeyMismatch(nodes);
        },
    },
    {
        // Sustained memory pressure on a container (vs its cgroup limit) or a
        // machine (MemAvailable). Reads the Valkey heartbeats like the key
        // mismatch source above, with the same liveness guard: an outage must
        // not read as "no pressure" and resolve a firing alert. The clocks that
        // make it "sustained" live in pressure-since.ts.
        prefix: 'resource-pressure:',
        run: async () => {
            if (!isCoordinationValkeyReady()) {
                throw new Error('Valkey unavailable — cannot read cluster heartbeats');
            }
            const nodes = await readClusterNodes();
            if (nodes.length === 0) {
                throw new Error('cluster heartbeat read returned no nodes, including self');
            }
            const now = Date.now();
            const clocks = await trackPressureSince(
                new Map(resourcePressureConditions(nodes).map((c) => [c.key, c])),
                now,
            );
            return adaptResourcePressure(clocks, now);
        },
    },
    {
        // A service that keeps exiting uncleanly (OOM kill, crash), deploy waves
        // excluded in the query.
        prefix: 'unclean-exits:',
        run: async (sql: postgres.Sql) =>
            adaptUncleanExits(await loadUncleanExits(sql, UNCLEAN_EXIT_THRESHOLD)),
    },
    {
        // A Live TV proxy this server cannot work with (own pinned image, left behind by
        // an app update or rollback). Same Valkey guard as above: an outage must not
        // resolve a firing alert.
        prefix: 'livetv-proxy-compat',
        run: async () => {
            if (!isCoordinationValkeyReady()) {
                throw new Error('Valkey unavailable — cannot read cluster heartbeats');
            }
            const nodes = await readClusterNodes();
            if (nodes.length === 0) {
                throw new Error('cluster heartbeat read returned no nodes, including self');
            }
            return adaptLiveTvProxyCompat(nodes, appProxyExpectation(), config.APP_VERSION);
        },
    },
    {
        // Repeated-recovery auto-promotion (spec §5): the same autonomous
        // recovery firing ≥ threshold times in 24h promotes to a warning.
        prefix: 'repeated-recovery:',
        run: async (sql: postgres.Sql) =>
            adaptRepeatedRecovery(
                await loadRepeatedSubsystemEvents(
                    sql,
                    RECOVERY_AUDIT_ACTIONS,
                    REPEATED_RECOVERY_THRESHOLD,
                ),
            ),
    },
] as const;

/**
 * Prefixes for sources handled separately in `deriveAttention` so they can
 * receive cross-source context (isInitializing, openCircuitTaskIds, etc.).
 * Kept as a named constant so the total-failure path in `getAttention` can
 * include them in `failedPrefixes` without listing them inline.
 *
 * Fix 11, Fix 7: overdue-schedule and the liveness bridge moved here so they
 * receive openCircuitTaskIds and activeSpikeTaskIds after both parallel groups
 * settle.
 */
const BACKLOG_SOURCE_PREFIXES: readonly string[] = [
    'stuck-items:',
    'decline-loop:',
    'failed-run-spike:',
    'overdue-schedule:',
    // The liveness bridge no longer emits a single `task-liveness:` prefix — it
    // namespaces by domain, so a transcode invariant stops lighting the Tasks
    // nav dot. Spread the canonical list rather than restating it: a prefix
    // missing here silently un-protects that domain's alerts.
    ...LIVENESS_DOMAIN_PREFIXES,
];

/**
 * EVERY id-namespace prefix this file can produce an alert under — the fixed
 * `SOURCES` fan-out plus the separately-handled backlog/liveness prefixes.
 *
 * Exported so a test can enumerate the PRODUCER side of
 * `attention-section-map.ts`. That map's own guard reads the `startsWith('…')`
 * literals out of the map source and requires each existing BRANCH to be
 * exercised — which only catches "someone added a branch and no test id". It is
 * blind in the direction that actually shipped twice in one plan: a new source
 * whose prefix has NO branch at all falls through to `'system'`, so the item
 * lights the wrong nav dot and lands on Health, and nothing fails. `scan-run:`
 * and `music-hygiene:` both did exactly that.
 *
 * Deriving this from `SOURCES` rather than restating it is the point: a source
 * added to the array above is in this list the same moment, so the new prefix
 * must either classify itself or be named in the test's explicit
 * `INTENTIONALLY_SYSTEM` allowlist.
 */
export const ATTENTION_SOURCE_PREFIXES: readonly string[] = [
    ...SOURCES.map((s) => s.prefix),
    ...BACKLOG_SOURCE_PREFIXES,
];

/**
 * Returns true when the install itself is brand new: the OLDEST (first-ever)
 * library path was created within the last 48 hours.  This is cheap (a single
 * `MIN(created_at)` scan on the small `library_paths` table) and irreversibly
 * transitions to false once the window has passed, so it can NEVER permanently
 * mask a genuine steady-state backlog problem.
 *
 * Deliberately uses MIN, not MAX: keying on the newest path would let an
 * operator re-arm the warning-suppressor on a months-old, healthy install
 * simply by adding one new library path — hiding a genuine pre-existing wedge
 * for 48h.  MIN ties the window to install age (the true "first ingest" case).
 *
 * We do NOT try to also check `has_files` ratios here — that would require a
 * full `media_items` count which is expensive on large catalogs.  The 48h
 * time-box is the primary safety gate; a genuinely wedged pipeline will
 * surface again as a `warning` once the window expires.
 */
export async function isInitializingWindow(sql: postgres.Sql): Promise<boolean> {
    const rows = await sql<[{ oldest: Date | null }]>`
        SELECT MIN(created_at) AS oldest FROM library_paths
    `;
    const oldest = rows[0]?.oldest ?? null;
    if (oldest === null) return false;
    return Date.now() - oldest.getTime() < INITIALIZING_WINDOW_MS;
}

/**
 * Read all cheap signals and map to derived alerts. Each source is read
 * independently (allSettled) so one slow or throwing source neither stalls the
 * others nor zeroes the board: a failed source contributes its prefix to
 * `failedPrefixes` instead of contributing alerts.
 *
 * The backlog-sensitive sources (`stuck-items:`, `failed-run-spike:`) and the
 * cross-source-aware sources (`overdue-schedule:`, the liveness bridge) run in
 * a separate batch. The `isInitializingWindow()` flag is computed in the same batch
 * and threaded into the adapters that need it.
 *
 * Fix 11 (OSS): `overdue-schedule:` and the liveness bridge are handled after
 * both parallel groups settle so they can receive `openCircuitTaskIds` (fleet fetched
 * once in the backlog batch) — suppresses overdue-schedule alerts for tasks whose
 * circuit is already open, and threads activeSpikeTaskIds into adaptTaskLiveness
 * so the generic spike invariant item is suppressed when per-task spike alerts fire.
 */
export async function deriveAttention(sql: postgres.Sql): Promise<DeriveOutcome> {
    // Run all signal fetches and the initializing probe concurrently. The two
    // groups use separate allSettled calls so each group keeps clean types.
    const [mainSettled, backlogSettled] = await Promise.all([
        Promise.allSettled(SOURCES.map((s) => runSource(s, sql))),
        Promise.allSettled([
            isInitializingWindow(sql),
            loadStuckItems(sql, 20),
            (async () => {
                // Sample rows for display AND true per-stage totals: the sample
                // length would cap the ack watermark at the sample limit no
                // matter how large the real population is.
                const [rows, totals] = await Promise.all([
                    loadDeclineLoopRows(sql, 20),
                    countDeclineLoopRowsByStage(sql),
                ]);
                return { rows, totals };
            })(),
            (async () => {
                // Fetch the fleet once (a single cheap SELECT) to:
                // (a) suppress spikes for tasks whose circuit is already open — those
                //     are covered by the circuit-open alert, and
                // (b) suppress overdue-schedule alerts for open-circuit tasks (Fix 11).
                const [spikes, fleet] = await Promise.all([
                    loadFailedRunSpikes(sql, FAILED_RUN_SPIKE_THRESHOLD),
                    getCircuitFleet(sql),
                ]);
                return { spikes, fleet };
            })(),
        ] as const),
    ]);

    const [initializingResult, stuckResult, declineLoopResult, spikeResult] = backlogSettled;

    const resolvedInitializing =
        initializingResult.status === 'fulfilled' ? initializingResult.value : false;
    if (initializingResult.status === 'rejected') {
        logger.warn('isInitializingWindow failed; treating as non-initializing', {
            err:
                initializingResult.reason instanceof Error
                    ? initializingResult.reason.message
                    : String(initializingResult.reason),
        });
    }

    // Resolve the open/force-enabled task id set from the fleet result (if available).
    // Used by both the spike suppression path and the overdue-schedule/liveness sources.
    const openCircuitTaskIds =
        spikeResult.status === 'fulfilled'
            ? new Set(
                  spikeResult.value.fleet.entries
                      .filter((e) => e.state !== 'closed' || e.forceEnabled)
                      .map((e) => e.taskId),
              )
            : new Set<string>();

    const alerts: DerivedAlert[] = [];
    const failedPrefixes: string[] = [];
    const warmingPrefixes: string[] = [];

    // Collect results from the fixed SOURCES.
    mainSettled.forEach((result, i) => {
        if (result.status === 'fulfilled') {
            alerts.push(...result.value);
        } else {
            failedPrefixes.push(SOURCES[i].prefix);
            if (logSourceFailure(SOURCES[i].prefix, result.reason)) {
                warmingPrefixes.push(SOURCES[i].prefix);
            }
        }
    });

    // Backlog source: stuck-items.
    if (stuckResult.status === 'fulfilled') {
        alerts.push(...adaptStuck(stuckResult.value, resolvedInitializing));
    } else {
        failedPrefixes.push('stuck-items:');
        if (logSourceFailure('stuck-items:', stuckResult.reason))
            warmingPrefixes.push('stuck-items:');
    }

    // Backlog source: decline-loop.
    if (declineLoopResult.status === 'fulfilled') {
        const { rows, totals } = declineLoopResult.value;
        alerts.push(...adaptDeclineLoop(rows, totals, resolvedInitializing));
    } else {
        failedPrefixes.push('decline-loop:');
        if (logSourceFailure('decline-loop:', declineLoopResult.reason))
            warmingPrefixes.push('decline-loop:');
    }

    // Backlog source: failed-run-spike.
    if (spikeResult.status === 'fulfilled') {
        const { spikes, fleet } = spikeResult.value;
        const suppressed = new Set(
            fleet.entries
                .filter((e) => e.state !== 'closed' || e.forceEnabled)
                .map((e) => e.taskId),
        );
        alerts.push(...adaptFailedRunSpikes(spikes, suppressed, resolvedInitializing));
    } else {
        failedPrefixes.push('failed-run-spike:');
        if (logSourceFailure('failed-run-spike:', spikeResult.reason))
            warmingPrefixes.push('failed-run-spike:');
    }

    // Context-aware source: overdue-schedule (Fix 11: receives openCircuitTaskIds).
    try {
        // Ignore ORPHANED scheduler_state rows — a task that dropped its
        // `schedule` (e.g. trickplay-generation) or was renamed/removed
        // (e.g. arr-calendar-sync) leaves a stale row whose next_fire_at never
        // advances and would otherwise alarm forever. computeScheduleOverdue
        // drops them via the scheduledTaskIds set.
        // Fail OPEN: if the registry isn't populated in this process yet, pass
        // `undefined` so filtering is skipped and a genuine overdue is never
        // silently suppressed.
        const tasks = registry.getAllTasks();
        const scheduledIds =
            tasks.length === 0
                ? undefined
                : new Set(tasks.filter((t) => t.schedule?.every).map((t) => t.id));
        const states = await listAllScheduledTasks(sql);
        const views = computeScheduleOverdue(
            states,
            Date.now(),
            ATTENTION_OVERDUE_GRACE_MS,
            undefined,
            scheduledIds,
        );
        // Common case: nothing overdue → no task_history query at all.
        const overdueIds = views.filter((v) => v.overdue).map((v) => v.taskId);
        if (overdueIds.length > 0) {
            // Suppress overdue alerts for tasks that completed a run within the
            // window — a wedged/redundant time-schedule on an event- or sweep-driven
            // task isn't actionable while it's clearly working. Scoped to the overdue
            // ids so it uses the (task_id, completed_at) index rather than scanning.
            const recentlyActive = await listRecentlyActiveTaskIds(
                sql,
                overdueIds,
                OVERDUE_RECENT_ACTIVITY_MINUTES,
            );
            alerts.push(
                ...adaptOverdueSchedules(views, new Set(recentlyActive), openCircuitTaskIds),
            );
        }
    } catch (err) {
        failedPrefixes.push('overdue-schedule:');
        if (logSourceFailure('overdue-schedule:', err)) warmingPrefixes.push('overdue-schedule:');
    }

    // Context-aware source: the liveness bridge (Fix 7: receives activeSpikeTaskIds).
    try {
        // Worker heartbeats, resource-class leaders and data invariants — the
        // liveness axes the observability verdict had but the spine lacked. We
        // run the same pure `computeHealthVerdict` and keep only its liveness
        // reasons (schedule-overdue + component health are already covered by
        // other sources). deriveValkeyAvailable makes a Valkey outage short to
        // `unknown` instead of a wall of spurious "worker dead" alarms.
        const [heartbeats, leaders, findings, components] = await Promise.all([
            readHeartbeats(),
            readClassLeaders(),
            listFindings(sql),
            buildComponentHealth(),
        ]);
        const invariants = findings.map((f) => ({
            status: f.status,
            id: f.invariant_id,
            label: f.label,
            // Thread the finding's remediation through to the verdict detail so
            // adaptTaskLiveness (Fix 8) can surface it in the bell — without this
            // the remediation read there is always undefined. Use the row's own
            // `remediation` (persisted from the invariant definition) so it works
            // for plugin-contributed invariants too, not just the built-in set.
            remediation: f.remediation,
        }));
        const valkeyAvailable = deriveValkeyAvailable(components);
        const verdict = computeHealthVerdict({
            heartbeats,
            leaders,
            schedules: [],
            invariants,
            inputsAvailable: { valkey: valkeyAvailable, db: true },
        });
        alerts.push(...adaptTaskLiveness(verdict.reasons));
    } catch (err) {
        failedPrefixes.push(...LIVENESS_DOMAIN_PREFIXES);
        if (logSourceFailure(LIVENESS_DOMAIN_PREFIXES.join(','), err)) {
            warmingPrefixes.push(...LIVENESS_DOMAIN_PREFIXES);
        }
    }

    return { alerts, failedPrefixes, warmingPrefixes };
}

/** Accept either the rich outcome or a bare alert array (test injection convenience). */
function normalizeDerive(out: DerivedAlert[] | DeriveOutcome): DeriveOutcome {
    return Array.isArray(out) ? { alerts: out, failedPrefixes: [] } : out;
}

/**
 * Options for one derivation cycle.
 */
export interface RunAttentionDerivationOpts {
    /** Injectable for tests; defaults to the real derive. May return a bare alert array. */
    derive?: (sql: postgres.Sql) => Promise<DerivedAlert[] | DeriveOutcome>;
}

/** What one derivation cycle did — the `problem-derive` task reports this. */
export interface AttentionDerivationOutcome {
    /** Alerts written (inserted or refreshed) this cycle. */
    upserted: number;
    /** Alerts moved to resolved history this cycle. */
    resolved: number;
    /** Board verdict as of this cycle. */
    verdict: AttentionResponse['verdict'];
    /** Unacked, unsnoozed item count as of this cycle (the bell badge). */
    unreadCount: number;
    /**
     * Id-namespace prefixes whose source could not be read. Non-empty means part
     * of the board is last-known-good rather than freshly observed — worth
     * surfacing in the run result so an operator can tell the two apart.
     */
    protectedPrefixes: string[];
    /**
     * Subset of `protectedPrefixes` that is unreadable only because its cache is
     * still warming up after boot (expected, not an operator concern).
     */
    warmingPrefixes: string[];
}

/**
 * Derive → reconcile against the table → apply writes → publish the render sidecar.
 *
 * THIS IS THE ONLY WRITER of `admin_attention_alerts` outside ack/snooze/retention,
 * and it runs from the `problem-derive` scheduled task — never from a request.
 * Before Slice 1 this body was inline in `getAttention()`, so the notification
 * bell's 60s poll on every open admin page triggered the full 11-source fan-out
 * AND a table write on the DB pool that also serves HLS/probe. That was the hard
 * ceiling on how many producers the board could ever have: every new producer made
 * an operator page load slower and added write amplification on the playback pool.
 * See `attention-cache.ts` for the incident that motivated the 20s cache mitigation.
 *
 * Leader gating is structural, not a check in this function: `problem-derive`
 * declares `resourceClass: 'maintenance'` + `scope: 'global'` like every other
 * cluster-singleton builtin (stage-sweep, health-invariants, artwork-reaper), so
 * the scheduler's cluster-wide fire claim and the WORKER_MODE gate on leader
 * election keep exactly one execution per cycle, on a worker replica.
 */
export async function runAttentionDerivation(
    sql: postgres.Sql,
    opts: RunAttentionDerivationOpts = {},
): Promise<AttentionDerivationOutcome> {
    const derive = opts.derive ?? deriveAttention;
    let outcome: DeriveOutcome;
    try {
        outcome = normalizeDerive(await derive(sql));
    } catch (err) {
        // Total failure: protect EVERY namespace so the reconcile carries the
        // persisted alerts forward unchanged instead of resolving them all
        // (which would render a false "healthy" board).
        logger.warn('derive failed entirely; leaving persisted state untouched', {
            err,
        });
        outcome = {
            alerts: [],
            failedPrefixes: [...SOURCES.map((s) => s.prefix), ...BACKLOG_SOURCE_PREFIXES],
        };
    }
    const existing = await readAllAlerts(sql);
    const result = reconcile(
        outcome.alerts,
        existing,
        new Date().toISOString(),
        outcome.failedPrefixes,
    );
    await upsertAlerts(sql, result.upserts);
    await resolveAlerts(sql, result.resolveIds);
    await publishRenderSidecar(
        outcome.alerts,
        result.items.map((i) => i.id),
    );

    return {
        upserted: result.upserts.length,
        resolved: result.resolveIds.length,
        verdict: result.verdict,
        unreadCount: result.unreadCount,
        protectedPrefixes: outcome.failedPrefixes,
        warmingPrefixes: outcome.warmingPrefixes ?? [],
    };
}

/**
 * Publish the typed `actions[]` / glossary `term` for the ids on the board, so the
 * read path can render them without re-running an adapter (they have no column —
 * see `AttentionRenderEntry` in types.ts).
 *
 * Only freshly-derived alerts carry real actions. An id that is on the board but
 * was NOT derived this cycle is a protected carry-forward (its source failed), so
 * its previous render is carried forward too — otherwise a single failed source
 * would strip that namespace's action buttons for as long as it stays down.
 * Ids that left the board are simply not copied, which is what prunes the map.
 */
async function publishRenderSidecar(derived: DerivedAlert[], boardIds: string[]): Promise<void> {
    const next: AttentionRenderMap = {};
    derived.forEach((a, order) => {
        next[a.id] = {
            fingerprint: a.fingerprint,
            order,
            term: a.term,
            actions: a.actions,
        };
    });

    const carried = boardIds.filter((id) => next[id] === undefined);
    if (carried.length > 0) {
        const prev = await readAttentionRender();
        for (const id of carried) {
            const entry = prev[id];
            if (entry) next[id] = entry;
        }
    }

    await publishAttentionRender(next);
}

export interface GetAttentionOpts {
    /** When true, includes activity count and recently-added items in the response. */
    includeOps?: boolean;
    /** Shared response caches must exclude process-local runtime state. */
    includePluginRestarts?: boolean;
}

/**
 * Read the board. A plain SELECT of the persisted table plus its render sidecar —
 * no signal fan-out, no writes. Plugin lifecycle notices are a cheap live join
 * against saved registry intent, since loaded code is process-local and must
 * be reported immediately rather than waiting for a worker's derive cycle.
 *
 * Cold boot is naturally correct: the rows this returns were written by the
 * PREVIOUS process, so a restart never shows an empty board waiting for a derive.
 * The residual case is a genuinely fresh install, where the table is empty until
 * `problem-derive`'s `runOnStartup` cycle lands (seconds), and an empty table is
 * indistinguishable from a clean one — both read `healthy`.
 */
export async function getAttention(
    sql: postgres.Sql,
    opts: GetAttentionOpts = {},
): Promise<AttentionResponse> {
    const nowIso = new Date().toISOString();
    const [rows, render, pluginRestarts] = await Promise.all([
        readAllAlerts(sql),
        readAttentionRender(),
        opts.includePluginRestarts === false
            ? Promise.resolve([])
            : readPluginRestartAttention(sql, nowIso),
    ]);
    const base: AttentionResponse = projectPersisted(rows, nowIso, render, pluginRestarts);
    if (!opts.includeOps) return base;
    // Ops extras are best-effort: if these supplementary queries fail, the bell
    // must still render the (already-projected) attention problems on every admin
    // page rather than 500.
    try {
        const [running, recent, resolved] = await Promise.all([
            countActiveManualRuns(sql),
            // Read far more rows than the 10 the drawer shows: one series' episodes
            // collapse into a single row, and a whole-series import must still
            // leave room for (and count) what else arrived.
            getRecentlyAddedForOps(sql, 500),
            readResolvedHistory(sql, 10),
        ]);
        return {
            ...base,
            activity: { running },
            recentlyAdded: groupRecentlyAdded(recent, 10),
            resolvedHistory: resolved.map((r) => itemFromRow(r, nowIso)),
        };
    } catch (err) {
        logger.warn('ops extras failed; returning attention base only', {
            err,
        });
        return base;
    }
}

/** Ack one alert by id + fingerprint. Returns true if a row was acked. */
/**
 * The `lumastra-update:` source: the stored release list evaluated against the
 * RUNNING build, plus the check's failing streak. Exported for its test — the
 * wiring from stored state to adapter is what keeps the notices alive.
 */
export async function deriveLumastraUpdateAlerts(
    sql: postgres.Sql,
    now: number = Date.now(),
): Promise<DerivedAlert[]> {
    if (!config.UPDATE_CHECK_ENABLED) return [];
    const state = await readUpdateState(sql);
    const build = config.buildInfo;
    return adaptLumastraUpdate(
        evaluateStoredUpdate(state, { version: build.version, buildTime: build.buildTime }),
        build.version,
        { since: state.failingSince, lastAttemptAt: state.lastAttemptAt },
        now,
    );
}

export async function ackAttention(
    sql: postgres.Sql,
    id: string,
    fingerprint: string,
    ackedBy: string,
): Promise<boolean> {
    // Persistent lifecycle/security notices cannot be clicked away.
    if (isPersistentAttentionId(id)) return false;
    return ackAlert(sql, id, fingerprint, ackedBy);
}

/** Snooze one alert for `durationMs` from now. Returns true if a row was snoozed. */
export async function snoozeAttention(
    sql: postgres.Sql,
    id: string,
    fingerprint: string,
    durationMs: number,
): Promise<boolean> {
    if (isPersistentAttentionId(id)) return false;
    const until = new Date(Date.now() + durationMs).toISOString();
    return snoozeAlert(sql, id, fingerprint, until);
}

/** Read the live config-load diagnostics on every cycle, without caching faults after a repair. */
export async function deriveMasterKeyAlerts(): Promise<DerivedAlert[]> {
    // Keep config.service off the static problem-derive/plugin-worker bundle
    // graph: it contains host-only configuration and master-key access.
    const { getUndecryptableConfigKeys } = await import('$lib/server/config/config.service.js');
    const { getMasterKeyBackupState, getMasterKeyFilePath } =
        await import('$lib/server/crypto/master-key.js');
    return adaptMasterKey(
        getUndecryptableConfigKeys(),
        getMasterKeyBackupState(),
        getMasterKeyFilePath(),
    );
}
