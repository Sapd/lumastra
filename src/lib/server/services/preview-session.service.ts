// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Preview Session Service
 *
 * Centralized management of preview sessions (hover video previews).
 * Tracks active sessions, handles cleanup, and enforces rate limits.
 *
 * Uses Redis/Valkey for distributed storage (multi-replica support).
 * Falls back to in-memory if Redis unavailable.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '$lib/server/utils/logger';
import type { UserId } from '$lib/shared/user-id.js';
import { getFFmpegTranscodeService } from './ffmpeg-transcode.service';
import { UnifiedCache } from '$lib/server/cache/unified-cache';
import {
    setIfNotExists,
    getCoordinationClient,
    cacheGet,
    cacheGetOrThrow,
    cacheSet,
    cacheDel,
    getKeysByPattern,
} from '$lib/server/cache/valkey';
import { probeMediaFile, containerFromExtension } from '$lib/server/utils/ffprobe.js';
import { probeForTranscode } from './transcoding/media-probe.service.js';
import type { MediaSourceInfo, MediaStreamInfo } from './transcoding/types.js';
import { resolveMediaPath } from '$lib/server/utils/media-path-resolver.js';
import { getFilesForMediaItem } from '$lib/server/database/queries/media-files.queries.js';
import { getStreamsForMediaItem } from '$lib/server/database/queries/media-streams.queries.js';
import { getMediaType } from '$lib/server/database/queries/media-type-cache.queries.js';
import { findLocalTrailerForItem } from '$lib/server/database/queries/media-extras.queries.js';
import { isSeries, isSeason } from '$lib/server/utils/media-types.js';
import { getUserWatchState } from '$lib/server/database/queries/watch-state.queries.js';
import { getPlaybackPreferences } from '$lib/server/database/queries/user-preferences.queries.js';
import { resolvePreferredAudioTrack, type LanguagePreferences } from '$lib/shared/track-selection';
import { asAbsoluteStreamIndex } from '$lib/shared/stream-index';
import { parseLanguagePreferences } from '$lib/server/services/info.service.js';
import { getMediaItemForWatch } from '$lib/server/database/queries/catalog-operations.queries.js';
import {
    dbRowToAudioStreamInfo,
    dbRowToAudioTrackInfo,
} from '$lib/server/utils/media-stream-mapper.js';
import { watchManager } from '$lib/server/services/watch-manager.service.js';
import { playbackPlanner } from '$lib/server/services/playback-planner.service.js';
import {
    defaultBrowserCaps,
    buildServerEncodeCaps,
    parseBitDepth,
} from '$lib/server/services/info.service.js';
import { get as getConfig } from '$lib/server/config/config.service.js';
import { config } from '$lib/server/config.js';
import { buildPreviewKey, seekBucket, type PreviewProfile } from './preview-cache-key.js';
import { getPreviewCacheStore } from './preview-cache.store.js';
import type { AudioStreamInfo } from '$lib/schemas/playback-types.js';
import type { AudioTrackInfo } from '$lib/server/utils/hls-audio-injection.js';
import type { HlsOutputConfig } from '$lib/server/services/transcoding/types.js';
import type { Sql } from 'postgres';

const logger = Logger.for('PreviewSessionService');

// Redis cache for distributed session tracking
const liveTvSessionCache = new UnifiedCache({
    namespace: 'preview-livetv-sessions',
    l2TTL: 5 * 60 * 1000, // 5 minutes in milliseconds
});

// =========================================================================
// Types
// =========================================================================

export interface PreviewSession {
    playSessionId: string;
    itemId: string;
    transcodeMode: 'local' | 'direct';
    transcodeJobId?: string;
    startPositionSeconds: number;
    createdAt: Date;
    lastHeartbeatAt: Date;
    isPreview: true;
    /** Persisted so cleanup also revokes grants on other replicas. */
    hasPlaybackGrant?: boolean;
    isLiveTv?: boolean;
    /** True when this session serves a resolved local trailer child, not a snippet of the parent. */
    isTrailer?: boolean;
    /**
     * The id the CLIENT originally requested (the parent movie/series), only
     * set (and only meaningful) when `isTrailer` is true — `itemId` above is
     * the resolved trailer CHILD's own uuid, which the client never sends on
     * a re-open. `findReusablePreview` matches against this so a trailer
     * re-open (same parent id, e.g. hero rotation loop, modal reopen) coalesces
     * onto the still-running trailer transcode instead of spawning a fresh one.
     */
    requestedItemId?: string;
    userId?: UserId;
    /** Resolved media file UUID the preview was built for */
    fileId?: string;
    /** PlaybackPlan UUID used for transcoding decisions */
    planId?: string;
    /**
     * Content-addressed preview cache key (see preview-cache-key.ts /
     * preview-cache.store.ts). Set only when this session's transcode was
     * served from (or is warming into) the shared preview cache — the
     * viewer session and the shared FFmpeg artifact are deliberately
     * different ids; see cleanupPreviewSession and createPreview.
     */
    cacheKey?: string;
}

type KeysClient = {
    keys: (pattern: string) => Promise<unknown>;
};

const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');

// =========================================================================
// Session Store (Redis + In-Memory Fallback)
// =========================================================================

// In-memory fallback if Redis unavailable
const activePreviews = new Map<string, PreviewSession>();
const userSessions = new Map<string, Set<string>>();
const userLiveTvSessions = new Map<string, string>();
const liveTvSessionIds = new Set<string>();

// playSessionIds for which THIS replica actually called
// `getPreviewCacheStore().attach()` (createPreview is the only attach site —
// see the `store.attach(key)` call below). A preview cache key is
// content-addressed and therefore stable across replicas, and
// `cleanupUserPreviewSessions` rehydrates + cleans up sessions that may have
// been created on a DIFFERENT pod, so an unconditional `detach()` in
// `cleanupPreviewSession` would decrement a co-resident viewer's refcount on
// a replica that never attached — evicting an in-use artifact out from under
// it. Scoping detach to "did THIS replica attach for THIS session" and
// removing the entry on first release makes cleanup both replica-scoped and
// idempotent: a second cleanup call for the same session, or a cleanup that
// rehydrated a foreign pod's session, is a safe no-op.
const cacheAttachedSessions = new Set<string>();

// In-flight GPU-preview starts on THIS replica: previews that have passed the
// PREVIEW_MAX_GPU_JOBS budget check but whose artifact FFmpeg job isn't yet
// registered in the transcode service (so countActiveGpuPreviewJobs() can't see
// it yet). Counted alongside the live job count in the budget check so a burst
// of hovers can't all pass the check during each other's async probe window and
// overshoot the cap. Incremented synchronously at the check (no await between),
// decremented once the job is registered (or the GPU path is abandoned).
let inFlightGpuPreviewStarts = 0;

// ── Per-file preview-setup memo ────────────────────────────────────────────
// createPreview's dominant "time to start" cost is re-running two ffprobes
// (probeMediaFile + probeForTranscode) and the planner on EVERY hover — paid
// even when the transcode artifact is already cached, so a repeat hover of the
// same title feels no faster. These bits depend only on the file (not the seek,
// user, or hover count — except the plan, which also varies by heroSafeCodec),
// so memoize them with a short TTL keyed by file identity. A re-scan / file
// replacement self-corrects within the TTL, and the transcode cacheKey still
// carries the real fileVersion so a changed file never serves a stale artifact.
const PREVIEW_SETUP_TTL_MS = 5 * 60 * 1000;
const PREVIEW_SETUP_MAX_ENTRIES = 256;
// Inferred from the functions themselves so the memo value types match their
// returns exactly (avoids typed-lint "unresolved type" on probe.video access).
type PreviewProbeResult = Awaited<ReturnType<typeof probeMediaFile>>;
type PreviewPlan = Awaited<ReturnType<typeof playbackPlanner.createPlan>>['plan'];
const probeMemo = new Map<string, { at: number; value: PreviewProbeResult }>();
const planMemo = new Map<string, { at: number; value: PreviewPlan }>();
// null = probe ran but found no usable video / failed — cached so we don't
// re-probe a source that can't feed the GPU/HDR decision.
const transcodeStreamsMemo = new Map<string, { at: number; value: MediaStreamInfo[] | null }>();

function memoGet<V>(cache: Map<string, { at: number; value: V }>, key: string): V | undefined {
    const e = cache.get(key);
    if (!e) return undefined;
    if (Date.now() - e.at > PREVIEW_SETUP_TTL_MS) {
        cache.delete(key);
        return undefined;
    }
    return e.value;
}
function memoSet<V>(cache: Map<string, { at: number; value: V }>, key: string, value: V): void {
    // Map preserves insertion order → the first key is the oldest. Bound size so
    // a large library can't grow these unbounded.
    if (cache.size >= PREVIEW_SETUP_MAX_ENTRIES && !cache.has(key)) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: Date.now(), value });
}

/**
 * Release this replica's preview-cache attach for `playSessionId`, exactly
 * once. No-ops if this replica never attached for this session (foreign-pod
 * session) or already released it (double cleanup).
 */
function detachPreviewCacheIfOwned(playSessionId: string, cacheKey: string): void {
    if (!cacheAttachedSessions.delete(playSessionId)) return;
    getPreviewCacheStore().detach(cacheKey);
}

// Redis keys
const REDIS_LIVE_TV_COUNT_KEY = 'preview:livetv:count';
const REDIS_LIVETV_SESSION_PREFIX = 'preview:livetv:user:';
const REDIS_LIVETV_WATCHERS_KEY = 'playback:livetv:watchers'; // Active real watchers

// Preview session Redis keys
const REDIS_SESSION_PREFIX = 'preview:session:v1:';
const REDIS_USER_LIVETV_PREFIX = 'preview:user-livetv:v1:';
const SESSION_REDIS_TTL_SECONDS = 5 * 60; // 5 minutes

// Session lifecycle constants (also used by runSessionExpiryCleanup)
const PREVIEW_SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes absolute max
const PREVIEW_HEARTBEAT_TIMEOUT_MS = 30 * 1000; // 30 seconds no heartbeat = dead

// Serialized form of PreviewSession (Dates as ISO strings for JSON storage)
interface SerializedPreviewSession extends Omit<PreviewSession, 'createdAt' | 'lastHeartbeatAt'> {
    createdAt: string;
    lastHeartbeatAt: string;
}

function serializeSession(session: PreviewSession): SerializedPreviewSession {
    return {
        ...session,
        createdAt: session.createdAt.toISOString(),
        lastHeartbeatAt: session.lastHeartbeatAt.toISOString(),
    };
}

function deserializeSession(raw: unknown): PreviewSession | null {
    try {
        const data: unknown = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
        if (!data || typeof data !== 'object') return null;
        const d = data as Record<string, unknown>;
        if (
            typeof d.playSessionId !== 'string' ||
            typeof d.itemId !== 'string' ||
            typeof d.transcodeMode !== 'string' ||
            typeof d.startPositionSeconds !== 'number' ||
            d.isPreview !== true
        ) {
            return null;
        }
        // Validate transcodeMode is one of the allowed values
        const validModes = ['local', 'direct'] as const;
        if (!validModes.includes(d.transcodeMode as (typeof validModes)[number])) {
            return null;
        }
        // Validate dates are parseable and not NaN
        const createdAt = new Date(d.createdAt as string);
        const lastHeartbeatAt = new Date(d.lastHeartbeatAt as string);
        if (isNaN(createdAt.getTime()) || isNaN(lastHeartbeatAt.getTime())) {
            return null;
        }
        return {
            ...(d as unknown as SerializedPreviewSession),
            createdAt,
            lastHeartbeatAt,
        };
    } catch {
        /* expected: Valkey value failed JSON parse or type validation — treat as no session */
        return null;
    }
}

// =========================================================================
// Session Management Functions
// =========================================================================

/**
 * Get an active preview session — checks in-memory first, then Redis
 */
