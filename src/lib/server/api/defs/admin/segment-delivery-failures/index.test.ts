// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/admin/segment-delivery-failures/index.ts
 * (GET, DELETE /api/admin/segment-delivery-failures).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import type { SegmentDeliveryFailureRow } from '$lib/server/database/queries/segment-delivery-failures.queries.js';

const mockGetDb = vi.fn();
const mockList = vi.fn();
const mockDelete = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/database/queries/segment-delivery-failures.queries.js', async (orig) => ({
    isUnfilteredFailureMatch: (
        await orig<
            typeof import('$lib/server/database/queries/segment-delivery-failures.queries.js')
        >()
    ).isUnfilteredFailureMatch,
    listSegmentDeliveryFailures: (...args: unknown[]) => mockList(...args),
    deleteSegmentDeliveryFailures: (...args: unknown[]) => mockDelete(...args),
}));

const { def } = await import('./index.js');

function makeRow(overrides: Partial<SegmentDeliveryFailureRow> = {}): SegmentDeliveryFailureRow {
    return {
        id: '7',
        play_session_id: '36FBEDFF-10F1-4686-ADB1-ED70430E01E1',
        category: 'gone',
        http_status: 404,
        resource_kind: 'segment',
        stream_variant: 'video_0',
        occurrences: 12,
        first_seen_at: new Date('2026-09-03T01:32:05Z'),
        last_seen_at: new Date('2026-09-03T01:32:10Z'),
        user_id: null,
        media_id: null,
        username: null,
        device_id: null,
        client_name: null,
        media_title: null,
        ...overrides,
    };
}

function makeEvent(): RequestEvent {
    const url = new URL('http://localhost/api/admin/segment-delivery-failures');
    return { url } as unknown as RequestEvent;
}

function makeCtx(query: Record<string, unknown> = {}): ApiContext<NonNullable<typeof def.request>> {
    return {
        surface: 'internal',
        input: {
            body: undefined,
            params: undefined,
            query: {
                playSessionId: undefined,
                userId: undefined,
                category: undefined,
                from: undefined,
                to: undefined,
                limit: 50,
                offset: 0,
                ...query,
            },
        },
    } as unknown as ApiContext<NonNullable<typeof def.request>>;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
});

describe('GET /admin/segment-delivery-failures', () => {
    it('maps filters into the query and returns the mapped response', async () => {
        mockList.mockResolvedValue({ rows: [makeRow()], total: 1 });

        const handler = def.handlers.GET!;
        const res = (await handler(makeEvent(), makeCtx({ category: 'gone' }))) as Response;

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            items: Record<string, unknown>[];
            page: { hasMore: boolean; total?: number };
        };
        expect(body.page.total).toBe(1);
        expect(body.page.hasMore).toBe(false);
        expect(body.items[0]).toMatchObject({
            id: '7',
            category: 'gone',
            httpStatus: 404,
            resourceKind: 'segment',
            streamVariant: 'video_0',
            occurrences: 12,
        });

        expect(mockList).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ category: 'gone', limit: 50, offset: 0 }),
        );
    });

    it("preserves the client's play session id spelling in the response", async () => {
        // Native clients send Swift's UPPERCASE UUID while play_sessions.id is
        // lowercase. The stored id keeps the failing request's spelling so an
        // operator can match it against the client's own logs verbatim.
        mockList.mockResolvedValue({ rows: [makeRow()], total: 1 });

        const handler = def.handlers.GET!;
        const res = (await handler(makeEvent(), makeCtx())) as Response;
        const body = (await res.json()) as { items: { playSessionId: string }[] };

        expect(body.items[0].playSessionId).toBe('36FBEDFF-10F1-4686-ADB1-ED70430E01E1');
    });

    it('reports hasMore when the page does not reach the total', async () => {
        mockList.mockResolvedValue({ rows: [makeRow()], total: 40 });

        const handler = def.handlers.GET!;
        const res = (await handler(makeEvent(), makeCtx())) as Response;
        const body = (await res.json()) as { page: { hasMore: boolean } };

        expect(body.page.hasMore).toBe(true);
    });

    it('returns 503 dependency_unavailable when the DB is down', async () => {
        mockGetDb.mockReturnValue(null);

        const handler = def.handlers.GET!;
        const res = (await handler(makeEvent(), makeCtx())) as Response;

        expect(res.status).toBe(503);
        expect(mockList).not.toHaveBeenCalled();
    });
});

describe('DELETE /admin/segment-delivery-failures', () => {
    it('scopes the clear to playSessionId when one is filtered', async () => {
        mockDelete.mockResolvedValue(3);

        const handler = def.handlers.DELETE!;
        const res = (await handler(makeEvent(), makeCtx({ playSessionId: 'abc-123' }))) as Response;

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ cleared: 3 });
        expect(mockDelete).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ playSessionId: 'abc-123' }),
        );
    });

    it('honours every list filter, not only playSessionId', async () => {
        mockDelete.mockResolvedValue(2);
        const userId = '11111111-1111-4111-8111-111111111111';

        const handler = def.handlers.DELETE!;
        const res = (await handler(makeEvent(), makeCtx({ userId, category: 'gone' }))) as Response;

        expect(res.status).toBe(200);
        expect(mockDelete).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ userId, category: 'gone' }),
        );
    });

    it('refuses to clear everything without all=1', async () => {
        const handler = def.handlers.DELETE!;
        const res = (await handler(makeEvent(), makeCtx())) as Response;

        expect(res.status).toBe(422);
        expect(mockDelete).not.toHaveBeenCalled();
    });

    it('clears everything with all=1 and no filter', async () => {
        mockDelete.mockResolvedValue(9);

        const handler = def.handlers.DELETE!;
        const res = (await handler(makeEvent(), makeCtx({ all: '1' }))) as Response;

        expect(await res.json()).toEqual({ cleared: 9 });
    });

    it('rejects all=1 combined with a filter', async () => {
        const handler = def.handlers.DELETE!;
        const res = (await handler(
            makeEvent(),
            makeCtx({ all: '1', playSessionId: 'abc' }),
        )) as Response;

        expect(res.status).toBe(422);
        expect(mockDelete).not.toHaveBeenCalled();
    });

    it('returns 503 dependency_unavailable when the DB is down', async () => {
        mockGetDb.mockReturnValue(null);

        const handler = def.handlers.DELETE!;
        const res = (await handler(makeEvent(), makeCtx())) as Response;

        expect(res.status).toBe(503);
        expect(mockDelete).not.toHaveBeenCalled();
    });
});
