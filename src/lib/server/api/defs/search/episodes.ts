// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/search/episodes.ts — GET /api/search/episodes
 *
 * Episode full-text search.
 *
 * Contract:
 *   GET /api/search/episodes?q=…&limit=…&seriesId=…  → { items, page }
 *
 * Each item is typed: id, seriesId, seriesMetaId, seriesMetaProvider,
 * seasonNumber, episodeNumber, title, overview, runtimeSeconds, premiereDate,
 * relevanceScore.
 *
 * DB down → 503 dependency_unavailable (never 200-empty).
 *
 * Auth: user.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { Logger } from '$lib/server/utils/logger.js';
import { parsePagination } from '$lib/server/utils/pagination.js';
import {
    searchEpisodes,
    type EpisodeSearchResult,
} from '$lib/server/database/queries/episode-search.queries.js';
import {
    getDeniedLibraryGroups,
    toLibraryAccessUser,
} from '$lib/server/cache/library-group-permissions-cache.js';
import { config } from '$lib/server/config.js';
import type { AgeRatingFilterParams } from '$lib/server/database/queries/builders/age-rating.builder.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';

const logger = Logger.for('EpisodeSearchDef');

const episodeSearchCache = cacheManager.for(CACHE_NAMESPACES.search);

function buildEpisodeCacheKey(
    query: string,
    seriesId: string | undefined,
    limit: number,
    deniedGroupIds: string[] | null,
    maxAgeRating: number | null,
): string {
    const parts = ['episodes', query.toLowerCase().trim(), seriesId ?? 'all', `l${limit}`];
    if (deniedGroupIds && deniedGroupIds.length > 0) {
        parts.push(`denied:${[...deniedGroupIds].sort().join(',')}`);
    }
    if (maxAgeRating !== null) parts.push(`age:${maxAgeRating}`);
    return parts.join(':');
}

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const EpisodeSearchQuerySchema = z.object({
    q: z.string().min(1).max(200).describe('Search query (min 2 chars enforced in handler)'),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    seriesId: z.string().optional().describe('Filter by series UUID'),
});

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: {
        query: EpisodeSearchQuerySchema,
    },
    handlers: {
        GET: async (event, _ctx) => {
            const { url, locals } = event;

            const query = url.searchParams.get('q');
            const seriesId = url.searchParams.get('seriesId') ?? undefined;

            if (!query || query.trim().length < 2) {
                return ApiProblem.validationFailed([
                    {
                        field: 'q',
                        message: 'Search query must be at least 2 characters',
                        value: query,
                    },
                ]);
            }

            const { limit } = parsePagination(url, { defaultLimit: 20, maxLimit: 100 });

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database unavailable');
            }

            const deniedGroupIds = await getDeniedLibraryGroups(
                sql,
                toLibraryAccessUser(locals.user),
            );
            const maxAgeRating = locals.user?.maxAgeRating ?? null;
            const ageRating: AgeRatingFilterParams | null =
                maxAgeRating != null
                    ? { maxAgeRating, allowUnrated: config.UNRATED_CONTENT_VISIBLE }
                    : null;

            const cacheKey = buildEpisodeCacheKey(
                query,
                seriesId,
                limit,
                deniedGroupIds,
                maxAgeRating,
            );

            let results = await episodeSearchCache.get<EpisodeSearchResult[]>(cacheKey);
            if (!results) {
                results = await searchEpisodes(sql, query, limit, seriesId, {
                    deniedGroupIds,
                    ageRating,
                });
                episodeSearchCache.set(cacheKey, results).catch(() => {});
            }

            logger.debug('Episode search completed', {
                query,
                seriesId,
                resultCount: results.length,
            });

            // Per-user metadata-language overlay (multilingual-media-metadata spec
            // §5): resolved once per request, applied AFTER the cache read/write
            // above (both the cache-hit and cache-miss paths converge into
            // `results` before this point). CRITICAL: the episode-search cache
            // key has NO user component AND UnifiedCache L1 returns/stores the
            // LIVE object reference — mutating `results` in place would write
            // one user's language INTO the shared cache entry and leak it to
            // every other user hitting the same key. Overlay therefore runs on
            // shallow CLONES; the cached array stays language-neutral.
            let responseItems = results;
            const overlayUserId = locals.user?.userId;
            if (overlayUserId && config.METADATA_ADDITIONAL_LANGUAGES.length > 0) {
                const { resolveMetadataLanguage } =
                    await import('$lib/server/utils/metadata-language-resolve.js');
                const { getPlaybackPreferences } =
                    await import('$lib/server/database/queries/user-preferences.queries.js');
                const langs = resolveMetadataLanguage(
                    await getPlaybackPreferences.one(sql, { userId: overlayUserId }),
                );
                if (langs.titleLang || langs.textLang) {
                    const { applyTranslationOverlay } =
                        await import('$lib/server/utils/translation-overlay.js');
                    const localized = results.map((r) => ({ ...r }));
                    await applyTranslationOverlay(sql, localized, langs, {
                        id: (it) => it.id,
                        setTitle: (it, v) => {
                            it.title = v;
                        },
                        setOverview: (it, v) => {
                            it.overview = v;
                        },
                    });
                    responseItems = localized;
                }
            }

            return json(
                paginate(responseItems, {
                    limit,
                    offset: 0,
                    hasMore: false,
                    total: results.length,
                }),
            );
        },
    },
});
