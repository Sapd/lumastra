// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the batch stage-state query helpers introduced in
 * Phase 3.2 (bug #6): markFailedPermanentBatch and markCompletedBatch.
 *
 * These helpers are used by sweep-style tasks (e.g. integrity-scanner) that
 * classify many items in a single pass rather than one item at a time.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    insertPendingRow,
    markFailedPermanentBatch,
    markCompletedBatch,
    markSkippedTransientBatch,
    findRowsByItem,
} from './stage-state.queries.js';

const STAGE = 'integrity-file-present';

describe('markFailedPermanentBatch', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`TRUNCATE media_item_stage_state, stage_version_state CASCADE`;
        await sql`DELETE FROM media_items WHERE title LIKE 'batch-test-%'`;
    });

    it('returns 0 and is a no-op for an empty input array', async () => {
        const count = await markFailedPermanentBatch(sql, {
            stageId: STAGE,
            mediaItemIds: [],
            error: {
                code: 'file-missing',
                message: 'Default file unreachable',
                retryable: false,
            },
        });
        expect(count).toBe(0);
    });

    it('marks all pending rows failed_permanent with correct error shape', async () => {
        const id1 = await insertBatchTestItem(sql, 'movie');
        const id2 = await insertBatchTestItem(sql, 'episode');
        await insertPendingRow(sql, {
            mediaItemId: id1,
            stageId: STAGE,
            processingVersion: 1,
        });
        await insertPendingRow(sql, {
            mediaItemId: id2,
            stageId: STAGE,
            processingVersion: 1,
        });

        const count = await markFailedPermanentBatch(sql, {
            stageId: STAGE,
            mediaItemIds: [id1, id2],
            error: {
                code: 'file-missing',
                message: 'Default file unreachable',
                retryable: false,
            },
        });

        expect(count).toBe(2);

        const [row1] = await findRowsByItem(sql, id1);
        expect(row1.status).toBe('failed_permanent');
        expect(row1.last_error?.code).toBe('file-missing');
        expect(row1.last_error?.retryable).toBe(false);
        expect(row1.next_eligible_at).toBeNull();

        const [row2] = await findRowsByItem(sql, id2);
        expect(row2.status).toBe('failed_permanent');
    });

    it('only affects rows matching the given stage_id', async () => {
        const id = await insertBatchTestItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: id,
            stageId: 'other-stage',
            processingVersion: 1,
        });
        await insertPendingRow(sql, {
            mediaItemId: id,
            stageId: STAGE,
            processingVersion: 1,
        });

        await markFailedPermanentBatch(sql, {
            stageId: STAGE,
            mediaItemIds: [id],
            error: {
                code: 'file-missing',
                message: 'Default file unreachable',
                retryable: false,
            },
        });

        const rows = await findRowsByItem(sql, id);
        const otherRow = rows.find((r) => r.stage_id === 'other-stage');
        const stageRow = rows.find((r) => r.stage_id === STAGE);

        expect(otherRow?.status).toBe('pending');
        expect(stageRow?.status).toBe('failed_permanent');
    });

    it('updates an already-failed_permanent row with fresh error', async () => {
        const id = await insertBatchTestItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: id,
            stageId: STAGE,
            processingVersion: 1,
        });

        await markFailedPermanentBatch(sql, {
            stageId: STAGE,
            mediaItemIds: [id],
            error: {
                code: 'file-missing',
                message: 'first run',
                retryable: false,
            },
        });

        const count = await markFailedPermanentBatch(sql, {
            stageId: STAGE,
            mediaItemIds: [id],
            error: {
                code: 'file-missing',
                message: 'second run',
                retryable: false,
            },
        });

        // Row already failed_permanent — updated_at changes so row is returned.
        expect(count).toBe(1);
        const [row] = await findRowsByItem(sql, id);
        expect(row.last_error?.message).toBe('second run');
    });
});

