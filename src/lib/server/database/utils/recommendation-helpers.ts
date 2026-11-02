// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Recommendation Helper Utilities
 *
 * Pure, side-effect-light helpers consumed by SuggestionEngineService
 * (services/suggestion-engine.service.ts): candidate-pool sizing, deterministic
 * ranking, similarity fusion, availability detection, reason generation, row
 * mapping, suggestion persistence, and the advisory-lock wrapper. Orchestration
 * lives in the service, not here.
 *
 * @module database/utils/recommendation-helpers
 */

import type postgres from 'postgres';
import { getGenreNames } from '../../../constants/genres.js';
import { isMovie, isSeries } from '../../../utils/media-types.js';
import { mulberry32 } from '../../utils/diversify-rank.js';
import { Logger } from '../../utils/logger.js';

const logger = Logger.for('RecommendationHelpers');

/**
 * Type for user suggestion without auto-generated fields.
 */
export interface UserSuggestionInput {
    user_id: string;
    primary_ext_id: string;
    media_type: string;
    combined_score: number;
    library_similarity_score: number | null;
    discovery_similarity_score: number | null;
    quality_score?: number | null;
    popularity_score?: number | null;
    suggestion_reason?: string;
    /**
     * Structured, client-localizable sibling of `suggestion_reason` — see
     * `SuggestionReasonData`. Optional: callers that don't build one (e.g.
     * the embedding-only generation paths, which don't call
     * `generateEnhancedRecommendationReason` at all) simply persist `null`.
     */
    reasonData?: SuggestionReasonData;
    is_available: boolean;
    can_request: boolean;
}

// =============================================================================
// Candidate Pool Utilities
// =============================================================================

/**
 * Calculate candidate pool size with dynamic multiplier.
 * Used when fetching recommendations to ensure enough candidates after filtering.
 *
 * @param requestedLimit - Target number of final recommendations
 * @param excludeCount - Number of items to exclude
 * @param baseMultiplier - Base candidate multiplier (default: 5x)
 * @returns Adjusted candidate limit
 *
 * @example
 * // Get 5x base candidates + boost for 50 excluded items
 * const candidateLimit = calculateCandidateLimit(20, 50, 5);
 * // Returns: 20 * 5 + ceil(50 / 5) = 110
 */
export function calculateCandidateLimit(
    requestedLimit: number,
    excludeCount: number,
    baseMultiplier: number = 5,
): number {
    const excludeBoost = excludeCount > 0 ? Math.ceil(excludeCount / 5) : 0;
    return requestedLimit * baseMultiplier + excludeBoost;
}

/**
 * Calculate candidate limits with 70/30 movie/TV split.
 *
 * @param limit - Total number of recommendations requested
 * @param excludeCount - Number of excluded items
 * @param mediaTypeFilter - Optional filter to single media type
 * @returns Split limits for movies and TV
 *
 * @example
 * const { movieLimit, tvLimit } = calculateSplitCandidateLimits(20, 10);
 * // Returns: { movieLimit: 70, tvLimit: 40, candidateMultiplier: 5 }
 */
export function calculateSplitCandidateLimits(
    limit: number,
    excludeCount: number,
    mediaTypeFilter?: 'movie' | 'tv',
): {
    movieLimit: number;
    tvLimit: number;
    candidateMultiplier: number;
} {
    let tvLimit: number;
    let movieLimit: number;

    if (isSeries(mediaTypeFilter)) {
        tvLimit = limit;
        movieLimit = 0;
    } else if (isMovie(mediaTypeFilter)) {
        tvLimit = 0;
        movieLimit = limit;
    } else {
        // Balanced ~50/50 split so TV series surface alongside movies. Series
        // ARE embedded (≈99% coverage) — their near-absence was this candidate
        // pool bias (old 70/30 movie-heavy split), not a data gap.
        tvLimit = Math.max(3, Math.round(limit * 0.5));
        movieLimit = Math.max(3, limit - tvLimit);
    }

    // Calculate multiplier with exclude boost
    const excludeRatio = excludeCount > 0 ? Math.min(excludeCount / 50, 4) : 0;
    const candidateMultiplier = Math.max(5, Math.ceil(limit / 3) + Math.ceil(excludeRatio * 3));

    return {
        movieLimit: movieLimit * candidateMultiplier,
        tvLimit: tvLimit * candidateMultiplier,
        candidateMultiplier,
    };
}

