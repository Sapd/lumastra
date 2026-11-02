// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for `configureAxiosWithOptimizedAgents` — the C29 fix-plan
 * finding for the Jellyfin SDK's axios instance.
 *
 * `base-client.ts`'s `getOrInitApi()` is the ONE place the Jellyfin axios
 * instance is built, and it calls this helper immediately after creation —
 * so this is the single chokepoint to disable axios's default
 * follow-redirects behaviour (which re-sends the `MediaBrowser Token`
 * Authorization header to wherever a compromised/misconfigured Jellyfin
 * server 3xx's the request).
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import axios from 'axios';
import { configureAxiosWithOptimizedAgents } from './runtime-optimizations.js';

describe('configureAxiosWithOptimizedAgents', () => {
    // `axios.create()` returns a *function* (with methods attached), not a
    // plain object — `typeof instance === 'function'`. A REAL axios instance
    // is used here (rather than a `{ defaults: {} }` stub) specifically
    // because a stub would not have caught the pre-existing bug where the
    // old `typeof axiosInstance !== 'object'` guard silently rejected every
    // real axios instance ever passed to this function — including the
    // Jellyfin SDK's own `api.axiosInstance` in production (see base-client.ts
    // `getOrInitApi()`, which calls `jellyfin.createApi()` with no explicit
    // `axiosInstance` arg, so the SDK defaults it to `globalAxios`, a
    // function). That meant the keep-alive agents, timeout, and (before this
    // fix) `maxRedirects`/`beforeRedirect` were NEVER actually applied.
    function realInstance(): ReturnType<typeof axios.create> {
        return axios.create();
    }

    it('with no allowed-redirect host given, disables redirects entirely (safe default)', () => {
        const instance = realInstance();

        configureAxiosWithOptimizedAgents(instance);

        expect(instance.defaults.maxRedirects).toBe(0);
        expect(instance.defaults.beforeRedirect).toBeUndefined();
    });

    it('with an allowed-redirect host, sets maxRedirects: 5 and installs beforeRedirect', () => {
        const instance = realInstance();

        configureAxiosWithOptimizedAgents(instance, 'jellyfin.example.com');

        expect(instance.defaults.maxRedirects).toBe(5);
        expect(typeof instance.defaults.beforeRedirect).toBe('function');
    });

    it('beforeRedirect allows a same-host redirect target (scheme/port may differ)', () => {
        const instance = realInstance();
        configureAxiosWithOptimizedAgents(instance, 'jellyfin.example.com');

        const beforeRedirect = instance.defaults.beforeRedirect as unknown as (opts: {
            hostname: string;
        }) => void;

        expect(() => beforeRedirect({ hostname: 'jellyfin.example.com' })).not.toThrow();
    });

    it('beforeRedirect throws for a cross-host redirect target', () => {
        const instance = realInstance();
        configureAxiosWithOptimizedAgents(instance, 'jellyfin.example.com');

        const beforeRedirect = instance.defaults.beforeRedirect as unknown as (opts: {
            hostname: string;
        }) => void;

        expect(() => beforeRedirect({ hostname: 'attacker.example.com' })).toThrow();
    });

    it('still configures the keep-alive agents and timeout (unchanged behaviour)', () => {
        const instance = realInstance();

        configureAxiosWithOptimizedAgents(instance);

        expect(instance.defaults.httpAgent).toBeDefined();
        expect(instance.defaults.httpsAgent).toBeDefined();
        expect(instance.defaults.timeout).toBe(30000);
    });

    it('does nothing for an invalid instance (no throw)', () => {
        expect(() => configureAxiosWithOptimizedAgents(null)).not.toThrow();
        expect(() => configureAxiosWithOptimizedAgents(undefined)).not.toThrow();
    });

    it('does nothing for a plain object with no defaults (no throw)', () => {
        expect(() => configureAxiosWithOptimizedAgents({})).not.toThrow();
    });
});

describe('configureAxiosWithOptimizedAgents — end-to-end against real servers', () => {
    function startServer(handler: http.RequestListener): Promise<{
        server: http.Server;
        url: string;
        hostname: string;
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
                resolve({
                    server,
                    url: `http://127.0.0.1:${port}`,
                    hostname: '127.0.0.1',
                    requestCount: () => count,
                });
            });
        });
    }
    function closeServer(server: http.Server): Promise<void> {
        return new Promise((resolve) => server.close(() => resolve()));
    }

    let stubA: Awaited<ReturnType<typeof startServer>>;
    let stubB: Awaited<ReturnType<typeof startServer>>;

    afterEach(async () => {
        if (stubA) await closeServer(stubA.server);
        if (stubB) await closeServer(stubB.server);
    });

    it('follows a same-host redirect to a different port', async () => {
        stubB = await startServer((_req, res) => {
            res.writeHead(200);
            res.end('moved-target');
        });
        stubA = await startServer((req, res) => {
            if (req.url === '/System/Info') {
                res.writeHead(302, {
                    Location: `http://127.0.0.1:${new URL(stubB.url).port}/System/Info`,
                });
                res.end();
                return;
            }
            res.writeHead(200);
            res.end('should not reach here');
        });

        const instance = axios.create();
        configureAxiosWithOptimizedAgents(instance, stubA.hostname);

        const res = await instance.get(`${stubA.url}/System/Info`);
        expect(res.data).toBe('moved-target');
        expect(stubB.requestCount()).toBe(1);
    });

    it('refuses a cross-host redirect and stub B receives nothing', async () => {
        stubB = await startServer((_req, res) => {
            res.writeHead(200);
            res.end('should never be reached');
        });
        // Same loopback address, but a DIFFERENT hostname STRING than stubA
        // ("localhost" vs "127.0.0.1") — a real cross-host redirect target,
        // without needing two distinct machines.
        const stubBCrossHostUrl = stubB.url.replace('127.0.0.1', 'localhost');
        stubA = await startServer((_req, res) => {
            res.writeHead(302, { Location: stubBCrossHostUrl });
            res.end();
        });

        const instance = axios.create();
        configureAxiosWithOptimizedAgents(instance, stubA.hostname);

        await expect(instance.get(stubA.url)).rejects.toThrow();
        expect(stubB.requestCount()).toBe(0);
    });
});

/**
 * C22 fix-plan finding — "latent": this module used to export a THIRD,
 * independently hand-rolled `fetchWithTimeout`/`FetchTimeoutError` pair that
 * followed redirects with plain default `fetch()` behaviour (no manual
 * redirect loop, no same-origin check at all). It had no importer, but an
 * editor's auto-import completing `fetchWithTimeout` from this file instead
 * of `utils/fetch-utils.ts` / `utils/fetch-timeout.ts` would have silently
 * reopened redirect-follow for whatever credentialed client picked it. This
 * module is deleted rather than fixed in place — the collapse invariant is
 * "one redirect loop in the tree", not "N loops that each individually
 * refuse cross-origin".
 */
describe('C22: no redirect-following fetch helper re-exported from this module', () => {
    it('does not export fetchWithTimeout', async () => {
        const mod = await import('./runtime-optimizations.js');
        expect((mod as Record<string, unknown>).fetchWithTimeout).toBeUndefined();
    });

    it('does not export FetchTimeoutError', async () => {
        const mod = await import('./runtime-optimizations.js');
        expect((mod as Record<string, unknown>).FetchTimeoutError).toBeUndefined();
    });
});
