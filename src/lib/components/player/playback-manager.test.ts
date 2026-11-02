// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the byte-verified network-activity poll (Layer 1 of the
 * dead-but-trickling stall fix).
 *
 * Context: the DOM 'progress' event fires even when hls.js is dead-but-
 * trickling (no genuine new bytes), which — via ReconnectController's
 * notifyNetworkActivity() — re-arms the stall dead-man forever and masks a
 * frozen playhead. For hls.js we can verify real network activity instead by
 * polling the *live-mutating* LoaderStats object on the fragment currently
 * being loaded (Hls.Events.FRAG_LOADING -> data.frag.stats) and firing
 * onVerifiedNetworkActivity() only when `.loaded` has genuinely increased
 * since the last poll.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NOTE: the Events/ErrorTypes enums below must stay INSIDE the vi.mock
// factory (not hoisted to module scope) — vi.mock calls are hoisted above all
// other statements, so a top-level const referenced from the factory would
// throw a "Cannot access before initialization" TDZ error. Test bodies access
// them via the mocked `Hls.Events` / `Hls.ErrorTypes` statics instead (see the
// `import Hls from 'hls.js'` below, which resolves to this mock).
vi.mock('hls.js', () => {
    const events = {
        MEDIA_ATTACHED: 'hlsMediaAttached',
        MANIFEST_PARSED: 'hlsManifestParsed',
        LEVEL_LOADED: 'hlsLevelLoaded',
        FRAG_LOADING: 'hlsFragLoading',
        FRAG_LOADED: 'hlsFragLoaded',
        FRAG_BUFFERED: 'hlsFragBuffered',
        LEVEL_SWITCHING: 'hlsLevelSwitching',
        ERROR: 'hlsError',
    } as const;
    const errorTypes = {
        NETWORK_ERROR: 'networkError',
        MEDIA_ERROR: 'mediaError',
        OTHER_ERROR: 'otherError',
    } as const;

    class FakeHls {
        static Events = events;
        static ErrorTypes = errorTypes;

        subtitleDisplay = false;
        levels: unknown[] = [];
        audioTracks: unknown[] = [];
        bandwidthEstimate = 0;
        destroyed = false;

        private listeners = new Map<string, ((...args: unknown[]) => void)[]>();

        constructor(_config?: unknown) {}

        on(event: string, cb: (...args: unknown[]) => void): void {
            const arr = this.listeners.get(event) ?? [];
            arr.push(cb);
            this.listeners.set(event, arr);
        }

        emit(event: string, data?: unknown): void {
            for (const cb of this.listeners.get(event) ?? []) cb(event, data);
        }

        loadSource(_url: string): void {}
        attachMedia(_el: HTMLVideoElement): void {}
        startLoad(_pos?: number): void {}
        recoverMediaError(): void {}
        destroy(): void {
            this.destroyed = true;
        }
    }

    return { default: FakeHls };
});

vi.mock('akarisub', () => ({}));
vi.mock('libbitsub', () => ({}));

import Hls from 'hls.js';
import { createPlaybackManager, type PlaybackManagerConfig } from './playback-manager';

/** Minimal shape of the mocked Hls instance used by these tests. */
interface FakeHlsInstance {
    emit: (event: string, data?: unknown) => void;
}

/** Access to the private setupHlsEventHandlers() for simulating a
 *  resetForSeek-style re-entry without going through the full async rebuild
 *  (dynamic hls.js/akarisub/libbitsub imports + seek-reset plumbing). */
interface PlaybackManagerInternals {
    setupHlsEventHandlers: () => void;
    resetForSeek: (position: number, isVideoCopyMode?: boolean, deferResume?: boolean) => void;
    pendingResumeAfterSeekReset: boolean | null;
    hls: FakeHlsInstance | null;
    currentMode: 'hls' | 'direct' | null;
    currentUrl?: string;
    currentStartPosition?: number;
}

