// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for the extracted SearchService (src/lib/server/services/search.service.ts).
 *
 * These cover the now-extracted pure units directly — the rank-band
 * normalization (squash/normalizeRank/SOURCE_BAND), the catalog discriminator
 * map (toCatalogType), the per-source row → item mappers, and the
 * merge/excludeTerms/stable-sort/window-paginate transform. They complement
 * (do NOT replace) the def-level black-box tests in
 * defs/search/{search,suggest}.test.ts, which remain the contract safety net.
 *
 * Only buildImageRefs is mocked (deterministic href shape); everything else is
 * the real pure code under test.
 */

import { describe, it, expect, vi } from 'vitest';
import type { SearchSourceToggles } from './search.service.js';

const searchAcrossServices = vi.fn();
vi.mock('$lib/server/services/media-aggregation.service.js', () => ({
    MediaAggregationService: { searchAcrossServices },
}));

const searchMediaFulltext = vi.fn();
const searchEpisode = vi.fn();
vi.mock('$lib/server/database/queries/search.queries.js', () => ({
    searchMedia: vi.fn(),
    searchMediaFulltext,
    searchMediaTrigram: vi.fn(),
    searchEpisode,
    searchMusic: vi.fn(),
}));

const getAbsItemIdsByMediaIds = vi.fn();
vi.mock('$lib/server/database/queries/audiobooks.queries.js', () => ({
    AUDIOBOOKSHELF_PROVIDER: 'audiobookshelf',
    AUDIOBOOK_MEDIA_TYPE: 'audiobook',
    getAbsItemIdsByMediaIds,
}));

const {
    SearchService,
    SOURCE_BAND,
    squash,
    normalizeRank,
    toCatalogType,
    posterImage,
    capTypeRuns,
    MAX_SAME_TYPE_RUN,
} = await import('./search.service.js');

// The surface these mappers are exercised on. IMG is the prefix that surface
// must produce — asserting against it pins the derivation, not a literal.
const SURFACE = 'v1' as const;
const IMG = '/api/v1/media';

// ── Rank normalization ──────────────────────────────────────────────────────

describe('SearchService — squash', () => {
    it('maps non-positive / non-finite raw rank to 0', () => {
        expect(squash(0)).toBe(0);
        expect(squash(-5)).toBe(0);
        expect(squash(null)).toBe(0);
        expect(squash(undefined)).toBe(0);
        expect(squash(Number.NaN)).toBe(0);
        expect(squash(Number.POSITIVE_INFINITY)).toBe(0);
    });

    it('squashes a positive raw rank into the open interval (0,1)', () => {
        expect(squash(1)).toBeCloseTo(0.5, 10);
        const big = squash(1_000_000);
        expect(big).toBeGreaterThan(0);
        expect(big).toBeLessThan(1);
    });

    it('is monotonic increasing in raw rank', () => {
        expect(squash(0.5)).toBeLessThan(squash(0.9));
        expect(squash(2)).toBeLessThan(squash(10));
    });
});

describe('SearchService — normalizeRank / SOURCE_BAND', () => {
    it('offsets each source onto its band so bands never overlap', () => {
        // Worst-case high raw rank in a lower band can never beat best-case in a
        // higher band — squash is bounded < 1, bands are integer-spaced.
        expect(normalizeRank('episode_pattern', 0)).toBeGreaterThan(
            normalizeRank('fts', 1_000_000),
        );
        expect(normalizeRank('fts', 0)).toBeGreaterThan(normalizeRank('music', 1e9));
        expect(normalizeRank('external', 0)).toBeGreaterThan(normalizeRank('fuzzy', 1e9));
    });

    it('preserves the documented band order', () => {
        expect(SOURCE_BAND.episode_pattern).toBeGreaterThan(SOURCE_BAND.fts);
        expect(SOURCE_BAND.fts).toBeGreaterThan(SOURCE_BAND.episode);
        expect(SOURCE_BAND.episode).toBe(SOURCE_BAND.music);
        expect(SOURCE_BAND.music).toBeGreaterThan(SOURCE_BAND.external);
        expect(SOURCE_BAND.external).toBe(SOURCE_BAND.non_entertainment);
        expect(SOURCE_BAND.non_entertainment).toBeGreaterThan(SOURCE_BAND.fuzzy);
    });

    it('unknown source falls back to band 0', () => {
        expect(normalizeRank('nope', 1)).toBeCloseTo(0.5, 10);
    });
});

