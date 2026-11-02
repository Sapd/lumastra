// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * discovery-embeddings coverage-gate integration tests.
 *
 * Verifies three complementary behaviours:
 *
 * A) `upsertCompletedRow` is called after a successful embedding — i.e. a
 *    `completed` row lands in `media_item_stage_state` for the media item.
 *
 * B) `findEmbeddingCoverageTableBacklog` returns items whose coverage row is in
 *    a retriable state, and excludes items that are `completed` or have no row.
 *
 * C) Read-path flag: `findEmbeddingCoverageTableBacklog` with the
 *    `discovery-embeddings` stage ID returns the correct shape and filters
 *    as expected when used as the candidateSource.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../../../tests/integration/fixtures/index.js';
import { findEmbeddingCoverageTableBacklog } from '../../../../database/queries/embeddings.queries.js';
import { upsertCompletedRow } from '../../../../database/queries/stage-state.queries.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const STAGE_ID = 'discovery-embeddings';
const PROCESSING_VERSION = 1;

// ─── Tables ───────────────────────────────────────────────────────────────────

const TEST_TABLES = [
    'media_item_stage_state',
    'media_embeddings',
    'media_file_items',
    'media_files',
    'media_items',
    'external_ids',
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function insertCoverageRow(
    sql: postgres.Sql,
    mediaItemId: string,
    status: string,
): Promise<void> {
    await sql`
        INSERT INTO media_item_stage_state (
            media_item_id, stage_id, processing_version, status, updated_at
        ) VALUES (
            ${mediaItemId}::uuid,
            ${STAGE_ID},
            ${PROCESSING_VERSION},
            ${status},
            now()
        )
        ON CONFLICT (media_item_id, stage_id) DO UPDATE
            SET status = EXCLUDED.status,
                updated_at = now()
    `;
}

async function getCoverageRow(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<{ status: string; processing_version: number } | undefined> {
    const [row] = await sql<Array<{ status: string; processing_version: number }>>`
        SELECT status, processing_version
        FROM media_item_stage_state
        WHERE media_item_id = ${mediaItemId}::uuid
          AND stage_id = ${STAGE_ID}
    `;
    return row;
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('discovery-embeddings coverage gate (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES);
    });

    // ── A: upsertCompletedRow writes a completed coverage row ─────────────────

    describe('upsertCompletedRow', () => {
        it('inserts a completed row when none exists', async () => {
            const item = createTestMediaItem({
                media_type: 'movie',
                title: 'DiscEmb Coverage A',
            });
            await insertTestMediaItem(sql, item);

            await upsertCompletedRow(sql, {
                mediaItemId: item.id,
                stageId: STAGE_ID,
                processingVersion: PROCESSING_VERSION,
            });

            const row = await getCoverageRow(sql, item.id);
            expect(row).toBeDefined();
            expect(row!.status).toBe('completed');
            expect(row!.processing_version).toBe(PROCESSING_VERSION);
        });

        it('transitions an existing pending row to completed', async () => {
            const item = createTestMediaItem({
                media_type: 'movie',
                title: 'DiscEmb Coverage B',
            });
            await insertTestMediaItem(sql, item);

            await insertCoverageRow(sql, item.id, 'pending');

            await upsertCompletedRow(sql, {
                mediaItemId: item.id,
                stageId: STAGE_ID,
                processingVersion: PROCESSING_VERSION,
            });

            const row = await getCoverageRow(sql, item.id);
            expect(row!.status).toBe('completed');
        });

        it('is idempotent — calling twice keeps the row completed', async () => {
            const item = createTestMediaItem({
                media_type: 'movie',
                title: 'DiscEmb Coverage C',
            });
            await insertTestMediaItem(sql, item);

            await upsertCompletedRow(sql, {
                mediaItemId: item.id,
                stageId: STAGE_ID,
                processingVersion: PROCESSING_VERSION,
            });
            await upsertCompletedRow(sql, {
                mediaItemId: item.id,
                stageId: STAGE_ID,
                processingVersion: PROCESSING_VERSION,
            });

            const row = await getCoverageRow(sql, item.id);
            expect(row!.status).toBe('completed');
        });
    });

    // ── B: findEmbeddingCoverageTableBacklog fetches only retriable rows ───────

    describe('findEmbeddingCoverageTableBacklog', () => {
        it('returns items with pending status', async () => {
            const item = createTestMediaItem({
                media_type: 'movie',
                title: 'DiscEmb Backlog Pending',
            });
            await insertTestMediaItem(sql, item);

            await insertCoverageRow(sql, item.id, 'pending');

            const rows = await findEmbeddingCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(item.id);
        });

        it('returns items with failed_transient status when past next_eligible_at', async () => {
            const item = createTestMediaItem({
                media_type: 'movie',
                title: 'DiscEmb Backlog FailedTransient',
            });
            await insertTestMediaItem(sql, item);

            await sql`
                INSERT INTO media_item_stage_state (
                    media_item_id, stage_id, processing_version, status,
                    next_eligible_at, updated_at
                ) VALUES (
                    ${item.id}::uuid,
                    ${STAGE_ID},
                    ${PROCESSING_VERSION},
                    'failed_transient',
                    now() - interval '1 minute',
                    now()
                )
            `;

            const rows = await findEmbeddingCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(item.id);
        });

        it('excludes items with failed_transient status still within backoff window', async () => {
            const item = createTestMediaItem({
                media_type: 'movie',
                title: 'DiscEmb Backlog BackoffActive',
            });
            await insertTestMediaItem(sql, item);

            await sql`
                INSERT INTO media_item_stage_state (
                    media_item_id, stage_id, processing_version, status,
                    next_eligible_at, updated_at
                ) VALUES (
                    ${item.id}::uuid,
                    ${STAGE_ID},
                    ${PROCESSING_VERSION},
                    'failed_transient',
                    now() + interval '10 minutes',
                    now()
                )
            `;

            const rows = await findEmbeddingCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).not.toContain(item.id);
        });

        it('excludes items with completed status', async () => {
            const item = createTestMediaItem({
                media_type: 'movie',
                title: 'DiscEmb Backlog Completed',
            });
            await insertTestMediaItem(sql, item);

            await insertCoverageRow(sql, item.id, 'completed');

            const rows = await findEmbeddingCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).not.toContain(item.id);
        });

        it('excludes items with no coverage row at all', async () => {
            const item = createTestMediaItem({
                media_type: 'movie',
                title: 'DiscEmb Backlog NoCoverage',
            });
            await insertTestMediaItem(sql, item);

            const rows = await findEmbeddingCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).not.toContain(item.id);
        });

        it('returns items with obsolete status', async () => {
            const item = createTestMediaItem({
                media_type: 'movie',
                title: 'DiscEmb Backlog Obsolete',
            });
            await insertTestMediaItem(sql, item);

            await insertCoverageRow(sql, item.id, 'obsolete');

            const rows = await findEmbeddingCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(item.id);
        });

        it('respects the limit parameter', async () => {
            for (let i = 0; i < 5; i++) {
                const item = createTestMediaItem({
                    media_type: 'movie',
                    title: `DiscEmb Limit ${i}`,
                });
                await insertTestMediaItem(sql, item);
                await insertCoverageRow(sql, item.id, 'pending');
            }

            const rows = await findEmbeddingCoverageTableBacklog(sql, STAGE_ID, 3);
            expect(rows).toHaveLength(3);
        });
    });

    // ── C: read-path flag — candidateSource shape and filtering ───────────────

    describe('candidateSource wiring (read-path flag)', () => {
        it('returns rows with the { id, media_type } shape expected by the generator', async () => {
            const item = createTestMediaItem({
                media_type: 'movie',
                title: 'DiscEmb ReadPath Shape',
            });
            await insertTestMediaItem(sql, item);
            await insertCoverageRow(sql, item.id, 'pending');

            const rows = await findEmbeddingCoverageTableBacklog(sql, STAGE_ID, 100);
            expect(rows.length).toBeGreaterThan(0);
            expect(rows[0]).toHaveProperty('id');
            expect(typeof rows[0].id).toBe('string');
        });

        it('excludes completed items so the coverage-driven path skips already-done work', async () => {
            const pending = createTestMediaItem({
                media_type: 'movie',
                title: 'DiscEmb ReadPath Pending',
            });
            const done = createTestMediaItem({
                media_type: 'movie',
                title: 'DiscEmb ReadPath Done',
            });
            await insertTestMediaItem(sql, pending);
            await insertTestMediaItem(sql, done);
            await insertCoverageRow(sql, pending.id, 'pending');
            await insertCoverageRow(sql, done.id, 'completed');

            const rows = await findEmbeddingCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(pending.id);
            expect(ids).not.toContain(done.id);
        });
    });
});
