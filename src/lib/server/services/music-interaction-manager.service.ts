// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/server/services/music-interaction-manager.service.ts
/**
 * MusicInteractionManager — owns all business logic for music track interactions.
 *
 * Responsibilities:
 * - Record track play start/end lifecycle events
 * - Record track like/dislike/skip/complete
 * - Write to user_music_state (aggregated) and music_listen_events (log)
 * - Cache invalidation after each interaction
 */

import type postgres from 'postgres';
import { getMediaType } from '$lib/server/database/queries/media-type-cache.queries.js';
import type { UserContext } from '$lib/server/types.js';
import type { UserId } from '$lib/shared/user-id.js';
import { Logger } from '$lib/server/utils/logger.js';
import { aiDbService } from './database.service.js';
import { cacheInvalidation } from '$lib/server/cache';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { MediaAccessDeniedError } from '$lib/server/utils/resolve-and-gate.js';
import { isMissingTrackError } from '$lib/server/utils/music-track-error.js';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    recordTrackLike,
    recordTrackDislike,
    recordTrackSkip,
    recordTrackComplete,
    clearTrackFeedback,
    clearTrackLike,
    clearTrackDislike,
} from '$lib/server/database/queries/music-interactions.queries.js';
import {
    recordPlayStart,
    recordPlayEnd,
    recordPlayEndNoTiming,
    insertListenEvent,
    isRecordedListenEvent,
    claimMusicPlayStart,
    hasMusicPlayStartNear,
} from '$lib/server/database/queries/music-tracking.queries.js';
import { setIfNotExists, getValkeyClient, del } from '$lib/server/cache/valkey.js';

const logger = Logger.for('MusicInteractionManager');

/**
 * Dedup window for play-start events (seconds).
 * A second call to reportPlayStart for the same user+track within this window
 * is treated as a retry and skipped — the play_count is not incremented again.
 * 30 s is long enough to absorb client retries and short enough that a genuine
 * back-to-back replay (unlikely under 30 s) would only lose one count.
 */
const PLAY_START_DEDUP_TTL_SECONDS = 30;

/**
 * @deprecated Use `MediaAccessDeniedError` from `$lib/server/utils/resolve-and-gate.js`.
 * Re-exported alias to keep existing route imports working during the migration window.
 * Aliasing the class on re-export carries both its value and type bindings without
 * the const+type declaration-merge that `no-redeclare` rejects.
 */
export { MediaAccessDeniedError as MusicInteractionAccessDeniedError } from '$lib/server/utils/resolve-and-gate.js';

/** Completion threshold — same as video (90% of track duration). */
const MUSIC_COMPLETION_THRESHOLD = 0.9;

class MusicInteractionManager {
    private async getSql() {
        const sql = await aiDbService.getSql();
        if (!sql) throw new Error('Database unavailable');
        return sql;
    }

    async reportSessionStart(
        sql: postgres.Sql,
        userId: UserId,
        trackId: string,
        eventId: string,
    ): Promise<void> {
        await withTx(sql, async (tx) => {
            // All writers acquire the event lock before touching aggregate counters.
            const recorded = await isRecordedListenEvent(tx, userId, eventId);
            const claimed = await claimMusicPlayStart(tx, userId, eventId);
            if (claimed && !recorded) await recordPlayStart(tx, userId, trackId);
        });
    }

    async clearFeedback(userId: UserId, trackId: string, user?: UserContext): Promise<void> {
        const sql = await this.getSql();
        await this.assertCanInteract(sql, trackId, user);
        if (!['track', 'audio'].includes((await getMediaType(sql, trackId)) ?? ''))
            throw new MediaAccessDeniedError();
        await clearTrackFeedback(sql, userId, trackId);
        await cacheInvalidation.onRatingCacheChanged(userId);
    }

