// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * trickplay-params Phase G failure-events wiring — unit tests.
 *
 * Verifies that:
 *   1. processSlice error path → recordFailure with 'trickplay-params' + composite key.
 *   2. retryOneTrickplayItem error path → recordFailure called.
 *   3. recordFailure NOT called on the 'no-provider' path.
 *   4. failures.list merges aggregates.
 *   5. failures.list tolerates missing aggregates.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as DrainBacklogModule from '../../../../plugins/runtime/drain-backlog.js';
import type { FailureAggregateRow } from '../../../../database/queries/plugin-failure-events.queries.js';

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

// ─── Drain-backlog mock ───────────────────────────────────────────────────────
vi.mock('../../../../plugins/runtime/drain-backlog.js', async (importOriginal) => {
    const actual = await importOriginal<typeof DrainBacklogModule>();
    return { ...actual, drainBacklog: vi.fn() };
});

import { trickplayParamsSyncTask } from '../trickplay-params-sync.js';
import { drainBacklog } from '../../../../plugins/runtime/drain-backlog.js';

// ─── Typed retry helper (avoids Parameters<> on optional type) ────────────────
type RetryFn = NonNullable<NonNullable<typeof trickplayParamsSyncTask.failures>['retry']>;
async function callRetry(ctx: ReturnType<typeof makeRetryCtx>, itemId: string): Promise<void> {
    return trickplayParamsSyncTask.failures!.retry!(
        ctx as unknown as Parameters<RetryFn>[0],
        itemId,
    );
}
import {
    recordFailure,
    getFailureAggregates,
} from '../../../../database/queries/plugin-failure-events.queries.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_UUID_A = '00000000-0000-0000-0000-000000000001';
const VALID_UUID_B = '00000000-0000-0000-0000-000000000002';
const VALID_UUID_C = '00000000-0000-0000-0000-000000000003';
const COMPOSITE_ID = `${VALID_UUID_A}|${VALID_UUID_B}`;

type SqlMock = ReturnType<typeof vi.fn> & { json: (v: unknown) => unknown };

// postgres returns a RowList: an array carrying a `count` property equal to the
// number of rows the statement affected (UPDATE/DELETE) or returned (SELECT).
// markTrickplayItemTried gates its boolean on `result.count`, so the mock must
// faithfully expose it rather than returning a bare array.
function asRowList(
    rows: Array<Record<string, unknown>>,
    count?: number,
): Array<Record<string, unknown>> {
    return Object.assign([...rows], { count: count ?? rows.length });
}

// Build a RowList whose `count` differs from its length — e.g. an UPDATE that
// affected N rows but returned none (no RETURNING clause).
function makeRowsWithCount(
    rows: Array<Record<string, unknown>>,
    count: number,
): Array<Record<string, unknown>> {
    return asRowList(rows, count);
}

function makeSqlFn(rows: Array<Array<Record<string, unknown>>>): SqlMock {
    let i = 0;
    const fn = vi.fn((..._args: unknown[]) => {
        const next = rows[i++] ?? [];
        // Preserve a pre-attached count (e.g. UPDATE affected-rows); otherwise
        // derive it from the row count like a SELECT/RETURNING result.
        const existingCount = (next as { count?: number }).count;
        return Promise.resolve(asRowList(next, existingCount));
    });
    return Object.assign(fn, { json: (v: unknown) => v });
}

function makeLogger() {
    return {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn(),
    };
}

function makeRetryCtx(rows: Array<Array<Record<string, unknown>>>) {
    return {
        sql: makeSqlFn(rows) as never,
        logger: makeLogger(),
        signal: new AbortController().signal,
        abortSignal: new AbortController().signal,
        runId: 'test-job-retry',
        input: {},
        reportProgress: vi.fn(),
    };
}

function makeExecuteCtx(sqlMock: unknown) {
    return {
        sql: sqlMock,
        logger: makeLogger(),
        signal: new AbortController().signal,
        abortSignal: new AbortController().signal,
        runId: 'test-job-xyz',
        input: {},
        reportProgress: vi.fn(),
    };
}

