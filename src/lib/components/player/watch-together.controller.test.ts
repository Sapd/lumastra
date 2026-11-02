// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { buildPublicAuthor } from '$lib/shared/public-author';

// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

import { WatchTogetherController } from './watch-together.controller';
import { goto } from '$app/navigation';
import { WatchTogetherHandlers } from './watch-together-handlers';
import type { WatchTogetherControllerDeps } from './watch-together.controller';
import { watchTogether } from '$lib/stores/watchTogether.svelte';
import type { WatchTogetherParty } from '$lib/schemas/watch-together-core-types';

const STALL_TIMEOUT_MS = 2000;

function session(): WatchTogetherParty {
    return {
        code: 'ABC123',
        host: buildPublicAuthor('11111111-1111-4111-8111-111111111111', 'host', 'internal'),
        itemId: 'item-1',
        mediaType: 'movie',
        title: 'X',
        currentTime: 0,
        isPlaying: false,
        playbackRate: 1,
        createdAt: 0,
        lastSync: 0,
        visibility: 'unlisted',
        participants: [],
    };
}

function makeController(videoPaused: boolean): WatchTogetherController {
    const deps = {
        getVideoElement: () => ({ paused: videoPaused }) as HTMLVideoElement,
        log: () => {},
    } as unknown as WatchTogetherControllerDeps;
    return new WatchTogetherController(deps);
}

describe('WatchTogetherController stall detection vs pause', () => {
    let reportStall: ReturnType<typeof vi.spyOn>;
    let reportReady: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.useFakeTimers();
        // In a watch party (isInWatchParty === session !== null).
        watchTogether.session = session();
        reportStall = vi.spyOn(watchTogether, 'reportStall').mockResolvedValue(true);
        reportReady = vi.spyOn(watchTogether, 'reportReady').mockResolvedValue(true);
    });

    afterEach(() => {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
        watchTogether.session = null;
    });

    it('retains the waiting player timeline when its delayed stall report fires', () => {
        watchTogether.session = { ...session(), timelineId: 'old' };
        const controller = makeController(false);
        controller.onWaiting();
        watchTogether.session = { ...session(), timelineId: 'new' };
        vi.advanceTimersByTime(STALL_TIMEOUT_MS);
        expect(reportStall).toHaveBeenCalledWith(expect.any(String), 'old');
        controller.clearStallTimer();
    });

    it('does NOT report a stall when a `waiting` fires while the video is paused', () => {
        const c = makeController(/* videoPaused */ true);
        c.onWaiting();
        vi.advanceTimersByTime(STALL_TIMEOUT_MS + 500);
        expect(reportStall).not.toHaveBeenCalled();
    });

    it('reports a stall when `waiting` fires while the video is playing', () => {
        const c = makeController(/* videoPaused */ false);
        c.onWaiting();
        vi.advanceTimersByTime(STALL_TIMEOUT_MS + 500);
        expect(reportStall).toHaveBeenCalledTimes(1);
    });

    it('onPause cancels a pending stall timer (no stall reported)', () => {
        const c = makeController(/* videoPaused */ false);
        c.onWaiting(); // arm the 2s timer
        c.onPause(); // pause before it fires
        vi.advanceTimersByTime(STALL_TIMEOUT_MS + 500);
        expect(reportStall).not.toHaveBeenCalled();
    });

    it('onPause reports ready if a stall had already been reported', async () => {
        const c = makeController(/* videoPaused */ false);
        c.onWaiting();
        vi.advanceTimersByTime(STALL_TIMEOUT_MS + 500); // stall fires
        expect(reportStall).toHaveBeenCalledTimes(1);
        c.onPause();
        await vi.advanceTimersByTimeAsync(0);
        expect(reportReady).toHaveBeenCalledTimes(1);
    });

    it('keeps retrying recovery until the matching stall is acknowledged', async () => {
        reportReady
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(false)
            .mockResolvedValue(true);
        const c = makeController(false);
        c.onWaiting();
        await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 1);
        c.onPlaying();
        await vi.advanceTimersByTimeAsync(1_600);
        expect(reportReady).toHaveBeenCalledTimes(3);
        expect(reportReady.mock.calls[0]?.[0]).toBe(reportStall.mock.calls[0]?.[0]);
        expect(c.hasReportedStall).toBe(false);
    });

    it('uses a new generation when playback stalls again during recovery', async () => {
        reportReady.mockImplementation(() => new Promise(() => {}));
        const c = makeController(false);
        c.onWaiting();
        await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 1);
        c.onPlaying();
        c.onWaiting();
        await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 1);
        expect(reportStall).toHaveBeenCalledTimes(2);
        expect(reportStall.mock.calls[1]?.[0]).not.toBe(reportStall.mock.calls[0]?.[0]);
        c.dispose();
    });
});

