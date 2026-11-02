// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared music replay validation, access checks, idempotent writes and per-item outcomes.
 */

import type postgres from 'postgres';
import { z } from 'zod';
import { getMediaType } from '$lib/server/database/queries/media-type-cache.queries.js';
import { findPlaybackDurationMs } from '$lib/server/database/queries/media-items.queries.js';
import { ReplayItemSchema } from '$lib/schemas/play-session-replay.js';
import type { UserContext } from '$lib/server/types.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { musicInteractionManager } from '$lib/server/services/music-interaction-manager.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    MusicPlayEndRequestSchema,
    MUSIC_PLAY_EVENT_MAX_AGE_MS,
    MUSIC_PLAY_EVENT_MAX_SKEW_MS,
    MUSIC_PLAY_END_INVALID_DETAILS_MAX,
    isRetryableMusicPlayEndResult,
    type MusicPlayEndRejectionReason,
    type MusicPlayEndResultDetail,
} from '$lib/schemas/music-play-events.js';
import { isMissingTrackError } from '$lib/server/utils/music-track-error.js';
import { isPermanentWriteError } from '$lib/server/utils/permanent-write-error.js';

const logger = Logger.for('MusicPlayEndBatch');

const MAX_UNTIMED_REPLAY_LISTENED_MS = 24 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PlayEndBatchResult {
    index: number;
    eventId: string | null;
    status: 'recorded' | 'duplicate' | 'rejected';
    reason: string | null;
    details: MusicPlayEndResultDetail[];
    retryable: boolean;
}

/**
 * Decide whether a `startedAt` falls inside the acceptance window.
 *
 * Exported so the single-event endpoint enforces the identical rule, and so
 * the window is testable without a database.
 */
export function classifyStartedAt(
    startedAtIso: string,
    nowMs: number,
): MusicPlayEndRejectionReason | null {
    const t = Date.parse(startedAtIso);
    // An unparseable timestamp is a shape problem, not a window problem. The
    // schema already rejects it; this is the belt for a direct caller.
    if (Number.isNaN(t)) return 'invalid';
    if (t > nowMs + MUSIC_PLAY_EVENT_MAX_SKEW_MS) return 'too_far_future';
    if (t < nowMs - MUSIC_PLAY_EVENT_MAX_AGE_MS) return 'too_old';
    return null;
}

function rejection(
    index: number,
    eventId: string | null,
    reason: MusicPlayEndRejectionReason,
    details: MusicPlayEndResultDetail[] = [],
): PlayEndBatchResult {
    return {
        index,
        eventId,
        status: 'rejected',
        reason,
        details,
        retryable: isRetryableMusicPlayEndResult('rejected', reason),
    };
}

/**
 * Process ONE event. Never throws: every failure mode becomes a result, so a
 * bad event can never take its batch-mates down with it.
 * `inferReplayDuration` applies only when replay omitted both timing fields.
 */
export async function processPlayEndEvent(
    sql: postgres.Sql,
    user: UserContext,
    raw: unknown,
    index: number,
    nowMs: number,
    accessCache: Map<string, boolean>,
    inferReplayDuration = false,
): Promise<PlayEndBatchResult> {
    const parsed = MusicPlayEndRequestSchema.extend({
        startedAt: z.string().datetime({ offset: true }),
        playContext: z.string().optional(),
        eventId: z.string().uuid(),
        startReported: z.boolean().default(false),
        playbackSessionId: z.string().uuid().optional(),
    }).safeParse(raw);
    if (!parsed.success) {
        // Read the eventId off the raw object when possible: a result the
        // client cannot attribute to a queue entry is close to useless, and
        // the id may be present even when some other field failed.
        const rawId = (raw as { eventId?: unknown } | null)?.eventId;
        return rejection(
            index,
            typeof rawId === 'string' ? rawId : null,
            'invalid',
            parsed.error.issues.slice(0, MUSIC_PLAY_END_INVALID_DETAILS_MAX).map((issue) => ({
                field: issue.path.join('.') || '(root)',
                message: issue.message,
            })),
        );
    }

    const event = parsed.data;
    const eventId = event.eventId ?? null;

    // The normalized internal shape still calls this trackId. Reject malformed
    // ids before a Postgres UUID cast can fail the item.
    if (!UUID_RE.test(event.trackId)) {
        return rejection(index, eventId, 'invalid', [
            { field: 'trackId', message: 'must be a UUID' },
        ]);
    }

    const windowReason = classifyStartedAt(event.startedAt, nowMs);
    if (windowReason) {
        return rejection(index, eventId, windowReason, [
            {
                field: 'startedAt',
                message:
                    windowReason === 'too_old'
                        ? `older than the ${MUSIC_PLAY_EVENT_MAX_AGE_MS / 86_400_000}-day acceptance window`
                        : 'further in the future than the allowed clock skew',
            },
        ]);
    }

    // Library + age gate. Without it a client could write listening history
    // for a track it is not allowed to see and steer its own taste signal
    // with it. The read surfaces re-filter through searchAccessBoundary, so
    // this guards the signal, not disclosure.
    try {
        let allowed = accessCache.get(event.trackId);
        if (allowed === undefined) {
            allowed = await checkMediaAccess(sql, event.trackId, user);
            accessCache.set(event.trackId, allowed);
        }
        if (!allowed) {
            // Deliberately `not_found`, never a distinct "forbidden": telling a
            // caller apart from "no such track" and "a track you may not see"
            // leaks the existence of restricted content.
            return rejection(index, eventId, 'not_found');
        }

        if (!['track', 'audio'].includes((await getMediaType(sql, event.trackId)) ?? '')) {
            return rejection(index, eventId, 'not_found');
        }
        let listenedMs = event.listenedMs;
        let durationMs = event.durationMs;
        if (inferReplayDuration) {
            durationMs = (await findPlaybackDurationMs(sql, event.trackId)) ?? undefined;
            // Missing client timing must not permanently discard a listen: accept
            // with a clamp to the known duration, or rely on the absolute cap.
            if (durationMs !== undefined) listenedMs = Math.min(listenedMs, durationMs);
        }
        // A startReported hint may acknowledge a zero-heard heartbeat. Only
        // the durable event claim can tell whether a positive listen counted.
        const { duplicate } = await musicInteractionManager.reportPlayEnd(
            user.userId,
            event.trackId,
            listenedMs,
            event.startedAt,
            durationMs,
            event.wasSkipped,
            event.playContext,
            eventId,
            /* noPlayStartReported: durable claim decides, not the client hint */ true,
            undefined,
            {
                id: event.playbackSessionId,
                // Hint only guards the no-session-id case: a reported start near
                // startedAt for this track was already counted by the live session.
                skipIfStartNear: event.startReported,
            },
        );
        return {
            index,
            eventId,
            status: duplicate ? 'duplicate' : 'recorded',
            reason: null,
            details: [],
            retryable: false,
        };
    } catch (err) {
        if (isMissingTrackError(err)) {
            return rejection(index, eventId, 'not_found');
        }
        // A constraint the event itself violates — a value too large for its
        // column, a bad enum — fails identically on every resubmission.
        // `write_failed` is classified retryable, so reporting one that way
        // asks the client to keep a doomed event in its queue forever,
        // burning a batch slot on every flush. `invalid` is terminal, which
        // is what the event actually is.
        if (isPermanentWriteError(err)) {
            logger.warn(
                'Play-end batch event is permanently unwritable',
                { index, trackId: event.trackId },
                err as Error,
            );
            return rejection(index, eventId, 'invalid');
        }
        logger.warn('Play-end batch event failed', { index, trackId: event.trackId }, err as Error);
        return rejection(index, eventId, 'write_failed');
    }
}

