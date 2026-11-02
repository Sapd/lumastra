// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/** A failed load is not an empty album, and runtimes render as durations. */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getAdminTracks = vi.hoisted(() => vi.fn());
const readArtistTracks = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/music-credits.js', () => ({ readArtistTracks }));
vi.mock('$lib/api/admin', () => ({ getAdminTracks }));
vi.mock('$app/state', async () => await import('./__fixtures__/music-page-state.svelte.js'));
const replaceState = vi.hoisted(() => vi.fn());
vi.mock('$app/navigation', () => ({ goto: vi.fn(), pushState: vi.fn(), replaceState }));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { error: vi.fn(), success: vi.fn() } }));

import { setMusicShallowUrl, setMusicUrl } from './__fixtures__/music-page-state.svelte.js';
import TracksTab from './TracksTab.svelte';

beforeEach(() => {
    setMusicUrl('/admin/library/media/album-1?tab=tracks');
    setMusicShallowUrl(null);
});
afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe('TracksTab', () => {
    it('shows a failed load as an error with retry, not as "No tracks found."', async () => {
        getAdminTracks.mockResolvedValue({ data: undefined, error: 'Internal server error' });
        render(TracksTab, { props: { albumId: 'album-1' } });

        expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
        expect(screen.queryByText('No tracks found.')).toBeNull();
    });

    it('rounds fractional runtimes and shows hours for long tracks', async () => {
        const row = {
            sort_order: 1,
            custom_metadata: null,
            has_lyrics: false,
            file_path: '/music/a.flac',
        };
        getAdminTracks.mockResolvedValue({
            data: [
                { ...row, id: 't1', title: 'Short', runtime_seconds: 187.4 },
                { ...row, id: 't2', title: 'Mix', runtime_seconds: 5703 },
            ],
            error: undefined,
        });
        render(TracksTab, { props: { albumId: 'album-1' } });

        expect(await screen.findByText('3:07')).toBeTruthy();
        expect(screen.getByText('1:35:03')).toBeTruthy();
    });
});

it('fetches artist filters across the complete catalog, bounds rendering and returns through artist context', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const album = '22222222-2222-4222-8222-222222222222';
    const row = {
        id: '33333333-3333-4333-8333-333333333333',
        title: 'Guest song',
        sort_order: 1,
        runtime_seconds: 60,
        custom_metadata: null,
        has_lyrics: true,
        file_path: '/fictional/song.mp3',
        album_id: album,
        album_title: 'Another owner album',
    };
    readArtistTracks
        .mockResolvedValueOnce({
            data: {
                tracks: [row],
                total: 196,
                catalogTotal: 196,
                durationSeconds: 11760,
                page: 1,
                pageSize: 50,
            },
        })
        .mockResolvedValue({
            data: {
                tracks: [row],
                total: 1,
                catalogTotal: 196,
                durationSeconds: 11760,
                page: 1,
                pageSize: 50,
            },
        });
    render(TracksTab, { albumId: id, kind: 'artist' });
    const track = await screen.findByRole('link', { name: 'Guest song' });
    expect(track.getAttribute('href')).toContain(`music_from_artist_tracks=${id}`);
    expect(await screen.findByRole('link', { name: 'Another owner album' })).toBeTruthy();
    expect(screen.getByText(/catalog duration/).textContent).toContain('196');
    await fireEvent.input(screen.getByRole('searchbox', { name: 'Find a track' }), {
        target: { value: 'Guest' },
    });
    await waitFor(() =>
        expect(readArtistTracks).toHaveBeenLastCalledWith(id, {
            q: 'Guest',
            issue: 'all',
            sort: 'album',
            page: '1',
        }),
    );
    const reviewCredits = screen.getByRole('link', { name: 'Review track credits' });
    const reviewUrl = new URL(reviewCredits.getAttribute('href')!, 'https://example.invalid');
    expect(reviewUrl.pathname).toContain(row.id);
    expect(reviewUrl.searchParams.get('tab')).toBe('overview');
    expect(reviewUrl.searchParams.get('music_from_artist_tracks')).toBe(id);
    expect(reviewUrl.searchParams.get('tracks_q')).toBe('Guest');
    expect(reviewUrl.searchParams.get('tracks_page')).toBe('1');
    expect(reviewUrl.hash).toBe('#artist-credits');
    expect(getAdminTracks).not.toHaveBeenCalled();
});

