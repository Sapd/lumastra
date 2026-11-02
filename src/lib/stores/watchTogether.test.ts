// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { buildPublicAuthor } from '$lib/shared/public-author';
import {
    createWatchTogetherHandlers,
    type VideoController,
} from '$lib/components/player/watch-together-handlers';

/**
 * Covers the `getCurrentSession` rejoin-on-reload fallback branch inside
 * `tryRejoinFromStorage`: when localStorage has no usable entry (cleared, or
 * a fresh tab) but the server reports we're still an active participant,
 * session state is set directly from that response. Audio-only must revert
 * to video on THIS path exactly like it does on the explicit `joinSession`
 * path — both call the private `applyAudioOnlyPartyExclusion()` helper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

vi.mock('./watchTogether/index', () => ({
    getOrCreateClientId: vi.fn(() => 'client-guest'),
    claimClientId: vi.fn(async () => 'client-guest'),
    saveToStorage: vi.fn(),
    // No usable local entry — forces tryRejoinFromStorage into the
    // getCurrentSession server-fallback branch.
    loadFromStorage: vi.fn(() => null),
    clearStorage: vi.fn(),
    isNavigatingWithinSession: vi.fn(() => false),
    setNavigatingWithinSessionFlag: vi.fn(),
    createSSEConnection: vi.fn(() => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
        isConnected: () => false,
    })),
    buildStreamUrl: vi.fn(() => 'http://fake/events'),
    parseSSEEvent: vi.fn(),
    calculateTimeToSync: vi.fn(() => 0),
    isHostDevice: vi.fn(() => false), // rejoining as a guest, not the host
    isOwnEvent: vi.fn(() => false),
    evaluateReconnect: vi.fn(),
    initialInstabilityState: vi.fn(() => ({})),
}));

vi.mock('$lib/api/watch-together', () => ({
    getCurrentSession: vi.fn(),
    sendHeartbeat: vi.fn(async () => ({ data: null, error: null, status: 204 })),
    getSession: vi.fn(),
    setVisibility: vi.fn(),
    createSession: vi.fn(),
    joinSession: vi.fn(),
    leaveSession: vi.fn(),
    disbandSession: vi.fn(),
    syncPlayback: vi.fn(async () => ({ data: { success: true }, error: null, status: 200 })),
    broadcastSeek: vi.fn(async () => ({ data: null, error: null, status: 204 })),
    broadcastNavigate: vi.fn(async () => ({ data: null, error: null, status: 204 })),
    signalReady: vi.fn(async () => ({ data: null, error: null, status: 202 })),
}));

// Keep the real module (buildPublicAuthor -> image-descriptor needs apiBase) and stub only apiUrl.
vi.mock('$lib/shared/api-urls.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/shared/api-urls.js')>()),
    apiUrl: vi.fn(() => 'http://fake/api'),
}));

import { playerStore } from '$lib/components/player/playerStore.svelte';
import { ORIGINAL_PROFILE } from '$lib/types/playback';
import * as watchTogetherApi from '$lib/api/watch-together';
import { toasts } from '$lib/stores/toast.store';
import { watchTogether } from './watchTogether.svelte';
import {
    isOwnEvent,
    isHostDevice,
    createSSEConnection,
    loadFromStorage,
    saveToStorage,
} from './watchTogether/index';
import type { WatchTogetherParty, SSEEventType } from '$lib/types/watch-together';

const fakeSession = {
    code: 'ABCD',
    hostClientId: 'client-host',
    host: buildPublicAuthor('11111111-1111-4111-8111-111111111111', 'Host', 'internal'),
    mediaType: 'movie',
    title: 'Movie',
    createdAt: 0,
    lastSync: 0,
    itemId: 'item-1',
    visibility: 'listed',
    currentTime: 0,
    isPlaying: false,
    playbackRate: 1,
    participants: [],
} satisfies WatchTogetherParty;

function linkedPartyPlayer(isHost: () => boolean = () => true) {
    let position = 2;
    let paused = true;
    const controller: VideoController = {
        getCurrentTime: () => position,
        seekTo: (target) => {
            position = target;
        },
        play: async () => {
            paused = false;
        },
        pause: () => {
            paused = true;
        },
        isPaused: () => paused,
        getPlaybackRate: () => 1,
        setPlaybackRate: () => {},
        getBuffered: () => ({ length: 1, start: () => 0, end: () => 100000 }) as TimeRanges,
        getReadyState: () => 4,
        isReady: () => true,
        hasLiveSource: () => true,
    };
    const handlers = createWatchTogetherHandlers({
        getItemId: () => 'item-1',
        isHost,
        log: () => {},
    });
    handlers.setController(controller);
    handlers.registerHandlers(watchTogether);
    handlers.markInitialSyncApplied();
    return { controller, handlers };
}

// Each test starts a separate client session on the shared singleton.
beforeEach(() => {
    watchTogether.disconnect();
    Object.assign(watchTogether, { playbackControlQueue: null });
});

describe('party snapshot before playback', () => {
    it('adopts the combined-file entry from the navigation acknowledgement without another read', async () => {
        watchTogether.session = { ...fakeSession, timelineId: 'old' };
        watchTogether.isHost = true;
        vi.mocked(watchTogetherApi.broadcastNavigate).mockResolvedValueOnce({
            data: { accepted: true, currentTime: 60 },
            error: null,
            status: 202,
        } as never);
        const reads = vi.mocked(watchTogetherApi.getSession).mock.calls.length;
        expect(await watchTogether.broadcastNavigate('combined', 'Part two', 'episode')).toBe(true);
        expect(watchTogether.session?.currentTime).toBe(60);
        expect(vi.mocked(watchTogetherApi.getSession).mock.calls.length).toBe(reads);
    });

    it.each([false, true])(
        'uses the canonical combined-file entry from navigation events (reuse=%s)',
        async (reuse) => {
            watchTogether.session = {
                ...fakeSession,
                itemId: reuse ? 'combined' : 'old',
                timelineId: 'old',
            };
            const seek = vi.fn();
            watchTogether.onSeek(seek);
            watchTogether.onNavigate(vi.fn());
            (watchTogether as unknown as { handleSSEEvent(event: unknown): void }).handleSSEEvent({
                type: 'navigate',
                itemId: 'combined',
                title: 'Part two',
                timelineId: 'new',
                currentTime: 60,
                author: fakeSession.host,
                clientId: 'peer',
            });
            expect(watchTogether.session?.currentTime).toBe(60);
            if (reuse) expect(seek).toHaveBeenCalledWith(60, 'system', false, true);
        },
    );

    it('retires a demoted host seek before applying the new host startup snapshot', async () => {
        vi.useFakeTimers();
        vi.mocked(isHostDevice).mockReturnValue(true);
        const party = { ...fakeSession, timelineId: 'startup', currentTime: 30, isPlaying: true };
        vi.mocked(watchTogetherApi.getCurrentSession).mockResolvedValue({
            data: { party },
            error: null,
            status: 200,
        } as never);
        let finish!: (value: never) => void;
        vi.mocked(watchTogetherApi.broadcastSeek).mockImplementationOnce(
            () =>
                new Promise<never>((resolve) => {
                    finish = resolve;
                }),
        );
        const { controller, handlers } = linkedPartyPlayer(() => watchTogether.isHost);
        try {
            await watchTogether.tryRejoinFromStorage('host', { connect: false });
            await watchTogether.tryRejoinFromStorage('host');
            controller.seekTo(50, 'seek');
            const pending = watchTogether.broadcastSeek(50, true);
            await vi.advanceTimersByTimeAsync(0);
            vi.mocked(isHostDevice).mockReturnValue(false);
            (watchTogether as unknown as { handleSSEEvent(event: unknown): void }).handleSSEEvent({
                type: 'connected',
                party: { ...party, hostClientId: 'new-host', currentTime: 10, isPlaying: false },
                lastEventId: 0,
                serverTime: Date.now(),
                requestReceivedAt: Date.now(),
                bufferCheck: {
                    checkId: 'new-host-join',
                    currentTime: 10,
                    isPlaying: false,
                    seekInitiated: false,
                },
            });
            finish({ data: null, error: 'not host', status: 403 } as never);
            await pending;
            await vi.advanceTimersByTimeAsync(16000);
            expect(watchTogether.isHost).toBe(false);
            expect(controller.getCurrentTime()).toBe(10);
            expect(controller.isPaused()).toBe(true);
            expect(watchTogether.session?.currentTime).toBe(10);
            expect(watchTogetherApi.syncPlayback).not.toHaveBeenCalled();
        } finally {
            handlers.dispose();
            watchTogether.disconnect();
            vi.useRealTimers();
            vi.mocked(isHostDevice).mockReturnValue(false);
        }
    });

    it.each(['item-1', 'item-2'])(
        'retires old startup seek recovery when the handshake changes the canonical binding to %s',
        async (itemId) => {
            vi.useFakeTimers();
            vi.mocked(isHostDevice).mockReturnValue(true);
            const party = { ...fakeSession, timelineId: 'old', currentTime: 30, isPlaying: true };
            vi.mocked(watchTogetherApi.getCurrentSession).mockResolvedValue({
                data: { party },
                error: null,
                status: 200,
            } as never);
            let finish!: (value: never) => void;
            vi.mocked(watchTogetherApi.broadcastSeek).mockImplementationOnce(
                () =>
                    new Promise<never>((resolve) => {
                        finish = resolve;
                    }),
            );
            const { controller, handlers } = linkedPartyPlayer();
            // Leave route replacement pending to prove old recovery cannot retarget the new party.
            watchTogether.onNavigate(vi.fn());
            try {
                await watchTogether.tryRejoinFromStorage('host', { connect: false });
                await watchTogether.tryRejoinFromStorage('host');
                controller.seekTo(50, 'seek');
                const pending = watchTogether.broadcastSeek(50, true);
                await vi.advanceTimersByTimeAsync(0);
                (
                    watchTogether as unknown as { handleSSEEvent(event: unknown): void }
                ).handleSSEEvent({
                    type: 'connected',
                    party: {
                        ...party,
                        itemId,
                        timelineId: 'new',
                        currentTime: 0,
                        isPlaying: false,
                    },
                    lastEventId: 0,
                    serverTime: Date.now(),
                    requestReceivedAt: Date.now(),
                    bufferCheck: {
                        checkId: 'new-item-join',
                        currentTime: 0,
                        isPlaying: false,
                        seekInitiated: false,
                    },
                });
                finish({ data: null, error: 'old seek failed', status: 503 } as never);
                await pending;
                await vi.advanceTimersByTimeAsync(16000);
                expect(watchTogether.session?.itemId).toBe(itemId);
                expect(watchTogether.session?.currentTime).toBe(0);
                expect(watchTogether.session?.isPlaying).toBe(false);
                expect(watchTogetherApi.syncPlayback).not.toHaveBeenCalled();
            } finally {
                handlers.dispose();
                watchTogether.disconnect();
                vi.useRealTimers();
                vi.mocked(isHostDevice).mockReturnValue(false);
            }
        },
    );

    it.each([
        { playing: false, barrier: false },
        { playing: true, barrier: false },
        { playing: false, barrier: true },
        { playing: true, barrier: true },
    ])(
        'keeps the viewer latest play/pause intent during the first handshake (playing=$playing, barrier=$barrier)',
        async ({ playing, barrier }) => {
            vi.useFakeTimers();
            vi.mocked(isHostDevice).mockReturnValue(true);
            const party = {
                ...fakeSession,
                timelineId: 'startup',
                currentTime: 30,
                isPlaying: !playing,
            };
            vi.mocked(watchTogetherApi.getCurrentSession).mockResolvedValue({
                data: { party },
                error: null,
                status: 200,
            } as never);
            const { controller, handlers } = linkedPartyPlayer();
            try {
                await watchTogether.tryRejoinFromStorage('host', { connect: false });
                await watchTogether.tryRejoinFromStorage('host');
                await watchTogether.syncPlaybackState(30, playing);
                (
                    watchTogether as unknown as { handleSSEEvent(event: unknown): void }
                ).handleSSEEvent({
                    type: 'connected',
                    party,
                    lastEventId: 0,
                    serverTime: Date.now(),
                    requestReceivedAt: Date.now(),
                    ...(barrier
                        ? {
                              bufferCheck: {
                                  checkId: 'older-join',
                                  currentTime: 30,
                                  isPlaying: !playing,
                                  seekInitiated: false,
                              },
                          }
                        : {}),
                });
                if (barrier) {
                    (
                        watchTogether as unknown as { handleSSEEvent(event: unknown): void }
                    ).handleSSEEvent({
                        type: 'all_ready',
                        checkId: 'older-join',
                        currentTime: 30,
                        isPlaying: !playing,
                        serverTime: Date.now(),
                        resumeAt: Date.now() + 1000,
                        timelineId: 'startup',
                    });
                    await vi.advanceTimersByTimeAsync(1100);
                }
                expect(controller.isPaused()).toBe(!playing);
            } finally {
                handlers.dispose();
                watchTogether.disconnect();
                vi.useRealTimers();
                vi.mocked(isHostDevice).mockReturnValue(false);
            }
        },
    );

    it.each(['none', 'join', 'seek'] as const)(
        'keeps a newer local seek in control before its prepare event (snapshot=%s)',
        async (barrier) => {
            vi.useFakeTimers();
            vi.mocked(isHostDevice).mockReturnValue(true);
            const party = {
                ...fakeSession,
                timelineId: 'startup',
                currentTime: 30,
                isPlaying: true,
            };
            vi.mocked(watchTogetherApi.getCurrentSession).mockResolvedValue({
                data: { party },
                error: null,
                status: 200,
            } as never);
            let finish!: (value: never) => void;
            vi.mocked(watchTogetherApi.broadcastSeek).mockImplementationOnce(
                () =>
                    new Promise<never>((resolve) => {
                        finish = resolve;
                    }),
            );
            const { controller, handlers } = linkedPartyPlayer();
            try {
                await watchTogether.tryRejoinFromStorage('host', { connect: false });
                await watchTogether.tryRejoinFromStorage('host');
                controller.seekTo(50, 'seek');
                const pending = watchTogether.broadcastSeek(50, true);
                await vi.advanceTimersByTimeAsync(0);
                (
                    watchTogether as unknown as { handleSSEEvent(event: unknown): void }
                ).handleSSEEvent({
                    type: 'connected',
                    party,
                    lastEventId: 0,
                    serverTime: Date.now(),
                    requestReceivedAt: Date.now(),
                    ...(barrier !== 'none'
                        ? {
                              bufferCheck: {
                                  checkId: 'older-barrier',
                                  currentTime: 30,
                                  isPlaying: true,
                                  seekInitiated: barrier === 'seek',
                              },
                          }
                        : {}),
                });
                expect(controller.getCurrentTime()).toBe(50);
                expect(controller.isPaused()).toBe(true);
                expect(handlers.isPlaybackHeld()).toBe(true);
                if (barrier !== 'none') {
                    finish({ data: null, error: 'seek response lost', status: 503 } as never);
                    await pending;
                }
                await vi.advanceTimersByTimeAsync(16000);
                expect(controller.isPaused()).toBe(false);
                expect(controller.getCurrentTime()).toBe(50);
                if (barrier === 'none') {
                    finish({ data: null, error: null, status: 204 } as never);
                    await pending;
                }
            } finally {
                handlers.dispose();
                watchTogether.disconnect();
                vi.useRealTimers();
                vi.mocked(isHostDevice).mockReturnValue(false);
            }
        },
    );

    it.each([false, true])(
        'restores a playing host from the handshake after a slow load (barrier=%s)',
        async (barrier) => {
            vi.useFakeTimers();
            vi.mocked(isHostDevice).mockReturnValue(true);
            const party = {
                ...fakeSession,
                timelineId: 'startup',
                currentTime: 30,
                isPlaying: true,
                lastSync: Date.now(),
            };
            vi.mocked(watchTogetherApi.getCurrentSession).mockResolvedValue({
                data: { party },
                error: null,
                status: 200,
            } as never);
            const { controller, handlers } = linkedPartyPlayer();
            try {
                await watchTogether.tryRejoinFromStorage('host', { connect: false });
                await vi.advanceTimersByTimeAsync(20000);
                await watchTogether.sendHeartbeat(0, false);
                expect(watchTogetherApi.sendHeartbeat).not.toHaveBeenCalled();
                await watchTogether.tryRejoinFromStorage('host');
                const events = watchTogether as unknown as { handleSSEEvent(event: unknown): void };
                events.handleSSEEvent({
                    type: 'connected',
                    party: { ...party, currentTime: 40, lastSync: Date.now() },
                    lastEventId: 0,
                    serverTime: Date.now(),
                    requestReceivedAt: Date.now(),
                    ...(barrier
                        ? {
                              bufferCheck: {
                                  checkId: 'startup-barrier',
                                  currentTime: 40,
                                  isPlaying: true,
                                  seekInitiated: false,
                              },
                          }
                        : {}),
                });
                expect(controller.getCurrentTime()).toBe(40);
                if (barrier) {
                    expect(controller.isPaused()).toBe(true);
                    events.handleSSEEvent({
                        type: 'all_ready',
                        checkId: 'startup-barrier',
                        currentTime: 40,
                        isPlaying: true,
                        resumeAt: Date.now() + 1000,
                        serverTime: Date.now(),
                        timelineId: 'startup',
                    });
                    await vi.advanceTimersByTimeAsync(1100);
                }
                expect(controller.isPaused()).toBe(false);
                await watchTogether.sendHeartbeat(controller.getCurrentTime(), false);
                expect(watchTogetherApi.sendHeartbeat).toHaveBeenCalledOnce();
            } finally {
                handlers.dispose();
                watchTogether.disconnect();
                vi.useRealTimers();
                vi.mocked(isHostDevice).mockReturnValue(false);
            }
        },
    );

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(loadFromStorage).mockReturnValue(null);
    });
    afterEach(() => {
        vi.mocked(loadFromStorage).mockReturnValue(null);
    });

    it.each(['stored', 'server'] as const)(
        'defers the %s stream until playback handlers can attach',
        async (path) => {
            if (path === 'stored') {
                vi.mocked(loadFromStorage).mockReturnValue({
                    code: fakeSession.code,
                    userId: 'user-1',
                });
                vi.mocked(watchTogetherApi.joinSession).mockResolvedValue({
                    data: { party: fakeSession },
                    error: null,
                    status: 200,
                } as never);
            } else {
                vi.mocked(watchTogetherApi.getCurrentSession).mockResolvedValue({
                    data: { party: fakeSession },
                    error: null,
                    status: 200,
                } as never);
            }
            expect(await watchTogether.tryRejoinFromStorage('user-1', { connect: false })).toBe(
                true,
            );
            expect(watchTogether.getSessionState()?.currentTime).toBe(0);
            expect(createSSEConnection).not.toHaveBeenCalled();
            expect(await watchTogether.tryRejoinFromStorage('user-1')).toBe(true);
            expect(createSSEConnection).toHaveBeenCalledOnce();
        },
    );

    it.each(['stored', 'server'] as const)(
        'does not resurrect membership after disconnect during %s restoration',
        async (path) => {
            let finish!: (value: never) => void;
            let started!: () => void;
            const requested = new Promise<void>((resolve) => {
                started = resolve;
            });
            const response = () => {
                started();
                return new Promise<never>((resolve) => {
                    finish = resolve;
                });
            };
            if (path === 'stored') {
                vi.mocked(loadFromStorage).mockReturnValue({
                    code: fakeSession.code,
                    userId: 'user-1',
                });
                vi.mocked(watchTogetherApi.joinSession).mockImplementationOnce(response);
            } else vi.mocked(watchTogetherApi.getCurrentSession).mockImplementationOnce(response);
            const pending = watchTogether.tryRejoinFromStorage('user-1', { connect: false });
            await requested;
            watchTogether.disconnect();
            finish({ data: { party: fakeSession }, error: null, status: 200 } as never);
            expect(await pending).toBe(false);
            expect(watchTogether.session).toBeNull();
            expect(saveToStorage).not.toHaveBeenCalled();
            expect(createSSEConnection).not.toHaveBeenCalled();
        },
    );
});

describe('tryRejoinFromStorage — server getCurrentSession fallback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        playerStore.currentQualityProfile = null;
        playerStore.previousQualityProfile = null;
        playerStore.qualityMode = 'original';

        // `watchTogether` is a module-level singleton shared by every test in
        // this file. Without resetting it, a successful rejoin in an earlier
        // test leaves `session` non-null, which makes tryRejoinFromStorage
        // take its "already in a session" early-return (watchTogether.svelte.ts
        // ~465-478) and never reach the getCurrentSession branch this file
        // exists to cover.
        watchTogether.session = null;
        watchTogether.isHost = false;
        watchTogether.hostClientId = null;
        watchTogether.isConnecting = false;
        watchTogether.hasSyncedInitially = false;
    });

    it('reverts audio-only to video when the server reports an active session that localStorage did not know about', async () => {
        playerStore.qualityMode = 'audio-only';
        playerStore.previousQualityProfile = ORIGINAL_PROFILE;
        const setQualityProfileSpy = vi.spyOn(playerStore, 'setQualityProfile');
        const toastInfoSpy = vi.spyOn(toasts, 'info');

        vi.mocked(watchTogetherApi.getCurrentSession).mockResolvedValue({
            data: { party: fakeSession },
            error: null,
            status: 200,
        } as never);

        const result = await watchTogether.tryRejoinFromStorage('user-1');

        // Proves the getCurrentSession fallback branch was actually entered
        // (not short-circuited by a leftover `session` from another test).
        expect(watchTogetherApi.getCurrentSession).toHaveBeenCalledTimes(1);
        expect(result).toBe(true);
        expect(setQualityProfileSpy).toHaveBeenCalledWith(ORIGINAL_PROFILE);
        expect(toastInfoSpy).toHaveBeenCalled();
    });

    it('does nothing to quality when not in audio-only', async () => {
        playerStore.qualityMode = 'original';
        const setQualityProfileSpy = vi.spyOn(playerStore, 'setQualityProfile');

        vi.mocked(watchTogetherApi.getCurrentSession).mockResolvedValue({
            data: { party: fakeSession },
            error: null,
            status: 200,
        } as never);

        const result = await watchTogether.tryRejoinFromStorage('user-1');

        // Proves the getCurrentSession fallback branch was actually entered
        // for THIS test too — without the beforeEach reset above, `session`
        // from the previous test would make this a false pass (the branch,
        // and the assertion below, would never run at all).
        expect(watchTogetherApi.getCurrentSession).toHaveBeenCalledTimes(1);
        expect(result).toBe(true);
        expect(setQualityProfileSpy).not.toHaveBeenCalled();
    });
});

describe('syncPlaybackState — which position a guest sends', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        watchTogether.isHost = false;
    });

    it('a guest pausing a playing party sends where it really is', async () => {
        // The cached session position is the host's last heartbeat (here 3.4 s old);
        // pausing with it rewound every player (browser <-> Apple TV e2e).
        watchTogether.session = { ...fakeSession, isPlaying: true, currentTime: 1.5 };
        await watchTogether.syncPlaybackState(4.9, false);
        expect(vi.mocked(watchTogetherApi.syncPlayback)).toHaveBeenCalledWith(
            'ABCD',
            expect.objectContaining({ currentTime: 4.9, isPlaying: false }),
        );
    });

    it('a guest pressing Play still sends the party position, never its own', async () => {
        // A guest's player can sit at 0 after joining; only the server-validated
        // pause case may carry the guest's own position.
        watchTogether.session = { ...fakeSession, isPlaying: false, currentTime: 600 };
        await watchTogether.syncPlaybackState(0, true);
        expect(vi.mocked(watchTogetherApi.syncPlayback)).toHaveBeenCalledWith(
            'ABCD',
            expect.objectContaining({ currentTime: 600, isPlaying: true }),
        );
    });
});

describe('seekResumeIntent — rapid host seeks keep a playing party playing', () => {
    type WithEvents = { handleSSEEvent(event: unknown): void };

    beforeEach(() => {
        vi.clearAllMocks();
        watchTogether.disconnect();
        vi.useFakeTimers();
        watchTogether.isHost = true;
        watchTogether.session = { ...fakeSession, isPlaying: true, currentTime: 2 };
        // A fresh store state for the intent: an explicit pause clears it.
        (watchTogether as unknown as { ownSeekIntent: null }).ownSeekIntent = null;
    });

    afterEach(() => {
        watchTogether.disconnect();
        vi.useRealTimers();
    });

    it('a second seek during the first seek barrier still means "playing"', async () => {
        // A coordinated seek pauses the host's own <video> until all_ready, so the
        // element says "paused" when the host presses seek again. The web e2e saw
        // four quick ArrowRight presses end the whole party paused.
        await watchTogether.broadcastSeek(12, true);
        expect(watchTogether.seekResumeIntent(false)).toBe(true);
    });

    it('a paused seek stays paused', async () => {
        await watchTogether.broadcastSeek(12, false);
        expect(watchTogether.seekResumeIntent(false)).toBe(false);
    });

    it('the element playing always means playing', () => {
        expect(watchTogether.seekResumeIntent(true)).toBe(true);
    });

    it('an explicit pause after the seek wins', async () => {
        await watchTogether.broadcastSeek(12, true);
        await watchTogether.syncPlaybackState(12, false);
        expect(watchTogether.seekResumeIntent(false)).toBe(false);
    });

    it("someone else's pause (sync event) wins", async () => {
        await watchTogether.broadcastSeek(12, true);
        (watchTogether as unknown as WithEvents).handleSSEEvent({
            type: 'sync',
            state: { currentTime: 12, isPlaying: false, playbackRate: 1, timestamp: Date.now() },
            author: {
                userId: '22222222-2222-4222-8222-222222222222',
                displayName: 'guest',
                images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
            },
            clientId: 'client-guest-2',
        });
        expect(watchTogether.seekResumeIntent(false)).toBe(false);
    });

    it('a barrier that ends paused clears the intent', async () => {
        await watchTogether.broadcastSeek(12, true);
        (watchTogether as unknown as WithEvents).handleSSEEvent({
            type: 'buffer_check',
            checkId: 'c1',
            currentTime: 12,
            isPlaying: true,
            author: {
                userId: '22222222-2222-4222-8222-222222222222',
                displayName: 'host',
                images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
            },
        });
        await watchTogether.syncPlaybackState(12, false);
        (watchTogether as unknown as WithEvents).handleSSEEvent({
            type: 'all_ready',
            checkId: 'c1',
            currentTime: 12,
            resumeAt: Date.now(),
            serverTime: Date.now(),
            isPlaying: false,
        });
        expect(watchTogether.seekResumeIntent(false)).toBe(false);
    });

    it('a barrier that ends playing keeps it (the resume is still scheduled)', async () => {
        await watchTogether.broadcastSeek(12, true);
        (watchTogether as unknown as WithEvents).handleSSEEvent({
            type: 'buffer_check',
            checkId: 'c1',
            currentTime: 12,
            isPlaying: true,
            author: {
                userId: '22222222-2222-4222-8222-222222222222',
                displayName: 'host',
                images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
            },
        });
        (watchTogether as unknown as WithEvents).handleSSEEvent({
            type: 'all_ready',
            checkId: 'c1',
            currentTime: 12,
            resumeAt: Date.now() + 1500,
            serverTime: Date.now(),
            isPlaying: true,
        });
        expect(watchTogether.seekResumeIntent(false)).toBe(true);
    });

    it('keeps playing intent through a long barrier and local readiness wait', async () => {
        watchTogether.onAllReady(vi.fn());
        await watchTogether.broadcastSeek(12, true);
        const store = watchTogether as unknown as WithEvents;
        store.handleSSEEvent({
            type: 'buffer_check',
            checkId: 'slow',
            currentTime: 12,
            isPlaying: true,
            author: {
                userId: '22222222-2222-4222-8222-222222222222',
                displayName: 'host',
                images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
            },
        });
        vi.advanceTimersByTime(9000);
        expect(watchTogether.seekResumeIntent(false)).toBe(true);
        store.handleSSEEvent({
            type: 'all_ready',
            checkId: 'slow',
            currentTime: 12,
            isPlaying: true,
            resumeAt: Date.now() + 1500,
            serverTime: Date.now(),
        });
        vi.advanceTimersByTime(9000);
        expect(watchTogether.seekResumeIntent(false)).toBe(true);
        watchTogether.settleSeekIntent();
        expect(watchTogether.seekResumeIntent(false)).toBe(false);
    });

    it.each(['returned error', 'throw'])(
        'recovers intended playback after a %s',
        async (failure) => {
            const ready = vi.fn();
            watchTogether.onAllReady(ready);
            if (failure === 'throw')
                vi.mocked(watchTogetherApi.broadcastSeek).mockRejectedValueOnce(
                    new Error('offline'),
                );
            else
                vi.mocked(watchTogetherApi.broadcastSeek).mockResolvedValueOnce({
                    error: { message: 'failed' },
                    status: 503,
                    data: null,
                } as never);
            await watchTogether.broadcastSeek(12, true);
            expect(ready).toHaveBeenCalledWith(expect.stringMatching(/^local-seek-/), 12, 0, true);
            expect(watchTogether.isCatchUpPaused()).toBe(false);
        },
    );

    it('recovers when the initial buffer_check event never arrives', async () => {
        const ready = vi.fn();
        watchTogether.onAllReady(ready);
        await watchTogether.broadcastSeek(12, true);
        vi.advanceTimersByTime(15000);
        expect(ready).toHaveBeenCalledWith(expect.stringMatching(/^local-seek-/), 12, 0, true);
    });

    it.each(['local', 'peer'])(
        'held %s Play keeps real target readiness and watchdog recovery when prepare is lost',
        async (sender) => {
            const { controller, handlers } = linkedPartyPlayer();
            await watchTogether.broadcastSeek(12, false);
            expect(handlers.isPlaybackHeld()).toBe(true);
            if (sender === 'local') await watchTogether.syncPlaybackState(12, true);
            else
                (watchTogether as unknown as WithEvents).handleSSEEvent({
                    type: 'sync',
                    clientId: 'peer',
                    author: fakeSession.host,
                    state: {
                        currentTime: 2,
                        isPlaying: true,
                        playbackRate: 1,
                        timestamp: Date.now(),
                    },
                });
            expect(controller.isPaused()).toBe(true);
            await vi.advanceTimersByTimeAsync(16000);
            expect(controller.isPaused()).toBe(true); // The SDK has not landed yet.
            controller.seekTo(12, 'watch_party_seek');
            await vi.advanceTimersByTimeAsync(250);
            expect(controller.getCurrentTime()).toBe(12);
            expect(controller.isPaused()).toBe(false);
            expect(handlers.isPlaybackHeld()).toBe(false);
            handlers.dispose();
        },
    );

    it('a peer Play can resume after a local Pause canceled its pending seek', async () => {
        const { controller, handlers } = linkedPartyPlayer();
        controller.seekTo(12, 'watch_party_seek');
        await watchTogether.broadcastSeek(12, true);
        await watchTogether.syncPlaybackState(12, false);
        (watchTogether as unknown as WithEvents).handleSSEEvent({
            type: 'sync',
            clientId: 'peer',
            author: fakeSession.host,
            state: { currentTime: 12, isPlaying: true, playbackRate: 1, timestamp: Date.now() },
        });
        await Promise.resolve();
        expect(controller.isPaused()).toBe(false);
        expect(handlers.isPlaybackHeld()).toBe(false);
        handlers.dispose();
    });

    it.each(['error', 'throw'])(
        'failed paused seek recovery preserves a newer peer Play (%s)',
        async (failure) => {
            const { controller, handlers } = linkedPartyPlayer();
            controller.seekTo(12, 'watch_party_seek');
            let release!: () => void;
            vi.mocked(watchTogetherApi.broadcastSeek).mockImplementationOnce(
                () =>
                    new Promise((resolve, reject) => {
                        release = () => {
                            if (failure === 'error')
                                resolve({
                                    data: null,
                                    error: { message: 'offline' },
                                    status: 503,
                                } as never);
                            else reject(new Error('offline'));
                        };
                    }),
            );
            const seek = watchTogether.broadcastSeek(12, false);
            for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
            (watchTogether as unknown as WithEvents).handleSSEEvent({
                type: 'sync',
                clientId: 'peer',
                author: fakeSession.host,
                state: { currentTime: 12, isPlaying: true, playbackRate: 1, timestamp: Date.now() },
            });
            release();
            await seek;
            await vi.advanceTimersByTimeAsync(1);
            expect(watchTogether.session?.isPlaying).toBe(true);
            expect(controller.isPaused()).toBe(false);
            expect(
                vi
                    .mocked(watchTogetherApi.syncPlayback)
                    .mock.calls.every((call) => call[1].isPlaying),
            ).toBe(true);
            handlers.dispose();
        },
    );

    it('keeps a same-item replacement held until its destination engine attaches', () => {
        watchTogether.session = { ...fakeSession, timelineId: 'old', fileId: 'old-file' };
        watchTogether.onNavigate(vi.fn());
        (watchTogether as unknown as WithEvents).handleSSEEvent({
            type: 'navigate',
            author: fakeSession.host,
            clientId: 'peer',
            itemId: 'item-1',
            timelineId: 'replacement',
            fileId: 'new-file',
            mediaType: 'movie',
        });
        expect(watchTogether.isPlayerAttachmentPending).toBe(true);
        watchTogether.attachLoadedNavigationPlayer('item-1');
        expect(watchTogether.isPlayerAttachmentPending).toBe(false);
    });

    it('held Play retains the newest queued seek and recovers its target through the real handler', async () => {
        const { controller, handlers } = linkedPartyPlayer();
        let release!: (value: Awaited<ReturnType<typeof watchTogetherApi.broadcastSeek>>) => void;
        vi.mocked(watchTogetherApi.broadcastSeek).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        controller.seekTo(12, 'watch_party_seek');
        const first = watchTogether.broadcastSeek(12, false);
        for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
        controller.seekTo(22, 'watch_party_seek');
        await watchTogether.broadcastSeek(22, false);
        const play = watchTogether.syncPlaybackState(22, true);
        release({ data: null, error: null, status: 204 });
        await first;
        await play;
        for (
            let i = 0;
            i < 10 && vi.mocked(watchTogetherApi.broadcastSeek).mock.calls.length < 2;
            i++
        )
            await Promise.resolve();
        expect(
            vi.mocked(watchTogetherApi.broadcastSeek).mock.calls.map((call) => call[1].currentTime),
        ).toEqual([12, 22]);
        expect(vi.mocked(watchTogetherApi.broadcastSeek).mock.calls[1][1].isPlaying).toBe(true);
        await vi.advanceTimersByTimeAsync(16000);
        expect(controller.getCurrentTime()).toBe(22);
        expect(controller.isPaused()).toBe(false);
        expect(handlers.isPlaybackHeld()).toBe(false);
        handlers.dispose();
    });

    it('only the newest missing-event watchdog recovers', async () => {
        const ready = vi.fn();
        watchTogether.onAllReady(ready);
        await watchTogether.broadcastSeek(12, true);
        vi.advanceTimersByTime(1000);
        await watchTogether.broadcastSeek(22, true);
        vi.advanceTimersByTime(14000);
        expect(ready).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1000);
        expect(ready).toHaveBeenCalledOnce();
        expect(ready).toHaveBeenCalledWith(expect.any(String), 22, 0, true);
    });

    it.each(['pause', 'disconnect', 'newer seek'])(
        'a late failed command cannot recover after %s',
        async (action) => {
            const ready = vi.fn();
            watchTogether.onAllReady(ready);
            let fail!: (value: never) => void;
            vi.mocked(watchTogetherApi.broadcastSeek).mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        fail = resolve;
                    }),
            );
            const request = watchTogether.broadcastSeek(12, true);
            const pause =
                action === 'pause' ? watchTogether.syncPlaybackState(12, false) : undefined;
            if (action === 'disconnect') watchTogether.disconnect();
            else if (action === 'newer seek') await watchTogether.broadcastSeek(22, true);
            fail({ error: { message: 'offline' }, status: 503 } as never);
            await request;
            await pause;
            expect(ready).not.toHaveBeenCalled();
            vi.advanceTimersByTime(14000);
            expect(ready).not.toHaveBeenCalled();
        },
    );

    it('explicit pause cancels the captured watchdog and late playing completion', async () => {
        const ready = vi.fn();
        watchTogether.onAllReady(ready);
        await watchTogether.broadcastSeek(12, true);
        const store = watchTogether as unknown as WithEvents;
        store.handleSSEEvent({
            type: 'buffer_check',
            checkId: 'slow',
            currentTime: 12,
            isPlaying: true,
            author: {
                userId: '22222222-2222-4222-8222-222222222222',
                displayName: 'host',
                images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
            },
        });
        await watchTogether.syncPlaybackState(12, false);
        vi.advanceTimersByTime(15000);
        expect(ready).toHaveBeenCalledWith('slow', 12, 0, false);
        ready.mockClear();
        store.handleSSEEvent({
            type: 'all_ready',
            checkId: 'slow',
            currentTime: 12,
            isPlaying: true,
            resumeAt: Date.now(),
            serverTime: Date.now(),
        });
        expect(ready).not.toHaveBeenCalled();
        expect(watchTogether.session?.isPlaying).toBe(false);
    });

    it('rejects an older target while the newest local request is pending', async () => {
        let finish!: (result: never) => void;
        vi.mocked(watchTogetherApi.broadcastSeek).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const first = watchTogether.broadcastSeek(12, true);
        await watchTogether.broadcastSeek(22, true);
        const buffer = vi.fn();
        watchTogether.onBufferCheck(buffer);
        const store = watchTogether as unknown as WithEvents;
        store.handleSSEEvent({
            type: 'buffer_check',
            checkId: 'old',
            currentTime: 12,
            isPlaying: true,
            author: {
                userId: '22222222-2222-4222-8222-222222222222',
                displayName: 'host',
                images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
            },
            seekInitiated: true,
        });
        expect(buffer).not.toHaveBeenCalled();
        expect(watchTogether.session?.currentTime).toBe(22);
        finish({ error: null, status: 204, data: null } as never);
        await first;
        expect(watchTogetherApi.broadcastSeek).toHaveBeenCalledTimes(2);
        expect(watchTogetherApi.broadcastSeek).toHaveBeenLastCalledWith(
            'ABCD',
            expect.objectContaining({ currentTime: 22 }),
        );
    });

    it('a pause before the initial barrier survives its delayed playing event', async () => {
        await watchTogether.broadcastSeek(12, true);
        await watchTogether.syncPlaybackState(12, false);
        const store = watchTogether as unknown as WithEvents;
        const ready = vi.fn();
        watchTogether.onAllReady(ready);
        store.handleSSEEvent({
            type: 'buffer_check',
            checkId: 'delayed',
            currentTime: 12,
            isPlaying: true,
            author: {
                userId: '22222222-2222-4222-8222-222222222222',
                displayName: 'host',
                images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
            },
            seekInitiated: true,
        });
        expect(watchTogether.session?.isPlaying).toBe(false);
        store.handleSSEEvent({
            type: 'all_ready',
            checkId: 'delayed',
            currentTime: 12,
            isPlaying: true,
            resumeAt: Date.now(),
            serverTime: Date.now(),
        });
        expect(ready).toHaveBeenCalledWith('delayed', 12, 0, false);
    });

    it('accepts a matching completion when the initial barrier is missing', async () => {
        await watchTogether.broadcastSeek(12, true);
        const ready = vi.fn();
        watchTogether.onAllReady(ready);
        (watchTogether as unknown as WithEvents).handleSSEEvent({
            type: 'all_ready',
            checkId: 'server-check',
            currentTime: 12,
            isPlaying: true,
            resumeAt: Date.now(),
            serverTime: Date.now(),
        });
        expect(ready).toHaveBeenCalledWith(expect.stringMatching(/^local-seek-/), 12, 0, true);
    });

    it.each([false, true])(
        'a real barrier missing all_ready recovers revised explicit play intent %s',
        async (play) => {
            await watchTogether.broadcastSeek(12, !play);
            const store = watchTogether as unknown as WithEvents;
            store.handleSSEEvent({
                type: 'buffer_check',
                checkId: 'real',
                currentTime: 12,
                isPlaying: !play,
                author: {
                    userId: '22222222-2222-4222-8222-222222222222',
                    displayName: 'host',
                    images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
                },
                seekInitiated: true,
            });
            const ready = vi.fn();
            watchTogether.onAllReady(ready);
            await watchTogether.syncPlaybackState(12, play);
            vi.advanceTimersByTime(15000);
            expect(ready).toHaveBeenCalledWith('real', 12, 0, play);
        },
    );

    it('does not veto an authoritative playing completion because of an old paused snapshot', async () => {
        const store = watchTogether as unknown as WithEvents;
        store.handleSSEEvent({
            type: 'buffer_check',
            checkId: 'join',
            currentTime: 12,
            isPlaying: false,
            author: {
                userId: '22222222-2222-4222-8222-222222222222',
                displayName: 'system',
                images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
            },
            seekInitiated: false,
        });
        const ready = vi.fn();
        watchTogether.onAllReady(ready);
        store.handleSSEEvent({
            type: 'all_ready',
            checkId: 'join',
            currentTime: 12,
            isPlaying: true,
            resumeAt: Date.now(),
            serverTime: Date.now(),
        });
        expect(ready).toHaveBeenCalledWith('join', 12, 0, true);
    });

    it('ignores an old-session authorization failure after a new party starts', async () => {
        let finish!: (result: never) => void;
        vi.mocked(watchTogetherApi.broadcastSeek).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const auth = vi.spyOn(
            watchTogether as unknown as { checkAuthError(status: number): boolean },
            'checkAuthError',
        );
        const request = watchTogether.broadcastSeek(12, true);
        watchTogether.disconnect();
        watchTogether.session = { ...fakeSession, code: 'NEW' };
        finish({ error: { message: 'unauthorized' }, status: 401 } as never);
        await request;
        expect(auth).not.toHaveBeenCalled();
        expect(watchTogether.session?.code).toBe('NEW');
        auth.mockRestore();
    });

    it('a delayed connected barrier snapshot preserves the newer explicit pause', async () => {
        await watchTogether.broadcastSeek(12, true);
        await watchTogether.syncPlaybackState(12, false);
        const ready = vi.fn();
        watchTogether.onAllReady(ready);
        (watchTogether as unknown as WithEvents).handleSSEEvent({
            type: 'connected',
            lastEventId: 0,
            party: { ...fakeSession, currentTime: 12, isPlaying: true },
            serverTime: Date.now(),
            requestReceivedAt: Date.now(),
            bufferCheck: {
                checkId: 'reconnect',
                currentTime: 12,
                isPlaying: true,
                seekInitiated: true,
            },
        });
        expect(watchTogether.session?.isPlaying).toBe(false);
        vi.advanceTimersByTime(15000);
        expect(ready).toHaveBeenCalledWith('reconnect', 12, 0, false);
    });

    it('acknowledges navigation without depending on a follow-up GET', async () => {
        watchTogether.session = { ...fakeSession, timelineId: 'old-timeline' };
        vi.mocked(watchTogetherApi.getSession).mockRejectedValue(new Error('GET unavailable'));
        expect(await watchTogether.broadcastNavigate('next', 'Next', 'movie')).toBe(true);
        const request = vi.mocked(watchTogetherApi.broadcastNavigate).mock.lastCall![1];
        expect(watchTogether.session?.itemId).toBe('next');
        expect(watchTogether.session?.timelineId).toBe(request.timelineId);
        expect(request.timelineId).toEqual(expect.any(String));
        expect(request.timelineId).not.toBe('old-timeline');
        expect(watchTogetherApi.getSession).not.toHaveBeenCalled();
        watchTogether.attachLoadedNavigationPlayer('next');
        await watchTogether.syncPlaybackState(0, true);
        expect(watchTogetherApi.syncPlayback).toHaveBeenLastCalledWith(
            'ABCD',
            expect.objectContaining({ expectedTimelineId: request.timelineId }),
        );
    });

    it('retries a transient navigation failure with the same command identity', async () => {
        vi.mocked(watchTogetherApi.broadcastNavigate).mockResolvedValueOnce({
            data: null,
            error: 'unavailable',
            status: 503,
        } as never);
        const navigation = watchTogether.broadcastNavigate('next', 'Next', 'movie');
        await vi.advanceTimersByTimeAsync(251);
        expect(await navigation).toBe(true);
        const calls = vi.mocked(watchTogetherApi.broadcastNavigate).mock.calls;
        expect(calls).toHaveLength(2);
        expect(calls[0][1].timelineId).toBe(calls[1][1].timelineId);
        expect(watchTogether.session?.timelineId).toBe(calls[1][1].timelineId);
    });

    it('recovers an accepted navigation when every HTTP reply is lost', async () => {
        vi.mocked(watchTogetherApi.broadcastNavigate).mockResolvedValue({
            data: null,
            error: 'unavailable',
            status: 503,
        } as never);
        vi.mocked(watchTogetherApi.getSession).mockImplementation(
            async () =>
                ({
                    data: {
                        party: {
                            ...fakeSession,
                            itemId: 'next',
                            currentTime: 45,
                            isPlaying: true,
                            playbackRate: 1.25,
                            timelineId: vi.mocked(watchTogetherApi.broadcastNavigate).mock
                                .lastCall![1].timelineId,
                        },
                    },
                    error: null,
                    status: 200,
                }) as never,
        );
        const navigation = watchTogether.broadcastNavigate('next', 'Next', 'movie');
        await vi.advanceTimersByTimeAsync(751);
        expect(await navigation).toBe(true);
        expect(watchTogetherApi.broadcastNavigate).toHaveBeenCalledTimes(3);
        expect(watchTogether.session?.itemId).toBe('next');
        expect(watchTogether.session?.currentTime).toBe(45);
        expect(watchTogether.session?.isPlaying).toBe(true);
        expect(watchTogether.session?.playbackRate).toBe(1.25);
        vi.mocked(watchTogetherApi.broadcastNavigate).mockResolvedValue({
            data: null,
            error: null,
            status: 204,
        } as never);
    });

    it('applies canonical clock and play state for a same-item new timeline on host reconnect', () => {
        watchTogether.session = {
            ...fakeSession,
            currentTime: 150,
            isPlaying: true,
            timelineId: 'old',
        };
        vi.mocked(isHostDevice).mockReturnValueOnce(true);
        const seek = vi.fn();
        const sync = vi.fn();
        watchTogether.onSeek(seek);
        watchTogether.onSync(sync);
        (watchTogether as unknown as WithEvents).handleSSEEvent({
            type: 'connected',
            party: { ...fakeSession, timelineId: 'new' },
            serverTime: Date.now(),
            requestReceivedAt: Date.now(),
        });
        expect(seek).toHaveBeenCalledWith(0, 'system', false, true);
        expect(sync).toHaveBeenCalledWith(
            expect.objectContaining({ currentTime: 0, isPlaying: false }),
        );
    });

    it('fences a watchdog recovery already in flight when navigation changes the timeline', async () => {
        watchTogether.session = { ...fakeSession, timelineId: 'old-timeline' };
        let finish!: (value: never) => void;
        vi.mocked(watchTogetherApi.syncPlayback).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        watchTogether.onAllReady(vi.fn());
        await watchTogether.broadcastSeek(12, true);
        await vi.advanceTimersByTimeAsync(15000);
        expect(watchTogetherApi.syncPlayback).toHaveBeenCalledWith(
            'ABCD',
            expect.objectContaining({
                itemId: fakeSession.itemId,
                expectedTimelineId: 'old-timeline',
            }),
        );
        expect(await watchTogether.broadcastNavigate('next', 'Next', 'movie')).toBe(true);
        finish({ data: { success: true }, error: null, status: 200 } as never);
        await vi.advanceTimersByTimeAsync(0);
        expect(watchTogetherApi.syncPlayback).toHaveBeenCalledTimes(1);
    });

    it('a remote same-item navigation restarts the loaded engine at canonical zero', () => {
        watchTogether.session = {
            ...fakeSession,
            currentTime: 150,
            isPlaying: true,
            timelineId: 'old',
        };
        const seek = vi.fn();
        const sync = vi.fn();
        watchTogether.onSeek(seek);
        watchTogether.onSync(sync);
        (watchTogether as unknown as WithEvents).handleSSEEvent({
            type: 'navigate',
            itemId: fakeSession.itemId,
            timelineId: 'new',
            title: 'Again',
            author: fakeSession.host,
            clientId: 'peer',
        });
        expect(seek).toHaveBeenCalledWith(0, 'system', false, true);
        expect(sync).toHaveBeenCalledWith(
            expect.objectContaining({ currentTime: 0, isPlaying: false }),
        );
    });

    it('does not ask the old title to satisfy a new title readiness barrier', async () => {
        const buffer = vi.fn();
        watchTogether.onBufferCheck(buffer);
        vi.mocked(watchTogetherApi.broadcastNavigate).mockImplementationOnce(
            async (_code, body) => {
                (watchTogether as unknown as WithEvents).handleSSEEvent({
                    type: 'buffer_check',
                    timelineId: body.timelineId,
                    checkId: 'new-ready',
                    currentTime: 0,
                    isPlaying: true,
                    seekInitiated: false,
                    initiator: 'peer',
                });
                expect(buffer).not.toHaveBeenCalled();
                await watchTogether.signalReady('new-ready', 150);
                expect(watchTogetherApi.signalReady).not.toHaveBeenCalled();
                return { data: null, error: null, status: 204 } as never;
            },
        );
        expect(await watchTogether.broadcastNavigate('next', 'Next', 'movie')).toBe(true);
        watchTogether.attachLoadedNavigationPlayer(fakeSession.itemId);
        expect(buffer).not.toHaveBeenCalled();
        watchTogether.attachLoadedNavigationPlayer('next');
        expect(buffer).toHaveBeenCalledWith('new-ready', 0, 'peer', true, false);
    });

    it('attaches a deferred barrier with the latest peer play intent', async () => {
        const buffer = vi.fn();
        watchTogether.onBufferCheck(buffer);
        vi.mocked(watchTogetherApi.broadcastNavigate).mockImplementationOnce(
            async (_code, body) => {
                (watchTogether as unknown as WithEvents).handleSSEEvent({
                    type: 'buffer_check',
                    timelineId: body.timelineId,
                    checkId: 'latest-intent',
                    currentTime: 0,
                    isPlaying: false,
                    seekInitiated: false,
                    initiator: 'peer',
                });
                (watchTogether as unknown as WithEvents).handleSSEEvent({
                    type: 'sync',
                    timelineId: body.timelineId,
                    state: {
                        currentTime: 0,
                        isPlaying: true,
                        playbackRate: 1,
                        timestamp: Date.now(),
                    },
                    author: fakeSession.host,
                    clientId: 'peer',
                });
                return { data: null, error: null, status: 204 } as never;
            },
        );
        expect(await watchTogether.broadcastNavigate('next', 'Next', 'movie')).toBe(true);
        watchTogether.attachLoadedNavigationPlayer('next');
        expect(buffer).toHaveBeenCalledWith('latest-intent', 0, 'peer', true, false);
    });

    it('retains the new title barrier and its watchdog when navigation is acknowledged', async () => {
        vi.mocked(watchTogetherApi.broadcastNavigate).mockImplementationOnce(
            async (_code, body) => {
                (watchTogether as unknown as WithEvents).handleSSEEvent({
                    type: 'buffer_check',
                    timelineId: body.timelineId,
                    checkId: 'new-join',
                    currentTime: 0,
                    isPlaying: true,
                    seekInitiated: false,
                    initiator: 'peer',
                });
                return { data: null, error: null, status: 204 } as never;
            },
        );
        const ready = vi.fn();
        watchTogether.onAllReady(ready);
        expect(await watchTogether.broadcastNavigate('next', 'Next', 'movie')).toBe(true);
        expect(watchTogether.isWatchPartySyncing).toBe(true);
        watchTogether.attachLoadedNavigationPlayer('next');
        await vi.advanceTimersByTimeAsync(15000);
        expect(ready).toHaveBeenCalledWith('new-join', 0, 0, true);
    });

    it('keeps a newer peer Play received before the navigation acknowledgement', async () => {
        vi.mocked(watchTogetherApi.broadcastNavigate).mockImplementationOnce(
            async (_code, body) => {
                (watchTogether as unknown as WithEvents).handleSSEEvent({
                    type: 'sync',
                    timelineId: body.timelineId,
                    state: {
                        currentTime: 45,
                        isPlaying: true,
                        playbackRate: 1.25,
                        timestamp: Date.now(),
                    },
                    author: fakeSession.host,
                    clientId: 'peer',
                });
                return { data: null, error: null, status: 204 } as never;
            },
        );
        expect(await watchTogether.broadcastNavigate('next', 'Next', 'movie')).toBe(true);
        expect(watchTogether.session?.currentTime).toBe(45);
        expect(watchTogether.session?.isPlaying).toBe(true);
        expect(watchTogether.session?.playbackRate).toBe(1.25);
    });

    it('returns superseded before an older navigation can replace the latest item', async () => {
        vi.mocked(watchTogetherApi.getSession).mockImplementation(
            async () =>
                ({
                    data: {
                        party: {
                            ...fakeSession,
                            timelineId: vi.mocked(watchTogetherApi.broadcastNavigate).mock
                                .calls[0][1].timelineId,
                        },
                    },
                    error: null,
                    status: 200,
                }) as never,
        );
        let finish!: (value: never) => void;
        vi.mocked(watchTogetherApi.broadcastNavigate).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const first = watchTogether.broadcastNavigate('first', 'First', 'movie');
        await vi.advanceTimersByTimeAsync(0);
        const latest = watchTogether.broadcastNavigate('latest', 'Latest', 'movie');
        expect(watchTogetherApi.broadcastNavigate).toHaveBeenCalledOnce();
        finish({ data: null, error: null, status: 204 } as never);
        expect(await first).toBe(false);
        expect(await latest).toBe(true);
        expect(watchTogether.session?.itemId).toBe('latest');
        expect(watchTogether.session?.timelineId).toBe(
            vi.mocked(watchTogetherApi.broadcastNavigate).mock.lastCall![1].timelineId,
        );
    });

    it('navigation invalidates queued old-timeline seeks before its response returns', async () => {
        watchTogether.session = { ...fakeSession, timelineId: 'old-timeline' };
        let finishSeek!: (result: never) => void;
        let finishNavigation!: (result: never) => void;
        vi.mocked(watchTogetherApi.broadcastSeek).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishSeek = resolve;
                }),
        );
        vi.mocked(watchTogetherApi.broadcastNavigate).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishNavigation = resolve;
                }),
        );
        const first = watchTogether.broadcastSeek(12, true);
        await watchTogether.broadcastSeek(22, true);
        const navigation = watchTogether.broadcastNavigate('next', 'Next', 'movie');
        finishSeek({ data: null, error: null, status: 204 } as never);
        await first;
        expect(watchTogetherApi.broadcastSeek).toHaveBeenCalledOnce();
        expect(watchTogetherApi.broadcastSeek).toHaveBeenCalledWith(
            'ABCD',
            expect.objectContaining({
                itemId: fakeSession.itemId,
                expectedTimelineId: 'old-timeline',
            }),
        );
        finishNavigation({ data: null, error: null, status: 204 } as never);
        await navigation;
        expect(watchTogether.session?.itemId).toBe('next');
        expect(watchTogether.session?.timelineId).toBe(
            vi.mocked(watchTogetherApi.broadcastNavigate).mock.lastCall![1].timelineId,
        );
        expect(watchTogether.session?.currentTime).toBe(0);
    });

    it('serializes outstanding requests and coalesces queued seeks to the latest target', async () => {
        let finish!: (result: never) => void;
        vi.mocked(watchTogetherApi.broadcastSeek).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const first = watchTogether.broadcastSeek(12, true);
        await watchTogether.broadcastSeek(22, true);
        await watchTogether.broadcastSeek(32, true);
        expect(watchTogetherApi.broadcastSeek).toHaveBeenCalledOnce();
        finish({ error: null, status: 204 } as never);
        await first;
        expect(watchTogetherApi.broadcastSeek).toHaveBeenCalledTimes(2);
        expect(watchTogetherApi.broadcastSeek).toHaveBeenLastCalledWith(
            'ABCD',
            expect.objectContaining({ currentTime: 32 }),
        );
    });

    it('does not dispatch an expired queued seek after its watchdog recovered', async () => {
        let finish!: (result: never) => void;
        vi.mocked(watchTogetherApi.broadcastSeek).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const ready = vi.fn();
        watchTogether.onAllReady(ready);
        const first = watchTogether.broadcastSeek(12, true);
        await watchTogether.broadcastSeek(22, true);
        await vi.advanceTimersByTimeAsync(15000);
        expect(ready).toHaveBeenCalledWith(expect.stringMatching(/^local-seek-/), 22, 0, true);
        expect(watchTogether.session?.currentTime).toBe(22);
        await vi.advanceTimersByTimeAsync(15000);
        finish({ error: null, status: 204 } as never);
        await first;
        expect(watchTogetherApi.broadcastSeek).toHaveBeenCalledOnce();
        expect(ready).toHaveBeenCalledOnce();
        expect(watchTogether.session?.isPlaying).toBe(true);
    });

    it('a delayed same-target playing barrier cannot override the newer paused seek', async () => {
        let finish!: (result: never) => void;
        vi.mocked(watchTogetherApi.broadcastSeek).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const first = watchTogether.broadcastSeek(12, true);
        await watchTogether.broadcastSeek(22, true);
        const control = watchTogether.syncPlaybackState(22, false);
        await watchTogether.broadcastSeek(12, false);
        const ready = vi.fn();
        const buffer = vi.fn();
        watchTogether.onAllReady(ready);
        watchTogether.onBufferCheck(buffer);
        const store = watchTogether as unknown as WithEvents;
        const oldCheck = {
            type: 'buffer_check',
            checkId: 'old-same-target',
            currentTime: 12,
            isPlaying: true,
            author: {
                userId: '22222222-2222-4222-8222-222222222222',
                displayName: 'host',
                images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
            },
            seekInitiated: true,
        };
        const oldReady = {
            type: 'all_ready',
            checkId: 'old-same-target',
            currentTime: 12,
            isPlaying: true,
            resumeAt: Date.now(),
            serverTime: Date.now(),
        };
        store.handleSSEEvent(oldCheck);
        store.handleSSEEvent(oldReady);
        expect(buffer).not.toHaveBeenCalled();
        expect(ready).not.toHaveBeenCalled();
        expect(watchTogether.session?.isPlaying).toBe(false);
        finish({ error: null, status: 204 } as never);
        await first;
        await control;
        expect(watchTogetherApi.broadcastSeek).toHaveBeenLastCalledWith(
            'ABCD',
            expect.objectContaining({ currentTime: 12, isPlaying: false }),
        );
        // Even after the newest command is sent, a delayed same-target old
        // event cannot distinguish generations; preserve latest host intent.
        store.handleSSEEvent(oldCheck);
        store.handleSSEEvent(oldReady);
        expect(ready).toHaveBeenCalledWith('old-same-target', 12, 0, false);
        expect(watchTogether.session?.isPlaying).toBe(false);
    });

    it('a guest explicit pause survives a delayed playing barrier and completion', async () => {
        watchTogether.isHost = false;
        await watchTogether.syncPlaybackState(12, false);
        const ready = vi.fn();
        watchTogether.onAllReady(ready);
        const store = watchTogether as unknown as WithEvents;
        store.handleSSEEvent({
            type: 'buffer_check',
            checkId: 'guest-delayed',
            currentTime: 12,
            isPlaying: true,
            author: {
                userId: '22222222-2222-4222-8222-222222222222',
                displayName: 'host',
                images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
            },
            seekInitiated: true,
        });
        expect(watchTogether.session?.isPlaying).toBe(false);
        // Delayed = sent before the pause. Stamping it with the current time let it
        // look newer than the pause whenever a few ms elapsed, and that heals the pause.
        const sentBeforePause = Date.now() - 5_000;
        store.handleSSEEvent({
            type: 'all_ready',
            checkId: 'guest-delayed',
            currentTime: 12,
            isPlaying: true,
            resumeAt: sentBeforePause,
            serverTime: sentBeforePause,
        });
        expect(ready).toHaveBeenCalledWith('guest-delayed', 12, 0, false);
    });

    it("a new session's guest pause is not stamped with the old connection's server clock", async () => {
        const store = watchTogether as unknown as WithEvents;
        store.handleSSEEvent({
            type: 'connected',
            lastEventId: 0,
            party: { ...fakeSession, currentTime: 2, isPlaying: true },
            serverTime: Date.now(),
            requestReceivedAt: Date.now(),
        });
        watchTogether.disconnect();
        // The next session starts a minute later on the wall clock. The monotonic
        // clock did not move, as when fake timers are reinstalled between tests.
        vi.setSystemTime(Date.now() + 60_000);
        watchTogether.session = { ...fakeSession, isPlaying: true, currentTime: 2 };
        watchTogether.isHost = false;
        await watchTogether.syncPlaybackState(12, false);
        const ready = vi.fn();
        watchTogether.onAllReady(ready);
        store.handleSSEEvent({
            type: 'buffer_check',
            checkId: 'after-reconnect',
            currentTime: 12,
            isPlaying: true,
            author: {
                userId: '22222222-2222-4222-8222-222222222222',
                displayName: 'host',
                images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
            },
            seekInitiated: true,
        });
        const sentBeforePause = Date.now() - 5_000;
        store.handleSSEEvent({
            type: 'all_ready',
            checkId: 'after-reconnect',
            currentTime: 12,
            isPlaying: true,
            resumeAt: sentBeforePause,
            serverTime: sentBeforePause,
        });
        expect(ready).toHaveBeenCalledWith('after-reconnect', 12, 0, false);
    });

    it('a delayed same-target paused barrier cannot override a newer playing host seek', async () => {
        let finish!: (result: never) => void;
        vi.mocked(watchTogetherApi.broadcastSeek).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const first = watchTogether.broadcastSeek(12, false);
        const control = watchTogether.syncPlaybackState(12, true);
        await watchTogether.broadcastSeek(12, true);
        const ready = vi.fn();
        watchTogether.onAllReady(ready);
        const store = watchTogether as unknown as WithEvents;
        const check = {
            type: 'buffer_check',
            checkId: 'old-paused',
            currentTime: 12,
            isPlaying: false,
            author: {
                userId: '22222222-2222-4222-8222-222222222222',
                displayName: 'host',
                images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
            },
            seekInitiated: true,
        };
        const completed = {
            type: 'all_ready',
            checkId: 'old-paused',
            currentTime: 12,
            isPlaying: false,
            resumeAt: Date.now(),
            serverTime: Date.now(),
        };
        store.handleSSEEvent(check);
        store.handleSSEEvent(completed);
        expect(ready).not.toHaveBeenCalled();
        finish({ error: null, status: 204 } as never);
        await first;
        await control;
        store.handleSSEEvent(check);
        store.handleSSEEvent(completed);
        expect(ready).toHaveBeenCalledWith('old-paused', 12, 0, true);
    });

    it('publishes the recovered target to peers after the initial event is lost', async () => {
        await watchTogether.broadcastSeek(12, true);
        await vi.advanceTimersByTimeAsync(15000);
        expect(watchTogetherApi.syncPlayback).toHaveBeenCalledWith(
            'ABCD',
            expect.objectContaining({ currentTime: 12, isPlaying: true }),
        );
    });

    it.each(['pending play', 'newer pause'])(
        'ignores its recovery sync echo during %s',
        async (action) => {
            // Keep the actual-play readiness gate pending after the watchdog.
            watchTogether.onAllReady(vi.fn());
            await watchTogether.broadcastSeek(12, true);
            await vi.advanceTimersByTimeAsync(15000);
            if (action === 'newer pause') await watchTogether.syncPlaybackState(12, false);
            vi.mocked(isOwnEvent).mockReturnValueOnce(true);
            (watchTogether as unknown as WithEvents).handleSSEEvent({
                type: 'sync',
                syncId: vi.mocked(watchTogetherApi.syncPlayback).mock.calls[0][1].syncId,
                author: {
                    userId: '22222222-2222-4222-8222-222222222222',
                    displayName: 'guest',
                    images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
                },
                clientId: 'client-guest',
                state: { currentTime: 12, isPlaying: true, playbackRate: 1, timestamp: Date.now() },
            });
            expect(watchTogether.session?.isPlaying).toBe(action === 'pending play');
            expect(watchTogether.seekResumeIntent(false)).toBe(action === 'pending play');
            await watchTogether.broadcastSeek(22, watchTogether.seekResumeIntent(false));
            expect(watchTogetherApi.broadcastSeek).toHaveBeenLastCalledWith(
                'ABCD',
                expect.objectContaining({ currentTime: 22, isPlaying: action === 'pending play' }),
            );
        },
    );

    it.each(['pause', 'newer seek'])(
        'reasserts newer %s state after a delayed recovery sync response',
        async (action) => {
            let finish!: (result: never) => void;
            vi.mocked(watchTogetherApi.syncPlayback).mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finish = resolve;
                    }),
            );
            await watchTogether.broadcastSeek(12, true);
            await vi.advanceTimersByTimeAsync(15000);
            expect(watchTogetherApi.syncPlayback).toHaveBeenCalledWith(
                'ABCD',
                expect.objectContaining({ currentTime: 12, isPlaying: true }),
            );
            const newer =
                action === 'pause'
                    ? watchTogether.syncPlaybackState(12, false)
                    : watchTogether.broadcastSeek(22, true);
            finish({ data: { success: true }, error: null, status: 200 } as never);
            await newer;
            await vi.advanceTimersByTimeAsync(0);
            expect(watchTogetherApi.syncPlayback).toHaveBeenLastCalledWith(
                'ABCD',
                expect.objectContaining({
                    currentTime: action === 'pause' ? 12 : 22,
                    isPlaying: action !== 'pause',
                }),
            );
            expect(watchTogether.session?.isPlaying).toBe(action !== 'pause');
            if (action === 'newer seek') expect(watchTogether.seekResumeIntent(false)).toBe(true);
        },
    );

    it.each(['older completion', 'later authoritative completion', 'pending local pause'])(
        'guest pause handles %s when the explicit Play event was missed',
        async (scenario) => {
            watchTogether.isHost = false;
            const store = watchTogether as unknown as WithEvents;
            const pauseAt = Date.now();
            let finish!: (result: never) => void;
            let pending: Promise<void> | undefined;
            if (scenario === 'pending local pause') {
                vi.mocked(watchTogetherApi.syncPlayback).mockImplementationOnce(
                    () =>
                        new Promise((resolve) => {
                            finish = resolve;
                        }),
                );
                pending = watchTogether.syncPlaybackState(12, false);
            } else {
                store.handleSSEEvent({
                    type: 'sync',
                    author: {
                        userId: '22222222-2222-4222-8222-222222222222',
                        displayName: 'guest',
                        images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
                    },
                    clientId: 'other-client',
                    state: {
                        currentTime: 12,
                        isPlaying: false,
                        playbackRate: 1,
                        timestamp: pauseAt,
                    },
                });
            }
            const ready = vi.fn();
            watchTogether.onAllReady(ready);
            store.handleSSEEvent({
                type: 'buffer_check',
                checkId: 'later-party',
                currentTime: 22,
                isPlaying: true,
                author: {
                    userId: '22222222-2222-4222-8222-222222222222',
                    displayName: 'host',
                    images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
                },
                seekInitiated: true,
            });
            expect(watchTogether.session?.isPlaying).toBe(false);
            store.handleSSEEvent({
                type: 'all_ready',
                checkId: 'later-party',
                currentTime: 22,
                isPlaying: true,
                resumeAt: pauseAt + 2000,
                serverTime: scenario === 'older completion' ? pauseAt - 1000 : pauseAt + 2000,
            });
            expect(watchTogether.session?.isPlaying).toBe(
                scenario === 'later authoritative completion',
            );
            expect(ready).toHaveBeenCalledWith(
                'later-party',
                22,
                expect.any(Number),
                scenario === 'later authoritative completion',
            );
            if (pending) {
                finish({ data: { success: true }, error: null, status: 200 } as never);
                await pending;
            }
        },
    );

    it('reasserts a pause that supersedes an already pending recovery correction', async () => {
        let finishRecovery!: (result: never) => void;
        let finishCorrection!: (result: never) => void;
        const success = { data: { success: true }, error: null, status: 200 } as never;
        vi.mocked(watchTogetherApi.syncPlayback)
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finishRecovery = resolve;
                    }),
            )
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finishCorrection = resolve;
                    }),
            );
        watchTogether.onAllReady(vi.fn());
        await watchTogether.broadcastSeek(12, true);
        await vi.advanceTimersByTimeAsync(15000);
        const newerSeek = watchTogether.broadcastSeek(22, true);
        finishRecovery(success);
        await newerSeek;
        await vi.advanceTimersByTimeAsync(0);
        expect(watchTogetherApi.syncPlayback).toHaveBeenLastCalledWith(
            'ABCD',
            expect.objectContaining({ currentTime: 22, isPlaying: true }),
        );
        const pause = watchTogether.syncPlaybackState(22, false);
        finishCorrection(success);
        await pause;
        await vi.advanceTimersByTimeAsync(0);
        expect(watchTogetherApi.syncPlayback).toHaveBeenLastCalledWith(
            'ABCD',
            expect.objectContaining({ currentTime: 22, isPlaying: false }),
        );
        expect(watchTogetherApi.syncPlayback).toHaveBeenCalledTimes(4);
        vi.mocked(isOwnEvent).mockReturnValueOnce(true);
        (watchTogether as unknown as WithEvents).handleSSEEvent({
            type: 'sync',
            syncId: vi.mocked(watchTogetherApi.syncPlayback).mock.calls[1][1].syncId,
            author: {
                userId: '22222222-2222-4222-8222-222222222222',
                displayName: 'guest',
                images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
            },
            clientId: 'client-guest',
            state: { currentTime: 22, isPlaying: true, playbackRate: 1, timestamp: Date.now() },
        });
        expect(watchTogether.session?.isPlaying).toBe(false);
        await vi.advanceTimersByTimeAsync(0);
        expect(watchTogetherApi.syncPlayback).toHaveBeenCalledTimes(4);
    });

    it('the intent expires once the barrier is long over', async () => {
        vi.useFakeTimers();
        await watchTogether.broadcastSeek(12, true);
        vi.advanceTimersByTime(30_000);
        expect(watchTogether.seekResumeIntent(false)).toBe(false);
        vi.useRealTimers();
    });
});

describe('freezeCatchUpTarget — a host tab the browser froze catches up with the party', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        watchTogether.isHost = true;
        watchTogether.session = { ...fakeSession, isPlaying: true, currentTime: 20 };
    });

    const serverSession = (over: Partial<WatchTogetherParty>) =>
        ({
            data: { party: { ...fakeSession, isPlaying: true, playbackRate: 1, ...over } },
            error: null,
            status: 200,
        }) as never;

    it('targets where the party has got to, from its own freeze record', async () => {
        // Frozen at 20 s; the guests played on for 40 s. The target comes from the
        // host's own freeze record (same clock), never from server.lastSync: guest
        // heartbeats keep bumping lastSync while only the host moves currentTime, so
        // `currentTime + (now - lastSync)` pulled the whole party back ~40 s.
        const now = 1_000_000;
        vi.mocked(watchTogetherApi.getCurrentSession).mockResolvedValue(
            serverSession({ currentTime: 20, lastSync: now - 2_000 }),
        );
        expect(
            await watchTogether.freezeCatchUpTarget(
                { wasPlaying: true, position: 20, at: now - 40_000 },
                now,
            ),
        ).toBe(60);
    });

    it('does nothing when the party was paused meanwhile', async () => {
        vi.mocked(watchTogetherApi.getCurrentSession).mockResolvedValue(
            serverSession({ isPlaying: false, currentTime: 31, lastSync: 1 }),
        );
        expect(
            await watchTogether.freezeCatchUpTarget(
                { wasPlaying: true, position: 20, at: 1 },
                1_000_000,
            ),
        ).toBeNull();
        expect(vi.mocked(watchTogetherApi.broadcastSeek)).not.toHaveBeenCalled();
    });

    it('does nothing when the host itself was paused before the freeze', async () => {
        expect(
            await watchTogether.freezeCatchUpTarget(
                { wasPlaying: false, position: 20, at: 1 },
                1_000_000,
            ),
        ).toBeNull();
        expect(vi.mocked(watchTogetherApi.getCurrentSession)).not.toHaveBeenCalled();
    });

    it('does nothing for a guest', async () => {
        watchTogether.isHost = false;
        expect(
            await watchTogether.freezeCatchUpTarget(
                { wasPlaying: true, position: 20, at: 1 },
                1_000_000,
            ),
        ).toBeNull();
        expect(vi.mocked(watchTogetherApi.broadcastSeek)).not.toHaveBeenCalled();
    });

    it('does nothing when the server session is another party', async () => {
        vi.mocked(watchTogetherApi.getCurrentSession).mockResolvedValue(
            serverSession({ code: 'OTHER', currentTime: 20, lastSync: 1 }),
        );
        expect(
            await watchTogether.freezeCatchUpTarget(
                { wasPlaying: true, position: 20, at: 1 },
                1_000_000,
            ),
        ).toBeNull();
        expect(vi.mocked(watchTogetherApi.broadcastSeek)).not.toHaveBeenCalled();
    });
});

describe('host_position — a late or replayed position is aged, not taken as "now"', () => {
    type Internals = {
        handleSSEEvent(event: unknown): void;
        serverClockAtReceipt: number;
        serverClockReceiptMonotonic: number;
        serverClockUncertaintyMs: number;
        hostPosition: unknown;
    };
    const store = watchTogether as unknown as Internals;

    beforeEach(() => {
        vi.clearAllMocks();
        watchTogether.isHost = false;
        watchTogether.session = { ...fakeSession, isPlaying: true, currentTime: 0 };
        store.hostPosition = null;
        store.serverClockUncertaintyMs = 0;
    });

    it('a host_position sent 4 s ago extrapolates from when it was sent', () => {
        // Web e2e (network blip): after a reconnect the replay ring delivered a
        // host_position sent 4 s earlier. Anchored at receipt, the host looked 4 s
        // behind and the guest hard-seeked back from 8.3 s to 4.6 s.
        const serverNow = 5_000_000;
        store.serverClockAtReceipt = serverNow;
        store.serverClockReceiptMonotonic = performance.now();
        store.handleSSEEvent({
            type: 'host_position',
            position: 5,
            timestamp: serverNow - 4_000,
            isPlaying: true,
            playbackRate: 1,
        });
        expect(watchTogether.getExpectedHostPosition()).toBeCloseTo(9, 1);
    });

    it('a fresh host_position is taken as it is', () => {
        const serverNow = 5_000_000;
        store.serverClockAtReceipt = serverNow;
        store.serverClockReceiptMonotonic = performance.now();
        store.handleSSEEvent({
            type: 'host_position',
            position: 5,
            timestamp: serverNow,
            isPlaying: true,
            playbackRate: 1,
        });
        expect(watchTogether.getExpectedHostPosition()).toBeCloseTo(5, 1);
    });

    it('never ages a live position beyond what the clock estimate can vouch for', () => {
        // Browser <-> Apple TV e2e: on a cold dev server the SSE request waited seconds
        // in module loading before the server stamped it, so the NTP-midpoint estimate
        // ran AHEAD. Every live host_position then looked that much old and the web
        // guest sat ahead of the TV host (inside the compensator's tolerance). Only
        // age beyond the estimate's uncertainty (round trip / 2, capped at 1 s) counts.
        const serverNow = 5_000_000;
        store.serverClockAtReceipt = serverNow + 1_000; // estimate 1 s ahead
        store.serverClockReceiptMonotonic = performance.now();
        store.serverClockUncertaintyMs = 1_600; // round trip 3.2 s
        store.handleSSEEvent({
            type: 'host_position',
            position: 5,
            timestamp: serverNow, // actually fresh
            isPlaying: true,
            playbackRate: 1,
        });
        expect(watchTogether.getExpectedHostPosition()).toBeCloseTo(5, 1);
    });

    it('the 1 s cap bounds the over-aging of a very asymmetric handshake to its excess', () => {
        // Estimate 1.5 s ahead: the cap (which keeps old replays from passing as
        // live) leaves 0.5 s of over-aging — below the 1 s drift threshold.
        const serverNow = 5_000_000;
        store.serverClockAtReceipt = serverNow + 1_500;
        store.serverClockReceiptMonotonic = performance.now();
        store.serverClockUncertaintyMs = 1_600;
        store.handleSSEEvent({
            type: 'host_position',
            position: 5,
            timestamp: serverNow,
            isPlaying: true,
            playbackRate: 1,
        });
        expect(watchTogether.getExpectedHostPosition()).toBeCloseTo(5.5, 1);
    });

    it('still ages a replayed position by what exceeds that uncertainty', () => {
        const serverNow = 5_000_000;
        store.serverClockAtReceipt = serverNow;
        store.serverClockReceiptMonotonic = performance.now();
        store.serverClockUncertaintyMs = 300;
        store.handleSSEEvent({
            type: 'host_position',
            position: 5,
            timestamp: serverNow - 4_000,
            isPlaying: true,
            playbackRate: 1,
        });
        expect(watchTogether.getExpectedHostPosition()).toBeCloseTo(8.7, 1);
    });

    it('caps the uncertainty at 1 s, so a slow handshake cannot pass an old replay as live', () => {
        // A reconnect handshake that took 22 s (TLS, auth, cold server) would otherwise
        // allow 11 s of "uncertainty": an 11 s old replayed position counted as fresh
        // and the guest was pulled back 11 s (tvOS d8895000, same cap).
        const serverNow = 5_000_000;
        store.serverClockAtReceipt = serverNow;
        store.serverClockReceiptMonotonic = performance.now();
        store.serverClockUncertaintyMs = 11_000;
        store.handleSSEEvent({
            type: 'host_position',
            position: 5,
            timestamp: serverNow - 11_000,
            isPlaying: true,
            playbackRate: 1,
        });
        expect(watchTogether.getExpectedHostPosition()).toBeCloseTo(15, 1);
    });

    it('without a server clock estimate it falls back to receipt time', () => {
        store.serverClockAtReceipt = 0;
        store.handleSSEEvent({
            type: 'host_position',
            position: 5,
            timestamp: 123,
            isPlaying: true,
            playbackRate: 1,
        });
        expect(watchTogether.getExpectedHostPosition()).toBeCloseTo(5, 1);
    });
});

describe('connected — a reconnecting guest is not rewound by a stale snapshot', () => {
    // Web e2e (network blip [A hosts]): the guest stayed in sync through a 6 s
    // outage, then its reconnect snapshot carried the host's last heartbeat
    // position (up to one 5 s heartbeat old) as if it were current. The guest
    // seeked back ~4 s until the drift loop pulled it forward again.
    type Internals = {
        handleSSEEvent(event: unknown): void;
        hostPosition: unknown;
        lastConnectedBinding: string | null;
        pendingStartupSync: boolean;
        monotonicNow(): number;
        serverClockAtReceipt: number;
        serverClockReceiptMonotonic: number;
    };
    const store = watchTogether as unknown as Internals;
    let now = 100_000;
    let synced: Array<{ currentTime: number; isPlaying: boolean }>;

    beforeEach(() => {
        vi.clearAllMocks();
        now = 100_000;
        store.lastConnectedBinding = JSON.stringify([
            fakeSession.code,
            fakeSession.itemId,
            (fakeSession as WatchTogetherParty).timelineId,
            (fakeSession as WatchTogetherParty).fileId,
            fakeSession.hostClientId,
        ]);
        store.pendingStartupSync = false;
        playerStore.setPlaying(false);
        playerStore.setCurrentTime(0);
        vi.spyOn(store, 'monotonicNow').mockImplementation(() => now);
        watchTogether.isHost = false;
        watchTogether.session = { ...fakeSession, isPlaying: true, currentTime: 0 };
        // Host anchor: the host was at 5 s, playing, when this was received.
        store.hostPosition = {
            position: 5,
            timestamp: Date.now(),
            receivedAt: now,
            isPlaying: true,
            playbackRate: 1,
        };
        synced = [];
        watchTogether.onSync((s) => synced.push(s));
    });

    afterEach(() => {
        watchTogether.disconnect();
        vi.restoreAllMocks();
    });

    const reconnect = (session: Partial<WatchTogetherParty>, bufferCheck?: unknown) =>
        store.handleSSEEvent({
            type: 'connected',
            lastEventId: 0,
            party: { ...fakeSession, ...session },
            serverTime: Date.now(),
            requestReceivedAt: Date.now(),
            ...(bufferCheck ? { bufferCheck } : {}),
        });

    it('uses its own host estimate when the playing snapshot lags it by a heartbeat', () => {
        now += 4_000;
        reconnect({ currentTime: 5, isPlaying: true });
        expect(synced).toHaveLength(1);
        expect(synced[0].currentTime).toBeCloseTo(9, 1);
        expect(synced[0].isPlaying).toBe(true);
    });

    it('keeps the delivered playing clock after an outage outlives the host anchor', () => {
        reconnect({ currentTime: 5, isPlaying: true });
        playerStore.setPlaying(true);
        playerStore.setCurrentTime(35.5);
        now += 30_000;
        expect(watchTogether.getExpectedHostPosition()).toBeNull();
        reconnect({ currentTime: 30, isPlaying: true });
        expect(synced.at(-1)?.currentTime).toBe(35.5);
    });

    it.each([
        { timelineId: 'new-timeline' },
        { fileId: 'different-cut' },
        { hostClientId: 'new-host' },
        { code: 'NEW123' },
    ])('uses the canonical snapshot after the binding changes: %s', (change) => {
        reconnect({ currentTime: 5, isPlaying: true });
        playerStore.setPlaying(true);
        playerStore.setCurrentTime(35.5);
        now += 30_000;
        reconnect({ currentTime: 30, isPlaying: true, ...change });
        expect(synced.at(-1)?.currentTime).toBe(30);
    });

    it('uses the canonical snapshot for a freshly attached player', () => {
        reconnect({ currentTime: 5, isPlaying: true });
        playerStore.setPlaying(true);
        playerStore.setCurrentTime(35.5);
        now += 30_000;
        store.pendingStartupSync = true;
        reconnect({ currentTime: 30, isPlaying: true });
        expect(synced.at(-1)?.currentTime).toBe(30);
    });

    it('does not preserve a stopped clock, and waits for a fresh host report after a long outage', () => {
        reconnect({ currentTime: 5, isPlaying: true });
        playerStore.setCurrentTime(35.5);
        now += 30_000;
        reconnect({ currentTime: 30, isPlaying: true });
        expect(synced.at(-1)?.currentTime).toBe(30);
        playerStore.setPlaying(true);
        reconnect({ currentTime: 10, isPlaying: true });
        expect(synced.at(-1)?.currentTime).toBe(35.5);
        store.handleSSEEvent({
            type: 'host_position',
            position: 10,
            timestamp:
                store.serverClockAtReceipt + performance.now() - store.serverClockReceiptMonotonic,
            isPlaying: true,
            playbackRate: 1,
        });
        expect(watchTogether.getExpectedHostPosition()).toBeCloseTo(10, 1);
    });

    it('keeps pause and pending barrier authority after a long outage', () => {
        reconnect({ currentTime: 5, isPlaying: true });
        playerStore.setPlaying(true);
        playerStore.setCurrentTime(35.5);
        now += 30_000;
        reconnect({ currentTime: 30, isPlaying: false });
        expect(synced.at(-1)).toMatchObject({ currentTime: 30, isPlaying: false });
        reconnect(
            { currentTime: 30, isPlaying: true },
            { checkId: 'pending', currentTime: 30, isPlaying: true },
        );
        expect(synced.at(-1)).toMatchObject({ currentTime: 30, isPlaying: false });
    });

    it.each([
        { timelineId: 'new-timeline' },
        { fileId: 'different-cut' },
        { hostClientId: 'new-host' },
        { code: 'NEW123' },
    ])('discards an unexpired estimate after the binding changes: %s', (change) => {
        now += 4_000;
        expect(watchTogether.getExpectedHostPosition()).toBeCloseTo(9, 1);
        reconnect({ currentTime: 5, isPlaying: true, ...change });
        expect(synced.at(-1)?.currentTime).toBe(5);
        expect(watchTogether.getExpectedHostPosition()).toBeNull();
    });

    it('discards an unexpired estimate for a fresh player or first handshake', () => {
        now += 4_000;
        store.pendingStartupSync = true;
        reconnect({ currentTime: 5, isPlaying: true });
        expect(synced.at(-1)?.currentTime).toBe(5);
        expect(watchTogether.getExpectedHostPosition()).toBeNull();
        store.pendingStartupSync = false;
        store.lastConnectedBinding = null;
        store.hostPosition = {
            position: 5,
            receivedAt: now - 4000,
            isPlaying: true,
            playbackRate: 1,
        };
        reconnect({ currentTime: 5, isPlaying: true });
        expect(synced.at(-1)?.currentTime).toBe(5);
        expect(watchTogether.getExpectedHostPosition()).toBeNull();
    });

    it('trusts the snapshot when it is ahead of the estimate (host moved on)', () => {
        now += 4_000;
        reconnect({ currentTime: 60, isPlaying: true });
        expect(synced[0].currentTime).toBe(60);
    });

    it('trusts the snapshot when it lags by more than a heartbeat (host seeked back)', () => {
        now += 4_000;
        reconnect({ currentTime: 1, isPlaying: true });
        expect(synced[0].currentTime).toBe(1);
    });

    it('trusts a paused snapshot', () => {
        now += 4_000;
        reconnect({ currentTime: 5, isPlaying: false });
        expect(synced[0].currentTime).toBe(5);
        expect(synced[0].isPlaying).toBe(false);
    });

    it('trusts the snapshot without a host estimate, or for another item', () => {
        store.hostPosition = null;
        now += 4_000;
        reconnect({ currentTime: 5, isPlaying: true });
        expect(synced[0].currentTime).toBe(5);
        store.hostPosition = {
            position: 5,
            timestamp: Date.now(),
            receivedAt: now - 4_000,
            isPlaying: true,
            playbackRate: 1,
        };
        const navigate = vi.fn();
        watchTogether.onNavigate(navigate);
        reconnect({
            currentTime: 5,
            isPlaying: true,
            itemId: 'item-2',
            timelineId: 'new-item-timeline',
        } as never);
        expect(navigate).toHaveBeenCalledWith('item-2', expect.any(String), 'system', undefined);
        expect(synced).toHaveLength(1);
        watchTogether.attachLoadedNavigationPlayer('item-2');
        expect(synced[1].currentTime).toBe(5);
    });
});

describe('resync — replace local state from the session read', () => {
    const store = watchTogether as unknown as { handleSSEEvent(event: unknown): void };

    beforeEach(() => {
        vi.clearAllMocks();
        watchTogether.disconnect();
        watchTogether.session = { ...fakeSession };
    });

    afterEach(() => watchTogether.disconnect());

    it.each(['gap', 'ahead'])('re-reads the session for a %s cursor', async (reason) => {
        const session = {
            ...fakeSession,
            visibility: 'unlisted' as const,
            currentTime: 42,
            host: buildPublicAuthor(fakeSession.host.userId, 'New host', 'internal'),
            participants: [
                {
                    ...buildPublicAuthor(
                        '22222222-2222-4222-8222-222222222222',
                        'Guest',
                        'internal',
                    ),
                    clientId: 'client-guest',
                    joinedAt: 1,
                },
            ],
        };
        vi.mocked(watchTogetherApi.getSession).mockResolvedValue({
            data: { party: session },
            error: null,
            status: 200,
        });
        const sync = vi.fn();
        watchTogether.onSync(sync);

        store.handleSSEEvent({ type: 'resync', reason, lastEventId: 100 });
        await vi.waitFor(() => expect(watchTogether.session).toEqual(session));
        expect(watchTogetherApi.getSession).toHaveBeenCalledWith(fakeSession.code);
        expect(sync).toHaveBeenCalledWith(expect.objectContaining({ currentTime: 42 }));
    });

    it('ignores a session read that finishes after leaving', async () => {
        let finish!: (value: Awaited<ReturnType<typeof watchTogetherApi.getSession>>) => void;
        vi.mocked(watchTogetherApi.getSession).mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        store.handleSSEEvent({ type: 'resync', reason: 'gap', lastEventId: 100 });
        watchTogether.disconnect();
        finish({ data: { party: fakeSession }, error: null, status: 200 });
        await Promise.resolve();
        expect(watchTogether.session).toBeNull();
    });
});

describe('party visibility commands', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        watchTogether.disconnect();
    });

    afterEach(() => watchTogether.disconnect());

    it.each([undefined, 'listed'] as const)(
        'creates a party with visibility %s',
        async (visibility) => {
            vi.mocked(watchTogetherApi.createSession).mockResolvedValue({
                data: { party: fakeSession },
                error: null,
                status: 201,
            });
            const userId = '11111111-1111-4111-8111-111111111111';
            await watchTogether.createSession(
                'item-1',
                'movie',
                'Movie',
                userId,
                undefined,
                0,
                undefined,
                visibility,
            );
            expect(watchTogetherApi.createSession).toHaveBeenCalledWith(
                expect.objectContaining({ visibility: visibility ?? 'unlisted' }),
            );
        },
    );

    it('sends the visibility enum when the host lists a party', async () => {
        watchTogether.session = { ...fakeSession, visibility: 'unlisted' };
        watchTogether.isHost = true;
        vi.mocked(watchTogetherApi.setVisibility).mockResolvedValue({
            data: null,
            error: null,
            status: 204,
        });
        expect(await watchTogether.setVisibility('listed')).toBe(true);
        expect(watchTogetherApi.setVisibility).toHaveBeenCalledWith(fakeSession.code, {
            visibility: 'listed',
        });
        expect(watchTogether.session?.visibility).toBe('listed');
    });
});

it('an own canonical pause accepted after a peer Play also pauses its sender', async () => {
    watchTogether.session = { ...fakeSession, isPlaying: true };
    watchTogether.isHost = true;
    const sync = vi.fn();
    watchTogether.onSync(sync);
    vi.mocked(isOwnEvent).mockImplementation((clientId) => clientId === 'client-guest');
    let finish: () => void = () => {};
    vi.mocked(watchTogetherApi.syncPlayback).mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = () => resolve({ data: null, error: null, status: 204 });
            }),
    );
    const pause = watchTogether.syncPlaybackState(17, false);
    const events = watchTogether as unknown as { handleSSEEvent(event: SSEEventType): void };
    const author = buildPublicAuthor(fakeSession.host.userId, 'Host', 'internal');
    try {
        events.handleSSEEvent({
            type: 'sync',
            clientId: 'peer',
            author,
            state: { currentTime: 18, isPlaying: true, playbackRate: 1, timestamp: Date.now() },
        });
        expect(watchTogether.session?.isPlaying).toBe(true);
        events.handleSSEEvent({
            type: 'sync',
            clientId: 'client-guest',
            author,
            state: {
                currentTime: 17,
                isPlaying: false,
                playbackRate: 1,
                timestamp: Date.now() + 1,
            },
        });
        expect(watchTogether.session?.isPlaying).toBe(false);
        expect(sync).toHaveBeenLastCalledWith(expect.objectContaining({ isPlaying: false }));
    } finally {
        finish();
        await pause;
        vi.mocked(isOwnEvent).mockReturnValue(false);
        watchTogether.session = null;
    }
});

it('an older own confirmation preserves a newer queued seek', async () => {
    watchTogether.session = { ...fakeSession, isPlaying: true };
    watchTogether.isHost = true;
    vi.mocked(isOwnEvent).mockImplementation((clientId) => clientId === 'client-guest');
    await watchTogether.syncPlaybackState(17, false);
    let finish: () => void = () => {};
    vi.mocked(watchTogetherApi.broadcastSeek).mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = () => resolve({ data: null, error: null, status: 204 });
            }),
    );
    const first = watchTogether.broadcastSeek(12, true);
    await watchTogether.broadcastSeek(22, true);
    const events = watchTogether as unknown as { handleSSEEvent(event: SSEEventType): void };
    try {
        events.handleSSEEvent({
            type: 'sync',
            clientId: 'client-guest',
            author: fakeSession.host,
            state: { currentTime: 17, isPlaying: false, playbackRate: 1, timestamp: Date.now() },
        });
        finish();
        await first;
        expect(watchTogetherApi.broadcastSeek).toHaveBeenLastCalledWith(
            'ABCD',
            expect.objectContaining({ currentTime: 22, isPlaying: true }),
        );
    } finally {
        finish();
        await first;
        watchTogether.disconnect();
        vi.mocked(isOwnEvent).mockReturnValue(false);
    }
});

it('an ordinary own pause is not mistaken for an earlier watchdog recovery at the same position', async () => {
    watchTogether.session = { ...fakeSession, currentTime: 17, isPlaying: true };
    watchTogether.isHost = true;
    vi.mocked(isOwnEvent).mockImplementation((clientId) => clientId === 'client-guest');
    const inner = watchTogether as unknown as {
        rememberRecoverySync(code: string): string;
        handleSSEEvent(event: SSEEventType): void;
    };
    inner.rememberRecoverySync('ABCD');
    const sync = vi.fn();
    watchTogether.onSync(sync);
    try {
        inner.handleSSEEvent({
            type: 'sync',
            clientId: 'peer',
            author: fakeSession.host,
            state: { currentTime: 17, isPlaying: true, playbackRate: 1, timestamp: Date.now() },
        });
        inner.handleSSEEvent({
            type: 'sync',
            clientId: 'client-guest',
            author: fakeSession.host,
            state: {
                currentTime: 17,
                isPlaying: false,
                playbackRate: 1,
                timestamp: Date.now() + 1,
            },
        });
        expect(watchTogether.session?.isPlaying).toBe(false);
        expect(sync).toHaveBeenLastCalledWith(expect.objectContaining({ isPlaying: false }));
    } finally {
        watchTogether.disconnect();
        vi.mocked(isOwnEvent).mockReturnValue(false);
    }
});

it('disconnect and same-party rejoin detach old queued controls', async () => {
    watchTogether.session = { ...fakeSession, isPlaying: true };
    watchTogether.isHost = true;
    let finish: () => void = () => {};
    vi.mocked(watchTogetherApi.syncPlayback).mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = () => resolve({ data: null, error: null, status: 204 });
            }),
    );
    const first = watchTogether.syncPlaybackState(17, false);
    const stale = watchTogether.syncPlaybackState(17, true);
    watchTogether.disconnect();
    watchTogether.session = { ...fakeSession, isPlaying: true };
    watchTogether.isHost = true;
    const before = vi.mocked(watchTogetherApi.syncPlayback).mock.calls.length;
    await watchTogether.syncPlaybackState(18, false);
    expect(watchTogetherApi.syncPlayback).toHaveBeenCalledTimes(before + 1);
    finish();
    await first;
    await stale;
    expect(watchTogetherApi.syncPlayback).toHaveBeenCalledTimes(before + 1);
    watchTogether.disconnect();
});

it('an abandoned seek cannot block or clean up a rejoined sender', async () => {
    watchTogether.session = { ...fakeSession, isPlaying: true };
    watchTogether.isHost = true;
    let finishOld: () => void = () => {};
    let finishNew: () => void = () => {};
    vi.mocked(watchTogetherApi.broadcastSeek)
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishOld = () => resolve({ data: null, error: null, status: 204 });
                }),
        )
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishNew = () => resolve({ data: null, error: null, status: 204 });
                }),
        );
    const old = watchTogether.broadcastSeek(12, true);
    watchTogether.disconnect();
    watchTogether.session = { ...fakeSession, isPlaying: true };
    watchTogether.isHost = true;
    const before = vi.mocked(watchTogetherApi.broadcastSeek).mock.calls.length;
    const fresh = watchTogether.broadcastSeek(22, false);
    expect(watchTogetherApi.broadcastSeek).toHaveBeenCalledTimes(before + 1);
    await watchTogether.broadcastSeek(32, false);
    finishOld();
    await old;
    expect(watchTogetherApi.broadcastSeek).toHaveBeenCalledTimes(before + 1);
    finishNew();
    await fresh;
    expect(watchTogetherApi.broadcastSeek).toHaveBeenLastCalledWith(
        'ABCD',
        expect.objectContaining({ currentTime: 32, isPlaying: false }),
    );
    watchTogether.disconnect();
});

describe('playback frames are scoped to the accepted timeline', () => {
    const author = buildPublicAuthor('11111111-1111-4111-8111-111111111111', 'Host', 'internal');
    const receive = (event: unknown) =>
        (watchTogether as unknown as { handleSSEEvent(event: unknown): void }).handleSSEEvent(
            event,
        );
    beforeEach(() => {
        vi.clearAllMocks();
        watchTogether.session = { ...fakeSession, itemId: 'new-item', timelineId: 'new' };
        watchTogether.isHost = false;
        vi.mocked(watchTogetherApi.broadcastNavigate)
            .mockReset()
            .mockResolvedValue({ data: null, error: null, status: 204 } as never);
    });
    afterEach(() => watchTogether.disconnect());

    it('drops old playback frames before changing the new title or invoking callbacks', () => {
        const callback = vi.fn();
        watchTogether.onSync(callback);
        watchTogether.onSeek(callback);
        watchTogether.onBufferCheck(callback);
        watchTogether.onAllReady(callback);
        watchTogether.onHostPosition(callback);
        watchTogether.onStall(callback);
        watchTogether.onResume(callback);
        watchTogether.onVersionChange(callback);
        const now = Date.now();
        for (const frame of [
            {
                type: 'sync',
                state: { currentTime: 100, isPlaying: true, playbackRate: 1, timestamp: now },
                author,
                clientId: 'peer',
            },
            {
                type: 'buffer_check',
                checkId: 'old',
                currentTime: 100,
                isPlaying: true,
                initiator: 'system',
                seekInitiated: false,
            },
            {
                type: 'all_ready',
                checkId: 'old',
                currentTime: 100,
                isPlaying: true,
                resumeAt: now,
                serverTime: now,
            },
            {
                type: 'host_position',
                position: 100,
                timestamp: now,
                isPlaying: true,
                playbackRate: 1,
            },
            { type: 'stall', author, clientId: 'peer' },
            { type: 'resume' },
            { type: 'version_change', fileId: 'old-file', author, clientId: 'peer' },
        ])
            receive({ ...frame, timelineId: 'old' });
        expect(watchTogether.session).toMatchObject({
            itemId: 'new-item',
            timelineId: 'new',
            currentTime: 0,
            isPlaying: false,
        });
        expect(watchTogether.isStalled).toBe(false);
        expect(callback).not.toHaveBeenCalled();
    });

    it('preserves current pending frames and fences captured ownership across same-item navigation', async () => {
        watchTogether.session = { ...fakeSession, timelineId: 'old' };
        let finish!: (value: never) => void;
        vi.mocked(watchTogetherApi.broadcastNavigate).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const pending = watchTogether.broadcastNavigate('new-item', 'New', 'movie');
        const owns = watchTogether.captureNavigationOwnership();
        await Promise.resolve();
        const timelineId = vi.mocked(watchTogetherApi.broadcastNavigate).mock.lastCall![1]
            .timelineId;
        const sync = vi.fn();
        watchTogether.onSync(sync);
        receive({
            type: 'sync',
            timelineId,
            state: { currentTime: 12, isPlaying: true, playbackRate: 1, timestamp: Date.now() },
            author,
            clientId: 'peer',
        });
        expect(sync).not.toHaveBeenCalled();
        finish({ data: null, error: null, status: 204 } as never);
        expect(await pending).toBe(true);
        expect(watchTogether.session).toMatchObject({
            itemId: 'new-item',
            timelineId,
            currentTime: 12,
            isPlaying: true,
        });
        expect(owns()).toBe(true);
        expect(await watchTogether.broadcastNavigate('new-item', 'New', 'movie')).toBe(true);
        expect(owns()).toBe(false);
    });

    it('delivers a pending destination stall before its initial sync', async () => {
        watchTogether.session = { ...fakeSession, timelineId: 'old' };
        await watchTogether.broadcastNavigate('new-item', 'New', 'movie');
        const timelineId = watchTogether.session!.timelineId;
        const order: string[] = [];
        watchTogether.onStall(() => order.push('stall'));
        watchTogether.onSync(() => order.push('sync'));
        receive({ type: 'stall', timelineId, author, clientId: 'peer' });
        expect(order).toEqual([]);
        watchTogether.attachLoadedNavigationPlayer('new-item');
        expect(order).toEqual(['stall', 'sync']);
        expect(watchTogether.isStalled).toBe(true);
    });

    it('keeps the newer canonical pause instead of a saved completion at attachment', async () => {
        watchTogether.session = { ...fakeSession, timelineId: 'old' };
        await watchTogether.broadcastNavigate('new-item', 'New', 'movie');
        const timelineId = watchTogether.session!.timelineId;
        const sync = vi.fn(),
            ready = vi.fn();
        watchTogether.onSync(sync);
        watchTogether.onAllReady(ready);
        receive({
            type: 'buffer_check',
            timelineId,
            checkId: 'new-check',
            currentTime: 12,
            isPlaying: true,
            initiator: 'system',
            seekInitiated: false,
        });
        receive({
            type: 'all_ready',
            timelineId,
            checkId: 'new-check',
            currentTime: 12,
            isPlaying: true,
            resumeAt: Date.now() + 1500,
            serverTime: Date.now(),
        });
        receive({
            type: 'sync',
            timelineId,
            state: { currentTime: 45, isPlaying: false, playbackRate: 1, timestamp: Date.now() },
            author,
            clientId: 'peer',
        });
        watchTogether.attachLoadedNavigationPlayer('new-item');
        expect(ready).not.toHaveBeenCalled();
        expect(sync).toHaveBeenLastCalledWith(
            expect.objectContaining({ currentTime: 45, isPlaying: false }),
        );
    });

    it('suppresses old-player heartbeats and controls during same-item navigation', async () => {
        watchTogether.session = { ...fakeSession, timelineId: 'old' };
        watchTogether.isHost = true;
        let finish!: (value: never) => void;
        vi.mocked(watchTogetherApi.broadcastNavigate).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const pending = watchTogether.broadcastNavigate(fakeSession.itemId, 'Again', 'movie');
        await Promise.resolve();
        const timelineId = vi.mocked(watchTogetherApi.broadcastNavigate).mock.lastCall![1]
            .timelineId;
        receive({
            type: 'sync',
            timelineId,
            state: { currentTime: 0, isPlaying: false, playbackRate: 1, timestamp: Date.now() },
            author,
            clientId: 'peer',
        });
        await watchTogether.sendHeartbeat(100, true, fakeSession.itemId);
        await watchTogether.syncPlaybackState(100, true);
        await watchTogether.broadcastSeek(100, true);
        expect(watchTogetherApi.sendHeartbeat).not.toHaveBeenCalled();
        expect(watchTogetherApi.syncPlayback).not.toHaveBeenCalled();
        expect(watchTogetherApi.broadcastSeek).not.toHaveBeenCalled();
        finish({ data: null, error: null, status: 204 } as never);
        await pending;
        watchTogether.attachLoadedNavigationPlayer(fakeSession.itemId);
        await watchTogether.sendHeartbeat(0, false, fakeSession.itemId);
        expect(watchTogetherApi.sendHeartbeat).toHaveBeenCalledOnce();
    });

    it('invalidates the accepted cleanup while a superseding request still awaits its response', async () => {
        watchTogether.session = { ...fakeSession, timelineId: 'old' };
        const first = watchTogether.broadcastNavigate('first', 'First', 'movie');
        const owns = watchTogether.captureNavigationOwnership();
        await first;
        expect(owns()).toBe(true);
        let finish!: (value: never) => void;
        vi.mocked(watchTogetherApi.broadcastNavigate).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const second = watchTogether.broadcastNavigate('second', 'Second', 'movie');
        await Promise.resolve();
        expect(owns()).toBe(false);
        finish({ data: null, error: null, status: 204 } as never);
        await second;
        expect(owns()).toBe(false);
    });

    it('keeps reconnect playback on the destination snapshot until the new engine attaches', async () => {
        watchTogether.session = { ...fakeSession, timelineId: 'old' };
        await watchTogether.broadcastNavigate('new-item', 'New', 'movie');
        const timelineId = watchTogether.session!.timelineId;
        const sync = vi.fn(),
            ready = vi.fn();
        watchTogether.onSync(sync);
        watchTogether.onAllReady(ready);
        receive({
            type: 'buffer_check',
            timelineId,
            checkId: 'saved',
            currentTime: 12,
            isPlaying: true,
            initiator: 'system',
            seekInitiated: false,
        });
        receive({
            type: 'all_ready',
            timelineId,
            checkId: 'saved',
            currentTime: 12,
            isPlaying: true,
            resumeAt: Date.now() + 1500,
            serverTime: Date.now(),
        });
        receive({
            type: 'connected',
            party: { ...watchTogether.session!, currentTime: 45, isPlaying: false },
            lastEventId: 100,
            serverTime: Date.now(),
            requestReceivedAt: Date.now(),
            bufferCheck: null,
        });
        expect(sync).not.toHaveBeenCalled();
        expect(ready).not.toHaveBeenCalled();
        watchTogether.attachLoadedNavigationPlayer('new-item');
        expect(ready).not.toHaveBeenCalled();
        expect(sync).toHaveBeenLastCalledWith(
            expect.objectContaining({ currentTime: 45, isPlaying: false }),
        );
    });

    it.each(['navigate', 'connected', 'resync'])(
        'retargets an unloaded destination after same-item %s replacement',
        async (surface) => {
            watchTogether.session = { ...fakeSession, timelineId: 'old' };
            await watchTogether.broadcastNavigate('new-item', 'New', 'movie');
            const seek = vi.fn(),
                sync = vi.fn(),
                navigate = vi.fn();
            watchTogether.onSeek(seek);
            watchTogether.onSync(sync);
            watchTogether.onNavigate(navigate);
            receive({
                type: 'stall',
                timelineId: watchTogether.session!.timelineId,
                author,
                clientId: 'peer',
            });
            expect(watchTogether.isStalled).toBe(true);
            const party: WatchTogetherParty = {
                ...watchTogether.session!,
                timelineId: 'replacement',
                currentTime: 0,
                isPlaying: false,
            };
            if (surface === 'navigate')
                receive({
                    type: 'navigate',
                    itemId: party.itemId,
                    title: party.title,
                    mediaType: 'movie',
                    timelineId: party.timelineId,
                    author,
                    clientId: 'peer',
                });
            else if (surface === 'connected')
                receive({
                    type: 'connected',
                    party,
                    lastEventId: 0,
                    serverTime: Date.now(),
                    requestReceivedAt: Date.now(),
                });
            else {
                vi.mocked(watchTogetherApi.getSession).mockResolvedValueOnce({
                    data: { party },
                    error: null,
                    status: 200,
                } as never);
                receive({ type: 'resync', reason: 'replay_gap', lastEventId: 0 });
                for (let i = 0; i < 20 && !navigate.mock.calls.length; i++) await Promise.resolve();
            }
            expect(watchTogether.isStalled).toBe(false);
            expect(seek).not.toHaveBeenCalled();
            expect(sync).not.toHaveBeenCalled();
            expect(navigate).toHaveBeenCalledWith(
                party.itemId,
                party.title,
                expect.any(String),
                party.fileId,
                true,
            );
            watchTogether.attachLoadedNavigationPlayer(party.itemId);
            expect(sync).toHaveBeenCalledWith(
                expect.objectContaining({ currentTime: 0, isPlaying: false }),
            );
            await watchTogether.sendHeartbeat(0, false, party.itemId);
            expect(watchTogetherApi.sendHeartbeat).toHaveBeenCalledOnce();
        },
    );

    it.each(['connected', 'resync'])(
        'preserves a pending navigation across an unchanged predecessor %s snapshot',
        async (surface) => {
            const original: WatchTogetherParty = { ...fakeSession, timelineId: 'old' };
            watchTogether.session = original;
            let finish!: (value: never) => void;
            vi.mocked(watchTogetherApi.broadcastNavigate).mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finish = resolve;
                    }),
            );
            const request = watchTogether.broadcastNavigate('new-item', 'New', 'movie');
            await Promise.resolve();
            const navigate = vi.fn(),
                sync = vi.fn();
            watchTogether.onNavigate(navigate);
            watchTogether.onSync(sync);
            if (surface === 'connected')
                receive({
                    type: 'connected',
                    party: original,
                    lastEventId: 0,
                    serverTime: Date.now(),
                    requestReceivedAt: Date.now(),
                });
            else {
                vi.mocked(watchTogetherApi.getSession).mockResolvedValueOnce({
                    data: { party: original },
                    error: null,
                    status: 200,
                } as never);
                receive({ type: 'resync', reason: 'replay_gap', lastEventId: 0 });
                for (let i = 0; i < 20; i++) await Promise.resolve();
            }
            expect(navigate).not.toHaveBeenCalled();
            expect(sync).not.toHaveBeenCalled();
            finish({ data: null, error: null, status: 204 } as never);
            expect(await request).toBe(true);
            expect(watchTogether.session?.itemId).toBe('new-item');
        },
    );

    it.each(['connected', 'resync'])(
        'fences a delayed navigation acknowledgement after a newer canonical %s snapshot',
        async (surface) => {
            watchTogether.session = { ...fakeSession, timelineId: 'old' };
            let finish!: (value: never) => void;
            vi.mocked(watchTogetherApi.broadcastNavigate).mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finish = resolve;
                    }),
            );
            const request = watchTogether.broadcastNavigate('new-item', 'New', 'movie');
            await Promise.resolve();
            const canonical: WatchTogetherParty = {
                ...fakeSession,
                itemId: 'replacement',
                title: 'Replacement',
                timelineId: 'newer',
                currentTime: 31,
                isPlaying: false,
            };
            watchTogether.onNavigate(vi.fn());
            if (surface === 'connected')
                receive({
                    type: 'connected',
                    party: canonical,
                    lastEventId: 0,
                    serverTime: Date.now(),
                    requestReceivedAt: Date.now(),
                });
            else {
                vi.mocked(watchTogetherApi.getSession).mockResolvedValueOnce({
                    data: { party: canonical },
                    error: null,
                    status: 200,
                } as never);
                receive({ type: 'resync', reason: 'replay_gap', lastEventId: 0 });
                for (let i = 0; i < 20; i++) await Promise.resolve();
            }
            finish({ data: null, error: null, status: 204 } as never);
            expect(await request).toBe(false);
            expect(watchTogether.session).toMatchObject({
                itemId: 'replacement',
                timelineId: 'newer',
                currentTime: 31,
                isPlaying: false,
            });
        },
    );

    it('keeps the preceding queued navigation snapshot from cancelling the newest request', async () => {
        watchTogether.session = { ...fakeSession, timelineId: 'old' };
        let firstDone!: (value: never) => void, secondDone!: (value: never) => void;
        vi.mocked(watchTogetherApi.broadcastNavigate)
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        firstDone = resolve;
                    }),
            )
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        secondDone = resolve;
                    }),
            );
        const first = watchTogether.broadcastNavigate('first', 'First', 'movie');
        await Promise.resolve();
        const firstTimeline = vi.mocked(watchTogetherApi.broadcastNavigate).mock.lastCall![1]
            .timelineId;
        const predecessor: WatchTogetherParty = {
            ...fakeSession,
            itemId: 'first',
            title: 'First',
            timelineId: firstTimeline,
            currentTime: 0,
            isPlaying: false,
        };
        vi.mocked(watchTogetherApi.getSession).mockResolvedValueOnce({
            data: { party: predecessor },
            error: null,
            status: 200,
        } as never);
        const second = watchTogether.broadcastNavigate('second', 'Second', 'movie');
        firstDone({ data: null, error: null, status: 204 } as never);
        expect(await first).toBe(false);
        for (let i = 0; i < 30 && !secondDone; i++) await Promise.resolve();
        expect(secondDone).toBeDefined();
        const navigate = vi.fn();
        watchTogether.onNavigate(navigate);
        receive({
            type: 'connected',
            party: predecessor,
            lastEventId: 0,
            serverTime: Date.now(),
            requestReceivedAt: Date.now(),
        });
        expect(navigate).not.toHaveBeenCalled();
        secondDone({ data: null, error: null, status: 204 } as never);
        expect(await second).toBe(true);
        expect(watchTogether.session?.itemId).toBe('second');
    });

    it('supersedes an old failed-navigation recovery before a new request receives its predecessor snapshot', async () => {
        const original: WatchTogetherParty = { ...fakeSession, timelineId: 'old' };
        watchTogether.session = original;
        vi.mocked(watchTogetherApi.broadcastNavigate).mockResolvedValueOnce({
            data: null,
            error: new Error('forbidden'),
            status: 403,
        } as never);
        vi.mocked(watchTogetherApi.getSession).mockRejectedValueOnce(new Error('lookup offline'));
        expect(await watchTogether.broadcastNavigate('failed', 'Failed', 'movie')).toBe(false);
        let finish!: (value: never) => void;
        vi.mocked(watchTogetherApi.broadcastNavigate).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const request = watchTogether.broadcastNavigate('new-item', 'New', 'movie');
        await Promise.resolve();
        const navigate = vi.fn();
        watchTogether.onNavigate(navigate);
        receive({
            type: 'connected',
            party: original,
            lastEventId: 0,
            serverTime: Date.now(),
            requestReceivedAt: Date.now(),
        });
        expect(navigate).not.toHaveBeenCalled();
        finish({ data: null, error: null, status: 204 } as never);
        expect(await request).toBe(true);
        expect(watchTogether.session?.itemId).toBe('new-item');
        receive({
            type: 'connected',
            party: watchTogether.session!,
            lastEventId: 0,
            serverTime: Date.now(),
            requestReceivedAt: Date.now(),
        });
        expect(navigate).not.toHaveBeenCalled();
    });

    it('recovers the same-item destination from a connected frame after the recovery lookup fails', async () => {
        watchTogether.session = { ...fakeSession, timelineId: 'old' };
        const navigate = vi.fn();
        watchTogether.onNavigate(navigate);
        vi.mocked(watchTogetherApi.broadcastNavigate).mockResolvedValueOnce({
            data: null,
            error: new Error('forbidden'),
            status: 403,
        } as never);
        vi.mocked(watchTogetherApi.getSession).mockRejectedValueOnce(new Error('lookup offline'));
        expect(await watchTogether.broadcastNavigate('rejected', 'Rejected', 'movie')).toBe(false);
        const party: WatchTogetherParty = {
            ...fakeSession,
            timelineId: 'recovered',
            currentTime: 31,
            isPlaying: false,
        };
        receive({
            type: 'connected',
            party,
            lastEventId: 0,
            serverTime: Date.now(),
            requestReceivedAt: Date.now(),
        });
        expect(navigate).toHaveBeenCalledWith(
            party.itemId,
            party.title,
            party.host.userId,
            party.fileId,
            true,
        );
        expect(watchTogether.session).toMatchObject({
            itemId: party.itemId,
            timelineId: 'recovered',
            currentTime: 31,
            isPlaying: false,
        });
    });

    it('reloads the canonical destination when a later navigation is rejected', async () => {
        watchTogether.session = { ...fakeSession, timelineId: 'old' };
        const navigate = vi.fn();
        watchTogether.onNavigate(navigate);
        const first = watchTogether.broadcastNavigate('accepted', 'Accepted', 'movie');
        const owns = watchTogether.captureNavigationOwnership();
        expect(await first).toBe(true);
        const accepted = { ...watchTogether.session! };
        vi.mocked(watchTogetherApi.broadcastNavigate).mockResolvedValueOnce({
            data: null,
            error: new Error('forbidden'),
            status: 403,
        } as never);
        vi.mocked(watchTogetherApi.getSession).mockResolvedValueOnce({
            data: { party: accepted },
            error: null,
            status: 200,
        } as never);
        expect(await watchTogether.broadcastNavigate('rejected', 'Rejected', 'movie')).toBe(false);
        expect(owns()).toBe(false);
        expect(navigate).toHaveBeenCalledWith(
            accepted.itemId,
            accepted.title,
            accepted.host.userId,
            accepted.fileId,
            true,
        );
        expect(watchTogether.session).toMatchObject({
            itemId: 'accepted',
            timelineId: accepted.timelineId,
        });
    });

    it('defers current-timeline completion and resume until the destination engine is attached', async () => {
        watchTogether.session = { ...fakeSession, timelineId: 'old' };
        let finish!: (value: never) => void;
        vi.mocked(watchTogetherApi.broadcastNavigate).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const pending = watchTogether.broadcastNavigate('new-item', 'New', 'movie');
        await Promise.resolve();
        const timelineId = vi.mocked(watchTogetherApi.broadcastNavigate).mock.lastCall![1]
            .timelineId;
        const ready = vi.fn(),
            resume = vi.fn();
        watchTogether.onAllReady(ready);
        watchTogether.onResume(resume);
        receive({
            type: 'buffer_check',
            timelineId,
            checkId: 'new-check',
            currentTime: 12,
            isPlaying: true,
            initiator: 'system',
            seekInitiated: false,
        });
        receive({
            type: 'all_ready',
            timelineId,
            checkId: 'new-check',
            currentTime: 12,
            isPlaying: true,
            resumeAt: Date.now() + 1500,
            serverTime: Date.now(),
        });
        receive({ type: 'resume', timelineId });
        expect(ready).not.toHaveBeenCalled();
        expect(resume).not.toHaveBeenCalled();
        finish({ data: null, error: null, status: 204 } as never);
        await pending;
        watchTogether.attachLoadedNavigationPlayer('new-item');
        expect(ready).toHaveBeenCalledWith('new-check', 12, expect.any(Number), true);
    });
});
