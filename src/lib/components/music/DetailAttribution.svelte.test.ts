// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';
import type { ComponentProps } from 'svelte';

import ArtistPage from '../../../routes/music/artists/[id]/+page.svelte';
import AlbumPage from '../../../routes/music/albums/[id]/+page.svelte';

type ArtistPageData = ComponentProps<typeof ArtistPage>['data'];
type AlbumPageData = ComponentProps<typeof AlbumPage>['data'];
// Root layout data is supplied by the mocked page store; validate the page-owned fields.

vi.mock('$app/stores', () => ({
    page: writable({ data: {}, route: { id: '/music' }, url: new URL('https://example.test/music') }),
}));
vi.mock('$lib/stores/music-player.store', () => ({ musicPlayerStore: {} }));
vi.mock('$lib/utils/modal-utils', () => ({ openAlbumModal: vi.fn(), openArtistModal: vi.fn() }));
afterEach(cleanup);

it('renders the artist biography and photo credits beside displayed content', () => {
    render(ArtistPage, { data: {
        artist: {
            id: 'artist', type: 'artist', title: 'Artist', biography: 'Discogs biography',
            genres: ['Rock'], countryCode: null, albumCount: 0, trackCount: 0,
            addedAt: null, isVariousArtists: false,
            images: { primary: { href: '/photo', source: 'self', revision: '1' } },
            discogsAttribution: {
                biography: 'https://www.discogs.com/artist/42',
                poster: 'https://www.discogs.com/artist/42',
            },
        }, albums: [],
    } satisfies Pick<ArtistPageData, 'artist' | 'albums'> as unknown as ArtistPageData });
    const credits = screen.getAllByRole('link', { name: 'Data provided by Discogs' });
    expect(credits).toHaveLength(2);
    expect(credits.every((a) => a.getAttribute('href') === 'https://www.discogs.com/artist/42')).toBe(true);
    expect(credits.every((a) => !a.getAttribute('rel')?.includes('nofollow'))).toBe(true);
    expect(credits[1].parentElement?.parentElement?.textContent).toContain('Discogs biography');
});

it('renders album metadata and artwork credits with the exact release URL', () => {
    render(AlbumPage, { data: {
        album: {
            id: 'album', type: 'album', title: 'Album', artist: { id: null, title: 'Artist' },
            year: 2000, trackCount: 0, durationMs: null, addedAt: null,
            overview: 'Release notes', genres: ['Rock'],
            images: { primary: { href: '/cover', source: 'self', revision: '1' } },
            discogsAttribution: {
                overview: 'https://www.discogs.com/release/42',
                poster: 'https://www.discogs.com/release/42',
            },
        }, tracks: [],
    } satisfies Pick<AlbumPageData, 'album' | 'tracks'> as unknown as AlbumPageData });
    const credits = screen.getAllByRole('link', { name: 'Data provided by Discogs' });
    expect(credits).toHaveLength(2);
    expect(credits.every((a) => a.getAttribute('href') === 'https://www.discogs.com/release/42')).toBe(true);
    expect(credits[1].parentElement?.parentElement?.textContent).toContain('Release notes');
});
