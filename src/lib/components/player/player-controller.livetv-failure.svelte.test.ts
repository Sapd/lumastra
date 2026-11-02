// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Typed Live TV failures in PlayerController: the failure card, the automatic retry budget,
 * cancel, and where a refused start ends up. Real methods on a prototype-built controller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('$lib/stores/toast.store.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('$lib/stores/toast.store.js')>();
    return { ...original, toasts: { ...original.toasts, error: toastError } };
});

import { PlayerController } from './player-controller.svelte';
import {
    LIVETV_SUSTAINED_PLAYBACK_MS,
    readLiveTvRetryBudget,
    writeLiveTvRetryBudget,
} from './livetv-retry-budget';
import { playerStore } from './playerStore.svelte';
import type { LiveTvFailureView } from './livetv-failure-retry.js';

interface FailureController {
    showLiveTvFailure(input: {
        code: LiveTvFailureView['code'];
        retryable: boolean;
        retryAfterMs?: number;
    }): void;
    handleLiveTvNegotiationFailure(result: unknown, preserveCurrentPlayback?: boolean): void;
    handleLiveTvCancelRetry(): void;
    retryLiveTvInPlace: ReturnType<typeof vi.fn>;
    liveTvFailure: { type: string; failure?: LiveTvFailureView } | null;
    liveTvAutoRetryAttempts: number;
    armLiveTvBudgetReset(): void;
    handleLiveTvRetry(): void;
    resetLiveTvRetryBudget(): void;
    props: { playbackInfo: { itemId: string } };
    playbackGeneration: number;
    wasKicked: boolean;
}

let controller: FailureController;

beforeEach(() => {
    sessionStorage.clear();
    vi.useFakeTimers();
    toastError.mockClear();
    playerStore.isLive = true;
    const target = Object.create(PlayerController.prototype);
    const properties: Record<string, unknown> = {
        liveTvFailure: null,
        liveTvAutoRetryAttempts: 0,
        liveTvAutoRetryTimer: undefined,
        liveTvStartupDeadline: { cancel: vi.fn() },
        liveTvStartupSignal: undefined,
        reconnectDiagnosticEpoch: 0,
        props: { playbackInfo: { itemId: 'station-a' } },
        videoElement: undefined,
        isInitialized: false,
        reloadLiveTvPage: vi.fn(),
        playbackGeneration: 0,
        wasKicked: false,
        playbackManager: { destroy: vi.fn() },
        retryLiveTvInPlace: vi.fn().mockResolvedValue(undefined),
    };
    for (const [key, value] of Object.entries(properties))
        Object.defineProperty(target, key, { value, writable: true, configurable: true });
    controller = target as FailureController;
});

afterEach(() => {
    vi.useRealTimers();
});

describe('showLiveTvFailure', () => {
    it('shows the card and retries once after max(retryAfterMs, 2 s)', async () => {
        controller.showLiveTvFailure({
            code: 'provider_connection_limit',
            retryable: true,
            retryAfterMs: 30_000,
        });
        expect(controller.liveTvFailure?.type).toBe('stream_failed');
        expect(controller.liveTvFailure?.failure).toMatchObject({
            code: 'provider_connection_limit',
            attempts: 0,
        });
        expect(controller.liveTvFailure?.failure?.retryAt).toBe(Date.now() + 30_000);
        await vi.advanceTimersByTimeAsync(29_999);
        expect(controller.retryLiveTvInPlace).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(controller.retryLiveTvInPlace).toHaveBeenCalledTimes(1);
    });

    it('never retries a failure that is not retryable', async () => {
        controller.showLiveTvFailure({ code: 'channel_offline', retryable: false });
        expect(controller.liveTvFailure?.failure?.retryAt).toBeUndefined();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(controller.retryLiveTvInPlace).not.toHaveBeenCalled();
    });

    it('backs off 2, 4, 8, 16 s and then stops at a terminal card', async () => {
        const waits: number[] = [];
        for (let i = 0; i < 5; i++) {
            controller.showLiveTvFailure({ code: 'upstream_stalled', retryable: true });
            const retryAt = controller.liveTvFailure?.failure?.retryAt;
            if (retryAt === undefined) break;
            waits.push(retryAt - Date.now());
            await vi.advanceTimersByTimeAsync(retryAt - Date.now());
        }
        expect(waits).toEqual([2000, 4000, 8000, 16000]);
        expect(controller.retryLiveTvInPlace).toHaveBeenCalledTimes(4);
        expect(controller.liveTvFailure?.failure).toMatchObject({ attempts: 4 });
        expect(controller.liveTvFailure?.failure?.retryAt).toBeUndefined();
    });

    it('a new failure replaces the pending timer instead of adding one', async () => {
        controller.showLiveTvFailure({ code: 'upstream_stalled', retryable: true });
        controller.showLiveTvFailure({ code: 'upstream_stalled', retryable: true });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(controller.retryLiveTvInPlace).toHaveBeenCalledTimes(1);
    });

    it('does not retry a playback that was replaced meanwhile', async () => {
        controller.showLiveTvFailure({ code: 'upstream_stalled', retryable: true });
        controller.playbackGeneration++;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(controller.retryLiveTvInPlace).not.toHaveBeenCalled();
    });
});