function makeConfig(
    events: Partial<PlaybackManagerConfig['events']>,
    videoElement = document.createElement('video'),
): PlaybackManagerConfig {
    return {
        videoElement,
        isSafari: false,
        isLive: false,
        autoPlay: false,
        mightBeInWatchParty: () => false,
        isInWatchParty: () => false,
        log: () => {},
        events,
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    // happy-dom does not implement MediaSource; PlaybackManager feature-detects
    // hls.js support via window.MediaSource.
    vi.stubGlobal(
        'MediaSource',
        class {
            static isTypeSupported(): boolean {
                return true;
            }
        },
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('PlaybackManager — asynchronous source ownership', () => {
    it('does not unmute a replacement source when an old muted play is aborted', async () => {
        const video = document.createElement('video');
        let rejectPlay: (error: Error) => void = () => {};
        vi.spyOn(video, 'play').mockReturnValue(
            new Promise<void>((_resolve, reject) => {
                rejectPlay = reject;
            }),
        );
        const onAutoplayResult = vi.fn();
        const manager = createPlaybackManager(makeConfig({ onAutoplayResult }, video));
        (manager as unknown as { startMutedPlayback(): void }).startMutedPlayback();
        manager.destroy(true);
        await manager.load('https://example.test/replacement.mp4', 'direct');
        video.muted = true;

        rejectPlay(new DOMException('Source replaced', 'AbortError'));
        await Promise.resolve();
        await Promise.resolve();

        expect(video.muted).toBe(true);
        expect(onAutoplayResult).not.toHaveBeenCalled();
        manager.destroy();
    });

    it('does not retry muted when an outgoing autoplay promise rejects late', async () => {
        const video = document.createElement('video');
        let rejectPlay: (error: Error) => void = () => {};
        const play = vi.spyOn(video, 'play').mockReturnValue(
            new Promise<void>((_resolve, reject) => {
                rejectPlay = reject;
            }),
        );
        const manager = createPlaybackManager(makeConfig({}, video));
        (manager as unknown as { tryAutoPlay(): void }).tryAutoPlay();
        manager.destroy(true);
        await manager.load('https://example.test/replacement.mp4', 'direct');

        rejectPlay(new DOMException('Blocked', 'NotAllowedError'));
        await Promise.resolve();
        await Promise.resolve();

        expect(play).toHaveBeenCalledTimes(1);
        expect(video.muted).toBe(false);
        manager.destroy();
    });

    it('with the muted fallback off (iOS), a blocked autoplay stays unmuted and waits for a tap', async () => {
        const video = document.createElement('video');
        const play = vi
            .spyOn(video, 'play')
            .mockRejectedValue(new DOMException('Blocked', 'NotAllowedError'));
        const onAutoplayResult = vi.fn();
        const onMutedFallbackStart = vi.fn();
        const manager = createPlaybackManager({
            ...makeConfig({ onAutoplayResult, onMutedFallbackStart }, video),
            mutedAutoplayFallback: false,
        });
        (manager as unknown as { tryAutoPlay(): void }).tryAutoPlay();
        await Promise.resolve();
        await Promise.resolve();

        expect(play).toHaveBeenCalledTimes(1);
        expect(video.muted).toBe(false);
        expect(onMutedFallbackStart).not.toHaveBeenCalled();
        expect(onAutoplayResult).toHaveBeenCalledWith(
            expect.objectContaining({ success: false, playingMuted: false }),
        );
        manager.destroy();
    });

    it('announces the muted fallback before it mutes the element', async () => {
        const video = document.createElement('video');
        vi.spyOn(video, 'play').mockResolvedValue(undefined);
        const mutedWhenAnnounced: boolean[] = [];
        const manager = createPlaybackManager(
            makeConfig({ onMutedFallbackStart: () => mutedWhenAnnounced.push(video.muted) }, video),
        );
        (manager as unknown as { startMutedPlayback(): void }).startMutedPlayback();
        await Promise.resolve();

        expect(mutedWhenAnnounced).toEqual([false]);
        expect(video.muted).toBe(true);
        manager.destroy();
    });

    it.each([
        { initiallyMuted: true, fallback: false, usedMutedFallback: undefined },
        { initiallyMuted: false, fallback: true, usedMutedFallback: true },
        { initiallyMuted: true, fallback: true, usedMutedFallback: false },
    ])(
        'reports whether muted autoplay changed the preference: %j',
        async ({ initiallyMuted, fallback, usedMutedFallback }) => {
            const video = document.createElement('video');
            video.muted = initiallyMuted;
            vi.spyOn(video, 'play').mockResolvedValue(undefined);
            const onAutoplayResult = vi.fn();
            const manager = createPlaybackManager(makeConfig({ onAutoplayResult }, video));
            const autoplay = manager as unknown as {
                tryAutoPlay(): void;
                startMutedPlayback(): void;
            };
            if (fallback) autoplay.startMutedPlayback();
            else autoplay.tryAutoPlay();
            await Promise.resolve();

            expect(onAutoplayResult).toHaveBeenCalledOnce();
            expect(onAutoplayResult.mock.calls[0][0].usedMutedFallback).toBe(usedMutedFallback);
            manager.destroy();
        },
    );

    it('does not resurrect HLS when destroyed during library loading', async () => {
        const manager = createPlaybackManager(makeConfig({}));
        const loading = manager.load('https://example.test/old.m3u8', 'hls');
        manager.destroy();
        await loading;
        const hls = manager.getHls();
        manager.destroy();
        expect(hls).toBeNull();
    });

    it('does not attach a source superseded while its libraries load', async () => {
        const loaded = vi.spyOn(Hls.prototype, 'loadSource');
        const manager = createPlaybackManager(makeConfig({}));
        try {
            const oldLoad = manager.load('https://example.test/old.m3u8', 'hls');
            const newLoad = manager.load('https://example.test/new.m3u8', 'hls');
            await Promise.all([oldLoad, newLoad]);
            expect(loaded.mock.calls.map(([url]) => url)).toEqual([
                'https://example.test/new.m3u8',
            ]);
        } finally {
            manager.destroy();
            loaded.mockRestore();
        }
    });
});

describe('PlaybackManager — byte-verified network activity poll', () => {
    it('does not auto-resume an HLS reset when coordinated playback owns the resume', async () => {
        const videoElement = document.createElement('video');
        Object.defineProperty(videoElement, 'paused', { configurable: true, value: false });
        const manager = createPlaybackManager(
            makeConfig(
                {
                    onLoadingChange: () => {},
                    onManifestParsed: () => {},
                },
                videoElement,
            ),
        );
        const internals = manager as unknown as PlaybackManagerInternals;

        // The explicit third argument is used by Watchparty seeks. Its
        // all_ready barrier, not the HLS rebuild, is the resume authority.
        await manager.load('https://example.test/master.m3u8', 'hls');
        internals.resetForSeek(50, false, true);

        expect(internals.pendingResumeAfterSeekReset).toBe(false);
        manager.destroy();
    });

    it('does not auto-resume a Safari-native HLS seek when coordinated playback owns the resume', () => {
        const videoElement = document.createElement('video');
        Object.defineProperty(videoElement, 'paused', { configurable: true, value: false });
        const play = vi.fn(() => Promise.resolve());
        Object.defineProperty(videoElement, 'play', { configurable: true, value: play });
        const manager = createPlaybackManager(makeConfig({}, videoElement));
        const internals = manager as unknown as PlaybackManagerInternals;

        // Native HLS has no Hls instance but retains the HLS mode and URL.
        internals.hls = null;
        internals.currentMode = 'hls';
        internals.currentUrl = 'https://example.test/master.m3u8';
        internals.resetForSeek(50, true, true);
        videoElement.dispatchEvent(new Event('loadedmetadata'));

        expect(play).not.toHaveBeenCalled();
        manager.destroy();
    });

    it('fires onVerifiedNetworkActivity only when FRAG_LOADING stats.loaded genuinely increases between 2s polls', async () => {
        const onVerifiedNetworkActivity = vi.fn();
        const manager = createPlaybackManager(makeConfig({ onVerifiedNetworkActivity }));

        await manager.load('https://example.test/master.m3u8', 'hls');
        const hls = manager.getHls() as unknown as FakeHlsInstance;

        const frag = { sn: 1, type: 'main', start: 0, stats: { loaded: 0 } };
        hls.emit(Hls.Events.FRAG_LOADING, { frag });

        // No byte progress yet — first poll tick must not fire.
        await vi.advanceTimersByTimeAsync(2000);
        expect(onVerifiedNetworkActivity).not.toHaveBeenCalled();

        // Real bytes arrive between polls — must fire exactly once.
        frag.stats.loaded = 1000;
        await vi.advanceTimersByTimeAsync(2000);
        expect(onVerifiedNetworkActivity).toHaveBeenCalledTimes(1);

        // No further progress — must NOT fire again (this is the case a
        // dead-but-trickling DOM 'progress' event would otherwise mask).
        await vi.advanceTimersByTimeAsync(2000);
        expect(onVerifiedNetworkActivity).toHaveBeenCalledTimes(1);

        // Bytes increase again — fires again.
        frag.stats.loaded = 2500;
        await vi.advanceTimersByTimeAsync(2000);
        expect(onVerifiedNetworkActivity).toHaveBeenCalledTimes(2);

        manager.destroy();
    });

    it('ignores non-main (e.g. demuxed audio) fragments so they cannot clobber main-stream byte tracking', async () => {
        const onVerifiedNetworkActivity = vi.fn();
        const manager = createPlaybackManager(makeConfig({ onVerifiedNetworkActivity }));

        await manager.load('https://example.test/master.m3u8', 'hls');
        const hls = manager.getHls() as unknown as FakeHlsInstance;

        // A non-'main' stream (would only exist if audio were demuxed through
        // hls.js) must NOT be tracked — otherwise a concurrent audio loader's
        // stats/completion would clobber the main fragment's tracking.
        const audioFrag = { sn: 1, type: 'audio', start: 0, stats: { loaded: 0 } };
        hls.emit(Hls.Events.FRAG_LOADING, { frag: audioFrag });
        audioFrag.stats.loaded = 5000;
        await vi.advanceTimersByTimeAsync(2000);
        expect(onVerifiedNetworkActivity).not.toHaveBeenCalled();

        // The main fragment IS tracked, and a stray audio FRAG_LOADED must not
        // null its still-live stats mid-download.
        const mainFrag = { sn: 1, type: 'main', start: 0, stats: { loaded: 0 } };
        hls.emit(Hls.Events.FRAG_LOADING, { frag: mainFrag });
        hls.emit(Hls.Events.FRAG_LOADED, { frag: { sn: 1, type: 'audio', start: 0 } });
        mainFrag.stats.loaded = 3000;
        await vi.advanceTimersByTimeAsync(2000);
        expect(onVerifiedNetworkActivity).toHaveBeenCalledTimes(1);

        manager.destroy();
    });

    it('clears the fragment ref on FRAG_LOADED so a stale finished fragment cannot keep firing (via the poll)', async () => {
        const onVerifiedNetworkActivity = vi.fn();
        const manager = createPlaybackManager(makeConfig({ onVerifiedNetworkActivity }));

        await manager.load('https://example.test/master.m3u8', 'hls');
        const hls = manager.getHls() as unknown as FakeHlsInstance;

        const frag = { sn: 1, type: 'main', start: 0, stats: { loaded: 0 } };
        hls.emit(Hls.Events.FRAG_LOADING, { frag });
        frag.stats.loaded = 500;
        await vi.advanceTimersByTimeAsync(2000);
        expect(onVerifiedNetworkActivity).toHaveBeenCalledTimes(1);

        // FRAG_LOADED itself also fires the signal directly (see the next
        // test) — that's call #2, not a leak from the stale ref.
        hls.emit(Hls.Events.FRAG_LOADED, { frag: { sn: 1, type: 'main', start: 0 } });
        expect(onVerifiedNetworkActivity).toHaveBeenCalledTimes(2);

        // Even though the (stale) frag object's `loaded` keeps climbing, the
        // ref was cleared — no more POLL-driven calls fire for it (the count
        // stays at 2, not 3+).
        frag.stats.loaded = 9999;
        await vi.advanceTimersByTimeAsync(2000);
        expect(onVerifiedNetworkActivity).toHaveBeenCalledTimes(2);

        manager.destroy();
    });

    it('fires onVerifiedNetworkActivity directly on FRAG_LOADED — not dependent on 2s poll timing', async () => {
        // A fragment that loads faster than the 2s poll interval (small/cached
        // segment, the common case) would otherwise never be sampled with
        // non-zero bytes before FRAG_LOADED nulls the ref — a perfectly
        // successful load could go completely undetected by the poll alone.
        // This is what ReconnectController's recovery-confirmation gate
        // (verifiedActivityDuringRecovery) relies on to not hang forever on
        // fast-completing fragments during a rebuild.
        const onVerifiedNetworkActivity = vi.fn();
        const manager = createPlaybackManager(makeConfig({ onVerifiedNetworkActivity }));

        await manager.load('https://example.test/master.m3u8', 'hls');
        const hls = manager.getHls() as unknown as FakeHlsInstance;

        const frag = { sn: 1, type: 'main', start: 0, stats: { loaded: 0 } };
        hls.emit(Hls.Events.FRAG_LOADING, { frag });
        // Load completes well within the 2s poll interval — no poll tick ever
        // observes non-zero bytes.
        hls.emit(Hls.Events.FRAG_LOADED, { frag: { sn: 1, type: 'main', start: 0 } });

        expect(onVerifiedNetworkActivity).toHaveBeenCalledTimes(1);

        manager.destroy();
    });

    it('does NOT fire onVerifiedNetworkActivity on a non-main FRAG_LOADED', async () => {
        const onVerifiedNetworkActivity = vi.fn();
        const manager = createPlaybackManager(makeConfig({ onVerifiedNetworkActivity }));

        await manager.load('https://example.test/master.m3u8', 'hls');
        const hls = manager.getHls() as unknown as FakeHlsInstance;

        hls.emit(Hls.Events.FRAG_LOADED, { frag: { sn: 1, type: 'audio', start: 0 } });

        expect(onVerifiedNetworkActivity).not.toHaveBeenCalled();

        manager.destroy();
    });

    it('clears the fragment ref on a hls.js ERROR event', async () => {
        const onVerifiedNetworkActivity = vi.fn();
        const manager = createPlaybackManager(makeConfig({ onVerifiedNetworkActivity }));

        await manager.load('https://example.test/master.m3u8', 'hls');
        const hls = manager.getHls() as unknown as FakeHlsInstance;

        const frag = { sn: 1, type: 'main', start: 0, stats: { loaded: 0 } };
        hls.emit(Hls.Events.FRAG_LOADING, { frag });

        hls.emit(Hls.Events.ERROR, {
            type: Hls.ErrorTypes.OTHER_ERROR,
            details: 'x',
            fatal: false,
        });

        frag.stats.loaded = 9999;
        await vi.advanceTimersByTimeAsync(2000);
        expect(onVerifiedNetworkActivity).not.toHaveBeenCalled();

        manager.destroy();
    });

    it('re-entering setupHlsEventHandlers (resetForSeek rebuild) clears the old poll timer instead of leaking a duplicate', async () => {
        const onVerifiedNetworkActivity = vi.fn();
        const manager = createPlaybackManager(makeConfig({ onVerifiedNetworkActivity }));
        const internals = manager as unknown as PlaybackManagerInternals;

        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

        await manager.load('https://example.test/master.m3u8', 'hls');
        expect(setIntervalSpy).toHaveBeenCalledTimes(1);
        expect(clearIntervalSpy).not.toHaveBeenCalled();

        // Simulate the resetForSeek rebuild calling setupHlsEventHandlers()
        // again on the same PlaybackManager instance (a fresh Hls instance is
        // attached, but the poll-timer bookkeeping lives on `this`).
        internals.setupHlsEventHandlers();

        // Regression guard: without clearing first, this would leak a second
        // interval running forever alongside the first.
        expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
        expect(setIntervalSpy).toHaveBeenCalledTimes(2);

        // And behaviorally: only ONE poll fires per genuine byte increase —
        // not two (which a leaked duplicate interval would eventually cause).
        const hls = manager.getHls() as unknown as FakeHlsInstance;
        const frag = { sn: 2, type: 'main', start: 10, stats: { loaded: 0 } };
        hls.emit(Hls.Events.FRAG_LOADING, { frag });
        frag.stats.loaded = 500;
        await vi.advanceTimersByTimeAsync(2000);
        expect(onVerifiedNetworkActivity).toHaveBeenCalledTimes(1);

        manager.destroy();
    });

    it('clears the poll timer and fragment ref on destroy()', async () => {
        const onVerifiedNetworkActivity = vi.fn();
        const manager = createPlaybackManager(makeConfig({ onVerifiedNetworkActivity }));

        const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

        await manager.load('https://example.test/master.m3u8', 'hls');
        const hls = manager.getHls() as unknown as FakeHlsInstance;
        const frag = { sn: 1, type: 'main', start: 0, stats: { loaded: 0 } };
        hls.emit(Hls.Events.FRAG_LOADING, { frag });

        const clearIntervalCallsBeforeDestroy = clearIntervalSpy.mock.calls.length;
        manager.destroy();
        expect(clearIntervalSpy.mock.calls.length).toBeGreaterThan(clearIntervalCallsBeforeDestroy);

        frag.stats.loaded = 9999;
        await vi.advanceTimersByTimeAsync(4000);
        expect(onVerifiedNetworkActivity).not.toHaveBeenCalled();
    });
});

describe('PlaybackManager — fatal manifest-stage network errors', () => {
    // Measured 2026-09-11 with a controlled 503 on `/api/playback/<id>/hls`:
    // hls.js retried the manifest five times on its own, went fatal, and the
    // player then sat SILENT for 60 s — no reconnect badge, no error. The
    // MAX_RECOVERY_ATTEMPTS loop below the terminal check re-kicks
    // `hls.startLoad()`, which resumes level/fragment loading and cannot
    // re-request a manifest that never loaded. No request goes out, so no
    // further ERROR event fires, so the attempt counter never advances and the
    // loop never reaches its `onError` exit. The controller's reconnect path
    // (badge, HTTP diagnostics, fresh-session rebuild) only starts from
    // `onError`, so it never started either.
    it('hands a fatal manifestLoadError to onError at once instead of nudging startLoad()', async () => {
        const onError = vi.fn();
        const onNetworkRecoveryAttempt = vi.fn();
        const manager = createPlaybackManager(makeConfig({ onError, onNetworkRecoveryAttempt }));
        await manager.load('https://example.test/master.m3u8', 'hls');
        const hls = manager.getHls() as unknown as FakeHlsInstance & { startLoad: () => void };
        const startLoad = vi.spyOn(hls, 'startLoad');

        hls.emit(Hls.Events.ERROR, {
            type: Hls.ErrorTypes.NETWORK_ERROR,
            details: 'manifestLoadError',
            fatal: true,
            response: { code: 503 },
        });
        await vi.advanceTimersByTimeAsync(20_000);

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0][0]).toMatchObject({
            type: 'network',
            recoverable: true,
            httpStatus: 503,
            stage: 'manifest',
        });
        expect(onNetworkRecoveryAttempt).not.toHaveBeenCalled();
        expect(startLoad).not.toHaveBeenCalled();
        manager.destroy();
    });

    it('still nudges startLoad() for a fatal fragment-stage network error (the loop is right there)', async () => {
        const onError = vi.fn();
        const onNetworkRecoveryAttempt = vi.fn();
        const manager = createPlaybackManager(makeConfig({ onError, onNetworkRecoveryAttempt }));
        await manager.load('https://example.test/master.m3u8', 'hls');
        const hls = manager.getHls() as unknown as FakeHlsInstance & { startLoad: () => void };
        const startLoad = vi.spyOn(hls, 'startLoad');

        hls.emit(Hls.Events.ERROR, {
            type: Hls.ErrorTypes.NETWORK_ERROR,
            details: 'fragLoadError',
            fatal: true,
            response: { code: 503 },
            frag: { type: 'main', sn: 4 },
        });
        await vi.advanceTimersByTimeAsync(2_000);

        expect(onNetworkRecoveryAttempt).toHaveBeenCalledWith(1, expect.any(Number));
        expect(startLoad).toHaveBeenCalledTimes(1);
        expect(onError).not.toHaveBeenCalled();
        manager.destroy();
    });
});

describe('PlaybackManager — receiver-timed fragment delivery samples', () => {
    /** A finished fragment as hls.js hands it over, with settable timings. */
    function loadedFrag(overrides: {
        type?: string;
        duration?: number;
        loaded?: number;
        start?: number;
        first?: number;
        end?: number;
    }) {
        const { type = 'main', duration = 6, loaded = 1_500_000 } = overrides;
        return {
            sn: 7,
            type,
            start: 42,
            duration,
            stats: {
                loaded,
                loading: {
                    start: overrides.start ?? 1_000,
                    first: overrides.first ?? 1_200,
                    end: overrides.end ?? 1_700,
                },
            },
        };
    }

    it('derives the sample from stats.loading — transfer time is first→end, not start→end', async () => {
        const onFragmentDelivered = vi.fn();
        const manager = createPlaybackManager(makeConfig({ onFragmentDelivered }));
        await manager.load('https://example.test/master.m3u8', 'hls');
        const hls = manager.getHls() as unknown as FakeHlsInstance;

        hls.emit(Hls.Events.FRAG_LOADED, {
            frag: loadedFrag({
                loaded: 1_500_000,
                duration: 6,
                start: 1_000,
                first: 1_200,
                end: 1_700,
            }),
        });

        // start→end (700 ms) would fold 200 ms of server think-time into the
        // rate and make a slow server look like a slow link.
        expect(onFragmentDelivered).toHaveBeenCalledTimes(1);
        expect(onFragmentDelivered).toHaveBeenCalledWith({
            bytes: 1_500_000,
            mediaSec: 6,
            requestMs: 700,
            transferMs: 500,
            ttfbMs: 200,
            endedAt: 1_700,
        });
        manager.destroy();
    });

    it('ignores non-main fragments', async () => {
        const onFragmentDelivered = vi.fn();
        const manager = createPlaybackManager(makeConfig({ onFragmentDelivered }));
        await manager.load('https://example.test/master.m3u8', 'hls');
        const hls = manager.getHls() as unknown as FakeHlsInstance;

        hls.emit(Hls.Events.FRAG_LOADED, { frag: loadedFrag({ type: 'audio' }) });

        expect(onFragmentDelivered).not.toHaveBeenCalled();
        manager.destroy();
    });

    it('emits nothing when the timings cannot describe a transfer', async () => {
        const onFragmentDelivered = vi.fn();
        const manager = createPlaybackManager(makeConfig({ onFragmentDelivered }));
        await manager.load('https://example.test/master.m3u8', 'hls');
        const hls = manager.getHls() as unknown as FakeHlsInstance;

        // Sub-millisecond / unrecorded transfer window.
        hls.emit(Hls.Events.FRAG_LOADED, { frag: loadedFrag({ first: 1_700, end: 1_700 }) });
        // Nothing actually arrived.
        hls.emit(Hls.Events.FRAG_LOADED, { frag: loadedFrag({ loaded: 0 }) });
        // `first` never stamped (LoadStats initialises the triple to 0) — a raw
        // first→end here would be the whole page uptime, i.e. ~0 bps.
        hls.emit(Hls.Events.FRAG_LOADED, { frag: loadedFrag({ first: 0 }) });

        expect(onFragmentDelivered).not.toHaveBeenCalled();
        manager.destroy();
    });

    it('does not require the consumer to implement the callback', async () => {
        const manager = createPlaybackManager(makeConfig({}));
        await manager.load('https://example.test/master.m3u8', 'hls');
        const hls = manager.getHls() as unknown as FakeHlsInstance;

        // Native-HLS consumers (and older callers) pass no handler at all.
        expect(() => hls.emit(Hls.Events.FRAG_LOADED, { frag: loadedFrag({}) })).not.toThrow();
        manager.destroy();
    });
});

describe('PlaybackManager — HLS.js seek playback intent', () => {
    async function hlsPlayer(
        initiallyPaused: boolean,
        autoPlay = true,
    ): Promise<{
        manager: ReturnType<typeof createPlaybackManager>;
        video: HTMLVideoElement;
        play: ReturnType<typeof vi.fn>;
    }> {
        const video = document.createElement('video');
        let paused = initiallyPaused;
        Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
        Object.defineProperty(video, 'readyState', {
            configurable: true,
            value: 0,
        });
        vi.spyOn(video, 'pause').mockImplementation(() => {
            paused = true;
        });
        vi.spyOn(video, 'load').mockImplementation(() => {});
        const play = vi.fn(() => {
            paused = false;
            return Promise.resolve();
        });
        Object.defineProperty(video, 'play', { configurable: true, value: play });
        const manager = createPlaybackManager({ ...makeConfig({}, video), autoPlay });
        await manager.load('https://example.test/master.m3u8', 'hls');
        paused = initiallyPaused;
        return { manager, video, play };
    }

    async function currentHls(
        manager: ReturnType<typeof createPlaybackManager>,
    ): Promise<FakeHlsInstance> {
        await vi.waitFor(() => expect(manager.getHls()).not.toBeNull());
        return manager.getHls() as unknown as FakeHlsInstance;
    }

    it('still autoplays an initial manifest without seek intent', async () => {
        const { manager, video, play } = await hlsPlayer(true);
        (await currentHls(manager)).emit(Hls.Events.MANIFEST_PARSED);
        expect(play).toHaveBeenCalledOnce();
        expect(video.paused).toBe(false);
        manager.destroy();
    });

    it('keeps a paused seek paused even when initial autoplay is enabled', async () => {
        const { manager, video, play } = await hlsPlayer(true);
        manager.resetForSeek(300);
        (await currentHls(manager)).emit(Hls.Events.MANIFEST_PARSED);
        video.dispatchEvent(new Event('loadeddata'));
        expect(play).not.toHaveBeenCalled();
        expect(video.paused).toBe(true);
        manager.destroy();
    });

    it('resumes a playing seek even when initial autoplay is disabled', async () => {
        const { manager, video, play } = await hlsPlayer(false, false);
        manager.resetForSeek(300);
        (await currentHls(manager)).emit(Hls.Events.MANIFEST_PARSED);
        expect(play).not.toHaveBeenCalled();
        video.dispatchEvent(new Event('loadeddata'));
        expect(play).toHaveBeenCalledOnce();
        expect(video.currentTime).toBe(300);
        expect(video.paused).toBe(false);
        manager.destroy();
    });

    it.each([true, false])(
        'preserves the original paused=%s intent through replacement seeks',
        async (initiallyPaused) => {
            const { manager, video, play } = await hlsPlayer(initiallyPaused, initiallyPaused);
            manager.resetForSeek(300);
            manager.resetForSeek(700);
            manager.resetForSeek(900);
            (await currentHls(manager)).emit(Hls.Events.MANIFEST_PARSED);
            expect(play).not.toHaveBeenCalled();
            (await currentHls(manager)).emit(Hls.Events.MANIFEST_PARSED);
            video.dispatchEvent(new Event('loadeddata'));
            expect(play).toHaveBeenCalledTimes(initiallyPaused ? 0 : 1);
            expect(video.paused).toBe(initiallyPaused);
            expect((manager as unknown as PlaybackManagerInternals).currentStartPosition).toBe(900);
            if (!initiallyPaused) expect(video.currentTime).toBe(900);
            manager.destroy();
        },
    );

    it('respects an explicit play during a pending rebuild before a replacement seek', async () => {
        const { manager, video, play } = await hlsPlayer(true, false);
        manager.resetForSeek(300);
        await video.play();
        manager.resetForSeek(900);
        (await currentHls(manager)).emit(Hls.Events.MANIFEST_PARSED);
        expect(play).toHaveBeenCalledOnce();
        (await currentHls(manager)).emit(Hls.Events.MANIFEST_PARSED);
        video.dispatchEvent(new Event('loadeddata'));
        expect(play).toHaveBeenCalledTimes(2);
        expect(video.currentTime).toBe(900);
        expect(video.paused).toBe(false);
        manager.destroy();
    });

    it('retains play intent when another seek arrives before a decoded frame', async () => {
        const { manager, video, play } = await hlsPlayer(false, false);
        manager.resetForSeek(300);
        (await currentHls(manager)).emit(Hls.Events.MANIFEST_PARSED);
        expect(play).not.toHaveBeenCalled();
        manager.resetForSeek(900);
        (await currentHls(manager)).emit(Hls.Events.MANIFEST_PARSED);
        video.dispatchEvent(new Event('loadeddata'));
        expect(play).toHaveBeenCalledOnce();
        expect(video.currentTime).toBe(900);
        expect(video.paused).toBe(false);
        manager.destroy();
    });

    it('leaves coordinated seek playback paused despite initial autoplay', async () => {
        const { manager, video, play } = await hlsPlayer(false);
        manager.resetForSeek(300);
        manager.resetForSeek(700, false, true);
        (await currentHls(manager)).emit(Hls.Events.MANIFEST_PARSED);
        (await currentHls(manager)).emit(Hls.Events.MANIFEST_PARSED);
        video.dispatchEvent(new Event('loadeddata'));
        expect(play).not.toHaveBeenCalled();
        expect(video.paused).toBe(true);
        manager.destroy();
    });

    it('clears paused seek intent when a different source is loaded', async () => {
        const { manager, video, play } = await hlsPlayer(true);
        manager.resetForSeek(300);
        (await currentHls(manager)).emit(Hls.Events.MANIFEST_PARSED);
        expect(play).not.toHaveBeenCalled();
        await manager.load('https://example.test/replacement.m3u8', 'hls');
        (await currentHls(manager)).emit(Hls.Events.MANIFEST_PARSED);
        video.dispatchEvent(new Event('loadeddata'));
        expect(play).toHaveBeenCalledOnce();
        expect(video.paused).toBe(false);
        manager.destroy();
    });
});

describe('PlaybackManager — queued native HLS seeks', () => {
    function nativePlayer(initiallyPaused = false): {
        manager: ReturnType<typeof createPlaybackManager>;
        video: HTMLVideoElement;
        play: ReturnType<typeof vi.fn>;
    } {
        const video = document.createElement('video');
        let paused = initiallyPaused;
        Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
        vi.spyOn(video, 'pause').mockImplementation(() => {
            paused = true;
        });
        const play = vi.fn(() => {
            paused = false;
            return Promise.resolve();
        });
        Object.defineProperty(video, 'play', { configurable: true, value: play });
        vi.spyOn(video, 'load').mockImplementation(() => {});
        const manager = createPlaybackManager(makeConfig({}, video));
        const internals = manager as unknown as PlaybackManagerInternals;
        internals.currentMode = 'hls';
        internals.currentUrl = 'https://example.test/master.m3u8';
        return { manager, video, play };
    }

    function burstPlayer() {
        const video = document.createElement('video');
        Object.defineProperty(video, 'paused', { configurable: true, value: true });
        const play = vi.spyOn(video, 'play').mockResolvedValue(undefined);
        vi.spyOn(video, 'pause').mockImplementation(() => {});
        const load = vi.spyOn(video, 'load').mockImplementation(() => {});
        const manager = createPlaybackManager({ ...makeConfig({}, video), isSafari: true });
        const internals = manager as unknown as PlaybackManagerInternals & {
            usingNativeHls: boolean;
        };
        internals.currentMode = 'hls';
        internals.currentUrl = 'https://example.test/master.m3u8';
        internals.usingNativeHls = true;
        return { manager, video, play, load, internals };
    }

    it('leaves a single explicit native party seek on the ordinary seek path', () => {
        const { manager, load } = burstPlayer();
        manager.recoverNativePartySeekBurst(20);
        vi.advanceTimersByTime(2000);
        expect(load).not.toHaveBeenCalled();
        manager.destroy(true);
    });

    it('coalesces a transcode-mode burst to one native reload at the latest target', () => {
        const { manager, video, play, load } = burstPlayer();
        manager.recoverNativePartySeekBurst(20);
        manager.recoverNativePartySeekBurst(30);
        manager.recoverNativePartySeekBurst(40);
        vi.advanceTimersByTime(200);
        manager.recoverNativePartySeekBurst(50);
        vi.advanceTimersByTime(250);
        expect(load).toHaveBeenCalledOnce();
        expect(new URL(video.src).searchParams.get('seek')).toBe('50');
        manager.recoverNativePartySeekBurst(60);
        video.dispatchEvent(new Event('loadedmetadata'));
        expect(video.currentTime).toBe(60);
        expect(load).toHaveBeenCalledOnce();
        expect(play).not.toHaveBeenCalled();
        manager.destroy(true);
    });

    it('bounds recovery despite a continuous seek stream and never resumes a paused party', () => {
        const { manager, video, load, play } = burstPlayer();
        for (let i = 0; i < 7; i++) {
            manager.recoverNativePartySeekBurst(20 + i * 10);
            vi.advanceTimersByTime(200);
        }
        expect(load).toHaveBeenCalledOnce();
        video.dispatchEvent(new Event('loadedmetadata'));
        expect(video.currentTime).toBe(80);
        expect(play).not.toHaveBeenCalled();
        manager.destroy(true);
    });

    it('cancels deferred reload when failed-seek recovery already resumed playback', () => {
        const { manager, video, load } = burstPlayer();
        for (const target of [20, 30, 40]) manager.recoverNativePartySeekBurst(target);
        Object.defineProperty(video, 'paused', { configurable: true, value: false });
        vi.advanceTimersByTime(250);
        expect(load).not.toHaveBeenCalled();
        manager.destroy(true);
    });

    it('requires three seeks inside a sliding one-second window', () => {
        const { manager, load } = burstPlayer();
        manager.recoverNativePartySeekBurst(20);
        vi.advanceTimersByTime(900);
        manager.recoverNativePartySeekBurst(30);
        vi.advanceTimersByTime(900);
        manager.recoverNativePartySeekBurst(40);
        vi.advanceTimersByTime(250);
        expect(load).not.toHaveBeenCalled();
        manager.destroy(true);
    });

    it('preserves copy-mode resume and latest target when metadata arrives after eight seconds', () => {
        const { manager, video, play } = nativePlayer();
        manager.resetForSeek(20, true);
        manager.resetForSeek(40, true);
        vi.advanceTimersByTime(9000);
        video.dispatchEvent(new Event('loadedmetadata'));
        video.dispatchEvent(new Event('loadedmetadata'));
        expect(video.currentTime).toBe(40);
        expect(play).toHaveBeenCalledOnce();
        manager.destroy(true);
    });

    it('cancels burst recovery on source teardown and bounds a missing metadata event', () => {
        const { manager, load } = burstPlayer();
        for (const target of [20, 30, 40]) manager.recoverNativePartySeekBurst(target);
        manager.destroy(true);
        vi.advanceTimersByTime(2000);
        expect(load).not.toHaveBeenCalled();
        const next = burstPlayer();
        for (const target of [20, 30, 40]) next.manager.recoverNativePartySeekBurst(target);
        vi.advanceTimersByTime(250);
        vi.advanceTimersByTime(8000);
        expect(
            (next.internals as unknown as { seekResetInFlight: boolean }).seekResetInFlight,
        ).toBe(false);
        expect(next.play).not.toHaveBeenCalled();
        next.manager.destroy(true);
    });

    it('resumes at the newest queued target after its own reload paused the element', () => {
        const { manager, video, play } = nativePlayer();
        manager.resetForSeek(300, true);
        manager.resetForSeek(700, true);
        manager.resetForSeek(900, true);
        video.dispatchEvent(new Event('loadedmetadata'));
        expect(play).not.toHaveBeenCalled();
        video.dispatchEvent(new Event('loadedmetadata'));
        expect(video.currentTime).toBe(900);
        expect(play).toHaveBeenCalledTimes(1);
        expect(video.paused).toBe(false);
        manager.destroy();
    });

    it('keeps queued seeks paused when playback was already paused', () => {
        const { manager, video, play } = nativePlayer(true);
        manager.resetForSeek(300, true);
        manager.resetForSeek(700, true);
        video.dispatchEvent(new Event('loadedmetadata'));
        video.dispatchEvent(new Event('loadedmetadata'));
        expect(video.currentTime).toBe(700);
        expect(play).not.toHaveBeenCalled();
        manager.destroy();
    });

    it('respects an explicit play during a pending native reload before a replacement seek', async () => {
        const { manager, video, play } = nativePlayer(true);
        manager.resetForSeek(300, true);
        await video.play();
        manager.resetForSeek(900, true);
        video.dispatchEvent(new Event('loadedmetadata'));
        expect(play).toHaveBeenCalledOnce();
        video.dispatchEvent(new Event('loadedmetadata'));
        expect(video.currentTime).toBe(900);
        expect(play).toHaveBeenCalledTimes(2);
        expect(video.paused).toBe(false);
        manager.destroy();
    });

    it('finishes a native copy reload when a small queued seek uses the generic reset call', () => {
        const { manager, video, play } = nativePlayer();
        manager.resetForSeek(997, true);
        manager.resetForSeek(15);
        video.dispatchEvent(new Event('loadedmetadata'));
        video.dispatchEvent(new Event('loadedmetadata'));
        expect(video.currentTime).toBe(15);
        expect(play).toHaveBeenCalledTimes(1);
        manager.destroy();
    });

    it('respects coordinated resume ownership for the latest queued seek', () => {
        const { manager, video, play } = nativePlayer();
        manager.resetForSeek(300, true);
        manager.resetForSeek(700, true, true);
        video.dispatchEvent(new Event('loadedmetadata'));
        video.dispatchEvent(new Event('loadedmetadata'));
        expect(video.currentTime).toBe(700);
        expect(play).not.toHaveBeenCalled();
        manager.destroy();
    });

    it('does not reuse an earlier successful seek resume intent after the user pauses', () => {
        const { manager, video, play } = nativePlayer();
        manager.resetForSeek(300, true);
        video.dispatchEvent(new Event('loadedmetadata'));
        video.pause();
        manager.resetForSeek(700, true);
        video.dispatchEvent(new Event('loadedmetadata'));
        expect(video.currentTime).toBe(700);
        expect(play).toHaveBeenCalledTimes(1);
        expect(video.paused).toBe(true);
        manager.destroy();
    });

    it('cancels a pending native metadata callback when the player is destroyed', () => {
        const { manager, video, play } = nativePlayer();
        manager.resetForSeek(300, true);
        manager.destroy(true);
        video.currentTime = 12;
        video.dispatchEvent(new Event('loadedmetadata'));
        expect(video.currentTime).toBe(12);
        expect(play).not.toHaveBeenCalled();
    });

    it('discards queued targets when a destroyed manager starts another source', () => {
        const { manager, video, play } = nativePlayer();
        manager.resetForSeek(300, true);
        manager.resetForSeek(700, true);
        manager.destroy(true);
        const internals = manager as unknown as PlaybackManagerInternals;
        internals.currentUrl = 'https://example.test/another.m3u8';
        // Simulate load() beginning the replacement source after destroy().
        (internals as unknown as { isDestroyed: boolean }).isDestroyed = false;
        manager.resetForSeek(20, true);
        video.dispatchEvent(new Event('loadedmetadata'));
        expect(video.currentTime).toBe(20);
        expect(video.src).toContain('another.m3u8?seek=20');
        expect(play).not.toHaveBeenCalled();
        manager.destroy();
    });
});

describe('PlaybackManager — native initial resume listener ownership', () => {
    it('does not apply a destroyed manager’s resume target to a replacement source', async () => {
        const video = document.createElement('video');
        vi.spyOn(video, 'canPlayType').mockReturnValue('probably');
        vi.spyOn(video, 'load').mockImplementation(() => {});
        vi.spyOn(video, 'pause').mockImplementation(() => {});
        const config = { ...makeConfig({}, video), isSafari: true };
        const outgoing = createPlaybackManager(config);
        await outgoing.load('https://example.test/old.m3u8', 'hls', { startPosition: 1205.25 });
        outgoing.destroy(true); // Metadata never arrived for the outgoing source.
        const replacement = createPlaybackManager(config);
        await replacement.load('https://example.test/new.m3u8', 'hls', { startPosition: 0 });
        video.dispatchEvent(new Event('loadedmetadata'));
        expect(video.currentTime).toBe(0);
        replacement.destroy();
    });

    it('replaces the initial resume listener when a copy seek reloads before metadata', async () => {
        const video = document.createElement('video');
        vi.spyOn(video, 'canPlayType').mockReturnValue('probably');
        vi.spyOn(video, 'load').mockImplementation(() => {});
        vi.spyOn(video, 'pause').mockImplementation(() => {});
        const manager = createPlaybackManager({ ...makeConfig({}, video), isSafari: true });
        await manager.load('https://example.test/stream.m3u8', 'hls', { startPosition: 1205.25 });
        const setTime = vi.spyOn(video, 'currentTime', 'set');
        manager.resetForSeek(514, true);
        video.dispatchEvent(new Event('loadedmetadata'));
        expect(setTime).toHaveBeenCalledExactlyOnceWith(514);
        manager.destroy();
    });
});

describe('PlaybackManager — iOS native HLS source waits for a user gesture', () => {
    function nativeVideo(): HTMLVideoElement {
        const video = document.createElement('video');
        vi.spyOn(video, 'canPlayType').mockReturnValue('probably');
        vi.spyOn(video, 'load').mockImplementation(() => {});
        vi.spyOn(video, 'pause').mockImplementation(() => {});
        return video;
    }
    function stubActivation(isActive: boolean): void {
        vi.stubGlobal('navigator', { ...navigator, userActivation: { isActive } });
    }

    it('keeps the source detached outside a gesture and attaches it on the tap', async () => {
        stubActivation(false);
        const video = nativeVideo();
        const play = vi.spyOn(video, 'play').mockResolvedValue(undefined);
        const onAutoplayResult = vi.fn();
        const manager = createPlaybackManager({
            ...makeConfig({ onAutoplayResult }, video),
            isSafari: true,
            autoPlay: true,
            deferNativeSourceUntilGesture: true,
        });
        await manager.load('https://example.test/stream.m3u8', 'hls', { startPosition: 140 });

        expect(video.getAttribute('src')).toBeNull();
        expect(play).not.toHaveBeenCalled();
        expect(manager.hasDeferredSource()).toBe(true);
        expect(onAutoplayResult).toHaveBeenCalledWith(
            expect.objectContaining({ success: false, playingMuted: false }),
        );

        await manager.play();
        expect(video.src).toBe('https://example.test/stream.m3u8?seek=140');
        expect(play).toHaveBeenCalledOnce();
        expect(manager.hasDeferredSource()).toBe(false);
        video.dispatchEvent(new Event('loadedmetadata'));
        expect(video.currentTime).toBe(140);
        manager.destroy();
    });

    it('fires onBeforeSourceChange before the native source is set', async () => {
        // iOS: the controller removes <track> children here, because tracks present
        // when a load starts reach AVFoundation and fail an HLS master.
        stubActivation(true);
        const video = nativeVideo();
        const srcAtCall: Array<string | null> = [];
        const manager = createPlaybackManager({
            ...makeConfig(
                { onBeforeSourceChange: () => srcAtCall.push(video.getAttribute('src')) },
                video,
            ),
            isSafari: true,
            deferNativeSourceUntilGesture: true,
        });
        await manager.load('https://example.test/stream.m3u8', 'hls');
        expect(srcAtCall).toEqual([null]);
        expect(video.src).toBe('https://example.test/stream.m3u8');
        manager.destroy();
    });

    it('attaches at once inside a gesture', async () => {
        stubActivation(true);
        const video = nativeVideo();
        const manager = createPlaybackManager({
            ...makeConfig({}, video),
            isSafari: true,
            deferNativeSourceUntilGesture: true,
        });
        await manager.load('https://example.test/stream.m3u8', 'hls');
        expect(video.src).toBe('https://example.test/stream.m3u8');
        expect(manager.startDeferredSource()).toBe(false);
        manager.destroy();
    });

    it('does not hold back a reload of an element that has already played', async () => {
        stubActivation(false);
        const video = nativeVideo();
        const config = {
            ...makeConfig({}, video),
            isSafari: true,
            deferNativeSourceUntilGesture: true,
        };
        const first = createPlaybackManager(config);
        await first.load('https://example.test/first.m3u8', 'hls');
        // Control: before it has played, the element's source waits.
        expect(video.getAttribute('src')).toBeNull();
        video.dispatchEvent(new Event('playing'));
        first.destroy(true);
        const reconnect = createPlaybackManager(config);
        await reconnect.load('https://example.test/rebuilt.m3u8', 'hls');
        expect(video.src).toBe('https://example.test/rebuilt.m3u8');
        reconnect.destroy();
    });

    it('a seek before the tap moves the waiting source instead of attaching it', async () => {
        stubActivation(false);
        const video = nativeVideo();
        const manager = createPlaybackManager({
            ...makeConfig({}, video),
            isSafari: true,
            autoPlay: true,
            deferNativeSourceUntilGesture: true,
        });
        await manager.load('https://example.test/stream.m3u8', 'hls', { startPosition: 140 });
        manager.resetForSeek(514, true);

        expect(video.getAttribute('src')).toBeNull();
        expect(manager.hasDeferredSource()).toBe(true);
        expect(manager.startDeferredSource()).toBe(true);
        expect(video.src).toBe('https://example.test/stream.m3u8?seek=514');
        video.dispatchEvent(new Event('loadedmetadata'));
        expect(video.currentTime).toBe(514);
        manager.destroy();
    });

    it('attaches the waiting source on any play() route (the element play event)', async () => {
        stubActivation(false);
        const video = nativeVideo();
        const manager = createPlaybackManager({
            ...makeConfig({}, video),
            isSafari: true,
            deferNativeSourceUntilGesture: true,
        });
        await manager.load('https://example.test/stream.m3u8', 'hls');
        video.dispatchEvent(new Event('play'));
        expect(video.src).toBe('https://example.test/stream.m3u8');
        expect(manager.hasDeferredSource()).toBe(false);
        manager.destroy();
    });

    it('a second load while a source waits replaces its play listener instead of leaking it', async () => {
        stubActivation(false);
        const video = nativeVideo();
        const add = vi.spyOn(video, 'addEventListener');
        const remove = vi.spyOn(video, 'removeEventListener');
        const manager = createPlaybackManager({
            ...makeConfig({}, video),
            isSafari: true,
            deferNativeSourceUntilGesture: true,
        });
        await manager.load('https://example.test/first.m3u8', 'hls');
        const firstListener = add.mock.calls.find(([type]) => type === 'play')![1];
        await manager.load('https://example.test/second.m3u8', 'hls');

        expect(remove).toHaveBeenCalledWith('play', firstListener);
        expect(manager.hasDeferredSource()).toBe(true);
        video.dispatchEvent(new Event('play'));
        expect(video.src).toBe('https://example.test/second.m3u8');
        manager.destroy();
    });

    it('drops a waiting source on destroy', async () => {
        stubActivation(false);
        const video = nativeVideo();
        const manager = createPlaybackManager({
            ...makeConfig({}, video),
            isSafari: true,
            deferNativeSourceUntilGesture: true,
        });
        await manager.load('https://example.test/stream.m3u8', 'hls');
        manager.destroy(true);
        expect(manager.startDeferredSource()).toBe(false);
        video.dispatchEvent(new Event('play'));
        expect(video.getAttribute('src')).toBeNull();
    });

    it('reports a tap-wait only when autoplay was wanted', async () => {
        stubActivation(false);
        const video = nativeVideo();
        const onAutoplayResult = vi.fn();
        const manager = createPlaybackManager({
            ...makeConfig({ onAutoplayResult }, video),
            isSafari: true,
            autoPlay: false,
            deferNativeSourceUntilGesture: true,
        });
        await manager.load('https://example.test/stream.m3u8', 'hls');
        expect(manager.hasDeferredSource()).toBe(true);
        expect(onAutoplayResult).not.toHaveBeenCalled();
        manager.destroy();
    });

    it('never holds back a source when the option is off (desktop Safari)', async () => {
        stubActivation(false);
        const video = nativeVideo();
        const manager = createPlaybackManager({ ...makeConfig({}, video), isSafari: true });
        await manager.load('https://example.test/stream.m3u8', 'hls');
        expect(video.src).toBe('https://example.test/stream.m3u8');
        manager.destroy();
    });
});

describe('PlaybackManager — temporary transcode admission refusal', () => {
    it('leaves a nonfatal 503 to hls.js retries without requesting a reconnect', async () => {
        const onError = vi.fn();
        const onTransientDiagnostic = vi.fn();
        const onNetworkRecoveryAttempt = vi.fn();
        const manager = createPlaybackManager(
            makeConfig({ onError, onTransientDiagnostic, onNetworkRecoveryAttempt }),
        );
        await manager.load('https://example.test/master.m3u8', 'hls');
        const hls = manager.getHls() as unknown as FakeHlsInstance;
        hls.emit(Hls.Events.ERROR, {
            type: Hls.ErrorTypes.NETWORK_ERROR,
            details: 'manifestLoadError',
            fatal: false,
            response: { code: 503 },
            networkDetails: new Response(null, {
                status: 503,
                headers: { 'X-Lumastra-Diagnostic-Code': 'concurrency-limit', 'Retry-After': '30' },
            }),
        });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(onTransientDiagnostic).toHaveBeenCalledWith(
            expect.objectContaining({ httpStatus: 503, serverDiagnosticCode: 'concurrency-limit' }),
        );
        expect(onError).not.toHaveBeenCalled();
        expect(onNetworkRecoveryAttempt).not.toHaveBeenCalled();
        manager.destroy();
    });
});

it('loads a ready granted file URL without replacing its credential or session', async () => {
    const video = document.createElement('video');
    const manager = createPlaybackManager(makeConfig({}, video));
    const href = '/api/v1/playback/media/file?grant=opaque%2Bsecret&PlaySessionId=server-session';
    await manager.load(href, 'direct');
    expect(video.getAttribute('src')).toBe(href);
    manager.destroy();
});

describe('PlaybackManager — restart-expired grant response', () => {
    it('hands a non-terminal 410 to session-expired recovery instead of unauthorized handling', async () => {
        const onError = vi.fn();
        const manager = createPlaybackManager(makeConfig({ onError }));
        await manager.load('https://example.test/master.m3u8', 'hls');
        const hls = manager.getHls() as unknown as FakeHlsInstance;
        hls.emit(Hls.Events.ERROR, {
            type: Hls.ErrorTypes.NETWORK_ERROR,
            details: 'fragLoadError',
            fatal: true,
            response: { code: 410 },
            networkDetails: new Response(null, {
                status: 410,
                headers: {
                    'X-Playback-Grant-Reason': 'session_restarted',
                    'X-Lumastra-Diagnostic-Code': 'session-expired',
                    'X-Lumastra-Session-Terminal': 'false',
                },
            }),
            frag: { type: 'main', sn: 124 },
        });
        expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'session_expired',
                httpStatus: 410,
                recoverable: true,
                sessionTerminal: false,
                serverDiagnosticCode: 'session-expired',
            }),
        );
        manager.destroy();
    });
});

