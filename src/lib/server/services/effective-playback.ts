// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/server/services/effective-playback.ts
import type { ActiveSessionView } from './session-read-model.service.js';
import type { PlaySessionSource } from '../database/queries/play-sessions.queries.js';
import type { WatchStateRow } from '$lib/server/database/queries/watch-state.queries.js';
import type { UserId } from '$lib/shared/user-id.js';
import { Logger } from '../utils/logger.js';

const logger = Logger.for('EffectivePlayback');

// ─── Public types ─────────────────────────────────────────────────────────────

export interface EffectiveResume {
    /** The resume position to seek to on bootstrap (ms). 0 means start from beginning. */
    positionMs: number;
    /** Where the position came from. */
    source: 'live-session' | 'durable' | 'none';
    /** True iff this came from a live session that's still fresh. */
    fromLive: boolean;
    /**
     * Server-clock freshness signal (epoch ms). The maximum of the eligible live
     * session's `last_heartbeat_at` and the durable `user_media_state.last_event_at`.
     * Null when neither source has any data.
     * Used by the client-side resume cache to detect stale localStorage entries.
     */
    anchorMs: number | null;
    /**
     * Whether the durable `user_media_state.is_watched` flag is set. Sourced from
     * the same memoized watch-state row as `positionMs`/`anchorMs`, so callers
     * never need a second `watchManager.getWatchState()` round-trip.
     */
    isWatched: boolean;
}

export interface EffectivePlayback {
    /** Live position (ms). Null when no live session exists. */
    livePositionMs: number | null;
    /** Whether the user is actively playing right now. */
    isPlaying: boolean;
    /** Source of the live signal. */
    source: PlaySessionSource | null;
    /** ms since last heartbeat/poll. */
    freshness: { ageMs: number; isFresh: boolean } | null;
    /** Underlying view if a caller wants more detail (codec, device, sessionId, etc.). */
    session: ActiveSessionView | null;
}

// ─── Deps interface ───────────────────────────────────────────────────────────

