// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, it, vi } from 'vitest';
import { PlayerController } from './player-controller.svelte';
import { playerStore } from './playerStore.svelte';

function controller(isIOS = false): PlayerController {
    const result = Object.create(PlayerController.prototype) as PlayerController;
    const video = document.createElement('video');
    video.muted = true;
    const fields = {
        videoElement: video,
        isIOS,
        autoplayMutedDismissed: false,
        showAutoplayMutedPrompt: false,
        showAutoplayTutorial: false,
        autoplayTutorialTimer: undefined,
        log: vi.fn(),
    };
    for (const [key, value] of Object.entries(fields)) {
        Object.defineProperty(result, key, { value, writable: true, configurable: true });
    }
    return result;
}

afterEach(() => {
    playerStore.reset();
    localStorage.removeItem('playerVolume');
    vi.restoreAllMocks();
    vi.useRealTimers();
});

// Exercise the real first-play handler. Only unrelated reporting/engagement
// services are stubbed; audio state and localStorage are the production paths.
function firstPlayController(): PlayerController {
    const c = controller();
    for (const [key, value] of Object.entries({
        isInitialized: false,
        isRestartingPlayback: false,
        shouldSuppressErrors: () => false,
        applyPlaybackResumedReset: vi.fn(),
        resetEngagementTracking: vi.fn(),
        startEngagementTicker: vi.fn(),
        reportProgress: vi.fn(),
        buildQualityRestartKey: () => '',
        consumePendingAudioSwitch: vi.fn(),
        abrCtrl: { onPlaybackStart: vi.fn() },
    })) {
        Object.defineProperty(c, key, { value, writable: true, configurable: true });
    }
    vi.spyOn(playerStore, 'startProgressReporting').mockImplementation(() => {});
    return c;
}

it.each([false, true])(
    'first Play preserves an explicit mute (blocked autoplay: %s)',
    (blocked) => {
        vi.useFakeTimers();
        localStorage.setItem('playerVolume', JSON.stringify({ volume: 1, muted: false }));
        const c = firstPlayController();
        if (blocked) {
            c.showMutedAutoplayPrompt();
            c.handleAutoplayUnmute();
            c.onVolumeChange();
        }
        // The toolbar's Mute handler, before onPlay has initialized the player.
        playerStore.isMuted = true;
        c.videoElement!.muted = true;
        c.onVolumeChange();
        c.onPlay();
        expect(c.isInitialized).toBe(true);
        expect(c.videoElement!.muted).toBe(true);
        expect(playerStore.isMuted).toBe(true);
        expect(JSON.parse(localStorage.getItem('playerVolume')!)).toMatchObject({ muted: true });
    },
);

it('first muted autoplay preserves its fallback without saving it as a user mute', () => {
    vi.useFakeTimers();
    const saved = JSON.stringify({ volume: 0.6, muted: false });
    localStorage.setItem('playerVolume', saved);
    const c = firstPlayController();
    c.videoElement!.volume = 0.6;
    c.showMutedAutoplayPrompt();
    c.onPlay();
    c.onVolumeChange();
    expect(c.videoElement!.muted).toBe(true);
    expect(playerStore.isMuted).toBe(true);
    expect(localStorage.getItem('playerVolume')).toBe(saved);
});

it('first Play keeps volume and unmute selected after loading saved preferences', () => {
    localStorage.setItem('playerVolume', JSON.stringify({ volume: 1, muted: true }));
    const c = firstPlayController();
    c.handleAutoplayUnmute();
    c.handleVolume(0.25);
    c.onVolumeChange();
    c.onPlay();
    expect(c.videoElement!.muted).toBe(false);
    expect(playerStore.isMuted).toBe(false);
    expect(c.videoElement!.volume).toBe(0.25);
    expect(playerStore.volume).toBe(0.25);
    expect(JSON.parse(localStorage.getItem('playerVolume')!)).toEqual({
        volume: 0.25,
        muted: false,
    });
});

