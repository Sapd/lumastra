// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { musicTrackFromCard } from '$lib/utils/music-track';
// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { Writable } from 'svelte/store';
import type { MusicPlayerState } from '$lib/stores/music-player.store';
import FullScreenPlayer from './FullScreenPlayer.svelte';
import QueuePanel from './QueuePanel.svelte';

const actions = vi.hoisted(() => ({ switchToSmartQueue: vi.fn() }));
vi.mock('$lib/stores/music-player.store', async () => {
    const { writable } = await vi.importActual<typeof import('svelte/store')>('svelte/store');
    return {
        musicPlayerStore: Object.assign(writable({}), actions),
        formattedCurrentTime: writable('0:45'),
        formattedDuration: writable('3:00'),
        currentChapter: writable(null),
        nextChapter: writable(null),
        currentRadioNowPlaying: writable(null),
    };
});
vi.mock('$app/navigation', () => ({ beforeNavigate: vi.fn() }));
vi.mock('$app/stores', async () => {
    const { writable } = await vi.importActual<typeof import('svelte/store')>('svelte/store');
    return { page: writable({ data: {}, url: new URL('http://localhost/music') }) };
});
vi.mock('$lib/stores/modal.store', () => ({ modals: { closeAll: vi.fn() } }));
vi.mock('$lib/utils/modal-utils', () => ({
    openAlbumModal: vi.fn(),
    openArtistModal: vi.fn(),
    openSimilarTracksModal: vi.fn(),
}));
vi.mock('svelte-dnd-action', () => ({
    dndzone: () => ({}),
    dragHandleZone: () => ({}),
    SHADOW_PLACEHOLDER_ITEM_ID: 'shadow',
}));
// Mount the actual parent components and banner; isolate unrelated panels/audio.
vi.mock('./CrossfadeSeekbarFx.svelte', () => ({ default: () => {} }));
vi.mock('./TrackArtistLine.svelte', () => ({ default: () => {} }));
vi.mock('./TrackTitleLine.svelte', () => ({ default: () => {} }));
vi.mock('./LyricsPanel.svelte', () => ({ default: () => {} }));
vi.mock('./QueueTrackItem.svelte', () => ({ default: () => {} }));
vi.mock('./QueueHistorySection.svelte', () => ({ default: () => {} }));
vi.mock('./QueueAddTab.svelte', () => ({ default: () => {} }));
vi.mock('./CrossfadeSettings.svelte', () => ({ default: () => {} }));
vi.mock('./MusicChapterSheet.svelte', () => ({ default: () => {} }));
vi.mock('./SonicStatChips.svelte', () => ({ default: () => {} }));
vi.mock('./music-track-menu', () => ({ buildMusicTrackMenu: () => [] }));

import { musicPlayerStore } from '$lib/stores/music-player.store';
const store = musicPlayerStore as unknown as Writable<Partial<MusicPlayerState>>;
afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

function prime(): void {
    const track = musicTrackFromCard({
        id: 'current',
        title: 'Current',
        artists: [{ id: null, title: 'Artist' }],
        durationMs: 180000,
        type: 'track' as const,
    });
    store.set({
        currentTrack: track,
        currentTrackSource: 'user',
        queue: [{ id: 'next', track: { ...track, id: 'next' }, source: 'user' }],
        history: [],
        autoplaySeed: null,
        playbackContext: { type: 'artist', name: 'Selected Artist', trackCount: 2 },
        isFullScreen: true,
        activePanel: 'queue',
        isPlaying: false,
        currentTimeMs: 45000,
        durationMs: 180000,
        progress: 0.25,
        volume: 0.5,
        autoplayEnabled: false,
        fullScreenSwipeProgress: 0,
        supportsVolumeControl: false,
    });
}

describe('Smart Queue parent placements', () => {
    it('offers conversion in the actual fullscreen queue tab', async () => {
        prime();
        const view = render(FullScreenPlayer);
        await fireEvent.click(view.getByRole('button', { name: 'Toggle queue' }));
        expect(view.getByText('Selected Artist')).toBeTruthy();
        await fireEvent.click(view.getByRole('button', { name: 'Smart Queue' }));
        expect(actions.switchToSmartQueue).toHaveBeenCalledOnce();
    });

    it('offers conversion in the actual desktop QueuePanel', async () => {
        prime();
        const view = render(QueuePanel);
        expect(view.getByText('Selected Artist')).toBeTruthy();
        await fireEvent.click(view.getByRole('button', { name: 'Smart Queue' }));
        expect(actions.switchToSmartQueue).toHaveBeenCalledOnce();
    });
});