describe('handleLiveTvCancelRetry', () => {
    it('stops the countdown and keeps the card for a manual retry', async () => {
        controller.showLiveTvFailure({ code: 'encoder_failed', retryable: true });
        controller.handleLiveTvCancelRetry();
        expect(controller.liveTvFailure?.type).toBe('stream_failed');
        expect(controller.liveTvFailure?.failure?.retryAt).toBeUndefined();
        expect(controller.liveTvFailure?.failure?.retryable).toBe(true);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(controller.retryLiveTvInPlace).not.toHaveBeenCalled();
    });
});

describe('handleLiveTvNegotiationFailure', () => {
    const failure = { kind: 'failure', code: 'geo_blocked', retryable: false };

    it('a refused start shows the typed card instead of a toast over a blank player', () => {
        controller.handleLiveTvNegotiationFailure({ ok: false, failure });
        expect(controller.liveTvFailure?.type).toBe('stream_failed');
        expect(controller.liveTvFailure?.failure?.code).toBe('geo_blocked');
        expect(toastError).not.toHaveBeenCalled();
    });

    it('an untyped error also ends in a card', () => {
        controller.handleLiveTvNegotiationFailure({
            ok: false,
            error: 'Stream unavailable (500)',
            status: 500,
        });
        expect(controller.liveTvFailure?.failure?.code).toBe('unknown');
    });

    it('a quality switch keeps playing and only toasts the reason', () => {
        controller.handleLiveTvNegotiationFailure({ ok: false, failure }, true);
        expect(controller.liveTvFailure).toBeNull();
        expect(toastError).toHaveBeenCalledTimes(1);
    });

    it('a stream limit still ends in the kicked overlay, not a failure card', () => {
        controller.handleLiveTvNegotiationFailure({
            ok: false,
            streamLimit: {
                error: 'stream_limit_reached',
                limit: 2,
                active: [],
                showActiveStreams: false,
            },
        });
        expect(controller.liveTvFailure?.type).toBe('kicked');
    });

    it('an eviction 410 still ends in the kicked overlay', () => {
        controller.handleLiveTvNegotiationFailure({ ok: false, kicked: true, reason: 'evicted' });
        expect(controller.liveTvFailure?.type).toBe('kicked');
    });
});