describe('PlaybackManager — manifest bitrate is not measured video bitrate', () => {
    it.each([
        [undefined, 'h264', ''],
        [3_080_794, 'h264', '3.1 Mbps'],
        [8_000_000, 'hevc', '8.0 Mbps'],
    ])('keeps source bitrate %s with codec %s', (sourceBitrate, sourceCodec, expected) => {
        const onCodecDetected = vi.fn();
        const manager = createPlaybackManager(makeConfig({ onCodecDetected }));
        const internal = manager as unknown as {
            hls: { levels: { videoCodec: string; bitrate: number }[] };
            detectCodecFromManifest(codec: string, bitrate?: number): void;
        };
        internal.hls = { levels: [{ videoCodec: 'avc1.640028', bitrate: 40_000_000 }] };
        internal.detectCodecFromManifest(sourceCodec, sourceBitrate);
        expect(onCodecDetected).toHaveBeenCalledWith(
            expect.objectContaining({ formattedBitrate: expected }),
        );
    });
});

describe('PlaybackManager — party startup clock supersedes personal resume', () => {
    it.each([
        { isSafari: false, position: 0 },
        { isSafari: true, position: 0 },
        { isSafari: false, position: 120 },
        { isSafari: true, position: 120 },
    ])('late metadata after rejoin uses %j', async ({ isSafari, position }) => {
        const video = document.createElement('video');
        vi.spyOn(video, 'canPlayType').mockReturnValue('probably');
        vi.spyOn(video, 'load').mockImplementation(() => {});
        vi.spyOn(video, 'pause').mockImplementation(() => {});
        let partyPosition: number | undefined;
        const manager = createPlaybackManager({
            ...makeConfig({}, video),
            isSafari,
        });
        try {
            await manager.load('https://example.test/master.m3u8', 'hls', {
                startPosition: 181,
                getStartupPosition: () => partyPosition,
            });
            partyPosition = position;
            video.currentTime = 181;
            video.dispatchEvent(new Event('loadedmetadata'));
            expect(video.currentTime).toBe(position);
        } finally {
            manager.destroy();
        }
    });

    it.each([false, true])('starts from the existing party zero on Safari=%s', async (isSafari) => {
        const video = document.createElement('video');
        vi.spyOn(video, 'canPlayType').mockReturnValue('probably');
        vi.spyOn(video, 'load').mockImplementation(() => {});
        vi.spyOn(video, 'pause').mockImplementation(() => {});
        const manager = createPlaybackManager({
            ...makeConfig({}, video),
            isSafari,
        });
        try {
            await manager.load('https://example.test/master.m3u8?seek=181', 'hls', {
                startPosition: 181,
                getStartupPosition: () => 0,
            });
            const inner = manager as unknown as PlaybackManagerInternals;
            expect(inner.currentStartPosition).toBe(0);
            expect(new URL(inner.currentUrl!).searchParams.has('seek')).toBe(false);
            video.currentTime = 181;
            video.dispatchEvent(new Event('loadedmetadata'));
            expect(video.currentTime).toBe(0);
            // A subsequent quality/audio replacement preserves the active clock,
            // even when the party's last control snapshot remains at zero.
            video.currentTime = 120;
            await manager.load('https://example.test/replacement.m3u8', 'hls', {
                startPosition: 120,
            });
            expect(inner.currentStartPosition).toBe(120);
            expect(new URL(inner.currentUrl!).searchParams.get('seek')).toBe('120');
            video.dispatchEvent(new Event('loadedmetadata'));
            expect(video.currentTime).toBe(120);
        } finally {
            manager.destroy();
        }
    });
});

