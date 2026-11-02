// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Covers the enqueue contract for POST /api/admin/media/bulk-sync:
 *  - a successful enqueue forwards the FULL id array (not a truncated or
 *    per-item slice) to orchestrator.startRun as `mediaItemIds`, and returns
 *    the run's id as `jobId` — this is the provider-hitting half of bulk
 *    actions, so the endpoint's only job is to hand the batch to the task
 *    queue and return immediately, not to process any item itself.
 *  - includeChildren/forceChildren default to false and are passed through
 *    verbatim when supplied — a revert that hardcodes them or drops them from
 *    the task input would desync the enqueued run from what the admin asked
 *    for.
 *  - a request over the 500-id cap is rejected by the Zod schema itself, the
 *    same guard as bulk-lock.ts — this endpoint enqueues ONE task run per
 *    call, so an unbounded id array would size that one run's own workload
 *    (and its request-timeout exposure) without limit.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiContext } from '$lib/server/api/define.js';
import type { RequestEvent } from '@sveltejs/kit';

const mockGetSql = vi.fn();
const mockStartRun = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: { startRun: (...args: unknown[]) => mockStartRun(...args) },
}));

const { def, BulkSyncRequestSchema } = await import('./bulk-sync.js');

function makeEvent(username = 'alice'): RequestEvent {
    return { locals: { user: { username } } } as unknown as RequestEvent;
}

function makeCtx(body: {
    ids: string[];
    includeChildren: boolean;
    forceChildren: boolean;
}): ApiContext<NonNullable<typeof def.request>> {
    return {
        surface: 'internal',
        input: { body, params: undefined, query: undefined },
    };
}

const ID_A = '11111111-1111-1111-1111-111111111111';
const ID_B = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
    vi.clearAllMocks();
    mockGetSql.mockResolvedValue({});
    mockStartRun.mockResolvedValue({ runId: 'run-abc-123' });
});

describe('POST /api/admin/media/bulk-sync', () => {
    it('enqueues the full id array and returns the run id as jobId', async () => {
        const response = await def.handlers.POST!(
            makeEvent(),
            makeCtx({ ids: [ID_A, ID_B], includeChildren: true, forceChildren: false }),
        );
        const body = await response.json();

        expect(mockStartRun).toHaveBeenCalledWith(
            'bulk-media-sync',
            { mediaItemIds: [ID_A, ID_B], includeChildren: true, forceChildren: false },
            expect.objectContaining({ trigger: expect.objectContaining({ by: 'alice' }) }),
        );
        expect(body).toEqual({ started: true, jobId: 'run-abc-123' });
    });

    it('defaults includeChildren and forceChildren to false when omitted', () => {
        const result = BulkSyncRequestSchema.parse({ ids: [ID_A] });

        expect(result.includeChildren).toBe(false);
        expect(result.forceChildren).toBe(false);
    });

    it('rejects a request over the 500-id cap instead of enqueueing it', () => {
        const tooMany = Array.from(
            { length: 501 },
            (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${i.toString(16).padStart(12, '0')}`,
        );
        const result = BulkSyncRequestSchema.safeParse({ ids: tooMany });

        expect(result.success).toBe(false);
        expect(mockStartRun).not.toHaveBeenCalled();
    });
});
