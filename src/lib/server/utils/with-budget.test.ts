// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { withBudget } from './with-budget.js';

describe('withBudget', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('resolves null on timeout before the slow inner promise settles', async () => {
        let resolveInner!: (value: string) => void;
        const inner = new Promise<string>((resolve) => {
            resolveInner = resolve;
        });

        const result = withBudget(inner, 100);
        vi.advanceTimersByTime(100);
        await expect(result).resolves.toBeNull();

        // Inner still hasn't settled — resolve it after the timeout fired.
        resolveInner('too late');
    });

    test('a post-timeout inner rejection does not surface as an unhandledRejection', async () => {
        let rejectInner!: (err: Error) => void;
        const inner = new Promise<string>((_resolve, reject) => {
            rejectInner = reject;
        });
        // Attach a catch-tracking spy so we can prove the rejection was observed
        // (i.e. withBudget's internal handler attaches to `inner`, suppressing it)
        // rather than relying on process-level unhandledRejection listeners.
        const unhandled = vi.fn();
        process.once('unhandledRejection', unhandled);

        const result = withBudget(inner, 50);
        vi.advanceTimersByTime(50);
        await expect(result).resolves.toBeNull();

        // Settle the inner promise AFTER the budget already resolved. If the
        // rejection handler wasn't attached, this would produce an
        // unhandledRejection.
        rejectInner(new Error('late failure'));
        // Flush microtasks so the rejection handler (attached by withBudget)
        // has a chance to run before we assert.
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();

        expect(unhandled).not.toHaveBeenCalled();
    });

    test('budgetMs undefined awaits untimed and maps rejection to null', async () => {
        const rejecting = Promise.reject(new Error('boom'));
        await expect(withBudget(rejecting, undefined)).resolves.toBeNull();
    });

    test('budgetMs <= 0 awaits untimed and maps rejection to null', async () => {
        const rejecting = Promise.reject(new Error('boom'));
        await expect(withBudget(rejecting, 0)).resolves.toBeNull();

        const rejectingNegative = Promise.reject(new Error('boom2'));
        await expect(withBudget(rejectingNegative, -5)).resolves.toBeNull();
    });

    test('budgetMs undefined/<=0 resolves the value when the inner promise resolves', async () => {
        await expect(withBudget(Promise.resolve('ok'), undefined)).resolves.toBe('ok');
        await expect(withBudget(Promise.resolve('ok2'), 0)).resolves.toBe('ok2');
    });

    test('resolves the inner value when it settles before the timeout', async () => {
        const inner = Promise.resolve('fast value');
        const result = withBudget(inner, 1000);
        await expect(result).resolves.toBe('fast value');
    });
});
