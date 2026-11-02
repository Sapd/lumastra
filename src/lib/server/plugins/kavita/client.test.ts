// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for plugins/kavita/client.ts — the C29 fix-plan finding.
 *
 * Both HTTP call sites (`authenticate()` and `apiRequest()`) used bare
 * `fetch()`, which follows an arbitrary redirect by default. Kavita is an
 * admin-configured integration whose API key/JWT is sent on every request,
 * so a compromised or misbehaving Kavita server answering a redirect could
 * pivot the request (and its credentials) to any host the app can reach.
 *
 * These tests use two REAL local HTTP servers (different ports = different
 * origins) so a passing test proves the second server never receives a
 * request — not just that a mocked fetch call was shaped a certain way.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FetchRedirectError } from '$lib/server/utils/fetch-utils.js';

// ── Config mock ──────────────────────────────────────────────────────────────
//
// kavita/client.ts reads `config.KAVITAURL` / `config.KAVITAAPIKEY` on every
// call (no module-load-time snapshot), so a mutable object works — tests
// point it at whichever stub server they started.

// Hoisted: the static fetch-utils import above loads provider-calls, which reads
// config before this module body runs.
const mockConfig = vi.hoisted(() => ({ KAVITAURL: '', KAVITAAPIKEY: 'test-api-key' }));
vi.mock('$lib/server/config.js', () => ({ config: mockConfig }));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

// `authenticate()` is not exported directly — `getLibraries()` (which calls
// `apiRequest()`, which calls `authenticate()` first) exercises BOTH call
// sites, so each describe block below arranges the stub server to redirect
// at the specific call site it targets.
const { getLibraries, clearAuthCache } = await import('./client.js');

// ── Stub server helper ───────────────────────────────────────────────────────

function startServer(handler: http.RequestListener): Promise<{
    server: http.Server;
    url: string;
    requestCount: () => number;
}> {
    let count = 0;
    const wrapped: http.RequestListener = (req, res) => {
        count++;
        handler(req, res);
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

describe('kavita/client.ts — redirect policy (C29)', () => {
    let stubA: Awaited<ReturnType<typeof startServer>>;
    let stubB: Awaited<ReturnType<typeof startServer>>;

    beforeEach(() => {
        clearAuthCache();
    });

    afterEach(async () => {
        if (stubA) await closeServer(stubA.server);
        if (stubB) await closeServer(stubB.server);
    });

    describe('authenticate() — POST /api/Plugin/authenticate', () => {
        it('follows a same-origin redirect (getLibraries succeeds end-to-end)', async () => {
            stubA = await startServer((req, res) => {
                if (req.url?.includes('/api/Plugin/authenticate') && !req.url.includes('/moved')) {
                    res.writeHead(302, { Location: '/api/Plugin/authenticate/moved' });
                    res.end();
                    return;
                }
                if (req.url?.includes('/api/Plugin/authenticate')) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ token: 'jwt-token-abc' }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify([{ id: 1, name: 'Comics' }]));
            });
            mockConfig.KAVITAURL = stubA.url;

            const libraries = await getLibraries();
            expect(libraries).toEqual([{ id: 1, name: 'Comics' }]);
        });

        it('throws FetchRedirectError on a cross-origin redirect and stub B receives nothing', async () => {
            stubB = await startServer((_req, res) => {
                res.writeHead(200);
                res.end('should never be reached');
            });
            // Same loopback address, but a DIFFERENT hostname STRING than
            // stubA ("localhost" vs "127.0.0.1") — a real cross-host
            // redirect target. A same-HOST redirect may now change PORT
            // (fix-plan ledger, Task 11 standing policy), so two stub
            // servers differing only by port are no longer a valid
            // stand-in for "cross-origin".
            const stubBCrossHostUrl = stubB.url.replace('127.0.0.1', 'localhost');
            stubA = await startServer((req, res) => {
                if (req.url?.includes('/api/Plugin/authenticate')) {
                    res.writeHead(302, {
                        Location: `${stubBCrossHostUrl}/api/Plugin/authenticate`,
                    });
                    res.end();
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify([{ id: 1, name: 'Comics' }]));
            });
            mockConfig.KAVITAURL = stubA.url;

            await expect(getLibraries()).rejects.toBeInstanceOf(FetchRedirectError);
            expect(stubB.requestCount()).toBe(0);
        });
    });

    describe('apiRequest() (via getLibraries) — GET /api/Library/libraries', () => {
        it('follows a same-origin redirect', async () => {
            stubA = await startServer((req, res) => {
                if (req.url?.includes('/api/Plugin/authenticate')) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ token: 'jwt-token-abc' }));
                    return;
                }
                if (req.url === '/api/Library/libraries') {
                    res.writeHead(302, { Location: '/api/Library/libraries/moved' });
                    res.end();
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify([{ id: 1, name: 'Comics' }]));
            });
            mockConfig.KAVITAURL = stubA.url;

            const libraries = await getLibraries();
            expect(libraries).toEqual([{ id: 1, name: 'Comics' }]);
        });

        it('throws FetchRedirectError on a cross-origin redirect and stub B receives nothing', async () => {
            stubB = await startServer((_req, res) => {
                res.writeHead(200);
                res.end('should never be reached');
            });
            // Same loopback address, but a DIFFERENT hostname STRING than
            // stubA ("localhost" vs "127.0.0.1") — a real cross-host
            // redirect target. A same-HOST redirect may now change PORT
            // (fix-plan ledger, Task 11 standing policy), so two stub
            // servers differing only by port are no longer a valid
            // stand-in for "cross-origin".
            const stubBCrossHostUrl = stubB.url.replace('127.0.0.1', 'localhost');
            stubA = await startServer((req, res) => {
                if (req.url?.includes('/api/Plugin/authenticate')) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ token: 'jwt-token-abc' }));
                    return;
                }
                res.writeHead(302, { Location: `${stubBCrossHostUrl}/api/Library/libraries` });
                res.end();
            });
            mockConfig.KAVITAURL = stubA.url;

            await expect(getLibraries()).rejects.toBeInstanceOf(FetchRedirectError);
            expect(stubB.requestCount()).toBe(0);
        });
    });
});
