// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Suggestion Engine Service
 *
 * Handles the complete suggestion generation pipeline:
 * - Extract user embeddings from profiles
 * - Find candidate media using dual embedding search
 * - Score and rank candidates with quality blending
 * - Apply diversity filters (genre-based greedy selection)
 * - Generate human-readable suggestion reasons
 * - Save suggestions to database
 *
 * Extracted from Database class (connection.ts) to follow service-oriented architecture.
 *
 * Uses lazy initialization pattern for dependent services to avoid circular dependencies.
 *
 * @module services/suggestion-engine
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { Logger } from '../utils/logger.js';
import { parseEmbedding as parseEmbeddingVector } from '../utils/embedding-utils.js';
import {
    calculateCandidateLimit,
    determineAvailability,
    saveSuggestionsToDatabase,
    buildWatchedBasedEmbedding,
    calculateSplitCandidateLimits,
    withAdvisoryLock,
    generateEnhancedRecommendationReason,
    generateStructuredReason,
    type SuggestionReasonData,
    monotonicRankScores,
    fuseSimilarity,
} from '../database/utils/recommendation-helpers.js';
import { getGenreNames } from '../../constants/genres.js';
import { interleaveByAvailability } from '../utils/availability-balancing.js';
import { config } from '../config.js';
import * as m from '$lib/paraglide/messages';
import {
    getTasteDamperService,
    computeDamperPenalty,
    DAMPER_LAMBDA,
} from './taste-damper.service.js';
import type { UserSuggestionInput } from '../database/queries/suggestion-management.queries.js';
import type {
    findSimilarMediaDual,
    fetchCandidateEmbeddings,
} from '../database/queries/suggestion-search.queries.js';
import { unrestrictedAccess } from '../database/queries/builders/media-access-boundary.js';
import type { TmdbMediaKey } from '../database/queries/suggestion-search.queries.js';
import type {
    saveSuggestions,
    getUserSuggestions,
    clearUserSuggestions,
    cleanupExpiredSuggestions,
    UserSuggestionRow,
} from '../database/queries/suggestion-management.queries.js';
import type { SimilarMediaDualRow } from '../database/queries/suggestion-search.queries.js';
import type { UserProfile, MediaEmbedding, UserRatingWithUuid } from '../database/connection.js';
import { CatalogService } from './catalog.service.js';
import {
    getTestExcludeQuery,
    getTotalMovieCount,
    getTotalTvCount,
} from '../database/queries/suggestion-engine.queries.js';
import { diversifyByGenre, hashSeed } from '../utils/diversify-rank.js';

const logger = Logger.for('SuggestionEngineService');

/**
 * The access boundary this engine's candidate searches run under.
 *
 * This engine has NO access boundary in scope. It is handed a bare `UserId`,
 * never a `UserContext`, so it cannot derive the user's denied library groups or
 * age limit without a new dependency — and before this migration it passed no
 * boundary at all, silently searching the whole catalogue.
 *
 * Naming that state `unrestrictedAccess()` is the point of the required-by-shape
 * reshape: the bypass is now one grep away instead of being invisible by
 * omission. It is also, deliberately, the SAME rows as before — this commit
 * changes how the boundary is expressed, never which rows anyone sees.
 *
 * Why an unfiltered candidate pool is not a leak today: the generated rows land
 * in `user_suggestions`, and EVERY read path re-gates them per-request through
 * `filterAccessibleMediaIds` with the caller's real library + age boundary (see
 * `api/defs/recommendations/strategies/ai.strategy.ts`). The persisted pool is
 * a superset; the served list is not.
 *
 * Why it is still worth fixing: a restricted user's pool is diluted by rows that
 * will always be filtered out at read time, so their rail is thinner than the
 * requested limit for reasons the engine cannot see. Threading a real boundary
 * (i.e. resolving a boundary from `userId` at generation time) would fix that —
 * but it changes which rows get persisted for restricted users, which is a
 * behaviour change and belongs in its own separately-tested commit.
 */
const ENGINE_CANDIDATE_ACCESS = unrestrictedAccess();

// =============================================================================
// Types
// =============================================================================

/**
 * Media suggestion candidate with scoring fields.
 */
export interface MediaSuggestionCandidate extends MediaEmbedding {
    combined_score?: number;
    library_similarity?: number;
    discovery_similarity?: number;
    quality_score?: number;
    popularity_score?: number;
    is_available?: boolean;
}

/**
 * Dependencies that SuggestionEngineService needs from other services.
 * Used for lazy initialization to avoid circular dependencies.
 */
export interface SuggestionEngineDeps {
    getUserProfile(userId: UserId): Promise<UserProfile | null>;
    getUserRatingsWithUuid(
        userId: UserId,
        limit?: number,
        includeSkipped?: boolean,
    ): Promise<UserRatingWithUuid[]>;
    getUserRatings(
        userId: UserId,
        limit?: number,
    ): Promise<
        Array<{
            media_id: string;
            primary_ext_id?: string;
            media_type: string;
            rating: number;
        }>
    >;
    getMediaEmbeddingByUuid(mediaId: string): Promise<MediaEmbedding | null>;
    getMediaEmbeddingsByUuids(mediaIds: string[]): Promise<Map<string, MediaEmbedding>>;
    getMediaEmbedding(tmdbId: number, mediaType: 'movie' | 'tv'): Promise<MediaEmbedding | null>;
}

// =============================================================================
// Service Class
// =============================================================================

