// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const getAdminTracks = vi.hoisted(() => vi.fn());
const getAdminAlbums = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/admin', () => ({ getAdminTracks, getAdminAlbums }));
vi.mock('$app/state', async () => await import('./__fixtures__/music-page-state.svelte.js'));
vi.mock('$app/navigation', () => ({ replaceState: vi.fn() }));
import { setMusicUrl } from './__fixtures__/music-page-state.svelte.js';
import TracksTab from './TracksTab.svelte';
import DiscographyTab from './DiscographyTab.svelte';

beforeEach(() => {
    setMusicUrl('/admin/library/media/album-1?tab=tracks');
});
afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});
function track(id: string, title: string, number: number | null) {
    return {
        id,
        title,
        sort_order: number,
        runtime_seconds: 180,
        custom_metadata: { disc_number: 1 },
        has_lyrics: false,
        file_path: '/fictional/track.flac',
    };
}
describe('music workspaces', () => {
    it('finds one track in a 196-track collection and retains the workspace in edit and tool links', async () => {
        const rows = Array.from({ length: 196 }, (_, index) =>
            track(
                `track-${index}`,
                index === 195 ? 'Target Lantern' : `Harbor track ${index}`,
                index + 1,
            ),
        );
        getAdminTracks.mockResolvedValue({ data: rows });
        render(TracksTab, { props: { albumId: 'album-1' } });
        expect(await screen.findByRole('link', { name: 'Harbor track 0' })).toBeTruthy();
        await fireEvent.input(screen.getByRole('searchbox', { name: 'Find a track' }), {
            target: { value: 'Target Lantern' },
        });
        await waitFor(() =>
            expect(screen.queryByRole('link', { name: 'Harbor track 0' })).toBeNull(),
        );
        const edit = screen.getByRole('link', { name: 'Edit metadata' });
        const url = new URL(edit.getAttribute('href')!, 'http://localhost');
        expect(url.searchParams.get('tracks_q')).toBe('Target Lantern');
        expect(url.searchParams.get('music_from_album')).toBe('album-1');
        expect(url.searchParams.get('edit')).toBe('1');
        expect(screen.getByRole('link', { name: 'Lyrics' }).getAttribute('href')).toContain(
            'tab=lyrics',
        );
        expect(screen.getByRole('link', { name: 'Files' }).getAttribute('href')).toContain(
            'tab=files',
        );
        expect(getAdminTracks).toHaveBeenCalledTimes(1);
    });
    it('distinguishes search with no results from an empty collection and preserves album order', async () => {
        getAdminTracks.mockResolvedValue({
            data: [track('z', 'Zulu', null), track('a', 'Alpha', 2)],
        });
        render(TracksTab, { props: { albumId: 'album-1' } });
        expect(await screen.findByRole('link', { name: 'Zulu' })).toBeTruthy();
        expect(screen.getByText(/Some tracks have no order number/)).toBeTruthy();
        const links = screen
            .getAllByRole('link')
            .filter((link) => ['Zulu', 'Alpha'].includes(link.textContent ?? ''));
        expect(links.map((link) => link.textContent)).toEqual(['Zulu', 'Alpha']);
        await fireEvent.input(screen.getByRole('searchbox', { name: 'Find a track' }), {
            target: { value: 'Not present' },
        });
        expect(await screen.findByText('No tracks match these filters.')).toBeTruthy();
        expect(screen.queryByText('No tracks found.')).toBeNull();
    });
    it('does not let a stale album response overwrite the next album', async () => {
        let finish: ((value: { data: ReturnType<typeof track>[] }) => void) | undefined;
        getAdminTracks.mockImplementation((id: string) =>
            id === 'old'
                ? new Promise<{ data: ReturnType<typeof track>[] }>((resolve) => {
                      finish = resolve;
                  })
                : Promise.resolve({ data: [track('new', 'New Album Track', 1)] }),
        );
        const view = render(TracksTab, { props: { albumId: 'old' } });
        await waitFor(() => expect(getAdminTracks).toHaveBeenCalledWith('old'));
        await view.rerender({ albumId: 'next' });
        expect(await screen.findByRole('link', { name: 'New Album Track' })).toBeTruthy();
        finish?.({ data: [track('old', 'Stale Album Track', 1)] });
        await Promise.resolve();
        expect(screen.queryByText('Stale Album Track')).toBeNull();
    });
    it('finds an album through a real accessible link and exposes direct edit and tracks actions', async () => {
        setMusicUrl('/admin/library/media/artist-1?tab=discography');
        getAdminAlbums.mockResolvedValue({
            data: [
                {
                    id: 'album-1',
                    title: 'Lantern Collection',
                    year: 2026,
                    custom_poster_url: null,
                    track_count: 196,
                    total_duration_seconds: 3600,
                    album_type: 'album',
                    sort_order: null,
                },
            ],
        });
        render(DiscographyTab, { props: { artistId: 'artist-1' } });
        expect(await screen.findByRole('link', { name: 'Lantern Collection' })).toBeTruthy();
        await fireEvent.input(screen.getByRole('searchbox', { name: 'Find an album' }), {
            target: { value: 'Lantern' },
        });
        const href = screen.getByRole('link', { name: 'Tracks' }).getAttribute('href')!;
        expect(href).toContain('music_from_artist=artist-1');
        expect(href).toContain('albums_q=Lantern');
        expect(href).toContain('tab=tracks');
    });
});

it('bounds rendered tracks to 50, carries the page in links, and resets it when finding a track', async () => {
    getAdminTracks.mockResolvedValue({
        data: Array.from({ length: 196 }, (_, n) => track(`t-${n}`, `Lantern ${n}`, n + 1)),
    });
    render(TracksTab, { albumId: 'album-1' });
    await screen.findByRole('link', { name: 'Lantern 0' });
    expect(screen.getAllByRole('listitem')).toHaveLength(50);
    await fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByRole('link', { name: 'Lantern 50' }).getAttribute('href')).toContain(
        'tracks_page=2',
    );
    expect(screen.queryByRole('link', { name: 'Lantern 0' })).toBeNull();
    await fireEvent.input(screen.getByRole('searchbox', { name: 'Find a track' }), {
        target: { value: 'Lantern 195' },
    });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Lantern 195' }).getAttribute('href')).toContain(
        'tracks_page=1',
    );
});
