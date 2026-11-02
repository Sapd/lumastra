// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { jellyfinPlaybackService } from '../jellyfin/playback.service.js';
import type { JellyfinSession } from '../jellyfin/types/jellyfin.types.js';
import type { StreamSession } from '../types.js';
import { transformJellyfinSessionToStreamSession } from '../transformers.js';
import { Logger } from '../utils/logger.js';
import { config, features } from '../config.js';
import { getDb } from '../database/connection.js';
import { acquireLock, isCoordinationValkeyReady } from '../cache/valkey.js';
import {
    getExternalIdFor,
    mergeExternalIds,
    createExternalIdFromSingle,
} from '$lib/utils/external-ids.js';
import {
    getSessionManager,
    type ExternalSessionSource,
    type IngestExternalParams,
} from './session-manager.service.js';
import { resolveJellyfinNamesToUserIds } from '../database/queries/users.queries.js';
import type { UserId } from '$lib/shared/user-id.js';

const logger = Logger.for('SessionsCacheService');

type SessionFetchResult = { source: 'jellyfin'; sessions: JellyfinSession[] };

/**
 * Strip out the fields we already extract into structured `ingestExternal`
 * params so we don't double-store them inside `external_payload`. Anything
 * relevant for forensics (TranscodingInfo, MediaStreams, deviceInfo, chapters)
 * stays in. Limits payload size so the jsonb column doesn't grow unbounded.
 */
function buildJellyfinExternalPayload(raw: JellyfinSession): Record<string, unknown> {
    const { Id, UserId, NowPlayingItem, ...rest } = raw;
    void Id;
    void UserId;
    return {
        nowPlaying: NowPlayingItem
            ? {
                  Type: NowPlayingItem.Type,
                  RunTimeTicks: NowPlayingItem.RunTimeTicks,
                  SeriesName: NowPlayingItem.SeriesName,
                  IndexNumber: NowPlayingItem.IndexNumber,
                  ParentIndexNumber: NowPlayingItem.ParentIndexNumber,
              }
            : undefined,
        transcodingInfo: rest.TranscodingInfo,
        playState: rest.PlayState,
    };
}

/**
 * Build `ingestExternal` params from a transformed `StreamSession`. Returns
 * null when a required upstream id is missing — caller must skip and warn.
 */
export function buildExternalIngestParams(
    source: ExternalSessionSource,
    session: StreamSession,
    rawPayload: unknown,
    userId: UserId,
): IngestExternalParams | null {
    const sourceSessionId =
        source === 'jellyfin' ? (session.playSessionId ?? session.__id) : session.__id;
    if (!sourceSessionId) return null;

    const internalId = getExternalIdFor(session.externalIds, 'internal');
    if (!internalId) return null;
    if (!session.username) return null;

    const positionSecs = session.playCurrentTime ?? 0;
    const positionMs = Math.max(0, Math.floor(positionSecs * 1000));
    const status: 'ACTIVE' | 'PAUSED' = session.playIsPlaying === false ? 'PAUSED' : 'ACTIVE';

    const runtimeSecs = session.playItemDuration;
    const runtimeMs =
        typeof runtimeSecs === 'number' && runtimeSecs > 0 ? Math.floor(runtimeSecs * 1000) : null;

    const bitrate =
        session.playBitrate ?? session.playOriginalBitrate ?? session.playTranscodeBitrate;
    const bitrateKbps =
        typeof bitrate === 'number' && bitrate > 0 ? Math.round(bitrate / 1000) : undefined;

    const resolution =
        typeof session.playVideoWidth === 'number' && typeof session.playVideoHeight === 'number'
            ? `${session.playVideoWidth}x${session.playVideoHeight}`
            : undefined;

    return {
        source,
        sourceSessionId,
        userId,
        mediaId: internalId,
        positionMs,
        status,
        playMethod: session.playMethod,
        device: {
            name: session.browsername,
            client: session.clientname,
            deviceId: session.deviceId,
        },
        technical: {
            videoCodec:
                session.playCodec ?? session.playOriginalCodec ?? session.playTranscodeCodec,
            audioCodec: session.playOriginalAudioCodec ?? session.playTranscodeAudioCodec,
            bitrate: bitrateKbps,
            container: session.playOriginalContainer ?? session.playTranscodeContainer,
            resolution,
        },
        runtimeMs,
        externalPayload: rawPayload,
    };
}

