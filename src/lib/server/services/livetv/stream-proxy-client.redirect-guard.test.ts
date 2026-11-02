// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * C22 fix round 1: the stream-proxy client posts to `config.STREAM_PROXY_URL`
 * (admin-configurable) with an `X-Proxy-Secret` credential — a sibling of
 * the twelve C22 sites, found during that task's audit (and, per the
 * review, "literally no redirect handling at all — the reviewer agreed
 * with your 'highest-severity of the three'"), now fixed and closed here.
 *
 * Uses the REAL two-origin `http.createServer` pattern
 * `plugins/kavita/client.test.ts` established. Unlike
 * `stream-proxy-client.test.ts` (which mocks `global.fetch` directly for
 * its business-logic assertions), this file mocks
 * `config.STREAM_PROXY_URL`/`STREAM_PROXY_SECRET` as MUTABLE values so it
 * can point at real local servers per test.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';

const mockConfig = { STREAM_PROXY_URL: '', STREAM_PROXY_SECRET: 'proxy-secret-value' };
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

const { createStreamProxyClient, proxyFetch } = await import('./stream-proxy-client.js');

function startServer(
    handler: RequestListener,
): Promise<{ server: http.Server; url: string; requestCount: () => number }> {
    let count = 0;
    const wrapped: RequestListener = (req, res) => {
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

describe('stream-proxy-client — real two-origin redirect policy (C22 fix round 1)', () => {
    let stubA: Awaited<ReturnType<typeof startServer>>;
    let stubB: Awaited<ReturnType<typeof startServer>>;

    afterEach(async () => {
        if (stubA) await closeServer(stubA.server);
        if (stubB) await closeServer(stubB.server);
    });

    it('refuses a cross-host redirect: stub B receives NOTHING, X-Proxy-Secret never leaves stub A', async () => {
        stubB = await startServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
        const stubBCrossHostUrl = stubB.url.replace('127.0.0.1', 'localhost');
        stubA = await startServer((req, res) => {
            expect(req.headers['x-proxy-secret']).toBe('proxy-secret-value');
            res.writeHead(302, { Location: `${stubBCrossHostUrl}/streams/ch-1/join` });
            res.end();
        });
        mockConfig.STREAM_PROXY_URL = stubA.url;

        const client = createStreamProxyClient();
        await expect(
            client.joinChannel('ch-1', { viewerId: 'v1', clientId: 'c1' } as never),
        ).rejects.toThrow();

        expect(stubA.requestCount()).toBe(1);
        expect(stubB.requestCount()).toBe(0);
    });

    it('follows a same-host redirect and returns the proxy response', async () => {
        stubA = await startServer((req, res) => {
            if (req.url === '/streams/ch-1/join') {
                res.writeHead(302, { Location: '/streams/ch-1/join/moved' });
                res.end();
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sessionId: 'sess-1' }));
        });
        mockConfig.STREAM_PROXY_URL = stubA.url;

        const client = createStreamProxyClient();
        const result = await client.joinChannel('ch-1', {
            viewerId: 'v1',
            clientId: 'c1',
        } as never);

        expect(result).toEqual({ sessionId: 'sess-1' });
    });
});

describe('stream-proxy-client — whole-exchange timeout covers a stalled body (C22 fix round 2)', () => {
    let stubA: Awaited<ReturnType<typeof startServer>>;

    afterEach(async () => {
        if (stubA) await closeServer(stubA.server);
    });

    /**
     * `proxyHlsSegment`/`proxyHlsRungSegment` pipe `proxyResponse.body`
     * straight through to the HLS client (see the `/j` Live TV routes) and
     * are called with no per-request `signal` of their own. `fetchWithTimeout`
     * clears its OWN internal timer as soon as headers resolve (see
     * `fetch-utils.test.ts`'s "chat-generation timeout" suite) — so a naive
     * `fetchWithTimeout(url, init, timeoutMs)` call here would let a server
     * that sends headers and then never finishes the body hang this call
     * forever. `proxyFetch` composes an independent `AbortSignal.timeout`
     * that stays attached to the connection for body reads too — this test
     * proves that composed signal, not `fetchWithTimeout`'s internal one,
     * is what bounds the exchange.
     */
    it('aborts a request whose body never finishes, within the whole-exchange bound', async () => {
        stubA = await startServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
            res.write('first-chunk');
            // Deliberately never call res.end() — the connection is held
            // open indefinitely, simulating a stream-proxy backend that
            // stalls mid-segment.
        });

        const start = Date.now();
        const response = await proxyFetch(
            `${stubA.url}/streams/ch-1/segment-1.ts`,
            { method: 'GET' },
            undefined,
            200, // shrink the whole-exchange bound so the test doesn't wait 45s
        );

        // Headers arrived fine — the timeout must fire while draining the
        // body, not before.
        expect(response.status).toBe(200);
        await expect(response.text()).rejects.toThrow();
        expect(Date.now() - start).toBeLessThan(5000);
    });
});