// =============================================================================
// Deterministic Ranking Helpers
// =============================================================================

/**
 * Re-encode an arbitrary set of scores as a strictly-decreasing sequence that
 * preserves the ORDER in which the inputs are passed. Each item keeps its own
 * score; scores are only clamped to ensure strict monotonic decrease.
 *
 * `user_suggestions` has no rank/position column and `getUserSuggestions`
 * serves rows `ORDER BY combined_score DESC`. When the engine wants to persist
 * a hand-built ordering (e.g. after an availability interleave), it cannot rely
 * on the natural combined_score values — a lower-ranked item could carry a
 * higher raw score and jump the queue on serve. This helper preserves each
 * item's position and score, but clamps subsequent scores to be strictly less
 * than their predecessor to ensure serve-time DESC ordering reproduces the
 * input order exactly.
 *
 * @param orderedScores - Scores in the desired final (descending-priority) order
 * @returns Strictly-decreasing scores, each item keeping its own value (clamped only when needed)
 *
 * @example
 * monotonicRankScores([0.6, 0.9, 0.5]); // => [0.6, <0.6, <result[1]] (order preserved, each item keeps its own)
 */
export function monotonicRankScores(orderedScores: number[]): number[] {
    const EPS = 1e-6;
    const out: number[] = [];
    let prev = Number.POSITIVE_INFINITY;
    for (const raw of orderedScores) {
        const s = Number.isFinite(raw) ? raw : 0;
        const v = s < prev ? s : prev - EPS;
        out.push(v);
        prev = v;
    }
    return out;
}

/**
 * Weighted late-fusion of the library and discovery cosine similarities into a
 * single value — the JS mirror of `buildFusedSimilarityExpr` (SQL). Used to
 * feed reason-tier thresholds with the *pure similarity* component rather than
 * the availability/quality-inflated combined_score.
 *
 * - both present → `wLib·lib + wDisc·disc` with `wLib + wDisc = 1`
 * - only one present → that value (no penalty)
 * - neither present → 0
 *
 * @param librarySimilarity - Library cosine similarity (0-1) or null
 * @param discoverySimilarity - Discovery cosine similarity (0-1) or null
 * @param libraryWeight - Raw library weight (normalized against discoveryWeight)
 * @param discoveryWeight - Raw discovery weight (normalized against libraryWeight)
 */
export function fuseSimilarity(
    librarySimilarity: number | null,
    discoverySimilarity: number | null,
    libraryWeight: number,
    discoveryWeight: number,
): number {
    if (librarySimilarity != null && discoverySimilarity != null) {
        const total = libraryWeight + discoveryWeight;
        const wLib = total > 0 ? libraryWeight / total : 0.5;
        const wDisc = total > 0 ? discoveryWeight / total : 0.5;
        return wLib * librarySimilarity + wDisc * discoverySimilarity;
    }
    if (librarySimilarity != null) return librarySimilarity;
    if (discoverySimilarity != null) return discoverySimilarity;
    return 0;
}

// =============================================================================
// Availability Detection
// =============================================================================

/**
 * Determine availability status from embeddings.
 *
 * @param libraryEmbedding - Library embedding (if available)
 * @param discoveryEmbedding - Discovery embedding (if requestable)
 * @returns Availability flags
 *
 * @example
 * const { isAvailable, canRequest } = determineAvailability(libEmbed, discEmbed);
 */
export function determineAvailability(
    libraryEmbedding: unknown,
    discoveryEmbedding: unknown,
): {
    isAvailable: boolean;
    canRequest: boolean;
} {
    const hasLibrary = !!libraryEmbedding;
    const hasDiscovery = !!discoveryEmbedding;
    return {
        isAvailable: hasLibrary,
        canRequest: hasDiscovery && !hasLibrary,
    };
}

// =============================================================================
// Weighted Embedding Calculation
// =============================================================================