describe('SearchService — toCatalogType', () => {
    it.each([
        ['tv', 'series'],
        ['show', 'series'],
        ['series', 'series'],
        ['TV', 'series'],
        ['movie', 'movie'],
        ['episode', 'episode'],
        ['track', 'track'],
        ['album', 'album'],
        ['artist', 'artist'],
    ])('maps %s → %s', (input, expected) => {
        expect(toCatalogType(input)).toBe(expected);
    });

    it('returns null for an unknown db type', () => {
        expect(toCatalogType('sonarr')).toBeNull();
        expect(toCatalogType('')).toBeNull();
    });
});

describe('SearchService — posterImage', () => {
    it('wraps a url as an images.poster.href entry', () => {
        expect(posterImage('http://x/cover.jpg')).toEqual({
            poster: { href: 'http://x/cover.jpg' },
        });
    });
    it('returns undefined for empty/nullish urls', () => {
        expect(posterImage('')).toBeUndefined();
        expect(posterImage(null)).toBeUndefined();
        expect(posterImage(undefined)).toBeUndefined();
    });
});

// ── Mappers ─────────────────────────────────────────────────────────────────

describe('SearchService.mapCatalogRow', () => {
    const baseRow = {
        media_type: 'movie',
        title: 'Dawn',
        rank: 0.9,
        internal_id: 'm-uuid',
        tmdb_id: null,
        imdb_id: null,
        release_date: '2021-10-22',
        overview: 'spice',
        match_source: 'fts',
    };

    it('maps an fts movie row to a self-describing item', () => {
        // createExternalIds is the real impl; with only internal set it yields
        // { internal: 'm-uuid' }.
        const item = SearchService.mapCatalogRow(baseRow as never, 'fts', SURFACE)!;
        expect(item.id).toBe('m-uuid');
        expect(item.type).toBe('movie');
        expect(item.year).toBe(2021);
        expect(item.overview).toBe('spice');
        expect(item.images).toEqual({
            poster: {
                href: `${IMG}/m-uuid/images/poster`,
                thumb: `${IMG}/m-uuid/images/poster?size=thumb`,
                card: `${IMG}/m-uuid/images/poster?size=card`,
                full: `${IMG}/m-uuid/images/poster?size=full`,
            },
            backdrop: {
                href: `${IMG}/m-uuid/images/backdrop`,
                thumb: `${IMG}/m-uuid/images/backdrop?size=thumb`,
                card: `${IMG}/m-uuid/images/backdrop?size=card`,
                wide: `${IMG}/m-uuid/images/backdrop?size=wide`,
                full: `${IMG}/m-uuid/images/backdrop?size=full`,
            },
        });
        expect(item.matchSource).toBe('fts');
        expect(item.rank).toBeCloseTo(normalizeRank('fts', 0.9), 10);
    });

    it("maps tv → 'series' and forces fuzzy matchSource for the fuzzy pass", () => {
        const item = SearchService.mapCatalogRow(
            { ...baseRow, media_type: 'tv', match_source: 'fts' } as never,
            'fuzzy',
            SURFACE,
        )!;
        expect(item.type).toBe('series');
        expect(item.matchSource).toBe('fuzzy');
        expect(item.rank).toBeCloseTo(normalizeRank('fuzzy', 0.9), 10);
    });

    it('never emits a Jellyfin id, even when the row still carries one', () => {
        const item = SearchService.mapCatalogRow(
            { ...baseRow, jellyfin_id: 'abcdef0123456789abcdef0123456789' } as never,
            'fts',
            SURFACE,
        )!;
        expect(item.id).toBe('m-uuid');
        expect(item.ids).not.toHaveProperty('jellyfin');
    });

    it.each([undefined, null, false, true])(
        'always emits a boolean isAvailable for catalog video (row value %s)',
        (value) => {
            const item = SearchService.mapCatalogRow(
                { ...baseRow, is_available: value } as never,
                'fts',
                SURFACE,
            )!;
            expect(item.isAvailable).toBe(value === true);
        },
    );

    it('emits a boolean isAvailable on episode-title rows even when the row omits it', () => {
        const row = {
            internal_id: 'e-uuid',
            title: 'Pilot',
            rank: 0.5,
            tmdb_id: null,
            imdb_id: null,
            release_date: null,
            overview: null,
        };
        expect(SearchService.mapEpisodeTitleRow(row as never, SURFACE)!.isAvailable).toBe(false);
        expect(
            SearchService.mapEpisodeTitleRow({ ...row, is_available: true } as never, SURFACE)!
                .isAvailable,
        ).toBe(true);
    });

    it('returns null for a non-catalog db type', () => {
        expect(
            SearchService.mapCatalogRow(
                { ...baseRow, media_type: 'home_video' } as never,
                'fts',
                SURFACE,
            ),
        ).toBeNull();
    });

    it('falls back to a composite tmdb id when no internal id', () => {
        const item = SearchService.mapCatalogRow(
            {
                ...baseRow,
                internal_id: null,
                tmdb_id: '603',
                media_type: 'movie',
            } as never,
            'fts',
            SURFACE,
        )!;
        expect(item.id).toBe('tmdb:603:movie');
    });
});

