// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Deterministic ranking and genre-diversity utilities.
 *
 * All functions are pure — no side effects, no Math.random().
 * Callers supply seeds so output is stable for a given seed.
 */

// =============================================================================
// PRNG
// =============================================================================

/**
 * mulberry32 — fast, high-quality 32-bit seeded PRNG.
 *
 * Returns a factory that, each time it is called, advances the internal state
 * and returns a float in [0, 1).
 */
export function mulberry32(seed: number): () => number {
    let s = seed >>> 0;
    return (): number => {
        s += 0x6d2b79f5;
        let z = s;
        z = Math.imul(z ^ (z >>> 15), z | 1);
        z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
        return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
    };
}

// =============================================================================
// Hash
// =============================================================================

/**
 * FNV-1a 32-bit hash of a string. Re-exported from the browser-safe shared
 * module so client-side hero rotation can derive the SAME seed as the server.
 */
export { hashSeed } from '$lib/shared/hash-seed.js';

// =============================================================================
// Shuffle
// =============================================================================

/**
 * Fisher-Yates shuffle seeded by mulberry32.
 * Pure: returns a new array; input is not mutated.
 */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
    const result = [...items];
    const rng = mulberry32(seed);
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

// =============================================================================
// Genre-diverse MMR ranking
// =============================================================================

/**
 * Options for diversifyByGenre.
 */
export interface DiversifyByGenreOptions<T> {
    /** Maximum items to return (defaults to items.length) */
    limit?: number;
    /** Extract genre identifiers from an item */
    getGenres: (t: T) => Array<string | number>;
    /** Extract base score from an item (higher = better) */
    getScore: (t: T) => number;
    /** Score reduction per genre-overlap instance (default 0.05) */
    genrePenalty?: number;
    /** Maximum total penalty applied to a single candidate (default 0.3) */
    maxPenalty?: number;
    /**
     * Seed for tie-breaking. Candidates with exactly equal effective scores
     * are broken deterministically using mulberry32(seed) rather than Math.random().
     * Defaults to 0.
     */
    seed?: number;
}

/**
 * Greedy MMR (Maximal Marginal Relevance) genre-diversity selector.
 *
 * Algorithm:
 *   1. Sort input by score desc (tie-break: seeded random).
 *   2. Greedy loop: pick the unselected candidate with the highest
 *      (score − min(genreOverlapCount × genrePenalty, maxPenalty)).
 *   3. Track selected genres; repeat until limit is reached.
 *
 * Pure: does not mutate input. Deterministic for a given seed.
 */
export function diversifyByGenre<T>(items: readonly T[], opts: DiversifyByGenreOptions<T>): T[] {
    const {
        limit = items.length,
        getGenres,
        getScore,
        genrePenalty = 0.05,
        maxPenalty = 0.3,
        seed = 0,
    } = opts;

    if (items.length === 0) return [];

    // Normalize the cap: non-finite limit → no cap (all items); negative → none.
    const cap = !Number.isFinite(limit) ? items.length : Math.max(0, Math.floor(limit));
    if (cap === 0) return [];

    const rng = mulberry32(seed);

    // Attach a tiny seeded jitter so ties resolve deterministically (not by array order).
    // A non-finite score is coerced to -Infinity so it sorts last instead of poisoning
    // comparisons (NaN comparisons are always false → unstable sort).
    const withJitter = items.map((item) => {
        const raw = getScore(item);
        return {
            item,
            jitter: rng() * 1e-9, // sub-epsilon nudge — does not change ranking, only breaks ties
            baseScore: Number.isFinite(raw) ? raw : -Infinity,
        };
    });

    // Sort by score desc + jitter so the greedy loop starts from the best candidates
    withJitter.sort((a, b) => b.baseScore + b.jitter - (a.baseScore + a.jitter));

    const selected: T[] = [];
    const selectedGenres = new Map<string | number, number>(); // genre → count
    const selectedSet = new Set<number>(); // index into withJitter

    while (selected.length < cap && selectedSet.size < withJitter.length) {
        let bestIdx = -1;
        let bestScore = -Infinity;

        for (let i = 0; i < withJitter.length; i++) {
            if (selectedSet.has(i)) continue;

            const { item, jitter, baseScore } = withJitter[i];
            const genres = getGenres(item) ?? [];

            let genreOverlap = 0;
            for (const g of genres) {
                genreOverlap += selectedGenres.get(g) ?? 0;
            }

            const penalty = Math.min(genreOverlap * genrePenalty, maxPenalty);
            const effectiveScore = baseScore - penalty + jitter;

            if (effectiveScore > bestScore) {
                bestScore = effectiveScore;
                bestIdx = i;
            }
        }

        if (bestIdx === -1) break;

        selectedSet.add(bestIdx);
        const chosen = withJitter[bestIdx].item;
        selected.push(chosen);

        // Update genre counts
        for (const g of getGenres(chosen) ?? []) {
            selectedGenres.set(g, (selectedGenres.get(g) ?? 0) + 1);
        }
    }

    return selected;
}
