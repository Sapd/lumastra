// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ForYouStrategy — general personalised "for you" recommendations.
 *
 * This strategy backs ONLY the generic personalised shelf: `type=for-you` (the
 * default when no `type` is given). It is NOT a collapse target for the curated
 * rails — each curated rail keeps its OWN `type`/strategy in the registry
 * (source of truth: strategies/index.ts + the recommendations.ts docstring):
 *   for-you/anime              → recommendations?type=anime
 *   for-you/binge-worthy       → recommendations?type=binge-worthy
 *   for-you/fresh-releases     → recommendations?type=fresh-releases
 *   for-you/short-movies       → recommendations?type=short-movies
 *   for-you/popular-shows      → recommendations?type=popular-shows
 *   for-you/recently-added     → recommendations?type=recently-added
 *   for-you/random-picks       → recommendations?type=random-picks
 *   for-you/fulfilled-requests → recommendations?type=fulfilled-requests
 *   for-you/music-because      → recommendations?type=because-you-watched&domain=music
 *
 * The strategy uses the quality-ranked library fallback (`getQualityLibraryMedia`)
 * which is already used by the existing recommendations endpoint for `type=movies|series`.
 * Richer personalisation (embeddings) is delegated to AiStrategy (type=ai).
 */

import type {
    RecommenderStrategy,
    AccessContext,
    RecommenderOptions,
    RecommenderResult,
    RecommendationItem,
    RecommendedMediaRef,
} from '../recommender.js';
import { Logger } from '$lib/server/utils/logger.js';
import { createExternalIds } from '$lib/utils/external-ids.js';
import { DependencyUnavailableError, isDependencyUnavailable } from '$lib/server/api/problem.js';
import { CACHE_NAMESPACES, searchScopedCacheWithBoundary } from '$lib/server/cache/index.js';
import { toPublicMediaType } from '$lib/shared/media-type-domain';
import { pickDisplayRating } from '$lib/server/utils/rating-utils.js';
import { hydrateRailMetadata } from '../../for-you/item-mapper.js';
import { m } from '$lib/paraglide/messages.js';

const logger = Logger.for('ForYouStrategy');

export class ForYouStrategy implements RecommenderStrategy {
    readonly id = 'for-you';
    readonly label = m.foryou_library_highlights;

