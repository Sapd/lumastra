// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the WatchTogetherHandlers protocol phase state machine.
 *
 * Drives the handlers through the SSE callback surface with a fake store and
 * a fake VideoController, asserting the phase transitions and — critically —
 * that superseded phases can never fire their resources (stale resume timers,
 * orphaned buffer-poll loops).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWatchTogetherHandlers, type VideoController } from './watch-together-handlers';
import { goto } from '$app/navigation';
import type { WatchTogetherStore } from '$lib/stores/watchTogether.svelte';

vi.mock('$app/environment', () => ({ browser: false }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/paths', () => ({ resolve: (u: string) => u }));
const workerCallbacks = vi.hoisted(() => new Map<string, () => void>());

vi.mock('$lib/utils/worker-timer', () => ({
    WorkerTimer: class {
        start(name: string, cb: () => void) {
            workerCallbacks.set(name, cb);
        }
        dispose() {}
    },
}));

type SyncCb = (state: {
    currentTime: number;
    isPlaying: boolean;
    playbackRate: number;
    timestamp: number;
}) => void;

/** Minimal fake of the WatchTogetherStore callback/query surface. */
function createFakeStore() {
    const callbacks: Record<string, ((...args: never[]) => void) | undefined> = {};
    const signalReady = vi.fn();
    let currentCheckId = 'check-0';
    let checkSequence = 0;
    let sessionState: { currentTime: number; isPlaying: boolean } | null = {
        currentTime: 0,
        isPlaying: true,
    };

    const store = {
        onSync: (cb: SyncCb) => (callbacks.sync = cb as never),
        onSeek: (cb: never) => (callbacks.seek = cb),
        onNavigate: (cb: never) => (callbacks.navigate = cb),
        onSessionEnded: (cb: never) => (callbacks.sessionEnded = cb),
        onParticipantJoined: (cb: never) => (callbacks.participantJoined = cb),
        onParticipantLeft: (cb: never) => (callbacks.participantLeft = cb),
        onAction: (cb: never) => (callbacks.action = cb),
        onBufferCheck: (cb: never) => (callbacks.bufferCheck = cb),
        onAllReady: (cb: never) => (callbacks.allReady = cb),
        onReaction: (cb: never) => (callbacks.reaction = cb),
        onScreenEffect: (cb: never) => (callbacks.screenEffect = cb),
        onVersionChange: (cb: never) => (callbacks.versionChange = cb),
        onHostPosition: (cb: never) => (callbacks.hostPosition = cb),
        onHostChanged: (cb: never) => (callbacks.hostChanged = cb),
        onHostActivity: (cb: never) => (callbacks.hostActivity = cb),
        onStall: (cb: never) => (callbacks.stall = cb),
        onResume: (cb: never) => (callbacks.resume = cb),
        needsResync: (a: number, b: number) => Math.abs(a - b) > 2,
        signalReady,
        getSessionState: () => sessionState,
        setCatchUpMode: vi.fn(),
        setCurrentDrift: vi.fn(),
        setEffectivePlaybackRate: vi.fn(),
        isCatchUpPaused: () => false,
        getExpectedHostPosition: () => null,
        sendHeartbeat: vi.fn(),
        settleSeekIntent: vi.fn(),
        reportPosition: vi.fn(),
    };

    return {
        store: store as unknown as WatchTogetherStore,
        callbacks,
        signalReady,
        setSessionState(s: { currentTime: number; isPlaying: boolean } | null) {
            sessionState = s;
        },
        // Typed event injectors
        emitSync(state: { currentTime: number; isPlaying: boolean; playbackRate?: number }) {
            (callbacks.sync as unknown as SyncCb)({
                playbackRate: 1,
                timestamp: Date.now(),
                ...state,
            });
        },
        emitBufferCheck(targetTime: number, isPlaying = true, seekInitiated = false) {
            currentCheckId = `check-${++checkSequence}`;
            (
                callbacks.bufferCheck as unknown as (
                    id: string,
                    t: number,
                    i: string,
                    p: boolean,
                    s: boolean,
                ) => void
            )(currentCheckId, targetTime, 'test', isPlaying, seekInitiated);
            return currentCheckId;
        },
        emitAllReady(
            targetTime: number,
            resumeAt: number,
            isPlaying: boolean,
            checkId = currentCheckId,
        ) {
            (
                callbacks.allReady as unknown as (
                    id: string,
                    t: number,
                    r: number,
                    p: boolean,
                ) => void
            )(checkId, targetTime, resumeAt, isPlaying);
        },
        emitStall(userId = 'u1', username = 'User1') {
            (callbacks.stall as unknown as (u: string, n: string) => void)(userId, username);
        },
        emitResume() {
            (callbacks.resume as unknown as () => void)();
        },
    };
}

function createFakeController(
    opts: { currentTime?: number; buffered?: boolean; seekMovesPlayhead?: boolean } = {},
) {
    let paused = true;
    let currentTime = opts.currentTime ?? 100;
    const play = vi.fn(async () => {
        paused = false;
    });
    const pause = vi.fn(() => {
        paused = true;
    });
    const seekTo = vi.fn((t: number) => {
        if (opts.seekMovesPlayhead !== false) currentTime = t;
    });
    const controller: VideoController = {
        getCurrentTime: () => currentTime,
        seekTo,
        play,
        pause,
        isPaused: () => paused,
        getPlaybackRate: () => 1,
        setPlaybackRate: vi.fn(),
        getBuffered: () =>
            opts.buffered === false
                ? null
                : ({
                      length: 1,
                      start: () => 0,
                      end: () => 100000,
                  } as unknown as TimeRanges),
        getReadyState: () => 4,
        isReady: () => true,
        hasLiveSource: () => true,
    };
    return {
        controller,
        play,
        pause,
        seekTo,
        setPaused: (p: boolean) => (paused = p),
        setCurrentTime: (t: number) => (currentTime = t),
    };
}

function setup(opts: { isHost?: boolean; buffered?: boolean } = {}) {
    const fake = createFakeStore();
    const video = createFakeController({ buffered: opts.buffered });
    const handlers = createWatchTogetherHandlers({
        getItemId: () => 'item-1',
        isHost: () => opts.isHost ?? false,
        log: () => {},
    });
    handlers.setController(video.controller);
    handlers.registerHandlers(fake.store);
    handlers.markInitialSyncApplied();
    return { fake, video, handlers };
}

describe('WatchTogetherHandlers protocol phase machine', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('reloads a canonical recovery even when its item matches the stopped old player', () => {
        const { fake, handlers } = setup();
        const reload = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
        const navigate = fake.callbacks.navigate as unknown as (
            id: string,
            title: string,
            user: string,
            file: string | undefined,
            reload: boolean,
        ) => void;
        navigate('item-1', 'Recovered', 'peer', undefined, true);
        expect(reload).toHaveBeenCalledWith('/watch/item-1');
        reload.mockRestore();
        handlers.dispose();
    });

    it('keeps a group stall paused when a later play sync arrives', () => {
        const { fake, video, handlers } = setup();
        fake.emitStall();
        fake.emitSync({ currentTime: 100, isPlaying: true });
        expect(video.play).not.toHaveBeenCalled();
        handlers.dispose();
    });

    it('supersedes pending routes and cancels the previous title resume', async () => {
        const { fake, video, handlers } = setup();
        vi.mocked(goto).mockReset();
        let rejectOld!: (reason: Error) => void;
        vi.mocked(goto)
            .mockImplementationOnce(
                () =>
                    new Promise((_resolve, reject) => {
                        rejectOld = reject;
                    }),
            )
            .mockResolvedValue(undefined);
        fake.emitBufferCheck(100);
        fake.emitAllReady(100, 1500, true);
        const navigate = fake.callbacks.navigate as unknown as (
            id: string,
            title: string,
            user: string,
        ) => void;
        navigate('item-2', 'Second', 'peer');
        navigate('item-3', 'Third', 'peer');
        rejectOld(new Error('superseded'));
        await Promise.resolve();
        navigate('item-3', 'Third', 'peer');
        expect(goto).toHaveBeenCalledTimes(2);
        expect(goto).toHaveBeenLastCalledWith('/watch/item-3');
        await vi.advanceTimersByTimeAsync(3000);
        expect(video.play).not.toHaveBeenCalled();
        handlers.dispose();
    });

    it('same-item timeline recovery discards an old barrier before applying canonical playback', async () => {
        const { fake, video, handlers } = setup({ isHost: true });
        fake.emitBufferCheck(150, true);
        expect(handlers.getPhase()).toBe('buffer_check');
        (
            fake.callbacks.seek as unknown as (
                time: number,
                userId: string,
                playing: boolean,
                resetTimeline: boolean,
            ) => void
        )(0, 'system', true, true);
        fake.emitSync({ currentTime: 0, isPlaying: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(handlers.getPhase()).toBe('synced');
        expect(video.seekTo).toHaveBeenCalledWith(0, 'watch_party_seek');
        expect(video.play).toHaveBeenCalled();
        handlers.dispose();
    });

    it.each([-2.1, 2.1])(
        'recovers a %ss drift within 30 seconds and remains aligned',
        (initialDrift) => {
            const { fake, video, handlers } = setup();
            let hostPosition = 100;
            let guestPosition = hostPosition - initialDrift;
            let rate = 1;
            fake.store.getExpectedHostPosition = () => hostPosition;
            fake.store.isHostPlaying = () => true;
            video.controller.getPlaybackRate = () => rate;
            vi.mocked(video.controller.setPlaybackRate).mockImplementation((next) => {
                rate = next;
            });
            video.setPaused(false);
            video.setCurrentTime(guestPosition);
            handlers.setMediaDuration(4891);
            const cleanup = handlers.setupIntervals(
                fake.store,
                () => true,
                () => false,
                () => false,
            );
            for (let seconds = 2; seconds <= 90; seconds += 2) {
                hostPosition += 2;
                guestPosition += 2 * rate;
                video.setCurrentTime(guestPosition);
                vi.advanceTimersByTime(2000);
                workerCallbacks.get('syncCheck')!();
                expect(rate).toBeGreaterThanOrEqual(0.95);
                expect(rate).toBeLessThanOrEqual(1.05);
                if (seconds >= 30) expect(Math.abs(hostPosition - guestPosition)).toBeLessThan(1);
                if (seconds >= 40)
                    expect(Math.abs(hostPosition - guestPosition)).toBeLessThan(0.75);
                if (seconds >= 60) expect(Math.abs(hostPosition - guestPosition)).toBeLessThan(0.5);
            }
            expect(video.seekTo).not.toHaveBeenCalled();
            cleanup();
        },
    );

    it('uses the first moving host report to correct a delayed Play without a long rate chase', () => {
        const { fake, video, handlers } = setup();
        let hostPosition = 102;
        fake.store.getExpectedHostPosition = () => hostPosition;
        fake.store.isHostPlaying = () => true;
        video.setCurrentTime(100);
        fake.emitSync({ currentTime: 100, isPlaying: true });
        const cleanup = handlers.setupIntervals(
            fake.store,
            () => true,
            () => false,
            () => false,
        );
        workerCallbacks.get('syncCheck')!();
        expect(video.seekTo).not.toHaveBeenCalled();
        (
            fake.callbacks.hostPosition as unknown as
                | ((position: number, timestamp: number, playing: boolean, rate: number) => void)
                | undefined
        )?.(102, Date.now(), true, 1);
        workerCallbacks.get('syncCheck')!();
        expect(video.seekTo).toHaveBeenCalledWith(102.25, 'watch_party_hard_sync');
        expect(Math.abs(hostPosition - video.controller.getCurrentTime())).toBeLessThan(1);
        video.setCurrentTime(100.25);
        (
            fake.callbacks.hostPosition as unknown as (
                position: number,
                timestamp: number,
                playing: boolean,
                rate: number,
            ) => void
        )(102, Date.now(), true, 1);
        workerCallbacks.get('syncCheck')!();
        expect(video.seekTo).toHaveBeenCalledTimes(1);
        cleanup();
    });

    it('does not consume startup alignment before the media can advance', () => {
        const { fake, video, handlers } = setup();
        let hostPosition = 100.3;
        let readyState = 2;
        fake.store.getExpectedHostPosition = () => hostPosition;
        fake.store.isHostPlaying = () => true;
        video.controller.getReadyState = () => readyState;
        video.setCurrentTime(100);
        fake.emitSync({ currentTime: 100, isPlaying: true });
        const cleanup = handlers.setupIntervals(
            fake.store,
            () => true,
            () => false,
            () => false,
        );
        const hostReport = fake.callbacks.hostPosition as unknown as (
            position: number,
            timestamp: number,
            playing: boolean,
            rate: number,
        ) => void;
        hostReport(hostPosition, Date.now(), true, 1);
        workerCallbacks.get('syncCheck')!();
        expect(video.seekTo).not.toHaveBeenCalled();
        readyState = 4;
        hostPosition = 102;
        video.setCurrentTime(100.1);
        workerCallbacks.get('syncCheck')!();
        expect(video.seekTo).toHaveBeenCalledWith(102.25, 'watch_party_hard_sync');
        cleanup();
    });

    it('heartbeats preserve intent and target during both barrier and local resume wait', () => {
        const { fake, video, handlers } = setup({ isHost: true });
        const cleanup = handlers.setupIntervals(
            fake.store,
            () => true,
            () => false,
            () => true,
        );
        fake.emitBufferCheck(150, true, true);
        video.setCurrentTime(0);
        workerCallbacks.get('heartbeat')!();
        expect(fake.store.sendHeartbeat).toHaveBeenLastCalledWith(150, undefined, 'item-1');
        fake.emitAllReady(150, 1000, true);
        workerCallbacks.get('heartbeat')!();
        expect(fake.store.sendHeartbeat).toHaveBeenLastCalledWith(150, undefined, 'item-1');
        cleanup();
    });

    it('a local explicit pause cancels the resume while waiting for the target', async () => {
        const { fake, video, handlers } = setup({ isHost: true });
        const cleanup = handlers.setupIntervals(
            fake.store,
            () => true,
            () => false,
            () => true,
        );
        fake.emitBufferCheck(150, true, true);
        fake.emitAllReady(150, 500, true);
        fake.setSessionState({ currentTime: 150, isPlaying: false });
        video.setCurrentTime(150);
        await vi.advanceTimersByTimeAsync(2000);
        expect(video.play).not.toHaveBeenCalled();
        cleanup();
    });

    it('retains seek intent through a stall and settles only when stall playback starts', async () => {
        const { fake, handlers } = setup();
        const cleanup = handlers.setupIntervals(
            fake.store,
            () => true,
            () => false,
            () => false,
        );
        fake.emitBufferCheck(100);
        fake.emitStall();
        fake.emitAllReady(100, 500, true);
        await vi.advanceTimersByTimeAsync(500);
        expect(fake.store.settleSeekIntent).not.toHaveBeenCalled();
        workerCallbacks.get('heartbeat')!();
        expect(fake.store.sendHeartbeat).toHaveBeenLastCalledWith(100, undefined, 'item-1');
        fake.emitResume();
        await Promise.resolve();
        expect(fake.store.settleSeekIntent).toHaveBeenCalledOnce();
        cleanup();
    });

    it('holds intent and heartbeat authority until the play promise resolves', async () => {
        const { fake, video, handlers } = setup();
        const cleanup = handlers.setupIntervals(
            fake.store,
            () => true,
            () => false,
            () => false,
        );
        let finish!: () => void;
        video.play.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        fake.emitBufferCheck(100);
        fake.emitAllReady(100, 500, true);
        await vi.advanceTimersByTimeAsync(500);
        expect(fake.store.settleSeekIntent).not.toHaveBeenCalled();
        workerCallbacks.get('heartbeat')!();
        expect(fake.store.sendHeartbeat).toHaveBeenLastCalledWith(100, undefined, 'item-1');
        video.setPaused(false);
        finish();
        await Promise.resolve();
        expect(fake.store.settleSeekIntent).toHaveBeenCalledOnce();
        cleanup();
    });

    it('an old play completion cannot settle the intent of a newer barrier', async () => {
        const { fake, video, handlers } = setup();
        const cleanup = handlers.setupIntervals(
            fake.store,
            () => true,
            () => false,
            () => false,
        );
        let finish!: () => void;
        video.play.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        fake.emitBufferCheck(100);
        fake.emitAllReady(100, 0, true);
        await vi.advanceTimersByTimeAsync(1);
        fake.emitBufferCheck(150);
        video.setPaused(false);
        finish();
        await Promise.resolve();
        expect(fake.store.settleSeekIntent).not.toHaveBeenCalled();
        expect(handlers.getPhase()).toBe('buffer_check');
        cleanup();
    });

    it.each(['rejected', 'never resolves'])(
        'bounds a %s playback start without retry loops',
        async (failure) => {
            const { fake, video, handlers } = setup();
            const cleanup = handlers.setupIntervals(
                fake.store,
                () => true,
                () => false,
                () => false,
            );
            if (failure === 'rejected')
                video.play.mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'));
            else video.play.mockImplementationOnce(() => new Promise<void>(() => {}));
            fake.emitBufferCheck(100);
            fake.emitAllReady(100, 0, true);
            await vi.advanceTimersByTimeAsync(9000);
            expect(handlers.getPhase()).toBe('synced');
            expect(video.play).toHaveBeenCalledOnce();
            expect(fake.store.settleSeekIntent).toHaveBeenCalledOnce();
            cleanup();
        },
    );

    it.each(['rejection', 'pending'])(
        'settles retained intent on terminal stall-resume %s',
        async (failure) => {
            const { fake, video, handlers } = setup();
            const cleanup = handlers.setupIntervals(
                fake.store,
                () => true,
                () => false,
                () => false,
            );
            fake.emitBufferCheck(100);
            fake.emitStall();
            fake.emitAllReady(100, 0, true);
            await vi.advanceTimersByTimeAsync(1);
            expect(fake.store.settleSeekIntent).not.toHaveBeenCalled();
            if (failure === 'rejection')
                video.play.mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'));
            else video.play.mockImplementationOnce(() => new Promise<void>(() => {}));
            fake.emitResume();
            await vi.advanceTimersByTimeAsync(9000);
            expect(fake.store.settleSeekIntent).toHaveBeenCalledOnce();
            expect(video.play).toHaveBeenCalledOnce();
            cleanup();
        },
    );

    it('cancels stall-play deadlines and old completions on a new barrier', async () => {
        const { fake, video, handlers } = setup();
        const cleanup = handlers.setupIntervals(
            fake.store,
            () => true,
            () => false,
            () => false,
        );
        fake.emitStall();
        let finish!: () => void;
        video.play.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        fake.emitResume();
        fake.emitBufferCheck(150);
        await vi.advanceTimersByTimeAsync(9000);
        finish();
        await Promise.resolve();
        expect(fake.store.settleSeekIntent).not.toHaveBeenCalled();
        expect(handlers.getPhase()).toBe('buffer_check');
        cleanup();
        handlers.dispose();
    });

    it('walks synced → buffer_check → resuming → synced and plays exactly once', async () => {
        const { fake, video, handlers } = setup();

        expect(handlers.getPhase()).toBe('synced');

        fake.emitBufferCheck(50);
        expect(handlers.getPhase()).toBe('buffer_check');
        expect(video.pause).toHaveBeenCalled();
        // Guest seeks to the target before verifying the buffer
        expect(video.seekTo).toHaveBeenCalledWith(50, 'watch_party_sync');

        // Poll loop reports ready (buffer is full in the fake)
        await vi.advanceTimersByTimeAsync(300);
        expect(fake.signalReady).toHaveBeenCalledTimes(1);

        fake.emitAllReady(50, 500, true);
        expect(handlers.getPhase()).toBe('resuming');
        expect(handlers.isPlaybackHeld()).toBe(true);
        expect(video.play).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(600);
        expect(handlers.getPhase()).toBe('synced');
        expect(handlers.isPlaybackHeld()).toBe(false);
        expect(video.play).toHaveBeenCalledTimes(1);
    });

    it('resumes a playing initial guest snapshot when no buffer check follows', async () => {
        const fake = createFakeStore();
        const video = createFakeController();
        const handlers = createWatchTogetherHandlers({
            getItemId: () => 'item-1',
            isHost: () => false,
            log: () => {},
        });
        handlers.setController(video.controller);
        handlers.registerHandlers(fake.store);

        // This models the connected snapshot arriving before metadata/canplay.
        // Watch-party autoplay is disabled, so the initial sync itself must
        // restart playback when the server says the host is already playing.
        fake.emitSync({ currentTime: 50, isPlaying: true });

        expect(video.seekTo).toHaveBeenCalledWith(50, 'watch_party_sync');
        expect(video.pause).toHaveBeenCalledTimes(1);
        expect(video.play).toHaveBeenCalledTimes(1);
    });

    it('adopts the party playback rate on the initial guest snapshot', () => {
        const fake = createFakeStore();
        const video = createFakeController();
        const onPlaybackRateChange = vi.fn();
        const handlers = createWatchTogetherHandlers({
            getItemId: () => 'item-1',
            isHost: () => false,
            onPlaybackRateChange,
            log: () => {},
        });
        handlers.setController(video.controller);
        handlers.registerHandlers(fake.store);

        fake.emitSync({ currentTime: 50, isPlaying: true, playbackRate: 1.25 });

        // Compensation is clamped to +/-5% around the base rate, so a guest left
        // at 1.0 in a 1.25x party can never catch up.
        expect(onPlaybackRateChange).toHaveBeenCalledWith(1.25);
    });

    it('does not resume an initial guest snapshot while a barrier is open', () => {
        const fake = createFakeStore();
        const video = createFakeController();
        const handlers = createWatchTogetherHandlers({
            getItemId: () => 'item-1',
            isHost: () => false,
            log: () => {},
        });
        handlers.setController(video.controller);
        handlers.registerHandlers(fake.store);

        // A remount mid-party (host navigate) leaves the store's stream alive,
        // so this handler's FIRST sync can land inside an open barrier.
        fake.emitBufferCheck(50);
        expect(handlers.getPhase()).toBe('buffer_check');

        fake.emitSync({ currentTime: 50, isPlaying: true });

        // all_ready owns the coordinated resume - playing now would start early.
        expect(video.play).not.toHaveBeenCalled();
        expect(handlers.getPhase()).toBe('buffer_check');
    });

    it('does not resume an initial guest snapshot during a group stall', () => {
        const fake = createFakeStore();
        const video = createFakeController();
        const handlers = createWatchTogetherHandlers({
            getItemId: () => 'item-1',
            isHost: () => false,
            log: () => {},
        });
        handlers.setController(video.controller);
        handlers.registerHandlers(fake.store);

        fake.emitStall();
        fake.emitSync({ currentTime: 50, isPlaying: true });

        // onResume owns the post-stall resume and re-checks the group's intent.
        expect(video.play).not.toHaveBeenCalled();

        fake.emitResume();
        expect(video.play).toHaveBeenCalledTimes(1);
    });

    it('keeps a paused initial guest snapshot paused', () => {
        const fake = createFakeStore();
        const video = createFakeController();
        const handlers = createWatchTogetherHandlers({
            getItemId: () => 'item-1',
            isHost: () => false,
            log: () => {},
        });
        handlers.setController(video.controller);
        handlers.registerHandlers(fake.store);

        fake.emitSync({ currentTime: 50, isPlaying: false });

        expect(video.seekTo).toHaveBeenCalledWith(50, 'watch_party_sync');
        expect(video.pause).toHaveBeenCalledTimes(1);
        expect(video.play).not.toHaveBeenCalled();
    });

    it('host does not seek during buffer_check and reports its live position', async () => {
        const { fake, video } = setup({ isHost: true });
        fake.emitBufferCheck(50);
        expect(video.seekTo).not.toHaveBeenCalled();
        expect(video.pause).toHaveBeenCalled();

        // A join/resync barrier can begin at a stale session position. The host
        // is the authority and must acknowledge it with its actual playhead so
        // the server can retarget everyone rather than timing out at 50.
        await vi.advanceTimersByTimeAsync(300);
        expect(fake.signalReady).toHaveBeenCalledWith('check-1', 100);
    });

    it('does not stay paused forever when the playhead never reaches the target', async () => {
        const fake = createFakeStore();
        // A playhead that never lands on the barrier target — an HLS source
        // rebuild, or a target the local media simply cannot reach.
        const video = createFakeController({ currentTime: 100, seekMovesPlayhead: false });
        const handlers = createWatchTogetherHandlers({
            getItemId: () => 'item-1',
            isHost: () => false,
            log: () => {},
        });
        handlers.setController(video.controller);
        handlers.registerHandlers(fake.store);
        handlers.markInitialSyncApplied();

        fake.emitBufferCheck(50);
        // The barrier poll has MAX_BUFFER_WAIT_MS and signals ready regardless.
        await vi.advanceTimersByTimeAsync(9000);
        expect(fake.signalReady).toHaveBeenCalled();

        fake.emitAllReady(50, 0, true);
        expect(handlers.getPhase()).toBe('resuming');

        // The resume poll must not spin forever: the barrier is over, the store
        // cleared isSyncing, and catch-up sync refuses to run outside 'synced'.
        // Nothing else can ever resume this guest.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(video.play).toHaveBeenCalledTimes(1);
        expect(handlers.getPhase()).toBe('synced');
    });

    it('requires the host to reach the target for a seek-initiated barrier', async () => {
        const fake = createFakeStore();
        const video = createFakeController({ currentTime: 0, seekMovesPlayhead: false });
        const handlers = createWatchTogetherHandlers({
            getItemId: () => 'item-1',
            isHost: () => true,
            log: () => {},
        });
        handlers.setController(video.controller);
        handlers.registerHandlers(fake.store);
        handlers.markInitialSyncApplied();

        fake.emitBufferCheck(50, true, true);
        await vi.advanceTimersByTimeAsync(500);
        expect(fake.signalReady).not.toHaveBeenCalled();

        video.setCurrentTime(50);
        await vi.advanceTimersByTimeAsync(100);
        expect(fake.signalReady).toHaveBeenCalledWith('check-1', 50);
    });

    it('does not acknowledge a barrier from stale readyState while a rapid seek reset reads 0', async () => {
        const fake = createFakeStore();
        const video = createFakeController({ currentTime: 0, seekMovesPlayhead: false });
        const handlers = createWatchTogetherHandlers({
            getItemId: () => 'item-1',
            isHost: () => false,
            log: () => {},
        });
        handlers.setController(video.controller);
        handlers.registerHandlers(fake.store);
        handlers.markInitialSyncApplied();

        fake.emitBufferCheck(50);
        await vi.advanceTimersByTimeAsync(500);

        expect(video.seekTo).toHaveBeenCalledWith(50, 'watch_party_sync');
        expect(fake.signalReady).not.toHaveBeenCalled();

        video.setCurrentTime(50);
        await vi.advanceTimersByTimeAsync(100);

        expect(fake.signalReady).toHaveBeenCalledTimes(1);
    });

    it('keeps a timed-out barrier paused until a slow seek reaches its target', async () => {
        const fake = createFakeStore();
        const video = createFakeController({ currentTime: 0, seekMovesPlayhead: false });
        const handlers = createWatchTogetherHandlers({
            getItemId: () => 'item-1',
            isHost: () => false,
            log: () => {},
        });
        handlers.setController(video.controller);
        handlers.registerHandlers(fake.store);
        handlers.markInitialSyncApplied();

        fake.emitBufferCheck(50);
        fake.emitAllReady(50, 500, true);

        // The server's resume deadline has passed, but HLS is still reporting
        // its transient reset position. Do not play at 00:00.
        await vi.advanceTimersByTimeAsync(1000);
        expect(handlers.getPhase()).toBe('resuming');
        expect(video.play).not.toHaveBeenCalled();

        video.setCurrentTime(50);
        await vi.advanceTimersByTimeAsync(200);

        expect(handlers.getPhase()).toBe('synced');
        expect(video.play).toHaveBeenCalledTimes(1);
    });

    it('keeps target readiness armed while a stall overlaps a timed-out barrier', async () => {
        const fake = createFakeStore();
        const video = createFakeController({ currentTime: 0, seekMovesPlayhead: false });
        const handlers = createWatchTogetherHandlers({
            getItemId: () => 'item-1',
            isHost: () => false,
            log: () => {},
        });
        handlers.setController(video.controller);
        handlers.registerHandlers(fake.store);
        handlers.markInitialSyncApplied();

        fake.emitBufferCheck(50);
        fake.emitAllReady(50, 500, true);
        fake.emitStall();
        fake.emitResume();
        await vi.advanceTimersByTimeAsync(600);

        expect(handlers.getPhase()).toBe('resuming');
        expect(video.play).not.toHaveBeenCalled();

        video.setCurrentTime(50);
        await vi.advanceTimersByTimeAsync(100);
        expect(handlers.getPhase()).toBe('synced');
        expect(video.play).toHaveBeenCalledTimes(1);
    });

    it('a stall cancels a scheduled resume — the stale timer never plays', async () => {
        const { fake, video, handlers } = setup();

        fake.emitBufferCheck(50);
        fake.emitAllReady(50, 500, true);
        expect(handlers.getPhase()).toBe('resuming');

        fake.emitStall();
        expect(handlers.getPhase()).toBe('synced+stalled');

        await vi.advanceTimersByTimeAsync(1000);
        expect(video.play).not.toHaveBeenCalled();
    });

    it('a remote pause cancels a scheduled resume', async () => {
        const { fake, video, handlers } = setup();

        fake.emitBufferCheck(50);
        fake.emitAllReady(50, 500, true);
        fake.emitSync({ currentTime: 50, isPlaying: false });
        expect(handlers.getPhase()).toBe('synced');

        await vi.advanceTimersByTimeAsync(1000);
        expect(video.play).not.toHaveBeenCalled();
        expect(video.pause).toHaveBeenCalled();
    });

    it('all_ready(paused) cancels a previously scheduled resume', async () => {
        const { fake, video, handlers } = setup();

        fake.emitBufferCheck(50);
        fake.emitAllReady(50, 500, true);
        expect(handlers.getPhase()).toBe('resuming');

        // A second all_ready arrives with isPlaying=false (paused seek flow)
        fake.emitAllReady(50, 500, false);
        expect(handlers.getPhase()).toBe('synced');

        await vi.advanceTimersByTimeAsync(1000);
        expect(video.play).not.toHaveBeenCalled();
    });

    it('a newer buffer_check supersedes the old poll loop — ready is signalled once', async () => {
        const { fake } = setup({ buffered: false });

        fake.emitBufferCheck(50);
        // Old loop is still polling (nothing buffered, readyState mocked at 4 → it
        // WOULD signal; use two rapid checks to prove single signalling)
        fake.emitBufferCheck(80);

        await vi.advanceTimersByTimeAsync(500);
        // Only the second check's loop may signal; the first aborted on generation
        expect(fake.signalReady).toHaveBeenCalledTimes(1);
    });

    it('ignores all_ready from a superseded buffer check', async () => {
        const { fake, video, handlers } = setup();

        const oldCheckId = fake.emitBufferCheck(50);
        fake.emitBufferCheck(80);
        fake.emitAllReady(50, 0, true, oldCheckId);

        expect(handlers.getPhase()).toBe('buffer_check');
        expect(video.play).not.toHaveBeenCalled();
    });

    it('resume after stall respects a group that paused meanwhile', () => {
        const { fake, video, handlers } = setup();

        fake.emitStall();
        expect(handlers.getPhase()).toBe('synced+stalled');

        fake.setSessionState({ currentTime: 50, isPlaying: false });
        fake.emitResume();
        expect(handlers.getPhase()).toBe('synced');
        expect(video.play).not.toHaveBeenCalled();

        fake.emitStall();
        fake.setSessionState({ currentTime: 50, isPlaying: true });
        fake.emitResume();
        expect(video.play).toHaveBeenCalledTimes(1);
    });

    it('a stall during buffer_check keeps the check alive (orthogonal overlay)', async () => {
        const { fake, handlers } = setup();

        fake.emitBufferCheck(50);
        fake.emitStall();
        expect(handlers.getPhase()).toBe('buffer_check+stalled');

        // The poll loop still signals ready — the stall must not starve the
        // server's buffer-check barrier
        await vi.advanceTimersByTimeAsync(300);
        expect(fake.signalReady).toHaveBeenCalledTimes(1);
    });

    it('a play sync during buffer_check does not start playback early', async () => {
        const { fake, video, handlers } = setup();

        fake.emitBufferCheck(50);
        expect(handlers.getPhase()).toBe('buffer_check');

        fake.emitSync({ currentTime: 50, isPlaying: true });
        expect(video.play).not.toHaveBeenCalled();
        expect(handlers.getPhase()).toBe('buffer_check');
    });

    it('a resume event during buffer_check defers playback to all_ready', async () => {
        const { fake, video, handlers } = setup();

        fake.emitBufferCheck(50);
        fake.emitStall();
        expect(handlers.getPhase()).toBe('buffer_check+stalled');

        fake.emitResume();
        // Overlay cleared, but playback is owned by the all_ready flow
        expect(handlers.getPhase()).toBe('buffer_check');
        expect(video.play).not.toHaveBeenCalled();

        fake.emitAllReady(50, 500, true);
        await vi.advanceTimersByTimeAsync(600);
        expect(video.play).toHaveBeenCalledTimes(1);
    });

    it('phase transitions still happen when the controller is not ready', async () => {
        const { fake, handlers } = setup();
        handlers.setController(null);

        fake.emitBufferCheck(50);
        expect(handlers.getPhase()).toBe('buffer_check');

        fake.emitAllReady(50, 500, true);
        expect(handlers.getPhase()).toBe('resuming');

        await vi.advanceTimersByTimeAsync(600);
        expect(handlers.getPhase()).toBe('synced');
    });

    it('resetState and dispose abort loops and clear the phase', async () => {
        const { fake, video, handlers } = setup();

        fake.emitBufferCheck(50);
        fake.emitAllReady(50, 500, true);
        handlers.resetState();
        expect(handlers.getPhase()).toBe('synced');

        await vi.advanceTimersByTimeAsync(1000);
        expect(video.play).not.toHaveBeenCalled();
        expect(fake.signalReady).not.toHaveBeenCalled();
    });
});

// WebKit can leave the play() promise pending while the element is in fact
// playing (seen in the Watch Together e2e on direct play). The start deadline
// must look at the element, not only at the promise, or it pauses a healthy
// party member and shows "Playback did not start".
describe('WatchTogetherHandlers play deadlines with a pending play() promise', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    function setupWithPlayError() {
        const fake = createFakeStore();
        const video = createFakeController();
        const onPlayError = vi.fn();
        const handlers = createWatchTogetherHandlers({
            getItemId: () => 'item-1',
            isHost: () => false,
            log: () => {},
            onPlayError,
        });
        handlers.setController(video.controller);
        handlers.registerHandlers(fake.store);
        handlers.markInitialSyncApplied();
        const cleanup = handlers.setupIntervals(
            fake.store,
            () => true,
            () => false,
            () => false,
        );
        return { fake, video, handlers, onPlayError, cleanup };
    }

    function pendingPlayThatStartsTheElement(video: ReturnType<typeof createFakeController>) {
        video.play.mockImplementationOnce(() => {
            video.setPaused(false);
            return new Promise<void>(() => {});
        });
    }

    it('does not pause a member whose element is playing when the start deadline fires', async () => {
        const { fake, video, handlers, onPlayError, cleanup } = setupWithPlayError();
        pendingPlayThatStartsTheElement(video);
        fake.emitBufferCheck(100);
        fake.emitAllReady(100, 500, true);
        await vi.advanceTimersByTimeAsync(600);
        expect(video.play).toHaveBeenCalledTimes(1);
        video.setCurrentTime(107);
        await vi.advanceTimersByTimeAsync(8000);
        expect(onPlayError).not.toHaveBeenCalled();
        expect(video.pause).toHaveBeenCalledTimes(1); // only the buffer-check pause
        expect(handlers.getPhase()).toBe('synced');
        expect(fake.store.settleSeekIntent).toHaveBeenCalledOnce();
        cleanup();
    });

    it('settles as soon as the element plays, long before the start deadline', async () => {
        const { fake, video, handlers, onPlayError, cleanup } = setupWithPlayError();
        pendingPlayThatStartsTheElement(video);
        fake.emitBufferCheck(100);
        fake.emitAllReady(100, 500, true);
        await vi.advanceTimersByTimeAsync(600);
        expect(handlers.getPhase()).toBe('resuming');
        video.setCurrentTime(100.6);
        await vi.advanceTimersByTimeAsync(600);
        expect(handlers.getPhase()).toBe('synced');
        expect(fake.store.settleSeekIntent).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(8000);
        expect(onPlayError).not.toHaveBeenCalled();
        expect(fake.store.settleSeekIntent).toHaveBeenCalledOnce();
        cleanup();
    });

    it('settles a stall restart as soon as the element plays', async () => {
        const { fake, video, onPlayError, cleanup } = setupWithPlayError();
        fake.emitStall();
        pendingPlayThatStartsTheElement(video);
        fake.emitResume();
        video.setCurrentTime(100.6);
        await vi.advanceTimersByTimeAsync(600);
        expect(fake.store.settleSeekIntent).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(8000);
        expect(onPlayError).not.toHaveBeenCalled();
        expect(fake.store.settleSeekIntent).toHaveBeenCalledOnce();
        cleanup();
    });

    it('still pauses and reports when the element never started', async () => {
        const { fake, video, handlers, onPlayError } = setupWithPlayError();
        video.play.mockImplementationOnce(() => new Promise<void>(() => {}));
        fake.emitBufferCheck(100);
        fake.emitAllReady(100, 500, true);
        await vi.advanceTimersByTimeAsync(600 + 8000);
        expect(onPlayError).toHaveBeenCalledOnce();
        expect(video.pause).toHaveBeenCalledTimes(2);
        expect(handlers.getPhase()).toBe('synced');
    });

    it('does not pause a playing member when the stall-restart deadline fires', async () => {
        const { fake, video, onPlayError, cleanup } = setupWithPlayError();
        fake.emitStall();
        const pausesBeforeResume = video.pause.mock.calls.length;
        pendingPlayThatStartsTheElement(video);
        fake.emitResume();
        expect(video.play).toHaveBeenCalledTimes(1);
        video.setCurrentTime(107);
        await vi.advanceTimersByTimeAsync(8000);
        expect(onPlayError).not.toHaveBeenCalled();
        expect(video.pause).toHaveBeenCalledTimes(pausesBeforeResume);
        expect(fake.store.settleSeekIntent).toHaveBeenCalledOnce();
        cleanup();
    });
});

it('a source replacement cannot publish its temporary zero, drift, or apply an early Play', () => {
    const fake = createFakeStore();
    const video = createFakeController({ currentTime: 0 });
    let replacing = true;
    const handlers = createWatchTogetherHandlers({
        getItemId: () => 'item-1',
        isHost: () => true,
        isSourceReplacing: () => replacing,
    });
    handlers.setController(video.controller);
    handlers.registerHandlers(fake.store);
    handlers.markInitialSyncApplied();
    const cleanup = handlers.setupIntervals(
        fake.store,
        () => true,
        () => false,
        () => true,
    );
    workerCallbacks.get('heartbeat')!();
    workerCallbacks.get('driftCheck')!();
    fake.emitSync({ currentTime: 60, isPlaying: true });
    expect(fake.store.sendHeartbeat).not.toHaveBeenCalled();
    expect(fake.store.reportPosition).not.toHaveBeenCalled();
    expect(video.play).not.toHaveBeenCalled();
    fake.setSessionState({ currentTime: 60, isPlaying: false });
    replacing = false;
    handlers.reapplyCurrentPartyState(fake.store);
    expect(video.pause).toHaveBeenCalled();
    expect(video.play).not.toHaveBeenCalled();
    video.setCurrentTime(60);
    workerCallbacks.get('heartbeat')!();
    expect(fake.store.sendHeartbeat).toHaveBeenCalledWith(60, false, 'item-1');
    cleanup();
    handlers.dispose();
});

it('a synchronized resume waits through source replacement and a newer replacement retires old timers', async () => {
    vi.useFakeTimers();
    const fake = createFakeStore();
    const video = createFakeController();
    let replacing = false;
    const handlers = createWatchTogetherHandlers({
        getItemId: () => 'item-1',
        isHost: () => false,
        isSourceReplacing: () => replacing,
    });
    handlers.setController(video.controller);
    handlers.registerHandlers(fake.store);
    handlers.markInitialSyncApplied();
    try {
        fake.emitBufferCheck(50);
        await vi.advanceTimersByTimeAsync(300);
        replacing = true;
        fake.emitAllReady(50, 100, true);
        await vi.advanceTimersByTimeAsync(12000);
        expect(video.play).not.toHaveBeenCalled();
        expect(handlers.getPhase()).toBe('resuming');
        handlers.prepareSourceReplacement();
        expect(handlers.getPhase()).toBe('synced');
        await vi.advanceTimersByTimeAsync(1000);
        expect(video.play).not.toHaveBeenCalled();
        replacing = false;
        handlers.reapplyCurrentPartyState(fake.store);
        expect(video.play).toHaveBeenCalledOnce();
    } finally {
        handlers.dispose();
        vi.clearAllTimers();
        vi.useRealTimers();
    }
});

it.each([true, false])('a restored guest adopts latest authority with playing=%s', (playing) => {
    const fake = createFakeStore();
    const video = createFakeController({ currentTime: 58 });
    fake.setSessionState({ currentTime: 60, isPlaying: playing });
    vi.spyOn(fake.store, 'getExpectedHostPosition').mockReturnValue(65);
    const handlers = createWatchTogetherHandlers({
        getItemId: () => 'item-1',
        isHost: () => false,
    });
    handlers.setController(video.controller);
    handlers.reapplyCurrentPartyState(fake.store);
    expect(video.seekTo).toHaveBeenCalledWith(playing ? 65 : 60, 'watch_party_sync');
    expect(video.play).toHaveBeenCalledTimes(playing ? 1 : 0);
    handlers.dispose();
});