it('dismissing the tutorial leaves unmute available and does not unpause playback', () => {
    vi.useFakeTimers();
    const c = controller();
    const play = vi.spyOn(c.videoElement!, 'play');
    c.showMutedAutoplayPrompt();
    vi.runAllTimers();
    expect(c.showAutoplayTutorial).toBe(true);
    c.handleAutoplayDismiss();
    expect(c.showAutoplayTutorial).toBe(false);
    expect(c.showAutoplayMutedPrompt).toBe(true);
    expect(c.videoElement!.muted).toBe(true);
    c.handleAutoplayUnmute();
    expect(c.showAutoplayMutedPrompt).toBe(false);
    expect(c.videoElement!.muted).toBe(false);
    expect(playerStore.isMuted).toBe(false);
    expect(play).not.toHaveBeenCalled();
    expect(c.videoElement!.paused).toBe(true);
});

it('a later muted fallback restores the sound action and store after tutorial dismissal', () => {
    vi.useFakeTimers();
    const c = controller();
    c.showMutedAutoplayPrompt();
    c.handleAutoplayDismiss();
    c.handleAutoplayUnmute();
    c.videoElement!.muted = true;
    c.showMutedAutoplayPrompt();
    vi.runAllTimers();
    expect(c.showAutoplayMutedPrompt).toBe(true);
    expect(playerStore.isMuted).toBe(true);
    expect(c.showAutoplayTutorial).toBe(false);
});

it('iOS keeps the sound action without displaying desktop Safari settings advice', () => {
    vi.useFakeTimers();
    const c = controller(true);
    c.showMutedAutoplayPrompt();
    vi.runAllTimers();
    expect(c.showAutoplayMutedPrompt).toBe(true);
    expect(c.showAutoplayTutorial).toBe(false);
});

it("never saves the autoplay fallback's mute, but saves the user's own mute", () => {
    vi.useFakeTimers();
    localStorage.removeItem('playerVolume');
    const c = controller();
    const video = c.videoElement!;
    video.muted = false;
    for (const [key, value] of Object.entries({
        isInitialized: true,
        mutedByAutoplayFallback: false,
    })) {
        Object.defineProperty(c, key, { value, writable: true, configurable: true });
    }
    const saved = (): unknown => JSON.parse(localStorage.getItem('playerVolume') ?? 'null');

    // Autoplay with sound was blocked: the player mutes itself.
    c.showMutedAutoplayPrompt();
    video.muted = true;
    c.onVolumeChange();
    expect(saved()).toBeNull();

    // The user unmutes, then mutes on purpose: both are theirs to keep.
    video.muted = false;
    c.onVolumeChange();
    expect(saved()).toMatchObject({ muted: false });
    video.muted = true;
    c.onVolumeChange();
    expect(saved()).toMatchObject({ muted: true });
    localStorage.removeItem('playerVolume');
});

it('a source waiting for the tap disarms the watchdog until playback starts', () => {
    const c = controller(true);
    Object.defineProperty(c, 'awaitingTapPause', {
        value: false,
        writable: true,
        configurable: true,
    });
    playerStore.setPausedByUser(false);
    c.handleAutoplayResult({
        success: false,
        playingMuted: false,
        policy: 'disallowed',
        awaitingTap: true,
    });
    expect(playerStore.pausedByUser).toBe(true);
    expect(c.awaitingTapPause).toBe(true);
});

it('an ordinary blocked autoplay (desktop) is not recorded as a user pause', () => {
    const c = controller(false);
    Object.defineProperty(c, 'awaitingTapPause', {
        value: false,
        writable: true,
        configurable: true,
    });
    playerStore.setPausedByUser(false);
    c.handleAutoplayResult({ success: false, playingMuted: false, policy: 'disallowed' });
    expect(playerStore.pausedByUser).toBe(false);
    expect(c.awaitingTapPause).toBe(false);
});
