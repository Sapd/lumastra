// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * media-probe Phase G failure-events wiring — unit tests.
 *
 * Verifies that:
 *   1. processPhaseBSlice with issues.length > 0 → recordFailure called with
 *      'media-probe' + file.id + issues[0].type + jobId.
 *   2. processPhaseBSlice with issues.length === 0 (clean keyframes) →
 *      recordFailure NOT called.
 *   3. retryOneFile when issues.length > 0 → recordFailure called.
 *   4. listFailedItems merges aggregates.
 *   5. listFailedItems tolerates missing aggregates.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as DrainBacklogModule from '../../../../plugins/runtime/drain-backlog.js';
import type { FailureAggregateRow } from '../../../../database/queries/plugin-failure-events.queries.js';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';

// ─── plugin-failure-events mock ───────────────────────────────────────────────
vi.mock('../../../../database/queries/plugin-failure-events.queries.js', () => ({
    recordFailure: vi.fn().mockResolvedValue(undefined),
    markFailureEventsResolved: vi.fn().mockResolvedValue(undefined),
    getFailureAggregates: vi.fn().mockResolvedValue(new Map()),
}));

// ─── ffprobe mock ─────────────────────────────────────────────────────────────
const { mockProbeMediaFile, mockProbeKeyframes } = vi.hoisted(() => ({
    mockProbeMediaFile: vi.fn(),
    mockProbeKeyframes: vi.fn(),
}));

vi.mock('../../../../utils/ffprobe.js', () => ({
    probeMediaFile: mockProbeMediaFile,
    probeKeyframes: mockProbeKeyframes,
}));

// ─── file-presence mock ───────────────────────────────────────────────────────
const { mockAssessFilePresence } = vi.hoisted(() => ({
    mockAssessFilePresence: vi.fn(),
}));

vi.mock('../../../../utils/file-presence.js', () => ({
    assessFilePresence: mockAssessFilePresence,
}));

// ─── media-files.queries mock ─────────────────────────────────────────────────
const { mockUpdateProbeData, mockUpdateKeyframes, mockUpdateHealthIssues } = vi.hoisted(() => ({
    mockUpdateProbeData: vi.fn(),
    mockUpdateKeyframes: vi.fn(),
    mockUpdateHealthIssues: vi.fn(),
}));

vi.mock('../../../../database/queries/media-files.queries.js', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        updateProbeData: mockUpdateProbeData,
        updateKeyframes: mockUpdateKeyframes,
        updateHealthIssues: mockUpdateHealthIssues,
        getFileHealthSnapshot: vi.fn().mockResolvedValue({ health_issues: null }),
        addRecheckedHealthIssues: vi.fn().mockResolvedValue(undefined),
        removeReviewedHealthIssues: vi.fn().mockResolvedValue(null),
        lockFileHealthIssues: vi.fn().mockResolvedValue(undefined),
    };
});

// ─── media-stream-mapper mock ─────────────────────────────────────────────────
const { mockMapFFprobeToDbRows } = vi.hoisted(() => ({
    mockMapFFprobeToDbRows: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../../utils/media-stream-mapper.js', () => ({
    mapFFprobeToDbRows: mockMapFFprobeToDbRows,
}));

// ─── media-streams.queries mock ───────────────────────────────────────────────
const { mockReplaceStreamsForFile } = vi.hoisted(() => ({
    mockReplaceStreamsForFile: vi.fn(),
}));

vi.mock('../../../../database/queries/media-streams.queries.js', () => ({
    replaceStreamsForFile: mockReplaceStreamsForFile,
}));

// ─── Drain-backlog mock ───────────────────────────────────────────────────────
vi.mock('../../../../plugins/runtime/drain-backlog.js', async (importOriginal) => {
    const actual = await importOriginal<typeof DrainBacklogModule>();
    return { ...actual, drainBacklog: vi.fn() };
});

