// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FreshReleasesStrategy — recently released, library-available content.
 *
 * Folds the legacy `GET /api/for-you/fresh-releases` rail. Backed by
 * `fetchFreshReleases` (for-you.service); global curated cache; reason kind
 * 'trending', score = rating/10.
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

const logger = Logger.for('FreshReleasesStrategy');

export class FreshReleasesStrategy implements RecommenderStrategy {
    readonly id = 'fresh-releases';
    readonly label = m.section_fresh_releases;

    async fetch(ctx: AccessContext, opts: RecommenderOptions): Promise<RecommenderResult> {
        try {
            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) throw new DependencyUnavailableError('Database unavailable', 'postgres');

            const { fetchFreshReleases } = await import('$lib/server/services/for-you.service.js');
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

            const watchedTmdbIds = readWatchedTmdbIds(opts);

            const CACHE_FETCH_SIZE = 50;

            // Bind the cache to BOTH the search context (locale/livetv/lib-only)
            // AND the real query boundary (`access`). The wrapper folds both into
            // the key internally — byte-identical to the previous
            // `${scopedCacheKey('fresh-releases:global:v2', …)}|${boundaryCacheKey(access)}`
            // hand-concat — so the ONE boundary that filters the query also
            // partitions the cache, and a denyAll/denyGroups/all boundary can never
            // collide. There is no method here that accepts a pre-formed key, so the
            // access token cannot be dropped by accident. getOrComputeSingleFlight
            // absorbs the raw-L2-key + JSON round-trip + L1 promotion the call site
            // used to hand-roll.
            const freshReleasesCache = searchScopedCacheWithBoundary(
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

            // Single-flight: collapse concurrent TTL-expiry misses to one DB query.
            let freshReleases = await freshReleasesCache.getOrComputeSingleFlight<
                Awaited<ReturnType<typeof fetchFreshReleases>>
            >('fresh-releases:global:v2', undefined, () =>
                fetchFreshReleases(sql, CACHE_FETCH_SIZE, [], access),
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
                freshReleases = freshReleases.filter((item) => {
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

            // Dislike exclusion is per-user, but the rail cache above is GLOBAL
            // (access-scoped) — so it must run AFTER the shared cache read, like
            // the watched filter, never inside the cached compute.
            if (ctx.userId) {
                const { excludeDislikedFreshReleases } =
                    await import('$lib/server/services/for-you.service.js');
                const { getDislikedMediaIds } =
                    await import('$lib/server/database/queries/for-you-helpers.queries.js');
                const disliked = await getDislikedMediaIds(sql, ctx.userId);
                if (disliked.length > 0) {
                    freshReleases = excludeDislikedFreshReleases(freshReleases, new Set(disliked));
                }
            }

            if (!ctx.showUnavailableMedia || opts.availableOnly) {
                freshReleases = freshReleases.filter((item) => item.isAvailable);
            }

            const result = mapBatch(
                freshReleases as Array<{
                    externalIds: (typeof freshReleases)[0]['externalIds'];
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
            logger.error('FreshReleasesStrategy fetch error', err as Error);
            return { items: [], hasMore: false };
        }
    }
}

export const freshReleasesStrategy = new FreshReleasesStrategy();
