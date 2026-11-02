// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * anidb.ts `fetchTitleList()` / `fetchAnimeDetail()` outage-masking
 * regression.
 *
 * Before this fix, both helpers silently returned `[]` / `null` on a fetch
 * failure — identical to their genuinely-empty / genuinely-no-data return
 * values. `search()` and `childList()` have no catch of their own, so a
 * total AniDB outage was indistinguishable from "no matches" / "no
 * episodes".
 *
 * These tests lock in the fixed contract:
 *   - `search()` propagates a thrown error when the title-list fetch fails
 *     (HTTP outage), instead of silently returning `[]`;
 *   - `childList()` propagates a thrown error when the per-anime API fetch
 *     fails (HTTP outage), instead of silently returning `[]`;
 *   - `childList()` still returns `[]` (no throw) for AniDB's documented
 *     "no data for this aid" response (`<error>` XML body) — that is a real
 *     answer from the server, not an outage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import type { PluginContext } from '@sapd/lumastra-plugin-sdk';
import { mockContext, mockLogger, mockCache } from '@sapd/lumastra-plugin-sdk-testing';

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { registerProvider: vi.fn() },
}));

import { anidbProvider } from './anidb.js';

type MockHttp = NonNullable<PluginContext['http']> & {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
};

function makeCtx(http: MockHttp): PluginContext {
    return mockContext({
        logger: mockLogger(),
        http,
        cache: mockCache(),
        signal: new AbortController().signal,
    });
}

function textResponse(body: string, init?: ResponseInit): Response {
    return new Response(body, init);
}

describe('anidbProvider — outage-masking regression', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        vi.clearAllMocks();
        // resolveCredentials falls through ctx.secrets (unmocked, throws)
        // to the ANIDB_CLIENT env var — set it so search()/detail()/
        // childList() don't short-circuit on "not configured" before
        // reaching the network path under test.
        process.env = { ...originalEnv, ANIDB_CLIENT: 'test-client', ANIDB_CLIENT_VER: '1' };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it('search() propagates a thrown error when the title-list fetch fails (outage)', async () => {
        const http: MockHttp = {
            get: vi.fn().mockResolvedValue(textResponse('', { status: 503 })),
            post: vi.fn<(url: string, body: unknown, opts?: RequestInit) => Promise<Response>>(),
        };
        const ctx = makeCtx(http);

        await expect(
            anidbProvider.search!(ctx, { type: 'tv', query: 'Some Anime' }),
        ).rejects.toThrow(/AniDB title list fetch failed/i);
    });

    it('childList() propagates a thrown error when the per-anime fetch fails (outage)', async () => {
        const http: MockHttp = {
            get: vi.fn().mockResolvedValue(textResponse('', { status: 500 })),
            post: vi.fn<(url: string, body: unknown, opts?: RequestInit) => Promise<Response>>(),
        };
        const ctx = makeCtx(http);

        await expect(anidbProvider.childList!(ctx, '12345')).rejects.toThrow(
            /AniDB API request failed/i,
        );
    });

    it("childList() still returns [] (no throw) on AniDB's documented no-data <error> response", async () => {
        const http: MockHttp = {
            get: vi
                .fn()
                .mockResolvedValue(textResponse('<error>Unknown anime</error>', { status: 200 })),
            post: vi.fn<(url: string, body: unknown, opts?: RequestInit) => Promise<Response>>(),
        };
        const ctx = makeCtx(http);

        await expect(anidbProvider.childList!(ctx, '12345')).resolves.toEqual([]);
    });

    it('detail() propagates a thrown error when the per-anime fetch fails (outage)', async () => {
        const http: MockHttp = {
            get: vi.fn().mockResolvedValue(textResponse('', { status: 503 })),
            post: vi.fn<(url: string, body: unknown, opts?: RequestInit) => Promise<Response>>(),
        };
        const ctx = makeCtx(http);

        await expect(anidbProvider.detail!(ctx, '12345')).rejects.toThrow(
            /AniDB API request failed/i,
        );
    });
});

describe('anidbProvider — hostile response bodies', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env = { ...originalEnv, ANIDB_CLIENT: 'test-client', ANIDB_CLIENT_VER: '1' };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    function ctxWith(get: (url: string) => Promise<Response>): PluginContext {
        return makeCtx({
            get: vi.fn(get),
            post: vi.fn<(url: string, body: unknown, opts?: RequestInit) => Promise<Response>>(),
        } as MockHttp);
    }

    it('refuses a title list that inflates past the output cap', async () => {
        const bomb = gzipSync(Buffer.alloc(200 * 1024 * 1024));
        expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
        const ctx = ctxWith(async () => new Response(bomb));

        await expect(anidbProvider.search!(ctx, { type: 'tv', query: 'x' })).rejects.toThrow(
            /exceeds/i,
        );
    });

    it('parses a normal gzipped title list', async () => {
        const xml =
            '<animetitles><anime aid="1"><title xml:lang="en" type="official">Moon Tide</title></anime></animetitles>';
        const ctx = ctxWith(async () => new Response(gzipSync(xml)));

        const results = await anidbProvider.search!(ctx, { type: 'tv', query: 'Moon Tide' });
        expect(results.length).toBeGreaterThan(0);
    });

    it('scans a title list full of unterminated <anime> blocks in linear time', async () => {
        const xml = `<animetitles>${'<anime aid="1">'.repeat(60_000)}`;
        const ctx = ctxWith(async () => new Response(gzipSync(xml)));

        const start = performance.now();
        await anidbProvider.search!(ctx, { type: 'tv', query: 'x' });
        expect(performance.now() - start).toBeLessThan(1500);
    });

    it('refuses an oversized detail response', async () => {
        const ctx = ctxWith(async () => new Response('<anime>'.padEnd(20 * 1024 * 1024, 'a')));

        await expect(anidbProvider.detail!(ctx, '12345')).rejects.toThrow(/exceeds/i);
    });
});
