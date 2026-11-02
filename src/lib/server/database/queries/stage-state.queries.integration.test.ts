// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    insertPendingRow,
    markRunning,
    markCompleted,
    markFailedTransient,
    markFailedPermanent,
    findRowsByItem,
    deleteRowsForItem,
    upsertRunningRow,
    upsertCompletedRow,
    upsertSkippedPermanentRow,
    reclaimWedgedRunningStageRows,
    recordStageAttemptFailure,
    reEnrollCompletedStageForReset,
    skipItemStage,
    unskipItemStage,
    deferTransientRetryBatch,
} from './stage-state.queries.js';

describe('stage-state queries', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`TRUNCATE media_item_stage_state, stage_version_state CASCADE`;
        await sql`DELETE FROM media_items WHERE title LIKE 'Test %'`;
    });

    it('inserts pending then transitions to running then completed', async () => {
        const itemId = await insertTestMediaItem(sql, 'movie');

        await insertPendingRow(sql, {
            mediaItemId: itemId,
            stageId: 's1',
            processingVersion: 1,
        });
        await markRunning(sql, {
            mediaItemId: itemId,
            stageId: 's1',
            runId: 'a0000000-0000-0000-0000-000000000001',
        });

        let rows = await findRowsByItem(sql, itemId);
        expect(rows[0].status).toBe('running');
        expect(rows[0].started_at).toBeInstanceOf(Date);

        await markCompleted(sql, { mediaItemId: itemId, stageId: 's1' });

        rows = await findRowsByItem(sql, itemId);
        expect(rows[0].status).toBe('completed');
        expect(rows[0].completed_at).toBeInstanceOf(Date);
        expect(rows[0].last_error).toBeNull();
    });

    it('failed_transient sets next_eligible_at and increments attempt', async () => {
        const itemId = await insertTestMediaItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: itemId,
            stageId: 's1',
            processingVersion: 1,
        });
        await markRunning(sql, {
            mediaItemId: itemId,
            stageId: 's1',
            runId: 'a0000000-0000-0000-0000-000000000002',
        });

        await markFailedTransient(sql, {
            mediaItemId: itemId,
            stageId: 's1',
            error: { message: 'boom', retryable: true },
            backoffMs: 60_000,
        });

        const [row] = await findRowsByItem(sql, itemId);
        expect(row.status).toBe('failed_transient');
        expect(row.attempt).toBe(1);
        expect(row.next_eligible_at).toBeInstanceOf(Date);
        expect(row.last_error?.message).toBe('boom');
    });

    it('failed_permanent clears next_eligible_at and writes error', async () => {
        const itemId = await insertTestMediaItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: itemId,
            stageId: 's1',
            processingVersion: 1,
        });
        await markFailedPermanent(sql, {
            mediaItemId: itemId,
            stageId: 's1',
            error: { message: 'hard fail', retryable: false },
        });

        const [row] = await findRowsByItem(sql, itemId);
        expect(row.status).toBe('failed_permanent');
        expect(row.next_eligible_at).toBeNull();
        expect(row.last_error?.retryable).toBe(false);
    });

    it('insertPendingRow with initialStatus skipped_permanent and skippedReason', async () => {
        const itemId = await insertTestMediaItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: itemId,
            stageId: 's1',
            processingVersion: 1,
            initialStatus: 'skipped_permanent',
            skippedReason: 'predicate-false',
        });
        const [row] = await findRowsByItem(sql, itemId);
        expect(row.status).toBe('skipped_permanent');
        expect(row.skipped_reason).toBe('predicate-false');
    });

    it('insertPendingRow is ON CONFLICT DO NOTHING', async () => {
        const itemId = await insertTestMediaItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: itemId,
            stageId: 's1',
            processingVersion: 1,
        });
        await insertPendingRow(sql, {
            mediaItemId: itemId,
            stageId: 's1',
            processingVersion: 5,
        });
        const rows = await findRowsByItem(sql, itemId);
        expect(rows).toHaveLength(1);
        expect(rows[0].processing_version).toBe(1); // first insert wins
    });

    it('upsertRunningRow seeds a fresh row when none exists', async () => {
        // P1-1 regression: the prior wrapper called markRunning which silently
        // no-ops when no row exists. upsertRunningRow must insert the row.
        const itemId = await insertTestMediaItem(sql, 'movie');
        const runId = 'b0000000-0000-0000-0000-000000000001';

        await upsertRunningRow(sql, {
            mediaItemId: itemId,
            stageId: 's-fresh',
            processingVersion: 7,
            runId,
        });

        const rows = await findRowsByItem(sql, itemId);
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('running');
        expect(rows[0].last_run_id).toBe(runId);
        expect(rows[0].processing_version).toBe(7);
        expect(rows[0].started_at).toBeInstanceOf(Date);
    });

    it('upsertRunningRow is idempotent under the same runId', async () => {
        const itemId = await insertTestMediaItem(sql, 'movie');
        const runId = 'b0000000-0000-0000-0000-000000000002';
        await upsertRunningRow(sql, {
            mediaItemId: itemId,
            stageId: 's-idem',
            processingVersion: 1,
            runId,
        });
        const [first] = await findRowsByItem(sql, itemId);
        const firstStartedAt = first.started_at;

        // Re-running under the same runId is a refresh — same row, status stays
        // 'running', last_run_id stays ours.
        await upsertRunningRow(sql, {
            mediaItemId: itemId,
            stageId: 's-idem',
            processingVersion: 1,
            runId,
        });

        const rows = await findRowsByItem(sql, itemId);
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('running');
        expect(rows[0].last_run_id).toBe(runId);
        // started_at updates on every same-run upsert (not the concurrent-run
        // branch) — that's fine; the row reflects the latest claim.
        expect(rows[0].started_at).toBeInstanceOf(Date);
        expect(firstStartedAt).toBeInstanceOf(Date);
    });

    it('upsertRunningRow does not clobber a concurrent run', async () => {
        // P1-4 regression: concurrent BullMQ delivery used to overwrite
        // last_run_id with whatever run dispatched last. The CASE-ON-CONFLICT
        // keeps the first running run's ownership intact.
        const itemId = await insertTestMediaItem(sql, 'movie');
        const runA = 'b0000000-0000-0000-0000-00000000000a';
        const runB = 'b0000000-0000-0000-0000-00000000000b';

        await upsertRunningRow(sql, {
            mediaItemId: itemId,
            stageId: 's-conc',
            processingVersion: 1,
            runId: runA,
        });
        await upsertRunningRow(sql, {
            mediaItemId: itemId,
            stageId: 's-conc',
            processingVersion: 1,
            runId: runB,
        });

        const [row] = await findRowsByItem(sql, itemId);
        expect(row.status).toBe('running');
        expect(row.last_run_id).toBe(runA); // run-A is still the recorded owner
    });

    it('upsertRunningRow transitions a completed row back to running', async () => {
        // When a stage is re-invalidated (file change, metadata change), the
        // row goes back to pending. If a worker picks it up before any
        // markRunning seed, upsertRunningRow must transition it cleanly.
        const itemId = await insertTestMediaItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: itemId,
            stageId: 's-reuse',
            processingVersion: 1,
        });
        await markRunning(sql, {
            mediaItemId: itemId,
            stageId: 's-reuse',
            runId: 'a0000000-0000-0000-0000-000000000099',
        });
        await markCompleted(sql, { mediaItemId: itemId, stageId: 's-reuse' });

        // Now a new run wants to take it.
        const runId = 'b0000000-0000-0000-0000-00000000000c';
        await upsertRunningRow(sql, {
            mediaItemId: itemId,
            stageId: 's-reuse',
            processingVersion: 1,
            runId,
        });
        const [row] = await findRowsByItem(sql, itemId);
        expect(row.status).toBe('running');
        expect(row.last_run_id).toBe(runId);
        expect(row.last_error).toBeNull();
    });

    it('markCompleted with runId does not clobber a concurrent run owner (P1-6)', async () => {
        // Regression: previously markCompleted unconditionally wrote 'completed'.
        // If Run B lost the upsertRunningRow race to Run A and then later
        // finished its inner() faster, Run B's markCompleted would diverge the
        // row from its actual owner. With the runId guard, B's call no-ops.
        const itemId = await insertTestMediaItem(sql, 'movie');
        const runA = 'd0000000-0000-0000-0000-00000000000a';
        const runB = 'd0000000-0000-0000-0000-00000000000b';

        await upsertRunningRow(sql, {
            mediaItemId: itemId,
            stageId: 's-guard',
            processingVersion: 1,
            runId: runA,
        });
        await upsertRunningRow(sql, {
            mediaItemId: itemId,
            stageId: 's-guard',
            processingVersion: 1,
            runId: runB,
        });
        // Run A is the recorded owner (concurrent claim was rejected).

        await sql`UPDATE media_item_stage_state SET skipped_reason='awaiting-file-stability' WHERE media_item_id=${itemId} AND stage_id='s-guard'`;
        // Run B (the loser) tries to mark completed first — should NO-OP.
        await markCompleted(sql, {
            mediaItemId: itemId,
            stageId: 's-guard',
            runId: runB,
        });
        let [row] = await findRowsByItem(sql, itemId);
        expect(row.status).toBe('running');
        expect(row.last_run_id).toBe(runA);
        expect(row.skipped_reason).toBe('awaiting-file-stability');

        // Run A (the actual owner) marks completed — should take effect.
        await markCompleted(sql, {
            mediaItemId: itemId,
            stageId: 's-guard',
            runId: runA,
        });
        [row] = await findRowsByItem(sql, itemId);
        expect(row.status).toBe('completed');
        expect(row.last_run_id).toBe(runA);
        expect(row.skipped_reason).toBeNull();
    });

    it('markFailedTransient with runId no-ops when called by a non-owner run (P1-6)', async () => {
        const itemId = await insertTestMediaItem(sql, 'movie');
        const runA = 'd0000000-0000-0000-0000-00000000010a';
        const runB = 'd0000000-0000-0000-0000-00000000010b';

        await upsertRunningRow(sql, {
            mediaItemId: itemId,
            stageId: 's-fail-guard',
            processingVersion: 1,
            runId: runA,
        });
        await upsertRunningRow(sql, {
            mediaItemId: itemId,
            stageId: 's-fail-guard',
            processingVersion: 1,
            runId: runB,
        });

        await markFailedTransient(sql, {
            mediaItemId: itemId,
            stageId: 's-fail-guard',
            runId: runB,
            error: { message: 'b-failed', retryable: true },
            backoffMs: 10_000,
        });
        const [row] = await findRowsByItem(sql, itemId);
        // Status stays running because Run A is still the owner.
        expect(row.status).toBe('running');
        expect(row.last_run_id).toBe(runA);
        expect(row.attempt).toBe(0);
    });

    it('markCompleted without runId remains idempotent (legacy behavior)', async () => {
        const itemId = await insertTestMediaItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: itemId,
            stageId: 's-legacy',
            processingVersion: 1,
        });
        // Legacy call site (no runId) — should still complete the row.
        await markCompleted(sql, { mediaItemId: itemId, stageId: 's-legacy' });
        const [row] = await findRowsByItem(sql, itemId);
        expect(row.status).toBe('completed');
    });

    it('upsertCompletedRow inserts a completed row when none exists', async () => {
        // P1-3 regression: global-scope tasks (intro-analyzer, music-analysis
        // with the authoritative-stages flag) must write the coverage row
        // themselves because the runner wrapper does not auto-seed for
        // global-scope inputs. Without this, the row stays pending and the
        // task re-processes the item every drain tick.
        const itemId = await insertTestMediaItem(sql, 'movie');

        await upsertCompletedRow(sql, {
            mediaItemId: itemId,
            stageId: 's-upsert-fresh',
            processingVersion: 3,
        });

        const [row] = await findRowsByItem(sql, itemId);
        expect(row.status).toBe('completed');
        expect(row.processing_version).toBe(3);
        expect(row.completed_at).toBeInstanceOf(Date);
        expect(row.last_error).toBeNull();
        expect(row.next_eligible_at).toBeNull();
    });

    it('upsertCompletedRow updates an existing pending row to completed', async () => {
        const itemId = await insertTestMediaItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: itemId,
            stageId: 's-upsert-existing',
            processingVersion: 1,
        });

        await upsertCompletedRow(sql, {
            mediaItemId: itemId,
            stageId: 's-upsert-existing',
            processingVersion: 1,
        });

        const [row] = await findRowsByItem(sql, itemId);
        expect(row.status).toBe('completed');
        expect(row.completed_at).toBeInstanceOf(Date);
    });

    it('upsertCompletedRow takes GREATEST(existing, new) for processing_version', async () => {
        const itemId = await insertTestMediaItem(sql, 'movie');
        // Seed a higher-version pending row.
        await insertPendingRow(sql, {
            mediaItemId: itemId,
            stageId: 's-upsert-version',
            processingVersion: 9,
        });

        // Caller writes a lower version — should NOT downgrade.
        await upsertCompletedRow(sql, {
            mediaItemId: itemId,
            stageId: 's-upsert-version',
            processingVersion: 2,
        });

        const [row] = await findRowsByItem(sql, itemId);
        expect(row.status).toBe('completed');
        expect(row.processing_version).toBe(9);
    });

    it('upsertCompletedRow clears obsolete deferral, last_error and next_eligible_at on update', async () => {
        const itemId = await insertTestMediaItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: itemId,
            stageId: 's-upsert-clear',
            processingVersion: 1,
        });
        await markFailedTransient(sql, {
            mediaItemId: itemId,
            stageId: 's-upsert-clear',
            error: { message: 'past failure', retryable: true },
            backoffMs: 60_000,
        });

        await sql`UPDATE media_item_stage_state SET skipped_reason = 'awaiting-file-stability'
            WHERE media_item_id = ${itemId} AND stage_id = 's-upsert-clear'`;
        expect((await findRowsByItem(sql, itemId))[0].skipped_reason).toBe(
            'awaiting-file-stability',
        );

        await upsertCompletedRow(sql, {
            mediaItemId: itemId,
            stageId: 's-upsert-clear',
            processingVersion: 1,
        });

        const [row] = await findRowsByItem(sql, itemId);
        expect(row.status).toBe('completed');
        expect(row.last_error).toBeNull();
        expect(row.next_eligible_at).toBeNull();
        expect(row.skipped_reason).toBeNull();
    });

    it('upsertCompletedRow is idempotent under repeated calls', async () => {
        const itemId = await insertTestMediaItem(sql, 'movie');
        await upsertCompletedRow(sql, {
            mediaItemId: itemId,
            stageId: 's-upsert-idem',
            processingVersion: 1,
        });
        await upsertCompletedRow(sql, {
            mediaItemId: itemId,
            stageId: 's-upsert-idem',
            processingVersion: 1,
        });
        const rows = await findRowsByItem(sql, itemId);
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('completed');
    });

    it("reclaimWedgedRunningStageRows preserves started_at so wedge rows don't starve behind pending FIFO", async () => {
        // Regression: when a worker dies mid-run, the reaper used to stamp
        // next_eligible_at = now() AND updated_at = now() on recovery. Combined
        // with the sweep's `ORDER BY next_eligible_at ASC NULLS FIRST`, every
        // wedge row sorted behind the entire pending bucket — observed on
        // preprod 2026-05-21–28: 88 trickplay-generation wedges accumulated
        // untouched for a full week behind a 14k pending backlog.
        //
        // Fix: reaper now sets next_eligible_at = NULL (back into the pending
        // bucket) and preserves the original started_at as the row's
        // updated_at so it competes for FIFO position based on when the work
        // first became eligible, not when the wedge happened to be detected.
        const itemId = await insertTestMediaItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: itemId,
            stageId: 'wedge-fix',
            processingVersion: 1,
        });
        // Backdate the row's started_at to 1 hour ago so we can verify it's
        // preserved through the wedge recovery (vs being clobbered with now()).
        const originalStart = new Date(Date.now() - 60 * 60 * 1000);
        await markRunning(sql, {
            mediaItemId: itemId,
            stageId: 'wedge-fix',
            runId: 'a0000000-0000-0000-0000-000000000bad',
        });
        // Force started_at + updated_at into the past so the reaper's age
        // gate (default 10 min) actually fires.
        await sql`
            UPDATE media_item_stage_state
               SET started_at = ${originalStart}, updated_at = ${originalStart}
             WHERE media_item_id = ${itemId}::uuid AND stage_id = 'wedge-fix'
        `;

        // No matching task_history row exists → reaper classifies it as wedged.
        const reclaimed = await reclaimWedgedRunningStageRows(sql);
        expect(reclaimed).toBeGreaterThanOrEqual(1);

        const [row] = await findRowsByItem(sql, itemId);
        expect(row.status).toBe('failed_transient');
        expect(row.last_error?.code).toBe('WEDGED_RUNNING_RECOVERY');
        // Key assertion: next_eligible_at cleared so the row joins the
        // pending FIFO bucket (NULLS FIRST in the sweep ORDER BY).
        expect(row.next_eligible_at).toBeNull();
        // And updated_at preserves the original started_at so the row
        // doesn't lose its rightful FIFO position to fresh pending entries.
        expect(row.updated_at.getTime()).toBe(originalStart.getTime());
    });

    it('deleteRowsForItem removes all rows for an item', async () => {
        const itemId = await insertTestMediaItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: itemId,
            stageId: 's1',
            processingVersion: 1,
        });
        await insertPendingRow(sql, {
            mediaItemId: itemId,
            stageId: 's2',
            processingVersion: 1,
        });

        await deleteRowsForItem(sql, itemId);

        const rows = await findRowsByItem(sql, itemId);
        expect(rows).toEqual([]);
    });

    // bug M1 — media-probe bypasses wrapExecute, so its per-item failure
    // bookkeeping goes through recordStageAttemptFailure instead. The guard is
    // the safety property: it must NOT resurrect a terminal row.
    describe('recordStageAttemptFailure (status-guarded attempt accounting)', () => {
        const ERR = { message: 'ffprobe boom', code: 'probe_failed', retryable: true };

        it('flips a pending row to failed_transient: increments attempt, sets last_error + backoff', async () => {
            const itemId = await insertTestMediaItem(sql, 'movie');
            await insertPendingRow(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                processingVersion: 1,
            });

            const updated = await recordStageAttemptFailure(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                error: ERR,
                backoffMs: 30 * 60 * 1000,
            });

            expect(updated).toBe(1);
            const [row] = await findRowsByItem(sql, itemId);
            expect(row.status).toBe('failed_transient');
            expect(row.attempt).toBe(1);
            expect(row.last_error).toMatchObject({ code: 'probe_failed' });
            expect(row.next_eligible_at).toBeInstanceOf(Date);
            expect((row.next_eligible_at as Date).getTime()).toBeGreaterThan(Date.now());
        });

        it('also transitions running and failed_transient rows, bumping attempt each time', async () => {
            const itemId = await insertTestMediaItem(sql, 'movie');
            await insertPendingRow(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                processingVersion: 1,
            });
            await markRunning(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                runId: 'a0000000-0000-0000-0000-0000000000aa',
            });

            // running → failed_transient (attempt 1)
            expect(
                await recordStageAttemptFailure(sql, {
                    mediaItemId: itemId,
                    stageId: 's1',
                    error: ERR,
                    backoffMs: 1000,
                }),
            ).toBe(1);
            // failed_transient → failed_transient (attempt 2)
            expect(
                await recordStageAttemptFailure(sql, {
                    mediaItemId: itemId,
                    stageId: 's1',
                    error: ERR,
                    backoffMs: 1000,
                }),
            ).toBe(1);

            const [row] = await findRowsByItem(sql, itemId);
            expect(row.status).toBe('failed_transient');
            expect(row.attempt).toBe(2);
        });

        it('does NOT touch a completed row (no clobber)', async () => {
            const itemId = await insertTestMediaItem(sql, 'movie');
            await insertPendingRow(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                processingVersion: 1,
            });
            await markCompleted(sql, { mediaItemId: itemId, stageId: 's1' });

            const updated = await recordStageAttemptFailure(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                error: ERR,
                backoffMs: 1000,
            });

            expect(updated).toBe(0);
            const [row] = await findRowsByItem(sql, itemId);
            expect(row.status).toBe('completed');
        });

        it('does NOT resurrect a skipped_permanent row (heal rail owns that)', async () => {
            const itemId = await insertTestMediaItem(sql, 'movie');
            await insertPendingRow(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                processingVersion: 1,
            });
            await sql`
                UPDATE media_item_stage_state
                   SET status = 'skipped_permanent', skipped_reason = 'ineligible'
                 WHERE media_item_id = ${itemId}::uuid AND stage_id = 's1'
            `;

            const updated = await recordStageAttemptFailure(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                error: ERR,
                backoffMs: 1000,
            });

            expect(updated).toBe(0);
            const [row] = await findRowsByItem(sql, itemId);
            expect(row.status).toBe('skipped_permanent');
        });

        it('does NOT touch a failed_permanent row, and is a no-op on an absent row', async () => {
            const itemId = await insertTestMediaItem(sql, 'movie');
            await insertPendingRow(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                processingVersion: 1,
            });
            await markFailedPermanent(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                error: { message: 'dead', code: 'x', retryable: false },
            });

            expect(
                await recordStageAttemptFailure(sql, {
                    mediaItemId: itemId,
                    stageId: 's1',
                    error: ERR,
                    backoffMs: 1000,
                }),
            ).toBe(0);
            // absent (media_item_id, stage_id) pair → 0 rows, no throw
            expect(
                await recordStageAttemptFailure(sql, {
                    mediaItemId: itemId,
                    stageId: 'does-not-exist',
                    error: ERR,
                    backoffMs: 1000,
                }),
            ).toBe(0);

            const [row] = await findRowsByItem(sql, itemId);
            expect(row.status).toBe('failed_permanent');
        });

        it('with maxAttempts: stays failed_transient below the cap, sets backoff', async () => {
            const itemId = await insertTestMediaItem(sql, 'movie');
            await insertPendingRow(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                processingVersion: 1,
            });

            // attempt 1 of cap 3 → still transient, retryable.
            await recordStageAttemptFailure(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                error: ERR,
                backoffMs: 1000,
                maxAttempts: 3,
            });
            const [row] = await findRowsByItem(sql, itemId);
            expect(row.status).toBe('failed_transient');
            expect(row.attempt).toBe(1);
            expect(row.next_eligible_at).toBeInstanceOf(Date);
        });

        it('with maxAttempts: promotes to failed_permanent at the cap and clears next_eligible_at (give up)', async () => {
            const itemId = await insertTestMediaItem(sql, 'movie');
            await insertPendingRow(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                processingVersion: 1,
            });

            // Cap 3: attempts 1, 2 transient; attempt 3 reaches the cap → permanent.
            await recordStageAttemptFailure(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                error: ERR,
                backoffMs: 1000,
                maxAttempts: 3,
            });
            await recordStageAttemptFailure(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                error: ERR,
                backoffMs: 1000,
                maxAttempts: 3,
            });
            let [row] = await findRowsByItem(sql, itemId);
            expect(row.status).toBe('failed_transient');
            expect(row.attempt).toBe(2);

            const updated = await recordStageAttemptFailure(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                error: ERR,
                backoffMs: 1000,
                maxAttempts: 3,
            });
            expect(updated).toBe(1);
            [row] = await findRowsByItem(sql, itemId);
            expect(row.status).toBe('failed_permanent');
            expect(row.attempt).toBe(3);
            expect(row.next_eligible_at).toBeNull(); // no further retry scheduled

            // And once permanent, the status guard means further calls are no-ops.
            expect(
                await recordStageAttemptFailure(sql, {
                    mediaItemId: itemId,
                    stageId: 's1',
                    error: ERR,
                    backoffMs: 1000,
                    maxAttempts: 3,
                }),
            ).toBe(0);
        });

        it('coerces a malformed maxAttempts (NaN / 0 / negative) to no-cap rather than silently looping', async () => {
            const itemId = await insertTestMediaItem(sql, 'movie');
            await insertPendingRow(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                processingVersion: 1,
            });

            // NaN would make `attempt + 1 >= NaN` always false in SQL — coerced to
            // null, so the row stays transient (legacy behavior), never wrongly
            // promoting AND never being a silently-disabled cap.
            for (const bad of [Number.NaN, 0, -1]) {
                await recordStageAttemptFailure(sql, {
                    mediaItemId: itemId,
                    stageId: 's1',
                    error: ERR,
                    backoffMs: 1000,
                    maxAttempts: bad,
                });
                const [row] = await findRowsByItem(sql, itemId);
                expect(row.status).toBe('failed_transient');
                expect(row.next_eligible_at).toBeInstanceOf(Date);
            }
        });
    });

    describe('skipItemStage (operator give-up)', () => {
        const ERR = { message: 'ffprobe timeout', code: 'probe_failed', retryable: true };

        it('flips a failed_transient row to skipped_permanent with the reason, clears backoff, preserves last_error', async () => {
            const itemId = await insertTestMediaItem(sql, 'movie');
            await insertPendingRow(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                processingVersion: 1,
            });
            await recordStageAttemptFailure(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                error: ERR,
                backoffMs: 1000,
            });

            const skipped = await skipItemStage(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                skippedReason: 'operator-gave-up',
            });

            expect(skipped).toBe(1);
            const [row] = await findRowsByItem(sql, itemId);
            expect(row.status).toBe('skipped_permanent');
            expect(row.skipped_reason).toBe('operator-gave-up');
            // last_error is preserved (not nulled) so an operator who later
            // un-ignores this row via unskipItemStage still sees why it was
            // failing before deciding whether to retry it.
            expect(row.last_error).toEqual(ERR);
            expect(row.next_eligible_at).toBeNull();
        });

        it('also gives up a failed_permanent row (regardless of retryable flag)', async () => {
            const itemId = await insertTestMediaItem(sql, 'movie');
            await insertPendingRow(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                processingVersion: 1,
            });
            await markFailedPermanent(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                error: { message: 'dead', code: 'x', retryable: true },
            });

            expect(
                await skipItemStage(sql, {
                    mediaItemId: itemId,
                    stageId: 's1',
                    skippedReason: 'operator-gave-up',
                }),
            ).toBe(1);
            const [row] = await findRowsByItem(sql, itemId);
            expect(row.status).toBe('skipped_permanent');
        });

        it('does NOT touch a completed or running row, and is a no-op when absent', async () => {
            const itemId = await insertTestMediaItem(sql, 'movie');
            await insertPendingRow(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                processingVersion: 1,
            });
            await markCompleted(sql, { mediaItemId: itemId, stageId: 's1' });

            expect(
                await skipItemStage(sql, {
                    mediaItemId: itemId,
                    stageId: 's1',
                    skippedReason: 'operator-gave-up',
                }),
            ).toBe(0);
            expect(
                await skipItemStage(sql, {
                    mediaItemId: itemId,
                    stageId: 'does-not-exist',
                    skippedReason: 'operator-gave-up',
                }),
            ).toBe(0);
            const [row] = await findRowsByItem(sql, itemId);
            expect(row.status).toBe('completed');
        });
    });

    describe('unskipItemStage (operator un-ignore)', () => {
        // Local fixture: the `ERR` at the top of the skipItemStage block is
        // scoped to that describe, so this block needs its own.
        const ERR = { message: 'ffprobe boom', code: 'probe_failed', retryable: true };

        it('restores a skipped_permanent row to pending, clearing skipped_reason, keeping last_error', async () => {
            const itemId = await insertTestMediaItem(sql, 'movie');
            await insertPendingRow(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                processingVersion: 1,
            });
            await recordStageAttemptFailure(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                error: ERR,
                backoffMs: 1000,
            });
            await skipItemStage(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                skippedReason: 'operator-gave-up',
            });

            const restored = await unskipItemStage(sql, { mediaItemId: itemId, stageId: 's1' });

            expect(restored).toBe(1);
            const [row] = await findRowsByItem(sql, itemId);
            expect(row.status).toBe('pending');
            expect(row.skipped_reason).toBeNull();
            expect(row.next_eligible_at).toBeNull();
            // The failure history that explained why the row was skipped stays
            // visible after the restore.
            expect(row.last_error).toEqual(ERR);
        });

        it('is a no-op on a non-skipped_permanent row or an absent one', async () => {
            const itemId = await insertTestMediaItem(sql, 'movie');
            await insertPendingRow(sql, {
                mediaItemId: itemId,
                stageId: 's1',
                processingVersion: 1,
            });

            expect(await unskipItemStage(sql, { mediaItemId: itemId, stageId: 's1' })).toBe(0);
            expect(
                await unskipItemStage(sql, { mediaItemId: itemId, stageId: 'does-not-exist' }),
            ).toBe(0);
            const [row] = await findRowsByItem(sql, itemId);
            expect(row.status).toBe('pending');
        });
    });
});

