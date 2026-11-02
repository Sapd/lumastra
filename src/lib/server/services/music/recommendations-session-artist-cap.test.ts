// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

vi.mock('$lib/server/database/queries/image-descriptor.queries.js', async () => {
    const { musicImageOwnerFixture } =
        await import('$lib/server/services/music/__tests__/image-fixtures.js');
    return {
        getImageDescriptorOwners: vi.fn(async (_sql: unknown, ids: string[]) =>
            ids.map((id) => musicImageOwnerFixture(id)),
        ),
    };
});

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Session-level artist cap (see SESSION_ARTIST_WINDOW in ./recommendations.service.ts).
 *
 * Regression cover for the failure this was built for: with only per-response
 * diversity, two nearest-neighbour artists could alternate for an entire
 * autoplay session because each hop is an independent request that counted
 * nothing across hops.
 */

import { describe, it, expect } from 'vitest';
import { overplayedSessionArtists } from './recommendations.service.js';

describe('overplayedSessionArtists', () => {
    it('returns an empty set when no artist repeats', () => {
        const keys = new Map([
            ['t1', 'sum 43'],
            ['t2', 'green harbor'],
            ['t3', 'rise anew'],
        ]);
        expect(overplayedSessionArtists(['t1', 't2', 't3'], keys).size).toBe(0);
    });

    it('does NOT cap an artist at a single repeat — two in a row stays allowed', () => {
        const keys = new Map([
            ['t1', 'sum 43'],
            ['t2', 'green harbor'],
        ]);
        // One play each: neither has spent its budget.
        expect(overplayedSessionArtists(['t1', 't2'], keys).size).toBe(0);
    });

    it('caps an artist once it reaches the window budget', () => {
        const keys = new Map([
            ['t1', 'rise anew'],
            ['t2', 'green harbor'],
            ['t3', 'rise anew'],
        ]);
        const capped = overplayedSessionArtists(['t1', 't2', 't3'], keys);
        expect(capped.has('rise anew')).toBe(true);
        expect(capped.has('green harbor')).toBe(false);
    });

    it('caps every artist that reaches the budget, not just the first', () => {
        const keys = new Map([
            ['t1', 'rise anew'],
            ['t2', 'green harbor'],
            ['t3', 'rise anew'],
            ['t4', 'green harbor'],
        ]);
        const capped = overplayedSessionArtists(['t1', 't2', 't3', 't4'], keys);
        expect([...capped].sort()).toEqual(['green harbor', 'rise anew']);
    });

    it('ignores ids with no resolved artist key rather than bucketing them together', () => {
        // Two deleted tracks must not add up to a cap on a synthetic "unknown"
        // key — that would suppress a real artist that never played.
        const keys = new Map([['t2', 'the cult']]);
        expect(overplayedSessionArtists(['t1', 't2', 't3'], keys).size).toBe(0);
    });

    it('treats each Various-Artists track as its own artist (va:<trackId> keys)', () => {
        // Compilation tracks share one synthetic artist row; effectiveArtistKey
        // gives each a unique va: key so a compilation run is not capped as if
        // it were one artist on repeat.
        const keys = new Map([
            ['t1', 'va:t1'],
            ['t2', 'va:t2'],
            ['t3', 'va:t3'],
        ]);
        expect(overplayedSessionArtists(['t1', 't2', 't3'], keys).size).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// pickAutoNextSonic — tiering happens BEFORE the top-K slice
// ---------------------------------------------------------------------------

import { pickAutoNextSonic } from './recommendations.service.js';
import { vi, afterEach } from 'vitest';

type SonicRow = Parameters<typeof pickAutoNextSonic>[0][number];

/** Minimal candidate row — only the fields the picker reads. */
function row(id: string, artist: string, score: number): SonicRow {
    return {
        id,
        similarity_score: score,
        resolved_artist: artist,
        parent_id: null,
    } as unknown as SonicRow;
}

describe('pickAutoNextSonic tiering', () => {
    afterEach(() => vi.restoreAllMocks());

    it('promotes an eligible candidate from BELOW the top-K window', () => {
        // The prod regression: top-5 are all by two capped artists, so slicing
        // first left nothing to pick and the rules were surrendered. The
        // eligible third artist sits at rank 6.
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const candidates = [
            row('e1', 'eloren', 0.95),
            row('s1', 'sora', 0.94),
            row('e2', 'eloren', 0.93),
            row('s2', 'sora', 0.92),
            row('e3', 'eloren', 0.91),
            row('m1', 'marlena', 0.5),
        ];
        const picked = pickAutoNextSonic(
            candidates,
            new Set(['eloren', 'sora']),
            5,
            undefined,
            new Set(['eloren']),
        );
        expect(picked?.id).toBe('m1');
    });

    it('keeps the hard current-artist rule when the soft cap excludes everything', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const candidates = [
            row('e1', 'eloren', 0.95),
            row('e2', 'eloren', 0.94),
            row('s1', 'sora', 0.5),
        ];
        // Both capped; 'eloren' is now playing. Must NOT return eloren.
        const picked = pickAutoNextSonic(
            candidates,
            new Set(['eloren', 'sora']),
            5,
            undefined,
            new Set(['eloren']),
        );
        expect(picked?.id).toBe('s1');
    });

    it('still returns a track when every rule excludes every candidate', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const candidates = [row('e1', 'eloren', 0.95), row('e2', 'eloren', 0.94)];
        const picked = pickAutoNextSonic(
            candidates,
            new Set(['eloren']),
            5,
            undefined,
            new Set(['eloren']),
        );
        expect(picked).not.toBeNull();
        expect(picked?.id).toBe('e1');
    });

    it('prefers the fully eligible pool over any fallback tier', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const candidates = [
            row('e1', 'eloren', 0.95),
            row('c1', 'the cult', 0.9),
            row('s1', 'sora', 0.85),
        ];
        const picked = pickAutoNextSonic(
            candidates,
            new Set(['eloren', 'sora']),
            5,
            undefined,
            new Set(['eloren']),
        );
        expect(picked?.id).toBe('c1');
    });
});
