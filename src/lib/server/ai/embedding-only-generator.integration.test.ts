// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * embedding-only-generator drift reconciliation integration test.
 *
 * Verifies that when `candidateSource` returns items the downstream legacy
 * SQL predicate then drops (e.g. discovery items lacking `media_file_items`
 * when `target=library`), the generator marks those rows
 * `skipped_transient` with a retry window — instead of leaving them
 * `pending` to be re-fetched on every sweep tick.
 *
 * Two paths are covered:
 *   1. Empty-fetch path: every candidate gets dropped by the legacy fetch
 *      predicate (totalCount === 0), the early-return branch reconciles.
 *   2. (Future) Partial-fetch path: some candidates make it through, some
 *      don't. The current test doesn't exercise this because the embedding
 *      generation requires OpenAI which we can't reach from integration
 *      tests; the unit-level batch helper test covers that contract.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../tests/integration/fixtures/index.js';
import { generateEmbeddingsFromDB } from './embedding-only-generator.js';
import { EMBEDDING_SOURCE } from '../utils/embedding-source.js';

const STAGE_ID = 'library-embeddings';

async function insertCoverageRow(
    sql: postgres.Sql,
    mediaItemId: string,
    status: string,
): Promise<void> {
    await sql`
        INSERT INTO media_item_stage_state (
            media_item_id, stage_id, processing_version, status, updated_at
        ) VALUES (
            ${mediaItemId}::uuid, ${STAGE_ID}, 1, ${status}, now()
        )
        ON CONFLICT (media_item_id, stage_id) DO UPDATE
            SET status = EXCLUDED.status, updated_at = now()
    `;
}

async function getCoverageRow(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<
    | {
          status: string;
          skipped_reason: string | null;
          next_eligible_at: Date | null;
      }
    | undefined
> {
    const [row] = await sql<
        Array<{
            status: string;
            skipped_reason: string | null;
            next_eligible_at: Date | null;
        }>
    >`
        SELECT status, skipped_reason, next_eligible_at
        FROM media_item_stage_state
        WHERE media_item_id = ${mediaItemId}::uuid AND stage_id = ${STAGE_ID}
    `;
    return row;
}

describe('generateEmbeddingsFromDB drift reconciliation', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`TRUNCATE media_item_stage_state, media_embeddings, media_file_items, media_files, media_items, external_ids CASCADE`;
    });

    it('marks pending candidates as skipped_permanent when the legacy filter drops them all', async () => {
        // Two items: both `active`, neither has files (no `media_file_items`).
        // target=library requires AVAILABILITY_EXISTS, so both get dropped by
        // the fetch query — totalCount === 0 path.
        const a = createTestMediaItem({
            media_type: 'movie',
            title: 'Drift Reconcile A',
        });
        const b = createTestMediaItem({
            media_type: 'movie',
            title: 'Drift Reconcile B',
        });
        await insertTestMediaItem(sql, a);
        await insertTestMediaItem(sql, b);

        await insertCoverageRow(sql, a.id, 'pending');
        await insertCoverageRow(sql, b.id, 'pending');

        await generateEmbeddingsFromDB({
            target: EMBEDDING_SOURCE.LIBRARY,
            batchSize: 10,
            candidateSource: async (_sql, _limit) => [{ id: a.id }, { id: b.id }],
            stageId: STAGE_ID,
        });

        const rowA = await getCoverageRow(sql, a.id);
        const rowB = await getCoverageRow(sql, b.id);
        // Empty-fetch drift reconciliation now escalates to skipped_permanent
        // (markSkippedPermanentBatch) so the rows stop cycling on every drain
        // tick; re-eligibility flows via event-driven invalidation instead of a
        // transient retry window. So next_eligible_at is null, not a future Date.
        expect(rowA?.status).toBe('skipped_permanent');
        expect(rowA?.skipped_reason).toBe('ineligible-by-legacy-filter');
        expect(rowA?.next_eligible_at).toBeNull();
        expect(rowB?.status).toBe('skipped_permanent');
    });

    it('does NOT touch a completed row when reconciling drift', async () => {
        // Completed row must NOT be flipped back to skipped_transient.
        const a = createTestMediaItem({
            media_type: 'movie',
            title: 'Drift Reconcile Completed',
        });
        await insertTestMediaItem(sql, a);
        await insertCoverageRow(sql, a.id, 'completed');

        await generateEmbeddingsFromDB({
            target: EMBEDDING_SOURCE.LIBRARY,
            batchSize: 10,
            candidateSource: async (_sql, _limit) => [{ id: a.id }],
            stageId: STAGE_ID,
        });

        const row = await getCoverageRow(sql, a.id);
        expect(row?.status).toBe('completed');
    });

    it('is a no-op when stageId is not provided (caller opted out of reconciliation)', async () => {
        const a = createTestMediaItem({
            media_type: 'movie',
            title: 'Drift Reconcile NoStage',
        });
        await insertTestMediaItem(sql, a);
        await insertCoverageRow(sql, a.id, 'pending');

        await generateEmbeddingsFromDB({
            target: EMBEDDING_SOURCE.LIBRARY,
            batchSize: 10,
            candidateSource: async (_sql, _limit) => [{ id: a.id }],
            // No stageId — reconciliation is gated on its presence.
        });

        const row = await getCoverageRow(sql, a.id);
        // Without stageId the row stays pending (drift) — proves the gate works.
        expect(row?.status).toBe('pending');
    });
});
