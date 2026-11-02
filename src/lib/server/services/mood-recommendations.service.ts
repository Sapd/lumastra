// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MoodRecommendationsService
 *
 * Thin service wrapper used by the D7 MoodStrategy (recommendations/strategies/mood.strategy.ts).
 * Bridges the new recommender abstraction to the existing keyword/genre mood queries.
 *
 * This service owns the mood-profile lookup table (keywords + genres, no i18n) and
 * adapts MoodMediaRow → the neutral shape the strategy consumes.
 */

import type { Sql } from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';
import type { SearchAccessContext } from '$lib/server/utils/search-access-context.js';
import { searchAccessBoundary } from '$lib/server/utils/search-access-context.js';
import {
    findMoodMedia,
    findMoodMediaPersonalized,
    type MoodQueryProfile,
} from '$lib/server/database/queries/mood-recommendations.queries.js';
import { MOOD_PROFILES } from '$lib/server/services/mood-profiles.js';
import { shouldSuppressContent } from '$lib/server/services/content-affinity.service.js';
import { getTasteDamperService } from '$lib/server/services/taste-damper.service.js';

// =============================================================================
// Profile data (keyword/genre rules only — no i18n)
// =============================================================================

// Re-exported so the /api/v1/recommendations OpenAPI query schema's `mood`
// enum can be tested against this list directly — the two must never drift
// (that drift is exactly what left `mood` undocumented in the spec despite
// the server always having required it). Source data lives in
// $lib/server/services/mood-profiles.ts, shared with the
// /api/mood-recommendations route.
export { MOOD_PROFILES };

/**
 * TTL for a mood that resolved to zero items. Far below the namespace's 30min
 * default so an empty rail on a scanning/enriching library self-heals fast.
 */
const EMPTY_RESULT_TTL_MS = 60 * 1000;

// =============================================================================
// Return type
// =============================================================================

export interface MoodRecommendationItem {
    /** Camelcase media type matching what the strategy expects. */
    mediaType: 'movie' | 'tv';
    /** Display title. */
    title: string;
    /** Release year extracted from release_date, or null. */
    year: number | null;
    /** Cosine similarity score, or null for non-personalised results. */
    similarity: number | null;
    /**
     * External IDs as a plain object (provider → id-string).
     * 'internal' key carries the internal UUID so strategies can build
     * a canonical reference without a separate field.
     */
    externalIds: Record<string, string>;
    /** Fallback UUID (same as externalIds['internal'] when present). */
    media_id: string;
    /**
     * Whether the item is present in the library (`media_items.has_files`).
     * The mood SQL includes requestable (has_files=false) items via
     * `WHERE (is_available = true OR can_request = true)`, so this must be
     * carried through or request-only titles render as watchable.
     */
    isAvailable: boolean;
    /** Whether the item is requestable (not available and eligible to request). */
    canRequest: boolean;
}

// =============================================================================
// Public API
// =============================================================================

export interface GetMoodRecommendationsParams {
    userId: UserId;
    mood: string;
    mediaType?: 'movie' | 'tv' | string | null;
    limit: number;
    genre?: string | null;
    accessCtx: SearchAccessContext;
    /** Age-restricted (kid) accounts are never kids-content-suppressed. */
    isAgeRestricted?: boolean;
    /** Bypass the cache and recompute (the `?refresh=true` escape hatch). */
    refresh?: boolean;
}

/**
 * Fetch mood-based recommendations for the given user + mood key.
 *
 * Returns items in the shape expected by MoodStrategy. Falls back gracefully
 * when the mood key is unrecognised or the database returns nothing.
 */
