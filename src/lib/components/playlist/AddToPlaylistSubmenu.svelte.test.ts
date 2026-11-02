// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getPlaylists = vi.fn();
const addItemToPlaylist = vi.fn();
const createPlaylist = vi.fn();

vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/api/playlists', () => ({ getPlaylists: (...a: unknown[]) => getPlaylists(...a) }));
vi.mock('$lib/stores/playlists', () => ({
    addItemToPlaylist: (...a: unknown[]) => addItemToPlaylist(...a),
    createPlaylist: (...a: unknown[]) => createPlaylist(...a),
}));

import AddToPlaylistSubmenu from './AddToPlaylistSubmenu.svelte';
import type { Playlist } from '$lib/schemas/playlists';

const playlistDefaults = {
    owner: {
        userId: '550e8400-e29b-41d4-a716-446655440000',
        displayName: 'Viewer',
        images: { primary: { href: '/avatar', revision: '0', source: 'self' as const } },
    },
    description: null,
    images: {},
    visibility: 'private' as const,
    memberCount: 1,
    revision: 0,
    isSystem: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
};

const OWNED: Playlist = {
    ...playlistDefaults,
    id: 1,
    name: 'Handsup',
    role: 'owner',
    itemCount: 12,
    playlistType: 'music',
};
const EDITOR: Playlist = {
    ...playlistDefaults,
    id: 2,
    name: 'Shared Mix',
    role: 'editor',
    itemCount: 3,
    playlistType: 'music',
};
const READONLY: Playlist = {
    ...playlistDefaults,
    id: 3,
    name: 'Read Only',
    role: 'readonly',
    itemCount: 7,
    playlistType: 'music',
};

function renderSubmenu(onDone = vi.fn()) {
    return {
        onDone,
        ...render(AddToPlaylistSubmenu, {
            props: {
                externalIds: { internal: 'track-1' },
                title: 'Beyond Me',
                subtitle: 'Eloren',
                posterPath: '/poster.jpg',
                onDone,
            },
        }),
    };
}

