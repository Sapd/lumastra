// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for the legacy `withAdvisoryLock` (fallback-flavoured variant used
 * by the suggestion engine — distinct from database/with-advisory-lock.ts).
 *
 * Regression coverage for two production bugs:
 *  1. Lock id was a char-code SUM → `suggestions_<uuidA>` and
 *     `suggestions_<uuidB>` collided whenever character multisets summed equal.
 *     Now hashed via Postgres hashtext(<key>) — asserted on the statement text.
 *  2. Acquire/unlock ran through the POOL → unlock could hit a different
 *     connection, stranding the session lock forever. Now both are pinned to
 *     one reserved connection, released in all paths.
 */

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import {
    withAdvisoryLock,
    monotonicRankScores,
    fuseSimilarity,
    generateEnhancedRecommendationReason,
    generateStructuredReason,
    type RecommendationReasonInput,
} from './recommendation-helpers.js';

interface FakeReserved {
    calls: string[];
    released: boolean;
}

function makeFakeSql(acquireResults: boolean[]): {
    sql: postgres.Sql;
    reserved: FakeReserved;
    reserveCount: () => number;
} {
    const state: FakeReserved = { calls: [], released: false };
    let acquireCallNumber = 0;
    let reserves = 0;

    const reservedTag = (strings: TemplateStringsArray, ...values: unknown[]) => {
        const stmt = strings.join('$');
        state.calls.push(`${stmt} :: ${values.join(',')}`);
        if (stmt.includes('pg_try_advisory_lock')) {
            const acquired = acquireResults[acquireCallNumber] ?? false;
            acquireCallNumber += 1;
            return Promise.resolve([{ acquired }]);
        }
        return Promise.resolve([]);
    };
    (reservedTag as unknown as { release: () => void }).release = () => {
        state.released = true;
    };

    const sql = {
        reserve: async () => {
            reserves += 1;
            return reservedTag;
        },
    } as unknown as postgres.Sql;

    return { sql, reserved: state, reserveCount: () => reserves };
}

