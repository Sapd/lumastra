// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import type { ProviderTopTrack } from './types.js';
import type { LibraryTrack } from './matcher.js';
import { matchTracks, simpleTrigramSim } from './matcher.js';

function makeProvider(
    overrides: Partial<ProviderTopTrack> & {
        providerTitle: string;
        rank: number;
    },
): ProviderTopTrack {
    return {
        providerUrl: 'https://example.com',
        ...overrides,
    };
}

function makeLibrary(
    overrides: Partial<LibraryTrack> & { id: string; title: string },
): LibraryTrack {
    return {
        normalizedTitle: overrides.title.toLowerCase(),
        mbid: null,
        ...overrides,
    };
}

describe('simpleTrigramSim', () => {
    it('identical strings return 1.0', () => {
        expect(simpleTrigramSim('hello', 'hello')).toBe(1.0);
    });

    it('completely different strings return low similarity', () => {
        const sim = simpleTrigramSim('abc', 'xyz');
        expect(sim).toBeLessThan(0.1);
    });

    it('empty first string returns 0', () => {
        expect(simpleTrigramSim('', 'hello')).toBe(0);
    });

    it('empty second string returns 0', () => {
        expect(simpleTrigramSim('hello', '')).toBe(0);
    });

    it('both empty returns 0', () => {
        expect(simpleTrigramSim('', '')).toBe(0);
    });

    it('similar strings return non-zero similarity', () => {
        const sim = simpleTrigramSim('poison', 'poisen');
        expect(sim).toBeGreaterThan(0.3);
    });

    it('is symmetric', () => {
        const a = simpleTrigramSim('hello world', 'world hello');
        const b = simpleTrigramSim('world hello', 'hello world');
        expect(a).toBeCloseTo(b);
    });
});