/**
 * Service for generating personalized media suggestions.
 *
 * Core pipeline: extract embedding → find candidates → score → rank → diversify → save
 *
 * @example
 * ```typescript
 * const engine = getSuggestionEngine(sql);
 * const suggestions = await engine.generateSuggestionsFromProfile('userId', 20);
 * ```
 */
export class SuggestionEngineService {
    private sql: postgres.Sql;
    private deps: SuggestionEngineDeps;
    private catalogService: CatalogService;

    // Query functions (imported from query modules)
    private findSimilarMediaDual: typeof findSimilarMediaDual;
    private fetchCandidateEmbeddings: typeof fetchCandidateEmbeddings;
    private saveSuggestions: typeof saveSuggestions;
    private getUserSuggestions: typeof getUserSuggestions;
    private clearUserSuggestions: typeof clearUserSuggestions;
    private cleanupExpiredSuggestions: typeof cleanupExpiredSuggestions;

    constructor(sql: postgres.Sql, deps: SuggestionEngineDeps, catalogService?: CatalogService) {
        this.sql = sql;
        this.deps = deps;
        this.catalogService = catalogService ?? new CatalogService(sql);

        // Query functions are loaded asynchronously
        this.findSimilarMediaDual = null as never;
        this.fetchCandidateEmbeddings = null as never;
        this.saveSuggestions = null as never;
        this.getUserSuggestions = null as never;
        this.clearUserSuggestions = null as never;
        this.cleanupExpiredSuggestions = null as never;
    }

    /**
     * Lazy-load query functions to avoid circular dependencies.
     */
    private async ensureQueryFunctionsLoaded(): Promise<void> {
        if (!this.findSimilarMediaDual) {
            const searchQueries = await import('../database/queries/suggestion-search.queries.js');
            const managementQueries =
                await import('../database/queries/suggestion-management.queries.js');

            this.findSimilarMediaDual = searchQueries.findSimilarMediaDual;
            this.fetchCandidateEmbeddings = searchQueries.fetchCandidateEmbeddings;
            this.saveSuggestions = managementQueries.saveSuggestions;
            this.getUserSuggestions = managementQueries.getUserSuggestions;
            this.clearUserSuggestions = managementQueries.clearUserSuggestions;
            this.cleanupExpiredSuggestions = managementQueries.cleanupExpiredSuggestions;
        }
    }

    // =============================================================================
    // Main Suggestion Generation Methods
    // =============================================================================

