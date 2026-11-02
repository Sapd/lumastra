// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WatchManager — owns all business logic for watch state.
 * Routes call this service, not raw query functions.
 *
 * Responsibilities:
 * - Progress updates during playback
 * - Explicit mark/unmark watched
 * - Bulk watch operations (season/series)
 * - Continue Watching / Next Up queries
 * - Watched status reads
 */

import { parseVirtualSeasonHandle } from './media-handle.js';
import { getSeriesOrdering } from '$lib/server/database/queries/season-detail.queries.js';
import { getSeriesEpisodesWithWatchState } from '$lib/server/database/queries/episode-detail.queries.js';

import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import { Logger } from '$lib/server/utils/logger.js';
import { config } from '$lib/server/config.js';
import { aiDbService } from './database.service.js';
import {
    getUserWatchState,
    batchGetUserWatchStates,
    getContinueWatchingFromDb,
    getNextUpFromDb,
    getNextUpForSeriesFromDb,
    getFirstEpisodeForSeries,
    getNextUpForSeasonFromDb,
    getFirstEpisodeForSeason,
    getWatchedEpisodeKeys,
    getWatchedSeriesFromDb,
    getWatchedTmdbIdsFromDb,
    getWatchedMediaUuidsFromDb,
    computeSeriesProgress,
    type WatchStateRow,
    type ContinueWatchingRow,
    type NextUpRow,
} from '$lib/server/database/queries/watch-state.queries.js';
import { watchStateEvents } from './watch-state-events.service.js';
import { getEpisodeWindowsForFile } from '$lib/server/database/queries/file-segments.queries.js';
import {
    getSeriesEpisodeIds,
    getSeasonEpisodeIds,
    getSeriesEpisodesWithOrderAndState,
} from '$lib/server/database/queries/watch-status.queries.js';
import {
    getResumeStates,
    getResumePositionForMedia,
} from '$lib/server/database/queries/user-media-state.queries.js';
import {
    invalidateAllWatchedCaches,
    invalidateContinueWatchingCache,
    getCachedWatchedIds,
    setCachedWatchedIds,
    getWatchedExternalIdSet,
    watchedCache,
    getWatchedUuidsCacheKey,
} from './watched-cache.service.js';
import { getOrComputeSingleFlight } from '$lib/server/cache/single-flight.js';
import { getWatchedItems } from '$lib/server/database/queries/index.js';
import { unrestrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { ExternalIdSet, ExternalIdMediaType } from '$lib/server/utils/tmdb-composite-key.js';
import { ticksToMs, EPISODE_ORDER_MULTIPLIER } from '$lib/server/utils/jellyfin-units.js';
import {
    applyAutoCompleteFromProgress,
    completionThresholdFor,
    crossedCompletionThreshold,
} from '$lib/server/utils/watch-constants.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import {
    appendEventAndRebuild,
    appendEventAndRebuildWithOutcome,
    type EventAppendOutcome,
} from './watch-state-rebuilder.service.js';
import { isSeries, isSeason, isAudiobook } from '$lib/shared/media-types.js';
import type { UserId } from '$lib/shared/user-id.js';
import {
    hasSessionCompletion,
    type EventSource,
} from '$lib/server/database/queries/user-media-events.queries.js';
import type { AgeRatingFilterParams } from '$lib/server/database/queries/builders/age-rating.builder.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';

const logger = Logger.for('WatchManager');

/**
 * Max media rows written per transaction during a bulk fan-out
 * (`fanOutMark`). Marking a season/series watched can touch 20–200 episode
 * rows; wrapping all of them in a single transaction pins one pool
 * connection for the entire fan-out (50–500 ms) and grows the row-lock
 * footprint linearly. Chunking commits incrementally so each transaction
 * is short and the connection is returned to the pool between batches.
 *
 * Cross-chunk atomicity is intentionally relaxed: every per-(user,media)
 * `appendEventAndRebuild` is itself atomic, the events are independent, and
 * a partial run self-heals on the next rebuild — a bulk mark-all does not
 * need to be all-or-nothing across hundreds of episodes.
 */
const FANOUT_CHUNK_SIZE = 25;

class WatchManager {
    private async getSql(): Promise<postgres.Sql | null> {
        return aiDbService.getSql();
    }

    // === Progress (called by the unified progress endpoint) ===

