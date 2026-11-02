// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { playbackStartFixture } from '$lib/utils/playback-start.fixture.js';
import { musicTrackFromCard } from '$lib/utils/music-track';

// @vitest-environment happy-dom
/**
 * A track whose stream fails must stop the player with an error, not leave it
 * "playing" over silence.
 *
 * This drives the REAL store through the REAL `PlainAudioBackend`: the defect
 * lived in the seam between them (every backend swallowed the rejection, so
 * the store's catch never ran), and a mock backend that rejects on cue would
 * prove the catch works while the production path still never reaches it.
 *
 * Only the `<audio>` element is faked, because happy-dom has no media
 * pipeline: its `play()` and `error` are made to behave the way a browser's do
 * for a failed resource (see `backend-playback-failure.test.ts`).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import type { MusicTrack } from '$lib/schemas/music';
import type { AudioBackend } from '$lib/audio';

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

vi.mock('./music-playback-persistence', () => ({
    savePlaybackState: vi.fn(),
    loadPlaybackState: vi.fn(() => null),
    clearPlaybackState: vi.fn(),
    onPlaybackSessionEndedElsewhere: vi.fn(() => () => {}),
}));

// init() loads playback preferences; unmocked it fetches localhost:3000.
vi.mock('$lib/api/user', () => ({
    getPlaybackPreferences: vi.fn(async () => ({ data: null, error: null, status: 200 })),
}));

// AUTOMOCKED, not a factory: the store reaches this module through overlapping
// floating dynamic imports, and a factory mock lets the second one resolve the
// REAL module, so a "never called" assertion on a spy could pass falsely. See
// the long note in music-player-crossfade.test.ts.
vi.mock('$lib/api/music');

import { musicPlayerStore } from './music-player.store';
import * as musicApi from '$lib/api/music';
import { toasts } from '$lib/stores/toast.store';
import * as messages from '$lib/paraglide/messages';

const EMPTY_OK = { data: null, error: null, status: 200 } as const;

function installMusicApiDefaults(): void {
    for (const value of Object.values(musicApi)) {
        if (vi.isMockFunction(value)) value.mockResolvedValue(EMPTY_OK);
    }
    vi.mocked(musicApi.startMusicPlaySession).mockImplementation(async ({ trackId }) => ({
        data: playbackStartFixture(trackId, `session-${trackId}`, 'tok', 'internal'),
        error: null,
        status: 201,
    }));
    vi.mocked(musicApi.getRecommendations).mockResolvedValue({
        ...EMPTY_OK,
        data: { alternatives: [], source: 'metadata' },
    });
}

const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

function failElement(el: HTMLMediaElement, code: number): void {
    Object.defineProperty(el, 'error', {
        configurable: true,
        value: { code, message: `fake MediaError ${code}` },
    });
    el.dispatchEvent(new Event('error'));
}

const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

let trackSeq = 0;
function makeTrack(): MusicTrack {
    trackSeq += 1;
    return musicTrackFromCard({
        id: `fail-track-${trackSeq}`,
        title: `Track ${trackSeq}`,
        artists: [{ id: null, title: 'Tester' }],
        durationMs: 200000,
    });
}

let playSpy: ReturnType<typeof vi.spyOn> | null = null;
let toastError: ReturnType<typeof vi.spyOn>;

function audioElement(): HTMLAudioElement {
    const el = backendRef.current?.getAudioElement();
    if (!el) throw new Error('backend not initialised');
    return el;
}

beforeAll(async () => {
    await musicPlayerStore.init();
});

beforeEach(() => {
    vi.clearAllMocks();
    installMusicApiDefaults();
    toastError = vi.spyOn(toasts, 'error').mockImplementation(() => 0);
    musicPlayerStore.stop();
    vi.clearAllMocks();
    installMusicApiDefaults();
    delete (audioElement() as { error?: unknown }).error;
});

afterEach(() => {
    playSpy?.mockRestore();
    playSpy = null;
    toastError.mockRestore();
});

/**
 * The unified start opens the server session before the stream is requested, so a
 * stream that fails leaves one behind: it must be closed (COMPLETED, nothing
 * listened), and no ACTIVE/PAUSED report may announce a play that never happened.
 */
function expectNoPlayReported(): void {
    for (const [, report] of vi.mocked(musicApi.reportMusicPlayback).mock.calls) {
        expect(report.status).toBe('COMPLETED');
        expect(report.listenedTotalMs).toBe(0);
    }
}