/**
 * Calculate weighted average of embeddings.
 * Used for building temporary profile from rated content.
 *
 * @param items - Items with embedding and weight
 * @returns Weighted average embedding or null
 *
 * @example
 * const profileEmbedding = calculateWeightedAverageEmbedding([
 *   { embedding: [0.1, 0.2, ...], weight: 1.0 },
 *   { embedding: [0.2, 0.3, ...], weight: 0.8 }
 * ]);
 */
export function calculateWeightedAverageEmbedding(
    items: Array<{ embedding: number[]; weight: number }>,
): number[] | null {
    if (items.length === 0) return null;

    const embeddingLength = items[0].embedding.length;
    const weightedSum = new Array(embeddingLength).fill(0);
    let totalWeight = 0;

    for (const item of items) {
        if (item.embedding.length !== embeddingLength) {
            throw new Error('All embeddings must have the same length');
        }
        for (let i = 0; i < embeddingLength; i++) {
            weightedSum[i] += item.embedding[i] * item.weight;
        }
        totalWeight += item.weight;
    }

    if (totalWeight === 0) return null;

    return weightedSum.map((sum) => sum / totalWeight);
}

/**
 * Build watched-based embedding from user ratings.
 * Fetches embeddings for rated items and calculates weighted average.
 *
 * @param sql - Postgres SQL connection
 * @param db - Database instance (for getMediaEmbeddingByUuid)
 * @param ratings - User ratings with UUIDs
 * @param weightingFn - Function to convert rating to weight
 * @returns Weighted average embedding or null
 *
 * @example
 * const embedding = await buildWatchedBasedEmbedding(
 *   sql,
 *   db,
 *   userRatings.filter(r => r.rating >= 6), // 1–10 scale; <= 4 is a dislike
 *   (rating) => rating / 10.0
 * );
 */
export async function buildWatchedBasedEmbedding<T extends { media_id: string; rating: number }>(
    db: { getMediaEmbeddingByUuid(id: string): Promise<unknown> },
    ratings: T[],
    weightingFn: (rating: number) => number,
): Promise<number[] | null> {
    // Import parseEmbedding from embedding-utils
    const { parseEmbedding: parseEmbeddingVector } =
        await import('$lib/server/utils/embedding-utils');

    const ratingEmbeddings: Array<{ embedding: number[]; weight: number }> = [];

    for (const rating of ratings) {
        const media = await db.getMediaEmbeddingByUuid(rating.media_id);
        if (!media) continue;

        // Type guard to check if media has embedding fields
        const hasEmbeddings = (
            m: unknown,
        ): m is {
            library_embedding: unknown;
            discovery_embedding: unknown;
        } => {
            return (
                typeof m === 'object' &&
                m !== null &&
                ('library_embedding' in m || 'discovery_embedding' in m)
            );
        };

        if (!hasEmbeddings(media)) continue;

        // Get best available embedding (cast to Embedding type)
        const embedding =
            parseEmbeddingVector(
                media.library_embedding as Parameters<typeof parseEmbeddingVector>[0],
            ) ??
            parseEmbeddingVector(
                media.discovery_embedding as Parameters<typeof parseEmbeddingVector>[0],
            );

        if (embedding && embedding.length > 0) {
            const weight = weightingFn(rating.rating);
            ratingEmbeddings.push({ embedding, weight });
        }
    }

    return calculateWeightedAverageEmbedding(ratingEmbeddings);
}

// =============================================================================
// Recommendation Reason Generation (Enhanced)
// =============================================================================

/**
 * Similarity at/above which a recommendation earns a "strong taste match"
 * reason. Tied to the FUSED library/discovery cosine similarity (see
 * `fuseSimilarity`), NOT the availability/quality-inflated combined_score.
 * Real top candidates land ~0.5-0.7 fused cosine, so 0.55 separates a genuine
 * taste match from a generic "also available" filler. (Was 0.15 against the
 * inflated composite, which fired on nearly every available card.)
 */
export const STRONG_SIMILARITY_THRESHOLD = 0.55;

/**
 * Input for generating recommendation reasons.
 */
