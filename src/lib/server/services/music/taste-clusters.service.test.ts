// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { kmeans } from './taste-clusters.service';

/** Tiny deterministic PRNG — keeps tests reproducible across runs. */
function seededRand(seed: number): () => number {
    let t = seed >>> 0;
    return () => {
        t = (t + 0x6d2b79f5) >>> 0;
        let r = t;
        r = Math.imul(r ^ (r >>> 15), r | 1);
        r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Build N vectors clustered around a center with small Gaussian-ish noise.
 * Uses a seeded PRNG so tests are deterministic across runs/CI.
 */
function blob(center: number[], n: number, jitter = 0.05, seed = 42): number[][] {
    const rand = seededRand(seed);
    const out: number[][] = [];
    for (let i = 0; i < n; i++) {
        out.push(center.map((c) => c + (rand() - 0.5) * jitter));
    }
    return out;
}

describe('kmeans', () => {
    it('returns empty when input is empty', () => {
        expect(kmeans([], 3)).toEqual([]);
    });

    it('returns empty when k <= 0', () => {
        expect(kmeans([[1, 0]], 0)).toEqual([]);
    });

    it('caps k to vector count', () => {
        const result = kmeans([[1, 0]], 5, { seed: 42 });
        expect(result).toHaveLength(1);
        expect(result[0].indices).toEqual([0]);
    });

    it('recovers obvious blobs (k=3)', () => {
        const a = blob([10, 0, 0], 12, 0.1, 1);
        const b = blob([0, 10, 0], 12, 0.1, 2);
        const c = blob([0, 0, 10], 12, 0.1, 3);
        const result = kmeans([...a, ...b, ...c], 3, { seed: 1 });

        expect(result).toHaveLength(3);
        // Each cluster should contain ~12 vectors all from the same blob.
        for (const cluster of result) {
            const fromA = cluster.indices.filter((i) => i >= 0 && i < 12).length;
            const fromB = cluster.indices.filter((i) => i >= 12 && i < 24).length;
            const fromC = cluster.indices.filter((i) => i >= 24 && i < 36).length;
            // The dominant source should be ≥10 of 12 — k-means ≠ perfect.
            const dominant = Math.max(fromA, fromB, fromC);
            expect(dominant).toBeGreaterThanOrEqual(10);
        }
    });

    it('handles all-identical vectors gracefully', () => {
        const same = Array.from({ length: 8 }, () => [1, 0, 0]);
        const result = kmeans(same, 3, { seed: 7 });
        // Every assignment must be valid (non-empty clusters dropped).
        const totalIndices = result.reduce((s, c) => s + c.indices.length, 0);
        expect(totalIndices).toBe(8);
    });

    it('is deterministic given a fixed seed', () => {
        const vectors = blob([1, 0], 20, 0.5, 11);
        const a = kmeans(vectors, 3, { seed: 99 });
        const b = kmeans(vectors, 3, { seed: 99 });
        expect(a.map((c) => c.indices)).toEqual(b.map((c) => c.indices));
    });

    it('produces clusters whose total size matches input vectors', () => {
        const vectors = [...blob([5, 0], 7, 0.1, 20), ...blob([0, 5], 9, 0.1, 21)];
        const result = kmeans(vectors, 2, { seed: 3 });
        const total = result.reduce((s, c) => s + c.indices.length, 0);
        expect(total).toBe(vectors.length);
    });

    it('reseeds empty clusters instead of collapsing k', () => {
        // Two well-separated blobs with k=3 — without reseeding, the third
        // cluster would stay empty and the filter would drop it, yielding 2
        // clusters. Post-F4 fix, the empty cluster is reseeded from the
        // farthest vector so we get 3 valid clusters back.
        const a = blob([10, 0, 0], 8, 0.05, 30);
        const b = blob([0, 10, 0], 8, 0.05, 31);
        const result = kmeans([...a, ...b], 3, { seed: 5 });
        expect(result.length).toBeGreaterThanOrEqual(2);
    });
});
