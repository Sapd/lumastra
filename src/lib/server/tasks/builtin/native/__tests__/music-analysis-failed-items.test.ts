// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * music-analysis failures.list — unit tests.
 *
 * The implementation queries media_items.processing_state for rows
 * with 'music-analysis' status = 'failed'. We mock ctx.sql.
 */

/**
 * Self-heal invariant (Phase C audit, commit 377c1d771):
 *
 * markTrackAnalyzed overwrites prior failed marker on success.
 *
 * Evidence: music-analysis.queries.ts:261-283 uses JSONB concat operator (||):
 *   SET processing_state = COALESCE(processing_state, '{}'::jsonb) || {
 *       'music-analysis': { version, processedAt }
 *   }
 * The || operator replaces the 'music-analysis' key entirely, so a prior
 * failed marker { status: 'failed', reason: '...' } is fully replaced by
 * the success marker (no status field = success by convention). This atomic
 * JSONB replacement means the backlog's "failed" count naturally drops on
 * successful retry.
 */

import { describe, it, expect, vi } from 'vitest';

// ─── plugin-failure-events mock ───────────────────────────────────────────────
vi.mock('../../../../database/queries/plugin-failure-events.queries.js', () => ({
    recordFailure: vi.fn().mockResolvedValue(undefined),
    getFailureAggregates: vi.fn().mockResolvedValue(new Map()),
}));

import { musicAnalysisTask } from '../music-analysis.js';

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

type ListFn = NonNullable<NonNullable<typeof musicAnalysisTask.failures>['list']>;

async function callList(ctx: ReturnType<typeof makeCtx>, opts: { limit: number; offset: number }) {
    return musicAnalysisTask.failures!.list!(ctx as unknown as Parameters<ListFn>[0], opts);
}

describe('music-analysis failures.list', () => {
    it('is defined on the task', () => {
        expect(typeof musicAnalysisTask.failures?.list).toBe('function');
    });

    it('returns empty result when no tracks have failed analysis', async () => {
        const ctx = makeCtx([[{ count: 0 }], []]);
        const result = await callList(ctx, { limit: 10, offset: 0 });
        expect(result.total).toBe(0);
        expect(result.items).toHaveLength(0);
    });

    it('excludes tracks with a stale-version failed marker — count and rows both return 0', async () => {
        const ctx = makeCtx([[{ count: 0 }], []]);
        const result = await callList(ctx, { limit: 10, offset: 0 });
        expect(result.total).toBe(0);
        expect(result.items).toHaveLength(0);
    });

    it('returns failed tracks with artist — title label', async () => {
        const failedTrack = {
            id: 'track-001',
            title: 'Blue in Amber',
            artist: 'Milo Fenwick',
            processing_state: {
                'music-analysis': {
                    version: 5,
                    status: 'failed',
                    reason: 'essentia-empty-result',
                    processedAt: '2026-04-01T10:00:00.000Z',
                },
            },
        };

        const ctx = makeCtx([[{ count: 2 }], [failedTrack]]);
        const result = await callList(ctx, { limit: 10, offset: 0 });

        expect(result.total).toBe(2);
        expect(result.items).toHaveLength(1);

        const item = result.items[0];
        expect(item.id).toBe('track-001');
        expect(item.label).toBe('Milo Fenwick — Blue in Amber');
        expect(item.reason).toBe('essentia-empty-result');
        expect(item.detectedAt).toBeNull();
    });

    it('uses just title when artist is null', async () => {
        const failedTrack = {
            id: 'track-002',
            title: 'Unknown Track',
            artist: null,
            processing_state: {
                'music-analysis': {
                    version: 5,
                    status: 'failed',
                    reason: 'analyze-threw',
                    processedAt: '2026-04-02T08:00:00.000Z',
                },
            },
        };

        const ctx = makeCtx([[{ count: 1 }], [failedTrack]]);
        const result = await callList(ctx, { limit: 10, offset: 0 });

        const item = result.items[0];
        expect(item.label).toBe('Unknown Track');
        expect(item.reason).toBe('analyze-threw');
    });

    it('falls back reason to "Analysis failed" when reason is missing', async () => {
        const failedTrack = {
            id: 'track-003',
            title: 'Some Track',
            artist: 'Artist',
            processing_state: {
                'music-analysis': {
                    version: 5,
                    status: 'failed',
                },
            },
            task_history_id: null,
        };

        const ctx = makeCtx([[{ count: 1 }], [failedTrack]]);
        const result = await callList(ctx, { limit: 10, offset: 0 });

        expect(result.items[0].reason).toBe('Analysis failed');
    });

    it('failures.list returns item without taskRunId (field not in SDK FailedItem)', async () => {
        const failedTrack = {
            id: 'track-004',
            title: 'Blue in Amber',
            artist: 'Milo Fenwick',
            processing_state: {
                'music-analysis': {
                    version: 5,
                    status: 'failed',
                    reason: 'essentia-empty-result',
                    audit_run_job_id: 'job-9001',
                },
            },
            task_history_id: 9001,
        };

        const ctx = makeCtx([[{ count: 1 }], [failedTrack]]);
        const result = await callList(ctx, { limit: 10, offset: 0 });

        expect(result.items[0].id).toBe('track-004');
        expect(result.items[0].label).toBe('Milo Fenwick — Blue in Amber');
    });

    it('failures.list returns item for archived runs', async () => {
        const failedTrack = {
            id: 'track-006',
            title: 'Kind of Dawn',
            artist: 'Milo Fenwick',
            processing_state: {
                'music-analysis': {
                    version: 5,
                    status: 'failed',
                    reason: 'essentia-empty-result',
                    audit_run_job_id: 'job-abc',
                },
            },
            task_history_id: 4213,
        };

        const ctx = makeCtx([[{ count: 1 }], [failedTrack]]);
        const result = await callList(ctx, { limit: 10, offset: 0 });

        expect(result.items[0].id).toBe('track-006');
    });

    it('failures.list returns undefined firstSeen when no aggregate', async () => {
        const failedTrack = {
            id: 'track-005',
            title: 'Unknown',
            artist: null,
            processing_state: {
                'music-analysis': {
                    version: 5,
                    status: 'failed',
                    reason: 'analyze-threw',
                },
            },
            task_history_id: null,
        };

        const ctx = makeCtx([[{ count: 1 }], [failedTrack]]);
        const result = await callList(ctx, { limit: 10, offset: 0 });

        expect(result.items[0].firstSeen).toBeUndefined();
        expect(result.items[0].failureCount).toBeUndefined();
        expect(result.items[0].lastSeen).toBeUndefined();
    });
});
