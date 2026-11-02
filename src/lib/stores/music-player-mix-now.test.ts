// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { playbackStartFixture } from '$lib/utils/playback-start.fixture.js';
import { musicTrackFromCard } from '$lib/utils/music-track';

/**
 * Unit tests for `musicPlayerStore.mixNow()` — the manual "hold-to-mix"
 * crossfade arming action in music-player.store.ts.
 *
 * These tests drive a MOCK AudioBackend (injected via vi.mock of `$lib/audio`)
 * and pump synthetic time-update ticks through the store's `init()`-wired
 * `onTimeUpdate` callback where needed. The mock records every call so we can
 * assert on `triggerCrossfade` invocation (or its absence when a pending is
 * merely armed). No real timers or audio are used — `triggerCrossfade` returns
 * a test-controlled deferred Promise, so we decide exactly when the backend
 * crossfade "completes".
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import type { MusicTrack, QueueItem } from '$lib/schemas/music';
import { applyLufsGain } from '$lib/utils/lufs-gain';
import { toasts } from '$lib/stores/toast.store';
import type {
    AudioBackend,
    AudioBackendCallbacks,
    CrossfadeOptions,
    TrackMetadata,
} from '$lib/audio';

// ---------------------------------------------------------------------------
// Module mocks — installed BEFORE the store is imported. The store reaches the
// network, the audio backend, the AirPlay detector, the device-id helper, and
// the persistence layer; all are neutralised here so tests stay deterministic.
// ---------------------------------------------------------------------------

/** Promise resolvers handed back by the mock backend's triggerCrossfade. */
interface Deferred {
    promise: Promise<void>;
    resolve: () => void;
    reject: (err: unknown) => void;
}

function makeDeferred(): Deferred {
    let resolve!: () => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/**
 * Recording mock backend. Every store→backend call lands in `calls` (ordered)
 * so tests can assert sequencing. `triggerCrossfade` parks on a deferred so the
 * test controls when the backend "finishes" the fade.
 */
interface MockBackend extends AudioBackend {
    calls: string[];
    capturedCallbacks: AudioBackendCallbacks | null;
    crossfadeDeferreds: Deferred[];
    lastCrossfadeOptions: CrossfadeOptions | undefined;
    lastVolume: number | undefined;
    currentTimeMs: number;
    durationMs: number;
    /** Clear recorder state so the SAME instance can be reused across tests. */
    reset(): void;
}

// The store is a singleton and guards re-init (`if (backend) return`), so the
// backend is installed exactly once for the whole file. We therefore use ONE
// persistent mock instance and reset its recorder between tests rather than
// swapping the instance (a swap would leave the store bound to a stale one).
let mockBackend: MockBackend;

function createMockBackend(): MockBackend {
    const calls: string[] = [];
    const crossfadeDeferreds: Deferred[] = [];
    let crossfading = false;

    const backend: MockBackend = {
        calls,
        capturedCallbacks: null,
        crossfadeDeferreds,
        lastCrossfadeOptions: undefined,
        lastVolume: undefined,
        currentTimeMs: 0,
        durationMs: 0,

        init(callbacks: AudioBackendCallbacks): void {
            calls.push('init');
            backend.capturedCallbacks = callbacks;
        },
        destroy(): void {
            calls.push('destroy');
        },
        async play(_src: string, _metadata: TrackMetadata): Promise<void> {
            calls.push('play');
        },
        pause(): void {
            calls.push('pause');
        },
        resume(): void {
            calls.push('resume');
        },
        stop(): void {
            calls.push('stop');
        },
        seekTo(ms: number): void {
            calls.push(`seekTo:${ms}`);
            backend.currentTimeMs = ms;
        },
        setVolume(volume: number): void {
            calls.push('setVolume');
            backend.lastVolume = volume;
        },
        mute(): void {
            calls.push('mute');
        },
        unmute(): void {
            calls.push('unmute');
        },
        async triggerCrossfade(
            _nextSrc: string,
            _metadata: TrackMetadata,
            options?: CrossfadeOptions,
        ): Promise<void> {
            calls.push('triggerCrossfade');
            backend.lastCrossfadeOptions = options;
            crossfading = true;
            const d = makeDeferred();
            crossfadeDeferreds.push(d);
            await d.promise;
            crossfading = false;
        },
        cancelCrossfade(): void {
            calls.push('cancelCrossfade');
            crossfading = false;
            // Mirror the real backend: cancelling resolves the awaited Promise
            // so triggerCrossfade's continuation runs.
            const pending = crossfadeDeferreds[crossfadeDeferreds.length - 1];
            pending?.resolve();
        },
        setPlaybackRate(rate: number): void {
            calls.push(`setPlaybackRate:${rate}`);
        },
        supportsGaplessAdvance: false,
        scheduleGaplessAdvance(): boolean {
            calls.push('scheduleGaplessAdvance');
            return false;
        },
        normalizePlaybackRate(): void {
            calls.push('normalizePlaybackRate');
        },
        getCurrentTimeMs(): number {
            return backend.currentTimeMs;
        },
        getDurationMs(): number {
            return backend.durationMs;
        },
        getPlaybackRate(): number {
            return 1;
        },
        isCrossfading(): boolean {
            return crossfading;
        },
        supportsCrossfade: true,
        supportsVolumeControl: true,
        normalizationStyle: 'gradual',
        getAudioElement(): HTMLAudioElement | null {
            return null;
        },
        getAllAudioElements(): HTMLAudioElement[] {
            return [];
        },
        async preload(): Promise<{ resumed: boolean }> {
            return { resumed: false };
        },
        async reloadCurrentSrc(): Promise<boolean> {
            return false;
        },
        prefetchNext(_src: string): void {
            calls.push('prefetchNext');
        },
        reset(): void {
            calls.length = 0;
            crossfadeDeferreds.length = 0;
            crossfading = false;
            backend.lastCrossfadeOptions = undefined;
            backend.lastVolume = undefined;
            backend.currentTimeMs = 0;
            backend.durationMs = 0;
        },
    };
    return backend;
}

// Single persistent instance — created once, reset per test.
const persistentBackend = createMockBackend();

vi.mock('$lib/audio', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/audio')>();
    return {
        ...actual,
        createAudioBackend: vi.fn(async () => mockBackend),
    };
});

