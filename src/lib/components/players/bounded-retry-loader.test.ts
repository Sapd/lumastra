// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BoundedRetryLoader — the retry/backoff mechanics behind every trigger in
 * LazyPlayerLoader (Task 8 fix round 1, Important 3). See the class's own
 * doc comment for why this is a standalone, generically-typed unit: it lets
 * failure/backoff be tested with a plain injected (and controllably
 * failing) `importFn`, without needing `vi.mock()` on a real `.svelte`
 * module path — which was tried for the sibling loader test and silently
 * not honoured for a dynamic `import()` reached from another module.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoundedRetryLoader } from './bounded-retry-loader.svelte';

describe('BoundedRetryLoader', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('does nothing while inactive', async () => {
        const importFn = vi.fn().mockResolvedValue({ default: 'X' });
        const loader = new BoundedRetryLoader(importFn);

        loader.notify(false);
        await Promise.resolve();

        expect(importFn).not.toHaveBeenCalled();
        expect(loader.value).toBeNull();
    });

    it('loads once active, and stays loaded on further notifications', async () => {
        const importFn = vi.fn().mockResolvedValue({ default: 'X' });
        const loader = new BoundedRetryLoader(importFn);

        loader.notify(true);
        await vi.waitFor(() => {
            if (loader.value === null) throw new Error('not loaded yet');
        });
        expect(loader.value).toBe('X');

        // Simulate a fast-ticking store calling notify many more times.
        loader.notify(true);
        loader.notify(true);
        loader.notify(true);
        await Promise.resolve();

        expect(importFn).toHaveBeenCalledOnce();
    });

    it('calls onLoaded exactly once, right after value is first set — not synchronously inside notify()', async () => {
        const importFn = vi.fn().mockResolvedValue({ default: 'X' });
        const onLoaded = vi.fn();
        const loader = new BoundedRetryLoader(importFn, { onLoaded });

        loader.notify(true);
        // notify() only STARTS the async import — onLoaded must not have
        // fired yet when this synchronous call returns (this is exactly the
        // mistake an earlier version of the real consumer, LazyPlayerLoader,
        // made by checking `.value` here instead of using onLoaded).
        expect(onLoaded).not.toHaveBeenCalled();

        await vi.waitFor(() => {
            if (loader.value === null) throw new Error('not loaded yet');
        });
        expect(onLoaded).toHaveBeenCalledOnce();
        expect(onLoaded).toHaveBeenCalledWith('X');

        // Further notifications (already loaded) must not re-fire it.
        loader.notify(true);
        loader.notify(true);
        await Promise.resolve();
        expect(onLoaded).toHaveBeenCalledOnce();
    });

    it('a true→false→true re-arm while the first import is still pending does not start a second import or double-fire onLoaded', async () => {
        let resolveImport!: (mod: { default: string }) => void;
        const importFn = vi.fn(
            () =>
                new Promise<{ default: string }>((resolve) => {
                    resolveImport = resolve;
                }),
        );
        const onLoaded = vi.fn();
        const loader = new BoundedRetryLoader(importFn, { onLoaded });

        // 1. true: starts the import (P1), still unsettled.
        loader.notify(true);
        expect(importFn).toHaveBeenCalledOnce();

        // 2. false: deactivate while P1 is still pending.
        loader.notify(false);

        // 3. true again, before P1 settles: a fresh re-arm may cancel a
        // pending BACKOFF timer, but must never cancel or duplicate a
        // genuinely in-flight import.
        loader.notify(true);
        expect(importFn).toHaveBeenCalledOnce();

        resolveImport({ default: 'X' });
        await vi.waitFor(() => {
            if (loader.value === null) throw new Error('not loaded yet');
        });

        expect(importFn).toHaveBeenCalledOnce();
        expect(onLoaded).toHaveBeenCalledOnce();
        expect(onLoaded).toHaveBeenCalledWith('X');
    });

    it('is a single-flight: many notify(true) calls while the import is pending only import once', async () => {
        let resolveImport!: (mod: { default: string }) => void;
        const importFn = vi.fn(
            () =>
                new Promise<{ default: string }>((resolve) => {
                    resolveImport = resolve;
                }),
        );
        const loader = new BoundedRetryLoader(importFn);

        // 50 calls in a row, like 50 playback-tick emissions while loading.
        for (let i = 0; i < 50; i++) loader.notify(true);
        expect(importFn).toHaveBeenCalledOnce();

        resolveImport({ default: 'X' });
        await vi.waitFor(() => {
            if (loader.value === null) throw new Error('not loaded yet');
        });
        expect(importFn).toHaveBeenCalledOnce();
    });

    describe('retry/backoff on failure', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        it('retries with exponential backoff and eventually succeeds', async () => {
            const importFn = vi
                .fn<() => Promise<{ default: string }>>()
                .mockRejectedValueOnce(new Error('stale chunk'))
                .mockRejectedValueOnce(new Error('stale chunk'))
                .mockResolvedValueOnce({ default: 'X' });
            const onAttemptFailed = vi.fn();
            const loader = new BoundedRetryLoader(importFn, {
                backoffBaseMs: 1000,
                onAttemptFailed,
            });

            loader.notify(true);
            await vi.advanceTimersByTimeAsync(0); // let the first rejection settle
            expect(importFn).toHaveBeenCalledOnce();
            expect(onAttemptFailed).toHaveBeenCalledWith(1, 3, expect.any(Error));

            // A tick storm DURING the backoff window must not trigger extra
            // attempts (this is the "no per-tick retries" requirement).
            loader.notify(true);
            loader.notify(true);
            expect(importFn).toHaveBeenCalledOnce();

            await vi.advanceTimersByTimeAsync(1000); // first backoff (1s) fires attempt 2
            expect(importFn).toHaveBeenCalledTimes(2);
            expect(onAttemptFailed).toHaveBeenCalledWith(2, 3, expect.any(Error));

            await vi.advanceTimersByTimeAsync(2000); // second backoff (2s) fires attempt 3 — succeeds
            expect(importFn).toHaveBeenCalledTimes(3);
            expect(loader.value).toBe('X');
        });

        it('stops retrying after maxAttempts and does not throw an unhandled rejection', async () => {
            const importFn = vi
                .fn<() => Promise<{ default: string }>>()
                .mockRejectedValue(new Error('permanently broken'));
            const loader = new BoundedRetryLoader(importFn, {
                maxAttempts: 2,
                backoffBaseMs: 100,
            });

            loader.notify(true);
            await vi.advanceTimersByTimeAsync(0);
            expect(importFn).toHaveBeenCalledOnce();

            await vi.advanceTimersByTimeAsync(100);
            expect(importFn).toHaveBeenCalledTimes(2);

            // Exhausted — further ticks (even many) must not retry again.
            for (let i = 0; i < 20; i++) loader.notify(true);
            await vi.advanceTimersByTimeAsync(10_000);
            expect(importFn).toHaveBeenCalledTimes(2);
            expect(loader.value).toBeNull();
        });

        it('a fresh false→true transition after exhaustion resets and retries immediately', async () => {
            const importFn = vi
                .fn<() => Promise<{ default: string }>>()
                .mockRejectedValueOnce(new Error('fail 1'))
                .mockResolvedValueOnce({ default: 'X' });
            const loader = new BoundedRetryLoader(importFn, {
                maxAttempts: 1,
                backoffBaseMs: 100,
            });

            loader.notify(true);
            await vi.advanceTimersByTimeAsync(0);
            expect(importFn).toHaveBeenCalledOnce();

            // Exhausted at maxAttempts=1 — a continued-true tick must not retry.
            loader.notify(true);
            expect(importFn).toHaveBeenCalledOnce();

            // A genuine false→true transition (e.g. the trigger store went
            // idle and became active again) DOES retry.
            loader.notify(false);
            loader.notify(true);
            await vi.advanceTimersByTimeAsync(0);

            expect(importFn).toHaveBeenCalledTimes(2);
            expect(loader.value).toBe('X');
        });

        it('dispose() cancels a pending backoff retry', async () => {
            const importFn = vi
                .fn<() => Promise<{ default: string }>>()
                .mockRejectedValue(new Error('fail'));
            const loader = new BoundedRetryLoader(importFn, { backoffBaseMs: 1000 });

            loader.notify(true);
            await vi.advanceTimersByTimeAsync(0);
            expect(importFn).toHaveBeenCalledOnce();

            loader.dispose();
            await vi.advanceTimersByTimeAsync(10_000);

            expect(importFn).toHaveBeenCalledOnce();
        });
    });
});
