// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The card's Edit/Delete menu is a native <details>, which has no light-dismiss
 * of its own: without the card's window listeners it stayed open after Escape
 * and after clicking elsewhere on the page.
 */

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import PlaylistLibraryCard from './PlaylistLibraryCard.svelte';
import type { Playlist } from '$lib/types/api-playlists';

const playlist: Playlist = {
    id: 7,
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
    name: 'Road trip',
    visibility: 'private',
    playlistType: 'general',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    role: 'owner',
    itemCount: 3,
};

function renderCard(ondelete = vi.fn()): HTMLDetailsElement {
    const { container } = render(PlaylistLibraryCard, {
        props: { playlist, covers: [], href: '/playlists/7', owned: true, ondelete },
    });
    const details = container.querySelector('details');
    if (!details) throw new Error('actions menu not rendered');
    return details;
}

async function open(details: HTMLDetailsElement): Promise<void> {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    await tick();
}

describe('PlaylistLibraryCard actions menu', () => {
    afterEach(() => cleanup());

    it('closes on Escape and returns focus to the trigger', async () => {
        const details = renderCard();
        await open(details);
        await fireEvent.keyDown(window, { key: 'Escape' });
        expect(details.open).toBe(false);
        expect(document.activeElement).toBe(details.querySelector('summary'));
    });

    it('closes on a pointer-down outside the menu but not inside it', async () => {
        const details = renderCard();
        await open(details);
        await fireEvent.pointerDown(details.querySelector('.action-menu') as Element);
        expect(details.open).toBe(true);
        await fireEvent.pointerDown(document.body);
        expect(details.open).toBe(false);
    });

    it('closes before handing the playlist to ondelete', async () => {
        const ondelete = vi.fn();
        const details = renderCard(ondelete);
        await open(details);
        await fireEvent.click(screen.getByRole('button', { name: /delete/i }));
        expect(ondelete).toHaveBeenCalledWith(playlist);
        expect(details.open).toBe(false);
    });
});