vi.mock('$lib/audio/airplay-detector', () => ({
    createAirPlayDetector: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
    })),
}));

vi.mock('$lib/components/player/device-id', () => ({
    getDeviceId: vi.fn(() => 'test-device'),
}));

vi.mock('./music-playback-persistence', () => ({
    savePlaybackState: vi.fn(),
    loadPlaybackState: vi.fn(() => null),
    clearPlaybackState: vi.fn(),
    onPlaybackSessionEndedElsewhere: vi.fn(() => () => {}),
}));

// `$lib/api/music` is imported dynamically throughout the store. Each export is
// a spy so we can count reportMusicPlayback calls (double-report regression guards).
// vi.hoisted() ensures these are initialised before the hoisted vi.mock factories run.
const {
    reportMusicPlayback,
    getTrack,
    getRecommendations,
    getAlbum,
    startMusicPlaySession,
    replayMusicPlays,
    reportMusicPlaybackBeacon,
} = vi.hoisted(() => ({
    reportMusicPlayback: vi.fn((_id: string, _body: import('$lib/api/music').MusicPlaybackReport) =>
        Promise.resolve({ data: null, error: null }),
    ),
    getTrack: vi.fn(() => Promise.resolve({ data: null })),
    getAlbum: vi.fn((_id: string): Promise<{ data?: { tracks: unknown[] }; error?: unknown }> =>
        Promise.resolve({ data: { tracks: [] } }),
    ),
    // getRecommendations returns no `next` so fetchNextTrack never enqueues real tracks
    // or triggers auto-resume during these tests.
    getRecommendations: vi.fn(
        (
            _args: import('$lib/api/music').RecommendationArgs,
        ): Promise<{
            data: {
                next?: MusicTrack;
                alternatives: MusicTrack[];
                source: string;
            };
        }> =>
            Promise.resolve({
                data: { alternatives: [], source: 'metadata' },
            }),
    ),
    startMusicPlaySession: vi.fn(({ trackId }: { trackId: string }) =>
        Promise.resolve({ data: playbackStartFixture(trackId, trackId) }),
    ),
    replayMusicPlays: vi.fn(() => Promise.resolve({ data: null, error: null })),
    reportMusicPlaybackBeacon: vi.fn(() => true),
}));

vi.mock('$lib/api/music', () => ({
    reportMusicPlayback,
    getTrack,
    getRecommendations,
    getAlbum,
    startMusicPlaySession,
    replayMusicPlays,
    reportMusicPlaybackBeacon,
}));

// Now import the store — mocks above are hoisted by vitest and applied first.
import { musicPlayerStore } from './music-player.store';

// Pre-load the UNMOCKED `$lib/api/music`, or ~half of this file's runs end in a
// burst of ~11 `EnvironmentTeardownError: Cannot load '<dep>' imported from
// .../src/lib/api/music.ts` — emitted after the 17 tests have already reported
// green, which is exactly the "this might cause false positive tests" case
// vitest warns about.
//
// Why they happen: the store reaches this module through FLOATING dynamic
// imports (`void import('$lib/api/music').then(...)` — reportMusicPlayback,
// unified reports), and several of them are in flight at once during
// a single test. Vitest's re-entrancy guard for a manual (factory) mock is ONE
// callstack array shared by every dynamic import issued from a given importer
// module: the mocker pushes a marker onto it around the factory call, so a
// second overlapping import from music-player.store.ts sees the first one's
// marker, skips the factory and resolves the REAL module instead. Vitest says
// as much in its own source — "this will not work if user does
// Promise.all(import(), import())". The real module then fetches its static
// dependencies, and any fetch still outstanding when vitest tears the
// environment down throws.
//
// `vi.importActual` resolves to exactly the id that bypass falls through to, so
// warming it here means a bypassing import is answered from the module cache
// and never issues a fetch that can outlive the environment. It does not stop
// the bypass itself — no test-side switch can, short of the store not making
// concurrent dynamic imports — it stops the bypass from needing a fetch.
//
// Nothing in this file asserts on the `$lib/api/music` spies (every assertion
// reads store state or `mockBackend.calls`), so the bypass never decided a
// result here either way.
beforeAll(async () => {
    await vi.importActual('$lib/api/music');
});