describe('reEnrollCompletedStageForReset', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`TRUNCATE media_item_stage_state, stage_version_state CASCADE`;
        await sql`DELETE FROM media_items WHERE title LIKE 'Test %'`;
    });

    it('flips completed → pending and resets attempt/timing/error', async () => {
        const itemId = await insertTestMediaItem(sql, 'movie');
        await upsertCompletedRow(sql, {
            mediaItemId: itemId,
            stageId: 'library-embeddings',
            processingVersion: 1,
        });
        // Dirty the fields the reset must clear.
        await sql`
            UPDATE media_item_stage_state
               SET attempt = 4, last_error = ${sql.json({ message: 'old' })}, started_at = now()
             WHERE media_item_id = ${itemId}::uuid AND stage_id = 'library-embeddings'
        `;

        const reset = await reEnrollCompletedStageForReset(sql, 'library-embeddings');
        expect(reset).toBe(1);

        const [row] = await findRowsByItem(sql, itemId);
        expect(row.status).toBe('pending');
        expect(row.attempt).toBe(0);
        expect(row.last_error).toBeNull();
        expect(row.started_at).toBeNull();
        expect(row.completed_at).toBeNull();
        expect(row.next_eligible_at).toBeInstanceOf(Date);
    });

    it('leaves skipped_permanent and failed rows untouched', async () => {
        const skippedItem = await insertTestMediaItem(sql, 'movie');
        await upsertSkippedPermanentRow(sql, {
            mediaItemId: skippedItem,
            stageId: 'library-embeddings',
            processingVersion: 1,
            skippedReason: 'no-overview',
        });
        const failedItem = await insertTestMediaItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: failedItem,
            stageId: 'library-embeddings',
            processingVersion: 1,
        });
        await markFailedPermanent(sql, {
            mediaItemId: failedItem,
            stageId: 'library-embeddings',
            error: { message: 'dead', code: 'x', retryable: false },
        });

        const reset = await reEnrollCompletedStageForReset(sql, 'library-embeddings');
        expect(reset).toBe(0);

        expect((await findRowsByItem(sql, skippedItem))[0].status).toBe('skipped_permanent');
        expect((await findRowsByItem(sql, failedItem))[0].status).toBe('failed_permanent');
    });

    it('is scoped to the given stage only', async () => {
        const itemId = await insertTestMediaItem(sql, 'movie');
        await upsertCompletedRow(sql, {
            mediaItemId: itemId,
            stageId: 'library-embeddings',
            processingVersion: 1,
        });
        await upsertCompletedRow(sql, {
            mediaItemId: itemId,
            stageId: 'discovery-embeddings',
            processingVersion: 1,
        });

        const reset = await reEnrollCompletedStageForReset(sql, 'library-embeddings');
        expect(reset).toBe(1);

        const rows = await findRowsByItem(sql, itemId);
        const byStage = Object.fromEntries(rows.map((r) => [r.stage_id, r.status]));
        expect(byStage['library-embeddings']).toBe('pending');
        expect(byStage['discovery-embeddings']).toBe('completed');
    });
});

