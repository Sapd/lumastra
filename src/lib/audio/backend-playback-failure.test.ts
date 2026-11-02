// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom
/**
 * A stream that fails to load or decode must reach the caller, on every
 * backend.
 *
 * Browsers report a failed track in two ways, and the backends swallowed both:
 *
 * - `play()` REJECTS. An HTTP 415/500/503, a network error before any data,
 *   or a body no decoder accepts runs the media element's "dedicated media
 *   source failure steps": `error` becomes a `MediaError` with code 4
 *   (`MEDIA_ERR_SRC_NOT_SUPPORTED`), an `error` event fires, and the pending
 *   play promise rejects with `NotSupportedError`.
 * - An `error` EVENT fires with no rejection. A network or decode failure
 *   after metadata (codes 2 and 3) fires the event but does not reject pending
 *   play promises, so a `play()` still waiting for data never settles, and one
 *   that already resolved has nothing left to reject.
 *
 * happy-dom loads nothing and implements no media pipeline, so these fakes
 * reproduce what the browser does at the element: set `error`, dispatch
 * `error`, and settle (or not) the play promise. They cannot prove which HTTP
 * status maps to which code in a given engine; that mapping is the browser's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlainAudioBackend } from './plain-audio-backend';
import { SafariAudioBackend } from './safari-audio-backend';
import { WebAudioBackend } from './web-audio-backend';
import type { AudioBackend, AudioBackendCallbacks, MediaSessionActions } from './types';

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

vi.mock('$lib/utils/crossfade-engine', () => {
    class MockCrossfadeEngine {
        startCrossfade = vi.fn(() => Promise.resolve());
        cancel = vi.fn();
        normalizePlaybackRate = vi.fn();
        destroy = vi.fn();
    }
    return { CrossfadeEngine: MockCrossfadeEngine };
});

/** Web Audio double — happy-dom ships none. */
class FakeAudioContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    private node(): Record<string, unknown> {
        return {
            gain: {
                value: 1,
                cancelScheduledValues: vi.fn(),
                setValueAtTime: vi.fn(),
                setTargetAtTime: vi.fn(),
            },
            frequency: { value: 0 },
            connect: vi.fn(),
            disconnect: vi.fn(),
        };
    }
    createGain(): Record<string, unknown> {
        return this.node();
    }
    createMediaElementSource(): Record<string, unknown> {
        return this.node();
    }
    createBiquadFilter(): Record<string, unknown> {
        return { ...this.node(), type: 'lowshelf' };
    }
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    resume = vi.fn(() => Promise.resolve());
    close = vi.fn(() => Promise.resolve());
}

const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

/** What the browser does to an element whose resource failed. */
function failElement(el: HTMLMediaElement, code: number): void {
    Object.defineProperty(el, 'error', {
        configurable: true,
        value: { code, message: `fake MediaError ${code}` },
    });
    el.dispatchEvent(new Event('error'));
}

/** A real browser clears `error` when a new source is loaded. */
function clearElementError(el: HTMLMediaElement): void {
    delete (el as { error?: unknown }).error;
}

