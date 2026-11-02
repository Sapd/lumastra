// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackContext } from '$lib/schemas/autoplay-seed';
import QueueSelectionBanner from './QueueSelectionBanner.svelte';

const state = vi.hoisted(() => ({ switchToSmartQueue: vi.fn() }));
vi.mock('$lib/stores/music-player.store', async () => {
    const { writable } = await vi.importActual<typeof import('svelte/store')>('svelte/store');
    return {
        musicPlayerStore: Object.assign(
            writable({
                currentTrack: { isRadio: false },
                autoplaySeed: null,
                playbackContext: null,
                queue: [],
            }),
            state,
        ),
    };
});
import { musicPlayerStore } from '$lib/stores/music-player.store';
import type { Writable } from 'svelte/store';
const store = musicPlayerStore as unknown as Writable<{
    currentTrack: { isRadio: boolean };
    autoplaySeed: object | null;
    playbackContext: PlaybackContext | null;
    queue: { source: string; sessionId?: string }[];
}>;
afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

function prime(context: PlaybackContext | null, user = true): void {
    store.set({
        currentTrack: { isRadio: false },
        autoplaySeed: null,
        playbackContext: context,
        queue: user ? [{ source: 'user' }] : [{ source: 'smart' }],
    });
}

describe('QueueSelectionBanner', () => {
    it.each<PlaybackContext>([
        { type: 'album', name: 'Album', trackCount: 2, sessionId: 'album' },
        { type: 'artist', name: 'Artist', trackCount: 2 },
        { type: 'mix', name: 'Playlist', trackCount: 2, href: '/music/mixes/test' },
        { type: 'genre', name: 'Collection' },
        { type: 'station', name: 'Station', stationId: 'a1b2c3d4e5f6.0' },
    ])('offers conversion for $type provenance', (context) => {
        prime(context);
        const view = render(QueueSelectionBanner);
        expect(view.getByRole('button', { name: 'Smart Queue' })).toBeTruthy();
        expect(view.getByText(context.name)).toBeTruthy();
    });

    it('offers conversion for unnamed user tracks and invokes the store action', async () => {
        prime(null);
        const view = render(QueueSelectionBanner);
        await fireEvent.click(view.getByRole('button', { name: 'Smart Queue' }));
        expect(state.switchToSmartQueue).toHaveBeenCalledOnce();
    });

    it('retains album final-track offer and mix navigation', () => {
        prime({ type: 'album', name: 'Album', trackCount: 1, sessionId: 'album' }, false);
        let view = render(QueueSelectionBanner);
        expect(view.getByText('Last track from album')).toBeTruthy();
        cleanup();
        prime({ type: 'mix', name: 'Mix', trackCount: 1, href: '/music/mixes/test' });
        view = render(QueueSelectionBanner);
        expect(view.getByRole('link').getAttribute('href')).toBe('/music/mixes/test');
    });

    it.each(['discovery', 'seeded', 'live'])('hides conversion for %s playback', (kind) => {
        prime(null, false);
        if (kind === 'seeded')
            store.update((s) => ({
                ...s,
                autoplaySeed: { type: 'genre' },
                queue: [{ source: 'user' }],
            }));
        if (kind === 'live')
            store.update((s) => ({
                ...s,
                currentTrack: { isRadio: true },
                queue: [{ source: 'user' }],
            }));
        expect(render(QueueSelectionBanner).queryByRole('button')).toBeNull();
    });
});
