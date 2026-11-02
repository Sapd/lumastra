// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

vi.mock('$lib/server/database/with-tx.js', () => ({ withTx: vi.fn() }));
vi.mock('$lib/server/database/queries/never-owned-media-gc.queries.js', async (original) => ({
    ...(await original<
        typeof import('$lib/server/database/queries/never-owned-media-gc.queries.js')
    >()),
    evaluateNeverOwnedUnits: vi.fn(),
}));
vi.mock('$lib/server/database/queries/media-retention.queries.js', async (original) => ({
    ...(await original<typeof import('$lib/server/database/queries/media-retention.queries.js')>()),
    deriveRetentionUnit: vi.fn(),
}));
vi.mock('./media-deletion.service.js', () => ({
    afterHardDelete: vi.fn(),
    deleteMediaDependentsTx: vi.fn(),
}));
import { withTx } from '../database/with-tx.js';
import { deriveRetentionUnit } from '../database/queries/media-retention.queries.js';
import {
    emptyNeverOwnedEvaluation,
    evaluateNeverOwnedUnits,
    type NeverOwnedUnitCandidate,
} from '../database/queries/never-owned-media-gc.queries.js';
import { afterHardDelete, deleteMediaDependentsTx } from './media-deletion.service.js';
import { runNeverOwnedMediaGc } from './never-owned-media-gc.service.js';

const unit = (id: string): NeverOwnedUnitCandidate => ({
    id,
    kind: 'movie',
    members: 1,
    seasons: 0,
    episodes: 0,
    extras: 0,
});
let catalog: NeverOwnedUnitCandidate[];
let protectedIds: Set<string>;
const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    if (Array.isArray(strings) && strings.join('').includes('DELETE FROM media_items')) {
        const ids = values[0] as string[];
        catalog = catalog.filter((c) => !ids.includes(c.id));
        return Promise.resolve(ids.map((id) => ({ id })));
    }
    return Promise.resolve([]);
}) as unknown as postgres.Sql;
const settings = { enabled: true, minAgeDays: 30 };
const input = { dryRun: false, batchLimit: 2 };
const signal = (): AbortSignal => new AbortController().signal;
const catalogCalls = (): number =>
    vi.mocked(evaluateNeverOwnedUnits).mock.calls.filter(([, opts]) => !opts.rootId).length;

