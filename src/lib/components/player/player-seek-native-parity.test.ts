// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlaybackManager } from './playback-manager';
import { PlayerController } from './player-controller.svelte';
import { playerStore } from './playerStore.svelte';
import { watchTogether } from '$lib/stores/watchTogether.svelte';
import { serverCapabilities } from '$lib/stores/server-capabilities.store';
import type { SubtitleRendererConfig } from './subtitle-renderer';

function seekController({
    native = true,
    hls = true,
    directStream = true,
    paused = false,
    buffered = false,
    party = false,
    guest = false,
    method = 'remux',
} = {}): {
    controller: PlayerController;
    video: HTMLVideoElement;
    setTime: ReturnType<typeof vi.fn>;
    setSource: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    restart: ReturnType<typeof vi.fn>;
} {
    const video = document.createElement('video');
    let currentTime = 10;
    const setTime = vi.fn((time: number) => {
        currentTime = time;
    });
    const setSource = vi.fn();
    Object.defineProperties(video, {
        currentTime: { get: () => currentTime, set: setTime },
        src: { get: () => 'https://example.test/master.m3u8', set: setSource },
        paused: { value: paused, configurable: true },
        buffered: { value: { length: buffered ? 1 : 0, start: () => 0, end: () => 900 } },
    });
    vi.spyOn(video, 'pause').mockImplementation(() => {});
    vi.spyOn(video, 'play').mockResolvedValue(undefined);
    vi.spyOn(video, 'load').mockImplementation(() => {});
    const reset = vi.fn();
    const restart = vi.fn();
    const controller = Object.create(PlayerController.prototype) as PlayerController;
    const fields = {
        videoElement: video,
        playbackManager: {
            isHlsMode: () => hls,
            isNativeEngine: () => native,
            getHls: () => null,
            resetForSeek: reset,
            recoverNativePartySeekBurst: vi.fn(),
        },
        isDirectStreamMode: directStream,
        lumastraPlayMethod: method,
        canSyncToWatchParty: party,
        isWatchPartyGuest: guest,
        telemetryCtrl: { seekStartPosition: 0 },
        restartStreamAtPosition: restart,
        log: vi.fn(),
        warn: vi.fn(),
        DEBUG: false,
    };
    for (const [key, value] of Object.entries(fields)) {
        Object.defineProperty(controller, key, { value, writable: true, configurable: true });
    }
    playerStore.duration = 1000;
    playerStore.currentTime = 10;
    return { controller, video, setTime, setSource, reset, restart };
}

