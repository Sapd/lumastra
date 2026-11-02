// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The module-init subscribe gate.
 *
 * notification-events.service subscribes to the cross-pod user-events channel
 * at import time, retrying with backoff because a pod can legitimately boot
 * before Valkey is reachable. With NO cache URL configured there is nothing to
 * wait for: the URL is read from the environment once, so every one of the six
 * attempts returns null and the loop ends in an error that says this pod will
 * not deliver cross-pod events — which a cacheless, necessarily single-pod
 * install cannot have as a problem.
 *
 * The behaviour that made this worth a test rather than a comment is the
 * backoff's timers. They outlive the module that started them, so the warnings
 * keep arriving during LATER test files; when one lands on a worker that is
 * shutting down, vitest reports
 *
 *     EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending
 *
 * and exits non-zero on a run in which every test passed. That took main red
 * twice on 2026-09-08 (test.yml runs 253 and 255), blamed both times on
 * whichever unrelated file's worker happened to be closing.
 *
 * Each case imports the module fresh (`resetModules`), because the thing under
 * test only happens once, at import.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const subscribeToChannel = vi.fn(async () => async () => {});

vi.mock('$lib/server/cache/valkey.js', () => ({
    subscribeToChannel,
    publishMessage: vi.fn(async () => true),
    getCoordinationClient: vi.fn(() => null),
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(() => null),
}));

vi.mock('$lib/server/database/queries/user-notifications.queries.js', () => ({
    insertNotification: vi.fn(async () => ({ inserted: false, row: null })),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() }),
    },
}));

/** Import the service fresh so its module-level subscribe runs again. */
async function importServiceFresh(): Promise<void> {
    vi.resetModules();
    await import('./notification-events.service.js');
    // The subscribe is fired as `void subscribeWithRetry()`, so the decision is
    // made on a microtask rather than during the import itself.
    await Promise.resolve();
    await Promise.resolve();
}

describe('notification-events module-init subscribe', () => {
    const originalCacheUrl = process.env.TASK_CACHE_URL;

    beforeEach(() => {
        subscribeToChannel.mockClear();
    });

    afterEach(() => {
        if (originalCacheUrl === undefined) delete process.env.TASK_CACHE_URL;
        else process.env.TASK_CACHE_URL = originalCacheUrl;
    });

    it('subscribes when a cache URL is configured', async () => {
        process.env.TASK_CACHE_URL = 'redis://localhost:6379';

        await importServiceFresh();

        expect(subscribeToChannel).toHaveBeenCalledTimes(1);
    });

    it('does not subscribe — or arm a retry — when no cache URL is configured', async () => {
        delete process.env.TASK_CACHE_URL;

        await importServiceFresh();

        // Not "gave up after six attempts": never attempted. An attempt is what
        // arms the backoff timer whose late log races worker teardown.
        expect(subscribeToChannel).not.toHaveBeenCalled();
    });
});
