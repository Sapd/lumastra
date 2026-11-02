// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WatcherRescanCoalescer } from './watcher-rescan.js';

afterEach(() => {
    vi.useRealTimers();
});
describe('watcher rescan coalescing', () => {
    it('coalesces a burst, serializes requests and bounds retries by cooldown', async () => {
        vi.useFakeTimers();
        let finish: (() => void) | undefined;
        const submit = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        const rescan = new WatcherRescanCoalescer(submit, vi.fn(), 100, 1000);
        for (let i = 0; i < 1000; i++) rescan.request();
        await vi.advanceTimersByTimeAsync(100);
        expect(submit).toHaveBeenCalledOnce();
        for (let i = 0; i < 1000; i++) rescan.request();
        await vi.advanceTimersByTimeAsync(2000);
        expect(submit).toHaveBeenCalledOnce();
        finish?.();
        await vi.advanceTimersByTimeAsync(100);
        expect(submit).toHaveBeenCalledTimes(2);
        rescan.stop();
        finish?.();
    });
    it('retries failed submission and cancels recovery when stopped', async () => {
        vi.useFakeTimers();
        const submit = vi
            .fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValue(undefined);
        const onError = vi.fn();
        const rescan = new WatcherRescanCoalescer(submit, onError, 100, 1000);
        rescan.request();
        await vi.advanceTimersByTimeAsync(100);
        expect(onError).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1000);
        expect(submit).toHaveBeenCalledTimes(2);
        rescan.request();
        rescan.stop();
        await vi.advanceTimersByTimeAsync(5000);
        expect(submit).toHaveBeenCalledTimes(2);
    });
});

it('keeps the rescan latch when the existing task API deduplicates a running scan', async () => {
    vi.useFakeTimers();
    const submit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const rescan = new WatcherRescanCoalescer(submit, vi.fn(), 100, 1000);
    rescan.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(submit).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(submit).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(submit).toHaveBeenCalledTimes(2);
    rescan.stop();
});

it('flushes a pending terminal request before the burst timer and preserves deduplication across pause', async () => {
    vi.useFakeTimers();
    const submit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const rescan = new WatcherRescanCoalescer(submit, vi.fn(), 100, 1000);
    rescan.request();
    rescan.pause();
    expect(await rescan.flush()).toBe(false);
    expect(submit).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    expect(submit).toHaveBeenCalledOnce();
    rescan.resume();
    await vi.advanceTimersByTimeAsync(100);
    expect(submit).toHaveBeenCalledTimes(2);
    rescan.stop();
});

it('bounds flushing an in-flight submission and retains the latch after a late failure', async () => {
    vi.useFakeTimers();
    let fail: ((error: Error) => void) | undefined;
    const submit = vi
        .fn()
        .mockImplementationOnce(
            () =>
                new Promise<void>((_resolve, reject) => {
                    fail = reject;
                }),
        )
        .mockResolvedValueOnce(true);
    const rescan = new WatcherRescanCoalescer(submit, vi.fn(), 100, 1000);
    rescan.request();
    rescan.pause();
    const flush = expect(rescan.flush(50)).rejects.toThrow('flush timed out');
    await vi.advanceTimersByTimeAsync(50);
    await flush;
    fail?.(new Error('submission lost'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(submit).toHaveBeenCalledOnce();
    rescan.resume();
    await vi.advanceTimersByTimeAsync(100);
    expect(submit).toHaveBeenCalledTimes(2);
    rescan.stop();
});

it('reports pending until accepted work and any newer dirty request have both settled', async () => {
    vi.useFakeTimers();
    let accept: (() => void) | undefined;
    const submit = vi
        .fn()
        .mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    accept = resolve;
                }),
        )
        .mockResolvedValueOnce(true);
    const rescan = new WatcherRescanCoalescer(submit, vi.fn(), 100, 1000);
    expect(rescan.pending).toBe(false);
    rescan.request();
    expect(rescan.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(rescan.pending).toBe(true);
    rescan.request();
    accept?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(rescan.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(rescan.pending).toBe(false);
    rescan.stop();
});