describe('withAdvisoryLock (recommendation-helpers)', () => {
    it('runs operation when the lock is free, then unlocks and releases', async () => {
        const { sql, reserved } = makeFakeSql([true]);
        const fallback = vi.fn(async () => 'fallback');

        const result = await withAdvisoryLock(sql, 'suggestions_u1', async () => 'work', fallback);

        expect(result).toBe('work');
        expect(fallback).not.toHaveBeenCalled();
        expect(reserved.calls.some((c) => c.includes('pg_try_advisory_lock'))).toBe(true);
        expect(reserved.calls.some((c) => c.includes('pg_advisory_unlock'))).toBe(true);
        expect(reserved.released).toBe(true);
    });

    it('hashes the key with hashtext (not a JS-side sum)', async () => {
        const { sql, reserved } = makeFakeSql([true]);
        await withAdvisoryLock(
            sql,
            'suggestions_u1',
            async () => 'x',
            async () => 'y',
        );

        const acquire = reserved.calls.find((c) => c.includes('pg_try_advisory_lock'));
        expect(acquire).toContain('hashtext');
        // The raw key must be bound as the hashtext parameter.
        expect(acquire).toContain('suggestions_u1');
    });

    it('returns fallback result when contended twice; never runs operation; still releases', async () => {
        vi.useFakeTimers();
        try {
            const { sql, reserved } = makeFakeSql([false, false]);
            const operation = vi.fn(async () => 'work');

            const pending = withAdvisoryLock(sql, 'k', operation, async () => 'fallback');
            await vi.advanceTimersByTimeAsync(500);
            const result = await pending;

            expect(result).toBe('fallback');
            expect(operation).not.toHaveBeenCalled();
            // Never acquired → never unlocks, but ALWAYS releases the reservation.
            expect(reserved.calls.some((c) => c.includes('pg_advisory_unlock'))).toBe(false);
            expect(reserved.released).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('runs operation when the retry acquires the lock', async () => {
        vi.useFakeTimers();
        try {
            const { sql, reserved } = makeFakeSql([false, true]);

            const pending = withAdvisoryLock(
                sql,
                'k',
                async () => 'work-after-retry',
                async () => 'fallback',
            );
            await vi.advanceTimersByTimeAsync(500);
            const result = await pending;

            expect(result).toBe('work-after-retry');
            expect(reserved.calls.some((c) => c.includes('pg_advisory_unlock'))).toBe(true);
            expect(reserved.released).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('unlocks and releases even when operation throws', async () => {
        const { sql, reserved } = makeFakeSql([true]);
        const boom = new Error('operation failed');

        await expect(
            withAdvisoryLock(
                sql,
                'k',
                async () => {
                    throw boom;
                },
                async () => 'fallback',
            ),
        ).rejects.toBe(boom);

        expect(reserved.calls.some((c) => c.includes('pg_advisory_unlock'))).toBe(true);
        expect(reserved.released).toBe(true);
    });

    it('uses a single reserved connection for acquire and unlock', async () => {
        const { sql, reserveCount } = makeFakeSql([true]);
        await withAdvisoryLock(
            sql,
            'k',
            async () => 'x',
            async () => 'y',
        );
        expect(reserveCount()).toBe(1);
    });
});

// =============================================================================
// monotonicRankScores — order-preserving strictly-decreasing re-encoding
// =============================================================================

describe('monotonicRankScores', () => {
    it('keeps already-decreasing scores untouched', () => {
        expect(monotonicRankScores([0.9, 0.7, 0.5])).toEqual([0.9, 0.7, 0.5]);
    });

    it('clamps ties/inversions without stealing another item score', () => {
        // Diversified order put a 0.6-scoring item ahead of a 0.9-scoring one.
        // The 0.9 item must NOT keep 0.9 (that would reorder it above on serve);
        // it gets clamped just under its predecessor. The leader keeps ITS OWN 0.6.
        const out = monotonicRankScores([0.6, 0.9, 0.5]);
        expect(out[0]).toBe(0.6); // own score, NOT the pool max 0.9
        expect(out[1]).toBeLessThan(out[0]);
        expect(out[2]).toBeLessThan(out[1]);
        expect(out[2]).toBeLessThanOrEqual(0.5);
    });

    it('handles non-finite values as 0 before clamping', () => {
        const out = monotonicRankScores([Number.NaN, 0.4]);
        expect(out[0]).toBe(0);
        expect(out[1]).toBeLessThan(out[0]);
    });

    it('clamps inversions to strictly-decreasing', () => {
        // Input order is [0.9, 0.95, 0.8]. Item 1 has a higher score but comes
        // second, so it must be clamped below item 0's score to preserve order.
        const out = monotonicRankScores([0.9, 0.95, 0.8]);
        // Item 0 keeps its own score
        expect(out[0]).toBeCloseTo(0.9, 10);
        // Item 1 is clamped just below item 0
        expect(out[1]).toBeLessThan(out[0]);
        expect(out[1]).toBeCloseTo(out[0] - 1e-6, 10);
        // Item 2 stays at 0.8 (already less than item 1)
        expect(out[2]).toBeCloseTo(0.8, 10);
        // Strictly decreasing so ORDER BY combined_score DESC reproduces the order.
        expect(out[0]).toBeGreaterThan(out[1]);
        expect(out[1]).toBeGreaterThan(out[2]);
    });

    it('breaks ties so equal magnitudes still strictly decrease', () => {
        const out = monotonicRankScores([0.5, 0.5, 0.5]);
        expect(out[0]).toBeGreaterThan(out[1]);
        expect(out[1]).toBeGreaterThan(out[2]);
    });

    it('is stable in length and handles a single element', () => {
        expect(monotonicRankScores([])).toEqual([]);
        expect(monotonicRankScores([0.3])).toEqual([0.3]);
    });

    it('coerces non-finite scores to 0 and clamps subsequent items', () => {
        const out = monotonicRankScores([Number.NaN, 0.4]);
        expect(out).toHaveLength(2);
        // NaN coerces to 0
        expect(out[0]).toBe(0);
        // 0.4 is not < 0, so it gets clamped below 0
        expect(out[1]).toBeLessThan(out[0]);
        expect(out[1]).toBeCloseTo(-1e-6, 10);
    });
});

// =============================================================================
// fuseSimilarity — JS mirror of buildFusedSimilarityExpr (SQL)
// =============================================================================

describe('fuseSimilarity', () => {
    it('weight-blends when both similarities are present (normalized weights)', () => {
        // raw weights 3:1 → 0.75 / 0.25
        expect(fuseSimilarity(0.8, 0.4, 3, 1)).toBeCloseTo(0.75 * 0.8 + 0.25 * 0.4, 10);
    });

    it('returns the single present value with no penalty', () => {
        expect(fuseSimilarity(0.6, null, 1, 1)).toBe(0.6);
        expect(fuseSimilarity(null, 0.42, 1, 1)).toBe(0.42);
    });

    it('returns 0 when neither is present', () => {
        expect(fuseSimilarity(null, null, 1, 1)).toBe(0);
    });

    it('falls back to an even split on a degenerate 0/0 weight config', () => {
        expect(fuseSimilarity(0.8, 0.4, 0, 0)).toBeCloseTo(0.5 * 0.8 + 0.5 * 0.4, 10);
    });
});

// =============================================================================
// generateEnhancedRecommendationReason — honest tiers (Q13)
// =============================================================================

describe('generateEnhancedRecommendationReason', () => {
    function base(overrides: Partial<RecommendationReasonInput> = {}): RecommendationReasonInput {
        return {
            similarity: 0.6,
            qualityScore: 0,
            popularityScore: 0,
            genres: undefined,
            imdbRating: undefined,
            isAvailable: false,
            mediaType: 'movie',
            userPreferenceSource: 'watch_history',
            userHasHighRatings: false,
            seed: 1,
            ...overrides,
        };
    }

    it('fires the strong-match tier only at/above the fused-similarity threshold', () => {
        // 0.6 >= 0.55 → strong match
        expect(generateEnhancedRecommendationReason(base({ similarity: 0.6 }))).toMatch(
            /Similar to movies you've enjoyed watching/,
        );
        // 0.5 < 0.55 → must NOT claim a taste match; falls through (here: seeded fallback)
        const weak = generateEnhancedRecommendationReason(base({ similarity: 0.5 }));
        expect(weak).not.toMatch(/Matches your taste|Similar to movies/);
    });

    it('does not fire the strong tier on the old 0.15-era composite values', () => {
        // A value that USED to trip "Matches your taste in X films" must not now.
        const reason = generateEnhancedRecommendationReason(
            base({ similarity: 0.2, genres: [28] }),
        );
        expect(reason).not.toMatch(/Matches your taste/);
    });

    it('uses series wording for a series (not "films"/"film")', () => {
        const reason = generateEnhancedRecommendationReason(
            base({ similarity: 0.7, genres: [28, 878], mediaType: 'tv' }),
        );
        expect(reason).toMatch(/shows$/);
        expect(reason).not.toMatch(/films/);
    });

    it('uses film wording for a movie', () => {
        const reason = generateEnhancedRecommendationReason(
            base({ similarity: 0.7, genres: [28, 878], mediaType: 'movie' }),
        );
        expect(reason).toMatch(/films$/);
    });

    it('uses media-type-aware wording in the exceptional-IMDB tier', () => {
        const movie = generateEnhancedRecommendationReason(
            base({ similarity: 0.1, imdbRating: 8.7, mediaType: 'movie' }),
        );
        expect(movie).toMatch(/Exceptional film/);
        const series = generateEnhancedRecommendationReason(
            base({ similarity: 0.1, imdbRating: 8.7, mediaType: 'tv' }),
        );
        expect(series).toMatch(/Exceptional series/);
    });

    it('picks fallback strings deterministically from the seed (no Math.random)', () => {
        // Below all tiers → seeded fallback pick. Same seed → same string; the
        // pick must be stable across calls.
        const inputA = base({ similarity: 0.1, isAvailable: false, seed: 12345 });
        const first = generateEnhancedRecommendationReason(inputA);
        const second = generateEnhancedRecommendationReason(inputA);
        expect(first).toBe(second);

        // A different seed can select a different fallback; at least it stays
        // within the known fallback set.
        const fallbackSet = [
            'Recommended based on your viewing patterns',
            'Selected for your unique taste profile',
            'Discovered through your preference analysis',
            'Curated match for your interests',
            'AI-selected based on your taste profile',
        ];
        expect(fallbackSet).toContain(first);
    });
});

// =============================================================================
// generateStructuredReason — structured, client-localizable sibling
// =============================================================================

describe('generateStructuredReason', () => {
    it('returns rated-similar when an anchor title with a strong similarity exists', () => {
        const r = generateStructuredReason({
            anchorTitle: 'Daydream',
            anchorRating: 9,
            similarity: 0.7, // >= STRONG_SIMILARITY_THRESHOLD (0.55)
            topGenre: 'Science Fiction',
        });
        expect(r).toEqual({ kind: 'rated-similar', title: 'Daydream', rating: 9 });
    });

    it('falls back to genre-affinity without a strong anchor', () => {
        const r = generateStructuredReason({
            anchorTitle: undefined,
            anchorRating: undefined,
            similarity: 0.4,
            topGenre: 'Drama',
        });
        expect(r).toEqual({ kind: 'genre-affinity', genre: 'Drama' });
    });

    it('falls back to plain ai with no signals', () => {
        expect(generateStructuredReason({ similarity: 0.2 })).toEqual({ kind: 'ai' });
    });
});
