// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import { acquireWithWait, isCapRejection } from './slot-wait.js';

function capError(): Error & { status: number } {
    const err = new Error('Music transcode concurrency limit reached: 4') as Error & {
        status: number;
    };
    err.status = 503;
    return err;
}

/** Deterministic clock + sleep so the tests never actually wait. */
function fakeTimers() {
    let t = 0;
    return {
        now: () => t,
        sleep: async (ms: number) => {
            t += ms;
        },
        advance: (ms: number) => {
            t += ms;
        },
    };
}

describe('isCapRejection', () => {
    it('recognises a 503 cap rejection', () => {
        expect(isCapRejection(capError())).toBe(true);
    });

    it('does not swallow unrelated errors', () => {
        expect(isCapRejection(new Error('ffmpeg exploded'))).toBe(false);
        const notFound = new Error('nope') as Error & { status: number };
        notFound.status = 404;
        expect(isCapRejection(notFound)).toBe(false);
        expect(isCapRejection('503')).toBe(false);
    });
});

describe('acquireWithWait', () => {
    it('returns immediately when a slot is free', async () => {
        const timers = fakeTimers();
        const acquire = vi.fn().mockResolvedValue('release-fn');

        const result = await acquireWithWait(acquire, {
            timeoutMs: 10_000,
            pollMs: 250,
            ...timers,
        });

        expect(result.value).toBe('release-fn');
        expect(result.waitedMs).toBe(0);
        expect(acquire).toHaveBeenCalledTimes(1);
    });

    // The whole point: a bulk download opening more parallel requests than
    // there are slots must queue, not error.
    it('retries until a slot frees up, then succeeds', async () => {
        const timers = fakeTimers();
        const acquire = vi
            .fn()
            .mockRejectedValueOnce(capError())
            .mockRejectedValueOnce(capError())
            .mockResolvedValue('release-fn');

        const result = await acquireWithWait(acquire, {
            timeoutMs: 10_000,
            pollMs: 250,
            ...timers,
        });

        expect(result.value).toBe('release-fn');
        expect(result.waitedMs).toBe(500);
        expect(acquire).toHaveBeenCalledTimes(3);
    });

    it('gives up with the cap error once the deadline passes', async () => {
        const timers = fakeTimers();
        const acquire = vi.fn().mockRejectedValue(capError());

        await expect(
            acquireWithWait(acquire, { timeoutMs: 1000, pollMs: 250, ...timers }),
        ).rejects.toMatchObject({ status: 503 });

        // 4 polls fill the 1000ms window, and the 5th attempt is past the
        // deadline — never an unbounded spin.
        expect(acquire).toHaveBeenCalledTimes(5);
    });

    it('rejects immediately when the wait is disabled (timeoutMs = 0)', async () => {
        const timers = fakeTimers();
        const acquire = vi.fn().mockRejectedValue(capError());

        await expect(
            acquireWithWait(acquire, { timeoutMs: 0, pollMs: 250, ...timers }),
        ).rejects.toMatchObject({ status: 503 });

        expect(acquire).toHaveBeenCalledTimes(1);
    });

    it('propagates a non-cap error without retrying', async () => {
        const timers = fakeTimers();
        const acquire = vi.fn().mockRejectedValue(new Error('valkey exploded'));

        await expect(
            acquireWithWait(acquire, { timeoutMs: 10_000, pollMs: 250, ...timers }),
        ).rejects.toThrow('valkey exploded');

        expect(acquire).toHaveBeenCalledTimes(1);
    });

    // A client that hangs up mid-queue must not keep a waiter alive, or a
    // disconnected bulk download would hold the queue for the full window.
    it('stops waiting when the client disconnects', async () => {
        const timers = fakeTimers();
        const controller = new AbortController();
        const acquire = vi.fn().mockImplementation(() => {
            controller.abort();
            return Promise.reject(capError());
        });

        await expect(
            acquireWithWait(acquire, {
                timeoutMs: 10_000,
                pollMs: 250,
                signal: controller.signal,
                ...timers,
            }),
        ).rejects.toMatchObject({ status: 503 });

        expect(acquire).toHaveBeenCalledTimes(1);
    });

    it('does not attempt at all if already aborted', async () => {
        const timers = fakeTimers();
        const controller = new AbortController();
        controller.abort();
        const acquire = vi.fn().mockResolvedValue('release-fn');

        await expect(
            acquireWithWait(acquire, {
                timeoutMs: 10_000,
                pollMs: 250,
                signal: controller.signal,
                ...timers,
            }),
        ).rejects.toMatchObject({ status: 503 });

        expect(acquire).not.toHaveBeenCalled();
    });
});
