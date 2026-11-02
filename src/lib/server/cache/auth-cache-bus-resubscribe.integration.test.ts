// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Seam test, real Valkey + Postgres: a replica whose auth-cache bus
 * subscription is missing (Valkey down at boot, pub/sub connection dropped)
 * must (a) subscribe once Valkey is reachable, (b) then hear revocations
 * published by another instance, (c) come back after a connection drop, and
 * (d) while unsubscribed, reject a revoked device session from the DB instead
 * of trusting its cache.
 *
 * "This replica" is a FRESH module graph (`vi.resetModules`) whose TASK_CACHE_URL
 * points at a TCP proxy in front of the real Valkey, so the test can take
 * Valkey away and give it back, or cut only the pub/sub connection (the proxy
 * recognises it by its `lumastra-pubsub` client name). "Another instance" is
 * a separate GLIDE client straight to the real Valkey.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { GlideClient } from '@valkey/valkey-glide';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';

vi.mock('$app/environment', () => ({
    dev: false,
    building: false,
    browser: false,
    version: 'test',
}));

const REAL_URL = process.env.TASK_CACHE_URL ? new URL(process.env.TASK_CACHE_URL) : null;
const CHANNEL = 'auth:cache:invalidate';

type Mode = 'down' | 'up' | 'block-pubsub';

/** TCP proxy that can refuse everything, or only the pub/sub connection. */
class ValkeyProxy {
    mode: Mode = 'down';
    private readonly server = net.createServer((c) => this.accept(c));
    private readonly pairs = new Set<{
        client: net.Socket;
        upstream: net.Socket | null;
        pubsub: boolean;
    }>();
    port = 0;

    constructor(
        private readonly host: string,
        private readonly upstreamPort: number,
    ) {}

    async listen(): Promise<void> {
        await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
        this.port = (this.server.address() as net.AddressInfo).port;
    }

    private accept(client: net.Socket): void {
        if (this.mode === 'down') {
            client.destroy();
            return;
        }
        const pair = { client, upstream: null as net.Socket | null, pubsub: false };
        this.pairs.add(pair);
        const upstream = net.connect(this.upstreamPort, this.host);
        pair.upstream = upstream;
        const close = (): void => {
            client.destroy();
            upstream.destroy();
            this.pairs.delete(pair);
        };
        client.on('data', (chunk: Buffer) => {
            if (chunk.includes('lumastra-pubsub')) pair.pubsub = true;
            if (this.mode === 'down' || (pair.pubsub && this.mode === 'block-pubsub')) {
                close();
                return;
            }
            upstream.write(chunk);
        });
        upstream.on('data', (chunk: Buffer) => client.write(chunk));
        client.on('error', close);
        upstream.on('error', close);
        client.on('close', close);
        upstream.on('close', close);
    }

    /** Cut live connections (all, or only the pub/sub one). */
    drop(onlyPubsub = false): void {
        for (const p of [...this.pairs]) {
            if (onlyPubsub && !p.pubsub) continue;
            p.client.destroy();
            p.upstream?.destroy();
            this.pairs.delete(p);
        }
    }

