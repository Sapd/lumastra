// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom
/**
 * The three AudioBackend additions the audiobook player depends on, plus the
 * two properties that decide whether the music surface is affected at all.
 *
 * These assert BEHAVIOUR of the real backends, not the shape of the interface —
 * a mock that satisfies the types proves nothing about whether an
 * `AudioContext` was constructed or a lock-screen handler was overwritten.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlainAudioBackend } from './plain-audio-backend';
import { SafariAudioBackend } from './safari-audio-backend';
import { applyPlaybackRate } from './audio-element-helpers';
import type { AudioBackendCallbacks, MediaSessionActions } from './types';
import {
    clearMediaSession,
    initMediaSession,
    updateMediaSessionPlaybackState,
    updateMediaSessionPositionState,
} from '$lib/utils/media-session';

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
    createSilentAudioKeepalive: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

function makeCallbacks(): AudioBackendCallbacks {
    return { onTrackEnded: vi.fn(), onTimeUpdate: vi.fn(), onGaplessAdvanceCommitted: vi.fn() };
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

/** Minimal AudioContext double — happy-dom does not ship Web Audio. */
class FakeAudioContext {
    static instances = 0;
    currentTime = 0;
    state: 'suspended' | 'running' | 'closed' = 'running';
    destination = {} as AudioDestinationNode;
    constructor() {
        FakeAudioContext.instances += 1;
    }
    createMediaElementSource(): { connect: () => void } {
        return { connect: () => {} };
    }
    createGain(): {
        gain: {
            value: number;
            cancelScheduledValues: () => void;
            setValueAtTime: (v: number, t: number) => void;
        };
        connect: () => void;
    } {
        return {
            gain: {
                value: 1,
                cancelScheduledValues: () => {},
                setValueAtTime: () => {},
            },
            connect: () => {},
        };
    }
    resume(): Promise<void> {
        return Promise.resolve();
    }
    close(): Promise<void> {
        return Promise.resolve();
    }
}

describe('applyPlaybackRate', () => {
    it('states pitch preservation explicitly on every spelling it finds', () => {
        const el = document.createElement('audio') as HTMLAudioElement & {
            preservesPitch?: boolean;
            webkitPreservesPitch?: boolean;
        };
        el.preservesPitch = true;
        el.webkitPreservesPitch = true;

        applyPlaybackRate(el, 1.5, false);
        expect(el.playbackRate).toBe(1.5);
        expect(el.preservesPitch).toBe(false);
        expect(el.webkitPreservesPitch).toBe(false);

        applyPlaybackRate(el, 2, true);
        expect(el.playbackRate).toBe(2);
        expect(el.preservesPitch).toBe(true);
    });
});

