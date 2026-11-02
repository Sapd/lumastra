// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { pickAutoNext, type RankedCandidate } from './music-autoplay-pick.js';

interface Row extends RankedCandidate {
    artist: string;
}
const artistOf = (r: Row) => r.artist;

function makeRow(id: string, artist: string, score: number): Row {
    return { id, artist, similarity_score: score };
}

describe('pickAutoNext', () => {
    it('returns null on empty input', () => {
        expect(pickAutoNext<Row>([], new Set(), artistOf, 5)).toBeNull();
    });

    it('k=1 returns the first eligible candidate (legacy deterministic)', () => {
        const scored = [makeRow('a', 'X', 0.9), makeRow('b', 'Y', 0.8), makeRow('c', 'Z', 0.7)];
        const pick = pickAutoNext(scored, new Set(), artistOf, 1);
        expect(pick?.id).toBe('a');
    });

    it('skips excluded artists when finding the k pool', () => {
        const scored = [
            makeRow('a', 'Maralon', 0.95),
            makeRow('b', 'X', 0.9),
            makeRow('c', 'Y', 0.85),
            makeRow('d', 'Z', 0.8),
        ];
        // With k=1 and Maralon excluded, should pick 'b' (first eligible)
        const pick = pickAutoNext(scored, new Set(['Maralon']), artistOf, 1);
        expect(pick?.id).toBe('b');
    });

    it('falls back to excluded-artist pool when nothing else is eligible', () => {
        const scored = [makeRow('a', 'Maralon', 0.9), makeRow('b', 'Maralon', 0.8)];
        const pick = pickAutoNext(scored, new Set(['Maralon']), artistOf, 1);
        expect(pick?.id).toBe('a');
    });

    it('stays within the top-K pool with k>1', () => {
        const scored = [
            makeRow('a', 'U', 0.95),
            makeRow('b', 'V', 0.9),
            makeRow('c', 'W', 0.85),
            makeRow('d', 'X', 0.5), // outside top-3
            makeRow('e', 'Y', 0.4),
        ];
        // 100 runs with k=3 — no pick should ever fall outside [a,b,c]
        for (let i = 0; i < 100; i++) {
            const pick = pickAutoNext(scored, new Set(), artistOf, 3);
            expect(['a', 'b', 'c']).toContain(pick!.id);
        }
    });

    it('produces more than one distinct pick across many runs (non-deterministic)', () => {
        const scored = [
            makeRow('a', 'U', 0.9),
            makeRow('b', 'V', 0.85),
            makeRow('c', 'W', 0.8),
            makeRow('d', 'X', 0.75),
            makeRow('e', 'Y', 0.7),
        ];
        const ids = new Set<string>();
        for (let i = 0; i < 50; i++) {
            const pick = pickAutoNext(scored, new Set(), artistOf, 5);
            if (pick) ids.add(pick.id);
        }
        // With random sampling over 5 similarly-weighted options, 50 runs
        // should see >= 2 distinct IDs with overwhelming probability.
        expect(ids.size).toBeGreaterThan(1);
    });

    it('uses injected RNG deterministically', () => {
        const scored = [makeRow('a', 'U', 0.9), makeRow('b', 'V', 0.85), makeRow('c', 'W', 0.8)];
        // rng always returns 0 → picks the first element (pick-=weights[0] <= 0)
        const pick1 = pickAutoNext(scored, new Set(), artistOf, 3, () => 0);
        expect(pick1?.id).toBe('a');
        // rng returns 0.999 → picks the last element
        const pick2 = pickAutoNext(scored, new Set(), artistOf, 3, () => 0.999);
        expect(pick2?.id).toBe('c');
    });

    it('weights pick probability by similarity score', () => {
        // Strongly skewed: first candidate should win most of the time.
        const scored = [makeRow('a', 'U', 0.99), makeRow('b', 'V', 0.01), makeRow('c', 'W', 0.01)];
        let aCount = 0;
        const trials = 1000;
        for (let i = 0; i < trials; i++) {
            const pick = pickAutoNext(scored, new Set(), artistOf, 3);
            if (pick?.id === 'a') aCount++;
        }
        // Expected share ≈ 0.99 / 1.01 ≈ 0.98; allow wide margin for variance.
        expect(aCount / trials).toBeGreaterThan(0.9);
    });
});

// ---------------------------------------------------------------------------
// Tiered fallback (hardExcludedArtists)
// ---------------------------------------------------------------------------

describe('pickAutoNext tiered fallback', () => {
    interface Row {
        id: string;
        similarity_score: number;
        artist: string;
    }
    const artistOf = (r: Row): string => r.artist;

    /**
     * The exact prod regression this tier exists for: a two-artist
     * neighbourhood where BOTH artists are excluded (one as the now-playing
     * artist, one by the session cap). Before tiering, the fallback returned
     * the whole deferred pool including the current artist, so autoplay served
     * runs of consecutive same-artist tracks — strictly worse than the
     * A>B>A>B alternation the current-artist rule produced on its own.
     */
    it('never returns the now-playing artist when a soft-excluded alternative exists', () => {
        const scored: Row[] = [
            { id: 'a1', similarity_score: 0.9, artist: 'eloren' },
            { id: 'a2', similarity_score: 0.88, artist: 'eloren' },
            { id: 'b1', similarity_score: 0.8, artist: 'sora' },
        ];
        // 'eloren' is now playing (hard); both are over the session cap (soft).
        const picked = pickAutoNext(
            scored,
            new Set(['eloren', 'sora']),
            artistOf,
            5,
            () => 0.5,
            new Set(['eloren']),
        );
        expect(picked).not.toBeNull();
        expect(picked!.artist).toBe('sora');
    });

    it('falls all the way through when the hard rule alone still excludes everything', () => {
        const scored: Row[] = [
            { id: 'a1', similarity_score: 0.9, artist: 'eloren' },
            { id: 'a2', similarity_score: 0.8, artist: 'eloren' },
        ];
        // Nothing but the current artist exists — returning null would strand
        // autoplay, so the hard rule yields last.
        const picked = pickAutoNext(
            scored,
            new Set(['eloren']),
            artistOf,
            5,
            () => 0.5,
            new Set(['eloren']),
        );
        expect(picked).not.toBeNull();
        expect(picked!.artist).toBe('eloren');
    });

    it('defaults to all-or-nothing when no hard subset is passed', () => {
        const scored: Row[] = [{ id: 'a1', similarity_score: 0.9, artist: 'eloren' }];
        const picked = pickAutoNext(scored, new Set(['eloren']), artistOf, 5, () => 0.5);
        expect(picked?.id).toBe('a1');
    });

    it('prefers a fully eligible candidate over both deferred tiers', () => {
        const scored: Row[] = [
            { id: 'a1', similarity_score: 0.9, artist: 'eloren' },
            { id: 'b1', similarity_score: 0.85, artist: 'sora' },
            { id: 'c1', similarity_score: 0.5, artist: 'marlena' },
        ];
        const picked = pickAutoNext(
            scored,
            new Set(['eloren', 'sora']),
            artistOf,
            5,
            () => 0.5,
            new Set(['eloren']),
        );
        expect(picked!.artist).toBe('marlena');
    });
});
