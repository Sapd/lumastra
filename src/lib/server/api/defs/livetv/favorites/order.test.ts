// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the favorites reorder ordering rules.
 *
 * These cover the logic the integration tests cannot reach: the comparator's
 * NULL handling and the head/tail construction. A parity test against the SQL
 * sort key lives in livetv-channels.queries.integration.test.ts — the two
 * expressions of the canonical order are otherwise unlinked.
 */

import { describe, it, expect } from 'vitest';
import { compareFavorites, computeFavoriteOrder } from './order.js';
import type { FavoriteOrderRow } from '$lib/server/database/queries/livetv-channels.queries.js';

const T0 = new Date('2026-01-01T00:00:00Z');

function row(
    channel_id: string,
    sort_order: number | null,
    created_at: Date = T0,
): FavoriteOrderRow {
    return { channel_id, sort_order, created_at };
}

describe('compareFavorites', () => {
    it('orders by sort_order ascending', () => {
        expect(compareFavorites(row('a', 0), row('b', 1))).toBeLessThan(0);
        expect(compareFavorites(row('a', 5), row('b', 2))).toBeGreaterThan(0);
    });

    it('sorts NULL ranks last, never producing NaN', () => {
        expect(compareFavorites(row('a', null), row('b', 0))).toBeGreaterThan(0);
        expect(compareFavorites(row('a', 0), row('b', null))).toBeLessThan(0);
        // Both NULL falls through to created_at/channel_id, not NaN.
        expect(Number.isNaN(compareFavorites(row('a', null), row('b', null)))).toBe(false);
    });

    it('breaks equal ranks by created_at, then channel_id', () => {
        const earlier = new Date('2026-01-01T00:00:00Z');
        const later = new Date('2026-01-02T00:00:00Z');
        expect(compareFavorites(row('z', 1, earlier), row('a', 1, later))).toBeLessThan(0);
        // Same rank AND same created_at → channel_id decides.
        expect(compareFavorites(row('b', 1, earlier), row('a', 1, earlier))).toBeGreaterThan(0);
    });

    it('is antisymmetric and reflexive-zero across mixed inputs', () => {
        const rows = [
            row('d', null),
            row('a', 1),
            row('c', null, new Date('2026-02-01T00:00:00Z')),
            row('b', 1),
            row('e', 0),
        ];
        for (const a of rows) {
            expect(compareFavorites(a, a)).toBe(0);
            for (const b of rows) {
                // Summed rather than negated: -Math.sign(0) is -0, which
                // Object.is would reject against +0.
                const forward = Math.sign(compareFavorites(a, b));
                const reverse = Math.sign(compareFavorites(b, a));
                expect(forward + reverse).toBe(0);
            }
        }
    });
});

describe('computeFavoriteOrder', () => {
    const favorites = [row('a', 0), row('b', 1), row('c', 2), row('d', 3), row('e', 4)];

    it('permutes to the requested order', () => {
        expect(computeFavoriteOrder(favorites, ['c', 'a', 'e', 'b', 'd'])).toEqual([
            'c',
            'a',
            'e',
            'b',
            'd',
        ]);
    });

    it('appends unmentioned favorites in existing order', () => {
        // Four unmentioned entries — with only two this can pass by coincidence.
        expect(computeFavoriteOrder(favorites, ['e'])).toEqual(['e', 'a', 'b', 'c', 'd']);
    });

    it('ignores ids that are not current favorites', () => {
        expect(computeFavoriteOrder(favorites, ['zz', 'c', 'yy', 'a'])).toEqual([
            'c',
            'a',
            'b',
            'd',
            'e',
        ]);
    });

    it('collapses duplicate ids to their first occurrence', () => {
        expect(computeFavoriteOrder(favorites, ['c', 'c', 'a', 'c'])).toEqual([
            'c',
            'a',
            'b',
            'd',
            'e',
        ]);
    });

    it('rewrites every rank for an empty payload without dropping anything', () => {
        expect(computeFavoriteOrder(favorites, [])).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('returns [] for a user with no favorites', () => {
        expect(computeFavoriteOrder([], ['a', 'b'])).toEqual([]);
    });

    it('is always a permutation — never inserts or deletes', () => {
        const cases: string[][] = [[], ['a'], ['zz'], ['e', 'e', 'd'], ['a', 'b', 'c', 'd', 'e']];
        for (const requested of cases) {
            const result = computeFavoriteOrder(favorites, requested);
            expect(result).toHaveLength(favorites.length);
            expect([...result].sort()).toEqual(favorites.map((r) => r.channel_id).sort());
        }
    });

    it('sorts unhealed NULL ranks to the tail before slicing', () => {
        const mixed = [row('a', 0), row('n', null), row('b', 1)];
        // 'n' is unmentioned, so it must land last — not first.
        expect(computeFavoriteOrder(mixed, ['b'])).toEqual(['b', 'a', 'n']);
    });
});