export interface RecommendationReasonInput {
    /**
     * FUSED library/discovery cosine similarity (0-1) — the pure embedding
     * match, NOT combined_score. Tier thresholds key off this.
     */
    similarity: number;
    qualityScore: number;
    popularityScore: number;
    genres?: number[];
    imdbRating?: number;
    isAvailable: boolean;
    /** Canonical media type — drives movie/series-aware wording. */
    mediaType: string;
    userPreferenceSource: 'watch_history' | 'ratings';
    userHasHighRatings: boolean;
    /**
     * Deterministic seed (e.g. hashSeed(user+item)) for the fallback string
     * pick — replaces Math.random so the same item always shows the same
     * fallback reason. Defaults to 0.
     */
    seed?: number;
}

/**
 * Generate human-readable explanation for recommendation.
 * Enhanced version that merges logic from both implementations.
 *
 * @param input - Recommendation reason configuration
 * @returns Explanation string
 *
 * @example
 * const reason = generateEnhancedRecommendationReason({
 *   similarity: 0.85,
 *   qualityScore: 0.9,
 *   popularityScore: 0.7,
 *   genres: [28, 878],
 *   imdbRating: 8.5,
 *   isAvailable: true,
 *   userPreferenceSource: 'watch_history',
 *   userHasHighRatings: true
 * });
 */
export function generateEnhancedRecommendationReason(input: RecommendationReasonInput): string {
    const {
        similarity,
        qualityScore,
        popularityScore,
        genres,
        imdbRating,
        isAvailable,
        mediaType,
        userPreferenceSource,
        userHasHighRatings,
        seed = 0,
    } = input;

    // Get genre names for recommendation reason
    const genreNames = genres ? getGenreNames(genres) : [];

    // Media-type-aware wording: a series is not a "film".
    const series = isSeries(mediaType);
    const pluralNoun = series ? 'shows' : 'films';
    const singularNoun = series ? 'series' : 'film';

    // Strong taste match — keyed off the PURE fused similarity, not the
    // availability-inflated composite (which used to fire ~everywhere).
    if (similarity >= STRONG_SIMILARITY_THRESHOLD) {
        if (genreNames.length > 0) {
            return `Matches your taste in ${genreNames.slice(0, 2).join(' and ')} ${pluralNoun}`;
        }
        return userPreferenceSource === 'watch_history'
            ? `Similar to ${series ? 'series' : 'movies'} you've enjoyed watching`
            : 'Matches your highly-rated content';
    }

    // Quality + user appreciates quality
    if (qualityScore > 0.8 && userHasHighRatings) {
        const genreLabel = genreNames.length > 0 ? genreNames[0] : singularNoun;
        return `Highly acclaimed ${genreLabel} - you seem to appreciate quality ${
            series ? 'television' : 'cinema'
        }`;
    }

    // Popularity
    if (popularityScore > 0.7) {
        return 'Trending and well-received - popular with viewers like you';
    }

    // Exceptional IMDB rating
    if (imdbRating && imdbRating > 8.0) {
        return `Exceptional ${singularNoun} (${imdbRating}/10 IMDB) in a genre you enjoy`;
    }

    // Availability
    if (isAvailable) {
        return 'Available to watch now - similar to your viewing preferences';
    }

    // Fallback reasons with variety — seeded (deterministic per user+item),
    // never Math.random, so the same card never flickers between reasons.
    const fallbacks = [
        'Recommended based on your viewing patterns',
        'Selected for your unique taste profile',
        'Discovered through your preference analysis',
        'Curated match for your interests',
        'AI-selected based on your taste profile',
    ];

    const rng = mulberry32(seed >>> 0);
    return fallbacks[Math.floor(rng() * fallbacks.length)];
}

/**
 * Structured, client-localizable recommendation reason. Persisted alongside
 * the legacy English `explanation` text (see `generateEnhancedRecommendationReason`)
 * so clients can render a localized string from `kind` + payload instead of
 * parsing/re-translating the English prose. The legacy widget keeps rendering
 * `explanation` untouched until Plan 3 moves clients over to this shape.
 */
