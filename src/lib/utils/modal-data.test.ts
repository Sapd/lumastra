// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The `?include=details` response is a MediaNode whose rich fields (cast,
// runtime, rating, genres, directors) live NESTED under `.details`
// (MediaNodeDetails), NOT at the node top level. This test locks in that the
// enrichment reads them from the nested block — the regression that made the
// modal never self-heal cast/runtime.
vi.mock('$lib/api/content', () => ({
    getMediaDetails: vi.fn(),
    getMediaDetailsByQuery: vi.fn(),
}));

import * as contentApi from '$lib/api/content';
import { canPlayDirectly, enrichMediaData, extractAudiobookFields } from '$lib/utils/modal-data';

describe('canPlayDirectly availability precedence', () => {
    it('does not infer unknown availability from a Sonarr file hint', () => {
        expect(canPlayDirectly({ mediaType: 'episode', sonarrHasFile: true })).toBe(false);
    });
    it('does not let a Sonarr file hint override explicit unavailable state', () => {
        expect(
            canPlayDirectly({ mediaType: 'episode', isAvailable: false, sonarrHasFile: true }),
        ).toBe(false);
        expect(
            canPlayDirectly({ mediaType: 'episode', isAvailable: true, sonarrHasFile: true }),
        ).toBe(true);
    });
});

describe('enrichMediaData — full overview replaces the card preview', () => {
    beforeEach(() => vi.resetAllMocks());

    const fullOverview = 'The full localized story continues beyond the card preview. '.repeat(12);
    const preview = `${fullOverview.slice(0, 147)}...`;

    it.each(['movie', 'series', 'episode'] as const)(
        'keeps the complete fetched %s overview instead of the opening-card preview',
        async (type) => {
            vi.mocked(contentApi.getMediaDetails).mockResolvedValue({
                data: {
                    id: 'overview-item',
                    type,
                    title: 'A complete story',
                    ids: { internal: 'overview-item' },
                    images: {},
                    isAvailable: true,
                    canRequest: false,
                    overview: fullOverview,
                },
                error: null,
                status: 200,
            });
            const enriched = await enrichMediaData({
                mediaType: type,
                externalIds: { internal: 'overview-item' },
                overview: preview,
            });
            expect(enriched.overview).toBe(fullOverview);
        },
    );

    it.each(['', undefined])(
        'preserves the supplied overview when fetched text is %s',
        async (overview) => {
            vi.mocked(contentApi.getMediaDetails).mockResolvedValue({
                data: {
                    id: 'overview-item',
                    type: 'movie',
                    title: 'A complete story',
                    ids: { internal: 'overview-item' },
                    images: {},
                    isAvailable: true,
                    canRequest: false,
                    overview,
                },
                error: null,
                status: 200,
            });
            const enriched = await enrichMediaData({
                mediaType: 'movie',
                externalIds: { internal: 'overview-item' },
                overview: preview,
            });
            expect(enriched.overview).toBe(preview);
        },
    );

    it('also replaces the preview when the fallback detail request succeeds', async () => {
        vi.mocked(contentApi.getMediaDetails)
            .mockResolvedValueOnce({ data: null, error: null, status: 503 })
            .mockResolvedValueOnce({
                data: {
                    id: 'overview-item',
                    type: 'movie',
                    title: 'A complete story',
                    ids: { internal: 'overview-item' },
                    images: {},
                    isAvailable: true,
                    canRequest: false,
                    overview: fullOverview,
                },
                error: null,
                status: 200,
            });
        const enriched = await enrichMediaData({
            mediaType: 'movie',
            externalIds: { internal: 'overview-item' },
            overview: preview,
        });
        expect(enriched.overview).toBe(fullOverview);
        expect(contentApi.getMediaDetails).toHaveBeenCalledTimes(2);
    });
});

