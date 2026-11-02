// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * modal-utils.ts Unit Tests
 *
 * [M24] Pins `openSeriesModalFromEpisode`'s UUID short-circuit behavior in
 * `openSeriesModalFromEpisodeInner`: a `seriesInternalId` UUID that resolves
 * to a record must only be treated as a series when the API actually
 * confirms `type`/`mediaType` is a series. A record with NO type (or an
 * explicitly non-series type) must NOT fabricate a series modal — it must
 * fall through to the multi-stage name/Jellyfin-ID lookup instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as contentApi from '$lib/api/content';
import { modals } from '$lib/stores/modal.store';
import { toasts } from '$lib/stores/toast.store';
import { getModalComponent } from '$lib/stores/modal-registry.store';
import { V1SearchResultItemSchema } from '$lib/schemas/api-content-responses';
import { transformSearchItem } from './search/transformers';
import { getItemOpenHandler } from './search/item-open-handlers';

vi.mock('$lib/api/content', () => ({
    getMediaDetails: vi.fn(),
    search: vi.fn(),
    searchSeries: vi.fn(),
    getSeriesDetails: vi.fn(),
}));

vi.mock('$lib/stores/modal.store', () => ({
    modals: {
        open: vi.fn(),
        openEntity: vi.fn(),
        close: vi.fn(),
        closeAll: vi.fn(),
        closeById: vi.fn(),
        replace: vi.fn(),
        updateProps: vi.fn(),
    },
}));

vi.mock('$lib/stores/toast.store', () => ({
    toasts: {
        success: vi.fn(),
        error: vi.fn(),
        warning: vi.fn(),
        info: vi.fn(),
    },
}));

vi.mock('$lib/utils/image-utils', () => ({
    imageFromIds: vi.fn(() => ''),
    pickVariant: vi.fn(() => undefined),
    getCatalogPosterUrl: vi.fn(() => 'https://example.test/poster.jpg'),
    getCatalogThumbUrl: vi.fn(() => 'https://example.test/thumb.jpg'),
    createPlaceholderDataUrl: vi.fn(() => 'data:image/placeholder'),
}));

vi.mock('$lib/utils/modal-data', () => ({
    fetchTmdbDetails: vi.fn().mockResolvedValue(null),
}));

vi.mock('$lib/stores/modal-registry.store', () => ({
    getModalComponent: vi.fn(() => 'MockMovieModalComponent'),
}));

import {
    openMediaModal,
    openSimilarItemModal,
    openSeriesModalFromEpisode,
    openMediaModalFromUrl,
    trailKeyForMedia,
} from './modal-utils';
import { fetchTmdbDetails } from '$lib/utils/modal-data';
import type { UniversalMediaItem } from '$lib/types/server-driven-ui';

describe('openSimilarItemModal availability precedence', () => {
    it('preserves fresh false availability over a cached similar-card true', async () => {
        const internalId = '55555555-5555-4555-8555-555555555555';
        vi.mocked(fetchTmdbDetails).mockResolvedValue({
            externalIds: { internal: internalId },
            mediaType: 'movie',
            title: 'Similar Movie',
            isAvailable: false,
            canRequest: false,
        } as NonNullable<Awaited<ReturnType<typeof fetchTmdbDetails>>>);

        await openSimilarItemModal({
            id: 'similar-card',
            title: 'Similar Movie',
            mediaType: 'movie',
            clickData: {
                originalMovie: {
                    type: 'movie',
                    ids: { internal: internalId },
                    title: 'Similar Movie',
                    isAvailable: true,
                    canRequest: true,
                },
            },
        } as unknown as UniversalMediaItem);

        const [, props] = vi.mocked(modals.openEntity).mock.calls.at(-1) as [
            unknown,
            { isAvailable?: boolean; canRequest?: boolean },
        ];
        expect(props.isAvailable).toBe(false);
        expect(props.canRequest).toBe(false);
    });
});

/** No-op response for the fallback stages (Stage 1-3) so `seriesData` stays
 * null and the function reaches the "create minimal series data" fallback,
 * making it obvious (via the resulting title) whether the short-circuit
 * branch fabricated a series or correctly fell through. */