    async reportProgress(
        params: {
            userId: UserId;
            mediaId: string;
            positionMs: number;
            runtimeMs?: number;
            sessionId: string;
            eventSeq: number;
            mediaType?: string;
            // Passed through to updateWatchProgress as the cross-session
            // ordering tiebreaker. Optional for callers that don't have the
            // session row handy (tests, legacy paths).
            sessionStartedAt?: Date;
            /**
             * Cumulative ms the player has been actively *playing* in this
             * session (excluding pauses, seeks, buffering). Drives the
             * engagement-based CW filter; absent for legacy callers.
             */
            sessionElapsedMs?: number;
            /**
             * Overrides the completion threshold for the primary item's
             * auto-complete AND, for combined multi-episode files, its sibling
             * episodes' completion (they share the same episode media_type).
             * Set by the /j-compat path (Jellyfin's flat 0.90 episode bar).
             * Absent → runtime-tiered completionThresholdFor().
             */
            completionThreshold?: number;
            /**
             * Occurrence time for every event this call emits. Defaults to now.
             * Offline ingestion passes the record's real end time so arbitration
             * sees when playback actually happened.
             *
             * This MUST apply to the derived 'completed' and the combined-file
             * sibling completions as well as the progress event. A back-dated
             * progress paired with a now-stamped completion makes that
             * completion the newest decisive event, and the resume walk zeroes
             * the position because its source won is_watched arbitration.
             */
            occurredAt?: string;
            /**
             * Provenance for every event this call emits. Defaults to
             * 'lumastra-player'. Offline ingestion passes 'lumastra-offline'.
             */
            source?: EventSource;
            /**
             * Idempotency key for the progress event. Derived completions use a
             * session-based key (also scoped by media and source in the unique
             * index), so different progress reports for one session still share
             * one completion, including combined-file sibling episodes.
             *
             * Without this the progress event inserts fresh on every replay,
             * `accepted` stays true, and the derived completion fires again —
             * inflating watch_count on each retry. Live heartbeats leave it
             * undefined and keep today's NULL behaviour.
             *
             * NOTE for any future LIVE (non-offline) caller: a replayed key
             * collapses on the unique index and comes back `'duplicate'` rather
             * than `'accepted'`, so the derived completion is correctly skipped.
             * It is NOT reported to the client as a supersede —
             * `reportProgress` returns the specific `EventAppendOutcome` and
             * `play-session-lifecycle.service.ts` raises `action: 'superseded'`
             * only for `'superseded'`. Before that split, a retried request
             * surfaced the "this session was superseded" toast (and the hard
             * client-side stop behind it) even though nothing was superseded.
             */
            sourceEventId?: string;
        },
        txSql?: postgres.Sql,
    ): Promise<EventAppendOutcome> {
        const sql = txSql ?? (await this.getSql());
        if (!sql) throw new Error('Database unavailable');

        const { getMediaType, isMusicMediaType } =
            await import('$lib/server/database/queries/media-type-cache.queries.js');
        const mediaType = params.mediaType ?? (await getMediaType(sql, params.mediaId));
        if (isMusicMediaType(mediaType)) {
            logger.warn(
                'watchManager.reportProgress called with music track — this is a bug. ' +
                    'Music should use MusicInteractionManager.',
                {
                    mediaId: params.mediaId,
                    mediaType,
                    userId: params.userId,
                },
            );
            return 'accepted';
        }

        const now = params.occurredAt ?? new Date().toISOString();
        const eventSource: EventSource = params.source ?? 'lumastra-player';

        const outcome = await appendEventAndRebuildWithOutcome(sql, {
            user_id: params.userId,
            media_id: params.mediaId,
            event_type: 'progress',
            source: eventSource,
            position_ms: params.positionMs,
            runtime_ms: params.runtimeMs ?? null,
            source_event_id: params.sourceEventId ?? null,
            session_id: params.sessionId,
            event_seq: params.eventSeq,
            session_elapsed_ms: params.sessionElapsedMs ?? null,
            occurred_at: now,
            session_started_at: params.sessionStartedAt?.toISOString() ?? null,
        });

        // A combined file (S02E24E25) is ONE video holding several episodes, and
        // positions are file-absolute. Judge completion against THIS episode's
        // window: entering episode 25 at 692s is 0% of it, not 105% of a 660s
        // runtime — which would mark it watched the moment it opened.
        const windows = await getEpisodeWindowsForFile(sql, params.mediaId).catch(() => []);
        const window = windows.find((w) => w.mediaItemId === params.mediaId) ?? null;
        // Auto-complete: if runtime is known and position crosses threshold, also
        // emit a completed event so the rebuilder marks is_watched=true. Skip
        // when the progress event was rejected as stale — otherwise a dead tab
        // could still mark an item watched after the active tab moved on.
        //
        // The threshold rule itself lives in `crossedCompletionThreshold` so its
        // test exercises THIS code rather than a copy of it; `accepted` stays
        // here because staleness is this caller's gate, not the rule's.
        const accepted = outcome === 'accepted';
        const crossedThreshold =
            accepted &&
            crossedCompletionThreshold({
                positionMs: params.positionMs,
                window,
                runtimeMs: params.runtimeMs,
                mediaType: mediaType ?? undefined,
                explicitThreshold: params.completionThreshold,
            });
        // Once per session: the player keeps beating past the threshold
        // (credits, a paused end screen), and every extra `completed` is
        // another +1 on watch_count. A later session is a genuine rewatch.
        // The deterministic completion key below is the concurrency guard:
        // overlapping heartbeat/stop calls can both pass this cheap read.
        const completedNow =
            crossedThreshold &&
            !(await hasSessionCompletion(sql, {
                userId: params.userId,
                mediaId: params.mediaId,
                sessionId: params.sessionId,
            }));
        if (completedNow) {
            await appendEventAndRebuild(sql, {
                user_id: params.userId,
                media_id: params.mediaId,
                event_type: 'completed',
                source: eventSource,
                position_ms: params.positionMs,
                runtime_ms: params.runtimeMs ?? null,
                source_event_id: `session:${params.sessionId}:completed`,
                session_id: params.sessionId,
                event_seq: params.eventSeq,
                session_elapsed_ms: params.sessionElapsedMs ?? null,
                occurred_at: now,
            });
        }

        // Watching a combined file straight through plays several episodes in one
        // session, but the player only ever reports the episode that was opened —
        // so its neighbours would never complete, and Next Up would send the viewer
        // back into the file they just finished. Complete them from the same
        // position, each against its own window.
        //
        // Only forwards: a window starting BEFORE the opened episode's was skipped
        // past, not watched (entering at episode 25 does not mean episode 24 was
        // seen), so it must never be marked from this session.
        if (accepted && window) {
            for (const sibling of windows) {
                if (sibling.mediaItemId === params.mediaId) continue;
                if (sibling.startMs < window.startMs) continue;

                const siblingRuntimeMs = sibling.endMs - sibling.startMs;
                const siblingPositionMs = params.positionMs - sibling.startMs;
                const siblingThreshold =
                    params.completionThreshold ??
                    completionThresholdFor(mediaType ?? undefined, siblingRuntimeMs);
                const siblingCrossed =
                    siblingRuntimeMs > 0 &&
                    siblingPositionMs >= siblingRuntimeMs * siblingThreshold;
                if (!siblingCrossed) continue;
                if (
                    await hasSessionCompletion(sql, {
                        userId: params.userId,
                        mediaId: sibling.mediaItemId,
                        sessionId: params.sessionId,
                    })
                ) {
                    continue;
                }

                await appendEventAndRebuild(sql, {
                    user_id: params.userId,
                    media_id: sibling.mediaItemId,
                    event_type: 'completed',
                    source: eventSource,
                    position_ms: params.positionMs,
                    runtime_ms: siblingRuntimeMs,
                    source_event_id: `session:${params.sessionId}:completed`,
                    session_id: params.sessionId,
                    event_seq: params.eventSeq,
                    session_elapsed_ms: params.sessionElapsedMs ?? null,
                    occurred_at: now,
                });
            }
        }

        // Heartbeat-driven progress writes do NOT emit a set-membership event;
        // CW eligibility only flips on auto-complete (covered below) or
        // explicit mark/clear paths.
        if (completedNow) {
            // Auto-complete flips CW/NU membership (the item leaves Continue
            // Watching; its successor may surface as Next Up), so evict the
            // short-TTL durable-row cache immediately rather than waiting out
            // the TTL. Heartbeat progress writes that do NOT cross the
            // threshold intentionally skip this (they'd invalidate on every
            // beat); their resume drift is bounded by the TTL + live overlay.
            await invalidateContinueWatchingCache(params.userId).catch((e) =>
                logger.warn('Failed to invalidate continue-watching cache', e as Error),
            );

            watchStateEvents.emit(params.userId, {
                type: 'watch_state_set_changed',
                mediaId: params.mediaId,
                reason: 'auto_complete',
            });
        }

        return outcome;
    }

    async clearWatchProgress(
        params: { userId: UserId; mediaId?: string },
        txSql?: postgres.Sql,
    ): Promise<void> {
        const sql = txSql ?? (await this.getSql());
        if (!sql) throw new Error('Database unavailable');

        const now = new Date().toISOString();

        if (params.mediaId) {
            await appendEventAndRebuild(sql, {
                user_id: params.userId,
                media_id: params.mediaId,
                event_type: 'progress',
                source: 'lumastra-user-mark',
                position_ms: 0,
                runtime_ms: null,
                source_event_id: null,
                session_id: null,
                event_seq: null,
                occurred_at: now,
            });
        } else {
            // Bulk clear: emit progress=0 for every item the user has a resume on
            const resumeRows = await getResumeStates.all(sql, {
                userId: params.userId,
            });
            for (const row of resumeRows) {
                await appendEventAndRebuild(sql, {
                    user_id: params.userId,
                    media_id: row.media_id,
                    event_type: 'progress',
                    source: 'lumastra-user-mark',
                    position_ms: 0,
                    runtime_ms: null,
                    source_event_id: null,
                    session_id: null,
                    event_seq: null,
                    occurred_at: now,
                });
            }
        }

        // Clearing progress removes the item(s) from Continue Watching — evict
        // the durable-row cache so the strip reflects it on the next load.
        // (clearWatchProgress does not go through invalidateAllWatchedCaches.)
        await invalidateContinueWatchingCache(params.userId).catch((e) =>
            logger.warn('Failed to invalidate continue-watching cache', e as Error),
        );

        watchStateEvents.emit(params.userId, {
            type: 'watch_state_set_changed',
            mediaId: params.mediaId ?? '*',
            reason: 'clear_progress',
        });
    }

