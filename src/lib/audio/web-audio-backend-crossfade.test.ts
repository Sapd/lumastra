// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom
/**
 * Crossfade state in the Web Audio backend.
 *
 * Mute during a crossfade: the engine owns both deck gains for the length of a
 * fade, so a mute written to the outgoing deck's gain was overwritten on the
 * next frame and never reached the incoming deck at all — audio kept playing
 * until the fade ended. Mid-fade mutes now go through an output bus.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebAudioBackend } from './web-audio-backend';
import type { AudioBackendCallbacks, MediaSessionActions } from './types';

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

let releaseFade: (() => void) | null = null;
vi.mock('$lib/utils/crossfade-engine', () => {
    class MockCrossfadeEngine {
        startCrossfade = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    releaseFade = resolve;
                }),
        );
        cancel = vi.fn();
        normalizePlaybackRate = vi.fn();
        destroy = vi.fn();
    }
    return { CrossfadeEngine: MockCrossfadeEngine };
});

interface FakeParam {
    value: number;
    cancelScheduledValues: ReturnType<typeof vi.fn>;
    setValueAtTime: ReturnType<typeof vi.fn>;
    setTargetAtTime: ReturnType<typeof vi.fn>;
}
function param(initial: number): FakeParam {
    const p: FakeParam = {
        value: initial,
        cancelScheduledValues: vi.fn(),
        setValueAtTime: vi.fn((v: number) => {
            p.value = v;
        }),
        // Tests read the settled level: a glide lands on its target.
        setTargetAtTime: vi.fn((v: number) => {
            p.value = v;
        }),
    };
    return p;
}

class FakeAudioContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    createGain(): Record<string, unknown> {
        return { gain: param(1), connect: vi.fn(), disconnect: vi.fn() };
    }
    createMediaElementSource(): Record<string, unknown> {
        return { connect: vi.fn(), disconnect: vi.fn() };
    }
    createBiquadFilter(): Record<string, unknown> {
        return {
            type: 'lowshelf',
            frequency: { value: 0 },
            gain: param(0),
            connect: vi.fn(),
            disconnect: vi.fn(),
        };
    }
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    resume = vi.fn(() => Promise.resolve());
    close = vi.fn(() => Promise.resolve());
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

describe('WebAudioBackend — mute during a crossfade', () => {
    let backend: WebAudioBackend;
    let playSpy: ReturnType<typeof vi.spyOn>;
    const bus = (): FakeParam =>
        (backend as unknown as { muteBus: { gain: FakeParam } }).muteBus.gain;

    beforeEach(async () => {
        (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
        releaseFade = null;
        playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
        backend = new WebAudioBackend();
        backend.init(makeCallbacks(), makeActions());
        await backend.play('/api/music/tracks/a/stream', META);
        for (const el of backend.getAllAudioElements()) {
            Object.defineProperty(el, 'readyState', { configurable: true, value: 4 });
        }
    });

    afterEach(() => {
        playSpy.mockRestore();
        backend.destroy();
    });

    /** Wrapped: an async function returning the fade promise would await it. */
    async function startFade(): Promise<{ fade: Promise<void> }> {
        const fade = backend.triggerCrossfade('/api/music/tracks/b/stream', META, {
            beats: 8,
            volume: 0.8,
        });
        await flush();
        expect(backend.isCrossfading()).toBe(true);
        return { fade };
    }

    it('silences both decks through the bus, and hands the mute to the new deck after', async () => {
        const { fade } = await startFade();
        expect(bus().value).toBe(1);

        backend.mute();
        expect(bus().value).toBe(0);

        releaseFade!();
        await fade;
        expect(backend.isCrossfading()).toBe(false);
        // Bus released; the mute now lives on the active deck's gain.
        expect(bus().value).toBe(1);
        const active = backend.getAudioElement();
        const deck = (
            backend as unknown as { getActiveDeck(): { audio: unknown; gain: { gain: FakeParam } } }
        ).getActiveDeck();
        expect(deck.audio).toBe(active);
        expect(deck.gain.gain.value).toBe(0);
    });

    it('unmute during the fade makes it audible again right away', async () => {
        const { fade } = await startFade();
        backend.mute();
        backend.unmute(0.8);
        expect(bus().value).toBe(1);
        releaseFade!();
        await fade;
        expect(bus().value).toBe(1);
    });

    it('a mute that was on before the fade stays on through it', async () => {
        backend.mute();
        const { fade } = await startFade();
        expect(bus().value).toBe(0);
        releaseFade!();
        await fade;
        const deck = (
            backend as unknown as { getActiveDeck(): { gain: { gain: FakeParam } } }
        ).getActiveDeck();
        expect(deck.gain.gain.value).toBe(0);
        expect(bus().value).toBe(1);
    });

    it('cancelling the fade while muted releases the bus and keeps the new deck silent', async () => {
        await startFade();
        backend.mute();
        backend.cancelCrossfade();
        expect(bus().value).toBe(1);
        const deck = (
            backend as unknown as { getActiveDeck(): { gain: { gain: FakeParam } } }
        ).getActiveDeck();
        expect(deck.gain.gain.value).toBe(0);
    });
});

