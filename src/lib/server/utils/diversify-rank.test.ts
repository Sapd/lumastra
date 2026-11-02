// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { mulberry32, hashSeed, seededShuffle, diversifyByGenre } from './diversify-rank.js';

// ---------------------------------------------------------------------------
// mulberry32
// ---------------------------------------------------------------------------

describe('mulberry32', () => {
    it('returns values in [0, 1)', () => {
        const rng = mulberry32(42);
        for (let i = 0; i < 100; i++) {
            const v = rng();
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(1);
        }
    });

    it('same seed produces same sequence', () => {
        const a = mulberry32(12345);
        const b = mulberry32(12345);
        const seqA = Array.from({ length: 20 }, () => a());
        const seqB = Array.from({ length: 20 }, () => b());
        expect(seqA).toEqual(seqB);
    });

    it('different seeds produce different sequences', () => {
        const a = mulberry32(1);
        const b = mulberry32(2);
        const seqA = Array.from({ length: 10 }, () => a());
        const seqB = Array.from({ length: 10 }, () => b());
        expect(seqA).not.toEqual(seqB);
    });
});

// ---------------------------------------------------------------------------
// hashSeed
// ---------------------------------------------------------------------------

describe('hashSeed', () => {
    it('returns an unsigned 32-bit integer', () => {
        const h = hashSeed('hello');
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(4294967295);
        expect(Number.isInteger(h)).toBe(true);
    });

    it('is stable — same string always yields same hash', () => {
        expect(hashSeed('user-42')).toBe(hashSeed('user-42'));
        expect(hashSeed('denis')).toBe(hashSeed('denis'));
    });

    it('different strings yield different hashes (collision is astronomically unlikely)', () => {
        const strings = ['foo', 'bar', 'baz', 'qux', 'user-1', 'user-2', '2026-01-01:0'];
        const hashes = strings.map(hashSeed);
        const unique = new Set(hashes);
        expect(unique.size).toBe(strings.length);
    });

    it('handles empty string', () => {
        expect(hashSeed('')).toBeGreaterThanOrEqual(0);
    });
});

// ---------------------------------------------------------------------------
// seededShuffle
// ---------------------------------------------------------------------------

describe('seededShuffle', () => {
    it('returns a new array with the same elements', () => {
        const input = [1, 2, 3, 4, 5];
        const result = seededShuffle(input, 99);
        expect(result).not.toBe(input); // new array
        expect(result.sort()).toEqual([1, 2, 3, 4, 5]);
    });

    it('is deterministic — same seed produces same order', () => {
        const items = ['a', 'b', 'c', 'd', 'e', 'f'];
        const r1 = seededShuffle(items, 777);
        const r2 = seededShuffle(items, 777);
        expect(r1).toEqual(r2);
    });

    it('different seeds produce different orders (for pools > 1)', () => {
        const items = [1, 2, 3, 4, 5, 6, 7, 8];
        const r1 = seededShuffle(items, 1);
        const r2 = seededShuffle(items, 9999);
        expect(r1).not.toEqual(r2);
    });

    it('handles empty input', () => {
        expect(seededShuffle([], 0)).toEqual([]);
    });

    it('handles single-element input', () => {
        expect(seededShuffle(['only'], 42)).toEqual(['only']);
    });

    it('does not mutate the original array', () => {
        const original = [1, 2, 3];
        const copy = [...original];
        seededShuffle(original, 1);
        expect(original).toEqual(copy);
    });
});

// ---------------------------------------------------------------------------
// diversifyByGenre
// ---------------------------------------------------------------------------

interface TestItem {
    id: string;
    score: number;
    genres: string[];
}

function item(id: string, score: number, genres: string[]): TestItem {
    return { id, score, genres };
}

describe('diversifyByGenre', () => {
    it('returns empty array for empty input', () => {
        const result = diversifyByGenre<TestItem>([], {
            getGenres: (t) => t.genres,
            getScore: (t) => t.score,
        });
        expect(result).toEqual([]);
    });

    it('respects the limit option', () => {
        const items = [
            item('a', 0.9, ['action']),
            item('b', 0.8, ['drama']),
            item('c', 0.7, ['comedy']),
            item('d', 0.6, ['horror']),
        ];
        const result = diversifyByGenre(items, {
            limit: 2,
            getGenres: (t) => t.genres,
            getScore: (t) => t.score,
        });
        expect(result).toHaveLength(2);
    });

    it('is deterministic — same seed yields identical output', () => {
        const items = [
            item('a', 0.9, ['action', 'thriller']),
            item('b', 0.85, ['action']),
            item('c', 0.8, ['drama']),
            item('d', 0.75, ['comedy']),
            item('e', 0.7, ['action', 'drama']),
        ];
        const opts = {
            limit: 3,
            getGenres: (t: TestItem) => t.genres,
            getScore: (t: TestItem) => t.score,
            seed: 42,
        };
        const r1 = diversifyByGenre(items, opts);
        const r2 = diversifyByGenre(items, opts);
        expect(r1.map((i) => i.id)).toEqual(r2.map((i) => i.id));
    });

    it('prefers genre-diverse items over genre-cluster duplicates', () => {
        // Two action items and one drama. With genre penalty the second action item
        // should be pushed below the drama item in the final ranking.
        const items = [
            item('action1', 0.9, ['action']),
            item('action2', 0.85, ['action']), // slightly lower score, same genre
            item('drama', 0.8, ['drama']),
        ];
        const result = diversifyByGenre(items, {
            limit: 3,
            getGenres: (t) => t.genres,
            getScore: (t) => t.score,
            genrePenalty: 0.2, // strong penalty to force visible effect
        });

        // drama should appear before action2 (penalized by genre overlap)
        const dramaIdx = result.findIndex((i) => i.id === 'drama');
        const action2Idx = result.findIndex((i) => i.id === 'action2');
        expect(dramaIdx).toBeLessThan(action2Idx);
    });

    it('returns all items when limit exceeds pool size', () => {
        const items = [item('x', 1, ['sci-fi']), item('y', 0.5, ['horror'])];
        const result = diversifyByGenre(items, {
            limit: 100,
            getGenres: (t) => t.genres,
            getScore: (t) => t.score,
        });
        expect(result).toHaveLength(2);
    });

    it('top-scoring item is always first when genres are distinct', () => {
        const items = [
            item('best', 1.0, ['sci-fi']),
            item('second', 0.9, ['drama']),
            item('third', 0.8, ['action']),
        ];
        const result = diversifyByGenre(items, {
            getGenres: (t) => t.genres,
            getScore: (t) => t.score,
        });
        expect(result[0].id).toBe('best');
    });
});