function stubEmptyFallbackStages(): void {
    vi.mocked(contentApi.search).mockResolvedValue({
        data: { items: [], page: 1 },
        error: undefined,
    } as unknown as Awaited<ReturnType<typeof contentApi.search>>);
    vi.mocked(contentApi.searchSeries).mockResolvedValue({
        data: null,
        error: 'not found',
    } as unknown as Awaited<ReturnType<typeof contentApi.searchSeries>>);
}

describe('[M24] openSeriesModalFromEpisode UUID short-circuit', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        stubEmptyFallbackStages();
    });

    it('does NOT fabricate a series modal when the resolved record has no type/mediaType', async () => {
        vi.mocked(contentApi.getMediaDetails).mockResolvedValue({
            data: {
                // No `type`, no `mediaType` — ambiguous record.
                title: 'WRONG TITLE FROM UNTYPED RECORD',
                overview: 'should never be used',
            },
            error: undefined,
        } as unknown as Awaited<ReturnType<typeof contentApi.getMediaDetails>>);

        await openSeriesModalFromEpisode({
            seriesName: 'My Real Series Name',
            seriesInternalId: 'uuid-untyped-record',
        });

        expect(modals.openEntity).toHaveBeenCalledTimes(1);
        const [, props] = vi.mocked(modals.openEntity).mock.calls[0] as [
            unknown,
            { title?: string },
        ];
        // Falls through to the "no series data resolved" fallback, whose
        // title is the caller-supplied seriesName — NOT the untyped record's
        // title. Proves the untyped record was never treated as a series.
        expect(props.title).toBe('My Real Series Name');
        expect(props.title).not.toBe('WRONG TITLE FROM UNTYPED RECORD');
        expect(toasts.warning).toHaveBeenCalled();
    });

    it('does NOT fabricate a series modal when the resolved record is explicitly a movie', async () => {
        vi.mocked(contentApi.getMediaDetails).mockResolvedValue({
            data: {
                type: 'movie',
                title: 'WRONG TITLE FROM MOVIE RECORD',
                overview: 'should never be used',
            },
            error: undefined,
        } as unknown as Awaited<ReturnType<typeof contentApi.getMediaDetails>>);

        await openSeriesModalFromEpisode({
            seriesName: 'My Real Series Name',
            seriesInternalId: 'uuid-movie-record',
        });

        expect(modals.openEntity).toHaveBeenCalledTimes(1);
        const [, props] = vi.mocked(modals.openEntity).mock.calls[0] as [
            unknown,
            { title?: string },
        ];
        expect(props.title).toBe('My Real Series Name');
        expect(props.title).not.toBe('WRONG TITLE FROM MOVIE RECORD');
        expect(toasts.warning).toHaveBeenCalled();
    });

    it('does NOT fabricate a series modal when the resolved record is explicitly an episode', async () => {
        vi.mocked(contentApi.getMediaDetails).mockResolvedValue({
            data: {
                type: 'episode',
                title: 'WRONG TITLE FROM EPISODE RECORD',
            },
            error: undefined,
        } as unknown as Awaited<ReturnType<typeof contentApi.getMediaDetails>>);

        await openSeriesModalFromEpisode({
            seriesName: 'My Real Series Name',
            seriesInternalId: 'uuid-episode-record',
        });

        expect(modals.openEntity).toHaveBeenCalledTimes(1);
        const [, props] = vi.mocked(modals.openEntity).mock.calls[0] as [
            unknown,
            { title?: string },
        ];
        expect(props.title).toBe('My Real Series Name');
        expect(props.title).not.toBe('WRONG TITLE FROM EPISODE RECORD');
    });

    it('DOES build the series modal directly when the UUID resolves to a confirmed series (`type`)', async () => {
        vi.mocked(contentApi.getMediaDetails).mockResolvedValue({
            data: {
                type: 'series',
                title: 'Confirmed Series Title',
                overview: 'A real series overview',
                ids: { internal: 'uuid-series-record' },
            },
            error: undefined,
        } as unknown as Awaited<ReturnType<typeof contentApi.getMediaDetails>>);

        await openSeriesModalFromEpisode({
            seriesName: 'Fallback Name (should not be used)',
            seriesInternalId: 'uuid-series-record',
        });

        expect(modals.openEntity).toHaveBeenCalledTimes(1);
        const [component, props] = vi.mocked(modals.openEntity).mock.calls[0] as [
            unknown,
            { title?: string; mediaType?: string },
        ];
        expect(getModalComponent).toHaveBeenCalledWith('movie');
        expect(component).toBe('MockMovieModalComponent');
        expect(props.title).toBe('Confirmed Series Title');
        expect(props.mediaType).toBe('tv');
        // The short-circuit succeeded, so none of the fallback-stage lookups
        // (which would only run on fallthrough) should have been needed to
        // resolve a series.
        expect(toasts.warning).not.toHaveBeenCalled();
    });

    it('opens the series modal with initialSeason/initialEpisode and never writes a Jellyfin id', async () => {
        vi.mocked(contentApi.getMediaDetails).mockResolvedValue({
            data: {
                type: 'series',
                title: 'Revival Series',
                ids: { internal: 'uuid-revival', tmdb: '4242' },
            },
            error: undefined,
        } as unknown as Awaited<ReturnType<typeof contentApi.getMediaDetails>>);

        await openSeriesModalFromEpisode({
            seriesInternalId: 'uuid-revival',
            seasonNumber: 2,
            episodeNumber: 5,
        });

        expect(contentApi.getMediaDetails).toHaveBeenCalledWith('uuid-revival');
        expect(modals.openEntity).toHaveBeenCalledTimes(1);
        const [, props, options] = vi.mocked(modals.openEntity).mock.calls[0] as [
            unknown,
            {
                title?: string;
                initialSeason?: number;
                initialEpisode?: number;
                seriesInternalId?: string;
                externalIds?: Record<string, string>;
            },
            { trailKey?: string },
        ];
        expect(props.title).toBe('Revival Series');
        expect(props.initialSeason).toBe(2);
        expect(props.initialEpisode).toBe(5);
        expect(props.seriesInternalId).toBe('uuid-revival');
        expect(props.externalIds?.internal).toBe('uuid-revival');
        expect(props.externalIds).not.toHaveProperty('jellyfin');
        expect(props).not.toHaveProperty('jellyfinSeriesId');
        expect(options.trailKey).toBe('series:uuid-revival');
    });

    it('keeps the caller series UUID when the lookup fails, never the episode UUID', async () => {
        vi.mocked(contentApi.getMediaDetails).mockResolvedValue({
            data: undefined,
            error: 'timed out',
        } as unknown as Awaited<ReturnType<typeof contentApi.getMediaDetails>>);

        await openSeriesModalFromEpisode({
            seriesName: 'Lantern Ward',
            seriesInternalId: '0b9e4c1a-2d3f-4e5a-8b6c-7d8e9f0a1b2c',
            externalIds: { internal: 'uuid-episode' },
            seasonNumber: 1,
            episodeNumber: 4,
        });

        const [, props, options] = vi.mocked(modals.openEntity).mock.calls[0] as [
            unknown,
            { seriesInternalId?: string; externalIds?: Record<string, string> },
            { trailKey?: string },
        ];
        expect(props.seriesInternalId).toBe('0b9e4c1a-2d3f-4e5a-8b6c-7d8e9f0a1b2c');
        expect(props.externalIds?.internal).toBe('0b9e4c1a-2d3f-4e5a-8b6c-7d8e9f0a1b2c');
        expect(options.trailKey).toBe('series:0b9e4c1a-2d3f-4e5a-8b6c-7d8e9f0a1b2c');
    });

    it('drops the caller UUID when the lookup proves it is not a series', async () => {
        vi.mocked(contentApi.getMediaDetails).mockResolvedValue({
            data: { type: 'movie', title: 'Not a series' },
            error: undefined,
        } as unknown as Awaited<ReturnType<typeof contentApi.getMediaDetails>>);

        await openSeriesModalFromEpisode({
            seriesName: 'Lantern Ward',
            seriesInternalId: 'uuid-movie',
        });

        const [, props] = vi.mocked(modals.openEntity).mock.calls[0] as [
            unknown,
            { seriesInternalId?: string },
        ];
        expect(props.seriesInternalId).toBeUndefined();
    });

    it('never keys the series modal on the EPISODE UUID when no series resolves', async () => {
        vi.mocked(contentApi.getMediaDetails).mockResolvedValue({
            data: { type: 'movie', title: 'Not a series' },
            error: undefined,
        } as unknown as Awaited<ReturnType<typeof contentApi.getMediaDetails>>);

        await openSeriesModalFromEpisode({
            seriesName: 'Lantern Ward',
            seriesInternalId: 'uuid-movie',
            externalIds: { internal: '1d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6', tmdb: '4242' },
        });

        const [, props, options] = vi.mocked(modals.openEntity).mock.calls[0] as [
            unknown,
            {
                externalIds?: Record<string, string | undefined>;
                image?: string;
                isAvailable?: boolean;
            },
            { trailKey?: string },
        ];
        expect(props.externalIds?.internal).toBeUndefined();
        expect(props.externalIds?.tmdb).toBe('4242');
        expect(props.image ?? '').not.toContain('1d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6');
        expect(options.trailKey ?? '').not.toContain('1d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6');
    });

    it('DOES build the series modal when the UUID resolves via the legacy `mediaType` field ("tv")', async () => {
        vi.mocked(contentApi.getMediaDetails).mockResolvedValue({
            data: {
                mediaType: 'tv',
                title: 'Legacy Field Series Title',
                ids: { internal: 'uuid-legacy-series' },
            },
            error: undefined,
        } as unknown as Awaited<ReturnType<typeof contentApi.getMediaDetails>>);

        await openSeriesModalFromEpisode({
            seriesName: 'Fallback Name (should not be used)',
            seriesInternalId: 'uuid-legacy-series',
        });

        expect(modals.openEntity).toHaveBeenCalledTimes(1);
        const [, props] = vi.mocked(modals.openEntity).mock.calls[0] as [
            unknown,
            { title?: string },
        ];
        expect(props.title).toBe('Legacy Field Series Title');
    });
});