    /**
     * Set the resume point of one item explicitly — not a playback heartbeat
     * (no session, no completion threshold): a client writing the user's
     * data, e.g. the Jellyfin-compat `POST /UserItems/{id}/UserData` with
     * `PlaybackPositionTicks`. Position 0 clears the resume point, exactly
     * like {@link clearWatchProgress}.
     */
    async setResumePosition(params: {
        userId: UserId;
        mediaId: string;
        positionMs: number;
    }): Promise<void> {
        const positionMs = Math.max(0, Math.floor(params.positionMs));
        if (positionMs === 0) {
            await this.clearWatchProgress({ userId: params.userId, mediaId: params.mediaId });
            return;
        }
        const sql = await this.getSql();
        if (!sql) throw new Error('Database unavailable');

        await appendEventAndRebuild(sql, {
            user_id: params.userId,
            media_id: params.mediaId,
            event_type: 'progress',
            source: 'lumastra-user-mark',
            position_ms: positionMs,
            runtime_ms: null,
            source_event_id: null,
            session_id: null,
            event_seq: null,
            occurred_at: new Date().toISOString(),
        });

        await invalidateContinueWatchingCache(params.userId).catch((e) =>
            logger.warn('Failed to invalidate continue-watching cache', e as Error),
        );

        watchStateEvents.emit(params.userId, {
            type: 'watch_state_set_changed',
            mediaId: params.mediaId,
            reason: 'set_progress',
        });
    }

    // === Explicit mark watched/unwatched ===

    async markWatched(
        params: {
            userId: UserId;
            mediaId: string;
        },
        txSql?: postgres.Sql,
    ): Promise<void> {
        const sql = txSql ?? (await this.getSql());
        if (!sql) throw new Error('Database unavailable');
        if (parseVirtualSeasonHandle(params.mediaId)) {
            await this.markVirtualSeason(sql, params.userId, params.mediaId, 'mark_watched');
            return;
        }

        const { getMediaType, isMusicMediaType } =
            await import('$lib/server/database/queries/media-type-cache.queries.js');
        const mediaType = await getMediaType(sql, params.mediaId);
        if (isMusicMediaType(mediaType)) {
            logger.warn(
                'watchManager.markWatched called with music track — this is a bug. ' +
                    'Music should use MusicInteractionManager.',
                {
                    mediaId: params.mediaId,
                    mediaType,
                    userId: params.userId,
                },
            );
            return;
        }

        // Series and seasons fan out so the modal's promise — "Do you want
        // to mark all episodes of {title} as watched?" — actually marks
        // every episode. Without the fan-out, only the series-level row
        // flips `is_watched=true` while CW/NextUp/episode lists keep showing
        // unwatched episodes (modal badge looked correct, everything else
        // didn't). Use canonical case-insensitive guards so legacy
        // PascalCase / UPPERCASE rows are still routed correctly.
        if (isSeries(mediaType)) {
            await this.markSeriesWatched({ userId: params.userId, seriesId: params.mediaId }, sql);
            return;
        }
        if (isSeason(mediaType)) {
            const handled = await this.fanOutSeasonByMediaId(sql, {
                userId: params.userId,
                seasonMediaId: params.mediaId,
                kind: 'mark_watched',
            });
            if (handled) return;
            // Fall through to single-event path when the season row is
            // missing parent/season_number (treat as a leaf).
        }

        await appendEventAndRebuild(sql, {
            user_id: params.userId,
            media_id: params.mediaId,
            event_type: 'mark_watched',
            source: 'lumastra-user-mark',
            position_ms: null,
            runtime_ms: null,
            source_event_id: null,
            session_id: null,
            event_seq: null,
            occurred_at: new Date().toISOString(),
        });

        await invalidateAllWatchedCaches(params.userId).catch((e) =>
            logger.warn('Failed to invalidate watched caches', e as Error),
        );

        watchStateEvents.emit(params.userId, {
            type: 'watch_state_set_changed',
            mediaId: params.mediaId,
            reason: 'mark_watched',
        });
    }

    async markUnwatched(params: { userId: UserId; mediaId: string }): Promise<void> {
        const sql = await this.getSql();
        if (!sql) throw new Error('Database unavailable');
        if (parseVirtualSeasonHandle(params.mediaId)) {
            await this.markVirtualSeason(sql, params.userId, params.mediaId, 'mark_unwatched');
            return;
        }

        const { getMediaType, isMusicMediaType } =
            await import('$lib/server/database/queries/media-type-cache.queries.js');
        const mediaType = await getMediaType(sql, params.mediaId);
        if (isMusicMediaType(mediaType)) {
            logger.warn(
                'watchManager.markUnwatched called with music track — this is a bug. ' +
                    'Music should use MusicInteractionManager.',
                {
                    mediaId: params.mediaId,
                    mediaType,
                    userId: params.userId,
                },
            );
            return;
        }

        if (isSeries(mediaType)) {
            await this.markSeriesUnwatched(
                { userId: params.userId, seriesId: params.mediaId },
                sql,
            );
            return;
        }
        if (isSeason(mediaType)) {
            const handled = await this.fanOutSeasonByMediaId(sql, {
                userId: params.userId,
                seasonMediaId: params.mediaId,
                kind: 'mark_unwatched',
            });
            if (handled) return;
        }

        // Audiobooks keep their listening position across an un-finish. For a
        // film "mark unwatched" means "I have not seen this" and dropping the
        // resume is the point; for a 21-hour book the position is the only
        // thing the user is trying to recover, and zeroing it is worse than the
        // bug they were escaping — the arbitrated position is pushed to
        // AudiobookShelf's history-free progress row, so it does not survive
        // anywhere. Carried ON the event because state is rebuilt from the log:
        // see the decisive-event branch in watch-state-rebuilder. Every other
        // media type still sends null and still resets to 0.
        let preservedPositionMs: number | null = null;
        if (isAudiobook(mediaType)) {
            const row = await getResumePositionForMedia.one(sql, {
                userId: params.userId,
                mediaId: params.mediaId,
            });
            preservedPositionMs = row?.resume_position_ms ?? null;
        }

        await appendEventAndRebuild(sql, {
            user_id: params.userId,
            media_id: params.mediaId,
            event_type: 'mark_unwatched',
            source: 'lumastra-user-mark',
            position_ms: preservedPositionMs,
            runtime_ms: null,
            source_event_id: null,
            session_id: null,
            event_seq: null,
            occurred_at: new Date().toISOString(),
        });

        await invalidateAllWatchedCaches(params.userId).catch((e) =>
            logger.warn('Failed to invalidate watched caches', e as Error),
        );

        watchStateEvents.emit(params.userId, {
            type: 'watch_state_set_changed',
            mediaId: params.mediaId,
            reason: 'mark_unwatched',
        });
    }

