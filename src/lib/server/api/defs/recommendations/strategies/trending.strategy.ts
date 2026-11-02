// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TrendingStrategy — wraps the existing fetchTrending() service.
 *
 * Maps the service's `TrendingItem[]` shape into the shared
 * `RecommendationItem` envelope.
 *
 * The `trending` strategy id is used both for the `/for-you` SDUI section and
 * the raw trending list.
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
import { DependencyUnavailableError, isDependencyUnavailable } from '$lib/server/api/problem.js';
import type { ExternalIds } from '$lib/types/api-common.js';
import { CACHE_NAMESPACES, searchScopedCacheWithBoundary } from '$lib/server/cache/index.js';
import { toPublicMediaType } from '$lib/shared/media-type-domain';
import { resolveMediaRefId, hydrateRailMetadata } from '../../for-you/item-mapper.js';
import { m } from '$lib/paraglide/messages.js';

const logger = Logger.for('TrendingStrategy');

/** Convert provider ExternalIds map to a plain `Record<string, string>`. */
function toIdsRecord(extIds: ExternalIds): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(extIds ?? {})) {
        if (v != null) out[k] = String(v);
    }
    return out;
}

export class TrendingStrategy implements RecommenderStrategy {
    readonly id = 'trending';
    readonly label = m.section_trending_today;

    async fetch(ctx: AccessContext, opts: RecommenderOptions): Promise<RecommenderResult> {
        try {
            // Age gate FIRST — age-restricted users cannot receive TMDB-sourced
            // trending (there is no SQL-level age filter for it), so short-circuit
            // to empty regardless of DB availability. Doing this before the getDb()
            // check keeps the age guard independent of dependency state (and matches
            // AnimeStrategy's ordering — this guards /feed too).
            if (ctx.isAgeRestricted) {
                return { items: [], hasMore: false };
            }

            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) {
                // DB DOWN — signal dependency-down (NOT genuine-empty). Tier-2
                // maps to 503; /feed drops this section.
                throw new DependencyUnavailableError('Database unavailable', 'postgres');
            }

            const { fetchTrending } = await import('$lib/server/services/for-you.service.js');
            const { restrictedAccess } =
                await import('$lib/server/database/queries/builders/media-access-boundary.js');

            // Over-fetch by 1 to detect hasMore cheaply.
            // NOTE: over-fetch BEFORE media-type and availability filters so that the
            // +1 sentinel survives post-fetch filtering and hasMore remains correct.
            const fetchLimit = opts.limit + 1;

            // Access boundary for the trending query, built directly from the
            // request's REAL access facts (`ctx.deniedGroupIds` etc, resolved
            // once in `buildAccessContext`). This is the SAME value used below to
            // key the cache — a query boundary and a cache key derived from two
            // independent sources is exactly how a restricted user could read
            // back another user's rails filtered under the wrong permissions.
            const trendingAccess = restrictedAccess({
                deniedGroupIds: ctx.deniedGroupIds ?? [],
                maxAgeRating: ctx.maxAgeRating ?? null,
                allowUnrated: ctx.allowUnrated,
            });

            // Over-fetch a larger pool so post-filters don't prematurely exhaust results.
            const overFetch = opts.mediaType ? fetchLimit * 4 : fetchLimit;

            // v2: fetchTrending now caps per availability class instead of a
            // blind slice(0, limit) — cached payload composition changed.
            //
            // Bind the cache to BOTH the search context (locale/livetv/lib-only)
            // AND the real query boundary (`trendingAccess`). The wrapper folds
            // both into the key internally — byte-identical to the previous
            // `${scopedCacheKey(...)}|${boundaryCacheKey(trendingAccess)}`
            // hand-concat — so the ONE boundary that filters the query also
            // partitions the cache, and a denyAll/denyGroups/all boundary can
            // never collide with another. There is no method here that accepts a
            // pre-formed key, so the access token cannot be dropped by accident.
            const trendingCache = searchScopedCacheWithBoundary(
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
                trendingAccess,
            );
            const cacheBase = `trending:v2:fetch=${overFetch}:type=${opts.mediaType ?? 'all'}`;

            // Single-flight: collapse concurrent TTL-expiry misses (trending is in
            // the default /feed plan, hit on every home load) to one fetch. The
            // wrapper's getOrComputeSingleFlight absorbs the raw-L2-key + JSON
            // round-trip + L1 promotion the call site used to hand-roll.
            let raw = await trendingCache.getOrComputeSingleFlight<
                Awaited<ReturnType<typeof fetchTrending>>
            >(cacheBase, undefined, () => fetchTrending(sql, overFetch, trendingAccess));

            // Media-type filter
            if (opts.mediaType) {
                const canonicalType = opts.mediaType === 'movie' ? 'movie' : 'tv';
                raw = raw.filter((item) => item.mediaType === canonicalType);
            }

            // Library-only filter: always-on server-config gate
            if (!ctx.showUnavailableMedia) {
                raw = raw.filter((item) => item.isAvailable);
            }

            // Per-request availability override: client-driven "available only" filter
            if (opts.availableOnly) {
                raw = raw.filter((item) => item.isAvailable);
            }

            const hasMore = raw.length > opts.limit;
            const page = raw.slice(0, opts.limit);

            const items: RecommendationItem[] = page.flatMap((item): RecommendationItem[] => {
                const extIds = item.externalIds as ExternalIds;
                // A type with no public representation is DROPPED, never
                // relabelled: `media.type` is what the client routes playback
                // off, so the old `?? item.mediaType ?? 'movie'` fallback turned
                // an unpublishable row into a broken movie card.
                const canonical = toPublicMediaType(item.mediaType);
                if (!canonical) return [];

                // Trending deliberately keeps discovery-only (request-only)
                // titles, which have no internal UUID — so the fallback must be
                // a VALID composite key. The previous `${provider}:${id}` form
                // was 2-part, which parseMediaId rejects outright for TMDB.
                const mediaId = resolveMediaRefId(extIds, canonical);
                if (!mediaId) return [];

                const media: RecommendedMediaRef = {
                    id: mediaId,
                    type: canonical,
                    title: item.title,
                    ids: toIdsRecord(extIds),
                };
                return [
                    {
                        media,
                        score: item.rating ? item.rating / 10 : undefined,
                        // Trending is discovery-sourced (TMDB): items may or may not be in
                        // the library. Carry the real availability computed by fetchTrending
                        // so the client doesn't blanket-assume "not in library" (which mis-
                        // flags library items like an owned movie as request-only).
                        isAvailable: item.isAvailable,
                        canRequest: item.canRequest,
                        reason: { kind: 'trending' },
                    },
                ];
            });

            await hydrateRailMetadata(sql, items);
            return { items, hasMore };
        } catch (err) {
            // Propagate dependency-down so the caller can return 503 / drop the section.
            if (isDependencyUnavailable(err)) throw err;
            logger.error('TrendingStrategy fetch error', err as Error);
            return { items: [], hasMore: false };
        }
    }
}

/** Singleton instance — strategies are stateless. */
export const trendingStrategy = new TrendingStrategy();