describe('[degraded-modal-fix] openMediaModalFromUrl resolves a direct series UUID correctly', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('hydrates mediaType/externalIds/genres from a series `type` response with nested `details`', async () => {
        vi.mocked(contentApi.getMediaDetails).mockResolvedValue({
            data: {
                type: 'series',
                title: 'Hafentage',
                overview: 'A real series overview',
                // Canonical `ids` map — the API no longer sends legacy `externalIds`.
                ids: { internal: 'uuid-hafentage-series', tmdb: '12345', jellyfin: 'jf-hafentage' },
                isAvailable: true,
                canRequest: false,
                // Rich fields only present with ?include=details.
                credits: {
                    cast: [{ person: { id: null, name: 'Rickey Collins' }, order: 0 }],
                    crew: [{ person: { id: null, name: 'Someone' }, job: 'Director' }],
                },
                details: {
                    genres: ['Animation', 'Comedy'],

                    ratings: { rtCritic: 80, mdblist: 7.5 },
                    rating: 7.5,
                },
            },
            error: undefined,
        } as unknown as Awaited<ReturnType<typeof contentApi.getMediaDetails>>);

        const result = await openMediaModalFromUrl(
            { internal: 'uuid-hafentage-series' },
            'movie', // URL-restore default hint — must NOT leak into the final mediaType
            2,
            11,
        );

        expect(result).toBe(true);
        // The initial fetch must request the rich detail block, or genres/
        // cast/ratings are permanently absent from the response.
        expect(contentApi.getMediaDetails).toHaveBeenCalledWith('uuid-hafentage-series');

        expect(modals.openEntity).toHaveBeenCalledTimes(1);
        const [, props] = vi.mocked(modals.openEntity).mock.calls[0] as [
            unknown,
            {
                mediaType?: string;
                externalIds?: Record<string, string | undefined>;
                genres?: string[];
                seasonNumber?: number;
                episodeNumber?: number;
            },
        ];

        // Bug A: must resolve to the ACTUAL type from the response, not the
        // 'movie' hint passed in from the URL parser's default.
        expect(props.mediaType).toBe('TV');
        // Bug B: the canonical `ids` map must be merged in (tmdb/jellyfin),
        // not just the bare UUID that was already in the URL.
        expect(props.externalIds).toEqual(
            expect.objectContaining({ internal: 'uuid-hafentage-series', tmdb: '12345' }),
        );
        // Bug C: genres must come from the nested `details` block.
        expect(props.genres).toEqual(['Animation', 'Comedy']);
        // Season/episode context from the URL must be preserved.
        expect(props.seasonNumber).toBe(2);
        expect(props.episodeNumber).toBe(11);
    });
});

