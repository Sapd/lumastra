// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, it, vi } from 'vitest';
import { PlayerController } from './player-controller.svelte';
import { watchTogether } from '$lib/stores/watchTogether.svelte';
import { playerStore } from './playerStore.svelte';

const party = vi.hoisted(() => ({
    syncing: false,
    stalled: false,
    attaching: false,
    handlerHeld: false,
}));

vi.mock('$lib/stores/watchTogether.svelte', () => ({
    watchTogether: {
        isInWatchParty: true,
        get isWatchPartySyncing() {
            return party.syncing;
        },
        get isStalled() {
            return party.stalled;
        },
        get isPlayerAttachmentPending() {
            return party.attaching;
        },
        getHasSyncedInitially: () => true,
        syncPlaybackState: vi.fn(async () => {}),
    },
}));

function player(): { controller: PlayerController; video: HTMLVideoElement } {
    const controller = Object.create(PlayerController.prototype) as PlayerController;
    const video = document.createElement('video');
    let paused = true;
    vi.spyOn(video, 'paused', 'get').mockImplementation(() => paused);
    vi.spyOn(video, 'play').mockImplementation(async () => {
        paused = false;
    });
    vi.spyOn(video, 'pause').mockImplementation(() => {
        paused = true;
    });
    for (const [key, value] of Object.entries({
        videoElement: video,
        canSyncToWatchParty: true,
        log: vi.fn(),
        handlePlayError: vi.fn(),
        watchTogetherCtrl: { isPlaybackHeld: () => party.handlerHeld },
    }))
        Object.defineProperty(controller, key, { value, writable: true, configurable: true });
    return { controller, video };
}

afterEach(() => {
    playerStore.reset();
    party.syncing = false;
    party.stalled = false;
    party.attaching = false;
    party.handlerHeld = false;
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

it.each([0, 60])(
    'keeps the clock updating when a party seek to %s has already landed',
    (position) => {
        const { controller, video } = player();
        video.currentTime = position;
        vi.spyOn(video, 'readyState', 'get').mockReturnValue(4);
        vi.spyOn(video, 'seeking', 'get').mockReturnValue(false);
        playerStore.setDuration(120);
        for (const [key, value] of Object.entries({
            isWatchPartyGuest: false,
            isDirectStreamMode: false,
            telemetryCtrl: { seekStartPosition: null },
            watchTogetherCtrl: { onTimeUpdate: vi.fn() },
            tickPlayingAccumulator: vi.fn(),
            hasFiredInitialPositionHeartbeat: true,
            lastMediaSessionPositionUpdate: Date.now(),
            mediaSessionCtrl: { updatePositionState: vi.fn() },
        }))
            Object.defineProperty(controller, key, { value, writable: true, configurable: true });
        controller.seekTo(position, false, 'watch_party_seek');
        expect(playerStore.isSeeking).toBe(false);
        // No native seeking/seeked events occur for an already-current position.
        video.currentTime = position + 2;
        controller.onTimeUpdate();
        expect(playerStore.isSeeking).toBe(false);
        expect(playerStore.playheadTime).toBe(position + 2);
    },
);

it.each(['syncing', 'stalled', 'attaching', 'handlerHeld'] as const)(
    'party Play retains the %s hold',
    async (hold) => {
        vi.useFakeTimers();
        party[hold] = true;
        if (hold === 'syncing') {
            // The real store supersedes a pending local seek when this input is sent.
            vi.mocked(watchTogether.syncPlaybackState).mockImplementationOnce(async () => {
                party.syncing = false;
            });
        }
        const { controller, video } = player();
        controller.togglePlayPause();
        expect(watchTogether.syncPlaybackState).toHaveBeenCalledWith(0, true);
        await vi.advanceTimersByTimeAsync(1000);
        expect(video.play).not.toHaveBeenCalled();
        expect(video.paused).toBe(true);
    },
);

it('a canonical pause supersedes the viewer’s earlier party Play', async () => {
    vi.useFakeTimers();
    const { controller, video } = player();
    controller.togglePlayPause();
    expect(video.play).toHaveBeenCalledOnce();
    expect(video.paused).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    video.pause(); // The remote canonical pause reaches the real element.
    await vi.advanceTimersByTimeAsync(1000);
    expect(video.paused).toBe(true);
});

it('an earlier party Play cannot start a replacement video element', async () => {
    vi.useFakeTimers();
    const { controller, video } = player();
    controller.togglePlayPause();
    expect(video.play).toHaveBeenCalledOnce();
    expect(video.paused).toBe(false);
    const replacement = document.createElement('video');
    const play = vi.spyOn(replacement, 'play').mockResolvedValue();
    controller.videoElement = replacement;
    video.pause();
    await vi.advanceTimersByTimeAsync(1000);
    expect(play).not.toHaveBeenCalled();
});

it('Pause during a source replacement toggles party intent instead of the transiently paused element', () => {
    const { controller, video } = player();
    Object.assign(watchTogether, { session: { isPlaying: true, currentTime: 60 } });
    Object.defineProperty(controller, 'watchTogetherCtrl', {
        value: { isSourceReplacing: true, isPlaybackHeld: () => true },
        configurable: true,
    });
    controller.togglePlayPause();
    expect(watchTogether.syncPlaybackState).toHaveBeenCalledWith(60, false);
    expect(video.play).not.toHaveBeenCalled();
    Object.assign(watchTogether, { session: null });
});