describe('PlaybackManager — party clock at delayed source attachment', () => {
    it('updates the actual manifest URL when the party rejoins during HLS imports', async () => {
        const video = document.createElement('video');
        vi.spyOn(video, 'load').mockImplementation(() => {});
        vi.spyOn(video, 'pause').mockImplementation(() => {});
        const loadSource = vi.spyOn(Hls.prototype, 'loadSource');
        const getStartupPosition = vi.fn().mockReturnValueOnce(181).mockReturnValue(0);
        const manager = createPlaybackManager(makeConfig({}, video));
        try {
            await manager.load('https://example.test/master.m3u8?seek=181', 'hls', {
                startPosition: 181,
                getStartupPosition,
            });
            expect(loadSource).toHaveBeenCalledOnce();
            expect(new URL(loadSource.mock.calls[0][0]).searchParams.has('seek')).toBe(false);
            expect(
                new URL(
                    (manager as unknown as PlaybackManagerInternals).currentUrl!,
                ).searchParams.has('seek'),
            ).toBe(false);
        } finally {
            manager.destroy();
            loadSource.mockRestore();
        }
    });

    it('updates the native source URL when the party rejoins before the initial tap', async () => {
        const video = document.createElement('video');
        vi.spyOn(video, 'canPlayType').mockReturnValue('probably');
        vi.spyOn(video, 'load').mockImplementation(() => {});
        vi.spyOn(video, 'pause').mockImplementation(() => {});
        const activation = Object.getOwnPropertyDescriptor(navigator, 'userActivation');
        Object.defineProperty(navigator, 'userActivation', {
            configurable: true,
            value: { isActive: false, hasBeenActive: false },
        });
        let position = 181;
        const manager = createPlaybackManager({
            ...makeConfig({}, video),
            isSafari: true,
            deferNativeSourceUntilGesture: true,
        });
        try {
            await manager.load('https://example.test/master.m3u8?seek=181', 'hls', {
                startPosition: 181,
                getStartupPosition: () => position,
            });
            expect(video.src).toBe('');
            position = 0;
            manager.startDeferredSource();
            expect(new URL(video.src).searchParams.has('seek')).toBe(false);
            expect((manager as unknown as PlaybackManagerInternals).currentStartPosition).toBe(0);
        } finally {
            manager.destroy();
            if (activation) Object.defineProperty(navigator, 'userActivation', activation);
            else Reflect.deleteProperty(navigator, 'userActivation');
        }
    });
});