describe('SearchService.mapMusicRow', () => {
    it('preserves empty canonical performer credits separately from remixer identities', () => {
        const item = SearchService.mapMusicRow(
            {
                id: 'trk-1',
                media_type: 'track',
                title: 'Song (Cascada remix)',
                rank: 0.4,
                year: null,
                artist_name: null,
                album_title: 'Album',
                image_source_id: null,
                track_artists: [],
                remixer_artists: [{ id: 'remixer-id', title: 'Cascada' }],
            } as never,
            SURFACE,
        );
        expect(item?.artists).toEqual([]);
        expect(item?.artist).toBeUndefined();
        expect(item?.remixerArtists).toEqual([{ id: 'remixer-id', title: 'Cascada' }]);
    });

    it('builds the artist · album subtitle and uses image_source_id for art', () => {
        const item = SearchService.mapMusicRow(
            {
                id: 'trk-1',
                media_type: 'track',
                title: 'Song',
                rank: 0.4,
                year: 1999,
                artist_name: 'Artist',
                album_title: 'Album',
                image_source_id: 'alb-1',
            } as never,
            SURFACE,
        )!;
        expect(item.id).toBe('trk-1');
        expect(item.type).toBe('track');
        expect(item.overview).toBe('Artist · Album');
        expect(item.images).toEqual({
            poster: {
                href: `${IMG}/alb-1/images/poster`,
                thumb: `${IMG}/alb-1/images/poster?size=thumb`,
                card: `${IMG}/alb-1/images/poster?size=card`,
                full: `${IMG}/alb-1/images/poster?size=full`,
            },
            backdrop: {
                href: `${IMG}/alb-1/images/backdrop`,
                thumb: `${IMG}/alb-1/images/backdrop?size=thumb`,
                card: `${IMG}/alb-1/images/backdrop?size=card`,
                wide: `${IMG}/alb-1/images/backdrop?size=wide`,
                full: `${IMG}/alb-1/images/backdrop?size=full`,
            },
        });
        expect(item.matchSource).toBe('music');
    });

    it('exposes the artist name structurally, not only inside the display overview', () => {
        // "Artist · Album" cannot be parsed back apart safely — either half may
        // contain the separator — so a client labelling a row needs the field.
        const item = SearchService.mapMusicRow(
            {
                id: 'trk-1',
                media_type: 'track',
                title: 'Song',
                rank: 0.4,
                year: 1999,
                artist_name: 'Alphaharbor',
                album_title: 'Forever Young',
                image_source_id: null,
            } as never,
            SURFACE,
        )!;
        expect(item.artist).toBe('Alphaharbor');
        expect(item.album).toBe('Forever Young');
        // The display string stays put for clients already rendering it.
        expect(item.overview).toBe('Alphaharbor · Forever Young');
    });

    it('gives an album row its own artist name, not just an id', () => {
        const item = SearchService.mapMusicRow(
            {
                id: 'alb-1',
                media_type: 'album',
                title: 'Forever Young',
                rank: 0.5,
                year: 1984,
                artist_name: 'Alphaharbor',
                artist_id: 'art-1',
                album_title: null,
                image_source_id: null,
            } as never,
            SURFACE,
        )!;
        expect(item.artist).toBe('Alphaharbor');
        expect(item.artistId).toBe('art-1');
    });

    it('omits the artist when the row has none', () => {
        const item = SearchService.mapMusicRow(
            {
                id: 'art-1',
                media_type: 'artist',
                title: 'Alphaharbor',
                rank: 0.5,
                year: null,
                artist_name: null,
                album_title: null,
                image_source_id: null,
            } as never,
            SURFACE,
        )!;
        expect(item.artist).toBeUndefined();
    });
});