const updateForTest = musicPlayerStore._updateForTest!;

// ---------------------------------------------------------------------------
// Track + state helpers
// ---------------------------------------------------------------------------

let trackSeq = 0;

/**
 * Build a track that yields a non-`cut` blend style (bpm 120/120, low energy,
 * no mood) so the outro branch is eligible and beats math is predictable.
 */
function makeTrack(overrides: Partial<MusicTrack> = {}): MusicTrack {
    trackSeq += 1;
    return musicTrackFromCard({
        id: `track-${trackSeq}`,
        title: `Track ${trackSeq}`,
        artists: [{ id: null, title: 'Tester' }],
        durationMs: 300000, // seconds → 300_000ms
        audioFeatures: {
            bpm: 120,
            energy: 0.3,
        },
        ...overrides,
    });
}

function queueItem(track: MusicTrack): QueueItem {
    return { track, source: 'user', id: track.id };
}

/** Drive the store's `onTimeUpdate` callback as the 20Hz tick would. */
function tick(currentTimeMs: number, durationMs = 300_000): void {
    mockBackend.currentTimeMs = currentTimeMs;
    mockBackend.durationMs = durationMs;
    mockBackend.capturedCallbacks!.onTimeUpdate({
        currentTimeMs,
        durationMs,
        playbackRate: 1,
    });
}

/**
 * Put the store into a "playing currentTrack with a queued next track" state
 * without going through the async play() path (keeps tests synchronous and
 * isolated from network/auto-resume). crossfadeBeatsOverride pins beats so the
 * trigger geometry is deterministic.
 */
function primePlaying(opts: {
    current: MusicTrack;
    next: MusicTrack;
    durationMs?: number;
    beatsOverride?: number | null;
}): void {
    void musicPlayerStore._startMusicSessionForTest!(opts.current);
    updateForTest((s) => ({
        ...s,
        currentTrack: opts.current,
        queue: [queueItem(opts.next)],
        isPlaying: true,
        isCrossfading: false,
        crossfadeEnabled: true,
        isAirPlayActive: false,
        crossfadeBeatsOverride: opts.beatsOverride ?? 4,
        durationMs: opts.durationMs ?? 300_000,
        currentTimeMs: 0,
        playStartedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
        playContext: 'queue',
        pendingCrossfadeAtMs: null,
        pendingCrossfadeForTrackId: null,
        hasSeeked: false,
        autoplayEnabled: false, // disable smart-queue refetch side effects
        autoplaySeed: null,
        history: [],
        skippedTrackIds: [],
    }));
}

beforeEach(async () => {
    // The store is a singleton: its internal `crossfadePending` lock and
    // monotonic crossfade token survive across tests. A test that starts a
    // crossfade leaves the backend deferred unresolved → `crossfadePending`
    // stays true and blocks every subsequent checkCrossfadeTrigger. Drain any
    // outstanding crossfade by resolving its deferred and letting the store's
    // triggerCrossfade continuation run (which clears `crossfadePending`),
    // then drive the store into a non-crossfading state.
    if (mockBackend) {
        // Clear isCrossfading FIRST so the awoken continuation bails (its guard
        // checks `!isCrossfading`) — it then only clears `crossfadePending`
        // without finalizing a swap or arming a progress-report interval.
        updateForTest((s) => ({ ...s, isCrossfading: false }));
        for (const d of mockBackend.crossfadeDeferreds) d.resolve();
        await flush();
    }

    musicPlayerStore.stop();
    await flush();
    vi.clearAllMocks();
    // Point the mocked factory at the single persistent backend and reset its
    // recorder. init() only installs the backend the FIRST time (the store
    // guards re-init), so the SAME instance must be reused for the whole file.
    mockBackend = persistentBackend;
    mockBackend.reset();
    await musicPlayerStore.init(); // no-op after the first call; callbacks persist
    // Reset transient store fields between tests.
    updateForTest((s) => ({
        ...s,
        currentTrack: null,
        queue: [],
        history: [],
        isPlaying: false,
        isCrossfading: false,
        crossfadeEnabled: true,
        isAirPlayActive: false,
        pendingCrossfadeAtMs: null,
        pendingCrossfadeForTrackId: null,
        pendingCrossfadeIsManual: false,
        crossfadeBeatsOverride: null,
        hasSeeked: false,
        autoplayEnabled: false,
        autoplaySeed: null,
        playbackContext: null,
        isMuted: false,
        loudnessNormalizationEnabled: true,
    }));
});

afterEach(() => {
    vi.restoreAllMocks();
});