    /**
     * Resolve a season media UUID to its parent series UUID + season number
     * and dispatch to the season fan-out helper. Returns true on a successful
     * dispatch, false when the row is missing/incomplete (caller should fall
     * back to single-event behaviour).
     */
    private async fanOutSeasonByMediaId(
        sql: postgres.Sql,
        args: {
            userId: UserId;
            seasonMediaId: string;
            kind: 'mark_watched' | 'mark_unwatched';
        },
    ): Promise<boolean> {
        const [row] = await sql<{ parent_id: string | null; season_number: number | null }[]>`
            SELECT parent_id, season_number
            FROM media_items
            WHERE id = ${args.seasonMediaId}::uuid
            LIMIT 1
        `;
        if (!row?.parent_id || row.season_number == null) {
            // Surface the data integrity issue: a season row in media_items
            // without a parent series or season_number can't be fanned out.
            // The dispatcher falls back to single-event semantics (the
            // season UUID alone gets marked) so the user's toggle isn't
            // silently dropped, but child episodes won't be marked.
            logger.warn('Season fan-out skipped — incomplete season metadata', {
                seasonMediaId: args.seasonMediaId,
                parentId: row?.parent_id ?? null,
                seasonNumber: row?.season_number ?? null,
            });
            return false;
        }

        const params = {
            userId: args.userId,
            seriesId: row.parent_id,
            seasonNumber: row.season_number,
            seasonMediaId: args.seasonMediaId,
        };
        if (args.kind === 'mark_watched') {
            await this.markSeasonWatched(params, sql);
        } else {
            await this.markSeasonUnwatched(params, sql);
        }
        return true;
    }

    // === Bulk operations ===

    /**
     * Append a `mark_watched` / `mark_unwatched` event for every episode
     * under the parent row, atomically. When `parentId` is provided, an
     * additional event is written for the parent itself so direct
     * `getWatchState(parentId)` reads (modal badge, batch watched-status
     * queries) stay consistent with the per-episode rows that drive
     * Continue Watching, Next Up, and checkmarks.
     *
     * `parentId` MUST identify the row whose `is_watched` should toggle —
     * never a stand-in. Callers that don't know the real parent UUID (e.g.
     * marking a single season without its season UUID) must omit it: using
     * the series UUID as a substitute would flip the series row even though
     * only one season was marked.
     *
     * Pass `outerSql` when participating in an existing transaction
     * (`postgres.begin` nests as a SAVEPOINT, so each chunk's `withTx`
     * below stays atomic). Single cache invalidation + a single SSE emit
     * run after all chunks complete — fan-out is one logical operation.
     *
     * The marks are written in chunks of {@link FANOUT_CHUNK_SIZE} rows,
     * each in its own transaction, so a large season/series mark doesn't
     * pin one pool connection for the whole fan-out. See the constant's
     * doc for the atomicity trade-off.
     */
    private async markVirtualSeason(
        sql: postgres.Sql,
        userId: UserId,
        handle: string,
        kind: 'mark_watched' | 'mark_unwatched',
    ): Promise<void> {
        const season = parseVirtualSeasonHandle(handle);
        if (
            !season ||
            season.ordering === 'standard' ||
            (await getSeriesOrdering(sql, season.seriesUuid)) !== season.ordering
        ) {
            throw new Error('Virtual season not found');
        }
        const episodes = await getSeriesEpisodesWithWatchState(
            sql,
            season.seriesUuid,
            userId,
            season.seasonNumber,
        );
        if (!episodes.length) throw new Error('Virtual season not found');
        await this.fanOutMark(sql, {
            userId,
            episodeIds: [...new Set(episodes.map((ep) => ep.id))],
            kind,
            reason: kind === 'mark_watched' ? 'mark_season_watched' : 'mark_season_unwatched',
        });
    }

    private async fanOutMark(
        outerSql: postgres.Sql | undefined,
        args: {
            userId: UserId;
            /** Omit when no real parent UUID is known — see contract above. */
            parentId?: string;
            episodeIds: string[];
            kind: 'mark_watched' | 'mark_unwatched';
            reason: string;
        },
    ): Promise<number> {
        const sql = outerSql ?? (await this.getSql());
        if (!sql) throw new Error('Database unavailable');

        const now = new Date().toISOString();
        // Parent event leads (preserves "season/series row first" ordering),
        // then every episode. Chunked across transactions so a large fan-out
        // doesn't hold one pool connection for the whole loop.
        const all = args.parentId ? [args.parentId, ...args.episodeIds] : [...args.episodeIds];
        for (let i = 0; i < all.length; i += FANOUT_CHUNK_SIZE) {
            const chunk = all.slice(i, i + FANOUT_CHUNK_SIZE);
            await withTx(sql, async (rawTxSql) => {
                const txSql = rawTxSql as unknown as postgres.Sql;
                const watched =
                    args.kind === 'mark_watched'
                        ? new Set(
                              (
                                  await batchGetUserWatchStates.all(txSql, {
                                      userId: args.userId,
                                      mediaIds: chunk,
                                  })
                              )
                                  .filter((state) => state.is_watched)
                                  .map((state) => state.media_id),
                          )
                        : new Set<string>();
                for (const mediaId of chunk) {
                    if (watched.has(mediaId)) continue;
                    await appendEventAndRebuild(txSql, {
                        user_id: args.userId,
                        media_id: mediaId,
                        event_type: args.kind,
                        source: 'lumastra-user-mark',
                        position_ms: null,
                        runtime_ms: null,
                        source_event_id: null,
                        session_id: null,
                        event_seq: null,
                        occurred_at: now,
                    });
                }
            });
        }

        await invalidateAllWatchedCaches(args.userId).catch((e) =>
            logger.warn('Failed to invalidate watched caches', e as Error),
        );

        watchStateEvents.emit(args.userId, {
            type: 'watch_state_set_changed',
            mediaId: '*',
            reason: args.reason,
        });

        return args.episodeIds.length;
    }

    async markSeasonWatched(
        params: {
            userId: UserId;
            seriesId: string;
            seasonNumber: number;
            /** Season UUID — when known, written so direct getWatchState(seasonId) reads stay consistent. */
            seasonMediaId?: string;
        },
        outerSql?: postgres.Sql,
    ): Promise<number> {
        const sql = outerSql ?? (await this.getSql());
        if (!sql) throw new Error('Database unavailable');

        const episodeIds = params.seasonMediaId
            ? (
                  await getSeriesEpisodesWithWatchState(
                      sql,
                      params.seriesId,
                      params.userId,
                      undefined,
                      { physicalSeasonId: params.seasonMediaId },
                  )
              ).map((ep) => ep.id)
            : await getSeasonEpisodeIds(sql, params.seriesId, params.seasonNumber);
        return this.fanOutMark(sql, {
            userId: params.userId,
            // Only write a parent event when the real season UUID is known.
            // Falling back to seriesId would flip getWatchState(seriesId)
            // even though only one season was marked — wrong semantic.
            parentId: params.seasonMediaId,
            episodeIds,
            kind: 'mark_watched',
            reason: 'mark_season_watched',
        });
    }

