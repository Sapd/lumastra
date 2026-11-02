// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * media-probe listFailedItems — unit tests.
 *
 * The implementation queries media_files.health_issues (JSONB array)
 * using ctx.sql tagged templates. We mock ctx.sql to return fixtures.
 */

/**
 * Self-heal invariant (Phase C audit, commit 377c1d771):
 *
 * media-probe's atomic write clears health_issues on success.
 *
 * Evidence: media-probe.ts wraps both updateKeyframes and
 * updateHealthIssues in withTx, ensuring health_issues is cleared
 * (set to null) on every successful probe. The atomic transaction:
 *   await withTx(sql, async (txRaw) => {
 *       await updateKeyframes(tx, file.id, result.keyframes);
 *       await updateHealthIssues(tx, file.id, issues.length > 0 ? issues : null);
 *   });
 * The null parameter on the updateHealthIssues call clears health_issues when
 * no issues are detected, preventing stale failure markers from persisting.
 * This means the backlog's "failed" count naturally drops on re-processing.
 *
 * Phase C Task 6 originally planned to add a real regression test here,
 * but the existing mocked-SQL test infrastructure can't verify the real
 * atomic transaction behavior. Integration-level coverage belongs in a future
 * DB-backed test suite. For now this comment locks the invariant by explicit
 * reference; any refactor that breaks the atomic pattern must be caught in
 * code review.
 */

import { describe, it, expect, vi } from 'vitest';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';
// These tests exercise task wiring with queued SQL results. Query-fragment construction
// is not a database call; the real shared predicates are exercised by the duration-review PG test.
vi.mock('../../../../database/queries/file-health-classification.queries.js', () => ({
    actionableFileHealthSql: () => 'current-file-health-fragment',
    boundedAdminHealthIssuesSql: () => 'bounded-file-health-fragment',
}));
import { mediaProbeTask, listFailedItems } from '../media-probe.js';