    async close(): Promise<void> {
        this.mode = 'down';
        this.drop();
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
}

type BusModule = typeof import('./auth-cache-bus.js');
type LivenessModule = typeof import('../oauth/device-session-liveness.js');
type ValkeyModule = typeof import('./valkey.js');
type MaxAgeModule = typeof import('./user-max-age-cache.js');

describe.skipIf(!REAL_URL)('auth-cache bus resubscribe (real Valkey)', () => {
    let proxy: ValkeyProxy;
    let other: GlideClient;
    let bus: BusModule;
    let liveness: LivenessModule;
    let valkey: ValkeyModule;
    let maxAge: MaxAgeModule;
    let closeFreshDb: () => Promise<void>;
    const savedCacheUrl = process.env.TASK_CACHE_URL;
    const userIds: string[] = [];
    const resyncs: number[] = [];

    /** Publish as another replica would (handleDeviceSessionsRevoked's payload). */
    async function publishRevocation(id: string): Promise<void> {
        await other.publish(
            JSON.stringify({
                kind: 'device-session-revoked',
                deviceSessionIds: [id],
                _from: 'other',
            }),
            CHANNEL,
        );
    }

    /** A live device session row (one unrevoked refresh token). */
    async function liveSession(): Promise<string> {
        const sql = getTestDb();
        const [user] = await sql<{ id: string }[]>`
            INSERT INTO users (username) VALUES (${`itest_bus_${randomUUID().slice(0, 8)}`})
            RETURNING id
        `;
        userIds.push(user.id);
        const sessionId = randomUUID();
        await sql`
            INSERT INTO oauth_refresh_tokens
                (token_hash, user_id, client_id, device_session_id, expires_at)
            VALUES (${randomUUID()}, ${user.id}, 'itest-client', ${sessionId}, now() + interval '1 day')
        `;
        return sessionId;
    }

    async function revokeInDbOnly(sessionId: string): Promise<void> {
        await getTestDb()`
            UPDATE oauth_refresh_tokens SET revoked_at = now() WHERE device_session_id = ${sessionId}
        `;
    }

    beforeAll(async () => {
        proxy = new ValkeyProxy(REAL_URL!.hostname, Number(REAL_URL!.port || 6379));
        await proxy.listen();
        other = await GlideClient.createClient({
            addresses: [{ host: REAL_URL!.hostname, port: Number(REAL_URL!.port || 6379) }],
            ...(REAL_URL!.password
                ? {
                      credentials: {
                          username: decodeURIComponent(REAL_URL!.username) || 'default',
                          password: decodeURIComponent(REAL_URL!.password),
                      },
                  }
                : {}),
        });

        const proxied = new URL(REAL_URL!.toString());
        proxied.hostname = '127.0.0.1';
        proxied.port = String(proxy.port);
        process.env.TASK_CACHE_URL = proxied.toString();
        vi.resetModules();
        valkey = await import('./valkey.js');
        bus = await import('./auth-cache-bus.js');
        liveness = await import('../oauth/device-session-liveness.js');
        maxAge = await import('./user-max-age-cache.js');
        closeFreshDb = (await import('../database/connection.js')).closeDb;
        bus.onAuthCacheBusResync(() => resyncs.push(Date.now()));
    });

    afterAll(async () => {
        process.env.TASK_CACHE_URL = savedCacheUrl;
        bus?._resetAuthCacheBusForTests();
        await valkey?.closeAllSubscriptions().catch(() => undefined);
        await valkey?.disconnectValkey().catch(() => undefined);
        other?.close();
        await proxy?.close();
        await closeFreshDb?.().catch(() => undefined);
        if (userIds.length > 0) {
            await getTestDb()`DELETE FROM users WHERE id = ANY(${userIds}::uuid[])`;
        }
    });

    it('boot with Valkey down: not subscribed; a revoked session is rejected from the DB', async () => {
        await bus.startAuthCacheInvalidationSubscriber();
        expect(bus.isAuthCacheBusSubscribed()).toBe(false);
        expect(bus.getAuthCacheBusStatus().state).toBe('unsubscribed');

        const sid = await liveSession();
        expect(await liveness.checkDeviceSessionLiveness(sid)).toBe('live');
        await revokeInDbOnly(sid); // revoked on another replica: no event, no marker here
        // Past the 5 s confirm window the DB decides.
        const realNow = Date.now.bind(Date);
        const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 6_000);
        try {
            expect(await liveness.checkDeviceSessionLiveness(sid)).toBe('revoked');
        } finally {
            spy.mockRestore();
        }
    });

    it("Valkey back: subscribed within the backoff window, and another instance's revocation arrives", async () => {
        proxy.mode = 'up';
        // Retries back off 1, 2, 4, … s (cap 30 s): allow one full cap.
        await vi.waitFor(() => expect(bus.isAuthCacheBusSubscribed()).toBe(true), {
            timeout: 35_000,
            interval: 200,
        });
        expect(resyncs.length).toBe(1);

        const sid = randomUUID();
        expect(liveness.isDeviceSessionTombstoned(sid)).toBe(false);
        await publishRevocation(sid);
        await vi.waitFor(() => expect(liveness.isDeviceSessionTombstoned(sid)).toBe(true), {
            timeout: 5_000,
            interval: 50,
        });

        // Comparison for the DB-fallback cases: with the bus subscribed the
        // cache IS trusted — a DB-only revocation (no event, no marker) is not
        // seen inside the fresh window, because the bus is what would carry it.
        // The marker must be readable for the cache to be trusted at all, and
        // test 1's "Valkey unavailable" memo (set under a shifted clock) must go.
        expect(await valkey.connectValkey()).toBe(true);
        liveness._resetDeviceSessionLivenessForTests();
        const cachedSid = await liveSession();
        expect(await liveness.checkDeviceSessionLiveness(cachedSid)).toBe('live');
        await revokeInDbOnly(cachedSid);
        const realNow = Date.now.bind(Date);
        const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 6_000);
        try {
            expect(await liveness.checkDeviceSessionLiveness(cachedSid)).toBe('live');
        } finally {
            spy.mockRestore();
        }
    }, 90_000);

