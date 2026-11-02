// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/user/series.ts — GET /user/series keyset conversion.
 *
 * All DB I/O is mocked — no database required. Verifies the offset/cursor
 * routing, the Gate B1 sort guard, the F9c cross-feed tag guard, Gate C
 * (total dropped in cursor mode + no second query), Gate D2b (NULL-group cursor
 * carry), Gate J1 (offset-mode bootstrap cursor), and the F9b sort-normalization.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => ({}),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

const mockCompute = vi.fn();
vi.mock('$lib/server/database/queries/watch-state.queries.js', () => ({
    computeAllSeriesProgress: (...args: unknown[]) => mockCompute(...args),
}));

const { def } = await import('./series.js');
// Reuse the def's own codec so the test encodes cursors exactly as the handler
// does (import after mocks so the module graph is settled).
const {
    encodeKeysetCursor,
}: typeof import('$lib/server/database/queries/builders/keyset-cursor.builder.js') =
    await import('$lib/server/database/queries/builders/keyset-cursor.builder.js');

const ctx: ApiContext = { surface: 'internal' };

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';

function seriesValueCursor(ts: string, id: string): string {
    return 'sv:' + encodeKeysetCursor({ ts, id });
}
function seriesNullCursor(id: string): string {
    return 'sn:' + encodeKeysetCursor({ ts: '-', id });
}

function row(id: string, lastWatchedAt: string | null): Record<string, unknown> {
    return {
        series_media_id: id,
        series_name: 'Test',
        total_seasons: 1,
        total_episodes: 10,
        watched_episodes: 3,
        progress_pct: 30,
        completion_status: 'in_progress',
        current_season: 1,
        current_episode: 3,
        last_watched_at: lastWatchedAt,
        last_watched_at_cursor: lastWatchedAt ?? undefined,
        first_watched_at: lastWatchedAt,
    };
}

function makeGetEvent(search = ''): Partial<RequestEvent> {
    return {
        url: new URL(`http://localhost/api/user/series${search}`),
        params: {},
        locals: {
            principal: { userId: UUID_A, username: 'alice' },
        } as RequestEvent['locals'],
    };
}

