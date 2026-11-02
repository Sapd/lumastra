// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockContext, mockCache } from '@sapd/lumastra-plugin-sdk-testing';
const service = vi.hoisted(() => ({
    backfillReconcileSeries: vi.fn(),
    listReconcileBackfillCandidates: vi.fn(),
    reevaluateQuarantineBacklog: vi.fn(),
    recheckQuarantinedMatchesForSeries: vi.fn(),
}));
vi.mock('$lib/server/services/episode-reconciliation.service.js', () => service);
vi.mock('../../../registry.js', () => ({ registry: { registerTask: vi.fn() } }));
import { reconciliationBackfillTask } from '../reconciliation-backfill.js';
const cursorKey = 'v1:quarantine-reeval:cursor';
const before = '12345678-1234-4234-8234-123456789abc';
const next = '12345678-1234-4234-8234-123456789abd';
beforeEach(() => {
    vi.clearAllMocks();
    service.listReconcileBackfillCandidates.mockResolvedValue([]);
    service.reevaluateQuarantineBacklog.mockResolvedValue({
        rowsExamined: 1,
        dismissedGone: 0,
        reattached: 0,
        continuation: next,
    });
});
describe('quarantine background traversal continuity', () => {
    it('persists progress past retained ambiguous rows and resumes the next bounded batch', async () => {
        const ctx = mockContext({ input: { quarantineReevalCap: 1 }, cache: mockCache() });
        await ctx.cache!.set(cursorKey, before, 10000);
        await reconciliationBackfillTask.execute(ctx);
        expect(service.reevaluateQuarantineBacklog).toHaveBeenCalledWith(expect.anything(), {
            cap: 1,
            actor: 'reconciliation-backfill',
            after: before,
        });
        expect(await ctx.cache!.get(cursorKey)).toBe(next);
    });
    it('starts a new traversal only after reaching the end', async () => {
        const ctx = mockContext({ input: { quarantineReevalCap: 1 }, cache: mockCache() });
        await ctx.cache!.set(cursorKey, before, 10000);
        service.reevaluateQuarantineBacklog.mockResolvedValue({
            rowsExamined: 0,
            dismissedGone: 0,
            reattached: 0,
        });
        await reconciliationBackfillTask.execute(ctx);
        expect(await ctx.cache!.get(cursorKey)).toBeNull();
    });
    it('keeps the prior cursor when a batch fails', async () => {
        const ctx = mockContext({ input: { quarantineReevalCap: 1 }, cache: mockCache() });
        await ctx.cache!.set(cursorKey, before, 10000);
        service.reevaluateQuarantineBacklog.mockRejectedValue(new Error('Interrupted'));
        await reconciliationBackfillTask.execute(ctx);
        expect(await ctx.cache!.get(cursorKey)).toBe(before);
    });
    it('runs one strict bounded completion check after a successful single-series backfill', async () => {
        service.backfillReconcileSeries.mockResolvedValueOnce({
            appliedExternalIds: 0,
            updatedTitles: 0,
            quarantined: 0,
        });
        service.recheckQuarantinedMatchesForSeries.mockResolvedValueOnce({
            examined: 250,
            resolved: 3,
            retained: 247,
        });
        const ctx = mockContext({ input: { seriesMediaId: before } });
        const result = await reconciliationBackfillTask.execute(ctx);
        expect(service.recheckQuarantinedMatchesForSeries).toHaveBeenCalledWith(
            ctx.sql,
            before,
            'reconciliation-backfill',
        );
        expect(result.result).toMatchObject({
            quarantineReevaluated: 250,
            quarantineReattached: 3,
        });
    });
});