it('clamps and refetches a retained artist page when an asynchronous catalog result shrinks', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const row = {
        id: '33333333-3333-4333-8333-333333333333',
        title: 'Remaining guest',
        sort_order: 1,
        runtime_seconds: 60,
        custom_metadata: null,
        has_lyrics: true,
        file_path: '/fictional/song.mp3',
        album_id: null,
        album_title: null,
    };
    let finish!: (value: unknown) => void;
    readArtistTracks
        .mockReset()
        .mockResolvedValueOnce({
            data: {
                tracks: [row],
                total: 61,
                catalogTotal: 61,
                durationSeconds: 3660,
                page: 1,
                pageSize: 50,
            },
        })
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        )
        .mockResolvedValue({
            data: {
                tracks: [row],
                total: 50,
                catalogTotal: 50,
                durationSeconds: 3000,
                page: 1,
                pageSize: 50,
            },
        });
    render(TracksTab, { albumId: id, kind: 'artist' });
    await screen.findByRole('link', { name: 'Remaining guest' });
    await fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(readArtistTracks).toHaveBeenCalledTimes(2));
    expect(readArtistTracks.mock.calls[1][1].page).toBe('2');
    finish({
        data: {
            tracks: [],
            total: 50,
            catalogTotal: 50,
            durationSeconds: 3000,
            page: 2,
            pageSize: 50,
        },
    });
    await waitFor(() => expect(readArtistTracks).toHaveBeenCalledTimes(3));
    expect(readArtistTracks.mock.calls[2][1]).toEqual({
        q: '',
        issue: 'all',
        sort: 'album',
        page: '1',
    });
    await screen.findByRole('link', { name: 'Remaining guest' });
    expect(screen.queryByText('No tracks match your filters.')).toBeNull();
    const target = replaceState.mock.calls.at(-1)?.[0] as URL;
    expect(target.searchParams.get('tracks_page')).toBe('1');
});

it('advances to distinct artist page2 rows and preserves page2 in review links', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const row = {
        id: '33333333-3333-4333-8333-333333333333',
        title: 'First page song',
        sort_order: 1,
        runtime_seconds: 60,
        custom_metadata: null,
        has_lyrics: true,
        file_path: '/fictional/song.mp3',
        album_id: null,
        album_title: null,
    };
    readArtistTracks
        .mockReset()
        .mockResolvedValueOnce({
            data: {
                tracks: [row],
                total: 61,
                catalogTotal: 61,
                durationSeconds: 3660,
                page: 1,
                pageSize: 50,
            },
        })
        .mockResolvedValueOnce({
            data: {
                tracks: [
                    {
                        ...row,
                        id: '44444444-4444-4444-8444-444444444444',
                        title: 'Second page song',
                    },
                ],
                total: 61,
                catalogTotal: 61,
                durationSeconds: 3660,
                page: 2,
                pageSize: 50,
            },
        });
    render(TracksTab, { albumId: id, kind: 'artist' });
    await screen.findByRole('link', { name: 'First page song' });
    await fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    const link = await screen.findByRole('link', { name: 'Second page song' });
    expect(screen.queryByRole('link', { name: 'First page song' })).toBeNull();
    expect(link.getAttribute('href')).toContain('tracks_page=2');
    expect(link.getAttribute('href')).toContain(`music_from_artist_tracks=${id}`);
    expect(screen.getByText('Page 2 of 2')).toBeTruthy();
});

it('restores artist filters from the same-path shallow URL when the rendered page URL is unfiltered', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const row = {
        id: '33333333-3333-4333-8333-333333333333',
        title: 'Shallow Guest Song',
        sort_order: 7,
        runtime_seconds: 60,
        custom_metadata: null,
        has_lyrics: false,
        file_path: null,
        album_id: null,
        album_title: null,
    };
    setMusicUrl(`/admin/library/media/${id}?tab=tracks`);
    setMusicShallowUrl(
        `/admin/library/media/${id}?tab=tracks&tracks_q=Shallow+Guest&tracks_issue=missing-file&tracks_sort=title&tracks_page=2`,
    );
    readArtistTracks.mockReset().mockResolvedValue({
        data: {
            tracks: [row],
            total: 61,
            catalogTotal: 61,
            durationSeconds: 3660,
            page: 2,
            pageSize: 50,
        },
    });

    render(TracksTab, { albumId: id, kind: 'artist' });

    expect(await screen.findByRole('link', { name: 'Shallow Guest Song' })).toBeTruthy();
    expect(
        (screen.getByRole('searchbox', { name: 'Find a track' }) as HTMLInputElement).value,
    ).toBe('Shallow Guest');
    expect(
        (screen.getByRole('combobox', { name: 'Track issues' }) as HTMLSelectElement).value,
    ).toBe('missing-file');
    expect((screen.getByRole('combobox', { name: 'Track order' }) as HTMLSelectElement).value).toBe(
        'title',
    );
    await waitFor(() =>
        expect(readArtistTracks).toHaveBeenCalledWith(id, {
            q: 'Shallow Guest',
            issue: 'missing-file',
            sort: 'title',
            page: '2',
        }),
    );

    const review = screen.getByRole('link', { name: 'Review track credits' });
    const href = new URL(review.getAttribute('href')!, 'http://localhost');
    expect(href.searchParams.get('tracks_q')).toBe('Shallow Guest');
    expect(href.searchParams.get('tracks_issue')).toBe('missing-file');
    expect(href.searchParams.get('tracks_sort')).toBe('title');
    expect(href.searchParams.get('tracks_page')).toBe('2');

    await fireEvent.input(screen.getByRole('searchbox', { name: 'Find a track' }), {
        target: { value: 'Shallow Guest Song' },
    });
    const replaced = replaceState.mock.calls.at(-1)?.[0] as URL;
    expect(replaced.searchParams.get('tracks_q')).toBe('Shallow Guest Song');
    expect(replaced.searchParams.get('tracks_issue')).toBe('missing-file');
    expect(replaced.searchParams.get('tracks_sort')).toBe('title');
    expect(replaced.searchParams.get('tracks_page')).toBe('1');
});
