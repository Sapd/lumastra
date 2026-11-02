// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * reconciliation-backfill opts into resumeAfterRestart. The runner treats a
 * run that returns `success: true` after its abort as finished, so a sweep
 * cut short by a shutdown must say so (`stopReason: 'aborted'`) or it would be
 * recorded as completed and never resumed.
 */

import { describe, it, expect, vi } from 'vitest';

const service = vi.hoisted(() => ({
    backfillReconcileSeries: vi.fn(async () => ({
        appliedExternalIds: 0,
        updatedTitles: 1,
        quarantined: 0,
    })),
    listReconcileBackfillCandidates: vi.fn(async () => [
        { seriesMediaId: 's1' },
        { seriesMediaId: 's2' },
    ]),
    reevaluateQuarantineBacklog: vi.fn(async () => ({
        rowsExamined: 0,
        dismissedGone: 0,
        reattached: 0,
    })),
}));
vi.mock('$lib/server/services/episode-reconciliation.service.js', () => service);
vi.mock('../../../registry.js', () => ({ registry: { registerTask: vi.fn() } }));

const { reconciliationBackfillTask, parseReconcileCheckpoint } =
    await import('../reconciliation-backfill.js');

function ctx(signal: AbortSignal, input: Record<string, unknown> = {}, checkpoint?: unknown) {
    return {
        sql: {},
        signal,
        input,
        checkpoint,
        reportProgress: vi.fn(),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as Parameters<typeof reconciliationBackfillTask.execute>[0];
}

describe('reconciliation-backfill resume after restart', () => {
    it('declares resumeAfterRestart', () => {
        expect(reconciliationBackfillTask.resumeAfterRestart).toBe(true);
    });

    it('reports an aborted sweep as unfinished', async () => {
        const controller = new AbortController();
        service.backfillReconcileSeries.mockImplementationOnce(async () => {
            controller.abort();
            return { appliedExternalIds: 0, updatedTitles: 0, quarantined: 0 };
        });
        const result = await reconciliationBackfillTask.execute(ctx(controller.signal));
        expect(result.success).toBe(false);
        expect(result.stopReason).toBe('aborted');
    });

    it('a sweep that drained reports success', async () => {
        service.listReconcileBackfillCandidates
            .mockResolvedValueOnce([{ seriesMediaId: 's1' }])
            .mockResolvedValueOnce([]);
        const result = await reconciliationBackfillTask.execute(ctx(new AbortController().signal));
        expect(result.success).toBe(true);
        expect(result.stopReason).toBeUndefined();
    });

    it('an abort that only skips the quarantine re-evaluation is still a finished sweep', async () => {
        const controller = new AbortController();
        service.listReconcileBackfillCandidates
            .mockResolvedValueOnce([{ seriesMediaId: 's1' }])
            .mockImplementationOnce(async () => {
                controller.abort();
                return [];
            });
        const result = await reconciliationBackfillTask.execute(ctx(controller.signal));
        expect(result.success).toBe(true);
    });

    it('a resumed forced sweep skips series stamped since the original sweep began', async () => {
        const sweepStartedAt = '2026-10-06T10:00:00.000Z';
        const totals = {
            seriesProcessed: 7,
            appliedExternalIds: 1,
            updatedTitles: 2,
            quarantined: 0,
            quarantineReevaluated: 0,
            quarantineDismissedGone: 0,
            quarantineReattached: 0,
        };
        service.listReconcileBackfillCandidates.mockReset();
        service.listReconcileBackfillCandidates
            .mockResolvedValueOnce([{ seriesMediaId: 's8' }])
            .mockResolvedValueOnce([]);
        const saves: unknown[] = [];
        const checkpoint = {
            load: vi.fn(async () => ({ v: 1, sweepStartedAt, totals })),
            save: vi.fn(async (v: unknown) => {
                saves.push(v);
            }),
        };
        const result = await reconciliationBackfillTask.execute(
            ctx(new AbortController().signal, { force: true }, checkpoint),
        );
        expect(service.listReconcileBackfillCandidates).toHaveBeenCalledWith(expect.anything(), {
            limit: expect.any(Number),
            staleOnly: true,
            staleBefore: new Date(sweepStartedAt),
        });
        expect(result.result?.seriesProcessed).toBe(8);
        expect(saves.at(-1)).toMatchObject({ sweepStartedAt });
    });

    it('a resumed default sweep keeps the original 7-day window', async () => {
        const sweepStartedAt = '2026-10-06T10:00:00.000Z';
        service.listReconcileBackfillCandidates.mockReset();
        service.listReconcileBackfillCandidates.mockResolvedValueOnce([]);
        await reconciliationBackfillTask.execute(
            ctx(
                new AbortController().signal,
                {},
                {
                    load: vi.fn(async () => ({
                        v: 1,
                        sweepStartedAt,
                        totals: {
                            seriesProcessed: 0,
                            appliedExternalIds: 0,
                            updatedTitles: 0,
                            quarantined: 0,
                            quarantineReevaluated: 0,
                            quarantineDismissedGone: 0,
                            quarantineReattached: 0,
                        },
                    })),
                    save: vi.fn(async () => {}),
                },
            ),
        );
        expect(service.listReconcileBackfillCandidates).toHaveBeenCalledWith(expect.anything(), {
            limit: expect.any(Number),
            staleOnly: true,
            staleBefore: new Date(Date.parse(sweepStartedAt) - 7 * 24 * 60 * 60 * 1000),
        });
    });

    it('ignores a malformed checkpoint', () => {
        expect(parseReconcileCheckpoint({ v: 1, sweepStartedAt: 'x', totals: {} })).toBeNull();
        expect(parseReconcileCheckpoint(null)).toBeNull();
    });
});