    /**
     * Called once when a track starts playing.
     * Increments play_count in user_music_state.
     *
     * Dedup: a Valkey NX key keyed on `music-play-start:${userId}:${trackId}` with a
     * PLAY_START_DEDUP_TTL_SECONDS TTL prevents double-counting when the client
     * retries the start call (network hiccup, StrictMode double-mount, etc.).
     *
     * Graceful degradation: when Valkey is unavailable (getValkeyClient() === null),
     * the NX set returns false even though no key exists — in that case we skip the
     * dedup check and always write to DB, accepting occasional duplicates over
     * silent data loss.
     */
    async reportPlayStart(
        userId: UserId,
        trackId: string,
        playContext?: string,
        transactionSql?: postgres.Sql,
    ): Promise<void> {
        const valkeyAvailable = getValkeyClient() !== null;
        const dedupKey = `music-play-start:${userId}:${trackId}`;

        if (valkeyAvailable) {
            const acquired = await setIfNotExists(dedupKey, '1', PLAY_START_DEDUP_TTL_SECONDS);
            if (!acquired) {
                // Key already exists — this is a retry within the dedup window.
                logger.debug('Play start deduped (within window)', { userId, trackId });
                return;
            }
        }

        try {
            const sql = transactionSql ?? (await this.getSql());
            await recordPlayStart(sql, userId, trackId);
        } catch (err) {
            // The dedup key was claimed BEFORE this write, so leaving it in
            // place turns a failed write into a permanent one: the client's
            // retry lands inside the window, is deduped as "already
            // recorded", and play_count never moves for that listen. Release
            // it so the retry can actually do the work.
            if (valkeyAvailable) {
                await del(dedupKey).catch(() => {
                    // Best effort. Failing to release only restores the old
                    // behaviour (one lost play), and throwing here would
                    // replace the real error with this one.
                });
            }
            throw err;
        }
        logger.debug('Play start recorded', { userId, trackId, playContext });
    }

    /**
     * Called once when a track stops (completed, skipped, or user navigated away).
     * Updates cumulative stats in user_music_state and appends to event log.
     *
     * @param startedAt - Real play-start timestamp (ISO 8601), captured by the client
     *                     when the track began. NOT approximated from listenedMs.
     * @param noPlayStartReported - True when this listen was never preceded by a
     *                     `reportPlayStart` call — the offline-batch flush path,
     *                     which only ever reports play-end. Threaded through to
     *                     `recordPlayEnd`'s `bumpPlayCount`, so a track replayed
     *                     offline still moves play_count. The online single-event
     *                     path leaves this false: it assumes a paired play-start
     *                     already counted the play.
     */
    async reportPlayEnd(
        userId: UserId,
        trackId: string,
        listenedMs: number,
        startedAt: string | Date,
        durationMs?: number,
        wasSkipped: boolean = false,
        playContext?: string,
        eventId?: string | null,
        noPlayStartReported: boolean = false,
        transactionSql?: postgres.Sql,
        playStartClaim?: { id?: string; skipIfStartNear?: boolean },
    ): Promise<{ duplicate: boolean }> {
        const sql = transactionSql ?? (await this.getSql());

        const wasCompleted =
            !wasSkipped && durationMs !== undefined && durationMs > 0
                ? listenedMs >= durationMs * MUSIC_COMPLETION_THRESHOLD
                : false;

        // The idempotency claim (event insert) and the counters it guards run
        // in ONE transaction. They previously ran as separate awaits on the
        // same connection with no transaction wrapping it: if the process
        // died between the claim and the counter writes (SIGTERM mid-report,
        // statement timeout, connection drop), the event row survived alone
        // with no aggregate bump, and a client retry hit the unique-index
        // conflict below and was told `duplicate`/`retryable:false` —
        // permanently losing that listen's total_listen_ms/skip_count/
        // complete_count with no error surfaced. Wrapping the claim and its
        // side effects in `withTx` means a failure anywhere rolls the claim
        // back too, so a genuine retry re-runs everything instead of being
        // told it already happened.
        const result = await withTx(sql, async (tx) => {
            if (eventId && (await isRecordedListenEvent(tx, userId, eventId)))
                return { duplicate: true };
            // Append the event FIRST, because this insert doubles as the
            // idempotency claim when the caller supplied an eventId. A
            // conflict is only reachable when an eventId was supplied (the
            // unique index is partial), so this is unambiguously "already
            // recorded" and never a spurious collision between two genuine
            // plays.
            const occurredAt = (() => {
                const d = typeof startedAt === 'string' ? new Date(startedAt) : startedAt;
                return isNaN(d.getTime()) ? new Date() : d;
            })();
            const { inserted } = await insertListenEvent(tx, {
                userId: userId,
                trackId,
                startedAt: occurredAt,
                durationMs: listenedMs,
                trackDurationMs: durationMs ?? null,
                wasCompleted,
                wasSkipped,
                playContext: playContext ?? null,
                eventId: eventId ?? null,
            });

            if (!inserted) {
                logger.debug('Play end already recorded, skipping side effects', {
                    userId,
                    trackId,
                    eventId,
                });
                return { duplicate: true };
            }

            // Retain the idempotency event for an abandoned preload, without
            // creating aggregate state or feedback for audio never heard.
            if (listenedMs <= 0) return { duplicate: false };

            // A replay may carry the live session's playbackSessionId: the live
            // heartbeat claimed its start under THAT key, so claim on it (not
            // on the replay eventId) or the play counts twice. Without the id,
            // a reported start near startedAt for the same track also blocks.
            const claimId = playStartClaim?.id ?? eventId;
            const startAlreadyCounted =
                noPlayStartReported &&
                playStartClaim?.skipIfStartNear === true &&
                !playStartClaim.id &&
                (await hasMusicPlayStartNear(tx, userId, trackId, occurredAt));
            const bumpPlayCount =
                listenedMs > 0 &&
                !startAlreadyCounted &&
                (noPlayStartReported && claimId
                    ? await claimMusicPlayStart(tx, userId, claimId)
                    : noPlayStartReported);

            // Update aggregated state (UPSERT — safe if play-start was lost)
            await recordPlayEnd(
                tx,
                userId,
                trackId,
                listenedMs,
                wasSkipped,
                wasCompleted,
                bumpPlayCount,
                // The real listen time, which for an offline flush is hours
                // or days before now. Only affects a first-ever row; see the
                // parameter's doc.
                occurredAt,
            );

            // Update ratings (existing behavior)
            if (wasSkipped) {
                await recordTrackSkip(tx, userId, trackId);
            } else if (wasCompleted) {
                await recordTrackComplete(tx, userId, trackId);
            }

            return { duplicate: false };
        });

        // Cache invalidation runs after the transaction commits, and only for
        // a genuine write — a duplicate changed nothing, so there is nothing
        // for the cache to catch up on.
        if (!result.duplicate) {
            await cacheInvalidation.onRatingCacheChanged(userId);
            logger.debug('Play end recorded', {
                userId,
                trackId,
                listenedMs,
                wasSkipped,
                wasCompleted,
            });
        }
        return result;
    }