describe('music player — a stream that fails stops with an error', () => {
    it('HTTP 415: stops, shows the playback-failed toast, and reports no play start', async () => {
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

        await musicPlayerStore.play(makeTrack());
        await flush();

        const state = get(musicPlayerStore);
        expect(state.isPlaying).toBe(false);
        expect(state.isLoadingTrack).toBe(false);
        expect(toastError).toHaveBeenCalledTimes(1);
        expect(toastError).toHaveBeenCalledWith(
            messages.music_playback_failed(),
            expect.objectContaining({ diagnosticKey: 'music_playback_failed' }),
        );
        // A track that never played has no play start and no session.
        expect(state.playStartedAt).toBeNull();
        expectNoPlayReported();
        expect(musicApi.startMusicPlaySession).toHaveBeenCalled();
    });

    it('decode error while loading (play() never settles): stops with the toast, no play start', async () => {
        playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (
            this: HTMLMediaElement,
        ) {
            setTimeout(() => failElement(this, MEDIA_ERR_DECODE), 0);
            return new Promise<void>(() => {});
        });

        void musicPlayerStore.play(makeTrack());
        await flush();

        const state = get(musicPlayerStore);
        expect(state.isPlaying).toBe(false);
        expect(state.isLoadingTrack).toBe(false);
        expect(toastError).toHaveBeenCalledTimes(1);
        expect(toastError).toHaveBeenCalledWith(
            messages.music_playback_failed(),
            expect.objectContaining({ diagnosticKey: 'music_playback_failed' }),
        );
        expect(state.playStartedAt).toBeNull();
        expectNoPlayReported();
        expect(musicApi.startMusicPlaySession).toHaveBeenCalled();
    });

    it('decode error after playback started: stops and shows the toast once', async () => {
        playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
        await musicPlayerStore.play(makeTrack());
        await flush();
        expect(get(musicPlayerStore).isPlaying).toBe(true);

        failElement(audioElement(), MEDIA_ERR_DECODE);
        await flush();

        expect(get(musicPlayerStore).isPlaying).toBe(false);
        expect(toastError).toHaveBeenCalledTimes(1);
        expect(toastError).toHaveBeenCalledWith(
            messages.music_playback_failed(),
            expect.objectContaining({ diagnosticKey: 'music_playback_failed' }),
        );
    });

    it('control: an autoplay-policy rejection stays silent', async () => {
        playSpy = vi
            .spyOn(HTMLMediaElement.prototype, 'play')
            .mockRejectedValue(new DOMException('blocked', 'NotAllowedError'));
        const track = makeTrack();

        await musicPlayerStore.play(track);
        await flush();

        expect(toastError).not.toHaveBeenCalled();
        expect(get(musicPlayerStore).currentTrack?.id).toBe(track.id);
    });

    it('control: a normal track plays, reports its start, and opens a session', async () => {
        playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
        const track = makeTrack();

        await musicPlayerStore.play(track);
        await flush();

        const state = get(musicPlayerStore);
        expect(state.isPlaying).toBe(true);
        expect(state.currentTrack?.id).toBe(track.id);
        expect(state.playStartedAt).not.toBeNull();
        expect(musicApi.startMusicPlaySession).toHaveBeenCalledWith({
            trackId: track.id,
            deviceId: expect.any(String),
            castTarget: false,
        });
        expect(musicApi.startMusicPlaySession).toHaveBeenCalledTimes(1);
        expect(toastError).not.toHaveBeenCalled();
    });
});