export type SuggestionReasonData =
    | { kind: 'rated-similar'; title: string; rating: number }
    | { kind: 'genre-affinity'; genre: string }
    | { kind: 'ai' };

/**
 * Input for `generateStructuredReason`. Deliberately a subset of
 * `RecommendationReasonInput` — the structured reason intentionally carries
 * less nuance than the prose generator (no quality/popularity/IMDB tiers,
 * no seeded fallback variety): it only needs enough signal to pick one of the
 * three `SuggestionReasonData` kinds.
 */
export interface StructuredReasonInputs {
    /** Title of the anchor item (e.g. a highly-rated item this suggestion is similar to). */
    anchorTitle?: string;
    /** The user's rating (1-10) of the anchor item. */
    anchorRating?: number;
    /** FUSED library/discovery cosine similarity (0-1) — same value fed to the text generator. */
    similarity: number;
    /** Top genre name (already resolved, not a TMDB genre id) for the genre-affinity fallback. */
    topGenre?: string;
}

/**
 * Generate the structured sibling of `generateEnhancedRecommendationReason`.
 * Callers MUST pass the same anchor/similarity/genre values the text
 * generator receives for the same suggestion, so the English prose and the
 * structured data can never disagree about *why* an item was suggested.
 *
 * @param inputs - Structured reason configuration
 * @returns One of `rated-similar` / `genre-affinity` / `ai`
 *
 * @example
 * const reason = generateStructuredReason({
 *   anchorTitle: 'Inception',
 *   anchorRating: 9,
 *   similarity: 0.7,
 *   topGenre: 'Science Fiction',
 * });
 * // => { kind: 'rated-similar', title: 'Inception', rating: 9 }
 */
export function generateStructuredReason(inputs: StructuredReasonInputs): SuggestionReasonData {
    if (
        inputs.anchorTitle &&
        typeof inputs.anchorRating === 'number' &&
        inputs.similarity >= STRONG_SIMILARITY_THRESHOLD
    ) {
        return { kind: 'rated-similar', title: inputs.anchorTitle, rating: inputs.anchorRating };
    }
    if (inputs.topGenre) {
        return { kind: 'genre-affinity', genre: inputs.topGenre };
    }
    return { kind: 'ai' };
}

// =============================================================================
// Media Embedding Mapping
// =============================================================================

/**
 * Map raw SQL row to MediaEmbedding format.
 * Centralizes the transformation logic for media embedding results.
 *
 * @param row - Raw SQL result row
 * @returns Formatted MediaEmbedding object
 *
 * @example
 * const results = await sql`SELECT ...`;
 * const embeddings = results.map(mapRowToMediaEmbedding);
 */
