// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/watch-state/[id].ts
 *
 *   GET /api/v1/watch-state/{id}  — unified read: watched+positionMs+favorite+rating
 *   PATCH /api/v1/watch-state/{id}  — partial write: watched? + favorite?
 *   (ratings are written through /media/{id}/rating)
 *
 * PATCH semantics: Presence-preserving partial update. Fields omitted from the body are
 * left unchanged. Send { favorite: null } to clear the favorite flag.
 *
 * Implementation note: favorite is backed by user_media_state.is_favorite
 * (migration 16.103.0).
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/watch-state/[id]/`
 * `+server.ts` (`requireAuth(withErrorHandler(withIdResolution([withValidation])))`).
 * Behaviour preserved BYTE-FOR-BYTE:
 *   - Auth: `{kind:'user'}` (from `requireAuth`) → mount()'s enforce() runs the
 *     SAME `locals.principal?.username ?? locals.user?.username` check. The
 *     `requireAuth` wrapper is dropped since mount() now performs the exact
 *     same gate before the handler runs; `withIdResolution` (and, for PATCH,
 *     `withValidation`) stay IN-HANDLER unchanged since they are not simple
 *     auth-kind decisions.
 *   - PATCH body validation stays IN-HANDLER via the ORIGINAL `withValidation()`
 *     call (reused directly) — preserves the exact 422 wire contract instead
 *     of mount()'s declarative `request.body` slot.
 *   - `withErrorHandler` is dropped: mount()'s own error wrapper provides the
 *     equivalent problem+json 500 fallback for uncaught throws (established
 *     Phase 3 precedent).
 *
 * HAND-MOUNTED from the bespoke v1 `+server.ts` (GET + PATCH). GET and PATCH are also
 * hand-mounted on the internal surface (`src/routes/api/watch-state/[id]/`).
 */

import { parseVirtualSeasonHandle } from '$lib/server/services/media-handle.js';
import { getSeriesOrdering } from '$lib/server/database/queries/season-detail.queries.js';
import { getSeriesEpisodesWithWatchState } from '$lib/server/database/queries/episode-detail.queries.js';
import { watchManager } from '$lib/server/services/watch-manager.service.js';
import { isEffectivelyWatched } from '$lib/server/utils/watch-constants.js';
import type { UserContext } from '$lib/server/types.js';
import type { UserId } from '$lib/shared/user-id.js';

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { problem } from '$lib/server/api/problem.js';
import { withValidation } from '$lib/server/middleware/validate.js';
import { withIdResolution } from '$lib/server/middleware/id-resolution.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    WatchStateResponseSchema,
    WatchStateUpdateSchema,
} from '$lib/schemas/api-playback-responses';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getUserWatchState } from '$lib/server/database/queries/watch-state.queries.js';
import { setUserMediaFavorite } from '$lib/server/database/queries/watch-state.queries.js';
import { getUserRating } from '$lib/server/database/queries/user-ratings.queries.js';
import {
    readWatchedStatus,
    markWatchedOp,
    markUnwatchedOp,
} from '$lib/server/services/watched-state-ops.js';

/** Validate every target before fan-out: a series gate alone does not authorize its episodes. */
async function virtualSeasonState(
    handle: string,
    userId: UserId,
    user: UserContext | undefined,
    watched?: boolean,
): Promise<Response> {
    const sql = await aiDbService.getSql();
    if (!sql) return problem('dependency_unavailable', { error: 'Database unavailable' });
    const season = parseVirtualSeasonHandle(handle);
    if (
        !season ||
        season.ordering === 'standard' ||
        (await getSeriesOrdering(sql, season.seriesUuid)) !== season.ordering ||
        !(await checkMediaAccess(sql, season.seriesUuid, user))
    )
        return problem('not_found');
    const episodes = await getSeriesEpisodesWithWatchState(
        sql,
        season.seriesUuid,
        userId,
        season.seasonNumber,
    );
    if (!episodes.length) return problem('not_found');
    for (const ep of episodes)
        if (!(await checkMediaAccess(sql, ep.id, user))) return problem('not_found');
    if (watched !== undefined) {
        if (watched) await watchManager.markWatched({ userId, mediaId: handle });
        else await watchManager.markUnwatched({ userId, mediaId: handle });
    }
    return json({
        mediaId: handle,
        watched:
            watched ??
            episodes.every((ep) =>
                isEffectivelyWatched({ ...ep, is_watched: ep.is_watched ?? false }),
            ),
        positionMs: 0,
        resumeAnchor: null,
        watchCount: 0,
        lastWatchedAt: null,
        lastEventAt: null,
        favorite: false,
        rating: null,
    });
}

export const def = defineEndpoint({
    auth: { kind: 'user' },
    docs: {
        GET: {
            tags: ['Media'],
            summary: 'Get watch state for a media item',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: WatchStateResponseSchema,
                    description: 'Unified watch state (watched, position, favorite, rating)',
                },
                401: 'Authentication required',
                404: 'Media not found',
                500: 'Internal server error',
            },
        },
        PATCH: {
            tags: ['Media'],
            summary: 'Update watch state for a media item',
            description:
                'Virtual season handles mark exactly the logical season episodes; only watched is supported for virtual seasons. Presence-preserving partial update: send either of `watched`, `favorite` (omit to ' +
                'leave unchanged; `favorite` false/null removes). To rate a title use `PUT /media/{id}/rating`. `position` ' +
                'cannot be SET here, but toggling `watched` does move it: marking watched, or ' +
                'marking unwatched on anything other than an audiobook, resets the resume point ' +
                'to 0. Audiobooks are the exception — `watched: false` preserves the listening ' +
                'position, because recovering it is the only reason to un-finish a book. ' +
                'During live playback the position is set by the play-session beacons. ' +
                'To write a position AFTER the fact — a resume flushed from offline listening, or ' +
                'any other bookkeeping write with no live playback behind it — use ' +
                '`POST /offline-playback-sessions`: it is batched, idempotent, arbitrates by real ' +
                'occurrence time, and fans out server-side to whichever store actually owns the ' +
                "resume point for that media type (an audiobook's lives in AudiobookShelf, not in " +
                'this resource). Never open a play session purely as a vehicle for a position ' +
                'write — a session consumes a concurrent-stream slot and supersedes paused ' +
                'sessions on the same item, neither of which a position write should cause.',
            stability: 'stable',
            auth: 'bearer',
            body: WatchStateUpdateSchema,
            responses: {
                200: {
                    schema: WatchStateResponseSchema,
                    description: 'Updated watch state',
                },
                401: 'Authentication required',
                404: 'Media not found',
                422: 'Validation failed',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        // ── GET ───────────────────────────────────────────────────────────
        GET: withIdResolution(async ({ params, locals }) => {
            const userId = locals.user?.userId;
            if (!userId) return problem('unauthorized');

            const mediaId = locals.resolvedIds?.internalId ?? params.id;
            if (!mediaId) return problem('not_found', { error: 'Media not found' });
            if (mediaId.startsWith('vseason:'))
                return virtualSeasonState(mediaId, userId, locals.user);

            const sql = await aiDbService.getSql();
            if (!sql) return problem('dependency_unavailable', { error: 'Database unavailable' });

            // Music-aware + access-gated watched read (shared with /api/watched).
            // Returns `denied` for media the caller cannot access — surfaced as
            // 404 to avoid leaking existence of restricted UUIDs.
            const watchedResult = await readWatchedStatus(userId, mediaId, locals.user);
            if (watchedResult.kind === 'denied') {
                return problem('not_found', { error: 'Media not found' });
            }

            // Parallel fetches (resume position / rating live in their own tables)
            const [stateRow, ratingRow] = await Promise.all([
                getUserWatchState.one(sql, { userId, mediaId }).catch(() => null),
                getUserRating.one(sql, { userId, mediaId }).catch(() => null),
            ]);

            // Derive resumeAnchor: fraction 0–1 for client seek UI
            const positionMs = stateRow?.resume_position_ms ?? 0;
            const runtimeMs = stateRow?.runtime_ms ?? null;
            const resumeAnchor =
                runtimeMs && runtimeMs > 0 ? Math.min(1, positionMs / runtimeMs) : null;

            return json({
                mediaId,
                watched: watchedResult.watched,
                positionMs,
                resumeAnchor,
                watchCount: stateRow?.watch_count ?? 0,
                lastWatchedAt: stateRow?.last_watched_at ?? null,
                lastEventAt: stateRow?.last_event_at ?? null,
                favorite: stateRow?.is_favorite ?? false,
                rating: ratingRow?.rating ?? null,
            });
        }),

        // ── PATCH ───────────────────────────────────────────────────────────
        PATCH: withIdResolution(
            withValidation(
                async ({ validated, params, locals }) => {
                    const userId = locals.user?.userId;
                    if (!userId) return problem('unauthorized');

                    const mediaId = locals.resolvedIds?.internalId ?? params.id;
                    if (!mediaId) return problem('not_found', { error: 'Media not found' });

                    const sql = await aiDbService.getSql();
                    if (!sql) {
                        return problem('dependency_unavailable', { error: 'Database unavailable' });
                    }

                    const { watched, favorite } = validated.body;
                    if (mediaId.startsWith('vseason:')) {
                        if (watched === undefined || favorite !== undefined) {
                            return problem('validation_failed', {
                                error: 'Virtual seasons support watched updates only',
                            });
                        }
                        return virtualSeasonState(mediaId, userId, locals.user, watched);
                    }

                    // Nothing to update
                    if (watched === undefined && favorite === undefined) {
                        return problem('validation_failed', {
                            error: 'At least one of watched or favorite must be provided',
                        });
                    }

                    // ── watched ─────────────────────────────────────────────
                    // Access is checked BEFORE anything is written, for every
                    // field this request touches. It used to be implicit in
                    // running the watched op first — but that op also COMMITS,
                    // which is the problem below.
                    if (watched !== undefined || favorite !== undefined) {
                        const accessible = await checkMediaAccess(sql, mediaId, locals.user);
                        if (!accessible) {
                            return problem('not_found', { error: 'Media not found' });
                        }
                    }

                    // ── favorite ──────────────────────────────────────────────
                    if (favorite !== undefined) {
                        await withTx(sql, async (tx) => {
                            await setUserMediaFavorite(tx, userId, mediaId, favorite ?? false);
                        });
                    }

                    // Watched LAST, and the order is the fix.
                    //
                    // This op commits on its own (appendEventAndRebuild has its
                    // own transaction), so running it first meant a throw in the
                    // favorite block above left it already committed — and
                    // the client's retry of the whole PATCH appended a SECOND
                    // mark_watched event, inflating watch_count. Nothing dedupes
                    // those: they carry no source_event_id.
                    //
                    // Reversed, a failure can only ever leave the favorite write
                    // done, and it is idempotent (a set), so the retry is clean.
                    // Access is gated above for both orders.
                    if (watched !== undefined) {
                        const watchedResult = watched
                            ? await markWatchedOp(userId, mediaId, locals.user)
                            : await markUnwatchedOp(userId, mediaId, locals.user);
                        if (watchedResult.kind === 'denied') {
                            return problem('not_found', { error: 'Media not found' });
                        }
                    }

                    // Re-read updated state to return consistent response. The
                    // `watched` boolean comes from the music-aware shared read
                    // (music tracks have no user_media_state row, so is_watched
                    // would falsely report false after a successful mark).
                    const [watchedResult, stateRow, ratingRow] = await Promise.all([
                        readWatchedStatus(userId, mediaId, locals.user).catch(() => null),
                        getUserWatchState.one(sql, { userId, mediaId }).catch(() => null),
                        getUserRating.one(sql, { userId, mediaId }).catch(() => null),
                    ]);

                    const positionMs = stateRow?.resume_position_ms ?? 0;
                    const runtimeMs = stateRow?.runtime_ms ?? null;
                    const resumeAnchor =
                        runtimeMs && runtimeMs > 0 ? Math.min(1, positionMs / runtimeMs) : null;

                    return json({
                        mediaId,
                        watched:
                            watchedResult?.kind === 'ok'
                                ? watchedResult.watched
                                : (stateRow?.is_watched ?? false),
                        positionMs,
                        resumeAnchor,
                        watchCount: stateRow?.watch_count ?? 0,
                        lastWatchedAt: stateRow?.last_watched_at ?? null,
                        lastEventAt: stateRow?.last_event_at ?? null,
                        favorite: stateRow?.is_favorite ?? false,
                        rating: ratingRow?.rating ?? null,
                    });
                },
                { body: WatchStateUpdateSchema },
            ),
        ),
    },
});
