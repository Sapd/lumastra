// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the position-restore timeout mechanism (createPositionRestoreHandler)
 * and for restartForBitrateChange's use of it.
 *
 * Bug context: createPositionRestoreHandler only force-resolves (calls
 * onRestored) via a `timeoutMs`-gated fallback timer. Without `timeoutMs`, if
 * `canplay` never fires (e.g. the rebuilt HLS session also fails to start —
 * common mid-deploy), `onRestored` never runs. In restartForBitrateChange,
 * `onRestored` is wired to `finishRestart`, which clears the player's
 * `isRestartingPlayback` latch — so a missing `timeoutMs` there means a
 * failed rebuild leaves that latch stuck forever, silently no-op-ing every
 * subsequent reconnect attempt ("Reconnecting" hangs forever).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPositionRestoreHandler } from './playback-restart';
import {
    restartForBitrateChange,
    restartForVersionChange,
    RESTART_TIMING,
} from './restart-orchestrator';
import type {
    RestartContext,
    StopPlaybackCallbacks,
    SessionCallbacks,
    UICallbacks,
} from './restart-orchestrator';

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Mechanism: createPositionRestoreHandler's timeoutMs fallback
// ---------------------------------------------------------------------------

describe('createPositionRestoreHandler — timeout fallback', () => {
    it('NEVER calls onRestored when canplay/loadedmetadata never fire and timeoutMs is omitted', () => {
        const videoElement = document.createElement('video');
        const onRestored = vi.fn();

        const handler = createPositionRestoreHandler(
            videoElement,
            {
                targetPosition: 10,
                autoResume: false,
                onRestored,
                // timeoutMs intentionally omitted — this is the exact shape
                // restartForBitrateChange used to pass before the fix.
            },
            vi.fn(),
            vi.fn(),
        );

        // Neither loadedmetadata nor canplay ever fires (simulates a stream
        // that never becomes playable). Advance far past any reasonable
        // restore window.
        vi.advanceTimersByTime(60_000);

        expect(onRestored).not.toHaveBeenCalled();

        handler.cleanup();
    });

    it('calls onRestored via the timeout fallback when canplay/loadedmetadata never fire and timeoutMs IS provided', () => {
        const videoElement = document.createElement('video');
        const onRestored = vi.fn();
        const setVideoTime = vi.fn();

        const handler = createPositionRestoreHandler(
            videoElement,
            {
                targetPosition: 10,
                autoResume: false,
                onRestored,
                toleranceSeconds: RESTART_TIMING.POSITION_TOLERANCE_S,
                timeoutMs: RESTART_TIMING.RESTORE_TIMEOUT_MS,
            },
            vi.fn(),
            setVideoTime,
        );

        expect(onRestored).not.toHaveBeenCalled();

        vi.advanceTimersByTime(RESTART_TIMING.RESTORE_TIMEOUT_MS + 100);

        expect(onRestored).toHaveBeenCalledTimes(1);

        handler.cleanup();
    });
});

// ---------------------------------------------------------------------------
// Regression: restartForBitrateChange must release the restart latch even
// when the rebuilt session never reaches `canplay`.
// ---------------------------------------------------------------------------

describe('restartForBitrateChange — releases the restart latch on timeout', () => {
    function makeHarness() {
        const videoElement = document.createElement('video');
        const finishRestart = vi.fn();

        const ctx: RestartContext = {
            videoElement,
            currentPosition: 42,
            log: vi.fn(),
            setVideoTime: vi.fn(),
            finishRestart,
        };

        const stop: StopPlaybackCallbacks = {
            destroyPlaybackManager: vi.fn(),
            clearVideoSource: vi.fn(),
        };

        const session: SessionCallbacks = {
            endCurrentSession: vi.fn().mockResolvedValue(undefined),
            generateNewSessionId: vi.fn().mockReturnValue('new-session-id'),
            setPlaySessionId: vi.fn(),
            hasActiveSession: vi.fn().mockReturnValue(true),
        };

        const ui: UICallbacks = {
            setLoading: vi.fn(),
            setCurrentTime: vi.fn(),
        };

        const buildStreamUrl = vi.fn().mockReturnValue('https://example.test/stream.m3u8');
        const initializeHls = vi.fn().mockResolvedValue(undefined);
        const clearAdaptiveSamples = vi.fn();

        return {
            ctx,
            stop,
            session,
            ui,
            buildStreamUrl,
            initializeHls,
            clearAdaptiveSamples,
            finishRestart,
        };
    }

    it('releases the latch via timeout once restartForBitrateChange passes timeoutMs (the fix)', async () => {
        const { ctx, stop, session, ui, buildStreamUrl, initializeHls, clearAdaptiveSamples } =
            makeHarness();

        const resultPromise = restartForBitrateChange(
            ctx,
            stop,
            session,
            ui,
            buildStreamUrl,
            initializeHls,
            clearAdaptiveSamples,
        );

        await vi.advanceTimersByTimeAsync(RESTART_TIMING.SESSION_CLEANUP_MS + 50);
        const result = await resultPromise;
        expect(result.success).toBe(true);

        expect(ctx.finishRestart).not.toHaveBeenCalled();

        // canplay/loadedmetadata never fire, but with timeoutMs wired the
        // fallback timer must force the restore to resolve.
        await vi.advanceTimersByTimeAsync(RESTART_TIMING.RESTORE_TIMEOUT_MS + 100);

        expect(ctx.finishRestart).toHaveBeenCalledWith(true);

        result.cleanup?.();
    });

    it.each(['session', 'delay', 'load'] as const)(
        'cancels a late recovery during %s without restoring position or playing',
        async (phase) => {
            const h = makeHarness();
            const video = h.ctx.videoElement!;
            const play = vi.spyOn(video, 'play').mockResolvedValue(undefined);
            let canceled = false;
            let releaseSession: () => void = () => {};
            let releaseLoad: () => void = () => {};
            h.session.endCurrentSession = vi.fn(
                () =>
                    new Promise<void>((resolve) => {
                        releaseSession = resolve;
                    }),
            );
            h.initializeHls.mockImplementation(
                () =>
                    new Promise<void>((resolve) => {
                        releaseLoad = resolve;
                    }),
            );
            const resultPromise = restartForBitrateChange(
                h.ctx,
                h.stop,
                h.session,
                h.ui,
                h.buildStreamUrl,
                h.initializeHls,
                h.clearAdaptiveSamples,
                { autoResume: true, isCancelled: () => canceled },
            );
            if (phase === 'session') canceled = true;
            releaseSession();
            await Promise.resolve();
            if (phase === 'delay') canceled = true;
            await vi.advanceTimersByTimeAsync(RESTART_TIMING.SESSION_CLEANUP_MS);
            if (phase === 'load') {
                canceled = true;
                releaseLoad();
            }
            const result = await resultPromise;
            expect(result.success).toBe(false);
            expect(result.cleanup).toBeUndefined();
            expect(h.initializeHls).toHaveBeenCalledTimes(phase === 'load' ? 1 : 0);
            expect(h.stop.destroyPlaybackManager).toHaveBeenCalled();
            expect(h.stop.clearVideoSource).toHaveBeenCalled();
            expect(h.finishRestart).toHaveBeenCalledTimes(1);
            video.dispatchEvent(new Event('canplay'));
            await vi.advanceTimersByTimeAsync(RESTART_TIMING.RESTORE_TIMEOUT_MS * 2);
            expect(h.ctx.setVideoTime).not.toHaveBeenCalled();
            expect(play).not.toHaveBeenCalled();
            expect(h.finishRestart).toHaveBeenCalledTimes(1);
            if (phase === 'session') expect(h.ui.setCurrentTime).not.toHaveBeenCalled();
        },
    );
});

