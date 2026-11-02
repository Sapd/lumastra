// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';
import { Logger } from '$lib/server/utils/logger';
import { boundaryCacheKey } from '$lib/server/database/queries/builders/media-access-boundary';
import {
    computeGenrePlan,
    type GenrePlanInput,
} from '$lib/server/services/music/genre-plan.service';

const logger = Logger.for('GenrePlanCached');

/**
 * Cache key is the JSON-encoded sorted list of genre names. If the user
 * pins a different genre set between navigations the plan invalidates
 * naturally — a new key means a cache miss, which triggers a rebuild.
 * This avoids explicit invalidation logic for the pin/unpin case.
 *
 * JSON.stringify is used instead of a `|`-separated join so genre names
 * that themselves contain a pipe (e.g. 'Rock|Metal') don't collide with
 * multi-genre keys like ['Rock', 'Metal'].
 *
 * The first element is the viewer's access boundary: the entry is already
 * per user, but a group or age-limit change must not keep serving a plan
 * drawn under the old boundary for the rest of the TTL.
 */
function buildPlanKey(input: GenrePlanInput): string {
    return JSON.stringify([
        boundaryCacheKey(input.access),
        ...[...input.genreCarouselNames].sort(),
    ]);
}

/**
 * Post-filter a cached plan against the current exclusion set.
 *
 * The cache key is derived only from genre names, so between the cache
 * write and a subsequent hit the user may have played more tracks or
 * Quick Picks may have shuffled. Without this filter the cached plan
 * could surface a track that also appears in Recently Played or Quick
 * Picks on the same page — breaking the cross-section dedup invariant
 * established in Phase 2.
 *
 * On cache miss this is unnecessary (the fresh plan is already built
 * with the current exclusions), so it's only applied on hit.
 */
function filterStaleExclusions(
    plan: Record<string, string[]>,
    currentExcludes: string[],
): Record<string, string[]> {
    if (currentExcludes.length === 0) return plan;
    const excludeSet = new Set(currentExcludes);
    const filtered: Record<string, string[]> = {};
    for (const [genre, ids] of Object.entries(plan)) {
        filtered[genre] = ids.filter((id) => !excludeSet.has(id));
    }
    return filtered;
}

/**
 * Cached wrapper around computeGenrePlan.
 *
 * - Cache hit: returns the stored plan (post-filtered against the current
 *   exclusion set), skipping 8 getTracksByGenre queries.
 * - Cache miss: runs the pure computeGenrePlan, writes to cache, returns.
 * - Cache-layer failures (Valkey down, serialization error): falls through
 *   to the underlying call so the page still loads.
 *
 * The 3-min L2 TTL is the accepted staleness budget per the design spec.
 * Users see a slightly stale plan for up to 3 min after a play — the same
 * trade-off Quick Picks accepts.
 *
 * An empty or whitespace-only userId bypasses the cache entirely. Both
 * UnifiedCache's buildL2Key and LRUCache's getKey treat falsy userId as
 * "no user" and key the entry at namespace scope, which would allow one
 * empty-user entry to be read by another empty-user caller. Bypassing
 * avoids any chance of cross-user data leakage via that degradation.
 */
export async function computeGenrePlanCached(
    sql: postgres.Sql,
    userId: string,
    input: GenrePlanInput,
): Promise<Record<string, string[]>> {
    if (input.genreCarouselNames.length === 0) {
        return {};
    }

    if (!userId || userId.trim().length === 0) {
        return computeGenrePlan(sql, userId, input);
    }

    const cache = cacheManager.for(CACHE_NAMESPACES.musicGenrePlan);
    const key = buildPlanKey(input);

    try {
        const cached = await cache.get<Record<string, string[]>>(key, userId);
        if (cached !== null) {
            logger.debug('genre-plan cache hit', {
                userId,
                genres: input.genreCarouselNames.length,
            });
            return filterStaleExclusions(cached, input.recentlyPlayedIds);
        }
    } catch (err) {
        logger.warn('genre-plan cache read failed; falling through', {
            userId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    const plan = await computeGenrePlan(sql, userId, input);

    try {
        await cache.set(key, plan, undefined, userId);
    } catch (err) {
        logger.warn('genre-plan cache write failed', {
            userId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    return plan;
}