export async function getPreviewSession(
    playSessionId: string,
    options: { requireLive?: boolean } = {},
): Promise<PreviewSession | undefined> {
    if (options.requireLive) {
        // Grant checks must see keepalives and teardown on other replicas, not
        // a rehydrated local snapshot. Preserve the service's local fallback
        // only when the coordination store cannot be consulted.
        let session = activePreviews.get(playSessionId);
        try {
            const raw = await cacheGetOrThrow(`${REDIS_SESSION_PREFIX}${playSessionId}`);
            session = raw ? (deserializeSession(raw) ?? undefined) : undefined;
        } catch {
            logger.debug('Preview liveness using local session: coordination store unavailable');
        }
        const now = Date.now();
        if (
            !session ||
            session.playSessionId !== playSessionId ||
            now - session.createdAt.getTime() > PREVIEW_SESSION_TTL_MS ||
            now - session.lastHeartbeatAt.getTime() > PREVIEW_HEARTBEAT_TIMEOUT_MS
        )
            return undefined;
        return session;
    }
    // Fast path: in-memory
    const inMemory = activePreviews.get(playSessionId);
    if (inMemory) return inMemory;

    // Redis rehydration (multi-replica: another pod may have created this session)
    try {
        const raw = await cacheGet(`${REDIS_SESSION_PREFIX}${playSessionId}`);
        if (raw) {
            const session = deserializeSession(raw);
            if (session) {
                // Rehydrate into in-memory Maps
                activePreviews.set(playSessionId, session);
                if (session.userId) {
                    const userSet = userSessions.get(session.userId) ?? new Set<string>();
                    userSet.add(playSessionId);
                    userSessions.set(session.userId, userSet);
                }
                return session;
            }
        }
    } catch (error) {
        logger.debug('Redis unavailable for getPreviewSession, falling back to in-memory', {
            error: String(error),
        });
    }

    return undefined;
}

/**
 * Get all active preview sessions for a user.
 * Checks in-memory first; falls back to Redis scan for rehydration.
 */
export async function getUserPreviewSessions(userId: UserId): Promise<PreviewSession[]> {
    // Fast path: in-memory
    const sessionIds = userSessions.get(userId);
    if (sessionIds && sessionIds.size > 0) {
        const sessions: PreviewSession[] = [];
        for (const sessionId of sessionIds) {
            const session = activePreviews.get(sessionId);
            if (session) sessions.push(session);
        }
        if (sessions.length > 0) return sessions;
        // All IDs in userSessions are stale; clear to prevent unbounded growth on long-lived pods
        userSessions.delete(userId);
    }

    // Redis fallback: scan all sessions and filter by userId (rehydration on pod restart)
    try {
        // Limit to 200; with PREVIEW_MAX_PER_USER=6 this covers ~33 concurrent
        // users without rehydration (same ~33-user coverage as the old
        // limit-100/cap-3 pairing -- getKeysByPattern's SCAN is non-blocking,
        // so doubling the limit is cheap).
        const keys = await getKeysByPattern(`${REDIS_SESSION_PREFIX}*`, 200);
        const sessions: PreviewSession[] = [];
        for (const key of keys) {
            const raw = await cacheGet(key);
            if (!raw) continue;
            const session = deserializeSession(raw);
            if (session?.userId === userId) {
                // Rehydrate into in-memory Maps
                activePreviews.set(session.playSessionId, session);
                const userSet = userSessions.get(userId) ?? new Set<string>();
                userSet.add(session.playSessionId);
                userSessions.set(userId, userSet);
                sessions.push(session);
            }
        }
        return sessions;
    } catch (error) {
        logger.debug('Redis unavailable for getUserPreviewSessions, using in-memory', {
            error: String(error),
        });
    }

    return [];
}

/**
 * Get the live TV session ID for a user — checks in-memory first, then Redis
 */
export async function getUserLiveTvSessionId(userId: UserId): Promise<string | undefined> {
    // Fast path: in-memory
    const inMemory = userLiveTvSessions.get(userId);
    if (inMemory) return inMemory;

    // Redis fallback
    try {
        const sessionId = await cacheGet(`${REDIS_USER_LIVETV_PREFIX}${userId}`);
        if (typeof sessionId === 'string' && sessionId) {
            userLiveTvSessions.set(userId, sessionId); // Rehydrate
            return sessionId;
        }
    } catch (error) {
        logger.debug('Redis unavailable for getUserLiveTvSessionId', {
            error: String(error),
        });
    }

    return undefined;
}

/**
 * Get live TV session count (checks Redis for multi-replica support)
 */
export async function getLiveTvSessionCount(): Promise<number> {
    try {
        // Try Redis first for distributed count
        const count = await liveTvSessionCache.get<string>(REDIS_LIVE_TV_COUNT_KEY);
        if (count !== null && typeof count === 'string') {
            return parseInt(count, 10) || 0;
        }
    } catch (error) {
        logger.debug('Redis unavailable, using in-memory count', {
            error: String(error),
        });
    }

    // Fallback to in-memory count
    return liveTvSessionIds.size;
}

/**
 * Get active live TV watcher count (real playback, not previews)
 * Distributed via Redis for multi-replica support
 *
 * Edge case: Negative counts (over-decrementing) return 0
 */
export async function getLiveTvWatcherCount(): Promise<number> {
    try {
        const count = await liveTvSessionCache.get<string>(REDIS_LIVETV_WATCHERS_KEY);
        if (count !== null && typeof count === 'string') {
            const parsed = parseInt(count, 10) || 0;
            // Safety: Negative counts indicate a bug, reset to 0
            if (parsed < 0) {
                logger.warn('Negative watcher count detected, resetting to 0', {
                    invalidCount: parsed,
                });
                await liveTvSessionCache.set(REDIS_LIVETV_WATCHERS_KEY, '0');
                return 0;
            }
            return parsed;
        }
    } catch (error) {
        logger.debug('Redis unavailable for watcher count', {
            error: String(error),
        });
    }

    return 0; // Default to 0 if Redis unavailable
}

/**
 * Track a live TV playback session (real watcher, not preview)
 * Called when user starts watching live TV
 *
 * Edge cases handled:
 * - Race conditions: Atomic SET NX prevents duplicate tracking
 * - Duplicate tracking: Same playSessionId won't increment twice
 * - Server crashes: TTL ensures cleanup after 10 minutes
 * - Multi-replica: Redis-based tracking works across instances
 */
export async function trackLiveTvWatcher(playSessionId: string, userId: UserId): Promise<void> {
    try {
        const sessionKey = `playback:livetv:session:${playSessionId}`;
        const sessionData = JSON.stringify({ userId, startedAt: Date.now() });

        // Atomically set session ONLY if it doesn't exist (SET NX)
        // Returns true if set, false if already exists
        // This is race-safe: only ONE thread/replica will succeed
        const wasSet = await setIfNotExists(
            sessionKey,
            sessionData,
            10 * 60, // 10 minutes TTL - auto-cleanup if browser killed
        );

        if (!wasSet) {
            logger.debug('Watcher session already tracked, skipping increment', {
                playSessionId,
                userId,
            });
            return;
        }

        // Session was created successfully, increment counter
        // Only ONE thread reaches here per unique playSessionId (race-safe)
        const currentCount = await getLiveTvWatcherCount();
        await liveTvSessionCache.set(REDIS_LIVETV_WATCHERS_KEY, String(currentCount + 1));

        logger.debug('Tracked live TV watcher', {
            playSessionId,
            userId,
            totalWatchers: currentCount + 1,
        });
    } catch (error) {
        logger.debug('Failed to track live TV watcher (non-critical)', {
            error: String(error),
        });
    }
}

/**
 * Refresh live TV watcher session TTL (heartbeat)
 * Called periodically while user is watching to prevent TTL expiration
 *
 * Edge case: User watches for 11+ minutes, TTL shouldn't expire
 */
export async function refreshLiveTvWatcherTTL(playSessionId: string): Promise<boolean> {
    try {
        // Use the SAME bare key + wrapper that trackLiveTvWatcher's setIfNotExists
        // writes (`playback:livetv:session:<id>`). Reading via the namespaced
        // liveTvSessionCache (`preview-livetv-sessions:…`) targeted a different key
        // that never existed, so the TTL was never actually refreshed.
        const sessionKey = `playback:livetv:session:${playSessionId}`;
        const session = await cacheGet(sessionKey);

        if (session !== null) {
            // Refresh TTL by re-setting the session (10 minutes, in seconds).
            await cacheSet(sessionKey, session, 10 * 60);
            return true;
        }
        return false;
    } catch (error) {
        logger.debug('Failed to refresh watcher TTL (non-critical)', {
            error: String(error),
        });
        return false;
    }
}

/**
 * Untrack a live TV playback session
 * Called when user stops watching live TV
 */
export async function untrackLiveTvWatcher(playSessionId: string): Promise<void> {
    try {
        // Use the SAME bare key trackLiveTvWatcher writes — reading/deleting via
        // the namespaced liveTvSessionCache targeted a key that never existed, so
        // the count was never decremented (it only ever leaked upward).
        const sessionKey = `playback:livetv:session:${playSessionId}`;
        const session = await cacheGet(sessionKey);
        if (!session) return;

        // Decrement watcher count (the counter itself stays on liveTvSessionCache,
        // consistent with trackLiveTvWatcher and getLiveTvWatcherCount).
        const currentCount = await getLiveTvWatcherCount();
        const newCount = Math.max(0, currentCount - 1);
        await liveTvSessionCache.set(REDIS_LIVETV_WATCHERS_KEY, String(newCount));

        // Remove session tracking.
        await cacheDel(sessionKey);

        logger.debug('Untracked live TV watcher', {
            playSessionId,
            totalWatchers: newCount,
        });
    } catch (error) {
        logger.debug('Failed to untrack live TV watcher (non-critical)', {
            error: String(error),
        });
    }
}

/**
 * Increment live TV session count (distributed via Redis)
 * Note: Uses read-modify-write, not atomic INCR. Counter is eventually consistent;
 * runBackgroundCleanup() reconciles every 2 minutes.
 */
async function incrementLiveTvCount(sessionId: string): Promise<void> {
    try {
        // Increment in Redis with TTL
        const currentCount = await getLiveTvSessionCount();
        await liveTvSessionCache.set(REDIS_LIVE_TV_COUNT_KEY, String(currentCount + 1));

        // Track the individual session key WITH a TTL so a crashed session (whose
        // decrement never runs) self-expires instead of inflating the count forever.
        // This key is the authoritative per-session marker the reconciler counts.
        await liveTvSessionCache.set(
            `${REDIS_LIVETV_SESSION_PREFIX}${sessionId}`,
            'active',
            SESSION_REDIS_TTL_SECONDS,
        );
    } catch (error) {
        logger.debug('Redis increment failed, continuing with in-memory', {
            error: String(error),
        });
    }
}

/**
 * Decrement live TV session count (distributed via Redis)
 * Note: Uses read-modify-write, not atomic DECR. Counter is eventually consistent;
 * runBackgroundCleanup() reconciles every 2 minutes.
 */
async function decrementLiveTvCount(sessionId: string): Promise<void> {
    try {
        const currentCount = await getLiveTvSessionCount();
        const newCount = Math.max(0, currentCount - 1);
        await liveTvSessionCache.set(REDIS_LIVE_TV_COUNT_KEY, String(newCount));

        // Remove individual session tracking
        await liveTvSessionCache.delete(`${REDIS_LIVETV_SESSION_PREFIX}${sessionId}`);
    } catch (error) {
        logger.debug('Redis decrement failed, continuing with in-memory', {
            error: String(error),
        });
    }
}

/**
 * Add a preview session to tracking (in-memory + Redis)
 */