describe('markCompletedBatch', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`TRUNCATE media_item_stage_state, stage_version_state CASCADE`;
        await sql`DELETE FROM media_items WHERE title LIKE 'batch-test-%'`;
    });

    it('returns 0 and is a no-op for an empty input array', async () => {
        const count = await markCompletedBatch(sql, {
            stageId: STAGE,
            mediaItemIds: [],
        });
        expect(count).toBe(0);
    });

    it('marks all pending rows completed with completed_at set', async () => {
        const id1 = await insertBatchTestItem(sql, 'movie');
        const id2 = await insertBatchTestItem(sql, 'episode');
        await insertPendingRow(sql, {
            mediaItemId: id1,
            stageId: STAGE,
            processingVersion: 1,
        });
        await insertPendingRow(sql, {
            mediaItemId: id2,
            stageId: STAGE,
            processingVersion: 1,
        });

        const count = await markCompletedBatch(sql, {
            stageId: STAGE,
            mediaItemIds: [id1, id2],
        });

        expect(count).toBe(2);

        const [row1] = await findRowsByItem(sql, id1);
        expect(row1.status).toBe('completed');
        expect(row1.completed_at).toBeInstanceOf(Date);
        expect(row1.last_error).toBeNull();
        expect(row1.next_eligible_at).toBeNull();
    });

    it('skips rows already completed (no re-write)', async () => {
        const id = await insertBatchTestItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: id,
            stageId: STAGE,
            processingVersion: 1,
        });

        await markCompletedBatch(sql, { stageId: STAGE, mediaItemIds: [id] });

        // Second call — row is already completed, no-op for that row.
        const count = await markCompletedBatch(sql, {
            stageId: STAGE,
            mediaItemIds: [id],
        });
        expect(count).toBe(0);
    });

    it('transitions a failed_permanent row to completed (file restored)', async () => {
        const id = await insertBatchTestItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: id,
            stageId: STAGE,
            processingVersion: 1,
        });
        await markFailedPermanentBatch(sql, {
            stageId: STAGE,
            mediaItemIds: [id],
            error: { code: 'file-missing', message: 'gone', retryable: false },
        });

        const count = await markCompletedBatch(sql, {
            stageId: STAGE,
            mediaItemIds: [id],
        });

        expect(count).toBe(1);
        const [row] = await findRowsByItem(sql, id);
        expect(row.status).toBe('completed');
        expect(row.last_error).toBeNull();
    });
});