// These tests exercise task wiring with queued SQL results. Query-fragment construction
// is not a database call; the real shared predicates are exercised by the duration-review PG test.
vi.mock('../../../../database/queries/file-health-classification.queries.js', () => ({
    actionableFileHealthSql: () => 'current-file-health-fragment',
    boundedAdminHealthIssuesSql: () => 'bounded-file-health-fragment',
}));
import { mediaProbeTask } from '../media-probe.js';
import { drainBacklog } from '../../../../plugins/runtime/drain-backlog.js';
import {
    recordFailure,
    markFailureEventsResolved,
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

function makeRetryCtx(
    rows: Array<Array<Record<string, unknown>>>,
): TaskContext<{ [x: string]: unknown }> {
    return {
        sql: makeSqlFn(rows) as never,
        logger: {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        },
        signal: new AbortController().signal,
        input: { mode: 'manual' },
        runId: 'test-job-retry',
        reportProgress: vi.fn(),
    } as unknown as TaskContext<{ [x: string]: unknown }>;
}

function makePluginCtx(): TaskContext<{ [x: string]: unknown }> {
    const sql = vi.fn((..._args: unknown[]) => {
        return Promise.resolve([]);
    }) as unknown as TaskContext['sql'];
    (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

    return {
        sql,
        logger: {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        },
        signal: new AbortController().signal,
        input: {},
        runId: 'test-run-id',
        reportProgress: vi.fn(),
    } as unknown as TaskContext<{ [x: string]: unknown }>;
}

function makeExecCtx(sqlMock: unknown): TaskContext<{ [x: string]: unknown }> {
    return {
        sql: sqlMock,
        logger: {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        },
        signal: new AbortController().signal,
        input: { mode: 'catchup' },
        runId: 'test-job-xyz',
        reportProgress: vi.fn(),
    } as unknown as TaskContext<{ [x: string]: unknown }>;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('media-probe Phase G failure-events wiring', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getFailureAggregates).mockResolvedValue(new Map());
        mockUpdateProbeData.mockResolvedValue(undefined);
        mockUpdateKeyframes.mockResolvedValue(undefined);
        mockUpdateHealthIssues.mockResolvedValue(undefined);
        mockReplaceStreamsForFile.mockResolvedValue(undefined);
    });

    // ── Case 1: processPhaseBSlice with issues → recordFailure called ─────────

    describe('processPhaseBSlice: issues.length > 0 → recordFailure called', () => {
        it('calls recordFailure with media-probe + file.id + issues[0].type + jobId', async () => {
            const sqlFn = vi.fn((..._args: unknown[]) => {
                return Promise.resolve([]);
            }) as SqlMock;
            sqlFn.json = (v: unknown) => v;
            sqlFn.begin = vi.fn((txFn: (sql: unknown) => Promise<unknown>) => txFn(sqlFn));

            mockAssessFilePresence.mockResolvedValueOnce('exists');
            // Probe returns empty keyframes → no_keyframes issue
            mockProbeKeyframes.mockResolvedValueOnce({
                success: true,
                keyframes: [],
            });

            // Phase A drainBacklog: return drained with 0 units (no Phase A files)
            // Phase B drainBacklog: fire processSlice with the keyframe file
            let drainCallCount = 0;
            vi.mocked(drainBacklog).mockImplementation(async (_ctx, options) => {
                drainCallCount++;
                if (drainCallCount === 1) {
                    // Phase A — nothing to probe; skip processSlice
                    return {
                        unitsProcessed: 0,
                        resultsProduced: 0,
                        stopReason: 'drained' as const,
                    };
                }
                // Phase B
                const item = {
                    id: VALID_UUID_A,
                    file_path: '/media/movie.mkv',
                    duration_seconds: 7200,
                    media_item_ids: [],
                };
                await options.processSlice([item], new AbortController().signal);
                return {
                    unitsProcessed: 1,
                    resultsProduced: 0,
                    stopReason: 'drained' as const,
                };
            });

            const ctx = makeExecCtx(sqlFn);
            await mediaProbeTask.execute(ctx);

            expect(vi.mocked(recordFailure)).toHaveBeenCalledOnce();
            const [, pluginId, itemKey, reason, jobId] = vi.mocked(recordFailure).mock.calls[0];
            expect(pluginId).toBe('media-probe');
            expect(itemKey).toBe(VALID_UUID_A);
            expect(reason).toBe('no_keyframes');
            expect(jobId).toBe('test-job-xyz');
        });
    });

    // ── Case 2: processPhaseBSlice clean keyframes → recordFailure NOT called ─

    describe('processPhaseBSlice: issues.length === 0 (clean keyframes) → recordFailure NOT called', () => {
        it('does not call recordFailure when keyframes are healthy', async () => {
            const sqlFn = vi.fn((..._args: unknown[]) => {
                return Promise.resolve([]);
            }) as SqlMock;
            sqlFn.json = (v: unknown) => v;
            sqlFn.begin = vi.fn((txFn: (sql: unknown) => Promise<unknown>) => txFn(sqlFn));

            mockAssessFilePresence.mockResolvedValueOnce('exists');
            // Clean keyframes span > 90% of 7200s
            mockProbeKeyframes.mockResolvedValueOnce({
                success: true,
                keyframes: [0, 1800, 3600, 5400, 7000],
            });

            let drainCallCount = 0;
            vi.mocked(drainBacklog).mockImplementation(async (_ctx, options) => {
                drainCallCount++;
                if (drainCallCount === 1) {
                    return {
                        unitsProcessed: 0,
                        resultsProduced: 0,
                        stopReason: 'drained' as const,
                    };
                }
                // Phase B
                const item = {
                    id: VALID_UUID_A,
                    file_path: '/media/movie.mkv',
                    duration_seconds: 7200,
                    media_item_ids: [],
                };
                await options.processSlice([item], new AbortController().signal);
                return {
                    unitsProcessed: 1,
                    resultsProduced: 1,
                    stopReason: 'drained' as const,
                };
            });

            const ctx = makeExecCtx(sqlFn);
            const outcome = await mediaProbeTask.execute(ctx);

            expect(outcome.result?.keyframed).toBe(1);
            expect(outcome.result?.errors).toBe(0);
            expect(vi.mocked(markFailureEventsResolved)).toHaveBeenCalledWith(
                expect.anything(),
                'media-probe',
                VALID_UUID_A,
            );
            expect(vi.mocked(recordFailure)).not.toHaveBeenCalled();
        });
    });

    // ── Case 3: retryOneFile when issues.length > 0 → recordFailure called ───

    describe('retryOneFile: issues.length > 0 → recordFailure called', () => {
        it('calls recordFailure after tx commits when health issues are detected', async () => {
            const fileRow = {
                id: VALID_UUID_A,
                file_path: '/media/movie.mkv',
                probed_at: new Date('2024-01-01'),
                duration_seconds: 7200,
                has_keyframes: false,
                has_video: true,
                prior_audit_job_id: 'original-run-42',
            };

            mockAssessFilePresence.mockResolvedValueOnce('exists');
            mockProbeKeyframes.mockResolvedValueOnce({
                success: true,
                keyframes: [], // empty → no_keyframes issue
            });

            const ctx = makeRetryCtx([[fileRow]]);
            await expect(mediaProbeTask.failures!.retry!(ctx, VALID_UUID_A)).rejects.toThrow(
                /no_keyframes/,
            );

            expect(vi.mocked(recordFailure)).toHaveBeenCalledOnce();
            const [, pluginId, itemKey, reason, jobId] = vi.mocked(recordFailure).mock.calls[0];
            expect(pluginId).toBe('media-probe');
            expect(itemKey).toBe(VALID_UUID_A);
            expect(reason).toBe('no_keyframes');
            // retryOneFile uses auditJobId (prior_audit_job_id) not the caller's jobId
            expect(jobId).toBe('original-run-42');
        });
    });

    // ── Case 4: listFailedItems merges aggregates ─────────────────────────────

    describe('listFailedItems: merges aggregates into response items', () => {
        it('populates firstSeen, failureCount, lastSeen when aggregate exists for a row', async () => {
            const firstSeen = new Date('2026-01-01T00:00:00Z');
            const lastSeen = new Date('2026-01-10T00:00:00Z');
            const agg: FailureAggregateRow = {
                plugin_id: 'media-probe',
                item_id: VALID_UUID_B,
                failure_count: 4,
                first_seen: firstSeen,
                last_seen: lastSeen,
            };
            vi.mocked(getFailureAggregates).mockResolvedValueOnce(new Map([[VALID_UUID_B, agg]]));

            const row = {
                id: VALID_UUID_B,
                file_path: '/media/some/movie.mkv',
                health_issues: [
                    {
                        type: 'no_keyframes',
                        detected_at: '2026-01-10T00:00:00.000Z',
                    },
                ],
                audit_run_job_id: 'job-abc',
                task_history_id: 77,
            };

            const ctx = makePluginCtx();
            let sqlCallIndex = 0;
            vi.mocked(ctx.sql as unknown as ReturnType<typeof vi.fn>).mockImplementation(
                (..._args: unknown[]) => {
                    if (
                        Array.isArray(_args[0]) &&
                        /^[a-z_]+[.][a-z_]+$/i.test(String(_args[0][0]).trim())
                    )
                        return Promise.resolve([]);
                    sqlCallIndex++;
                    if (sqlCallIndex === 1) return Promise.resolve([{ count: 1 }]);
                    if (sqlCallIndex === 2) return Promise.resolve([row]);
                    return Promise.resolve([]);
                },
            );

            const result = await mediaProbeTask.failures!.list(ctx, {
                limit: 10,
                offset: 0,
            });

            expect(vi.mocked(getFailureAggregates)).toHaveBeenCalledOnce();
            expect(vi.mocked(getFailureAggregates)).toHaveBeenCalledWith(
                expect.anything(),
                'media-probe',
                expect.arrayContaining([VALID_UUID_B]),
            );

            const item = result.items[0];
            expect(item.id).toBe(VALID_UUID_B);
            expect(item.firstSeen).toBe(firstSeen.toISOString());
            expect(item.failureCount).toBe(4);
            expect(item.lastSeen).toBe(lastSeen.toISOString());
        });
    });

    // ── Case 5: listFailedItems tolerates missing aggregates ─────────────────

    describe('listFailedItems: tolerates missing aggregates', () => {
        it('leaves firstSeen/failureCount/lastSeen undefined when no aggregate exists for a row', async () => {
            // getFailureAggregates returns empty map (default mock)
            const row = {
                id: VALID_UUID_C,
                file_path: '/media/other/movie.mkv',
                health_issues: [
                    {
                        type: 'truncated_video',
                        detected_at: '2026-01-05T00:00:00.000Z',
                    },
                ],
                audit_run_job_id: null,
                task_history_id: null,
            };

            const ctx = makePluginCtx();
            let sqlCallIndex = 0;
            vi.mocked(ctx.sql as unknown as ReturnType<typeof vi.fn>).mockImplementation(
                (..._args: unknown[]) => {
                    if (
                        Array.isArray(_args[0]) &&
                        /^[a-z_]+[.][a-z_]+$/i.test(String(_args[0][0]).trim())
                    )
                        return Promise.resolve([]);
                    sqlCallIndex++;
                    if (sqlCallIndex === 1) return Promise.resolve([{ count: 1 }]);
                    if (sqlCallIndex === 2) return Promise.resolve([row]);
                    return Promise.resolve([]);
                },
            );

            const result = await mediaProbeTask.failures!.list(ctx, {
                limit: 10,
                offset: 0,
            });

            const item = result.items[0];
            expect(item.id).toBe(VALID_UUID_C);
            expect(item.firstSeen).toBeUndefined();
            expect(item.failureCount).toBeUndefined();
            expect(item.lastSeen).toBeUndefined();
        });
    });
});
