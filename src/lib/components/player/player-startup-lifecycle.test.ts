// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayerController } from './player-controller.svelte';
import { playerStore } from './playerStore.svelte';
import { ReconnectController } from './reconnect-controller';
import { RECONNECT_TUNING } from './reconnect-policy';
import { IncidentReporter } from './incident-reporter';
import { IncidentRingBuffer } from './incident-buffer';
import { createPlaybackManager } from './playback-manager';

/** Real event methods, without mounting the unrelated UI/effects constructor. */
function eventController(fields: Record<string, unknown>): PlayerController {
    const controller = Object.create(PlayerController.prototype) as PlayerController;
    for (const [key, value] of Object.entries(fields)) {
        Object.defineProperty(controller, key, { value, writable: true, configurable: true });
    }
    return controller;
}

afterEach(() => {
    playerStore.reset();
    vi.useRealTimers();
});

describe('player startup event wiring', () => {
    it('arms recovery on play even when playing never fires', () => {
        vi.useFakeTimers();
        const video = document.createElement('video');
        Object.defineProperty(video, 'paused', { value: false });
        const reconnect = new ReconnectController({
            schedule: (fn, ms) => {
                const timer = setTimeout(fn, ms);
                return () => clearTimeout(timer);
            },
            attemptRecovery: vi.fn(),
            onStateChange: vi.fn(),
            canRecoverStartup: () => video.paused === false,
        });
        const controller = eventController({
            videoElement: video,
            reconnect,
            isRestartingPlayback: false,
            suppressErrorsDuringRestart: false,
            incidentBuffer: undefined,
            subtitleRenderer: undefined,
            hasEnded: true,
            isInitialized: true,
            mediaSessionCtrl: { updatePlaybackState: vi.fn() },
            reportProgress: vi.fn(),
        });
        controller.onPlay();
        vi.advanceTimersByTime(RECONNECT_TUNING.startupTimeoutMs - 1);
        expect(reconnect.getState()).toBe('connected');
        vi.advanceTimersByTime(1);
        expect(reconnect.getState()).toBe('recovering');
        reconnect.destroy();
    });

    it('captures the native error and original media state before fallback replaces them', () => {
        const video = document.createElement('video');
        video.src = 'https://example.test/stream.mp4';
        video.currentTime = 1205.25;
        Object.defineProperty(video, 'error', { value: { code: 3, message: 'decode failed' } });
        Object.defineProperty(video, 'webkitDecodedFrameCount', { value: 0 });
        const post = vi.fn().mockResolvedValue(undefined);
        const controller = eventController({
            videoElement: video,
            reconnect: undefined,
            isRestartingPlayback: false,
            suppressErrorsDuringRestart: false,
            directPlayFailed: false,
            recoverTokenizedSource: vi.fn().mockReturnValue(false),
            checkForLostBrowserSession: vi.fn(),
            fallbackToHlsTranscoding: vi.fn(() => {
                video.currentTime = 0;
            }),
        });
        const reporter = new IncidentReporter({
            attemptId: 'native-startup',
            deviceId: 'test-device',
            buffer: new IncidentRingBuffer({ maxEntries: 120, maxAgeMs: 90000 }),
            clientInfo: () => ({ media: controller.getMediaSnapshot() }),
            post,
            patchResolve: vi.fn().mockResolvedValue(undefined),
            beacon: vi.fn(),
        });
        Object.defineProperty(controller, 'incidentReporter', { value: reporter });
        playerStore.setPlaySessionId('failed-session');
        controller.onError();
        expect(video.currentTime).toBe(0);
        // A native failure has no status: it asks whether the session is gone.
        expect(
            (controller as unknown as { checkForLostBrowserSession: ReturnType<typeof vi.fn> })
                .checkForLostBrowserSession,
        ).toHaveBeenCalledWith('native-error');
        expect(post).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                playSessionId: 'failed-session',
                errorType: 'decode',
                message: 'decode failed',
                clientInfo: {
                    media: expect.objectContaining({
                        currentTime: 1205.25,
                        decodedFrames: 0,
                        error: { code: 3, message: 'decode failed' },
                    }),
                },
            }),
        );
    });

    /** onError fixture whose collaborators record every reaction to an error. */
    function errorController(video: HTMLVideoElement): {
        controller: PlayerController;
        post: ReturnType<typeof vi.fn>;
        probe: ReturnType<typeof vi.fn>;
        fallback: ReturnType<typeof vi.fn>;
    } {
        Object.defineProperty(video, 'error', {
            configurable: true,
            get: () => ({ code: 4, message: 'Empty src attribute' }),
        });
        const post = vi.fn().mockResolvedValue(undefined);
        const probe = vi.fn();
        const fallback = vi.fn();
        const controller = eventController({
            videoElement: video,
            reconnect: undefined,
            isRestartingPlayback: false,
            suppressErrorsDuringRestart: false,
            directPlayFailed: false,
            recoverTokenizedSource: vi.fn().mockReturnValue(false),
            checkForLostBrowserSession: probe,
            fallbackToHlsTranscoding: fallback,
            log: vi.fn(),
        });
        const reporter = new IncidentReporter({
            attemptId: 'teardown',
            deviceId: 'test-device',
            buffer: new IncidentRingBuffer({ maxEntries: 120, maxAgeMs: 90000 }),
            clientInfo: () => ({}),
            post,
            patchResolve: vi.fn().mockResolvedValue(undefined),
            beacon: vi.fn(),
        });
        Object.defineProperty(controller, 'incidentReporter', { value: reporter });
        playerStore.setPlaySessionId('closing-session');
        return { controller, post, probe, fallback };
    }

    it('a media error after PlaybackManager.destroy() is no incident and no auth probe', () => {
        const video = document.createElement('video');
        video.src = 'https://example.test/hls/master.m3u8';
        const manager = createPlaybackManager({
            videoElement: video,
            isSafari: true,
            isLive: false,
            autoPlay: false,
            mightBeInWatchParty: () => false,
            isInWatchParty: () => false,
            log: () => {},
            events: { onError: vi.fn() },
        });
        manager.destroy();
        // destroy() must not leave an empty src (WebKit reports MediaError 4 for it).
        expect(video.hasAttribute('src')).toBe(false);

        const { controller, post, probe, fallback } = errorController(video);
        // WebKit's late 'error' event from the teardown load() reaching onerror.
        controller.onError();
        expect(post).not.toHaveBeenCalled();
        expect(probe).not.toHaveBeenCalled();
        expect(fallback).not.toHaveBeenCalled();
    });

    it('a media error from an element left with src="" is ignored too', () => {
        const video = document.createElement('video');
        video.setAttribute('src', '');
        const { controller, post, probe } = errorController(video);
        controller.onError();
        expect(post).not.toHaveBeenCalled();
        expect(probe).not.toHaveBeenCalled();
    });

    it('a media error on an hls.js <source>-child attachment (no src attribute) still reports', () => {
        // hls.js appendSource (ManagedMediaSource on iOS) leaves src unset and
        // attaches the blob URL through a <source> child.
        const video = document.createElement('video');
        const source = document.createElement('source');
        source.src = 'blob:https://example.test/mms';
        video.appendChild(source);
        const { controller, post, probe } = errorController(video);
        controller.onError();
        expect(post).toHaveBeenCalledOnce();
        expect(probe).toHaveBeenCalledWith('native-error');
    });

    it('a media error before teardown still reports and probes the session', () => {
        const video = document.createElement('video');
        video.src = 'https://example.test/hls/master.m3u8';
        const { controller, post, probe, fallback } = errorController(video);
        controller.onError();
        expect(post).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ playSessionId: 'closing-session', errorType: 'media' }),
        );
        expect(probe).toHaveBeenCalledWith('native-error');
        expect(fallback).toHaveBeenCalledOnce();
    });

    it('ignores late source events after terminal teardown', () => {
        const controller = eventController({
            reconnect: { getState: () => 'terminal' },
            isRestartingPlayback: false,
            suppressErrorsDuringRestart: false,
            incidentBuffer: undefined,
            videoElement: undefined,
            applyPlaybackResumedReset: vi.fn(),
            checkForLostBrowserSession: vi.fn(),
            log: vi.fn(),
        });
        playerStore.setError('Recovery exhausted');
        playerStore.setPlaying(false);
        controller.onPlay();
        controller.onPlaying();
        controller.onTimeUpdate();
        controller.onError();
        expect(playerStore.error).toBe('Recovery exhausted');
        expect(playerStore.isPlaying).toBe(false);
    });

    it('does not stop a replacement item after the outgoing telemetry flush finishes', async () => {
        let release: () => void = () => {};
        let current = true;
        const reportProgress = vi.fn();
        const controller = eventController({
            destroyTelemetry: () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
            reportProgress,
        });
        const pending = controller.endCurrentSession('switch', () => current);
        current = false;
        release();
        await pending;
        expect(reportProgress).not.toHaveBeenCalled();
    });
});