describe('SearchService.mapKavitaRow', () => {
    it('recovers the bare source id into the kavita slot and wraps the cover', () => {
        const item = SearchService.mapKavitaRow({
            id: 'kavita-series-42',
            mediaType: 'manga',
            title: 'Sky Harbor',
            overview: null,
            author: 'Eijiro Vale',
            year: 1997,
            libraryId: '3',
            imageUrl: '/api/image/kavita/42',
        })!;
        expect(item.type).toBe('manga');
        expect(item.id).toBe('kavita-series-42');
        expect(item.ids.kavita).toBe('42');
        expect(item.ids).not.toHaveProperty('jellyfin');
        expect(item.libraryId).toBe(3);
        expect(item.author).toBe('Eijiro Vale');
        expect(item.year).toBe(1997);
        expect(item.images).toEqual({ poster: { href: '/api/image/kavita/42' } });
        expect(item.matchSource).toBe('kavita');
    });

    it('drops non book/manga/comic kavita rows', () => {
        expect(
            SearchService.mapKavitaRow({
                id: 'kavita-x-1',
                mediaType: 'movie',
                title: 'X',
            }),
        ).toBeNull();
    });

    it('reports author/year as undefined rather than null', () => {
        const item = SearchService.mapKavitaRow({
            id: 'kavita-series-7',
            mediaType: 'book',
            title: 'Untitled',
            author: null,
            year: null,
        })!;
        expect(item.author).toBeUndefined();
        expect(item.year).toBeUndefined();
    });
});

describe('SearchService.mapExternalRow', () => {
    const allSources = {
        movies: true,
        series: true,
        episodes: true,
        music: true,
        books: true,
        audiobooks: true,
        requests: true,
        channels: true,
        nonEntTypes: [] as never[],
    };

    it('skips catalog rows owned by the DB tasks', () => {
        for (const t of ['movie', 'tv', 'episode']) {
            expect(
                SearchService.mapExternalRow({ id: 'x', mediaType: t, title: 'X' }, allSources),
            ).toBeNull();
        }
    });

    it('maps anfragen → request with the canonical type', () => {
        const item = SearchService.mapExternalRow(
            {
                id: 'req-1',
                mediaType: 'anfragen',
                title: 'Req',
                requestMediaType: 'tv',
                externalIds: { tmdb: '5' },
            },
            allSources,
        )!;
        expect(item.type).toBe('request');
        expect(item.requestMediaType).toBe('tv');
        expect(item.ids).toEqual({ tmdb: '5' });
        expect(item.matchSource).toBe('jellyseerr');
    });

    it('maps tvchannel to its canonical type', () => {
        const ch = SearchService.mapExternalRow(
            { id: 'c1', mediaType: 'tvchannel', title: 'CH', imageUrl: '/logo.png' },
            allSources,
        )!;
        expect(ch.type).toBe('tvchannel');
        expect(ch.matchSource).toBe('livetv');
    });

    it('drops an audiobook — books are owned by the local catalog pass now', () => {
        // Guard against double-emission. Audiobooks used to be mapped here from
        // a live AudiobookShelf response; they now come from
        // searchAudiobookRows with a media_items id and a real rank. An
        // 'audiobook' arriving through the aggregator would be a duplicate with
        // the WORSE id (raw ABS) and the WORSE rank (flat external band).
        expect(
            SearchService.mapExternalRow(
                { id: 'ab1', mediaType: 'audiobook', title: 'AB' },
                allSources,
            ),
        ).toBeNull();
    });
});

// ── Audiobooks: local catalog rows ──────────────────────────────────────────

describe('SearchService.mapNonEntertainmentRow', () => {
    it.each(['home_video', 'training', 'educational', 'personal'] as const)(
        '%s reports actual file availability',
        (mediaType) => {
            for (const has_files of [false, true]) {
                const item = SearchService.mapNonEntertainmentRow(
                    { id: '10000000-0000-0000-0000-000000000001', title: 'A video', has_files },
                    mediaType,
                    SURFACE,
                );
                expect(item.isAvailable).toBe(has_files);
            }
        },
    );
});

