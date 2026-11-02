// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SafariAudioBackend } from './safari-audio-backend';
import type { AudioBackendCallbacks, MediaSessionActions } from './types';
import { initMediaSession } from '$lib/utils/media-session';

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

describe('SafariAudioBackend', () => {
    let backend: SafariAudioBackend;

    beforeEach(() => {
        vi.clearAllMocks();
        backend = new SafariAudioBackend();
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

    it('destroy cleans up without errors', () => {
        const callbacks = makeCallbacks();
        const actions = makeActions();
        backend.init(callbacks, actions);
        expect(() => backend.destroy()).not.toThrow();
    });

    it('onTrackEnded fires only for active deck', () => {
        const callbacks = makeCallbacks();
        const actions = makeActions();
        backend.init(callbacks, actions);

        // Deck B is inactive — its ended event should NOT fire onTrackEnded
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const deckB = (backend as any).deckB as HTMLAudioElement;
        deckB.dispatchEvent(new Event('ended'));
        expect(callbacks.onTrackEnded).not.toHaveBeenCalled();

        // Deck A is active by default — its ended event should fire onTrackEnded
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const deckA = (backend as any).deckA as HTMLAudioElement;
        deckA.dispatchEvent(new Event('ended'));
        expect(callbacks.onTrackEnded).toHaveBeenCalledOnce();
    });

    it('cancelCrossfade sets isCrossfading to false', () => {
        const callbacks = makeCallbacks();
        const actions = makeActions();
        backend.init(callbacks, actions);

        // Simulate crossfade in progress
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (backend as any)._isCrossfading = true;
        backend.cancelCrossfade();
        expect(backend.isCrossfading()).toBe(false);
    });

    it('triggerCrossfade swaps active deck after completion', async () => {
        const callbacks = makeCallbacks();
        const actions = makeActions();
        backend.init(callbacks, actions);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((backend as any).activeDeck).toBe('A');

        // Simulate post-crossfade swap
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (backend as any)._isCrossfading = true;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (backend as any).activeDeck = 'B';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((backend as any).activeDeck).toBe('B');
    });

    it('keeps fading in a hidden tab, where requestAnimationFrame never fires', async () => {
        // Before: the fade only advanced on rAF, so a background tab left the
        // incoming deck silent until the fallback timer hard-swapped at the end.
        backend.init(makeCallbacks(), makeActions());
        vi.useFakeTimers();
        vi.stubGlobal(
            'requestAnimationFrame',
            vi.fn(() => 1),
        );
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        try {
            const from = { volume: 1 } as HTMLAudioElement;
            const to = { volume: 0 } as HTMLAudioElement;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const fade = (backend as any).animateCrossfade(
                from,
                to,
                4000,
                1,
                8,
                1,
            ) as Promise<void>;

            await vi.advanceTimersByTimeAsync(2000);
            // Midway: both decks audible — not the old "outgoing full, incoming silent".
            expect(to.volume).toBeGreaterThan(0.2);
            expect(from.volume).toBeLessThan(0.95);

            await vi.advanceTimersByTimeAsync(2300);
            await fade;
            expect(from.volume).toBe(0);
            expect(to.volume).toBe(1);
        } finally {
            delete (document as { hidden?: boolean }).hidden;
            vi.unstubAllGlobals();
            vi.useRealTimers();
        }
    });

    it("hide mid-fade drops the queued frame, and a cancelled fade's stray tick does nothing", async () => {
        // Before: the frame queued while visible survived the hide and fired on
        // show next to the new one (two tick chains), and cancel left a chain
        // alive that kept driving the decks along the old curve.
        backend.init(makeCallbacks(), makeActions());
        const frames: Array<(t: number) => void> = [];
        vi.stubGlobal(
            'requestAnimationFrame',
            vi.fn((cb: (t: number) => void) => frames.push(cb)),
        );
        const cancelRaf = vi.fn();
        vi.stubGlobal('cancelAnimationFrame', cancelRaf);
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        try {
            const from = { volume: 1 } as HTMLAudioElement;
            const to = { volume: 0 } as HTMLAudioElement;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            void (backend as any).animateCrossfade(from, to, 4000, 1, 8, 1);
            expect(frames).toHaveLength(1);

            Object.defineProperty(document, 'hidden', { configurable: true, value: true });
            document.dispatchEvent(new Event('visibilitychange'));
            expect(cancelRaf).toHaveBeenCalledWith(1);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (backend as any).cancelCrossfadeAnimation();
            to.volume = 0.42;
            frames[0](performance.now() + 2000); // the stale queued frame fires anyway
            expect(to.volume).toBe(0.42);
        } finally {
            delete (document as { hidden?: boolean }).hidden;
            vi.unstubAllGlobals();
        }
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