export async function addPreviewSession(session: PreviewSession): Promise<void> {
    activePreviews.set(session.playSessionId, session);

    // Track for user
    if (session.userId) {
        const userSessionSet = userSessions.get(session.userId) ?? new Set<string>();
        userSessionSet.add(session.playSessionId);
        userSessions.set(session.userId, userSessionSet);

        // Track live TV separately (in-memory + Redis for distributed)
        if (session.isLiveTv) {
            userLiveTvSessions.set(session.userId, session.playSessionId);
            liveTvSessionIds.add(session.playSessionId);

            // Increment distributed counter
            await incrementLiveTvCount(session.playSessionId);
        }
    }

    // Persist to Redis for multi-replica support (non-critical: fail silently)
    try {
        await cacheSet(
            `${REDIS_SESSION_PREFIX}${session.playSessionId}`,
            JSON.stringify(serializeSession(session)),
            SESSION_REDIS_TTL_SECONDS,
        );

        // Track live TV session per user in Redis
        if (session.isLiveTv && session.userId) {
            await cacheSet(
                `${REDIS_USER_LIVETV_PREFIX}${session.userId}`,
                session.playSessionId,
                SESSION_REDIS_TTL_SECONDS,
            );
        }
    } catch (error) {
        logger.debug('Redis unavailable for addPreviewSession, continuing with in-memory', {
            error: String(error),
        });
    }
}

/**
 * Cleanup a single preview session — stops transcode jobs, removes from Maps and Redis
 */
export async function cleanupPreviewSession(
    playSessionId: string,
    session: PreviewSession,
    userId: UserId | undefined,
): Promise<void> {
    // Previews without grants need no grant dependencies or invalidation.
    if (session.hasPlaybackGrant) {
        const { invalidatePlaybackGrantCache, revokeGrantsForPlaySession } =
            await import('./playback-grant');
        invalidatePlaybackGrantCache(undefined, playSessionId);
        await revokeGrantsForPlaySession(playSessionId, undefined, 'stopped');
    }
    // Cleanup local transcode job — cache-backed sessions never set
    // transcodeJobId (see createPreview), so this only ever stops a
    // session-owned (non-cache) job. The shared cache artifact is released
    // via detach() below instead, and its FFmpeg job lives on for other
    // viewers / the reaper.
    if (session.transcodeMode === 'local' && session.transcodeJobId) {
        try {
            const transcodeService = getFFmpegTranscodeService();
            await transcodeService.stopJob(session.transcodeJobId);
        } catch (err) {
            logger.error('Failed to stop transcode job', err instanceof Error ? err : undefined, {
                jobId: session.transcodeJobId,
            });
        }
    }

    // Release this viewer's refcount on the shared preview-cache artifact —
    // but only if THIS replica is the one that attached it (see
    // detachPreviewCacheIfOwned / cacheAttachedSessions above). Do NOT stop
    // the underlying transcode job here — it is owned by the cache/refcount
    // and reaped by budget/inactivity, not by session cleanup.
    if (session.cacheKey) {
        try {
            detachPreviewCacheIfOwned(playSessionId, session.cacheKey);
        } catch (err) {
            logger.error(
                'Failed to detach preview cache entry',
                err instanceof Error ? err : undefined,
                { cacheKey: session.cacheKey },
            );
        }
    }

    // Remove from in-memory Maps (user-keyed cleanup only when we know the user)
    activePreviews.delete(playSessionId);
    if (userId) {
        const userSessionSet = userSessions.get(userId);
        if (userSessionSet) {
            userSessionSet.delete(playSessionId);
            if (userSessionSet.size === 0) {
                userSessions.delete(userId);
            }
        }
    }

    // Clean up live TV tracking (in-memory + Redis)
    if (session.isLiveTv) {
        liveTvSessionIds.delete(playSessionId);
        if (userId && userLiveTvSessions.get(userId) === playSessionId) {
            userLiveTvSessions.delete(userId);
        }

        // Decrement distributed counter
        await decrementLiveTvCount(playSessionId);
    }

    // Remove from Redis (non-critical: fail silently)
    try {
        await cacheDel(`${REDIS_SESSION_PREFIX}${playSessionId}`);

        // Remove live TV user key only if it still points to this session
        if (session.isLiveTv && userId) {
            const currentLiveTv = await cacheGet(`${REDIS_USER_LIVETV_PREFIX}${userId}`);
            if (currentLiveTv === playSessionId) {
                await cacheDel(`${REDIS_USER_LIVETV_PREFIX}${userId}`);
            }
        }
    } catch (error) {
        logger.debug('Failed to delete session from Redis (non-critical)', {
            error: String(error),
        });
    }
}

/**
 * Cleanup all preview sessions for a user
 * Called when user starts real playback to free up resources
 */
export async function cleanupUserPreviewSessions(userId: UserId): Promise<void> {
    // Rehydrate from Redis first (handles multi-replica: sessions created on another pod)
    const sessions = await getUserPreviewSessions(userId);
    if (sessions.length === 0) {
        return;
    }

    logger.info('Cleaning up all preview sessions for user', {
        userId,
        count: sessions.length,
    });

    for (const session of sessions) {
        await cleanupPreviewSession(session.playSessionId, session, userId);
    }
}

/**
 * Update heartbeat for a session — updates in-memory timestamp and refreshes Redis TTL
 */
export async function updateSessionHeartbeat(playSessionId: string): Promise<boolean> {
    const session = activePreviews.get(playSessionId);
    if (session) {
        session.lastHeartbeatAt = new Date();

        // Refresh Redis TTL and update stored timestamp (non-critical)
        try {
            await cacheSet(
                `${REDIS_SESSION_PREFIX}${playSessionId}`,
                JSON.stringify(serializeSession(session)),
                SESSION_REDIS_TTL_SECONDS,
            );
        } catch (error) {
            logger.debug('Failed to refresh session TTL in Redis (non-critical)', {
                error: String(error),
            });
        }
        return true;
    }
    return false;
}

// =========================================================================
// Safety: Background Cleanup Job
// =========================================================================

/**
 * Background sweep to stop orphaned transcode jobs and clean stale sessions.
 * Runs every 60 seconds. Sessions not receiving heartbeats for 30s are cleaned up.
 * Redis keys are TTL-based (5 min) and self-clean via Valkey expiry.
 */
async function runSessionExpiryCleanup(): Promise<void> {
    const now = Date.now();
    const toCleanup: { sessionId: string; session: PreviewSession }[] = [];

    for (const [sessionId, session] of activePreviews.entries()) {
        const timeSinceHeartbeat = now - session.lastHeartbeatAt.getTime();
        const timeSinceCreation = now - session.createdAt.getTime();

        if (
            timeSinceHeartbeat > PREVIEW_HEARTBEAT_TIMEOUT_MS ||
            timeSinceCreation > PREVIEW_SESSION_TTL_MS
        ) {
            toCleanup.push({ sessionId, session });
        }
    }

    for (const { sessionId, session } of toCleanup) {
        const timeSinceHeartbeat = now - session.lastHeartbeatAt.getTime();
        const timeSinceCreation = now - session.createdAt.getTime();
        const reason =
            timeSinceHeartbeat > PREVIEW_HEARTBEAT_TIMEOUT_MS
                ? 'no heartbeat (browser closed)'
                : 'TTL expired';

        // Split-brain guard: heartbeat PATCHes land on whichever backend the
        // edge routes them to and update THAT backend's in-memory copy (plus
        // the shared Valkey record). This backend's copy — often a rehydrated
        // read-only snapshot — can look heartbeat-dead while the viewer is
        // happily heartbeating via the peer. Cleaning it up would delete the
        // SHARED Valkey key and kill the session mid-play (the "hover preview
        // plays then reverts to backdrop" bug, prod 2026-07-17). Before a
        // no-heartbeat cleanup, consult the authoritative Valkey record; if it
        // is fresher, adopt it locally and skip. TTL-expiry cleanups proceed
        // regardless (absolute cap).
        if (reason === 'no heartbeat (browser closed)') {
            try {
                const raw = await cacheGet(`${REDIS_SESSION_PREFIX}${sessionId}`);
                const authoritative = raw ? deserializeSession(raw) : null;
                if (
                    authoritative &&
                    now - authoritative.lastHeartbeatAt.getTime() <= PREVIEW_HEARTBEAT_TIMEOUT_MS
                ) {
                    session.lastHeartbeatAt = authoritative.lastHeartbeatAt;
                    continue;
                }
            } catch {
                /* Valkey unreachable — fall through to local-only judgment */
            }
        }

        logger.info('Auto-cleanup expired preview session', {
            sessionId,
            transcodeMode: session.transcodeMode,
            reason,
            timeSinceHeartbeat: Math.floor(timeSinceHeartbeat / 1000),
            timeSinceCreation: Math.floor(timeSinceCreation / 1000),
        });

        await cleanupPreviewSession(sessionId, session, session.userId);
    }
}

setInterval(() => {
    void runSessionExpiryCleanup();
}, 60 * 1000); // Every minute

// =========================================================================
// Preview Creation / Deletion (business logic extracted from route)
// =========================================================================

export interface CreatePreviewParams {
    sql: Sql;
    itemId: string;
    /** Login handle — transcode-job identity, preview-session ownership, logging. */
    username: string;
    /** Stable users.id UUID — keys the Next-Up resolution (mig 16.46.0). */
    userId: UserId;
    internalId: string;
    fileId: string | undefined;
    startPositionSeconds: number;
    isLiveTv: boolean | undefined;
    /**
     * When true, force the planner to h264-only so a shared hero preview never
     * emits hevc/av1 (which some browsers can't decode). Default behavior
     * (browser-cap-driven codec selection) is unchanged when absent.
     */
    heroSafeCodec?: boolean;
    /** Resolve and serve a local trailer child of internalId instead of a snippet. */
    trailerPreferred?: boolean;
    /** With trailerPreferred: return { mode: 'none' } when no trailer exists
     *  instead of falling back to a snippet. Set by callers with a YouTube fallback. */
    trailerRequired?: boolean;
    /**
     * The caller's `locals.authMethod`. Decides which HLS surface the returned
     * `streamUrl` points at: token clients use `/api/v1/*`; delivery requests
     * carry scoped grants. Cookie/forward-auth clients use the `/api/*` BFF
     * mirror (forward-auth headers are stripped on `/api/v1`). Absent/unknown →
     * `/api/*` (the browser default). See previewHlsApiPrefix.
     */
    authMethod?: string;
    clientIp?: string;
    deviceSessionId?: string;
    parentTokenHash?: string;
    mintedByAdmin?: boolean;
}

/**
 * Which HLS API surface a preview `streamUrl` (and its child playlists/segments)
 * must live under, given the caller's auth method.
 *
 * Token clients use `/api/v1/*` and scoped grants for media delivery.
 * Cookie / forward-auth clients rely on the header-injecting
 * `/api/*` BFF mirror (the edge strips forward-auth headers on `/api/v1`). This
 * mirrors `isTokenBasedAuth` in the VOD HLS route (`.../hls/+server.ts`).
 */
function previewHlsApiPrefix(authMethod: string | undefined): 'api/v1' | 'api' {
    return authMethod === 'bearer' ||
        authMethod === 'pat' ||
        authMethod === 'service_token' ||
        authMethod === 'stream_token'
        ? 'api/v1'
        : 'api';
}

/** Mint a separate item/session-bound delivery credential for URL-only players. */
export async function buildPreviewStreamHref(
    caller: {
        userId: UserId;
        authMethod?: string;
        clientIp?: string;
        deviceSessionId?: string;
        parentTokenHash?: string;
        mintedByAdmin?: boolean;
    },
    mediaId: string,
    playbackSessionId: string,
    fileId: string,
): Promise<string> {
    const path = `/${previewHlsApiPrefix(caller.authMethod)}/playback/${mediaId}/hls/master.m3u8`;
    const query = new URLSearchParams({
        PlaySessionId: playbackSessionId,
        fileId,
        hlsAudioMode: 'muxed',
    });
    if (previewHlsApiPrefix(caller.authMethod) !== 'api/v1') return `${path}?${query}`;
    if (!caller.clientIp) throw new Error('Preview grant requires the authenticated client IP');
    const session = await getPreviewSession(playbackSessionId);
    if (!session || session.userId !== caller.userId || session.itemId !== mediaId)
        throw new Error('Preview grant requires an owned preview session');
    session.hasPlaybackGrant = true;
    try {
        await cacheSet(
            `${REDIS_SESSION_PREFIX}${playbackSessionId}`,
            JSON.stringify(serializeSession(session)),
            SESSION_REDIS_TTL_SECONDS,
        );
    } catch {
        logger.debug('Redis unavailable while recording preview grant; using local session');
    }
    const { mintPlaybackGrant, buildGrantedHref } = await import('./playback-grant');
    const grant = await mintPlaybackGrant({
        userId: caller.userId,
        mediaId,
        playbackSessionId,
        kind: 'preview',
        clientIp: caller.clientIp,
        deviceSessionId: caller.deviceSessionId,
        parentTokenHash: caller.parentTokenHash,
        mintedByAdmin: caller.mintedByAdmin,
        ttl: 60 * 60 * 1000,
    });
    return buildGrantedHref(grant, path, query);
}