function makeListCtx() {
    const sql = vi.fn((..._args: unknown[]) => {
        return Promise.resolve([]);
    }) as unknown as SqlMock;
    (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

    return {
        sql,
        logger: makeLogger(),
        signal: new AbortController().signal,
        abortSignal: new AbortController().signal,
        runId: 'test-run',
        input: {},
        reportProgress: vi.fn(),
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('trickplay-params Phase G failure-events wiring', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getFailureAggregates).mockResolvedValue(new Map());
    });

    // ── Case 1: recordFailure called in processSlice error path (ok=true) ─────

    describe('processSlice: getParams throws → recordFailure called with composite key', () => {
        it('calls recordFailure with pluginId trickplay-params and composite itemKey when marker write lands', async () => {
            // markTrickplayItemTried returns true when the UPDATE affects a row
            // (RowList.count > 0). The mock exposes count to match postgres.
            const sqlFn = vi.fn((..._args: unknown[]) => {
                return Promise.resolve(asRowList([{ id: VALID_UUID_A }]));
            }) as SqlMock;
            (sqlFn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

            mockGetParams.mockRejectedValueOnce(new Error('Provider timed out'));

            vi.mocked(drainBacklog).mockImplementation(async (_ctx, options) => {
                const item = {
                    id: VALID_UUID_A,
                    fileId: VALID_UUID_B,
                    jellyfinId: null,
                };
                await options.processSlice([item], new AbortController().signal);
                return {
                    unitsProcessed: 1,
                    resultsProduced: 0,
                    stopReason: 'drained' as const,
                };
            });

            const ctx = makeExecuteCtx(sqlFn);
            await trickplayParamsSyncTask.execute(
                ctx as unknown as Parameters<typeof trickplayParamsSyncTask.execute>[0],
            );

            expect(vi.mocked(recordFailure)).toHaveBeenCalledOnce();
            const [, pluginId, itemKey, reason] = vi.mocked(recordFailure).mock.calls[0];
            expect(pluginId).toBe('trickplay-params');
            expect(itemKey).toBe(COMPOSITE_ID);
            expect(reason).toContain('Provider timed out');
        });
    });

    // ── Case 2: recordFailure called in retryOneTrickplayItem error path ──────

    describe('retryOneTrickplayItem: getParams throws → recordFailure called', () => {
        it('calls recordFailure with composite key after error marker write succeeds', async () => {
            const foundRow = {
                id: VALID_UUID_A,
                file_id: VALID_UUID_B,
                jellyfin_id: 'jf-abc',
                prior_audit_job_id: null,
            };

            mockGetParams.mockRejectedValueOnce(new Error('Connection refused'));

            // sql calls: [lookup], [markTrickplayItemTried UPDATE affecting one row]
            // The marker UPDATE returns no rows but its RowList.count is 1, which
            // is what markTrickplayItemTried checks to confirm the write landed.
            const ctx = makeRetryCtx([
                [foundRow],
                makeRowsWithCount([], 1), // marker UPDATE — affected 1 row
            ]);

            await callRetry(ctx, COMPOSITE_ID).catch(() => undefined);

            expect(vi.mocked(recordFailure)).toHaveBeenCalledOnce();
            const [, pluginId, itemKey, reason] = vi.mocked(recordFailure).mock.calls[0];
            expect(pluginId).toBe('trickplay-params');
            expect(itemKey).toBe(COMPOSITE_ID);
            expect(reason).toContain('Connection refused');
        });
    });

    // ── Case 3: recordFailure NOT called on 'no-provider' path ───────────────

    describe('processSlice: getParams returns null → recordFailure NOT called', () => {
        it('does not call recordFailure when getParams returns null (no-provider path)', async () => {
            // no-provider is a terminal non-failed state — failures.list predicate
            // filters on status='error' only, so 'no-provider' rows are not failures.
            const sqlFn = vi.fn((..._args: unknown[]) => {
                return Promise.resolve([{ id: VALID_UUID_A }]);
            }) as SqlMock;
            (sqlFn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

            mockGetParams.mockResolvedValueOnce(null);

            vi.mocked(drainBacklog).mockImplementation(async (_ctx, options) => {
                const item = {
                    id: VALID_UUID_A,
                    fileId: VALID_UUID_B,
                    jellyfinId: null,
                };
                await options.processSlice([item], new AbortController().signal);
                return {
                    unitsProcessed: 1,
                    resultsProduced: 0,
                    stopReason: 'drained' as const,
                };
            });

            const ctx = makeExecuteCtx(sqlFn);
            await trickplayParamsSyncTask.execute(
                ctx as unknown as Parameters<typeof trickplayParamsSyncTask.execute>[0],
            );

            expect(vi.mocked(recordFailure)).not.toHaveBeenCalled();
        });
    });

    // ── Case 4: failures.list calls getFailureAggregates and merges aggregates

    describe('failures.list: merges aggregates into response items', () => {
        it('populates firstSeen, failureCount, lastSeen when aggregate exists for a row', async () => {
            const firstSeen = new Date('2026-01-01T00:00:00Z');
            const lastSeen = new Date('2026-01-10T00:00:00Z');
            const agg: FailureAggregateRow = {
                plugin_id: 'trickplay-params',
                item_id: COMPOSITE_ID,
                failure_count: 4,
                first_seen: firstSeen,
                last_seen: lastSeen,
            };
            vi.mocked(getFailureAggregates).mockResolvedValueOnce(new Map([[COMPOSITE_ID, agg]]));

            const row = {
                item_id: VALID_UUID_A,
                file_id: VALID_UUID_B,
                title: 'Quiet Orbit',
                marker_key: `trickplay-params:${VALID_UUID_B}`,
                marker_reason: 'provider-threw',
                audit_run_job_id: null,
                task_history_id: null,
            };

            const ctx = makeListCtx();
            let sqlCallIndex = 0;
            vi.mocked(ctx.sql as unknown as ReturnType<typeof vi.fn>).mockImplementation(
                (..._args: unknown[]) => {
                    sqlCallIndex++;
                    if (sqlCallIndex === 1) return Promise.resolve([{ count: 1 }]);
                    if (sqlCallIndex === 2) return Promise.resolve([row]);
                    return Promise.resolve([]);
                },
            );

            const result = await trickplayParamsSyncTask.failures!.list!(
                ctx as unknown as Parameters<
                    NonNullable<typeof trickplayParamsSyncTask.failures>['list']
                >[0],
                { limit: 10, offset: 0 },
            );

            expect(vi.mocked(getFailureAggregates)).toHaveBeenCalledOnce();
            expect(vi.mocked(getFailureAggregates)).toHaveBeenCalledWith(
                expect.anything(),
                'trickplay-params',
                expect.arrayContaining([COMPOSITE_ID]),
            );

            const item = result.items[0];
            expect(item.id).toBe(COMPOSITE_ID);
            expect(item.firstSeen).toBe(firstSeen.toISOString());
            expect(item.failureCount).toBe(4);
            expect(item.lastSeen).toBe(lastSeen.toISOString());
        });
    });

    // ── Case 5: failures.list tolerates missing aggregates ─────────────────

    describe('failures.list: tolerates missing aggregates', () => {
        it('leaves firstSeen/failureCount/lastSeen undefined when no aggregate exists for a row', async () => {
            // getFailureAggregates returns empty map (default mock)
            const row = {
                item_id: VALID_UUID_A,
                file_id: VALID_UUID_C,
                title: 'Voyage to Orion',
                marker_key: `trickplay-params:${VALID_UUID_C}`,
                marker_reason: 'disk-read-error',
                audit_run_job_id: null,
                task_history_id: null,
            };

            const ctx = makeListCtx();
            let sqlCallIndex = 0;
            vi.mocked(ctx.sql as unknown as ReturnType<typeof vi.fn>).mockImplementation(
                (..._args: unknown[]) => {
                    sqlCallIndex++;
                    if (sqlCallIndex === 1) return Promise.resolve([{ count: 1 }]);
                    if (sqlCallIndex === 2) return Promise.resolve([row]);
                    return Promise.resolve([]);
                },
            );

            const result = await trickplayParamsSyncTask.failures!.list!(
                ctx as unknown as Parameters<
                    NonNullable<typeof trickplayParamsSyncTask.failures>['list']
                >[0],
                { limit: 10, offset: 0 },
            );

            const item = result.items[0];
            expect(item.id).toBe(`${VALID_UUID_A}|${VALID_UUID_C}`);
            expect(item.firstSeen).toBeUndefined();
            expect(item.failureCount).toBeUndefined();
            expect(item.lastSeen).toBeUndefined();
        });
    });
});