    /**
     * Generate suggestions from user profile embeddings.
     *
     * Uses the user's learned preference embeddings (Jellyfin/Jellyseerr) to find
     * similar media with quality blending and diversity filtering.
     *
     * @param userId - User identifier
     * @param limit - Maximum suggestions to return (default: 20)
     * @param excludeItems - Composite keys to exclude (for "Load More" functionality)
     * @param mediaTypeFilter - Optional filter: 'movie' | 'tv' | undefined (mixed)
     * @returns UserSuggestion[] - Array of suggestions with scores and reasons
     *
     * @example
     * ```typescript
     * // Get initial 20 suggestions
     * const suggestions = await engine.generateSuggestionsFromProfile('testuser', 20);
     *
     * // Load more, excluding first 20 items shown
     * const moreSuggestions = await engine.generateSuggestionsFromProfile(
     *   'testuser',
     *   20,
     *   shownItems.map(i => ({tmdb_id: i.tmdbId, media_type: i.mediaType})),
     *   'tv'  // Only get more TV series
     * );
     * ```
     */
    async generateSuggestionsFromProfile(
        userId: UserId,
        limit = 20,
        excludeItems: TmdbMediaKey[] = [],
        mediaTypeFilter?: 'movie' | 'tv',
        refresh = false,
    ): Promise<UserSuggestionRow[]> {
        await this.ensureQueryFunctionsLoaded();

        // F3: serve already-stored fresh suggestions instead of regenerating on
        // every request. When the caller did not ask for a refresh and there are
        // already enough non-expired stored rows (matching the media-type filter
        // and still covering the requested count after excludeItems removal),
        // return them without acquiring the lock or running the vector searches.
        const stored = await this._loadStoredIfFresh(
            userId,
            limit,
            excludeItems,
            mediaTypeFilter,
            refresh,
        );
        if (stored) {
            logger.info('[ForYou] Served stored suggestions (no regeneration)', {
                userId,
                served: stored.length,
                limit,
                mediaTypeFilter: mediaTypeFilter || 'mixed',
            });
            return stored;
        }

        logger.info('[ForYou] Generating fresh suggestions', {
            userId,
            limit,
            refresh,
            mediaTypeFilter: mediaTypeFilter || 'mixed',
        });

        return withAdvisoryLock(
            this.sql,
            `suggestions_${userId}`,
            async () => {
                // Main operation with lock acquired
                const userProfile = await this.deps.getUserProfile(userId);
                if (!userProfile?.catalog_embedding && !userProfile?.request_embedding) {
                    logger.info('No user profile embeddings found', { userId });
                    return [];
                }

                // Extract user embedding
                const embedding = this._extractUserEmbedding(userProfile);
                if (!embedding) {
                    logger.warn('Empty embeddings for user', { userId });
                    return [];
                }

                // Calculate candidate limits with 70/30 split
                const limits = calculateSplitCandidateLimits(
                    limit,
                    excludeItems.length,
                    mediaTypeFilter,
                );

                logger.info('[Load More Debug] Searching for candidates', {
                    userId,
                    mediaTypeFilter: mediaTypeFilter || 'mixed',
                    excludeItemsCount: excludeItems.length,
                    movieLimit: limits.movieLimit,
                    tvLimit: limits.tvLimit,
                });

                // Find candidate media
                const candidates = await this._findCandidateMedia(
                    userId,
                    embedding,
                    userProfile,
                    limits,
                    excludeItems,
                );

                if (candidates.length === 0) {
                    await this._logEmptyResults(userId, excludeItems.length);
                    return [];
                }

                logger.info('[Load More Debug] Found candidates', {
                    userId,
                    candidatesCount: candidates.length,
                });

                // Score and rank candidates
                const scoredCandidates = this._scoreAndRankCandidates(candidates, userProfile);

                // Apply diversity filters
                const selectedItems = await this._applyDiversityFilters(
                    scoredCandidates,
                    userProfile,
                    userId,
                    limit,
                );

                if (selectedItems.length < limit) {
                    logger.warn('Insufficient suggestions generated', {
                        userId,
                        generated: selectedItems.length,
                        requested: limit,
                        candidates: candidates.length,
                        excluded: excludeItems.length,
                    });
                }

                logger.info('[Load More Debug] Generated suggestions', {
                    userId,
                    suggestionsCount: selectedItems.length,
                    excludeItemsCount: excludeItems.length,
                });

                // Save to database
                if (selectedItems.length > 0) {
                    await this.saveSuggestions(this.sql, selectedItems);
                }

                // Return cached suggestions with proper typing, filtering excluded items
                const allSuggestions = await this.getUserSuggestions(
                    this.sql,
                    userId,
                    limit + excludeItems.length,
                    { mediaType: mediaTypeFilter },
                );
                if (excludeItems.length === 0) return allSuggestions.slice(0, limit);
                const excludeSet = new Set(
                    excludeItems.map((e) => `${e.primary_ext_id}:${e.media_type}`),
                );
                return allSuggestions
                    .filter((s) => !excludeSet.has(`${s.primary_ext_id ?? ''}:${s.media_type}`))
                    .slice(0, limit);
            },
            async () => {
                // Fallback when lock cannot be acquired
                logger.info('[Load More Debug] Lock not acquired, using fallback path', { userId });

                const cachedSuggestions = await this.getUserSuggestions(
                    this.sql,
                    userId,
                    limit * 2,
                    {
                        mediaType: mediaTypeFilter,
                    },
                );

                // Filter out excluded items
                const freshSuggestions = cachedSuggestions
                    .filter((s) => {
                        const key = `${s.primary_ext_id ?? ''}:${s.media_type}`;
                        const isExcluded = excludeItems.some(
                            (e) => `${e.primary_ext_id}:${e.media_type}` === key,
                        );
                        return !isExcluded;
                    })
                    .slice(0, limit);

                logger.info('[Load More Debug] Fallback path results', {
                    userId,
                    cachedCount: cachedSuggestions.length,
                    excludeCount: excludeItems.length,
                    freshCount: freshSuggestions.length,
                    threshold: limit * 0.5,
                });

                if (freshSuggestions.length >= limit * 0.5) {
                    return freshSuggestions;
                }

                // Not enough fresh suggestions - return what we have
                logger.warn(
                    '[Load More Debug] Insufficient cached suggestions, returning what we have',
                    { userId, count: freshSuggestions.length },
                );
                return freshSuggestions;
            },
        );
    }

    /**
     * F3 helper: return already-stored suggestions when they are still fresh and
     * plentiful enough to satisfy the request WITHOUT regenerating.
     *
     * Returns the ready-to-serve rows (sliced to `limit`) when:
     *   - `refresh` is false, AND
     *   - after removing `excludeItems`, at least `limit` non-expired stored rows
     *     matching `mediaTypeFilter` remain.
     * Otherwise returns null so the caller falls through to generation.
     *
     * `getUserSuggestions` already filters `expires_at > NOW()`, so every row here
     * is non-expired. We over-fetch by `excludeItems.length` so exclusion cannot
     * starve the result below `limit`.
     */
    private async _loadStoredIfFresh(
        userId: UserId,
        limit: number,
        excludeItems: TmdbMediaKey[],
        mediaTypeFilter: 'movie' | 'tv' | undefined,
        refresh: boolean,
    ): Promise<UserSuggestionRow[] | null> {
        if (refresh) return null;

        const stored = await this.getUserSuggestions(
            this.sql,
            userId,
            limit + excludeItems.length,
            {
                mediaType: mediaTypeFilter,
            },
        );

        let usable = stored;
        if (excludeItems.length > 0) {
            const excludeSet = new Set(
                excludeItems.map((e) => `${e.primary_ext_id}:${e.media_type}`),
            );
            usable = stored.filter(
                (s) => !excludeSet.has(`${s.primary_ext_id ?? ''}:${s.media_type}`),
            );
        }

        if (usable.length >= limit) {
            return usable.slice(0, limit);
        }
        return null;
    }

