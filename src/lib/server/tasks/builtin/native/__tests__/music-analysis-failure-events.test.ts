// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * music-analysis Phase G failure-events wiring — unit tests.
 *
 * Verifies that:
 *   1. processTrackSlice empty-result path → recordFailure with 'music-analysis' + track.id + 'essentia-empty-result'.
 *   2. processTrackSlice analyze-threw path → recordFailure with the error message.
 *   3. failures.retry analyze-threw path → recordFailure called.
 *   4. failures.retry 'skipped' path (file-not-found) → recordFailure NOT called.
 *   5. failures.list merges aggregates.
 *   6. failures.list tolerates missing aggregates.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as DrainBacklogModule from '../../../../plugins/runtime/drain-backlog.js';
import type { FailureAggregateRow } from '../../../../database/queries/plugin-failure-events.queries.js';

// ─── plugin-failure-events mock ───────────────────────────────────────────────
vi.mock('../../../../database/queries/plugin-failure-events.queries.js', () => ({
    recordFailure: vi.fn().mockResolvedValue(undefined),
    getFailureAggregates: vi.fn().mockResolvedValue(new Map()),
}));

// ─── essentia-analysis.service mock ──────────────────────────────────────────
const { mockWithEssentiaConcurrency, mockAnalyzeTrack, mockStoreAnalysis, mockAssessFilePresence } =
    vi.hoisted(() => ({
        mockWithEssentiaConcurrency: vi.fn(async (fn: () => Promise<void>) => {
            await fn();
        }),
        mockAnalyzeTrack: vi.fn(),
        mockStoreAnalysis: vi.fn(),
        mockAssessFilePresence: vi.fn(),
    }));

vi.mock('../../../../services/essentia-analysis.service.js', () => ({
    withEssentiaConcurrency: mockWithEssentiaConcurrency,
    analyzeTrack: mockAnalyzeTrack,
    storeAnalysis: mockStoreAnalysis,
    isEssentiaAvailable: vi.fn().mockReturnValue(true),
    isAnalysisEngineUsable: vi.fn().mockReturnValue(true),
    verifyAnalysisEngineReady: vi.fn().mockResolvedValue(true),
    getEssentiaConcurrencyLimit: vi.fn().mockReturnValue(2),
}));

vi.mock('../../../../utils/file-presence.js', () => ({
    assessFilePresence: mockAssessFilePresence,
}));

// ─── Drain-backlog mock ───────────────────────────────────────────────────────
vi.mock('../../../../plugins/runtime/drain-backlog.js', async (importOriginal) => {
    const actual = await importOriginal<typeof DrainBacklogModule>();
    return { ...actual, drainBacklog: vi.fn() };
});

import { musicAnalysisTask } from '../music-analysis.js';
import { drainBacklog } from '../../../../plugins/runtime/drain-backlog.js';
import {
    recordFailure,
    getFailureAggregates,
} from '../../../../database/queries/plugin-failure-events.queries.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_UUID_A = '00000000-0000-0000-0000-000000000001';
const VALID_UUID_B = '00000000-0000-0000-0000-000000000002';
const VALID_UUID_C = '00000000-0000-0000-0000-000000000003';

type SqlMock = ReturnType<typeof vi.fn> & {
    begin: ReturnType<typeof vi.fn>;
    json: (v: unknown) => unknown;
};

