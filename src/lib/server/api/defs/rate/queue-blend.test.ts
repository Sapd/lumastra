// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { shareForBacklog, evenSpreadInterleave } from './queue-blend.js';

describe('shareForBacklog', () => {
    it('returns full explore when the backlog is empty', () => {
        expect(shareForBacklog(0)).toBe(1);
        expect(shareForBacklog(-3)).toBe(1); // defensive: never negative in practice
    });

    it('leans explore for a shallow backlog (1-4)', () => {
        expect(shareForBacklog(1)).toBe(0.65);
        expect(shareForBacklog(4)).toBe(0.65);
    });

    it('is balanced for a mid backlog (5-9)', () => {
        expect(shareForBacklog(5)).toBe(0.5);
        expect(shareForBacklog(9)).toBe(0.5);
    });

    it('leans seen for a deeper backlog (10-19)', () => {
        expect(shareForBacklog(10)).toBe(0.4);
        expect(shareForBacklog(19)).toBe(0.4);
    });

    it('floors explore at 0.30 for a deep backlog (>=20)', () => {
        expect(shareForBacklog(20)).toBe(0.3);
        expect(shareForBacklog(500)).toBe(0.3);
    });
});

describe('evenSpreadInterleave', () => {
    it('returns the non-empty list unchanged when the other is empty', () => {
        expect(evenSpreadInterleave([1, 2, 3], [])).toEqual([1, 2, 3]);
        expect(evenSpreadInterleave([], [1, 2, 3])).toEqual([1, 2, 3]);
    });

    it('opens on the first list (ties favor seen)', () => {
        expect(evenSpreadInterleave(['s'], ['e'])).toEqual(['s', 'e']);
    });

    it('alternates evenly for equal-length lists', () => {
        expect(evenSpreadInterleave(['s1', 's2', 's3'], ['e1', 'e2', 'e3'])).toEqual([
            's1',
            'e1',
            's2',
            'e2',
            's3',
            'e3',
        ]);
    });

    it('spreads the minority list without clustering it at the tail', () => {
        const a = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'];
        const b = ['e1', 'e2', 'e3'];
        const out = evenSpreadInterleave(a, b);
        expect(out).toEqual(['s1', 'e1', 's2', 's3', 'e2', 's4', 's5', 'e3', 's6', 's7']);
        // explicit anti-clustering: no two explore items are adjacent
        const bPositions = out.map((x, i) => (x.startsWith('e') ? i : -1)).filter((i) => i >= 0);
        for (let k = 1; k < bPositions.length; k++) {
            expect(bPositions[k] - bPositions[k - 1]).toBeGreaterThan(1);
        }
    });

    it('preserves the total item count and each list order', () => {
        const out = evenSpreadInterleave(['s1', 's2'], ['e1', 'e2', 'e3', 'e4']);
        expect(out).toHaveLength(6);
        expect(out.filter((x) => x.startsWith('s'))).toEqual(['s1', 's2']);
        expect(out.filter((x) => x.startsWith('e'))).toEqual(['e1', 'e2', 'e3', 'e4']);
    });
});
