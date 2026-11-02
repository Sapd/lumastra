// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Playlist } from '$lib/stores/playlists';

const {
    getPlaylists,
    createPlaylist,
    addItemToPlaylist,
    closeAddToPlaylistModal,
    syncWatchlistStoreAdded,
} = vi.hoisted(() => ({
    getPlaylists: vi.fn(),
    createPlaylist: vi.fn(),
    addItemToPlaylist: vi.fn(),
    closeAddToPlaylistModal: vi.fn(),
    syncWatchlistStoreAdded: vi.fn(),
}));
vi.mock('$lib/api/playlists', () => ({ getPlaylists }));
vi.mock('$lib/stores/playlists', () => ({
    createPlaylist,
    addItemToPlaylist,
    closeAddToPlaylistModal,
    syncWatchlistStoreAdded,
}));
import AddToPlaylistModal from './AddToPlaylistModal.svelte';

function playlist(overrides: Partial<Playlist>): Playlist {
    return {
        id: 1,
        owner: {
            userId: '550e8400-e29b-41d4-a716-446655440000',
            displayName: 'viewer',
            images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
        },
        revision: 0,
        memberCount: 0,
        isSystem: false,
        description: null,
        images: {},
        name: 'Watchlist',
        visibility: 'private',
        playlistType: 'watchlist',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        role: 'owner',
        itemCount: 0,
        ...overrides,
    };
}
const WATCHLIST = playlist({});
const REGULAR = playlist({ id: 2, name: 'My Mix', playlistType: 'general' });
const EDITOR = playlist({ id: 3, name: 'Shared Mix', role: 'editor', playlistType: 'general' });
function renderModal(mediaType: 'movie' | 'tv' | 'episode' | 'track' = 'movie') {
    return render(AddToPlaylistModal, {
        externalIds: { internal: '550e8400-e29b-41d4-a716-446655440001' },
        mediaType,
        title: 'Some Title',
        ...(mediaType === 'episode'
            ? {
                  seasonNumber: 2,
                  episodeNumber: 3,
                  seriesName: 'Some Series',
                  seriesExternalIds: { internal: '550e8400-e29b-41d4-a716-446655440002' },
              }
            : {}),
    });
}
beforeEach(() => {
    vi.clearAllMocks();
    getPlaylists.mockResolvedValue({
        data: {
            items: [
                WATCHLIST,
                REGULAR,
                EDITOR,
                playlist({ id: 4, name: 'Read only', role: 'readonly' }),
            ],
        },
        error: null,
    });
    addItemToPlaylist.mockResolvedValue({
        id: 9,
        mediaType: 'movie',
        mediaId: '550e8400-e29b-41d4-a716-446655440001',
        title: 'Some Title',
        position: 0,
        addedAt: '2026-01-01T00:00:00Z',
        watched: false,
    });
    createPlaylist.mockResolvedValue(
        playlist({ id: 5, name: 'Road Trip', playlistType: 'general' }),
    );
});
afterEach(cleanup);