    async markSeasonUnwatched(
        params: {
            userId: UserId;
            seriesId: string;
            seasonNumber: number;
            seasonMediaId?: string;
        },
        outerSql?: postgres.Sql,
    ): Promise<number> {
        const sql = outerSql ?? (await this.getSql());
        if (!sql) throw new Error('Database unavailable');

        const episodeIds = params.seasonMediaId
            ? (
                  await getSeriesEpisodesWithWatchState(
                      sql,
                      params.seriesId,
                      params.userId,
                      undefined,
                      { physicalSeasonId: params.seasonMediaId },
                  )
              ).map((ep) => ep.id)
            : await getSeasonEpisodeIds(sql, params.seriesId, params.seasonNumber);
        return this.fanOutMark(sql, {
            userId: params.userId,
            parentId: params.seasonMediaId,
            episodeIds,
            kind: 'mark_unwatched',
            reason: 'mark_season_unwatched',
        });
    }

    async markSeriesWatched(
        params: {
            userId: UserId;
            seriesId: string;
        },
        outerSql?: postgres.Sql,
    ): Promise<number> {
        const sql = outerSql ?? (await this.getSql());
        if (!sql) throw new Error('Database unavailable');

        const episodeIds = await getSeriesEpisodeIds(sql, params.seriesId);
        return this.fanOutMark(sql, {
            userId: params.userId,
            parentId: params.seriesId,
            episodeIds,
            kind: 'mark_watched',
            reason: 'mark_series_watched',
        });
    }

    async markSeriesUnwatched(
        params: {
            userId: UserId;
            seriesId: string;
        },
        outerSql?: postgres.Sql,
    ): Promise<number> {
        const sql = outerSql ?? (await this.getSql());
        if (!sql) throw new Error('Database unavailable');

        const episodeIds = await getSeriesEpisodeIds(sql, params.seriesId);
        return this.fanOutMark(sql, {
            userId: params.userId,
            parentId: params.seriesId,
            episodeIds,
            kind: 'mark_unwatched',
            reason: 'mark_series_unwatched',
        });
    }

    /**
     * "Set my progress" — manual reconciliation when Lumastra's view of a
     * series drifts from the user's mental model in a way no Jellyfin
     * re-pull can fix (watched outside Jellyfin, Jellyfin marked things
     * wrong, etc.). Two modes:
     *
     *  - **through-episode**: linear "I'm at S3:E5". Marks every episode
     *    in effective custom order <= the picked one as watched, every
     *    one > as unwatched. The common case.
     *  - **per-episode**: explicit `{ watchedIds, unwatchedIds }` for
     *    non-linear viewing (anthologies, filler-skipping).
     *
     * Both modes commit as a *delta* against the current `is_watched`
     * state so re-saving an unchanged episode doesn't re-emit its
     * `mark_watched` event — that would bump `last_watched_at` to "now"
     * and scramble the NextUp anchor (which picks the most-recently-
     * watched). Atomic transaction so a partial run can't leave the row
     * set inconsistent.
     *
     * Series-level `is_watched` follows the FINAL state: full mark_watched
     * only when every episode ends up watched, else mark_unwatched (so the
     * modal badge doesn't claim "✓ Watched" on a partially-completed
     * series).
     */
    async setSeriesProgress(
        params: {
            userId: UserId;
            seriesId: string;
        } & ({ throughEpisodeId: string } | { watchedIds: string[]; unwatchedIds: string[] }),
        outerSql?: postgres.Sql,
    ): Promise<{ markedWatched: number; markedUnwatched: number }> {
        const sql = outerSql ?? (await this.getSql());
        if (!sql) throw new Error('Database unavailable');

        const episodes = await getSeriesEpisodesWithOrderAndState(
            sql,
            params.seriesId,
            params.userId,
        );
        if (episodes.length === 0) {
            return { markedWatched: 0, markedUnwatched: 0 };
        }
        const epById = new Map(episodes.map((e) => [e.id, e]));

        // Resolve the user's "desired final state" per-episode: a Map
        // from episode id → boolean (true=watched). Both modes converge
        // on this representation so the delta + final-tally logic below
        // stays mode-agnostic.
        const finalWatched = new Map<string, boolean>();

        if ('throughEpisodeId' in params) {
            const through = epById.get(params.throughEpisodeId);
            if (!through) {
                throw new Error(
                    'Through-episode does not belong to this series (or is unmapped in the active ordering)',
                );
            }
            // Reject specials as through-anchors. effective_order for
            // S00E* falls below EPISODE_ORDER_MULTIPLIER (10000) — anchoring
            // there would mark every real-season episode unwatched, which
            // is never the user's intent for "I'm at this episode".
            if (through.effective_order < EPISODE_ORDER_MULTIPLIER) {
                throw new Error(
                    'Through-episode cannot be a special — pick a numbered season episode',
                );
            }
            const throughOrder = through.effective_order;
            for (const ep of episodes) {
                finalWatched.set(ep.id, ep.effective_order <= throughOrder);
            }
        } else {
            // Reject foreign / typo'd UUIDs explicitly so the caller learns
            // about the mismatch instead of seeing a silent zero-delta save.
            const seen = new Set<string>();
            const unknown: string[] = [];
            for (const id of params.watchedIds) {
                seen.add(id);
                if (!epById.has(id)) unknown.push(id);
            }
            for (const id of params.unwatchedIds) {
                if (!seen.has(id) && !epById.has(id)) unknown.push(id);
            }
            if (unknown.length > 0) {
                throw new Error(`Episode(s) not in this series: ${unknown.join(', ')}`);
            }
            // Start from current state, then overlay explicit toggles.
            // Episodes the user didn't touch keep their current state —
            // per-episode mode is a partial edit, not a wipe.
            for (const ep of episodes) {
                finalWatched.set(ep.id, ep.is_watched);
            }
            for (const id of params.watchedIds) {
                finalWatched.set(id, true);
            }
            for (const id of params.unwatchedIds) {
                finalWatched.set(id, false);
            }
        }

        // Delta: only episodes whose state actually changes. Skipping
        // unchanged rows avoids the lwa-bump → NextUp-anchor-scramble
        // failure mode called out above.
        const toWatch: string[] = [];
        const toUnwatch: string[] = [];
        for (const ep of episodes) {
            const desired = finalWatched.get(ep.id);
            if (desired === ep.is_watched) continue;
            if (desired) toWatch.push(ep.id);
            else toUnwatch.push(ep.id);
        }

        // Final tally drives the series-level event.
        let totalWatched = 0;
        for (const v of finalWatched.values()) if (v) totalWatched += 1;
        const seriesFullyWatched = totalWatched === episodes.length;

        if (toWatch.length === 0 && toUnwatch.length === 0) {
            // No episode-level changes. Check whether the series-level
            // row's `is_watched` still matches the desired final tally —
            // legacy saves (pre-conditional-series-event) can leave the
            // series row stuck on `is_watched=true` even when episodes
            // are partially unwatched. Emit a corrective series-level
            // event in that case so the modal badge can self-heal;
            // otherwise return clean (no churn).
            const seriesRow = await getUserWatchState.one(sql, {
                userId: params.userId,
                mediaId: params.seriesId,
            });
            const seriesIsWatched = seriesRow?.is_watched ?? false;
            if (seriesIsWatched === seriesFullyWatched) {
                return { markedWatched: 0, markedUnwatched: 0 };
            }
            const now = new Date().toISOString();
            await appendEventAndRebuild(sql, {
                user_id: params.userId,
                media_id: params.seriesId,
                event_type: seriesFullyWatched ? 'mark_watched' : 'mark_unwatched',
                source: 'lumastra-user-mark',
                position_ms: null,
                runtime_ms: null,
                source_event_id: null,
                session_id: null,
                event_seq: null,
                occurred_at: now,
            });
            await invalidateAllWatchedCaches(params.userId).catch((e) =>
                logger.warn('Failed to invalidate watched caches', e as Error),
            );
            return { markedWatched: 0, markedUnwatched: 0 };
        }

        const now = new Date().toISOString();
        await withTx(sql, async (rawTx) => {
            const tx = rawTx as unknown as postgres.Sql;
            // Series-level state mirrors the final per-episode tally so
            // the modal badge ("✓ Watched") stops claiming a series is
            // done when episodes are still unwatched. Always emit (even
            // if it doesn't change) — the rebuilder is idempotent and
            // this keeps the contract explicit on every save.
            await appendEventAndRebuild(tx, {
                user_id: params.userId,
                media_id: params.seriesId,
                event_type: seriesFullyWatched ? 'mark_watched' : 'mark_unwatched',
                source: 'lumastra-user-mark',
                position_ms: null,
                runtime_ms: null,
                source_event_id: null,
                session_id: null,
                event_seq: null,
                occurred_at: now,
            });
            for (const id of toWatch) {
                await appendEventAndRebuild(tx, {
                    user_id: params.userId,
                    media_id: id,
                    event_type: 'mark_watched',
                    source: 'lumastra-user-mark',
                    position_ms: null,
                    runtime_ms: null,
                    source_event_id: null,
                    session_id: null,
                    event_seq: null,
                    occurred_at: now,
                });
            }
            for (const id of toUnwatch) {
                await appendEventAndRebuild(tx, {
                    user_id: params.userId,
                    media_id: id,
                    event_type: 'mark_unwatched',
                    source: 'lumastra-user-mark',
                    position_ms: null,
                    runtime_ms: null,
                    source_event_id: null,
                    session_id: null,
                    event_seq: null,
                    occurred_at: now,
                });
            }
        });

        await invalidateAllWatchedCaches(params.userId).catch((e) =>
            logger.warn('Failed to invalidate watched caches', e as Error),
        );

        watchStateEvents.emit(params.userId, {
            type: 'watch_state_set_changed',
            mediaId: '*',
            reason: 'set_series_progress',
        });

        return {
            markedWatched: toWatch.length,
            markedUnwatched: toUnwatch.length,
        };
    }