describe('canonical availability in URL-restored details', () => {
    beforeEach(() => vi.clearAllMocks());

    it('reads nested availability and preserves explicit false despite an internal UUID', async () => {
        vi.mocked(contentApi.getMediaDetails).mockResolvedValue({
            data: {
                type: 'movie',
                title: 'Unavailable catalog movie',
                overview: 'A known item without a playable file.',
                ids: { internal: 'catalog-movie-uuid', tmdb: '12345' },
                availability: { isAvailable: false, canRequest: true, hasFile: false },
            },
            error: undefined,
        } as unknown as Awaited<ReturnType<typeof contentApi.getMediaDetails>>);

        expect(await openMediaModalFromUrl({ internal: 'catalog-movie-uuid' }, 'movie')).toBe(true);
        const [, props] = vi.mocked(modals.openEntity).mock.calls[0] as [
            unknown,
            { isAvailable?: boolean; canRequest?: boolean },
        ];
        expect(props).toMatchObject({ isAvailable: false, canRequest: true });
    });
});

describe('canonical availability in parent-series details', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        stubEmptyFallbackStages();
    });

    it('does not infer series availability from the series UUID', async () => {
        vi.mocked(contentApi.getMediaDetails).mockResolvedValue({
            data: {
                type: 'series',
                title: 'Unavailable series',
                overview: 'No episodes are playable.',
                ids: { internal: 'series-uuid', tmdb: '12345' },
                availability: { isAvailable: false, canRequest: false },
            },
            error: undefined,
        } as unknown as Awaited<ReturnType<typeof contentApi.getMediaDetails>>);

        await openSeriesModalFromEpisode({
            seriesName: 'Unavailable series',
            seriesInternalId: 'series-uuid',
        });
        const [, props] = vi.mocked(modals.openEntity).mock.calls[0] as [
            unknown,
            { isAvailable?: boolean; canRequest?: boolean },
        ];
        expect(props).toMatchObject({ isAvailable: false, canRequest: false });
    });
});