function makeCallbacks(): AudioBackendCallbacks {
    return { onTrackEnded: vi.fn(), onTimeUpdate: vi.fn(), onPlaybackError: vi.fn() };
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

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const META = { title: 'Track' };
const SRC = '/api/music/tracks/t1/stream';

const BACKENDS: Array<[string, () => AudioBackend]> = [
    ['PlainAudioBackend', () => new PlainAudioBackend()],
    ['SafariAudioBackend', () => new SafariAudioBackend()],
    ['WebAudioBackend', () => new WebAudioBackend()],
];

describe.each(BACKENDS)('%s — a failed stream reaches the caller', (_name, create) => {
    let backend: AudioBackend;
    let callbacks: AudioBackendCallbacks;
    let playSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
        callbacks = makeCallbacks();
        backend = create();
        backend.init(callbacks, makeActions());
        for (const el of backend.getAllAudioElements()) clearElementError(el);
    });

    afterEach(() => {
        playSpy?.mockRestore();
        backend.destroy();
    });

    it('rejects play() when the source fails to load (HTTP 415 → MEDIA_ERR_SRC_NOT_SUPPORTED)', async () => {
        playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (
            this: HTMLMediaElement,
        ) {
            failElement(this, MEDIA_ERR_SRC_NOT_SUPPORTED);
            return Promise.reject(
                new DOMException(
                    'Failed to load because no supported source was found.',
                    'NotSupportedError',
                ),
            );
        });

        await expect(backend.play(SRC, META)).rejects.toMatchObject({
            name: 'MediaPlaybackError',
            code: MEDIA_ERR_SRC_NOT_SUPPORTED,
        });
        // The rejection carries this failure; reporting it again through the
        // callback would make the store handle one failure twice.
        expect(callbacks.onPlaybackError).not.toHaveBeenCalled();
    });

    it('rejects play() when a decode error fires and the play promise never settles', async () => {
        playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (
            this: HTMLMediaElement,
        ) {
            setTimeout(() => failElement(this, MEDIA_ERR_DECODE), 0);
            return new Promise<void>(() => {});
        });

        await expect(backend.play(SRC, META)).rejects.toMatchObject({
            name: 'MediaPlaybackError',
            code: MEDIA_ERR_DECODE,
        });
        expect(callbacks.onPlaybackError).not.toHaveBeenCalled();
    });

    it('reports a decode error on the current track after play() resolved', async () => {
        playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
        await backend.play(SRC, META);

        failElement(backend.getAudioElement()!, MEDIA_ERR_DECODE);

        expect(callbacks.onPlaybackError).toHaveBeenCalledTimes(1);
        expect(callbacks.onPlaybackError).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'MediaPlaybackError', code: MEDIA_ERR_DECODE }),
        );
    });

    it('reports a network error on the current track after play() resolved', async () => {
        playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
        await backend.play(SRC, META);

        failElement(backend.getAudioElement()!, MEDIA_ERR_NETWORK);

        expect(callbacks.onPlaybackError).toHaveBeenCalledWith(
            expect.objectContaining({ code: MEDIA_ERR_NETWORK }),
        );
    });

    it('keeps an autoplay-policy rejection (NotAllowedError) silent', async () => {
        playSpy = vi
            .spyOn(HTMLMediaElement.prototype, 'play')
            .mockRejectedValue(new DOMException('blocked', 'NotAllowedError'));

        await expect(backend.play(SRC, META)).resolves.toBeUndefined();
        expect(callbacks.onPlaybackError).not.toHaveBeenCalled();
    });

    it('keeps an AbortError (a newer load interrupted this play) silent', async () => {
        playSpy = vi
            .spyOn(HTMLMediaElement.prototype, 'play')
            .mockRejectedValue(new DOMException('interrupted', 'AbortError'));

        await expect(backend.play(SRC, META)).resolves.toBeUndefined();
        expect(callbacks.onPlaybackError).not.toHaveBeenCalled();
    });

    it('does not report the error a browser fires when stop() empties the src', async () => {
        playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
        await backend.play(SRC, META);
        const el = backend.getAudioElement()!;

        backend.stop();
        // `src = ''` resolves to the document URL and fails with code 4 in
        // real engines; that is teardown, not a failed track.
        failElement(el, MEDIA_ERR_SRC_NOT_SUPPORTED);
        await flush();

        expect(callbacks.onPlaybackError).not.toHaveBeenCalled();
    });

    it('does not report an error on a deck that is not playing the current track', async () => {
        playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
        await backend.play(SRC, META);
        const active = backend.getAudioElement();
        const idle = backend.getAllAudioElements().find((el) => el !== active);
        if (!idle) return; // single-deck backend: nothing to check

        idle.src = '/api/music/tracks/next/stream';
        failElement(idle, MEDIA_ERR_SRC_NOT_SUPPORTED);

        expect(callbacks.onPlaybackError).not.toHaveBeenCalled();
    });

    it('plays a normal track without reporting an error', async () => {
        playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);

        await expect(backend.play(SRC, META)).resolves.toBeUndefined();
        expect(playSpy).toHaveBeenCalled();
        expect(callbacks.onPlaybackError).not.toHaveBeenCalled();
    });
});

