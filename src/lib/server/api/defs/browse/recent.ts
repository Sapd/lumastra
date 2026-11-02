// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { buildMediaPreviews } from '$lib/server/services/media-preview.service.js';
import { MediaBrowseResponseSchema } from '$lib/schemas/api-browse-responses.js';

/**
 * defs/browse/recent.ts — GET /api/browse/recent
 *
 * Filterable "Recently Added" surface for /browse. Supports media-type filter,
 * library-group filter, newness mode (everything|seasons|titles), and title search.
 *
 * Results are access-filtered per the caller and are NOT cached (filter
 * combination space is large; data is intentionally fresh).
 *
 * Contract:
 *   GET /browse/recent?type&libraryGroupId&new&q
 *     → bare BrowseResponse  { recentlyAdded, genres:[], … }
 *
 * Auth: user.  Surface: internal.
 * 503 dependency_unavailable when DB is down.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { recentQuerySchema } from '$lib/schemas/browse.js';
import type { BrowseItem, BrowseResponse } from '$lib/schemas/api-browse-responses.js';
import { getFilteredRecentlyAddedMedia } from '$lib/server/database/queries/browse.queries.js';
import { isMovie } from '$lib/server/utils/media-types.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { config } from '$lib/server/config.js';
import { trimItemOverview } from '$lib/server/utils/truncate-overview.js';

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Discovery'],
            summary: 'Recently added library previews',
            description: 'Browse sections carry MediaPreview with opaque handles and ImageSet.',
            responses: {
                200: { schema: MediaBrowseResponseSchema, description: 'Recent preview sections' },
            },
        },
    },
    auth: { kind: 'user' },
    visibility: 'internal',
    request: {
        query: recentQuerySchema,
    },
    handlers: {
        GET: async (event, ctx) => {
            const { type: mediaType, libraryGroupId, new: newness, q } = ctx.input!.query;

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not available');
            }

            // Translate canonical public value to the internal DB discriminator.
            // 'channels' is not a DB media_type; fall through to 'all'.
            let dbMediaType: 'movie' | 'tv' | 'all' = 'all';
            if (mediaType === 'movie') dbMediaType = 'movie';
            else if (mediaType === 'series') dbMediaType = 'tv';

            const accessCtx = await buildSearchAccessContext(sql, event.locals.user!);

            const results = await getFilteredRecentlyAddedMedia(sql, {
                mediaType: dbMediaType,
                limit: 40,
                access: searchAccessBoundary(accessCtx),
                groupId: libraryGroupId,
                query: q,
                newness,
            });

            const recentlyAdded: BrowseItem[] = results.map((row) => ({
                id: row.id,
                name: row.title,
                // Canonical: 'series' replaces 'tv'
                type: isMovie(row.media_type) ? 'movie' : 'series',
                overview: row.overview ?? undefined,
                imageId: row.id,
            }));

            // Per-user metadata-language overlay (multilingual-media-metadata spec
            // §5): resolved ONCE per request, applied AFTER the DB read above.
            // This endpoint is explicitly NOT cached (see module docblock), and
            // `recentlyAdded` was just freshly constructed by the `.map()` call
            // above, so it's safe to overlay in place — no clone needed.
            const { enrichSeriesEpisodeCounts } =
                await import('$lib/server/services/series-episode-counts.service.js');
            await enrichSeriesEpisodeCounts(
                sql,
                recentlyAdded,
                event.locals.user?.userId ?? null,
                searchAccessBoundary(accessCtx),
            );
            const userId = event.locals.user?.userId;
            if (userId && config.METADATA_ADDITIONAL_LANGUAGES.length > 0) {
                const { resolveMetadataLanguage } =
                    await import('$lib/server/utils/metadata-language-resolve.js');
                const { getPlaybackPreferences } =
                    await import('$lib/server/database/queries/user-preferences.queries.js');
                const langs = resolveMetadataLanguage(
                    await getPlaybackPreferences.one(sql, { userId }),
                );
                if (langs.titleLang || langs.textLang) {
                    const { applyTranslationOverlay } =
                        await import('$lib/server/utils/translation-overlay.js');
                    await applyTranslationOverlay(sql, recentlyAdded, langs, {
                        id: (it) => it.id || null,
                        setTitle: (it, v) => {
                            it.name = v;
                        },
                        setOverview: (it, v) => {
                            it.overview = v;
                        },
                    });
                }
            }

            // This def has no /api/v1 mount (visibility: 'internal', see module
            // docblock), so the overview trim below applies unconditionally.
            const response = {
                continueWatching: [],
                nextUp: [],
                recentlyAdded: recentlyAdded.map(trimItemOverview),
                genres: [],
                totalGenres: 0,
                hasMoreGenres: false,
                // Server is reachable — empty result is a legitimate "no matches".
                mediaServerAvailable: true,
            } satisfies BrowseResponse;

            return json({
                ...response,
                recentlyAdded: await buildMediaPreviews(
                    sql,
                    ctx.surface,
                    response.recentlyAdded.map((item) => ({
                        id: item.id,
                        type: item.type,
                        title: item.name,
                        overview: item.overview,
                    })),
                ),
            });
        },
    },
});