describe('SearchService.mapAudiobookRow', () => {
    const INTERNAL = '11111111-1111-1111-1111-111111111111';
    function row(over: Record<string, unknown> = {}) {
        return {
            internal_id: INTERNAL,
            title: 'Milo Farrow and the Lantern of Dawn',
            overview: 'Book four.',
            release_date: '2000-07-08',
            rank: 3,
            match_source: 'title',
            ...over,
        } as never;
    }

    it('keys the item on the media_items UUID and fills the ABS id slot only', () => {
        const ab = SearchService.mapAudiobookRow(row(), new Map([[INTERNAL, 'abs-1']]), SURFACE)!;
        expect(ab.type).toBe('audiobook');
        expect(ab.id).toBe(INTERNAL);
        expect(ab.ids.internal).toBe(INTERNAL);
        expect(ab.ids.audiobookshelf).toBe('abs-1');
        // Responses no longer carry anything in the Jellyfin slot.
        expect(ab.ids).not.toHaveProperty('jellyfin');
        expect(ab.year).toBe(2000);
    });

    it('uses the resolvable byte route for cover art, not an AudiobookShelf url', () => {
        const ab = SearchService.mapAudiobookRow(row(), new Map([[INTERNAL, 'abs-1']]), SURFACE)!;
        expect(ab.images.poster.href).toContain(`${IMG}/${INTERNAL}`);
    });

    it('still emits the book when no external_ids row exists for it', () => {
        // A local row whose provider link was never written is a real state.
        // It must stay openable in Lumastra (ids.internal) even though the
        // deep link out to ABS is unavailable.
        const ab = SearchService.mapAudiobookRow(row(), new Map(), SURFACE)!;
        expect(ab.id).toBe(INTERNAL);
        expect(ab.ids.internal).toBe(INTERNAL);
        expect(ab.ids.audiobookshelf).toBeUndefined();
        expect(ab.ids.jellyfin).toBeUndefined();
    });

    it('ranks in the catalog fts band, not the external one', () => {
        const ab = SearchService.mapAudiobookRow(row(), new Map(), SURFACE)!;
        expect(ab.rank).toBeGreaterThanOrEqual(SOURCE_BAND.fts);
        expect(ab.rank).toBeLessThan(SOURCE_BAND.fts + 1);
        // The old behaviour: every book pinned into the external band below
        // every catalog and music hit, regardless of how well it matched.
        expect(ab.rank).toBeGreaterThan(normalizeRank('external', null));
    });

    it('drops a row with no internal_id rather than inventing an id', () => {
        expect(
            SearchService.mapAudiobookRow(row({ internal_id: null }), new Map(), SURFACE),
        ).toBeNull();
    });
});

describe('SearchService.searchAudiobookRows', () => {
    it.each([false, true])(
        'honors the description toggle for audiobooks and episodes: %s',
        async (useFulltext) => {
            searchMediaFulltext.mockResolvedValue([]);
            await SearchService.searchAudiobookRows(opts({ useFulltext }), {} as never);
            expect(searchMediaFulltext).toHaveBeenLastCalledWith(
                expect.anything(),
                'potter fire',
                expect.anything(),
                expect.objectContaining({ includeDescriptions: useFulltext }),
            );
            await SearchService.searchEpisodeTitles(opts({ useFulltext }), {} as never);
            expect(searchMediaFulltext).toHaveBeenLastCalledWith(
                expect.anything(),
                'potter fire',
                expect.anything(),
                expect.objectContaining({ includeDescriptions: useFulltext }),
            );
        },
    );
    const INTERNAL = '22222222-2222-2222-2222-222222222222';

    function opts(over: Record<string, unknown> = {}) {
        return {
            sql: {} as never,
            q: 'potter fire',
            window: 20,
            showUnavailableMedia: false,
            surface: SURFACE,
            ...over,
        } as never;
    }

    it('asks the shared fulltext primitive for audiobook rows only', async () => {
        searchMediaFulltext.mockResolvedValueOnce([]);
        await SearchService.searchAudiobookRows(opts(), {} as never);
        // The whole point of the fix: the same tokenising primitive movies and
        // episodes use, rather than handing the raw string to AudiobookShelf,
        // which matches it as one contiguous substring.
        expect(searchMediaFulltext).toHaveBeenCalledWith(
            expect.anything(),
            'potter fire',
            expect.anything(),
            expect.objectContaining({ mediaTypes: ['audiobook'], includeDescriptions: false }),
        );
    });

    it('skips the external-id lookup entirely when nothing matched', async () => {
        searchMediaFulltext.mockResolvedValueOnce([]);
        const out = await SearchService.searchAudiobookRows(opts(), {} as never);
        expect(out).toEqual([]);
        expect(getAbsItemIdsByMediaIds).not.toHaveBeenCalled();
    });

    it('keeps the hits when the external-id lookup fails', async () => {
        // The ABS ids decorate a deep link OUT of Lumastra; they are not what
        // opens the book here. Losing them must not lose the search result.
        searchMediaFulltext.mockResolvedValueOnce([
            { internal_id: INTERNAL, title: 'AB', rank: 2, release_date: null },
        ]);
        getAbsItemIdsByMediaIds.mockRejectedValueOnce(new Error('connection reset'));

        const out = await SearchService.searchAudiobookRows(opts(), {} as never);

        expect(out).toHaveLength(1);
        expect(out[0].id).toBe(INTERNAL);
        expect(out[0].ids.audiobookshelf).toBeUndefined();
    });
});