/**
 * Server-side cache service for session-related data.
 * Polls external sources (Jellyfin, Audiobookshelf) on a 5-second interval and
 * mirrors active sessions into play_sessions via SessionManager.ingestExternal.
 */
class SessionsCacheService {
    private sessionsCacheInterval: ReturnType<typeof setTimeout> | null = null;

    // Use config values for refresh intervals
    private get SESSIONS_REFRESH_INTERVAL() {
        return config.SESSIONS_REFRESH_INTERVAL_MS;
    }

    // Circuit breaker for API failures
    private failureCount = 0;
    private readonly MAX_FAILURES = 5;
    private backoffDelay = 1000;
    private lastFailureTime = 0;

    // In-flight guard for refreshSessionsCache(). Prevents stampedes when many
    // requests trigger a refresh while the previous one is still running (e.g.
    // because Jellyfin is slow). Cleared in the refresh's finally block.
    private refreshInFlight: Promise<void> | null = null;

    // Hard wall-clock timeout for a single refresh cycle. The downstream
    // `refreshSessionsCache` relies on per-source timeouts (axios for Jellyfin
    // is bounded; Audiobookshelf's bare `fetch` is not). Without this ceiling,
    // a hung upstream would leave `refreshInFlight` permanently non-null and
    // silently block all subsequent refreshes.
    private readonly REFRESH_WALL_CLOCK_TIMEOUT_MS = 15_000;

    /**
     * Per-source set of `(source, sourceSessionId)` upsert keys observed in the
     * previous poll cycle. On the next cycle we diff against the new set and
     * call `markStop({reason: 'crashed'})` for keys that vanished — this beats
     * the F5 reaper (30s) to a snappy UI.
     */
    private readonly previouslySeenSourceKeys: Map<ExternalSessionSource, Set<string>> = new Map();

    /**
     * Upstream sessions already reported as unresolvable (no Lumastra media
     * item for what they play). The poll runs every ~5 s, so warning on each
     * pass repeated one line ~120 times for a single Jellyfin episode on prod.
     */
    private readonly unresolvedSessionsWarned = new Set<string>();

    /**
     * Start background cache refresh processes.
     * This method is idempotent - calling it multiple times is safe.
     */
    startCaching() {
        // Belt-and-suspenders: do nothing when Jellyfin sync is off
        if (!features.jellyfinSync) {
            logger.debug('Jellyfin sync not enabled — sessions cache will not start');
            return;
        }

        // Guard against double-starting
        if (this.sessionsCacheInterval) {
            logger.debug('Sessions cache service already running, skipping start');
            return;
        }

        logger.info('Starting background cache processes');

        // Start sessions caching (every 5 seconds)
        // Use the in-flight-guarded kicker so a slow refresh (e.g. Jellyfin
        // taking 10s) cannot stack a second refresh on top of itself.
        // Leader-elect each tick: exactly one replica claims the per-window
        // bucket lock in Valkey and runs the refresh; other web replicas
        // no-op. Without this guard, scaling the web tier horizontally
        // would multiply Jellyfin /Sessions polling by replica count.
        // Bucket-keyed SETNX matches the scheduler pattern in
        // `tasks/scheduler.ts:tryClaim`.
        // A self-rescheduling timeout rather than setInterval: the period is
        // re-read for every tick, so a saved SESSIONS_REFRESH_INTERVAL_MS applies
        // without a restart.
        const scheduleNext = (): void => {
            this.sessionsCacheInterval = setTimeout(() => {
                void this.tickIfLeader();
                if (this.sessionsCacheInterval) scheduleNext();
            }, this.SESSIONS_REFRESH_INTERVAL);
        };
        scheduleNext();

        // Initial refresh — also leader-gated so simultaneous boots don't
        // thunder-herd Jellyfin.
        void this.tickIfLeader();
    }

