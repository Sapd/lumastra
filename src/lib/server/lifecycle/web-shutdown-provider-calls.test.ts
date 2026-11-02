// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const customCommand = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/cache/valkey.js', () => ({
    getCoordinationClient: () => ({ customCommand }),
}));
vi.mock('../utils/external-request-stats.js', () => ({ flushRequestPathCalls: async () => {} }));
import { flushProviderCalls, recordProviderCall } from '../utils/provider-calls.js';
import { _resetWebShutdownForTests, createWebShutdown } from './web-shutdown.js';

let release: () => void = () => {};
beforeEach(() => {
    vi.useFakeTimers();
    _resetWebShutdownForTests();
    customCommand.mockReset().mockImplementation(
        () =>
            new Promise<void>((resolve) => {
                release = resolve;
            }),
    );
    recordProviderCall('tmdb', 200);
});
afterEach(async () => {
    release();
    await flushProviderCalls();
    vi.clearAllTimers();
    vi.useRealTimers();
    _resetWebShutdownForTests();
});

describe('web shutdown provider counters', () => {
    it.each([
        { deadlineMs: 5000, serviceMs: 0, flushMs: 1500 },
        { deadlineMs: 1000, serviceMs: 600, flushMs: 200 },
    ])(
        'closes pools inside a $deadlineMs ms deadline with Valkey stuck',
        async ({ deadlineMs, serviceMs, flushMs }) => {
            const events: string[] = [];
            const exit = vi.fn();
            const shutdown = createWebShutdown({
                waitForHttpServerClosed: async () => {},
                drainTimeoutMs: 100,
                cleanupDeadlineMs: deadlineMs,
                services: [
                    {
                        name: 'service',
                        run: () => new Promise<void>((resolve) => setTimeout(resolve, serviceMs)),
                    },
                ],
                pools: [
                    {
                        name: 'Valkey',
                        run: () => {
                            events.push('valkey');
                        },
                    },
                    {
                        name: 'DB',
                        run: async () => {
                            await new Promise<void>((resolve) => setTimeout(resolve, 100));
                            events.push('db');
                        },
                    },
                ],
                exit,
                log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            });
            const done = shutdown('SIGTERM');
            await vi.advanceTimersByTimeAsync(serviceMs + flushMs - 1);
            expect(events).toEqual([]);
            await vi.advanceTimersByTimeAsync(1);
            expect(events).toEqual(['valkey']);
            await vi.advanceTimersByTimeAsync(100);
            await done;
            expect(events).toEqual(['valkey', 'db']);
            expect(exit).toHaveBeenCalledExactlyOnceWith(0);
            await vi.advanceTimersByTimeAsync(deadlineMs);
            expect(exit).toHaveBeenCalledOnce();
        },
    );
});