describe('SearchService — episodes always require a file', () => {
    const base = {
        sql: {} as never,
        q: 'harbor pilot',
        window: 20,
        limit: 20,
        offset: 0,
        useFulltext: false,
        deniedGroupIds: null,
        ageRating: null,
        liveTvAllowed: false,
        // The search switch is ON: file-less movies/series may show, episodes may not.
        showUnavailableMedia: true,
        surface: SURFACE,
    };

    it('episode title search ignores the show-unavailable switch', async () => {
        searchMediaFulltext.mockResolvedValue([]);
        await SearchService.searchEpisodeTitles(base as never, {} as never);
        expect(searchMediaFulltext).toHaveBeenLastCalledWith(
            expect.anything(),
            'harbor pilot',
            expect.anything(),
            expect.objectContaining({ mediaTypes: ['episode'], availableOnly: true }),
        );
    });

    it('the SxxEyy fast path ignores the show-unavailable switch', async () => {
        searchEpisode.mockResolvedValue([]);
        await SearchService.fanOut({
            ...base,
            q: 'Full Harbor S03E12',
            sources: { episodes: true, movies: true, series: true },
        } as never);
        expect(searchEpisode).toHaveBeenCalledTimes(1);
        expect(searchEpisode.mock.calls[0][5]).toEqual({ availableOnly: true });
    });
});

describe('SearchService.searchExternal', () => {
    function baseOpts(sources: Partial<SearchSourceToggles> = {}) {
        return {
            sql: {} as never,
            q: 'milo farrow',
            window: 20,
            offset: 0,
            limit: 20,
            useFulltext: false,
            deniedGroupIds: null,
            ageRating: null,
            showUnavailableMedia: false,
            liveTvAllowed: true,
            surface: SURFACE,
            sources: {
                movies: false,
                series: false,
                episodes: false,
                music: false,
                books: false,
                audiobooks: true,
                requests: false,
                channels: true,
                nonEntTypes: [],
                ...sources,
            },
        };
    }

    it('never asks AudiobookShelf, even with the audiobooks source enabled', async () => {
        // The regression this whole change exists to prevent coming back:
        // ABS matches the raw query as one contiguous substring, so any query
        // whose words are not adjacent ("potter fire") scored zero there.
        searchAcrossServices.mockResolvedValueOnce({
            items: [],
            totalResults: 0,
            sources: {} as never,
        });

        await SearchService.searchExternal(baseOpts());

        const [, callOpts] = searchAcrossServices.mock.calls[0];
        expect(callOpts.sources).toEqual(['livetv']);
        expect(callOpts.sources).not.toContain('audiobookshelf');
    });

    it('drops an audiobook the aggregator returns anyway, and keeps the other sources', async () => {
        // Defence in depth: if some other caller ever re-enables the ABS source
        // on the aggregator, its books must not reappear here as duplicates of
        // the local rows — while Live TV in the same response stays untouched.
        searchAcrossServices.mockResolvedValueOnce({
            items: [
                { id: 'ab1', mediaType: 'audiobook', title: 'AB' },
                { id: 'c1', mediaType: 'tvchannel', title: 'CH' },
            ],
            totalResults: 2,
            sources: {} as never,
        });

        const out = await SearchService.searchExternal(baseOpts());

        expect(out.find((r) => r.type === 'audiobook')).toBeUndefined();
        expect(out.find((r) => r.type === 'tvchannel')!.id).toBe('c1');
    });
});

// ── Merge / filter / sort / paginate ────────────────────────────────────────