    /**
     * Acquire a per-window leadership bucket and run the refresh if won.
     *
     * Why per-window (vs sticky leader): keeps the implementation small and
     * makes flap-tolerant correctness explicit. Diff state for the "vanished
     * sessions → markStop" path is per-replica; if leadership migrates,
     * the new leader's diff state is empty for one tick and a markStop
     * may slip through this cycle. The F5 reaper (30s) still catches it.
     *
     * Valkey unreachable → falls through with no claim — single-replica
     * fallback. In-memory lock fallback in `acquireLock` also handles dev.
     */
    private async tickIfLeader(): Promise<void> {
        let claimed = true;
        if (isCoordinationValkeyReady()) {
            const intervalMs = this.SESSIONS_REFRESH_INTERVAL;
            const bucket = Math.floor(Date.now() / intervalMs);
            const lockKey = `lock:sessions-cache-refresh:${bucket}`;
            // TTL slightly shorter than the tick interval so a stuck leader
            // can't hold past one window. Floored at 2s so a sub-2s tick
            // (configured by the operator) still grabs at least one window.
            const ttlSec = Math.max(2, Math.floor(intervalMs / 1000) - 1);
            const value = await acquireLock(lockKey, ttlSec, config.INSTANCE_ID);
            claimed = value !== null;
        }
        if (!claimed) return;
        this.kickRefreshSessionsCache();
    }

    /**
     * Run `refreshSessionsCache` while sharing the `refreshInFlight` slot with
     * on-demand triggers, so concurrent kickers all await the same refresh.
     * Wraps the underlying refresh in a wall-clock timeout so a hung upstream
     * cannot leave the in-flight slot permanently occupied.
     */
    private kickRefreshSessionsCache(): void {
        if (this.refreshInFlight) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((_, reject) => {
            timer = setTimeout(
                () =>
                    reject(
                        new Error(
                            `sessions cache refresh exceeded ${this.REFRESH_WALL_CLOCK_TIMEOUT_MS}ms`,
                        ),
                    ),
                this.REFRESH_WALL_CLOCK_TIMEOUT_MS,
            );
        });
        this.refreshInFlight = Promise.race([this.refreshSessionsCache(), timeout])
            .catch((error) => {
                logger.error('Unhandled error in sessions cache refresh', error as Error);
                // The wall-clock timeout fired before the refresh completed.
                // Count it as a failure so the circuit breaker eventually opens
                // and stops hammering a hung/slow upstream.
                this.recordFailure();
            })
            .finally(() => {
                if (timer !== undefined) clearTimeout(timer);
                this.refreshInFlight = null;
            });
    }

    /**
     * Stop background cache processes
     */
    stopCaching() {
        if (this.sessionsCacheInterval) {
            clearTimeout(this.sessionsCacheInterval);
            this.sessionsCacheInterval = null;
        }
        logger.info('Stopped background cache processes');
    }

