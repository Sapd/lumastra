// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Losing the Jellyfin connection must START the recovery, not merely record it.
 *
 * The retry used to be started from the STARTUP failure path only. An instance
 * that connected at boot and lost Jellyfin later — a Jellyfin restart, a blip
 * that trips the circuit breaker — therefore had nothing scheduled to check
 * again, and stayed "disconnected" until the process was restarted.
 *
 * Seen on prod: the worker logged "jellyfin connection lost" at 00:48 and made
 * no reconnect attempt in the NINE hours that followed, while Jellyfin was up
 * the whole time and the app was successfully talking to it. /admin/settings/
 * providers read "Jellyfin sync: unreachable" for all of it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) },
}));

const { connectionStatus } = await import('./connection-status.service.js');

describe('Jellyfin connection recovery', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        connectionStatus.stopJellyfinRetry();
        // Back to a connected instance, which is the state the bug needs: the
        // startup retry loop is NOT running because startup succeeded.
        connectionStatus.setConnected('jellyfin', { serverName: 's', version: '12' });
    });
    afterEach(() => {
        connectionStatus.stopJellyfinRetry();
        vi.useRealTimers();
    });

    it('schedules a reconnect when the connection is lost AFTER startup', async () => {
        const verify = vi
            .fn<() => Promise<{ serverName: string; version: string }>>()
            .mockResolvedValue({ serverName: 'stream', version: '12.0.0' });
        connectionStatus.registerJellyfinVerifyFn(verify);

        connectionStatus.setDisconnected('jellyfin', 'Circuit breaker opened after 5 failures');
        expect(connectionStatus.isJellyfinAvailable()).toBe(false);

        // Nothing used to be scheduled here, so this stayed false forever.
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(verify).toHaveBeenCalled();
        expect(connectionStatus.isJellyfinAvailable()).toBe(true);
    });

    it('keeps retrying while the server is still down, then recovers', async () => {
        const verify = vi
            .fn<() => Promise<{ serverName: string; version: string }>>()
            .mockRejectedValueOnce(new Error('ECONNREFUSED'))
            .mockRejectedValueOnce(new Error('ECONNREFUSED'))
            .mockResolvedValue({ serverName: 'stream', version: '12.0.0' });
        connectionStatus.registerJellyfinVerifyFn(verify);

        connectionStatus.setDisconnected('jellyfin', 'down');
        await vi.advanceTimersByTimeAsync(60 * 60_000);

        expect(verify.mock.calls.length).toBeGreaterThanOrEqual(3);
        expect(connectionStatus.isJellyfinAvailable()).toBe(true);
    });

    it('does not stack timers when failures repeat', async () => {
        const verify = vi
            .fn<() => Promise<{ serverName: string; version: string }>>()
            .mockRejectedValue(new Error('still down'));
        connectionStatus.registerJellyfinVerifyFn(verify);

        connectionStatus.setDisconnected('jellyfin', 'down');
        connectionStatus.setDisconnected('jellyfin', 'down again');
        connectionStatus.setDisconnected('jellyfin', 'and again');

        // One pending retry, not three: a burst of failures must not multiply
        // the probe rate against a server that is already struggling. Advanced
        // just past ONE backoff delay (30s base x 1.5^retryCount, and each
        // disconnect increments retryCount) — three stacked timers would show up
        // here as three probes.
        await vi.advanceTimersByTimeAsync(50_000);
        expect(verify).toHaveBeenCalledTimes(1);
    });

    it('does nothing for a service that is not jellyfin', async () => {
        const verify = vi.fn<() => Promise<{ serverName: string; version: string }>>();
        connectionStatus.registerJellyfinVerifyFn(verify);

        connectionStatus.setDisconnected('postgres', 'down');
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(verify).not.toHaveBeenCalled();
    });
});
