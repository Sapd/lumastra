// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { matchStableClusterIds } from './audio-cluster-id-matching.js';

/** `n` tracks named `<prefix>0..<prefix>n-1`, all in `cluster`. */
function members(prefix: string, n: number, cluster: number): [string, number][] {
    return Array.from({ length: n }, (_, k) => [`${prefix}${k}`, cluster]);
}

describe('matchStableClusterIds', () => {
    it('issues 0..K-1 on a fresh install', () => {
        const fresh = new Map([...members('a', 5, 0), ...members('b', 5, 1)]);
        const r = matchStableClusterIds(new Map(), fresh, -1);
        expect([...r.idByRaw.entries()]).toEqual([
            [0, 0],
            [1, 1],
        ]);
        expect(r.issued).toEqual([0, 1]);
        expect(r.kept).toEqual([]);
        expect(r.retired).toEqual([]);
    });

    it('keeps every id when KMeans only permutes its indices', () => {
        const old = new Map([...members('a', 5, 0), ...members('b', 5, 1), ...members('c', 5, 2)]);
        // Same partition, labels rotated: a→2, b→0, c→1.
        const fresh = new Map([
            ...members('a', 5, 2),
            ...members('b', 5, 0),
            ...members('c', 5, 1),
        ]);
        const r = matchStableClusterIds(old, fresh, 2);
        expect(r.idByRaw.get(2)).toBe(0);
        expect(r.idByRaw.get(0)).toBe(1);
        expect(r.idByRaw.get(1)).toBe(2);
        expect(r.issued).toEqual([]);
        expect(r.kept.sort()).toEqual([0, 1, 2]);
    });

    it('keeps the id on the larger half of a split and issues a new one for the rest', () => {
        const old = new Map(members('a', 10, 7));
        const fresh = new Map([
            ...members('a', 10, 0).slice(0, 4),
            ...members('a', 10, 1).slice(4), // 6 of the 10 land in raw 1
        ]);
        const r = matchStableClusterIds(old, fresh, 7);
        expect(r.idByRaw.get(1)).toBe(7);
        expect(r.idByRaw.get(0)).toBe(8);
        expect(r.issued).toEqual([8]);
    });

    it('never reuses an id, even one that is no longer assigned', () => {
        // Registry already issued up to 11; id 11 retired earlier and is gone.
        const old = new Map(members('a', 5, 3));
        const fresh = new Map([...members('a', 5, 0), ...members('z', 5, 1)]);
        const r = matchStableClusterIds(old, fresh, 11);
        expect(r.idByRaw.get(0)).toBe(3);
        expect(r.idByRaw.get(1)).toBe(12);
    });

    it('does not inherit an id below the overlap threshold', () => {
        // Only 2 of old cluster 4's 10 tracks (20%) end up in raw 0.
        const old = new Map(members('a', 10, 4));
        const fresh = new Map([...members('a', 10, 0).slice(0, 2), ...members('n', 8, 0)]);
        const r = matchStableClusterIds(old, fresh, 4);
        expect(r.idByRaw.get(0)).toBe(5);
        expect(r.retired).toEqual([4]);
    });

    it('reports old ids that no raw cluster inherited as retired', () => {
        const old = new Map([...members('a', 5, 0), ...members('b', 5, 1)]);
        const fresh = new Map([...members('a', 5, 0), ...members('b', 5, 0)]);
        const r = matchStableClusterIds(old, fresh, 1);
        expect(r.idByRaw.get(0)).toBe(0);
        expect(r.retired).toEqual([1]);
    });

    it('is deterministic when two old clusters tie for one raw cluster', () => {
        const old = new Map([...members('a', 5, 0), ...members('b', 5, 1)]);
        const fresh = new Map([...members('a', 5, 0), ...members('b', 5, 0)]);
        const one = matchStableClusterIds(old, fresh, 1);
        const two = matchStableClusterIds(
            new Map([...old.entries()].reverse()),
            new Map([...fresh.entries()].reverse()),
            1,
        );
        expect([...two.idByRaw.entries()]).toEqual([...one.idByRaw.entries()]);
    });
});
