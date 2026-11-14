// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Route-level SSRF/redirect-pivot test for `/j/UserImage`, mirroring
 * `defs/music/lyrics-search-ssrf-redirect.test.ts`'s shape: mock everything
 * around the target call (DB, config, the Jellyfin user-id resolver) but let
 * the REAL `ImageProxyService.getUserAvatar` → `fetchWithTimeout` chain run
 * unmodified, then prove end-to-end that a malicious/compromised Jellyfin
 * server cannot pivot the request off-origin.
 *
 * C22 fix-plan finding: `getUserAvatar`'s Jellyfin-avatar fetch carries the
 * Jellyfin ADMIN token (`config.JELLYFINAPIKEY`) on every request, and this
 * route is reachable **anonymously** (no auth — see the route's own file
 * doc) — Jellyseerr fetches it without a session. Before the fix this was a
 * bare `fetch()`; an attacker who can make the configured Jellyfin server
 * (or an on-path party) answer with a 3xx could pivot that admin-token-
 * bearing request anywhere the app's network position can reach.
 *
 * C22 fix round 2: this file used to replace `globalThis.fetch` wholesale and
 * discriminate purely on call *shape* (`redirect:'manual'`, the URL/headers of
 * every call) — real `fetch()` under a full mock replacement can't exhibit
 * undici's actual automatic-redirect-follow behaviour either way, so a shape
 * assertion can't tell a genuinely guarded call from an unguarded one that
 * merely happens to pass `redirect:'manual'`. Converted to the REAL
 * two-origin `http.createServer` pattern (`plugins/kavita/client.test.ts`,
 * `stream-proxy-client.redirect-guard.test.ts`, `relay-transport
 * .redirect-guard.test.ts`, `hls-audio-injection.redirect-guard.test.ts`) —
 * `mockConfigOverrides.JELLYFINURL` points at a REAL local stub A, which
 * 302s to a REAL local stub B on a different hostname
 * (`127.0.0.1` vs `localhost`, same loopback), and the assertion is
 * `stubB.requestCount() === 0`: the redirect guard loop genuinely runs and
 * genuinely refuses to dial the second origin, not just "was called with the
 * right-shaped options".
 *
 * The named file "+server.ts" cannot be imported as a test module (SvelteKit
 * only allows reserved handler exports there) — this file is `server.test.ts`
 * per the project convention (see root CLAUDE.md's SvelteKit route note) and
 * imports the sibling `+server.ts` directly, which vitest resolves fine even
 * though SvelteKit's own dev/build pipeline wouldn't treat it as a route.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import http from 'node:http';
import type { RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';

// ── DB mock — the route's own lookup + the ImageProxyService singleton's pool handle ──

const mockSql = vi.fn(() => Promise.resolve([{ username: 'alice' }]));
vi.mock('$lib/server/database', () => ({
    getDb: () => mockSql,
}));

// Custom-avatar / user lookups the service consults before Jellyfin — none
// configured, so the real getUserAvatar() falls through to the Jellyfin step.
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: vi.fn().mockResolvedValue(null),
    getUserById: vi.fn().mockResolvedValue(null),
    getUserAvatar: vi.fn().mockResolvedValue(null),
    getUserAvatarVersion: vi.fn().mockResolvedValue(null),
}));

// Jellyfin is "enabled" and username 'alice' resolves to a fixed Jellyfin GUID.
vi.mock('$lib/server/operation-mode.js', () => ({
    operationMode: { isJellyfinEnabled: true },
}));
vi.mock('$lib/server/services/jellyfin-user-id-resolver.js', () => ({
    resolveJellyfinUserId: vi.fn().mockResolvedValue('deadbeef-0000-4000-8000-000000000000'),
}));

const mockConfigOverrides: Record<string, unknown> = {
    JELLYFINURL: '',
    JELLYFINAPIKEY: 'admin-jellyfin-token',
    IMAGE_WEBP_ENABLED: false,
    IMAGE_THUMB_QUALITY: 80,
};
const mockFeatures: Record<string, unknown> = { gravatar: false };
vi.mock('$lib/server/config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config')>();
    return {
        ...actual,
        features: mockFeatures,
        config: new Proxy(actual.config, {
            get: (target, prop: string) =>
                prop in mockConfigOverrides ? mockConfigOverrides[prop] : target[prop as never],
        }),
    };
});

