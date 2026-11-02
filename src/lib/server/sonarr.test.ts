// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for sonarr.ts `ArrClientBase.get` — the C29 fix-plan finding.
 *
 * Sonarr/Radarr are admin-configured integrations whose `X-Api-Key` travels
 * on every request (via `$lib/server/utils/fetch-utils.js` `fetchWithTimeout`,
 * a header undici does NOT strip on a cross-origin redirect). These tests
 * prove the shared helper's same-origin-only redirect policy applies
 * end-to-end through `SonarrClient.ping()`, using two REAL local HTTP
 * servers (different ports = different origins) so a passing test proves
 * the second server never receives a request.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SonarrClient } from './sonarr.js';

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

describe('sonarr.ts ArrClientBase.get — redirect policy (C29)', () => {
    let stubA: Awaited<ReturnType<typeof startServer>>;
    let stubB: Awaited<ReturnType<typeof startServer>>;

    afterEach(async () => {
        if (stubA) await closeServer(stubA.server);
        if (stubB) await closeServer(stubB.server);
    });

    it('follows a same-origin redirect', async () => {
        stubA = await startServer((req, res) => {
            if (req.url === '/api/v3/system/status') {
                res.writeHead(302, { Location: '/api/v3/system/status/moved' });
                res.end();
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ version: '4.0.0' }));
        });

        const client = new SonarrClient(stubA.url, 'test-api-key');
        const ok = await client.ping();
        expect(ok).toBe(true);
    });

    it('refuses a cross-origin redirect and stub B receives nothing', async () => {
        stubB = await startServer((_req, res) => {
            res.writeHead(200);
            res.end('should never be reached');
        });
        // Same loopback address, but a DIFFERENT hostname STRING than stubA
        // ("localhost" vs "127.0.0.1") — a real cross-host redirect target.
        // A same-HOST redirect may now change PORT (fix-plan ledger, Task 11
        // standing policy — see fetch-utils.ts's `isAllowedRedirectTarget`),
        // so two stub servers differing only by port are no longer a valid
        // stand-in for "cross-origin".
        const stubBCrossHostUrl = stubB.url.replace('127.0.0.1', 'localhost');
        stubA = await startServer((_req, res) => {
            res.writeHead(302, { Location: `${stubBCrossHostUrl}/api/v3/system/status` });
            res.end();
        });

        const client = new SonarrClient(stubA.url, 'test-api-key');
        const ok = await client.ping();
        expect(ok).toBe(false);
        expect(stubB.requestCount()).toBe(0);
    }, 10_000);
});

describe('SonarrClient.getSeriesByTvdbId', () => {
    let stub: Awaited<ReturnType<typeof startServer>>;

    afterEach(async () => {
        if (stub) await closeServer(stub.server);
    });

    it('asks Sonarr to filter by tvdbId instead of downloading the whole library', async () => {
        const urls: string[] = [];
        stub = await startServer((req, res) => {
            urls.push(req.url ?? '');
            const u = new URL(req.url ?? '', 'http://x');
            const tvdbId = Number(u.searchParams.get('tvdbId'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(tvdbId ? [{ id: 7, title: 'Match', tvdbId }] : []));
        });

        const client = new SonarrClient(stub.url, 'test-api-key');
        const series = await client.getSeriesByTvdbId(349187);

        expect(series).toMatchObject({ id: 7, tvdbId: 349187 });
        expect(urls).toEqual(['/api/v3/series?tvdbId=349187']);
    });
});

describe('SonarrClient.getSeriesByTvdbId — unexpected filtered shape', () => {
    let stub: Awaited<ReturnType<typeof startServer>>;

    afterEach(async () => {
        if (stub) await closeServer(stub.server);
    });

    it('falls back to the full list instead of reporting a live series missing', async () => {
        stub = await startServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            const filtered = (req.url ?? '').includes('tvdbId=');
            res.end(
                JSON.stringify(
                    filtered ? { id: 7, tvdbId: 1 } : [{ id: 7, title: 'Match', tvdbId: 1 }],
                ),
            );
        });

        const series = await new SonarrClient(stub.url, 'k').getSeriesByTvdbId(1);

        expect(series).toMatchObject({ id: 7, tvdbId: 1 });
    });
});