beforeEach(() => {
    vi.useFakeTimers();
});
afterEach(() => {
    playerStore.reset();
    watchTogether.session = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('real player controller seek engine routing', () => {
    it.each(['host', 'guest'] as const)(
        'adopts native burst recovery through the real %s controller path',
        async (role) => {
            const { controller, video, setSource } = seekController({
                party: role === 'host',
                guest: role === 'guest',
                paused: role === 'guest',
            });
            let paused = role === 'guest';
            Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
            vi.mocked(video.pause).mockImplementation(() => {
                paused = true;
            });
            const manager = createPlaybackManager({
                videoElement: video,
                isSafari: true,
                isLive: false,
                autoPlay: false,
                mightBeInWatchParty: () => true,
                isInWatchParty: () => true,
                log: () => {},
                events: {},
            });
            const internals = manager as unknown as {
                currentMode: string;
                currentUrl: string;
                usingNativeHls: boolean;
            };
            internals.currentMode = 'hls';
            internals.currentUrl = 'https://example.test/master.m3u8';
            internals.usingNativeHls = true;
            controller.playbackManager = manager;
            vi.spyOn(watchTogether, 'broadcastSeek').mockResolvedValue(undefined);
            vi.spyOn(watchTogether, 'seekResumeIntent').mockReturnValue(role === 'host');
            for (const target of [20, 30, 40])
                controller.seekTo(
                    target,
                    role === 'host',
                    role === 'host' ? 'seekTo' : 'watch_party_seek',
                );
            expect(setSource).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(250);
            expect(setSource).toHaveBeenCalledWith(expect.stringContaining('seek=40'));
            video.dispatchEvent(new Event('loadedmetadata'));
            expect(video.currentTime).toBe(40);
            expect(video.play).not.toHaveBeenCalled();
            manager.destroy(true);
        },
    );

    it('resolves the subtitle clock after engine selection and on subsequent engine changes', async () => {
        const { controller } = seekController();
        let finishCapabilities!: () => void;
        vi.spyOn(serverCapabilities, 'fetch').mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    finishCapabilities = resolve;
                }),
        );
        Object.defineProperty(controller, 'props', { value: {} });
        Object.defineProperty(controller, 'playbackGeneration', { value: 0, writable: true });
        controller.playbackManager = null;
        const setup = controller.setupSubtitleAndProgressReporter();
        const config = (
            controller.subtitleRenderer as unknown as { config: SubtitleRendererConfig }
        ).config;
        expect(config.useFrameAwareSync?.()).toBe(true);
        let native = true;
        controller.playbackManager = {
            isNativeEngine: () => native,
        } as NonNullable<PlayerController['playbackManager']>;
        expect(config.useFrameAwareSync?.()).toBe(false);
        native = false;
        expect(config.useFrameAwareSync?.()).toBe(true);
        // Finish the unrelated async setup through its existing stale-generation guard.
        Object.defineProperty(controller, 'playbackGeneration', { value: 1 });
        finishCapabilities();
        await setup;
        controller.subtitleRenderer?.disposeAll();
    });

    it.each([
        { paused: true, readyState: 4, buffering: false },
        { paused: true, readyState: 2, buffering: false },
        { paused: true, readyState: 1, buffering: true },
        { paused: false, readyState: 4, buffering: true },
    ])(
        'finishes a paused seek only with a decoded frame ($paused, ready=$readyState)',
        ({ paused, readyState, buffering }) => {
            // happy-dom does not expose the standard media readiness constants.
            vi.stubGlobal(
                'HTMLMediaElement',
                class extends HTMLMediaElement {
                    static readonly HAVE_CURRENT_DATA = 2;
                },
            );
            const { controller, video } = seekController({ paused });
            Object.defineProperty(video, 'readyState', { value: readyState });
            Object.defineProperties(controller, {
                telemetryCtrl: { value: { seekStartPosition: null } },
                abrCtrl: { value: { clearSamples: vi.fn() } },
                writeResumeCache: { value: vi.fn() },
            });
            playerStore.setSeeking(true);
            playerStore.setBuffering(true);
            playerStore.setLoading(true);

            controller.onSeeked();

            expect(playerStore.isSeeking).toBe(false);
            expect(playerStore.isBuffering).toBe(buffering);
            expect(playerStore.isLoading).toBe(buffering);
            expect(video.play).not.toHaveBeenCalled();
            expect(video.pause).not.toHaveBeenCalled();
            vi.clearAllTimers();
        },
    );

    it.each(['remux', 'audio_transcode'])(
        'native %s seeks once without source or play-state interruption',
        (method) => {
            const { controller, video, setTime, setSource, reset, restart } = seekController({
                method,
            });
            controller.seekTo(700);
            expect(setTime).toHaveBeenCalledExactlyOnceWith(700);
            expect(setSource).not.toHaveBeenCalled();
            expect(reset).not.toHaveBeenCalled();
            expect(restart).not.toHaveBeenCalled();
            expect(video.load).not.toHaveBeenCalled();
            expect(video.pause).not.toHaveBeenCalled();
            expect(video.play).not.toHaveBeenCalled();
            expect(playerStore.currentTime).toBe(700);
        },
    );

    it('preserves a paused native seek', () => {
        const { controller, video, setTime, reset } = seekController({ paused: true });
        controller.seekTo(700);
        expect(setTime).toHaveBeenCalledExactlyOnceWith(700);
        expect(reset).not.toHaveBeenCalled();
        expect(video.play).not.toHaveBeenCalled();
        expect(video.pause).not.toHaveBeenCalled();
    });

    it('still resets HLS.js outside the buffer even while its instance is being replaced', () => {
        const { controller, setTime, reset, restart } = seekController({ native: false });
        controller.seekTo(700);
        expect(setTime).toHaveBeenCalledExactlyOnceWith(700);
        expect(reset).toHaveBeenCalledExactlyOnceWith(700, false, false);
        expect(setTime.mock.invocationCallOrder[0]).toBeLessThan(reset.mock.invocationCallOrder[0]);
        expect(restart).not.toHaveBeenCalled();
    });

    it('does not reset HLS.js for an already buffered target', () => {
        const { controller, setTime, reset } = seekController({ native: false, buffered: true });
        controller.seekTo(700);
        expect(setTime).toHaveBeenCalledExactlyOnceWith(700);
        expect(reset).not.toHaveBeenCalled();
    });

    it('still restarts a non-HLS DirectStream outside the buffer', () => {
        const { controller, setTime, reset, restart } = seekController({
            native: false,
            hls: false,
        });
        controller.seekTo(700);
        expect(restart).toHaveBeenCalledExactlyOnceWith(700);
        expect(setTime).not.toHaveBeenCalled();
        expect(reset).not.toHaveBeenCalled();
    });

    it.each(['native', 'hls.js', 'direct'] as const)(
        'the watch-party barrier keeps resume ownership for %s',
        (engine) => {
            watchTogether.session = { code: 'seek-party' } as NonNullable<
                typeof watchTogether.session
            >;
            vi.spyOn(watchTogether, 'seekResumeIntent').mockReturnValue(true);
            const broadcast = vi.spyOn(watchTogether, 'broadcastSeek').mockResolvedValue(undefined);
            const { controller, video, setTime, reset, restart } = seekController({
                party: true,
                native: engine === 'native',
                hls: engine !== 'direct',
            });
            controller.seekTo(700);
            expect(video.pause).toHaveBeenCalledOnce();
            expect(video.play).not.toHaveBeenCalled();
            expect(broadcast).toHaveBeenCalledExactlyOnceWith(700, true);
            if (engine === 'native') {
                expect(setTime).toHaveBeenCalledExactlyOnceWith(700);
                expect(reset).not.toHaveBeenCalled();
            }
            if (engine === 'hls.js')
                expect(reset).toHaveBeenCalledExactlyOnceWith(700, false, true);
            if (engine === 'direct') expect(restart).toHaveBeenCalledExactlyOnceWith(700);
        },
    );

    it('broadcasts paused intent for a paused host', () => {
        vi.spyOn(watchTogether, 'seekResumeIntent').mockReturnValue(false);
        const broadcast = vi.spyOn(watchTogether, 'broadcastSeek').mockResolvedValue(undefined);
        const { controller, video } = seekController({ party: true, paused: true });
        controller.seekTo(700);
        expect(broadcast).toHaveBeenCalledExactlyOnceWith(700, false);
        expect(video.play).not.toHaveBeenCalled();
    });

    it('blocks guest timeline seeks and permits authorized synchronization', () => {
        const { controller, setTime, reset, restart } = seekController({ guest: true });
        controller.seekTo(700);
        expect(setTime).not.toHaveBeenCalled();
        expect(reset).not.toHaveBeenCalled();
        expect(restart).not.toHaveBeenCalled();
        controller.seekTo(700, false, 'watch_party_sync');
        expect(setTime).toHaveBeenCalledExactlyOnceWith(700);
    });
});