    /**
     * Generate suggestions from positive ratings only (rating >= 3).
     *
     * This algorithm:
     * 1. Gets user's positive ratings (rating >= 3)
     * 2. Calculates weighted average embedding from rated content
     * 3. Finds similar media purely based on what was rated highly
     * 4. Does NOT use the user's preference profile embeddings
     *
     * @param userId - User identifier
     * @param limit - Maximum suggestions to return (default: 20)
     * @param excludeItems - Composite keys to exclude (for "Load More" functionality)
     * @param mediaTypeFilter - Optional filter: 'movie' | 'tv' | undefined (mixed)
     * @returns UserSuggestion[] - Array of suggestions with scores and reasons
     *
     * @example
     * ```typescript
     * const suggestions = await engine.generateSuggestionsFromWatchedOnly('testuser', 20, [], 'movie');
     * ```
     */
    async generateSuggestionsFromWatchedOnly(
        userId: UserId,
        limit = 20,
        excludeItems: TmdbMediaKey[] = [],
        mediaTypeFilter?: 'movie' | 'tv',
    ): Promise<UserSuggestionRow[]> {
        await this.ensureQueryFunctionsLoaded();

        try {
            logger.info('Generating watched-based suggestions', {
                userId,
                limit,
            });

            // Check if user has a profile
            const userProfile = await this.deps.getUserProfile(userId);
            if (!userProfile?.catalog_embedding) {
                logger.info('No profile found for user', { userId });
                return [];
            }

            // Get user ratings WITH UUIDs to avoid re-resolving TMDB → UUID
            const userRatings = await this.deps.getUserRatingsWithUuid(userId, 100);
            if (userRatings.length === 0) {
                logger.info('No ratings found for user', { userId });
                return [];
            }

            // Positive experiences only. Ratings are 1–10; <= 4 is the system-wide
            // dislike convention (getDislikedMediaIds), so the old `>= 3` cutoff
            // (a 1–5-scale leftover) was folding disliked titles INTO the taste
            // vector. >= 6 keeps neutral-positive and up.
            const positiveRatings = userRatings.filter((rating) => rating.rating >= 6);
            if (positiveRatings.length === 0) {
                logger.info('No positive ratings found for user', { userId });
                return [];
            }

            // Calculate weighted average embedding from rated content only
            const watchedBasedEmbedding = await buildWatchedBasedEmbedding(
                this.deps,
                positiveRatings,
                // 1–10 scale (was /5.0, a legacy 1–5 calibration that gave 8–10s a
                // 2.0 weight and over-counted them). /10.0 → 0.3–1.0 normalized range.
                (rating) => rating / 10.0,
            );

            if (!watchedBasedEmbedding) {
                logger.info('No embeddings found for positive ratings', {
                    userId,
                });
                return [];
            }

            // Exclude already-rated titles from the pool (composite keys avoid
            // TMDB ID collisions). Filtering before ordering keeps the rated
            // exclusion from silently shrinking the final limited set.
            const ratedCompositeKeys = new Set(
                userRatings.map((r) => `${r.primary_ext_id ?? r.media_id}:${r.media_type}`),
            );

            return await this._generateFromEmbedding(
                userId,
                watchedBasedEmbedding,
                limit,
                excludeItems,
                mediaTypeFilter,
                {
                    availabilityPreference: userProfile.availability_preference ?? 0.7,
                    qualityWeight: userProfile.quality_weight || 0.2,
                    popularityWeight: userProfile.popularity_weight || 0.1,
                    excludeCompositeKeys: ratedCompositeKeys,
                    logLabel: 'Insufficient watched-based suggestions generated',
                },
            );
        } catch (error) {
            logger.error('Failed to generate watched-based suggestions', error as Error, {
                userId,
            });
            return [];
        }
    }

    /**
     * Generate suggestions from watch history only, completely ignoring any ratings.
     * Pure discovery mode - good for users who watch but don't rate, or for exploration.
     *
     * This algorithm:
     * 1. Uses only the Jellyfin preference embedding (watch history based)
     * 2. Does NOT consider any user ratings or preferences
     * 3. Finds similar media purely based on what was watched
     *
     * @param userId - User identifier
     * @param limit - Maximum suggestions to return (default: 20)
     * @param excludeItems - Composite keys to exclude (for "Load More" functionality)
     * @param mediaTypeFilter - Optional filter: 'movie' | 'tv' | undefined (mixed)
     * @returns UserSuggestion[] - Array of suggestions with scores and reasons
     *
     * @example
     * ```typescript
     * // Get pure watch-based movie recommendations
     * const suggestions = await engine.generateSuggestionsFromWatchOnlyWithoutRatings(
     *   'testuser',
     *   20,
     *   [],
     *   'movie'
     * );
     * ```
     */
    async generateSuggestionsFromWatchOnlyWithoutRatings(
        userId: UserId,
        limit = 20,
        excludeItems: TmdbMediaKey[] = [],
        mediaTypeFilter?: 'movie' | 'tv',
    ): Promise<UserSuggestionRow[]> {
        await this.ensureQueryFunctionsLoaded();

        try {
            // Check if user has a profile
            const userProfile = await this.deps.getUserProfile(userId);
            if (!userProfile?.catalog_embedding) {
                logger.info('No profile found for user (pure watch-based)', {
                    userId,
                });
                return [];
            }

            // Get the user's watch-based preference embedding
            const userEmbedding = parseEmbeddingVector(userProfile.catalog_embedding ?? undefined);

            if (!userEmbedding || userEmbedding.length === 0) {
                logger.warn('Invalid user embedding', {
                    userId,
                    embeddingLength: userEmbedding?.length || 0,
                });
                return [];
            }

            return await this._generateFromEmbedding(
                userId,
                userEmbedding,
                limit,
                excludeItems,
                mediaTypeFilter,
                {
                    availabilityPreference: userProfile.availability_preference ?? 0.7,
                    qualityWeight: userProfile.quality_weight || 0.2,
                    popularityWeight: userProfile.popularity_weight || 0.1,
                    logLabel: 'Insufficient watch-only suggestions generated',
                },
            );
        } catch (error) {
            logger.error('Failed to generate pure watch-based suggestions', error as Error, {
                userId,
            });
            return [];
        }
    }