describe('WatchTogetherController stall detection — engines that skip `playing`', () => {
    // Web e2e 2026-10-02 (WebKit/GStreamer): `waiting` fired, playback carried on
    // without a matching `playing`, the stall was reported and never cleared — the
    // whole party sat paused for ~30 s while the WebKit player kept playing.
    let reportStall: ReturnType<typeof vi.spyOn>;
    let reportReady: ReturnType<typeof vi.spyOn>;
    const video = { paused: false, currentTime: 10 } as { paused: boolean; currentTime: number };
    const make = () =>
        new WatchTogetherController({
            getVideoElement: () => video as unknown as HTMLVideoElement,
            log: () => {},
        } as unknown as WatchTogetherControllerDeps);

    beforeEach(() => {
        vi.useFakeTimers();
        watchTogether.session = session();
        video.paused = false;
        video.currentTime = 10;
        reportStall = vi.spyOn(watchTogether, 'reportStall').mockResolvedValue(true);
        reportReady = vi.spyOn(watchTogether, 'reportReady').mockResolvedValue(true);
    });

    afterEach(() => {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
        watchTogether.session = null;
    });

    it('a `waiting` the playhead moved past is not reported as a stall', () => {
        const c = make();
        c.onWaiting();
        video.currentTime = 11.5; // kept playing, no `playing` event
        vi.advanceTimersByTime(STALL_TIMEOUT_MS + 500);
        expect(reportStall).not.toHaveBeenCalled();
    });

    it('a reported stall clears once the playhead moves again, even without `playing`', async () => {
        const c = make();
        c.onWaiting();
        vi.advanceTimersByTime(STALL_TIMEOUT_MS + 500); // stuck at 10 -> reported
        expect(reportStall).toHaveBeenCalledTimes(1);
        video.currentTime = 10.8;
        c.onTimeUpdate();
        await vi.runOnlyPendingTimersAsync();
        expect(reportReady).toHaveBeenCalled();
    });

    it('a real stall (playhead stuck) is still reported and stays until it moves', () => {
        const c = make();
        c.onWaiting();
        vi.advanceTimersByTime(STALL_TIMEOUT_MS + 500);
        c.onTimeUpdate(); // same position
        expect(reportStall).toHaveBeenCalledTimes(1);
        expect(reportReady).not.toHaveBeenCalled();
    });
});