describe('openSeriesModalFromEpisode — internal id only from a dashed UUID', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        stubEmptyFallbackStages();
        vi.mocked(contentApi.getMediaDetails).mockResolvedValue({
            data: undefined,
            error: { status: 404 },
        } as unknown as Awaited<ReturnType<typeof contentApi.getMediaDetails>>);
    });

    it('does not put a dashless (Jellyfin-style) series id into externalIds.internal', async () => {
        await openSeriesModalFromEpisode({
            seriesName: 'Some Series',
            seriesInternalId: '6f1c2d3e4a5b4c6d8e7f90a1b2c3d4e5',
        });

        const [, props] = vi.mocked(modals.openEntity).mock.calls[0] as [
            unknown,
            { externalIds?: Record<string, string | undefined> },
        ];
        expect(props.externalIds?.internal).toBeUndefined();
    });

    it('uses a dashed series UUID as the internal id', async () => {
        const uuid = '6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5';
        await openSeriesModalFromEpisode({ seriesName: 'Some Series', seriesInternalId: uuid });

        const [, props] = vi.mocked(modals.openEntity).mock.calls[0] as [
            unknown,
            { externalIds?: Record<string, string | undefined> },
        ];
        expect(props.externalIds?.internal).toBe(uuid);
    });
});

describe('openMediaModalFromUrl — legacy ?modal=jellyfin:<id>:<type> links', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('asks the server to map the Jellyfin id and opens the internal item without a jellyfin id', async () => {
        const jellyfinId = '6f1c2d3e4a5b4c6d8e7f90a1b2c3d4e5';
        vi.mocked(contentApi.getMediaDetails).mockResolvedValue({
            data: {
                type: 'movie',
                title: 'Mapped Movie',
                ids: { internal: '6f1c2d3e-0000-4c6d-8e7f-90a1b2c3d4e5', tmdb: '550' },
                isAvailable: true,
            },
            error: undefined,
        } as unknown as Awaited<ReturnType<typeof contentApi.getMediaDetails>>);

        const result = await openMediaModalFromUrl({ jellyfin: jellyfinId }, 'movie');

        expect(result).toBe(true);
        expect(contentApi.getMediaDetails).toHaveBeenCalledWith(jellyfinId);
        const [, props] = vi.mocked(modals.openEntity).mock.calls[0] as [
            unknown,
            { externalIds?: Record<string, string | undefined> },
        ];
        expect(props.externalIds).not.toHaveProperty('jellyfin');
        expect(props.externalIds?.internal).toBe('6f1c2d3e-0000-4c6d-8e7f-90a1b2c3d4e5');
    });

    it('opens nothing (no empty modal) when the server does not know the id', async () => {
        vi.mocked(contentApi.getMediaDetails).mockResolvedValue({
            data: undefined,
            error: { status: 404 },
        } as unknown as Awaited<ReturnType<typeof contentApi.getMediaDetails>>);

        const result = await openMediaModalFromUrl(
            { jellyfin: '6f1c2d3e4a5b4c6d8e7f90a1b2c3d4e5' },
            'tv',
        );

        expect(result).toBe(false);
        expect(modals.openEntity).not.toHaveBeenCalled();
    });

    it('does not call the server for a malformed Jellyfin id', async () => {
        const result = await openMediaModalFromUrl({ jellyfin: 'not-an-id' }, 'movie');

        expect(result).toBe(false);
        expect(contentApi.getMediaDetails).not.toHaveBeenCalled();
        expect(modals.openEntity).not.toHaveBeenCalled();
    });
});

