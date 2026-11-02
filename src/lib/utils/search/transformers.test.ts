// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for search result transformers
 */

import { describe, it, expect, vi } from 'vitest';
import { transformSearchItem, highlightSearchTerms, buildSubtitle } from './transformers';
import type { SearchResultItem as V1SearchResultItem } from '$lib/api/content';

// Mock paraglide messages
vi.mock('$lib/paraglide/messages', () => ({
    search_by_author: ({ author }: { author: string }) => `by ${author}`,
}));

function makeSearchItem(overrides: Partial<V1SearchResultItem> = {}): V1SearchResultItem {
    return {
        id: 'test-id',
        title: 'Test Title',
        type: 'movie',
        ids: {},
        catalogId: null,
        availability: { isAvailable: true, canRequest: false },
        images: {},
        score: 0,
        ...overrides,
    } as V1SearchResultItem;
}

describe('transformSearchItem', () => {
    it.each(['track', 'album', 'artist'] as const)(
        '%s cards keep catalog UUIDs for music actions',
        (type) => {
            const id = '10000000-0000-0000-0000-000000000001';
            const item = transformSearchItem(
                makeSearchItem({
                    id,
                    catalogId: id,
                    type,
                    artistId: 'artist-id',
                    albumId: 'album-id',
                    artists: [{ id: 'artist-id', title: 'An artist' }],
                    durationMs: 180000,
                }),
                '',
            );
            expect(item.id).toBe(id);
            expect(item.externalIds?.internal).toBe(id);
            expect(item.clickData).toMatchObject({ artistId: 'artist-id', albumId: 'album-id' });
            expect(item.artists).toEqual([{ id: 'artist-id', title: 'An artist' }]);
            expect(item.durationMs).toBe(180000);
        },
    );

    it.each(['track', 'album', 'artist'] as const)(
        '%s results preserve primary artwork hrefs without rebuilding IDs',
        (type) => {
            const href =
                '/api/media/67984085-d447-47bb-981c-4da636912ee8/images/poster?size=card&v=cover-v2';
            const thumb = href.replace('size=card', 'size=thumb');
            const primary = {
                href,
                variants: { thumb },
                revision: 'cover-v2',
                source: 'album' as const,
            };
            const input = makeSearchItem({ type, images: { primary } });
            expect(transformSearchItem(input, 'alchemy').image).toBe(thumb);
            expect(
                transformSearchItem(
                    { ...input, images: { primary: { ...primary, variants: undefined } } },
                    'alchemy',
                ).image,
            ).toBe(href);
            expect(transformSearchItem({ ...input, images: {} }, 'alchemy').image).toBe('');
        },
    );

    it.each(['movie', 'series', 'episode'] as const)(
        '%s without availability does not fabricate playback or requestability',
        (type) => {
            const item = transformSearchItem(makeSearchItem({ type, availability: undefined }), '');
            expect(item.isAvailable).toBe(false);
            expect(item.canRequest).toBe(false);
        },
    );

    it.each(['movie', 'series', 'episode'] as const)(
        '%s keeps an explicit server availability flag',
        (type) => {
            expect(
                transformSearchItem(
                    makeSearchItem({
                        type,
                        availability: { isAvailable: true, canRequest: false },
                    }),
                    '',
                ).isAvailable,
            ).toBe(true);
        },
    );

    it.each(['episode', 'artist', 'book', 'tvchannel', 'request'] as const)(
        '%s with an unavailable flag is not treated as a requestable movie',
        (type) => {
            const item = transformSearchItem(
                makeSearchItem({
                    type,
                    availability: { isAvailable: false, canRequest: true },
                }),
                '',
            );
            expect(item.isAvailable).toBe(false);
            expect(item.canRequest).toBe(false);
        },
    );

    it('preserves description matches and extracts a bounded, plain-text excerpt near the match', () => {
        const result = transformSearchItem(
            makeSearchItem({
                reason: { kind: 'overview' },
                overview: `${'A long introduction. '.repeat(20)}A spaceship <script> arrives. ${'More story. '.repeat(20)}`,
            }),
            'spaceship',
        );
        expect(result.matchSource).toBe('overview');
        expect(result.matchSnippet).toContain('spaceship <script>');
        expect(result.matchSnippet?.length).toBeLessThanOrEqual(162);
        expect(result.matchSnippet).toMatch(/^…/);
        expect(result.highlightedMatchSnippet).toBeUndefined();
    });

    it('does not label title matches as description matches', () => {
        expect(
            transformSearchItem(
                makeSearchItem({ reason: { kind: 'title' }, overview: 'story' }),
                'story',
            ).matchSnippet,
        ).toBeUndefined();
    });
    describe('mediaType normalization', () => {
        it('should normalize series to tv', () => {
            const item = makeSearchItem({
                type: 'series',
            });
            const result = transformSearchItem(item, 'test');
            expect(result.mediaType).toBe('tv');
        });

        it('should preserve episode type', () => {
            const item = makeSearchItem({ type: 'episode' });
            const result = transformSearchItem(item, 'test');
            expect(result.mediaType).toBe('episode');
        });

        it('should preserve movie type', () => {
            const item = makeSearchItem({ type: 'movie' });
            const result = transformSearchItem(item, 'test');
            expect(result.mediaType).toBe('movie');
        });

        it('should map request to anfragen', () => {
            const item = makeSearchItem({ type: 'request' });
            const result = transformSearchItem(item, 'test');
            expect(result.mediaType).toBe('anfragen');
        });

        // Non-standard types that pass through as-is
        const nonStandardTypes = [
            'tvchannel',
            'audiobook',
            'book',
            'manga',
            'comic',
            'home_video',
            'training',
            'educational',
            'personal',
            'track',
            'album',
            'artist',
        ] as const;

        for (const mediaType of nonStandardTypes) {
            it(`should preserve ${mediaType} type`, () => {
                const item = makeSearchItem({
                    type: mediaType,
                });
                const result = transformSearchItem(item, 'test');
                expect(result.mediaType).toBe(mediaType);
            });
        }
    });
});