    // === Read operations ===

    async getWatchState(userId: UserId, mediaId: string): Promise<WatchStateRow | null> {
        const sql = await this.getSql();
        if (!sql) return null;

        const { getMediaType, isMusicMediaType } =
            await import('$lib/server/database/queries/media-type-cache.queries.js');
        const mediaType = await getMediaType(sql, mediaId);
        if (isMusicMediaType(mediaType)) {
            logger.debug(
                'watchManager.getWatchState called with music track — returning null. ' +
                    'Use MusicInteractionManager for music watch state.',
                { mediaId, userId },
            );
            return null;
        }

        const result = await getUserWatchState.one(sql, {
            userId,
            mediaId,
        });
        return result ?? null;
    }

    async batchGetWatchStates(
        userId: UserId,
        mediaIds: string[],
    ): Promise<Map<string, WatchStateRow>> {
        if (mediaIds.length === 0) return new Map();

        const sql = await this.getSql();
        if (!sql) return new Map();

        const rows = await batchGetUserWatchStates.all(sql, {
            userId,
            mediaIds,
        });
        const map = new Map<string, WatchStateRow>();
        for (const row of rows) {
            map.set(row.media_id, row);
        }
        return map;
    }

    /**
     * @param collapsePerSeries Collapse to one row per series inside the query,
     * before its LIMIT. Callers that apply an access boundary to the result
     * must pass false — see the param docs on getContinueWatchingFromDb for
     * why a post-collapse access filter can drop a whole series.
     */
    async getContinueWatching(
        userId: UserId,
        limit: number,
        collapsePerSeries = true,
    ): Promise<ContinueWatchingRow[]> {
        const sql = await this.getSql();
        if (!sql) return [];

        // Short-TTL, single-flight result cache. The home render reads CW
        // several times per load; this collapses the concurrent burst to one
        // DB query and shares it across loads within the TTL. Keyed per user
        // (the value is that user's own rows — no cross-user sharing), per
        // limit, and per collapse mode — the two modes return DIFFERENT row
        // shapes (collapsed vs per-episode), so they must never share an entry.
        // Invalidated on every explicit watch mutation; see the
        // continueWatchingRows namespace doc for the staleness reasoning.
        const rows = await this.readWatchingRowsCached(
            collapsePerSeries ? 'cw' : 'cw-uncollapsed',
            userId,
            limit,
            () =>
                getContinueWatchingFromDb.all(sql, {
                    userId,
                    limit,
                    minMs: config.CONTINUE_WATCHING_MIN_SECONDS * 1000,
                    minPercent: config.CONTINUE_WATCHING_MIN_PERCENT,
                    maxAgeDays: config.CONTINUE_WATCHING_MAX_AGE_DAYS,
                    collapsePerSeries,
                }),
        );
        return rows;
    }

    async getNextUp(userId: UserId, limit: number): Promise<NextUpRow[]> {
        const sql = await this.getSql();
        if (!sql) return [];

        // See getContinueWatching for the caching contract.
        const rows = await this.readWatchingRowsCached('nu', userId, limit, () =>
            getNextUpFromDb.all(sql, {
                userId,
                limit,
                // Symmetric with CW: a series the user hasn't touched in N days
                // shouldn't keep surfacing as "next up" forever after a single
                // migration-imported watched episode.
                maxAgeDays: config.NEXT_UP_MAX_AGE_DAYS,
            }),
        );
        return rows;
    }

    /**
     * Shared read-through cache for the durable CW/NU row lists, using the
     * existing single-flight helper so a burst of concurrent misses (the home
     * load fans CW/NU out ~5x) runs the underlying query exactly once.
     *
     * Cache key is `<kind>:v3:<limit>`, user-scoped via UnifiedCache so the L2
     * key is `<ns>:<userId>:<kind>:v3:<limit>` — which the per-user pattern
     * delete in invalidateContinueWatchingCache() matches. The single-flight
     * raw key is built to line up with buildL2Key(key, userId).
     *
     * The value round-trips through JSON (same pattern as the trending /
     * binge-worthy strategies). Row consumers already treat date/number fields
     * as string|Date-tolerant. Version 2 invalidates pre-availability rows that
     * lacked has_files and used provider IDs as eligibility evidence.
     */
    private async readWatchingRowsCached<T>(
        kind: 'cw' | 'cw-uncollapsed' | 'nu',
        userId: UserId,
        limit: number,
        compute: () => Promise<T[]>,
    ): Promise<T[]> {
        const ns = CACHE_NAMESPACES.continueWatchingRows;
        const cache = cacheManager.for(ns);
        const key = `${kind}:v3:${limit}`;

        const cached = await cache.get<T[]>(key, userId);
        if (cached !== null) return cached;

        const rawValkeyKey = `${ns.name}:${userId}:${key}`;
        const ttlSeconds = Math.floor(ns.l2TTL / 1000);
        const json = await getOrComputeSingleFlight({
            cacheKey: rawValkeyKey,
            ttlSeconds,
            compute: async () => JSON.stringify(await compute()),
        });

        let rows: T[];
        try {
            rows = JSON.parse(json) as T[];
        } catch {
            rows = [];
        }

        // Populate L1 so subsequent in-process reads skip Valkey.
        void cache.set(key, rows, undefined, userId);
        return rows;
    }

