// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

// Real compiled paraglide messages are used (they are pure functions that
// default to the base locale), so assertions below use the English copy.

// Heavy / browser-touching deps the filter behaviour does not depend on.
// The track rows read `$musicPlayerStore.showBpm` / `.showLoudnessDb`
// reactively, so the mock must be store-SHAPED as well as method-shaped: a
// bare object of vi.fn()s throws `store_invalid_shape` during render, which
// aborts before onMount ever resolves getAlbum — leaving the modal stuck on
// its spinner and every query below failing with a misleading "can't find
// the text" rather than the real error. Defaults mirror the real store
// (showBpm: true, showLoudnessDb: false).
vi.mock('$lib/stores/music-player.store', async () => {
    const { readable } = await import('svelte/store');
    return {
        musicPlayerStore: {
            ...readable({ showBpm: true, showLoudnessDb: false }),
            startPlayback: vi.fn(),
            enqueueFromBrew: vi.fn(),
            addToQueue: vi.fn(),
            setPlaybackContext: vi.fn(),
        },
    };
});
vi.mock('$lib/stores/modal.store', () => ({
    modals: { updateProps: vi.fn(), close: vi.fn() },
}));
vi.mock('$lib/utils/modal-utils', () => ({
    openArtistModal: vi.fn(),
    openAlbumModal: vi.fn(),
}));
vi.mock('$lib/components/music/MusicEntityHoverCard.svelte', () => ({ default: vi.fn() }));
vi.mock('$lib/components/music/PopularityBadge.svelte', () => ({ default: vi.fn() }));
vi.mock('$lib/components/ui/Tooltip.svelte', () => ({ default: vi.fn() }));
vi.mock('$lib/components/ui/ContextMenu.svelte', () => ({ default: vi.fn() }));
vi.mock('$lib/utils/swipe-to-close', () => ({ swipeToClose: () => ({ destroy() {} }) }));
vi.mock('$lib/utils/image-utils', () => ({
    getCatalogPosterUrl: vi.fn(() => 'https://example.com/art.jpg'),
}));
vi.mock('$lib/utils/music-track-metadata', () => ({ parseMusicChapters: vi.fn(() => undefined) }));

const getAlbumMock = vi.fn();
const getArtistMock = vi.fn();
vi.mock('$lib/api/music', () => ({
    getAlbum: (id: string) => getAlbumMock(id),
    getArtist: (id: string) => getArtistMock(id),
    getSimilarArtists: vi.fn(async () => ({ data: { items: [] }, error: null })),
    getAlbumSeries: vi.fn(async () => ({ data: { albums: [] }, error: null })),
    getSimilarAlbums: vi.fn(async () => ({ data: null, error: null })),
}));

import { musicTrackFromCard } from '$lib/utils/music-track';
import { musicImagesFixture } from '$lib/server/services/music/__tests__/image-fixtures.js';
import { toAlbum, toArtist } from '$lib/server/services/music/track-projection';
import AlbumModal from './AlbumModal.svelte';
import ArtistModal from './ArtistModal.svelte';
import {
    MusicAlbumDetailResponseSchema,
    MusicArtistDetailResponseSchema,
} from '$lib/schemas/api-music-responses';

interface TrackSeed {
    id: string;
    title: string;
    artist?: string;
    sort_order?: number;
}

function mkTrack(seed: TrackSeed) {
    return musicTrackFromCard({
        id: seed.id,
        title: seed.title,
        artists: [{ id: null, title: seed.artist ?? 'Unknown Artist' }],
        album: { id: 'album-1', title: 'Test Album' },
        trackNumber: seed.sort_order ?? null,
        durationMs: 180000,
    });
}

function mkAlbumResponse(tracks: ReturnType<typeof mkTrack>[]) {
    return {
        data: {
            ...toAlbum(
                {
                    id: 'album-1',
                    custom_poster_url: '/album.jpg',
                    title: 'Test Album',
                    artist_title: 'Various Artists',
                    year: 2026,
                    track_count: tracks.length,
                    total_duration: tracks.length * 180,
                },
                musicImagesFixture('album-1', 'internal'),
            ),
            tracks,
        },
        error: null,
    };
}

function seededTracks(n: number) {
    return Array.from({ length: n }, (_v, i) =>
        mkTrack({
            id: `t${i}`,
            title: `Song ${i}`,
            artist: i % 2 === 0 ? 'Picco' : 'Megalanterns',
            sort_order: i + 1,
        }),
    );
}

afterEach(() => {
    cleanup();
    getAlbumMock.mockReset();
    getArtistMock.mockReset();
});