describe('SearchService.mergeAndPaginate', () => {
    function item(
        over: Partial<{ id: string; title: string; rank: number; overview: string; year: number }>,
    ) {
        return {
            year: over.year,
            id: over.id ?? 'id',
            type: 'movie' as const,
            ids: {},
            title: over.title ?? 'T',
            overview: over.overview,
            images: { poster: { href: '' } },
            rank: over.rank ?? 1,
            matchSource: 'fts',
        };
    }
    const baseOpts = {
        offset: 0,
        limit: 2,
    } as never;

    it('sorts by rank desc, then title, then id; slices the window', () => {
        const items = [
            item({ id: 'c', title: 'Cee', rank: 1 }),
            item({ id: 'a', title: 'Aay', rank: 2 }),
            item({ id: 'b', title: 'Bee', rank: 2 }),
        ];
        const { items: page, hasMore } = SearchService.mergeAndPaginate(items, baseOpts);
        // rank 2 group first, tie broken by title (Aay < Bee), then rank 1.
        expect(page.map((i) => i.id)).toEqual(['a', 'b']);
        expect(hasMore).toBe(true); // 3 > offset(0)+limit(2)
    });

    it('yearHint floats matching years first within a rank band, never across bands', () => {
        const items = [
            item({ id: 'old', title: 'Anna', rank: 4.9, year: 1990 }),
            item({ id: 'new', title: 'Anna', rank: 4.6, year: 2019 }),
            item({ id: 'fuzzy', title: 'Ana', rank: 1.9, year: 2019 }),
        ];
        const { items: page } = SearchService.mergeAndPaginate(items, {
            offset: 0,
            limit: 10,
            yearHint: 2019,
        } as never);
        expect(page.map((i) => i.id)).toEqual(['new', 'old', 'fuzzy']);
    });

    it('applies excludeTerms against title and overview (case-insensitive)', () => {
        const items = [
            item({ id: '1', title: 'Star Lanterns', rank: 3 }),
            item({ id: '2', title: 'Trek', overview: 'A STAR voyage', rank: 2 }),
            item({ id: '3', title: 'Dawn', rank: 1 }),
        ];
        const { items: page } = SearchService.mergeAndPaginate(items, {
            offset: 0,
            limit: 10,
            excludeTerms: ['star'],
        } as never);
        expect(page.map((i) => i.id)).toEqual(['3']);
    });

    it('respects offset for the second page and reports hasMore=false at the end', () => {
        const items = [
            item({ id: '1', title: 'A', rank: 4 }),
            item({ id: '2', title: 'B', rank: 3 }),
            item({ id: '3', title: 'C', rank: 2 }),
        ];
        const { items: page, hasMore } = SearchService.mergeAndPaginate(items, {
            offset: 2,
            limit: 2,
        } as never);
        expect(page.map((i) => i.id)).toEqual(['3']);
        expect(hasMore).toBe(false);
    });
});

describe('SearchService.suggest (pure merge path)', () => {
    it('sorts suggestions by title then id and slices to limit with truncated', async () => {
        // Drive suggest() with a fake sql by stubbing the fan-out (we only test
        // the merge/sort/slice tail here; fan-out per-source is covered by the
        // def-level suggest.test.ts and the mapper tests above).
        const spy = vi.spyOn(SearchService, 'suggestFanOut').mockResolvedValue([
            { id: 'z', title: 'Zed', mediaType: 'movie', images: {} as never },
            { id: 'a', title: 'Aay', mediaType: 'movie', images: {} as never },
            { id: 'm', title: 'Em', mediaType: 'movie', images: {} as never },
        ]);
        const { items, truncated } = await SearchService.suggest({
            limit: 2,
        } as never);
        expect(items.map((i) => i.id)).toEqual(['a', 'm']);
        expect(truncated).toBe(true);
        spy.mockRestore();
    });
});

// ── Same-type run capping ───────────────────────────────────────────────────

/**
 * The regression these pin is a REAL, MEASURED one that flipped direction.
 *
 * On prod, "milo farrow" matches 27 audiobooks and 14 movies. Before books
 * joined the catalog band they were pinned below everything and the first one
 * sat at global offset 362 — unreachable. After the banding fix they legitimately
 * outranked AND outnumbered the films, so a purely rank-ordered page put 27 books
 * at indices 0–26 and the first film at 27. Same failure, other direction: one
 * shared scale over an unbalanced corpus.
 *
 * These assert the presentation fix and, just as importantly, its LIMITS — that
 * it never reorders across rank bands and never loses a result.
 */
