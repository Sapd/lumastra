// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * album-enrichment coverage-gate integration tests.
 *
 * Verifies two complementary behaviours:
 *
 * A) `upsertCompletedRow` is called after a successful enrichment — i.e. a
 *    `completed` row lands in `media_item_stage_state` for the album.
 *
 * B) `findCoverageTableBacklog` returns albums whose coverage row is in a
 *    retriable state, and excludes albums that are `completed` or have no
 *    row at all (when the flag is enabled, albums with no coverage row are
 *    not re-processed — they simply have no row to fetch).
 *
 * These tests run against a real PostgreSQL test database via the shared
 * test-database setup.
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
    insertTestAlbum,
    createTestArtist,
    createTestAlbum,
    createTestTrack,
    insertTestTrack,
} from '../../../../../../../tests/integration/fixtures/index.js';
import { findCoverageTableBacklog } from '../../../../database/queries/album-enrichment.queries.js';
import { recomputeHasFilesBatch } from '../../../../database/queries/media-files.queries.js';
import { upsertCompletedRow } from '../../../../database/queries/stage-state.queries.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const STAGE_ID = 'album-enrichment';
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

async function insertLibraryAlbum(
    sql: postgres.Sql,
    album: ReturnType<typeof createTestAlbum>,
): Promise<void> {
    await insertTestAlbum(sql, album);
    await insertTestTrack(sql, createTestTrack(album.id, 1));
    await recomputeHasFilesBatch(sql, [album.id]);
}

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

describe('album-enrichment coverage gate (integration)', () => {
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
            const album = createTestAlbum(artist.id, {
                title: 'Coverage Album A',
            });
            await insertLibraryAlbum(sql, album);

            await upsertCompletedRow(sql, {
                mediaItemId: album.id,
                stageId: STAGE_ID,
                processingVersion: PROCESSING_VERSION,
            });

            const row = await getCoverageRow(sql, album.id);
            expect(row).toBeDefined();
            expect(row!.status).toBe('completed');
            expect(row!.processing_version).toBe(PROCESSING_VERSION);
        });

        it('transitions an existing pending row to completed', async () => {
            const artist = createTestArtist({ title: 'Coverage Artist B' });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'Coverage Album B',
            });
            await insertLibraryAlbum(sql, album);

            await insertCoverageRow(sql, album.id, 'pending');

            await upsertCompletedRow(sql, {
                mediaItemId: album.id,
                stageId: STAGE_ID,
                processingVersion: PROCESSING_VERSION,
            });

            const row = await getCoverageRow(sql, album.id);
            expect(row!.status).toBe('completed');
        });

        it('is idempotent — calling twice keeps the row completed', async () => {
            const artist = createTestArtist({ title: 'Coverage Artist C' });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'Coverage Album C',
            });
            await insertLibraryAlbum(sql, album);

            await upsertCompletedRow(sql, {
                mediaItemId: album.id,
                stageId: STAGE_ID,
                processingVersion: PROCESSING_VERSION,
            });
            await upsertCompletedRow(sql, {
                mediaItemId: album.id,
                stageId: STAGE_ID,
                processingVersion: PROCESSING_VERSION,
            });

            const row = await getCoverageRow(sql, album.id);
            expect(row!.status).toBe('completed');
        });
    });

    // ── B: findCoverageTableBacklog fetches only retriable rows ───────────────

    describe('findCoverageTableBacklog', () => {
        it('returns albums with pending status', async () => {
            const artist = createTestArtist({ title: 'Backlog Artist A' });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'Backlog Album Pending',
            });
            await insertLibraryAlbum(sql, album);

            await insertCoverageRow(sql, album.id, 'pending');

            const rows = await findCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(album.id);
        });

        it('returns albums with failed_transient status when past next_eligible_at', async () => {
            const artist = createTestArtist({ title: 'Backlog Artist B' });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'Backlog Album FailedTransient',
            });
            await insertLibraryAlbum(sql, album);

            await sql`
                INSERT INTO media_item_stage_state (
                    media_item_id, stage_id, processing_version, status,
                    next_eligible_at, updated_at
                ) VALUES (
                    ${album.id}::uuid,
                    ${STAGE_ID},
                    ${PROCESSING_VERSION},
                    'failed_transient',
                    now() - interval '1 minute',
                    now()
                )
            `;

            const rows = await findCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(album.id);
        });

        it('excludes albums with failed_transient status still within backoff window', async () => {
            const artist = createTestArtist({ title: 'Backlog Artist C' });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'Backlog Album BackoffActive',
            });
            await insertLibraryAlbum(sql, album);

            await sql`
                INSERT INTO media_item_stage_state (
                    media_item_id, stage_id, processing_version, status,
                    next_eligible_at, updated_at
                ) VALUES (
                    ${album.id}::uuid,
                    ${STAGE_ID},
                    ${PROCESSING_VERSION},
                    'failed_transient',
                    now() + interval '10 minutes',
                    now()
                )
            `;

            const rows = await findCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).not.toContain(album.id);
        });

        it('excludes albums with completed status', async () => {
            const artist = createTestArtist({ title: 'Backlog Artist D' });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'Backlog Album Completed',
            });
            await insertLibraryAlbum(sql, album);

            await insertCoverageRow(sql, album.id, 'completed');

            const rows = await findCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).not.toContain(album.id);
        });

        it('excludes albums with no coverage row at all', async () => {
            const artist = createTestArtist({ title: 'Backlog Artist E' });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'Backlog Album NoCoverage',
            });
            await insertLibraryAlbum(sql, album);

            // No coverage row inserted.

            const rows = await findCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).not.toContain(album.id);
        });

        it('returns albums with obsolete status', async () => {
            const artist = createTestArtist({ title: 'Backlog Artist F' });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'Backlog Album Obsolete',
            });
            await insertLibraryAlbum(sql, album);

            await insertCoverageRow(sql, album.id, 'obsolete');

            const rows = await findCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(album.id);
        });

        it('includes joined parent_title from the artist row', async () => {
            const artist = createTestArtist({ title: 'Joined Parent Artist' });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'Joined Parent Album',
            });
            await insertLibraryAlbum(sql, album);

            await insertCoverageRow(sql, album.id, 'pending');

            const rows = await findCoverageTableBacklog(sql, STAGE_ID, 100);
            const row = rows.find((r) => r.id === album.id);
            expect(row).toBeDefined();
            expect(row!.parent_title).toBe('Joined Parent Artist');
        });

        it('respects the limit parameter', async () => {
            const artist = createTestArtist({ title: 'Limit Artist' });
            await insertTestArtist(sql, artist);

            const albumIds: string[] = [];
            for (let i = 0; i < 5; i++) {
                const album = createTestAlbum(artist.id, {
                    title: `Limit Album ${i}`,
                });
                await insertLibraryAlbum(sql, album);
                await insertCoverageRow(sql, album.id, 'pending');
                albumIds.push(album.id);
            }

            const rows = await findCoverageTableBacklog(sql, STAGE_ID, 3);
            expect(rows).toHaveLength(3);
        });
    });
});