// A crossfade's incoming stream can die too (expired token, 404, transcode
// failure). Before: the fade fell back to a cut — the outgoing track stopped
// seconds early and nothing played, because the error event had fired while
// the incoming deck was still inactive and was never reported. And a play()
// that never settled left the fade flag stuck with the outgoing track ending
// into silence. The fade must reject so the store hard-cuts with recovery.
const CROSSFADE_BACKENDS: Array<[string, () => AudioBackend]> = [
    ['SafariAudioBackend', () => new SafariAudioBackend()],
    ['WebAudioBackend', () => new WebAudioBackend()],
];

describe.each(CROSSFADE_BACKENDS)(
    '%s — a dead incoming stream during a crossfade',
    (_name, create) => {
        let backend: AudioBackend;
        let callbacks: AudioBackendCallbacks;
        let playSpy: ReturnType<typeof vi.spyOn>;

        beforeEach(() => {
            (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
            callbacks = makeCallbacks();
            backend = create();
            backend.init(callbacks, makeActions());
            for (const el of backend.getAllAudioElements()) clearElementError(el);
        });

        afterEach(() => {
            vi.useRealTimers();
            playSpy?.mockRestore();
            backend.destroy();
        });

        async function startOutgoing(): Promise<HTMLAudioElement> {
            await backend.play(SRC, META);
            const active = backend.getAudioElement();
            const incoming = backend.getAllAudioElements().find((el) => el !== active);
            if (!incoming) throw new Error('two-deck backend expected');
            return incoming as HTMLAudioElement;
        }

        it('rejects the fade when the incoming stream fails while buffering', async () => {
            playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
            const incoming = await startOutgoing();

            const fade = backend.triggerCrossfade!('/api/music/tracks/next/stream', META, {
                beats: 8,
                volume: 1,
            });
            await flush();
            failElement(incoming, MEDIA_ERR_NETWORK);

            await expect(fade).rejects.toMatchObject({ name: 'MediaPlaybackError' });
            expect(backend.isCrossfading()).toBe(false);
        });

        it('rejects the fade when the incoming play() never settles', async () => {
            playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
            const incoming = await startOutgoing();
            playSpy.mockImplementation(function (this: HTMLMediaElement) {
                return this === incoming ? new Promise<void>(() => {}) : Promise.resolve();
            });
            vi.useFakeTimers();

            const fade = backend.triggerCrossfade!('/api/music/tracks/next/stream', META, {
                beats: 8,
                volume: 1,
            });
            const assertion = expect(fade).rejects.toMatchObject({ name: 'MediaPlaybackError' });
            await vi.advanceTimersByTimeAsync(8_100);
            await assertion;
            expect(backend.isCrossfading()).toBe(false);
        });
    },
);

describe('WebAudioBackend — a stream that dies mid-fade', () => {
    it('is reported once the fade completes and the incoming deck is current', async () => {
        (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
        const callbacks = makeCallbacks();
        const backend = new WebAudioBackend();
        backend.init(callbacks, makeActions());
        for (const el of backend.getAllAudioElements()) clearElementError(el);
        const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
        try {
            await backend.play(SRC, META);
            const active = backend.getAudioElement();
            const incoming = backend.getAllAudioElements().find((el) => el !== active)!;
            Object.defineProperty(incoming, 'readyState', { configurable: true, value: 4 });
            const engine = (
                backend as unknown as {
                    crossfadeEngine: { startCrossfade: ReturnType<typeof vi.fn> };
                }
            ).crossfadeEngine;
            engine.startCrossfade.mockImplementationOnce(async () => {
                failElement(incoming, MEDIA_ERR_DECODE); // inactive deck: ignored by the watcher
            });

            await backend.triggerCrossfade!('/api/music/tracks/next/stream', META, {
                beats: 8,
                volume: 1,
            });

            expect(backend.getAudioElement()).toBe(incoming);
            expect(callbacks.onPlaybackError).toHaveBeenCalledTimes(1);
        } finally {
            playSpy.mockRestore();
            backend.destroy();
        }
    });
});