describe('capTypeRuns', () => {
    /** Items in one band, so only the run cap can reorder them. */
    type CapInput = Parameters<typeof capTypeRuns>[0];
    function band4(spec: Array<[string, number]>): CapInput {
        return spec.map(([type, rank], i) => ({
            id: `${type}-${i}`,
            type,
            ids: {},
            title: `${type} ${i}`,
            rank,
        })) as unknown as CapInput;
    }

    it('breaks a same-type wall so the other type reaches the first page', () => {
        // 8 books all outranking 4 films — the shape of the prod page.
        const input = band4([
            ...Array.from({ length: 8 }, () => ['audiobook', 4.83] as [string, number]),
            ...Array.from({ length: 4 }, () => ['movie', 4.8] as [string, number]),
        ]);

        const out = capTypeRuns(input, 4);

        const firstMovie = out.findIndex((i) => i.type === 'movie');
        expect(firstMovie).toBe(4); // was 8 — off a short page
        expect(out.slice(0, 4).every((i) => i.type === 'audiobook')).toBe(true);
    });

    it('never lets a run exceed the cap while another same-band type remains', () => {
        const input = band4([
            ...Array.from({ length: 20 }, () => ['audiobook', 4.83] as [string, number]),
            ...Array.from({ length: 20 }, () => ['movie', 4.8] as [string, number]),
        ]);

        const out = capTypeRuns(input, MAX_SAME_TYPE_RUN);

        // The cap binds only while there is something else to switch TO. Once
        // one type is exhausted the remainder is necessarily one long run, and
        // that is correct — the alternative would be withholding results. So
        // the invariant is conditional on the suffix, not global; asserting it
        // globally is what made the first version of this test fail against
        // correct behaviour.
        let run = 0;
        let last: string | null = null;
        for (let i = 0; i < out.length; i++) {
            run = out[i].type === last ? run + 1 : 1;
            last = out[i].type;
            const anotherTypeRemains = out.slice(i + 1).some((o) => o.type !== out[i].type);
            if (anotherTypeRemains) {
                expect({ i, run }).toEqual({ i, run: Math.min(run, MAX_SAME_TYPE_RUN) });
            }
        }
    });

    it('NEVER promotes a lower band — a fuzzy guess must not outrank exact matches', () => {
        // THE constraint that makes this safe. Band 1 (trigram typo hits) must
        // stay below band 4 no matter how long the band-4 run gets; otherwise
        // the cap trades a crowded page for a wrong one.
        const input = [
            ...Array.from({ length: 10 }, (_, i) => ({
                id: `m${i}`,
                type: 'movie',
                ids: {},
                title: `m${i}`,
                rank: normalizeRank('fts', 5),
            })),
            ...Array.from({ length: 5 }, (_, i) => ({
                id: `f${i}`,
                type: 'series',
                ids: {},
                title: `f${i}`,
                rank: normalizeRank('fuzzy', 5),
            })),
        ] as unknown as CapInput;

        const out = capTypeRuns(input, 4);

        expect(out.slice(0, 10).every((i) => i.type === 'movie')).toBe(true);
        expect(out.slice(10).every((i) => i.type === 'series')).toBe(true);
    });

    it('lets the run continue when no same-band alternative is left', () => {
        // The cap is a preference, never a reason to withhold or reorder across
        // bands. A tail of one type must simply be emitted.
        const out = capTypeRuns(band4(Array.from({ length: 9 }, () => ['movie', 4.8])), 4);
        expect(out).toHaveLength(9);
        expect(out.every((i) => i.type === 'movie')).toBe(true);
    });

    it('loses nothing and duplicates nothing', () => {
        // A starvation or double-shift bug here would silently delete search
        // results, which is worse than the crowding it fixes.
        const input = band4([
            ...Array.from({ length: 13 }, () => ['audiobook', 4.83] as [string, number]),
            ...Array.from({ length: 7 }, () => ['movie', 4.8] as [string, number]),
            ...Array.from({ length: 3 }, () => ['track', 4.81] as [string, number]),
        ]);

        const out = capTypeRuns(input, MAX_SAME_TYPE_RUN);

        expect(out).toHaveLength(input.length);
        expect(new Set(out.map((i) => i.id)).size).toBe(input.length);
        expect(new Set(out.map((i) => i.id))).toEqual(new Set(input.map((i) => i.id)));
    });

    it('is a no-op for a single-type result set', () => {
        // The common case — a scoped search — must not be reordered at all.
        const input = band4(Array.from({ length: 30 }, (_, i) => ['movie', 5 - i * 0.01]));
        expect(capTypeRuns(input, 4).map((i) => i.id)).toEqual(input.map((i) => i.id));
    });

    it('is deterministic — same input, same order', () => {
        // Pagination slices this list; a non-deterministic order would put one
        // item on two pages and drop another entirely.
        const input = band4([
            ...Array.from({ length: 9 }, () => ['audiobook', 4.83] as [string, number]),
            ...Array.from({ length: 9 }, () => ['movie', 4.8] as [string, number]),
        ]);
        expect(capTypeRuns(input, 4).map((i) => i.id)).toEqual(
            capTypeRuns(input, 4).map((i) => i.id),
        );
    });
});
