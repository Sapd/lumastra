// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for jellyseerr.ts `JellyseerrClient.makeRequest` — the C29
 * fix-plan finding.
 *
 * Jellyseerr is an admin-configured integration whose `X-Api-Key` travels
 * on every request (via `$lib/server/utils/fetch-utils.js` `fetchWithTimeout`).
 * `jellyseerrClient` is a module-level singleton built from `config.SEERRURL`
 * at import time, so each test re-mocks config with `vi.doMock` + reimports
 * the module fresh (`vi.resetModules()`) once the stub server's ephemeral
 * port is known.
 *
 * Uses two REAL local HTTP servers (different ports = different origins) so
 * a passing test proves the second server never receives a request.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

function startServer(handler: http.RequestListener): Promise<{
    server: http.Server;
    url: string;
    requestCount: () => number;
}> {
    let count = 0;
    const server = http.createServer((req, res) => {
        count++;
        handler(req, res);
    });
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

async function loadClient(baseUrl: string) {
    vi.resetModules();
    vi.doMock('$lib/server/config.js', async (importOriginal) => {
        const actual = await importOriginal<typeof import('$lib/server/config.js')>();
        return {
            ...actual,
            config: { ...actual.config, SEERRURL: baseUrl, SEERRAPIKEY: 'test-key' },
        };
    });
    const mod = await import('./jellyseerr.js');
    return mod.jellyseerrClient;
}

describe('jellyseerr.ts JellyseerrClient — redirect policy (C29)', () => {
    let stubA: Awaited<ReturnType<typeof startServer>>;
    let stubB: Awaited<ReturnType<typeof startServer>>;

    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(async () => {
        vi.doUnmock('$lib/server/config.js');
        if (stubA) await closeServer(stubA.server);
        if (stubB) await closeServer(stubB.server);
    });

    it('returns metadata and request state for seasons absent from the library', async () => {
        stubA = await startServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
                JSON.stringify({
                    id: 123,
                    name: 'Series',
                    seasons: [
                        { seasonNumber: 1, name: 'Season 1', episodeCount: 6 },
                        { seasonNumber: 2, name: 'Season 2', episodeCount: 8 },
                        { seasonNumber: 3, name: 'Season 3', episodeCount: 4 },
                    ],
                    mediaInfo: {
                        seasons: [
                            { seasonNumber: 1, status: 5 },
                            { seasonNumber: 2, status: 3 },
                        ],
                    },
                }),
            );
        });
        const client = await loadClient(stubA.url);
        const seasons = await client.getRequestSeasons(123);
        expect(seasons).toEqual([
            expect.objectContaining({
                seasonNumber: 1,
                episodeCount: 6,
                isAvailable: true,
                isPending: false,
            }),
            expect.objectContaining({ seasonNumber: 2, isAvailable: false, isPending: true }),
            expect.objectContaining({ seasonNumber: 3, isAvailable: false, isPending: false }),
        ]);
    });

    it('follows a same-origin redirect', async () => {
        stubA = await startServer((req, res) => {
            if (req.url === '/api/v1/user?take=100') {
                res.writeHead(302, { Location: '/api/v1/user?take=100&moved=1' });
                res.end();
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ pageInfo: {}, results: [{ id: 1 }] }));
        });

        const client = await loadClient(stubA.url);
        const users = await client.getUsers();
        expect(users).toEqual([{ id: 1 }]);
    });

    it('refuses a cross-origin redirect, degrades gracefully, and stub B receives nothing', async () => {
        stubB = await startServer((_req, res) => {
            res.writeHead(200);
            res.end('should never be reached');
        });
        // Same loopback address, but a DIFFERENT hostname STRING than stubA
        // ("localhost" vs "127.0.0.1") — a real cross-host redirect target.
        // A same-HOST redirect may now change PORT (fix-plan ledger, Task 11
        // standing policy), so two stub servers differing only by port are
        // no longer a valid stand-in for "cross-origin".
        const stubBCrossHostUrl = stubB.url.replace('127.0.0.1', 'localhost');
        stubA = await startServer((_req, res) => {
            res.writeHead(302, { Location: `${stubBCrossHostUrl}/api/v1/user` });
            res.end();
        });

        const client = await loadClient(stubA.url);
        const users = await client.getUsers();
        expect(users).toEqual([]);
        expect(stubB.requestCount()).toBe(0);
    }, 10_000);
});

describe('jellyseerr.ts JellyseerrClient — /user listing cache', () => {
    let stub: Awaited<ReturnType<typeof startServer>>;

    afterEach(async () => {
        vi.doUnmock('$lib/server/config.js');
        if (stub) await closeServer(stub.server);
    });

    it('serves repeated and concurrent lookups from one upstream call', async () => {
        stub = await startServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ pageInfo: {}, results: [{ id: 7, username: 'Denis' }] }));
        });
        const client = await loadClient(stub.url);

        const [a, b] = await Promise.all([client.getUsers(), client.getUsers()]);
        const link = await client.resolveUserLink('denis');
        const byName = await client.getUserByUsername('denis');

        expect(a).toEqual([{ id: 7, username: 'Denis' }]);
        expect(b).toBe(a);
        expect(link.state).toBe('linked');
        expect(byName?.id).toBe(7);
        expect(stub.requestCount()).toBe(1);
    });

    it('does not remember a failed listing — the next call asks again', async () => {
        let fail = true;
        stub = await startServer((_req, res) => {
            if (fail) {
                res.writeHead(500);
                res.end('boom');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ pageInfo: {}, results: [{ id: 1 }] }));
        });
        const client = await loadClient(stub.url);

        expect(await client.getUsers()).toEqual([]);
        fail = false;
        expect(await client.getUsers()).toEqual([{ id: 1 }]);
        expect(stub.requestCount()).toBe(2);
    });
});

describe('jellyseerr.ts JellyseerrClient — "not reachable" latch', () => {
    afterEach(() => {
        vi.doUnmock('$lib/server/config.js');
        vi.doUnmock('$lib/server/utils/fetch-utils.js');
        vi.restoreAllMocks();
    });

    it('asks Seerr again once the retry window lapses, instead of failing until a restart', async () => {
        let dnsDown = true;
        const fetchWithTimeout = vi.fn(async () => {
            if (dnsDown) {
                throw new Error('fetch failed', {
                    cause: Object.assign(new Error('getaddrinfo ENOTFOUND seerr'), {
                        code: 'ENOTFOUND',
                    }),
                });
            }
            return new Response(JSON.stringify({ pageInfo: {}, results: [{ id: 3 }] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
        vi.doMock('$lib/server/utils/fetch-utils.js', async (importOriginal) => ({
            ...(await importOriginal<typeof import('$lib/server/utils/fetch-utils.js')>()),
            fetchWithTimeout,
        }));
        let now = 1_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const client = await loadClient('http://seerr.example');

        expect(await client.getUsers()).toEqual([]);
        expect(client.isConfigured()).toBe(false);
        expect((await client.resolveUserLink('denis')).state).toBe('unavailable');
        expect(fetchWithTimeout).toHaveBeenCalledTimes(1);

        dnsDown = false;
        now += 61_000;
        expect(client.isConfigured()).toBe(true);
        expect(await client.getUsers()).toEqual([{ id: 3 }]);
        expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    });
});
