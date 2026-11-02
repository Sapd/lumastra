// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * artist-enrichment coverage-gate integration tests.
 *
 * Verifies two complementary behaviours:
 *
 * A) `upsertCompletedRow` is called after a successful enrichment — i.e. a
 *    `completed` row lands in `media_item_stage_state` for the artist.
 *
 * B) `findCoverageTableBacklog` returns artists whose coverage row is in a
 *    retriable state, and excludes artists that are `completed` or have no
 *    row at all.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../../../tests/integration/helpers/cleanup.js';
import {
    insertTestArtist,
    createTestArtist,
} from '../../../../../../../tests/integration/fixtures/index.js';
import { findCoverageTableBacklog } from '../../../../database/queries/artist-enrichment.queries.js';
import { upsertCompletedRow } from '../../../../database/queries/stage-state.queries.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const STAGE_ID = 'artist-enrichment';
const PROCESSING_VERSION = 1;

// ─── Tables ───────────────────────────────────────────────────────────────────

const TEST_TABLES = [
    'media_item_stage_state',
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

describe('artist-enrichment coverage gate (integration)', () => {
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
            const artist = createTestArtist({ title: 'Coverage Artist A' });
            await insertTestArtist(sql, artist);

            await upsertCompletedRow(sql, {
                mediaItemId: artist.id,
                stageId: STAGE_ID,
                processingVersion: PROCESSING_VERSION,
            });

            const row = await getCoverageRow(sql, artist.id);
            expect(row).toBeDefined();
            expect(row!.status).toBe('completed');
            expect(row!.processing_version).toBe(PROCESSING_VERSION);
        });

        it('transitions an existing pending row to completed', async () => {
            const artist = createTestArtist({ title: 'Coverage Artist B' });
            await insertTestArtist(sql, artist);

            await insertCoverageRow(sql, artist.id, 'pending');

            await upsertCompletedRow(sql, {
                mediaItemId: artist.id,
                stageId: STAGE_ID,
                processingVersion: PROCESSING_VERSION,
            });

            const row = await getCoverageRow(sql, artist.id);
            expect(row!.status).toBe('completed');
        });

        it('is idempotent — calling twice keeps the row completed', async () => {
            const artist = createTestArtist({ title: 'Coverage Artist C' });
            await insertTestArtist(sql, artist);

            await upsertCompletedRow(sql, {
                mediaItemId: artist.id,
                stageId: STAGE_ID,
                processingVersion: PROCESSING_VERSION,
            });
            await upsertCompletedRow(sql, {
                mediaItemId: artist.id,
                stageId: STAGE_ID,
                processingVersion: PROCESSING_VERSION,
            });

            const row = await getCoverageRow(sql, artist.id);
            expect(row!.status).toBe('completed');
        });
    });

    // ── B: findCoverageTableBacklog fetches only retriable rows ───────────────

    describe('findCoverageTableBacklog', () => {
        it('returns artists with pending status', async () => {
            const artist = createTestArtist({
                title: 'Backlog Artist Pending',
            });
            await insertTestArtist(sql, artist);

            await insertCoverageRow(sql, artist.id, 'pending');

            const rows = await findCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(artist.id);
        });

        it('returns artists with failed_transient status when past next_eligible_at', async () => {
            const artist = createTestArtist({
                title: 'Backlog Artist FailedTransient',
            });
            await insertTestArtist(sql, artist);

            await sql`
                INSERT INTO media_item_stage_state (
                    media_item_id, stage_id, processing_version, status,
                    next_eligible_at, updated_at
                ) VALUES (
                    ${artist.id}::uuid,
                    ${STAGE_ID},
                    ${PROCESSING_VERSION},
                    'failed_transient',
                    now() - interval '1 minute',
                    now()
                )
            `;

            const rows = await findCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(artist.id);
        });

        it('excludes artists with failed_transient status still within backoff window', async () => {
            const artist = createTestArtist({
                title: 'Backlog Artist BackoffActive',
            });
            await insertTestArtist(sql, artist);

            await sql`
                INSERT INTO media_item_stage_state (
                    media_item_id, stage_id, processing_version, status,
                    next_eligible_at, updated_at
                ) VALUES (
                    ${artist.id}::uuid,
                    ${STAGE_ID},
                    ${PROCESSING_VERSION},
                    'failed_transient',
                    now() + interval '10 minutes',
                    now()
                )
            `;

            const rows = await findCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).not.toContain(artist.id);
        });

        it('excludes artists with completed status', async () => {
            const artist = createTestArtist({
                title: 'Backlog Artist Completed',
            });
            await insertTestArtist(sql, artist);

            await insertCoverageRow(sql, artist.id, 'completed');

            const rows = await findCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).not.toContain(artist.id);
        });

        it('excludes artists with no coverage row at all', async () => {
            const artist = createTestArtist({
                title: 'Backlog Artist NoCoverage',
            });
            await insertTestArtist(sql, artist);

            const rows = await findCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).not.toContain(artist.id);
        });

        it('returns artists with obsolete status', async () => {
            const artist = createTestArtist({
                title: 'Backlog Artist Obsolete',
            });
            await insertTestArtist(sql, artist);

            await insertCoverageRow(sql, artist.id, 'obsolete');

            const rows = await findCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(artist.id);
        });

        it('respects the limit parameter', async () => {
            for (let i = 0; i < 5; i++) {
                const artist = createTestArtist({ title: `Limit Artist ${i}` });
                await insertTestArtist(sql, artist);
                await insertCoverageRow(sql, artist.id, 'pending');
            }

            const rows = await findCoverageTableBacklog(sql, STAGE_ID, 3);
            expect(rows).toHaveLength(3);
        });
    });
});
