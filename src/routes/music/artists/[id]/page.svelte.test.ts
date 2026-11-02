// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { writable } from 'svelte/store';
import { afterEach, expect, it, vi } from 'vitest';
import { toArtist } from '$lib/server/services/music/track-projection';
import { musicTrackFromCard } from '$lib/utils/music-track';
import ArtistPage from './+page.svelte';
import type { PageData } from './$types';
const mocks = vi.hoisted(() => ({ getArtist: vi.fn(), play: vi.fn(), radio: vi.fn() }));
vi.mock('$app/stores', () => ({
    page: writable({
        route: { id: '/music/artists/[id]' },
        url: new URL('https://example.test/music/artists/artist'),
        data: {},
    }),
}));
vi.mock('$lib/api/music', () => ({ getArtist: mocks.getArtist }));
vi.mock('$lib/stores/music-player.store', () => ({
    musicPlayerStore: { enqueueFromBrew: mocks.play, seedAutoplay: mocks.radio },
}));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { info: vi.fn(), error: vi.fn() } }));
vi.mock('$lib/utils/modal-utils', () => ({ openAlbumModal: vi.fn() }));
vi.mock('$lib/utils/image-utils', () => ({ getCatalogPosterUrl: (id: string) => `/image/${id}` }));
vi.mock('$lib/paths', () => ({ resolve: (path: string) => `/base${path}` }));
afterEach(cleanup);
it('renders one primary navigation row and the contextual Artists return', () => {
    const { container } = render(ArtistPage, {
        data: {
            artist: toArtist({ id: 'artist', title: 'Artist' }, {}),
            albums: [],
        } as unknown as PageData,
    });
    expect(container.querySelectorAll('nav')).toHaveLength(1);
    for (const name of ['Home', 'Explore', 'Library', 'Search'])
        expect(screen.getByRole('link', { name })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Library' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Artists' }).getAttribute('href')).toBe(
        '/base/music/artists',
    );
});

it('shuffles real songs from the artist endpoint instead of queueing album IDs', async () => {
    mocks.getArtist.mockResolvedValue({
        data: {
            tracks: [
                musicTrackFromCard({ id: 'song-one', title: 'First', durationMs: 120000 }),
                musicTrackFromCard({ id: 'song-two', title: 'Second', durationMs: 140000 }),
            ],
        },
    });
    render(ArtistPage, {
        data: {
            artist: toArtist({ id: 'artist', title: 'Artist', track_count: 2 }, {}),
            albums: [],
        } as unknown as PageData, // Partial fixture: this page only reads artist and albums.
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Shuffle songs' }));
    await waitFor(() => expect(mocks.play).toHaveBeenCalledOnce());
    expect(mocks.play.mock.calls[0][0].map((track: { id: string }) => track.id).sort()).toEqual([
        'song-one',
        'song-two',
    ]);
    expect(mocks.play.mock.calls[0][2]).toEqual({ type: 'artist', name: 'Artist', trackCount: 2 });
});

it('shows the flat public biography and updates when the detail changes', async () => {
    const data = {
        artist: toArtist({ id: 'artist', title: 'Artist', overview: 'Discogs biography' }, {}),
        albums: [],
    };
    const { rerender } = render(ArtistPage, { data: data as unknown as PageData });
    expect(screen.getByText('Discogs biography')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Data provided by Discogs' })).toBeNull();
    await rerender({
        data: {
            ...data,
            artist: { ...data.artist, biography: 'My curated biography' },
        } as unknown as PageData,
    });
    expect(screen.getByText('My curated biography')).toBeTruthy();
});
