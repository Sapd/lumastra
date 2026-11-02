// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// gen-api-routes: skip — authored ahead of route migration; the live route is a
// bespoke/legacy handler at a non-convention path (not generator-mounted). See
// scripts/gen-api-routes.ts (hasSkipDirective).

/**
 * defs/catalog/media-id-rating.ts — `media/{id}/rating`.
 *
 * GET  /media/{id}/rating  → { rating: number|null, ratingStyle?: 'quick'|'stars', canRate: boolean }
 * PUT  /media/{id}/rating  → { rating: number|null } (0 = remove)
 * DELETE /media/{id}/rating → 204, clears the rating (music: the track feedback)
 *
 * Auth:
 *   GET  — user (any authenticated caller; returns null if no rating found)
 *   PUT  — user (same; writes the rating for the authenticated user)
 *   DELETE — user (same; the caller's own rating)
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { RatingBody } from './media-id-rating.schemas.js';
import { MediaRatingResponseSchema } from '$lib/schemas/api-content-responses.js';
import { json } from '@sveltejs/kit';
import { withIdResolution } from '$lib/server/middleware/id-resolution.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import {
    getMediaType,
    isMusicMediaType,
} from '$lib/server/database/queries/media-type-cache.queries.js';
import { clearTrackFeedback } from '$lib/server/database/queries/music-interactions.queries.js';
import { deleteUserRating } from '$lib/server/database/queries/user-ratings.queries.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { RequestEvent } from '@sveltejs/kit';

// ---------------------------------------------------------------------------
// Request contract
// ---------------------------------------------------------------------------
// RatingBody is imported from ./media-id-rating.schemas — kept in a separate
// lightweight file so the colocated _openapi.ts generator can import the schema
// without pulling in the full runtime dep tree (valkey-glide native binary etc.)

const logger = Logger.for('CatalogMediaRatingDef');

// ---------------------------------------------------------------------------
// Shared resolution helper
// ---------------------------------------------------------------------------

/**
 * Resolve the internal media ID from the request.
 * Prefers locals.resolvedIds (populated by withIdResolution middleware);
 * falls back to the UUID fast-path for direct UUID params.
 */
