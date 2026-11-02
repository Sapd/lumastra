// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A cursor that decodes to something other than a row id is a 422, not a 500
 * from Postgres rejecting the bigint comparison. Buffer.from(…, 'base64')
 * never throws, so the decode itself cannot be the guard.
 */

import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { getTask: () => ({ id: 'metadata-sync' }) },
}));
const sqlMock = vi.fn(() => {
    throw new Error('the handler must not reach the database with a bad cursor');
});
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => sqlMock }));

const { def, taskFailuresResponse } = await import('./failures.js');

function makeEvent(cursor: string): RequestEvent {
    const url = new URL(
        `https://app.example/api/v1/tasks/metadata-sync/failures?cursor=${encodeURIComponent(cursor)}`,
    );
    return { params: { taskId: 'metadata-sync' }, url, locals: {} } as unknown as RequestEvent;
}

describe('GET /api/v1/tasks/{taskId}/failures — cursor validation', () => {
    it.each([
        ['non-numeric', Buffer.from('abc').toString('base64')],
        ['not base64 at all', '%%%'],
        ['too long for a bigint', Buffer.from('1'.repeat(30)).toString('base64')],
    ])('%s cursor → 422', async (_label, cursor) => {
        const res = await def.handlers.GET!(makeEvent(cursor), {} as never);
        expect(res.status).toBe(422);
        expect(sqlMock).not.toHaveBeenCalled();
    });
});

describe('task failure HTTP collection mapper', () => {
    it('keeps row identity distinct from item identity and moves continuation into page', () => {
        const failures = [
            {
                id: '123',
                itemId: 'media-item',
                occurredAt: new Date('2026-10-16T10:00:00Z'),
                reason: 'redacted reason',
                failureCount: 2,
            },
        ];
        const cursor = Buffer.from('123').toString('base64');
        expect(taskFailuresResponse({ failures, total: 3, nextCursor: cursor }, 1)).toEqual({
            items: failures,
            page: { limit: 1, hasMore: true, nextCursor: cursor, total: 3 },
        });
    });

    it('keeps total and the requested limit on an empty last page', () => {
        expect(
            JSON.parse(JSON.stringify(taskFailuresResponse({ failures: [], total: 3 }, 50))),
        ).toEqual({ items: [], page: { limit: 50, hasMore: false, total: 3 } });
    });
});