describe('enrichMediaData — rich fields nested under node.details', () => {
    beforeEach(() => vi.clearAllMocks());

    it('reads actors/rating/genres/directors from the nested details block and runtime from durationMs', async () => {
        const node = {
            id: 'uuid-1',
            type: 'movie',
            title: 'Fresh Movie',
            overview: 'An overview',
            ids: { internal: 'uuid-1', tmdb: '123' },
            isAvailable: true,
            canRequest: false,
            // Rich augmentation is NESTED here (MediaNodeDetails), never top level.
            credits: {
                cast: [{ person: { id: null, name: 'Jane Doe' }, character: 'Hero', order: 0 }],
                crew: [{ person: { id: null, name: 'John Smith' }, job: 'Director' }],
            },
            // The one duration is the node's durationMs (ms), not details.runtime.
            durationMs: 120 * 60_000,
            details: {
                rating: 8.2,
                ratings: { rtCritic: 91, rtAudience: 88 },
                genres: ['Action', 'Sci-Fi'],
            },
        };
        vi.mocked(contentApi.getMediaDetails).mockResolvedValue({
            data: node,
            error: null,
        } as never);

        const enriched = await enrichMediaData({
            mediaType: 'movie',
            externalIds: { internal: 'uuid-1', tmdb: '123' },
        });

        expect(enriched._enriched).toBe(true);
        expect(enriched.actors).toEqual([
            expect.objectContaining({ name: 'Jane Doe', character: 'Hero', personId: null }),
        ]);
        expect(enriched.duration).toBe(120 * 60);
        expect(enriched.rating).toBe(8.2);
        expect(enriched.genres).toEqual(['Action', 'Sci-Fi']);
        expect(enriched.directors).toEqual(['John Smith']);
        expect(enriched.rtCritic).toBe(91);
        expect(enriched.rtAudience).toBe(88);
    });

    it('self-heals cast/directors even when initialData supplied EMPTY arrays', async () => {
        // A caller-supplied `[]` is truthy — the enrichment must still fill from
        // the fetched nested block rather than keep the empty array.
        const node = {
            id: 'uuid-2',
            type: 'movie',
            title: 'Empty-Cast Card',
            ids: { internal: 'uuid-2' },
            credits: {
                cast: [{ person: { id: null, name: 'Real Actor' }, character: 'Lead', order: 0 }],
                crew: [{ person: { id: null, name: 'Real Director' }, job: 'Director' }],
            },
            details: {},
        };
        vi.mocked(contentApi.getMediaDetails).mockResolvedValue({
            data: node,
            error: null,
        } as never);

        const enriched = await enrichMediaData({
            mediaType: 'movie',
            externalIds: { internal: 'uuid-2' },
            actors: [],
            directors: [],
        });

        expect(enriched.actors).toEqual([
            expect.objectContaining({ name: 'Real Actor', character: 'Lead', personId: null }),
        ]);
        expect(enriched.directors).toEqual(['Real Director']);
    });
});

// ── Audiobook block extraction ─────────────────────────────────────────────
//
// The author/narrator/chapter data rides the node's TOP level, not `.details`
// (MediaNodeAudiobookSchema): the composite `media/{id}/context` endpoint the
// modal actually uses calls buildMediaDetail() with an EMPTY `include`, so
// anything nested under `details` never reaches it.