async function insertTestMediaItem(sql: postgres.Sql, mediaType: string): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, media_type, title)
        VALUES (${id}::uuid, ${mediaType}, ${'Test ' + id.slice(0, 6)})
    `;
    return id;
}

// =============================================================================
// deferTransientRetryBatch
// =============================================================================

describe('deferTransientRetryBatch', () => {
    let sql: postgres.Sql;
    const STAGE = `defer-test-${Math.random().toString(36).slice(2, 10)}`;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`TRUNCATE media_item_stage_state, stage_version_state CASCADE`;
        await sql`DELETE FROM media_items WHERE title LIKE 'Test %'`;
    });

    it('pushes next_eligible_at forward for pending and completed rows', async () => {
        const pendingId = await insertTestMediaItem(sql, 'movie');
        const completedId = await insertTestMediaItem(sql, 'movie');

        await insertPendingRow(sql, {
            mediaItemId: pendingId,
            stageId: STAGE,
            processingVersion: 1,
        });
        await upsertCompletedRow(sql, {
            mediaItemId: completedId,
            stageId: STAGE,
            processingVersion: 1,
        });

        const retryAfterMs = 30 * 60 * 1000; // 30 min
        const before = Date.now();
        const count = await deferTransientRetryBatch(sql, {
            stageId: STAGE,
            mediaItemIds: [pendingId, completedId],
            retryAfterMs,
        });
        expect(count).toBe(2);

        for (const itemId of [pendingId, completedId]) {
            const [row] = await findRowsByItem(sql, itemId);
            // next_eligible_at must be set and >= now + retryAfterMs (with 5s slop for test speed).
            expect(row.next_eligible_at).toBeInstanceOf(Date);
            expect((row.next_eligible_at as Date).getTime()).toBeGreaterThan(
                before + retryAfterMs - 5_000,
            );
            // Status must be unchanged.
        }

        const [pendingRow] = await findRowsByItem(sql, pendingId);
        const [completedRow] = await findRowsByItem(sql, completedId);
        expect(pendingRow.status).toBe('pending');
        expect(completedRow.status).toBe('completed');
    });

    it('does NOT defer running or failed_permanent rows (status guard)', async () => {
        const runningId = await insertTestMediaItem(sql, 'movie');
        const permanentId = await insertTestMediaItem(sql, 'movie');

        await insertPendingRow(sql, {
            mediaItemId: runningId,
            stageId: STAGE,
            processingVersion: 1,
        });
        await markRunning(sql, {
            mediaItemId: runningId,
            stageId: STAGE,
            runId: 'c0000000-0000-0000-0000-000000000001',
        });

        await insertPendingRow(sql, {
            mediaItemId: permanentId,
            stageId: STAGE,
            processingVersion: 1,
        });
        await markFailedPermanent(sql, {
            mediaItemId: permanentId,
            stageId: STAGE,
            error: { message: 'dead', retryable: false },
        });

        const count = await deferTransientRetryBatch(sql, {
            stageId: STAGE,
            mediaItemIds: [runningId, permanentId],
            retryAfterMs: 60_000,
        });
        expect(count).toBe(0);

        const [runningRow] = await findRowsByItem(sql, runningId);
        const [permanentRow] = await findRowsByItem(sql, permanentId);
        expect(runningRow.next_eligible_at).toBeNull();
        expect(permanentRow.next_eligible_at).toBeNull();
    });

    it('defers failed_transient rows (eligible status)', async () => {
        const itemId = await insertTestMediaItem(sql, 'movie');
        await insertPendingRow(sql, { mediaItemId: itemId, stageId: STAGE, processingVersion: 1 });
        await markFailedTransient(sql, {
            mediaItemId: itemId,
            stageId: STAGE,
            error: { message: 'transient', retryable: true },
            backoffMs: 0,
        });

        const count = await deferTransientRetryBatch(sql, {
            stageId: STAGE,
            mediaItemIds: [itemId],
            retryAfterMs: 10_000,
        });
        expect(count).toBe(1);

        const [row] = await findRowsByItem(sql, itemId);
        expect(row.status).toBe('failed_transient');
        expect(row.next_eligible_at).toBeInstanceOf(Date);
    });

    it('returns 0 immediately when mediaItemIds is empty (short-circuit)', async () => {
        const count = await deferTransientRetryBatch(sql, {
            stageId: STAGE,
            mediaItemIds: [],
            retryAfterMs: 60_000,
        });
        expect(count).toBe(0);
    });

    it('is a no-op for item ids that have no stage row for this stageId', async () => {
        const itemId = await insertTestMediaItem(sql, 'movie');
        // No stage row inserted for STAGE.
        const count = await deferTransientRetryBatch(sql, {
            stageId: STAGE,
            mediaItemIds: [itemId],
            retryAfterMs: 60_000,
        });
        expect(count).toBe(0);
    });
});