describe('trailKeyForMedia', () => {
    it('keys a library series on its own series id', () => {
        expect(trailKeyForMedia({ internal: 'S1' }, 'tv', undefined)).toBe('series:S1');
    });

    it('keys every episode of a series on the SAME series key (swaps collapse)', () => {
        const a = trailKeyForMedia({ internal: 'epX' }, 'episode', 'S1');
        const b = trailKeyForMedia({ internal: 'epY' }, 'episode', 'S1');
        expect(a).toBe('series:S1');
        expect(b).toBe('series:S1');
    });

    it('unifies a series card and its episodes onto one key', () => {
        // Series card: seriesInternalId is undefined; identity comes from its
        // own internal id. Episode: carries the same id as seriesInternalId.
        const seriesCard = trailKeyForMedia({ internal: 'S7' }, 'tv');
        const episode = trailKeyForMedia({ internal: 'ep21' }, 'episode', 'S7');
        expect(seriesCard).toBe(episode);
    });

    it('keys a season on its parent series', () => {
        expect(trailKeyForMedia({ internal: 'seasonZ' }, 'season', 'S1')).toBe('series:S1');
    });

    it('keys a movie on its own media identity', () => {
        const key = trailKeyForMedia({ tmdb: '550' }, 'movie');
        expect(key).toBeTruthy();
        expect(key?.startsWith('media:')).toBe(true);
    });

    it('gives different movies different keys', () => {
        expect(trailKeyForMedia({ tmdb: '550' }, 'movie')).not.toBe(
            trailKeyForMedia({ tmdb: '551' }, 'movie'),
        );
    });

    it('returns null when nothing identifies the media', () => {
        expect(trailKeyForMedia({}, 'movie')).toBeNull();
    });
});

describe('search context transport', () => {
    it('passes the matching title through explicit modal props', () => {
        openMediaModal({
            title: 'The Worst Witch',
            matchedTitle: 'Eine lausige Hexe',
            mediaType: 'tv',
            externalIds: { internal: '11111111-1111-4111-8111-111111111111' },
        });
        expect(vi.mocked(modals.openEntity).mock.calls.at(-1)?.[1]).toMatchObject({
            title: 'The Worst Witch',
            matchedTitle: 'Eine lausige Hexe',
        });
    });

    it.each(['movie', 'series'] as const)(
        'keeps the parsed %s search title through cards, dispatch and explicit modal props',
        (type) => {
            vi.clearAllMocks();
            const source = V1SearchResultItemSchema.parse({
                id: '11111111-1111-4111-8111-111111111111',
                type,
                title: 'The Worst Witch',
                matchedTitle: 'Eine lausige Hexe',
                ids: { internal: '11111111-1111-4111-8111-111111111111' },
                images: {},
                score: 1,
            });
            const card = transformSearchItem(
                {
                    ...source,
                    catalogId: '11111111-1111-4111-8111-111111111111',
                    images: {},
                    availability: { isAvailable: true, canRequest: false },
                },
                'lausige',
            );
            expect(card.title).toBe('The Worst Witch');
            expect(card.subtitle).toBe('Eine lausige Hexe');
            getItemOpenHandler(card.clickData?.mediaType as string)(card, {
                closeSearch: vi.fn(),
            });
            expect(modals.openEntity).toHaveBeenCalledTimes(1);
            expect(vi.mocked(modals.openEntity).mock.calls[0][1]).toMatchObject({
                title: 'The Worst Witch',
                matchedTitle: 'Eine lausige Hexe',
            });
        },
    );
});
