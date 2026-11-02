// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Suggestion Utility Functions
 *
 * Pure utility functions for suggestion generation that have no service dependencies.
 * These can be used by both the suggestion engine service and route handlers directly.
 *
 * Extracted from Database class to keep callers lightweight and support reuse.
 *
 * @module utils/suggestion-utils
 */

import { parseEmbedding as parseEmbeddingVector } from './embedding-utils.js';
import { Logger } from './logger.js';

const logger = Logger.for('SuggestionUtils');

// =============================================================================
// Episode Query Parsing
// =============================================================================

/**
 * Result of parsing an episode query string.
 */
export interface ParsedEpisodeQuery {
    seriesName: string;
    season: number;
    episode: number;
}

/**
 * Parse an episode notation from a search query.
 * Supports formats like: "Quiet Orbit S37E13", "S1E4", "S01E04", "s1e1", etc.
 *
 * @param query - Search query string
 * @returns Parsed episode query or null if no episode pattern is found
 *
 * @example
 * ```typescript
 * const parsed = parseEpisodeQuery("Quiet Orbit S37E13");
 * // Returns: { seriesName: "Quiet Orbit", season: 37, episode: 13 }
 *
 * const parsed2 = parseEpisodeQuery("Drifting Clouds");
 * // Returns: null (no episode pattern)
 * ```
 */
export function parseEpisodeQuery(query: string): ParsedEpisodeQuery | null {
    // Match patterns like S1E4, S01E04, s37e13, etc. (with optional series name before)
    // \s{0,8}: an unbounded \s* retried the whole whitespace run for every series-name
    // position, quadratic on a long run in a query the client chooses.
    const episodePattern = /^(.+?)\s{0,8}[Ss](\d{1,3})[Ee](\d{1,3})$/;
    const match = query.trim().match(episodePattern);

    if (match) {
        const seriesName = match[1].trim();
        const season = Number.parseInt(match[2], 10);
        const episode = Number.parseInt(match[3], 10);

        // Require a series name
        if (seriesName.length > 0 && season > 0 && episode > 0) {
            return { seriesName, season, episode };
        }
    }

    return null;
}

// =============================================================================
// Vector Similarity
// =============================================================================

/**
 * Calculate cosine similarity between two embedding vectors.
 *
 * Cosine similarity ranges from -1 (opposite) to 1 (identical).
 * For normalized embeddings (like OpenAI's), it's typically 0 to 1.
 *
 * Formula: cos(θ) = (A · B) / (||A|| * ||B||)
 *
 * @param vectorA - First embedding vector (can be array or JSONB string)
 * @param vectorB - Second embedding vector (can be array or JSONB string)
 * @returns Cosine similarity score (0-1), or 0 if vectors are invalid
 *
 * @example
 * ```typescript
 * const similarity = calculateCosineSimilarity(
 *   [0.1, 0.2, 0.3],
 *   [0.15, 0.25, 0.35]
 * );
 * // Returns: ~0.9998 (very similar)
 * ```
 */
export function calculateCosineSimilarity(
    vectorA: number[] | string,
    vectorB: number[] | string,
): number {
    try {
        // Parse vectors if they're strings (from JSONB)
        const a = parseEmbeddingVector(vectorA);
        const b = parseEmbeddingVector(vectorB);

        // Validate inputs
        if (!a || !b) {
            logger.warn('Invalid vector inputs - not arrays');
            return 0;
        }

        if (a.length !== b.length) {
            logger.warn('Vector dimensions do not match', {
                dimensionA: a.length,
                dimensionB: b.length,
            });
            return 0;
        }

        if (a.length === 0) {
            logger.warn('Empty vectors');
            return 0;
        }

        // Calculate dot product
        let dotProduct = 0;
        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
        }

        // Calculate magnitudes
        let magnitudeA = 0;
        let magnitudeB = 0;
        for (let i = 0; i < a.length; i++) {
            magnitudeA += a[i] * a[i];
            magnitudeB += b[i] * b[i];
        }

        magnitudeA = Math.sqrt(magnitudeA);
        magnitudeB = Math.sqrt(magnitudeB);

        // Avoid division by zero
        if (magnitudeA === 0 || magnitudeB === 0) {
            logger.warn('Zero magnitude vectors');
            return 0;
        }

        // Calculate cosine similarity
        const similarity = dotProduct / (magnitudeA * magnitudeB);

        // Clamp to [-1, 1] to handle floating point errors
        return Math.max(-1, Math.min(1, similarity));
    } catch (error) {
        logger.error('Error calculating cosine similarity', error as Error);
        return 0;
    }
}
