// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const failureLookup = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/livetv-playback.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/api/livetv-playback.js')>()),
    getPlaybackSessionFailure: failureLookup,
}));
import { PlayerController } from './player-controller.svelte';
import { LiveTvStartupDeadline } from './livetv-startup-deadline';
import { playerStore } from './playerStore.svelte';

interface StartupController {
    armLiveTvStartup(): void;
    liveTvStartupCleanup?: () => void;
    liveTvFailure: { type: string; failure?: { code: string } } | null;
    liveTvSessionId: string | null;
    handlePlayError(error: Error): void;
    cleanupBeforeLiveTvNavigation(): Promise<void>;
}
let controller: StartupController;
let video: HTMLVideoElement;
let frames = 0;
let time = 0;
let paused = false;
let seeking = false;
type FrameCallback = Parameters<HTMLVideoElement['requestVideoFrameCallback']>[0];
let present: FrameCallback;

beforeEach(() => {
    vi.useFakeTimers();
    frames = time = 0;
    paused = seeking = false;
    playerStore.pausedByUser = false;
    video = document.createElement('video');
    Object.defineProperties(video, {
        currentTime: { get: () => time },
        paused: { get: () => paused },
        seeking: { get: () => seeking },
        videoWidth: { get: () => 1920 },
    });
    video.getVideoPlaybackQuality = () => ({ totalVideoFrames: frames }) as VideoPlaybackQuality;
    video.requestVideoFrameCallback = (callback) => {
        present = callback;
        return 1;
    };
    video.cancelVideoFrameCallback = vi.fn();
    const target = Object.create(PlayerController.prototype);
    const properties = {
        videoElement: video,
        playbackGeneration: 0,
        liveTvStartupHasProgress: false,
        liveTvStartupDeadline: new LiveTvStartupDeadline(),
        liveTvFailure: null,
        liveTvSessionId: null,
        liveTvCurrentFeedId: undefined,
        playbackManager: { destroy: vi.fn() },
        endCurrentSession: vi.fn().mockResolvedValue(undefined),
        showLiveTvFailure: vi.fn(),
        shouldSuppressErrors: () => false,
        stopAndCleanup: vi.fn(() => new Promise(() => {})),
    };
    for (const [key, value] of Object.entries(properties))
        Object.defineProperty(target, key, { value, writable: true, configurable: true });
    controller = target as StartupController;
});
afterEach(() => {
    controller?.liveTvStartupCleanup?.();
    vi.useRealTimers();
});

describe('startup deadline failure lookup', () => {
    it('asks for the typed reason before the session is ended', async () => {
        const order: string[] = [];
        failureLookup.mockImplementation(async () => {
            order.push('lookup');
            return { code: 'channel_offline', retryable: false };
        });
        const target = controller as unknown as {
            liveTvSessionId: string | null;
            endCurrentSession: ReturnType<typeof vi.fn>;
            showLiveTvFailure: ReturnType<typeof vi.fn>;
        };
        target.liveTvSessionId = 'session-1';
        target.endCurrentSession.mockImplementation(async () => {
            order.push('end');
        });
        controller.armLiveTvStartup();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(order).toEqual(['lookup', 'end']);
        expect(failureLookup).toHaveBeenCalledWith('session-1', expect.any(AbortSignal));
        expect(target.showLiveTvFailure).toHaveBeenCalledWith({
            code: 'channel_offline',
            retryable: false,
        });
    });
});

describe('actual Live TV controller startup event wiring', () => {
    it('currentTime seek and canplay do not count as startup success', async () => {
        controller.armLiveTvStartup();
        seeking = true;
        video.dispatchEvent(new Event('seeking'));
        time = 120;
        video.dispatchEvent(new Event('timeupdate'));
        frames = 1;
        seeking = false;
        video.dispatchEvent(new Event('seeked'));
        video.dispatchEvent(new Event('canplay'));
        await vi.advanceTimersByTimeAsync(25_000);
        expect(controller.liveTvFailure?.type).toBe('connection_lost');
    });
    it('advancing decode clears the deadline even without time progression', async () => {
        controller.armLiveTvStartup();
        frames = 2;
        video.dispatchEvent(new Event('timeupdate'));
        await vi.advanceTimersByTimeAsync(30_000);
        expect(controller.liveTvFailure).toBeNull();
    });
    it('advancing presented frames clear native HLS startup', async () => {
        controller.armLiveTvStartup();
        present(0, { mediaTime: 100 } as Parameters<FrameCallback>[1]);
        present(10, { mediaTime: 101 } as Parameters<FrameCallback>[1]);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(controller.liveTvFailure).toBeNull();
    });
    it('deliberate pause suspends startup and play rearms despite a seeked clock', async () => {
        controller.armLiveTvStartup();
        playerStore.pausedByUser = true;
        paused = true;
        time = 120;
        video.dispatchEvent(new Event('pause'));
        await vi.advanceTimersByTimeAsync(30_000);
        expect(controller.liveTvFailure).toBeNull();
        playerStore.pausedByUser = false;
        paused = false;
        video.dispatchEvent(new Event('play'));
        await vi.advanceTimersByTimeAsync(25_000);
        expect(controller.liveTvFailure?.type).toBe('connection_lost');
    });
    it('browser-required gesture suspends startup until play is requested', async () => {
        controller.armLiveTvStartup();
        const error = new Error('gesture required');
        error.name = 'NotAllowedError';
        controller.handlePlayError(error);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(controller.liveTvFailure).toBeNull();
        video.dispatchEvent(new Event('play'));
        await vi.advanceTimersByTimeAsync(25_000);
        expect(controller.liveTvFailure?.type).toBe('connection_lost');
    });
    it('navigation cleanup completes within one second even when teardown hangs', async () => {
        const done = vi.fn();
        void controller.cleanupBeforeLiveTvNavigation().then(done);
        await vi.advanceTimersByTimeAsync(1000);
        expect(done).toHaveBeenCalledOnce();
    });
});