export function mapRowToMediaEmbedding(row: {
    id?: number;
    media_uuid?: string;
    tmdb_id: number;
    imdb_id?: string | null;
    media_type: string;
    title: string;
    original_title?: string | null;
    release_year?: number | null;
    is_local_only?: boolean;
    created_at?: Date;
    updated_at?: Date;
    overview?: string | null;
    genres?: number[] | null;
    vote_count?: number | null;
    popularity?: number | null;
    runtime_minutes?: number | null;
    imdb_rating?: number | null;
    rt_rating?: number | null;
    rt_audience_score?: number | null;
    mdblist_score?: number | null;
    letterboxd_rating?: number | null;
    letterboxd_votes?: number | null;
    metacritic_score?: number | null;
    trakt_score?: number | null;
    actors?: unknown;
    directors?: unknown;
    poster_path?: string | null;
    backdrop_path?: string | null;
    is_available?: boolean;
    can_request?: boolean;
    jellyfin_id?: string | null;
    library_embedding?: unknown;
    discovery_embedding?: unknown;
}): {
    id: number;
    tmdb_id: number;
    imdb_id: string | null;
    media_type: string;
    title: string;
    original_title: string | null;
    release_year: number | null;
    is_local_only: boolean;
    created_at: Date;
    updated_at: Date;
    overview: string | null;
    genres: number[] | null;
    vote_count: number | null;
    popularity: number | null;
    runtime_minutes: number | null;
    imdb_rating: number | null;
    rt_rating: number | null;
    rt_audience_score: number | null;
    mdblist_score: number | null;
    letterboxd_rating: number | null;
    letterboxd_votes: number | null;
    metacritic_score: number | null;
    trakt_score: number | null;
    actors: unknown;
    directors: unknown;
    poster_path: string | null;
    backdrop_path: string | null;
    is_available: boolean;
    can_request: boolean;
    jellyfin_id: string | null;
    library_embedding: unknown;
    discovery_embedding: unknown;
} {
    return {
        id: row.id ?? 0,
        tmdb_id: row.tmdb_id,
        imdb_id: row.imdb_id ?? null,
        media_type: row.media_type,
        title: row.title,
        original_title: row.original_title ?? null,
        release_year: row.release_year ?? null,
        is_local_only: row.is_local_only ?? false,
        created_at: row.created_at ?? new Date(),
        updated_at: row.updated_at ?? new Date(),
        overview: row.overview ?? null,
        genres: row.genres ?? null,
        vote_count: row.vote_count ?? null,
        popularity: row.popularity ?? null,
        runtime_minutes: row.runtime_minutes ?? null,
        imdb_rating: row.imdb_rating ?? null,
        rt_rating: row.rt_rating ?? null,
        rt_audience_score: row.rt_audience_score ?? null,
        mdblist_score: row.mdblist_score ?? null,
        letterboxd_rating: row.letterboxd_rating ?? null,
        letterboxd_votes: row.letterboxd_votes ?? null,
        metacritic_score: row.metacritic_score ?? null,
        trakt_score: row.trakt_score ?? null,
        actors: row.actors ?? null,
        directors: row.directors ?? null,
        poster_path: row.poster_path ?? null,
        backdrop_path: row.backdrop_path ?? null,
        is_available: row.is_available ?? false,
        can_request: row.can_request ?? false,
        jellyfin_id: row.jellyfin_id ?? null,
        library_embedding: row.library_embedding ?? null,
        discovery_embedding: row.discovery_embedding ?? null,
    };
}

// =============================================================================
// Database Operations
// =============================================================================

/**
 * Save suggestions to database with transaction-based batch operations.
 * Centralizes suggestion persistence logic for consistency.
 *
 * @param sql - Postgres SQL connection
 * @param userId - User identifier
 * @param suggestions - Suggestions to save
 * @param expiryDays - Days until expiry (default: 2)
 *
 * @example
 * await saveSuggestionsToDatabase(sql, 'user123', suggestions, 2);
 */
export async function saveSuggestionsToDatabase(
    sql: postgres.Sql,
    userId: string,
    suggestions: UserSuggestionInput[],
    expiryDays: number = 2,
): Promise<void> {
    if (suggestions.length === 0) return;

    // Resolve external IDs to internal UUIDs (provider-agnostic)
    const { resolveExternalIdToUuid } = await import('../queries/media-lookup.queries.js');

    const resolvedSuggestions = await Promise.all(
        suggestions.map(async (s) => {
            const mediaId = await resolveExternalIdToUuid(
                sql,
                s.primary_ext_id,
                // No cast: the param is matched verbatim against
                // external_ids.media_type, which holds episode/season rows too.
                s.media_type,
            );
            return mediaId ? { ...s, media_id: mediaId } : null;
        }),
    );

    // Filter out any suggestions that couldn't be resolved
    const validSuggestions = resolvedSuggestions.filter(
        (s): s is NonNullable<typeof s> => s !== null,
    );

    if (validSuggestions.length === 0) return;

    // Calculate expiry timestamp
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

    // Use transaction for atomic batch operation
    await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;

        // Clear old suggestions, scoped to the media types present in THIS
        // batch. A blanket `DELETE ... WHERE user_id = ?` let a single-type
        // generation (e.g. a movie-only watched-based request) wipe the user's
        // TV suggestions and repopulate the pool movies-only, which a later
        // mixed read then served. A mixed batch still clears both types
        // (batchMediaTypes = ['movie','tv']); a single-type batch leaves the
        // other type's still-valid rows untouched.
        const batchMediaTypes = [...new Set(validSuggestions.map((s) => s.media_type))];
        await tx`
            DELETE FROM user_suggestions
            WHERE user_id = ${userId}
              AND media_id IN (
                  SELECT id FROM media_items WHERE media_type = ANY(${batchMediaTypes}::text[])
              )
        `;

        // Insert new suggestions
        for (const s of validSuggestions) {
            await tx`
                INSERT INTO user_suggestions (
                    user_id, media_id, combined_score,
                    library_similarity_score, discovery_similarity_score,
                    explanation, reason_data, expires_at
                )
                VALUES (
                    ${userId},
                    ${s.media_id},
                    ${s.combined_score},
                    ${s.library_similarity_score ?? null},
                    ${s.discovery_similarity_score ?? null},
                    ${s.suggestion_reason ?? null},
                    ${s.reasonData ? tx.json(s.reasonData) : null},
                    ${expiresAt}
                )
            `;
        }
    });
}