    it('pub/sub connection dropped: re-subscribed, revocations arrive again', async () => {
        const before = resyncs.length;
        // Another auth cache on the same bus: a lowered age cap published in
        // the gap would be lost, so the resync must drop its entries too.
        maxAge.setCachedMaxAge('itest-bus-user', 18);
        proxy.drop(true);
        // GLIDE reconnects on its own; the supervisor must notice (new
        // connection id, or a missing subscription) and resync.
        await vi.waitFor(() => expect(resyncs.length).toBeGreaterThan(before), {
            timeout: 35_000,
            interval: 200,
        });
        expect(maxAge.getCachedMaxAge('itest-bus-user')).toBe(maxAge.MAX_AGE_MISS);
        await vi.waitFor(() => expect(bus.isAuthCacheBusSubscribed()).toBe(true), {
            timeout: 35_000,
            interval: 200,
        });

        const sid = randomUUID();
        await vi.waitFor(
            async () => {
                await publishRevocation(sid);
                expect(liveness.isDeviceSessionTombstoned(sid)).toBe(true);
            },
            { timeout: 10_000, interval: 250 },
        );
    }, 120_000);

    it('Valkey up but pub/sub cut: a cached live verdict does not outlive a missed revocation', async () => {
        expect(await valkey.connectValkey()).toBe(true);
        const sid = await liveSession();
        expect(await liveness.checkDeviceSessionLiveness(sid)).toBe('live');

        proxy.mode = 'block-pubsub';
        proxy.drop(true);
        await vi.waitFor(() => expect(bus.isAuthCacheBusSubscribed()).toBe(false), {
            timeout: 15_000,
            interval: 200,
        });
        // The main client still reaches Valkey: the marker read is clean.
        expect(valkey.isValkeyReady()).toBe(true);

        // Revoked elsewhere; its event is lost and no marker was written.
        await publishRevocation(sid);
        await revokeInDbOnly(sid);
        const realNow = Date.now.bind(Date);
        const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 6_000);
        try {
            expect(await liveness.checkDeviceSessionLiveness(sid)).toBe('revoked');
        } finally {
            spy.mockRestore();
        }

        proxy.mode = 'up';
        await vi.waitFor(() => expect(bus.isAuthCacheBusSubscribed()).toBe(true), {
            timeout: 35_000,
            interval: 200,
        });
    }, 90_000);
});
