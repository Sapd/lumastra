// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
    dbLive: vi.fn<(sql: unknown, id: string) => Promise<boolean>>(),
    getDb: vi.fn<() => unknown>(() => ({})),
    valkeyReady: vi.fn<() => boolean>(() => true),
    cacheGetOrThrow: vi.fn<(key: string) => Promise<string | null>>(async () => null),
    cacheSet: vi.fn(async (..._a: unknown[]) => true),
    publishMessage: vi.fn(async (..._a: unknown[]) => 1),
    busHandler: null as null | ((raw: string) => void),
    endByDeviceSessionIds: vi.fn(async (_ids: readonly string[]) => [] as string[]),
    // The auth-cache bus probe: subscribed on connection 1 unless a test says otherwise.
    probe: vi.fn(
        async (_channel: string) =>
            ({ subscribed: true, connectionId: 1 }) as null | {
                subscribed: boolean;
                connectionId: number;
            },
    ),
}));
// The bus supervisor only runs with a cache URL configured.
// The unit config sets CACHE_URL to '' when none is configured; the bus
// treats that as "no Valkey" (disabled), so replace an empty value too.
process.env.CACHE_URL ||= 'redis://unit-test:6379/0';

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => h.getDb() }));
vi.mock('$lib/server/database/queries/oauth-refresh-tokens.queries.js', () => ({
    isDeviceSessionLiveInDb: (sql: unknown, id: string) => h.dbLive(sql, id),
}));
vi.mock('$lib/server/cache/valkey.js', () => ({
    isCoordinationValkeyReady: () => h.valkeyReady(),
    connectValkey: async () => true,
    cacheGetOrThrow: (key: string) => h.cacheGetOrThrow(key),
    cacheSet: (...a: unknown[]) => h.cacheSet(...a),
    publishMessage: (...a: unknown[]) => h.publishMessage(...a),
    subscribeToChannel: async (_channel: string, fn: (raw: string) => void) => {
        h.busHandler = fn;
        return () => undefined;
    },
    probeChannelSubscription: (channel: string) => h.probe(channel),
    resubscribeChannel: async () => true,
}));
vi.mock('$lib/server/oauth/streaming-session.service.js', () => ({
    getStreamingSessionService: () => ({
        endByDeviceSessionIds: (ids: readonly string[]) => h.endByDeviceSessionIds(ids),
    }),
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import {
    checkDeviceSessionLiveness,
    handleDeviceSessionsRevoked,
    isDeviceSessionTombstoned,
    onDeviceSessionsRevoked,
    _resetDeviceSessionLivenessForTests,
    LIVE_FRESH_MS,
    MARKER_RECHECK_MS,
    MARKER_UNAVAILABLE_MEMO_MS,
    STALE_LIVE_MAX_MS,
} from './device-session-liveness.js';
import {
    startAuthCacheInvalidationSubscriber,
    isAuthCacheBusSubscribed,
    _resetAuthCacheBusForTests,
} from '$lib/server/cache/auth-cache-bus.js';

const SID = 'aaaaaaaa-0000-0000-0000-000000000001';
const MARKER_KEY = `device-session-revoked:v1:${SID}`;
let now = 1_000_000;

beforeEach(async () => {
    _resetDeviceSessionLivenessForTests();
    vi.clearAllMocks();
    h.probe.mockImplementation(async () => ({ subscribed: true, connectionId: 1 }));
    _resetAuthCacheBusForTests();
    await startAuthCacheInvalidationSubscriber();
    h.getDb.mockImplementation(() => ({}));
    h.valkeyReady.mockImplementation(() => true);
    h.cacheGetOrThrow.mockImplementation(async () => null);
    h.cacheSet.mockImplementation(async () => true);
    h.endByDeviceSessionIds.mockImplementation(async () => []);
    h.dbLive.mockImplementation(async () => true);
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
    _resetAuthCacheBusForTests();
    vi.restoreAllMocks();
});

const check = (): Promise<string> => checkDeviceSessionLiveness(SID);

describe('checkDeviceSessionLiveness', () => {
    it('a cached live verdict answers without a DB read', async () => {
        expect(await check()).toBe('live');
        expect(h.dbLive).toHaveBeenCalledTimes(1);

        now += 1_000;
        expect(await check()).toBe('live');
        now += MARKER_RECHECK_MS; // marker re-read, still no DB read
        expect(await check()).toBe('live');
        expect(h.dbLive).toHaveBeenCalledTimes(1);
    });

    it('re-reads the DB once the live verdict is older than the fresh window', async () => {
        expect(await check()).toBe('live');
        now += LIVE_FRESH_MS + 1;
        h.dbLive.mockImplementation(async () => false);
        expect(await check()).toBe('revoked');
        expect(h.dbLive).toHaveBeenCalledTimes(2);
    });

    it('a Valkey marker from another replica rejects despite a cached live verdict', async () => {
        expect(await check()).toBe('live');
        now += MARKER_RECHECK_MS + 1;
        h.cacheGetOrThrow.mockImplementation(async (key) => (key === MARKER_KEY ? '1' : null));
        expect(await check()).toBe('revoked');
        expect(h.dbLive).toHaveBeenCalledTimes(1);
        // And stays rejected without asking anyone again.
        h.cacheGetOrThrow.mockClear();
        expect(await check()).toBe('revoked');
        expect(h.cacheGetOrThrow).not.toHaveBeenCalled();
    });

    it('a marker hit on a cold entry rejects even though the DB still shows a live row', async () => {
        h.cacheGetOrThrow.mockImplementation(async (key) => (key === MARKER_KEY ? '1' : null));
        expect(await check()).toBe('revoked');
        expect(h.dbLive).not.toHaveBeenCalled();
    });

    it('the marker-hit tombstone outlives the old 10-minute verdict TTL', async () => {
        h.cacheGetOrThrow.mockImplementation(async () => '1');
        expect(await check()).toBe('revoked');
        h.cacheGetOrThrow.mockImplementation(async () => null); // marker gone
        now += 60 * 60_000; // 1 h later
        expect(await check()).toBe('revoked');
        expect(h.dbLive).not.toHaveBeenCalled();
    });

    it('Valkey failing: confirms the cached verdict against the DB', async () => {
        expect(await check()).toBe('live');
        now += MARKER_RECHECK_MS + 1;
        h.cacheGetOrThrow.mockImplementation(async () => {
            throw new Error('valkey down');
        });
        h.dbLive.mockImplementation(async () => false); // revoked meanwhile
        expect(await check()).toBe('revoked');
        expect(h.dbLive).toHaveBeenCalledTimes(2);
    });

    it('Valkey not ready: DB confirm, throttled to the marker re-check interval', async () => {
        h.valkeyReady.mockImplementation(() => false);
        expect(await check()).toBe('live');
        now += MARKER_RECHECK_MS + 1;
        expect(await check()).toBe('live');
        now += 100;
        expect(await check()).toBe('live');
        expect(h.dbLive).toHaveBeenCalledTimes(2);
    });

    it('a blackholed Valkey costs one bounded read, then is skipped for the memo window', async () => {
        h.cacheGetOrThrow.mockImplementation(() => new Promise<string | null>(() => undefined));
        const started = performance.now();
        expect(await check()).toBe('live'); // DB decides
        expect(performance.now() - started).toBeLessThan(2_000);
        expect(h.cacheGetOrThrow).toHaveBeenCalledTimes(1);

        // Another (cold) session inside the memo window: Valkey is skipped.
        expect(await checkDeviceSessionLiveness('sid-2')).toBe('live');
        expect(h.cacheGetOrThrow).toHaveBeenCalledTimes(1);

        now += MARKER_UNAVAILABLE_MEMO_MS + 1;
        h.cacheGetOrThrow.mockImplementation(async () => null);
        expect(await checkDeviceSessionLiveness('sid-3')).toBe('live');
        expect(h.cacheGetOrThrow).toHaveBeenCalledTimes(2);
    });

    it('cold cache + DB error is unknown and caches nothing', async () => {
        h.dbLive.mockImplementation(async () => {
            throw new Error('db down');
        });
        expect(await check()).toBe('unknown');
        h.dbLive.mockImplementation(async () => true);
        expect(await check()).toBe('live');
    });

    it('no DB handle at all is unknown', async () => {
        h.getDb.mockImplementation(() => null);
        expect(await check()).toBe('unknown');
    });

    it('DB error: a recent live verdict stands in only with a clean marker', async () => {
        expect(await check()).toBe('live');
        now += LIVE_FRESH_MS + 1;
        h.dbLive.mockImplementation(async () => {
            throw new Error('db down');
        });
        expect(await check()).toBe('live');

        h.cacheGetOrThrow.mockImplementation(async () => '1');
        expect(await check()).toBe('revoked');
    });

    it('DB error with the marker unreadable is unknown, not live', async () => {
        expect(await check()).toBe('live');
        now += LIVE_FRESH_MS + 1;
        h.dbLive.mockImplementation(async () => {
            throw new Error('db down');
        });
        h.cacheGetOrThrow.mockImplementation(async () => {
            throw new Error('valkey down');
        });
        expect(await check()).toBe('unknown');
    });

    it('DB error grace is capped at STALE_LIVE_MAX_MS', async () => {
        expect(await check()).toBe('live');
        now += STALE_LIVE_MAX_MS + 1;
        h.dbLive.mockImplementation(async () => {
            throw new Error('db down');
        });
        expect(await check()).toBe('unknown');
    });

    it('concurrent checks of one session share a single lookup', async () => {
        let release: (v: boolean) => void = () => undefined;
        h.dbLive.mockImplementation(
            () =>
                new Promise<boolean>((resolve) => {
                    release = resolve;
                }),
        );
        const all = Promise.all([check(), check(), check()]);
        await vi.waitFor(() => expect(h.dbLive).toHaveBeenCalledTimes(1));
        release(true);
        expect(await all).toEqual(['live', 'live', 'live']);
        expect(h.dbLive).toHaveBeenCalledTimes(1);
        expect(h.cacheGetOrThrow).toHaveBeenCalledTimes(1);
    });

    it('a revoke landing during a pending marker re-read wins, for the pending and a joining check', async () => {
        expect(await check()).toBe('live');
        now += MARKER_RECHECK_MS + 1;
        let release: (v: string | null) => void = () => undefined;
        h.cacheGetOrThrow.mockImplementation(
            () =>
                new Promise<string | null>((resolve) => {
                    release = resolve;
                }),
        );
        const pending = check();
        await vi.waitFor(() => expect(h.cacheGetOrThrow).toHaveBeenCalledTimes(1));

        await handleDeviceSessionsRevoked([SID]);
        const joining = check();
        release(null); // the marker read itself still saw no marker
        expect(await pending).toBe('revoked');
        expect(await joining).toBe('revoked');
    });
});

describe('handleDeviceSessionsRevoked', () => {
    it('tombstones locally, writes a marker, publishes, ends stream tokens, notifies listeners', async () => {
        const seen: string[][] = [];
        onDeviceSessionsRevoked((ids) => seen.push([...ids]));
        expect(await check()).toBe('live');

        await handleDeviceSessionsRevoked([SID, null, SID]);

        expect(await check()).toBe('revoked');
        expect(isDeviceSessionTombstoned(SID)).toBe(true);
        expect(h.cacheSet).toHaveBeenCalledTimes(1);
        expect(h.cacheSet.mock.calls[0]).toEqual([MARKER_KEY, '1', expect.any(Number)]);
        expect(h.publishMessage).toHaveBeenCalledTimes(1);
        expect(h.endByDeviceSessionIds).toHaveBeenCalledWith([SID]);
        expect(seen).toContainEqual([SID]);
    });

    it('is a no-op for an empty list', async () => {
        await handleDeviceSessionsRevoked([null, undefined]);
        expect(h.cacheSet).not.toHaveBeenCalled();
        expect(h.publishMessage).not.toHaveBeenCalled();
        expect(h.endByDeviceSessionIds).not.toHaveBeenCalled();
    });

    it('a Valkey-only failure still publishes and still ends stream tokens', async () => {
        h.cacheSet.mockImplementation(async () => {
            throw new Error('valkey down');
        });
        await expect(handleDeviceSessionsRevoked([SID])).resolves.toBeUndefined();
        expect(h.publishMessage).toHaveBeenCalledTimes(1);
        expect(h.endByDeviceSessionIds).toHaveBeenCalledWith([SID]);
        expect(await check()).toBe('revoked');
    });

    it('never throws when every side channel fails', async () => {
        h.cacheSet.mockImplementation(async () => {
            throw new Error('valkey down');
        });
        h.endByDeviceSessionIds.mockImplementation(async () => {
            throw new Error('db down');
        });
        await expect(handleDeviceSessionsRevoked([SID])).resolves.toBeUndefined();
        expect(await check()).toBe('revoked');
    });

    it('does not hang on a stuck marker write / stream end (bounded)', async () => {
        h.cacheSet.mockImplementation(() => new Promise<boolean>(() => undefined));
        h.endByDeviceSessionIds.mockImplementation(() => new Promise<string[]>(() => undefined));
        const started = performance.now();
        await handleDeviceSessionsRevoked([SID]);
        expect(performance.now() - started).toBeLessThan(5_000);
        expect(await check()).toBe('revoked');
    });

    it('the published payload round-trips through the bus handler of another replica', async () => {
        expect(h.busHandler).not.toBeNull();

        await handleDeviceSessionsRevoked([SID]);
        const published = JSON.parse(String(h.publishMessage.mock.calls[0][1])) as Record<
            string,
            unknown
        >;
        expect(published).toMatchObject({
            kind: 'device-session-revoked',
            deviceSessionIds: [SID],
        });

        // "Another replica": a cold cache that has a live verdict for SID.
        _resetDeviceSessionLivenessForTests();
        expect(await check()).toBe('live');
        h.busHandler!(JSON.stringify({ ...published, _from: 'other-replica' }));
        expect(await check()).toBe('revoked');
        expect(isDeviceSessionTombstoned(SID)).toBe(true);
    });
});

/**
 * The bus is how another replica's revocation reaches this one at once. While
 * this replica is not subscribed (Valkey was down at boot, or the pub/sub
 * connection dropped) an event can be lost, so the cache must not vouch for a
 * session: the DB decides, exactly as with Valkey down.
 */
describe('auth-cache bus not subscribed', () => {
    async function busDown(): Promise<void> {
        _resetAuthCacheBusForTests();
        h.probe.mockImplementation(async () => null);
        await startAuthCacheInvalidationSubscriber();
        expect(isAuthCacheBusSubscribed()).toBe(false);
    }

    it('comparison: with the bus subscribed, a clean marker confirms a cached live verdict', async () => {
        expect(await check()).toBe('live');
        now += MARKER_RECHECK_MS + 1;
        h.dbLive.mockImplementation(async () => false); // revoked elsewhere, event + marker missed
        expect(await check()).toBe('live');
        expect(h.dbLive).toHaveBeenCalledTimes(1);
    });

    it('a revoked session is rejected via the DB although the marker is clean', async () => {
        expect(await check()).toBe('live');
        await busDown();
        now += MARKER_RECHECK_MS + 1;
        h.dbLive.mockImplementation(async () => false); // revoked elsewhere, event + marker missed
        expect(await check()).toBe('revoked');
        expect(h.dbLive).toHaveBeenCalledTimes(2);
    });

    it('DB reads are throttled to the marker re-check interval, as with Valkey down', async () => {
        await busDown();
        expect(await check()).toBe('live');
        expect(await check()).toBe('live');
        expect(h.dbLive).toHaveBeenCalledTimes(1);
        now += MARKER_RECHECK_MS + 1;
        expect(await check()).toBe('live');
        expect(h.dbLive).toHaveBeenCalledTimes(2);
    });

    it('a DB error is unknown (503) even with a recent live verdict and a clean marker', async () => {
        expect(await check()).toBe('live');
        await busDown();
        now += MARKER_RECHECK_MS + 1;
        h.dbLive.mockImplementation(async () => {
            throw new Error('db down');
        });
        expect(await check()).toBe('unknown');
    });

    it('a cold session is still decided by the DB', async () => {
        await busDown();
        h.dbLive.mockImplementation(async () => false);
        expect(await check()).toBe('revoked');
    });
});

describe('auth-cache bus resync', () => {
    it('recovery after a gap drops cached live verdicts (an event in the gap is lost)', async () => {
        expect(await check()).toBe('live');
        // The bus drops and comes back; a revocation published in between is gone.
        _resetAuthCacheBusForTests();
        h.probe.mockImplementation(async () => null);
        await startAuthCacheInvalidationSubscriber();
        h.dbLive.mockImplementation(async () => false);
        h.probe.mockImplementation(async () => ({ subscribed: true, connectionId: 2 }));
        await vi.waitFor(() => expect(isAuthCacheBusSubscribed()).toBe(true), { timeout: 5_000 });
        // Within the 5 s confirm window the old verdict would have answered alone.
        expect(await check()).toBe('revoked');
        expect(h.dbLive).toHaveBeenCalledTimes(2);
    });

    it('a tombstone survives a resync', async () => {
        await handleDeviceSessionsRevoked([SID]);
        _resetAuthCacheBusForTests();
        h.probe.mockImplementation(async () => null);
        await startAuthCacheInvalidationSubscriber();
        h.probe.mockImplementation(async () => ({ subscribed: true, connectionId: 2 }));
        await vi.waitFor(() => expect(isAuthCacheBusSubscribed()).toBe(true), { timeout: 5_000 });
        h.dbLive.mockImplementation(async () => true);
        expect(await check()).toBe('revoked');
    });
});
