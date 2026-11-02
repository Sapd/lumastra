// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * bulk-media-sync task — the provider-hitting counterpart to bulk-lock.ts,
 * enqueued by admin/media/bulk-sync.ts and polled via /api/runs/{jobId}.
 *
 * Verifies behaviourally that:
 *  - a batch where every item syncs cleanly reports itemsProcessed === the
 *    batch size and an empty failedIds — a revert that stops incrementing
 *    `processed` (or always pushes into failedIds) fails this.
 *  - a batch with one failing item names THAT id in failedIds and still
 *    processes the rest of the batch — a revert that aborts the whole loop
 *    on the first thrown error, or that reports counts without identifying
 *    which id failed, fails this.
 *  - an episode/season id in the batch is rejected without attempting a sync
 *    call at all (mirrors the single-item admin/media/[id]/sync.ts gate) — a
 *    revert that drops this gate would call syncSingleItem for an
 *    episode/season and fail this test's "not called" assertion.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const stageState = vi.hoisted(() => ({
    upsertCompletedRow: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/server/database/queries/stage-state.queries.js', () => stageState);

vi.mock('$lib/server/config.js', () => ({
    config: {},
    getAuthoritativeStageIds: vi.fn(() => new Set()),
    FEATURE_PER_TASK_QUEUES: false,
}));

const syncMock = vi.hoisted(() => ({
    syncSingleItem: vi.fn(),
    syncSeriesWithChildren: vi.fn(),
    SeriesSyncAbortedError: class SeriesSyncAbortedError extends Error {},
}));
vi.mock('$lib/server/services/metadata-sync-single.service.js', () => syncMock);

const { bulkMediaSyncTask, parseBulkSyncCheckpoint } = await import('../media-item-tasks.js');

const MOVIE_A = '11111111-1111-1111-1111-111111111111';
const MOVIE_B = '22222222-2222-2222-2222-222222222222';
const EPISODE_C = '33333333-3333-3333-3333-333333333333';

