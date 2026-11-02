// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerController } from './player-controller.svelte';
import { playerStore } from './playerStore.svelte';
import { watchTogether } from '$lib/stores/watchTogether.svelte';
import { serverCapabilities } from '$lib/stores/server-capabilities.store';
import { getPlaybackContext } from '$lib/api/playlists.js';
import { LiveTvStartupDeadline } from './livetv-startup-deadline';
import type { WatchTogetherParty } from '$lib/schemas/watch-together-core-types';
import * as watchTogetherApi from '$lib/api/watch-together';

vi.mock('$lib/api/playlists.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/api/playlists.js')>()),
    getPlaybackContext: vi.fn(),
}));

vi.mock('./browserCapabilities.svelte', async (importOriginal) => {
    const original = await importOriginal<typeof import('./browserCapabilities.svelte')>();
    return {
        ...original,
        detectCapabilities: vi.fn().mockResolvedValue({
            h264: {},
            h265: {},
            vp9: {},
            av1: {},
            hdr10: {},
            dolbyVision: {},
        }),
        ensurePathScopedCapabilities: vi.fn().mockResolvedValue(undefined),
    };
});
vi.mock('./preferences-sync.svelte', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./preferences-sync.svelte')>()),
    initializePreferences: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/api/watch-together', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/api/watch-together')>()),
    getCurrentSession: vi.fn(),
}));

const mounted: PlayerController[] = [];

beforeEach(() => {
    vi.spyOn(watchTogether, 'tryRejoinFromStorage').mockResolvedValue(false);
});

/** Execute the real mount method without starting unrelated constructor effects. */
function mountController(fields: Record<string, unknown> = {}): PlayerController {
    const controller = Object.create(PlayerController.prototype) as PlayerController;
    mounted.push(controller);
    for (const [key, value] of Object.entries({
        playbackGeneration: 0,
        startupPositionResolved: false,
        // Field initializers do not run under Object.create; live mounts arm this deadline.
        liveTvStartupDeadline: new LiveTvStartupDeadline(),
        liveTvStartupHasProgress: false,
        caps: undefined,
        playbackProbe: undefined,
        videoElement: undefined,
        props: { mediaDbId: 'episode-1', playbackInfo: { mediaSources: [] } },
        currentPlaybackInfo: { mediaSources: [], userData: {} },
        currentMediaDbId: 'episode-1',
        setupResizeObserver: vi.fn(),
        setupPowerManagement: vi.fn(),
        log: vi.fn(),
        logSub: vi.fn(),
        getCacheIdentity: () => null,
        mightBeInWatchParty: () => false,
        ...fields,
    })) {
        Object.defineProperty(controller, key, { value, writable: true, configurable: true });
    }
    return controller;
}

function invalidateMount(controller: PlayerController): void {
    // stopAndCleanup() and destroy() both increment this lifecycle generation.
    // Avoid their unrelated media/network teardown in this focused async test.
    Object.defineProperty(controller, 'playbackGeneration', { value: 1 });
}

afterEach(() => {
    // invalidateMount() skips stopAndCleanup(), so disarm the live startup timer here.
    for (const controller of mounted.splice(0)) {
        (controller as unknown as { liveTvStartupCleanup?: () => void }).liveTvStartupCleanup?.();
    }
    playerStore.reset();
    watchTogether.session = null;
    watchTogether.isHost = false;
    vi.restoreAllMocks();
});