describe('defs/user/series (keyset)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCompute.mockResolvedValue([]);
    });

    it('requires user auth', () => {
        expect(def.auth as Record<string, unknown>).toMatchObject({ kind: 'user' });
    });

    it('no cursor → query receives offset mode', async () => {
        await def.handlers.GET!(makeGetEvent('?limit=10&offset=20') as RequestEvent, ctx);
        expect(mockCompute.mock.calls[0][2]).toMatchObject({
            page: { mode: 'offset', offset: 20 },
            sort: 'last_watched',
        });
    });

    it('cursor param (sort=last_watched) → query receives cursor mode, offset ignored', async () => {
        const cursor = seriesValueCursor('2026-07-20T00:00:00.000000Z', UUID_B);
        await def.handlers.GET!(
            makeGetEvent(`?offset=999&cursor=${encodeURIComponent(cursor)}`) as RequestEvent,
            ctx,
        );
        expect(mockCompute.mock.calls[0][2]).toMatchObject({
            page: {
                mode: 'cursor',
                cursor: { lastWatchedAt: '2026-07-20T00:00:00.000000Z', seriesMediaId: UUID_B },
            },
        });
    });

    it('Gate D2b: a NULL-group cursor decodes to lastWatchedAt=null', async () => {
        const cursor = seriesNullCursor(UUID_B);
        await def.handlers.GET!(
            makeGetEvent(`?cursor=${encodeURIComponent(cursor)}`) as RequestEvent,
            ctx,
        );
        expect(mockCompute.mock.calls[0][2].page).toEqual({
            mode: 'cursor',
            cursor: { lastWatchedAt: null, seriesMediaId: UUID_B },
        });
    });

    it('Gate B1: cursor with sort=progress → 422, query never called', async () => {
        const cursor = seriesValueCursor('2026-07-20T00:00:00.000Z', UUID_B);
        const res = await def.handlers.GET!(
            makeGetEvent(`?sort=progress&cursor=${encodeURIComponent(cursor)}`) as RequestEvent,
            ctx,
        );
        expect((res as Response).status).toBe(422);
        expect(mockCompute).not.toHaveBeenCalled();
    });

    it('malformed cursor → 422, query never called', async () => {
        const res = await def.handlers.GET!(
            makeGetEvent('?cursor=not-a-valid-cursor!!!') as RequestEvent,
            ctx,
        );
        expect((res as Response).status).toBe(422);
        expect(mockCompute).not.toHaveBeenCalled();
    });

    it('F9c: a cursor tagged for another feed → 422', async () => {
        // Same (ts:id) core, but a genre-style tag rather than series' 'sv:'/'sn:'.
        const foreign = 'g:' + encodeKeysetCursor({ ts: '2026-07-20T00:00:00.000Z', id: UUID_B });
        const res = await def.handlers.GET!(
            makeGetEvent(`?cursor=${encodeURIComponent(foreign)}`) as RequestEvent,
            ctx,
        );
        expect((res as Response).status).toBe(422);
        expect(mockCompute).not.toHaveBeenCalled();
    });

    it('decodable-but-bogus cursor (non-UUID id) → 422', async () => {
        const bogus =
            'sv:' + encodeKeysetCursor({ ts: '2026-07-20T00:00:00.000Z', id: 'not-a-uuid' });
        const res = await def.handlers.GET!(
            makeGetEvent(`?cursor=${encodeURIComponent(bogus)}`) as RequestEvent,
            ctx,
        );
        expect((res as Response).status).toBe(422);
        expect(mockCompute).not.toHaveBeenCalled();
    });

    it('decodable-but-bogus cursor (bad timestamp) → 422', async () => {
        const bogus = 'sv:' + encodeKeysetCursor({ ts: 'not-a-date', id: UUID_B });
        const res = await def.handlers.GET!(
            makeGetEvent(`?cursor=${encodeURIComponent(bogus)}`) as RequestEvent,
            ctx,
        );
        expect((res as Response).status).toBe(422);
        expect(mockCompute).not.toHaveBeenCalled();
    });

    it('F9b: ?sort=bogus normalizes to last_watched (offset behaviour unchanged)', async () => {
        await def.handlers.GET!(makeGetEvent('?sort=bogus') as RequestEvent, ctx);
        expect(mockCompute.mock.calls[0][2].sort).toBe('last_watched');
    });

    it('Gate C: cursor mode drops page.total and makes exactly ONE query', async () => {
        // limit=2, three rows back → hasMore, sliced to 2, no second (total) query.
        mockCompute.mockResolvedValueOnce([
            row(UUID_A, '2026-07-20T00:00:00.000000Z'),
            row(UUID_B, '2026-07-19T00:00:00.000000Z'),
            row('33333333-3333-3333-3333-333333333333', '2026-07-18T00:00:00.000000Z'),
        ]);
        const cursor = seriesValueCursor('2026-07-21T00:00:00.000000Z', UUID_B);
        const res = await def.handlers.GET!(
            makeGetEvent(`?limit=2&cursor=${encodeURIComponent(cursor)}`) as RequestEvent,
            ctx,
        );
        const body = (await (res as Response).json()) as {
            items: unknown[];
            page: { total?: number; hasMore: boolean; nextCursor?: string };
        };
        expect(mockCompute).toHaveBeenCalledTimes(1);
        expect(body.items).toHaveLength(2);
        expect(body.page.hasMore).toBe(true);
        expect(body.page.total).toBeUndefined();
        expect(body.page.nextCursor).toBe(seriesValueCursor('2026-07-19T00:00:00.000000Z', UUID_B));
    });

    it('cursor mode: last row in the NULL group mints a NULL-group (sn:) cursor', async () => {
        mockCompute.mockResolvedValueOnce([
            row(UUID_A, '2026-07-20T00:00:00.000000Z'),
            row(UUID_B, null),
            row('33333333-3333-3333-3333-333333333333', null),
        ]);
        const cursor = seriesValueCursor('2026-07-21T00:00:00.000000Z', UUID_A);
        const res = await def.handlers.GET!(
            makeGetEvent(`?limit=2&cursor=${encodeURIComponent(cursor)}`) as RequestEvent,
            ctx,
        );
        const body = (await (res as Response).json()) as { page: { nextCursor?: string } };
        expect(body.page.nextCursor).toBe(seriesNullCursor(UUID_B));
    });

    it('cursor mode omits page.nextCursor when hasMore is false', async () => {
        mockCompute.mockResolvedValueOnce([row(UUID_A, '2026-07-20T00:00:00.000000Z')]);
        const cursor = seriesValueCursor('2026-07-21T00:00:00.000000Z', UUID_A);
        const res = await def.handlers.GET!(
            makeGetEvent(`?limit=2&cursor=${encodeURIComponent(cursor)}`) as RequestEvent,
            ctx,
        );
        const body = (await (res as Response).json()) as { page: { nextCursor?: string } };
        expect(body.page.nextCursor).toBeUndefined();
    });

    it('offset mode keeps page.total and runs the second query', async () => {
        mockCompute
            .mockResolvedValueOnce([row(UUID_A, '2026-07-20T00:00:00.000000Z')]) // page
            .mockResolvedValueOnce([
                row(UUID_A, '2026-07-20T00:00:00.000000Z'),
                row(UUID_B, '2026-07-19T00:00:00.000000Z'),
            ]); // total
        const res = await def.handlers.GET!(makeGetEvent('?limit=1&offset=0') as RequestEvent, ctx);
        const body = (await (res as Response).json()) as {
            page: { total?: number; hasMore: boolean; offset?: number };
        };
        expect(mockCompute).toHaveBeenCalledTimes(2);
        expect(body.page.total).toBe(2);
        expect(body.page.offset).toBe(0);
        expect(body.page.hasMore).toBe(true);
    });

    it('Gate J1: offset mode emits a bootstrap page.nextCursor when cursor-eligible and hasMore', async () => {
        mockCompute
            .mockResolvedValueOnce([row(UUID_A, '2026-07-20T00:00:00.000000Z')]) // page (1 row)
            .mockResolvedValueOnce([
                row(UUID_A, '2026-07-20T00:00:00.000000Z'),
                row(UUID_B, '2026-07-19T00:00:00.000000Z'),
            ]); // total (2 rows → hasMore)
        const res = await def.handlers.GET!(makeGetEvent('?limit=1&offset=0') as RequestEvent, ctx);
        const body = (await (res as Response).json()) as {
            page: { nextCursor?: string; offset?: number };
        };
        expect(body.page.offset).toBe(0);
        expect(body.page.nextCursor).toBe(seriesValueCursor('2026-07-20T00:00:00.000000Z', UUID_A));
    });

    it('Gate J1: offset mode with sort=name (not cursor-eligible) emits NO page.nextCursor', async () => {
        mockCompute
            .mockResolvedValueOnce([row(UUID_A, '2026-07-20T00:00:00.000000Z')])
            .mockResolvedValueOnce([
                row(UUID_A, '2026-07-20T00:00:00.000000Z'),
                row(UUID_B, '2026-07-19T00:00:00.000000Z'),
            ]);
        const res = await def.handlers.GET!(
            makeGetEvent('?sort=name&limit=1&offset=0') as RequestEvent,
            ctx,
        );
        const body = (await (res as Response).json()) as { page: { nextCursor?: string } };
        expect(body.page.nextCursor).toBeUndefined();
    });

    it('returns 401 when unauthenticated', async () => {
        const res = await def.handlers.GET!(
            { ...makeGetEvent(), locals: {} as RequestEvent['locals'] } as RequestEvent,
            ctx,
        );
        expect((res as Response).status).toBe(401);
    });
});
