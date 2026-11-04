// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('../utils/logger', () => ({ Logger: { for: () => log } }));

describe('cache warnings while Valkey is unreachable', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        log.warn.mockReset();
        log.debug.mockReset();
    });
    afterEach(() => vi.useRealTimers());

    /** Runs a cache operation that fails the way a client does without a connection. */
    async function failing(message: string, error: Error): Promise<void> {
        const { __warnForTests } = await import('./valkey.js');
        __warnForTests(message, {}, error);
    }

    it('logs one warning per message per window for connection-loss errors', async () => {
        for (let i = 0; i < 20; i++)
            await failing('Cache set failed', new Error('connect ECONNREFUSED 10.0.0.2:6379'));
        // A different operation is its own message, not hidden by the first.
        await failing(
            'Cache get failed',
            new Error('Unable to execute requests; the client is closed.'),
        );
        expect(log.warn).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(31_000);
        await failing('Cache set failed', new Error('connect ECONNREFUSED 10.0.0.2:6379'));
        expect(log.warn).toHaveBeenCalledTimes(3);
        expect(log.warn.mock.calls[2][1]).toMatchObject({ suppressedSinceLastWarning: 19 });
    });

    it('never suppresses a timeout: an overloaded server times out and that stays visible', async () => {
        for (let i = 0; i < 5; i++) await failing('Cache set failed', new Error('timed out'));
        expect(log.warn).toHaveBeenCalledTimes(5);
    });

    it('never suppresses an error that has nothing to do with the connection', async () => {
        for (let i = 0; i < 3; i++)
            await failing('Cache set failed', new Error('WRONGTYPE Operation against a key'));
        expect(log.warn).toHaveBeenCalledTimes(3);
    });

    it('gates a warning that carries the failure as an error field the same way', async () => {
        const { __warnForTests } = await import('./valkey.js');
        for (let i = 0; i < 6; i++)
            __warnForTests('Failed to publish message', { error: 'getaddrinfo ENOTFOUND valkey' });
        expect(log.warn).toHaveBeenCalledTimes(1);
    });
});
