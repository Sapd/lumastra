// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BingeWorthyStrategy — highly-rated series good for binge watching.
 *
 * Folds the legacy `GET /api/for-you/binge-worthy` rail. Backed by
 * `fetchBingeWorthySeries` (for-you.service); user-scoped curated cache;
 * reason kind 'for-you', score = rating/10.
 *
 * Watched exclusion combines three sources: client `watched=` TMDB ids
 * (opts.extra.watchedTmdbIds), client `watchedIds=` UUIDs
 * (opts.extra.watchedUuids) and the server-side watch state for ctx.userId.
 * DB DOWN → DependencyUnavailableError.
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
import { readWatchedTmdbIds, readWatchedUuids } from './rail-extra.js';
import { m } from '$lib/paraglide/messages.js';

const logger = Logger.for('BingeWorthyStrategy');

export class BingeWorthyStrategy implements RecommenderStrategy {
    readonly id = 'binge-worthy';
    readonly label = m.section_binge_worthy;

    async fetch(ctx: AccessContext, opts: RecommenderOptions): Promise<RecommenderResult> {
        try {
            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) throw new DependencyUnavailableError('Database unavailable', 'postgres');

            const { fetchBingeWorthySeries } =
                await import('$lib/server/services/for-you.service.js');
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

            const watchedIds = readWatchedUuids(opts);
            const watchedTmdbIds = readWatchedTmdbIds(opts);

            const damper = await getTasteDamperService(sql).getDamperContext(ctx.userId);

            // Computed once per request; feeds both the cache key and the query.
            const { kids: suppressKidsContent, anime: suppressAnimeContent } =
                await shouldSuppressContent(sql, {
                    userId: ctx.userId,
                    isAgeRestricted: ctx.isAgeRestricted,
                    moodKey: null,
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
                ctx.userId,
            );
            const cacheBase = `v7:binge-worthy:user:${damper?.hash ?? 'nd'}:${suppressTag}`;

            // Single-flight: collapse concurrent TTL-expiry misses to one DB query.
            // The wrapper's getOrComputeSingleFlight absorbs the raw-L2-key
            // (`${ns.name}:${userId}:${key}`) + JSON round-trip + L1 promotion the
            // call site used to hand-roll.
            let bingeWorthy = await curatedCache.getOrComputeSingleFlight<
                Awaited<ReturnType<typeof fetchBingeWorthySeries>>
            >(cacheBase, undefined, () =>
                fetchBingeWorthySeries(sql, CACHE_FETCH_SIZE, watchedTmdbIds, ctx.userId, access, {
                    suppressKids: suppressKidsContent,
                    suppressAnime: suppressAnimeContent,
                    damper,
                }),
            );

            const watchedUuidSet = new Set(watchedIds);
            const watchedTmdbSet = new Set(watchedTmdbIds);
            let serverWatchedUuidSet = new Set<string>();
            try {
                serverWatchedUuidSet = new Set(
                    await watchManager.getWatchedMediaIdsCached(ctx.userId),
                );
            } catch (e) {
                logger.warn('Failed to fetch server-side watched UUIDs', { error: e });
            }

            if (
                watchedUuidSet.size > 0 ||
                watchedTmdbSet.size > 0 ||
                serverWatchedUuidSet.size > 0
            ) {
                bingeWorthy = bingeWorthy.filter((item) => {
                    const internalId = getExternalIdFor(item.externalIds, 'internal');
                    if (
                        internalId &&
                        (watchedUuidSet.has(internalId) || serverWatchedUuidSet.has(internalId))
                    ) {
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
                bingeWorthy = bingeWorthy.filter((item) => item.isAvailable);
            }

            const result = mapBatch(
                bingeWorthy as Array<{
                    externalIds: (typeof bingeWorthy)[0]['externalIds'];
                    mediaType: string;
                    title: string;
                    rating: number;
                    year?: number | null;
                }>,
                opts.limit,
                'for-you',
                opts.surface,
                (item) => (item.rating ? item.rating / 10 : undefined),
            );
            await hydrateRailMetadata(sql, result.items);
            return result;
        } catch (err) {
            if (isDependencyUnavailable(err)) throw err;
            logger.error('BingeWorthyStrategy fetch error', err as Error);
            return { items: [], hasMore: false };
        }
    }
}

export const bingeWorthyStrategy = new BingeWorthyStrategy();
