// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * C22 fix round 1 (review of the original C22 fix-plan finding): the
 * previous version of this test replaced `global.fetch` wholesale with a
 * `vi.fn()` and asserted on the shape of the single call it captured
 * (`redirect:'manual'`) — a full-mock replacement cannot discriminate a
 * guarded call from an unguarded one, since it can't simulate undici's real
 * automatic-redirect-follow behaviour either way.
 *
 * The cross-host case below uses the REAL two-origin `http.createServer`
 * pattern `plugins/kavita/client.test.ts` established (`startServer`
 * helper, a cross-host redirect built by rewriting the target's hostname
 * string, a request counter proving the second origin was never reached),
 * applied directly to `guardedFetch` — the local redirect guard `index.js`
 * keeps for the ONE call `ctx.http` cannot express (MAL's PATCH
 * `/anime/{id}/my_list_status`). Unlike testing through the full plugin
 * call chain, `guardedFetch` takes an arbitrary URL, so it can be pointed
 * at real local servers directly — `MAL_API_BASE`/`MAL_TOKEN_URL` being
 * hardcoded, real hosts is what made the two-origin pattern impossible for
 * the OTHER calls in this file (now routed through `ctx.http`, whose
 * redirect guard is `safeFetch` — see `tasks/url-safety.test.ts`, tested
 * with DNS/undici mocking, the correct technique for DNS-pinning).
 *
 * Scheme upgrade/downgrade is tested with a mocked `fetch` instead (real TLS
 * negotiation against a plain `http.createServer` is not practical without
 * generating certificates) — this mirrors exactly how `fetch-utils.test.ts`
 * tests the SAME policy on the canonical implementation, and the scheme
 * check itself is a pure protocol-string comparison, not something that
 * needs a live second origin to prove.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import { guardedFetch, MalRedirectError } from './index.js';

function startServer(handler) {
    let count = 0;
    const wrapped = (req, res) => {
        count++;
        handler(req, res);
    };
    const server = http.createServer(wrapped);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, url: `http://127.0.0.1:${port}`, requestCount: () => count });
        });
    });
}

function closeServer(server) {
    return new Promise((resolve) => server.close(() => resolve()));
}

describe('mal-watch-sync guardedFetch — real two-origin cross-host policy (C22 fix round 1)', () => {
    let stubA;
    let stubB;

    afterEach(async () => {
        if (stubA) await closeServer(stubA.server);
        if (stubB) await closeServer(stubB.server);
        stubA = undefined;
        stubB = undefined;
    });

    it('refuses a cross-host redirect: stub B receives NOTHING, credential never leaves stub A', async () => {
        stubB = await startServer((_req, res) => {
            res.writeHead(200);
            res.end('should never be reached');
        });
        // Same loopback address, but a DIFFERENT hostname STRING than stubA
        // ("localhost" vs "127.0.0.1") — a real cross-host redirect target.
        const stubBCrossHostUrl = stubB.url.replace('127.0.0.1', 'localhost');
        stubA = await startServer((req, res) => {
            expect(req.headers.authorization).toBe('Bearer mal-secret-token');
            res.writeHead(302, { Location: `${stubBCrossHostUrl}/anime/1/my_list_status` });
            res.end();
        });

        await expect(
            guardedFetch(`${stubA.url}/anime/1/my_list_status`, {
                method: 'PATCH',
                headers: { Authorization: 'Bearer mal-secret-token' },
                body: 'status=completed',
            }),
        ).rejects.toBeInstanceOf(MalRedirectError);

        expect(stubA.requestCount()).toBe(1);
        expect(stubB.requestCount()).toBe(0);
    });

    it('follows a same-host redirect (different path) and returns the final response', async () => {
        stubA = await startServer((req, res) => {
            if (req.url === '/anime/1/my_list_status') {
                res.writeHead(302, { Location: '/anime/1/my_list_status/moved' });
                res.end();
                return;
            }
            res.writeHead(200);
            res.end('ok');
        });

        const res = await guardedFetch(`${stubA.url}/anime/1/my_list_status`, {
            method: 'PATCH',
            headers: { Authorization: 'Bearer mal-secret-token' },
            body: 'status=completed',
        });

        expect(res.status).toBe(200);
        expect(await res.text()).toBe('ok');
    });
});

describe('mal-watch-sync guardedFetch — same-host scheme policy (mocked, mirrors fetch-utils.test.ts)', () => {
    let mockFetch;

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function redirectResponse(location, status = 302) {
        return new Response(null, { status, headers: { location } });
    }

    it('follows a same-host redirect to a DIFFERENT PORT (same scheme)', async () => {
        mockFetch = vi
            .fn()
            .mockResolvedValueOnce(redirectResponse('https://mal.example.com:8443/other'))
            .mockResolvedValueOnce(new Response('final', { status: 200 }));
        vi.stubGlobal('fetch', mockFetch);

        const res = await guardedFetch('https://mal.example.com/api', { method: 'PATCH' });
        expect(await res.text()).toBe('final');
        expect(mockFetch.mock.calls[1][0]).toBe('https://mal.example.com:8443/other');
    });

    it('follows a same-host scheme UPGRADE (http -> https)', async () => {
        mockFetch = vi
            .fn()
            .mockResolvedValueOnce(redirectResponse('https://mal.example.com/other'))
            .mockResolvedValueOnce(new Response('final', { status: 200 }));
        vi.stubGlobal('fetch', mockFetch);

        const res = await guardedFetch('http://mal.example.com/api', { method: 'PATCH' });
        expect(await res.text()).toBe('final');
        expect(mockFetch.mock.calls[1][0]).toBe('https://mal.example.com/other');
    });

    it('refuses a same-host scheme DOWNGRADE (https -> http)', async () => {
        mockFetch = vi.fn().mockResolvedValueOnce(redirectResponse('http://mal.example.com/other'));
        vi.stubGlobal('fetch', mockFetch);

        await expect(
            guardedFetch('https://mal.example.com/api', { method: 'PATCH' }),
        ).rejects.toBeInstanceOf(MalRedirectError);
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
});