function resolveInternalId(event: RequestEvent): string | null {
    const fromMiddleware = event.locals.resolvedIds?.internalId;
    if (fromMiddleware) return fromMiddleware;

    const rawId = event.params.id ?? '';
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId);
    return isUuid ? rawId : null;
}

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'user' },

    // OpenAPI docs for the /api/v1/media/{id}/rating (public/native) surface.
    // Migrated verbatim from the retired
    // src/routes/api/v1/media/[id]/rating/_openapi.ts (which added the PUT body
    // on top of the internal GET-only sibling). Bearer auth is documented on
    // both methods → security stays `[bearerAuth]` (byte-identical to prior).
    docs: {
        GET: {
            tags: ['Media'],
            summary: 'Get your rating of a title',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: MediaRatingResponseSchema,
                    description: 'Rating information',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
        PUT: {
            tags: ['Media'],
            summary: 'Set your rating of a title',
            stability: 'stable',
            auth: 'bearer',
            description: "Set the authenticated user's rating for this item (0–10; 0 removes).",
            body: RatingBody,
            responses: {
                200: {
                    schema: MediaRatingResponseSchema,
                    description: 'Updated rating',
                },
                401: 'Authentication required',
                422: 'Validation failed',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['Media'],
            summary: 'Clear your rating of a title',
            description:
                "Deletes the caller's rating. Idempotent: returns 204 whether or not a rating was " +
                'set. For music tracks this also clears `userContext.feedback` in both directions; ' +
                'use DELETE /me/music/tracks/{id}/feedback to clear music feedback directly.',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                204: 'Rating cleared',
                401: 'Authentication required',
                404: 'Media not found',
                500: 'Internal server error',
            },
        },
    },

    request: {
        body: RatingBody,
        bodyMethods: ['PUT'],
    },

    handlers: {
        /**
         * GET /media/{id}/rating
         * Returns the authenticated user's rating for this media item.
         */
        GET: async (event, _ctx) => {
            const userId = event.locals.user?.userId;
            if (!userId) {
                // auth: user already ensures a user is present; this is belt-and-suspenders
                return json({ rating: undefined });
            }

            const internalId = resolveInternalId(event);
            if (!internalId) {
                return ApiProblem.validationFailed([
                    {
                        field: 'id',
                        message:
                            'Composite ID keys require the ID-resolution middleware. ' +
                            'Use an internal UUID or ?externalId=provider:id:type.',
                    },
                ]);
            }

            try {
                const sql = await aiDbService.getSql();
                if (!sql) {
                    return json({ rating: undefined });
                }

                const result = await sql<{ rating: number; rating_style: string | null }[]>`
					SELECT rating, rating_style
					FROM user_ratings
					WHERE user_id = ${userId}::uuid
					  AND media_id = ${internalId}
					LIMIT 1
				`;

                const row = result[0];
                // Validated narrow, not a cast: rating_style is free text at
                // the type level and legacy rows may hold neither value.
                const ratingStyle =
                    row?.rating_style === 'quick' || row?.rating_style === 'stars'
                        ? row.rating_style
                        : undefined;

                return json({
                    rating: row ? row.rating : undefined,
                    ratingStyle,
                    canRate: true,
                });
            } catch (err) {
                logger.error('Failed to get user rating in media/{id}/rating GET', err as Error, {
                    userId,
                    internalId,
                });
                return json({ rating: undefined });
            }
        },

        /**
         * PUT /media/{id}/rating
         * Body: { rating: number }  — 1–10 to set, 0 to remove.
         *
         * Canonical write path for ratings.
         * AI side-effects (embedding nudge, taste profile update) run as async
         * server-side tasks after the upsert — they are NOT exposed in the response.
         */
        PUT: async (event, ctx) => {
            const userId = event.locals.user?.userId;
            if (!userId) {
                return ApiProblem.unauthorized();
            }

            const internalId = resolveInternalId(event);
            if (!internalId) {
                return ApiProblem.validationFailed([
                    {
                        field: 'id',
                        message:
                            'Composite ID keys require the ID-resolution middleware. ' +
                            'Use an internal UUID or ?externalId=provider:id:type.',
                    },
                ]);
            }

            // Body was already validated by the request contract (see RatingBody).
            // mount() rejects malformed/out-of-range input before we get here.
            const { rating, ratingStyle } = ctx.input!.body;

            try {
                const sql = await aiDbService.getSql();
                if (!sql) {
                    return ApiProblem.dependencyUnavailable('Database unavailable');
                }

                if (rating === 0) {
                    const { deleteUserRating } =
                        await import('$lib/server/database/queries/user-ratings.queries.js');
                    await deleteUserRating.execute(sql, { userId, mediaId: internalId });
                } else {
                    const { upsertUserRating } =
                        await import('$lib/server/database/queries/user-ratings.queries.js');
                    await upsertUserRating.execute(sql, {
                        userId,
                        mediaId: internalId,
                        rating,
                        ratingStyle,
                    });
                }

                return json({ rating: rating === 0 ? undefined : rating });
            } catch (err) {
                logger.error(
                    'Failed to update user rating in media/{id}/rating PUT',
                    err as Error,
                    {
                        userId,
                        internalId,
                        rating,
                    },
                );
                return ApiProblem.internalError('Failed to update rating');
            }
        },

        /**
         * DELETE /media/{id}/rating
         * Clears the caller's rating. 204 whether or not one was set; 404 when the media does
         * not exist or the caller cannot reach it (never 403, to avoid leaking existence).
         * For music, `user_ratings.rating` is also the storage behind a track's feedback, so
         * clearing goes through clearTrackFeedback.
         */
        DELETE: withIdResolution(async ({ params, locals }) => {
            const userId = locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const mediaId = locals.resolvedIds?.internalId ?? params.id;
            if (!mediaId) return ApiProblem.notFound('Media not found');

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const accessible = await checkMediaAccess(sql, mediaId, locals.user);
            if (!accessible) return ApiProblem.notFound('Media not found');

            if (isMusicMediaType(await getMediaType(sql, mediaId)))
                await clearTrackFeedback(sql, userId, mediaId);
            else await deleteUserRating.execute(sql, { userId, mediaId });

            return new Response(null, { status: 204 });
        }),
    },
});

// Export the id resolver for use in route files that delegate here
export { resolveInternalId };
