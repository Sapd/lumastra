// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * C22 fix round 1: `RelayTransport` posts to `config.PUSH_RELAY_URL`
 * (deliberately admin-configurable — a self-hoster can point it at their
 * own relay, per the config.ts comment on the getter) with a Bearer
 * credential — a sibling of the twelve C22 sites, found during that task's
 * audit and left as a tracked gap, now fixed and closed here.
 *
 * Uses the REAL two-origin `http.createServer` pattern
 * `plugins/kavita/client.test.ts` established. Unlike
 * `relay-transport.test.ts` (which mocks `global.fetch` directly for its
 * business-logic assertions), this file mocks `config.PUSH_RELAY_URL` as a
 * MUTABLE value so it can point at real local servers per test.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import http from 'node:http';
import type { RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setRelayToken } from './relay-token.store.js';
import { buildPushPayload } from './push-payload.js';

const mockConfig = { PUSH_RELAY_URL: '', PUSH_RELAY_TOKEN: 'relay-secret-token' };
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: new Proxy(actual.config, {
            get: (t, p: string) =>
                p in mockConfig ? mockConfig[p as keyof typeof mockConfig] : t[p as never],
        }),
    };
});

const { RelayTransport } = await import('./relay-transport.js');

const NID = '11111111-1111-4111-8111-111111111111';
const LONG_TOKEN = 'abcdef0123456789'.repeat(4);

function req() {
    return {
        bundleId: 'de.hinterthaner.stellar-tvos.ios',
        environment: 'production' as const,
        collapseId: NID,
        expirationEpochSeconds: 1786554000,
        tokens: [LONG_TOKEN],
        payload: buildPushPayload({
            kind: 'library.new_episode',
            notificationId: NID,
            badge: 1,
            locale: 'en-US',
            mode: 'content-free',
        }),
    };
}

function startServer(
    handler: RequestListener,
): Promise<{ server: http.Server; url: string; requestCount: () => number }> {
    let count = 0;
    const wrapped: RequestListener = (r, res) => {
        count++;
        handler(r, res);
    };
    const server = http.createServer(wrapped);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            resolve({ server, url: `http://127.0.0.1:${port}`, requestCount: () => count });
        });
    });
}

function closeServer(server: http.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

describe('RelayTransport — real two-origin redirect policy (C22 fix round 1)', () => {
    let stubA: Awaited<ReturnType<typeof startServer>>;
    let stubB: Awaited<ReturnType<typeof startServer>>;

    beforeEach(() => {
        setRelayToken('relay-secret-token');
    });

    afterEach(async () => {
        if (stubA) await closeServer(stubA.server);
        if (stubB) await closeServer(stubB.server);
    });

    it('refuses a cross-host redirect: stub B receives NOTHING, the Bearer token never leaves stub A', async () => {
        stubB = await startServer((_r, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ results: [] }));
        });
        const stubBCrossHostUrl = stubB.url.replace('127.0.0.1', 'localhost');
        stubA = await startServer((r, res) => {
            expect(r.headers.authorization).toBe('Bearer relay-secret-token');
            res.writeHead(302, { Location: `${stubBCrossHostUrl}/api/push/send` });
            res.end();
        });
        mockConfig.PUSH_RELAY_URL = stubA.url;

        const transport = new RelayTransport();
        await expect(transport.send(req())).rejects.toThrow();

        expect(stubA.requestCount()).toBe(1);
        expect(stubB.requestCount()).toBe(0);
    });

    it('follows a same-host redirect and returns the relay results', async () => {
        stubA = await startServer((r, res) => {
            if (r.url === '/api/push/send') {
                res.writeHead(302, { Location: '/api/push/send/moved' });
                res.end();
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
                JSON.stringify({
                    results: [{ token: LONG_TOKEN, outcome: 'delivered' }],
                }),
            );
        });
        mockConfig.PUSH_RELAY_URL = stubA.url;

        const transport = new RelayTransport();
        const results = await transport.send(req());

        expect(results).toEqual([{ token: LONG_TOKEN, outcome: 'delivered' }]);
    });
});