// Flush queued microtasks AND a macrotask. The store fires its analytics calls
// through `import('$lib/api/music').then(...)`; under vitest the mocked dynamic
// import resolves on a macrotask turn, so microtask-only flushing misses those
// `.then` callbacks. A `setTimeout(0)` hop lets them run deterministically.
async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
}

// ===========================================================================
// mixNow() — manual hold-to-mix crossfade
// ===========================================================================

describe('mixNow', () => {
    it('a mix in the last second fits the fade into what is left (below the 8-beat floor)', async () => {
        // No downbeats → fires immediately. 120 BPM = 500ms beats; 1s left.
        const current = makeTrack({ audioFeatures: { bpm: 120, energy: 0.3 } });
        const next = makeTrack();
        primePlaying({ current, next });
        // primePlaying defaults a 4-beat manual override; overrides are never shrunk.
        updateForTest((s) => ({ ...s, crossfadeBeatsOverride: null }));
        mockBackend.currentTimeMs = 299_000;
        mockBackend.durationMs = 300_000;

        musicPlayerStore.mixNow();
        await flush();

        expect(mockBackend.calls).toContain('triggerCrossfade');
        const beats = mockBackend.lastCrossfadeOptions?.beats ?? Infinity;
        // Fits the remaining ~750ms: 1 beat, not the old 8-beat (4s) fade that
        // kept going 3s after the outgoing track had ended.
        expect(beats).toBe(1);
    });

    it('arms a manual pending crossfade at the next downbeat (≤2 bars ahead)', async () => {
        const current = makeTrack({
            audioFeatures: {
                bpm: 120,
                energy: 0.3,
                // Downbeats every 2s (120 BPM, 4/4). Current position 10_500ms
                // → next downbeat at 12s, within the 4s (2-bar) lookahead.
                downbeats: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20],
            },
        });
        const next = makeTrack();
        primePlaying({ current, next });
        mockBackend.currentTimeMs = 10_500;
        mockBackend.durationMs = 300_000;

        musicPlayerStore.mixNow();
        await flush();

        const s = get(musicPlayerStore);
        expect(s.pendingCrossfadeAtMs).toBe(12_000);
        expect(s.pendingCrossfadeForTrackId).toBe(next.id);
        expect(s.pendingCrossfadeIsManual).toBe(true);
        // Nothing fired yet.
        expect(mockBackend.calls.filter((c) => c.startsWith('triggerCrossfade'))).toHaveLength(0);
    });

    it('triggers the crossfade immediately when the outgoing track has no beat data', async () => {
        const current = makeTrack({ audioFeatures: { bpm: 120, energy: 0.3 } }); // no downbeats
        const next = makeTrack();
        primePlaying({ current, next });
        mockBackend.currentTimeMs = 10_500;
        mockBackend.durationMs = 300_000;

        musicPlayerStore.mixNow();
        await flush();

        expect(get(musicPlayerStore).isCrossfading).toBe(true);
        expect(
            mockBackend.calls.filter((c) => c.startsWith('triggerCrossfade')).length,
        ).toBeGreaterThan(0);
    });

    it('triggers immediately when the next downbeat is beyond the 2-bar lookahead', async () => {
        const current = makeTrack({
            audioFeatures: { bpm: 120, energy: 0.3, downbeats: [0, 2, 100, 102] },
        });
        const next = makeTrack();
        primePlaying({ current, next });
        // 2 bars @120bpm = 4s lookahead; next downbeat (100s) is 89.5s away.
        mockBackend.currentTimeMs = 10_500;
        mockBackend.durationMs = 300_000;

        musicPlayerStore.mixNow();
        await flush();

        expect(get(musicPlayerStore).isCrossfading).toBe(true);
    });

    it('clamps the snap so the fade can complete before track end (immediate when too late)', async () => {
        const current = makeTrack({
            audioFeatures: { bpm: 120, energy: 0.3, downbeats: [296, 298] },
        });
        const next = makeTrack();
        // beatsOverride 4 @120bpm → fadeDurationMs 2000; end headroom 500.
        // Snap candidate 296_000 > 300_000 - 2000 - 500 = 297_500? No —
        // 296_000 fits. Position the playhead so the only reachable downbeat
        // would leave no room: currentMs 297_600 → clamp target 297_500 is in
        // the past → immediate trigger.
        primePlaying({ current, next });
        mockBackend.currentTimeMs = 297_600;
        mockBackend.durationMs = 300_000;

        musicPlayerStore.mixNow();
        await flush();

        expect(get(musicPlayerStore).isCrossfading).toBe(true);
    });

    it('falls back to skip() when the backend cannot crossfade', async () => {
        const current = makeTrack();
        const next = makeTrack();
        primePlaying({ current, next });
        updateForTest((s) => ({ ...s, supportsCrossfade: false }));
        mockBackend.currentTimeMs = 10_000;
        mockBackend.durationMs = 300_000;

        musicPlayerStore.mixNow();
        await flush();
        await flush();

        const s = get(musicPlayerStore);
        expect(s.isCrossfading).toBe(false);
        expect(s.pendingCrossfadeIsManual).toBe(false);
        expect(s.currentTrack?.id).toBe(next.id); // skip() advanced normally
        updateForTest((st) => ({ ...st, supportsCrossfade: true }));
    });

    it('falls back to skip() when AirPlay is active', async () => {
        const current = makeTrack();
        const next = makeTrack();
        primePlaying({ current, next });
        updateForTest((s) => ({ ...s, isAirPlayActive: true }));
        mockBackend.currentTimeMs = 10_000;
        mockBackend.durationMs = 300_000;

        musicPlayerStore.mixNow();
        await flush();
        await flush();

        const s = get(musicPlayerStore);
        expect(s.isCrossfading).toBe(false);
        expect(s.currentTrack?.id).toBe(next.id);
        updateForTest((st) => ({ ...st, isAirPlayActive: false }));
    });

    it('falls back to skip() when the queue is empty', async () => {
        const current = makeTrack();
        primePlaying({ current, next: makeTrack() });
        updateForTest((s) => ({ ...s, queue: [] }));
        mockBackend.currentTimeMs = 10_000;
        mockBackend.durationMs = 300_000;

        musicPlayerStore.mixNow();
        await flush();
        await flush();

        expect(get(musicPlayerStore).isCrossfading).toBe(false);
    });

    it('falls back to skip() when paused (symmetric with tap-while-paused)', async () => {
        const current = makeTrack({
            audioFeatures: { bpm: 120, energy: 0.3, downbeats: [0, 2, 4, 6, 8, 10, 12, 14] },
        });
        const next = makeTrack();
        primePlaying({ current, next });
        updateForTest((s) => ({ ...s, isPlaying: false }));
        mockBackend.currentTimeMs = 10_500;
        mockBackend.durationMs = 300_000;

        musicPlayerStore.mixNow();
        await flush();
        await flush();

        const s = get(musicPlayerStore);
        expect(s.isCrossfading).toBe(false);
        expect(s.pendingCrossfadeIsManual).toBe(false);
        expect(s.currentTrack?.id).toBe(next.id); // skip() advanced normally
    });

    it('triggers immediately (not armed) on a track too short for the tick fire window', async () => {
        // crossfadeBeatsOverride 4 @ 120bpm -> fadeDurationMs 2000ms; blend
        // mode's bufferAfterFade is 5000ms, so dynamicTargetMs <= 0 requires
        // durationMs <= 7000ms. 6000ms qualifies. Downbeats are provided so
        // the snap path would otherwise arm a pending at the next downbeat
        // (2000ms), which the tick's `dynamicTargetMs > 0` fire-branch could
        // never reach.
        const current = makeTrack({
            audioFeatures: { bpm: 120, energy: 0.3, downbeats: [0, 1, 2, 3, 4, 5] },
        });
        const next = makeTrack();
        primePlaying({ current, next, durationMs: 6_000 });
        mockBackend.currentTimeMs = 1_500;
        mockBackend.durationMs = 6_000;

        musicPlayerStore.mixNow();
        await flush();

        const s = get(musicPlayerStore);
        expect(s.isCrossfading).toBe(true);
        expect(s.pendingCrossfadeAtMs).toBeNull();
    });

    it('no-ops while a crossfade is already in progress', async () => {
        const current = makeTrack();
        const next = makeTrack();
        primePlaying({ current, next });
        updateForTest((s) => ({ ...s, isCrossfading: true }));
        mockBackend.currentTimeMs = 10_000;
        mockBackend.durationMs = 300_000;

        musicPlayerStore.mixNow();
        await flush();

        expect(get(musicPlayerStore).pendingCrossfadeIsManual).toBe(false);
        expect(mockBackend.calls.filter((c) => c.startsWith('triggerCrossfade'))).toHaveLength(0);
    });

    it('arms even when the auto-crossfade setting is disabled', async () => {
        const current = makeTrack({
            audioFeatures: { bpm: 120, energy: 0.3, downbeats: [0, 2, 4, 6, 8, 10, 12, 14] },
        });
        const next = makeTrack();
        primePlaying({ current, next });
        updateForTest((s) => ({ ...s, crossfadeEnabled: false }));
        mockBackend.currentTimeMs = 10_500;
        mockBackend.durationMs = 300_000;

        musicPlayerStore.mixNow();
        await flush();

        const s = get(musicPlayerStore);
        expect(s.pendingCrossfadeAtMs).toBe(12_000);
        expect(s.pendingCrossfadeIsManual).toBe(true);
    });

    describe('firing and lifecycle', () => {
        it('the tick fires an armed manual mix once currentMs reaches the snap point', async () => {
            const current = makeTrack({
                audioFeatures: { bpm: 120, energy: 0.3, downbeats: [0, 2, 4, 6, 8, 10, 12, 14] },
            });
            const next = makeTrack();
            primePlaying({ current, next });
            mockBackend.currentTimeMs = 10_500;
            mockBackend.durationMs = 300_000;
            musicPlayerStore.mixNow();
            await flush();
            expect(get(musicPlayerStore).pendingCrossfadeAtMs).toBe(12_000);

            tick(11_000); // before the snap point — must not fire
            expect(get(musicPlayerStore).isCrossfading).toBe(false);

            tick(12_050); // past the snap point — fires
            expect(get(musicPlayerStore).isCrossfading).toBe(true);
        });

        it('fires a manual mix even when crossfadeEnabled is false', async () => {
            const current = makeTrack({
                audioFeatures: { bpm: 120, energy: 0.3, downbeats: [0, 2, 4, 6, 8, 10, 12, 14] },
            });
            const next = makeTrack();
            primePlaying({ current, next });
            updateForTest((s) => ({ ...s, crossfadeEnabled: false }));
            mockBackend.currentTimeMs = 10_500;
            mockBackend.durationMs = 300_000;
            musicPlayerStore.mixNow();
            await flush();

            tick(12_050);
            expect(get(musicPlayerStore).isCrossfading).toBe(true);
        });

        it('a queue-head swap clears an armed manual mix and, with auto-crossfade off, arms/fires nothing', async () => {
            const current = makeTrack({
                audioFeatures: { bpm: 120, energy: 0.3, downbeats: [0, 2, 4, 6, 8, 10, 12, 14] },
            });
            const next = makeTrack();
            primePlaying({ current, next });
            updateForTest((s) => ({ ...s, crossfadeEnabled: false }));
            mockBackend.currentTimeMs = 10_500;
            mockBackend.durationMs = 300_000;
            musicPlayerStore.mixNow();
            await flush();
            expect(get(musicPlayerStore).pendingCrossfadeIsManual).toBe(true);

            const swapped = makeTrack();
            updateForTest((s) => ({ ...s, queue: [queueItem(swapped)] }));
            tick(12_050); // manual pending belonged to the OLD head

            const s = get(musicPlayerStore);
            expect(s.isCrossfading).toBe(false);
            expect(s.pendingCrossfadeAtMs).toBeNull();
            expect(s.pendingCrossfadeIsManual).toBe(false);
        });

        it('the flag resets when the fade fires (auto path stays auto)', async () => {
            const current = makeTrack({
                audioFeatures: { bpm: 120, energy: 0.3, downbeats: [0, 2, 4, 6, 8, 10, 12, 14] },
            });
            const next = makeTrack();
            primePlaying({ current, next });
            mockBackend.currentTimeMs = 10_500;
            mockBackend.durationMs = 300_000;
            musicPlayerStore.mixNow();
            await flush();
            tick(12_050);
            expect(get(musicPlayerStore).isCrossfading).toBe(true);
            expect(get(musicPlayerStore).pendingCrossfadeIsManual).toBe(false);
        });

        it('disabling crossfade clears an armed manual mix', async () => {
            const current = makeTrack({
                audioFeatures: { bpm: 120, energy: 0.3, downbeats: [0, 2, 4, 6, 8, 10, 12, 14] },
            });
            const next = makeTrack();
            primePlaying({ current, next });
            mockBackend.currentTimeMs = 10_500;
            mockBackend.durationMs = 300_000;
            musicPlayerStore.mixNow();
            await flush();

            void musicPlayerStore.setCrossfadeEnabled(false);

            const s = get(musicPlayerStore);
            expect(s.pendingCrossfadeAtMs).toBeNull();
            expect(s.pendingCrossfadeIsManual).toBe(false);
        });

        it('a seek clears an armed manual mix, and it never fires at the stale (pre-seek) snap point', async () => {
            const current = makeTrack({
                audioFeatures: { bpm: 120, energy: 0.3, downbeats: [0, 2, 4, 6, 8, 10, 12, 14] },
            });
            const next = makeTrack();
            primePlaying({ current, next });
            mockBackend.currentTimeMs = 10_500;
            mockBackend.durationMs = 300_000;
            musicPlayerStore.mixNow();
            await flush();
            expect(get(musicPlayerStore).pendingCrossfadeAtMs).toBe(12_000);
            expect(get(musicPlayerStore).pendingCrossfadeIsManual).toBe(true);

            // User drags the seek bar backward while the mix is armed — the
            // seek supersedes the hold-to-mix arm; it must not linger against
            // a target that's now seconds (or minutes) away.
            musicPlayerStore.seekTo(3_000);
            await flush();

            const afterSeek = get(musicPlayerStore);
            expect(afterSeek.pendingCrossfadeAtMs).toBeNull();
            expect(afterSeek.pendingCrossfadeIsManual).toBe(false);
            expect(afterSeek.isCrossfading).toBe(false);

            // Playback continues and crosses the OLD (pre-seek) snap point —
            // must not fire an un-quantized fade against a cleared pending.
            tick(12_050);
            expect(get(musicPlayerStore).isCrossfading).toBe(false);
        });
    });
});

