// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * THE cross-basis test.
 *
 * Every other test file in this module (`quantize.test.ts`, `fit.test.ts`)
 * checks each function in isolation -- which, per the eval doc, is exactly
 * what would NOT have caught the real risk: "two independently-fit bases
 * are each individually fine... only the mixed comparison breaks. A naive
 * self-consistent test would pass." This file is the one that compares
 * across bases on purpose, in two complementary ways:
 *
 *   1. A numeric measurement (`describe('recall degrades...')`): fit two
 *      independent bases over similar synthetic data, then show that
 *      nearest-neighbour recall computed same-basis vastly outperforms
 *      recall computed with the query under basis A and candidates under
 *      basis B. This is the same methodology the eval doc used to produce
 *      its 93.9% (same) vs 16.4-39.4% (mismatched) numbers, just on a
 *      synthetic corpus so the test is fast and self-contained.
 *
 *   2. The version-mismatch guard (`describe('selectServableProjectedVector')`):
 *      `selectServableProjectedVector` is the one place in the codebase that
 *      is supposed to prevent case 1 from ever reaching a real client --
 *      it refuses to serve a stored vector whose version doesn't match the
 *      currently active one. These tests are the mutation-check target: if
 *      that guard is edited to ignore the version (i.e. the exact "silently
 *      tolerate a version mismatch" bug), the tests in that `describe` block
 *      fail immediately. See the verification notes in the PR/commit this
 *      test shipped with for the actual mutate-run-revert-run exercise.
 */

import { describe, it, expect } from 'vitest';
import { fitUncenteredPcaBasis } from './fit.js';
import { projectAndQuantize, selectServableProjectedVector } from './quantize.js';
import type { ProjectionBasis } from './types.js';

function mulberry32(seed: number): () => number {
    let state = seed | 0;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / Math.sqrt(na * nb);
}

/** Indices of the top-k highest-cosine candidates against `query`, excluding `excludeIndex`. */
function topKByCosine(
    query: ArrayLike<number>,
    candidates: ArrayLike<number>[],
    k: number,
    excludeIndex: number,
): number[] {
    const scored = candidates
        .map((c, i) => ({ i, score: i === excludeIndex ? -Infinity : cosine(query, c) }))
        .sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map((s) => s.i);
}

function recallAt(truth: number[], predicted: number[]): number {
    const truthSet = new Set(truth);
    let hits = 0;
    for (const p of predicted) if (truthSet.has(p)) hits++;
    return hits / truth.length;
}

/**
 * A synthetic corpus with cluster structure (concentrated energy in a
 * `latentDim`-dim subspace), so nearest-neighbour queries have a real
 * "correct answer" and PCA has real structure to find -- mirrors why real
 * MSCLAP embeddings work for this feature at all (eval doc: top-64 = 98.2%
 * of uncentered energy).
 */
function makeClusteredCorpus(
    inputDim: number,
    latentDim: number,
    clusterCount: number,
    perCluster: number,
    seed: number,
): number[][] {
    const rand = mulberry32(seed);
    const clusterCenters: number[][] = Array.from({ length: clusterCount }, () =>
        Array.from({ length: latentDim }, () => (rand() * 2 - 1) * 4),
    );
    const latentDirs: number[][] = Array.from({ length: latentDim }, (_, d) =>
        Array.from({ length: inputDim }, (_, i) => Math.sin((d + 1) * (i + 1) * 0.53)),
    );
    const vectors: number[][] = [];
    for (const center of clusterCenters) {
        for (let n = 0; n < perCluster; n++) {
            const v = new Array<number>(inputDim).fill(0);
            for (let d = 0; d < latentDim; d++) {
                const coeff = center[d] + (rand() - 0.5) * 0.3; // small within-cluster spread
                for (let i = 0; i < inputDim; i++) {
                    v[i] += coeff * latentDirs[d][i];
                }
            }
            vectors.push(v);
        }
    }
    return vectors;
}

describe('cross-basis recall degradation (numeric measurement)', () => {
    const inputDim = 48;
    const latentDim = 6;

    it('mixing an independently-fit basis collapses recall vs comparing within one basis', () => {
        // Two independent corpora over the SAME latent structure but different
        // sampling noise/order -- mirrors the eval doc's "two independently-fit
        // bases, each individually fine" setup, not a degenerate/adversarial one.
        const corpusA = makeClusteredCorpus(inputDim, latentDim, 8, 25, 101);
        const corpusB = makeClusteredCorpus(inputDim, latentDim, 8, 25, 202);

        const basisA = fitUncenteredPcaBasis(corpusA, inputDim, latentDim, {
            seed: 11,
            iterations: 60,
        });
        const basisB = fitUncenteredPcaBasis(corpusB, inputDim, latentDim, {
            seed: 22,
            iterations: 60,
        });
        const projA: ProjectionBasis = { version: 1, modelId: 'test', ...basisA };
        const projB: ProjectionBasis = { version: 2, modelId: 'test', ...basisB };

        // Evaluation pool: corpus A itself. Ground truth = full-inputDim cosine.
        const pool = corpusA;
        const queryIndices = Array.from({ length: 40 }, (_, i) => i * 5).filter(
            (i) => i < pool.length,
        );
        const k = 5;

        let sameBasisRecallSum = 0;
        let mixedBasisRecallSum = 0;

        // Precompute projections once per basis (apply-path only, never refit mid-loop).
        const quantizedA = pool.map((v) => Array.from(projectAndQuantize(v, projA)));
        const quantizedB = pool.map((v) => Array.from(projectAndQuantize(v, projB)));

        for (const qIdx of queryIndices) {
            const truth = topKByCosine(pool[qIdx], pool, k, qIdx);

            // Same-basis: query and every candidate projected through basis A.
            const sameBasisPred = topKByCosine(quantizedA[qIdx], quantizedA, k, qIdx);
            sameBasisRecallSum += recallAt(truth, sameBasisPred);

            // Mixed-basis: query stored under basis A, candidates under basis B --
            // exactly the "client held vectors from before a version bump" scenario.
            const mixedBasisPred = topKByCosine(quantizedA[qIdx], quantizedB, k, qIdx);
            mixedBasisRecallSum += recallAt(truth, mixedBasisPred);
        }

        const sameBasisRecall = sameBasisRecallSum / queryIndices.length;
        const mixedBasisRecall = mixedBasisRecallSum / queryIndices.length;

        // Same-basis must recover most of the true neighbourhood (the whole
        // point of the feature -- this is the 93.9%-style control row).
        expect(sameBasisRecall).toBeGreaterThan(0.6);
        // Mixed-basis must degrade badly -- this is the 16.4-39.4%-style row.
        expect(mixedBasisRecall).toBeLessThan(0.3);
        // And the RELATIVE collapse is the actual claim under test: mixing
        // bases must be dramatically worse than staying within one, not just
        // "somewhat worse" -- matching the eval doc's "collapse", not "dip".
        expect(mixedBasisRecall).toBeLessThan(sameBasisRecall * 0.5);
    });
});

describe('selectServableProjectedVector — the version-mismatch guard (mutation-check target)', () => {
    const vector = Buffer.from(Array.from({ length: 8 }, (_, i) => i));

    it('returns null when nothing is stored', () => {
        expect(selectServableProjectedVector(null, 1)).toBeNull();
    });

    it('returns the vector when the stored version matches the active version', () => {
        expect(selectServableProjectedVector({ version: 1, vector }, 1)).toBe(vector);
    });

    it('returns null when the stored version does NOT match the active version', () => {
        // This is the operational form of the numeric measurement above: a
        // vector fit under a different basis must never be handed to a caller
        // as if it were comparable to the current one.
        expect(selectServableProjectedVector({ version: 2, vector }, 1)).toBeNull();
        expect(selectServableProjectedVector({ version: 1, vector }, 2)).toBeNull();
    });

    it('never serves a mismatched version even when the vector content is otherwise valid', () => {
        const otherVector = Buffer.from(Array.from({ length: 8 }, (_, i) => 127 - i));
        expect(selectServableProjectedVector({ version: 3, vector: otherVector }, 1)).toBeNull();
    });
});
