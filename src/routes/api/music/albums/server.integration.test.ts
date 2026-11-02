// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for GET /api/music/albums pagination.
 *
 * Key behaviors verified:
 *   - Returns { items, page } envelope matching the redesign contract.
 *   - hasMore=true when more than `limit` accessible rows exist (the limit+1
 *     over-fetch → hasMore derivation that was broken by the post-filter).
 *   - hasMore=false when the page exhausts the result set.
 *   - limit/offset correctly pages the access-filtered set.
 *   - items[] each carry images{poster} hrefs.
 *
 * NOTE: This file is named server.integration.test.ts (NOT +server.integration.test.ts)
 * — the `+` prefix is reserved by SvelteKit for route files and breaks vite build.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { createAndInsertTestMusicHierarchy } from '../../../../../tests/integration/fixtures/index.js';

// ── point ALL DB access at the test DB ──────────────────────────────────────

vi.hoisted(() => {
    const testUrl =
        process.env.TEST_DATABASE_URL ||
        process.env.DATABASE_URL?.replace(/\/[^/]*$/, '/lumastra_tests') ||
        'postgres://localhost:5432/lumastra_tests';
    process.env.TEST_DATABASE_URL = testUrl;
    process.env.DATABASE_URL = testUrl;
});

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        })),
    },
}));

// Route under test uses aiDbService.getSql() — redirect it to the test DB.
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: () => Promise.resolve(getTestDb()) },
}));

// requireAuth and withErrorHandler must be transparent wrappers in unit/integration
// tests so we can invoke GET directly without a real SvelteKit request pipeline.
vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAuth: (handler: unknown) => handler,
}));

vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (handler: unknown) => handler,
}));

// Access context: unrestricted (no denied groups, no age limit) so every
// seeded album is visible and pagination math is predictable.
// PARTIAL mock: only the DB-backed context build and the cache key are
// stubbed. `searchAccessBoundary` (and anything else this module exports) is
// inherited from the real implementation, so the route derives its
// MediaAccessBoundary through production code from the stubbed context. A
// full replacement here is what broke after 966de569a migrated these routes
// onto searchAccessBoundary: the mock had no such export and every test threw.
vi.mock('$lib/server/utils/search-access-context.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/utils/search-access-context.js')>();
    return {
        ...actual,
        buildSearchAccessContext: vi.fn().mockResolvedValue({
            username: 'test-user',
            deniedGroupIds: null,
            ageRating: null,
            liveTvAllowed: false,
            showUnavailableMedia: true,
        }),
        scopedCacheKey: vi.fn().mockReturnValue('test-key'),
    };
});

// ── skip when no test database is available ──────────────────────────────────

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

describe.runIf(RUN)('GET /api/music/albums — pagination integration', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
        try {
            await sql`SELECT 1 FROM media_items LIMIT 0`;
        } catch {
            throw new Error('media_items table missing — run db:test:migrate first');
        }
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        // Truncate music-related tables; CASCADE removes child rows.
        await sql.unsafe(
            'TRUNCATE TABLE media_embeddings, media_file_items, media_files, media_items CASCADE',
        );
    });

    // ── helpers ──────────────────────────────────────────────────────────────

    function makeLocals(): App.Locals {
        return {
            user: {
                userId: 'test-user-uuid',
                username: 'test-user',
                groups: [],
                isAdmin: false,
                hasLiveTvPermission: false,
                maxAgeRating: null,
                isAgeRestricted: false,
            },
        } as unknown as App.Locals;
    }

    function makeEvent(searchParams: Record<string, string> = {}): Record<string, unknown> {
        const url = new URL('http://localhost/api/music/albums');
        for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v);
        return { url, locals: makeLocals() };
    }

    // ── tests ─────────────────────────────────────────────────────────────────

    it('returns { items, page } envelope with hasMore=false when all albums fit on one page', async () => {
        await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
        await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });

        const { GET } = await import('./+server.js');
        const res = await GET(makeEvent({ limit: '10' }) as unknown as Parameters<typeof GET>[0]);

        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[]; page: Record<string, unknown> };
        expect(Array.isArray(body.items)).toBe(true);
        expect(body.page.hasMore).toBe(false);
        expect(body.page.limit).toBe(10);
        expect(body.page.offset).toBe(0);
    });

    it('hasMore=true when more than `limit` accessible albums exist', async () => {
        // Seed 4 albums; request limit=3 → hasMore should be true.
        for (let i = 0; i < 4; i++) {
            await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
        }

        const { GET } = await import('./+server.js');
        const res = await GET(makeEvent({ limit: '3' }) as unknown as Parameters<typeof GET>[0]);

        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[]; page: Record<string, unknown> };
        // Only `limit` items are returned (not limit+1)
        expect(body.items).toHaveLength(3);
        expect(body.page.hasMore).toBe(true);
        expect(body.page.limit).toBe(3);
    });

    it('offset pages the result set correctly', async () => {
        // Seed 3 albums; page 1 = first 2, page 2 = last 1.
        for (let i = 0; i < 3; i++) {
            await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
        }

        const { GET } = await import('./+server.js');

        const page1Res = await GET(
            makeEvent({ limit: '2', offset: '0' }) as unknown as Parameters<typeof GET>[0],
        );
        const page1 = (await page1Res.json()) as {
            items: unknown[];
            page: Record<string, unknown>;
        };
        expect(page1.items).toHaveLength(2);
        expect(page1.page.hasMore).toBe(true);

        const page2Res = await GET(
            makeEvent({ limit: '2', offset: '2' }) as unknown as Parameters<typeof GET>[0],
        );
        const page2 = (await page2Res.json()) as {
            items: unknown[];
            page: Record<string, unknown>;
        };
        expect(page2.items).toHaveLength(1);
        expect(page2.page.hasMore).toBe(false);
        expect(page2.page.offset).toBe(2);
    });

    it('each album item omits unavailable primary artwork', async () => {
        await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });

        const { GET } = await import('./+server.js');
        const res = await GET(makeEvent() as unknown as Parameters<typeof GET>[0]);

        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: Array<Record<string, unknown>> };
        expect(body.items.length).toBeGreaterThan(0);
        const album = body.items[0];
        expect(album).toHaveProperty('images');
        const images = album.images as Record<string, Record<string, unknown>>;
        expect(images).not.toHaveProperty('primary');
        expect(images).not.toHaveProperty('poster');
    });

    it('returns 401 when user is not authenticated', async () => {
        const { GET } = await import('./+server.js');
        const url = new URL('http://localhost/api/music/albums');
        const res = await GET({ url, locals: { user: null } } as unknown as Parameters<
            typeof GET
        >[0]);
        expect(res.status).toBe(401);
    });
});
