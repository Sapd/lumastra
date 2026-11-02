// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebAudioBackend } from './web-audio-backend';
import type { AudioBackendCallbacks, MediaSessionActions } from './types';
import { initMediaSession } from '$lib/utils/media-session';

// Mock AudioContext for happy-dom (which doesn't implement Web Audio API)
const mockGainNode = {
    gain: {
        value: 1,
        cancelScheduledValues: vi.fn(),
        setValueAtTime: vi.fn(),
        setTargetAtTime: vi.fn(),
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
};

const mockSourceNode = {
    connect: vi.fn(),
    disconnect: vi.fn(),
};

class MockAudioContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    createGain(): typeof mockGainNode {
        return { ...mockGainNode, gain: { ...mockGainNode.gain } };
    }
    createMediaElementSource(): typeof mockSourceNode {
        return { ...mockSourceNode };
    }
    createBiquadFilter() {
        return {
            type: 'lowshelf',
            frequency: { value: 0 },
            gain: { value: 0 },
            connect: vi.fn(),
            disconnect: vi.fn(),
        };
    }
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    resume = vi.fn(() => Promise.resolve());
    close = vi.fn(() => Promise.resolve());
}

globalThis.AudioContext = MockAudioContext as unknown as typeof AudioContext;

vi.mock('$lib/utils/crossfade-engine', () => {
    class MockCrossfadeEngine {
        startCrossfade = vi.fn(() => Promise.resolve());
        cancel = vi.fn();
        normalizePlaybackRate = vi.fn();
        destroy = vi.fn();
    }
    return { CrossfadeEngine: MockCrossfadeEngine };
});

vi.mock('$lib/utils/media-session', () => ({
    initMediaSession: vi.fn(),
    updateMediaSessionMetadata: vi.fn(),
    updateMediaSessionPlaybackState: vi.fn(),
    updateMediaSessionPositionState: vi.fn(),
    clearMediaSession: vi.fn(),
}));

vi.mock('$lib/utils/wake-lock', () => ({
    requestWakeLock: vi.fn(),
    releaseWakeLock: vi.fn(),
    setupWakeLockReacquisition: vi.fn(() => () => {}),
    destroyWakeLock: vi.fn(),
}));

vi.mock('$lib/utils/background-playback', () => ({
    createSilentAudioKeepalive: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
    })),
}));

function makeCallbacks(): AudioBackendCallbacks {
    return {
        onTrackEnded: vi.fn(),
        onTimeUpdate: vi.fn(),
        onCrossfadeProgress: vi.fn(),
    };
}

function makeActions(): MediaSessionActions {
    return {
        onPlay: vi.fn(),
        onPause: vi.fn(),
        onNextTrack: vi.fn(),
        onPreviousTrack: vi.fn(),
        onSeekTo: vi.fn(),
        onSeekForward: vi.fn(),
        onSeekBackward: vi.fn(),
        onStop: vi.fn(),
    };
}

describe('WebAudioBackend', () => {
    let backend: WebAudioBackend;

    beforeEach(() => {
        vi.clearAllMocks();
        backend = new WebAudioBackend();
    });

    it('reports crossfade support', () => {
        expect(backend.supportsCrossfade).toBe(true);
    });

    it('reports volume control support', () => {
        expect(backend.supportsVolumeControl).toBe(true);
    });

    it('init is idempotent', () => {
        const callbacks = makeCallbacks();
        const actions = makeActions();
        backend.init(callbacks, actions);
        backend.init(callbacks, actions); // no error
    });

    it('registers music media session with track controls and scrubber seeking', () => {
        const callbacks = makeCallbacks();
        const actions = makeActions();
        backend.init(callbacks, actions);

        const [, registeredActions, options] = vi.mocked(initMediaSession).mock.calls[0];
        expect(registeredActions.onNextTrack).toBe(actions.onNextTrack);
        expect(registeredActions.onPreviousTrack).toBe(actions.onPreviousTrack);
        expect(registeredActions.onSeekTo).toBe(actions.onSeekTo);
        expect(registeredActions.onSeekForward).toBeUndefined();
        expect(registeredActions.onSeekBackward).toBeUndefined();
        expect(options).toEqual({
            trackControlsOnly: true,
            seekToWithTrackControls: true,
        });
    });

    it('re-registers track-only controls with track metadata after play starts', async () => {
        const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
        const callbacks = makeCallbacks();
        const actions = makeActions();

        backend.init(callbacks, actions);
        await backend.play('/api/music/tracks/abc/stream', {
            title: 'Now Playing',
            artist: 'Artist',
            album: 'Album',
            artworkUrl: '/cover.jpg',
        });

        const [metadata, registeredActions, options] = vi
            .mocked(initMediaSession)
            .mock.calls.at(-1)!;
        expect(metadata).toEqual({
            title: 'Now Playing',
            artist: 'Artist',
            album: 'Album',
            artwork: '/cover.jpg',
        });
        expect(registeredActions.onNextTrack).toBe(actions.onNextTrack);
        expect(registeredActions.onPreviousTrack).toBe(actions.onPreviousTrack);
        expect(registeredActions.onSeekTo).toBe(actions.onSeekTo);
        expect(registeredActions.onSeekForward).toBeUndefined();
        expect(registeredActions.onSeekBackward).toBeUndefined();
        expect(options).toEqual({
            trackControlsOnly: true,
            seekToWithTrackControls: true,
        });

        playSpy.mockRestore();
    });

    it('isCrossfading returns false before any playback', () => {
        expect(backend.isCrossfading()).toBe(false);
    });

    it('getCurrentTimeMs returns 0 before playback', () => {
        expect(backend.getCurrentTimeMs()).toBe(0);
    });

    it('getDurationMs returns 0 before playback', () => {
        expect(backend.getDurationMs()).toBe(0);
    });

    it('getPlaybackRate returns 1 before init', () => {
        expect(backend.getPlaybackRate()).toBe(1);
    });

    it('reloadCurrentSrc restores the caller-given position and play state', async () => {
        // Recovering from a failed load (dead AirPlay stream token): after the
        // media error the element's own currentTime/paused no longer say where
        // playback was, so the store passes them explicitly.
        backend.init(makeCallbacks(), makeActions());
        const audio = backend.getAudioElement()!;
        const play = vi.spyOn(audio, 'play').mockResolvedValue(undefined);
        expect(audio.paused).toBe(true);
        const pending = backend.reloadCurrentSrc('/api/v1/music/tracks/a/stream?stream_token=t', {
            positionMs: 42_000,
            resume: true,
        });
        audio.dispatchEvent(new Event('loadedmetadata'));
        expect(await pending).toBe(true);
        expect(audio.src).toContain('stream_token=t');
        expect(audio.currentTime).toBe(42);
        expect(play).toHaveBeenCalledTimes(1);
    });
});