describe('restartForVersionChange — resolves the started delivery position', () => {
    it('uses the post-build target position for UI pin, restore, and HLS initialization', async () => {
        const videoElement = document.createElement('video');
        Object.defineProperty(videoElement, 'readyState', { value: 1 });
        const ctx: RestartContext = {
            videoElement,
            currentPosition: 40,
            log: vi.fn(),
            setVideoTime: vi.fn(),
            finishRestart: vi.fn(),
        };
        const stop: StopPlaybackCallbacks = {
            destroyPlaybackManager: vi.fn(),
            clearVideoSource: vi.fn(),
        };
        const ui: UICallbacks = {
            setLoading: vi.fn(),
            setCurrentTime: vi.fn(),
        };
        const order: string[] = [];
        const buildStreamUrl = vi.fn().mockImplementation(async () => {
            order.push('build');
            return '/stream';
        });
        const initializeHls = vi.fn().mockResolvedValue(undefined);
        const resolveStartedPosition = vi.fn((requested: number) => {
            order.push('resolve');
            return requested + 10;
        });

        const result = await restartForVersionChange(
            ctx,
            stop,
            ui,
            buildStreamUrl,
            vi.fn(),
            initializeHls,
            () => false,
            resolveStartedPosition,
        );

        expect(result.success).toBe(true);
        expect(order).toEqual(['build', 'resolve']);
        expect(ui.setCurrentTime).toHaveBeenLastCalledWith(50);
        expect(initializeHls).toHaveBeenCalledWith('/stream', 50);
        videoElement.dispatchEvent(new Event('loadedmetadata'));
        expect(ctx.setVideoTime).toHaveBeenCalledWith(50, 'restore_position');
        result.cleanup?.();
    });
});

it('a newer seek target supersedes the captured restore before metadata or canplay', () => {
    const video = document.createElement('video');
    let target = 60;
    Object.defineProperty(video, 'readyState', { value: 0, configurable: true });
    const seek = vi.fn((time: number) => {
        video.currentTime = time;
    });
    const handler = createPositionRestoreHandler(
        video,
        { targetPosition: () => target, autoResume: false },
        () => {},
        seek,
    );
    target = 50;
    Object.defineProperty(video, 'readyState', { value: 1, configurable: true });
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(seek).toHaveBeenLastCalledWith(50, 'restore_position');
    target = 40;
    Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
    video.dispatchEvent(new Event('canplay'));
    expect(seek).toHaveBeenLastCalledWith(40, 'restore_position');
    handler.cleanup();
});

it('seeks once per target even when the first seek lands outside tolerance', () => {
    const video = document.createElement('video');
    let target = 60;
    Object.defineProperty(video, 'readyState', { value: 1, configurable: true });
    // Safari HLS snaps to a segment boundary: lands 3 s off the target.
    const seek = vi.fn((time: number) => {
        video.currentTime = time - 3;
    });
    const handler = createPositionRestoreHandler(
        video,
        { targetPosition: () => target, autoResume: false, toleranceSeconds: 2 },
        () => {},
        seek,
    );
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(seek).toHaveBeenCalledTimes(1);
    Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
    video.dispatchEvent(new Event('canplay'));
    expect(seek).toHaveBeenCalledTimes(1);
    target = 30;
    handler.cleanup();
    const second = createPositionRestoreHandler(
        video,
        { targetPosition: () => target, autoResume: false, toleranceSeconds: 2 },
        () => {},
        seek,
    );
    video.dispatchEvent(new Event('canplay'));
    expect(seek).toHaveBeenCalledTimes(2);
    expect(seek).toHaveBeenLastCalledWith(30, 'restore_position');
    second.cleanup();
});