describe('never-owned media GC batch drain', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        catalog = ['a', 'b', 'c', 'd', 'e'].map(unit);
        protectedIds = new Set<string>();
        vi.mocked(withTx).mockImplementation(async (db, callback) => callback(db));
        vi.mocked(deriveRetentionUnit).mockImplementation(async (_db, id) => [
            { id, depth: 0, parent_id: null, truncated: false },
        ]);
        vi.mocked(afterHardDelete).mockResolvedValue();
        vi.mocked(deleteMediaDependentsTx).mockResolvedValue();
        vi.mocked(evaluateNeverOwnedUnits).mockImplementation(async (_db, opts) => {
            const result = emptyNeverOwnedEvaluation();
            const candidates = catalog.filter((c) => !opts.rootId || c.id === opts.rootId);
            const eligible = candidates.filter((c) => !protectedIds.has(c.id));
            result.candidates = eligible.slice(0, opts.limit);
            result.summary.movie = {
                ...result.summary.movie,
                roots: candidates.length,
                eligible: eligible.length,
                eligibleRows: eligible.length,
                kept: candidates.length - eligible.length,
            };
            return result;
        });
    });

    it('drains full and partial batches and sums deletions without duplicating catalog counts', async () => {
        const result = await runNeverOwnedMediaGc(sql, input, settings, signal());
        expect(result).toMatchObject({
            batches: 3,
            selected: 5,
            deleted: { movieUnits: 5, totalRows: 5 },
            eligible: { movieUnits: 5 },
            stoppedOnBudget: false,
            hasMore: false,
            timeBudgetMs: 900_000,
            sampleIds: ['a', 'b', 'c', 'd', 'e'],
        });
        expect(catalog).toEqual([]);
        expect(catalogCalls()).toBe(4);
        // Four read transactions and five independently guarded unit transactions.
        expect(withTx).toHaveBeenCalledTimes(9);
        expect(result.summary).toContain('deleted 5 movies');
        expect(result.summary).toContain('3 batches; time budget not reached');
    });

    it('finishes an empty catalog without a delete batch or a pause', async () => {
        catalog = [];
        const result = await runNeverOwnedMediaGc(sql, input, settings, signal());
        expect(result).toMatchObject({
            batches: 0,
            selected: 0,
            hasMore: false,
            stoppedOnBudget: false,
        });
        expect(catalogCalls()).toBe(1);
        expect(deleteMediaDependentsTx).not.toHaveBeenCalled();
    });

    it('does not start a delete batch when the initial evaluation consumes the budget', async () => {
        let now = 0;
        const evaluate = vi.mocked(evaluateNeverOwnedUnits).getMockImplementation()!;
        vi.mocked(evaluateNeverOwnedUnits).mockImplementationOnce(async (db, opts) => {
            const result = await evaluate(db, opts);
            now = 1000;
            return result;
        });
        const result = await runNeverOwnedMediaGc(
            sql,
            { ...input, timeBudgetMs: 1000 },
            settings,
            signal(),
            { now: () => now },
        );
        expect(result).toMatchObject({ batches: 0, stoppedOnBudget: true, hasMore: true });
        expect(deleteMediaDependentsTx).not.toHaveBeenCalled();
    });

    it.each([500, 1000])(
        'stops inside or between batches when the %i ms budget is reached',
        async (budget) => {
            let now = 0;
            vi.mocked(afterHardDelete).mockImplementation(async () => {
                now += 500;
            });
            const result = await runNeverOwnedMediaGc(
                sql,
                { ...input, timeBudgetMs: budget },
                settings,
                signal(),
                { now: () => now },
            );
            expect(result).toMatchObject({
                batches: 1,
                deleted: { movieUnits: budget / 500 },
                stoppedOnBudget: true,
                hasMore: true,
            });
            expect(catalogCalls()).toBe(1);
            expect(result.summary).toContain('stopped on time budget');
        },
    );

    it('counts the pause against the budget without evaluating another batch after expiry', async () => {
        const result = await runNeverOwnedMediaGc(
            sql,
            { ...input, timeBudgetMs: 100 },
            settings,
            signal(),
        );
        expect(result.stoppedOnBudget).toBe(true);
        expect(result.deleted.movieUnits).toBe(2);
        expect(catalogCalls()).toBe(1);
    });

    it('checks the budget between catalog read transactions', async () => {
        let now = 0;
        vi.mocked(evaluateNeverOwnedUnits).mockImplementationOnce(async () => {
            now = 1000;
            return { ...emptyNeverOwnedEvaluation(), nextAfterRootId: 'a' };
        });
        const result = await runNeverOwnedMediaGc(
            sql,
            { ...input, timeBudgetMs: 1000 },
            settings,
            signal(),
            { now: () => now },
        );
        expect(result).toMatchObject({
            stoppedOnBudget: true,
            evaluationComplete: false,
            hasMore: true,
        });
        expect(catalogCalls()).toBe(1);
        expect(deleteMediaDependentsTx).not.toHaveBeenCalled();
        expect(result.skipReasons).not.toHaveProperty('evaluation-statement-timeout');
    });

    it.each([
        { dryRun: true, enabled: true },
        { dryRun: false, enabled: false },
    ])('evaluates once for preview ($dryRun, enabled $enabled)', async ({ dryRun, enabled }) => {
        const result = await runNeverOwnedMediaGc(
            sql,
            { ...input, dryRun },
            { ...settings, enabled },
            signal(),
        );
        expect(result.dryRun).toBe(true);
        expect(result.batches).toBe(0);
        expect(catalogCalls()).toBe(1);
        expect(deleteMediaDependentsTx).not.toHaveBeenCalled();
    });

    it('rechecks protection added after selection and continues without retrying the skipped root', async () => {
        vi.mocked(deriveRetentionUnit).mockImplementation(async (_db, id) => {
            if (id === 'a') protectedIds.add(id);
            return [{ id, depth: 0, parent_id: null, truncated: false }];
        });
        const result = await runNeverOwnedMediaGc(
            sql,
            { ...input, batchLimit: 1 },
            settings,
            signal(),
        );
        expect(result.deleted.movieUnits).toBe(4);
        expect(result.skipReasons).toEqual({ 'eligibility-changed': 1 });
        expect(result.hasMore).toBe(true);
        expect(catalog.map((c) => c.id)).toEqual(['a']);
        expect(
            vi.mocked(deriveRetentionUnit).mock.calls.filter(([, id]) => id === 'a'),
        ).toHaveLength(2);
    });

    it('continues past a permanently contended first root', async () => {
        vi.mocked(deriveRetentionUnit).mockImplementation(async (_db, id) => {
            if (id === 'a') throw Object.assign(new Error('locked'), { code: '55P03' });
            return [{ id, depth: 0, parent_id: null, truncated: false }];
        });
        const result = await runNeverOwnedMediaGc(
            sql,
            { ...input, batchLimit: 1 },
            settings,
            signal(),
        );
        expect(result.deleted.movieUnits).toBe(4);
        expect(result.skipped).toBe(1);
        expect(catalog.map((c) => c.id)).toEqual(['a']);
    });

    it('honors an already aborted signal before I/O', async () => {
        const controller = new AbortController();
        controller.abort(new Error('cancelled'));
        await expect(runNeverOwnedMediaGc(sql, input, settings, controller.signal)).rejects.toThrow(
            'cancelled',
        );
        expect(withTx).not.toHaveBeenCalled();
    });

    it('honors cancellation after a batch before re-evaluation', async () => {
        const controller = new AbortController();
        vi.mocked(afterHardDelete).mockImplementation(async () => {
            if (catalog.length === 3) controller.abort(new Error('cancelled'));
        });
        await expect(runNeverOwnedMediaGc(sql, input, settings, controller.signal)).rejects.toThrow(
            'cancelled',
        );
        expect(catalogCalls()).toBe(1);
        expect(afterHardDelete).toHaveBeenCalledTimes(2);
    });

    it('interrupts the pause on cancellation', async () => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        vi.mocked(afterHardDelete).mockImplementation(async () => {
            if (catalog.length === 3) timer = setTimeout(() => controller.abort(), 10);
        });
        try {
            await expect(
                runNeverOwnedMediaGc(sql, input, settings, controller.signal),
            ).rejects.toMatchObject({ name: 'AbortError' });
            expect(catalogCalls()).toBe(1);
        } finally {
            clearTimeout(timer);
        }
    });
});
