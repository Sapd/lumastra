// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Covers the batch contract for PATCH /api/admin/media/bulk-lock:
 *  - a full batch where every id matches a row (updatedCount === ids.length,
 *    failedIds empty) — reverting the handler to always report
 *    `skippedCount: 0` regardless of what the query returns would pass a
 *    naive "it responds" test but fail this one's exact-count assertions.
 *  - a partial failure where some ids don't match any row — `failedIds` must
 *    name exactly those ids, not just a count. A revert to a count-only
 *    response (e.g. dropping the `updatedSet` diff) fails this test because
 *    `failedIds` would be missing or wrong.
 *  - a request over the 500-id cap is rejected by the Zod schema itself
 *    (not silently truncated to 500) — reverting `.max(500)` to `.max(5000)`
 *    or removing it would make this test's `safeParse` unexpectedly succeed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiContext } from '$lib/server/api/define.js';
import type { RequestEvent } from '@sveltejs/kit';

const mockGetSql = vi.fn();
const mockBulkSetLock = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

vi.mock('$lib/server/database/queries/media-items.queries.js', () => ({
    bulkSetLockMediaItems: (...args: unknown[]) => mockBulkSetLock(...args),
}));

const { def, BulkLockRequestSchema } = await import('./bulk-lock.js');

function makeEvent(username = 'alice'): RequestEvent {
    return { locals: { user: { username } } } as unknown as RequestEvent;
}

function makeCtx(body: {
    ids: string[];
    locked: boolean;
}): ApiContext<NonNullable<typeof def.request>> {
    return {
        surface: 'internal',
        input: { body, params: undefined, query: undefined },
    };
}

const ID_A = '11111111-1111-1111-1111-111111111111';
const ID_B = '22222222-2222-2222-2222-222222222222';
const ID_C = '33333333-3333-3333-3333-333333333333';

beforeEach(() => {
    vi.clearAllMocks();
    mockGetSql.mockResolvedValue({});
});

describe('PATCH /api/admin/media/bulk-lock', () => {
    it('reports every id as updated on a full-success batch', async () => {
        mockBulkSetLock.mockResolvedValue([ID_A, ID_B]);

        const response = await def.handlers.PATCH!(
            makeEvent(),
            makeCtx({ ids: [ID_A, ID_B], locked: true }),
        );
        const body = await response.json();

        expect(body).toEqual({ updatedCount: 2, skippedCount: 0, failedIds: [] });
        expect(mockBulkSetLock).toHaveBeenCalledWith(
            expect.anything(),
            [ID_A, ID_B],
            true,
            'alice',
        );
    });

    it('names the ids that failed to match a row, not just a count', async () => {
        // ID_B does not exist — the query returns only the ids it actually updated.
        mockBulkSetLock.mockResolvedValue([ID_A, ID_C]);

        const response = await def.handlers.PATCH!(
            makeEvent(),
            makeCtx({ ids: [ID_A, ID_B, ID_C], locked: false }),
        );
        const body = await response.json();

        expect(body.updatedCount).toBe(2);
        expect(body.skippedCount).toBe(1);
        expect(body.failedIds).toEqual([ID_B]);
    });

    it('clears lockedBy when unlocking regardless of the caller', async () => {
        mockBulkSetLock.mockResolvedValue([ID_A]);

        await def.handlers.PATCH!(makeEvent(), makeCtx({ ids: [ID_A], locked: false }));

        expect(mockBulkSetLock).toHaveBeenCalledWith(expect.anything(), [ID_A], false, null);
    });

    it('rejects a request over the 500-id cap instead of truncating it', () => {
        const tooMany = Array.from(
            { length: 501 },
            (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${i.toString(16).padStart(12, '0')}`,
        );
        const result = BulkLockRequestSchema.safeParse({ ids: tooMany, locked: true });

        expect(result.success).toBe(false);
    });
});
