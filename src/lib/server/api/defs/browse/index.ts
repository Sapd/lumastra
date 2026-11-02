// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { buildMediaPreviews } from '$lib/server/services/media-preview.service.js';

/**
 * defs/browse/index.ts — GET /api/browse
 *
 * Main browse endpoint: recently added + genre carousels.
 *
 * Contract:
 *   GET /browse?type=movie|series|channels|all  (legacy: 'movies'→'movie', 'tv'→'series')
 *     → bare BrowseResponse object (recentlyAdded, genres, …)
 *
 * Auth: user.  Surface: internal.
 * 503 dependency_unavailable when DB is down (never 200-with-empty).
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { browseQuerySchema } from '$lib/schemas/browse.js';
import {
    type BrowseResponse,
    MediaBrowseResponseSchema,
} from '$lib/schemas/api-browse-responses.js';
import { loadBrowseIndexData } from '$lib/server/services/browse-index.service.js';
import { trimItemOverview, trimRowItemOverviews } from '$lib/server/utils/truncate-overview.js';

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    // OpenAPI docs for the /api/v1/browse (public/native) surface. Migrated
    // verbatim from the retired src/routes/api/v1/browse/_openapi.ts, which
    // re-exported the internal src/routes/api/browse/_openapi.ts `route`.
    // No `auth`/`stability` fields → security stays NO_AUTH and stability
    // defaults to 'beta' for this path (byte-identical to the prior spec).
    docs: {
        GET: {
            tags: ['Browse'],
            stability: 'beta',
            summary: 'Browse media by category',
            description:
                'Returns media organized by sections: continue watching, next up, recently added, and genre rows.',
            query: browseQuerySchema,
            responses: {
                200: {
                    schema: MediaBrowseResponseSchema,
                    description: 'Browse response with media sections',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },
    request: {
        query: browseQuerySchema,
    },
    handlers: {
        GET: async (event, ctx) => {
            const { type: mediaType } = ctx.input!.query;

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not available');
            }

            const data = await loadBrowseIndexData(sql, { mediaType, user: event.locals.user });

            // Overview truncation applies ONLY on the internal surface — this def
            // is also mounted at /api/v1/browse (see routes/api/v1/browse), which
            // must stay byte-identical for native clients. See truncate-overview.ts.
            const trimmed = ctx.surface === 'internal';

            const response = {
                continueWatching: [],
                nextUp: [],
                recentlyAdded: trimmed
                    ? data.recentlyAdded.map(trimItemOverview)
                    : data.recentlyAdded,
                genres: trimmed ? data.genres.map(trimRowItemOverviews) : data.genres,
                totalGenres: data.totalGenres,
                hasMoreGenres: data.hasMoreGenres,
                mediaServerAvailable: data.mediaServerAvailable,
            } satisfies BrowseResponse;

            const previews = async (items: typeof data.recentlyAdded) =>
                buildMediaPreviews(
                    sql,
                    ctx.surface,
                    items.map((item) => ({
                        id: item.id,
                        type: item.type,
                        title: item.name,
                        overview: item.overview,
                        year: item.year,
                        rating: item.communityRating,
                    })),
                );
            return json({
                ...response,
                recentlyAdded: await previews(response.recentlyAdded),
                genres: await Promise.all(
                    response.genres.map(async (row) => ({
                        ...row,
                        items: await previews(row.items),
                    })),
                ),
            });
        },
    },
});