// =============================================================================
// Advisory Lock Utilities
// =============================================================================

/**
 * Execute operation with PostgreSQL advisory lock.
 * Handles lock acquisition, retry logic, and cleanup.
 *
 * @param sql - Postgres SQL connection
 * @param lockKey - Lock key string (max 63 chars)
 * @param operation - Operation to execute with lock
 * @param fallback - Fallback operation if lock cannot be acquired
 * @returns Result from operation or fallback
 *
 * @example
 * const result = await withAdvisoryLock(
 *   sql,
 *   'suggestions_user123',
 *   async () => generateSuggestions(),
 *   async () => getCachedSuggestions()
 * );
 */
export async function withAdvisoryLock<T>(
    sql: postgres.Sql,
    lockKey: string,
    operation: () => Promise<T>,
    fallback: () => Promise<T>,
): Promise<T> {
    // Session advisory locks MUST acquire and release on the SAME connection.
    // The previous implementation ran both through the pool, so the unlock
    // routinely hit a different connection: it returned false (WARNING) and
    // the lock stayed held on the original pooled connection ~forever,
    // permanently forcing that key onto the fallback path. A reserved
    // connection pins both. The key is hashed with Postgres's own hashtext()
    // (same idiom as database/with-advisory-lock.ts) — the old JS char-code
    // SUM collided for any two keys with equal character multisets.
    // A reserve() failure (pool exhausted, connection error) must DEGRADE to the
    // fallback — which runs on the pool, not the reserved connection — rather
    // than throw and 500 the whole suggestion request.
    let reserved: Awaited<ReturnType<typeof sql.reserve>>;
    try {
        reserved = await sql.reserve();
    } catch (error) {
        logger.warn('Advisory lock: reserve() failed, serving fallback', {}, error as Error);
        return fallback();
    }

    const tryAcquire = async (): Promise<boolean> => {
        const [row] = await reserved<[{ acquired: boolean }]>`
            SELECT pg_try_advisory_lock(hashtext(${lockKey})) as acquired
        `;
        // pg_try_advisory_lock always returns exactly one row; guard defensively
        // so a driver-level empty rowset degrades to "not acquired" not a crash.
        return row?.acquired ?? false;
    };

    let lockAcquired = false;
    try {
        lockAcquired = await tryAcquire();

        if (!lockAcquired) {
            // Contended: serve the fallback, then give the holder a moment
            // and retry once before settling for the fallback result.
            const fallbackResult = await fallback();
            await new Promise((resolve) => setTimeout(resolve, 500));
            lockAcquired = await tryAcquire();
            if (!lockAcquired) {
                return fallbackResult;
            }
        }

        return await operation();
    } finally {
        try {
            if (lockAcquired) {
                await reserved`SELECT pg_advisory_unlock(hashtext(${lockKey}))`;
            }
        } catch (error) {
            // Non-fatal: releasing the reserved connection below returns it to
            // the pool; the session lock dies with the connection if unlock
            // failed for a transient reason.
            logger.warn('Failed to release advisory lock', {}, error as Error);
        } finally {
            // release() must never mask the operation result / a real throw.
            try {
                reserved.release();
            } catch {
                /* connection already returned to / dropped from the pool */
            }
        }
    }
}
