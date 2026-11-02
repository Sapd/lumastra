// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the search item-open dispatch map.
 *
 * Regression guard: music results carry a per-item mediaType of
 * 'album' | 'artist' | 'track' (NOT 'music'/'audio'). Before the fix they had
 * no dispatch entry and fell through to handleDefaultOpen → openMediaModal,
 * which always opens ModalMovie. These tests assert each music type routes to
 * its own modal and NEVER to the movie modal.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchResponseSchema, type SearchResultItem } from '$lib/api/content';

const openMediaModal = vi.fn();
const openAlbumModal = vi.fn();
const openArtistModal = vi.fn();
const openAlbumForTrack = vi.fn();
const { playAudiobook } = vi.hoisted(() => ({
    playAudiobook: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('$lib/utils/modal-utils', () => ({
    openMediaModal: (...a: unknown[]) => openMediaModal(...a),
    openAlbumModal: (...a: unknown[]) => openAlbumModal(...a),
    openArtistModal: (...a: unknown[]) => openArtistModal(...a),
    openAlbumForTrack: (...a: unknown[]) => openAlbumForTrack(...a),
}));
vi.mock('$lib/stores/playerNavigation', () => ({ saveReturnPath: vi.fn() }));
vi.mock('$lib/paths', () => ({ navigateTo: vi.fn() }));
vi.mock('$lib/utils/search/media-external-links', () => ({
    openKavitaItem: vi.fn(),
    kavitaSeriesUrl: (seriesId?: string | null, libraryId?: number | null) =>
        seriesId ? `https://kavita.example/library/${libraryId ?? 1}/series/${seriesId}` : null,
}));
vi.mock('$lib/services/audiobook-playback', () => ({
    playAudiobook,
    audiobookStartFailureMessage: () => 'Could not start this book',
}));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { error: vi.fn() },
}));

import { getItemOpenHandler } from './item-open-handlers';
import { transformSearchItem } from './transformers';

function makeItem(overrides: Partial<SearchResultItem> = {}): SearchResultItem {
    return {
        id: 'uuid-self',
        catalogId: 'uuid-self',
        title: 'Test',
        type: 'movie',
        ids: {},
        images: {},
        score: 0,
        ...overrides,
    };
}

const helpers = { closeSearch: vi.fn() };

const PARSED_CATALOG_ID = '22222222-2222-4222-8222-222222222222';

/** Run a fixture through the client search schema (catalog handles must be real UUIDs). */
function parseSearchItem(raw: SearchResultItem): SearchResultItem {
    return SearchResponseSchema.shape.items.element.parse({
        ...raw,
        id: PARSED_CATALOG_ID,
        catalogId: PARSED_CATALOG_ID,
    });
}

function open(raw: SearchResultItem): void {
    const item = transformSearchItem(raw, '');
    getItemOpenHandler(item.clickData?.mediaType as string)(item, helpers);
}

beforeEach(() => vi.clearAllMocks());

describe('getItemOpenHandler music routing', () => {
    it('album → openAlbumModal with the internal UUID, not the movie modal', () => {
        open(makeItem({ type: 'album', id: 'album-1', catalogId: 'album-1', ids: {} }));
        expect(openAlbumModal).toHaveBeenCalledWith('album-1');
        expect(openMediaModal).not.toHaveBeenCalled();
    });

    it('artist → openArtistModal with the internal UUID, not the movie modal', () => {
        open(makeItem({ type: 'artist', id: 'artist-1', catalogId: 'artist-1', ids: {} }));
        expect(openArtistModal).toHaveBeenCalledWith('artist-1');
        expect(openMediaModal).not.toHaveBeenCalled();
    });

    it('track → openAlbumForTrack with the track UUID + parent albumId (scroll target), not the movie modal', () => {
        open(
            makeItem({
                type: 'track',
                id: 'track-1',
                catalogId: 'track-1',
                ids: {},
                albumId: 'album-9',
            }),
        );
        expect(openAlbumForTrack).toHaveBeenCalledTimes(1);
        const [trackId, opts] = openAlbumForTrack.mock.calls[0];
        expect(trackId).toBe('track-1');
        expect(opts.albumId).toBe('album-9');
        expect(openMediaModal).not.toHaveBeenCalled();
    });

    it('movie → still routes to the movie modal (default handler unaffected)', () => {
        open(makeItem({ type: 'movie' }));
        expect(openMediaModal).toHaveBeenCalledTimes(1);
        expect(openAlbumModal).not.toHaveBeenCalled();
    });

    it('book → opens the detail modal with Kavita deep-link data and no externalIds', () => {
        open(
            makeItem({
                type: 'book',
                id: 'kavita-series-42',
                catalogId: null,
                ids: { kavita: '42' },
                libraryId: 3,
                overview: 'A book.',
                author: 'M. K. Fenwick',
                year: 1997,
            }),
        );
        expect(openMediaModal).toHaveBeenCalledTimes(1);
        const [media] = openMediaModal.mock.calls[0] as [Record<string, unknown>];
        expect(media.mediaType).toBe('book');
        expect(media.kavitaSeriesId).toBe('42');
        expect(media.kavitaLibraryId).toBe(3);
        expect(media.author).toBe('M. K. Fenwick');
        expect(media.year).toBe('1997');
        // Kavita ids are not catalog ids — the modal must not receive them as
        // externalIds or its enrichment machinery would chase dead URLs.
        expect(media.externalIds).toBeUndefined();
    });

    it('audiobook → starts the in-app player with the internal catalog id', () => {
        open(
            makeItem({
                type: 'audiobook',
                id: 'book-1',
                catalogId: 'catalog-book-1',
                ids: { audiobookshelf: 'abs-book-1' },
            }),
        );
        expect(playAudiobook).toHaveBeenCalledWith('catalog-book-1');
        expect(openMediaModal).not.toHaveBeenCalled();
    });

    it('tvchannel → navigates to /watch with the channel id from ids.internal (no Jellyfin slot)', async () => {
        const { navigateTo } = await import('$lib/paths');
        open(makeItem({ type: 'tvchannel', id: 'chan-7', catalogId: 'chan-7', ids: {} }));
        expect(navigateTo).toHaveBeenCalledWith('/watch/chan-7');
    });
});

describe('parsed search availability through modal dispatch', () => {
    it.each([
        ['series', false, true],
        ['series', true, false],
        ['movie', true, false],
        ['movie', false, true],
    ] as const)(
        '%s available=%s survives parsing, cards and modal opening',
        (type, available, requestable) => {
            const parsed = parseSearchItem({
                ...makeItem({ type }),
                availability: { isAvailable: available, canRequest: !available },
            });
            const card = transformSearchItem(parsed, '');
            expect(card.isAvailable).toBe(available);
            expect(card.canRequest).toBe(requestable);
            getItemOpenHandler(card.clickData?.mediaType as string)(card, helpers);
            expect(openMediaModal).toHaveBeenCalledWith(
                expect.objectContaining({ isAvailable: available, canRequest: requestable }),
                expect.any(String),
            );
            if (!available)
                expect(openMediaModal.mock.calls[0][0].availabilitySource).toBeUndefined();
        },
    );

    it.each(['artist', 'request', 'tvchannel', 'book'] as const)(
        '%s without availability parses and keeps its dedicated handler',
        (type) => {
            const parsed = parseSearchItem(makeItem({ type }));
            const card = transformSearchItem(parsed, '');
            expect(card.canRequest).toBe(false);
            expect(getItemOpenHandler(card.clickData?.mediaType as string)).not.toBe(
                getItemOpenHandler('movie'),
            );
        },
    );
});