it('late party rejoin at 120 overrides a zero personal HLS startup', async () => {
    const video = document.createElement('video');
    let position: number | undefined;
    const manager = createPlaybackManager(makeConfig({}, video));
    try {
        await manager.load('https://example.test/zero.m3u8', 'hls', {
            startPosition: 0,
            getStartupPosition: () => position,
        });
        position = 120;
        video.dispatchEvent(new Event('loadedmetadata'));
        expect(video.currentTime).toBe(120);
    } finally {
        manager.destroy();
    }
});

it('a newly joined party cancels personal autoplay queued before decoded data', async () => {
    const video = document.createElement('video');
    Object.defineProperty(video, 'readyState', { configurable: true, value: 0 });
    const play = vi.spyOn(video, 'play').mockResolvedValue(undefined);
    vi.spyOn(video, 'pause').mockImplementation(() => {});
    let inParty = false;
    const manager = createPlaybackManager({
        ...makeConfig({}, video),
        autoPlay: true,
        isInWatchParty: () => inParty,
    });
    try {
        await manager.load('https://example.test/queued.m3u8', 'hls', {
            startPosition: 181,
            getStartupPosition: () => (inParty ? 0 : undefined),
        });
        const internal = manager as unknown as PlaybackManagerInternals;
        internal.hls!.emit(Hls.Events.MANIFEST_PARSED, { levels: [] });
        inParty = true;
        video.dispatchEvent(new Event('loadedmetadata'));
        expect(video.currentTime).toBe(0);
        video.dispatchEvent(new Event('loadeddata'));
        expect(video.currentTime).toBe(0);
        expect(play).not.toHaveBeenCalled();
    } finally {
        manager.destroy();
    }
});

it('preserves an explicit seek while initial HLS imports are pending', async () => {
    const video = document.createElement('video');
    const loadSource = vi.spyOn(Hls.prototype, 'loadSource');
    const manager = createPlaybackManager(makeConfig({}, video));
    try {
        const loading = manager.load('https://example.test/loading.m3u8?seek=181', 'hls', {
            startPosition: 181,
            getStartupPosition: () => 181,
        });
        manager.resetForSeek(95, false, true);
        await loading;
        expect(loadSource).toHaveBeenCalledOnce();
        expect(new URL(loadSource.mock.calls[0][0]).searchParams.get('seek')).toBe('95');
        video.dispatchEvent(new Event('loadedmetadata'));
        expect(video.currentTime).toBe(95);
    } finally {
        manager.destroy();
        loadSource.mockRestore();
    }
});