describe('extractAudiobookFields', () => {
    const node = {
        id: 'book-uuid',
        // UPPER-CASE on purpose: `openMediaModal` upper-cases mediaType, so any
        // literal `=== 'audiobook'` comparison in this area is dead code. The
        // extractor must go through the isAudiobook() comparator.
        type: 'audiobook',
        title: 'Milo Farrow und der Stein der Weisen - Gesprochen von Felix Vale',
        ids: { isbn: '9780000000001' },
        year: 2016,
        overview: 'Felix Vale liest Band 1 von Milo Farrow.',
        isAvailable: true,
        canRequest: false,
        authors: [{ id: '11111111-1111-4111-8111-111111111111', name: 'M.K. Fenwick' }],
        narrators: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Felix Vale' }],
        publisher: 'Der Hörverlag',
        series: { id: '33333333-3333-4333-8333-333333333333', name: 'Milo Farrow', position: 1 },
        durationMs: 30_600_000,
        abridged: false,
        chapterCount: 2,
        chapters: [
            { index: 0, name: 'Der Junge, der überlebte', startMs: 0, endMs: 120000 },
            {
                index: 1,
                name: 'Das verschwundene Glas',
                startMs: 120000,
                endMs: 400000,
            },
        ],
    };

    it('pulls the whole block off an audiobook node', () => {
        expect(extractAudiobookFields(node)).toEqual({
            authors: [{ id: '11111111-1111-4111-8111-111111111111', name: 'M.K. Fenwick' }],
            narrators: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Felix Vale' }],
            publisher: 'Der Hörverlag',
            series: node.series,
            durationMs: 30_600_000,
            abridged: false,
            chapterCount: 2,
            chapters: node.chapters,
            progress: undefined,
            images: undefined,
        });
    });

    it('accepts an UPPER-CASED type via the comparator', () => {
        expect(extractAudiobookFields({ ...node, type: 'AUDIOBOOK' })?.narrators).toEqual([
            { id: '22222222-2222-4222-8222-222222222222', name: 'Felix Vale' },
        ]);
    });

    it('returns undefined for a movie/series/episode node', () => {
        expect(extractAudiobookFields({ ...node, type: 'movie' })).toBeUndefined();
        expect(extractAudiobookFields({ ...node, type: 'series' })).toBeUndefined();
        expect(extractAudiobookFields({ ...node, type: 'episode' })).toBeUndefined();
    });

    it('returns undefined for a non-object (both clients are fail-open, so raw JSON can arrive)', () => {
        expect(extractAudiobookFields(undefined)).toBeUndefined();
        expect(extractAudiobookFields(null)).toBeUndefined();
        expect(extractAudiobookFields('audiobook')).toBeUndefined();
    });

    it('keeps the server-reported count when the chapter list was not shipped', () => {
        const withoutList = { ...node, chapters: undefined };
        const fields = extractAudiobookFields(withoutList);
        expect(fields?.chapterCount).toBe(2);
        expect(fields?.chapters).toEqual([]);
    });

    it('drops unusable chapter entries instead of rendering blank rows', () => {
        const fields = extractAudiobookFields({
            ...node,
            chapterCount: undefined,
            chapters: [
                { index: 0, name: 'Real', startMs: 0, endMs: 1000 },
                { index: 1, name: 'No start' },
                'not an object',
                { index: 3, startMs: 10000 },
            ],
        });
        expect(fields?.chapters).toEqual([{ index: 0, name: 'Real', startMs: 0, endMs: 1000 }]);
        // No server count → derived from the surviving rows.
        expect(fields?.chapterCount).toBe(1);
    });

    it('degrades a malformed authors/narrators value to an empty list', () => {
        const fields = extractAudiobookFields({
            ...node,
            authors: 'M.K. Fenwick',
            narrators: [
                null,
                '',
                { id: '22222222-2222-4222-8222-222222222222', name: 'Felix Vale' },
            ],
        });
        expect(fields?.authors).toEqual([]);
        expect(fields?.narrators).toEqual([
            { id: '22222222-2222-4222-8222-222222222222', name: 'Felix Vale' },
        ]);
    });

    it('omits optional scalars rather than defaulting them', () => {
        const fields = extractAudiobookFields({
            id: 'x',
            type: 'audiobook',
            title: 'Standalone',
            ids: {},
            isAvailable: true,
            canRequest: false,
        });
        expect(fields).toEqual({
            authors: [],
            narrators: [],
            publisher: undefined,
            series: undefined,
            progress: undefined,
            images: undefined,
            durationMs: undefined,
            abridged: undefined,
            chapterCount: 0,
            chapters: [],
        });
    });
});