describe('AlbumModal track filter', () => {
    test('filter box is hidden on small albums (< 15 tracks)', async () => {
        getAlbumMock.mockResolvedValue(mkAlbumResponse(seededTracks(5)));
        const { findByText, queryByPlaceholderText } = render(AlbumModal, {
            albumId: 'album-1',
            modalId: 'modal-1',
        });
        // Wait until the async load has rendered the track list.
        await findByText('Song 0');
        expect(queryByPlaceholderText('Filter tracks or artists')).toBeNull();
    });

    test('filter box appears on large albums (>= 15 tracks)', async () => {
        getAlbumMock.mockResolvedValue(mkAlbumResponse(seededTracks(20)));
        const { findByPlaceholderText } = render(AlbumModal, {
            albumId: 'album-1',
            modalId: 'modal-1',
        });
        expect(await findByPlaceholderText('Filter tracks or artists')).toBeTruthy();
    });

    test('typing a title hides non-matching rows', async () => {
        getAlbumMock.mockResolvedValue(mkAlbumResponse(seededTracks(20)));
        const { findByPlaceholderText, queryByText } = render(AlbumModal, {
            albumId: 'album-1',
            modalId: 'modal-1',
        });
        const input = await findByPlaceholderText('Filter tracks or artists');
        expect(queryByText('Song 3')).toBeTruthy();

        await fireEvent.input(input, { target: { value: 'Song 1' } });

        // "Song 1", "Song 10".."Song 19" match; "Song 3" does not.
        expect(queryByText('Song 3')).toBeNull();
        expect(queryByText('Song 1')).toBeTruthy();
    });

    test('filters by artist name, not just title', async () => {
        getAlbumMock.mockResolvedValue(mkAlbumResponse(seededTracks(20)));
        const { findByPlaceholderText, queryByText } = render(AlbumModal, {
            albumId: 'album-1',
            modalId: 'modal-1',
        });
        const input = await findByPlaceholderText('Filter tracks or artists');

        await fireEvent.input(input, { target: { value: 'Picco' } });

        // Even-index tracks are Picco; Song 1 (Megalanterns) should be hidden.
        expect(queryByText('Song 0')).toBeTruthy();
        expect(queryByText('Song 1')).toBeNull();
    });

    test('shows a no-matches message when nothing matches', async () => {
        getAlbumMock.mockResolvedValue(mkAlbumResponse(seededTracks(20)));
        const { findByPlaceholderText, queryByText } = render(AlbumModal, {
            albumId: 'album-1',
            modalId: 'modal-1',
        });
        const input = await findByPlaceholderText('Filter tracks or artists');

        await fireEvent.input(input, { target: { value: 'zzzznope' } });

        expect(queryByText('Song 0')).toBeNull();
        expect(queryByText(/No tracks match/)).toBeTruthy();
    });
});

test('album Play prepares the whole ordered queue in one operation', async () => {
    const { musicPlayerStore } = await import('$lib/stores/music-player.store');
    vi.mocked(musicPlayerStore.enqueueFromBrew).mockClear();
    getAlbumMock.mockResolvedValue(
        mkAlbumResponse([
            mkTrack({ id: 'first', title: 'First song', sort_order: 1 }),
            mkTrack({ id: 'second', title: 'Second song', sort_order: 2 }),
        ]),
    );
    const view = render(AlbumModal, { albumId: 'album-1', modalId: 'album-modal' });
    await view.findByText('First song');
    await fireEvent.click(view.getByRole('button', { name: 'Play All' }));
    expect(musicPlayerStore.enqueueFromBrew).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'first' }), expect.objectContaining({ id: 'second' })],
        true,
        expect.objectContaining({ type: 'album', name: 'Test Album', trackCount: 1 }),
    );
});

describe('modals consume public detail DTOs', () => {
    test.each([false, true])(
        'album artwork uses the public image refs (replacement %s)',
        async (overridden) => {
            const response = mkAlbumResponse([]);
            response.data.images.primary = {
                href: overridden ? '/uploaded' : '/image',
                revision: '1',
                source: 'self',
            };
            getAlbumMock.mockResolvedValue({
                data: MusicAlbumDetailResponseSchema.parse(response.data),
                error: null,
            });
            const { findByText, queryByRole } = render(AlbumModal, {
                albumId: 'album-1',
                modalId: 'modal-1',
            });
            await findByText('Test Album');
            expect(queryByRole('link', { name: 'Data provided by Discogs' })).toBeNull();
        },
    );
    test.each([null, '', 42, 'curated biography'])(
        'artist renders the projected biography with curated value %s',
        async (curated) => {
            const artist = toArtist(
                {
                    id: 'artist-1',
                    title: 'Test Artist',
                    custom_metadata: {
                        biography: curated,
                        artist_enrichment: { biography: 'enriched biography' },
                    },
                },
                {},
            );
            const parsed = MusicArtistDetailResponseSchema.parse({
                ...artist,
                albums: [],
                tracks: [],
            });
            getArtistMock.mockResolvedValue({ data: parsed, error: null });
            const { findByText, queryByRole } = render(ArtistModal, {
                artistId: 'artist-1',
                modalId: 'modal-1',
            });
            await findByText(curated === 'curated biography' ? curated : 'enriched biography');
            expect(queryByRole('link', { name: 'Data provided by Discogs' })).toBeNull();
        },
    );
});

test('album detail schema retains canonical inheriting artwork refs', async () => {
    const response = mkAlbumResponse([]);
    response.data.artist = { id: 'artist-1', title: 'Artist' };
    const parsed = MusicAlbumDetailResponseSchema.parse(response.data);
    expect(parsed.images.primary?.href).toContain('/api/media/album-1/images/poster');
    getAlbumMock.mockResolvedValue({ data: parsed, error: null });
    const { findByText } = render(AlbumModal, { albumId: 'album-1', modalId: 'modal-1' });
    await findByText('Test Album');
});
