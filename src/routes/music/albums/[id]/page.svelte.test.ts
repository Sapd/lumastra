// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { writable } from 'svelte/store';
import { afterEach, expect, it, vi } from 'vitest';
import { buildImageSet } from '$lib/shared/image-descriptor';
import AlbumPage from './+page.svelte';
import { musicPlayerStore } from '$lib/stores/music-player.store';
import type { PageData } from './$types';
vi.mock('$app/stores', () => ({
    page: writable({
        route: { id: '/music/albums/[id]' },
        url: new URL('https://example.test/music/albums/album'),
        data: {},
    }),
}));
vi.mock('$lib/stores/music-player.store', () => ({
    musicPlayerStore: { enqueueFromBrew: vi.fn(), seedAutoplay: vi.fn() },
}));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { info: vi.fn(), error: vi.fn() } }));
vi.mock('$lib/utils/modal-utils', () => ({ openArtistModal: vi.fn() }));
vi.mock('$lib/utils/image-utils', () => ({ getCatalogPosterUrl: (id: string) => `/image/${id}` }));
vi.mock('$lib/paths', () => ({ resolve: (path: string) => `/base${path}` }));
afterEach(cleanup);
function albumData(id = 'album'): PageData {
    return {
        album: {
            id,
            type: 'album',
            title: 'Album',
            artist: { id: 'artist', title: 'Artist' },
            images: buildImageSet('internal', { primary: { ownerId: id, urlRole: 'poster' } }),
            year: null,
            overview: null,
            genres: [],
            trackCount: 0,
            durationMs: null,
            addedAt: null,
        },
        tracks: [],
    } as unknown as PageData;
}

it('renders public artwork refs and accepts a replacement album', async () => {
    const { rerender } = render(AlbumPage, { data: albumData() });
    expect(screen.getByRole('img', { name: 'Album' })).toBeTruthy();
    await rerender({ data: albumData('replacement') });
    expect(screen.getByRole('img', { name: 'Album' }).getAttribute('src')).toContain('replacement');
});

it('renders one primary navigation row and the contextual Albums return', () => {
    const { container } = render(AlbumPage, { data: albumData() });
    expect(container.querySelectorAll('nav')).toHaveLength(1);
    for (const name of ['Home', 'Explore', 'Library', 'Search'])
        expect(screen.getByRole('link', { name })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Library' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Albums' }).getAttribute('href')).toBe(
        '/base/music/albums',
    );
});

it('renders a compilation from its public artist reference', async () => {
    const data = albumData();
    data.album.artist.title = 'Various Artists';
    render(AlbumPage, { data });
    expect(screen.getByText('Various Artists')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Data provided by Discogs' })).toBeNull();
});

it('handles failed artwork and resets for a different album', async () => {
    const { rerender } = render(AlbumPage, { data: albumData() });
    await fireEvent.error(screen.getByRole('img', { name: 'Album' }));
    await rerender({ data: albumData('different-album') });
    expect(screen.getByRole('img', { name: 'Album' })).toBeTruthy();
});

it('groups discs, restarts fallback numbering, and plays from the full-list index', async () => {
    const data = albumData();
    data.tracks = [1, 1, 2, 2].map((discNumber, index) => ({
        id: `track-${index}`,
        type: 'track',
        title: `Invented Song ${index}`,
        artists: [{ id: 'artist', title: 'Artist' }],
        discNumber,
    })) as PageData['tracks'];
    render(AlbumPage, { data });
    expect(screen.getByRole('heading', { name: 'Disc 1' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Disc 2' })).toBeTruthy();
    const row = screen.getByRole('button', { name: /Invented Song 2/ });
    expect(row.querySelector('span')?.textContent?.trim()).toBe('1');
    await fireEvent.click(row);
    expect(musicPlayerStore.enqueueFromBrew).toHaveBeenLastCalledWith(
        data.tracks.slice(2),
        true,
        expect.any(Object),
    );
});

it('omits disc headings for a single disc', () => {
    const data = albumData();
    data.tracks = [
        {
            id: 'track-one',
            type: 'track',
            title: 'Only Song',
            artists: [{ id: 'artist', title: 'Artist' }],
            discNumber: 2,
        },
    ] as PageData['tracks'];
    render(AlbumPage, { data });
    expect(screen.queryByRole('heading', { name: /Disc/ })).toBeNull();
});