export interface CreatePreviewResult {
    playSessionId: string;
    sessionItemId: string;
    streamUrl: string;
    playMethod: 'DirectPlay' | 'DirectStream' | 'Transcode';
    transcodeMode: 'local';
    hlsStartPosition: number;
    mode: 'trailer' | 'preview';
}

export type CreatePreviewOutcome =
    CreatePreviewResult | { mode: 'none' } | { error: string; status: number };

/**
 * Resolve a series Jellyfin ID to its appropriate episode ID.
 * Returns next unwatched episode, or first episode if not started, or null on failure.
 */
async function resolveSeriesIdToEpisodeId(
    seriesInternalId: string,
    mediaType: string,
    userId: UserId,
    _sql: Sql,
): Promise<{
    episodeId: string | null;
    episodeName?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    source?: 'local_db';
    error?: string;
}> {
    try {
        // Seasons need getNextUpForSeason — getNextUpForSeries joins through
        // parent_id and would never match when called with a season UUID.
        const nextEpisode = isSeason(mediaType)
            ? await watchManager.getNextUpForSeason(seriesInternalId, userId)
            : await watchManager.getNextUpForSeries(seriesInternalId, userId);
        if (nextEpisode) {
            return {
                episodeId: nextEpisode.media_id || '',
                episodeName: nextEpisode.title ?? undefined,
                seasonNumber: nextEpisode.season_number ?? undefined,
                episodeNumber: nextEpisode.episode_number ?? undefined,
                source: 'local_db',
            };
        }
    } catch (e) {
        logger.warn('Local DB read failed for next episode lookup', {
            error: e,
        });
    }
    return { episodeId: null, error: 'No playable episode found locally.' };
}

/**
 * Two preview requests for the same item whose seek positions fall within this
 * many seconds of each other are treated as "the same preview" and coalesced
 * onto one transcode job. The hero/hover UIs always request the same seek for a
 * given item, so this comfortably absorbs re-requests (rotation, re-mount,
 * hover re-entry, post-eviction retry) without spawning duplicate FFmpeg jobs.
 */
const PREVIEW_REUSE_SEEK_TOLERANCE_SECONDS = 15;

/**
 * Look for an already-running preview this user can reuse for the same item and
 * (approximately) the same seek position, instead of spawning a fresh FFmpeg
 * job. This is the primary defense against the create→evict→re-request thrash
 * loop: without it, every POST mints a new `preview-<item>-<Date.now()>` id and
 * a new transcode, so any client that re-requests the same items churns the CPU
 * indefinitely with zero forward progress.
 *
 * Returns a ready-to-serve result when a healthy session is found, else null.
 * A session is only reusable when its backing transcode job still exists and is
 * not in a terminal/stopping state — an evicted or errored session must fall
 * through to a fresh create so playback actually works.
 */
