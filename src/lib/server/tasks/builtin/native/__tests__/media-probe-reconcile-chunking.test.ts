// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression: the pre-drain stage_state reconciliation must run as BOUNDED,
 * abort-aware chunked UPDATEs — not one unbounded statement over the whole
 * media_item_stage_state table.
 *
 * Before this fix `reconcileProbeStageState` issued two single-shot
 * `UPDATE ... WHERE stage_id = ...` statements BEFORE the heartbeat started, so
 * on a large library a single statement could hold locks long enough to look
 * like a stall (the exact class the Phase 0 backfill was already patched for).
 *
 * We drive the extracted `reconcileProbeStageState` with a recording sql double
 * and assert:
 *   1. Each statement is bounded (`LIMIT ?` with RECONCILE_CHUNK_SIZE) and
 *      keyed on `ctid` (the chunk cursor).
 *   2. A stage that returns a FULL chunk loops again; it stops once a chunk
 *      returns fewer than a full chunk.
 *   3. An already-aborted signal short-circuits before issuing any statement.
 */

import { describe, it, expect } from 'vitest';
import { makeRecordingSql } from '$lib/server/tasks/__testkit__/index.js';
import { reconcileProbeStageState, RECONCILE_CHUNK_SIZE } from '../media-probe.js';

type ReconcileSql = Parameters<typeof reconcileProbeStageState>[0];

describe('media-probe reconcileProbeStageState: bounded chunked UPDATEs', () => {
    it('chunks each stage until a partial chunk drains the backlog', async () => {
        const rec = makeRecordingSql();
        // Phase A: full chunk (loops), then a partial chunk (stops). Phase B:
        // a single empty chunk (nothing to reconcile).
        rec.queueRows([{ count: RECONCILE_CHUNK_SIZE }]);
        rec.queueRows([{ count: 3 }]);
        rec.queueRows([{ count: 0 }]);

        const ac = new AbortController();
        const result = await reconcileProbeStageState(
            rec.sql as unknown as ReconcileSql,
            ac.signal,
        );

        // A looped twice (500 + 3), B ran once (0). Neither phase hit the chunk
        // cap (both drained on a partial/empty chunk), so `capped` is false.
        expect(result).toEqual({
            reconciledA: RECONCILE_CHUNK_SIZE + 3,
            reconciledB: 0,
            capped: false,
        });
        expect(rec.calls).toHaveLength(3);

        // Every statement is bounded + ctid-cursored (never a whole-table UPDATE).
        for (const call of rec.calls) {
            expect(call.query).toContain('media_item_stage_state');
            expect(call.query).toContain('ctid');
            expect(call.query).toContain('LIMIT ?');
            expect(call.values).toContain(RECONCILE_CHUNK_SIZE);
        }

        // First two statements target stage A, the last targets stage B.
        expect(rec.calls[0].query).toContain("'media-probe-a'");
        expect(rec.calls[1].query).toContain("'media-probe-a'");
        expect(rec.calls[2].query).toContain("'media-probe-b'");
    });

    it('short-circuits without issuing any statement when already aborted', async () => {
        const rec = makeRecordingSql();
        const ac = new AbortController();
        ac.abort();

        const result = await reconcileProbeStageState(
            rec.sql as unknown as ReconcileSql,
            ac.signal,
        );

        expect(result).toEqual({ reconciledA: 0, reconciledB: 0, capped: false });
        expect(rec.calls).toHaveLength(0);
    });
});
