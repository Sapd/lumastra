// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlainAudioBackend } from './plain-audio-backend';
import type { AudioBackendCallbacks, MediaSessionActions } from './types';
import { initMediaSession, updateMediaSessionPositionState } from '$lib/utils/media-session';

// Mock the media-session module
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

describe('PlainAudioBackend', () => {
    let backend: PlainAudioBackend;
    let callbacks: AudioBackendCallbacks;
    let actions: MediaSessionActions;

    beforeEach(() => {
        vi.clearAllMocks();
        backend = new PlainAudioBackend();
        callbacks = makeCallbacks();
        actions = makeActions();
    });

    it('reports no crossfade support', () => {
        expect(backend.supportsCrossfade).toBe(false);
    });

    it('reports no volume control', () => {
        expect(backend.supportsVolumeControl).toBe(false);
    });

    it('isCrossfading always returns false', () => {
        expect(backend.isCrossfading()).toBe(false);
    });

    it('init is idempotent', () => {
        backend.init(callbacks, actions);
        backend.init(callbacks, actions); // no error
    });

    it('registers iOS media session with track controls and scrubber seeking', () => {
        backend.init(callbacks, actions);

        expect(initMediaSession).toHaveBeenCalledWith(
            { title: 'Lumastra Music', artist: '' },
            expect.objectContaining({
                onPlay: actions.onPlay,
                onPause: actions.onPause,
                onNextTrack: actions.onNextTrack,
                onPreviousTrack: actions.onPreviousTrack,
                onSeekTo: actions.onSeekTo,
                onStop: actions.onStop,
            }),
            { trackControlsOnly: true, seekToWithTrackControls: true },
        );
        const [, registeredActions, options] = vi.mocked(initMediaSession).mock.calls[0];
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

    it('reloadCurrentSrc does not restore onto a src loaded after it', async () => {
        // AirPlay bounds this reload with a timeout; a skip in that window must
        // not be seeked/resumed to the reloaded track's position when the late
        // loadedmetadata finally fires.
        backend.init(callbacks, actions);
        const audio = backend.getAudioElement()!;
        const pending = backend.reloadCurrentSrc('/api/v1/music/tracks/a/stream?stream_token=t');
        audio.src = '/api/music/tracks/b/stream';
        audio.dispatchEvent(new Event('loadedmetadata'));
        expect(await pending).toBe(false);
    });

    it('triggerCrossfade switches track instantly', async () => {
        backend.init(callbacks, actions);
        // triggerCrossfade should resolve without error
        await backend.triggerCrossfade(
            '/api/music/tracks/abc/stream',
            { title: 'Next Track', artist: 'Artist' },
            { fadeMode: 'echo', beats: 16 }, // all options silently ignored
        );
        // Should resolve instantly (no actual crossfade)
    });

    it('setVolume is a no-op', () => {
        backend.init(callbacks, actions);
        // Should not throw
        backend.setVolume(0.5);
    });

    it('getCurrentTimeMs returns 0 before playback', () => {
        backend.init(callbacks, actions);
        expect(backend.getCurrentTimeMs()).toBe(0);
    });

    it('getDurationMs returns 0 before playback', () => {
        backend.init(callbacks, actions);
        expect(backend.getDurationMs()).toBe(0);
    });

    it('getPlaybackRate returns 1 before playback', () => {
        backend.init(callbacks, actions);
        expect(backend.getPlaybackRate()).toBe(1);
    });

    it('destroy cleans up resources', () => {
        backend.init(callbacks, actions);
        backend.destroy();
        // After destroy, getCurrentTimeMs should return 0 (audio is null)
        expect(backend.getCurrentTimeMs()).toBe(0);
    });

    it('re-registers track-only media session controls after stop', () => {
        backend.init(callbacks, actions);
        backend.stop();

        const [, registeredActions, options] = vi.mocked(initMediaSession).mock.calls.at(-1)!;
        expect(registeredActions.onNextTrack).toBe(actions.onNextTrack);
        expect(registeredActions.onPreviousTrack).toBe(actions.onPreviousTrack);
        expect(registeredActions.onSeekTo).toBe(actions.onSeekTo);
        expect(registeredActions.onSeekForward).toBeUndefined();
        expect(registeredActions.onSeekBackward).toBeUndefined();
        expect(options).toEqual({
            trackControlsOnly: true,
            seekToWithTrackControls: true,
        });
        expect(updateMediaSessionPositionState).not.toHaveBeenCalled();
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