describe('AddToPlaylistModal', () => {
    it('loads locally, shows writable targets, and searches without offering read-only rows', async () => {
        renderModal();
        await screen.findByText('My Mix');
        expect(getPlaylists).toHaveBeenCalledWith(undefined);
        expect(screen.queryByText('Read only')).toBeNull();
        await fireEvent.input(screen.getByLabelText('Search playlists'), {
            target: { value: 'shared' },
        });
        expect(screen.getByText('Shared Mix')).toBeTruthy();
        expect(screen.queryByText('My Mix')).toBeNull();
        await fireEvent.input(screen.getByLabelText('Search playlists'), {
            target: { value: 'zzzz' },
        });
        expect(screen.getByText('No playlists match your search.')).toBeTruthy();
        await fireEvent.click(screen.getByLabelText('Clear playlist search'));
        expect(document.activeElement).toBe(screen.getByLabelText('Search playlists'));
    });

    it('hides Watchlist for episodes and forwards exact episode identity and scope', async () => {
        renderModal('episode');
        await screen.findByText('My Mix');
        expect(screen.queryByText('Watchlist')).toBeNull();
        expect(screen.getByText(/S2E3/)).toBeTruthy();
        expect(screen.getByText('Only this episode will be added.')).toBeTruthy();
        await fireEvent.click(screen.getByRole('button', { name: /My Mix/ }));
        expect(addItemToPlaylist).toHaveBeenCalledWith(
            2,
            expect.objectContaining({
                externalIds: { internal: '550e8400-e29b-41d4-a716-446655440001' },
                mediaType: 'episode',
                seriesExternalIds: { internal: '550e8400-e29b-41d4-a716-446655440002' },
                seasonNumber: 2,
                episodeNumber: 3,
            }),
        );
    });

    it('uses the music API filter for tracks without reading shared store cache', async () => {
        getPlaylists.mockResolvedValue({
            data: {
                items: [
                    WATCHLIST,
                    REGULAR,
                    playlist({ id: 8, name: 'Music Mix', playlistType: 'music' }),
                ],
            },
            error: null,
        });
        renderModal('track');
        await screen.findByText('Music Mix');
        expect(getPlaylists).toHaveBeenCalledWith('music');
        expect(screen.queryByText('Watchlist')).toBeNull();
        expect(screen.queryByText('My Mix')).toBeNull();
    });

    it('explains series versus Watchlist behavior and displays actual expansion count', async () => {
        addItemToPlaylist.mockResolvedValue({
            expanded: true,
            episodesAdded: 7,
            seriesName: 'Some Title',
        });
        renderModal('tv');
        await screen.findByText('My Mix');
        expect(screen.getByText(/Watchlist saves this series as one entry/)).toBeTruthy();
        await fireEvent.click(screen.getByRole('button', { name: /My Mix/ }));
        expect(screen.getByRole('status').textContent).toBe('Added 7 episodes to My Mix.');
    });

    it('explicitly syncs Watchlist indicators even when its type was only loaded locally', async () => {
        renderModal();
        await fireEvent.click(await screen.findByRole('button', { name: /Watchlist/ }));
        expect(syncWatchlistStoreAdded).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }));
    });

    it('distinguishes duplicates from successful additions', async () => {
        addItemToPlaylist.mockResolvedValue(null);
        renderModal();
        await fireEvent.click(await screen.findByRole('button', { name: /My Mix/ }));
        expect(screen.getByRole('status').textContent).toBe('Already in My Mix.');
    });

    it('renders load errors without a false empty state and retries thrown failures', async () => {
        getPlaylists.mockRejectedValueOnce(new Error('Offline'));
        renderModal();
        await screen.findByRole('alert');
        expect(screen.queryByText(/No editable playlists/)).toBeNull();
        await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('My Mix')).toBeTruthy();
    });

    it('renders the empty state after a successful load with no eligible destinations', async () => {
        getPlaylists.mockResolvedValue({ data: { items: [] }, error: null });
        renderModal();
        expect(await screen.findByText(/No editable playlists/)).toBeTruthy();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('keeps failures retryable and never shows success for a rejected write', async () => {
        addItemToPlaylist.mockRejectedValueOnce(new Error('Server error'));
        renderModal();
        await fireEvent.click(await screen.findByRole('button', { name: /My Mix/ }));
        expect(screen.getByRole('alert')).toBeTruthy();
        expect(screen.getByRole('status').textContent).toBe('');
        await fireEvent.click(screen.getByRole('button', { name: /My Mix/ }));
        expect(screen.getByRole('status').textContent).toBe('Added to My Mix.');
    });

    it('blocks all concurrent writes and close while adding', async () => {
        let finish!: (value: null) => void;
        addItemToPlaylist.mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        renderModal();
        await fireEvent.click(await screen.findByRole('button', { name: /My Mix/ }));
        expect(
            (screen.getByRole('button', { name: /Shared Mix/ }) as HTMLButtonElement).disabled,
        ).toBe(true);
        expect(
            (screen.getByRole('button', { name: /Create new playlist/i }) as HTMLButtonElement)
                .disabled,
        ).toBe(true);
        await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
        expect(closeAddToPlaylistModal).not.toHaveBeenCalled();
        finish(null);
        await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Already in'));
    });

    it('retains a newly created private playlist on add failure and retries without creating again', async () => {
        addItemToPlaylist.mockRejectedValueOnce(new Error('Offline'));
        renderModal();
        await screen.findByText('My Mix');
        await fireEvent.click(screen.getByRole('button', { name: /Create new playlist/i }));
        const name = screen.getByLabelText('Playlist name');
        expect(document.activeElement).toBe(name);
        await fireEvent.input(name, { target: { value: 'Road Trip' } });
        await fireEvent.click(screen.getByRole('button', { name: /Create.*Add/i }));
        expect(createPlaylist).toHaveBeenCalledWith('Road Trip', undefined, 'private', 'general');
        await waitFor(() =>
            expect(screen.getByRole('alert').textContent).toContain('Created “Road Trip”'),
        );
        await fireEvent.click(screen.getByRole('button', { name: /Road Trip/ }));
        expect(createPlaylist).toHaveBeenCalledTimes(1);
        expect(addItemToPlaylist).toHaveBeenLastCalledWith(5, expect.anything());
        expect(screen.getByRole('status').textContent).toBe('Added to Road Trip.');
    });

    it('labels the dialog, focuses search, handles Escape once and restores opener on unmount', async () => {
        const opener = document.createElement('button');
        document.body.appendChild(opener);
        opener.focus();
        const { unmount } = renderModal();
        await screen.findByText('My Mix');
        expect(screen.getByRole('dialog', { name: 'Add to Playlist' })).toBeTruthy();
        expect(document.activeElement).toBe(screen.getByLabelText('Search playlists'));
        await fireEvent.keyDown(screen.getByLabelText('Search playlists'), { key: 'Escape' });
        expect(closeAddToPlaylistModal).toHaveBeenCalledTimes(1);
        unmount();
        expect(document.activeElement).toBe(opener);
        opener.remove();
    });

    it('labels destination types and hides stale counts after a successful expansion', async () => {
        addItemToPlaylist.mockResolvedValue({
            expanded: true,
            episodesAdded: 12,
            seriesName: 'Some Title',
        });
        getPlaylists.mockResolvedValue({
            data: { items: [REGULAR, playlist({ id: 8, name: 'Songs', playlistType: 'music' })] },
            error: null,
        });
        renderModal('tv');
        const row = await screen.findByRole('button', { name: /My Mix/ });
        expect(row.textContent).toContain('Mixed');
        expect(screen.getByRole('button', { name: /Songs/ }).textContent).toContain('Music');
        await fireEvent.click(row);
        await waitFor(() => expect(row.textContent).toContain('Added 12 episodes'));
        expect(row.textContent).not.toMatch(/0\s+items/);
    });

    it('recovers row focus after failure and moves it to search after success', async () => {
        let reject!: (error: Error) => void;
        addItemToPlaylist.mockReturnValueOnce(
            new Promise((_, fail) => {
                reject = fail;
            }),
        );
        renderModal();
        const row = await screen.findByRole('button', { name: /My Mix/ });
        row.focus();
        await fireEvent.click(row);
        row.blur(); // Browsers drop focus when the pending button becomes disabled.
        reject(new Error('Offline'));
        await waitFor(() => expect(document.activeElement).toBe(row));
        await fireEvent.click(row);
        await waitFor(() =>
            expect(document.activeElement).toBe(screen.getByLabelText('Search playlists')),
        );
    });

    it('does not steal focus when the user moves to search during a pending write', async () => {
        let reject!: (error: Error) => void;
        addItemToPlaylist.mockReturnValueOnce(
            new Promise((_, fail) => {
                reject = fail;
            }),
        );
        renderModal();
        const row = await screen.findByRole('button', { name: /My Mix/ });
        row.focus();
        await fireEvent.click(row);
        const search = screen.getByLabelText('Search playlists');
        search.focus();
        reject(new Error('Offline'));
        await screen.findByRole('alert');
        expect(document.activeElement).toBe(search);
    });
});