describe('Smart Queue conversion', () => {
    it('keeps paused playback and history while enabling recommendations', async () => {
        const current = makeTrack();
        const selected = makeTrack();
        const past = makeTrack();
        const recommendation = makeTrack();
        primePlaying({ current, next: selected });
        updateForTest((s) => ({
            ...s,
            currentTimeMs: 45000,
            isPlaying: false,
            history: [past],
            playbackContext: { type: 'artist', name: 'Artist', trackCount: 2 },
        }));
        getRecommendations.mockResolvedValueOnce({
            data: { next: recommendation, alternatives: [], source: 'metadata' },
        });
        mockBackend.calls.length = 0;
        musicPlayerStore.switchToSmartQueue();
        await flush();
        await flush();
        const state = get(musicPlayerStore);
        expect(state.currentTrack?.id).toBe(current.id);
        expect(state.currentTimeMs).toBe(45000);
        expect(state.isPlaying).toBe(false);
        expect(state.history).toEqual([past]);
        expect(state.autoplayEnabled).toBe(true);
        expect(state.playbackContext).toBeNull();
        expect(state.queue.map((q) => q.track.id)).toEqual([recommendation.id]);
        expect(state.queue[0].source).toBe('smart');
        expect(mockBackend.calls).not.toContain('play');
        expect(mockBackend.calls).not.toContain('seekTo:45000');
    });

    it('ignores a recommendation response for the selection being replaced', async () => {
        const current = makeTrack();
        const stale = makeTrack();
        const fresh = makeTrack();
        let resolveOld!: (value: Awaited<ReturnType<typeof getRecommendations>>) => void;
        getRecommendations.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveOld = resolve;
                }),
        );
        primePlaying({ current, next: makeTrack() });
        updateForTest((s) => ({ ...s, autoplayEnabled: true }));
        musicPlayerStore.refreshSmartQueue();
        await flush();
        getRecommendations.mockResolvedValueOnce({
            data: { next: fresh, alternatives: [], source: 'metadata' },
        });
        musicPlayerStore.switchToSmartQueue();
        await flush();
        resolveOld({ data: { next: stale, alternatives: [], source: 'metadata' } });
        await flush();
        expect(get(musicPlayerStore).queue.map((q) => q.track.id)).toEqual([fresh.id]);
    });

    it('keeps paused current playback when recommendation retrieval fails', async () => {
        const current = makeTrack();
        primePlaying({ current, next: makeTrack() });
        updateForTest((s) => ({ ...s, isPlaying: false, currentTimeMs: 17000 }));
        getRecommendations.mockRejectedValueOnce(new Error('offline'));
        musicPlayerStore.switchToSmartQueue();
        await flush();
        const state = get(musicPlayerStore);
        expect(state.currentTrack?.id).toBe(current.id);
        expect(state.currentTimeMs).toBe(17000);
        expect(state.isPlaying).toBe(false);
        expect(state.queue).toEqual([]);
        expect(state.smartQueueLoading).toBe(false);
    });
});

