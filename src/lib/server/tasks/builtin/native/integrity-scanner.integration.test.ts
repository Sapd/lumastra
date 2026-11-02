// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the integrity-scanner stage-state sweep (Phase 3.2).
 *
 * Exercises the end-to-end path from file state in `media_files` through to
 * `media_item_stage_state` rows being written as `failed_permanent` (missing)
 * or `completed` (present). Uses a real `lumastra_tests` database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import {
    insertPendingRow,
    markFailedPermanentBatch,
    findRowsByItem,
} from '../../../database/queries/stage-state.queries.js';
import {
    upsertMediaFile,
    attachFileToItem,
} from '../../../database/queries/media-files.queries.js';

const STAGE = 'integrity-file-present';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertItem(sql: postgres.Sql, mediaType: string): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, media_type, title)
        VALUES (${id}::uuid, ${mediaType}, ${'scanner-int-test-' + id.slice(0, 6)})
    `;
    return id;
}

async function attachDefaultFile(
    sql: postgres.Sql,
    itemId: string,
    opts: { missing?: boolean; probedAt?: boolean } = {},
): Promise<string> {
    const { id: fileId } = await upsertMediaFile(sql, {
        filePath: `/test-files/${itemId}.mkv`,
    });
    await attachFileToItem(sql, fileId, itemId);
    if (opts.missing) {
        await sql`UPDATE media_files SET is_missing = TRUE WHERE id = ${fileId}::uuid`;
    }
    if (opts.probedAt) {
        await sql`UPDATE media_files SET probed_at = NOW() WHERE id = ${fileId}::uuid`;
    }
    return fileId;
}

async function seedStageRow(sql: postgres.Sql, itemId: string): Promise<void> {
    await insertPendingRow(sql, {
        mediaItemId: itemId,
        stageId: STAGE,
        processingVersion: 1,
    });
}

// ---------------------------------------------------------------------------
// Helper that mirrors the scanner's scanMissingDefaultFiles query so we can
// exercise it without importing from the scanner module (which triggers
// registry side-effects).
// ---------------------------------------------------------------------------
async function queryMissingIds(sql: postgres.Sql): Promise<string[]> {
    const rows = await sql<Array<{ media_item_id: string }>>`
        SELECT mfi.media_item_id
        FROM media_file_items mfi
        JOIN media_files mf ON mf.id = mfi.file_id
        JOIN media_items mi ON mi.id = mfi.media_item_id
        JOIN media_item_stage_state miss
          ON miss.media_item_id = mfi.media_item_id
         AND miss.stage_id = ${STAGE}
        WHERE mfi.is_default = TRUE
          AND mf.is_missing = TRUE
          AND NOT mi.is_dismissed
          AND mi.status != 'deleted'
          AND mi.media_type IN ('movie', 'episode', 'track')
    `;
    return rows.map((r) => r.media_item_id);
}

async function queryPresentIds(sql: postgres.Sql): Promise<string[]> {
    const rows = await sql<Array<{ media_item_id: string }>>`
        SELECT mfi.media_item_id
        FROM media_file_items mfi
        JOIN media_files mf ON mf.id = mfi.file_id
        JOIN media_items mi ON mi.id = mfi.media_item_id
        JOIN media_item_stage_state miss
          ON miss.media_item_id = mfi.media_item_id
         AND miss.stage_id = ${STAGE}
        WHERE mfi.is_default = TRUE
          AND mf.is_missing = FALSE
          AND mf.probed_at IS NOT NULL
          AND NOT mi.is_dismissed
          AND mi.status != 'deleted'
          AND mi.media_type IN ('movie', 'episode', 'track')
          AND miss.status != 'completed'
    `;
    return rows.map((r) => r.media_item_id);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('integrity-scanner stage-state sweep', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`TRUNCATE media_item_stage_state, media_file_items, media_files, stage_version_state CASCADE`;
        await sql`DELETE FROM media_items WHERE title LIKE 'scanner-int-test-%'`;
    });

    it('scanMissingDefaultFiles includes items with is_missing=true that have a stage row', async () => {
        const itemId = await insertItem(sql, 'movie');
        await attachDefaultFile(sql, itemId, { missing: true });
        await seedStageRow(sql, itemId);

        const ids = await queryMissingIds(sql);
        expect(ids).toContain(itemId);
    });

    it('scanMissingDefaultFiles excludes items without a stage row', async () => {
        const itemId = await insertItem(sql, 'movie');
        await attachDefaultFile(sql, itemId, { missing: true });
        // no seedStageRow — scanner should not include it

        const ids = await queryMissingIds(sql);
        expect(ids).not.toContain(itemId);
    });

    it('scanMissingDefaultFiles excludes dismissed items', async () => {
        const itemId = await insertItem(sql, 'movie');
        await attachDefaultFile(sql, itemId, { missing: true });
        await seedStageRow(sql, itemId);
        await sql`UPDATE media_items SET is_dismissed = TRUE WHERE id = ${itemId}::uuid`;

        const ids = await queryMissingIds(sql);
        expect(ids).not.toContain(itemId);
    });

    it('scanMissingDefaultFiles excludes soft-deleted items', async () => {
        // Regression: deleted items have orphaned/cleared hierarchy + file links
        // *because* they are being removed; flagging them produced ~381 false
        // critical integrity violations on preprod.
        const itemId = await insertItem(sql, 'movie');
        await attachDefaultFile(sql, itemId, { missing: true });
        await seedStageRow(sql, itemId);
        await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${itemId}::uuid`;

        const ids = await queryMissingIds(sql);
        expect(ids).not.toContain(itemId);
    });

    it('scanPresentDefaultFiles includes items with probed non-missing default file', async () => {
        const itemId = await insertItem(sql, 'episode');
        await attachDefaultFile(sql, itemId, {
            missing: false,
            probedAt: true,
        });
        await seedStageRow(sql, itemId);

        const ids = await queryPresentIds(sql);
        expect(ids).toContain(itemId);
    });

    it('scanPresentDefaultFiles excludes items already completed', async () => {
        const itemId = await insertItem(sql, 'episode');
        await attachDefaultFile(sql, itemId, {
            missing: false,
            probedAt: true,
        });
        await insertPendingRow(sql, {
            mediaItemId: itemId,
            stageId: STAGE,
            processingVersion: 1,
        });
        // Mark it completed first
        await sql`
            UPDATE media_item_stage_state
               SET status = 'completed', completed_at = NOW()
             WHERE media_item_id = ${itemId}::uuid AND stage_id = ${STAGE}
        `;

        const ids = await queryPresentIds(sql);
        expect(ids).not.toContain(itemId);
    });

    it('scanner sweep marks a missing-file item as failed_permanent', async () => {
        const itemId = await insertItem(sql, 'movie');
        await attachDefaultFile(sql, itemId, { missing: true });
        await seedStageRow(sql, itemId);

        const missingIds = await queryMissingIds(sql);
        await markFailedPermanentBatch(sql, {
            stageId: STAGE,
            mediaItemIds: missingIds,
            error: {
                code: 'file-missing',
                message: 'Default file unreachable',
                retryable: false,
            },
        });

        const [row] = await findRowsByItem(sql, itemId);
        expect(row.status).toBe('failed_permanent');
        expect(row.last_error?.code).toBe('file-missing');
        expect(row.last_error?.retryable).toBe(false);
        expect(row.next_eligible_at).toBeNull();
    });

    it('scanner sweep marks a present-file item as completed', async () => {
        const itemId = await insertItem(sql, 'track');
        await attachDefaultFile(sql, itemId, {
            missing: false,
            probedAt: true,
        });
        await seedStageRow(sql, itemId);

        const presentIds = await queryPresentIds(sql);
        await sql`
            UPDATE media_item_stage_state
               SET status = 'completed', completed_at = NOW(), last_error = NULL, next_eligible_at = NULL
             WHERE stage_id = ${STAGE}
               AND media_item_id = ANY(${presentIds}::uuid[])
               AND status != 'completed'
        `;

        const [row] = await findRowsByItem(sql, itemId);
        expect(row.status).toBe('completed');
        expect(row.completed_at).toBeInstanceOf(Date);
    });

    it('a file restored after missing transitions from failed_permanent to completed on next scan', async () => {
        const itemId = await insertItem(sql, 'movie');
        const fileId = await attachDefaultFile(sql, itemId, { missing: true });
        await seedStageRow(sql, itemId);

        // First scan pass — file is missing
        const missingIds1 = await queryMissingIds(sql);
        await markFailedPermanentBatch(sql, {
            stageId: STAGE,
            mediaItemIds: missingIds1,
            error: {
                code: 'file-missing',
                message: 'Default file unreachable',
                retryable: false,
            },
        });
        const [row1] = await findRowsByItem(sql, itemId);
        expect(row1.status).toBe('failed_permanent');

        // File is restored (is_missing cleared, probed)
        await sql`UPDATE media_files SET is_missing = FALSE, probed_at = NOW() WHERE id = ${fileId}::uuid`;

        // Second scan pass — file is present, row transitions to completed
        const presentIds = await queryPresentIds(sql);
        expect(presentIds).toContain(itemId);

        const updatedCount = await sql`
            UPDATE media_item_stage_state
               SET status = 'completed', completed_at = NOW(), last_error = NULL, next_eligible_at = NULL
             WHERE stage_id = ${STAGE}
               AND media_item_id = ANY(${presentIds}::uuid[])
               AND status != 'completed'
        `;
        expect(updatedCount.count).toBe(1);

        const [row2] = await findRowsByItem(sql, itemId);
        expect(row2.status).toBe('completed');
        expect(row2.last_error).toBeNull();
    });
});