describe('party zero position on rejoin', () => {
    it.each([true, false])(
        'requires host navigation acknowledgement before loading a different item (%s)',
        async (accepted) => {
            watchTogether.session = session();
            vi.spyOn(watchTogether, 'isHost', 'get').mockReturnValue(true);
            const navigate = vi
                .spyOn(watchTogether, 'broadcastNavigate')
                .mockResolvedValue(accepted);
            const c = new WatchTogetherController({
                getPlaybackInfo: () => ({ itemId: 'item-2', title: 'Next', mediaType: 'episode' }),
                log: vi.fn(),
            } as unknown as WatchTogetherControllerDeps);
            expect(await c.reconcileRestoredItem()).toBe(accepted);
            expect(navigate).toHaveBeenCalledWith('item-2', 'Next', 'episode', undefined);
            c.dispose();
        },
    );

    it('redirects a guest to the party item without continuing the wrong playback', async () => {
        watchTogether.session = { ...session(), fileId: 'party-file' };
        vi.spyOn(watchTogether, 'isHost', 'get').mockReturnValue(false);
        const navigate = vi.spyOn(watchTogether, 'broadcastNavigate');
        const c = new WatchTogetherController({
            getPlaybackInfo: () => ({ itemId: 'item-2' }),
            log: vi.fn(),
        } as unknown as WatchTogetherControllerDeps);
        expect(await c.reconcileRestoredItem()).toBe(false);
        expect(goto).toHaveBeenCalledWith('/watch/item-1?fileId=party-file');
        expect(navigate).not.toHaveBeenCalled();
        c.dispose();
    });

    afterEach(() => {
        watchTogether.session = null;
        vi.restoreAllMocks();
    });
    it('does not restore or start heartbeat intervals after disposal during rejoin', async () => {
        let finish!: (value: boolean) => void;
        vi.spyOn(watchTogether, 'tryRejoinFromStorage').mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const intervals = vi.spyOn(WatchTogetherHandlers.prototype, 'setupIntervals');
        const getPlaybackInfo = vi.fn();
        const controller = new WatchTogetherController({
            getItemId: () => 'item-1',
            getPlaybackInfo,
            getVideoElement: () => null,
            log: vi.fn(),
        } as unknown as WatchTogetherControllerDeps);
        const setup = controller.setupInMount('host');
        controller.dispose();
        finish(true);
        expect(await setup).toBeUndefined();
        expect(intervals).not.toHaveBeenCalled();
        expect(getPlaybackInfo).not.toHaveBeenCalled();
    });

    it('waits for canonical host restoration before starting heartbeat intervals', async () => {
        let finishRejoin!: () => void;
        watchTogether.session = null;
        vi.spyOn(watchTogether, 'isHost', 'get').mockReturnValue(true);
        vi.spyOn(watchTogether, 'tryRejoinFromStorage').mockImplementationOnce(async () => {
            await new Promise<void>((resolve) => {
                finishRejoin = resolve;
            });
            watchTogether.session = session();
            return true;
        });
        const video = { currentTime: 90, pause: vi.fn() };
        const intervals = vi
            .spyOn(WatchTogetherHandlers.prototype, 'setupIntervals')
            .mockImplementation(() => {
                expect(video.currentTime).toBe(0);
                return () => {};
            });
        const controller = new WatchTogetherController({
            getItemId: () => 'item-1',
            getVideoElement: () => video as unknown as HTMLVideoElement,
            getPlaybackInfo: () => ({ itemId: 'item-1' }),
            setVideoTime: (time: number) => {
                video.currentTime = time;
            },
            log: vi.fn(),
        } as unknown as WatchTogetherControllerDeps);
        const setup = controller.setupInMount('host');
        expect(intervals).not.toHaveBeenCalled();
        finishRejoin();
        const cleanup = await setup;
        expect(intervals).toHaveBeenCalledOnce();
        expect(video.pause).toHaveBeenCalled();
        cleanup?.();
        controller.dispose();
    });

    it.each([
        { host: false, playing: false },
        { host: false, playing: true },
        { host: true, playing: false },
        { host: true, playing: true },
    ])(
        'realigns a same-movie member to zero with host=$host and playing=$playing',
        async ({ host, playing }) => {
            vi.spyOn(watchTogether, 'isHost', 'get').mockReturnValue(host);
            watchTogether.session = { ...session(), isPlaying: playing };
            vi.spyOn(watchTogether, 'isWatchPartySyncing', 'get').mockReturnValue(false);
            const seek = vi.fn();
            const pause = vi.fn();
            const video = { currentTime: 90, pause };
            const c = new WatchTogetherController({
                getVideoElement: () => video as unknown as HTMLVideoElement,
                getPlaybackInfo: () => ({ itemId: 'item-1' }),
                setVideoTime: seek,
                log: vi.fn(),
            } as unknown as WatchTogetherControllerDeps);
            await (c as unknown as { handleRejoin(): Promise<void> }).handleRejoin();
            expect(seek).toHaveBeenCalledWith(0, 'watch_party_sync');
            expect(pause).toHaveBeenCalledTimes(playing ? 0 : 1);
        },
    );
});

