// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { playbackStartFixture } from '$lib/utils/playback-start.fixture.js';
import { musicTrackFromCard } from '$lib/utils/music-track';

// @vitest-environment happy-dom
/**
 * The music store across tabs, driven through the REAL store and the REAL
 * `PlainAudioBackend`, with a raw BroadcastChannel standing in for the other
 * tab (see music-tab-sync.ts for the protocol).
 *
 * The seam is the store, not the coordinator: every defect here was the store
 * acting on the shared localStorage snapshot as if it were the only tab —
 * resuming a track another tab was already playing, and overwriting that
 * tab's snapshot with its own stale copy.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import type { MusicTrack } from '$lib/schemas/music';
import type { AudioBackend } from '$lib/audio';
import type { PersistedPlaybackState } from './music-playback-persistence';
import { MUSIC_TAB_CHANNEL, type MusicTabClaim, type MusicTabMessage } from './music-tab-sync';

const { backendRef } = vi.hoisted(() => ({
    backendRef: { current: null as AudioBackend | null },
}));

vi.mock('$lib/audio', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/audio')>();
    const { PlainAudioBackend } = await import('$lib/audio/plain-audio-backend');
    return {
        ...actual,
        createAudioBackend: vi.fn(async () => {
            backendRef.current = new PlainAudioBackend();
            return backendRef.current;
        }),
    };
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

vi.mock('$lib/audio/airplay-detector', () => ({
    createAirPlayDetector: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

vi.mock('$lib/components/player/device-id', () => ({
    getDeviceId: vi.fn(() => 'test-device'),
}));

// The storage calls are spied; the cross-tab logout wiring stays real.
vi.mock('./music-playback-persistence', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./music-playback-persistence')>()),
    savePlaybackState: vi.fn(),
    loadPlaybackState: vi.fn(() => null),
    clearPlaybackState: vi.fn(),
}));

vi.mock('$lib/api/user', () => ({
    getPlaybackPreferences: vi.fn(async () => ({ data: null, error: null, status: 200 })),
}));

// Automocked, not a factory — see music-player-playback-failure.test.ts.
vi.mock('$lib/api/music');

import { musicPlayerStore } from './music-player.store';
import * as musicApi from '$lib/api/music';
import * as persistence from './music-playback-persistence';

const EMPTY_OK = { data: null, error: null, status: 200 } as const;

function installMusicApiDefaults(): void {
    for (const value of Object.values(musicApi)) {
        if (vi.isMockFunction(value)) value.mockResolvedValue(EMPTY_OK);
    }
    vi.mocked(musicApi.startMusicPlaySession).mockImplementation(async ({ trackId }) => ({
        data: playbackStartFixture(trackId, `session-${trackId}`),
        error: null,
        status: 201,
    }));
    vi.mocked(musicApi.getRecommendations).mockResolvedValue({
        ...EMPTY_OK,
        data: { alternatives: [], source: 'metadata' },
    });
}

const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const settle = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let trackSeq = 0;
function makeTrack(): MusicTrack {
    trackSeq += 1;
    return musicTrackFromCard({
        id: `tab-track-${trackSeq}`,
        title: `Track ${trackSeq}`,
        artists: [{ id: null, title: 'Tester' }],
        durationMs: 200000,
    });
}

function snapshot(track: MusicTrack, wasPlaying: boolean): PersistedPlaybackState {
    return {
        autoplaySeed: null,
        playbackContext: null,
        currentTrack: track,
        position: 42_000,
        queue: [],
        history: [],
        volume: 0.8,
        wasPlaying,
        savedAt: Date.now(),
    };
}

function audioElement(): HTMLAudioElement {
    const el = backendRef.current?.getAudioElement();
    if (!el) throw new Error('backend not initialised');
    return el;
}

/** Make the preload's `waitForMetadata` proceed, as a real element would. */
function loadMetadata(): void {
    audioElement().dispatchEvent(new Event('loadedmetadata'));
}

/** The "other tab": a bare channel plus a log of what this tab broadcast. */
let otherTab: BroadcastChannel;
let received: MusicTabMessage[];
/** The other tab's claim; always newer than anything this tab made so far. */
let otherClaim: MusicTabClaim;
let lastClaimTs = 0;
/** Strictly newer than every claim so far — this tab's included (they are ts+1). */
function newerClaim(tabId = 'other-tab'): MusicTabClaim {
    lastClaimTs = Math.max(Date.now() + 1_000_000, lastClaimTs + 1_000);
    return { ts: lastClaimTs, tabId };
}
/** When set, the other tab answers 'who-owns' as the owner with this state. */
let otherTabOwnerState: { isPlaying: boolean; trackId: string | null; positionMs: number } | null;

let playSpy: ReturnType<typeof vi.spyOn>;
let pauseSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
    await musicPlayerStore.init();
});

beforeEach(() => {
    vi.clearAllMocks();
    installMusicApiDefaults();
    vi.spyOn(navigator, 'sendBeacon').mockReturnValue(true);
    playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    received = [];
    otherTabOwnerState = null;
    otherTab = new BroadcastChannel(MUSIC_TAB_CHANNEL);
    otherTab.onmessage = (event: MessageEvent<MusicTabMessage>) => {
        received.push(event.data);
        if (event.data.type === 'who-owns' && otherTabOwnerState) {
            otherClaim = newerClaim();
            otherTab.postMessage({
                type: 'owner-state',
                tabId: 'other-tab',
                queryId: event.data.queryId,
                claim: otherClaim,
                ...otherTabOwnerState,
            } satisfies MusicTabMessage);
        }
    };
});

afterEach(async () => {
    otherTab.close();
    // Leave this tab owning the snapshot for the next case.
    musicPlayerStore.stop();
    await musicPlayerStore.play(makeTrack());
    await flush();
    musicPlayerStore.stop();
    playSpy.mockRestore();
    pauseSpy.mockRestore();
});

function announceFromOtherTab(): void {
    otherClaim = newerClaim();
    otherTab.postMessage({
        type: 'playing',
        tabId: 'other-tab',
        claim: otherClaim,
    } satisfies MusicTabMessage);
}