    /**
     * Shared generation core for the two embedding-seeded paths
     * (`generateSuggestionsFromWatchedOnly` and
     * `generateSuggestionsFromWatchOnlyWithoutRatings`), which differ only in how
     * the seed embedding is derived and whether already-rated titles are excluded
     * from the candidate pool.
     *
     * Pipeline: dual similarity search → damper steering → optional composite-key
     * exclusion → seeded diversify/availability-interleave → suggestion rows →
     * persist → return the freshly stored suggestions.
     *
     * Both callers pass the FULL findSimilarMediaDual option set
     * (availabilityPreference / qualityWeight / popularityWeight). The omission in
     * the old watch-only path was drift, not intent — availabilityPreference is
     * the interleave ratio and qualityWeight feeds the SQL combined_score.
     *
     * @param userId - User identifier
     * @param embedding - Seed embedding (watched-weighted or raw preference vector)
     * @param limit - Maximum suggestions to return
     * @param excludeItems - Composite keys to exclude at the SQL layer
     * @param mediaTypeFilter - Optional filter: 'movie' | 'tv' | undefined (mixed)
     * @param opts - Similarity/interleave weights, optional post-search composite-key
     *   exclusion set, and the "insufficient results" warn label
     */
    private async _generateFromEmbedding(
        userId: UserId,
        embedding: number[],
        limit: number,
        excludeItems: TmdbMediaKey[],
        mediaTypeFilter: 'movie' | 'tv' | undefined,
        opts: {
            availabilityPreference: number;
            qualityWeight: number;
            popularityWeight: number;
            excludeCompositeKeys?: Set<string>;
            logLabel: string;
        },
    ): Promise<UserSuggestionRow[]> {
        // Calculate candidate limit with boost for exclusions
        const candidateLimit = calculateCandidateLimit(limit, excludeItems.length, 5);

        // Determine media types to search based on filter
        const mediaTypesToSearch: ('movie' | 'tv')[] = mediaTypeFilter
            ? [mediaTypeFilter]
            : ['movie', 'tv'];

        const similarMedia = await this.findSimilarMediaDual(this.sql, embedding, {
            limit: candidateLimit,
            availabilityPreference: opts.availabilityPreference,
            qualityWeight: opts.qualityWeight,
            popularityWeight: opts.popularityWeight,
            source: 'both',
            mediaTypes: mediaTypesToSearch,
            excludeUserId: userId,
            excludeWatchedForUserId: userId,
            excludeItems,
            access: ENGINE_CANDIDATE_ACCESS,
        });

        // "Show less like this": steer the pool away from damped neighborhoods.
        await this._applyDamperSteering(userId, similarMedia);

        // Optional composite-key exclusion (e.g. already-rated titles), applied
        // before ordering so it cannot silently shrink the final limited set.
        const pool = opts.excludeCompositeKeys
            ? similarMedia.filter(
                  (media) =>
                      !opts.excludeCompositeKeys!.has(
                          `${media.primary_ext_id ?? ''}:${media.media_type}`,
                      ),
              )
            : similarMedia;

        // Deterministic diversity + availability interleave (replaces the old
        // ±0.15 uniform jitter). Emits up to `limit` items in final order.
        const orderedMedia = this._diversifyAndInterleave(
            pool,
            userId,
            limit,
            opts.availabilityPreference,
            (r) => r.combined_score ?? 0,
        );

        const suggestions: UserSuggestionInput[] = [];

        for (const media of orderedMedia) {
            const { isAvailable, canRequest } = determineAvailability(
                media.has_library_embedding,
                media.has_discovery_embedding,
            );

            suggestions.push({
                user_id: userId,
                primary_ext_id: media.primary_ext_id ?? '',
                media_type: media.media_type,
                combined_score: media.combined_score || 0,
                library_similarity_score: media.library_similarity || null,
                discovery_similarity_score: media.discovery_similarity || null,
                is_available: isAvailable,
                can_request: canRequest,
            });
        }

        // Save suggestions to database (convert to helper format)
        const helperInputs = suggestions.map((s) => ({
            user_id: s.user_id,
            primary_ext_id: s.primary_ext_id ?? '',
            media_type: s.media_type,
            combined_score: s.combined_score ?? 0,
            library_similarity_score: s.library_similarity_score ?? null,
            discovery_similarity_score: s.discovery_similarity_score ?? null,
            is_available: s.is_available,
            can_request: s.can_request,
        }));
        await saveSuggestionsToDatabase(this.sql, userId, helperInputs, 2);

        if (suggestions.length < limit) {
            logger.warn(opts.logLabel, {
                userId,
                generated: suggestions.length,
                requested: limit,
                candidates: similarMedia.length,
                excluded: excludeItems.length,
                ...(opts.excludeCompositeKeys ? { rated: opts.excludeCompositeKeys.size } : {}),
            });
        }

        // Read back scoped to the generated media type (mirrors the profile
        // path). Without this, a single-type generation's read-back could
        // surface stored rows of the OTHER type that a mixed generation left
        // behind, returning a mismatched pool for a movie-only / tv-only request.
        return await this.getUserSuggestions(this.sql, userId, limit, {
            mediaType: mediaTypeFilter,
        });
    }