describe('recommendation request arguments', () => {
    it('upcoming excludes the current track and startedBy follows the current track source', async () => {
        const current = makeTrack();
        primePlaying({ current, next: makeTrack() });
        updateForTest((s) => ({
            ...s,
            autoplayEnabled: true,
            currentTrackSource: 'user',
            queue: [],
        }));
        musicPlayerStore.refreshSmartQueue();
        await flush();
        const args = getRecommendations.mock.calls[0][0];
        expect(args.currentTrackId).toBe(current.id);
        expect(args.upcoming ?? []).not.toContain(current.id);
        expect(args.startedBy).toBe('user');

        vi.clearAllMocks();
        updateForTest((s) => ({ ...s, currentTrackSource: 'smart' }));
        musicPlayerStore.refreshSmartQueue();
        await flush();
        expect(getRecommendations.mock.calls[0][0].startedBy).toBe('autoplay');
    });

    it('sends crossfade false while AirPlay is active', async () => {
        const current = makeTrack();
        primePlaying({ current, next: makeTrack() });
        updateForTest((s) => ({ ...s, autoplayEnabled: true, isAirPlayActive: true, queue: [] }));
        musicPlayerStore.refreshSmartQueue();
        await flush();
        expect(getRecommendations.mock.calls[0][0].crossfade).toBe(false);
    });

    it('a genre radio cold start sends its genre as a mood seed', async () => {
        await musicPlayerStore.seedAutoplay({ type: 'genre', genre: 'Trance', label: 'Trance' });
        await flush();
        const args = getRecommendations.mock.calls[0][0];
        expect(args.seed).toEqual({ type: 'mood', mood: 'Trance' });
        expect(args.currentTrackId).toBeUndefined();
    });

    it('an album radio sends the picked track and the seed', async () => {
        const albumTrack = makeTrack();
        const next = makeTrack();
        getAlbum.mockResolvedValueOnce({ data: { tracks: [albumTrack] } });
        getRecommendations.mockResolvedValueOnce({
            data: { next, alternatives: [], source: 'metadata' },
        });
        const seed = { type: 'album' as const, albumId: 'album-1', albumName: 'Album' };
        await musicPlayerStore.seedAutoplay(seed);
        await flush();
        const args = getRecommendations.mock.calls[0][0];
        expect(args.currentTrackId).toBe(albumTrack.id);
        expect(args.seed).toEqual(seed);
        expect(get(musicPlayerStore).currentTrack?.id).toBe(next.id);
    });

    it('an album radio still starts the album track when the recommendation fails', async () => {
        const albumTrack = makeTrack();
        getAlbum.mockResolvedValueOnce({ data: { tracks: [albumTrack] } });
        getRecommendations.mockResolvedValueOnce({
            error: { message: 'unprocessable' },
        } as unknown as Awaited<ReturnType<typeof getRecommendations>>);
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        await musicPlayerStore.seedAutoplay({
            type: 'album',
            albumId: 'album-1',
            albumName: 'Album',
        });
        await flush();
        expect(get(musicPlayerStore).currentTrack?.id).toBe(albumTrack.id);
    });

    it('an album radio still starts the album track when no next track comes back', async () => {
        const albumTrack = makeTrack();
        getAlbum.mockResolvedValueOnce({ data: { tracks: [albumTrack] } });
        await musicPlayerStore.seedAutoplay({
            type: 'album',
            albumId: 'album-1',
            albumName: 'Album',
        });
        await flush();
        expect(get(musicPlayerStore).currentTrack?.id).toBe(albumTrack.id);
    });
});

