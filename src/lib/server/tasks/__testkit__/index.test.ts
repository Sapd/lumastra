// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Self-test for the task-system testkit. Exercises every builder so the public
 * API is proven to compile AND produce valid shapes — this file is itself the
 * first consumer that locks the types in place.
 *
 * Run with:
 *   NODE_OPTIONS='--max-old-space-size=6144' \
 *     npx vitest run src/lib/server/tasks/__testkit__/index.test.ts
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type postgres from 'postgres';
import type * as StageStateQueries from '$lib/server/database/queries/stage-state.queries.js';
import {
    makeRecordingSql,
    makeTaskDef,
    makeStateMachine,
    makeRegistry,
    mockContext,
} from './index.js';

// ── Verify the documented stage-state typed-mock convention actually works ──
// This is the exact hoist-safe pattern the 6 downstream coverage files copy.
// `typeof StageStateQueries.upsertCompletedRow` is a compile-time type, so it
// is legal inside vi.hoisted (which is hoisted above the imports).
const stageState = vi.hoisted(() => ({
    upsertCompletedRow: vi.fn<typeof StageStateQueries.upsertCompletedRow>(),
    upsertSkippedPermanentRow: vi.fn<typeof StageStateQueries.upsertSkippedPermanentRow>(),
}));
vi.mock('$lib/server/database/queries/stage-state.queries.js', () => stageState);

describe('testkit / makeTaskDef', () => {
    it('applies sensible defaults', () => {
        const def = makeTaskDef();
        expect(def.id).toBe('testkit-task');
        expect(def.version).toBe('1.0.0');
        expect(def.processingVersion).toBe(1);
        expect(def.resourceClass).toBe('io');
        expect(typeof def.execute).toBe('function');
        expect(def.identityFor({})).toBe('global');
    });

    it('merges overrides', () => {
        const def = makeTaskDef({ id: 'x', resourceClass: 'cpu' });
        expect(def.id).toBe('x');
        expect(def.resourceClass).toBe('cpu');
    });

    it('produces a runnable execute', async () => {
        const def = makeTaskDef();
        const ctx = mockContext();
        const result = await def.execute(ctx);
        expect(result).toEqual({ success: true, itemsProcessed: 0 });
    });

    it('accepts quota / pipeline fields directly (one builder, no variants)', () => {
        const def = makeTaskDef({
            id: 'with-quota',
            quotas: { maxConcurrent: 2 },
            inputSchema: z.object({ libraryGroupId: z.string().optional() }),
        });
        expect(def.quotas?.maxConcurrent).toBe(2);
    });
});

describe('testkit / makeRecordingSql', () => {
    it('records the assembled query text and interpolated values', async () => {
        const rec = makeRecordingSql();
        await rec.sql`SELECT id FROM t WHERE x = ${42} AND y = ${'a'}`;
        expect(rec.calls).toHaveLength(1);
        expect(rec.calls[0].query).toBe('SELECT id FROM t WHERE x = ? AND y = ?');
        expect(rec.calls[0].values).toEqual([42, 'a']);
    });

    it('returns the rows passed via opts.rows on the first call', async () => {
        const rec = makeRecordingSql({ rows: [{ id: 'a' }, { id: 'b' }] });
        const out = await rec.sql`SELECT id FROM t`;
        expect(out).toEqual([{ id: 'a' }, { id: 'b' }]);
        // Second call falls back to [] once the queue is drained.
        const out2 = await rec.sql`SELECT id FROM t`;
        expect(out2).toEqual([]);
    });

    it('returns [] by default and supports queueRows() FIFO', async () => {
        const rec = makeRecordingSql();
        const empty = await rec.sql`SELECT 1`;
        expect(empty).toEqual([]);
        rec.queueRows([{ n: 1 }]);
        rec.queueRows([{ n: 2 }]);
        expect(await rec.sql`SELECT 2`).toEqual([{ n: 1 }]);
        expect(await rec.sql`SELECT 3`).toEqual([{ n: 2 }]);
    });

    it('tolerates .json / .begin / .unsafe access without exploding', async () => {
        const rec = makeRecordingSql({ rows: [{ ok: true }] });
        const sql = rec.sql;
        expect(sql.json({ a: 1 })).toEqual({ a: 1 });
        const begun = await sql.begin(async (txRaw) => {
            const tx = txRaw as unknown as postgres.Sql;
            return tx`UPDATE t SET x = ${1}`;
        });
        expect(begun).toEqual([{ ok: true }]);
        // The transaction statement was recorded through the same double.
        expect(rec.calls.some((c) => c.query.startsWith('UPDATE t'))).toBe(true);
    });
});

describe('testkit / makeStateMachine', () => {
    it('exposes callable vi.fn methods with success defaults', async () => {
        const sm = makeStateMachine();
        expect(vi.isMockFunction(sm.transitionRun)).toBe(true);
        await expect(
            sm.transitionRun({ runId: 'r', from: 'pending', to: 'active' }),
        ).resolves.toEqual({ ok: true });
        await expect(sm.incrementStage({ runId: 'r', stageId: 's' })).resolves.toEqual({
            ok: true,
            processed: 0,
            autoCompleted: false,
        });
        await expect(sm.reseedForRetry('r')).resolves.toBe('reseeded');
    });

    it('allows overriding a single method', async () => {
        const claimRun = vi.fn(async () => ({
            ok: false,
            error: 'claimed by other',
        }));
        const sm = makeStateMachine({ claimRun });
        await expect(
            sm.claimRun({
                runId: 'r',
                expectedState: 'pending',
                instanceId: 'i',
                bootId: 'b',
            }),
        ).resolves.toEqual({ ok: false, error: 'claimed by other' });
        expect(claimRun).toHaveBeenCalledTimes(1);
    });
});

describe('testkit / makeRegistry', () => {
    it('builds a real registry that resolves tasks by id', () => {
        const reg = makeRegistry([makeTaskDef({ id: 'a' }), makeTaskDef({ id: 'b' })]);
        expect(reg.getTask('a')?.id).toBe('a');
        expect(reg.getTask('b')?.id).toBe('b');
        expect(reg.getTask('missing')).toBeUndefined();
        expect(reg.getAllTasks()).toHaveLength(2);
    });
});

describe('testkit / stage-state typed-mock convention', () => {
    it('intercepts the real query module exports', async () => {
        // Import lazily so the vi.mock above is in effect.
        const mod = await import('$lib/server/database/queries/stage-state.queries.js');
        await mod.upsertCompletedRow(makeRecordingSql().sql, {
            mediaItemId: 'id',
            stageId: 'stage',
            processingVersion: 1,
        });
        expect(stageState.upsertCompletedRow).toHaveBeenCalledTimes(1);
        expect(stageState.upsertCompletedRow.mock.calls[0][1]).toEqual({
            mediaItemId: 'id',
            stageId: 'stage',
            processingVersion: 1,
        });
    });
});