    async getNextUpForSeries(
        seriesId: string,
        userId: UserId,
    ): Promise<{
        media_id: string;
        title: string;
        season_number: number;
        episode_number: number;
        overview: string | null;
        runtime_seconds: number | null;
        premiere_date: string | null;
    } | null> {
        const sql = await this.getSql();
        if (!sql) return null;

        return (
            getNextUpForSeriesFromDb.one(sql, {
                seriesMediaId: seriesId,
                userId,
            }) ?? null
        );
    }

    async getFirstEpisode(seriesId: string): Promise<{
        media_id: string;
        title: string;
        season_number: number;
        episode_number: number;
        overview: string | null;
        runtime_seconds: number | null;
        premiere_date: string | null;
    } | null> {
        const sql = await this.getSql();
        if (!sql) return null;

        return getFirstEpisodeForSeries.one(sql, { seriesMediaId: seriesId }) ?? null;
    }

    async getNextUpForSeason(
        seasonId: string,
        userId: UserId,
    ): Promise<{
        media_id: string;
        title: string;
        season_number: number;
        episode_number: number;
        overview: string | null;
        runtime_seconds: number | null;
        premiere_date: string | null;
    } | null> {
        const sql = await this.getSql();
        if (!sql) return null;

        return (
            getNextUpForSeasonFromDb.one(sql, {
                seasonMediaId: seasonId,
                userId,
            }) ?? null
        );
    }

    async getFirstEpisodeForSeason(seasonId: string): Promise<{
        media_id: string;
        title: string;
        season_number: number;
        episode_number: number;
        overview: string | null;
        runtime_seconds: number | null;
        premiere_date: string | null;
    } | null> {
        const sql = await this.getSql();
        if (!sql) return null;

        return getFirstEpisodeForSeason.one(sql, { seasonMediaId: seasonId }) ?? null;
    }

    async getSeriesProgress(
        userId: UserId,
        seriesMediaId: string,
    ): Promise<Awaited<ReturnType<typeof computeSeriesProgress>>> {
        const sql = await this.getSql();
        if (!sql) return null;

        return computeSeriesProgress(sql, userId, seriesMediaId);
    }

    async getWatchedTmdbIds(
        userId: UserId,
    ): Promise<Array<{ tmdb_id: number; media_type: string }>> {
        const sql = await this.getSql();
        if (!sql) return [];

        return getWatchedTmdbIdsFromDb(sql, userId);
    }

    async getWatchedMediaIds(userId: UserId): Promise<string[]> {
        const sql = await this.getSql();
        if (!sql) return [];

        return getWatchedMediaUuidsFromDb(sql, userId);
    }

    /**
     * Cached + single-flight version of {@link getWatchedMediaIds}.
     *
     * Concurrent callers within one /feed request all share a single DB query
     * on a cold-cache miss. The result is stored in the `watchedIds` namespace
     * under a distinct `uuids:v1:${userId}` key (not the composite-key
     * WatchedItem[] key used by TMDB-id filtering) and is invalidated by
     * `invalidateWatchedCache` on every watch mutation.
     */
    async getWatchedMediaIdsCached(userId: UserId): Promise<string[]> {
        const uuidsCacheKey = getWatchedUuidsCacheKey(userId);

        // L1 fast-path via UnifiedCache (avoids Valkey round-trip on warm hits).
        const cached = await watchedCache.get<string[]>(uuidsCacheKey);
        if (cached !== null) return cached;

        // L2 miss — collapse concurrent callers to a single DB query.
        // The raw Valkey key mirrors what UnifiedCache.buildL2Key would produce
        // for the `watchedIds` namespace (`watched-ids`) with no userId suffix
        // (userId is already encoded in the uuidsCacheKey string itself).
        const rawValkeyKey = `${CACHE_NAMESPACES.watchedIds.name}:${uuidsCacheKey}`;
        const ttlSeconds = Math.floor(CACHE_NAMESPACES.watchedIds.l2TTL / 1000);

        const json = await getOrComputeSingleFlight({
            cacheKey: rawValkeyKey,
            ttlSeconds,
            compute: async () => {
                const sql = await this.getSql();
                const ids = sql ? await getWatchedMediaUuidsFromDb(sql, userId) : [];
                return JSON.stringify(ids);
            },
        });

        let ids: string[];
        try {
            ids = JSON.parse(json) as string[];
        } catch {
            ids = [];
        }

        // Populate L1 so subsequent calls within this process skip Valkey.
        void watchedCache.set(uuidsCacheKey, ids);

        return ids;
    }

    // === Jellyfin sync ===

