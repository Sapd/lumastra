// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { heroRotationSeed, rotateHeroPool } from './hero-rotation.js';

// ---------------------------------------------------------------------------
// heroRotationSeed
// ---------------------------------------------------------------------------

describe('heroRotationSeed', () => {
    it('is stable — same parts yield same seed', () => {
        const parts = { dateBucket: 19900, daypart: 2, userKey: 'testuser' };
        expect(heroRotationSeed(parts)).toBe(heroRotationSeed(parts));
    });

    it('different daypart → different seed', () => {
        const base = { dateBucket: 19900, userKey: 'alice' };
        const s0 = heroRotationSeed({ ...base, daypart: 0 });
        const s1 = heroRotationSeed({ ...base, daypart: 1 });
        const s2 = heroRotationSeed({ ...base, daypart: 2 });
        const s3 = heroRotationSeed({ ...base, daypart: 3 });
        expect(new Set([s0, s1, s2, s3]).size).toBe(4);
    });

    it('different dateBucket → different seed', () => {
        const s1 = heroRotationSeed({ dateBucket: 1, daypart: 0 });
        const s2 = heroRotationSeed({ dateBucket: 2, daypart: 0 });
        expect(s1).not.toBe(s2);
    });

    it('returns an unsigned 32-bit integer', () => {
        const s = heroRotationSeed({ dateBucket: 10, daypart: 1 });
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(4294967295);
        expect(Number.isInteger(s)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// rotateHeroPool
// ---------------------------------------------------------------------------

describe('rotateHeroPool', () => {
    it('is deterministic — same seed yields same order', () => {
        const pool = ['A', 'B', 'C', 'D', 'E'];
        const r1 = rotateHeroPool(pool, 42);
        const r2 = rotateHeroPool(pool, 42);
        expect(r1).toEqual(r2);
    });

    it('different seeds yield different orders for pool > 1', () => {
        const pool = ['A', 'B', 'C', 'D', 'E', 'F'];
        const r1 = rotateHeroPool(pool, 0);
        const r2 = rotateHeroPool(pool, 1);
        const r3 = rotateHeroPool(pool, 2);
        // At least two of the three should differ
        const allSame = r1.join('') === r2.join('') && r2.join('') === r3.join('');
        expect(allSame).toBe(false);
    });

    it('returns all elements (just reordered)', () => {
        const pool = [1, 2, 3, 4, 5];
        const result = rotateHeroPool(pool, 99);
        expect(result.sort()).toEqual([1, 2, 3, 4, 5]);
    });

    it('handles single-element pool safely', () => {
        expect(rotateHeroPool(['only'], 7)).toEqual(['only']);
    });

    it('handles empty pool', () => {
        expect(rotateHeroPool([], 42)).toEqual([]);
    });

    it('pinFirst keeps pool[0] at index 0', () => {
        const pool = ['BEST', 'B', 'C', 'D', 'E'];
        const result = rotateHeroPool(pool, 99, { pinFirst: true });
        expect(result[0]).toBe('BEST');
        // All other elements are still present
        expect(result.sort()).toEqual(['B', 'BEST', 'C', 'D', 'E'].sort());
    });

    it('pinFirst with windowSize returns correct count', () => {
        const pool = ['X', 'A', 'B', 'C', 'D'];
        const result = rotateHeroPool(pool, 5, { pinFirst: true, windowSize: 3 });
        expect(result).toHaveLength(3);
        expect(result[0]).toBe('X');
    });

    it('windowSize truncates result', () => {
        const pool = ['a', 'b', 'c', 'd', 'e'];
        const result = rotateHeroPool(pool, 3, { windowSize: 2 });
        expect(result).toHaveLength(2);
    });

    it('does not mutate the original pool', () => {
        const pool = [1, 2, 3, 4];
        const copy = [...pool];
        rotateHeroPool(pool, 1234);
        expect(pool).toEqual(copy);
    });

    it('different daypart seeds from heroRotationSeed produce different orders (pool > 1)', () => {
        const pool = ['A', 'B', 'C', 'D'];
        const seed0 = heroRotationSeed({ dateBucket: 19900, daypart: 0 });
        const seed2 = heroRotationSeed({ dateBucket: 19900, daypart: 2 });
        const r0 = rotateHeroPool(pool, seed0);
        const r2 = rotateHeroPool(pool, seed2);
        // They should differ (seeds are different, and pool size > 1 means not all seeds give offset=0)
        // Can't guarantee 100% but different seeds very likely give different offsets
        // The test passes as long as at least one pair differs across 4 dayparts
        const s1 = heroRotationSeed({ dateBucket: 19900, daypart: 1 });
        const s3 = heroRotationSeed({ dateBucket: 19900, daypart: 3 });
        const r1 = rotateHeroPool(pool, s1);
        const r3 = rotateHeroPool(pool, s3);
        const results = [r0, r1, r2, r3].map((r) => r.join(''));
        const unique = new Set(results);
        expect(unique.size).toBeGreaterThan(1);
    });
});