export async function getMoodRecommendations(
    sql: Sql,
    params: GetMoodRecommendationsParams,
): Promise<MoodRecommendationItem[]> {
    const {
        userId,
        mood,
        mediaType,
        limit,
        accessCtx,
        isAgeRestricted = false,
        refresh = false,
    } = params;

    const profile = MOOD_PROFILES[mood];
    if (!profile) {
        return [];
    }

    // Single source of truth for this request's access boundary. Passed as ONE
    // value to every mood query below — previously `deniedGroupIds`/`ageRating`
    // were spread field-by-field into three call sites, which is the
    // drop-an-argument failure mode the boundary type exists to remove.
    const access = searchAccessBoundary(accessCtx);

    const { kids: suppressKidsContent, anime: suppressAnimeContent } = await shouldSuppressContent(
        sql,
        {
            userId,
            isAgeRestricted,
            moodKey: mood,
        },
    );

    const queryProfile: MoodQueryProfile = {
        keywords: profile.keywords,
        genres: profile.genres,
        excludeGenres: profile.excludeGenres,
        excludeKeywords: profile.excludeKeywords,
        minRuntime: profile.minRuntime,
        maxRuntime: profile.maxRuntime,
        minRating: profile.minRating,
        maxRating: profile.maxRating,
        maxPopularity: profile.maxPopularity,
        minPopularity: profile.minPopularity,
        minYear: profile.minYear,
        maxYear: profile.maxYear,
    };

    const narrowedMediaType: 'movie' | 'tv' | undefined =
        mediaType === 'movie' || mediaType === 'tv' ? mediaType : undefined;

    // -------------------------------------------------------------------------
    // Cache
    // -------------------------------------------------------------------------
    // The mood queries are the most expensive read in the recommender (a
    // ~1s full keyword/genre evaluation on prod even after the candidate-
    // prefilter rewrite), and until now ONLY the legacy /api/mood-recommendations
    // web route cached them — the v1 strategy that tvOS calls recomputed on
    // every home load and every mood-pill tap. Caching here, at the seam where
    // the damper/suppression inputs are already resolved, covers both callers.
    //
    // Cached payload is the PRE-MAP service row, never a mapped
    // RecommendationItem — the translation overlay in runRecommender mutates
    // mapped items in place and UnifiedCache's L1 hands back the live object
    // reference, so caching post-map items would permanently localize the
    // entry (recommender.ts §"INVARIANT"). MoodStrategy re-maps on every hit.
    const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache/index.js');
    const { scopedCacheKey } = await import('$lib/server/utils/search-access-context.js');
    const moodCache = cacheManager.for(CACHE_NAMESPACES.moodRecommendations);

    // Every input that changes the result set must be in the key: the damper
    // hash and the suppression flags feed the ORDER BY / penalty terms, and
    // `limit` is baked into the SQL (callers over-fetch limit+1), so a smaller
    // cached page must never satisfy a larger request.
    const damperForKey = await getTasteDamperService(sql).getDamperContext(userId);
    const damperTag = damperForKey?.hash ?? 'nd';
    const suppressTag = `supK${suppressKidsContent ? 1 : 0}A${suppressAnimeContent ? 1 : 0}`;
    const cacheKey = scopedCacheKey(
        `v1:mood-svc:${userId}:${mood}:${narrowedMediaType ?? 'all'}:${limit}:${damperTag}:${suppressTag}`,
        accessCtx,
    );

    if (!refresh) {
        // `userId` is passed as the cache's user scope (NOT just embedded in the
        // key string) so `deleteUserCache(userId)` can purge this namespace on
        // rating changes — see cacheInvalidation.onUserRating.
        const cached = await moodCache
            .get<{ items: MoodRecommendationItem[] }>(cacheKey, userId)
            .catch(() => null);
        if (cached) return cached.items;
    }

    // Try personalized path; fall back to non-personalized on any error
    let rows;
    // Only the personalized query produces a real cosine similarity; the
    // non-personalized variant returns a constant 0.5 placeholder that must
    // not surface as a match score.
    let hasRealSimilarity = false;
    // Set when the personalized attempt THREW and we silently degraded to the
    // non-personalized query. That degraded answer must never be cached: it
    // would pin similarity-less results for the whole TTL on the strength of
    // one transient DB error. (The `else` branch below — user genuinely has no
    // embedding — is NOT a degradation and stays cacheable.)
    let degradedToFallback = false;
    try {
        const [userProfile] = await sql<{ catalog_embedding: unknown }[]>`
			SELECT catalog_embedding
			FROM user_profiles
			WHERE user_id = ${userId}
			AND catalog_embedding IS NOT NULL
			LIMIT 1
		`;
        if (userProfile?.catalog_embedding) {
            // "Show less like this": findMoodMediaPersonalized already applies
            // the damper penalty in its ORDER BY (buildDamperPenalty against
            // jellyfin_embedding) — it just needs the active context, which
            // was previously never supplied here, so the penalty was always
            // inert (damper = null → 0 penalty).
            // Reuses the context already fetched for the cache key above, so
            // the key and the query can never disagree about the damper.
            const damper = damperForKey;
            rows = await findMoodMediaPersonalized(sql, {
                profile: queryProfile,
                mediaType: narrowedMediaType,
                userId,
                limit,
                access,
                damper,
                suppressKidsContent,
                suppressAnimeContent,
            });
            hasRealSimilarity = true;
        } else {
            rows = await findMoodMedia(sql, {
                profile: queryProfile,
                mediaType: narrowedMediaType,
                userId,
                limit,
                access,
                suppressKidsContent,
                suppressAnimeContent,
            });
        }
    } catch {
        degradedToFallback = true;
        rows = await findMoodMedia(sql, {
            profile: queryProfile,
            mediaType: narrowedMediaType,
            userId,
            limit,
            access,
            suppressKidsContent,
            suppressAnimeContent,
        });
    }

    const items: MoodRecommendationItem[] = (rows ?? []).map((row): MoodRecommendationItem => {
        const internalId = row.internal_id ?? '';
        const extIds: Record<string, string> = {};
        if (internalId) extIds['internal'] = internalId;
        if (row.primary_ext_id) extIds['tmdb'] = row.primary_ext_id;

        let year: number | null = null;
        if (row.release_date) {
            const d = new Date(row.release_date);
            if (!Number.isNaN(d.getFullYear())) {
                year = d.getFullYear();
            }
        }

        return {
            mediaType: row.media_type,
            title: row.title,
            year,
            similarity: hasRealSimilarity ? (row.ai_similarity ?? null) : null,
            externalIds: extIds,
            media_id: internalId,
            isAvailable: row.is_available ?? false,
            canRequest: row.can_request ?? false,
        };
    });

    if (!degradedToFallback) {
        // An empty rail gets a much shorter TTL than a populated one. Empty is
        // usually transient — a library still scanning, or metadata not yet
        // enriched — and pinning it for the full 30min would keep freshly
        // scanned titles invisible long after they landed. Short enough to
        // self-heal quickly, long enough to still absorb a burst of rail loads.
        const ttl = items.length === 0 ? EMPTY_RESULT_TTL_MS : undefined;
        // Best-effort write: a cache outage must degrade to "slow", never to a
        // failed request.
        await moodCache.set(cacheKey, { items }, ttl, userId).catch(() => undefined);
    }

    return items;
}