describe('WatchTogetherController source replacement', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        watchTogether.disconnect();
        watchTogether.session = {
            ...session(),
            currentTime: 60,
            isPlaying: true,
            timelineId: 'timeline',
        };
        vi.spyOn(watchTogether, 'reportStall').mockResolvedValue(true);
        vi.spyOn(watchTogether, 'reportReady').mockResolvedValue(true);
    });
    afterEach(() => {
        watchTogether.disconnect();
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });
    function replacement() {
        const video = document.createElement('video');
        video.currentTime = 60;
        let ready = 0;
        let seeking = false;
        vi.spyOn(video, 'readyState', 'get').mockImplementation(() => ready);
        vi.spyOn(video, 'seeking', 'get').mockImplementation(() => seeking);
        const play = vi.spyOn(video, 'play').mockResolvedValue();
        const pause = vi.spyOn(video, 'pause').mockImplementation(() => {});
        const c = new WatchTogetherController({
            getVideoElement: () => video,
            getItemId: () => 'item-1',
            getPlaybackInfo: () => ({ itemId: 'item-1' }),
            log: () => {},
        } as WatchTogetherControllerDeps);
        const handlers = new WatchTogetherHandlers({
            getItemId: () => 'item-1',
            isHost: () => true,
            isSourceReplacing: () => c.isSourceReplacing,
        });
        handlers.setController({
            getCurrentTime: () => video.currentTime,
            seekTo: (t) => {
                video.currentTime = t;
            },
            play: () => video.play(),
            pause: () => video.pause(),
            isPaused: () => video.paused,
            getPlaybackRate: () => 1,
            setPlaybackRate: () => {},
            getBuffered: () => null,
            getReadyState: () => ready,
            isReady: () => true,
            hasLiveSource: () => true,
        });
        c.handlers = handlers;
        return {
            c,
            video,
            play,
            pause,
            ready: (v: number) => {
                ready = v;
            },
            seeking: (v: boolean) => {
                seeking = v;
            },
        };
    }
    it('holds the party through source reset, and resumes from current authority after actual readiness', async () => {
        const r = replacement();
        r.c.beginSourceReplacement();
        expect(r.c.isSourceReplacing).toBe(true);
        const id = vi.mocked(watchTogether.reportStall).mock.calls[0][0];
        r.c.finishSourceReplacement();
        await vi.advanceTimersByTimeAsync(0);
        expect(watchTogether.reportReady).not.toHaveBeenCalled();
        r.ready(4);
        r.seeking(true);
        r.c.onCanPlay();
        await vi.advanceTimersByTimeAsync(0);
        expect(watchTogether.reportReady).not.toHaveBeenCalled();
        r.seeking(false);
        r.c.onSeeked();
        await vi.advanceTimersByTimeAsync(0);
        expect(watchTogether.reportReady).toHaveBeenCalledWith(id);
        expect(r.c.isSourceReplacing).toBe(false);
        expect(r.play).toHaveBeenCalledOnce();
        r.c.dispose();
    });
    it('a pause accepted during the load wins over the earlier playing intent', async () => {
        const r = replacement();
        r.c.beginSourceReplacement();
        r.ready(4);
        watchTogether.session = { ...watchTogether.session!, isPlaying: false };
        r.c.finishSourceReplacement();
        await vi.advanceTimersByTimeAsync(0);
        expect(r.play).not.toHaveBeenCalled();
        expect(r.pause).toHaveBeenCalledOnce();
        r.c.dispose();
    });
    it.each(['navigate', 'dispose'] as const)(
        'does not ready or resume an obsolete replacement after %s',
        async (action) => {
            let resolve!: (value: boolean) => void;
            vi.mocked(watchTogether.reportStall).mockImplementation(
                () =>
                    new Promise((r) => {
                        resolve = r;
                    }),
            );
            const r = replacement();
            r.c.beginSourceReplacement();
            r.ready(4);
            r.c.finishSourceReplacement();
            if (action === 'dispose') r.c.dispose();
            else watchTogether.session = { ...watchTogether.session!, timelineId: 'new' };
            resolve(true);
            await vi.advanceTimersByTimeAsync(0);
            expect(watchTogether.reportReady).not.toHaveBeenCalled();
            expect(r.play).not.toHaveBeenCalled();
            r.c.dispose();
        },
    );
    it('an earlier ready acknowledgement cannot release a chained replacement', async () => {
        let release!: (value: boolean) => void;
        vi.mocked(watchTogether.reportReady).mockImplementationOnce(
            () =>
                new Promise((r) => {
                    release = r;
                }),
        );
        const r = replacement();
        r.c.beginSourceReplacement();
        r.ready(4);
        r.c.finishSourceReplacement();
        await vi.advanceTimersByTimeAsync(0);
        r.c.beginSourceReplacement();
        r.ready(0);
        release(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(r.c.isSourceReplacing).toBe(true);
        expect(r.play).not.toHaveBeenCalled();
        expect(watchTogether.reportStall).toHaveBeenCalledTimes(2);
        expect(vi.mocked(watchTogether.reportStall).mock.calls[0][0]).not.toBe(
            vi.mocked(watchTogether.reportStall).mock.calls[1][0],
        );
        r.ready(4);
        r.c.finishSourceReplacement();
        await vi.advanceTimersByTimeAsync(0);
        expect(r.play).toHaveBeenCalledOnce();
        expect(r.c.isSourceReplacing).toBe(false);
        r.c.dispose();
    });
    it('re-enters a fresh stall if media loses readiness while the server acknowledges ready', async () => {
        let release!: (value: boolean) => void;
        vi.mocked(watchTogether.reportReady).mockImplementationOnce(
            () =>
                new Promise((r) => {
                    release = r;
                }),
        );
        const r = replacement();
        r.c.beginSourceReplacement();
        r.ready(4);
        r.c.finishSourceReplacement();
        await vi.advanceTimersByTimeAsync(0);
        r.ready(0);
        release(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(r.c.isSourceReplacing).toBe(true);
        expect(watchTogether.reportStall).toHaveBeenCalledTimes(2);
        expect(r.play).not.toHaveBeenCalled();
        r.ready(4);
        r.c.onCanPlay();
        await vi.advanceTimersByTimeAsync(0);
        expect(r.play).toHaveBeenCalledOnce();
        r.c.dispose();
    });
    it('same-item NAV retargets a held readiness acknowledgement through the real store callbacks', async () => {
        watchTogether.session = { ...watchTogether.session!, fileId: 'file-a' };
        const video = document.createElement('video');
        video.currentTime = 60;
        vi.spyOn(video, 'readyState', 'get').mockReturnValue(4);
        vi.spyOn(video, 'seeking', 'get').mockReturnValue(false);
        const play = vi.spyOn(video, 'play').mockResolvedValue();
        vi.spyOn(video, 'pause').mockImplementation(() => {});
        vi.spyOn(WatchTogetherHandlers.prototype, 'setupIntervals').mockReturnValue(() => {});
        vi.spyOn(watchTogether, 'tryRejoinFromStorage').mockResolvedValue(false);
        let release!: (value: boolean) => void;
        vi.mocked(watchTogether.reportReady).mockImplementationOnce(
            () =>
                new Promise((r) => {
                    release = r;
                }),
        );
        const c = new WatchTogetherController({
            getVideoElement: () => video,
            getItemId: () => 'item-1',
            getWatchTogetherToast: () => null,
            getPlaybackInfo: () => ({ itemId: 'item-1', title: 'X', mediaType: 'movie' }),
            getPlaybackProbe: () => null,
            seekTo: (time) => {
                video.currentTime = time;
            },
            setVideoTime: (time) => {
                video.currentTime = time;
            },
            switchLumastraFile: () => {},
            handlePlayError: vi.fn(),
            onMutedFallback: () => {},
            log: () => {},
        });
        const cleanup = await c.setupInMount('user');
        try {
            c.beginSourceReplacement();
            c.finishSourceReplacement();
            await vi.advanceTimersByTimeAsync(0);
            (watchTogether as unknown as { handleSSEEvent(event: unknown): void }).handleSSEEvent({
                type: 'navigate',
                itemId: 'item-1',
                fileId: 'file-a',
                timelineId: 'new-timeline',
                title: 'X',
                currentTime: 20,
                author: session().host,
                clientId: 'host',
            });
            await vi.advanceTimersByTimeAsync(0);
            release(true);
            await vi.advanceTimersByTimeAsync(0);
            expect(watchTogether.reportStall).toHaveBeenCalledTimes(2);
            expect(watchTogether.reportReady).toHaveBeenCalledTimes(2);
            expect(vi.mocked(watchTogether.reportReady).mock.calls[1][0]).toBe(
                vi.mocked(watchTogether.reportStall).mock.calls[1][0],
            );
            expect(c.isSourceReplacing).toBe(false);
            expect(video.currentTime).toBe(20);
            expect(play).not.toHaveBeenCalled();
        } finally {
            cleanup?.();
            c.dispose();
        }
    });
    it('a peer version change during a quality/audio hold recreates the canonical file', async () => {
        watchTogether.session = { ...watchTogether.session!, fileId: 'file-a' };
        const video = document.createElement('video');
        vi.spyOn(video, 'readyState', 'get').mockReturnValue(4);
        vi.spyOn(video, 'seeking', 'get').mockReturnValue(false);
        vi.spyOn(video, 'pause').mockImplementation(() => {});
        const play = vi.spyOn(video, 'play').mockResolvedValue();
        const switchFile = vi.fn();
        const reload = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
        vi.spyOn(WatchTogetherHandlers.prototype, 'setupIntervals').mockReturnValue(() => {});
        vi.spyOn(watchTogether, 'tryRejoinFromStorage').mockResolvedValue(false);
        const c = new WatchTogetherController({
            getVideoElement: () => video,
            getItemId: () => 'item-1',
            getWatchTogetherToast: () => null,
            getPlaybackInfo: () => ({ itemId: 'item-1', title: 'X', mediaType: 'movie' }),
            getPlaybackProbe: () => ({ versions: [{ fileId: 'file-b' }] }),
            seekTo: () => {},
            setVideoTime: () => {},
            switchLumastraFile: switchFile,
            handlePlayError: vi.fn(),
            onMutedFallback: () => {},
            log: () => {},
        });
        const cleanup = await c.setupInMount('user');
        try {
            c.beginSourceReplacement();
            (watchTogether as unknown as { handleSSEEvent(event: unknown): void }).handleSSEEvent({
                type: 'version_change',
                fileId: 'file-b',
                author: session().host,
                clientId: 'peer',
            });
            c.finishSourceReplacement();
            await vi.advanceTimersByTimeAsync(0);
            expect(reload).toHaveBeenCalledWith('/watch/item-1?fileId=file-b');
            expect(switchFile).not.toHaveBeenCalled();
            expect(watchTogether.reportReady).not.toHaveBeenCalled();
            expect(play).not.toHaveBeenCalled();
        } finally {
            cleanup?.();
            c.dispose();
        }
    });
    it('leaving and rejoining the same party retires its old local replacement hold', async () => {
        const r = replacement();
        r.c.beginSourceReplacement();
        expect(r.c.isSourceReplacing).toBe(true);
        watchTogether.disconnect();
        watchTogether.session = {
            ...session(),
            currentTime: 60,
            isPlaying: true,
            timelineId: 'timeline',
        };
        expect(r.c.isSourceReplacing).toBe(false);
        r.ready(4);
        r.c.finishSourceReplacement();
        await vi.advanceTimersByTimeAsync(0);
        expect(watchTogether.reportReady).not.toHaveBeenCalled();
        r.c.handlers!.reapplyCurrentPartyState(watchTogether);
        expect(r.play).toHaveBeenCalledOnce();
        r.c.dispose();
    });
    it('retries the matching readiness generation without publishing a replacement clock', async () => {
        vi.mocked(watchTogether.reportReady).mockResolvedValueOnce(false).mockResolvedValue(true);
        const r = replacement();
        r.c.beginSourceReplacement();
        r.ready(4);
        r.c.finishSourceReplacement();
        await vi.advanceTimersByTimeAsync(0);
        expect(r.c.isSourceReplacing).toBe(true);
        expect(r.play).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(500);
        expect(r.c.isSourceReplacing).toBe(false);
        expect(r.play).toHaveBeenCalledOnce();
        r.c.dispose();
    });
});
