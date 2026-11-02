// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PopularShowsStrategy — popular TV shows (global cache).
 *
 * Folds the legacy `GET /api/for-you/popular-shows` rail into the shared
 * recommender dispatch. Backed by `fetchPopularShows` (for-you.service);
 * global (non-user) curated cache; reason kind 'trending', score = rating/10.
 *
 * Contract notes:
 * - DB DOWN → throw DependencyUnavailableError (never empty 200).
 * - Over-fetch is handled by mapBatch (slice + hasMore) on `limit`.
 * - Watched-exclusion uses the server-side watch state for `ctx.userId`.
 */

import type {
    RecommenderStrategy,
    AccessContext,
    RecommenderOptions,
    RecommenderResult,
} from '../recommender.js';
import { Logger } from '$lib/server/utils/logger.js';
import { DependencyUnavailableError, isDependencyUnavailable } from '$lib/server/api/problem.js';
import { mapBatch, hydrateRailMetadata } from '../../for-you/item-mapper.js';
import { m } from '$lib/paraglide/messages.js';

const logger = Logger.for('PopularShowsStrategy');

export class PopularShowsStrategy implements RecommenderStrategy {
    readonly id = 'popular-shows';
    readonly label = m.section_popular_shows;

    async fetch(ctx: AccessContext, opts: RecommenderOptions): Promise<RecommenderResult> {
        try {
            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) throw new DependencyUnavailableError('Database unavailable', 'postgres');

            const { fetchPopularShows } = await import('$lib/server/services/for-you.service.js');
            const { watchManager } = await import('$lib/server/services/watch-manager.service.js');
            const { getExternalIdFor } = await import('$lib/utils/external-ids.js');
            const { CACHE_NAMESPACES, searchScopedCacheWithBoundary } =
                await import('$lib/server/cache/index.js');
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

            const CACHE_FETCH_SIZE = 30;
            // v5: fetchPopularShows now caps per availability class instead of a
            // blind slice(0, limit) — cached payload composition changed.
            //
            // `searchScopedCacheWithBoundary` binds the cache to BOTH the request's
            // search context (username/denied-groups/age/livetv/showUnavailable)
            // AND the query boundary, then folds both into the key internally —
            // byte-identical to the previous
            // `${scopedCacheKey(...)}|${boundaryCacheKey(access)}` hand-concat. This
            // is a GLOBAL (non-user) curated cache, so no `userId` partition is
            // threaded — the entry is shared across users with the same access
            // scope, exactly as before. There is no method here that accepts a
            // pre-formed key, so the access token cannot be dropped by accident.
            const curatedCache = searchScopedCacheWithBoundary(
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
            const cacheBase = 'popular-shows:global:v5';

            // Single-flight: collapse concurrent TTL-expiry misses to one DB query,
            // then promote into L1. The wrapper serialises the computed payload for
            // the single-flight substrate and parses it back — same JSON round-trip
            // the old hand-rolled block performed.
            let popularShows = await curatedCache.getOrComputeSingleFlight<
                Awaited<ReturnType<typeof fetchPopularShows>>
            >(cacheBase, undefined, async () => fetchPopularShows(sql, CACHE_FETCH_SIZE, access));

            // Always-on server-config gate + per-request availableOnly override.
            if (!ctx.showUnavailableMedia || opts.availableOnly) {
                popularShows = popularShows.filter((item) => item.isAvailable);
            }

            // Exclude already-watched (non-fatal).
            try {
                const watchedIds = await watchManager.getWatchedMediaIdsCached(ctx.userId);
                if (watchedIds.length > 0) {
                    const watchedSet = new Set(watchedIds);
                    popularShows = popularShows.filter((item) => {
                        const internalId = getExternalIdFor(item.externalIds, 'internal');
                        return !internalId || !watchedSet.has(internalId);
                    });
                }
            } catch (e) {
                logger.warn('Failed to fetch watched IDs for popular-shows exclusion', {
                    error: e,
                });
            }

            const result = mapBatch(
                popularShows as Array<{
                    externalIds: (typeof popularShows)[0]['externalIds'];
                    mediaType: string;
                    title: string;
                    rating: number;
                }>,
                opts.limit,
                'trending',
                opts.surface,
                (item) => (item.rating ? item.rating / 10 : undefined),
            );
            await hydrateRailMetadata(sql, result.items);
            return result;
        } catch (err) {
            if (isDependencyUnavailable(err)) throw err;
            logger.error('PopularShowsStrategy fetch error', err as Error);
            return { items: [], hasMore: false };
        }
    }
}

export const popularShowsStrategy = new PopularShowsStrategy();
