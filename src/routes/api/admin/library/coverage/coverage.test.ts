// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for GET /api/admin/library/coverage
 *
 * Query modules are mocked; these tests verify middleware composition,
 * query-param parsing, and response shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('$lib/server/database/queries/coverage-grid.queries.js', () => ({
    loadCoverageGridItems: vi.fn(),
    loadCoverageGridSummary: vi.fn(),
}));

const mockSql = {} as never;
// The summary's shared short-TTL cache is Valkey-backed; pass-through here so
// every test sees its own query mocks rather than a previous test's value.
vi.mock('$lib/server/services/library-coverage-summary-cache.js', () => ({
    getCachedCoverageSummary: (_filter: unknown, compute: () => Promise<unknown>) => compute(),
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(() => mockSql),
}));

vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (evt: unknown) => Promise<Response>) => fn,
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { GET } from './+server.js';
import {
    loadCoverageGridItems,
    loadCoverageGridSummary,
} from '$lib/server/database/queries/coverage-grid.queries.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEFAULT_SUMMARY = {
    total: 0,
    completed: 0,
    in_progress: 0,
    failed: 0,
    pending: 0,
    skipped: 0,
    obsolete: 0,
};

function makeEvent(searchParams: Record<string, string | string[]> = {}, isAdmin = true) {
    const urlParams = new URLSearchParams();
    for (const [key, val] of Object.entries(searchParams)) {
        if (Array.isArray(val)) {
            for (const v of val) urlParams.append(key, v);
        } else {
            urlParams.set(key, val);
        }
    }
    const url = new URL(`http://test/api/admin/library/coverage?${urlParams.toString()}`);
    return {
        locals: { user: { isAdmin }, principal: { isAdmin } },
        url,
        request: new Request(url),
        params: {},
    } as never;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/admin/library/coverage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(loadCoverageGridItems).mockResolvedValue([]);
        vi.mocked(loadCoverageGridSummary).mockResolvedValue(DEFAULT_SUMMARY);
    });

    it('returns 403 for non-admin', async () => {
        expect(GET).toBeDefined();
        const res = await GET!(makeEvent({}, false));
        expect(res.status).toBe(403);
    });

    it('returns shape { items, summary, limit, offset } for admin', async () => {
        expect(GET).toBeDefined();
        const res = await GET!(makeEvent());
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({
            items: expect.any(Array),
            summary: expect.objectContaining({
                total: expect.any(Number),
                completed: expect.any(Number),
                in_progress: expect.any(Number),
                failed: expect.any(Number),
                pending: expect.any(Number),
                skipped: expect.any(Number),
                obsolete: expect.any(Number),
            }),
            page: { limit: expect.any(Number), offset: 0, hasMore: false },
        });
    });

    it('maps ?mediaType=series to DB value "tv"', async () => {
        expect(GET).toBeDefined();
        await GET!(makeEvent({ mediaType: 'series' }));
        expect(loadCoverageGridItems).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({ mediaTypes: ['tv'] }),
        );
    });

    it('passes ?mediaType=movie unchanged', async () => {
        expect(GET).toBeDefined();
        await GET!(makeEvent({ mediaType: 'movie' }));
        expect(loadCoverageGridItems).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({ mediaTypes: ['movie'] }),
        );
    });

    it('passes multiple mediaType params', async () => {
        expect(GET).toBeDefined();
        await GET!(makeEvent({ mediaType: ['movie', 'series'] }));
        expect(loadCoverageGridItems).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({ mediaTypes: ['movie', 'tv'] }),
        );
    });

    it('parses ?incompleteOnly=1', async () => {
        expect(GET).toBeDefined();
        await GET!(makeEvent({ incompleteOnly: '1' }));
        expect(loadCoverageGridItems).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({ incompleteOnly: true }),
        );
    });

    it('does not set incompleteOnly without param', async () => {
        expect(GET).toBeDefined();
        await GET!(makeEvent());
        expect(loadCoverageGridItems).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({ incompleteOnly: false }),
        );
    });

    it('parses ?missingStage', async () => {
        expect(GET).toBeDefined();
        await GET!(makeEvent({ missingStage: 'tmdb-metadata-sync' }));
        expect(loadCoverageGridItems).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({ missingStage: 'tmdb-metadata-sync' }),
        );
    });

    it('parses ?limit and ?offset', async () => {
        expect(GET).toBeDefined();
        await GET!(makeEvent({ limit: '25', offset: '50' }));
        expect(loadCoverageGridItems).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({ limit: 26, offset: 50 }),
        );
    });

    it('caps limit at 500', async () => {
        expect(GET).toBeDefined();
        await GET!(makeEvent({ limit: '9999' }));
        expect(loadCoverageGridItems).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({ limit: 501 }),
        );
    });

    it('uses default limit 50 when not provided', async () => {
        expect(GET).toBeDefined();
        await GET!(makeEvent());
        expect(loadCoverageGridItems).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({ limit: 51 }),
        );
    });

    it('passes same opts to both items and summary queries', async () => {
        expect(GET).toBeDefined();
        await GET!(
            makeEvent({
                mediaType: 'movie',
                incompleteOnly: '1',
                limit: '10',
                offset: '5',
            }),
        );
        const itemsCall = vi.mocked(loadCoverageGridItems).mock.calls[0][1];
        const summaryCall = vi.mocked(loadCoverageGridSummary).mock.calls[0][1];
        expect(itemsCall).toEqual({ ...summaryCall, limit: summaryCall.limit! + 1 });
    });

    it('includes items in response body', async () => {
        vi.mocked(loadCoverageGridItems).mockResolvedValue([
            {
                id: 'abc',
                title: 'Test Movie',
                media_type: 'movie',
                library_group_id: null,
                stage_completion: { 'media-probe': 'completed' },
                added_at: new Date(),
                series_title: null,
                season_number: null,
                episode_number: null,
            },
        ]);
        const res = await GET!(makeEvent());
        const body = await res.json();
        expect(body.items).toHaveLength(1);
        expect(body.items[0].id).toBe('abc');
    });
});
