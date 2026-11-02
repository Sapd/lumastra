// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for GET /api/admin/ingest/map
 *
 * Query module is mocked; these tests verify middleware composition,
 * query-param parsing, and response shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('$lib/server/database/queries/ingest-map.queries.js', () => ({
    loadIngestMap: vi.fn(),
    loadIngestMapSummaryBuckets: vi.fn(async () => []),
}));

const mockSql = {} as never;
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(() => mockSql),
}));

vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (evt: unknown) => Promise<Response>) => fn,
}));

vi.mock('$lib/server/logger.js', () => ({
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

const { GET } = await import('./+server.js');
import { loadIngestMap } from '$lib/server/database/queries/ingest-map.queries.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeItems(n: number) {
    return Array.from({ length: n }, (_, i) => ({
        media_item_id: `id-${i}`,
        media_type: 'movie',
        title: `Movie ${i}`,
        series_title: null,
        season_number: null,
        episode_number: null,
        created_at: new Date(),
        stages: [],
    }));
}

function makeEvent(searchParams: Record<string, string | string[]> = {}, isAdmin = true) {
    const urlParams = new URLSearchParams();
    for (const [key, val] of Object.entries(searchParams)) {
        if (Array.isArray(val)) {
            for (const v of val) urlParams.append(key, v);
        } else {
            urlParams.set(key, val);
        }
    }
    const url = new URL(`http://test/api/admin/ingest/map?${urlParams.toString()}`);
    return {
        locals: {
            user: {
                userId: 'user-1',
                username: 'testuser',
                userGroups: [],
                isAdmin,
                maxAgeRating: null,
            },
            principal: isAdmin
                ? {
                      userId: 'user-1',
                      username: 'testuser',
                      userGroups: [],
                      scopes: ['admin'],
                      isAdmin: true,
                  }
                : undefined,
        },
        url,
        request: new Request(url),
        params: {},
    } as never;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/admin/ingest/map', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(loadIngestMap).mockResolvedValue([]);
    });

    it('returns 403 for non-admin', async () => {
        const res = await GET!(makeEvent({}, false));
        expect(res.status).toBe(403);
    });

    it('returns shape { items, window, total, truncated } for admin', async () => {
        vi.mocked(loadIngestMap).mockResolvedValue(makeItems(3));
        const res = await GET!(makeEvent());
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({
            items: expect.any(Array),
            window: {
                since: expect.any(String),
                until: expect.any(String),
            },
            page: { limit: 500, hasMore: false },
        });
    });

    it('uses 24h window by default', async () => {
        await GET!(makeEvent());
        expect(loadIngestMap).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({ windowSinceMs: 24 * 60 * 60 * 1000 }),
        );
    });

    it('parses ?window=7d correctly', async () => {
        await GET!(makeEvent({ window: '7d' }));
        expect(loadIngestMap).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({ windowSinceMs: 7 * 24 * 60 * 60 * 1000 }),
        );
    });

    it('parses ?window=all as a very large interval', async () => {
        await GET!(makeEvent({ window: 'all' }));
        const call = vi.mocked(loadIngestMap).mock.calls[0][1];
        expect(call?.windowSinceMs).toBeGreaterThan(365 * 24 * 60 * 60 * 1000);
    });

    it('maps ?mediaType=series to DB value "tv"', async () => {
        await GET!(makeEvent({ mediaType: 'series' }));
        expect(loadIngestMap).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({ mediaTypes: ['tv'] }),
        );
    });

    it('passes ?mediaType=movie unchanged', async () => {
        await GET!(makeEvent({ mediaType: 'movie' }));
        expect(loadIngestMap).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({ mediaTypes: ['movie'] }),
        );
    });

    it('passes multiple mediaType params', async () => {
        await GET!(makeEvent({ mediaType: ['movie', 'series'] }));
        expect(loadIngestMap).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({ mediaTypes: ['movie', 'tv'] }),
        );
    });

    it('passes ?limit correctly', async () => {
        await GET!(makeEvent({ limit: '100' }));
        expect(loadIngestMap).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({ limit: 101 }),
        );
    });

    it('sets truncated: true when result count equals limit', async () => {
        vi.mocked(loadIngestMap).mockResolvedValue(makeItems(501));
        const res = await GET!(makeEvent());
        const body = await res.json();
        expect(body.page.hasMore).toBe(true);
    });

    it('sets truncated: false when result count is below limit', async () => {
        vi.mocked(loadIngestMap).mockResolvedValue(makeItems(10));
        const res = await GET!(makeEvent());
        const body = await res.json();
        expect(body.page.hasMore).toBe(false);
    });

    it('window.since is earlier than window.until', async () => {
        await GET!(makeEvent());
        const res = await GET!(makeEvent({ window: '1h' }));
        const body = await res.json();
        expect(new Date(body.window.since).getTime()).toBeLessThan(
            new Date(body.window.until).getTime(),
        );
    });
});