describe('markSkippedTransientBatch', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`TRUNCATE media_item_stage_state, stage_version_state CASCADE`;
        await sql`DELETE FROM media_items WHERE title LIKE 'batch-test-%'`;
    });

    it('returns 0 and is a no-op for an empty input array', async () => {
        const count = await markSkippedTransientBatch(sql, {
            stageId: STAGE,
            mediaItemIds: [],
            skippedReason: 'ineligible-by-legacy-filter',
            retryAfterMs: 6 * 60 * 60 * 1000,
        });
        expect(count).toBe(0);
    });

    it('marks pending rows as skipped_transient with a retry window', async () => {
        const id1 = await insertBatchTestItem(sql, 'movie');
        const id2 = await insertBatchTestItem(sql, 'episode');
        await insertPendingRow(sql, {
            mediaItemId: id1,
            stageId: STAGE,
            processingVersion: 1,
        });
        await insertPendingRow(sql, {
            mediaItemId: id2,
            stageId: STAGE,
            processingVersion: 1,
        });

        const before = Date.now();
        const count = await markSkippedTransientBatch(sql, {
            stageId: STAGE,
            mediaItemIds: [id1, id2],
            skippedReason: 'ineligible-by-legacy-filter',
            retryAfterMs: 6 * 60 * 60 * 1000,
        });

        expect(count).toBe(2);

        const [row1] = await findRowsByItem(sql, id1);
        expect(row1.status).toBe('skipped_transient');
        expect(row1.skipped_reason).toBe('ineligible-by-legacy-filter');
        expect(row1.next_eligible_at).toBeInstanceOf(Date);
        // Should be roughly 6h in the future (allow 5 minute slack for test latency).
        const sixHoursMs = 6 * 60 * 60 * 1000;
        const delta = row1.next_eligible_at!.getTime() - before;
        expect(delta).toBeGreaterThan(sixHoursMs - 5 * 60 * 1000);
        expect(delta).toBeLessThan(sixHoursMs + 5 * 60 * 1000);
    });

    it('only touches rows in allowed statuses (pending/failed_transient/skipped_transient)', async () => {
        // pending → eligible
        const idPending = await insertBatchTestItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: idPending,
            stageId: STAGE,
            processingVersion: 1,
        });

        // completed → must NOT be clobbered
        const idCompleted = await insertBatchTestItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: idCompleted,
            stageId: STAGE,
            processingVersion: 1,
        });
        await markCompletedBatch(sql, {
            stageId: STAGE,
            mediaItemIds: [idCompleted],
        });

        // failed_permanent → must NOT be clobbered
        const idFailedPerm = await insertBatchTestItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: idFailedPerm,
            stageId: STAGE,
            processingVersion: 1,
        });
        await markFailedPermanentBatch(sql, {
            stageId: STAGE,
            mediaItemIds: [idFailedPerm],
            error: { code: 'gone', message: 'gone', retryable: false },
        });

        // running → must NOT be clobbered
        const idRunning = await insertBatchTestItem(sql, 'movie');
        await sql`
            INSERT INTO media_item_stage_state (media_item_id, stage_id, processing_version, status, last_run_id)
            VALUES (${idRunning}::uuid, ${STAGE}, 1, 'running', 'fake-run-id')
        `;

        const count = await markSkippedTransientBatch(sql, {
            stageId: STAGE,
            mediaItemIds: [idPending, idCompleted, idFailedPerm, idRunning],
            skippedReason: 'ineligible-by-legacy-filter',
            retryAfterMs: 6 * 60 * 60 * 1000,
        });

        // Only the pending row should be touched.
        expect(count).toBe(1);

        const [pendingRow] = await findRowsByItem(sql, idPending);
        expect(pendingRow.status).toBe('skipped_transient');

        const [completedRow] = await findRowsByItem(sql, idCompleted);
        expect(completedRow.status).toBe('completed');

        const [failedPermRow] = await findRowsByItem(sql, idFailedPerm);
        expect(failedPermRow.status).toBe('failed_permanent');

        const [runningRow] = await findRowsByItem(sql, idRunning);
        expect(runningRow.status).toBe('running');
    });

    it('is idempotent — calling twice keeps the row skipped_transient', async () => {
        const id = await insertBatchTestItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: id,
            stageId: STAGE,
            processingVersion: 1,
        });

        const count1 = await markSkippedTransientBatch(sql, {
            stageId: STAGE,
            mediaItemIds: [id],
            skippedReason: 'ineligible-by-legacy-filter',
            retryAfterMs: 6 * 60 * 60 * 1000,
        });
        expect(count1).toBe(1);

        const count2 = await markSkippedTransientBatch(sql, {
            stageId: STAGE,
            mediaItemIds: [id],
            skippedReason: 'ineligible-by-legacy-filter',
            retryAfterMs: 6 * 60 * 60 * 1000,
        });
        // skipped_transient is in the allowed status set, so the row is
        // touched again — bump of next_eligible_at is by design.
        expect(count2).toBe(1);

        const [row] = await findRowsByItem(sql, id);
        expect(row.status).toBe('skipped_transient');
    });

    it('only affects rows matching the given stage_id', async () => {
        const id = await insertBatchTestItem(sql, 'movie');
        await insertPendingRow(sql, {
            mediaItemId: id,
            stageId: 'other-stage',
            processingVersion: 1,
        });
        await insertPendingRow(sql, {
            mediaItemId: id,
            stageId: STAGE,
            processingVersion: 1,
        });

        await markSkippedTransientBatch(sql, {
            stageId: STAGE,
            mediaItemIds: [id],
            skippedReason: 'ineligible-by-legacy-filter',
            retryAfterMs: 6 * 60 * 60 * 1000,
        });

        const rows = await findRowsByItem(sql, id);
        const otherRow = rows.find((r) => r.stage_id === 'other-stage');
        const stageRow = rows.find((r) => r.stage_id === STAGE);

        expect(otherRow?.status).toBe('pending');
        expect(stageRow?.status).toBe('skipped_transient');
    });
});

async function insertBatchTestItem(sql: postgres.Sql, mediaType: string): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, media_type, title)
        VALUES (${id}::uuid, ${mediaType}, ${'batch-test-' + id.slice(0, 6)})
    `;
    return id;
}
