// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { BrowseKeywordsResponseSchema } from '$lib/schemas/api-browse-responses.js';
import { trimItemOverview } from '$lib/server/utils/truncate-overview.js';
import { buildMediaPreviews } from '$lib/server/services/media-preview.service.js';

/**
 * defs/browse/keywords.ts — GET /api/browse/keywords
 *
 * Keyword-based browse sections sourced entirely from the local DB.
 * Only emits sections for keywords that intersect the user's own library
 * (isAvailable=true), filtered by the caller's library + age access scope.
 *
 * Contract:
 *   GET /browse/keywords?type&limit&offset
 *     → { items: KeywordSection[], availableKeywords, page }
 *
 * Auth: user.  Surface: internal.
 * 503 dependency_unavailable when the database is not available.
 * 403 forbidden for age-restricted profiles.
 */

import { json } from '@sveltejs/kit';
import type { EpisodeCountTarget } from '$lib/server/services/series-episode-counts.service.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { keywordsQuerySchema } from '$lib/schemas/browse.js';
import {
    browseScopedCacheKey,
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import {
    type BrowseKeywordSectionsResult,
    buildBrowseKeywordSections,
} from '$lib/server/database/queries/browse.queries.js';
import { CACHE_NAMESPACES, cacheManager } from '$lib/server/cache/index.js';
import { getOrComputeSingleFlight } from '$lib/server/cache/single-flight.js';
import { config } from '$lib/server/config.js';

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Discovery'],
            summary: 'Keyword discovery preview sections',
            description:
                'Keyword sections carry MediaPreview items with opaque handles and ImageSet.',
            responses: {
                200: {
                    schema: BrowseKeywordsResponseSchema,
                    description: 'Paged keyword sections',
                },
            },
        },
    },
    auth: { kind: 'user' },
    visibility: 'internal',
    request: {
        query: keywordsQuerySchema,
    },
    handlers: {
        GET: async (event, ctx) => {
            if (event.locals.user?.isAgeRestricted) {
                return ApiProblem.forbidden(
                    'Keyword browse is not available for age-restricted profiles',
                );
            }

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database unavailable');
            }

            const { type: mediaType, limit, offset } = ctx.input!.query;

            const accessCtx = await buildSearchAccessContext(sql, event.locals.user);

            // Map the API 'series' filter value to the DB column value 'tv'.
            const dbMediaType: 'movie' | 'tv' | 'all' =
                mediaType === 'series' ? 'tv' : (mediaType as 'movie' | 'tv' | 'all');

            // Access-scoped cache key (library group + age via browseScopedCacheKey),
            // partitioned per page (type:offset:limit). The keyword list is static and
            // its membership only changes on ingest — invalidated on the same
            // content-added cascade that clears browseGenres. Unrestricted callers
            // share one bare key per page (which the cache warmer fills); restricted
            // callers partition by their denied-group/age suffix so they can never
            // read an entry containing media they can't access.
            const keywordsCache = cacheManager.for(CACHE_NAMESPACES.browseKeywords);
            const cacheKey = browseScopedCacheKey('bk2', accessCtx, [mediaType, offset, limit]);

            let result = await keywordsCache.get<BrowseKeywordSectionsResult>(cacheKey);
            if (!result) {
                // Single-flight the expensive compute (2 GIN/JSONB queries per keyword
                // over the static list) so a burst of concurrent cold-cache misses —
                // this endpoint fires on load, tab change, and infinite scroll — runs
                // it once. Response SHAPE is unchanged; only the miss path is wrapped.
                // Raw Valkey key mirrors UnifiedCache.buildL2Key(cacheKey) for a
                // non-user-scoped namespace: `${ns.name}:${cacheKey}`.
                const ns = CACHE_NAMESPACES.browseKeywords;
                const rawKey = `${ns.name}:${cacheKey}`;
                const ttlSeconds = Math.floor(ns.l2TTL / 1000);
                const jsonStr = await getOrComputeSingleFlight({
                    cacheKey: rawKey,
                    ttlSeconds,
                    compute: async () =>
                        JSON.stringify(
                            await buildBrowseKeywordSections(sql, {
                                mediaType: dbMediaType,
                                limit,
                                offset,
                                access: searchAccessBoundary(accessCtx),
                            }),
                        ),
                });
                result = JSON.parse(jsonStr) as BrowseKeywordSectionsResult;
                // Populate L1 so subsequent in-process reads skip Valkey.
                void keywordsCache.set(cacheKey, result);
            }

            // Per-user metadata-language overlay (multilingual-media-metadata spec
            // §5): resolved ONCE per request, applied AFTER cache retrieval so the
            // shared Valkey/L1 payload stays language-neutral. CRITICAL: UnifiedCache
            // L1 returns/stores the LIVE object reference — mutating `result` in
            // place would write one user's language INTO the shared cache entry and
            // leak it to every other user hitting the same key. Overlay therefore
            // runs on a deep-enough clone (sections + their items arrays).
            let sections = result.sections;
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
                    const cloned = result.sections.map((s) => ({
                        ...s,
                        items: s.items.map((it) => ({ ...it })),
                    }));
                    const allItems = cloned.flatMap((s) => s.items);
                    await applyTranslationOverlay(sql, allItems, langs, {
                        id: (it) => it.internalId || null,
                        setTitle: (it, v) => {
                            it.name = v;
                        },
                        setOverview: (it, v) => {
                            it.overview = v;
                        },
                    });
                    sections = cloned;
                }
            }

            // `internalId` is an internal-only field (translation-overlay lookup
            // key) — strip it at the response boundary so the wire shape matches
            // BrowseKeywordsResponseSchema (item id/externalIds stay TMDB-based).
            // This def has no /api/v1 mount (visibility: 'internal', see module
            // docblock), so the overview trim below applies unconditionally.
            sections = sections.map((section) => ({
                ...section,
                items: section.items.map((item) => ({ ...item })),
            }));
            const countItems = sections.flatMap((section) => section.items);
            const countTargets: EpisodeCountTarget[] = countItems.map((item) => ({
                id: item.internalId ?? '',
                type: item.type,
            }));
            const { enrichSeriesEpisodeCounts } =
                await import('$lib/server/services/series-episode-counts.service.js');
            await enrichSeriesEpisodeCounts(
                sql,
                countTargets,
                userId ?? null,
                searchAccessBoundary(accessCtx),
            );
            countItems.forEach((item, index) =>
                Object.assign(item, {
                    seasonCount: countTargets[index].seasonCount,
                    episodeCount: countTargets[index].episodeCount,
                    availableEpisodeCount: countTargets[index].availableEpisodeCount,
                    watchedEpisodeCount: countTargets[index].watchedEpisodeCount,
                    unwatchedEpisodeCount: countTargets[index].unwatchedEpisodeCount,
                }),
            );

            return json({
                availableKeywords: result.availableKeywords,
                page: { limit, offset, hasMore: result.hasMore, total: result.totalKeywords },
                items: await Promise.all(
                    sections.map(async (s) => ({
                        ...s,
                        items: await buildMediaPreviews(
                            sql,
                            ctx.surface,
                            s.items.map((item) => ({
                                id: item.internalId,
                                type: item.type,
                                title: item.name,
                                ids: item.externalIds,
                                overview: trimItemOverview(item).overview,
                                year: item.year ? Number(item.year) : undefined,
                                rating: item.rating,
                                isAvailable: item.isAvailable,
                            })),
                        ),
                    })),
                ),
            });
        },
    },
});