describe('mix queue actions', () => {
    beforeEach(() => {
        playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
        musicPlayerStore._updateForTest!((state) => ({
            ...state,
            queue: [],
            autoplayEnabled: false,
            playbackContext: null,
            autoplaySeed: null,
        }));
    });

    it('appends without interrupting playback or replacing existing tracks', async () => {
        const current = makeTrack();
        const queued = makeTrack();
        const added = makeTrack();
        await musicPlayerStore.play(current);
        musicPlayerStore.addToQueue(queued);
        musicPlayerStore.pause();
        await musicPlayerStore.enqueueFromBrew([queued, added, added], false);
        const state = get(musicPlayerStore);
        expect(state.queue.map((item) => item.id)).toEqual([queued.id, added.id]);
        expect(state.currentTrack?.id).toBe(current.id);
        expect(state.isPlaying).toBe(false);
    });

    it('plays the requested first track even when every incoming track is already queued', async () => {
        const first = makeTrack();
        const second = makeTrack();
        musicPlayerStore.addToQueue(first);
        musicPlayerStore.addToQueue(second);
        await musicPlayerStore.enqueueFromBrew([second, first, second]);
        expect(get(musicPlayerStore).currentTrack?.id).toBe(second.id);
        expect(get(musicPlayerStore).queue.map((item) => item.id)).toEqual([first.id]);
    });

    it('replaces unrelated queued tracks and clears the previous seed', async () => {
        musicPlayerStore.addToQueue(makeTrack());
        musicPlayerStore._updateForTest!((state) => ({
            ...state,
            autoplaySeed: { type: 'genre', genre: 'rock', label: 'Rock' },
        }));
        const first = makeTrack();
        const second = makeTrack();
        await musicPlayerStore.enqueueFromBrew([first, second]);
        expect(get(musicPlayerStore).queue.map((item) => item.id)).toEqual([second.id]);
        expect(get(musicPlayerStore).autoplaySeed).toBeNull();
    });

    it('ignores suggestions that finish after the old session is replaced', async () => {
        type Result = Awaited<ReturnType<typeof musicApi.getRecommendations>>;
        let complete!: (value: Result) => void;
        vi.mocked(musicApi.getRecommendations).mockImplementationOnce(
            () =>
                new Promise<Result>((resolve) => {
                    complete = resolve;
                }),
        );
        musicPlayerStore._updateForTest!((state) => ({ ...state, autoplayEnabled: true }));
        await musicPlayerStore.play(makeTrack());
        await flush();
        expect(musicApi.getRecommendations).toHaveBeenCalledOnce();
        musicPlayerStore._updateForTest!((state) => ({ ...state, autoplayEnabled: false }));
        const first = makeTrack();
        const second = makeTrack();
        await musicPlayerStore.enqueueFromBrew([first, second]);
        complete({ ...EMPTY_OK, data: { alternatives: [makeTrack()], source: 'metadata' } });
        await flush();
        expect(get(musicPlayerStore).queue.map((item) => item.id)).toEqual([second.id]);
    });

    it('sets album context and session tags on the replacement queue', async () => {
        const first = makeTrack();
        const second = makeTrack();
        const context = {
            type: 'album' as const,
            name: 'Album',
            trackCount: 1,
            sessionId: 'album-session',
        };
        await musicPlayerStore.enqueueFromBrew([first, second], true, context);
        expect(get(musicPlayerStore).playbackContext).toEqual(context);
        expect(get(musicPlayerStore).queue).toEqual([
            expect.objectContaining({ id: second.id, sessionId: 'album-session' }),
        ]);
    });

    it('leaves the current session alone for an empty selection', async () => {
        const current = makeTrack();
        await musicPlayerStore.play(current);
        await musicPlayerStore.enqueueFromBrew([]);
        expect(get(musicPlayerStore).currentTrack?.id).toBe(current.id);
    });
});

describe('music starts for AirPlay', () => {
    beforeEach(() => {
        playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    });
    afterEach(() => {
        musicPlayerStore._updateForTest!((s) => ({ ...s, isAirPlayActive: false }));
        delete (
            audioElement() as HTMLAudioElement & { webkitCurrentPlaybackTargetIsWireless?: boolean }
        ).webkitCurrentPlaybackTargetIsWireless;
        delete (audioElement() as unknown as { remote?: unknown }).remote;
    });

    it.each(['active', 'safari', 'remote-connected', 'remote-connecting', 'picker'])(
        'requests an unpinned grant while AirPlay is %s',
        async (mode) => {
            const element = audioElement();
            if (mode === 'active')
                musicPlayerStore._updateForTest!((s) => ({ ...s, isAirPlayActive: true }));
            if (mode === 'safari')
                Object.defineProperty(element, 'webkitCurrentPlaybackTargetIsWireless', {
                    configurable: true,
                    value: true,
                });
            if (mode.startsWith('remote-'))
                Object.defineProperty(element, 'remote', {
                    configurable: true,
                    value: { state: mode.replace('remote-', '') },
                });
            const track = makeTrack();
            await musicPlayerStore.play(track);
            if (mode === 'picker') {
                Object.defineProperty(element, 'webkitShowPlaybackTargetPicker', {
                    configurable: true,
                    value: vi.fn(),
                });
                await musicPlayerStore.activateAirPlay();
            }
            expect(musicApi.startMusicPlaySession).toHaveBeenLastCalledWith(
                expect.objectContaining({ trackId: track.id, castTarget: true }),
            );
            if (mode === 'picker') expect(musicApi.startMusicPlaySession).toHaveBeenCalledTimes(2);
        },
    );
});
vi.mock('$app/stores', () => ({
    page: {
        subscribe: (run: (value: unknown) => void) => {
            run({ data: { user: { userId: 'music-player-test-user' } } });
            return () => undefined;
        },
    },
}));

describe('music player — a user-initiated play does not wait for the previous completion', () => {
    it('track C starts while track A completion is still unacknowledged', async () => {
        playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
        const [a, b, c] = [makeTrack(), makeTrack(), makeTrack()];
        await musicPlayerStore.play(a);
        await flush();
        // A's COMPLETED report (sent when B starts) never gets its acknowledgement.
        vi.mocked(musicApi.reportMusicPlayback).mockImplementation(() => new Promise(() => {}));
        await musicPlayerStore.play(b);
        await flush();
        vi.mocked(musicApi.startMusicPlaySession).mockClear();

        void musicPlayerStore.play(c);
        await flush();

        expect(
            vi
                .mocked(musicApi.startMusicPlaySession)
                .mock.calls.some(([arg]) => arg.trackId === c.id),
        ).toBe(true);
    });
});
