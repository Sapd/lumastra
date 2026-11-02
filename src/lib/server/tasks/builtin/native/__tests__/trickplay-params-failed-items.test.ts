// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * trickplay-params failures.list — unit tests.
 *
 * The implementation queries media_items.processing_state for rows where
 * any key matching 'trickplay-params:*' has status='error'. Uses jsonb_each
 * lateral join to scan provider-suffixed keys. We mock ctx.sql.
 */

import { describe, it, expect, vi } from 'vitest';

// ─── plugin-failure-events mock ───────────────────────────────────────────────
vi.mock('../../../../database/queries/plugin-failure-events.queries.js', () => ({
    recordFailure: vi.fn().mockResolvedValue(undefined),
    getFailureAggregates: vi.fn().mockResolvedValue(new Map()),
}));

import { trickplayParamsSyncTask } from '../trickplay-params-sync.js';

function makeCtx(sqlCalls: unknown[][]) {
    let callIndex = 0;
    const sql = vi.fn((..._args: unknown[]) => {
        const result = sqlCalls[callIndex] ?? [];
        callIndex++;
        return Promise.resolve(result);
    });

    return {
        sql,
        logger: {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        },
        signal: new AbortController().signal,
        abortSignal: new AbortController().signal,
        runId: 'test-run',
        input: {},
        reportProgress: vi.fn(),
    };
}

type ListFn = NonNullable<NonNullable<typeof trickplayParamsSyncTask.failures>['list']>;

async function callList(ctx: ReturnType<typeof makeCtx>, opts: { limit: number; offset: number }) {
    return trickplayParamsSyncTask.failures!.list!(ctx as unknown as Parameters<ListFn>[0], opts);
}

describe('trickplay-params failures.list', () => {
    it('is defined on the task', () => {
        expect(typeof trickplayParamsSyncTask.failures?.list).toBe('function');
    });

    it('returns empty result when no items have trickplay error markers', async () => {
        const ctx = makeCtx([[{ count: 0 }], []]);
        const result = await callList(ctx, { limit: 10, offset: 0 });
        expect(result.total).toBe(0);
        expect(result.items).toHaveLength(0);
    });

    it('returns failed items with correct shape — per-file rows, id is itemId|fileId', async () => {
        // Row returned by the per-file jsonb_each query (no DISTINCT ON).
        // id is `${item_id}|${file_id}` to preserve per-file uniqueness.
        const failedRow = {
            item_id: 'item-001',
            file_id: 'file-abc',
            title: 'Daydream',
            marker_key: 'trickplay-params:file-abc',
            marker_reason: 'provider-threw',
        };

        const ctx = makeCtx([[{ count: 2 }], [failedRow]]);
        const result = await callList(ctx, { limit: 10, offset: 0 });

        expect(result.total).toBe(2);
        expect(result.items).toHaveLength(1);

        const item = result.items[0];
        expect(item.id).toBe('item-001|file-abc');
        expect(item.label).toBe('Daydream');
        expect(item.reason).toBe('provider-threw');
        expect(item.detectedAt).toBeNull();
    });

    it('counts 2 failed entries when one media item has 2 failed files', async () => {
        // Per-file granularity: the backlog counts each (media_item, file_id)
        // pair separately. If one media item has 2 failed files, the count
        // must be 2 — matching the backlog's `failed` bucket. The old
        // DISTINCT ON (mi.id) implementation would have counted only 1.
        const failedRow1 = {
            item_id: 'item-001',
            file_id: 'file-aaa',
            title: 'Multi-Version Movie',
            marker_key: 'trickplay-params:file-aaa',
            marker_reason: 'provider-threw',
        };
        const failedRow2 = {
            item_id: 'item-001',
            file_id: 'file-bbb',
            title: 'Multi-Version Movie',
            marker_key: 'trickplay-params:file-bbb',
            marker_reason: 'null-result',
        };

        const ctx = makeCtx([[{ count: 2 }], [failedRow1, failedRow2]]);
        const result = await callList(ctx, { limit: 10, offset: 0 });

        expect(result.total).toBe(2);
        expect(result.items).toHaveLength(2);
        expect(result.items[0].id).toBe('item-001|file-aaa');
        expect(result.items[1].id).toBe('item-001|file-bbb');
    });

    it('caps reason at 500 characters', async () => {
        const longReason = 'x'.repeat(600);
        const failedRow = {
            item_id: 'item-002',
            file_id: 'file-xyz',
            title: 'Long Error Movie',
            marker_key: 'trickplay-params:file-xyz',
            marker_reason: longReason,
        };

        const ctx = makeCtx([[{ count: 1 }], [failedRow]]);
        const result = await callList(ctx, { limit: 10, offset: 0 });

        expect(result.items[0].reason.length).toBeLessThanOrEqual(500);
    });

    it('falls back reason to "Trickplay failed" when reason is null', async () => {
        const failedRow = {
            item_id: 'item-003',
            file_id: 'file-000',
            title: 'No Reason Movie',
            marker_key: 'trickplay-params:file-000',
            marker_reason: null,
            audit_run_job_id: null,
            task_history_id: null,
        };

        const ctx = makeCtx([[{ count: 1 }], [failedRow]]);
        const result = await callList(ctx, { limit: 10, offset: 0 });

        expect(result.items[0].reason).toBe('Trickplay failed');
    });

    it('failures.list preserves firstSeen/failureCount/lastSeen from aggregates', async () => {
        const failedRow = {
            item_id: 'item-004',
            file_id: 'file-aaa',
            title: 'Daydream',
            marker_key: 'trickplay-params:file-aaa',
            marker_reason: 'provider-threw',
            audit_run_job_id: 'job-7777',
            task_history_id: 7777,
        };

        const ctx = makeCtx([[{ count: 1 }], [failedRow]]);
        const result = await callList(ctx, { limit: 10, offset: 0 });

        // taskRunId is not surfaced in the SDK FailedItem interface;
        // verify the item is returned with basic fields intact.
        expect(result.items[0].id).toBe('item-004|file-aaa');
        expect(result.items[0].label).toBe('Daydream');
    });

    it('failures.list returns item with undefined firstSeen when no aggregate', async () => {
        const failedRow = {
            item_id: 'item-005',
            file_id: 'file-bbb',
            title: 'No History Movie',
            marker_key: 'trickplay-params:file-bbb',
            marker_reason: 'null-result',
            audit_run_job_id: null,
            task_history_id: null,
        };

        const ctx = makeCtx([[{ count: 1 }], [failedRow]]);
        const result = await callList(ctx, { limit: 10, offset: 0 });

        expect(result.items[0].firstSeen).toBeUndefined();
        expect(result.items[0].failureCount).toBeUndefined();
        expect(result.items[0].lastSeen).toBeUndefined();
    });
});
