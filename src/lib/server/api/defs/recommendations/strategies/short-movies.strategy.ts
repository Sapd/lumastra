// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ShortMoviesStrategy — movies under 90 minutes, AI-personalised + damped.
 *
 * Folds the legacy `GET /api/for-you/short-movies` rail. Backed by
 * `fetchShortMovies` (for-you.service) with the taste-damper context folded in;
 * user-scoped curated cache; reason kind 'for-you', score = imdbRating/10.
 *
 * Watched exclusion combines the legacy client `watched=` CSV of TMDB ids
 * (opts.extra.watchedTmdbIds) with the server-side watch state for
 * ctx.userId — the client param is never depended on, since the For You feed
 * client no longer sends it. DB DOWN → DependencyUnavailableError.
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
import { readWatchedTmdbIds } from './rail-extra.js';
import { m } from '$lib/paraglide/messages.js';

const logger = Logger.for('ShortMoviesStrategy');

export class ShortMoviesStrategy implements RecommenderStrategy {
    readonly id = 'short-movies';
    readonly label = m.section_short_movies;

    async fetch(ctx: AccessContext, opts: RecommenderOptions): Promise<RecommenderResult> {
        try {
            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) throw new DependencyUnavailableError('Database unavailable', 'postgres');

            const { fetchShortMovies } = await import('$lib/server/services/for-you.service.js');
            const { getTasteDamperService } =
                await import('$lib/server/services/taste-damper.service.js');
            const { watchManager } = await import('$lib/server/services/watch-manager.service.js');
            const { getExternalIdFor } = await import('$lib/utils/external-ids.js');
            const { CACHE_NAMESPACES, searchScopedCacheWithBoundary } =
                await import('$lib/server/cache/index.js');
            const { restrictedAccess } =
                await import('$lib/server/database/queries/builders/media-access-boundary.js');
            const { shouldSuppressContent } =
                await import('$lib/server/services/content-affinity.service.js');

            // Access boundary built directly from the request's REAL access facts
            // (`ctx.deniedGroupIds` etc, resolved once in `buildAccessContext`) —
            // the SAME value feeds the query below AND the cache key.
            const access = restrictedAccess({
                deniedGroupIds: ctx.deniedGroupIds ?? [],
                maxAgeRating: ctx.maxAgeRating,
                allowUnrated: ctx.allowUnrated,
            });

            const watchedTmdbIds = readWatchedTmdbIds(opts);

            const damper = await getTasteDamperService(sql).getDamperContext(ctx.userId);

            // Computed once per request; feeds both the cache key and the query.
            const { kids: suppressKidsContent, anime: suppressAnimeContent } =
                await shouldSuppressContent(sql, {
                    userId: ctx.userId,
                    isAgeRestricted: ctx.isAgeRestricted,
                });
            const suppressTag = `supK${suppressKidsContent ? 1 : 0}A${suppressAnimeContent ? 1 : 0}`;

            const CACHE_FETCH_SIZE = 40;

            // The cache is bound to BOTH the search context (locale / livetv /
            // lib-only, folded via scopedCacheKey) AND the query boundary (the
            // `denyAll` distinction the search context cannot express), plus the
            // per-user partition (`ctx.userId`). `searchScopedCacheWithBoundary`
            // folds all three into the key internally — byte-identical to the
            // previous `${scopedCacheKey(...)}|${boundaryCacheKey(access)}`
            // hand-concat read under `cache.get(key, ctx.userId)`. There is no
            // method here that accepts a pre-formed key, so the access token
            // cannot be dropped by accident.
            const shortMoviesCache = searchScopedCacheWithBoundary(
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
                ctx.userId,
            );
            // v6: fetchShortMovies now caps per availability class (both in SQL
            // and the post-shuffle JS truncation) instead of a blind slice —
            // cached payload composition changed.
            const cacheBase = `short-movies:user:v6:${damper?.hash ?? 'nd'}:${suppressTag}`;

            // Single-flight: collapse concurrent TTL-expiry misses to one
            // (embedding-damped) DB query. Mirrors BingeWorthyStrategy. Query
            // SHAPE is unchanged — the wrapper only wraps the miss compute and
            // reproduces the previous raw L2 key `${ns.name}:${userId}:${key}`.
            let shortMovies = await shortMoviesCache.getOrComputeSingleFlight<
                Awaited<ReturnType<typeof fetchShortMovies>>
            >(cacheBase, undefined, () =>
                fetchShortMovies(sql, CACHE_FETCH_SIZE, ctx.userId, watchedTmdbIds, access, {
                    suppressKids: suppressKidsContent,
                    suppressAnime: suppressAnimeContent,
                    damper,
                }),
            );

            const watchedTmdbSet = new Set(watchedTmdbIds);
            let serverWatchedUuidSet = new Set<string>();
            try {
                serverWatchedUuidSet = new Set(
                    await watchManager.getWatchedMediaIdsCached(ctx.userId),
                );
            } catch (e) {
                logger.warn('Failed to fetch server-side watched UUIDs', { error: e });
            }

            if (watchedTmdbSet.size > 0 || serverWatchedUuidSet.size > 0) {
                shortMovies = shortMovies.filter((item) => {
                    const internalId = getExternalIdFor(item.externalIds, 'internal');
                    if (internalId && serverWatchedUuidSet.has(internalId)) {
                        return false;
                    }
                    if (watchedTmdbSet.size > 0) {
                        const tmdbNum = Number.parseInt(
                            getExternalIdFor(item.externalIds, 'tmdb') || '0',
                        );
                        if (
                            !Number.isNaN(tmdbNum) &&
                            tmdbNum !== 0 &&
                            watchedTmdbSet.has(tmdbNum)
                        ) {
                            return false;
                        }
                    }
                    return true;
                });
            }

            if (!ctx.showUnavailableMedia || opts.availableOnly) {
                shortMovies = shortMovies.filter((item) => item.isAvailable);
            }

            const result = mapBatch(
                shortMovies as Array<{
                    externalIds: (typeof shortMovies)[0]['externalIds'];
                    mediaType: string;
                    title: string;
                    imdbRating?: number | null;
                }>,
                opts.limit,
                'for-you',
                opts.surface,
                (item) => (item.imdbRating != null ? item.imdbRating / 10 : undefined),
            );
            await hydrateRailMetadata(sql, result.items);
            return result;
        } catch (err) {
            if (isDependencyUnavailable(err)) throw err;
            logger.error('ShortMoviesStrategy fetch error', err as Error);
            return { items: [], hasMore: false };
        }
    }
}

export const shortMoviesStrategy = new ShortMoviesStrategy();
