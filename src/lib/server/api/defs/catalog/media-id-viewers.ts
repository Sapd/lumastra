// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/catalog/media-id-viewers.ts — `media/{id}/viewers`.
 *
 * GET /media/{id}/viewers → { items: [{ author, rating?, watchedAt?, ... }], page, me }.
 *
 * Feature-flagged on FEATURE_SOCIAL. Returns 503 when DB unavailable.
 * Auth: user. Surface: internal.
 */

import { userImageSets } from '$lib/server/services/image-descriptor/avatars.js';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/database/connection.js';
import { features } from '$lib/server/config.js';
import {
    getMediaViewers,
    getCurrentUserWatchState,
} from '$lib/server/database/queries/social.queries.js';
import { resolveCatalogInternalId } from './resolve-id.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { parsePagination } from '$lib/server/utils/pagination.js';
import {
    ViewersResponseSchema,
    type ViewersResponse,
    type ViewerItem,
} from '$lib/schemas/api-content-responses.js';
import { toPublicAuthor } from '$lib/server/utils/public-author.js';

export { ViewersResponseSchema };
export type { ViewersResponse };

const QuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().nonnegative().default(0),
});

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: { query: QuerySchema },

    docs: {
        GET: {
            tags: ['Media'],
            summary: 'List who else watched a title',
            stability: 'beta',
            auth: 'bearer',
            query: QuerySchema,
            responses: {
                200: {
                    schema: ViewersResponseSchema,
                    description: 'Users who have watched this item',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },

    handlers: {
        GET: async (event, ctx) => {
            if (!features.social) {
                return ApiProblem.forbidden('Social features are disabled');
            }

            const currentUser = event.locals.user;
            if (!currentUser?.userId) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');

            const internalId = await resolveCatalogInternalId(event);
            if (!internalId) return ApiProblem.notFound('Media not found');

            if (!(await checkMediaAccess(sql, internalId, currentUser))) {
                return ApiProblem.notFound('Media not found');
            }

            const { limit, offset } = parsePagination(event.url, {
                defaultLimit: 50,
                maxLimit: 100,
            });

            // Keep the existing privacy-filtered query unchanged. Fetch the prefix
            // before slicing so its window count remains available beyond the last page.
            const viewerRows = await getMediaViewers(
                sql,
                internalId,
                currentUser.userId,
                offset + limit,
            );
            const watchState = await getCurrentUserWatchState(sql, internalId, currentUser.userId);

            const pageRows = viewerRows.slice(offset, offset + limit);
            const avatars = await userImageSets(
                sql,
                ctx.surface,
                pageRows.map((row) => row.user_id),
                { external: false },
            );
            const items: ViewerItem[] = pageRows.map((row) => ({
                author: toPublicAuthor(
                    { userId: row.user_id, displayName: row.display_name },
                    ctx.surface,
                    avatars.get(row.user_id),
                ),
                // `??`, not `?` — a legitimate rating of 0 is falsy, and the
                // truthiness check silently reported the strongest negative
                // rating a user can give as "not rated".
                rating: row.rating ?? undefined,
                // Validated narrow, not a cast: rating_style is free text at
                // the type level and legacy rows may hold neither value.
                ratingStyle:
                    row.rating_style === 'quick' || row.rating_style === 'stars'
                        ? row.rating_style
                        : undefined,
                watchedAt: row.last_played_at
                    ? new Date(row.last_played_at).toISOString()
                    : undefined,
                playCount: row.play_count ? Number(row.play_count) : undefined,
                isFavorite: row.is_favorite === true,
            }));

            const totalViewers = viewerRows[0]?.total_count ?? 0;

            return json({
                items,
                page: {
                    limit,
                    offset,
                    hasMore: offset + items.length < totalViewers,
                    total: totalViewers,
                },
                me: { watched: watchState.watched, rating: watchState.rating ?? undefined },
            } satisfies ViewersResponse);
        },
    },
});