describe('music player across tabs', () => {
    it('starting playback tells the other tabs', async () => {
        await musicPlayerStore.play(makeTrack());
        await settle();
        expect(received.some((m) => m.type === 'playing')).toBe(true);
    });

    it('another tab starting playback pauses this one and says so, without rewriting the snapshot', async () => {
        await musicPlayerStore.play(makeTrack());
        await flush();
        expect(get(musicPlayerStore).isPlaying).toBe(true);
        vi.mocked(persistence.savePlaybackState).mockClear();
        pauseSpy.mockClear();

        announceFromOtherTab();
        await settle();

        expect(get(musicPlayerStore).isPlaying).toBe(false);
        expect(get(musicPlayerStore).playingElsewhere).toBe(true);
        expect(pauseSpy).toHaveBeenCalled();
        // The pause here must not overwrite the playing tab's snapshot.
        expect(persistence.savePlaybackState).not.toHaveBeenCalled();
    });

    it('a paused tab stops writing the shared snapshot once another tab plays', async () => {
        await musicPlayerStore.play(makeTrack());
        await flush();
        musicPlayerStore.pause();
        announceFromOtherTab();
        await settle();
        vi.mocked(persistence.savePlaybackState).mockClear();

        // Any action that persists — here a volume change, and the unload hook.
        musicPlayerStore.setVolume(0.3);
        window.dispatchEvent(new Event('beforeunload'));

        expect(persistence.savePlaybackState).not.toHaveBeenCalled();
    });

    it('closing the player in a non-owning tab does not wipe the snapshot', async () => {
        await musicPlayerStore.play(makeTrack());
        await flush();
        announceFromOtherTab();
        await settle();

        musicPlayerStore.stop(true);

        expect(persistence.clearPlaybackState).not.toHaveBeenCalled();
    });

    it('the hint clears when the other tab stops playing', async () => {
        await musicPlayerStore.play(makeTrack());
        await flush();
        announceFromOtherTab();
        await settle();
        expect(get(musicPlayerStore).playingElsewhere).toBe(true);

        otherTab.postMessage({
            type: 'idle',
            tabId: 'other-tab',
            claim: otherClaim,
        } satisfies MusicTabMessage);
        await settle();

        expect(get(musicPlayerStore).playingElsewhere).toBe(false);
    });

    it("resuming here continues from the other tab's live position and takes the snapshot back", async () => {
        const track = makeTrack();
        await musicPlayerStore.play(track);
        await flush();
        announceFromOtherTab();
        await settle();
        expect(get(musicPlayerStore).currentTimeMs).toBeLessThan(1000);
        otherTabOwnerState = { isPlaying: true, trackId: track.id, positionMs: 95_000 };
        received = [];

        musicPlayerStore.resume();
        await settle(60);

        const state = get(musicPlayerStore);
        expect(state.isPlaying).toBe(true);
        expect(state.playingElsewhere).toBe(false);
        expect(state.currentTimeMs).toBe(95_000);
        expect(received.some((m) => m.type === 'playing')).toBe(true);

        vi.mocked(persistence.savePlaybackState).mockClear();
        musicPlayerStore.setVolume(0.5);
        expect(persistence.savePlaybackState).toHaveBeenCalled();
    });

    it('resuming after the other tab closed continues from the shared snapshot', async () => {
        const track = makeTrack();
        await musicPlayerStore.play(track);
        await flush();
        announceFromOtherTab();
        await settle();
        vi.mocked(persistence.loadPlaybackState).mockReturnValueOnce({
            ...snapshot(track, true),
            position: 70_000,
        });

        musicPlayerStore.resume();
        await settle(300); // no owner answers: the query times out

        expect(get(musicPlayerStore).isPlaying).toBe(true);
        expect(get(musicPlayerStore).currentTimeMs).toBe(70_000);
    });

    it('a new tab does NOT resume a snapshot another tab is still playing', async () => {
        musicPlayerStore.stop();
        const track = makeTrack();
        otherTabOwnerState = { isPlaying: true, trackId: track.id, positionMs: 123_000 };
        vi.mocked(persistence.loadPlaybackState).mockReturnValueOnce(snapshot(track, true));
        playSpy.mockClear();

        const hydrated = musicPlayerStore.hydrateFromPersistence();
        await settle(50);
        loadMetadata();
        await hydrated;
        await flush();

        const state = get(musicPlayerStore);
        expect(state.currentTrack?.id).toBe(track.id);
        expect(state.isPlaying).toBe(false);
        expect(state.playingElsewhere).toBe(true);
        // Lined up with the live music, not the snapshot's older 42s.
        expect(state.currentTimeMs).toBe(123_000);
        expect(playSpy).not.toHaveBeenCalled();
        expect(received.some((m) => m.type === 'playing')).toBe(false);
    });

    it('control: with no other tab playing, a "was playing" snapshot resumes and announces', async () => {
        musicPlayerStore.stop();
        const track = makeTrack();
        vi.mocked(persistence.loadPlaybackState).mockReturnValueOnce(snapshot(track, true));
        playSpy.mockClear();

        const hydrated = musicPlayerStore.hydrateFromPersistence();
        // The query waits out its timeout before the preload starts.
        await settle(300);
        loadMetadata();
        await hydrated;
        await flush();

        expect(get(musicPlayerStore).isPlaying).toBe(true);
        expect(playSpy).toHaveBeenCalled();
        expect(received.some((m) => m.type === 'playing')).toBe(true);
    });

    it('pausing while the restore is still loading keeps the audio paused', async () => {
        musicPlayerStore.stop();
        const track = makeTrack();
        vi.mocked(persistence.loadPlaybackState).mockReturnValueOnce(snapshot(track, true));

        const hydrated = musicPlayerStore.hydrateFromPersistence();
        await settle(300);
        // The UI already shows "playing"; the user taps pause before the
        // source has loaded. The preload then resumes the element anyway.
        expect(get(musicPlayerStore).isPlaying).toBe(true);
        musicPlayerStore.pause();
        pauseSpy.mockClear();
        loadMetadata();
        await hydrated;
        await flush();

        expect(get(musicPlayerStore).isPlaying).toBe(false);
        expect(pauseSpy).toHaveBeenCalled();
    });

    it('an older claim arriving late does not stop this tab', async () => {
        await musicPlayerStore.play(makeTrack());
        await flush();
        otherTab.postMessage({
            type: 'playing',
            tabId: 'other-tab',
            claim: { ts: 1, tabId: 'other-tab' },
        } satisfies MusicTabMessage);
        await settle();

        expect(get(musicPlayerStore).isPlaying).toBe(true);
        expect(get(musicPlayerStore).playingElsewhere).toBe(false);
    });

    it('a claim arriving while a track is still loading stops it once loaded', async () => {
        let finishLoad: () => void = () => {};
        playSpy.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    finishLoad = resolve;
                }),
        );
        const loading = musicPlayerStore.play(makeTrack());
        await settle();
        loadMetadata();
        await vi.waitFor(() => expect(playSpy).toHaveBeenCalled());
        // Loading: not playing yet, so the claim cannot pause anything now.
        expect(get(musicPlayerStore).isPlaying).toBe(false);
        announceFromOtherTab();
        await settle();
        finishLoad();
        playSpy.mockResolvedValue(undefined);
        await loading;
        await flush();

        expect(get(musicPlayerStore).isPlaying).toBe(false);
        expect(get(musicPlayerStore).playingElsewhere).toBe(true);
    });

    it('a pause during the owner query cancels the resume', async () => {
        await musicPlayerStore.play(makeTrack());
        await flush();
        announceFromOtherTab();
        await settle();
        // The other tab is gone: the query will time out.
        playSpy.mockClear();

        musicPlayerStore.resume();
        musicPlayerStore.pause();
        await settle(300);

        expect(get(musicPlayerStore).isPlaying).toBe(false);
        expect(playSpy).not.toHaveBeenCalled();
    });

    it('a restore blocked by autoplay retracts its claim', async () => {
        musicPlayerStore.stop();
        vi.mocked(persistence.loadPlaybackState).mockReturnValueOnce(snapshot(makeTrack(), true));
        playSpy.mockRejectedValue(new DOMException('blocked', 'NotAllowedError'));

        const hydrated = musicPlayerStore.hydrateFromPersistence();
        await settle(300);
        loadMetadata();
        await hydrated;
        await flush();

        expect(get(musicPlayerStore).isPlaying).toBe(false);
        const types = received.map((m) => m.type);
        expect(types).toContain('playing');
        expect(types.lastIndexOf('idle')).toBeGreaterThan(types.lastIndexOf('playing'));
    });

    it('logging out in another tab stops playback here and suppresses the snapshot', async () => {
        await musicPlayerStore.play(makeTrack());
        await flush();
        const logoutTab = new BroadcastChannel('lumastra:music-session-ended');
        logoutTab.postMessage('ended');
        await settle();
        logoutTab.close();

        expect(get(musicPlayerStore).isPlaying).toBe(false);
        expect(get(musicPlayerStore).currentTrack).toBeNull();
        const real = await vi.importActual<typeof import('./music-playback-persistence')>(
            './music-playback-persistence',
        );
        // The real module instance the store's listener suppressed.
        const used = await import('./music-playback-persistence');
        expect(used.isPlaybackPersistenceSuppressed()).toBe(true);
        used.resumePlaybackPersistence();
        void real;
    });

    it('resuming after another tab played opens a fresh session instead of reviving the closed one', async () => {
        // Same browser = same device id: the other tab's session start closed ours.
        vi.mocked(musicApi.startMusicPlaySession).mockResolvedValue({
            ...EMPTY_OK,
            data: playbackStartFixture('track-1', 'session-before'),
        } as Awaited<ReturnType<typeof musicApi.startMusicPlaySession>>);
        await musicPlayerStore.play(makeTrack());
        await flush();
        announceFromOtherTab();
        await settle();
        vi.mocked(musicApi.startMusicPlaySession).mockClear();
        vi.mocked(musicApi.reportMusicPlayback).mockClear();

        vi.mocked(musicApi.startMusicPlaySession).mockResolvedValue({
            ...EMPTY_OK,
            data: playbackStartFixture('track-1', 'session-after'),
        });
        musicPlayerStore.resume();
        await settle(300); // owner query times out: the other tab is gone
        await flush();

        expect(get(musicPlayerStore).isPlaying).toBe(true);
        expect(musicApi.startMusicPlaySession).toHaveBeenCalledTimes(1);
        const activeBeats = vi
            .mocked(musicApi.reportMusicPlayback)
            .mock.calls.filter(([id, body]) => id === 'session-before' && body.status === 'ACTIVE');
        expect(activeBeats).toHaveLength(0);
    });

    it('control: pause and resume within one tab keeps its session', async () => {
        vi.mocked(musicApi.startMusicPlaySession).mockResolvedValue({
            ...EMPTY_OK,
            data: playbackStartFixture('track-1', 'session-kept'),
        } as Awaited<ReturnType<typeof musicApi.startMusicPlaySession>>);
        await musicPlayerStore.play(makeTrack());
        await flush();
        musicPlayerStore.pause();
        vi.mocked(musicApi.startMusicPlaySession).mockClear();
        vi.mocked(musicApi.reportMusicPlayback).mockClear();

        musicPlayerStore.resume();
        await flush();

        expect(musicApi.startMusicPlaySession).not.toHaveBeenCalled();
        expect(musicApi.reportMusicPlayback).toHaveBeenCalledWith(
            'session-kept',
            expect.objectContaining({ status: 'ACTIVE' }),
        );
    });

    it('the 404 for a session another tab superseded does not stop this tab', async () => {
        vi.mocked(musicApi.startMusicPlaySession).mockResolvedValue({
            ...EMPTY_OK,
            data: playbackStartFixture('track-1', 'session-superseded'),
        } as Awaited<ReturnType<typeof musicApi.startMusicPlaySession>>);
        // The other tab's session start closed ours ('track_change'): every
        // heartbeat for it now 404s.
        const track = makeTrack();
        await musicPlayerStore.play(track);
        await flush();

        vi.mocked(musicApi.reportMusicPlayback).mockResolvedValue({
            data: null,
            error: 'not found',
            status: 404,
        } as Awaited<ReturnType<typeof musicApi.reportMusicPlayback>>);

        announceFromOtherTab(); // pauses here → PAUSED heartbeat → 404
        await settle();
        await flush();

        const state = get(musicPlayerStore);
        expect(state.currentTrack?.id).toBe(track.id);
        expect(state.playingElsewhere).toBe(true);
    });

    it('a late smart-queue fetch does not start the next track in a paused player', async () => {
        let answer: (
            value: Awaited<ReturnType<typeof musicApi.getRecommendations>>,
        ) => void = () => {};
        vi.mocked(musicApi.getRecommendations).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    answer = resolve;
                }),
        );
        const track = makeTrack();
        await musicPlayerStore.play(track);
        await flush();
        musicPlayerStore.pause();

        // Suggestions arrive after the pause.
        answer({
            ...EMPTY_OK,
            data: { alternatives: [makeTrack()], source: 'metadata' },
        } as Awaited<ReturnType<typeof musicApi.getRecommendations>>);
        await flush();

        const state = get(musicPlayerStore);
        expect(state.currentTrack?.id).toBe(track.id);
        expect(state.isPlaying).toBe(false);
    });

    it('a restored-paused tab is not started by its suggestions fetch', async () => {
        musicPlayerStore.stop();
        const track = makeTrack();
        vi.mocked(persistence.loadPlaybackState).mockReturnValueOnce({
            ...snapshot(track, false),
            queue: [{ track: makeTrack(), source: 'user', id: 'queued-1' }],
        });
        vi.mocked(musicApi.getRecommendations).mockResolvedValueOnce({
            ...EMPTY_OK,
            data: { alternatives: [makeTrack()], source: 'metadata' },
        } as Awaited<ReturnType<typeof musicApi.getRecommendations>>);
        playSpy.mockClear();

        const hydrated = musicPlayerStore.hydrateFromPersistence();
        await settle();
        loadMetadata();
        await hydrated;
        await settle(50);

        const state = get(musicPlayerStore);
        expect(state.currentTrack?.id).toBe(track.id);
        expect(state.isPlaying).toBe(false);
        expect(playSpy).not.toHaveBeenCalled();
    });

    it('control: a track that ends while suggestions load continues with them', async () => {
        let answer: (
            value: Awaited<ReturnType<typeof musicApi.getRecommendations>>,
        ) => void = () => {};
        vi.mocked(musicApi.getRecommendations).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    answer = resolve;
                }),
        );
        await musicPlayerStore.play(makeTrack());
        await flush();
        expect(get(musicPlayerStore).smartQueueLoading).toBe(true);

        audioElement().dispatchEvent(new Event('ended'));
        await flush();
        const next = makeTrack();
        answer({
            ...EMPTY_OK,
            data: { next: next, alternatives: [], source: 'metadata' },
        } as Awaited<ReturnType<typeof musicApi.getRecommendations>>);
        await flush();

        expect(get(musicPlayerStore).currentTrack?.id).toBe(next.id);
        expect(get(musicPlayerStore).isPlaying).toBe(true);
    });

    describe('mirroring the playing tab', () => {
        function sendOwnerState(overrides: Record<string, unknown>): void {
            otherTab.postMessage({
                type: 'state',
                tabId: 'other-tab',
                claim: otherClaim,
                state: {
                    track: null,
                    queue: [],
                    history: [],
                    playbackContext: null,
                    autoplaySeed: null,
                    positionMs: 0,
                    durationMs: 200_000,
                    isPlaying: true,
                    sentAt: Date.now(),
                    ...overrides,
                },
            });
        }

        it('this tab broadcasts its live state when its track changes', async () => {
            await musicPlayerStore.play(makeTrack());
            await flush();
            received = [];
            const next = makeTrack();
            await musicPlayerStore.play(next);
            await settle(250); // change-driven broadcasts are throttled (≤150ms)

            const states = received.filter((m) => m.type === 'state') as Array<
                Extract<MusicTabMessage, { type: 'state' }>
            >;
            const last = states.at(-1)?.state as { track: MusicTrack | null } | undefined;
            expect(last?.track?.id).toBe(next.id);
        });

        it('a paused tab shows the track the other tab switched to, and its moving position', async () => {
            await musicPlayerStore.play(makeTrack());
            await flush();
            announceFromOtherTab();
            await settle();

            const theirs = makeTrack();
            sendOwnerState({ track: theirs, positionMs: 30_000, sentAt: Date.now() });
            await settle();
            expect(get(musicPlayerStore).currentTrack?.id).toBe(theirs.id);
            const first = get(musicPlayerStore).currentTimeMs;
            expect(first).toBeGreaterThanOrEqual(30_000);
            expect(get(musicPlayerStore).isPlaying).toBe(false);

            await settle(1_100); // the mirror ticker advances between states
            expect(get(musicPlayerStore).currentTimeMs).toBeGreaterThanOrEqual(first + 900);
        });

        it('resuming after the other tab changed tracks loads that track at its live position', async () => {
            await musicPlayerStore.play(makeTrack());
            await flush();
            announceFromOtherTab();
            await settle();
            const theirs = makeTrack();
            sendOwnerState({ track: theirs, positionMs: 50_000, sentAt: Date.now() });
            await settle();
            otherTabOwnerState = { isPlaying: true, trackId: theirs.id, positionMs: 52_000 };
            const preload = vi.spyOn(backendRef.current!, 'preload');
            vi.mocked(musicApi.startMusicPlaySession).mockClear();

            musicPlayerStore.resume();
            await settle(60);
            loadMetadata();
            await settle();
            await flush();

            expect(preload).toHaveBeenCalled();
            const [src, , positionMs, , autoResume] = preload.mock.calls.at(-1)!;
            expect(String(src)).toContain(theirs.id);
            expect(positionMs).toBe(52_000);
            expect(autoResume).toBe(true);
            expect(get(musicPlayerStore).isPlaying).toBe(true);
            expect(get(musicPlayerStore).currentTrack?.id).toBe(theirs.id);
            // Taking over the deck opens its own shared playback session.
            expect(musicApi.startMusicPlaySession).toHaveBeenCalledTimes(1);
            preload.mockRestore();
        });
    });

    describe('seeking in a tab that mirrors another', () => {
        function mirrorOther(track: MusicTrack, positionMs: number): void {
            otherTab.postMessage({
                type: 'state',
                tabId: 'other-tab',
                claim: otherClaim,
                state: {
                    track,
                    queue: [],
                    history: [],
                    playbackContext: null,
                    autoplaySeed: null,
                    positionMs,
                    durationMs: 200_000,
                    isPlaying: true,
                    sentAt: Date.now(),
                },
            });
        }

        it('steers the playing tab, and the bar stays where it was dropped', async () => {
            await musicPlayerStore.play(makeTrack());
            await flush();
            announceFromOtherTab();
            await settle();
            const theirs = makeTrack();
            mirrorOther(theirs, 10_000);
            await settle();
            received = [];
            const localSeek = vi.spyOn(backendRef.current!, 'seekTo');

            musicPlayerStore.seekTo(120_000);
            await settle(700); // past a mirror tick

            const commands = received.filter((m) => m.type === 'command');
            expect(commands).toHaveLength(1);
            expect((commands[0] as Extract<MusicTabMessage, { type: 'command' }>).command).toEqual({
                type: 'seek',
                trackId: theirs.id,
                positionMs: 120_000,
            });
            // Not a local seek of a deck nobody hears, and no snap back.
            expect(localSeek).not.toHaveBeenCalled();
            expect(get(musicPlayerStore).currentTimeMs).toBeGreaterThanOrEqual(120_000);
            expect(get(musicPlayerStore).isPlaying).toBe(false);
            localSeek.mockRestore();
        });

        it('the playing tab applies a seek command for its current track', async () => {
            const mine = makeTrack();
            await musicPlayerStore.play(mine);
            await flush();
            const seekSpy = vi.spyOn(backendRef.current!, 'seekTo');
            // Learn our claim from what we broadcast, then address it.
            const claim = (
                received.filter((m) => m.type === 'playing').at(-1) as Extract<
                    MusicTabMessage,
                    { type: 'playing' }
                >
            ).claim;

            otherTab.postMessage({
                type: 'command',
                tabId: 'other-tab',
                claim,
                command: { type: 'seek', trackId: 'some-other-track', positionMs: 5_000 },
            } satisfies MusicTabMessage);
            await settle();
            expect(seekSpy).not.toHaveBeenCalled();

            otherTab.postMessage({
                type: 'command',
                tabId: 'other-tab',
                claim,
                command: { type: 'seek', trackId: mine.id, positionMs: 45_000 },
            } satisfies MusicTabMessage);
            await settle();
            expect(seekSpy).toHaveBeenCalledWith(45_000);
            expect(get(musicPlayerStore).currentTimeMs).toBe(45_000);
            seekSpy.mockRestore();
        });

        it('control: seeking in a tab that plays itself seeks locally', async () => {
            await musicPlayerStore.play(makeTrack());
            await flush();
            received = [];
            const seekSpy = vi.spyOn(backendRef.current!, 'seekTo');
            musicPlayerStore.seekTo(30_000);
            await settle();
            expect(seekSpy).toHaveBeenCalledWith(30_000);
            expect(received.filter((m) => m.type === 'command')).toHaveLength(0);
            seekSpy.mockRestore();
        });
    });

    describe('pause and volume in a tab that mirrors another', () => {
        async function mirrorPlayingOther(volume = 0.8): Promise<MusicTrack> {
            await musicPlayerStore.play(makeTrack());
            await flush();
            announceFromOtherTab();
            await settle();
            const theirs = makeTrack();
            otherTab.postMessage({
                type: 'state',
                tabId: 'other-tab',
                claim: otherClaim,
                state: {
                    track: theirs,
                    queue: [],
                    history: [],
                    playbackContext: null,
                    autoplaySeed: null,
                    positionMs: 10_000,
                    durationMs: 200_000,
                    isPlaying: true,
                    volume,
                    isMuted: false,
                    sentAt: Date.now(),
                },
            });
            await settle();
            received = [];
            return theirs;
        }
        const commandsSent = (): unknown[] =>
            received
                .filter((m) => m.type === 'command')
                .map((m) => (m as Extract<MusicTabMessage, { type: 'command' }>).command);

        it('Pause pauses the music where it plays, not here', async () => {
            await mirrorPlayingOther();
            expect(get(musicPlayerStore).playingElsewhere).toBe(true);

            musicPlayerStore.pause();
            await settle();

            expect(commandsSent()).toEqual([{ type: 'pause' }]);
            expect(get(musicPlayerStore).playingElsewhere).toBe(false);
            expect(get(musicPlayerStore).isPlaying).toBe(false);
        });

        it("shows the playing tab's volume and sets it from here", async () => {
            await mirrorPlayingOther(0.4);
            expect(get(musicPlayerStore).volume).toBe(0.4);
            const localVolume = vi.spyOn(backendRef.current!, 'setVolume');

            musicPlayerStore.setVolume(0.2);
            musicPlayerStore.toggleMute();
            await settle(200); // volume commands trail by 100ms (slider drags)

            expect(commandsSent()).toEqual(
                expect.arrayContaining([
                    { type: 'volume', volume: 0.2 },
                    { type: 'mute', muted: true },
                ]),
            );
            expect(commandsSent()).toHaveLength(2);
            expect(localVolume).not.toHaveBeenCalled();
            expect(get(musicPlayerStore).volume).toBe(0.2);
            expect(get(musicPlayerStore).isMuted).toBe(true);
            localVolume.mockRestore();
        });

        it("taking over carries the mirrored volume onto this tab's player", async () => {
            await mirrorPlayingOther(0.3);
            // The other tab moved to another track, so taking over loads it —
            // at the mirrored volume, not this tab's old one.
            const preload = vi.spyOn(backendRef.current!, 'preload');

            musicPlayerStore.resume();
            await settle(300); // owner query times out
            loadMetadata();
            await settle();
            await flush();

            expect(get(musicPlayerStore).isPlaying).toBe(true);
            expect(get(musicPlayerStore).volume).toBe(0.3);
            expect(preload.mock.calls.at(-1)![3]).toBeCloseTo(0.3, 2);
            preload.mockRestore();
        });

        it('the playing tab applies pause, volume and mute commands', async () => {
            await musicPlayerStore.play(makeTrack());
            await flush();
            const claim = (
                received.filter((m) => m.type === 'playing').at(-1) as Extract<
                    MusicTabMessage,
                    { type: 'playing' }
                >
            ).claim;
            const send = (command: Extract<MusicTabMessage, { type: 'command' }>['command']) =>
                otherTab.postMessage({
                    type: 'command',
                    tabId: 'other-tab',
                    claim,
                    command,
                } satisfies MusicTabMessage);

            send({ type: 'volume', volume: 0.35 });
            send({ type: 'mute', muted: true });
            await settle();
            expect(get(musicPlayerStore).volume).toBe(0.35);
            expect(get(musicPlayerStore).isMuted).toBe(true);

            send({ type: 'pause' });
            await settle();
            expect(get(musicPlayerStore).isPlaying).toBe(false);
            musicPlayerStore.toggleMute(); // restore for later cases
        });

        it('control: in a tab that plays itself, pause and volume stay local', async () => {
            await musicPlayerStore.play(makeTrack());
            await flush();
            received = [];
            musicPlayerStore.setVolume(0.6);
            musicPlayerStore.pause();
            await settle();
            expect(commandsSent()).toEqual([]);
            expect(get(musicPlayerStore).isPlaying).toBe(false);
            expect(get(musicPlayerStore).volume).toBe(0.6);
        });
    });

    describe('review follow-ups: a mirroring tab', () => {
        async function mirror(overrides: Record<string, unknown> = {}): Promise<MusicTrack> {
            await musicPlayerStore.play(makeTrack());
            await flush();
            announceFromOtherTab();
            await settle();
            const theirs = makeTrack();
            sendState({ track: theirs, ...overrides });
            await settle();
            received = [];
            return theirs;
        }
        function sendState(overrides: Record<string, unknown>): void {
            otherTab.postMessage({
                type: 'state',
                tabId: 'other-tab',
                claim: otherClaim,
                state: {
                    track: null,
                    queue: [],
                    history: [],
                    playbackContext: null,
                    autoplaySeed: null,
                    positionMs: 10_000,
                    durationMs: 200_000,
                    isPlaying: true,
                    volume: 0.8,
                    isMuted: false,
                    sentAt: Date.now(),
                    ...overrides,
                },
            });
        }
        const commands = (): Array<Record<string, unknown>> =>
            received
                .filter((m) => m.type === 'command')
                .map(
                    (m) =>
                        (m as Extract<MusicTabMessage, { type: 'command' }>).command as Record<
                            string,
                            unknown
                        >,
                );

        it('closing the player reports no play-end for the track it only mirrored', async () => {
            const theirs = await mirror();
            vi.mocked(musicApi.reportMusicPlayback).mockClear();
            musicPlayerStore.stop(true);
            await flush();
            // The session this tab opened for its OWN track may be closed; nothing may
            // report the track it only mirrored.
            const reportedIds = vi
                .mocked(musicApi.reportMusicPlayback)
                .mock.calls.map(([id]) => id);
            expect(reportedIds).not.toContain(`session-${theirs.id}`);
        });

        it('a queue edit is sent to the playing tab, and its next state does not undo it', async () => {
            const theirs = await mirror();
            const added = makeTrack();
            musicPlayerStore.addToQueue(added);
            await settle();

            const sent = commands().find((c) => c.type === 'queue-op') as
                { op: string; track: { id: string } } | undefined;
            expect(sent?.op).toBe('add');
            expect(sent?.track.id).toBe(added.id);
            // A position tick carries no queue: the local edit survives.
            sendState({ track: theirs, queue: undefined, history: undefined });
            await settle();
            expect(get(musicPlayerStore).queue.map((q) => q.id)).toContain(added.id);
        });

        it('the playing tab applies queue edits onto ITS queue, keeping what it added meanwhile', async () => {
            await musicPlayerStore.play(makeTrack());
            await flush();
            const claim = (
                received.filter((m) => m.type === 'playing').at(-1) as Extract<
                    MusicTabMessage,
                    { type: 'playing' }
                >
            ).claim;
            const send = (command: Extract<MusicTabMessage, { type: 'command' }>['command']) =>
                otherTab.postMessage({
                    type: 'command',
                    tabId: 'other-tab',
                    claim,
                    command,
                } satisfies MusicTabMessage);
            const [a, b, own] = [makeTrack(), makeTrack(), makeTrack()];
            send({ type: 'queue-op', op: 'add', track: a });
            send({ type: 'queue-op', op: 'add', track: b });
            await settle();
            // The owner appends something the mirror has not seen yet…
            musicPlayerStore.addToQueue(own);
            // …while the mirror, from its older view, reorders b before a.
            send({ type: 'queue-op', op: 'order', ids: [b.id, a.id] });
            await settle();
            expect(get(musicPlayerStore).queue.map((i) => i.id)).toEqual([b.id, a.id, own.id]);

            send({ type: 'queue-op', op: 'remove', id: a.id });
            send({ type: 'queue-op', op: 'add', track: { nope: true } });
            await settle();
            expect(get(musicPlayerStore).queue.map((i) => i.id)).toEqual([b.id, own.id]);
        });

        it('a state arriving during a take-over neither re-shows "elsewhere" nor steals a Pause', async () => {
            const theirs = await mirror();
            // Owner gone silent for the query (it times out), but a state lands meanwhile.
            musicPlayerStore.resume();
            await settle(20);
            sendState({ track: theirs, isPlaying: true, sentAt: Date.now() });
            await settle(20);
            expect(get(musicPlayerStore).playingElsewhere).toBe(false);

            musicPlayerStore.pause();
            await settle(300);
            expect(commands().filter((c) => c.type === 'pause')).toHaveLength(0);
            expect(get(musicPlayerStore).isPlaying).toBe(false);
        });

        it('after the owner closes, a seek here is local and Play continues from it', async () => {
            const theirs = await mirror();
            otherTab.postMessage({
                type: 'closed',
                tabId: 'other-tab',
                claim: otherClaim,
            } satisfies MusicTabMessage);
            await settle();
            const preload = vi.spyOn(backendRef.current!, 'preload');

            musicPlayerStore.seekTo(77_000);
            await settle(); // let any (wrongly) sent command arrive
            expect(commands()).toHaveLength(0);
            musicPlayerStore.resume();
            await settle(300);
            loadMetadata();
            await settle();
            await flush();

            // The shown track (the owner's) is loaded at the position set here.
            const call = preload.mock.calls.at(-1)!;
            expect(String(call[0])).toContain(theirs.id);
            expect(call[2]).toBe(77_000);
            preload.mockRestore();
        });

        it('a volume drag sends a few commands, ending on the final value', async () => {
            await mirror();
            for (let i = 1; i <= 20; i++) musicPlayerStore.setVolume(i / 40);
            await settle(250);
            const vols = commands().filter((c) => c.type === 'volume');
            expect(vols.length).toBeGreaterThanOrEqual(1);
            expect(vols.length).toBeLessThanOrEqual(3);
            expect(vols.at(-1)?.volume).toBe(0.5);
        });

        it('a state sent before a local seek does not snap the bar back', async () => {
            const theirs = await mirror();
            const before = Date.now() - 50;
            musicPlayerStore.seekTo(150_000);
            sendState({ track: theirs, positionMs: 10_000, sentAt: before });
            await settle();
            expect(get(musicPlayerStore).currentTimeMs).toBeGreaterThanOrEqual(150_000);
        });

        it('an audiobook starting elsewhere during a take-over stops it', async () => {
            await mirror();
            musicPlayerStore.resume();
            await settle(20);
            const bookTab = new BroadcastChannel('lumastra:audio-claim');
            bookTab.postMessage({ owner: 'audiobook', tabId: 'book-tab' });
            await settle(300);
            bookTab.close();
            loadMetadata();
            await settle();
            expect(get(musicPlayerStore).isPlaying).toBe(false);
        });

        it('ignores malformed commands', async () => {
            const mine = makeTrack();
            await musicPlayerStore.play(mine);
            await flush();
            const claim = (
                received.filter((m) => m.type === 'playing').at(-1) as Extract<
                    MusicTabMessage,
                    { type: 'playing' }
                >
            ).claim;
            const volumeBefore = get(musicPlayerStore).volume;
            otherTab.postMessage({
                type: 'command',
                tabId: 'other-tab',
                claim,
                command: { type: 'volume', volume: Number.NaN },
            } satisfies MusicTabMessage);
            otherTab.postMessage({
                type: 'command',
                tabId: 'other-tab',
                claim,
                command: { type: 'seek', trackId: mine.id, positionMs: Number.NaN },
            } satisfies MusicTabMessage);
            await settle();
            expect(get(musicPlayerStore).volume).toBe(volumeBefore);
            expect(Number.isFinite(get(musicPlayerStore).currentTimeMs)).toBe(true);
        });
    });

    it("taking over the same track seeks this tab's deck to the live position, even though the mirrored time already shows it", async () => {
        const shared = makeTrack();
        await musicPlayerStore.play(shared);
        await flush();
        // Paused for the other tab with this deck at ~0.
        announceFromOtherTab();
        await settle();
        // The other tab plays the SAME track and has moved on to 90s.
        otherTab.postMessage({
            type: 'state',
            tabId: 'other-tab',
            claim: otherClaim,
            state: {
                track: shared,
                queue: [],
                history: [],
                playbackContext: null,
                autoplaySeed: null,
                positionMs: 90_000,
                durationMs: 200_000,
                isPlaying: true,
                volume: 0.8,
                isMuted: false,
                sentAt: Date.now(),
            },
        });
        await settle();
        expect(get(musicPlayerStore).currentTimeMs).toBeGreaterThanOrEqual(90_000);
        otherTabOwnerState = { isPlaying: true, trackId: shared.id, positionMs: 90_500 };
        const deckSeek = vi.spyOn(backendRef.current!, 'seekTo');

        musicPlayerStore.resume();
        await settle(60);

        expect(deckSeek).toHaveBeenCalledWith(90_500);
        expect(get(musicPlayerStore).isPlaying).toBe(true);
        deckSeek.mockRestore();
    });

    describe('when the playing tab goes away', () => {
        async function mirrorAt(positionMs: number, sentAt: number): Promise<MusicTrack> {
            await musicPlayerStore.play(makeTrack());
            await flush();
            announceFromOtherTab();
            await settle();
            const theirs = makeTrack();
            otherTab.postMessage({
                type: 'state',
                tabId: 'other-tab',
                claim: otherClaim,
                state: {
                    track: theirs,
                    queue: [],
                    history: [],
                    playbackContext: null,
                    autoplaySeed: null,
                    positionMs,
                    durationMs: 200_000,
                    isPlaying: true,
                    volume: 0.8,
                    isMuted: false,
                    sentAt,
                },
                playing: true,
            } satisfies MusicTabMessage);
            await settle();
            return theirs;
        }

        it('closed cleanly: stops showing "elsewhere" and keeps the position it had reached', async () => {
            await mirrorAt(40_000, Date.now());
            await settle(600); // the ticker moves on while the owner plays
            otherTab.postMessage({
                type: 'closed',
                tabId: 'other-tab',
                claim: otherClaim,
            } satisfies MusicTabMessage);
            await settle();
            const at = get(musicPlayerStore).currentTimeMs;
            expect(get(musicPlayerStore).playingElsewhere).toBe(false);
            expect(at).toBeGreaterThanOrEqual(40_500);
            await settle(700);
            // Frozen now: nothing plays.
            expect(get(musicPlayerStore).currentTimeMs).toBe(at);
        });

        it('crashed (went silent): rewinds to where the music actually stopped', async () => {
            vi.useFakeTimers({
                toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
                shouldAdvanceTime: true,
            });
            try {
                await mirrorAt(40_000, Date.now());
                // No more states: the owner died. The ticker keeps extrapolating
                // until the expiry fires…
                await vi.advanceTimersByTimeAsync(9_000);
                const s = get(musicPlayerStore);
                expect(s.playingElsewhere).toBe(false);
                // …then the position goes back to the last sign of life (~40s),
                // not the ~49s the ticker had reached.
                expect(s.currentTimeMs).toBeGreaterThanOrEqual(40_000);
                expect(s.currentTimeMs).toBeLessThan(41_500);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe('second review follow-ups', () => {
        function stateMsg(overrides: Record<string, unknown>): MusicTabMessage {
            return {
                type: 'state',
                tabId: 'other-tab',
                claim: otherClaim,
                state: {
                    track: null,
                    queue: [],
                    history: [],
                    playbackContext: null,
                    autoplaySeed: null,
                    positionMs: 10_000,
                    durationMs: 200_000,
                    isPlaying: true,
                    volume: 0.8,
                    isMuted: false,
                    sentAt: Date.now(),
                    ...overrides,
                },
                playing: true,
            };
        }
        async function mirror(): Promise<MusicTrack> {
            await musicPlayerStore.play(makeTrack());
            await flush();
            announceFromOtherTab();
            await settle();
            const theirs = makeTrack();
            otherTab.postMessage(stateMsg({ track: theirs }));
            await settle();
            received = [];
            return theirs;
        }
        const lastState = (): Record<string, unknown> | undefined =>
            (
                received.filter((m) => m.type === 'state').at(-1) as
                    Extract<MusicTabMessage, { type: 'state' }> | undefined
            )?.state as Record<string, unknown> | undefined;

        it('a new tab asking who owns gets the full queue at once', async () => {
            const queued = makeTrack();
            await musicPlayerStore.play(makeTrack());
            musicPlayerStore.addToQueue(queued);
            await settle(250);
            received = [];
            otherTab.postMessage({
                type: 'who-owns',
                tabId: 'other-tab',
                queryId: 'q1',
            } satisfies MusicTabMessage);
            await settle(250);
            const state = lastState();
            expect(Array.isArray(state?.queue)).toBe(true);
            expect((state?.queue as Array<{ id: string }>).map((q) => q.id)).toContain(queued.id);
        });

        it('the first state after a claim carries the full lists', async () => {
            await musicPlayerStore.play(makeTrack());
            await settle(250);
            received = [];
            musicPlayerStore.pause();
            musicPlayerStore.resume(); // a new claim; queue unchanged
            await settle(250);
            expect(Array.isArray(lastState()?.queue)).toBe(true);
        });

        it('closed with X stays closed while the same tab plays on, reopens for another tab', async () => {
            const theirs = await mirror();
            musicPlayerStore.stop(true);
            // Same owner, next track: a new claim from the SAME tab.
            announceFromOtherTab();
            await settle();
            otherTab.postMessage(stateMsg({ track: makeTrack(), sentAt: Date.now() + 5 }));
            await settle();
            expect(get(musicPlayerStore).currentTrack).toBeNull();

            // A different tab starts playing: reopen.
            otherClaim = newerClaim('third-tab');
            otherTab.postMessage({
                type: 'playing',
                tabId: 'third-tab',
                claim: otherClaim,
            } satisfies MusicTabMessage);
            await settle();
            otherTab.postMessage({
                ...(stateMsg({ track: theirs, sentAt: Date.now() + 10 }) as Extract<
                    MusicTabMessage,
                    { type: 'state' }
                >),
                tabId: 'third-tab',
            });
            await settle();
            expect(get(musicPlayerStore).currentTrack?.id).toBe(theirs.id);
        });

        it('skip and previous in a mirroring tab steer the playing tab and report nothing here', async () => {
            await mirror();
            vi.mocked(musicApi.reportMusicPlayback).mockClear();
            await musicPlayerStore.skip();
            await musicPlayerStore.previous();
            await settle();
            const sent = received
                .filter((m) => m.type === 'command')
                .map((m) => (m as Extract<MusicTabMessage, { type: 'command' }>).command.type);
            expect(sent).toEqual(['skip', 'previous']);
            expect(musicApi.reportMusicPlayback).not.toHaveBeenCalled();
            expect(get(musicPlayerStore).isPlaying).toBe(false);
        });

        it('a pending volume command is dropped when this tab takes over', async () => {
            await mirror();
            musicPlayerStore.setVolume(0.33);
            musicPlayerStore.resume(); // take over within the 100ms window
            await settle(350);
            const vols = received.filter(
                (m) =>
                    m.type === 'command' &&
                    (m as Extract<MusicTabMessage, { type: 'command' }>).command.type === 'volume',
            );
            expect(vols).toHaveLength(0);
            expect(get(musicPlayerStore).volume).toBe(0.33);
        });

        it('if the owner changed track during the take-over query, the taker continues ITS track', async () => {
            await mirror();
            const moved = makeTrack();
            otherTabOwnerState = {
                isPlaying: true,
                trackId: moved.id,
                positionMs: 4_000,
            };
            // The owner-state reply carries the track too.
            otherTab.onmessage = (event: MessageEvent<MusicTabMessage>) => {
                received.push(event.data);
                if (event.data.type === 'who-owns') {
                    otherTab.postMessage({
                        type: 'owner-state',
                        tabId: 'other-tab',
                        queryId: event.data.queryId,
                        claim: otherClaim,
                        isPlaying: true,
                        trackId: moved.id,
                        positionMs: 4_000,
                        track: moved,
                    } satisfies MusicTabMessage);
                }
            };
            const preload = vi.spyOn(backendRef.current!, 'preload');
            musicPlayerStore.resume();
            await settle(60);
            loadMetadata();
            await settle();
            await flush();
            const call = preload.mock.calls.at(-1)!;
            expect(String(call[0])).toContain(moved.id);
            expect(call[2]).toBe(4_000);
            expect(get(musicPlayerStore).currentTrack?.id).toBe(moved.id);
            preload.mockRestore();
        });
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