describe('player mount ownership', () => {
    it('does not attach listeners after an obsolete playlist request rejects', async () => {
        let rejectContext: (error: Error) => void = () => {};
        let contextRequested: () => void = () => {};
        const requested = new Promise<void>((resolve) => {
            contextRequested = resolve;
        });
        vi.mocked(getPlaybackContext).mockImplementation(() => {
            contextRequested();
            return new Promise((_resolve, reject) => {
                rejectContext = reject;
            });
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const loadSubtitles = vi.fn();
        const setupEventListeners = vi.fn();
        const playbackInfo = {
            isLive: true,
            mediaSources: [
                { id: 'live-source', videoStreams: [], audioStreams: [], subtitleStreams: [] },
            ],
        };
        const controller = mountController({
            props: { playbackInfo, playlistContext: { playlistId: 'playlist-1', position: 0 } },
            currentPlaybackInfo: playbackInfo,
            setupSubtitleAndProgressReporter: vi.fn().mockResolvedValue(undefined),
            negotiateLiveTvStream: vi.fn().mockResolvedValue({
                result: {
                    ok: true,
                    streamInfo: { delivery: { url: 'https://example.test/live.m3u8' } },
                },
                applied: {},
            }),
            applyLiveTvStreamInfo: vi.fn(),
            initializeHls: vi.fn().mockResolvedValue(undefined),
            loadSubtitles,
            setupEventListeners,
            setupMediaSession: vi.fn(),
            setupAirPlayListeners: vi.fn(),
            watchTogetherCtrl: { setupInMount: vi.fn().mockResolvedValue(undefined) },
        });
        const pending = controller.mount();
        await requested;
        invalidateMount(controller);
        rejectContext(new Error('Request failed after navigation'));
        (await pending)?.();

        expect(loadSubtitles).not.toHaveBeenCalled();
        expect(setupEventListeners).not.toHaveBeenCalled();
    });

    it('does not create a reporter or continue mounting after pending capabilities resolve late', async () => {
        let resolveCapabilities: () => void = () => {};
        vi.spyOn(serverCapabilities, 'fetch').mockReturnValue(
            new Promise<void>((resolve) => {
                resolveCapabilities = resolve;
            }),
        );
        const power = vi.fn();
        const controller = mountController({ setupPowerManagement: power });
        const pending = controller.mount();

        invalidateMount(controller);
        resolveCapabilities();
        (await pending)?.();

        expect(controller.progressReporter).toBeUndefined();
        expect(power).not.toHaveBeenCalled();
    });

    it('does not apply playback info that arrives after the mount is invalidated', async () => {
        let resolveInfo: (value: unknown) => void = () => {};
        let infoRequested: () => void = () => {};
        const requested = new Promise<void>((resolve) => {
            infoRequested = resolve;
        });
        const setInfo = vi.fn();
        const controller = mountController({
            setupSubtitleAndProgressReporter: vi.fn().mockResolvedValue(undefined),
            fetchPlaybackProbe: () => {
                infoRequested();
                return new Promise((resolve) => {
                    resolveInfo = resolve;
                });
            },
            setPlaybackProbe: setInfo,
        });
        const pending = controller.mount();
        await requested;

        invalidateMount(controller);
        resolveInfo({ playable: true });
        (await pending)?.();

        expect(setInfo).not.toHaveBeenCalled();
        expect(playerStore.error).toBeNull();
    });
});

describe('party position at granted playback start', () => {
    it.each([false, true])(
        'real restoration honors mount connection and ownership boundaries (cancel=%s)',
        async (cancel) => {
            vi.mocked(watchTogether.tryRejoinFromStorage).mockRestore();
            vi.spyOn(serverCapabilities, 'fetch').mockResolvedValue(undefined);
            localStorage.clear();
            const connect = vi
                .spyOn(
                    watchTogether as unknown as { connectToStream(code: string): Promise<void> },
                    'connectToStream',
                )
                .mockResolvedValue(undefined);
            let finish!: (value: never) => void;
            let requested!: () => void;
            const observed = new Promise<void>((resolve) => {
                requested = resolve;
            });
            vi.mocked(watchTogetherApi.getCurrentSession).mockImplementationOnce(() => {
                requested();
                return new Promise<never>((resolve) => {
                    finish = resolve;
                });
            });
            const party = {
                code: 'mount-party',
                host: { userId: 'host' },
                hostClientId: 'mount-client',
                mediaType: 'episode',
                title: 'Mount party',
                playbackRate: 1,
                itemId: 'episode-1',
                currentTime: 0,
                isPlaying: false,
                participants: [],
            } as unknown as WatchTogetherParty;
            const controller = mountController({
                props: {
                    userId: 'host',
                    mediaDbId: 'episode-1',
                    playbackInfo: { itemId: 'episode-1', mediaSources: [] },
                },
                currentPlaybackInfo: { itemId: 'episode-1', mediaSources: [] },
                setupSubtitleAndProgressReporter: vi.fn().mockResolvedValue(undefined),
                fetchPlaybackProbe: vi.fn(async () => {
                    invalidateMount(controller);
                    return null;
                }),
            });
            const pending = controller.mount();
            await observed;
            if (cancel) invalidateMount(controller);
            finish({ data: { party }, error: null, status: 200 } as never);
            (await pending)?.();
            expect(connect).not.toHaveBeenCalled();
            expect(watchTogether.session?.code ?? null).toBe(cancel ? null : party.code);
            watchTogether.disconnect();
        },
    );

    it.each([true, false])(
        'reconciles a different party item before probing (continue=%s)',
        async (continuePlayback) => {
            watchTogether.isHost = true;
            vi.spyOn(serverCapabilities, 'fetch').mockResolvedValue(undefined);
            vi.mocked(watchTogether.tryRejoinFromStorage).mockImplementationOnce(async () => {
                watchTogether.session = {
                    itemId: 'other-episode',
                    currentTime: 120,
                    isPlaying: false,
                } as WatchTogetherParty;
                return true;
            });
            let finish!: (value: boolean) => void;
            let reconcileStarted!: () => void;
            const started = new Promise<void>((resolve) => {
                reconcileStarted = resolve;
            });
            const reconcile = vi.fn(() => {
                reconcileStarted();
                return new Promise<boolean>((resolve) => {
                    finish = resolve;
                });
            });
            const fetchProbe = vi.fn(async () => {
                invalidateMount(controller);
                return null;
            });
            const controller = mountController({
                props: {
                    userId: 'host',
                    mediaDbId: 'episode-1',
                    playbackInfo: { itemId: 'episode-1', mediaSources: [] },
                },
                currentPlaybackInfo: { itemId: 'episode-1', mediaSources: [] },
                setupSubtitleAndProgressReporter: vi.fn().mockResolvedValue(undefined),
                watchTogetherCtrl: { reconcileRestoredItem: reconcile },
                fetchPlaybackProbe: fetchProbe,
            });
            const pending = controller.mount();
            await started;
            expect(fetchProbe).not.toHaveBeenCalled();
            watchTogether.session = {
                ...watchTogether.session!,
                itemId: 'episode-1',
                currentTime: 0,
            };
            finish(continuePlayback);
            (await pending)?.();
            expect(fetchProbe).toHaveBeenCalledTimes(continuePlayback ? 1 : 0);
            if (!continuePlayback) {
                expect(playerStore.error).toBeTruthy();
                expect(playerStore.isLoading).toBe(false);
            }
        },
    );

    it('does not request a stream after a pending party restoration outlives its mount', async () => {
        vi.spyOn(serverCapabilities, 'fetch').mockResolvedValue(undefined);
        let releaseRejoin!: (value: boolean) => void;
        let observeRejoin!: () => void;
        const requested = new Promise<void>((resolve) => {
            observeRejoin = resolve;
        });
        vi.mocked(watchTogether.tryRejoinFromStorage).mockImplementationOnce(() => {
            observeRejoin();
            return new Promise<boolean>((resolve) => {
                releaseRejoin = resolve;
            });
        });
        const requestStart = vi.fn();
        const fetchProbe = vi.fn();
        const setupParty = vi.fn();
        const controller = mountController({
            props: { userId: 'host', mediaDbId: 'episode-1', playbackInfo: { mediaSources: [] } },
            setupSubtitleAndProgressReporter: vi.fn().mockResolvedValue(undefined),
            fetchPlaybackProbe: fetchProbe,
            buildLumastraPlaybackUrl: requestStart,
            watchTogetherCtrl: { setupInMount: setupParty },
        });
        const pending = controller.mount();
        await requested;
        invalidateMount(controller);
        releaseRejoin(true);
        (await pending)?.();
        expect(fetchProbe).not.toHaveBeenCalled();
        expect(requestStart).not.toHaveBeenCalled();
        expect(setupParty).not.toHaveBeenCalled();
    });

    it.each([0, 120, null])(
        'waits for party restoration before requesting a stream at %s',
        async (position) => {
            vi.spyOn(serverCapabilities, 'fetch').mockResolvedValue(undefined);
            let releaseRejoin!: (value: boolean) => void;
            let observeRejoin!: () => void;
            let observeStart!: () => void;
            const rejoinObserved = new Promise<void>((resolve) => {
                observeRejoin = resolve;
            });
            const startObserved = new Promise<void>((resolve) => {
                observeStart = resolve;
            });
            let state: { currentTime: number; isPlaying: boolean } | null = null;
            vi.spyOn(watchTogether, 'getSessionState').mockImplementation(() => state);
            vi.mocked(watchTogether.tryRejoinFromStorage).mockImplementationOnce(() => {
                observeRejoin();
                return new Promise<boolean>((resolve) => {
                    releaseRejoin = resolve;
                });
            });
            const info = {
                itemId: 'episode-1',
                mediaSources: [],
                userData: { playbackPositionTicks: 1250000000 },
            };
            const probe = {
                resumePositionMs: 125000,
                activeVersion: {
                    playable: true,
                    durationMs: 145000,
                    tracks: { audio: [], subtitles: [] },
                },
                versions: [],
            };
            const requestStart = vi.fn(async () => {
                observeStart();
                return 'https://example.test/stream.m3u8';
            });
            const controller = mountController({
                props: { userId: 'host', mediaDbId: 'episode-1', playbackInfo: info },
                currentPlaybackInfo: info,
                mightBeInWatchParty: () => true,
                setupSubtitleAndProgressReporter: vi.fn().mockResolvedValue(undefined),
                fetchPlaybackProbe: vi.fn().mockResolvedValue(probe),
                setPlaybackProbe: () =>
                    Object.defineProperty(controller, 'playbackProbe', {
                        value: probe,
                        writable: true,
                        configurable: true,
                    }),
                syncProbeVersionsToStore: vi.fn(),
                updateProbedSource: vi.fn(),
                resolveAvailableLumastraMethod: () => 'remux',
                refreshTimeline: vi.fn(),
                setLumastraPlayMethod: vi.fn(),
                buildLumastraPlaybackUrl: requestStart,
                lumastraPlayMethod: 'remux',
                playbackStart: { delivery: { startPositionMs: (position ?? 125) * 1000 } },
                setLumastraHdrInfo: vi.fn(),
                initializeHls: vi.fn(async () => {
                    expect(playerStore.currentTime).toBe(position ?? 125);
                    expect(controller.startupPositionResolved).toBe(true);
                    invalidateMount(controller);
                }),
            });
            const pending = controller.mount();
            const first = await Promise.race([
                rejoinObserved.then(() => 'rejoin'),
                startObserved.then(() => 'stream'),
            ]);
            expect(
                first,
                'Saved episode progress must not load before the party snapshot is known',
            ).toBe('rejoin');
            expect(requestStart).not.toHaveBeenCalled();
            state = position === null ? null : { currentTime: position, isPlaying: false };
            releaseRejoin(position !== null);
            (await pending)?.();
            expect(requestStart).toHaveBeenCalledWith(probe, 'remux', position ?? 125);
        },
    );

    it.each([0, 120])(
        'requests party position %s despite saved resume and preview handoff',
        async (position) => {
            vi.spyOn(serverCapabilities, 'fetch').mockResolvedValue(undefined);
            vi.spyOn(watchTogether, 'getSessionState').mockReturnValue({
                currentTime: position,
                isPlaying: false,
            });
            const info = {
                itemId: 'episode-1',
                mediaSources: [],
                userData: { playbackPositionTicks: 900000000 },
                episodeSegment: { startMs: 60000 },
            };
            const probe = {
                resumePositionMs: 90000,
                activeVersion: {
                    playable: true,
                    durationMs: 7200000,
                    tracks: { audio: [], subtitles: [] },
                },
                versions: [],
            };
            const requestStart = vi.fn(async () => {
                invalidateMount(controller);
                return 'https://example.test/stream.mp4';
            });
            const controller = mountController({
                props: { mediaDbId: 'episode-1', playbackInfo: info, initialStartTime: 400 },
                currentPlaybackInfo: info,
                mightBeInWatchParty: () => true,
                setupSubtitleAndProgressReporter: vi.fn().mockResolvedValue(undefined),
                fetchPlaybackProbe: vi.fn().mockResolvedValue(probe),
                setPlaybackProbe: () =>
                    Object.defineProperty(controller, 'playbackProbe', {
                        value: probe,
                        writable: true,
                        configurable: true,
                    }),
                syncProbeVersionsToStore: vi.fn(),
                updateProbedSource: vi.fn(),
                resolveAvailableLumastraMethod: () => 'direct',
                refreshTimeline: vi.fn(),
                setLumastraPlayMethod: vi.fn(),
                buildLumastraPlaybackUrl: requestStart,
            });
            (await controller.mount())?.();
            expect(requestStart).toHaveBeenCalledWith(probe, 'direct', position);
            expect(playerStore.error).toBeNull();
        },
    );
});