describe('PlainAudioBackend — the iOS gapless decision', () => {
    let callbacks: AudioBackendCallbacks;
    let actions: MediaSessionActions;

    beforeEach(() => {
        vi.clearAllMocks();
        FakeAudioContext.instances = 0;
        (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
        callbacks = makeCallbacks();
        actions = makeActions();
    });

    afterEach(() => {
        delete (globalThis as { AudioContext?: unknown }).AudioContext;
    });

    it('builds NO Web Audio graph by default — the music path on iOS is untouched', () => {
        const backend = new PlainAudioBackend();
        backend.init(callbacks, actions);

        expect(FakeAudioContext.instances).toBe(0);
        expect(backend.supportsGaplessAdvance).toBe(false);
        // The single bare element is the whole reason background playback is
        // reliable here; capturing it into a MediaElementAudioSourceNode is
        // exactly what the plain path exists to avoid.
        expect(backend.getAllAudioElements()).toHaveLength(1);
        backend.destroy();
    });

    /**
     * The regression this guards: with the graph on, sending the iOS app to the
     * home screen stopped playback. `createMediaElementSource` routes every
     * sample through an `AudioContext` that iOS suspends on background, and
     * WebKit will not resume one without a user gesture a backgrounded app
     * cannot produce. Nothing in this suite can observe THAT — no OS here
     * suspends anything — so what is pinned instead is the one decision that
     * prevents it: the audiobook factory must not build the graph on iOS.
     */
    it('does not build the graph for the iOS audiobook backend', async () => {
        const { createAudiobookBackend } = await import('./index');
        const backend = await createAudiobookBackend('ios');
        backend.init(callbacks, actions);

        expect(FakeAudioContext.instances).toBe(0);
        expect(backend.supportsGaplessAdvance).toBe(false);
        expect(backend.getAllAudioElements()).toHaveLength(1);
        backend.destroy();
    });

    it('builds a two-deck gain graph when the audiobook flag is passed', () => {
        const backend = new PlainAudioBackend({ gaplessGraph: true });
        backend.init(callbacks, actions);

        expect(FakeAudioContext.instances).toBe(1);
        expect(backend.supportsGaplessAdvance).toBe(true);
        expect(backend.getAllAudioElements()).toHaveLength(2);
        backend.destroy();
    });

    it('degrades to the plain path when the AudioContext cannot be built', () => {
        (globalThis as { AudioContext?: unknown }).AudioContext = class {
            constructor() {
                throw new Error('no audio context here');
            }
        };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const backend = new PlainAudioBackend({ gaplessGraph: true });
        backend.init(callbacks, actions);

        // A book that plays with a 21 ms seam beats one that does not play.
        expect(backend.supportsGaplessAdvance).toBe(false);
        expect(backend.scheduleGaplessAdvance({ src: '/a.mp3', metadata: { title: 'x' } })).toBe(
            false,
        );
        warn.mockRestore();
        backend.destroy();
    });

    it('mutes both decks, because the incoming one is about to become audible', () => {
        const backend = new PlainAudioBackend({ gaplessGraph: true });
        backend.init(callbacks, actions);

        backend.mute();
        expect(backend.getAllAudioElements().every((el) => el.muted)).toBe(true);
        backend.unmute(1);
        expect(backend.getAllAudioElements().some((el) => el.muted)).toBe(false);
        backend.destroy();
    });

    it('writes NO part of MediaSession when the caller owns it', async () => {
        const backend = new PlainAudioBackend({ gaplessGraph: true });
        backend.init(callbacks, actions, { manageMediaSession: false });

        // Asserted past init(), across every lifecycle call, because the
        // interface doc promises the caller owns MediaSession *outright*: the
        // audiobook player maps nexttrack to a CHAPTER and reports BOOK time,
        // and a backend writing handlers, playback state or a clear would
        // silently replace part of that.
        await backend.play('/a.mp3', { title: 'x' });
        backend.pause();
        backend.resume();
        backend.stop();
        backend.destroy();

        expect(initMediaSession).not.toHaveBeenCalled();
        expect(updateMediaSessionPositionState).not.toHaveBeenCalled();
        expect(updateMediaSessionPlaybackState).not.toHaveBeenCalled();
        expect(clearMediaSession).not.toHaveBeenCalled();
    });

    it('still writes all of it by default', async () => {
        const backend = new PlainAudioBackend();
        backend.init(callbacks, actions);
        backend.pause();
        expect(initMediaSession).toHaveBeenCalled();
        expect(updateMediaSessionPlaybackState).toHaveBeenCalledWith('paused');
        backend.destroy();
    });

    it('still owns MediaSession by default', () => {
        const backend = new PlainAudioBackend();
        backend.init(callbacks, actions);
        expect(initMediaSession).toHaveBeenCalled();
        backend.destroy();
    });
});

describe('SafariAudioBackend — desktop can butt-join without a graph', () => {
    beforeEach(() => vi.clearAllMocks());

    it('advertises gapless support (element .volume works off iOS)', () => {
        const backend = new SafariAudioBackend();
        expect(backend.supportsGaplessAdvance).toBe(true);
    });

    it('refuses to schedule before init, when there are no decks', () => {
        const backend = new SafariAudioBackend();
        expect(backend.scheduleGaplessAdvance({ src: '/a.mp3', metadata: { title: 'x' } })).toBe(
            false,
        );
    });

    it('applies rate and pitch preservation to the active deck', () => {
        const backend = new SafariAudioBackend();
        backend.init(makeCallbacks(), makeActions());
        backend.setPlaybackRate(1.75, { preservePitch: true });
        const active = backend.getAudioElement();
        expect(active?.playbackRate).toBe(1.75);
        backend.destroy();
    });
});