export async function findReusablePreview(params: {
    userId: UserId;
    requestedItemId: string;
    startPositionSeconds: number;
    isLiveTv: boolean | undefined;
    /**
     * Whether THIS request wants trailer playback. Must match the candidate
     * session's own `isTrailer` flag exactly — a snippet request must never
     * reuse a full-length trailer session (wrong content, wrong seek
     * semantics) and vice versa.
     */
    trailerPreferred?: boolean;
    /** Caller's `locals.authMethod` — selects the HLS surface for `streamUrl`.
     *  See previewHlsApiPrefix / CreatePreviewParams.authMethod. */
    authMethod?: string;
    clientIp?: string;
    deviceSessionId?: string;
    parentTokenHash?: string;
    mintedByAdmin?: boolean;
}): Promise<CreatePreviewResult | null> {
    const { userId, requestedItemId, startPositionSeconds, isLiveTv, trailerPreferred } = params;

    // Live TV previews have their own per-server/watcher accounting and a single
    // per-user slot; don't coalesce them here.
    if (isLiveTv) return null;

    let sessions: PreviewSession[];
    try {
        sessions = await getUserPreviewSessions(userId);
    } catch {
        return null;
    }
    if (sessions.length === 0) return null;

    const transcodeService = getFFmpegTranscodeService();

    for (const session of sessions) {
        if (session.isLiveTv) continue;
        // A trailer session's `itemId` is the resolved trailer CHILD's own
        // uuid, not the parent the client re-requests with — match on
        // `requestedItemId` (the original parent id, stamped at creation)
        // for trailer sessions so a re-open coalesces instead of spawning a
        // fresh transcode. Also require the session's trailer-ness to match
        // this request's — a non-trailer request must never reuse a trailer
        // session (and vice versa).
        if (!!session.isTrailer !== !!trailerPreferred) continue;
        const matchesRequestedItem = session.isTrailer
            ? session.requestedItemId === requestedItemId
            : session.itemId === requestedItemId;
        if (!matchesRequestedItem) continue;
        if (
            Math.abs(session.startPositionSeconds - startPositionSeconds) >
            PREVIEW_REUSE_SEEK_TOLERANCE_SECONDS
        ) {
            continue;
        }

        // The session record can outlive its backing transcode (global-cap
        // eviction, crash, error). Only reuse when it is genuinely still
        // serviceable — and the "backing transcode" is a different object
        // depending on whether the session is cache-backed.
        if (session.cacheKey) {
            // Cache-backed: the shared artifact runs under
            // `preview-cache-${cacheKey}`, NOT this viewer's playSessionId, so
            // check the artifact id (getJob(session.playSessionId) is always
            // undefined here). Reuse requires BOTH the store entry AND a live
            // in-memory job: the store entry outlives the job (scanOnStartup
            // indexes on-disk artifacts with no job; cleanupInactiveJobs reaps
            // a completed artifact's job after ~5 min idle), and serving reads
            // getJob(`preview-cache-<key>`).config — a store-only reuse would
            // hand back a session whose master.m3u8 410s. When the entry exists
            // but the job is gone, fall through to createPreview, which
            // re-warms the job into the existing artifact dir.
            const entry = getPreviewCacheStore().lookup(session.cacheKey);
            if (!entry) continue;
            const artifactJob = transcodeService.getJob(`preview-cache-${session.cacheKey}`);
            if (!artifactJob) continue;
            if (
                artifactJob.status === 'error' ||
                artifactJob.status === 'stopped' ||
                artifactJob.status === 'stopping'
            ) {
                continue;
            }
        } else {
            const job = transcodeService.getJob(session.playSessionId);
            if (!job) continue;
            if (job.status === 'error' || job.status === 'stopped' || job.status === 'stopping') {
                continue;
            }
        }
        if (!session.fileId) continue;

        // Keep the session warm: eviction orders victims by lastHeartbeatAt
        // (see pickEvictionVictim in preview-eviction.ts), so refreshing it
        // here keeps this session out of the front of that line the instant
        // we hand it back.
        await updateSessionHeartbeat(session.playSessionId).catch(() => {
            /* non-fatal: heartbeat refresh is best-effort */
        });

        // Cache-backed reuse: mint the NEW viewer their OWN session record over
        // the SAME shared artifact. Handing multiple viewers one playSessionId
        // meant whichever popup closed first DELETEd the session out from under
        // the others — heartbeat 404 → the hover preview silently reverted to
        // its backdrop mid-play (prod 2026-07-17). The expensive part (the
        // FFmpeg artifact) stays shared via cacheKey; the session record is
        // just a small Valkey/JSON entry, so per-viewer copies are cheap. The
        // clone also gets a fresh createdAt, so a re-hover no longer inherits
        // the first hover's absolute-TTL death clock.
        if (session.cacheKey) {
            const viewerSessionId = `preview-${session.itemId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
            const viewerSession: PreviewSession = {
                ...session,
                playSessionId: viewerSessionId,
                createdAt: new Date(),
                lastHeartbeatAt: new Date(),
            };
            await addPreviewSession(viewerSession);
            // This viewer pins the artifact with their own refcount, released
            // by THEIR delete/cleanup (replica-scoped, same as createPreview).
            getPreviewCacheStore().attach(session.cacheKey);
            cacheAttachedSessions.add(viewerSessionId);

            logger.info('[PreviewSession] Reusing preview artifact (per-viewer session)', {
                playSessionId: viewerSessionId,
                reusedFrom: session.playSessionId,
                itemId: session.itemId,
                requestedSeek: startPositionSeconds,
                sessionSeek: session.startPositionSeconds,
            });

            return {
                playSessionId: viewerSessionId,
                sessionItemId: session.itemId,
                streamUrl: await buildPreviewStreamHref(
                    params,
                    session.itemId,
                    viewerSessionId,
                    session.fileId,
                ),
                playMethod: 'Transcode',
                transcodeMode: 'local',
                hlsStartPosition: 0,
                mode: session.isTrailer ? ('trailer' as const) : ('preview' as const),
            };
        }

        // Non-cache-backed (preview cache disabled): the FFmpeg job is keyed by
        // the ORIGINAL playSessionId, so a per-viewer id would orphan serving —
        // keep the legacy shared-id reuse for this rare configuration.
        logger.info('[PreviewSession] Reusing live preview session (coalesced)', {
            playSessionId: session.playSessionId,
            itemId: session.itemId,
            requestedSeek: startPositionSeconds,
            sessionSeek: session.startPositionSeconds,
            cacheBacked: false,
        });

        return {
            playSessionId: session.playSessionId,
            sessionItemId: session.itemId,
            streamUrl: await buildPreviewStreamHref(
                params,
                session.itemId,
                session.playSessionId,
                session.fileId,
            ),
            playMethod: 'Transcode',
            transcodeMode: 'local',
            hlsStartPosition: 0,
            mode: session.isTrailer ? ('trailer' as const) : ('preview' as const),
        };
    }

    return null;
}

/**
 * Resolve a stable "version" string for a media file, used as part of the
 * preview cache key so a re-scan/re-mux that changes the underlying bytes
 * (new hash, size, or mtime) invalidates any previously cached preview
 * artifact instead of silently serving stale content.
 *
 * Deliberately does NOT use `updated_at` — that column can change for
 * reasons unrelated to file content (e.g. metadata edits), which would
 * invalidate the cache far more often than necessary.
 *
 * Returns `null` — "indeterminate identity" — when file_hash_head,
 * file_size_bytes, AND file_mtime are ALL null/absent (e.g. the row hasn't
 * been probed yet, or doesn't exist). Without this, every such file would
 * collapse onto the same literal `"null:0"` key forever and never rotate
 * even when the underlying content genuinely changes; callers must treat a
 * `null` return as "do not cache this preview" rather than build a key
 * from it.
 */
export async function resolveFileVersion(sql: Sql, fileId: string): Promise<string | null> {
    const rows = await sql<
        { file_hash_head: string | null; file_size_bytes: number | null; file_mtime: Date | null }[]
    >`
        SELECT file_hash_head, file_size_bytes, file_mtime
        FROM media_files
        WHERE id = ${fileId}
    `;
    const row = rows[0];
    const fileHashHead = row?.file_hash_head ?? null;
    if (fileHashHead) return fileHashHead;
    const fileSizeBytes = row?.file_size_bytes ?? null;
    const fileMtime = row?.file_mtime ?? null;
    if (fileSizeBytes === null && fileMtime === null) {
        return null;
    }
    return `${fileSizeBytes}:${fileMtime ? new Date(fileMtime).getTime() : 0}`;
}

/**
 * Core preview creation logic — resolves media, probes with ffprobe, runs PlaybackPlanner
 * with intent:'preview', starts HLS transcode job, and returns session info.
 */
export async function createPreview(params: CreatePreviewParams): Promise<CreatePreviewOutcome> {
    const {
        sql,
        itemId,
        username,
        userId,
        internalId: bodyInternalId,
        fileId: bodyFileId,
        startPositionSeconds,
        isLiveTv,
        heroSafeCodec,
    } = params;

    let seekSeconds = startPositionSeconds;

    let isTrailer = false;
    let effectiveInternalId = bodyInternalId;
    // trailerRequired implies trailer mode even when the caller omitted
    // trailerPreferred — a caller that only wants a "real trailer or nothing"
    // answer still needs the trailer-resolution branch to run (else it would
    // fall through to a plain snippet instead of ever seeing `mode: 'none'`).
    if (params.trailerPreferred || params.trailerRequired) {
        const trailerId = await findLocalTrailerForItem(sql, bodyInternalId);
        if (trailerId) {
            isTrailer = true;
            effectiveInternalId = trailerId;
            // Trailers always start at 0 — the client's resume/30s-floor
            // startPositionSeconds is a snippet concept.
            seekSeconds = 0;
        } else if (params.trailerRequired) {
            return { mode: 'none' };
        }
    }

    // Trailers always transcode to the universal h264/AAC profile: they play
    // with sound on every surface (modal overlay, Safari native HLS included),
    // and a caps-driven HEVC plan gives Safari audio-without-video (hev1/MSE
    // trap). Short clips — compatibility beats quality here.
    const effectiveHeroSafe = heroSafeCodec || isTrailer;

    const initialInternalId: string = effectiveInternalId;

    // Item is locally playable if it has at least one video stream in the DB
    const isPlayable = initialInternalId
        ? (await getStreamsForMediaItem(sql, initialInternalId)).some(
              (s) => s.stream_type === 'video',
          )
        : false;

    let resolvedEpisodeInternalId: string | undefined;

    // Live TV channels don't go through the "resolve to playable episode" flow;
    // their media_streams row is produced by the tuner pipeline, not ffprobe, so
    // the isPlayable check above can legitimately return false. The caller
    // (`+server.ts`) has already run live-TV rate limiting, so once we see the
    // flag we skip the gate entirely and let the planner/probe handle it.
    if (!isPlayable && !isLiveTv) {
        // No video streams in DB. Two possibilities:
        //   1. media_type is series/season → the item is a parent; resolve to Next Up episode.
        //   2. anything else (movie/episode/tvchannel/audio/…) → no local file to preview.
        // Branch on the shared media-type helpers (case-insensitive) because
        // `media_items.media_type` is stored lowercase (`'tv'`, not `'series'`),
        // while legacy code and tests may pass other casings.
        const mediaType = initialInternalId ? await getMediaType(sql, initialInternalId) : null;

        if (!isSeries(mediaType) && !isSeason(mediaType)) {
            // Before giving up, check whether there's a local file at all.
            // An episode may have a file without indexed streams if it was
            // added to the library but FFprobe hasn't run yet. FFprobe in
            // createPreview will discover the streams dynamically from the file.
            const filesCheck = await getFilesForMediaItem(sql, initialInternalId);
            if (filesCheck.length === 0) {
                logger.info(
                    '[PreviewSession] Media has no local video streams or file — nothing to preview',
                    { internalId: initialInternalId, mediaType },
                );
                return {
                    error: 'This item has no local file available for preview.',
                    status: 404,
                };
            }
            logger.info(
                '[PreviewSession] Episode has file but no indexed streams, will probe dynamically',
                { internalId: initialInternalId, mediaType },
            );
            // resolvedEpisodeInternalId stays undefined so code below uses
            // initialInternalId directly. Skip series resolution entirely.
        } else {
            logger.info(
                '[PreviewSession] Series/season has no direct streams, resolving to Next Up episode',
                { internalId: initialInternalId, mediaType },
            );
            const resolved = await resolveSeriesIdToEpisodeId(
                initialInternalId,
                mediaType ?? '',
                userId,
                sql,
            );
            if (resolved.error || !resolved.episodeId) {
                logger.info('[PreviewSession] Series/season has no resolvable Next Up episode', {
                    internalId: initialInternalId,
                    error: resolved.error,
                });
                return {
                    error: resolved.error || 'No playable episode found for this series.',
                    status: 404,
                };
            }

            resolvedEpisodeInternalId = resolved.episodeId;
            logger.info('[PreviewSession] Local mode: Resolved Series to episode', {
                seriesId: initialInternalId,
                episodeId: resolved.episodeId,
                episodeName: resolved.episodeName,
                season: resolved.seasonNumber,
                episode: resolved.episodeNumber,
                source: resolved.source,
            });

            try {
                const watchState = await getUserWatchState.one(sql, {
                    userId,
                    mediaId: resolvedEpisodeInternalId,
                });
                if (watchState && Number(watchState.resume_position_ms) > 0) {
                    seekSeconds = Math.floor(Number(watchState.resume_position_ms) / 1000);
                    logger.info('[PreviewSession] Local mode: Using DB resume position', {
                        episodeId: resolvedEpisodeInternalId,
                        seekSeconds,
                        clientSeekSeconds: startPositionSeconds,
                    });
                }
            } catch (err) {
                logger.warn('[PreviewSession] Local mode: Failed to load episode watch state', {
                    episodeId: resolvedEpisodeInternalId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }

            const episodeStreams = await getStreamsForMediaItem(sql, resolvedEpisodeInternalId);
            if (!episodeStreams.some((s) => s.stream_type === 'video')) {
                logger.info(
                    '[PreviewSession] Resolved Next Up episode has no local video streams',
                    {
                        seriesId: initialInternalId,
                        episodeId: resolvedEpisodeInternalId,
                    },
                );
                return {
                    error: 'Resolved episode has no local file available for preview.',
                    status: 404,
                };
            }
        }
    }

    // Use resolved episode ID if we resolved from series, otherwise the original internal ID.
    // Also update itemId so the stream URL and session point at the playable episode,
    // not the series (HLS resolves files from itemId and would fail for a series).
    const internalId = resolvedEpisodeInternalId ?? initialInternalId;
    const resolvedItemId = internalId ?? itemId;

    // Get media source path from DB
    let localFilePath: string | undefined;
    let resolvedFileId: string | undefined;
    if (internalId) {
        const files = await getFilesForMediaItem(sql, internalId);
        const targetFile = bodyFileId ? files.find((f) => f.id === bodyFileId) : files[0];
        if (bodyFileId && !targetFile) {
            logger.warn('[PreviewSession] Requested fileId does not belong to media item', {
                bodyFileId,
                internalId,
                availableFileIds: files.map((f) => f.id),
            });
            return {
                error: 'The requested file does not belong to this media item.',
                status: 400,
            };
        }
        resolvedFileId = targetFile?.id;
        if (targetFile?.file_path) {
            const resolved = await resolveMediaPath(targetFile.file_path, {
                skipLocalAccessCheck: true,
            });
            if (resolved?.isAccessible) {
                localFilePath = resolved.containerPath;
            }
        }
    }

    if (!localFilePath) {
        logger.warn('[PreviewSession] Local mode: Media file not found in local DB', {
            itemId,
            internalId,
        });
        return {
            error: 'Media file not accessible for local transcoding. Ensure the library is synced.',
            status: 404,
        };
    }

    // Probe media file and build PlaybackPlan via planner. Memoized per file so
    // a repeat hover of the same title skips the ffprobe (the dominant
    // time-to-start cost). Only successful probes are cached.
    let probe = memoGet(probeMemo, localFilePath);
    if (!probe) {
        probe = await probeMediaFile(localFilePath);
        if (probe.success) {
            memoSet(probeMemo, localFilePath, probe);
        }
    }
    if (!probe.success) {
        logger.warn('[PreviewSession] ffprobe failed', {
            localFilePath,
            error: probe.error,
        });
        return {
            error: 'Failed to probe media file for preview.',
            status: 500,
        };
    }

    const maxAudioChannels = probe.audioStreams.reduce(
        (max, a) => Math.max(max, a.channels ?? 0),
        0,
    );
    const mediaInfo = {
        videoCodec: probe.video?.codec ?? '',
        videoBitDepth: parseBitDepth(probe.video?.pixelFormat),
        videoProfile: probe.video?.profile ?? undefined,
        videoLevel: probe.video?.level ?? undefined,
        width: probe.video?.width ?? undefined,
        height: probe.video?.height ?? undefined,
        bitrate: probe.formatBitrate ?? probe.video?.bitrate ?? undefined,
        audioCodecs: probe.audioStreams.map((a) => a.codec).filter(Boolean),
        audioTrackCount: probe.audioStreams.length,
        audioChannels: maxAudioChannels > 0 ? maxAudioChannels : undefined,
        container: containerFromExtension(localFilePath) ?? probe.container ?? '',
        hdr: probe.video?.hdr ?? 'sdr',
    } as const;

    if (!resolvedFileId) {
        logger.error(
            '[PreviewSession] resolvedFileId unexpectedly undefined after file resolution',
            undefined,
            { itemId: resolvedItemId, internalId },
        );
        return {
            error: 'Internal error: could not resolve file ID.',
            status: 500,
        };
    }
    const fileIdForPlan = resolvedFileId;
    // The plan depends only on the file + heroSafeCodec (mediaInfo derives from
    // the file's probe, serverEncode is server-stable), so memoize it — a repeat
    // hover skips the planner + the GPU-cap probe inside buildServerEncodeCaps.
    const planMemoKey = `${fileIdForPlan}:${effectiveHeroSafe ? 1 : 0}`;
    let plan = memoGet(planMemo, planMemoKey);
    if (!plan) {
        const serverEncode = await buildServerEncodeCaps();

        // For a hero shown to every visitor, force the most universally decodable
        // codec by constraining the planner's browser caps to h264 only (audio
        // already normalizes to AAC below). Without the flag, caps are unchanged.
        const planCaps = defaultBrowserCaps();
        if (effectiveHeroSafe) {
            planCaps.videoCodecs = new Set(['h264']);
        }

        plan = (
            await playbackPlanner.createPlan({
                intent: 'preview',
                fileId: fileIdForPlan,
                mediaInfo,
                caps: planCaps,
                serverEncode,
                deliveryPath: 'mse_hls',
                enableHdrPreservation: false,
            })
        ).plan;
        memoSet(planMemo, planMemoKey, plan);
    }

    // Get audio streams for track selection
    //
    // TWO shapes of the same list, deliberately:
    //   availableAudioStreams  AudioStreamInfo[]  — index is AUDIO-RELATIVE, fed
    //                                               to the shared track resolver
    //   previewAudioTracks     AudioTrackInfo[]   — index is ABSOLUTE (branded),
    //                                               fed to startJob
    // Muxed mode resolves `hlsAudioTrackIndex` (absolute) to an array POSITION
    // via resolveAudioTrackByAbsoluteIndex, so the list handed to startJob must
    // be the file's FULL audio list in stream_index order. A one-element array
    // makes that translation meaningless — see the note below.
    let availableAudioStreams: AudioStreamInfo[] = [];
    let previewAudioTracks: AudioTrackInfo[] = [];
    // An empty audio list means two OPPOSITE things, and conflating them is
    // what made every silent film's hover preview die:
    //
    //   • probed, and the file genuinely has no audio — the video-only
    //     renditions this app ships deliberately, and most of a public-domain
    //     film library. The right answer is to map NO audio at all.
    //   • not probed yet — we know nothing about the layout, so the historical
    //     single synthetic track below is the right degrade.
    //
    // Conflating them synthesized a phantom audio track for audio-less files.
    // That phantom is not harmless metadata: it defeats the "does this track
    // exist?" guard in full-transcode-strategy's muxed branch (the guard tests
    // the ARRAY, and the array had an entry), so ffmpeg was asked to `-map
    // 0:a:0` on a file with one video stream and exited 234 with "Stream map ''
    // matches no streams" before writing a single segment.
    //
    // ANY `media_streams` row for the previewed FILE is the discriminator. The
    // probe writes a file's streams in one pass (replaceStreamsForFile), so a
    // video row sitting there with no audio row beside it is a positive
    // statement that this file has no audio — not an absence of information.
    //
    // getStreamsForMediaItem returns the streams of EVERY file linked to the
    // item, so the rows are narrowed to the file being previewed. Unfiltered, a
    // movie with a 1080p and a 2160p file interleaved both files' audio (prod:
    // `1,1,2,2,3`), the absolute->position resolve in muxed mode landed on
    // position 2 of a two-track file, and ffmpeg exited 234 on `-map 0:a:2`.
    let audioLayoutKnown = false;
    if (internalId) {
        const dbStreamRows = (await getStreamsForMediaItem(sql, internalId)).filter(
            (row) => row.file_id === resolvedFileId,
        );
        audioLayoutKnown = dbStreamRows.length > 0;
        // ORDERed BY stream_type, stream_index, so filtering down to audio
        // preserves stream_index order and the array position IS the
        // audio-relative index dbRowToAudioStreamInfo wants.
        const dbAudioRows = dbStreamRows.filter((row) => row.stream_type === 'audio');
        availableAudioStreams = dbAudioRows.map((row, i) => dbRowToAudioStreamInfo(row, i));
        previewAudioTracks = dbAudioRows.map(dbRowToAudioTrackInfo);
    }
    if (!audioLayoutKnown) {
        availableAudioStreams = [
            {
                index: 0,
                absoluteIndex: 0,
                codec: 'aac',
                channels: 2,
                language: 'und',
                displayTitle: 'Default',
                isDefault: true,
                isForced: false,
            },
        ];
        // Mirror of the synthetic entry above, in the absolute-index shape. We
        // know nothing about the real layout here, so absolute 0 stands in and
        // muxed's absolute->position resolve lands on position 0 — i.e. the
        // file's first audio stream, which is what this path did before.
        previewAudioTracks = [
            {
                index: asAbsoluteStreamIndex(0),
                displayTitle: 'Default',
                language: 'und',
                channels: 2,
                codec: 'aac',
                isDefault: true,
            },
        ];
    }

    // Resolve the preview's audio track with the SAME resolver the player and
    // lumastra-info use. This path used to run a second, independently-written
    // resolver that knew only `audio_language` — so
    // a viewer with "prefer original language" on, or a learned language from
    // their last in-player pick, got a different track in the hover preview
    // than in the actual player.
    //
    // Best effort throughout: a preview is a nicety, and any failure here
    // should degrade to the file's own default rather than break the hover.
    let languagePrefs: LanguagePreferences = {
        preferOriginalAudio: false,
        audioLanguage: null,
        lastAudioLanguage: null,
        subtitleLanguage: null,
        subtitlesEnabled: false,
        forcedSubtitlesEnabled: false,
        subtitleTrackHint: null,
    };
    try {
        const prefsRow = await getPlaybackPreferences.one(sql, { userId });
        if (prefsRow) languagePrefs = parseLanguagePreferences(prefsRow);
    } catch {
        // Non-fatal: fall back to default track
    }

    // `preferOriginalAudio` is meaningless without the title's original
    // language, and omitting it would silently demote that preference on the
    // preview path only.
    let originalLanguage: string | null = null;
    if (internalId && languagePrefs.preferOriginalAudio) {
        try {
            originalLanguage =
                (await getMediaItemForWatch(sql, internalId))?.original_language ?? null;
        } catch {
            // Non-fatal: the resolver simply skips the original-language pass.
        }
    }

    // Audio only — a preview has no subtitle tracks at all, so calling
    // resolveTracks with an empty subtitle list and discarding half the answer
    // would be pretending at a shared path rather than having one.
    const fileDefaultIndex =
        availableAudioStreams.find((a) => a.isDefault)?.index ??
        availableAudioStreams[0]?.index ??
        0;
    const selection = resolvePreferredAudioTrack(
        availableAudioStreams,
        {
            preferOriginalAudio: languagePrefs.preferOriginalAudio,
            audioLanguage: languagePrefs.audioLanguage,
            lastAudioLanguage: languagePrefs.lastAudioLanguage,
        },
        originalLanguage,
        fileDefaultIndex,
    );
    // The resolver answers in the candidates' own `index` convention, which for
    // AudioStreamInfo is AUDIO-RELATIVE. What follows is consumed as an
    // `AudioTrackInfo` (startJob's `audioTracks`), whose `.index` is ABSOLUTE.
    // Look the stream back up and take `absoluteIndex`; never pass `index` through.
    const selectedStream = availableAudioStreams.find((a) => a.index === selection.index);
    // Only a stream carrying a real `absoluteIndex` can be honoured. Falling
    // back to the stream's own `index` would pass an AUDIO-RELATIVE value off
    // as an absolute one — the precise substitution `AbsoluteStreamIndex`
    // exists to make impossible, so it must not be laundered through a `??`.
    // Both producers of these streams always populate it; the schema merely
    // still types it optional.
    const selectedAbsolute = selectedStream?.absoluteIndex;
    // The job config that carries the selection to ffmpeg.
    //
    // `hlsAudioTrackIndex` is set ONLY when a real absolute index was resolved.
    // When it is absent the strategy falls back to `defaultAudioAbsoluteIndex`
    // — the file's own default track — which is the right degrade. Passing a
    // laundered 0 instead would name the VIDEO stream on essentially every
    // file, which is the exact substitution AbsoluteStreamIndex exists to stop.
    const previewHlsOutput: HlsOutputConfig = {
        hlsAudioMode: 'muxed',
        ...(selectedAbsolute !== undefined ? { hlsAudioTrackIndex: selectedAbsolute } : {}),
    };

    // ========================================================================
    // The resolved track reaches ffmpeg via MUXED mode. Three parts, all required.
    // ========================================================================
    // This used to be a KNOWN LIMITATION: the resolver above picked the right
    // track and nothing carried it to ffmpeg. `audioTracks: [resolvedAudioTrack]`
    // with no `hlsOutput` left `hlsAudioMode` unset, so full-transcode-strategy
    // took the DEMUX branch, which maps by ARRAY POSITION
    // (`for i in audioTracks: mapAudio(0, i)`). One element meant one call,
    // `-map 0:a:0` — the file's FIRST audio stream, whatever the viewer preferred.
    // Worse, `resolvedAudioTrack.language` still went into the preview manifest,
    // so on any file whose preferred track is not stream 0 the manifest
    // MISLABELLED the audio it was actually serving.
    //
    // Demux cannot express "one specific track": it maps the first N audio
    // streams in order, so selecting track 3 alone is not something that branch
    // can do. Muxed can — it resolves an ABSOLUTE index to an array position via
    // resolveAudioTrackByAbsoluteIndex. Hence:
    //
    //   1. `audioTracks` is the file's FULL list in stream_index order
    //      (previewAudioTracks). The absolute->position translation is only
    //      meaningful against the complete list; a one-element array would
    //      resolve to position 0 again and change nothing.
    //   2. `hlsOutput: { hlsAudioMode: 'muxed', hlsAudioTrackIndex: <absolute> }`
    //      so the strategy selects that one track instead of muxing every
    //      audio stream into a hover preview.
    //   3. The preview's own `streamUrl` carries `hlsAudioMode=muxed`. This is
    //      the part that is easy to miss: playback.service computes
    //      `isMuxedMode` from the REQUEST (line ~1061), BEFORE the job is
    //      resolved — so a muxed job served by a URL that does not say muxed
    //      gets a DEMUX master describing stream_0/stream_1 renditions that
    //      muxed FFmpeg never writes, and every one of them 404s. The VOD path
    //      already pins the mode on its follow-up URL for exactly this reason.
    //
    // Output shape changes with it: a flat index.m3u8 instead of the 2-rendition
    // demux structure. That is consistent with how previews are read back —
    // playback.service's readiness wait is already branch-aware (muxed waits for
    // index.m3u8, demux for master.m3u8), and buildAudioOnlyArgs depends on the
    // same job-config/args pairing.
    // ========================================================================

    // Append a short random suffix: two viewers hovering the same item in the
    // same millisecond on one replica would otherwise collide on this id,
    // sharing one entry in the replica-scoped `cacheAttachedSessions` Set —
    // one detach for two attaches pins the shared artifact's refcount and it
    // is never evicted until restart. `.startsWith('preview-')` callers and
    // the cacheKey (not positional parsing) are unaffected by the extra
    // segment.
    const playSessionId = `preview-${resolvedItemId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const transcodeService = getFFmpegTranscodeService();

    // Preview transcode decision. The planner put a hardware encoder in
    // `plan.gpu_encoder`, but the decision engine only HONORS it (→ GPU, and
    // crucially → HDR tonemapping) when startJob receives a `mediaSourceInfo`
    // (→ consumePlan); without it the job runs a decision-less software encode
    // with no tonemapping (the historical preview behavior). Two cases:
    //
    //  • HDR source: the QSV VPP tonemap (vpp_qsv=tonemap=1) washes HDR out; the
    //    reliable HDR→SDR path is the SOFTWARE `tonemapx` filter, which only runs
    //    on a software encoder. So HDR previews ALWAYS run the decision (for
    //    needs_tonemapping) but are forced onto libx264 (see `forceSoftware` /
    //    planForJob below), independent of the GPU budget, and take no GPU slot.
    //  • SDR source: no tonemapping to get wrong, so take the GPU fast path only
    //    when HW encoding is configured AND we're under the concurrent-GPU-preview
    //    budget — otherwise stay on the historical CPU path so bursty hovers can
    //    never starve real playback of the GPU's limited encode sessions.
    //
    // Live TV has no stable file to probe → always the historical CPU path. The
    // probe is DB-cached (fast) and any failure degrades safely.
    const isHdrSource = !isLiveTv && !!mediaInfo.hdr && mediaInfo.hdr !== 'sdr';

    let mediaSourceInfo: MediaSourceInfo | undefined;
    let forceSoftware = false;
    let gpuReservationHeld = false;
    // Idempotent release of this preview's GPU reservation. Called once the
    // artifact job is registered (after store.acquire / startJob, where
    // countActiveGpuPreviewJobs() then accounts for it) and defensively in the
    // unwind catch, so a throw between reservation and job-start can't leak a
    // slot (which would permanently shrink the GPU-preview budget until restart).
    const releaseGpuReservation = (): void => {
        if (gpuReservationHeld) {
            gpuReservationHeld = false;
            inFlightGpuPreviewStarts--;
        }
    };
    // Build the mediaSourceInfo (drives consumePlan → tonemapping + encoder
    // choice) from DB-cached streams. Returns false on probe failure / no video
    // so callers degrade to the historical no-decision path.
    const buildMediaSourceInfo = async (mediaItemId: string): Promise<boolean> => {
        // Memoized per file: `undefined` = not probed yet, `null` = probed but no
        // usable video / probe failed (don't re-probe), else the stream list.
        let streams = memoGet(transcodeStreamsMemo, resolvedFileId);
        if (streams === undefined) {
            try {
                const mediaProbe = await probeForTranscode(
                    sql,
                    mediaItemId,
                    localFilePath,
                    undefined,
                    {
                        fileId: resolvedFileId,
                    },
                );
                streams = mediaProbe.streams.some((s) => s.type === 'Video')
                    ? mediaProbe.streams
                    : null;
            } catch (err) {
                logger.warn('[PreviewSession] preview probe failed, using historical CPU path', {
                    internalId: mediaItemId,
                    error: err instanceof Error ? err.message : String(err),
                });
                streams = null;
            }
            memoSet(transcodeStreamsMemo, resolvedFileId, streams);
        }
        if (streams) {
            mediaSourceInfo = {
                id: resolvedFileId,
                path: localFilePath,
                container: mediaInfo.container || undefined,
                bitrate: probe.formatBitrate ?? probe.video?.bitrate ?? undefined,
                streams,
            };
            return true;
        }
        return false;
    };
    const gpuPreviewsEnabled =
        config.HW_ENCODING_ENABLED &&
        config.GPU_ACCELERATION !== 'none' &&
        config.PREVIEW_MAX_GPU_JOBS > 0;

    if (internalId && !isLiveTv && isHdrSource) {
        // HDR → decide + tonemap on the software encoder, no GPU slot.
        forceSoftware = true;
        await buildMediaSourceInfo(internalId);
    } else if (
        gpuPreviewsEnabled &&
        !isLiveTv &&
        internalId &&
        // Check budget and reserve in ONE synchronous step (no await between the
        // read and the increment) so concurrent hovers can't both observe the
        // same sub-budget count and both proceed to GPU.
        transcodeService.countActiveGpuPreviewJobs() + inFlightGpuPreviewStarts <
            config.PREVIEW_MAX_GPU_JOBS
    ) {
        inFlightGpuPreviewStarts++;
        gpuReservationHeld = true;
        const built = await buildMediaSourceInfo(internalId);
        // Probe found no usable video (or failed) → hand the reservation back
        // immediately instead of holding it to job-start.
        if (!built) {
            releaseGpuReservation();
        }
    }

    // For an HDR source, strip the plan's hardware encoder so consumePlan yields
    // useGpu=false + a software encoder (libx264) while KEEPING needs_tonemapping
    // — i.e. the reliable software tonemapx runs instead of the washed-out
    // vpp_qsv tonemap. Shallow copy so the planner's cached plan object is never
    // mutated. SDR / no-decision previews pass the plan unchanged. The cacheKey
    // does not encode encoder choice, so a software-tonemapped HDR artifact and
    // any other warm of the same key stay interchangeable.
    const planForJob =
        mediaSourceInfo && forceSoftware
            ? { ...plan, gpu_encoder: undefined, gpu_decoder: undefined }
            : plan;

    const maxWidth = getConfig<number>('PREVIEW_MAX_WIDTH');
    const maxHeight = getConfig<number>('PREVIEW_MAX_HEIGHT');
    const encodingPreset = getConfig<string>('PREVIEW_ENCODING_PRESET');
    const nvencPreset = getConfig<string>('PREVIEW_NVENC_PRESET');

    // Trailers play full-length instead of the short hover/preview snippet —
    // lift the clamp everywhere the 30s snippet cap is otherwise applied.
    const previewMaxSeconds = isTrailer
        ? config.TRAILER_MAX_SECONDS
        : config.PREVIEW_TRANSCODE_MAX_SECONDS;

    // Live TV has no stable file identity to hash (no media_files row / the
    // stream is genuinely live), so it never goes through the content-
    // addressed cache — same exclusion findReusablePreview already applies
    // to the reuse-by-seek coalescing above.
    const cachePreconditionsMet = config.PREVIEW_CACHE_ENABLED && !isLiveTv;

    // Resolved up front (only when otherwise eligible) so an indeterminate
    // fileVersion — no file_hash_head/size/mtime signal at all — can bypass
    // the cache entirely instead of every such file colliding onto the same
    // literal key forever (see resolveFileVersion's null-return contract).
    const fileVersion = cachePreconditionsMet
        ? await resolveFileVersion(sql, resolvedFileId)
        : null;
    const cacheEnabled = cachePreconditionsMet && fileVersion !== null;

    // Set only on the cache path — lets the outer try/catch and the returned
    // session know whether a shared cache artifact (vs. a session-owned job)
    // is backing this preview.
    let cacheKey: string | undefined;
    let transcodeJobId: string | undefined;
    // Deferred re-warm of a reaped cache-backed artifact job. Assigned in the
    // cache branch below but INVOKED inside the unwind-safe try further down, so
    // a re-warm failure releases the store refcount via that try's catch. Stays
    // null on the non-cache path. See its assignment site for the full rationale.
    let ensureArtifactJobResident: (() => Promise<void>) | null = null;

    if (cacheEnabled && fileVersion !== null) {
        const videoCodec = config.PREVIEW_FORCE_UNIVERSAL_CODEC
            ? 'h264'
            : (plan.target_video_codec ?? config.PREVIEW_VIDEO_CODEC);
        const profile: PreviewProfile = {
            videoCodec,
            audioCodec: 'aac',
            audioTrackIndex: previewHlsOutput.hlsAudioTrackIndex ?? null,
            maxWidth,
            maxHeight,
            maxDurationSeconds: previewMaxSeconds,
            encodingPreset,
        };
        const key = buildPreviewKey({
            fileId: resolvedFileId,
            rawSeekSeconds: seekSeconds,
            bucketSeconds: PREVIEW_REUSE_SEEK_TOLERANCE_SECONDS,
            profile,
            fileVersion,
        });
        // Stable id the FFmpeg job (the shared artifact) runs under — distinct
        // from the per-viewer playSessionId. store.acquire()'s single-flight
        // guarantees exactly one job spawns per key even under a concurrent
        // burst of viewers requesting the same (file, seek-bucket, profile).
        const artifactSessionId = `preview-cache-${key}`;
        const bucket = seekBucket(seekSeconds, PREVIEW_REUSE_SEEK_TOLERANCE_SECONDS);
        const store = getPreviewCacheStore();

        // Rough estimate of the in-flight artifact's disk footprint so the
        // budget accounts for warming jobs (currently 0 bytes until
        // markReady replaces this with the real measured size). 720p≈4 Mbps
        // baseline scaled by pixel count and clamped duration.
        const estBytes = Math.round(
            ((maxWidth * maxHeight) / (1280 * 720)) * (4_000_000 / 8) * previewMaxSeconds,
        );

        // Starts (or restarts) the shared artifact's FFmpeg job into `dir`.
        // Reused by BOTH the acquire() factory (cache miss) and the
        // job-liveness re-warm below (cache hit whose in-memory job is gone).
        // startJob() only STARTS the transcode (resolves fast, per
        // PreviewCacheStore contract) — the artifact stays `warming` until
        // FFmpeg's onExit hook flips it ready/failed via cacheKey.
        const startArtifactJob = async (dir: string): Promise<void> => {
            await transcodeService.startJob({
                itemId: resolvedItemId,
                username,
                deviceId: 'preview-player',
                playSessionId: artifactSessionId,
                inputUrl: '',
                transcodeMode: 'full',
                localFilePath,
                // FULL list + muxed hlsOutput ⇒ the resolved track actually
                // reaches ffmpeg. See the note where previewHlsOutput is built.
                audioTracks: previewAudioTracks,
                hlsOutput: previewHlsOutput,
                subtitleTracks: [],
                videoInfo: {
                    // `codec`/`bitDepth` describe the SOURCE (they key the GPU
                    // decode-capability deny-map on a learn-on-failure exit);
                    // `outputCodec` is the encode target. Passing the target as
                    // `codec` — or omitting the depth — makes a Hi10P failure
                    // land on the bare "h264" key and software-decode every
                    // 8-bit H.264 source. See markSourceNotHardwareDecodable.
                    codec: mediaInfo.videoCodec || videoCodec,
                    bitDepth: mediaInfo.videoBitDepth,
                    // Source dimensions, not the preview cap: computeMaxDimensions
                    // reads `height` as the SOURCE height to decide whether a
                    // GPU-less host must cap the encode at 1080p. Passing the cap
                    // here made a 4K source look like a 720p one and skipped it.
                    width: mediaInfo.width ?? maxWidth,
                    height: mediaInfo.height ?? maxHeight,
                    outputCodec: videoCodec,
                    isTranscoded: true,
                },
                // Canonical bucket position, NOT the raw seek — every viewer
                // whose seek falls in this bucket shares this exact artifact.
                startTimeSeconds: bucket,
                fileId: resolvedFileId,
                playbackPlan: planForJob,
                // Present only when under the GPU-preview budget; enables the
                // consumePlan → hardware-encoder path (else undefined → CPU).
                // The cacheKey does NOT encode GPU-vs-CPU (output is h264 either
                // way), so a GPU-warmed and a CPU-warmed artifact are equivalent
                // and interchangeable under the same key.
                mediaSourceInfo,
                encodingPreset,
                nvencPreset,
                // Short segments → the first playable segment is ready far sooner,
                // cutting cold-preview first-frame latency.
                segmentDurationSeconds: config.PREVIEW_SEGMENT_DURATION,
                isPreview: true,
                outputDir: dir,
                cacheKey: key,
                maxDurationSeconds: isTrailer ? config.TRAILER_MAX_SECONDS : undefined,
                // Whole-file duration (NOT the clip length) — matches the main
                // playback path (playback.service.ts). Without it, handleExit's
                // code===0 completion branch never corrects job.segmentsReady
                // from its stderr-parsed value, which can still read 0 for a
                // preview that finishes encoding faster than one -stats tick —
                // a cosmetic "0 segments" reading in the logs for an artifact
                // that actually completed correctly on disk.
                totalDurationSeconds: probe.duration ?? undefined,
            });
        };

        const entry = await store
            .acquire(
                key,
                async (dir) => {
                    // Best-effort clear any stale transcode-service job entry left
                    // under this exact artifact id — evictToBudget()/markFailed()
                    // delete the store entry + on-disk dir but do NOT touch the
                    // transcode service's own job map, so a prior warm for this key
                    // that was evicted/failed can leave a dead job behind. Without
                    // this, startJob() below could find that stale job (rather than
                    // starting a fresh one) or the FFmpeg service could still think
                    // the now-deleted dir is in use. This only runs once per warm —
                    // store.acquire()'s single-flight guarantees that — so it never
                    // races a healthy, currently-warming job for the same key.
                    // stopJob() on an id with no job is a safe no-op.
                    await transcodeService.stopJob(artifactSessionId).catch(() => {
                        /* best-effort: no stale job to clear is the common case */
                    });
                    await startArtifactJob(dir);
                    // On a MISS the artifact job is now registered (countable); release
                    // the GPU reservation. `.finally` below also covers a store HIT (no
                    // factory run) and any throw, so the slot is never leaked.
                },
                estBytes,
            )
            .finally(releaseGpuReservation);

        // Pin THIS viewer's refcount NOW, before the deferred re-warm below can
        // run. A re-warm target is an idle (refcount 0) `ready` entry — exactly
        // what evictToBudget() would rm out from under a just-spawned FFmpeg
        // process mid-re-warm (and its onDrop would then orphan the job). attach()
        // lifts the refcount to ≥1 so eviction skips it; the unwind-safe try
        // below releases this refcount if setup later throws.
        store.attach(key);
        // Record that THIS replica performed the attach for THIS viewer
        // session, so cleanupPreviewSession's detach is replica-scoped (see
        // cacheAttachedSessions above).
        cacheAttachedSessions.add(playSessionId);
        cacheKey = key;

        // A store HIT returns the existing entry WITHOUT running the factory —
        // but the in-memory FFmpeg job that serving depends on
        // (serveMasterPlaylist reads getJob(`preview-cache-<key>`).config) may
        // be absent: scanOnStartup indexes on-disk `.ready` artifacts with no
        // job, and cleanupInactiveJobs reaps a completed artifact's job after
        // ~5 min idle while the store entry survives. In both cases the reused
        // session's master.m3u8 would 410, so re-warm the job into the existing
        // (now-pinned) artifact dir. Gated on state 'ready': a `warming` entry
        // — a fresh miss OR a concurrent start still in flight — already has a
        // job start pending, so re-warming it would be a spurious duplicate. A
        // reaped/startup-scanned artifact is always `ready`. startJob() dedupes
        // a live job (by playSessionId) and is serialized per session, so a
        // concurrent burst of viewers spawns at most one FFmpeg process.
        // Deferred (not run here) so it executes INSIDE the try below and a
        // failure detaches this refcount.
        ensureArtifactJobResident = async (): Promise<void> => {
            if (entry.state === 'ready' && !transcodeService.getJob(artifactSessionId)) {
                // A complete artifact needs NO in-memory job anymore: the segment
                // handler's tryServeCompletePreviewFromDisk serves the master,
                // media playlists, and segments straight from the `.ready` dir.
                // Re-warming here used to spawn a second FFmpeg over that same
                // dir, rewriting segment files in place under active viewers —
                // truncated reads → hls.js fatal mediaError → hover previews
                // reverting to the backdrop (prod 2026-07-17). Only re-warm the
                // (legacy) case where the artifact has no on-disk master.m3u8,
                // which disk-serving cannot cover.
                //
                // "Has a master" means EITHER layout: a demux artifact writes
                // master.m3u8, but a MUXED one (every preview since 2026-08-26)
                // is flat — index.m3u8 is its master, and the disk handler serves
                // it as such. Checking master.m3u8 alone made every complete
                // muxed artifact look legacy, so each reuse after its job was
                // reaped re-ran FFmpeg over the ready dir (prod 2026-09-26).
                const hasMaster = async (name: string): Promise<boolean> =>
                    fs.access(join(entry.dir, name)).then(
                        () => true,
                        () => false,
                    );
                // Same gate as the disk handler (tryServeCompletePreviewFromDisk):
                // it serves nothing without the `.ready` marker, so a playlist
                // alone must not skip the re-warm — that would strand a 410.
                if (
                    (await hasMaster('.ready')) &&
                    ((await hasMaster('master.m3u8')) || (await hasMaster('index.m3u8')))
                ) {
                    logger.debug('[PreviewSession] Ready artifact served jobless from disk', {
                        cacheKey: key,
                        artifactSessionId,
                    });
                    return;
                }
                // No on-disk master of either layout — the legacy re-warm.
                logger.info('[PreviewSession] Re-warming reaped cache-backed artifact job', {
                    cacheKey: key,
                    artifactSessionId,
                    dir: entry.dir,
                });
                await startArtifactJob(entry.dir);
            }
        };
        // transcodeJobId intentionally left undefined: the FFmpeg job runs
        // under artifactSessionId, not this viewer's playSessionId, and is
        // owned by the cache (reaped by budget/inactivity) — NOT by this
        // session's cleanup. See cleanupPreviewSession.
    } else {
        const job = await transcodeService
            .startJob({
                itemId: resolvedItemId,
                username,
                deviceId: 'preview-player',
                playSessionId,
                inputUrl: '',
                transcodeMode: 'full',
                localFilePath,
                // FULL list + muxed hlsOutput ⇒ the resolved track actually
                // reaches ffmpeg. See the note where previewHlsOutput is built.
                audioTracks: previewAudioTracks,
                hlsOutput: previewHlsOutput,
                subtitleTracks: [],
                videoInfo: {
                    // Source-vs-target split as above: `codec`/`bitDepth` feed
                    // the decode deny-map, `outputCodec` is the encode target.
                    codec: mediaInfo.videoCodec || (plan.target_video_codec ?? 'h264'),
                    bitDepth: mediaInfo.videoBitDepth,
                    width: mediaInfo.width ?? maxWidth,
                    height: mediaInfo.height ?? maxHeight,
                    outputCodec: plan.target_video_codec ?? 'h264',
                    isTranscoded: true,
                },
                startTimeSeconds: seekSeconds,
                fileId: resolvedFileId,
                playbackPlan: planForJob,
                // Present only when under the GPU-preview budget; enables the
                // consumePlan → hardware-encoder path (else undefined → CPU).
                mediaSourceInfo,
                encodingPreset,
                nvencPreset,
                // Short segments → the first playable segment is ready far sooner,
                // cutting cold-preview first-frame latency.
                segmentDurationSeconds: config.PREVIEW_SEGMENT_DURATION,
                // Preview jobs use a self-contained mini-playlist starting at the
                // seek point, so segments must be numbered from 0. See JobConfig.isPreview.
                isPreview: true,
                maxDurationSeconds: isTrailer ? config.TRAILER_MAX_SECONDS : undefined,
                // Whole-file duration (NOT the clip length) — see the cache-path
                // branch above for why this is needed.
                totalDurationSeconds: probe.duration ?? undefined,
            })
            .finally(releaseGpuReservation);
        transcodeJobId = job.id;
    }

    // Everything past the FFmpeg spawn must be able to unwind: a throw here
    // (e.g. addPreviewSession Valkey failure) would otherwise leak either the
    // running FFmpeg process (non-cache path) or this viewer's refcount on
    // the shared artifact (cache path), with no session record to release it.
    try {
        // Re-warm a reaped cache-backed artifact's FFmpeg job (assigned in the
        // cache branch above). Runs here, inside the try, so a failure unwinds
        // the store.attach() refcount via the catch below. No-op on the
        // non-cache path (stays null) and on a live/warming artifact.
        if (ensureArtifactJobResident) {
            await ensureArtifactJobResident();
        }

        const transcodeMode = 'local' as const;

        logger.info('[PreviewSession] Created local preview session via planner', {
            itemId: resolvedItemId,
            originalItemId: itemId !== resolvedItemId ? itemId : undefined,
            internalId,
            playSessionId,
            planId: plan.plan_id,
            targetVideoCodec: plan.target_video_codec,
            transcodeJobId,
            cacheKey,
            seekSeconds,
            localFilePath,
            isLiveTv,
        });

        // Store session
        const now = new Date();
        const session: PreviewSession = {
            playSessionId,
            itemId: resolvedItemId,
            transcodeMode,
            transcodeJobId,
            startPositionSeconds,
            createdAt: now,
            lastHeartbeatAt: now,
            isPreview: true,
            isLiveTv,
            isTrailer,
            // The parent id the client actually sent (resolvedItemId above is
            // the resolved trailer CHILD's own uuid for a trailer session) —
            // only meaningful/set for trailer sessions; findReusablePreview
            // matches re-opens against this instead of `itemId`.
            requestedItemId: isTrailer ? itemId : undefined,
            userId,
            fileId: resolvedFileId,
            planId: plan.plan_id,
            cacheKey,
        };
        await addPreviewSession(session);
        const streamUrl = await buildPreviewStreamHref(
            params,
            resolvedItemId,
            playSessionId,
            resolvedFileId,
        );

        if (isLiveTv) {
            const currentLiveTvCount = await getLiveTvSessionCount();
            logger.info('[PreviewSession] Created live TV preview session', {
                playSessionId,
                username,
                itemId: resolvedItemId,
                currentLiveTvCount,
                maxLiveTvPerServer: getConfig<number>('PREVIEW_MAX_LIVETV_PER_SERVER'),
            });
        }

        return {
            playSessionId,
            sessionItemId: resolvedItemId,
            streamUrl,
            playMethod: 'Transcode',
            transcodeMode,
            // The preview's HLS playlist is FFmpeg's raw output (no VOD URL
            // translation), so segment 0 is at relative time 0 — and FFmpeg has
            // already seeked the input to seekSeconds, meaning segment 0's content
            // IS the resume position. Telling hls.js to start at the absolute
            // seekSeconds would be out of the playlist's range and silently fall
            // back to the wrong position; 0 maps directly to the resume frame.
            hlsStartPosition: 0,
            mode: isTrailer ? 'trailer' : 'preview',
        };
    } catch (err) {
        if (cacheKey) {
            // Release the refcount grabbed by store.attach() above — the
            // shared artifact/job itself is owned by the cache, not this
            // (never-established) session, so it is NOT stopped here. Goes
            // through the same owned/idempotent release path as
            // cleanupPreviewSession so cacheAttachedSessions never leaks
            // this playSessionId.
            detachPreviewCacheIfOwned(playSessionId, cacheKey);
        } else {
            // Stop the orphaned FFmpeg job before rethrowing (see try note above).
            await transcodeService.stopJob(playSessionId, 'preview_setup_failed').catch(() => {
                /* best-effort: the inactivity watchdog is the backstop */
            });
        }
        throw err;
    }
}

export interface DeletePreviewParams {
    playSessionId: string;
    username: string;
}

/**
 * Clean up a preview session — stops transcode job and removes from tracking.
 * Returns true if session was found and cleaned up; false if already gone.
 *
 * NO itemId GUARD, deliberately. This used to reject when a caller-supplied
 * itemId differed from `session.itemId`, which could not work: the session
 * stores the RESOLVED id (a series preview resolves to the episode actually
 * played) while every caller has only the id it requested. `originalItemId` is
 * written to a log line at creation, not persisted, so there is nothing to
 * compare the requested id against.
 *
 * The consequences were real, not cosmetic. `/api/v1/playback/previews/{id}`
 * passed `itemId: ''` — the id can't appear in that route at all — so DELETE
 * 422'd on EVERY call and had never once succeeded; the ambient home hero
 * rotates every 8s and its teardown is swallowed client-side, so each idling
 * viewer left a rolling handful of orphaned FFmpeg preview jobs for the reaper.
 * The internal itemId-in-path route hit the same wall for anything whose id
 * resolves.
 *
 * Ownership is the actual security boundary and still applies. A caller
 * claiming a different item could only ever have torn down its OWN session,
 * so the guard protected nothing while breaking teardown.
 */
export async function deletePreview(params: DeletePreviewParams): Promise<{
    found: boolean;
}> {
    const { playSessionId, username } = params;

    const session = await getPreviewSession(playSessionId);
    if (!session) {
        return { found: false };
    }

    // Non-owners get the same answer as "no such session" — never reveal that
    // a play-session id exists but belongs to someone else.
    if (session.userId !== username) {
        return { found: false };
    }

    await cleanupPreviewSession(playSessionId, session, session.userId);
    return { found: true };
}

/**
 * Background cleanup to ensure Redis counters don't get stuck
 * Runs every 2 minutes to sync Redis with actual sessions
 * Also cleans up expired watcher sessions
 */
async function runBackgroundCleanup(): Promise<void> {
    try {
        // 1. Sync the aggregate live-TV count from the AUTHORITATIVE per-session
        // keys in shared Valkey — NOT this replica's local activePreviews map. The
        // local map holds only this node's sessions, so reconciling from it would
        // stomp the cluster-wide counter down to one replica's slice every tick,
        // permanently under-counting under multi-replica. Scanning the shared
        // `preview:livetv:user:*` keyspace gives the true cross-replica count
        // (leaked keys self-expire via the TTL set in incrementLiveTvCount).
        let actualCount: number | null = null;
        try {
            const liveTvKeys = await getKeysByPattern(`${REDIS_LIVETV_SESSION_PREFIX}*`, 1000);
            actualCount = liveTvKeys.length;
        } catch {
            // Valkey scan unavailable — skip part-1 reconciliation this tick rather
            // than stomping the shared counter with a wrong (local) value. Part 2
            // (watcher reconciliation) below still runs.
        }
        if (actualCount !== null) {
            const redisCount = await getLiveTvSessionCount();
            if (actualCount !== redisCount) {
                logger.warn('Live TV preview count mismatch, syncing Redis', {
                    actual: actualCount,
                    redis: redisCount,
                });
                try {
                    await liveTvSessionCache.set(REDIS_LIVE_TV_COUNT_KEY, String(actualCount));
                } catch (err) {
                    logger.error(
                        'Failed to sync preview count',
                        err instanceof Error ? err : undefined,
                    );
                }
            }
        }

        // 2. Validate watcher count against actual sessions
        // Edge case: Counter incremented but session creation failed
        const watcherCount = await getLiveTvWatcherCount();
        if (watcherCount > 0) {
            try {
                // Get raw Valkey client to use KEYS command
                const cache = getCoordinationClient();
                if (cache) {
                    const keysClient = cache as unknown as KeysClient;
                    const rawKeys = await keysClient.keys('playback:livetv:session:*');
                    const keys = isStringArray(rawKeys) ? rawKeys : [];
                    const actualSessions = keys.length;

                    // If counter doesn't match actual sessions, fix it
                    if (actualSessions !== watcherCount) {
                        logger.warn('Watcher count mismatch (orphaned counter), fixing', {
                            counter: watcherCount,
                            actualSessions,
                        });

                        // Reset to actual count
                        await liveTvSessionCache.set(
                            REDIS_LIVETV_WATCHERS_KEY,
                            String(actualSessions),
                        );
                    } else {
                        logger.debug('Active live TV watchers', {
                            count: watcherCount,
                        });
                    }
                }
            } catch (error) {
                // Non-critical - TTL will handle cleanup eventually
                logger.debug('Failed to validate watcher count', {
                    error: String(error),
                });
            }
        }
    } catch (error) {
        logger.debug('Background cleanup error (non-critical)', {
            error: String(error),
        });
    }
}

setInterval(
    () => {
        void runBackgroundCleanup();
    },
    2 * 60 * 1000,
); // Every 2 minutes
