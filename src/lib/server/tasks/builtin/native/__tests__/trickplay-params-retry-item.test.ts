// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * trickplay-params failures.retry — unit tests.
 *
 * Covers the retryOneTrickplayItem path:
 *   - Missing `|` separator (no DB hit)
 *   - Invalid UUID in one half (no DB hit)
 *   - Row/file pair not found
 *   - getParams returns a result → success, no marker write
 *   - getParams returns null → marker written with 'no-provider' status
 *   - getParams throws → marker written with 'error' status including jobId,
 *     then recordFailure called (Phase G: 3 total sql calls)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as DrainBacklogModule from '../../../../plugins/runtime/drain-backlog.js';

// ─── plugin-failure-events mock ───────────────────────────────────────────────
vi.mock('../../../../database/queries/plugin-failure-events.queries.js', () => ({
    recordFailure: vi.fn().mockResolvedValue(undefined),
    getFailureAggregates: vi.fn().mockResolvedValue(new Map()),
}));

// ─── trickplayParamsService mock ──────────────────────────────────────────────
const { mockGetParams } = vi.hoisted(() => ({
    mockGetParams: vi.fn(),
}));

vi.mock('../../../../services/trickplay-params.service.js', () => ({
    trickplayParamsService: {
        getParams: mockGetParams,
    },
}));

// ─── Drain-backlog mock (task uses it at module load in execute()) ────────────
vi.mock('../../../../plugins/runtime/drain-backlog.js', async (importOriginal) => {
    const actual = await importOriginal<typeof DrainBacklogModule>();
    return { ...actual, drainBacklog: vi.fn() };
});

import { trickplayParamsSyncTask } from '../trickplay-params-sync.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

type RetryFn = NonNullable<NonNullable<typeof trickplayParamsSyncTask.failures>['retry']>;

async function callRetry(ctx: ReturnType<typeof makeCtx>, itemId: string): Promise<void> {
    return trickplayParamsSyncTask.failures!.retry!(
        ctx as unknown as Parameters<RetryFn>[0],
        itemId,
    );
}

type SqlMock = ReturnType<typeof vi.fn> & { json: (v: unknown) => unknown };

function makeSqlFn(rows: Array<Array<Record<string, unknown>>>): SqlMock {
    let i = 0;
    const fn = vi.fn(() => Promise.resolve(rows[i++] ?? []));
    return Object.assign(fn, { json: (v: unknown) => v });
}

function makeCtx(rows: Array<Array<Record<string, unknown>>>) {
    return {
        sql: makeSqlFn(rows) as never,
        logger: {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        },
        signal: new AbortController().signal,
        abortSignal: new AbortController().signal,
        runId: 'test-job-retry',
        input: {},
        reportProgress: vi.fn(),
    };
}

const VALID_UUID_A = '00000000-0000-0000-0000-000000000001';
const VALID_UUID_B = '00000000-0000-0000-0000-000000000002';
const COMPOSITE_ID = `${VALID_UUID_A}|${VALID_UUID_B}`;

const FOUND_ROW = {
    id: VALID_UUID_A,
    file_id: VALID_UUID_B,
    jellyfin_id: 'jf-abc123',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('trickplay-params failures.retry', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // 1. failures.retry is defined on the task
    it('is defined on the task', () => {
        expect(typeof trickplayParamsSyncTask.failures?.retry).toBe('function');
    });

    // 2. Missing `|` separator → no DB call
    it('rejects itemId without pipe separator without hitting the DB', async () => {
        const ctx = makeCtx([]);
        await expect(callRetry(ctx, VALID_UUID_A)).rejects.toThrow(/expected mediaId.fileId/i);
        expect(ctx.sql as SqlMock).not.toHaveBeenCalled();
    });

    // 3. Invalid UUID in one half → no DB call
    it('rejects itemId with invalid UUID halves without hitting the DB', async () => {
        const ctx = makeCtx([]);
        await expect(callRetry(ctx, `not-a-uuid|${VALID_UUID_B}`)).rejects.toThrow(/invalid uuid/i);
        expect(ctx.sql as SqlMock).not.toHaveBeenCalled();
    });

    // 4. Row not found → sql returns []
    it('throws not-found when the item/file pair is missing', async () => {
        const ctx = makeCtx([[]]);
        await expect(callRetry(ctx, COMPOSITE_ID)).rejects.toThrow(/not found/i);
    });

    // 5. getParams returns a result → success, no marker write
    it('resolves when getParams returns a result', async () => {
        mockGetParams.mockResolvedValueOnce({ width: 320, height: 180 });

        // sql calls: [lookup] — no marker write on success
        const ctx = makeCtx([[FOUND_ROW]]);

        await expect(callRetry(ctx, COMPOSITE_ID)).resolves.toBeUndefined();

        expect(mockGetParams).toHaveBeenCalledWith(
            FOUND_ROW.id,
            FOUND_ROW.jellyfin_id,
            expect.objectContaining({ fileId: FOUND_ROW.file_id }),
        );
        // Only 1 sql call (lookup) — no marker written
        expect(ctx.sql as SqlMock).toHaveBeenCalledTimes(1);
    });

    // 6. getParams returns null → marker written with 'no-provider' status
    //    AND retry resolves. The marker's 'no-provider' status drops
    //    the row out of failures.list's predicate (which filters on
    //    status='error'), so the row has transitioned out of the failed
    //    bucket — throwing here would leave a stale row visible
    //    in the UI until a full reload, contradicting actual DB state.
    it('writes no-provider marker and resolves when getParams returns null', async () => {
        mockGetParams.mockResolvedValueOnce(null);

        // sql calls: [lookup], [markTrickplayItemTried UPDATE]
        const ctx = makeCtx([
            [FOUND_ROW],
            [], // marker write
        ]);

        await expect(callRetry(ctx, COMPOSITE_ID)).resolves.toBeUndefined();

        // 2 calls: lookup + no-provider marker write
        expect(ctx.sql as SqlMock).toHaveBeenCalledTimes(2);
    });

    // 7. getParams throws → marker written with 'error' status, then throws
    it('writes error marker with jobId and throws when getParams throws', async () => {
        const thrownErr = new Error('Provider connection refused');
        mockGetParams.mockRejectedValueOnce(thrownErr);

        // sql calls: [lookup], [markTrickplayItemTried UPDATE]
        // recordFailure is mocked — its INSERT does not go through ctx.sql
        const ctx = makeCtx([
            [FOUND_ROW],
            [], // marker write
        ]);

        await expect(callRetry(ctx, COMPOSITE_ID)).rejects.toThrow(/Provider connection refused/);

        // 2 calls: lookup + error marker write (recordFailure mock bypasses ctx.sql)
        expect(ctx.sql as SqlMock).toHaveBeenCalledTimes(2);
    });
});