describe('Smart Queue conversion during a crossfade', () => {
    it.each([false, true])(
        'restores normalized volume and rejects old fade completion (muted=%s)',
        async (muted) => {
            const outgoing = makeTrack({
                audioFeatures: { bpm: 120, energy: 0.3, loudnessLufs: -9 },
            });
            const incoming = makeTrack({
                audioFeatures: { bpm: 120, energy: 0.3, loudnessLufs: -22 },
            });
            primePlaying({ current: outgoing, next: incoming });
            updateForTest((s) => ({
                ...s,
                queue: [queueItem(incoming), queueItem(makeTrack())],
                playbackContext: { type: 'artist', name: 'Artist', trackCount: 3 },
                volume: 0.55,
                isMuted: muted,
            }));
            mockBackend.currentTimeMs = 299000;
            mockBackend.durationMs = 300000;
            musicPlayerStore.mixNow();
            await flush();
            expect(get(musicPlayerStore).isCrossfading).toBe(true);
            expect(get(musicPlayerStore).currentTrack?.id).toBe(incoming.id);
            const before = get(musicPlayerStore);
            mockBackend.calls.length = 0;
            mockBackend.lastVolume = undefined;
            musicPlayerStore.switchToSmartQueue();
            if (muted) expect(mockBackend.calls).not.toContain('setVolume');
            else expect(mockBackend.lastVolume).toBeCloseTo(applyLufsGain(0.55, -22));
            await flush();
            expect(get(musicPlayerStore).currentTrack?.id).toBe(incoming.id);
            expect(get(musicPlayerStore).currentTimeMs).toBe(before.currentTimeMs);
            expect(get(musicPlayerStore).history).toEqual(before.history);
            expect(get(musicPlayerStore).queue).toEqual([]);
            expect(get(musicPlayerStore).isPlaying).toBe(before.isPlaying);
            expect(mockBackend.calls).not.toContain('play');
            expect(
                reportMusicPlayback.mock.calls.filter((call) => call[1].status === 'COMPLETED'),
            ).toHaveLength(1);
        },
    );
});