describe('matchTracks', () => {
    describe('empty inputs', () => {
        it('empty library and provider tracks returns empty result', () => {
            const result = matchTracks([], []);
            expect(result.matched.size).toBe(0);
            expect(result.unmatchedProviderTracks).toEqual([]);
        });

        it('empty library with provider tracks marks all unmatched', () => {
            const providerTracks = [makeProvider({ providerTitle: 'Song A', rank: 1 })];
            const result = matchTracks([], providerTracks);
            expect(result.matched.size).toBe(0);
            expect(result.unmatchedProviderTracks).toEqual(['Song A']);
        });

        it('library tracks with no provider tracks returns empty match', () => {
            const library = [makeLibrary({ id: 'uuid-1', title: 'song a' })];
            const result = matchTracks(library, []);
            expect(result.matched.size).toBe(0);
            expect(result.unmatchedProviderTracks).toEqual([]);
        });
    });

    describe('MBID matching', () => {
        it('MBID match beats title match even with different titles', () => {
            const library: LibraryTrack[] = [
                {
                    id: 'uuid-1',
                    title: 'Completely Different Title',
                    normalizedTitle: 'completely different title',
                    mbid: 'mbid-abc-123',
                },
            ];
            const providerTracks = [
                makeProvider({
                    providerTitle: 'Song With Same MBID',
                    rank: 1,
                    providerMbid: 'mbid-abc-123',
                }),
            ];

            const result = matchTracks(library, providerTracks);
            expect(result.matched.has('uuid-1')).toBe(true);
            expect(result.matched.get('uuid-1')?.providerTitle).toBe('Song With Same MBID');
            expect(result.unmatchedProviderTracks).toEqual([]);
        });

        it('does not MBID-match when provider has no MBID', () => {
            const library: LibraryTrack[] = [
                {
                    id: 'uuid-1',
                    title: 'Song',
                    normalizedTitle: 'song',
                    mbid: 'mbid-abc-123',
                },
            ];
            const providerTracks = [makeProvider({ providerTitle: 'Other Song', rank: 1 })];

            const result = matchTracks(library, providerTracks);
            // no title match either — should be unmatched
            expect(result.unmatchedProviderTracks).toEqual(['Other Song']);
        });
    });

    describe('exact normalized title matching', () => {
        it('matches when titles normalize to the same value', () => {
            const library: LibraryTrack[] = [
                {
                    id: 'uuid-1',
                    title: 'All The Things She Said (Nightcore Edit)',
                    normalizedTitle: 'all the things she said',
                    mbid: null,
                },
            ];
            const providerTracks = [
                makeProvider({
                    providerTitle: 'All the Things She Said - Nightcore Edit',
                    rank: 1,
                }),
            ];

            const result = matchTracks(library, providerTracks);
            expect(result.matched.has('uuid-1')).toBe(true);
            expect(result.unmatchedProviderTracks).toEqual([]);
        });

        it('matches case-insensitively via normalization', () => {
            const library: LibraryTrack[] = [
                {
                    id: 'uuid-1',
                    title: 'Hello World',
                    normalizedTitle: 'hello world',
                    mbid: null,
                },
            ];
            const providerTracks = [makeProvider({ providerTitle: 'HELLO WORLD', rank: 1 })];

            const result = matchTracks(library, providerTracks);
            expect(result.matched.has('uuid-1')).toBe(true);
        });
    });

    describe('trigram matching', () => {
        it('matches tracks above 0.75 threshold', () => {
            // 'all the things she said' vs 'all the things she sayd' — very similar
            const library: LibraryTrack[] = [
                {
                    id: 'uuid-1',
                    title: 'All the Things She Said',
                    normalizedTitle: 'all the things she said',
                    mbid: null,
                },
            ];
            const providerTracks = [
                // normalized: 'all the things she sayd' — typo variant
                makeProvider({
                    providerTitle: 'All the Things She Sayd',
                    rank: 1,
                }),
            ];

            const sim = simpleTrigramSim('all the things she said', 'all the things she sayd');
            // Confirm similarity is high enough to qualify this as a trigram test
            expect(sim).toBeGreaterThan(0.75);

            const result = matchTracks(library, providerTracks);
            expect(result.matched.has('uuid-1')).toBe(true);
        });

        it('does not match below 0.75 threshold', () => {
            const library: LibraryTrack[] = [
                {
                    id: 'uuid-1',
                    title: 'Hello World',
                    normalizedTitle: 'hello world',
                    mbid: null,
                },
            ];
            const providerTracks = [
                makeProvider({
                    providerTitle: 'Completely Different Track Name',
                    rank: 1,
                }),
            ];

            const result = matchTracks(library, providerTracks);
            expect(result.matched.has('uuid-1')).toBe(false);
            expect(result.unmatchedProviderTracks).toContain('Completely Different Track Name');
        });
    });

    describe('one-to-one matching constraint', () => {
        it('one library track can only match one provider track', () => {
            const library: LibraryTrack[] = [
                {
                    id: 'uuid-1',
                    title: 'Hello World',
                    normalizedTitle: 'hello world',
                    mbid: null,
                },
            ];
            // Two provider tracks with the same normalized title
            const providerTracks = [
                makeProvider({ providerTitle: 'Hello World', rank: 1 }),
                makeProvider({ providerTitle: 'Hello World', rank: 2 }),
            ];

            const result = matchTracks(library, providerTracks);
            // uuid-1 claimed by rank-1 track
            expect(result.matched.has('uuid-1')).toBe(true);
            expect(result.matched.get('uuid-1')?.rank).toBe(1);
            // The rank-2 track has no library track left to claim
            expect(result.unmatchedProviderTracks).toEqual(['Hello World']);
        });

        it('higher-ranked provider track claims library track first', () => {
            const library: LibraryTrack[] = [
                {
                    id: 'uuid-1',
                    title: 'Poison',
                    normalizedTitle: 'poison',
                    mbid: null,
                },
            ];
            const providerTracks = [
                makeProvider({ providerTitle: 'Poison (Radio Edit)', rank: 2 }),
                makeProvider({ providerTitle: 'Poison', rank: 1 }),
            ];

            const result = matchTracks(library, providerTracks);
            expect(result.matched.get('uuid-1')?.rank).toBe(1);
        });
    });

    describe('unmatched provider tracks', () => {
        it('tracks with no library match land in unmatchedProviderTracks', () => {
            const library: LibraryTrack[] = [
                {
                    id: 'uuid-1',
                    title: 'Known Track',
                    normalizedTitle: 'known track',
                    mbid: null,
                },
            ];
            const providerTracks = [
                makeProvider({ providerTitle: 'Known Track', rank: 1 }),
                makeProvider({ providerTitle: 'Unknown Obscure Song', rank: 2 }),
            ];

            const result = matchTracks(library, providerTracks);
            expect(result.matched.size).toBe(1);
            expect(result.unmatchedProviderTracks).toEqual(['Unknown Obscure Song']);
        });
    });
});