/** Minimal fake TaskExecutionContext — only the surface bulk-media-sync touches. */
function makeCtx(rowsByid: Record<string, string>) {
    const sql = vi.fn((..._args: unknown[]) => {
        // The task issues one templated SELECT per id, always awaited
        // immediately — a queue drained in call order matches 1:1 with the
        // mediaItemIds loop order.
        const id = idQueue.shift();
        const mediaType = id ? rowsByid[id] : undefined;
        return Promise.resolve(mediaType ? [{ media_type: mediaType }] : []);
    });
    const idQueue = Object.keys(rowsByid).length ? [...Object.keys(rowsByid)] : [];
    return {
        input: {
            mediaItemIds: Object.keys(rowsByid),
            includeChildren: false,
            forceChildren: false,
        },
        sql,
        signal: { aborted: false } as AbortSignal,
        reportProgress: vi.fn(),
        spend: vi.fn(),
    } as unknown as Parameters<typeof bulkMediaSyncTask.execute>[0];
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('bulk-media-sync task', () => {
    it('processes every item and reports an empty failedIds on full success', async () => {
        syncMock.syncSingleItem.mockResolvedValue({ updated: true, fieldsChanged: ['title'] });

        const ctx = makeCtx({ [MOVIE_A]: 'movie', [MOVIE_B]: 'movie' });
        const result = (await bulkMediaSyncTask.execute(ctx)) as {
            success: boolean;
            itemsProcessed: number;
            failedIds: string[];
        };

        expect(result.itemsProcessed).toBe(2);
        expect(result.failedIds).toEqual([]);
        expect(result.success).toBe(true);
        expect(syncMock.syncSingleItem).toHaveBeenCalledTimes(2);
    });

    it('names the failing id and keeps processing the rest of the batch', async () => {
        syncMock.syncSingleItem.mockImplementation(async (_sql: unknown, id: string) => {
            if (id === MOVIE_A) throw new Error('tmdb unreachable');
            return { updated: true, fieldsChanged: [] };
        });

        const ctx = makeCtx({ [MOVIE_A]: 'movie', [MOVIE_B]: 'movie' });
        const result = (await bulkMediaSyncTask.execute(ctx)) as {
            success: boolean;
            itemsProcessed: number;
            failedIds: string[];
        };

        expect(result.itemsProcessed).toBe(1);
        expect(result.failedIds).toEqual([MOVIE_A]);
        expect(result.success).toBe(false);
        // Both items were attempted despite the first one throwing.
        expect(syncMock.syncSingleItem).toHaveBeenCalledTimes(2);
    });

    it('rejects an episode id without ever calling syncSingleItem for it', async () => {
        syncMock.syncSingleItem.mockResolvedValue({ updated: true, fieldsChanged: [] });

        // A lone episode is a total failure (0 processed, 1 failed), which
        // this task throws rather than returns — see the comment above the
        // throw in bulk-media-sync's execute(): a bare `success: false` on a
        // coversStages-less task is invisible to the circuit breaker.
        const ctx = makeCtx({ [EPISODE_C]: 'episode', [MOVIE_A]: 'movie' });
        syncMock.syncSingleItem.mockResolvedValue({ updated: true, fieldsChanged: [] });
        const result = (await bulkMediaSyncTask.execute(ctx)) as unknown as {
            failedIds: string[];
        };

        expect(result.failedIds).toEqual([EPISODE_C]);
        expect(syncMock.syncSingleItem).toHaveBeenCalledTimes(1);
        expect(syncMock.syncSingleItem).not.toHaveBeenCalledWith(
            expect.anything(),
            EPISODE_C,
            expect.anything(),
        );
    });

    it('declares resumeAfterRestart and continues from its checkpoint', async () => {
        expect(bulkMediaSyncTask.resumeAfterRestart).toBe(true);
        syncMock.syncSingleItem.mockResolvedValue({ updated: true, fieldsChanged: [] });

        const ctx = makeCtx({ [MOVIE_A]: 'movie', [MOVIE_B]: 'movie' });
        const saves: unknown[] = [];
        const checkpoint = {
            load: vi.fn(async () => ({
                v: 1,
                count: 2,
                next: 1,
                processed: 1,
                failedIds: [],
            })),
            save: vi.fn(async (v: unknown) => {
                saves.push(v);
            }),
        };
        const result = (await bulkMediaSyncTask.execute({
            ...ctx,
            checkpoint,
        } as typeof ctx)) as { itemsProcessed: number; success: boolean };

        // MOVIE_A was done by the interrupted run: only MOVIE_B is synced.
        expect(syncMock.syncSingleItem).toHaveBeenCalledTimes(1);
        expect(syncMock.syncSingleItem).toHaveBeenCalledWith(expect.anything(), MOVIE_B, {
            force: true,
        });
        expect(result.itemsProcessed).toBe(2);
        expect(result.success).toBe(true);
        expect(saves.at(-1)).toMatchObject({ next: 2, processed: 2 });
    });

    it('ignores a checkpoint saved for a different id list', () => {
        const saved = { v: 1, count: 3, next: 1, processed: 1, failedIds: [] };
        expect(parseBulkSyncCheckpoint(saved, [MOVIE_A, MOVIE_B])).toBeNull();
        expect(parseBulkSyncCheckpoint({ ...saved, count: 2 }, [MOVIE_A, MOVIE_B])).not.toBeNull();
        expect(parseBulkSyncCheckpoint('junk', [MOVIE_A])).toBeNull();
    });

    it('does not record or checkpoint past an item the abort cut short', async () => {
        const signal = { aborted: false } as { aborted: boolean };
        syncMock.syncSingleItem.mockImplementation(async (_sql: unknown, id: string) => {
            if (id === MOVIE_B) {
                signal.aborted = true;
                throw new Error('aborted');
            }
            return { updated: true, fieldsChanged: [] };
        });
        const ctx = makeCtx({ [MOVIE_A]: 'movie', [MOVIE_B]: 'movie' });
        const saves: Array<{ next: number }> = [];
        const result = (await bulkMediaSyncTask.execute({
            ...ctx,
            signal: signal as unknown as AbortSignal,
            checkpoint: {
                load: vi.fn(async () => null),
                save: vi.fn(async (v: unknown) => {
                    saves.push(v as { next: number });
                }),
            },
        } as typeof ctx)) as { stopReason?: string; failedIds: string[]; success: boolean };

        expect(result.success).toBe(false);
        expect(result.stopReason).toBe('aborted');
        // MOVIE_B is neither a failure nor saved past: a resume re-does it.
        expect(result.failedIds).toEqual([]);
        expect(saves.map((v) => v.next)).toEqual([1]);
    });
});
