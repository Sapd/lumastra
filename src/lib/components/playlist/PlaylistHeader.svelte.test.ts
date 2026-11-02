// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The watchlist is a system playlist (`playlist.isSystem === true`) with a
 * fixed identity: the server 409s rename/visibility/share/delete for it
 * (Tasks 1-7). This header must not offer those controls in the first place
 * — Task 8, Step 1. The "Add" button is the one exception: adding items to
 * the watchlist is the point, so it must stay visible even when isSystem.
 */

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PlaylistHeader from './PlaylistHeader.svelte';
import type { Playlist } from '$lib/types/api-playlists';

function makePlaylist(overrides: Partial<Playlist>): Playlist {
    return {
        id: 1,
        owner: {
            userId: '550e8400-e29b-41d4-a716-446655440000',
            displayName: 'testuser',
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
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        role: 'owner',
        itemCount: 0,
        ...overrides,
    };
}

function baseProps(playlist: Playlist) {
    return {
        playlist,
        canEdit: true,
        canManageMembers: true,
        username: 'testuser',
    };
}

describe('PlaylistHeader — system playlist controls', () => {
    afterEach(() => cleanup());

    it('hides rename, visibility, share and delete for a system playlist', () => {
        const playlist = makePlaylist({ isSystem: true });
        render(PlaylistHeader, { props: baseProps(playlist) });

        // No pencil / click-to-rename affordance — title is a plain heading.
        const title = screen.getByText('Watchlist');
        expect(title.closest('h1')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Edit name' })).toBeNull();
        expect(screen.queryByTitle(/private|public/i)).toBeNull();
        expect(screen.queryByRole('button', { name: 'Sharing & members' })).toBeNull();
        expect(screen.queryByLabelText('Delete playlist')).toBeNull();

        // The Add button is the one control that stays.
        expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
    });

    it('shows rename, visibility, share and delete for a non-system playlist', () => {
        const playlist = makePlaylist({ isSystem: false, playlistType: 'general' });
        render(PlaylistHeader, { props: baseProps(playlist) });

        const title = screen.getByText('Watchlist');
        expect(title.closest('h1')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Edit name' })).toBeTruthy();
        expect(screen.queryByTitle(/private|public/i)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Sharing & members' })).toBeTruthy();
        expect(screen.getByLabelText('Delete playlist')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
    });

    it('requires explicit save and lets the user cancel without saving on blur', async () => {
        const onSaveName = vi.fn();
        render(PlaylistHeader, {
            props: {
                ...baseProps(makePlaylist({ isSystem: false })),
                playlistName: 'Watchlist',
                onSaveName,
            },
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Edit name' }));
        const input = screen.getByRole('textbox', { name: 'Name' });
        expect(document.activeElement).toBe(input);
        await fireEvent.input(input, { target: { value: 'Changed' } });
        await fireEvent.blur(input);
        expect(onSaveName).not.toHaveBeenCalled();
        await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('textbox')).toBeNull();
        expect(onSaveName).not.toHaveBeenCalled();
    });

    it('hides description editing even when requested for a system playlist', () => {
        render(PlaylistHeader, {
            props: { ...baseProps(makePlaylist({ isSystem: true })), editingDescription: true },
        });
        expect(screen.queryByRole('textbox')).toBeNull();
    });

    it('exposes member disclosure state and disables saving duplicate edits', () => {
        render(PlaylistHeader, {
            props: {
                ...baseProps(makePlaylist({ isSystem: false })),
                editingName: true,
                playlistName: 'Mix',
                savingMetadata: true,
                membersExpanded: true,
            },
        });
        expect(
            screen.getByRole('button', { name: 'Sharing & members' }).getAttribute('aria-expanded'),
        ).toBe('true');
        expect(screen.getByRole('textbox').hasAttribute('disabled')).toBe(true);
        expect(screen.getByRole('button', { name: /saving/i }).hasAttribute('disabled')).toBe(true);
    });
});