describe('retry budget across brief playback', () => {
    it('playback shorter than 30 s does not give the budget back', async () => {
        controller.showLiveTvFailure({ code: 'upstream_stalled', retryable: true });
        expect(controller.liveTvAutoRetryAttempts).toBe(1);
        controller.armLiveTvBudgetReset();
        await vi.advanceTimersByTimeAsync(LIVETV_SUSTAINED_PLAYBACK_MS - 1);
        controller.showLiveTvFailure({ code: 'upstream_stalled', retryable: true });
        await vi.advanceTimersByTimeAsync(LIVETV_SUSTAINED_PLAYBACK_MS * 2);
        expect(controller.liveTvAutoRetryAttempts).toBe(2);
    });

    it('a flapping feed ends at a terminal card instead of looping at attempt 1', async () => {
        for (let i = 0; i < 6; i++) {
            controller.showLiveTvFailure({ code: 'upstream_stalled', retryable: true });
            controller.armLiveTvBudgetReset();
            await vi.advanceTimersByTimeAsync(5_000);
        }
        expect(controller.liveTvAutoRetryAttempts).toBe(4);
        expect(controller.liveTvFailure?.failure?.retryAt).toBeUndefined();
    });

    it('30 s of sustained playback resets the count, in memory and in storage', async () => {
        controller.showLiveTvFailure({ code: 'upstream_stalled', retryable: true });
        expect(readLiveTvRetryBudget('station-a')).toBe(1);
        controller.armLiveTvBudgetReset();
        await vi.advanceTimersByTimeAsync(LIVETV_SUSTAINED_PLAYBACK_MS);
        expect(controller.liveTvAutoRetryAttempts).toBe(0);
        expect(readLiveTvRetryBudget('station-a')).toBe(0);
    });

    it('a deliberate channel switch resets the budget and the pending retry', async () => {
        controller.showLiveTvFailure({ code: 'upstream_stalled', retryable: true });
        // handleSelectChannel / zap / another-channel all start with this call.
        controller.resetLiveTvRetryBudget();
        expect(controller.liveTvAutoRetryAttempts).toBe(0);
        expect(readLiveTvRetryBudget('station-a')).toBe(0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(controller.retryLiveTvInPlace).not.toHaveBeenCalled();
    });

    it('a persisted count is spent by the next failure after a recreate', () => {
        writeLiveTvRetryBudget('station-a', 3);
        controller.liveTvAutoRetryAttempts = readLiveTvRetryBudget('station-a');
        controller.showLiveTvFailure({ code: 'upstream_stalled', retryable: true });
        expect(controller.liveTvAutoRetryAttempts).toBe(4);
        expect(readLiveTvRetryBudget('station-a')).toBe(4);
    });

    it('never retries after an eviction', async () => {
        controller.showLiveTvFailure({ code: 'upstream_stalled', retryable: true });
        controller.wasKicked = true;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(controller.retryLiveTvInPlace).not.toHaveBeenCalled();
    });
});

describe('retryLiveTvInPlace when a restart is busy', () => {
    interface RetryController {
        retryLiveTvInPlace(busyRetried?: boolean): Promise<void>;
        tryStartRestart: ReturnType<typeof vi.fn>;
        reloadLiveTvPage: ReturnType<typeof vi.fn>;
        liveTvFailure: { type: string; failure?: LiveTvFailureView } | null;
        videoElement: unknown;
        isInitialized: boolean;
    }
    let retry: RetryController;
    let real: (busyRetried?: boolean) => Promise<void>;

    beforeEach(() => {
        real = PlayerController.prototype['retryLiveTvInPlace' as keyof PlayerController] as never;
        retry = controller as unknown as RetryController;
        retry.videoElement = document.createElement('video');
        retry.isInitialized = true;
        retry.tryStartRestart = vi.fn().mockReturnValue(false);
        playerStore.isLive = true;
    });

    it('reschedules once instead of reloading, then leaves the card', async () => {
        controller.showLiveTvFailure({ code: 'upstream_stalled', retryable: true });
        const call = (busy?: boolean): Promise<void> => real.call(controller, busy);
        await call();
        expect(retry.reloadLiveTvPage).not.toHaveBeenCalled();
        expect(retry.tryStartRestart).toHaveBeenCalledTimes(1);
        await call(true);
        expect(retry.reloadLiveTvPage).not.toHaveBeenCalled();
        expect(retry.liveTvFailure?.failure?.retryAt).toBeUndefined();
    });

    it('reloads only when there is no initialised player', async () => {
        retry.isInitialized = false;
        await real.call(controller);
        expect(retry.reloadLiveTvPage).toHaveBeenCalledTimes(1);
    });
});