    /**
     * Resolve which observed (Jellyfin) login names map to a Lumastra user, by
     * the stable `users.id` UUID. Sessions whose name is not a registered
     * Lumastra user have no entry and are skipped from `play_sessions` ingestion
     * (they would otherwise FK-fail on the now-uuid `play_sessions.user_id`).
     *
     * Uses the SAME shared resolver as the watch-sync pull
     * (`resolveJellyfinNamesToUserIds`), which matches on
     * `LOWER(COALESCE(jellyfin_username, username))` — so the per-user Jellyfin
     * login override (mig 16.45.0) is honored here too. (Previously this matched
     * raw `username` only, an override-blindness bug that dropped sessions for
     * users with a Jellyfin-name override.)
     *
     * Returns a map from lower-cased provider name → branded `UserId`. On DB
     * failure returns an empty map → all sessions skipped this cycle (fail-safe;
     * inventing a sentinel UUID would cross-attribute history).
     */
    private async resolveProviderUserIds(
        candidates: Iterable<string>,
    ): Promise<Map<string, UserId>> {
        const sql = getDb();
        const names = new Set<string>();
        for (const c of candidates) {
            if (c) names.add(c.toLowerCase());
        }
        if (!sql || names.size === 0) return new Map<string, UserId>();
        try {
            return await resolveJellyfinNamesToUserIds(sql, [...names]);
        } catch (err) {
            logger.warn('Failed to resolve provider users to UserIds; skipping all this cycle', {
                error: err instanceof Error ? err.message : String(err),
            });
            return new Map<string, UserId>();
        }
    }