/**
 * Process a whole batch, in submission order.
 *
 * Sequential on purpose. These events mutate per-track counters and the
 * duplicate check is a unique-index race, so running them concurrently buys
 * little (the batch is bounded) and makes the failure modes much harder to
 * reason about. Access decisions are memoised per track id so a repeat listen
 * inside one batch costs one gate check, not N.
 */
export async function processPlayEndBatch(
    sql: postgres.Sql,
    user: UserContext,
    events: unknown[],
    nowMs: number = Date.now(),
): Promise<{
    results: PlayEndBatchResult[];
    summary: { recorded: number; duplicate: number; rejected: number };
}> {
    const accessCache = new Map<string, boolean>();
    const results: PlayEndBatchResult[] = [];

    for (let i = 0; i < events.length; i++) {
        results.push(await processPlayEndEvent(sql, user, events[i], i, nowMs, accessCache));
    }

    return {
        results,
        summary: {
            recorded: results.filter((r) => r.status === 'recorded').length,
            duplicate: results.filter((r) => r.status === 'duplicate').length,
            rejected: results.filter((r) => r.status === 'rejected').length,
        },
    };
}

/** Unified offline replay contract. All accepted items have an idempotency key. */
export async function processReplayBatch(
    sql: postgres.Sql,
    user: UserContext,
    items: unknown[],
    nowMs = Date.now(),
): Promise<{
    results: PlayEndBatchResult[];
    summary: { recorded: number; duplicate: number; rejected: number };
}> {
    const accessCache = new Map<string, boolean>();
    const results: PlayEndBatchResult[] = [];
    for (const [index, raw] of items.entries()) {
        const parsed = ReplayItemSchema.safeParse(raw);
        if (!parsed.success) {
            const id = (raw as { eventId?: unknown } | null)?.eventId;
            results.push(
                rejection(
                    index,
                    typeof id === 'string' ? id : null,
                    'invalid',
                    parsed.error.issues
                        .slice(0, MUSIC_PLAY_END_INVALID_DETAILS_MAX)
                        .map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
                ),
            );
            continue;
        }
        const item = parsed.data;
        const inferReplayDuration = item.endedAt === undefined && item.durationMs === undefined;
        const elapsedMs =
            item.endedAt === undefined
                ? undefined
                : Math.max(0, Date.parse(item.endedAt) - Date.parse(item.startedAt));
        const maxListenedMs = inferReplayDuration
            ? MAX_UNTIMED_REPLAY_LISTENED_MS
            : Math.max(item.durationMs ?? 0, elapsedMs ?? 0) * 1.1 + 5000;
        if (item.listenedMs > maxListenedMs) {
            results.push(rejection(index, item.eventId, 'invalid'));
            continue;
        }
        results.push(
            await processPlayEndEvent(
                sql,
                user,
                {
                    trackId: item.mediaId,
                    eventId: item.eventId,
                    listenedMs: item.listenedMs,
                    startedAt: item.startedAt,
                    durationMs: item.durationMs,
                    wasSkipped: item.endReason === 'skip',
                    playContext: item.playContext,
                    startReported: item.startReported,
                    playbackSessionId: item.playbackSessionId,
                },
                index,
                nowMs,
                accessCache,
                inferReplayDuration,
            ),
        );
    }
    return {
        results,
        summary: {
            recorded: results.filter((r) => r.status === 'recorded').length,
            duplicate: results.filter((r) => r.status === 'duplicate').length,
            rejected: results.filter((r) => r.status === 'rejected').length,
        },
    };
}
