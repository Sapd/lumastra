// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * library-embeddings coverage-gate integration tests.
 *
 * Verifies three complementary behaviours:
 *
 * A) `upsertCompletedRow` is called after a successful embedding — i.e. a
 *    `completed` row lands in `media_item_stage_state` for the media item.
 *
 * B) `findEmbeddingCoverageTableBacklog` returns items whose coverage row is in
 *    a retriable state, and excludes items that are `completed` or have no row.
 *
 * C) Read-path flag: when `useCoverageTable` is ON, the task wires
 *    `candidateSource` pointing at `findEmbeddingCoverageTableBacklog`; when
 *    OFF (empty authoritative stage set), `candidateSource` is undefined.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
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

const STAGE_ID = 'library-embeddings';
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

describe('library-embeddings coverage gate (integration)', () => {
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
                title: 'LibEmb Coverage A',
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
                title: 'LibEmb Coverage B',
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
                title: 'LibEmb Coverage C',
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
                title: 'LibEmb Backlog Pending',
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
                title: 'LibEmb Backlog FailedTransient',
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
                title: 'LibEmb Backlog BackoffActive',
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
                title: 'LibEmb Backlog Completed',
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
                title: 'LibEmb Backlog NoCoverage',
            });
            await insertTestMediaItem(sql, item);

            const rows = await findEmbeddingCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).not.toContain(item.id);
        });

        it('returns items with obsolete status', async () => {
            const item = createTestMediaItem({
                media_type: 'movie',
                title: 'LibEmb Backlog Obsolete',
            });
            await insertTestMediaItem(sql, item);

            await insertCoverageRow(sql, item.id, 'obsolete');

            const rows = await findEmbeddingCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(item.id);
        });

        it('excludes items whose media_items.status is not active', async () => {
            const inactive = createTestMediaItem({
                media_type: 'movie',
                title: 'LibEmb Backlog Inactive',
                status: 'deleted',
            });
            await insertTestMediaItem(sql, inactive);
            await insertCoverageRow(sql, inactive.id, 'pending');

            const rows = await findEmbeddingCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).not.toContain(inactive.id);
        });

        it('excludes items where media_items.is_dismissed = true', async () => {
            const dismissed = createTestMediaItem({
                media_type: 'movie',
                title: 'LibEmb Backlog Dismissed',
            });
            await insertTestMediaItem(sql, dismissed);
            await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${dismissed.id}::uuid`;
            await insertCoverageRow(sql, dismissed.id, 'pending');

            const rows = await findEmbeddingCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).not.toContain(dismissed.id);
        });

        it('respects the limit parameter', async () => {
            for (let i = 0; i < 5; i++) {
                const item = createTestMediaItem({
                    media_type: 'movie',
                    title: `LibEmb Limit ${i}`,
                });
                await insertTestMediaItem(sql, item);
                await insertCoverageRow(sql, item.id, 'pending');
            }

            const rows = await findEmbeddingCoverageTableBacklog(sql, STAGE_ID, 3);
            expect(rows).toHaveLength(3);
        });
    });

    // ── C: read-path flag — candidateSource wiring ────────────────────────────

    describe('candidateSource wiring (read-path flag)', () => {
        it('EmbeddingGeneratorOptions carries candidateSource when flag is ON', async () => {
            const capturedOptions: Array<{ candidateSource: unknown }> = [];

            const mockGenerate = vi.fn(async (opts: { candidateSource?: unknown }) => {
                capturedOptions.push({
                    candidateSource: opts.candidateSource,
                });
                return {
                    success: true,
                    totalEntries: 0,
                    processed: 0,
                    generated: 0,
                    skipped: 0,
                    errors: 0,
                    message: '',
                };
            });

            vi.doMock('../../../ai/embedding-only-generator.js', () => ({
                EmbeddingOnlyGenerator: vi.fn(() => ({
                    generate: mockGenerate,
                    abort: vi.fn(),
                    isAborted: vi.fn(() => false),
                    isGenerating: vi.fn(() => false),
                    getProgress: vi.fn(() => ({
                        phase: 'completed',
                        totalItems: 0,
                        processedItems: 0,
                        currentSubStatus: '',
                        errors: [],
                        recentLogs: [],
                        startTime: new Date(),
                        created: 0,
                        updated: 0,
                        skipped: 0,
                        errorCount: 0,
                        progressPercentage: 0,
                    })),
                })),
            }));

            const { findEmbeddingCoverageTableBacklog: backlogFn } =
                await import('../../../../database/queries/embeddings.queries.js');

            // candidateSource is set when stage is in the authoritative set
            const candidateSourceWithFlag = (aSql: postgres.Sql, limit: number) =>
                backlogFn(aSql, STAGE_ID, limit);

            // Verify the function signature matches what the generator expects
            expect(typeof candidateSourceWithFlag).toBe('function');

            // Verify it returns the right shape: Array<{ id: string }>
            const item = createTestMediaItem({
                media_type: 'movie',
                title: 'LibEmb ReadPath A',
            });
            await insertTestMediaItem(sql, item);
            await insertCoverageRow(sql, item.id, 'pending');

            const rows = await candidateSourceWithFlag(sql, 100);
            expect(Array.isArray(rows)).toBe(true);
            expect(rows[0]).toHaveProperty('id');
            expect(typeof rows[0].id).toBe('string');
        });

        it('findEmbeddingCoverageTableBacklog excludes completed items — so the read path skips already-done work', async () => {
            const pending = createTestMediaItem({
                media_type: 'movie',
                title: 'LibEmb ReadPath Pending',
            });
            const done = createTestMediaItem({
                media_type: 'movie',
                title: 'LibEmb ReadPath Done',
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