    // =============================================================================
    // Private Pipeline Methods
    // =============================================================================

    /**
     * Extract user embedding from profile.
     * Prioritizes library over discovery.
     */
    private _extractUserEmbedding(userProfile: UserProfile): number[] | null {
        const libraryEmbedding = parseEmbeddingVector(userProfile.catalog_embedding ?? undefined);
        const discoveryEmbedding = parseEmbeddingVector(userProfile.request_embedding ?? undefined);

        if (libraryEmbedding && libraryEmbedding.length > 0) {
            return libraryEmbedding;
        }
        if (discoveryEmbedding && discoveryEmbedding.length > 0) {
            return discoveryEmbedding;
        }
        return null;
    }

    /**
     * Find candidate media using dual embedding search.
     */
    /**
     * "Show less like this": attenuate each candidate's combined_score by the
     * per-damper mean-centered max-pool penalty (in place), so generated AI
     * suggestions — and therefore the home hero pool — steer away from damped
     * neighborhoods. No-op when the user has no active dampers. Fetches the
     * damper context once per call.
     */
    private async _applyDamperSteering(userId: UserId, rows: SimilarMediaDualRow[]): Promise<void> {
        if (rows.length === 0) return;
        const damper = await getTasteDamperService(this.sql).getDamperContext(userId);
        if (!damper) return;

        // F9: candidate rows no longer carry the raw embedding text (only
        // has_library_embedding / has_discovery_embedding presence flags). The
        // damper penalty needs the actual vector, so fetch it for exactly this
        // candidate set in ONE batched query — and only here, after the null
        // check above, so the common no-damper path pays nothing.
        const embRows = await this.fetchCandidateEmbeddings(
            this.sql,
            rows.map((r) => r.media_uuid),
        );
        const vectorByUuid = new Map<string, string | null>();
        for (const e of embRows) {
            vectorByUuid.set(e.media_uuid, e.library_embedding ?? e.discovery_embedding);
        }

        for (const media of rows) {
            const pen = computeDamperPenalty(damper, vectorByUuid.get(media.media_uuid) ?? null);
            if (pen > 0) {
                const c = media.combined_score ?? 0;
                // Attenuate only the positive part — never boost a negative score.
                media.combined_score = c - Math.max(0, c) * DAMPER_LAMBDA * pen;
            }
        }
    }

    private async _findCandidateMedia(
        userId: UserId,
        embedding: number[],
        userProfile: UserProfile,
        limits: {
            movieLimit: number;
            tvLimit: number;
            candidateMultiplier: number;
        },
        excludeItems: TmdbMediaKey[],
    ): Promise<SimilarMediaDualRow[]> {
        // Debug exclusion logic if needed
        if (excludeItems.length > 0) {
            const testExcludeResult = await getTestExcludeQuery(
                this.sql,
                excludeItems.map((e) => [e.primary_ext_id, e.media_type]),
            );
            logger.info('[Load More Debug] Exclusion test', {
                totalMedia: testExcludeResult?.total ?? '0',
                afterExclude: testExcludeResult?.after_exclude ?? '0',
                excludedCount: excludeItems.length,
            });
        }

        // Query movies and TV in parallel
        const moviePromise =
            limits.movieLimit > 0
                ? this.findSimilarMediaDual(this.sql, embedding, {
                      limit: limits.movieLimit,
                      availabilityPreference: userProfile.availability_preference ?? 0.7,
                      qualityWeight: userProfile.quality_weight || 0.2,
                      popularityWeight: userProfile.popularity_weight || 0.1,
                      source: 'both',
                      mediaTypes: ['movie'],
                      excludeUserId: userId,
                      excludeWatchedForUserId: userId,
                      excludeItems,
                      access: ENGINE_CANDIDATE_ACCESS,
                  })
                : Promise.resolve([]);

        const tvPromise =
            limits.tvLimit > 0
                ? this.findSimilarMediaDual(this.sql, embedding, {
                      limit: limits.tvLimit,
                      availabilityPreference: userProfile.availability_preference ?? 0.7,
                      qualityWeight: userProfile.quality_weight || 0.2,
                      popularityWeight: userProfile.popularity_weight || 0.1,
                      source: 'both',
                      mediaTypes: ['tv'],
                      excludeUserId: userId,
                      excludeWatchedForUserId: userId,
                      excludeItems,
                      access: ENGINE_CANDIDATE_ACCESS,
                  })
                : Promise.resolve([]);

        const [similarMovies, similarTv] = await Promise.all([moviePromise, tvPromise]);

        const merged = [...similarMovies, ...similarTv];
        await this._applyDamperSteering(userId, merged);
        return merged;
    }