export interface EffectivePlaybackDeps {
    getSessionForMedia: (userId: UserId, mediaId: string) => Promise<ActiveSessionView | null>;
    getSessionsForSeries: (userId: UserId, seriesId: string) => Promise<ActiveSessionView[]>;
    getDurableResumeMs: (userId: UserId, mediaId: string) => Promise<number | null>;
    getDurableLastEventAt: (userId: UserId, mediaId: string) => Promise<number | null>;
    getDurableIsWatched: (userId: UserId, mediaId: string) => Promise<boolean>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function maxNullable(a: number | null, b: number | null): number | null {
    if (a === null) return b;
    if (b === null) return a;
    return a > b ? a : b;
}

// ─── Null result constants ────────────────────────────────────────────────────

const NO_LIVE_PLAYBACK: EffectivePlayback = {
    livePositionMs: null,
    isPlaying: false,
    source: null,
    freshness: null,
    session: null,
};

// ─── Core logic ───────────────────────────────────────────────────────────────

function sessionToPlayback(session: ActiveSessionView): EffectivePlayback {
    return {
        livePositionMs: session.positionMs,
        isPlaying: session.isPlaying,
        source: session.source,
        freshness: { ageMs: session.heartbeatAgeMs, isFresh: session.isFresh },
        session,
    };
}

function pickFreshestSession(sessions: ActiveSessionView[]): ActiveSessionView | null {
    const fresh = sessions.filter((s) => s.isFresh);
    if (fresh.length === 0) return null;
    const active = fresh.filter((s) => s.isPlaying);
    const pool = active.length > 0 ? active : fresh;
    return pool.reduce((best, s) => (s.heartbeatAgeMs < best.heartbeatAgeMs ? s : best));
}

// ─── Exported resolvers ───────────────────────────────────────────────────────

/**
 * Resume position resolver — the SOLE rule for "where should playback resume?".
 * Used by /watch/[id] bootstrap, item modals, Jellyfin /j/ compat resume APIs.
 *
 * Rule: prefer fresh ACTIVE live session position; otherwise fall back to
 * user_media_state.resume_position_ms; otherwise 0.
 *
 * Stale (non-fresh) sessions are NOT used — better to fall through to durable.
 * Non-active (PAUSED) sessions ARE used if fresh: a paused session represents
 * the user's current intent.
 */
export async function resolveEffectiveResume(
    userId: UserId,
    mediaId: string,
    deps: EffectivePlaybackDeps = defaultDeps(),
): Promise<EffectiveResume> {
    // The live-session read and the durable watch-state read are independent, and
    // BOTH were already unconditional before the isFresh branch below — so issuing
    // them concurrently changes no behaviour, it just stops the second waiting on
    // the first. Two serial round-trips become one.
    //
    // getDurableLastEventAt and getDurableIsWatched both go through the per-call
    // memoized watch-state promise (see defaultDeps), so together they cost a
    // single query; kicking them off here is what primes that memo for
    // getDurableResumeMs further down, which then resolves without a round-trip.
    //
    // Each read keeps its own catch and its own fallback value — the failure
    // modes are deliberately different (session failure falls back to durable, a
    // durable anchor failure is ignored, is_watched defaults to false). A bare
    // Promise.all without these would turn any single failure into a page error.
    const [session, durableAnchor, isWatched] = await Promise.all([
        deps.getSessionForMedia(userId, mediaId).catch((err): ActiveSessionView | null => {
            logger.warn('resolveEffectiveResume: SessionReadModel threw, falling back to durable', {
                userId,
                mediaId,
                error: err instanceof Error ? err.message : String(err),
            });
            return null;
        }),
        deps.getDurableLastEventAt(userId, mediaId).catch((err): number | null => {
            logger.warn('resolveEffectiveResume: durable last_event_at read threw, ignoring', {
                userId,
                mediaId,
                error: err instanceof Error ? err.message : String(err),
            });
            return null;
        }),
        deps.getDurableIsWatched(userId, mediaId).catch((err): boolean => {
            logger.warn(
                'resolveEffectiveResume: durable is_watched read threw, defaulting to false',
                {
                    userId,
                    mediaId,
                    error: err instanceof Error ? err.message : String(err),
                },
            );
            return false;
        }),
    ]);

    const liveAnchor = session?.isFresh ? session.lastHeartbeatAt.getTime() : null;
    const anchorMs = maxNullable(liveAnchor, durableAnchor);

    if (session?.isFresh) {
        return {
            positionMs: session.positionMs,
            source: 'live-session',
            fromLive: true,
            anchorMs,
            isWatched,
        };
    }

    let durableMs: number | null = null;
    try {
        durableMs = await deps.getDurableResumeMs(userId, mediaId);
    } catch (err) {
        logger.warn('resolveEffectiveResume: durable read threw, returning none', {
            userId,
            mediaId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    if (durableMs !== null) {
        return {
            positionMs: durableMs,
            source: 'durable',
            fromLive: false,
            anchorMs,
            isWatched,
        };
    }

    return {
        positionMs: 0,
        source: 'none',
        fromLive: false,
        anchorMs,
        isWatched,
    };
}

/**
 * Live-playback resolver — the SOLE rule for "is this user actively watching
 * this thing right now, and where are they?". Used by CW live overlay,
 * "Now Playing" badges, cross-device indicators.
 *
 * Pass `seriesId` when the question is series-level (e.g. CW asking "is there
 * any episode of this series being watched?"). The resolver picks the freshest
 * active session for the series (or null).
 */
export async function resolveEffectivePlayback(
    userId: UserId,
    mediaId: string,
    seriesId?: string,
    deps: EffectivePlaybackDeps = defaultDeps(),
): Promise<EffectivePlayback> {
    try {
        if (seriesId) {
            const sessions = await deps.getSessionsForSeries(userId, seriesId);
            const pick = pickFreshestSession(sessions);
            return pick ? sessionToPlayback(pick) : NO_LIVE_PLAYBACK;
        }

        const session = await deps.getSessionForMedia(userId, mediaId);
        if (!session?.isFresh) return NO_LIVE_PLAYBACK;
        return sessionToPlayback(session);
    } catch (err) {
        logger.warn('resolveEffectivePlayback: SessionReadModel threw, returning empty', {
            userId,
            mediaId,
            seriesId,
            error: err instanceof Error ? err.message : String(err),
        });
        return NO_LIVE_PLAYBACK;
    }
}

// ─── Default deps (production wiring) ────────────────────────────────────────

function defaultDeps(): EffectivePlaybackDeps {
    // Memoize the watch state query so all three durable deps (getDurableResumeMs,
    // getDurableLastEventAt, getDurableIsWatched) share a single DB round-trip per resolver call.
    // The closure is created fresh per resolveEffectiveResume invocation
    // (via the default-parameter pattern), so there is no cross-request leakage.
    let watchStatePromise: Promise<WatchStateRow | null> | null = null;
    const getWatchStateOnce = async (userId: UserId, mediaId: string) => {
        if (!watchStatePromise) {
            const { watchManager } = await import('./watch-manager.service.js');
            watchStatePromise = watchManager.getWatchState(userId, mediaId);
        }
        return watchStatePromise;
    };

    return {
        getSessionForMedia: async (userId, mediaId) => {
            const { getSessionReadModel } = await import('./session-read-model.service.js');
            return getSessionReadModel().getActiveSessionForMedia(userId, mediaId);
        },
        getSessionsForSeries: async (userId, seriesId) => {
            const { getSessionReadModel } = await import('./session-read-model.service.js');
            return getSessionReadModel().getActiveSessionsForSeries(userId, seriesId);
        },
        getDurableResumeMs: async (userId, mediaId) => {
            const row = await getWatchStateOnce(userId, mediaId);
            return row !== null ? row.resume_position_ms : null;
        },
        getDurableLastEventAt: async (userId, mediaId) => {
            const row = await getWatchStateOnce(userId, mediaId);
            if (!row?.last_event_at) return null;
            const t = new Date(row.last_event_at).getTime();
            return Number.isFinite(t) ? t : null;
        },
        getDurableIsWatched: async (userId, mediaId) => {
            const row = await getWatchStateOnce(userId, mediaId);
            return row?.is_watched ?? false;
        },
    };
}