function makeSqlFn(rows: Array<Array<Record<string, unknown>>>): SqlMock {
    let i = 0;
    const fn = vi.fn((..._args: unknown[]) => Promise.resolve(rows[i++] ?? []));
    const beginFn = vi.fn((txFn: (sql: unknown) => Promise<unknown>) => txFn(fn));
    return Object.assign(fn, { begin: beginFn, json: (v: unknown) => v });
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
    (sql as unknown as { begin: ReturnType<typeof vi.fn> }).begin = vi.fn();

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

type RetryFn = NonNullable<NonNullable<typeof musicAnalysisTask.failures>['retry']>;
async function callRetry(ctx: ReturnType<typeof makeRetryCtx>, itemId: string): Promise<void> {
    return musicAnalysisTask.failures!.retry!(ctx as unknown as Parameters<RetryFn>[0], itemId);
}

type ListFn = NonNullable<NonNullable<typeof musicAnalysisTask.failures>['list']>;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('music-analysis Phase G failure-events wiring', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getFailureAggregates).mockResolvedValue(new Map());
        mockWithEssentiaConcurrency.mockImplementation(async (fn: () => Promise<void>) => {
            await fn();
        });
    });

    // ── Case 1: processTrackSlice empty-result → recordFailure ────────────────

    describe('processTrackSlice: analyzeTrack returns null → recordFailure called', () => {
        it('calls recordFailure with pluginId music-analysis and essentia-empty-result reason', async () => {
            const sqlFn = vi.fn((..._args: unknown[]) => {
                return Promise.resolve([{ id: VALID_UUID_A }]);
            }) as SqlMock;
            (sqlFn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
            sqlFn.begin = vi.fn((txFn: (sql: unknown) => Promise<unknown>) => txFn(sqlFn));

            mockAssessFilePresence.mockResolvedValueOnce('exists');
            mockAnalyzeTrack.mockResolvedValueOnce(null);

            vi.mocked(drainBacklog).mockImplementation(async (_ctx, options) => {
                const item = {
                    id: VALID_UUID_A,
                    file_path: '/music/track.flac',
                };
                await options.processSlice([item], new AbortController().signal);
                return {
                    unitsProcessed: 1,
                    resultsProduced: 0,
                    stopReason: 'drained' as const,
                };
            });

            const ctx = makeExecuteCtx(sqlFn);
            await musicAnalysisTask.execute(
                ctx as unknown as Parameters<typeof musicAnalysisTask.execute>[0],
            );

            expect(vi.mocked(recordFailure)).toHaveBeenCalledOnce();
            const [, pluginId, itemKey, reason] = vi.mocked(recordFailure).mock.calls[0];
            expect(pluginId).toBe('music-analysis');
            expect(itemKey).toBe(VALID_UUID_A);
            expect(reason).toBe('essentia-empty-result');
        });
    });

    // ── Case 2: processTrackSlice analyze-threw → recordFailure called ────────

    describe('processTrackSlice: analyzeTrack throws → recordFailure called with error message', () => {
        it('calls recordFailure with the thrown error message', async () => {
            const sqlFn = vi.fn((..._args: unknown[]) => {
                return Promise.resolve([{ id: VALID_UUID_A }]);
            }) as SqlMock;
            (sqlFn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
            sqlFn.begin = vi.fn((txFn: (sql: unknown) => Promise<unknown>) => txFn(sqlFn));

            mockAssessFilePresence.mockResolvedValueOnce('exists');
            mockAnalyzeTrack.mockRejectedValueOnce(new Error('Essentia segfault'));

            vi.mocked(drainBacklog).mockImplementation(async (_ctx, options) => {
                const item = {
                    id: VALID_UUID_A,
                    file_path: '/music/track.flac',
                };
                await options.processSlice([item], new AbortController().signal);
                return {
                    unitsProcessed: 1,
                    resultsProduced: 0,
                    stopReason: 'drained' as const,
                };
            });

            const ctx = makeExecuteCtx(sqlFn);
            await musicAnalysisTask.execute(
                ctx as unknown as Parameters<typeof musicAnalysisTask.execute>[0],
            );

            expect(vi.mocked(recordFailure)).toHaveBeenCalledOnce();
            const [, pluginId, itemKey, reason] = vi.mocked(recordFailure).mock.calls[0];
            expect(pluginId).toBe('music-analysis');
            expect(itemKey).toBe(VALID_UUID_A);
            expect(reason).toBe('Essentia segfault');
        });
    });

    // ── Case 3: failures.retry analyze-threw → recordFailure called ──────────

    describe('failures.retry: analyzeTrack throws → recordFailure called with error message', () => {
        it('calls recordFailure after successful marker write in retry catch', async () => {
            const foundTrack = {
                id: VALID_UUID_A,
                file_path: '/music/track.flac',
                prior_audit_job_id: null,
            };

            mockAssessFilePresence.mockResolvedValueOnce('exists');
            mockAnalyzeTrack.mockRejectedValueOnce(new Error('FLAC decode error'));

            // sql calls: [lookup], [markTrackExcluded UPDATE returns row → ok=true], [post-check]
            const ctx = makeRetryCtx([
                [foundTrack],
                [{ id: VALID_UUID_A }], // markTrackExcluded → ok=true
                [{ status: 'failed', reason: 'FLAC decode error' }],
            ]);

            await callRetry(ctx, VALID_UUID_A).catch(() => undefined);

            expect(vi.mocked(recordFailure)).toHaveBeenCalledOnce();
            const [, pluginId, itemKey, reason] = vi.mocked(recordFailure).mock.calls[0];
            expect(pluginId).toBe('music-analysis');
            expect(itemKey).toBe(VALID_UUID_A);
            expect(reason).toBe('FLAC decode error');
        });
    });

    // ── Case 4: failures.retry 'skipped' path → recordFailure NOT called ─────

    describe('failures.retry: file-not-found (skipped) → recordFailure NOT called', () => {
        it('does not call recordFailure when the file is missing (skipped is non-failed)', async () => {
            const foundTrack = {
                id: VALID_UUID_A,
                file_path: '/music/track.flac',
                prior_audit_job_id: null,
            };

            mockAssessFilePresence.mockResolvedValueOnce('missing');

            // sql calls: [lookup], [markTrackExcluded skipped UPDATE], [post-check]
            const ctx = makeRetryCtx([
                [foundTrack],
                [], // markTrackExcluded UPDATE
                [{ status: 'skipped', reason: 'file-not-found' }],
            ]);

            await callRetry(ctx, VALID_UUID_A).catch(() => undefined);

            expect(vi.mocked(recordFailure)).not.toHaveBeenCalled();
        });
    });

    // ── Case 5: failures.list merges aggregates ───────────────────────────────

    describe('failures.list: merges aggregates into response items', () => {
        it('populates firstSeen, failureCount, lastSeen when aggregate exists for a row', async () => {
            const firstSeen = new Date('2026-01-01T00:00:00Z');
            const lastSeen = new Date('2026-01-10T00:00:00Z');
            const agg: FailureAggregateRow = {
                plugin_id: 'music-analysis',
                item_id: VALID_UUID_B,
                failure_count: 3,
                first_seen: firstSeen,
                last_seen: lastSeen,
            };
            vi.mocked(getFailureAggregates).mockResolvedValueOnce(new Map([[VALID_UUID_B, agg]]));

            const row = {
                id: VALID_UUID_B,
                title: 'Kind of Dawn',
                artist: 'Milo Fenwick',
                processing_state: {
                    'music-analysis': {
                        version: 5,
                        status: 'failed',
                        reason: 'essentia-empty-result',
                    },
                },
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

            const result = await musicAnalysisTask.failures!.list!(
                ctx as unknown as Parameters<ListFn>[0],
                { limit: 10, offset: 0 },
            );

            expect(vi.mocked(getFailureAggregates)).toHaveBeenCalledOnce();
            expect(vi.mocked(getFailureAggregates)).toHaveBeenCalledWith(
                expect.anything(),
                'music-analysis',
                expect.arrayContaining([VALID_UUID_B]),
            );

            const item = result.items[0];
            expect(item.id).toBe(VALID_UUID_B);
            expect(item.firstSeen).toBe(firstSeen.toISOString());
            expect(item.failureCount).toBe(3);
            expect(item.lastSeen).toBe(lastSeen.toISOString());
        });
    });

    // ── Case 6: failures.list tolerates missing aggregates ───────────────────

    describe('failures.list: tolerates missing aggregates', () => {
        it('leaves firstSeen/failureCount/lastSeen undefined when no aggregate exists for a row', async () => {
            // getFailureAggregates returns empty map (default mock)
            const row = {
                id: VALID_UUID_C,
                title: 'Blue in Amber',
                artist: 'Milo Fenwick',
                processing_state: {
                    'music-analysis': {
                        version: 5,
                        status: 'failed',
                        reason: 'analyze-threw',
                    },
                },
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

            const result = await musicAnalysisTask.failures!.list!(
                ctx as unknown as Parameters<ListFn>[0],
                { limit: 10, offset: 0 },
            );

            const item = result.items[0];
            expect(item.id).toBe(VALID_UUID_C);
            expect(item.firstSeen).toBeUndefined();
            expect(item.failureCount).toBeUndefined();
            expect(item.lastSeen).toBeUndefined();
        });
    });
});
