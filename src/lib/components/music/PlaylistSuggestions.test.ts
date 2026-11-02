// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import PlaylistSuggestions from './PlaylistSuggestions.svelte';
vi.mock('$lib/api/playlists', () => ({ getPlaylistSuggestions: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { error: vi.fn() } }));
afterEach(cleanup);
const suggestions = [{ id: 'track', title: 'Song', artist: 'Artist' }];
it('keeps a failed addition visible and removes it only after a successful retry', async () => {
    const onAdd = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(PlaylistSuggestions, { playlistId: '1', suggestions, onAdd });
    await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Song')).toBeTruthy();
    await fireEvent.click(await screen.findByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.queryByText('Song')).toBeNull());
    expect(onAdd).toHaveBeenCalledTimes(2);
});
it('disables adding to a read-only playlist', () => {
    render(PlaylistSuggestions, { playlistId: '1', suggestions });
    expect(screen.getByRole('button', { name: 'Add' }).hasAttribute('disabled')).toBe(true);
});

it('loads the playlist route and converts durationMs for display', async () => {
    const { getPlaylistSuggestions } = await import('$lib/api/playlists');
    vi.mocked(getPlaylistSuggestions).mockResolvedValue({
        data: {
            items: [
                {
                    id: '550e8400-e29b-41d4-a716-446655440000',
                    title: 'New song',
                    type: 'track',
                    artists: [{ id: null, title: 'Artist' }],
                    albumArtist: null,
                    album: null,
                    trackNumber: null,
                    discNumber: null,
                    genres: [],
                    year: null,
                    isRadio: false,
                    durationMs: 180000,
                    images: {
                        primary: {
                            href: '/art',
                            revision: '0',
                            source: 'self',
                            variants: { thumb: '/art', card: '/art', full: '/art' },
                        },
                    },
                },
            ],
            source: 'sonic',
            page: { limit: 6, truncated: false },
        },
        error: null,
        status: 200,
    });
    render(PlaylistSuggestions, { playlistId: '42', onAdd: vi.fn() });
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('3:00')).toBeTruthy();
    expect(getPlaylistSuggestions).toHaveBeenCalledWith(42, 6);
    expect(screen.getByText('sonic')).toBeTruthy();
});
