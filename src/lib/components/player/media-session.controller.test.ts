// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    MediaSessionController,
    type MediaSessionControllerDeps,
} from './media-session.controller';
import { initMediaSession } from '$lib/utils/media-session';
import { requestWakeLock, releaseWakeLock } from '$lib/utils/wake-lock';

vi.mock('$lib/utils/media-session', () => ({
    initMediaSession: vi.fn(),
    updateMediaSessionPlaybackState: vi.fn(),
    updateMediaSessionPositionState: vi.fn(),
    clearMediaSession: vi.fn(),
}));

vi.mock('$lib/utils/image-utils', () => ({
    getCatalogBackdropUrl: vi.fn(() => undefined),
}));

vi.mock('$lib/shared/media-types', () => ({
    isEpisode: vi.fn(() => false),
}));

vi.mock('$lib/utils/wake-lock', () => ({
    requestWakeLock: vi.fn(),
    releaseWakeLock: vi.fn(),
}));

describe('MediaSessionController', () => {
    const deps: MediaSessionControllerDeps = {
        getVideoElement: () => undefined,
        seekTo: vi.fn(),
        onPlay: vi.fn(),
        onPause: vi.fn(),
        onStop: vi.fn(),
        onNextTrack: undefined,
        hasWatchPartyGuestRestrictions: () => false,
        handlePlayError: vi.fn(),
        isAudioOnly: () => false,
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('routes an external pause action through the player pause callback', () => {
        const pause = vi.fn();
        const video = { pause: vi.fn() } as unknown as HTMLVideoElement;
        const controller = new MediaSessionController({
            ...deps,
            getVideoElement: () => video,
            onPause: pause,
        });

        controller.setup({ title: 'Example', itemId: 'item-1', mediaType: 'Movie' } as never);

        const callbacks = vi.mocked(initMediaSession).mock.calls[0]?.[1];
        callbacks?.onPause?.();

        expect(pause).toHaveBeenCalledOnce();
        expect(video.pause).not.toHaveBeenCalled();
    });

    it('routes an external play action through the player play callback', () => {
        // Lock-screen / headset Play in a watch party must go through the player's
        // party sync, not straight to the element (the host would play alone).
        const play = vi.fn();
        const video = { play: vi.fn(async () => {}) } as unknown as HTMLVideoElement;
        const controller = new MediaSessionController({
            ...deps,
            getVideoElement: () => video,
            onPlay: play,
        });

        controller.setup({ title: 'Example', itemId: 'item-1', mediaType: 'Movie' } as never);

        const callbacks = vi.mocked(initMediaSession).mock.calls[0]?.[1];
        callbacks?.onPlay?.();

        expect(play).toHaveBeenCalledOnce();
        expect(video.play).not.toHaveBeenCalled();
    });

    it('does not hold a wake lock in audio-only mode', () => {
        new MediaSessionController({ ...deps, isAudioOnly: () => true }).updatePlaybackState(
            'playing',
        );
        expect(requestWakeLock).not.toHaveBeenCalled();
    });

    it('still holds a wake lock for video', () => {
        new MediaSessionController({ ...deps, isAudioOnly: () => false }).updatePlaybackState(
            'playing',
        );
        expect(requestWakeLock).toHaveBeenCalled();
    });

    /**
     * The audio-only ↔ video crossing.
     *
     * The wake lock is normally taken by onPlay() → updatePlaybackState, but
     * onPlay() early-returns for the whole quality-restart window and the media
     * element never pauses in between — so no later `play` event arrives.
     * Returning to video therefore never re-acquired the lock and the screen
     * slept during ordinary video playback. `syncWakeLock` is the seam the
     * player calls on that crossing.
     *
     * The mode is read through a MUTABLE `isAudioOnly` closure so the same
     * controller instance genuinely crosses modes — a fixture that constructed
     * a second controller would not be testing the crossing at all.
     *
     * What this does not prove: that PlayerController.finishRestart() calls it
     * (that wiring lives in the controller).
     */
    describe('syncWakeLock across the audio-only ↔ video crossing', () => {
        it('re-acquires the lock when the SAME controller returns to video', () => {
            let audioOnly = true;
            const controller = new MediaSessionController({
                ...deps,
                isAudioOnly: () => audioOnly,
            });

            // Baseline: suppressed while audio-only.
            controller.syncWakeLock(true);
            expect(requestWakeLock).not.toHaveBeenCalled();

            audioOnly = false;
            controller.syncWakeLock(true);

            expect(requestWakeLock).toHaveBeenCalledOnce();
        });

        it('releases the lock when the SAME controller enters audio-only', () => {
            let audioOnly = false;
            const controller = new MediaSessionController({
                ...deps,
                isAudioOnly: () => audioOnly,
            });

            controller.syncWakeLock(true);
            expect(requestWakeLock).toHaveBeenCalledOnce();

            audioOnly = true;
            controller.syncWakeLock(true);

            expect(releaseWakeLock).toHaveBeenCalled();
            // And must NOT have taken a second lock on the way in.
            expect(requestWakeLock).toHaveBeenCalledOnce();
        });

        it('does not take a lock when playback is not intended, even for video', () => {
            new MediaSessionController({ ...deps, isAudioOnly: () => false }).syncWakeLock(false);

            expect(requestWakeLock).not.toHaveBeenCalled();
            expect(releaseWakeLock).toHaveBeenCalled();
        });
    });
});
