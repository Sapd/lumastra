// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { mmrRerank } from './mmr';

interface Doc {
    id: string;
    rel: number;
    vec: number[];
}

const cosine = (a: number[], b: number[]): number => {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
};

describe('mmrRerank', () => {
    it('returns empty when count is 0', () => {
        const docs: Doc[] = [{ id: 'a', rel: 1, vec: [1, 0] }];
        const result = mmrRerank(docs, {
            count: 0,
            relevance: (d) => d.rel,
            similarity: (a, b) => cosine(a.vec, b.vec),
        });
        expect(result).toEqual([]);
    });

    it('returns all items when count exceeds candidates', () => {
        const docs: Doc[] = [
            { id: 'a', rel: 1, vec: [1, 0] },
            { id: 'b', rel: 0.5, vec: [0, 1] },
        ];
        const result = mmrRerank(docs, {
            count: 10,
            relevance: (d) => d.rel,
            similarity: (a, b) => cosine(a.vec, b.vec),
        });
        expect(result).toHaveLength(2);
    });

    it('lambda=1.0 picks pure top-relevance order', () => {
        const docs: Doc[] = [
            { id: 'low', rel: 0.1, vec: [1, 0] },
            { id: 'mid', rel: 0.5, vec: [0, 1] },
            { id: 'top', rel: 0.9, vec: [0.7, 0.7] },
        ];
        const result = mmrRerank(docs, {
            count: 3,
            lambda: 1.0,
            relevance: (d) => d.rel,
            similarity: (a, b) => cosine(a.vec, b.vec),
        });
        expect(result.map((d) => d.id)).toEqual(['top', 'mid', 'low']);
    });

    it('lambda=0.5 prefers diversity over near-duplicates', () => {
        // Two near-duplicates (same vec) at top relevance, one diverse at lower relevance.
        // With lambda=1.0 we'd get [dup1, dup2, diverse].
        // With lambda=0.5 the diverse item should be picked second.
        const docs: Doc[] = [
            { id: 'dup1', rel: 0.9, vec: [1, 0] },
            { id: 'dup2', rel: 0.85, vec: [1, 0] },
            { id: 'diverse', rel: 0.7, vec: [0, 1] },
        ];
        const result = mmrRerank(docs, {
            count: 2,
            lambda: 0.5,
            relevance: (d) => d.rel,
            similarity: (a, b) => cosine(a.vec, b.vec),
        });
        expect(result[0].id).toBe('dup1');
        expect(result[1].id).toBe('diverse');
    });

    it('does not return duplicates', () => {
        const docs: Doc[] = [
            { id: 'a', rel: 1, vec: [1, 0] },
            { id: 'b', rel: 0.5, vec: [0, 1] },
            { id: 'c', rel: 0.3, vec: [0.5, 0.5] },
        ];
        const result = mmrRerank(docs, {
            count: 3,
            relevance: (d) => d.rel,
            similarity: (a, b) => cosine(a.vec, b.vec),
        });
        const ids = result.map((d) => d.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('skips candidates whose relevance is not finite (E1)', () => {
        const docs: Doc[] = [
            { id: 'nan', rel: Number.NaN, vec: [1, 0] },
            { id: 'inf', rel: Number.POSITIVE_INFINITY, vec: [0, 1] },
            { id: 'real', rel: 0.3, vec: [0.5, 0.5] },
        ];
        const result = mmrRerank(docs, {
            count: 3,
            relevance: (d) => d.rel,
            similarity: (a, b) => cosine(a.vec, b.vec),
        });
        // Only the finite-relevance candidate should survive.
        expect(result.map((d) => d.id)).toEqual(['real']);
    });

    it('returns empty when count or lambda is not finite (E2)', () => {
        const docs: Doc[] = [{ id: 'a', rel: 1, vec: [1, 0] }];
        const nanCount = mmrRerank(docs, {
            count: Number.NaN,
            relevance: (d) => d.rel,
            similarity: (a, b) => cosine(a.vec, b.vec),
        });
        expect(nanCount).toEqual([]);
        // Non-finite lambda falls back to the default 0.5 rather than
        // poisoning the score.
        const nanLambda = mmrRerank(docs, {
            count: 1,
            lambda: Number.NaN,
            relevance: (d) => d.rel,
            similarity: (a, b) => cosine(a.vec, b.vec),
        });
        expect(nanLambda).toHaveLength(1);
    });

    it('de-prioritizes candidates whose similarity cannot be computed', () => {
        // "broken" returns null similarity (e.g. missing embedding). MMR
        // must NOT prefer it over a valid diverse candidate.
        const docs: Doc[] = [
            { id: 'dup', rel: 0.9, vec: [1, 0] },
            { id: 'broken', rel: 0.8, vec: [] }, // null similarity
            { id: 'diverse', rel: 0.7, vec: [0, 1] },
        ];
        const result = mmrRerank(docs, {
            count: 2,
            lambda: 0.5,
            relevance: (d) => d.rel,
            similarity: (a, b) => {
                if (a.vec.length === 0 || b.vec.length === 0) return null;
                return cosine(a.vec, b.vec);
            },
        });
        expect(result[0].id).toBe('dup');
        // Second pick should be the diverse one, not the broken one.
        expect(result[1].id).toBe('diverse');
    });
});

/**
 * The pre-2026-08-21 implementation, verbatim apart from the name.
 *
 * `mmrRerank` was rewritten from O(n·k²) to O(n·k) by carrying each
 * candidate's max-similarity-to-the-selected-set across rounds instead of
 * recomputing it inside them. That is an algebraic identity, not a heuristic,
 * so it is worth holding to the strict standard: identical output on every
 * input, not merely similar rankings. This reference exists to assert exactly
 * that — if a future change to `mmrRerank` is a genuine behaviour change, this
 * is the test that should fail and be deliberately updated.
 */
function mmrRerankReference<T>(
    candidates: T[],
    opts: {
        count: number;
        relevance: (item: T) => number;
        similarity: (a: T, b: T) => number | null;
        lambda?: number;
    },
): T[] {
    const rawLambda = opts.lambda ?? 0.5;
    const lambda = Number.isFinite(rawLambda) ? rawLambda : 0.5;
    const rawCount = opts.count;
    if (!Number.isFinite(rawCount)) return [];
    const target = Math.min(rawCount, candidates.length);
    if (target <= 0) return [];

    const remaining = [...candidates];
    const selected: T[] = [];

    while (selected.length < target && remaining.length > 0) {
        let bestIdx = -1;
        let bestScore = -Infinity;

        for (let i = 0; i < remaining.length; i++) {
            const candidate = remaining[i];
            const rel = opts.relevance(candidate);
            if (!Number.isFinite(rel)) continue;

            let maxSim = selected.length === 0 ? -Infinity : -1;
            for (const chosen of selected) {
                const sim = opts.similarity(candidate, chosen);
                const effective = sim === null ? Number.POSITIVE_INFINITY : sim;
                if (effective > maxSim) maxSim = effective;
            }

            const diversityPenalty = selected.length === 0 ? 0 : maxSim;
            const score = lambda * rel - (1 - lambda) * diversityPenalty;
            if (score > bestScore) {
                bestScore = score;
                bestIdx = i;
            }
        }

        if (bestIdx < 0) break;
        selected.push(remaining.splice(bestIdx, 1)[0]);
    }

    return selected;
}

describe('mmrRerank — equivalence with the pre-optimisation implementation', () => {
    /** Deterministic PRNG, so a failure is reproducible from its seed alone. */
    function mulberry32(seed: number): () => number {
        let a = seed >>> 0;
        return () => {
            a = (a + 0x6d2b79f5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    it('returns identical selections across randomised inputs', () => {
        for (let seed = 1; seed <= 200; seed++) {
            const rnd = mulberry32(seed);
            const n = 1 + Math.floor(rnd() * 40);
            const dims = 1 + Math.floor(rnd() * 4);
            const docs: Doc[] = Array.from({ length: n }, (_, i) => ({
                id: `d${i}`,
                // ~8% non-finite relevance, to cover the skip branch.
                rel: rnd() < 0.08 ? Number.NaN : rnd(),
                // ~10% empty vector, to cover the null-similarity branch.
                vec: rnd() < 0.1 ? [] : Array.from({ length: dims }, () => rnd() * 2 - 1),
            }));
            const count = Math.floor(rnd() * (n + 2));
            const lambda = rnd();
            const opts = {
                count,
                lambda,
                relevance: (d: Doc) => d.rel,
                similarity: (a: Doc, b: Doc) =>
                    a.vec.length === 0 || b.vec.length === 0 ? null : cosine(a.vec, b.vec),
            };

            const actual = mmrRerank(docs, opts).map((d) => d.id);
            const expected = mmrRerankReference(docs, opts).map((d) => d.id);
            expect(actual, `seed ${seed}`).toEqual(expected);
        }
    });

    it('agrees on the degenerate inputs the fast path could plausibly break', () => {
        const one: Doc[] = [{ id: 'only', rel: 0.5, vec: [1, 0] }];
        const allBroken: Doc[] = [
            { id: 'a', rel: 0.9, vec: [] },
            { id: 'b', rel: 0.8, vec: [] },
        ];
        const opts = (count: number) => ({
            count,
            lambda: 0.5,
            relevance: (d: Doc) => d.rel,
            similarity: (a: Doc, b: Doc) =>
                a.vec.length === 0 || b.vec.length === 0 ? null : cosine(a.vec, b.vec),
        });
        for (const [label, docs, count] of [
            ['single candidate, count 1', one, 1],
            ['single candidate, over-asked', one, 5],
            ['every similarity null', allBroken, 2],
            ['empty candidate list', [] as Doc[], 3],
        ] as const) {
            expect(
                mmrRerank(docs as Doc[], opts(count)).map((d) => d.id),
                label,
            ).toEqual(mmrRerankReference(docs as Doc[], opts(count)).map((d) => d.id));
        }
    });
});