describe('AddToPlaylistSubmenu', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getPlaylists.mockResolvedValue({ data: { items: [OWNED, EDITOR, READONLY] }, error: null });
        addItemToPlaylist.mockResolvedValue({ id: 99 });
        createPlaylist.mockResolvedValue({
            ...playlistDefaults,
            id: 4,
            name: 'New One',
            role: 'owner',
            itemCount: 0,
            playlistType: 'music',
        });
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it('requests only music playlists', async () => {
        renderSubmenu();
        await waitFor(() => expect(getPlaylists).toHaveBeenCalledWith('music'));
    });

    it('lists writable playlists and hides read-only ones', async () => {
        renderSubmenu();
        await screen.findByText('Handsup');
        expect(screen.getByText('Shared Mix')).toBeTruthy();
        // A readonly share cannot be written to, so offering it would only
        // produce a 403 after the click.
        expect(screen.queryByText('Read Only')).toBeNull();
    });

    it('adds the track to the clicked playlist, then closes the menu', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const onDone = vi.fn();
        renderSubmenu(onDone);

        const row = await screen.findByText('Handsup');
        row.closest('button')?.click();

        await waitFor(() =>
            expect(addItemToPlaylist).toHaveBeenCalledWith(1, {
                externalIds: { internal: 'track-1' },
                mediaType: 'track',
                title: 'Beyond Me',
                overview: 'Eloren',
                posterPath: '/poster.jpg',
            }),
        );

        // The checkmark holds briefly before the menu tears itself down.
        expect(onDone).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(500);
        expect(onDone).toHaveBeenCalled();
    });

    it('creates a music playlist inline and adds the track to it', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        renderSubmenu();
        await screen.findByText('Handsup');

        screen.getByText('New Playlist').closest('button')?.click();

        const input = await screen.findByPlaceholderText('Playlist name');
        const field = input as HTMLInputElement;
        field.value = 'Road Trip';
        field.dispatchEvent(new Event('input', { bubbles: true }));

        field
            .closest('form')
            ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

        await waitFor(() =>
            expect(createPlaylist).toHaveBeenCalledWith('Road Trip', undefined, 'private', 'music'),
        );
        await waitFor(() => expect(addItemToPlaylist).toHaveBeenCalledWith(4, expect.anything()));
    });

    it('surfaces an add failure instead of flashing the success tick', async () => {
        // addItemToPlaylist used to return null for duplicates AND real failures,
        // and never rejected — so a 404, a 500 or a concurrently-deleted
        // playlist confirmed and closed over a track that was never added.
        addItemToPlaylist.mockRejectedValue(new Error('Failed to add item to playlist'));
        const onDone = vi.fn();
        renderSubmenu(onDone);

        const row = await screen.findByText('Handsup');
        row.closest('button')?.click();

        await waitFor(() => expect(addItemToPlaylist).toHaveBeenCalled());
        expect(onDone).not.toHaveBeenCalled();
    });

    it('still confirms when the track is already on the playlist', async () => {
        // A duplicate outcome resolves to null in the store: from the user's side
        // the track is already on the playlist.
        vi.useFakeTimers({ shouldAdvanceTime: true });
        addItemToPlaylist.mockResolvedValue(null);
        const onDone = vi.fn();
        renderSubmenu(onDone);

        const row = await screen.findByText('Handsup');
        row.closest('button')?.click();

        await waitFor(() => expect(addItemToPlaylist).toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(500);
        expect(onDone).toHaveBeenCalled();
    });

    it('surfaces a load failure instead of rendering an empty list', async () => {
        getPlaylists.mockResolvedValue({ data: null, error: 'boom' });
        renderSubmenu();
        await screen.findByText('Could not load playlists');
    });

    it('hides the watchlist even if the server ever returned it here', async () => {
        // This submenu only ever adds a 'track', which the watchlist cannot
        // hold — mirrors the same client-side guard as AddToPlaylistModal
        // (Task 8, Step 4), so a future change to the `getPlaylists('music')`
        // server-side filter can't silently offer the watchlist as a target.
        const WATCHLIST: Playlist = {
            ...playlistDefaults,
            isSystem: true,
            id: 5,
            name: 'Watchlist',
            role: 'owner',
            itemCount: 3,
            playlistType: 'watchlist',
        };
        getPlaylists.mockResolvedValue({
            data: { items: [OWNED, WATCHLIST] },
            error: null,
        });
        renderSubmenu();
        await screen.findByText('Handsup');
        expect(screen.queryByText('Watchlist')).toBeNull();
    });

    it('searches eligible destinations and clears the query without closing', async () => {
        const { onDone } = renderSubmenu();
        await screen.findByText('Handsup');
        const search = screen.getByLabelText('Search playlists');
        await fireEvent.input(search, { target: { value: 'shared' } });
        expect(screen.queryByText('Handsup')).toBeNull();
        expect(screen.getByText('Shared Mix')).toBeTruthy();
        await fireEvent.input(search, { target: { value: 'missing' } });
        expect(screen.getByText('No playlists match your search.')).toBeTruthy();
        await fireEvent.click(screen.getByLabelText('Clear playlist search'));
        expect(document.activeElement).toBe(search);
        expect(onDone).not.toHaveBeenCalled();
    });

    it('retries a thrown load failure without also showing an empty state', async () => {
        getPlaylists.mockRejectedValueOnce(new Error('Offline'));
        renderSubmenu();
        await screen.findByRole('alert');
        expect(screen.queryByText(/No editable playlists/)).toBeNull();
        await fireEvent.click(screen.getByRole('menuitem', { name: 'Try again' }));
        expect(await screen.findByText('Handsup')).toBeTruthy();
    });

    it('retains the created playlist when adding fails and retries without another create', async () => {
        addItemToPlaylist.mockRejectedValueOnce(new Error('Offline'));
        renderSubmenu();
        await screen.findByText('Handsup');
        await fireEvent.click(screen.getByRole('menuitem', { name: 'New Playlist' }));
        await fireEvent.input(screen.getByLabelText('Playlist name'), {
            target: { value: 'New One' },
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Create & Add' }));
        await waitFor(() =>
            expect(screen.getByRole('alert').textContent).toContain('Created “New One”'),
        );
        await fireEvent.click(screen.getByRole('menuitem', { name: 'New One' }));
        expect(createPlaylist).toHaveBeenCalledTimes(1);
        expect(addItemToPlaylist).toHaveBeenCalledTimes(2);
        expect(screen.getByRole('status').textContent).toBe('Added to New One.');
    });

    it('announces an existing track and cancels delayed close on unmount', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        addItemToPlaylist.mockResolvedValue(null);
        const { onDone, unmount } = renderSubmenu();
        await fireEvent.click(await screen.findByRole('menuitem', { name: 'Handsup' }));
        expect(screen.getByRole('status').textContent).toBe('Already in Handsup.');
        unmount();
        await vi.advanceTimersByTimeAsync(500);
        expect(onDone).not.toHaveBeenCalled();
    });

    it('does not schedule a close after an in-flight add outlives the submenu', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        let finish!: (value: null) => void;
        addItemToPlaylist.mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const { onDone, unmount } = renderSubmenu();
        await fireEvent.click(await screen.findByRole('menuitem', { name: 'Handsup' }));
        expect(
            (screen.getByRole('menuitem', { name: 'New Playlist' }) as HTMLButtonElement).disabled,
        ).toBe(true);
        expect(
            (screen.getByRole('menuitem', { name: /Shared Mix/ }) as HTMLButtonElement).disabled,
        ).toBe(true);
        unmount();
        finish(null);
        await vi.advanceTimersByTimeAsync(500);
        expect(onDone).not.toHaveBeenCalled();
    });

    it('handles submenu arrow navigation without leaking to the parent menu', async () => {
        renderSubmenu();
        const first = await screen.findByRole('menuitem', { name: 'Handsup' });
        first.focus();
        await fireEvent.keyDown(first, { key: 'ArrowDown' });
        expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /Shared Mix/ }));
        const search = screen.getByLabelText('Search playlists');
        search.focus();
        await fireEvent.keyDown(search, { key: 'Home' });
        expect(document.activeElement).toBe(search);
    });
});
