// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for abortable-sleep helpers.
 *
 * Both variants must honour `signal.aborted === true` at call time (no timer
 * scheduled) and mid-sleep aborts (timer cleared) — the latter is load-bearing
 * because otherwise a dangling Node.js timer would keep the process alive and
 * the event listener would leak.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sleepOrReject, sleepOrResolve } from './abortable-sleep.js';

describe('sleepOrReject', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('resolves after the timeout when no signal is provided', async () => {
        const promise = sleepOrReject(100);
        vi.advanceTimersByTime(100);
        await expect(promise).resolves.toBeUndefined();
    });

    it('rejects immediately when the signal is already aborted', async () => {
        const ac = new AbortController();
        ac.abort();
        await expect(sleepOrReject(100, ac.signal)).rejects.toBeInstanceOf(DOMException);
    });

    it('rejects mid-sleep when the signal fires', async () => {
        const ac = new AbortController();
        const promise = sleepOrReject(100, ac.signal);
        vi.advanceTimersByTime(50);
        ac.abort();
        await expect(promise).rejects.toBeInstanceOf(DOMException);
    });

    it('propagates a custom AbortSignal reason', async () => {
        const ac = new AbortController();
        const reason = new Error('Custom stop');
        ac.abort(reason);
        await expect(sleepOrReject(100, ac.signal)).rejects.toBe(reason);
    });

    it('does not leak the abort listener after the timer fires', async () => {
        const ac = new AbortController();
        const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');
        const promise = sleepOrReject(100, ac.signal);
        vi.advanceTimersByTime(100);
        await promise;
        expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    });
});

describe('sleepOrResolve', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('resolves after the timeout when no signal is provided', async () => {
        const promise = sleepOrResolve(100);
        vi.advanceTimersByTime(100);
        await expect(promise).resolves.toBeUndefined();
    });

    it('resolves immediately when the signal is already aborted', async () => {
        const ac = new AbortController();
        ac.abort();
        // No timer advance — the returned promise should already be
        // resolved. Awaiting without advancing would hang if we got this
        // wrong.
        await expect(sleepOrResolve(100, ac.signal)).resolves.toBeUndefined();
    });

    it('resolves early when the signal fires mid-sleep', async () => {
        const ac = new AbortController();
        const promise = sleepOrResolve(100, ac.signal);
        vi.advanceTimersByTime(50);
        ac.abort();
        await expect(promise).resolves.toBeUndefined();
    });

    it('does not leak the abort listener after the timer fires', async () => {
        const ac = new AbortController();
        const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');
        const promise = sleepOrResolve(100, ac.signal);
        vi.advanceTimersByTime(100);
        await promise;
        expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    });
});
