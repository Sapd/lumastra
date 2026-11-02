// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { parseEmbedding, cosineSimilarity, cosineSimilarityOrDefault } from './embedding-utils.js';

describe('parseEmbedding', () => {
    it('returns null for null input', () => {
        expect(parseEmbedding(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
        expect(parseEmbedding(undefined)).toBeNull();
    });

    it('returns the array directly if already an array', () => {
        const embedding = [0.1, 0.2, 0.3];
        expect(parseEmbedding(embedding)).toEqual([0.1, 0.2, 0.3]);
    });

    it('parses JSON string to array', () => {
        const embedding = '[0.1, 0.2, 0.3]';
        expect(parseEmbedding(embedding)).toEqual([0.1, 0.2, 0.3]);
    });

    it('returns null for invalid JSON string', () => {
        expect(parseEmbedding('not valid json')).toBeNull();
    });

    it('returns null for empty string', () => {
        expect(parseEmbedding('')).toBeNull();
    });
});

describe('cosineSimilarity', () => {
    it('returns 1 for identical normalized vectors', () => {
        const vec = [0.6, 0.8]; // normalized: sqrt(0.36 + 0.64) = 1
        const result = cosineSimilarity(vec, vec);
        expect(result).toBeCloseTo(1, 5);
    });

    it('returns -1 for opposite normalized vectors', () => {
        const vecA = [0.6, 0.8];
        const vecB = [-0.6, -0.8];
        const result = cosineSimilarity(vecA, vecB);
        expect(result).toBeCloseTo(-1, 5);
    });

    it('returns 0 for orthogonal vectors', () => {
        const vecA = [1, 0];
        const vecB = [0, 1];
        const result = cosineSimilarity(vecA, vecB);
        expect(result).toBeCloseTo(0, 5);
    });

    it('handles JSON string inputs', () => {
        const vecA = '[0.6, 0.8]';
        const vecB = [0.6, 0.8];
        const result = cosineSimilarity(vecA, vecB);
        expect(result).toBeCloseTo(1, 5);
    });

    it('returns null for null inputs', () => {
        expect(cosineSimilarity(null, [1, 0])).toBeNull();
        expect(cosineSimilarity([1, 0], null)).toBeNull();
        expect(cosineSimilarity(null, null)).toBeNull();
    });

    it('returns null for empty arrays', () => {
        expect(cosineSimilarity([], [1, 0])).toBeNull();
        expect(cosineSimilarity([1, 0], [])).toBeNull();
    });

    it('handles vectors of different lengths (uses shorter)', () => {
        const vecA = [0.6, 0.8, 0.5];
        const vecB = [0.6, 0.8];
        // Should compute dot product of first 2 elements: 0.36 + 0.64 = 1
        const result = cosineSimilarity(vecA, vecB);
        expect(result).toBeCloseTo(1, 5);
    });

    it('computes correct similarity for realistic embeddings', () => {
        // Simulating OpenAI-style normalized embeddings (small subset)
        const vecA = [0.1, 0.2, 0.3, 0.4, 0.5];
        const vecB = [0.15, 0.25, 0.35, 0.45, 0.55];
        // dot = 0.015 + 0.05 + 0.105 + 0.18 + 0.275 = 0.625
        const result = cosineSimilarity(vecA, vecB);
        expect(result).toBeCloseTo(0.625, 5);
    });

    it('clamps result to [-1, 1] range', () => {
        // Create vectors that might produce slight floating point errors
        const vec = Array(1000).fill(0.0316227766); // sqrt(1/1000), normalized
        const result = cosineSimilarity(vec, vec);
        expect(result).toBeLessThanOrEqual(1);
        expect(result).toBeGreaterThanOrEqual(-1);
        expect(result).toBeCloseTo(1, 4);
    });
});

describe('cosineSimilarityOrDefault', () => {
    it('returns similarity for valid inputs', () => {
        const vec = [0.6, 0.8];
        const result = cosineSimilarityOrDefault(vec, vec);
        expect(result).toBeCloseTo(1, 5);
    });

    it('returns default value (0.5) for null inputs', () => {
        expect(cosineSimilarityOrDefault(null, [1, 0])).toBe(0.5);
        expect(cosineSimilarityOrDefault([1, 0], null)).toBe(0.5);
    });

    it('returns custom default value when specified', () => {
        expect(cosineSimilarityOrDefault(null, null, 0.75)).toBe(0.75);
    });

    it('returns default for empty arrays', () => {
        expect(cosineSimilarityOrDefault([], [1, 0], 0.3)).toBe(0.3);
    });
});