    /**
     * Verify the caller is allowed to interact with this track.
     * Used by every explicit interaction below; routes call it through
     * the {@link like}/{@link dislike}/{@link skip}/{@link complete}
     * variants which take a UserContext.
     *
     * An undefined `user` is always rejected — passing no user context
     * would cause `checkMediaAccess` to return `true` unconditionally
     * (its "unauthenticated — let auth middleware handle it" early-exit),
     * silently bypassing the library and age gate. Every call site must
     * resolve a real UserContext before invoking these methods.
     */
    private async assertCanInteract(
        sql: Awaited<ReturnType<typeof aiDbService.getSql>>,
        trackId: string,
        user: UserContext | undefined,
    ): Promise<void> {
        if (!user) {
            throw new MediaAccessDeniedError();
        }
        if (!sql) throw new MediaAccessDeniedError();
        if (!(await checkMediaAccess(sql, trackId, user))) {
            throw new MediaAccessDeniedError();
        }
    }

    /**
     * Run a track-feedback write and translate a foreign-key violation
     * (23503) or an invalid-uuid cast (22P02) into the same
     * `MediaAccessDeniedError` `assertCanInteract` already throws.
     *
     * `assertCanInteract`'s `checkMediaAccess` call short-circuits to
     * "allowed" for an unrestricted, non-age-restricted user without ever
     * looking the trackId up (see `getDeniedLibraryGroups`), so a trackId
     * that does not exist — deleted from the library, or simply malformed —
     * only surfaces here, at the write. Every def that calls like/dislike/
     * removeLike/removeDislike/skip/complete already catches
     * `MediaAccessDeniedError` and maps it to 404; centralising the
     * translation here means a future def cannot ship without it, matching
     * what `music/progress/start` and `music/progress/end` already do
     * against the same FK by hand.
     */
    private async writeOrNotFound<T>(fn: () => Promise<T>): Promise<T> {
        try {
            return await fn();
        } catch (err) {
            if (isMissingTrackError(err)) throw new MediaAccessDeniedError();
            throw err;
        }
    }

    // ── Explicit interactions (from queue like/dislike buttons) ──
    //
    // Each takes the caller's UserContext so the service can gate the
    // write by library + age. The userId is still passed separately
    // because the write may target a different user (admin tooling).
    // A real UserContext MUST be provided — undefined is rejected.

    async like(userId: UserId, trackId: string, user?: UserContext): Promise<void> {
        const sql = await this.getSql();
        await this.assertCanInteract(sql, trackId, user);
        if (!['track', 'audio'].includes((await getMediaType(sql, trackId)) ?? ''))
            throw new MediaAccessDeniedError();
        await this.writeOrNotFound(() => recordTrackLike(sql, userId, trackId));
        await cacheInvalidation.onRatingCacheChanged(userId);
        logger.debug('Track like recorded', { userId, trackId });
    }