describe('selection completion notice', () => {
    it('announces the selection-to-smart transition once when playing a generated track', async () => {
        const info = vi.spyOn(toasts, 'info');
        primePlaying({ current: makeTrack(), next: makeTrack() });
        const generated = makeTrack();
        updateForTest((s) => ({
            ...s,
            playbackContext: { type: 'artist', name: 'Artist', trackCount: 1 },
            queue: [{ track: generated, source: 'smart', id: generated.id }],
        }));
        await musicPlayerStore.skip();
        expect(get(musicPlayerStore).playbackContext).toBeNull();
        expect(info).toHaveBeenCalledWith('Queue finished — Autoplay picking similar tracks');
        await musicPlayerStore.play(makeTrack(), false, 'smart');
        expect(info).toHaveBeenCalledTimes(1);
    });

    it('announces completion once at the start of a crossfade into generated playback', async () => {
        const info = vi.spyOn(toasts, 'info');
        primePlaying({ current: makeTrack(), next: makeTrack() });
        updateForTest((s) => ({
            ...s,
            playbackContext: { type: 'album', name: 'Album', trackCount: 1, sessionId: 'album' },
            queue: s.queue.map((q) => ({ ...q, source: 'smart' })),
        }));
        mockBackend.currentTimeMs = 299000;
        mockBackend.durationMs = 300000;
        musicPlayerStore.mixNow();
        await flush();
        expect(get(musicPlayerStore).playbackContext).toBeNull();
        expect(info).toHaveBeenCalledTimes(1);
        mockBackend.crossfadeDeferreds.at(-1)?.resolve();
        await flush();
        expect(info).toHaveBeenCalledTimes(1);
    });
});

vi.mock('$app/stores', () => ({
    page: {
        subscribe: (run: (value: unknown) => void) => {
            run({ data: { user: { userId: 'music-player-test-user' } } });
            return () => undefined;
        },
    },
}));