    /**
     * Push a set of polled sessions through `SessionManager.ingestExternal` and
     * detect sessions that disappeared since the previous poll, calling
     * `markStop({reason: 'crashed'})` for them. Errors on a single session do
     * NOT abort the loop — the poller must keep working even if one row is
     * malformed.
     *
     * The caller has already run `resolveInternalUuids`, so `externalIds.internal`
     * is populated where the upstream id maps to a Lumastra media item. Sessions
     * with no internal id are skipped (FK would fail) with a warn.
     */
    private async processObservedSessions(
        source: ExternalSessionSource,
        sessions: StreamSession[],
        rawById: Map<string, unknown>,
    ): Promise<void> {
        const manager = getSessionManager();
        const seenKeys = new Set<string>();

        const candidateUsernames = sessions
            .map((s) => s.username)
            .filter((u): u is string => typeof u === 'string' && u.length > 0);
        const providerUserIds = await this.resolveProviderUserIds(candidateUsernames);

        // Aggregate non-Lumastra external users so we emit a single debug line
        // per refresh instead of one per session per cycle.
        const skippedNonLumastraUsers = new Set<string>();

        for (const session of sessions) {
            const sourceSessionId =
                source === 'jellyfin' ? (session.playSessionId ?? session.__id) : session.__id;
            if (!sourceSessionId) {
                logger.warn('Skipping external session — missing source_session_id', { source });
                continue;
            }

            const resolvedUserId = session.username
                ? providerUserIds.get(session.username.toLowerCase())
                : undefined;
            if (!resolvedUserId) {
                // Routine, not a problem: the upstream server (e.g. Jellyfin)
                // legitimately has its own users who aren't Lumastra users.
                // Unmapped → SKIP (orphan policy: never invent a sentinel UUID).
                // Collect and log ONCE per refresh (below) instead of one line
                // per session per ~5s cycle — otherwise a fresh admin's logs
                // flood with Jellyfin's own accounts.
                if (session.username) skippedNonLumastraUsers.add(session.username);
                continue;
            }

            const internalId = getExternalIdFor(session.externalIds, 'internal');
            if (!internalId) {
                const context = { source, sourceSessionId, upstreamMediaId: session.jellyfinId };
                const warnKey = `${source}:${sourceSessionId}`;
                if (this.unresolvedSessionsWarned.has(warnKey)) {
                    logger.debug(
                        'Skipping external session — no internal media UUID resolved',
                        context,
                    );
                } else {
                    if (this.unresolvedSessionsWarned.size >= 1000)
                        this.unresolvedSessionsWarned.clear();
                    this.unresolvedSessionsWarned.add(warnKey);
                    logger.warn(
                        'Skipping external session — no internal media UUID resolved',
                        context,
                    );
                }
                continue;
            }

            const raw = rawById.get(sourceSessionId);
            // Attribute the row to the resolved stable users.id UUID
            // (play_sessions.user_id FK, mig 16.46.0).
            const params = buildExternalIngestParams(source, session, raw, resolvedUserId);
            if (!params) continue;

            seenKeys.add(sourceSessionId);

            try {
                await manager.ingestExternal(params);
            } catch (err) {
                logger.warn('Failed to ingest external session — continuing', {
                    source,
                    sourceSessionId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        if (skippedNonLumastraUsers.size > 0) {
            logger.debug('Skipped external sessions for non-Lumastra users', {
                source,
                count: skippedNonLumastraUsers.size,
                usernames: [...skippedNonLumastraUsers],
            });
        }

        // Diff against the previous cycle's seen set. Anything that vanished
        // gets marked CRASHED immediately (snappier than the F5 reaper).
        const previous = this.previouslySeenSourceKeys.get(source);
        if (previous) {
            for (const prevKey of previous) {
                if (seenKeys.has(prevKey)) continue;
                try {
                    await manager.markStop({
                        source,
                        sourceSessionId: prevKey,
                        reason: 'crashed',
                        detail: 'vanished from poll',
                    });
                } catch (err) {
                    logger.warn('Failed to markStop vanished session — continuing', {
                        source,
                        sourceSessionId: prevKey,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }
        }
        this.previouslySeenSourceKeys.set(source, seenKeys);
    }

    /**
     * Batch-resolve Jellyfin item IDs to internal UUIDs.
     * Injects `externalIds.internal` into each session that has a match.
     */
    private async resolveInternalUuids(sessions: StreamSession[]): Promise<void> {
        const sql = getDb();
        if (!sql) return;

        const sessionsNeedingResolution = sessions.filter(
            (s) => s.jellyfinId && !getExternalIdFor(s.externalIds, 'internal'),
        );
        if (sessionsNeedingResolution.length === 0) return;

        const uniqueJellyfinIds = [
            ...new Set(
                sessionsNeedingResolution
                    .map((s) => s.jellyfinId)
                    .filter((id): id is string => !!id),
            ),
        ];

        try {
            const rows = await sql`
                SELECT DISTINCT ON (external_id) external_id, media_id
                FROM external_ids
                WHERE provider = 'jellyfin'
                  AND external_id = ANY(${uniqueJellyfinIds})
                ORDER BY external_id
            `;

            const jellyfinToUuid = new Map<string, string>();
            for (const row of rows) {
                jellyfinToUuid.set(String(row.external_id), String(row.media_id));
            }

            for (const session of sessionsNeedingResolution) {
                if (!session.jellyfinId) continue;
                const uuid = jellyfinToUuid.get(session.jellyfinId);
                if (uuid) {
                    session.externalIds = mergeExternalIds(
                        session.externalIds,
                        createExternalIdFromSingle('internal', uuid),
                    );
                }
            }
        } catch (error) {
            logger.debug('Failed to batch-resolve Jellyfin IDs to UUIDs', {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /**
     * Check if circuit breaker should prevent API calls
     */
    private shouldSkipApiCall(): boolean {
        if (this.failureCount >= this.MAX_FAILURES) {
            const timeSinceLastFailure = Date.now() - this.lastFailureTime;
            if (timeSinceLastFailure < this.backoffDelay) {
                return true;
            }
            // Reset after backoff period
            this.failureCount = 0;
            this.backoffDelay = 1000;
        }
        return false;
    }

    /**
     * Record API success
     */
    private recordSuccess() {
        this.failureCount = 0;
        this.backoffDelay = 1000;
    }

    /**
     * Record API failure and update circuit breaker state
     */
    private recordFailure() {
        this.failureCount++;
        this.lastFailureTime = Date.now();
        this.backoffDelay = Math.min(this.backoffDelay * 2, 60000); // Cap at 1 minute
    }

    /**
     * Refresh sessions cache with all media sources and enrich with cached data
     */
    private async refreshSessionsCache() {
        try {
            if (this.shouldSkipApiCall()) {
                logger.warn('Circuit breaker open, skipping refresh', {
                    failureCount: this.failureCount,
                });
                return;
            }

            // Build list of session fetchers based on enabled features
            const sessionFetchers: Promise<SessionFetchResult>[] = [];

            if (features.jellyfinSync) {
                sessionFetchers.push(
                    jellyfinPlaybackService
                        .getSessions()
                        .then((sessions) => ({ source: 'jellyfin', sessions })),
                );
            }

            const results = await Promise.allSettled(sessionFetchers);
            const allSessions: StreamSession[] = [];
            const transformedBySource: Map<ExternalSessionSource, StreamSession[]> = new Map();
            const rawBySourceById: Map<ExternalSessionSource, Map<string, unknown>> = new Map();

            // Process results
            for (const result of results) {
                if (result.status === 'fulfilled') {
                    const { sessions } = result.value;
                    const transformed = transformJellyfinSessionToStreamSession(sessions);
                    allSessions.push(...transformed);
                    transformedBySource.set('jellyfin', transformed);
                    const rawMap = new Map<string, unknown>();
                    for (const s of sessions) {
                        const key = s.PlayState?.PlaySessionId ?? s.Id;
                        if (key) rawMap.set(key, buildJellyfinExternalPayload(s));
                    }
                    rawBySourceById.set('jellyfin', rawMap);
                } else {
                    logger.error('Failed to fetch sessions', result.reason as Error);
                }
            }

            // Batch-resolve Jellyfin item IDs to internal UUIDs
            await this.resolveInternalUuids(allSessions);

            // Mirror observed sessions into play_sessions via SessionManager.
            // Errors from any single source are non-fatal.
            for (const [managerSource, transformed] of transformedBySource.entries()) {
                const rawById = rawBySourceById.get(managerSource) ?? new Map<string, unknown>();
                try {
                    await this.processObservedSessions(managerSource, transformed, rawById);
                } catch (err) {
                    logger.warn('processObservedSessions failed — continuing', {
                        source: managerSource,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }
            // Clear seen-key state for any source that was disabled or whose
            // fetch failed entirely this cycle — we don't want stale entries
            // to fire markStop next time the source comes back up.
            for (const knownSource of this.previouslySeenSourceKeys.keys()) {
                if (!transformedBySource.has(knownSource)) {
                    this.previouslySeenSourceKeys.delete(knownSource);
                }
            }

            // Record success for circuit breaker
            this.recordSuccess();
        } catch (error) {
            logger.error('Failed to refresh sessions cache', error as Error);

            // Record failure for circuit breaker
            this.recordFailure();
        }
    }

    /**
     * Get cache statistics for debugging
     */
    getCacheStats() {
        return {
            users: {
                note: 'No longer maintained here — user lookups go through filterToLumastraUsernames()',
            },
        };
    }

    /**
     * Force immediate refresh of the sessions cache.
     */
    async invalidateAndRefresh() {
        logger.info('Forcing sessions cache refresh');
        this.kickRefreshSessionsCache();
    }

    /**
     * Get health status for monitoring
     */
    getHealthStatus() {
        return {
            isHealthy: this.failureCount < this.MAX_FAILURES,
            cacheStats: this.getCacheStats(),
            intervalCount: this.sessionsCacheInterval ? 1 : 0,
            circuitBreaker: {
                failureCount: this.failureCount,
                isOpen: this.failureCount >= this.MAX_FAILURES,
                backoffDelay: this.backoffDelay,
                lastFailureTime: this.lastFailureTime,
            },
        };
    }
}

// Singleton instance
export const sessionsCacheService = new SessionsCacheService();

/** Getter for the singleton — exported alongside sessionsCacheService for call-site migration. */
export function getSessionsCacheService(): SessionsCacheService {
    return sessionsCacheService;
}

// Note: Signal handlers are registered in hooks.server.ts for coordinated shutdown
