// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { playbackStartFixture } from '$lib/utils/playback-start.fixture.js';
import { musicTrackFromCard } from '$lib/utils/music-track';

/**
 * Unit tests for channel-specific crossfade beat selection AND the crossfade
 * orchestration state machine in music-player.store.ts.
 *
 * The orchestration tests drive a MOCK AudioBackend (injected via vi.mock of
 * `$lib/audio`) and pump synthetic time-update ticks through the store's
 * `init()`-wired `onTimeUpdate` callback to exercise `checkCrossfadeTrigger`,
 * `triggerCrossfade`, and the cancel/finalize paths. The mock records every
 * call so we can assert on `cancelCrossfade`/`seekTo`/`triggerCrossfade`
 * ordering. No real timers or audio are used — `triggerCrossfade` returns a
 * test-controlled deferred Promise, so we decide exactly when the backend
 * crossfade "completes".
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { get } from 'svelte/store';
import type { MusicTrack, QueueItem } from '$lib/schemas/music';
import type {
    AudioBackend,
    AudioBackendCallbacks,
    CrossfadeOptions,
    TrackMetadata,
} from '$lib/audio';
import { MediaPlaybackError } from '$lib/audio/audio-element-helpers';

// The singleton registers unload/online listeners during module evaluation.
// Install a Node EventTarget before imports so these tests exercise those listeners.
vi.hoisted(() => {
    vi.stubGlobal(
        'window',
        Object.assign(new EventTarget(), {
            location: { pathname: '/', search: '', href: 'http://localhost/' },
        }),
    );
    vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => true) });
});

afterAll(() => vi.unstubAllGlobals());

const replayIdentity = vi.hoisted(() => ({ userId: 'music-player-test-user' }));
vi.mock('$app/stores', () => ({
    page: {
        subscribe: (run: (value: unknown) => void) => {
            run({ data: { user: { userId: replayIdentity.userId } } });
            return () => undefined;
        },
    },
}));

function createMemoryStorage(): Storage {
    const entries = new Map<string, string>();
    return {
        get length() {
            return entries.size;
        },
        clear: () => entries.clear(),
        getItem: (key) => entries.get(key) ?? null,
        key: (index) => Array.from(entries.keys())[index] ?? null,
        removeItem: (key) => {
            entries.delete(key);
        },
        setItem: (key, value) => {
            entries.set(key, value);
        },
    };
}

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
    currentTimeMs: number;
    durationMs: number;
    /** The incoming deck's clock while a fade runs (null = not readable yet). */
    incomingTimeMs: number | null;
    /** Every value passed to setVolume, in order. */
    volumes: number[];
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
        currentTimeMs: 0,
        durationMs: 0,
        incomingTimeMs: null,
        volumes: [],

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
            backend.volumes.push(volume);
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
        getCrossfadeIncomingTimeMs(): number | null {
            return crossfading ? backend.incomingTimeMs : null;
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
            backend.volumes.length = 0;
            crossfadeDeferreds.length = 0;
            crossfading = false;
            backend.lastCrossfadeOptions = undefined;
            backend.currentTimeMs = 0;
            backend.durationMs = 0;
            backend.incomingTimeMs = null;
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

// ---------------------------------------------------------------------------
// `$lib/api/music` — AUTOMOCKED, deliberately NOT a factory mock.
//
// Keep automocking so overlapping imports resolve to the same reporting spies.
// The mock-integrity guards below verify that terminal reports remain observable.
//
// Vitest's re-entrancy guard for a MANUAL (factory) `vi.mock` is ONE
// `callstack` array shared by every dynamic import issued from a given importer
// module: `requestWithMockedModule` pushes a marker onto it around the factory
// call, so a SECOND overlapping `import()` of the same specifier sees the
// marker, SKIPS the factory and resolves the REAL module. Vitest says so in its
// own source comment: "this will not work if user does Promise.all(import(),
// import())".
//
// That bypass silently DEFEATS the double-report guards further down: a
// bypassed call runs the real `reportMusicPlayback`, the spy never records it, and an
// actual double-report regression still reads as exactly 1 call. Measured on
// this file (vitest 5.0.1) with a deliberate second `reportMusicPlayback` injected
// into `triggerCrossfade`, the spy saw ONE call with and without the
// regression — identical numbers — and the terminal completion report, issued from the same
// synchronous block, recorded ZERO calls on every run.
//
// The automock path is different code in the mocker: it caches `mockedExports`
// and never pushes onto the callstack, so every import — overlapping or not —
// resolves to the mock. Implementations are therefore installed per test in
// `beforeEach` instead of by a factory. `mock-integrity` at the bottom of this
// file is the canary that keeps it that way.
// ---------------------------------------------------------------------------
vi.mock('$lib/api/music');

// Now import the store — mocks above are hoisted by vitest and applied first.
import { getSeedCrossfadeBeats, musicPlayerStore } from './music-player.store';
import { calculateCrossfadeDuration } from '$lib/utils/beat-math';
import { applyLufsGain } from '$lib/utils/lufs-gain';
import * as musicApi from '$lib/api/music';

// Typed handles onto the automocked exports. `vi.mocked` keeps the REAL
// signatures, so `reportMusicPlayback.mock.calls[n][1]` indexes a properly-sized
// tuple (the old factory had to hand-write that tuple type).
const reportMusicPlayback = vi.mocked(musicApi.reportMusicPlayback);
const terminalReports = (): Parameters<typeof musicApi.reportMusicPlayback>[] =>
    reportMusicPlayback.mock.calls.filter(([, body]) => body.status === 'COMPLETED');
const getRecommendations = vi.mocked(musicApi.getRecommendations);

/**
 * A well-formed empty `ApiResult`. `status` is part of the interface, so a bare
 * `{ data, error }` is not an `ApiResult` — the old factory got away with that
 * because a mock factory's return value is never type-checked.
 */
const EMPTY_OK = { data: null, error: null, status: 200 } as const;

/**
 * Give every automocked `$lib/api/music` export a resolved `ApiResult`.
 *
 * Automocked stubs return `undefined`, and the store destructures several of
 * these results (`const { data } = await getRecommendations(...)`), so an un-stubbed
 * export would throw rather than no-op. Re-applied per test because
 * `clearAllMocks`/`restoreAllMocks` drop implementations.
 */
function installMusicApiDefaults(): void {
    for (const value of Object.values(musicApi)) {
        if (vi.isMockFunction(value)) value.mockResolvedValue(EMPTY_OK);
    }
    vi.mocked(musicApi.startMusicPlaySession).mockImplementation(async ({ trackId }) => ({
        data: playbackStartFixture(trackId, trackId),
        error: null,
        status: 201,
    }));
    // `getRecommendations` gets the real response shape with no `next` and an
    // EMPTY alternatives list, so `fetchNextTrack` never enqueues a track or
    // triggers auto-resume during these tests. `next` is OMITTED rather than
    // `null` (the schema declares it `.optional()`, not `.nullable()`).
    getRecommendations.mockResolvedValue({
        ...EMPTY_OK,
        data: { alternatives: [], source: 'metadata' },
    });
}

const updateForTest = musicPlayerStore._updateForTest!;

// ---------------------------------------------------------------------------
// Track + state helpers
// ---------------------------------------------------------------------------

let trackSeq = 0;
let replayUserSeq = 0;

/**
 * Build a track that yields a non-`cut` blend style (bpm 120/120, low energy,
 * no mood) so the outro branch is eligible and beats math is predictable.
 */
function makeTrack(overrides: Partial<MusicTrack> = {}): MusicTrack {
    trackSeq += 1;
    return musicTrackFromCard({
        // Replay persistence validates both media ids and the mocked session ids as UUIDs.
        id: `00000000-0000-4000-8000-${String(trackSeq).padStart(12, '0')}`,
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

/** Fire a synthetic backend time-update tick (drives checkCrossfadeTrigger). */
async function tick(currentTimeMs: number, durationMs = 300_000): Promise<void> {
    mockBackend.currentTimeMs = currentTimeMs;
    mockBackend.durationMs = durationMs;
    mockBackend.capturedCallbacks!.onTimeUpdate({
        currentTimeMs,
        durationMs,
        playbackRate: 1,
    });
    await flush();
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

// crossfadeBeatsOverride = 4 → fadeDurationMs = 500*4 = 2000; leadMs = 7000.
// For durationMs = 300_000: targetTriggerMs = 293_000; pending-set window opens
// at targetTriggerMs - 2000 = 291_000. No downbeats → snapAtMs = 293_000.
const PENDING_AT_MS = 293_000;

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
    // A fresh owner also resets the singleton's in-memory replay queue. Fresh
    // storage alone would leave its previously loaded entries in memory.
    replayIdentity.userId = `music-player-test-user-${++replayUserSeq}`;
    vi.stubGlobal('localStorage', createMemoryStorage());
    vi.clearAllMocks();
    installMusicApiDefaults();
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
        crossfadeBeatsOverride: null,
        hasSeeked: false,
        autoplayEnabled: false,
        autoplaySeed: null,
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
// Existing coverage: channel-specific crossfade beat selection
// ===========================================================================

describe('getSeedCrossfadeBeats', () => {
    describe('without BPM data (time-based fallback)', () => {
        it('returns 4 beats for null channel', async () => {
            expect(getSeedCrossfadeBeats(null)).toBe(4);
        });

        it('returns 4 beats for chill mood without BPM', async () => {
            expect(
                getSeedCrossfadeBeats({
                    type: 'mood',
                    mood: 'chill',
                    label: 'Chill',
                    emoji: '😌',
                }),
            ).toBe(4);
        });

        it('returns 4 beats for energetic mood without BPM', async () => {
            expect(
                getSeedCrossfadeBeats({
                    type: 'mood',
                    mood: 'energetic',
                    label: 'Energetic',
                    emoji: '⚡',
                }),
            ).toBe(4);
        });

        it('returns 4 beats for genre channel without BPM', async () => {
            expect(getSeedCrossfadeBeats({ type: 'genre', genre: 'rock', label: 'Rock' })).toBe(4);
        });
    });

    describe('with BPM data (DJ-style long blends)', () => {
        it('returns 48 beats for synced BPMs, no channel', async () => {
            expect(getSeedCrossfadeBeats(null, 128, 130)).toBe(48);
        });

        it('returns 64 beats for synced BPMs with chill mood', async () => {
            expect(
                getSeedCrossfadeBeats(
                    { type: 'mood', mood: 'chill', label: 'Chill', emoji: '😌' },
                    128,
                    130,
                ),
            ).toBe(64);
        });

        it('returns 32 beats for synced BPMs with energetic mood', async () => {
            expect(
                getSeedCrossfadeBeats(
                    { type: 'mood', mood: 'energetic', label: 'Energetic', emoji: '⚡' },
                    128,
                    130,
                ),
            ).toBe(32);
        });
    });

    describe('beat count to duration conversion', () => {
        it('synced energetic at 128 BPM: 32 beats = 15000ms', async () => {
            const beats = getSeedCrossfadeBeats(
                { type: 'mood', mood: 'energetic', label: 'Energetic', emoji: '⚡' },
                128,
                130,
            );
            expect(calculateCrossfadeDuration(128, beats)).toBe(15000);
        });

        it('no BPM: calculateCrossfadeDuration paces the beats at an assumed 120 BPM', async () => {
            // One rule for plan, trigger and engine (the engine already ran 48
            // beats as 24s while the plan assumed 2s and fired too late).
            expect(calculateCrossfadeDuration(0, 48)).toBe(24_000);
            expect(calculateCrossfadeDuration(0, 4)).toBe(2_000);
        });
    });
});

// ===========================================================================
// Orchestration state machine
// ===========================================================================

describe('crossfade orchestration state machine', () => {
    it('sanity: init wired the mock backend callbacks', async () => {
        expect(mockBackend.capturedCallbacks).not.toBeNull();
        expect(typeof mockBackend.capturedCallbacks!.onTimeUpdate).toBe('function');
    });

    // -- (1) pending crossfade fires when currentMs >= pendingCrossfadeAtMs ----
    describe('pending-trigger path', () => {
        it('arms pendingCrossfadeAtMs in the lead window, then fires triggerCrossfade once currentMs >= pendingCrossfadeAtMs', async () => {
            const current = makeTrack();
            const next = makeTrack();
            primePlaying({ current, next });

            // Tick BEFORE the pending-set window (291_000): nothing armed yet.
            await tick(100_000);
            expect(get(musicPlayerStore).pendingCrossfadeAtMs).toBeNull();
            expect(mockBackend.calls).not.toContain('triggerCrossfade');

            // Tick INSIDE the pending-set window but before snap point: arms but
            // does not fire (currentMs < pendingCrossfadeAtMs).
            await tick(291_500);
            expect(get(musicPlayerStore).pendingCrossfadeAtMs).toBe(PENDING_AT_MS);
            expect(get(musicPlayerStore).pendingCrossfadeForTrackId).toBe(next.id);
            expect(mockBackend.calls).not.toContain('triggerCrossfade');

            // Tick AT/PAST the pending point: fires exactly one crossfade.
            await tick(PENDING_AT_MS);
            expect(mockBackend.calls.filter((c) => c === 'triggerCrossfade')).toHaveLength(1);
            expect(get(musicPlayerStore).isCrossfading).toBe(true);
            // Promotion happens at fade START, not completion: currentTrack has
            // already switched to the incoming track, its queue slot is
            // consumed, and the outgoing track is at the head of history — all
            // while the fade is still in progress.
            const state = get(musicPlayerStore);
            expect(state.currentTrack?.id).toBe(next.id);
            expect(state.queue).toHaveLength(0);
            expect(state.history[0]?.id).toBe(current.id);
        });

        it('does not fire while currentMs is still below the armed pending point', async () => {
            primePlaying({ current: makeTrack(), next: makeTrack() });
            await tick(291_500); // arm
            expect(get(musicPlayerStore).pendingCrossfadeAtMs).toBe(PENDING_AT_MS);
            await tick(292_999); // 1ms shy of the trigger
            expect(mockBackend.calls).not.toContain('triggerCrossfade');
            expect(get(musicPlayerStore).isCrossfading).toBe(false);
        });
    });

    // -- (2) pending recomputed/discarded when queue[0] changes ----------------
    describe('queue-head change invalidates a stale pending trigger', () => {
        it('discards pendingCrossfadeAtMs when queue[0] differs from pendingCrossfadeForTrackId', async () => {
            const current = makeTrack();
            const next = makeTrack();
            primePlaying({ current, next });

            await tick(291_500); // arm for `next`
            expect(get(musicPlayerStore).pendingCrossfadeAtMs).toBe(PENDING_AT_MS);
            expect(get(musicPlayerStore).pendingCrossfadeForTrackId).toBe(next.id);

            // Swap the queue head to a different track (e.g. user reordered).
            const replacement = makeTrack();
            updateForTest((s) => ({ ...s, queue: [queueItem(replacement)] }));

            // Next tick early in the track: stale pending is discarded and, being
            // far from the lead window, NOT re-armed.
            await tick(100_000);
            expect(get(musicPlayerStore).pendingCrossfadeAtMs).toBeNull();
            expect(get(musicPlayerStore).pendingCrossfadeForTrackId).toBeNull();
            expect(mockBackend.calls).not.toContain('triggerCrossfade');
        });

        it('re-arms for the NEW head when the swap happens inside the lead window', async () => {
            const current = makeTrack();
            const next = makeTrack();
            primePlaying({ current, next });
            await tick(291_500); // arm for `next`

            const replacement = makeTrack();
            updateForTest((s) => ({ ...s, queue: [queueItem(replacement)] }));

            // Still inside the lead window → discard stale, recompute for the new
            // head this same tick. Pending is re-armed and bound to the new id.
            await tick(291_600);
            expect(get(musicPlayerStore).pendingCrossfadeAtMs).toBe(PENDING_AT_MS);
            expect(get(musicPlayerStore).pendingCrossfadeForTrackId).toBe(replacement.id);
            expect(mockBackend.calls).not.toContain('triggerCrossfade');
        });
    });

    // -- (3) no trigger while isCrossfading or crossfadePending ----------------
    describe('re-entrancy guard', () => {
        it('does not fire a second crossfade while one is already in progress (isCrossfading)', async () => {
            primePlaying({ current: makeTrack(), next: makeTrack() });
            await tick(291_500); // arm
            await tick(PENDING_AT_MS); // fire #1
            expect(mockBackend.calls.filter((c) => c === 'triggerCrossfade')).toHaveLength(1);
            expect(get(musicPlayerStore).isCrossfading).toBe(true);

            // Further ticks past the trigger must NOT fire again — the early
            // return guards on isCrossfading (and crossfadePending).
            await tick(294_000);
            await tick(295_000);
            expect(mockBackend.calls.filter((c) => c === 'triggerCrossfade')).toHaveLength(1);
        });

        it('does not arm or fire when crossfade is disabled', async () => {
            primePlaying({ current: makeTrack(), next: makeTrack() });
            updateForTest((s) => ({ ...s, crossfadeEnabled: false }));
            await tick(291_500);
            await tick(PENDING_AT_MS);
            expect(get(musicPlayerStore).pendingCrossfadeAtMs).toBeNull();
            expect(mockBackend.calls).not.toContain('triggerCrossfade');
        });

        it('does not fire when AirPlay is active', async () => {
            primePlaying({ current: makeTrack(), next: makeTrack() });
            updateForTest((s) => ({ ...s, isAirPlayActive: true }));
            await tick(291_500);
            await tick(PENDING_AT_MS);
            expect(mockBackend.calls).not.toContain('triggerCrossfade');
        });
    });

    // -- (4) outro-boundary path -----------------------------------------------
    describe('outro-boundary path', () => {
        it('fires triggerCrossfade immediately at currentMs >= outroStartMs (no pending armed)', async () => {
            const current = makeTrack({
                audioFeatures: { bpm: 120, energy: 0.3, outroStartMs: 250_000 },
            });
            const next = makeTrack();
            primePlaying({ current, next });

            // Before the outro boundary: nothing fires (and far from lead window,
            // so no pending armed either).
            await tick(100_000);
            expect(mockBackend.calls).not.toContain('triggerCrossfade');

            // At the outro boundary, with ample remaining time (>= fadeDuration +
            // 1000): fires straight away, no pending pre-arm required.
            await tick(250_000);
            expect(mockBackend.calls.filter((c) => c === 'triggerCrossfade')).toHaveLength(1);
            expect(get(musicPlayerStore).isCrossfading).toBe(true);
            // Promotion at fade start applies to the outro-boundary trigger too.
            expect(get(musicPlayerStore).currentTrack?.id).toBe(next.id);
        });

        it('does not fire the outro path when too little time remains for the fade', async () => {
            // outroStartMs very close to the end: remainingMs < fadeDuration+1000
            // (fadeDuration = 2000, so need >= 3000ms remaining). Place outro at
            // 298_500 → remaining 1500ms < 3000ms guard.
            const current = makeTrack({
                audioFeatures: { bpm: 120, energy: 0.3, outroStartMs: 298_500 },
            });
            primePlaying({ current, next: makeTrack() });
            await tick(298_500);
            // The outro branch is gated out; but this currentMs is past the
            // pending-set window so a pending may still arm — assert only that
            // the outro path itself did not fire an immediate crossfade here.
            // (pending fires on a LATER tick, not this one.)
            expect(get(musicPlayerStore).isCrossfading).toBe(false);
        });
    });

    // -- (5) regression guards -------------------------------------------------
    describe('regression: skip() during crossfade reports each track exactly once (B2/B4)', () => {
        it('reports the outgoing play-end once (at fade start) and the incoming play-end once (skip cancel), never twice for either', async () => {
            const current = makeTrack();
            const next = makeTrack();
            const afterNext = makeTrack();
            primePlaying({ current, next });
            // Give skip() a track to advance to after `next` — `next` becomes
            // currentTrack once the fade starts, so skip() must land on
            // `afterNext`.
            updateForTest((s) => ({ ...s, queue: [queueItem(next), queueItem(afterNext)] }));

            // Start a crossfade (outgoing = current, incoming = next).
            await tick(291_500);
            await tick(PENDING_AT_MS);
            expect(get(musicPlayerStore).isCrossfading).toBe(true);
            expect(mockBackend.calls.filter((c) => c === 'triggerCrossfade')).toHaveLength(1);
            // triggerCrossfade already promoted `next` and reported `current`'s
            // play-end synchronously, before awaiting the backend.
            expect(get(musicPlayerStore).currentTrack?.id).toBe(next.id);

            // The crossfade backend Promise is still pending (deferred
            // unresolved). Rapidly skip() — currentTrack is now `next` (the
            // incoming track), so skip() cancels the fade and reports ITS
            // play-end (wasSkipped=true) and advances to `afterNext`. The
            // resolved continuation inside triggerCrossfade must bail (token
            // bumped + isCrossfading cleared) so `current`'s play-end is NOT
            // reported a second time.
            const skipPromise = musicPlayerStore.skip();
            await skipPromise;
            await flush();

            // Outgoing track's play-end was reported exactly once, at fade
            // start — not again by the skip/cancel path.
            const endCallsForOutgoing = reportMusicPlayback.mock.calls.filter(
                (args) => args[0] === current.id && args[1].status === 'COMPLETED',
            );
            expect(endCallsForOutgoing).toHaveLength(1);
            expect(endCallsForOutgoing[0][1].endReason).toBe('completion'); // fade-start reporting, not a skip

            // skip() recorded the INCOMING track (now currentTrack) as skipped
            // — asserted via the synchronous skippedTrackIds update rather than
            // racing its own fire-and-forget reportMusicPlayback import against the
            // one triggerCrossfade already queued for `current` (two concurrent
            // dynamic imports of the same specifier is not a reliable thing to
            // assert on in this test harness).
            expect(get(musicPlayerStore).skippedTrackIds).toContain(next.id);
            expect(get(musicPlayerStore).skippedTrackIds).not.toContain(current.id);

            // skip() cancelled the in-flight crossfade and advanced past `next`.
            expect(mockBackend.calls).toContain('cancelCrossfade');
            expect(get(musicPlayerStore).currentTrack?.id).toBe(afterNext.id);
        });

        it('cancelCrossfade is called before play() advances during a skip', async () => {
            const current = makeTrack();
            const next = makeTrack();
            const afterNext = makeTrack();
            primePlaying({ current, next });
            updateForTest((s) => ({ ...s, queue: [queueItem(next), queueItem(afterNext)] }));

            await tick(291_500);
            await tick(PENDING_AT_MS);
            expect(get(musicPlayerStore).isCrossfading).toBe(true);

            const skipPromise = musicPlayerStore.skip();
            await flush();
            await skipPromise;
            await flush();

            const cancelIdx = mockBackend.calls.indexOf('cancelCrossfade');
            const playIdx = mockBackend.calls.indexOf('play');
            expect(cancelIdx).toBeGreaterThanOrEqual(0);
            expect(playIdx).toBeGreaterThan(cancelIdx);
        });

        it('skip() during a fade with an empty post-fade queue behaves like a normal end-of-queue skip', async () => {
            const current = makeTrack();
            const next = makeTrack();
            primePlaying({ current, next });
            // Only one queued track: it's consumed as the incoming track at
            // fade start, leaving the queue empty for skip() to advance into.
            updateForTest((s) => ({ ...s, queue: [queueItem(next)], autoplayEnabled: false }));

            await tick(291_500);
            await tick(PENDING_AT_MS);
            expect(get(musicPlayerStore).isCrossfading).toBe(true);
            expect(get(musicPlayerStore).queue).toHaveLength(0);

            await musicPlayerStore.skip();
            await flush();

            // No next track and autoplay disabled → skip() stops playback
            // instead of calling play() again.
            expect(mockBackend.calls).not.toContain('play');
            expect(get(musicPlayerStore).currentTrack).toBeNull();
        });
    });

    describe('regression: seekTo during crossfade always seeks the incoming track (B7)', () => {
        it('cancels the crossfade then seeks the incoming (now-current) track to the requested position', async () => {
            const current = makeTrack();
            const next = makeTrack();
            primePlaying({ current, next });
            updateForTest((s) => ({ ...s, queue: [queueItem(next)] }));

            // Begin a crossfade. Outgoing deck position ~ PENDING_AT_MS.
            await tick(291_500);
            await tick(PENDING_AT_MS);
            expect(get(musicPlayerStore).isCrossfading).toBe(true);

            // Forward seek within the incoming track's timeline.
            const seekTarget = 295_000;
            musicPlayerStore.seekTo(seekTarget);
            await flush();

            // The cancel must precede the seek, and the seek must hit the backend
            // with the requested target.
            const cancelIdx = mockBackend.calls.indexOf('cancelCrossfade');
            const seekIdx = mockBackend.calls.indexOf(`seekTo:${seekTarget}`);
            expect(cancelIdx).toBeGreaterThanOrEqual(0);
            expect(seekIdx).toBeGreaterThan(cancelIdx);

            const state = get(musicPlayerStore);
            expect(state.isCrossfading).toBe(false);
            expect(state.currentTrack?.id).toBe(next.id);
            expect(state.currentTimeMs).toBe(seekTarget);

            // Outgoing track's play-end reported exactly once (at fade start —
            // the triggerCrossfade continuation must have bailed, and the seek
            // itself reports nothing since promotion already happened).
            const endCallsForCurrent = reportMusicPlayback.mock.calls.filter(
                (args) => args[0] === current.id && args[1].status === 'COMPLETED',
            );
            expect(endCallsForCurrent).toHaveLength(1);
            expect(endCallsForCurrent[0][1].endReason).toBe('completion'); // not flagged as skip
        });

        it('a seek "backward" relative to the outgoing deck position still seeks WITHIN the incoming track (old outgoing-track-stays behavior is gone)', async () => {
            const current = makeTrack();
            const next = makeTrack();
            primePlaying({ current, next });
            updateForTest((s) => ({ ...s, queue: [queueItem(next)] }));

            await tick(291_500);
            await tick(PENDING_AT_MS);
            expect(get(musicPlayerStore).isCrossfading).toBe(true);
            // Outgoing deck's position — irrelevant now: the seek bar shows the
            // INCOMING track's timeline, not the outgoing deck's clock.
            mockBackend.currentTimeMs = PENDING_AT_MS;

            // Seek to an early position — "backward" only relative to the old
            // outgoing-deck position, which no longer matters.
            const seekTarget = 10_000;
            musicPlayerStore.seekTo(seekTarget);
            await flush();

            const state = get(musicPlayerStore);
            // The incoming track (promoted at fade start) is what gets seeked —
            // there is no "stay on outgoing track" branch anymore.
            expect(state.currentTrack?.id).toBe(next.id);
            expect(state.isCrossfading).toBe(false);
            expect(state.currentTimeMs).toBe(seekTarget);
            expect(mockBackend.calls).toContain(`seekTo:${seekTarget}`);
            // Outgoing track's play-end was already reported once, at fade
            // start — this seek must not report it again.
            const endCallsForCurrent = reportMusicPlayback.mock.calls.filter(
                (args) => args[0] === current.id && args[1].status === 'COMPLETED',
            );
            expect(endCallsForCurrent).toHaveLength(1);
            expect(endCallsForCurrent[0][1].endReason).toBe('completion');
        });

        it('clamps the seek target into the incoming track range ([0, durationMs - 1000])', async () => {
            const current = makeTrack();
            const next = makeTrack();
            primePlaying({ current, next });
            updateForTest((s) => ({ ...s, queue: [queueItem(next)] }));

            await tick(291_500);
            await tick(PENDING_AT_MS);
            expect(get(musicPlayerStore).isCrossfading).toBe(true);
            const durationMs = get(musicPlayerStore).durationMs;

            // Seek far past the end of the incoming track.
            musicPlayerStore.seekTo(durationMs + 50_000);
            await flush();

            const state = get(musicPlayerStore);
            expect(state.currentTimeMs).toBe(durationMs - 1_000);
        });
    });

    // =======================================================================
    // Session history on the crossfade advance paths
    //
    // `history` is what feeds the smart queue's exclude/history params, so a
    // path that promotes the incoming track without recording the outgoing one
    // leaves the server with no session context and it re-picks played tracks.
    // Every path that swaps currentTrack must record the outgoing track.
    // =======================================================================

    describe('regression: crossfade advance records the outgoing track in history', () => {
        it('triggerCrossfade finalize pushes the outgoing track into history', async () => {
            const current = makeTrack();
            const next = makeTrack();
            primePlaying({ current, next });

            await tick(291_500);
            await tick(PENDING_AT_MS);
            expect(get(musicPlayerStore).isCrossfading).toBe(true);

            // Let the backend crossfade complete → finalize path runs.
            for (const d of mockBackend.crossfadeDeferreds) d.resolve();
            await flush();

            const state = get(musicPlayerStore);
            expect(state.currentTrack?.id).toBe(next.id);
            expect(state.history.map((t) => t.id)).toEqual([current.id]);
        });

        it('accumulates history across consecutive crossfades (oldest last)', async () => {
            const first = makeTrack();
            const second = makeTrack();
            const third = makeTrack();
            primePlaying({ current: first, next: second });

            await tick(291_500);
            await tick(PENDING_AT_MS);
            for (const d of mockBackend.crossfadeDeferreds) d.resolve();
            await flush();

            // Queue up a third track and crossfade again.
            updateForTest((s) => ({
                ...s,
                queue: [queueItem(third)],
                currentTimeMs: 0,
                pendingCrossfadeAtMs: null,
                pendingCrossfadeForTrackId: null,
            }));
            await tick(291_500);
            await tick(PENDING_AT_MS);
            for (const d of mockBackend.crossfadeDeferreds) d.resolve();
            await flush();

            const state = get(musicPlayerStore);
            expect(state.currentTrack?.id).toBe(third.id);
            expect(state.history.map((t) => t.id)).toEqual([second.id, first.id]);
        });

        it('forward seekTo during a crossfade records the outgoing track', async () => {
            const current = makeTrack();
            const next = makeTrack();
            primePlaying({ current, next });

            await tick(291_500);
            await tick(PENDING_AT_MS);
            expect(get(musicPlayerStore).isCrossfading).toBe(true);

            musicPlayerStore.seekTo(295_000);
            await flush();

            const state = get(musicPlayerStore);
            expect(state.currentTrack?.id).toBe(next.id);
            expect(state.history.map((t) => t.id)).toEqual([current.id]);
        });

        it('pause during a crossfade records the outgoing track', async () => {
            const current = makeTrack();
            const next = makeTrack();
            primePlaying({ current, next });

            await tick(291_500);
            await tick(PENDING_AT_MS);
            expect(get(musicPlayerStore).isCrossfading).toBe(true);

            musicPlayerStore.pause();
            await flush();

            const state = get(musicPlayerStore);
            expect(state.currentTrack?.id).toBe(next.id);
            expect(state.history.map((t) => t.id)).toEqual([current.id]);
        });
    });

    // =======================================================================
    // Queue mutations mid-fade: since queue[0] is consumed synchronously at
    // fade start, it is never a live fade target — reorderQueue/removeFromQueue
    // must apply immediately, with no crossfade lock.
    // =======================================================================

    describe('regression: reorderQueue/removeFromQueue apply verbatim mid-fade', () => {
        it('reorderQueue during an in-flight fade is applied verbatim (no silent drop, head not re-inserted)', async () => {
            const current = makeTrack();
            const next = makeTrack();
            const a = makeTrack();
            const b = makeTrack();
            primePlaying({ current, next });
            updateForTest((s) => ({ ...s, queue: [queueItem(next), queueItem(a), queueItem(b)] }));

            await tick(291_500);
            await tick(PENDING_AT_MS);
            expect(get(musicPlayerStore).isCrossfading).toBe(true);
            // `next` was consumed synchronously at fade start.
            expect(get(musicPlayerStore).queue.map((q) => q.id)).toEqual([a.id, b.id]);

            // Reorder mid-fade: reversed order, applied verbatim.
            musicPlayerStore.reorderQueue([queueItem(b), queueItem(a)]);

            expect(get(musicPlayerStore).queue.map((q) => q.id)).toEqual([b.id, a.id]);
            // The fade itself is untouched by the queue mutation.
            expect(get(musicPlayerStore).isCrossfading).toBe(true);
        });

        it('removeFromQueue removes any item mid-fade', async () => {
            const current = makeTrack();
            const next = makeTrack();
            const a = makeTrack();
            const b = makeTrack();
            primePlaying({ current, next });
            updateForTest((s) => ({ ...s, queue: [queueItem(next), queueItem(a), queueItem(b)] }));

            await tick(291_500);
            await tick(PENDING_AT_MS);
            expect(get(musicPlayerStore).isCrossfading).toBe(true);
            expect(get(musicPlayerStore).queue.map((q) => q.id)).toEqual([a.id, b.id]);

            musicPlayerStore.removeFromQueue(a.id);

            expect(get(musicPlayerStore).queue.map((q) => q.id)).toEqual([b.id]);
            expect(get(musicPlayerStore).isCrossfading).toBe(true);
        });
    });

    // =======================================================================
    // Outgoing-track play-end reporting: must fire exactly once whether the
    // fade is cancelled early or allowed to complete normally.
    // =======================================================================

    describe('regression: play-end reported exactly once for the outgoing track on a normal (uncancelled) fade completion', () => {
        it('reports the outgoing track once at fade start and does not report it again when the backend fade later resolves', async () => {
            const current = makeTrack();
            const next = makeTrack();
            primePlaying({ current, next });

            await tick(291_500);
            await tick(PENDING_AT_MS);
            expect(get(musicPlayerStore).isCrossfading).toBe(true);

            // The outgoing track's play-end is already queued (via the
            // fire-and-forget dynamic import) at fade start, before the
            // backend fade resolves.
            await flush();
            let endCallsForCurrent = reportMusicPlayback.mock.calls.filter(
                (args) => args[0] === current.id && args[1].status === 'COMPLETED',
            );
            expect(endCallsForCurrent).toHaveLength(1);
            expect(endCallsForCurrent[0][1].endReason).toBe('completion');

            // Let the backend crossfade complete normally (no cancel path).
            for (const d of mockBackend.crossfadeDeferreds) d.resolve();
            await flush();

            // Completion only clears fade flags/re-syncs volume — it must not
            // report play-end again for the outgoing track.
            endCallsForCurrent = reportMusicPlayback.mock.calls.filter(
                (args) => args[0] === current.id && args[1].status === 'COMPLETED',
            );
            expect(endCallsForCurrent).toHaveLength(1);
            expect(get(musicPlayerStore).isCrossfading).toBe(false);
        });
    });

    describe('regression: loudness normalization for a track queued without loudnessLufs', () => {
        // Album pages built queue items with only { bpm }. The incoming track's
        // loudness only arrives via the detail fetch fired at fade start, so the
        // track played un-normalized until its own fade-out stepped the level.
        const LOUD_LUFS = -20; // +6 dB gain → 0.4 × ~1.995
        const expected = applyLufsGain(0.4, LOUD_LUFS);

        function detailWithLoudness(id: string) {
            return {
                data: {
                    track: {
                        id,
                        audioFeatures: { bpm: 120, energy: 0.3, loudnessLufs: LOUD_LUFS },
                    },
                },
                error: null,
                status: 200,
            } as never;
        }

        it('post-fade re-sync uses the loudness that arrived mid-fade', async () => {
            const current = makeTrack();
            const next = makeTrack(); // no loudnessLufs
            vi.mocked(musicApi.getTrack).mockImplementation(async (id: string) =>
                id === next.id ? detailWithLoudness(id) : (EMPTY_OK as never),
            );
            primePlaying({ current, next });
            updateForTest((s) => ({
                ...s,
                volume: 0.4,
                loudnessNormalizationEnabled: true,
                isMuted: false,
            }));

            await tick(291_500);
            await tick(PENDING_AT_MS);
            expect(get(musicPlayerStore).isCrossfading).toBe(true);
            await flush(); // detail lands mid-fade
            expect(get(musicPlayerStore).currentTrack?.audioFeatures?.loudnessLufs).toBe(LOUD_LUFS);

            for (const d of mockBackend.crossfadeDeferreds) d.resolve();
            await flush();

            expect(get(musicPlayerStore).isCrossfading).toBe(false);
            expect(mockBackend.volumes.at(-1)).toBeCloseTo(expected);
        });

        it('re-applies normalization when the loudness arrives after the fade finished', async () => {
            const current = makeTrack();
            const next = makeTrack(); // no loudnessLufs
            let releaseDetail!: () => void;
            const gate = new Promise<void>((r) => (releaseDetail = r));
            vi.mocked(musicApi.getTrack).mockImplementation(async (id: string) => {
                if (id !== next.id) return EMPTY_OK as never;
                await gate;
                return detailWithLoudness(id);
            });
            primePlaying({ current, next });
            updateForTest((s) => ({
                ...s,
                volume: 0.4,
                loudnessNormalizationEnabled: true,
                isMuted: false,
            }));

            await tick(291_500);
            await tick(PENDING_AT_MS);
            for (const d of mockBackend.crossfadeDeferreds) d.resolve();
            await flush();
            expect(get(musicPlayerStore).isCrossfading).toBe(false);
            expect(mockBackend.volumes.at(-1)).toBeCloseTo(0.4); // loudness still unknown

            releaseDetail();
            await flush();
            expect(mockBackend.volumes.at(-1)).toBeCloseTo(expected);
        });

        it('leaves the volume alone when normalization is off', async () => {
            const current = makeTrack();
            const next = makeTrack();
            vi.mocked(musicApi.getTrack).mockImplementation(async (id: string) =>
                id === next.id ? detailWithLoudness(id) : (EMPTY_OK as never),
            );
            primePlaying({ current, next });
            updateForTest((s) => ({
                ...s,
                volume: 0.4,
                loudnessNormalizationEnabled: false,
                isMuted: false,
            }));

            await tick(291_500);
            await tick(PENDING_AT_MS);
            await flush();
            for (const d of mockBackend.crossfadeDeferreds) d.resolve();
            await flush();
            expect(mockBackend.volumes.every((v) => v === 0.4)).toBe(true);
        });
    });

    // =======================================================================
    // Harness canary: the mock that every play-end count above depends on.
    //
    // If `$lib/api/music` ever goes back to a factory `vi.mock`, an overlapping
    // pair of dynamic imports resolves the SECOND one to the real module, the
    // spy stops recording those calls, and every `toHaveLength(1)` guard above
    // silently turns into a guard that cannot fail. These tests fail loudly
    // instead — they are the reason those guards can be trusted to count.
    // =======================================================================

    describe('mock-integrity: $lib/api/music cannot be bypassed by overlapping dynamic imports', () => {
        it('resolves BOTH sides of a concurrent double import to the same mocked module', async () => {
            const [first, second] = await Promise.all([
                import('$lib/api/music'),
                import('$lib/api/music'),
            ]);

            // The bypass hands one side the REAL module: its exports are plain
            // functions, not spies, and there are ~40 of them rather than the
            // mocked surface. Assert on both sides, not just the first.
            expect(vi.isMockFunction(first.reportMusicPlayback)).toBe(true);
            expect(vi.isMockFunction(second.reportMusicPlayback)).toBe(true);
            expect(second.reportMusicPlayback).toBe(first.reportMusicPlayback);
            expect(first.reportMusicPlayback).toBe(reportMusicPlayback);
        });

        it('counts EVERY call when a burst of overlapping imports each report', async () => {
            // Mirrors what the store does at fade start: several floating
            // `import(...).then(m => m.reportMusicPlayback(...))` issued back to back
            // from one module. All of them must land on the spy.
            const BURST = 5;
            await Promise.all(
                Array.from({ length: BURST }, (_, i) =>
                    import('$lib/api/music').then((m) =>
                        m.reportMusicPlayback(`burst-${i}`, {
                            positionMs: 0,
                            status: 'COMPLETED',
                            eventSeq: 1,
                            sessionElapsedMs: 0,
                        }),
                    ),
                ),
            );

            const burstCalls = reportMusicPlayback.mock.calls.filter((args) =>
                args[0].startsWith('burst-'),
            );
            expect(burstCalls).toHaveLength(BURST);
        });

        it('records one terminal completion report at fade start', async () => {
            // Completion and listen history share this report; no second write.
            const current = makeTrack();
            const next = makeTrack();
            primePlaying({ current, next });

            await tick(291_500);
            await tick(PENDING_AT_MS);
            await flush();

            expect(
                reportMusicPlayback.mock.calls.filter(
                    (args) => args[0] === current.id && args[1].status === 'COMPLETED',
                ),
            ).toHaveLength(1);
            expect(
                terminalReports().filter(
                    ([id, body]) => id === current.id && body.endReason === 'completion',
                ),
            ).toHaveLength(1);
        });
    });

    describe('regression: backend fade failure hard-cuts to the promoted track', () => {
        it('cap-one rejects a preload, then releases the outgoing session before a clean hard cut', async () => {
            const current = makeTrack();
            const next = makeTrack();
            primePlaying({ current, next });
            let admittedNext = false;
            let released = false;
            let release!: () => void;
            const ack = new Promise<void>((resolve) => {
                release = resolve;
            });
            reportMusicPlayback.mockImplementation(async (id, report) => {
                if (id === current.id && report.status === 'COMPLETED') {
                    await ack;
                    released = true;
                }
                return EMPTY_OK;
            });
            vi.mocked(musicApi.startMusicPlaySession).mockImplementation(async ({ trackId }) => {
                if (trackId === next.id && !released) {
                    return { data: null, error: 'stream_limit_exceeded', status: 409 };
                }
                if (trackId === next.id) admittedNext = true;
                return { data: playbackStartFixture(trackId, trackId), error: null, status: 201 };
            });
            await tick(100000);
            await flush();
            await tick(110000);
            await flush();
            await tick(120000);
            await flush();
            expect(
                vi
                    .mocked(musicApi.startMusicPlaySession)
                    .mock.calls.filter(([input]) => input.trackId === next.id),
            ).toHaveLength(1);
            expect(admittedNext).toBe(false);
            expect(get(musicPlayerStore).currentTrack?.id).toBe(current.id);
            expect(get(musicPlayerStore).isPlaying).toBe(true);
            await tick(291500);
            await tick(PENDING_AT_MS);
            await flush();
            expect(admittedNext).toBe(false);
            release();
            await flush();
            expect(admittedNext).toBe(true);
            expect(get(musicPlayerStore).currentTrack?.id).toBe(next.id);
            expect(get(musicPlayerStore).isPlaying).toBe(true);
        });

        it('recovers by playing the promoted incoming track when triggerCrossfade rejects', async () => {
            const current = makeTrack();
            const next = makeTrack();
            primePlaying({ current, next });

            await tick(291_500);
            await tick(PENDING_AT_MS);
            expect(get(musicPlayerStore).isCrossfading).toBe(true);
            expect(get(musicPlayerStore).currentTrack?.id).toBe(next.id);

            // Backend fails to run the fade (missing deck / incoming deck
            // play() rejection — both backends throw on those paths).
            mockBackend.crossfadeDeferreds[mockBackend.crossfadeDeferreds.length - 1]!.reject(
                new Error('incoming deck play() failed'),
            );
            await flush();

            // Fade state cleared; the promoted track stays current, and the
            // store hard-cut the audio to it (cancelCrossfade + play).
            const state = get(musicPlayerStore);
            expect(state.isCrossfading).toBe(false);
            expect(state.currentTrack?.id).toBe(next.id);
            expect(state.isPlaying).toBe(true);
            expect(mockBackend.calls).toContain('cancelCrossfade');
            expect(mockBackend.calls).toContain('play');
        });

        it('a dead incoming track (recovery play fails too) moves on to the next queued track', async () => {
            const current = makeTrack();
            const dead = makeTrack();
            const after = makeTrack();
            primePlaying({ current, next: dead });
            updateForTest((s) => ({ ...s, queue: [...s.queue, queueItem(after)] }));

            await tick(291_500);
            await tick(PENDING_AT_MS);
            expect(get(musicPlayerStore).currentTrack?.id).toBe(dead.id);

            // The incoming stream is dead (404): the fade engine gives up, and
            // the hard-cut recovery play() of the same track fails as well.
            const realPlay = mockBackend.play;
            let failNext = true;
            mockBackend.play = async (src, metadata) => {
                if (failNext) {
                    failNext = false;
                    mockBackend.calls.push('play-failed');
                    throw new Error('MEDIA_ERR_SRC_NOT_SUPPORTED');
                }
                return realPlay(src, metadata);
            };
            try {
                mockBackend.crossfadeDeferreds[mockBackend.crossfadeDeferreds.length - 1]!.reject(
                    new Error('incoming stream failed'),
                );
                await flush();
                await flush();
            } finally {
                mockBackend.play = realPlay;
            }

            // Not a dead stop with the session wiped: the next track plays.
            const state = get(musicPlayerStore);
            expect(mockBackend.calls).toContain('play-failed');
            expect(state.currentTrack?.id).toBe(after.id);
            expect(state.isPlaying).toBe(true);
            expect(state.queue).toHaveLength(0);
        });

        it('does not fight a cancel path that took over before the rejection surfaced', async () => {
            const current = makeTrack();
            const next = makeTrack();
            primePlaying({ current, next });

            await tick(291_500);
            await tick(PENDING_AT_MS);
            expect(get(musicPlayerStore).isCrossfading).toBe(true);

            // The rejection is queued (settles on a microtask) ...
            mockBackend.crossfadeDeferreds[mockBackend.crossfadeDeferreds.length - 1]!.reject(
                new Error('late failure'),
            );
            // ... but a user pause takes over SYNCHRONOUSLY first: bumps the
            // crossfade token, cancels at the backend, pauses.
            musicPlayerStore.pause();
            const playCallsBefore = mockBackend.calls.filter((c) => c === 'play').length;
            await flush();

            // The catch saw the bumped token and bailed — no recovery play()
            // fires against the decks the pause path now owns.
            expect(mockBackend.calls.filter((c) => c === 'play').length).toBe(playCallsBefore);
            expect(get(musicPlayerStore).isPlaying).toBe(false);
            expect(get(musicPlayerStore).isCrossfading).toBe(false);
        });
    });
});

// ===========================================================================
// AirPlay: a second button press must open the picker, not reload the stream
// ===========================================================================

describe('mood radio with the autoplay setting off', () => {
    it('keeps the radio going: the seed turns autoplay on and the queue is fetched', async () => {
        const seedTrack = makeTrack({ title: 'Radio Start' });
        // The cold start is the first recommendations call; the follow-up fetch
        // for the playing track falls through to the default (no pick).
        getRecommendations.mockResolvedValueOnce({
            ...EMPTY_OK,
            data: { next: seedTrack, alternatives: [], source: 'mood' },
        } as Awaited<ReturnType<typeof musicApi.getRecommendations>>);
        updateForTest((s) => ({
            ...s,
            currentTrack: null,
            queue: [],
            isPlaying: false,
            autoplayEnabled: false,
            autoplaySeed: null,
        }));
        getRecommendations.mockClear();

        await musicPlayerStore.seedAutoplay({
            type: 'mood',
            mood: 'chill',
            label: 'Chill',
            emoji: '😌',
        });
        await flush();

        // A radio is a request for continuous music: with autoplay left off it
        // played the first track and nothing after it.
        expect(get(musicPlayerStore).currentTrack?.id).toBe(seedTrack.id);
        expect(get(musicPlayerStore).autoplayEnabled).toBe(true);
        expect(getRecommendations).toHaveBeenCalled();
    });
});

describe('activateAirPlay', () => {
    const originalGetAudioElement = persistentBackend.getAudioElement;
    const originalReload = persistentBackend.reloadCurrentSrc;

    afterEach(() => {
        persistentBackend.getAudioElement = originalGetAudioElement;
        persistentBackend.reloadCurrentSrc = originalReload;
    });

    function installFakeAudio(): { el: { src: string }; picker: ReturnType<typeof vi.fn> } {
        const picker = vi.fn();
        const el = { src: '', webkitShowPlaybackTargetPicker: picker };
        mockBackend.getAudioElement = (): HTMLAudioElement => el as unknown as HTMLAudioElement;
        return { el, picker };
    }

    function mockToken(token: string): void {
        vi.mocked(musicApi.startMusicPlaySession).mockImplementation(
            async ({ trackId }) =>
                ({
                    data: playbackStartFixture(trackId, `session-${trackId}`, token),
                    error: null,
                    status: 200,
                }) as Awaited<ReturnType<typeof musicApi.startMusicPlaySession>>,
        );
    }

    function installRecordingReload(el: { src: string }): ReturnType<typeof vi.fn> {
        const reload = vi.fn(async (src: string) => {
            el.src = `https://lumastra.test${src}`;
            return true;
        });
        mockBackend.reloadCurrentSrc = reload;
        return reload;
    }

    it('reloads onto the token URL on the first press, and only opens the picker on the second', async () => {
        const track = makeTrack();
        updateForTest((s) => ({ ...s, currentTrack: track, isPlaying: true }));
        mockToken('tok');
        const { el, picker } = installFakeAudio();
        const reload = installRecordingReload(el);

        expect(await musicPlayerStore.activateAirPlay()).toBe(true);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(reload.mock.calls[0][0]).toContain('grant=tok');
        expect(picker).toHaveBeenCalledTimes(1);

        // Second press while routed to the receiver: re-assigning the same src
        // made the receiver re-buffer and the button spin forever.
        updateForTest((s) => ({ ...s, isAirPlayActive: true }));
        expect(await musicPlayerStore.activateAirPlay()).toBe(true);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(picker).toHaveBeenCalledTimes(2);
    });

    it('still reloads when AirPlay is active but the element is on the cookie-authed URL', async () => {
        // Route engaged from Safari's own control: the receiver can't auth the
        // internal URL, so isAirPlayActive alone must not skip the reload.
        const track = makeTrack();
        updateForTest((s) => ({
            ...s,
            currentTrack: track,
            isPlaying: true,
            isAirPlayActive: true,
        }));
        mockToken('tok');
        const { el, picker } = installFakeAudio();
        el.src = `https://lumastra.test/api/music/tracks/${track.id}/stream`;
        const reload = installRecordingReload(el);

        expect(await musicPlayerStore.activateAirPlay()).toBe(true);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(picker).toHaveBeenCalledTimes(1);
    });

    it('reloads when the element is on the token URL of a different track', async () => {
        const track = makeTrack();
        updateForTest((s) => ({ ...s, currentTrack: track, isPlaying: true }));
        mockToken('tok');
        const { el } = installFakeAudio();
        el.src = 'https://lumastra.test/api/v1/music/tracks/other/stream?grant=tok';
        const reload = installRecordingReload(el);

        await musicPlayerStore.activateAirPlay();
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('reloads when the element carries a stale token for the same track', async () => {
        // After a re-mint the old token is dead; the receiver needs the new URL.
        const track = makeTrack();
        updateForTest((s) => ({
            ...s,
            currentTrack: track,
            isPlaying: true,
            isAirPlayActive: true,
        }));
        mockToken('tok');
        const { el, picker } = installFakeAudio();
        await musicPlayerStore.activateAirPlay(); // ensures a current token exists
        el.src = `https://lumastra.test/api/v1/music/tracks/${track.id}/stream?grant=old`;
        const reload = installRecordingReload(el);

        await musicPlayerStore.activateAirPlay();
        expect(reload).toHaveBeenCalledTimes(1);
        expect(picker).toHaveBeenCalledTimes(2);
    });

    it('opens the picker even when the reload never settles', async () => {
        vi.useFakeTimers();
        try {
            const track = makeTrack();
            updateForTest((s) => ({ ...s, currentTrack: track, isPlaying: true }));
            mockToken('tok');
            const { picker } = installFakeAudio();
            mockBackend.reloadCurrentSrc = vi.fn(() => new Promise<boolean>(() => {}));

            const pending = musicPlayerStore.activateAirPlay();
            await vi.advanceTimersByTimeAsync(3_000);
            expect(await pending).toBe(true);
            expect(picker).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});

// ===========================================================================
// AirPlay stream token: local playback stays cookie-authed, dead sessions
// re-mint once (the endpoint doc: "clients MUST re-mint on 401")
// ===========================================================================

describe('AirPlay stream token lifecycle', () => {
    const originalPlay = persistentBackend.play;
    const originalGetAudioElement = persistentBackend.getAudioElement;
    const originalReload = persistentBackend.reloadCurrentSrc;

    beforeEach(() => {
        musicPlayerStore._resetAirPlayTokenForTest!();
    });

    afterEach(() => {
        persistentBackend.play = originalPlay;
        persistentBackend.getAudioElement = originalGetAudioElement;
        persistentBackend.reloadCurrentSrc = originalReload;
    });

    let mintSeq = 0;
    /** Each mint hands out a new token: tok-1, tok-2, ... */
    function mockMinting(): ReturnType<typeof vi.fn> {
        const mint = vi.mocked(musicApi.startMusicPlaySession);
        mint.mockImplementation(async ({ trackId }) => {
            mintSeq += 1;
            return {
                data: playbackStartFixture(trackId, `session-${mintSeq}`, `tok-${mintSeq}`),
                error: null,
                status: 200,
            } as Awaited<ReturnType<typeof musicApi.startMusicPlaySession>>;
        });
        return mint as unknown as ReturnType<typeof vi.fn>;
    }

    /** Fake deck whose src follows backend.play/reloadCurrentSrc. */
    function installDeck(): {
        el: { src: string };
        plays: string[];
        reload: ReturnType<typeof vi.fn>;
        picker: ReturnType<typeof vi.fn>;
    } {
        const picker = vi.fn();
        const el = { src: '', webkitShowPlaybackTargetPicker: picker };
        const plays: string[] = [];
        mockBackend.getAudioElement = (): HTMLAudioElement => el as unknown as HTMLAudioElement;
        mockBackend.play = vi.fn(async (src: string) => {
            plays.push(src);
            el.src = `https://lumastra.test${src}`;
        });
        const reload = vi.fn(async (src: string) => {
            el.src = `https://lumastra.test${src}`;
            return true;
        });
        mockBackend.reloadCurrentSrc = reload;
        return { el, plays, reload, picker };
    }

    /** activateAirPlay, then the route engages (the detector's report). */
    async function engageAirPlay(): Promise<void> {
        expect(await musicPlayerStore.activateAirPlay()).toBe(true);
        updateForTest((s) => ({ ...s, isAirPlayActive: true }));
    }

    it('keeps local playback on the cookie URL even with a cached token', async () => {
        mockMinting();
        const { plays } = installDeck();
        updateForTest((s) => ({ ...s, currentTrack: makeTrack(), isPlaying: true }));
        await engageAirPlay();

        // AirPlay disconnects; the next track must not ride the token for hours.
        updateForTest((s) => ({ ...s, isAirPlayActive: false }));
        const next = makeTrack();
        await musicPlayerStore.play(next);
        expect(plays.at(-1)).toBe(`/api/v1/music/tracks/${next.id}/stream?grant=tok-${mintSeq}`);
    });

    it('uses the token URL for the next track while AirPlay is active', async () => {
        mockMinting();
        const { plays } = installDeck();
        updateForTest((s) => ({ ...s, currentTrack: makeTrack(), isPlaying: true }));
        await engageAirPlay();

        const next = makeTrack();
        await musicPlayerStore.play(next);
        expect(plays.at(-1)).toBe(`/api/v1/music/tracks/${next.id}/stream?grant=tok-${mintSeq}`);
    });

    it('re-mints once and retries when play() fails on a tokenized URL', async () => {
        const mint = mockMinting();
        const { plays } = installDeck();
        updateForTest((s) => ({ ...s, currentTrack: makeTrack(), isPlaying: true }));
        await engageAirPlay();
        const deadToken = `tok-${mintSeq}`;
        expect(mint).toHaveBeenCalledTimes(1);

        // The session died (inactivity timeout): the dead token's load fails.
        const basePlay = mockBackend.play;
        mockBackend.play = vi.fn(async (src: string, meta: TrackMetadata) => {
            if (src.includes(`grant=${deadToken}`)) {
                plays.push(src);
                throw new Error('MediaError 4');
            }
            return basePlay(src, meta);
        });

        const next = makeTrack();
        await musicPlayerStore.play(next);
        expect(mint).toHaveBeenCalledTimes(2);
        expect(plays.at(-1)).toBe(`/api/v1/music/tracks/${next.id}/stream?grant=tok-${mintSeq}`);
        expect(get(musicPlayerStore).currentTrack?.id).toBe(next.id);
        expect(get(musicPlayerStore).isPlaying).toBe(true);
    });

    it('does not mint when a cookie-URL play fails with AirPlay inactive', async () => {
        const mint = mockMinting();
        installDeck();
        mockBackend.play = vi.fn(async () => {
            throw new Error('MediaError 4');
        });

        await musicPlayerStore.play(makeTrack());
        expect(mint).toHaveBeenCalledTimes(1);
        expect(get(musicPlayerStore).currentTrack).toBeNull();
    });

    it('mid-stream failure on the token URL re-mints and reloads at the store position', async () => {
        const mint = mockMinting();
        const { reload } = installDeck();
        const track = makeTrack();
        updateForTest((s) => ({ ...s, currentTrack: track, isPlaying: true }));
        await engageAirPlay();
        reload.mockClear();
        updateForTest((s) => ({ ...s, currentTimeMs: 95_000, isPlaying: true }));

        mockBackend.capturedCallbacks!.onPlaybackError?.(
            new MediaPlaybackError(2, 'MEDIA_ERR_NETWORK'),
        );
        await flush();

        expect(mint).toHaveBeenCalledTimes(2);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(reload.mock.calls[0][0]).toBe(
            `/api/v1/music/tracks/${track.id}/stream?grant=tok-${mintSeq}`,
        );
        expect(reload.mock.calls[0][1]).toEqual({ positionMs: 95_000, resume: true });
        expect(get(musicPlayerStore).currentTrack?.id).toBe(track.id);
    });

    it('a second mid-stream failure inside the cooldown stops instead of looping', async () => {
        const mint = mockMinting();
        installDeck();
        updateForTest((s) => ({ ...s, currentTrack: makeTrack(), isPlaying: true }));
        await engageAirPlay();

        const fail = (): void =>
            mockBackend.capturedCallbacks!.onPlaybackError?.(
                new MediaPlaybackError(2, 'MEDIA_ERR_NETWORK'),
            );
        fail();
        await flush();
        fail();
        await flush();

        expect(mint).toHaveBeenCalledTimes(2); // activation + ONE recovery
        expect(get(musicPlayerStore).currentTrack).toBeNull();
    });

    it('mid-stream failure of local cookie playback stops without minting', async () => {
        const mint = mockMinting();
        const { el } = installDeck();
        const track = makeTrack();
        updateForTest((s) => ({ ...s, currentTrack: track, isPlaying: true }));
        el.src = `https://lumastra.test/api/music/tracks/${track.id}/stream`;

        mockBackend.capturedCallbacks!.onPlaybackError?.(
            new MediaPlaybackError(2, 'MEDIA_ERR_NETWORK'),
        );
        await flush();

        expect(mint).not.toHaveBeenCalled();
        expect(get(musicPlayerStore).currentTrack).toBeNull();
    });

    it('stop() keeps the AirPlay flags; stop(true) drops the token', async () => {
        const mint = mockMinting();
        const { el, reload } = installDeck();
        const track = makeTrack();
        updateForTest((s) => ({
            ...s,
            currentTrack: track,
            isPlaying: true,
            isAirPlayAvailable: true,
        }));
        await engageAirPlay();

        musicPlayerStore.stop();
        expect(get(musicPlayerStore).isAirPlayActive).toBe(true);
        expect(get(musicPlayerStore).isAirPlayAvailable).toBe(true);

        musicPlayerStore.stop(true);
        // Next activation must mint afresh, not reuse the old user's token.
        updateForTest((s) => ({ ...s, currentTrack: track, isPlaying: true }));
        el.src = '';
        reload.mockClear();
        await musicPlayerStore.activateAirPlay();
        expect(mint).toHaveBeenCalledTimes(2);
        expect(reload.mock.calls[0][0]).toContain(`grant=tok-${mintSeq}`);
    });

    function failMidStream(): void {
        mockBackend.capturedCallbacks!.onPlaybackError?.(
            new MediaPlaybackError(2, 'MEDIA_ERR_NETWORK'),
        );
    }

    it('a failed mint does not use up the recovery window', async () => {
        const mint = mockMinting();
        const { reload } = installDeck();
        updateForTest((s) => ({ ...s, currentTrack: makeTrack(), isPlaying: true }));
        await engageAirPlay();
        reload.mockClear();

        mint.mockResolvedValueOnce({ data: null, error: 'offline', status: 0 });
        failMidStream();
        await flush();
        expect(get(musicPlayerStore).currentTrack).toBeNull(); // this failure is fatal

        // The next session's failure still gets its one retry.
        updateForTest((s) => ({ ...s, currentTrack: makeTrack(), isPlaying: true }));
        failMidStream();
        await flush();
        expect(reload).toHaveBeenCalledTimes(1);
        expect(get(musicPlayerStore).currentTrack).not.toBeNull();
    });

    it('a deck on an OLDER token retries with the current one without minting', async () => {
        // Preloaded before the last re-mint (gapless/crossfade next deck).
        const mint = mockMinting();
        const { el, reload } = installDeck();
        const track = makeTrack();
        updateForTest((s) => ({ ...s, currentTrack: track, isPlaying: true }));
        await engageAirPlay();
        el.src = `https://lumastra.test/api/v1/music/tracks/${track.id}/stream?grant=old`;
        reload.mockClear();

        failMidStream();
        await flush();
        expect(mint).toHaveBeenCalledTimes(1); // activation only
        expect(reload.mock.calls[0][0]).toContain(`grant=tok-${mintSeq}`);

        // ...and that retry did not consume the window: a dead CURRENT token
        // right after still re-mints.
        failMidStream();
        await flush();
        expect(mint).toHaveBeenCalledTimes(2);
    });

    it('with AirPlay off, a failing tokenized src drops the token and retries on the cookie URL', async () => {
        const mint = mockMinting();
        const { reload } = installDeck();
        const track = makeTrack();
        updateForTest((s) => ({ ...s, currentTrack: track, isPlaying: true }));
        await engageAirPlay();
        updateForTest((s) => ({ ...s, isAirPlayActive: false })); // disconnected
        reload.mockClear();

        failMidStream();
        await flush();
        // A mint would end every other browser's music token for nothing.
        expect(mint).toHaveBeenCalledTimes(2);
        expect(reload.mock.calls[0][0]).toBe(
            `/api/v1/music/tracks/${track.id}/stream?grant=tok-${mintSeq}`,
        );
    });

    it('a mint in flight across stop(true) does not resurrect the token', async () => {
        const mint = mockMinting();
        const { plays } = installDeck();
        updateForTest((s) => ({ ...s, currentTrack: makeTrack(), isPlaying: true }));
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const realMint = mint.getMockImplementation() as (input: {
            trackId: string;
        }) => Promise<unknown>;
        mint.mockImplementationOnce(async () => {
            await gate;
            return realMint({
                trackId: get(musicPlayerStore).currentTrack?.id ?? 'cancelled-track',
            });
        });

        const pending = musicPlayerStore.activateAirPlay();
        await flush();
        musicPlayerStore.stop(true); // logout
        release();
        expect(await pending).toBe(false);

        updateForTest((s) => ({ ...s, isAirPlayActive: true }));
        const next = makeTrack();
        await musicPlayerStore.play(next);
        expect(plays.at(-1)).toBe(`/api/v1/music/tracks/${next.id}/stream?grant=tok-${mintSeq}`);
    });

    it('concurrent activations share one mint', async () => {
        const mint = mockMinting();
        installDeck();
        updateForTest((s) => ({ ...s, currentTrack: makeTrack(), isPlaying: true }));
        await Promise.all([musicPlayerStore.activateAirPlay(), musicPlayerStore.activateAirPlay()]);
        expect(mint).toHaveBeenCalledTimes(1);
    });

    it('a play superseded during the re-mint is not retried', async () => {
        const mint = mockMinting();
        const { plays } = installDeck();
        updateForTest((s) => ({ ...s, currentTrack: makeTrack(), isPlaying: true }));
        await engageAirPlay();
        const deadToken = `tok-${mintSeq}`;
        const basePlay = mockBackend.play;
        mockBackend.play = vi.fn(async (src: string, meta: TrackMetadata) => {
            if (src.includes(`grant=${deadToken}`)) {
                plays.push(src);
                throw new Error('MediaError 4');
            }
            return basePlay(src, meta);
        });
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const realMint = mint.getMockImplementation() as (input: {
            trackId: string;
        }) => Promise<unknown>;
        mint.mockImplementationOnce(async () => {
            await gate;
            return realMint({
                trackId: get(musicPlayerStore).currentTrack?.id ?? 'cancelled-track',
            });
        });

        const first = makeTrack();
        const firstPlay = musicPlayerStore.play(first);
        await flush();
        const second = makeTrack();
        const secondPlay = musicPlayerStore.play(second); // user moved on
        release();
        await Promise.all([firstPlay, secondPlay]);

        expect(plays.filter((p) => p.includes(`/tracks/${first.id}/`))).toHaveLength(0);
        expect(get(musicPlayerStore).currentTrack?.id).toBe(second.id);
    });
});

describe('crossfadeOutgoing: the outgoing track and its own clock during a fade', () => {
    async function startFade() {
        const current = makeTrack();
        const next = makeTrack();
        primePlaying({ current, next });
        await tick(291_500);
        await tick(PENDING_AT_MS);
        await flush();
        expect(get(musicPlayerStore).isCrossfading).toBe(true);
        return { current, next };
    }

    it('is set at promotion and follows the outgoing deck forward only', async () => {
        const { current, next } = await startFade();
        let s = get(musicPlayerStore);
        expect(s.currentTrack?.id).toBe(next.id);
        expect(s.crossfadeOutgoing).toEqual({ trackId: current.id, timeMs: PENDING_AT_MS });

        // Incoming deck not readable yet: the outgoing clock still advances.
        await tick(293_500);
        expect(get(musicPlayerStore).crossfadeOutgoing?.timeMs).toBe(293_500);

        mockBackend.incomingTimeMs = 1_500;
        await tick(294_000);
        s = get(musicPlayerStore);
        expect(s.crossfadeOutgoing?.timeMs).toBe(294_000);
        expect(s.currentTimeMs).toBe(1_500);

        // After the completion swap the active deck reports the incoming clock.
        mockBackend.incomingTimeMs = null;
        const before = get(musicPlayerStore);
        await tick(2_500);
        // Nothing moved: the same state object, so subscribers are not woken.
        expect(get(musicPlayerStore)).toBe(before);
        expect(before.crossfadeOutgoing?.timeMs).toBe(294_000);

        for (const d of mockBackend.crossfadeDeferreds) d.resolve();
        await flush();
        s = get(musicPlayerStore);
        expect(s.isCrossfading).toBe(false);
        expect(s.crossfadeOutgoing).toBeNull();
    });

    it('is cleared when a seek cancels the fade', async () => {
        await startFade();
        musicPlayerStore.seekTo(10_000);
        await flush();
        expect(get(musicPlayerStore).crossfadeOutgoing).toBeNull();
    });

    it('is cleared when a pause cancels the fade', async () => {
        await startFade();
        musicPlayerStore.pause();
        await flush();
        expect(get(musicPlayerStore).crossfadeOutgoing).toBeNull();
    });

    it('a new fade starts at progress 0 even if a cancelled one left progress behind', async () => {
        updateForTest((s) => ({ ...s, crossfadeProgress: 0.8 }));
        await startFade();
        expect(get(musicPlayerStore).crossfadeProgress).toBe(0);
    });
});

// The web player promotes the incoming track at fade START, so it reports the
// fade on the NEW session, as role 'incoming', for the Active Streams card.
describe('Active Streams crossfade report on the music session heartbeat', () => {
    const heartbeat = vi.mocked(musicApi.reportMusicPlayback);
    type Body = Parameters<typeof musicApi.reportMusicPlayback>[1];
    const bodies = (): Body[] => heartbeat.mock.calls.map((c) => c[1]);

    async function startReportedFade(): Promise<{ current: MusicTrack; next: MusicTrack }> {
        vi.mocked(musicApi.startMusicPlaySession).mockResolvedValue({
            data: playbackStartFixture('track-1', 'sess-fade'),
            error: null,
            status: 200,
        });
        const current = makeTrack();
        const next = makeTrack();
        primePlaying({ current, next });
        await tick(291_500);
        await tick(PENDING_AT_MS);
        await flush();
        return { current, next };
    }

    it('sends one heartbeat right after the new session starts, naming the outgoing track', async () => {
        const { current } = await startReportedFade();
        const withFade = bodies().filter((b) => b.crossfade);
        expect(withFade).toHaveLength(1);
        expect(heartbeat.mock.calls.find((call) => call[1].crossfade)?.[0]).toBe('sess-fade');
        expect(withFade[0].crossfade).toMatchObject({
            role: 'incoming',
            otherTrackId: current.id,
            // 4 beats at 120 BPM, as the engine computes it.
            durationMs: 2_000,
        });
        expect(withFade[0].crossfade!.remainingMs).toBeGreaterThan(0);
        expect(withFade[0].crossfade!.remainingMs).toBeLessThanOrEqual(2_000);
    });

    it('a seek that cancels the fade sends crossfade: null', async () => {
        await startReportedFade();
        heartbeat.mockClear();
        musicPlayerStore.seekTo(10_000);
        await flush();
        expect(bodies().some((b) => b.crossfade === null)).toBe(true);
    });

    it('retries the clear on the next heartbeat when it failed', async () => {
        await startReportedFade();
        heartbeat.mockClear();
        heartbeat.mockResolvedValueOnce({ data: null, error: 'boom', status: 500 });
        musicPlayerStore.seekTo(10_000);
        await flush();
        expect(bodies().filter((b) => b.crossfade === null)).toHaveLength(1);
        musicPlayerStore.pause();
        await flush();
        expect(bodies().filter((b) => b.crossfade === null)).toHaveLength(2);
    });

    it('a heartbeat without a fade omits the key', async () => {
        await startReportedFade();
        musicPlayerStore.seekTo(10_000);
        await flush();
        heartbeat.mockClear();
        musicPlayerStore.pause();
        await flush();
        expect(bodies().length).toBeGreaterThan(0);
        for (const b of bodies()) expect('crossfade' in b).toBe(false);
    });
});

describe('stop() keeps what init() set once', () => {
    it('a backend that cannot crossfade stays that way after the player is closed', async () => {
        const backendCaps = mockBackend as { supportsCrossfade: boolean };
        // iOS: PlainAudioBackend. init() returns early once a backend exists,
        // so nothing re-applies the capability after stop(); INITIAL_STATE's
        // `true` armed fades that the backend played as an early hard cut.
        backendCaps.supportsCrossfade = false;
        try {
            updateForTest((s) => ({ ...s, supportsCrossfade: false }));
            musicPlayerStore.stop(true);
            expect(get(musicPlayerStore).supportsCrossfade).toBe(false);
        } finally {
            backendCaps.supportsCrossfade = true;
            updateForTest((s) => ({ ...s, supportsCrossfade: true }));
        }
    });

    it('keeps the saved preferences and mute, and still resets the session', async () => {
        const before = get(musicPlayerStore);
        // Every value is the opposite of its INITIAL_STATE default, so a key
        // dropped from the kept list fails here.
        const prefs = {
            crossfadeEnabled: false,
            crossfadeBeatsOverride: 16,
            autoplayEnabled: false,
            showLoudnessDb: true,
            showBpm: false,
            alwaysShowBeatPulse: true,
            loudnessNormalizationEnabled: false,
            crossfadeDebug: !before.crossfadeDebug,
            isMuted: true,
        };
        try {
            updateForTest((s) => ({
                ...s,
                ...prefs,
                currentTrack: makeTrack(),
                queue: [queueItem(makeTrack())],
            }));
            musicPlayerStore.stop(true);
            const s = get(musicPlayerStore);
            expect(s).toMatchObject(prefs);
            expect(s.currentTrack).toBeNull();
            expect(s.queue).toEqual([]);
        } finally {
            updateForTest((s) => ({
                ...s,
                crossfadeEnabled: before.crossfadeEnabled,
                crossfadeBeatsOverride: before.crossfadeBeatsOverride,
                autoplayEnabled: before.autoplayEnabled,
                showLoudnessDb: before.showLoudnessDb,
                showBpm: before.showBpm,
                alwaysShowBeatPulse: before.alwaysShowBeatPulse,
                loudnessNormalizationEnabled: before.loudnessNormalizationEnabled,
                crossfadeDebug: before.crossfadeDebug,
                isMuted: before.isMuted,
            }));
        }
    });
});

// Reporting follows a playback session, independently of the playhead or queue.
describe('unified listening reports', () => {
    it('closes an unheard preload when its queue entry is discarded', async () => {
        const current = makeTrack();
        const next = makeTrack();
        primePlaying({ current, next });
        await tick(100000);
        await flush();
        expect(mockBackend.calls).toContain('prefetchNext');
        updateForTest((s) => ({ ...s, queue: [] }));
        await flush();
        expect(musicApi.cancelMusicPlayback).toHaveBeenCalledWith(next.id);
        expect(musicApi.cancelMusicPlayback).not.toHaveBeenCalledWith(current.id);
        expect(terminalReports().filter(([id]) => id === next.id)).toHaveLength(0);
    });

    it('starts sequence numbers at one and advances across pause, seek, and completion', async () => {
        const track = makeTrack();
        updateForTest((s) => ({ ...s, currentTrack: track, isPlaying: true, currentTimeMs: 0 }));
        await musicPlayerStore._startMusicSessionForTest!(track);
        musicPlayerStore.pause();
        musicPlayerStore.seekTo(90_000);
        musicPlayerStore.stop();
        await flush();
        const reports = reportMusicPlayback.mock.calls
            .filter(([id]) => id === track.id)
            .map(([, body]) => body);
        expect(reports.map((body) => body.eventSeq)).toEqual([1, 2, 3, 4]);
        expect(reports.map((body) => body.status)).toEqual([
            'ACTIVE',
            'PAUSED',
            'PAUSED',
            'COMPLETED',
        ]);
        expect(reports.at(-1)).toMatchObject({
            endReason: 'user',
            listenedTotalMs: 0,
            sessionElapsedMs: 0,
            positionMs: 90_000,
        });
    });

    it('counts advancing audio capped by wall time, excluding paused time and seek distance', async () => {
        const track = makeTrack();
        updateForTest((s) => ({ ...s, currentTrack: track, isPlaying: true, currentTimeMs: 0 }));
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
        await musicPlayerStore._startMusicSessionForTest!(track);
        clock.mockReturnValue(2_000);
        tick(1_000);
        clock.mockReturnValue(5_000);
        tick(1_000); // buffering: wall time advances, audio does not
        musicPlayerStore.pause();
        clock.mockReturnValue(50_000);
        musicPlayerStore.seekTo(90_000);
        musicPlayerStore.resume();
        clock.mockReturnValue(51_000);
        tick(91_000);
        musicPlayerStore.stop();
        await flush();
        expect(terminalReports().find(([id]) => id === track.id)?.[1]).toMatchObject({
            listenedTotalMs: 2_000,
            sessionElapsedMs: 2_000,
            positionMs: 91_000,
        });
        clock.mockRestore();
    });

    it('reports a skip exactly once even when skip also stops an empty queue', async () => {
        const track = makeTrack();
        updateForTest((s) => ({ ...s, currentTrack: track, queue: [], isPlaying: true }));
        await musicPlayerStore._startMusicSessionForTest!(track);
        await musicPlayerStore.skip();
        await flush();
        const reports = terminalReports().filter(([id]) => id === track.id);
        expect(reports).toHaveLength(1);
        expect(reports[0][1].endReason).toBe('skip');
    });

    it('replays a failed terminal report with the same session id for deduplication', async () => {
        const track = makeTrack();
        updateForTest((s) => ({ ...s, currentTrack: track, isPlaying: true }));
        await musicPlayerStore._startMusicSessionForTest!(track);
        await flush();
        reportMusicPlayback.mockResolvedValueOnce({
            data: null,
            error: 'lost response',
            status: 500,
        });
        musicPlayerStore.stop();
        await flush();
        const items = vi.mocked(musicApi.replayMusicPlays).mock.calls.flatMap(([batch]) => batch);
        expect(items).toContainEqual(
            expect.objectContaining({
                eventId: track.id,
                mediaId: track.id,
                kind: 'music',
                endReason: 'user',
                startReported: false,
            }),
        );
    });

    it('offline plays use generated replay ids and default to no reported start', async () => {
        vi.mocked(musicApi.startMusicPlaySession).mockResolvedValueOnce({
            data: null,
            error: 'offline',
            status: 0,
        });
        const track = makeTrack();
        updateForTest((s) => ({ ...s, currentTrack: track, isPlaying: true }));
        await musicPlayerStore._startMusicSessionForTest!(track);
        musicPlayerStore.stop();
        await flush();
        const item = vi
            .mocked(musicApi.replayMusicPlays)
            .mock.calls.flatMap(([batch]) => batch)
            .find((entry) => entry.mediaId === track.id);
        expect(item).toMatchObject({ kind: 'music', startReported: false });
        expect(item?.eventId).toMatch(/^[0-9a-f-]{36}$/);
        expect(item?.eventId).not.toBe(track.id);
    });
});

it('retries unfamiliar replay reasons using retryable and drops terminal outcomes', async () => {
    const track = makeTrack();
    let retryable = true;
    vi.mocked(musicApi.replayMusicPlays).mockImplementation(async (items) => ({
        data: {
            results: items.map((item, index) => ({
                index,
                eventId: item.eventId,
                status: 'rejected' as const,
                reason: 'a-future-server-reason',
                retryable: item.mediaId === track.id && retryable,
                details: [],
            })),
            summary: { recorded: 0, duplicate: 0, rejected: items.length },
        },
        error: null,
        status: 200,
    }));
    vi.mocked(musicApi.startMusicPlaySession).mockResolvedValueOnce({
        data: null,
        error: 'offline',
        status: 0,
    });
    updateForTest((s) => ({ ...s, currentTrack: track, isPlaying: true }));
    await musicPlayerStore._startMusicSessionForTest!(track);
    musicPlayerStore.stop();
    await flush();
    const queuedIds = (): string[] =>
        vi
            .mocked(musicApi.replayMusicPlays)
            .mock.calls.flatMap(([items]) => items)
            .filter((item) => item.mediaId === track.id)
            .map((item) => item.eventId);
    const firstId = queuedIds()[0];
    expect(firstId).toBeDefined();
    retryable = false;
    window.dispatchEvent(new Event('online'));
    await flush();
    expect(queuedIds()).toEqual([firstId, firstId]);
    window.dispatchEvent(new Event('online'));
    await flush();
    expect(queuedIds()).toEqual([firstId, firstId]);
});

it('finalizes a late start with its returned session id without replacing the newer session', async () => {
    let accept!: (value: Awaited<ReturnType<typeof musicApi.startMusicPlaySession>>) => void;
    vi.mocked(musicApi.startMusicPlaySession).mockReturnValueOnce(
        new Promise((resolve) => {
            accept = resolve;
        }),
    );
    const first = makeTrack();
    const next = makeTrack();
    updateForTest((s) => ({ ...s, currentTrack: first, isPlaying: true }));
    const pending = musicPlayerStore._startMusicSessionForTest!(first);
    await Promise.resolve();
    updateForTest((s) => ({ ...s, currentTrack: next }));
    const nextStart = musicPlayerStore._startMusicSessionForTest!(next);
    await Promise.resolve();
    accept({
        data: playbackStartFixture('track-1', 'late-session'),
        error: null,
        status: 200,
    });
    await pending;
    await nextStart;
    await flush();
    expect(get(musicPlayerStore).playEventId).toBe(next.id);
    expect(terminalReports().filter(([id]) => id === 'late-session')).toHaveLength(1);
    expect(
        reportMusicPlayback.mock.calls.filter(
            ([id, body]) => id === 'late-session' && body.status === 'ACTIVE',
        ),
    ).toHaveLength(0);
});

it('natural completion has one terminal report even when the player is later stopped', async () => {
    const track = makeTrack();
    updateForTest((s) => ({ ...s, currentTrack: track, queue: [], isPlaying: true }));
    await musicPlayerStore._startMusicSessionForTest!(track);
    mockBackend.capturedCallbacks!.onTrackEnded();
    musicPlayerStore.stop();
    await flush();
    const ended = terminalReports().filter(([id]) => id === track.id);
    expect(ended).toHaveLength(1);
    expect(ended[0][1]).toMatchObject({ status: 'COMPLETED', endReason: 'completion' });
});

it('dislike writes explicit feedback and advances without inferring a skip', async () => {
    const track = makeTrack();
    updateForTest((s) => ({ ...s, currentTrack: track, queue: [], isPlaying: true }));
    await musicPlayerStore._startMusicSessionForTest!(track);
    await musicPlayerStore.dislikeCurrentTrack();
    await flush();
    expect(musicApi.setTrackFeedback).toHaveBeenCalledWith(track.id, 'disliked');
    const ended = terminalReports().filter(([id]) => id === track.id);
    expect(ended).toHaveLength(1);
    expect(ended[0][1].endReason).toBe('user');
});

it('unload beacons and replays share a terminal id and do not report twice for pagehide plus beforeunload', async () => {
    const track = makeTrack();
    updateForTest((s) => ({ ...s, currentTrack: track, isPlaying: true }));
    await musicPlayerStore._startMusicSessionForTest!(track);
    await flush();
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('beforeunload'));
    expect(musicApi.reportMusicPlaybackBeacon).toHaveBeenCalledTimes(1);
    expect(musicApi.reportMusicPlaybackBeacon).toHaveBeenCalledWith(
        track.id,
        expect.objectContaining({
            status: 'COMPLETED',
            endReason: 'unload',
            eventSeq: 2,
            sessionElapsedMs: 0,
            listenedTotalMs: 0,
        }),
    );
    window.dispatchEvent(new Event('online'));
    await flush();
    const replay = vi.mocked(musicApi.replayMusicPlays).mock.calls.flatMap(([items]) => items);
    expect(replay).toContainEqual(
        expect.objectContaining({ eventId: track.id, mediaId: track.id, endReason: 'unload' }),
    );
});

it('loads only this user replay queue, clears the unowned legacy queue, and persists bounded entries', async () => {
    const storage = new Map<string, string>();
    const key = 'music-playback-replays-v1:queue-owner-test';
    const now = Date.now();
    const item = (index: number, ageDays = 0) => ({
        eventId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        kind: 'music',
        mediaId: '11111111-1111-4111-8111-111111111111',
        startedAt: new Date(now - ageDays * 86_400_000).toISOString(),
        positionMs: 1000,
        listenedMs: 1000,
        endReason: 'user',
    });
    storage.set('music-playback-replays-v1', JSON.stringify([item(999)]));
    storage.set('music-playback-replays-v1:other-user', 'other-account-data');
    storage.set(
        key,
        JSON.stringify([item(998, 91), ...Array.from({ length: 501 }, (_, i) => item(i))]),
    );
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, value: string) => storage.set(k, value),
        removeItem: (k: string) => storage.delete(k),
    });
    const previousUserId = replayIdentity.userId;
    replayIdentity.userId = 'queue-owner-test';
    vi.mocked(musicApi.replayMusicPlays).mockResolvedValue({
        data: null,
        error: 'offline',
        status: 0,
    });
    try {
        window.dispatchEvent(new Event('online'));
        await flush();
        expect(storage.has('music-playback-replays-v1')).toBe(false);
        expect(storage.get('music-playback-replays-v1:other-user')).toBe('other-account-data');
        const saved = JSON.parse(storage.get(key)!);
        expect(saved).toHaveLength(500);
        expect(saved[0].eventId).toBe(item(1).eventId);
    } finally {
        replayIdentity.userId = previousUserId;
    }
});