describe('enrichMediaData — audiobook node', () => {
    beforeEach(() => vi.clearAllMocks());

    it('carries the audiobook block, the publication year and the listening duration', async () => {
        vi.mocked(contentApi.getMediaDetails).mockResolvedValue({
            data: {
                id: 'book-uuid',
                type: 'audiobook',
                title: 'Ein Buch',
                overview: 'Beschreibung',
                ids: { internal: 'book-uuid' },
                year: 2016,
                isAvailable: true,
                canRequest: false,
                authors: [{ id: '11111111-1111-4111-8111-111111111111', name: 'M.K. Fenwick' }],
                narrators: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Felix Vale' }],
                durationMs: 30_600_000,
                chapterCount: 108,
                chapters: [{ index: 0, name: 'Eins', startMs: 0, endMs: 1000 }],
            },
            error: null,
        } as never);

        const enriched = await enrichMediaData({
            mediaType: 'AUDIOBOOK',
            externalIds: { internal: 'book-uuid' },
        });

        expect(enriched._enriched).toBe(true);
        expect(enriched.overview).toBe('Beschreibung');
        // Year is node-level and was previously movie-only, so a book's only date
        // never reached the modal.
        expect(enriched.year).toBe('2016');
        expect(enriched.duration).toBe(30_600);
        expect(enriched.audiobook?.narrators).toEqual([
            { id: '22222222-2222-4222-8222-222222222222', name: 'Felix Vale' },
        ]);
        expect(enriched.audiobook?.chapterCount).toBe(108);
    });

    it('leaves the audiobook block undefined for a movie', async () => {
        vi.mocked(contentApi.getMediaDetails).mockResolvedValue({
            data: {
                id: 'movie-uuid',
                type: 'movie',
                title: 'Intertidal',
                ids: { internal: 'movie-uuid' },
                isAvailable: true,
                canRequest: false,
            },
            error: null,
        } as never);

        const enriched = await enrichMediaData({
            mediaType: 'movie',
            externalIds: { internal: 'movie-uuid' },
        });
        expect(enriched.audiobook).toBeUndefined();
    });
});

describe('enrichMediaData fresh availability', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it.each([
        [false, true, false],
        [true, false, false],
        [false, true, true],
        [true, false, true],
        [undefined, undefined, false],
        [undefined, undefined, true],
    ] as const)(
        'available=%s requestable=%s fallback=%s',
        async (available, requestable, fallback) => {
            const response = {
                data: {
                    id: 'catalog-series',
                    type: 'series',
                    title: 'Catalog series',
                    ids: { internal: 'catalog-series' },
                    isAvailable: available,
                    canRequest: requestable,
                    seasonCount: 8,
                    episodeCount: 254,
                    availableEpisodeCount: 0,
                },
                error: null,
                status: 200,
            };
            const fetch = vi.mocked(contentApi.getMediaDetails);
            if (fallback) fetch.mockResolvedValueOnce({ data: null, error: null, status: 503 });
            fetch.mockResolvedValueOnce(response as never);
            const enriched = await enrichMediaData({
                mediaType: 'tv',
                externalIds: { internal: 'catalog-series' },
                isAvailable: available === undefined ? true : !available,
                canRequest: requestable === undefined ? false : !requestable,
            });
            expect(enriched.isAvailable).toBe(available ?? true);
            expect(enriched.canRequest).toBe(requestable ?? false);
            expect(fetch).toHaveBeenCalledTimes(fallback ? 2 : 1);
            if (!fallback) {
                expect(enriched.seasonCount).toBe(8);
                expect(enriched.episodeCount).toBe(254);
                expect(enriched.availableEpisodeCount).toBe(0);
            }
        },
    );

    it('failed details preserve supplied flags', async () => {
        vi.mocked(contentApi.getMediaDetails).mockResolvedValue({
            data: null,
            error: null,
            status: 503,
        });
        const enriched = await enrichMediaData({
            mediaType: 'tv',
            externalIds: { internal: 'catalog-series' },
            isAvailable: false,
            canRequest: true,
        });
        expect(enriched.isAvailable).toBe(false);
        expect(enriched.canRequest).toBe(true);
    });
});
