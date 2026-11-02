// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding utility functions for vector similarity calculations
 */

export type Embedding = number[] | string | null | undefined;

/**
 * Parse an embedding from database format (could be array or JSON string)
 */
export function parseEmbedding(embedding: Embedding): number[] | null {
    if (!embedding) return null;
    if (Array.isArray(embedding)) return embedding;
    if (typeof embedding === 'string') {
        try {
            const parsed: unknown = JSON.parse(embedding);
            if (!Array.isArray(parsed)) return null;
            if (parsed.every((value) => typeof value === 'number')) {
                return parsed;
            }
            return null;
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * Compute cosine similarity between two embedding vectors.
 *
 * For normalized vectors (like OpenAI embeddings), this equals the dot product.
 * Returns a value in [-1, 1] range where:
 *   - 1 = identical direction (most similar)
 *   - 0 = orthogonal (unrelated)
 *   - -1 = opposite direction (most dissimilar)
 *
 * This matches PostgreSQL pgvector's `1 - (a <=> b)` for normalized vectors.
 *
 * @param a First embedding vector
 * @param b Second embedding vector
 * @returns Cosine similarity in [-1, 1] range, or null if inputs are invalid
 */
export function cosineSimilarity(a: Embedding, b: Embedding): number | null {
    const vecA = parseEmbedding(a);
    const vecB = parseEmbedding(b);

    if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0) {
        return null;
    }

    // Use the shorter length to handle potential mismatches gracefully
    const len = Math.min(vecA.length, vecB.length);

    let dot = 0;
    for (let i = 0; i < len; i++) {
        dot += vecA[i] * vecB[i];
    }

    // For normalized vectors, dot product = cosine similarity
    // Clamp to [-1, 1] to handle floating point errors
    return Math.max(-1, Math.min(1, dot));
}

/**
 * Compute cosine similarity with a default value for invalid inputs.
 * Useful when you need a numeric result regardless of input validity.
 *
 * @param a First embedding vector
 * @param b Second embedding vector
 * @param defaultValue Value to return if similarity can't be computed (default: 0.5)
 * @returns Cosine similarity or default value
 */
export function cosineSimilarityOrDefault(
    a: Embedding,
    b: Embedding,
    defaultValue: number = 0.5,
): number {
    return cosineSimilarity(a, b) ?? defaultValue;
}

// =========================================================================
// Vector Arithmetic Functions
// =========================================================================

/**
 * Compute the L2 (Euclidean) magnitude of a vector.
 *
 * @param vec The input vector
 * @returns The L2 magnitude (sqrt of sum of squares)
 */
export function vectorMagnitude(vec: number[]): number {
    return Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0));
}

/**
 * Normalize a vector to unit length (L2 normalization).
 * Required for cosine similarity comparisons.
 *
 * @param vec The input vector
 * @returns Unit vector with the same direction, or zero vector if input is zero
 */
export function normalizeVector(vec: number[]): number[] {
    const magnitude = vectorMagnitude(vec);
    if (magnitude === 0) return vec.map(() => 0);
    return vec.map((val) => val / magnitude);
}

/**
 * Add two vectors with optional weights.
 * Result is NOT normalized - call normalizeVector() after if needed.
 *
 * Formula: result[i] = weightA * a[i] + weightB * b[i]
 *
 * @param a First vector
 * @param b Second vector (must be same length as a)
 * @param weightA Weight for first vector (default: 1.0)
 * @param weightB Weight for second vector (default: 1.0)
 * @returns Weighted sum of vectors
 */
export function addVectors(
    a: number[],
    b: number[],
    weightA: number = 1.0,
    weightB: number = 1.0,
): number[] {
    const len = Math.min(a.length, b.length);
    const result = new Array<number>(len);
    for (let i = 0; i < len; i++) {
        result[i] = weightA * a[i] + weightB * b[i];
    }
    return result;
}

/**
 * Subtract second vector from first with optional weight.
 * Result is NOT normalized - call normalizeVector() after if needed.
 *
 * Formula: result[i] = a[i] - weight * b[i]
 *
 * @param a Vector to subtract from
 * @param b Vector to subtract (must be same length as a)
 * @param weight Weight for the subtracted vector (default: 1.0)
 * @returns Difference vector
 */
export function subtractVectors(a: number[], b: number[], weight: number = 1.0): number[] {
    const len = Math.min(a.length, b.length);
    const result = new Array<number>(len);
    for (let i = 0; i < len; i++) {
        result[i] = a[i] - weight * b[i];
    }
    return result;
}

/**
 * Compute the element-wise average of multiple vectors.
 * Result is NOT normalized - call normalizeVector() after if needed.
 *
 * @param vectors Array of vectors (all must have the same length)
 * @returns Average vector, or empty array if no vectors provided
 */
export function averageVectors(vectors: number[][]): number[] {
    if (vectors.length === 0) return [];
    const dim = vectors[0].length;
    const result = new Array<number>(dim).fill(0);

    for (const vec of vectors) {
        for (let i = 0; i < dim; i++) {
            result[i] += vec[i];
        }
    }

    const count = vectors.length;
    for (let i = 0; i < dim; i++) {
        result[i] /= count;
    }

    return result;
}

/**
 * Combine mood vector with user preference vector using weighted addition.
 * Returns a normalized query vector for similarity search.
 *
 * Formula: normalize((moodWeight * moodVec) + (userWeight * userVec))
 *
 * @param moodVector Pre-computed mood direction vector
 * @param userVector User preference embedding (can be null)
 * @param moodWeight Weight for mood vector (default: 0.6)
 * @param userWeight Weight for user vector (default: 0.4)
 * @returns Normalized combined query vector
 */
export function combineMoodAndUserVectors(
    moodVector: number[],
    userVector: number[] | null,
    moodWeight: number = 0.6,
    userWeight: number = 0.4,
): number[] {
    if (!userVector) {
        // No user vector - just return normalized mood vector
        return normalizeVector(moodVector);
    }
    const combined = addVectors(moodVector, userVector, moodWeight, userWeight);
    return normalizeVector(combined);
}

/**
 * Apply negative steering to a source vector based on dismissed items.
 * Used to adjust "Because you watched" recommendations when users dismiss items.
 *
 * Formula: normalize(sourceVec - beta * avg(dismissedVecs))
 *
 * @param sourceVector The source media's embedding
 * @param dismissedVectors Array of dismissed items' embeddings
 * @param beta Steering strength (default: 0.3, higher = stronger steering)
 * @returns Steered query vector for finding recommendations away from dismissed content
 */
export function applyNegativeSteering(
    sourceVector: number[],
    dismissedVectors: number[][],
    beta: number = 0.3,
): number[] {
    if (dismissedVectors.length === 0) {
        return sourceVector; // Already assumed normalized from DB
    }

    const avgDismissed = averageVectors(dismissedVectors);
    const steered = subtractVectors(sourceVector, avgDismissed, beta);
    return normalizeVector(steered);
}