describe('WebAudioBackend — a cancelled fade resuming after a newer one started', () => {
    it('bails instead of running (and swapping decks) a second time', async () => {
        (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
        let releaseFirstPlay!: () => void;
        let calls = 0;
        const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => {
            calls += 1;
            // 1st: outgoing play(). 2nd: fade #1's incoming play — held open.
            if (calls === 2) return new Promise<void>((r) => (releaseFirstPlay = r));
            return Promise.resolve();
        });
        const backend = new WebAudioBackend();
        backend.init(makeCallbacks(), makeActions());
        try {
            await backend.play('/api/music/tracks/a/stream', META);
            for (const el of backend.getAllAudioElements()) {
                Object.defineProperty(el, 'readyState', { configurable: true, value: 4 });
            }
            const engine = (
                backend as unknown as {
                    crossfadeEngine: { startCrossfade: ReturnType<typeof vi.fn> };
                }
            ).crossfadeEngine;

            const first = backend.triggerCrossfade('/api/music/tracks/b/stream', META, {
                beats: 8,
            });
            await flush();
            backend.cancelCrossfade(); // user skipped while #1 waited on play()
            const deckAfterCancel = backend.getAudioElement();

            const second = backend.triggerCrossfade('/api/music/tracks/c/stream', META, {
                beats: 8,
            });
            await flush();
            expect(engine.startCrossfade).toHaveBeenCalledTimes(1); // #2 only

            releaseFirstPlay(); // #1 resumes while #2 is fading
            await first;
            expect(engine.startCrossfade).toHaveBeenCalledTimes(1);
            expect(backend.isCrossfading()).toBe(true); // #2's flag untouched
            expect(backend.getAudioElement()).toBe(deckAfterCancel);

            releaseFade!();
            await second;
            expect(backend.isCrossfading()).toBe(false);
        } finally {
            playSpy.mockRestore();
            backend.destroy();
        }
    });
});

describe('WebAudioBackend — incoming deck pre-seek', () => {
    it('seeks the incoming deck to its entry point before play(), not after the readiness wait', async () => {
        (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
        const order: string[] = [];
        const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (
            this: HTMLMediaElement,
        ) {
            order.push(`play@${this.currentTime}`);
            return Promise.resolve();
        });
        const backend = new WebAudioBackend();
        backend.init(makeCallbacks(), makeActions());
        try {
            await backend.play('/api/music/tracks/a/stream', META);
            order.length = 0;
            for (const el of backend.getAllAudioElements()) {
                // metadata known → seekWhenReady writes currentTime straight away
                Object.defineProperty(el, 'readyState', { configurable: true, value: 4 });
            }
            const fade = backend.triggerCrossfade('/api/music/tracks/b/stream', META, {
                beats: 8,
                incomingIntroEndMs: 16_000,
                incomingDownbeats: [0, 8, 16, 24],
            });
            await flush();
            expect(order).toEqual(['play@16']);
            releaseFade!();
            await fade;
        } finally {
            playSpy.mockRestore();
            backend.destroy();
        }
    });
});

describe('WebAudioBackend — review follow-ups', () => {
    let backend: WebAudioBackend;
    let playSpy: ReturnType<typeof vi.spyOn>;
    type Deck = { audio: HTMLAudioElement; gain: { gain: FakeParam } };
    const decks = () => backend as unknown as { getActiveDeck(): Deck; getInactiveDeck(): Deck };

    beforeEach(async () => {
        (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
        releaseFade = null;
        playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    });

    afterEach(() => {
        playSpy.mockRestore();
        backend.destroy();
        delete (document as { hidden?: boolean }).hidden;
    });

    async function ready(opts?: { useShadowAudio?: boolean }): Promise<void> {
        backend = new WebAudioBackend(opts);
        backend.init(makeCallbacks(), makeActions());
        await backend.play('/api/music/tracks/a/stream', META);
        for (const el of backend.getAllAudioElements()) {
            Object.defineProperty(el, 'readyState', { configurable: true, value: 4 });
        }
    }

    it('play() while muted keeps the new deck silent (a bus mute is not dropped)', async () => {
        await ready();
        backend.mute();
        await backend.play('/api/music/tracks/b/stream', META);
        expect(decks().getActiveDeck().gain.gain.value).toBe(0);
    });

    it('shortens the fade to the outgoing audio actually left after the waits', async () => {
        await ready();
        const out = backend.getAudioElement()!;
        Object.defineProperty(out, 'duration', { configurable: true, value: 100 });
        out.currentTime = 99; // 1s left − 250ms margin → 750ms → one 500ms beat at 120 BPM
        const engine = (
            backend as unknown as { crossfadeEngine: { startCrossfade: ReturnType<typeof vi.fn> } }
        ).crossfadeEngine;
        const fade = backend.triggerCrossfade('/api/music/tracks/b/stream', META, {
            beats: 16,
            paceBpm: 120,
        });
        await flush();
        expect(engine.startCrossfade.mock.calls[0][2].beats).toBe(1);
        releaseFade!();
        await fade;
    });

    it('Android: defers the shadow element while fading, then hands it the new track', async () => {
        await ready({ useShadowAudio: true });
        const fade = backend.triggerCrossfade('/api/music/tracks/b/stream', META, { beats: 8 });
        await flush();
        const shadowActive = () => (backend as unknown as { shadowActive: boolean }).shadowActive;

        // happy-dom never starts playback; the real decks are playing here —
        // otherwise activateShadowAudio would bail on a paused deck regardless.
        for (const el of backend.getAllAudioElements()) {
            Object.defineProperty(el, 'paused', { configurable: true, value: false });
        }
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        (backend as unknown as { activateShadowAudio(): void }).activateShadowAudio();
        expect(shadowActive()).toBe(false); // would have shadowed the OUTGOING deck

        releaseFade!();
        await fade;
        expect(shadowActive()).toBe(true);
        const shadow = (backend as unknown as { shadowAudio: HTMLAudioElement }).shadowAudio;
        expect(shadow.src).toContain('/api/music/tracks/b/stream');
    });
});