    /**
     * Rank candidates by their combined_score.
     *
     * Q12b (double-quality fix): quality is now weighted in exactly ONE place —
     * the SQL `combined_score` (`quality_score * qualityWeight`). The former JS
     * blend here (`sim*0.7 + quality*0.3*qualityWeight*5`) re-applied quality a
     * second time — a ~0.3 quality injection on top of the SQL term — so a
     * mediocre-but-similar title was penalised twice and the two knobs fought.
     * We keep quality in SQL (not JS) because the two watched-based generation
     * paths consume the SQL `combined_score` directly and have no JS re-rank
     * stage; stripping it from SQL would silently drop quality from them. This
     * method therefore just carries `combined_score` through as the ranking
     * score (kept as a named seam + regression test for the single-count rule).
     *
     * Math.random jitter has been removed — variety comes from the seeded
     * diversifyByGenre selector + availability interleave in
     * _applyDiversityFilters and from server-side hero rotation in the
     * suggestions API endpoint.
     */
    private _scoreAndRankCandidates(
        candidates: SimilarMediaDualRow[],
        _userProfile: UserProfile,
    ): Array<SimilarMediaDualRow & { randomized_score: number }> {
        return candidates
            .map((item) => ({
                ...item,
                randomized_score: item.combined_score || 0,
            }))
            .sort((a, b) => b.randomized_score - a.randomized_score);
    }

    /**
     * Deterministic diversity + availability interleave, shared by all three
     * generation paths.
     *
     * Pipeline:
     *   1. Genre-diversify the WHOLE candidate pool with a per-(user, day) seed
     *      (`hashSeed(userId + ':' + dateBucket)`) — no Math.random, stable
     *      within a day, rotates across days.
     *   2. Interleave available vs requestable so a strong discovery match can
     *      surface early while the list stays library-mostly-first. The ratio is
     *      the user's `availability_preference` (default 0.7 ≈ 70% available) —
     *      the same semantic the old SQL availability offset carried, now applied
     *      as an explicit order rather than a score partition.
     *   3. `interleaveByAvailability` can under-fill when one bucket is short of
     *      its ratio target; backfill from the diverse-ranked remainder so we
     *      still emit up to `limit` items.
     *   4. Re-encode `combined_score` as a strictly-decreasing sequence matching
     *      the final order — `user_suggestions` has no rank column and
     *      `getUserSuggestions` serves `ORDER BY combined_score DESC`, so the
     *      persisted (and later served) order must live in the score itself.
     *
     * @param rows - Candidate rows (mutated: combined_score reassigned to encode order)
     * @param userId - For the per-(user, day) diversity seed
     * @param limit - Max items to emit
     * @param availabilityPreference - Interleave ratio (fraction available)
     * @param scoreOf - Ranking-score accessor (profile: randomized_score; watched: combined_score)
     * @returns Final ordered rows (≤ limit) with combined_score encoding the order
     */
    private _diversifyAndInterleave<T extends SimilarMediaDualRow>(
        rows: T[],
        userId: UserId,
        limit: number,
        availabilityPreference: number,
        scoreOf: (r: T) => number,
    ): T[] {
        if (rows.length === 0) return [];

        const dateBucket = Math.floor(Date.now() / 86_400_000);
        const seed = hashSeed(`${String(userId)}:${dateBucket}`);

        // Order the entire pool by genre-diverse MMR (limit = full length) so the
        // interleave has both availability buckets to draw from.
        const diverse = diversifyByGenre(rows, {
            limit: rows.length,
            getGenres: (r) => (r.genres as Array<string | number>) || [],
            getScore: scoreOf,
            genrePenalty: 0.05,
            maxPenalty: 0.3,
            seed,
        });

        const interleaved = interleaveByAvailability(
            diverse,
            limit,
            availabilityPreference,
            (r) => !!r.has_library_embedding,
        );

        // Backfill if the ratio left a bucket short (keeps output at up to limit,
        // interleaved items first, then the best remaining diverse candidates).
        if (interleaved.length < limit) {
            const used = new Set(interleaved.map((r) => r.media_uuid));
            for (const r of diverse) {
                if (interleaved.length >= limit) break;
                if (!used.has(r.media_uuid)) interleaved.push(r);
            }
        }

        const final = interleaved.slice(0, limit);

        // Encode the final order into combined_score (see step 4 above).
        const ranks = monotonicRankScores(final.map(scoreOf));
        final.forEach((r, i) => {
            r.combined_score = ranks[i];
        });

        return final;
    }

    /**
     * Apply diversity + availability interleave, then build reasons.
     *
     * Selection is fully deterministic (per-user, per-day seed; no Math.random)
     * and availability is applied as an explicit interleave (not a score
     * partition) via the shared _diversifyAndInterleave helper.
     */
    private async _applyDiversityFilters(
        candidates: Array<SimilarMediaDualRow & { randomized_score: number }>,
        userProfile: UserProfile,
        userId: UserId,
        limit: number,
    ): Promise<UserSuggestionInput[]> {
        const availabilityPreference = userProfile.availability_preference ?? 0.7;

        const selected = this._diversifyAndInterleave(
            candidates,
            userId,
            limit,
            availabilityPreference,
            (item) => item.randomized_score,
        );

        // F2: hoist the two DB reads that were previously done PER item inside
        // generateSuggestionReason (a limit×2 serial round-trip storm):
        //   1. getUserRatings(userId, 10) was identical on every iteration —
        //      fetch it once and derive userHasHighRatings once.
        //   2. getMediaEmbeddingByUuid per item → batch into ONE
        //      getMediaEmbeddingsByUuids call for the whole selected set.
        const recentRatings = await this.deps.getUserRatings(userId, 10);
        // 1–10 scale; >= 8 is a genuinely high rating (see rating-threshold notes).
        const userHasHighRatings = recentRatings.some((r) => r.rating >= 8);

        const embeddingsMap = await this.deps.getMediaEmbeddingsByUuids(
            selected.map((s) => s.media_uuid),
        );

        const userPreferenceSource: 'watch_history' | 'ratings' =
            (userProfile.preferences.created_from as 'watch_history' | 'ratings') ||
            'watch_history';

        const suggestions: UserSuggestionInput[] = [];

        for (const movie of selected) {
            const { isAvailable, canRequest } = determineAvailability(
                movie.has_library_embedding,
                movie.has_discovery_embedding,
            );

            const reason = this._buildSuggestionReason(
                userId,
                movie,
                embeddingsMap.get(movie.media_uuid) ?? null,
                userPreferenceSource,
                userHasHighRatings,
            );

            suggestions.push({
                user_id: userId,
                primary_ext_id: movie.primary_ext_id ?? '',
                media_type: movie.media_type,
                combined_score: movie.combined_score || 0,
                library_similarity_score: movie.library_similarity || null,
                discovery_similarity_score: movie.discovery_similarity || null,
                suggestion_reason: reason.text,
                reason_data: reason.reasonData,
                is_available: isAvailable,
                can_request: canRequest,
            });
        }

        return suggestions;
    }