    /**
     * Sync watch state from Jellyfin.
     * Uses special upsert logic that only overwrites existing watch state
     * if it was previously synced from Jellyfin or has never been modified locally.
     */
    async syncFromJellyfin(params: {
        userId: UserId;
        watchedItems: Array<{
            mediaId: string;
            isWatched: boolean;
            resumePositionTicks: number;
            runtimeTicks: number;
            playCount: number;
        }>;
    }): Promise<void> {
        if (params.watchedItems.length === 0) return;

        const sql = await this.getSql();
        if (!sql) throw new Error('Database unavailable');

        // Cap per-item diagnostic logs per batch — an initial post-deploy
        // sync can auto-complete hundreds of historical rows, which would
        // drown out real signals. Total still reported in the summary log.
        const AUTOCOMPLETE_LOG_LIMIT = 10;
        let autoCompleteCount = 0;
        const validItems = params.watchedItems
            .filter((item) => UUID_RE.test(item.mediaId))
            .map((item) => {
                const raw = {
                    mediaId: item.mediaId,
                    isWatched: item.isWatched,
                    resumePositionMs: ticksToMs(item.resumePositionTicks),
                    runtimeMs: ticksToMs(item.runtimeTicks),
                    watchCount: item.playCount,
                };
                // mediaType is omitted deliberately: this batch arrives from
                // JELLYFIN (hence ticks), which serves no audiobooks — they come
                // from AudiobookShelf down a different path. Without it
                // completionThresholdFor() falls to the runtime tier ladder,
                // which is correct for film and episode and WRONG for a book:
                // the ladder tops out at 150 minutes, so a 21-hour audiobook
                // would be auto-completed with ~45 minutes left (see
                // AUDIOBOOK_FINISH_REMAINING_MS). If this path ever grows a
                // source that can carry audiobooks, pass the media type here —
                // the argument is optional, so the mistake is silent.
                const result = applyAutoCompleteFromProgress(raw);
                if (result.triggered) {
                    autoCompleteCount++;
                    if (autoCompleteCount <= AUTOCOMPLETE_LOG_LIMIT) {
                        // Diagnostic log for Infuse→Jellyfin sync-gap investigation.
                        logger.info('Jellyfin sync: auto-completing stale resume', {
                            userId: params.userId,
                            mediaId: item.mediaId,
                            jellyfinIsWatched: item.isWatched,
                            resumeMs: raw.resumePositionMs,
                            runtimeMs: raw.runtimeMs,
                            ratio: result.ratio,
                            threshold: result.threshold,
                        });
                    }
                }
                return result.item;
            });
        if (validItems.length === 0) return;
        if (validItems.length < params.watchedItems.length) {
            logger.warn('syncFromJellyfin: filtered invalid UUIDs from batch', {
                userId: params.userId,
                originalCount: params.watchedItems.length,
                validCount: validItems.length,
            });
        }
        if (autoCompleteCount > 0) {
            logger.info('syncFromJellyfin: auto-completed batch items', {
                userId: params.userId,
                autoCompleteCount,
                batchSize: validItems.length,
            });
        }

        const now = new Date().toISOString();
        await withTx(sql, async (rawTxSql) => {
            // postgres.js TransactionSql is structurally compatible with
            // postgres.Sql but TS doesn't know it. Cast once per convention.
            const txSql = rawTxSql as unknown as postgres.Sql;
            for (const item of validItems) {
                if (item.isWatched) {
                    await appendEventAndRebuild(txSql, {
                        user_id: params.userId,
                        media_id: item.mediaId,
                        event_type: 'mark_watched',
                        source: 'jellyfin-sync',
                        position_ms: null,
                        runtime_ms: item.runtimeMs > 0 ? item.runtimeMs : null,
                        source_event_id: `mark_watched:${now}`,
                        session_id: null,
                        event_seq: null,
                        occurred_at: now,
                    });
                } else if (item.resumePositionMs > 0) {
                    await appendEventAndRebuild(txSql, {
                        user_id: params.userId,
                        media_id: item.mediaId,
                        event_type: 'progress',
                        source: 'jellyfin-sync',
                        position_ms: item.resumePositionMs,
                        runtime_ms: item.runtimeMs > 0 ? item.runtimeMs : null,
                        source_event_id: null,
                        session_id: null,
                        event_seq: null,
                        occurred_at: now,
                    });
                }
                // else: nothing to record — not watched and no resume position
            }
        });

        await invalidateAllWatchedCaches(params.userId).catch((e) =>
            logger.warn('Failed to invalidate watched caches after Jellyfin sync', e as Error),
        );

        watchStateEvents.emit(params.userId, {
            type: 'watch_state_set_changed',
            mediaId: '*',
            reason: 'jellyfin_sync',
        });
    }

    // === Local-first reads (unique to former WatchStateService) ===

    /**
     * Get watched series names and episode keys from local DB.
     * Used by upcoming/new-episodes routes for filtering.
     */
    async getWatchedSeriesAndEpisodes(
        userId: UserId,
        access: {
            deniedGroupIds: string[] | null;
            ageRating: AgeRatingFilterParams | null;
        },
    ): Promise<{
        seriesNames: string[];
        episodeKeys: Set<string>;
    }> {
        const sql = await this.getSql();
        if (!sql) return { seriesNames: [], episodeKeys: new Set() };

        const [seriesRows, episodeRows] = await Promise.all([
            getWatchedSeriesFromDb.all(sql, {
                userId,
                deniedGroupIds: access.deniedGroupIds,
                ageRating: access.ageRating,
            }),
            getWatchedEpisodeKeys.all(sql, { userId }),
        ]);

        const seriesNames = seriesRows.map((r) => r.series_name);
        const episodeKeys = new Set<string>();
        for (const row of episodeRows) {
            episodeKeys.add(`${row.series_name}|S${row.season_number}E${row.episode_number}`);
        }

        return { seriesNames, episodeKeys };
    }

    /**
     * Get watched status for a batch of TMDB composite keys.
     * Used by the search route (per-request, across its parallel group fan-out)
     * to mark items as watched.
     *
     * Backed by the shared per-user watched-id cache (same cache /api/watched
     * populates; invalidated on every watch mutation via invalidateAllWatchedCaches).
     * This avoids a per-request DB round-trip on the search hot path — previously
     * every search group request issued its own getWatchedStatusBatchFromDb query,
     * even on a fully cached search.
     */
    async getWatchedStatusBatch(params: {
        userId: UserId;
        items: Array<{ tmdbId: number; mediaType: ExternalIdMediaType }>;
    }): Promise<Map<string, boolean>> {
        const result = new Map<string, boolean>();
        if (params.items.length === 0) return result;

        const watchedSet = await this.getWatchedExternalIdSetCached(params.userId);
        for (const item of params.items) {
            result.set(
                `${item.tmdbId}:${item.mediaType}`,
                watchedSet.has(item.tmdbId, item.mediaType),
            );
        }
        return result;
    }

    /**
     * Per-user watched composite-key set, read from the shared watched-id cache
     * with populate-on-miss. Populates using the SAME query + shape /api/watched
     * uses (incl. internal_id) so neither path degrades the other's cache entry.
     *
     * That shared entry is why the access boundary below must stay identical to
     * the one in the /api/watched handler: the two writers share one cache key
     * (`getWatchedCacheKey(userId)`, user UUID only, no access component), so a
     * boundary that differed between them would let whichever path ran first
     * decide what the other sees.
     */
    private async getWatchedExternalIdSetCached(userId: UserId): Promise<ExternalIdSet> {
        const cached = await getCachedWatchedIds(userId);
        if (!cached) {
            const sql = await this.getSql();
            if (sql) {
                const watched = await getWatchedItems.all(sql, {
                    userId,
                    // Explicitly unrestricted — must match /api/watched exactly.
                    access: unrestrictedAccess(),
                });
                await setCachedWatchedIds(
                    userId,
                    watched.map((w) => ({
                        internal_id: w.internal_id ?? null,
                        tmdb_id: w.tmdb_id,
                        media_type: w.media_type,
                    })),
                );
            }
        }
        return getWatchedExternalIdSet(userId);
    }

    // === Background refresh ===

    /**
     * Trigger a throttled background refresh of watch state from Jellyfin.
     * Uses cache namespace as a per-user throttle (30s cooldown).
     * The actual refresh happens asynchronously — caller doesn't wait.
     */
    async triggerBackgroundRefresh(params: {
        userId: UserId;
        scope: string;
        refreshFn: () => Promise<void>;
    }): Promise<void> {
        const cache = cacheManager.for(CACHE_NAMESPACES.watchStateRefresh);
        const key = `${params.userId}:${params.scope}`;

        const existing = await cache.get<string>(key);
        if (existing) {
            logger.debug('Background refresh throttled', {
                userId: params.userId,
                scope: params.scope,
            });
            return;
        }

        // Set throttle key before starting refresh
        await cache.set(key, '1');

        // Fire-and-forget
        params
            .refreshFn()
            .catch((err) =>
                logger.warn(
                    'Background watch state refresh failed',
                    { userId: params.userId, scope: params.scope },
                    err as Error,
                ),
            );
    }
}

export const watchManager = new WatchManager();