// The Jellyfin runtime gate (sync on + connected + breaker closed) is covered by
// its own tests; here it is open so the route's redirect handling is exercised.
vi.mock('$lib/server/jellyfin/runtime-gate.js', () => ({
    JELLYFIN_DIRECT_FETCH_TIMEOUT_MS: 2_500,
    isJellyfinSyncEnabled: () => true,
    canCallJellyfin: () => true,
    recordJellyfinTransportFailure: vi.fn(),
    recordJellyfinTransportSuccess: vi.fn(),
}));

vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

// ImageCache is a REAL on-disk cache rooted at `process.cwd()/.cache/...` —
// unmocked, a run of this test would read/write the actual project checkout's
// cache directory (and a prior run's write would poison a later run's
// "cache miss" assumption, since disk state outlives the test process). Stub
// it to always miss and never write, so this test only exercises the redirect
// guard, not disk I/O.
vi.mock('$lib/server/services/image-proxy/cache.js', () => ({
    ImageCache: class {
        async read(): Promise<null> {
            return null;
        }
        async write(): Promise<void> {}
        async deleteByPrefix(): Promise<void> {}
    },
}));

// The C22 guard under test sits behind the credential gate (covered by
// ../user-images-auth.server.test.ts); here every request counts as signed in.
vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: unknown) => handler,
    withOptionalJellyfinAuth: (handler: unknown) => handler,
}));

// ── Import route AFTER mocks ────────────────────────────────────────────────

const { GET } = await import('./+server.js');
const { getImageProxyService } = await import('$lib/server/services/image-proxy');
type UserImageEvent = Parameters<typeof GET>[0];

function makeEvent(userId: string): UserImageEvent {
    const url = new URL('http://localhost/j/UserImage');
    url.searchParams.set('UserId', userId);
    const request = new Request(url.toString());
    return {
        url,
        params: {},
        route: { id: '/(modules)/j/UserImage' as const },
        request,
        locals: {},
        cookies: {},
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as UserImageEvent;
}

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

describe('/j/UserImage — refuses a cross-origin redirect from the configured Jellyfin server (C22)', () => {
    let stubA: Awaited<ReturnType<typeof startServer>>;
    let stubB: Awaited<ReturnType<typeof startServer>>;

    // `getImageProxyService()` is a module singleton shared by both cases below,
    // and a request that resolves to no avatar now leaves a negative-cache entry
    // behind (see ImageProxyService.avatarMissCache) — the first case's refused
    // redirect is exactly such a miss. Without this, the control case would be
    // short-circuited before ever dialling stub A and its
    // `requestCount() === 1` assertion would read 0 for the wrong reason.
    beforeEach(async () => {
        await getImageProxyService().invalidateAvatarCache('alice');
    });

    afterEach(async () => {
        if (stubA) await closeServer(stubA.server);
        if (stubB) await closeServer(stubB.server);
    });

    it('a 302 to a different origin is refused: the route still responds (default avatar), stub B receives NOTHING, and the admin token never left stub A', async () => {
        stubB = await startServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'image/jpeg' });
            res.end(Buffer.from([1, 2, 3, 4]));
        });
        const stubBCrossHostUrl = stubB.url.replace('127.0.0.1', 'localhost');
        stubA = await startServer((req, res) => {
            // The guard's fingerprint: it re-validates the Location itself
            // (redirect:'manual') rather than letting the runtime follow it —
            // there is no way to observe `redirect:'manual'` from the server
            // side, so the load-bearing assertion is stubB.requestCount()
            // below; this handler only checks the credential.
            expect(req.headers.authorization).toContain('admin-jellyfin-token');
            res.writeHead(302, { Location: `${stubBCrossHostUrl}/stolen` });
            res.end();
        });
        mockConfigOverrides.JELLYFINURL = stubA.url;

        const response = await GET(makeEvent('deadbeef000040008000000000000000'));

        // Falls back to the (200, indistinguishable) default avatar rather
        // than hanging, 500ing, or leaking whatever stub B sends back — see
        // service.ts's catch around the Jellyfin fetch step.
        expect(response.status).toBe(200);

        expect(stubA.requestCount()).toBe(1);
        // The redirect target must never actually be contacted — not with
        // the token, not without it.
        expect(stubB.requestCount()).toBe(0);
    });

    it('control: a well-behaved (non-redirecting) Jellyfin response is accepted', async () => {
        stubA = await startServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'image/jpeg' });
            res.end(Buffer.from([1, 2, 3, 4]));
        });
        mockConfigOverrides.JELLYFINURL = stubA.url;

        const response = await GET(makeEvent('deadbeef000040008000000000000000'));

        expect(response.status).toBe(200);
        expect(stubA.requestCount()).toBe(1);
    });
});