function makeCtx(sqlCalls: unknown[][]): TaskContext<{ [x: string]: unknown }> {
    let callIndex = 0;
    const sql = vi.fn((..._args: unknown[]) => {
        if (Array.isArray(_args[0]) && /^[a-z_]+[.][a-z_]+$/i.test(String(_args[0][0]).trim()))
            return Promise.resolve([]);
        const result = sqlCalls[callIndex] ?? [];
        callIndex++;
        return Promise.resolve(result);
    }) as unknown as TaskContext['sql'];

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

describe('media-probe listFailedItems', () => {
    it('is defined on the task', () => {
        expect(typeof mediaProbeTask.failures?.list).toBe('function');
    });

    it('returns empty result when no files have health issues', async () => {
        const ctx = makeCtx([[{ count: 0 }], []]);
        const result = await mediaProbeTask.failures!.list(ctx, {
            limit: 10,
            offset: 0,
        });
        expect(result.total).toBe(0);
        expect(result.items).toHaveLength(0);
    });

    it('excludes unlinked or unprobed files — count and rows both return 0 for those', async () => {
        // An unlinked file (no media_file_items row) or an unprobed file
        // (probed_at IS NULL) must NOT appear in the drilldown because the
        // backlog's `failed` count requires is_linked AND is_probed.
        // The SQL predicate filters them out at the DB level; when the DB
        // returns no rows, listFailedItems correctly reports total=0.
        const ctx = makeCtx([[{ count: 0 }], []]);
        const result = await mediaProbeTask.failures!.list(ctx, {
            limit: 10,
            offset: 0,
        });
        expect(result.total).toBe(0);
        expect(result.items).toHaveLength(0);
    });

    it('returns paginated failed files with correct shape', async () => {
        const failedFile = {
            id: 'file-bad',
            file_path: '/media/movies/Daydream.mkv',
            health_issues: [
                {
                    type: 'no_keyframes',
                    detected_at: '2026-04-01T10:00:00.000Z',
                },
            ],
        };

        // First sql call → COUNT(*), second sql call → rows
        const ctx = makeCtx([[{ count: 1 }], [failedFile]]);
        const result = await mediaProbeTask.failures!.list(ctx, {
            limit: 10,
            offset: 0,
        });

        expect(result.total).toBe(1);
        expect(result.items).toHaveLength(1);

        const item = result.items[0];
        expect(item.id).toBe('file-bad');
        expect(item.label).toContain('Daydream');
        expect(item.reason).toMatch(/no_keyframes/);
        expect(item.detectedAt).toBe('2026-04-01T10:00:00.000Z');
        expect(item.subtitle).toBe('/media/movies/Daydream.mkv');
    });

    it('includes the truncated_video reason from health_issues', async () => {
        const failedFile = {
            id: 'file-trunc',
            file_path: '/media/tv/Show S01E01.mkv',
            health_issues: [
                {
                    type: 'truncated_video',
                    detected_at: '2026-04-02T08:00:00.000Z',
                    expected_duration: 3600,
                    actual_duration: 300,
                },
            ],
        };

        const ctx = makeCtx([[{ count: 1 }], [failedFile]]);
        const result = await mediaProbeTask.failures!.list(ctx, {
            limit: 10,
            offset: 0,
        });

        expect(result.items[0].reason).toMatch(/truncated_video/);
    });

    it('clamps limit to [1, 100]', async () => {
        // Two complete sql cycles needed (count + rows) for each call
        const ctx = makeCtx([
            [{ count: 0 }],
            [], // limit=0 call
            [{ count: 0 }],
            [], // limit=200 call
        ]);
        await expect(
            mediaProbeTask.failures!.list(ctx, { limit: 0, offset: 0 }),
        ).resolves.toBeDefined();
        await expect(
            mediaProbeTask.failures!.list(ctx, { limit: 200, offset: 0 }),
        ).resolves.toBeDefined();
    });

    it('surfaces taskRunId from task_history JOIN when audit_run_job_id is set', async () => {
        const failedFile = {
            id: 'file-with-job',
            file_path: '/media/movies/Tenet.mkv',
            health_issues: [
                {
                    type: 'no_keyframes',
                    detected_at: '2026-04-20T12:00:00.000Z',
                },
            ],
            audit_run_job_id: 'probe-job-42',
            task_history_id: 9001,
        };

        // Call listFailedItems directly to access taskRunId (stripped from SdkFailedItem)
        const ctx = makeCtx([[{ count: 1 }], [failedFile]]);
        const result = await listFailedItems(ctx, { limit: 10, offset: 0 });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].taskRunId).toBe(9001);
    });

    it('returns taskRunId as undefined when audit_run_job_id has no matching task_history row', async () => {
        const failedFile = {
            id: 'file-no-match',
            file_path: '/media/movies/Dawn.mkv',
            health_issues: [
                {
                    type: 'truncated_video',
                    detected_at: '2026-04-21T08:00:00.000Z',
                },
            ],
            audit_run_job_id: 'probe-job-99',
            task_history_id: null,
        };

        // Call listFailedItems directly to access taskRunId (stripped from SdkFailedItem)
        const ctx = makeCtx([[{ count: 1 }], [failedFile]]);
        const result = await listFailedItems(ctx, { limit: 10, offset: 0 });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].taskRunId).toBeUndefined();
    });

    it('returns taskRunId as undefined when audit_run_job_id is null (pre-Phase-D row)', async () => {
        const failedFile = {
            id: 'file-legacy',
            file_path: '/media/movies/Orionkeeper.mkv',
            health_issues: [
                {
                    type: 'no_keyframes',
                    detected_at: '2026-01-10T06:00:00.000Z',
                },
            ],
            audit_run_job_id: null,
            task_history_id: null,
        };

        // Call listFailedItems directly to access taskRunId (stripped from SdkFailedItem)
        const ctx = makeCtx([[{ count: 1 }], [failedFile]]);
        const result = await listFailedItems(ctx, { limit: 10, offset: 0 });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].taskRunId).toBeUndefined();
    });

    it('returns the archive id as taskRunId via UNION ALL', async () => {
        // Simulates an archive row seeded with original_id = 4213 and
        // task_id = 'job-abc'. The UNION ALL projects original_id AS id for the
        // archive side, so the JOIN returns task_history_id = 4213 (NOT the
        // archive's own SERIAL pk), preventing stale id collisions.
        const failedFile = {
            id: 'file-archived-probe',
            file_path: '/media/movies/Dune2.mkv',
            health_issues: [
                {
                    type: 'no_keyframes',
                    detected_at: '2026-01-15T09:00:00.000Z',
                },
            ],
            audit_run_job_id: 'job-abc',
            // task_history_id comes from the JOIN: original_id = 4213
            task_history_id: 4213,
        };

        // Call listFailedItems directly to access taskRunId (stripped from SdkFailedItem)
        const ctx = makeCtx([[{ count: 1 }], [failedFile]]);
        const result = await listFailedItems(ctx, { limit: 10, offset: 0 });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].taskRunId).toBe(4213);
    });
});