    async fetch(ctx: AccessContext, opts: RecommenderOptions): Promise<RecommenderResult> {
        try {
            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) {
                // DB DOWN — signal dependency-down (NOT genuine-empty).
                throw new DependencyUnavailableError('Database unavailable', 'postgres');
            }

            const { getQualityLibraryMedia } =
                await import('$lib/server/database/queries/hero-fallback.queries.js');
            const { restrictedAccess } =
                await import('$lib/server/database/queries/builders/media-access-boundary.js');

            // Access boundary built directly from the request's REAL access facts
            // (`ctx.deniedGroupIds` etc, resolved once in `buildAccessContext`) —
            // the SAME value feeds the query below AND the cache key.
            const access = restrictedAccess({
                deniedGroupIds: ctx.deniedGroupIds ?? [],
                maxAgeRating: ctx.maxAgeRating,
                allowUnrated: ctx.allowUnrated,
            });

            const fetchLimit = opts.limit + 1;

            // Map canonical media type to internal DB type
            const dbMediaType =
                opts.mediaType === 'movie'
                    ? 'movie'
                    : opts.mediaType === 'series'
                      ? 'tv'
                      : undefined;

            // The cache is bound to BOTH the search context (locale / livetv /
            // lib-only, folded via scopedCacheKey) AND the query boundary (the
            // `denyAll` distinction the search context cannot express).
            // `searchScopedCacheWithBoundary` folds both into the key internally —
            // byte-identical to the previous
            // `${scopedCacheKey(...)}|${boundaryCacheKey(access)}` hand-concat.
            // There is no method here that accepts a pre-formed key, so the access
            // token cannot be dropped by accident. The SAME `access` value also
            // feeds the query below, so the cached payload always matches the
            // boundary it was computed under.
            const forYouCache = searchScopedCacheWithBoundary(
                CACHE_NAMESPACES.curatedContent,
                {
                    username: ctx.username,
                    deniedGroupIds: ctx.deniedGroupIds,
                    ageRating:
                        ctx.maxAgeRating != null
                            ? { maxAgeRating: ctx.maxAgeRating, allowUnrated: ctx.allowUnrated }
                            : null,
                    liveTvAllowed: false,
                    showUnavailableMedia: ctx.showUnavailableMedia,
                },
                access,
            );
            const cacheBase = `for-you:quality:v1:limit=${fetchLimit}:type=${dbMediaType ?? 'all'}`;

            // Single-flight: collapse concurrent TTL-expiry misses (this is the
            // first /feed section, so it's hit on every home load) to one query.
            // The wrapper reproduces the previous raw L2 key
            // `${ns.name}:${scopedKey}` and the JSON round-trip / L1 promote.
            const dbItems = await forYouCache.getOrComputeSingleFlight<
                Awaited<ReturnType<typeof getQualityLibraryMedia>>
            >(cacheBase, undefined, () =>
                getQualityLibraryMedia(sql, {
                    mediaType: dbMediaType,
                    limit: fetchLimit,
                    access,
                }),
            );

            // getQualityLibraryMedia already constrains to has_files = true rows,
            // so all results are library-available. Both the always-on server-config
            // gate (ctx.showUnavailableMedia) and the per-request availableOnly
            // override (opts.availableOnly) are automatically satisfied — no
            // additional post-filter is required.

            const hasMore = dbItems.length > opts.limit;
            const page = dbItems.slice(0, opts.limit);

            const items: RecommendationItem[] = page.flatMap((item): RecommendationItem[] => {
                // Skip items with no stable internal UUID — clients cannot dereference them.
                if (!item.internal_id) return [];

                const extIds = createExternalIds({
                    tmdb: item.tmdb_id ?? undefined,
                    internal: item.internal_id,
                });

                const idsRecord: Record<string, string> = {};
                for (const [k, v] of Object.entries(extIds ?? {})) {
                    if (v != null) idsRecord[k] = String(v);
                }

                // A type with no public representation is DROPPED, never
                // relabelled: the old `?? item.media_type ?? 'movie'` leaked the
                // raw storage token (or silently published a typeless row as a
                // movie) into the discriminator the client routes playback off.
                const publicType = toPublicMediaType(item.media_type);
                if (!publicType) return [];

                const media: RecommendedMediaRef = {
                    id: item.internal_id,
                    type: publicType,
                    title: item.title,
                    year: item.release_year ?? null,
                    ids: idsRecord,
                };

                const rating = pickDisplayRating({
                    imdbRating: item.imdb_rating,
                    tmdbRating: item.tmdb_rating,
                    voteCount: item.vote_count,
                });

                return [
                    {
                        media,
                        score: rating ? rating / 10 : undefined,
                        // Non-personalized quality-ranked library fallback — 'trending'
                        // is the honest generic kind this codebase already uses for
                        // global, non-user-scoped curated content (see
                        // popular-shows.strategy.ts / fresh-releases.strategy.ts).
                        // 'for-you' would misrepresent this as personalized to
                        // consumers hitting `?type=for-you` directly.
                        reason: { kind: 'trending' },
                    },
                ];
            });

            await hydrateRailMetadata(sql, items);
            return { items, hasMore };
        } catch (err) {
            // Propagate dependency-down so the caller can return 503 / drop the section.
            if (isDependencyUnavailable(err)) throw err;
            logger.error('ForYouStrategy fetch error', err as Error);
            return { items: [], hasMore: false };
        }
    }
}

export const forYouStrategy = new ForYouStrategy();