describe('highlightSearchTerms', () => {
    it('should highlight matching terms', () => {
        const result = highlightSearchTerms('The Silent Beacon', 'silent');
        expect(result).toContain('<mark');
        expect(result).toContain('Silent');
    });

    it('should return text unchanged for empty query', () => {
        expect(highlightSearchTerms('Hello', '')).toBe('Hello');
    });

    it('should return text unchanged for empty text', () => {
        expect(highlightSearchTerms('', 'test')).toBe('');
    });

    it('should escape HTML entities', () => {
        const result = highlightSearchTerms('<script>alert("xss")</script>', 'script');
        expect(result).not.toContain('<script>');
        expect(result).toContain('&lt;');
    });
});

describe('buildSubtitle', () => {
    it('should not repeat the year for movies (card metadata row renders it)', () => {
        const item = makeSearchItem({
            type: 'movie',
            year: 2020,
        });
        const result = buildSubtitle(item);
        expect(result).toBe('');
    });

    it('should show series name for episodes', () => {
        const item = makeSearchItem({
            type: 'episode',
            context: {
                series: { id: 'show', catalogId: null, title: 'Drifting Clouds' },
                seasonNumber: 1,
                episodeNumber: 1,
            },
        });
        const result = buildSubtitle(item);
        expect(result).toContain('Drifting Clouds');
        expect(result).toContain('S1 E1');
    });

    it('should show the author for a book row with an author', () => {
        const item = makeSearchItem({
            type: 'book',
            author: 'M. K. Fenwick',
        });
        const result = buildSubtitle(item);
        expect(result).toBe('by M. K. Fenwick');
    });

    it('should return empty string for a book row without an author', () => {
        const item = makeSearchItem({ type: 'book' });
        const result = buildSubtitle(item);
        expect(result).toBe('');
    });
});

describe('matched-title search context', () => {
    it('uses secondary text while retaining primary title and navigation source data', () => {
        const source = makeSearchItem({
            title: 'The Worst Witch',
            matchedTitle: 'Eine lausige Hexe',
            type: 'series',
        });
        const item = transformSearchItem(source, 'Eine lausige Hexe');
        expect(item.title).toBe('The Worst Witch');
        expect(item.subtitle).toBe('Eine lausige Hexe');
        expect(item.clickData?.originalItem).toBe(source);
    });
    it('omits duplicates and preserves existing episode context', () => {
        expect(
            buildSubtitle(
                makeSearchItem({ title: 'The Worst Witch', matchedTitle: 'THE WÓRST—WITCH!' }),
            ),
        ).toBe('');
        expect(
            buildSubtitle(
                makeSearchItem({
                    type: 'episode',
                    context: {
                        series: { id: 'show', catalogId: null, title: 'The Worst Witch' },
                        seasonNumber: 1,
                        episodeNumber: 2,
                    },
                }),
            ),
        ).toBe('The Worst Witch • S1 E2');
    });
});

describe('audiobook progress projection', () => {
    it('renders the shared block as card progress and finished state', () => {
        const item = transformSearchItem(
            {
                id: 'book-1',
                catalogId: null,
                type: 'audiobook',
                ids: { internal: 'book-1' },
                title: 'Book',
                images: {},
                score: 1,
                progress: {
                    positionMs: 250,
                    durationMs: 1000,
                    fraction: 0.25,
                    finished: false,
                    updatedAt: null,
                },
            },
            '',
        );
        expect(item.progress).toBe(25);
        expect(item.isPlayed).toBe(false);
    });
});
