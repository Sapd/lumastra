// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Live TV re-join after a failed stream (PlayerController.recoverLiveTvStream): the real
 * methods on a prototype-built controller, with the network and HLS layers stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerController } from './player-controller.svelte';
import { playerStore } from './playerStore.svelte';

type Outcome = 'recovered' | 'superseded' | 'exhausted';
interface RejoinController {
    recoverLiveTvStream(reason: string): Promise<Outcome>;
    recoverLiveTvOrFail(reason: string, onExhausted: () => void): void;
    negotiateLiveTvStream: ReturnType<typeof vi.fn>;
    initializeHls: ReturnType<typeof vi.fn>;
    applyLiveTvStreamInfo: ReturnType<typeof vi.fn>;
    handleLiveTvNegotiationFailure: ReturnType<typeof vi.fn>;
    playbackGeneration: number;
    wasKicked: boolean;
    isRestartingPlayback: boolean;
    liveTvFailure: { type: string } | null;
}

const OK = {
    result: {
        ok: true,
        streamInfo: { delivery: { url: '/api/livetv/channels/c/stream/v/fmp4/master.m3u8' } },
    },
    applied: 'original',
};

let controller: RejoinController;

beforeEach(() => {
    vi.useFakeTimers();
    playerStore.isLive = true;
    const target = Object.create(PlayerController.prototype);
    const properties: Record<string, unknown> = {
        videoElement: document.createElement('video'),
        playbackManager: { prepareForRestart: vi.fn() },
        playbackGeneration: 0,
        isInitialized: true,
        wasKicked: false,
        isRestartingPlayback: false,
        suppressErrorsDuringRestart: false,
        cleanupPositionRestore: null,
        reconnect: null,
        liveTvFailure: null,
        liveTvRejoin: null,
        log: vi.fn(),
        syncWakeLockForQualityMode: vi.fn(),
        consumePendingAudioSwitch: vi.fn(),
        restartQueue: { takePending: () => null, settle: vi.fn(), generation: 0 },
        negotiateLiveTvStream: vi.fn().mockResolvedValue(OK),
        initializeHls: vi.fn().mockResolvedValue(undefined),
        applyLiveTvStreamInfo: vi.fn(),
        handleLiveTvNegotiationFailure: vi.fn(),
    };
    for (const [key, value] of Object.entries(properties))
        Object.defineProperty(target, key, { value, writable: true, configurable: true });
    controller = target as RejoinController;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    playerStore.isLive = false;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

async function settle<T>(promise: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(20_000);
    return promise;
}

describe('Live TV re-join', () => {
    it('re-joins and reloads the stream', async () => {
        expect(await settle(controller.recoverLiveTvStream('video error'))).toBe('recovered');
        expect(controller.negotiateLiveTvStream).toHaveBeenCalledTimes(1);
        expect(controller.initializeHls).toHaveBeenCalledWith(OK.result.streamInfo.delivery.url, 0);
        expect(controller.isRestartingPlayback).toBe(false);
    });

    it('the error events of one failure share one re-join', async () => {
        const a = controller.recoverLiveTvStream('fatal network error');
        const b = controller.recoverLiveTvStream('video error');
        expect(a).toBe(b);
        await settle(a);
        expect(controller.negotiateLiveTvStream).toHaveBeenCalledTimes(1);
    });

    it('retries with backoff when a re-join fails, then reports exhaustion', async () => {
        controller.initializeHls.mockRejectedValue(new Error('no segments yet'));
        expect(await settle(controller.recoverLiveTvStream('video error'))).toBe('exhausted');
        expect(controller.negotiateLiveTvStream).toHaveBeenCalledTimes(3);
        // The budget is spent: a further failure inside two minutes does not re-join.
        expect(await settle(controller.recoverLiveTvStream('video error'))).toBe('exhausted');
        expect(controller.negotiateLiveTvStream).toHaveBeenCalledTimes(3);
    });

    it('turns the spinner off when the re-joins run out', async () => {
        controller.initializeHls.mockRejectedValue(new Error('no segments yet'));
        const setLoading = vi.spyOn(playerStore, 'setLoading');
        expect(await settle(controller.recoverLiveTvStream('video error'))).toBe('exhausted');
        expect(setLoading).toHaveBeenCalledWith(true);
        expect(setLoading.mock.calls.at(-1)).toEqual([false]);
        // An exhausted budget on a later failure also leaves no spinner behind.
        setLoading.mockClear();
        expect(await settle(controller.recoverLiveTvStream('video error'))).toBe('exhausted');
        expect(setLoading.mock.calls.at(-1)).toEqual([false]);
    });

    it('a new playback (channel switch) starts with a fresh budget', async () => {
        controller.initializeHls.mockRejectedValue(new Error('down'));
        await settle(controller.recoverLiveTvStream('video error'));
        controller.playbackGeneration++;
        controller.initializeHls.mockResolvedValue(undefined);
        expect(await settle(controller.recoverLiveTvStream('video error'))).toBe('recovered');
    });

    it('a channel switch during the wait is superseded, not a failure', async () => {
        const outcome = controller.recoverLiveTvStream('video error');
        controller.playbackGeneration++;
        expect(await settle(outcome)).toBe('superseded');
        expect(controller.negotiateLiveTvStream).not.toHaveBeenCalled();
    });

    it('another restart owning the player supersedes the re-join', async () => {
        controller.isRestartingPlayback = true;
        expect(await settle(controller.recoverLiveTvStream('video error'))).toBe('superseded');
        expect(controller.isRestartingPlayback).toBe(true);
    });

    it('a kicked viewer is not re-joined', async () => {
        controller.wasKicked = true;
        expect(await settle(controller.recoverLiveTvStream('video error'))).toBe('superseded');
        expect(controller.negotiateLiveTvStream).not.toHaveBeenCalled();
    });

    it('a refused join shows the server answer once, without more re-joins', async () => {
        controller.negotiateLiveTvStream.mockResolvedValue({
            result: {
                ok: false,
                failure: { kind: 'failure', code: 'channel_offline', retryable: false },
            },
            applied: 'original',
        });
        expect(await settle(controller.recoverLiveTvStream('video error'))).toBe('recovered');
        expect(controller.handleLiveTvNegotiationFailure).toHaveBeenCalledTimes(1);
        expect(controller.liveTvFailure).toEqual({ type: 'source_down' });
    });

    it('the failure screen comes only after exhaustion, for the playback that failed', async () => {
        controller.initializeHls.mockRejectedValue(new Error('down'));
        const onExhausted = vi.fn();
        controller.recoverLiveTvOrFail('video error', onExhausted);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(onExhausted).toHaveBeenCalledTimes(1);

        const later = vi.fn();
        controller.playbackGeneration++;
        controller.recoverLiveTvOrFail('video error', later);
        controller.playbackGeneration++;
        await vi.advanceTimersByTimeAsync(20_000);
        expect(later).not.toHaveBeenCalled();
    });
});