    async dislike(userId: UserId, trackId: string, user?: UserContext): Promise<void> {
        const sql = await this.getSql();
        await this.assertCanInteract(sql, trackId, user);
        if (!['track', 'audio'].includes((await getMediaType(sql, trackId)) ?? ''))
            throw new MediaAccessDeniedError();
        await this.writeOrNotFound(() => recordTrackDislike(sql, userId, trackId));
        await cacheInvalidation.onRatingCacheChanged(userId);
        logger.debug('Track dislike recorded', { userId, trackId });
    }

    // ── Clearing explicit feedback ────────────────────────────────────
    //
    // Idempotent by construction: each clear is scoped to its own direction,
    // so removing a like from a track that is not liked (or is disliked) is a
    // silent no-op rather than an error. Callers get 204 either way — a
    // toggle-off button must not fail just because another device got there
    // first, and the two directions must never clear each other.

    async removeLike(userId: UserId, trackId: string, user?: UserContext): Promise<void> {
        const sql = await this.getSql();
        await this.assertCanInteract(sql, trackId, user);
        const cleared = await this.writeOrNotFound(() => clearTrackLike(sql, userId, trackId));
        if (cleared) await cacheInvalidation.onRatingCacheChanged(userId);
        logger.debug('Track like cleared', { userId, trackId, cleared });
    }

    async removeDislike(userId: UserId, trackId: string, user?: UserContext): Promise<void> {
        const sql = await this.getSql();
        await this.assertCanInteract(sql, trackId, user);
        const cleared = await this.writeOrNotFound(() => clearTrackDislike(sql, userId, trackId));
        if (cleared) await cacheInvalidation.onRatingCacheChanged(userId);
        logger.debug('Track dislike cleared', { userId, trackId, cleared });
    }

    async skip(userId: UserId, trackId: string, user?: UserContext): Promise<void> {
        const sql = await this.getSql();
        await this.assertCanInteract(sql, trackId, user);
        await this.writeOrNotFound(() => recordTrackSkip(sql, userId, trackId));
        await cacheInvalidation.onRatingCacheChanged(userId);
        logger.debug('Track skip recorded', { userId, trackId });
    }

    async complete(userId: UserId, trackId: string, user?: UserContext): Promise<void> {
        const sql = await this.getSql();
        await this.assertCanInteract(sql, trackId, user);
        await this.writeOrNotFound(() => recordTrackComplete(sql, userId, trackId));
        await cacheInvalidation.onRatingCacheChanged(userId);
        logger.debug('Track complete listen recorded', { userId, trackId });
    }

    /**
     * Called when a play session ends without precise timing information
     * (e.g. Subsonic scrobble/stopped paths where listenedMs is unavailable).
     * Increments complete_count only — UPDATE-only, never inserts a phantom row.
     * If no prior play-start was recorded (no row exists) this is a safe no-op:
     * we do not inflate play_count for a play we have no evidence of starting.
     */
    async recordPlayEnd(userId: UserId, trackId: string): Promise<void> {
        const sql = await this.getSql();
        await recordPlayEndNoTiming(sql, userId, trackId);
        await cacheInvalidation.onRatingCacheChanged(userId);
        logger.debug('Play end recorded (no timing)', { userId, trackId });
    }

    /**
     * Atomic external-play-end: records both the complete interaction signal
     * and the no-timing play-end in a single manager call, sharing one DB
     * connection and one cache-invalidation call.
     *
     * Use this for Subsonic 'stopped' events that arrive without a prior
     * 'starting' state — combining the two ops prevents partial writes and
     * avoids the double cache-invalidation that firing them separately causes.
     *
     * @param userId - The user who was playing
     * @param trackId - The track that stopped
     * @param user - UserContext for access gate (required)
     */
    async recordExternalPlayEnd(
        userId: UserId,
        trackId: string,
        user: UserContext | undefined,
        transactionSql?: postgres.Sql,
    ): Promise<void> {
        const sql = transactionSql ?? (await this.getSql());
        await this.assertCanInteract(sql, trackId, user);
        await withTx(sql, async (tx) => {
            await recordTrackComplete(tx, userId, trackId);
            await recordPlayEndNoTiming(tx, userId, trackId);
        });
        // Single cache invalidation covering both writes.
        await cacheInvalidation.onRatingCacheChanged(userId);
        logger.debug('External play end recorded', { userId, trackId });
    }
}

export const musicInteractionManager = new MusicInteractionManager();
