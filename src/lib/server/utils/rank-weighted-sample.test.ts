// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { rankWeightedSample, recencyFactor, type RankedItem } from './rank-weighted-sample.js';

interface Row extends RankedItem {
    id: string;
}
const make = (id: string, hours_since_played: number | null = null): Row => ({
    id,
    hours_since_played,
});

describe('recencyFactor', () => {
    it('returns 1.0 for never-played (null)', () => {
        expect(recencyFactor(null)).toBe(1.0);
    });
    it('returns 1.0 for never-played (undefined)', () => {
        expect(recencyFactor(undefined)).toBe(1.0);
    });
    it('returns 0.2 within 1h', () => {
        expect(recencyFactor(0)).toBe(0.2);
        expect(recencyFactor(0.99)).toBe(0.2);
    });
    it('returns 0.5 within 6h', () => {
        expect(recencyFactor(1)).toBe(0.5);
        expect(recencyFactor(5.9)).toBe(0.5);
    });
    it('returns 0.8 within 24h', () => {
        expect(recencyFactor(6)).toBe(0.8);
        expect(recencyFactor(23.9)).toBe(0.8);
    });
    it('returns 1.0 beyond 24h', () => {
        expect(recencyFactor(24)).toBe(1.0);
        expect(recencyFactor(1000)).toBe(1.0);
    });
});

describe('rankWeightedSample', () => {
    it('returns [] for empty input', () => {
        expect(rankWeightedSample<Row>([], { decay: 1, count: 5 })).toEqual([]);
    });

    it('returns all items when count >= pool size', () => {
        const items = [make('a'), make('b'), make('c')];
        const result = rankWeightedSample(items, { decay: 1, count: 10 });
        expect(result).toHaveLength(3);
        expect(result.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
    });

    it('never returns duplicates (sampling without replacement)', () => {
        const items = Array.from({ length: 20 }, (_, i) => make(`t${i}`));
        for (let trial = 0; trial < 50; trial++) {
            const picks = rankWeightedSample(items, { decay: 1, count: 10 });
            expect(picks).toHaveLength(10);
            expect(new Set(picks.map((p) => p.id)).size).toBe(10);
        }
    });

    it('sharp decay (2) picks rank-0 most often', () => {
        const items = Array.from({ length: 10 }, (_, i) => make(`r${i}`));
        let first = 0;
        const trials = 1000;
        for (let i = 0; i < trials; i++) {
            const picks = rankWeightedSample(items, { decay: 2, count: 1 });
            if (picks[0].id === 'r0') first++;
        }
        expect(first / trials).toBeGreaterThan(0.5);
    });

    it('flat decay (0.5) spreads picks widely', () => {
        const items = Array.from({ length: 10 }, (_, i) => make(`r${i}`));
        let first = 0;
        const trials = 1000;
        for (let i = 0; i < trials; i++) {
            const picks = rankWeightedSample(items, { decay: 0.5, count: 1 });
            if (picks[0].id === 'r0') first++;
        }
        expect(first / trials).toBeLessThan(0.35);
    });

    it('recency penalty reduces pick probability', () => {
        const items = [make('fresh'), make('recent', 0.5)];
        let fresh = 0;
        const trials = 1000;
        for (let i = 0; i < trials; i++) {
            const picks = rankWeightedSample(items, { decay: 1, count: 1 });
            if (picks[0].id === 'fresh') fresh++;
        }
        expect(fresh / trials).toBeGreaterThan(0.7);
    });

    it('treats null hours_since_played as never-played (factor 1.0)', () => {
        const nullRow: Row = { id: 'n', hours_since_played: null };
        const undefRow: Row = { id: 'u' };
        const recentRow = make('r', 0.5);
        let nullWins = 0;
        let undefWins = 0;
        const trials = 1000;
        for (let i = 0; i < trials; i++) {
            const picks1 = rankWeightedSample([nullRow, recentRow], {
                decay: 1,
                count: 1,
            });
            if (picks1[0].id === 'n') nullWins++;
            const picks2 = rankWeightedSample([undefRow, recentRow], {
                decay: 1,
                count: 1,
            });
            if (picks2[0].id === 'u') undefWins++;
        }
        expect(nullWins / trials).toBeGreaterThan(0.7);
        expect(undefWins / trials).toBeGreaterThan(0.7);
    });

    it('uses injected RNG deterministically', () => {
        const items = [make('a'), make('b'), make('c')];
        const pick1 = rankWeightedSample(items, {
            decay: 1,
            count: 1,
            rng: () => 0,
        });
        expect(pick1[0].id).toBe('a');
        const pick2 = rankWeightedSample(items, {
            decay: 1,
            count: 1,
            rng: () => 0.999,
        });
        expect(pick2[0].id).toBe('c');
    });
});
