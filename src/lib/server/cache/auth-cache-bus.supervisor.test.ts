// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The auth-cache bus supervisor: a replica that boots while Valkey is down
 * must subscribe once Valkey is back, must notice a dropped subscription and a
 * silent GLIDE reconnect, and must say so in the log exactly once per outage.
 * The real-Valkey version of these cases is
 * `auth-cache-bus-resubscribe.integration.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Probe = { subscribed: boolean; connectionId: number } | null;

const h = vi.hoisted(() => ({
    subscribe: vi.fn(
        async (_c: string, _fn: (raw: string) => void) => (() => undefined) as null | (() => void),
    ),
    probe: vi.fn(async (_c: string): Promise<Probe> => ({ subscribed: true, connectionId: 1 })),
    resubscribe: vi.fn(async (_c: string) => true),
    warn: vi.fn(),
    info: vi.fn(),
}));

vi.mock('./valkey.js', () => ({
    publishMessage: vi.fn(async () => 1),
    subscribeToChannel: (c: string, fn: (raw: string) => void) => h.subscribe(c, fn),
    probeChannelSubscription: (c: string) => h.probe(c),
    resubscribeChannel: (c: string) => h.resubscribe(c),
}));
vi.mock('../utils/logger.js', () => ({
    Logger: {
        for: () => ({ debug: vi.fn(), info: h.info, warn: h.warn, error: vi.fn() }),
    },
}));

// The unit config sets TASK_CACHE_URL to '' when none is configured; the bus
// treats that as "no Valkey" (disabled), so replace an empty value too.
process.env.TASK_CACHE_URL ||= 'redis://unit-test:6379/0';

const bus = await import('./auth-cache-bus.js');
const {
    startAuthCacheInvalidationSubscriber,
    isAuthCacheBusSubscribed,
    getAuthCacheBusStatus,
    onAuthCacheBusResync,
    _resetAuthCacheBusForTests,
    SUBSCRIBE_RETRY_BASE_MS,
    SUBSCRIBE_RETRY_MAX_MS,
    SUBSCRIPTION_PROBE_INTERVAL_MS,
} = bus;

const resync = vi.fn();
onAuthCacheBusResync(resync);

function valkeyDown(): void {
    h.subscribe.mockImplementation(async () => null);
    h.probe.mockImplementation(async () => null);
}
function valkeyUp(connectionId = 1): void {
    h.subscribe.mockImplementation(async () => () => undefined);
    h.probe.mockImplementation(async () => ({ subscribed: true, connectionId }));
}
const busWarnings = (): number =>
    h.warn.mock.calls.filter((c) => String(c[0]).includes('not subscribed')).length;

beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    _resetAuthCacheBusForTests();
    valkeyUp();
});

afterEach(() => {
    _resetAuthCacheBusForTests();
    vi.useRealTimers();
});

describe('auth-cache bus supervisor', () => {
    it('subscribes on start when Valkey is up', async () => {
        await startAuthCacheInvalidationSubscriber();
        expect(isAuthCacheBusSubscribed()).toBe(true);
        expect(resync).not.toHaveBeenCalled();
    });

    it('boot with Valkey down: unsubscribed, then subscribed within the backoff window once Valkey is up', async () => {
        valkeyDown();
        await startAuthCacheInvalidationSubscriber();
        expect(isAuthCacheBusSubscribed()).toBe(false);
        expect(getAuthCacheBusStatus().state).toBe('unsubscribed');

        // Still down through several retries: the warning is logged ONCE.
        await vi.advanceTimersByTimeAsync(
            SUBSCRIBE_RETRY_BASE_MS + 2 * SUBSCRIBE_RETRY_BASE_MS + 4 * SUBSCRIBE_RETRY_BASE_MS,
        );
        expect(h.subscribe.mock.calls.length).toBeGreaterThanOrEqual(4);
        expect(busWarnings()).toBe(1);
        expect(isAuthCacheBusSubscribed()).toBe(false);

        valkeyUp();
        // The longest any retry waits is the backoff cap.
        await vi.advanceTimersByTimeAsync(SUBSCRIBE_RETRY_MAX_MS);
        expect(isAuthCacheBusSubscribed()).toBe(true);
        expect(h.info.mock.calls.some((c) => String(c[0]).includes('subscribed again'))).toBe(true);
        // Events may have been lost while down: caches are told to resync.
        expect(resync).toHaveBeenCalledTimes(1);
    });

    it('the backoff is capped', async () => {
        valkeyDown();
        await startAuthCacheInvalidationSubscriber();
        await vi.advanceTimersByTimeAsync(10 * SUBSCRIBE_RETRY_MAX_MS);
        const calls = h.subscribe.mock.calls.length;
        await vi.advanceTimersByTimeAsync(SUBSCRIBE_RETRY_MAX_MS);
        expect(h.subscribe.mock.calls.length).toBe(calls + 1);
    });

    it('a connection drop is noticed by the probe, and the subscription comes back', async () => {
        await startAuthCacheInvalidationSubscriber();
        expect(isAuthCacheBusSubscribed()).toBe(true);

        valkeyDown();
        await vi.advanceTimersByTimeAsync(SUBSCRIPTION_PROBE_INTERVAL_MS);
        expect(isAuthCacheBusSubscribed()).toBe(false);
        expect(busWarnings()).toBe(1);

        valkeyUp(2);
        await vi.advanceTimersByTimeAsync(SUBSCRIBE_RETRY_MAX_MS);
        expect(isAuthCacheBusSubscribed()).toBe(true);
        expect(resync).toHaveBeenCalledTimes(1);
    });

    it('a reconnect between two probes (new connection id) triggers a resync', async () => {
        await startAuthCacheInvalidationSubscriber();
        valkeyUp(7); // GLIDE reconnected and re-subscribed silently
        await vi.advanceTimersByTimeAsync(SUBSCRIPTION_PROBE_INTERVAL_MS);
        expect(isAuthCacheBusSubscribed()).toBe(true);
        expect(resync).toHaveBeenCalledTimes(1);
        // Same connection on the next probe: nothing more.
        await vi.advanceTimersByTimeAsync(SUBSCRIPTION_PROBE_INTERVAL_MS);
        expect(resync).toHaveBeenCalledTimes(1);
    });

    it('a channel the server lost is re-SUBSCRIBEd', async () => {
        await startAuthCacheInvalidationSubscriber();
        h.probe.mockImplementation(async () => ({ subscribed: false, connectionId: 3 }));
        await vi.advanceTimersByTimeAsync(SUBSCRIPTION_PROBE_INTERVAL_MS);
        expect(isAuthCacheBusSubscribed()).toBe(false);

        h.resubscribe.mockImplementation(async () => {
            h.probe.mockImplementation(async () => ({ subscribed: true, connectionId: 3 }));
            return true;
        });
        await vi.advanceTimersByTimeAsync(SUBSCRIBE_RETRY_MAX_MS);
        expect(h.resubscribe).toHaveBeenCalled();
        expect(isAuthCacheBusSubscribed()).toBe(true);
    });

    it('logs one warning per outage, not one per retry, and again for the next outage', async () => {
        await startAuthCacheInvalidationSubscriber();
        valkeyDown();
        await vi.advanceTimersByTimeAsync(SUBSCRIPTION_PROBE_INTERVAL_MS + SUBSCRIBE_RETRY_MAX_MS);
        expect(busWarnings()).toBe(1);
        valkeyUp();
        await vi.advanceTimersByTimeAsync(SUBSCRIBE_RETRY_MAX_MS);
        valkeyDown();
        await vi.advanceTimersByTimeAsync(SUBSCRIPTION_PROBE_INTERVAL_MS + SUBSCRIBE_RETRY_MAX_MS);
        expect(busWarnings()).toBe(2);
    });

    it('a throwing subscribe counts as down and is retried', async () => {
        h.subscribe.mockImplementation(async () => {
            throw new Error('wire error');
        });
        await startAuthCacheInvalidationSubscriber();
        expect(isAuthCacheBusSubscribed()).toBe(false);
        valkeyUp();
        await vi.advanceTimersByTimeAsync(SUBSCRIBE_RETRY_MAX_MS);
        expect(isAuthCacheBusSubscribed()).toBe(true);
    });

    it('is idempotent', async () => {
        await Promise.all([
            startAuthCacheInvalidationSubscriber(),
            startAuthCacheInvalidationSubscriber(),
        ]);
        await startAuthCacheInvalidationSubscriber();
        expect(h.subscribe).toHaveBeenCalledTimes(1);
    });

    it('no TASK_CACHE_URL: disabled, trusted, no retries', async () => {
        const url = process.env.TASK_CACHE_URL;
        delete process.env.TASK_CACHE_URL;
        try {
            await startAuthCacheInvalidationSubscriber();
            expect(getAuthCacheBusStatus().state).toBe('disabled');
            expect(bus.isAuthCacheBusDown()).toBe(false);
            expect(isAuthCacheBusSubscribed()).toBe(true);
            await vi.advanceTimersByTimeAsync(SUBSCRIBE_RETRY_MAX_MS);
            expect(h.subscribe).not.toHaveBeenCalled();
        } finally {
            process.env.TASK_CACHE_URL = url;
        }
    });

    it('never started: not trusted', () => {
        expect(getAuthCacheBusStatus().state).toBe('idle');
        expect(isAuthCacheBusSubscribed()).toBe(false);
    });
});

// Actual web/worker boot wiring, including an unavailable Valkey at startup,
// is exercised by src/task-runtime/lifecycle.test.ts.

it('routes remote Live TV permission invalidations to the local cache callback', async () => {
    const invalidate = vi.fn();
    bus.onRemoteUserLiveTvInvalidate(invalidate);
    await startAuthCacheInvalidationSubscriber();
    h.subscribe.mock.calls[0][1](
        JSON.stringify({ kind: 'user-live-tv', username: 'alice', _from: 'other-replica' }),
    );
    expect(invalidate).toHaveBeenCalledWith('alice');
});

it('B-1: only an unsubscribed bus makes every auth cache getter miss', async () => {
    const admin = await import('./user-admin-cache.js');
    const age = await import('./user-max-age-cache.js');
    function fill(): void {
        admin.setCachedIsAdmin('bus-viewer', true);
        admin.setCachedAdminPinned('bus-viewer', true);
        admin.setCachedDisabled('bus-viewer', false);
        admin.setCachedDeleted('bus-viewer', false);
        admin.setCachedUserId('bus-viewer', 'user-id');
        admin.setCachedGroups('bus-viewer', ['admins']);
        age.setCachedMaxAge('bus-viewer', 18);
    }
    function values(): unknown[] {
        return [
            admin.getCachedIsAdmin('bus-viewer'),
            admin.getCachedAdminPinned('bus-viewer'),
            admin.getCachedDisabled('bus-viewer'),
            admin.getCachedDeleted('bus-viewer'),
            admin.getCachedUserId('bus-viewer'),
            admin.getCachedGroups('bus-viewer'),
            age.getCachedMaxAge('bus-viewer'),
        ];
    }
    fill();
    expect(values()).toEqual([true, true, false, false, 'user-id', ['admins'], 18]);
    expect('isAuthCacheBusDown' in bus && bus.isAuthCacheBusDown()).toBe(false);
    await startAuthCacheInvalidationSubscriber();
    expect(values()[0]).toBe(true);
    valkeyDown();
    await vi.advanceTimersByTimeAsync(SUBSCRIPTION_PROBE_INTERVAL_MS);
    expect('isAuthCacheBusDown' in bus && bus.isAuthCacheBusDown()).toBe(true);
    fill(); // Even entries written during an outage are not trusted.
    expect(values()).toEqual([null, null, null, null, null, null, age.MAX_AGE_MISS]);
    valkeyUp(2);
    await vi.advanceTimersByTimeAsync(SUBSCRIBE_RETRY_MAX_MS);
    expect(values()[0]).toBeNull(); // Recovery still flushes.
    fill();
    expect(values()[0]).toBe(true);
});

it('B-1 follow-up: resolved in-app access misses only while the bus is down', async () => {
    const access = await import('./user-access-cache.js');
    const permissions = { groupNames: ['admins'], capabilities: { ownerIsAdmin: true } };
    access.setCachedUserAccess('followup-user', permissions);
    expect(access.getCachedUserAccess('followup-user')).toEqual(permissions); // idle
    await startAuthCacheInvalidationSubscriber();
    expect(access.getCachedUserAccess('followup-user')).toEqual(permissions);
    valkeyDown();
    await vi.advanceTimersByTimeAsync(SUBSCRIPTION_PROBE_INTERVAL_MS);
    expect(access.getCachedUserAccess('followup-user')).toBeNull();
    access.setCachedUserAccess('followup-user', permissions);
    expect(access.getCachedUserAccess('followup-user')).toBeNull();
    valkeyUp(2);
    await vi.advanceTimersByTimeAsync(SUBSCRIBE_RETRY_MAX_MS);
    expect(access.getCachedUserAccess('followup-user')).toBeNull(); // resync
    access.setCachedUserAccess('followup-user', permissions);
    expect(access.getCachedUserAccess('followup-user')).toEqual(permissions);
});