    /**
     * Log detailed diagnostics when no results found.
     */
    private async _logEmptyResults(userId: UserId, excludeCount: number): Promise<void> {
        const totalMovies = await getTotalMovieCount(this.sql);
        const totalTv = await getTotalTvCount(this.sql);
        logger.warn('[Load More Debug] No similar media found - checking database state', {
            userId,
            totalMoviesInDb: totalMovies,
            totalTvInDb: totalTv,
            excludeItemsCount: excludeCount,
        });
    }

    /**
     * Build a varied, human-readable suggestion reason from already-fetched data.
     *
     * F2: this is now a PURE, DB-free helper. The two reads it used to make per
     * item (getMediaEmbeddingByUuid + getUserRatings) are hoisted/batched by the
     * caller (_applyDiversityFilters) and passed in, so the reason loop no longer
     * issues any round trips.
     *
     * Q13 (honest reasons): the tier thresholds key off the FUSED library/
     * discovery cosine similarity (computed here from the row's per-source
     * similarities), NOT the row's `combined_score` — which is now an order-
     * encoding value anyway (see _diversifyAndInterleave) and was previously
     * availability-inflated so the "matches your taste" tier fired on nearly
     * every available card. The fallback string pick is seeded per (user, item)
     * so a card never flickers between reasons.
     *
     * @param userId - For the deterministic fallback seed
     * @param movie - The candidate row (carries per-source similarity / quality / popularity)
     * @param media - Pre-fetched media embedding (for genres + imdb rating), or null
     * @param userPreferenceSource - Whether the profile came from watch history or ratings
     * @param userHasHighRatings - Whether the user has any genuinely high (>= 8) ratings
     * @returns The legacy English prose (`text`) alongside its structured,
     *   client-localizable sibling (`reasonData`) — both derived from the SAME
     *   fused similarity / genre inputs so they can never disagree. This call
     *   site has no "anchor" item (a specific title+rating the candidate is
     *   similar to) to offer, so `reasonData` only ever resolves to
     *   `genre-affinity` or `ai` here — never `rated-similar`.
     */
    private _buildSuggestionReason(
        userId: UserId,
        movie: SimilarMediaDualRow,
        media: MediaEmbedding | null,
        userPreferenceSource: 'watch_history' | 'ratings',
        userHasHighRatings: boolean,
    ): { text: string; reasonData: SuggestionReasonData } {
        try {
            const fusedSimilarity = fuseSimilarity(
                movie.library_similarity,
                movie.discovery_similarity,
                config.EMBEDDING_FUSION_LIBRARY_WEIGHT,
                config.EMBEDDING_FUSION_DISCOVERY_WEIGHT,
            );
            const genreNames = media?.genres ? getGenreNames(media.genres) : [];
            const text = generateEnhancedRecommendationReason({
                similarity: fusedSimilarity,
                qualityScore: movie.quality_score || 0,
                popularityScore: movie.popularity_score || 0,
                genres: media?.genres,
                imdbRating: media?.imdb_rating,
                isAvailable: movie.is_available ?? false,
                mediaType: movie.media_type,
                userPreferenceSource,
                userHasHighRatings,
                seed: hashSeed(
                    `${String(userId)}:${movie.primary_ext_id ?? ''}:${movie.media_type}`,
                ),
            });
            const reasonData = generateStructuredReason({
                similarity: fusedSimilarity,
                topGenre: genreNames[0],
            });
            return { text, reasonData };
        } catch (error) {
            logger.warn('Failed to build suggestion reason', error as Error);
            return { text: m.suggestion_reason_default(), reasonData: { kind: 'ai' } };
        }
    }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Factory function to create a SuggestionEngineService instance.
 *
 * @param sql - postgres.js SQL connection
 * @param deps - Service dependencies (typically from Database class)
 * @returns SuggestionEngineService instance
 *
 * @example
 * ```typescript
 * import { getSuggestionEngine } from '$lib/server/services/suggestion-engine.service';
 *
 * const engine = getSuggestionEngine(sql, database);
 * const suggestions = await engine.generateSuggestionsFromProfile('userId', 20);
 * ```
 */
export function getSuggestionEngine(
    sql: postgres.Sql,
    deps: SuggestionEngineDeps,
): SuggestionEngineService {
    return new SuggestionEngineService(sql, deps);
}
