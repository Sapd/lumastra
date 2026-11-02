// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * mdblist.ts `batchLookup()` outage-masking regression.
 *
 * Before this fix, `batchLookup()` swallowed EVERY chunk failure (non-ok
 * HTTP incl. 429, network throw, and rate-limit cool-down) into
 * `continue`/silent-null-fill/early-`return`. That made the caller's
 * purpose-built outage detector (`mdblist-sync.ts`'s `processedViaFallback`,
 * which only increments when `invokeProviderBatchLookup` THROWS) unreachable
 * in production — a total MDBList outage looked identical to "no data for
 * any of these items" and permanently tombstoned the whole pending backlog.
 *
 * These tests lock in the fixed contract:
 *   - a cancelled call rethrows immediately (not folded into "chunk failed");
 *   - a total outage (every attempted chunk fails, zero successful HTTP
 *     responses) THROWS instead of returning null-filled results;
 *   - a partial outage (some chunks succeed) stays lenient — no throw, and
 *     the successful chunk's data is still returned;
 *   - the rate-limit cool-down (429) also throws, both on the call that
 *     trips it and on subsequent calls made while the cool-down is active.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginContext } from '@sapd/lumastra-plugin-sdk';
import { mockContext, mockLogger } from '@sapd/lumastra-plugin-sdk-testing';

// registry.registerProvider() runs at module load (self-registration) —
// stub it so importing mdblist.ts doesn't require a real TaskRegistry.
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { registerProvider: vi.fn() },
}));

// config.ts pulls in DB/crypto/env wiring not needed for this unit — stub
// the one field mdblist.ts reads: the host MDBLIST_API_KEY (its only key source).
vi.mock('$lib/server/config.js', () => ({
    config: { MDBLIST_API_KEY: 'test-mdblist-key' },
}));

import { mdblistProvider } from './mdblist.js';

type MockHttp = NonNullable<PluginContext['http']> & {
    post: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
};

function makeCtx(http: MockHttp): PluginContext {
    return mockContext({
        logger: mockLogger(),
        http,
        signal: new AbortController().signal,
    });
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        ...init,
    });
}

function errorResponse(
    status: number,
    statusText: string,
    headers?: Record<string, string>,
): Response {
    return new Response(JSON.stringify([]), { status, statusText, headers });
}

describe('mdblistProvider.batchLookup — outage-masking regression', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rethrows an AbortError immediately instead of treating it as a chunk failure', async () => {
        const http: MockHttp = {
            post: vi
                .fn<(url: string, body: unknown, opts?: RequestInit) => Promise<Response>>()
                .mockRejectedValue(new DOMException('The user aborted', 'AbortError')),
            get: vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>(),
        };
        const ctx = makeCtx(http);

        await expect(mdblistProvider.batchLookup!(ctx, ['tmdb:100:movie'])).rejects.toMatchObject({
            name: 'AbortError',
        });

        // Only one attempt — no retry-as-chunk-failure loop past the abort.
        expect(http.post).toHaveBeenCalledTimes(1);
    });

    it('throws a descriptive error when every chunk fails via non-ok HTTP responses (total outage)', async () => {
        const http: MockHttp = {
            post: vi
                .fn<(url: string, body: unknown, opts?: RequestInit) => Promise<Response>>()
                .mockResolvedValue(errorResponse(503, 'Service Unavailable')),
            get: vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>(),
        };
        const ctx = makeCtx(http);

        await expect(
            mdblistProvider.batchLookup!(ctx, ['tmdb:100:movie', 'tmdb:200:movie']),
        ).rejects.toThrow(/total outage/i);
    });

    it('throws a descriptive error when every chunk fails via network errors (total outage)', async () => {
        const http: MockHttp = {
            post: vi
                .fn<(url: string, body: unknown, opts?: RequestInit) => Promise<Response>>()
                .mockRejectedValue(new Error('ECONNRESET')),
            get: vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>(),
        };
        const ctx = makeCtx(http);

        await expect(mdblistProvider.batchLookup!(ctx, ['tmdb:100:movie'])).rejects.toThrow(
            /total outage/i,
        );
    });

    it('stays lenient (no throw) when some chunks succeed and some fail, and returns the successful data', async () => {
        const http: MockHttp = {
            post: vi
                .fn<(url: string, body: unknown, opts?: RequestInit) => Promise<Response>>()
                .mockImplementation((url: string) => {
                    if (url.includes('/tmdb/movie')) {
                        return Promise.reject(new Error('mdblist 500'));
                    }
                    if (url.includes('/tmdb/show')) {
                        return Promise.resolve(
                            jsonResponse([{ title: 'A Show', ids: { tmdb: 200 } }]),
                        );
                    }
                    throw new Error(`unexpected url in test: ${url}`);
                }),
            get: vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>(),
        };
        const ctx = makeCtx(http);

        const results = await mdblistProvider.batchLookup!(ctx, [
            'tmdb:100:movie',
            'tmdb:200:show',
        ]);

        expect(results).toHaveLength(2);
        expect(results[0]).toBeNull(); // movie chunk failed → null, not thrown away
        expect(results[1]).toMatchObject({ title: 'A Show' });
        expect(http.post).toHaveBeenCalledTimes(2);
    });

    it('trips the rate-limit cool-down on 429 and throws on the tripping call', async () => {
        const http: MockHttp = {
            post: vi
                .fn<(url: string, body: unknown, opts?: RequestInit) => Promise<Response>>()
                .mockResolvedValue(
                    errorResponse(429, 'Too Many Requests', { 'retry-after': '30' }),
                ),
            get: vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>(),
        };
        const ctx = makeCtx(http);

        await expect(mdblistProvider.batchLookup!(ctx, ['tmdb:100:movie'])).rejects.toThrow(
            /total outage/i,
        );
    });

    it('throws immediately on a subsequent call while the cool-down window is still active, without hitting the network', async () => {
        // This test depends on the module-scoped cool-down tripped by the
        // previous test ("trips the rate-limit cool-down..."). Kept last in
        // file order intentionally — the cool-down state lives at module
        // scope (process-local memoisation, by design) and isn't reset
        // between tests.
        const http: MockHttp = {
            post: vi.fn<(url: string, body: unknown, opts?: RequestInit) => Promise<Response>>(),
            get: vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>(),
        };
        const ctx = makeCtx(http);

        await expect(mdblistProvider.batchLookup!(ctx, ['tmdb:999:movie'])).rejects.toThrow(
            /cool-down active/i,
        );
        expect(http.post).not.toHaveBeenCalled();
    });
});
