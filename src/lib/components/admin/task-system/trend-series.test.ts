// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { deltaSeries } from './trend-series.js';

const pt = (instanceId: string, n: number) => ({ instanceId, n });

describe('deltaSeries', () => {
    it('diffs adjacent snapshots of one process', () => {
        expect(deltaSeries([pt('a', 10), pt('a', 15), pt('a', 22)], (p) => p.n)).toEqual([0, 5, 7]);
    });

    it('a restart (counter went down) is 0, not a negative spike', () => {
        expect(deltaSeries([pt('a', 100), pt('a', 3)], (p) => p.n)).toEqual([0, 0]);
    });

    it('rows from different replicas are never diffed against each other', () => {
        // Leadership moved a → b → a: b's counter is unrelated to a's.
        const points = [pt('a', 1000), pt('b', 20), pt('b', 25), pt('a', 1010)];
        expect(deltaSeries(points, (p) => p.n)).toEqual([0, 0, 5, 0]);
    });

    it('empty in, empty out', () => {
        expect(deltaSeries([], () => 0)).toEqual([]);
    });
});
