// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AnimeStrategy — anime recommendations with AI personalisation + taste damper.
 *
 * Folds the legacy `GET /api/for-you/anime` rail. Backed by
 * `fetchAnimeRecommendations` (for-you.service) with the taste-damper context
 * folded in; user-scoped curated cache; reason kind 'ai', score =
 * aiSimilarity/100.
 *
 * AGE GATE: anime is unavailable to age-restricted profiles. The canonical 403
 * is enforced at the route (it has the request principal); this strategy keeps
 * a defensive early-return of empty for age-restricted callers so /feed and any
 * direct caller can never leak anime to a restricted profile.
 *
 * Watched exclusion combines client `watched=` TMDB ids + `watchedIds=` UUIDs
 * (opts.extra) with the server-side watch state. Disliked items (rating <= 4,
 * see `getDislikedMediaIds`) are excluded the same way — a fresh per-request
 * lookup applied after the cached `anime` payload is read, so a rating
 * recorded after the cache was populated still takes effect immediately. DB
 * DOWN → DependencyUnavailableError.
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

const logger = Logger.for('AnimeStrategy');

export class AnimeStrategy implements RecommenderStrategy {
    readonly id = 'anime';
    readonly label = m.section_anime_for_you;

    async fetch(ctx: AccessContext, opts: RecommenderOptions): Promise<RecommenderResult> {
        try {
            // Defensive: never serve anime to age-restricted profiles. The route
            // returns the canonical 403 before dispatch; this guards /feed too.
            if (ctx.isAgeRestricted) return { items: [], hasMore: false };

            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) throw new DependencyUnavailableError('Database unavailable', 'postgres');

            const { fetchAnimeRecommendations } =
                await import('$lib/server/services/for-you.service.js');
            const { getTasteDamperService } =
                await import('$lib/server/services/taste-damper.service.js');
            const { watchManager } = await import('$lib/server/services/watch-manager.service.js');
            const { getExternalIdFor } = await import('$lib/utils/external-ids.js');
            const { CACHE_NAMESPACES, searchScopedCacheWithBoundary } =
                await import('$lib/server/cache/index.js');
            const { restrictedAccess } =
                await import('$lib/server/database/queries/builders/media-access-boundary.js');

            // Access boundary built directly from the request's REAL access facts
            // (`ctx.deniedGroupIds` etc, resolved once in `buildAccessContext`) —
            // the SAME value feeds the query below AND the cache key, so a
            // restricted user's rail can never be filtered under one boundary and
            // cached under another.
            const access = restrictedAccess({
                deniedGroupIds: ctx.deniedGroupIds ?? [],
                maxAgeRating: ctx.maxAgeRating,
                allowUnrated: ctx.allowUnrated,
            });

            const watchedIds = readWatchedUuids(opts);
            const watchedTmdbIds = readWatchedTmdbIds(opts);

            const damper = await getTasteDamperService(sql).getDamperContext(ctx.userId);

            const CACHE_FETCH_SIZE = 40;
            // v8: fetchAnimeRecommendations now caps per availability class (both
            // in SQL and the post-shuffle JS truncation) instead of a blind slice
            // — cached payload composition changed.
            //
            // `searchScopedCacheWithBoundary` binds the cache to BOTH the request's
            // search context (username/denied-groups/age/livetv/showUnavailable)
            // AND the query boundary, then folds both into the key internally —
            // byte-identical to the previous
            // `${scopedCacheKey(...)}|${boundaryCacheKey(access)}` hand-concat. The
            // `ctx.userId` argument threads the per-user partition through every
            // read/write and the single-flight L2 key, preserving the old
            // `cache.get(key, ctx.userId)` scoping. There is no method here that
            // accepts a pre-formed key, so the access token cannot be dropped by
            // accident.
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
            const cacheBase = `anime:user:v8:${damper?.hash ?? 'nd'}`;

            // Single-flight: collapse concurrent TTL-expiry misses to one DB query,
            // then promote into L1. The wrapper serialises the computed payload for
            // the single-flight substrate and parses it back — same JSON round-trip
            // the old hand-rolled block performed.
            let anime = await curatedCache.getOrComputeSingleFlight<
                Awaited<ReturnType<typeof fetchAnimeRecommendations>>
            >(cacheBase, undefined, async () =>
                fetchAnimeRecommendations(
                    sql,
                    CACHE_FETCH_SIZE,
                    ctx.userId,
                    watchedTmdbIds,
                    null,
                    // Whole boundary, not just the library axis. The AGE axis is
                    // deliberately not applied by this rail (see
                    // fetchAnimeRecommendations) — the age filter is computed here
                    // and silently dropped because the signature had no slot for
                    // it. It is handed over and ignored in one documented place.
                    access,
                    damper,
                ),
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
                anime = anime.filter((item) => {
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

            // Disliked exclusion (rating <= 4): same post-cache idiom as the
            // watched filter above — fetched fresh every call so a rating
            // recorded after the cached `anime` payload was populated is
            // reflected immediately, without needing to invalidate the cache.
            let dislikedIdSet = new Set<string>();
            try {
                const { getDislikedMediaIds } =
                    await import('$lib/server/database/queries/for-you-helpers.queries.js');
                dislikedIdSet = new Set(await getDislikedMediaIds(sql, ctx.userId));
            } catch (e) {
                logger.warn('Failed to fetch disliked media ids', { error: e });
            }

            if (dislikedIdSet.size > 0) {
                anime = anime.filter((item) => {
                    const internalId = getExternalIdFor(item.externalIds, 'internal');
                    return !(internalId && dislikedIdSet.has(internalId));
                });
            }

            if (!ctx.showUnavailableMedia || opts.availableOnly) {
                anime = anime.filter((item) => item.isAvailable);
            }

            const result = mapBatch(
                anime as Array<{
                    externalIds: (typeof anime)[0]['externalIds'];
                    mediaType: string;
                    title: string;
                    aiSimilarity?: number | null;
                }>,
                opts.limit,
                'ai',
                opts.surface,
                (item) =>
                    item.aiSimilarity != null ? Math.min(item.aiSimilarity / 100, 1) : undefined,
            );
            await hydrateRailMetadata(sql, result.items);
            return result;
        } catch (err) {
            if (isDependencyUnavailable(err)) throw err;
            logger.error('AnimeStrategy fetch error', err as Error);
            return { items: [], hasMore: false };
        }
    }
}

export const animeStrategy = new AnimeStrategy();
