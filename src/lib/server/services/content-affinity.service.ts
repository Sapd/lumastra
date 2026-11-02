// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ContentAffinityService — per-user "content cluster affinity" signal.
 *
 * Purpose: the For-You mood rails soft-suppress content clusters (kids/family,
 * anime) for users who don't engage with them; users who DO engage with a
 * cluster regularly keep seeing it. This module owns ONLY the signal (derived
 * from the user's own watch/rating history) — wiring it into a recommendation
 * query's ranking/filtering is the caller's responsibility.
 *
 * Age-restricted (kid) accounts are a SEPARATE concern handled by the caller
 * via `SearchAccessContext` — this service only looks at engagement history,
 * and only for the kids cluster (anime has no age-restriction exemption).
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { Logger } from '$lib/server/utils/logger';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';
import {
    getClusterWatchCounts,
    type ClusterWatchCounts,
} from '$lib/server/database/queries/content-affinity.queries';
import { MOOD_PROFILES } from '$lib/server/services/mood-profiles';

const logger = Logger.for('ContentAffinityService');

// =============================================================================
// Cache
// =============================================================================

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

const contentAffinityCache = cacheManager.for(CACHE_NAMESPACES.contentAffinity);

function cacheKeyFor(userId: UserId): string {
    return `v1:content-affinity:${userId}`;
}

// =============================================================================
// Pure logic
// =============================================================================

/** Minimum number of distinct kids/family engagements required before the ratio is trusted. */
const MIN_KIDS_COUNT = 2;
/** Minimum share of engagements that must be kids/family content. */
const MIN_KIDS_RATIO = 0.15;
/**
 * Minimum number of distinct anime engagements required. More liberal than
 * kids (no ratio gate) by design — anime is a distinct-taste cluster, so any
 * real engagement means don't suppress.
 */
const MIN_ANIME_COUNT = 2;

export interface ClusterAffinity {
    kids: boolean;
    anime: boolean;
}

/**
 * Decide whether a user "welcomes" each content cluster based on their own
 * engagement counts.
 *
 * - kids: `kidsCount >= 2` AND the kids share of total engagement is
 *   `>= 0.15`. A `totalCount` of 0 always returns false (nothing to base an
 *   affinity on).
 * - anime: `animeCount >= 2`, no ratio gate.
 */
export function computeClusterAffinity(counts: ClusterWatchCounts): ClusterAffinity {
    const { kidsCount, animeCount, totalCount } = counts;
    const kids =
        totalCount > 0 && kidsCount >= MIN_KIDS_COUNT && kidsCount / totalCount >= MIN_KIDS_RATIO;
    const anime = animeCount >= MIN_ANIME_COUNT;
    return { kids, anime };
}

// =============================================================================
// Cached wrapper
// =============================================================================

/**
 * Per-cluster affinity for the given user, based on their recent watch
 * history + ratings. Cached for 6 hours under a single key
 * (`v1:content-affinity:${userId}`) since it is derived from slow-moving
 * history, not real-time state.
 *
 * Fails toward suppression: any query error is logged and swallowed, returning
 * `{ kids: false, anime: false }` (uncached) rather than throwing — this
 * signal must never break a For-You recommendations request.
 */
export async function getUserClusterAffinity(
    sql: postgres.Sql,
    userId: UserId,
): Promise<ClusterAffinity> {
    const cacheKey = cacheKeyFor(userId);
    const cached = await contentAffinityCache.get<ClusterAffinity>(cacheKey);
    if (cached !== null) return cached;

    let counts: ClusterWatchCounts;
    try {
        counts = await getClusterWatchCounts(sql, userId);
    } catch (error) {
        logger.error(
            'Failed to compute content cluster affinity — defaulting to suppressed',
            error instanceof Error ? error : new Error(String(error)),
            { userId },
        );
        return { kids: false, anime: false };
    }

    const result = computeClusterAffinity(counts);
    await contentAffinityCache.set(cacheKey, result, CACHE_TTL_MS);
    return result;
}

// =============================================================================
// Decision rule
// =============================================================================

/**
 * TMDB genre ids that mark a mood profile as INTENTIONALLY including kids/
 * family content (Animation, Family, Kids). Distinct from
 * {@link KIDS_GENRE_IDS} in content-affinity.queries (which is used to score a
 * candidate ITEM's own genres) — this list decides whether a given MOOD is
 * allowed to surface kids content on purpose (e.g. cozy, nostalgic).
 */
const KIDS_ADJACENT_MOOD_GENRE_IDS = [16, 10751, 10762];

/**
 * TMDB genre ids that mark a mood profile as INTENTIONALLY including anime
 * (Animation). Moods like cozy/nostalgic/visuallystunning positively include
 * genre 16, so anime should never be suppressed for those rails.
 */
const ANIME_MOOD_EXEMPT_GENRE_IDS = [16];

export interface ShouldSuppressContentParams {
    /** The requesting user, or null for an anonymous/unresolvable caller. */
    userId: UserId | null;
    /** Age-restricted (kid) accounts are never kids-suppressed — see module docs. */
    isAgeRestricted: boolean;
    /** Mood key driving the current rail, if any. */
    moodKey?: string | null;
}

/**
 * Decide whether a For-You rail should soft-suppress each content cluster
 * (kids/family, anime) for this request.
 *
 * Kids — order of precedence:
 * 1. Age-restricted (kid) accounts → never suppress.
 * 2. The `familynight` mood is intentionally kids-oriented → never suppress.
 * 3. Any other mood whose profile positively includes an Animation/Family/Kids
 *    genre (e.g. cozy, nostalgic, relaxing, eveningchill) → never suppress
 *    (the mood author already opted in).
 * 4. Otherwise, suppress unless the user's own engagement history shows they
 *    welcome kids content. A caller with no resolvable `userId` is suppressed
 *    (nothing to base an exception on).
 *
 * Anime — order of precedence (no age-restriction exemption; `familynight`
 * already includes genre 16, so it's covered by rule 1 below):
 * 1. A mood profile positively including Animation (genre 16) → never
 *    suppress (e.g. cozy, nostalgic, visuallystunning, familynight).
 * 2. Otherwise, suppress unless the user's own engagement history shows they
 *    welcome anime. A caller with no resolvable `userId` is suppressed.
 */
export async function shouldSuppressContent(
    sql: postgres.Sql,
    params: ShouldSuppressContentParams,
): Promise<ClusterAffinity> {
    const { userId, isAgeRestricted, moodKey } = params;

    const profile = moodKey ? MOOD_PROFILES[moodKey] : undefined;

    const kidsExempt =
        isAgeRestricted ||
        moodKey === 'familynight' ||
        !!profile?.genres.some((g) => KIDS_ADJACENT_MOOD_GENRE_IDS.includes(g));

    const animeExempt = !!profile?.genres.some((g) => ANIME_MOOD_EXEMPT_GENRE_IDS.includes(g));

    if (kidsExempt && animeExempt) {
        return { kids: false, anime: false };
    }

    if (!userId) {
        return { kids: !kidsExempt, anime: !animeExempt };
    }

    const affinity = await getUserClusterAffinity(sql, userId);
    return {
        kids: kidsExempt ? false : !affinity.kids,
        anime: animeExempt ? false : !affinity.anime,
    };
}
