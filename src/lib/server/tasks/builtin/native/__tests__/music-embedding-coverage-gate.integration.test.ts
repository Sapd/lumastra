// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * music-embedding-generation coverage-gate integration tests.
 *
 * Verifies three complementary behaviours:
 *
 * A) `upsertCompletedRow` is called after a successful embedding — i.e. a
 *    `completed` row lands in `media_item_stage_state` for the track.
 *
 * B) `findEmbeddingCoverageTableBacklog` returns tracks whose coverage row is
 *    in a retriable state, and excludes tracks that are `completed` or have no
 *    row at all.
 *
 * C) Read-path flag: when used as a candidateSource, `findEmbeddingCoverageTableBacklog`
 *    returns the { id } shape expected by `generateMusicEmbeddings` and correctly
 *    filters completed tracks.
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
    insertTestTrack,
    createTestArtist,
    createTestAlbum,
    createTestTrack,
} from '../../../../../../../tests/integration/fixtures/index.js';
import { findEmbeddingCoverageTableBacklog } from '../../../../database/queries/embeddings.queries.js';
import { upsertCompletedRow } from '../../../../database/queries/stage-state.queries.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const STAGE_ID = 'music-embedding-generation';
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

describe('music-embedding-generation coverage gate (integration)', () => {
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
            const artist = createTestArtist({ title: 'MusicEmb Artist A' });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'MusicEmb Album A',
            });
            await insertTestAlbum(sql, album);
            const track = createTestTrack(album.id, 1, {
                title: 'MusicEmb Track A',
            });
            await insertTestTrack(sql, track);

            await upsertCompletedRow(sql, {
                mediaItemId: track.id,
                stageId: STAGE_ID,
                processingVersion: PROCESSING_VERSION,
            });

            const row = await getCoverageRow(sql, track.id);
            expect(row).toBeDefined();
            expect(row!.status).toBe('completed');
            expect(row!.processing_version).toBe(PROCESSING_VERSION);
        });

        it('transitions an existing pending row to completed', async () => {
            const artist = createTestArtist({ title: 'MusicEmb Artist B' });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'MusicEmb Album B',
            });
            await insertTestAlbum(sql, album);
            const track = createTestTrack(album.id, 1, {
                title: 'MusicEmb Track B',
            });
            await insertTestTrack(sql, track);

            await insertCoverageRow(sql, track.id, 'pending');

            await upsertCompletedRow(sql, {
                mediaItemId: track.id,
                stageId: STAGE_ID,
                processingVersion: PROCESSING_VERSION,
            });

            const row = await getCoverageRow(sql, track.id);
            expect(row!.status).toBe('completed');
        });

        it('is idempotent — calling twice keeps the row completed', async () => {
            const artist = createTestArtist({ title: 'MusicEmb Artist C' });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'MusicEmb Album C',
            });
            await insertTestAlbum(sql, album);
            const track = createTestTrack(album.id, 1, {
                title: 'MusicEmb Track C',
            });
            await insertTestTrack(sql, track);

            await upsertCompletedRow(sql, {
                mediaItemId: track.id,
                stageId: STAGE_ID,
                processingVersion: PROCESSING_VERSION,
            });
            await upsertCompletedRow(sql, {
                mediaItemId: track.id,
                stageId: STAGE_ID,
                processingVersion: PROCESSING_VERSION,
            });

            const row = await getCoverageRow(sql, track.id);
            expect(row!.status).toBe('completed');
        });
    });

    // ── B: findEmbeddingCoverageTableBacklog fetches only retriable rows ───────

    describe('findEmbeddingCoverageTableBacklog', () => {
        it('returns tracks with pending status', async () => {
            const artist = createTestArtist({
                title: 'MusicEmb Backlog Artist A',
            });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'MusicEmb Backlog Album A',
            });
            await insertTestAlbum(sql, album);
            const track = createTestTrack(album.id, 1, {
                title: 'MusicEmb Backlog Pending',
            });
            await insertTestTrack(sql, track);

            await insertCoverageRow(sql, track.id, 'pending');

            const rows = await findEmbeddingCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(track.id);
        });

        it('returns tracks with failed_transient status when past next_eligible_at', async () => {
            const artist = createTestArtist({
                title: 'MusicEmb Backlog Artist B',
            });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'MusicEmb Backlog Album B',
            });
            await insertTestAlbum(sql, album);
            const track = createTestTrack(album.id, 1, {
                title: 'MusicEmb Backlog FailedTransient',
            });
            await insertTestTrack(sql, track);

            await sql`
                INSERT INTO media_item_stage_state (
                    media_item_id, stage_id, processing_version, status,
                    next_eligible_at, updated_at
                ) VALUES (
                    ${track.id}::uuid,
                    ${STAGE_ID},
                    ${PROCESSING_VERSION},
                    'failed_transient',
                    now() - interval '1 minute',
                    now()
                )
            `;

            const rows = await findEmbeddingCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(track.id);
        });

        it('excludes tracks with failed_transient status still within backoff window', async () => {
            const artist = createTestArtist({
                title: 'MusicEmb Backlog Artist C',
            });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'MusicEmb Backlog Album C',
            });
            await insertTestAlbum(sql, album);
            const track = createTestTrack(album.id, 1, {
                title: 'MusicEmb Backlog BackoffActive',
            });
            await insertTestTrack(sql, track);

            await sql`
                INSERT INTO media_item_stage_state (
                    media_item_id, stage_id, processing_version, status,
                    next_eligible_at, updated_at
                ) VALUES (
                    ${track.id}::uuid,
                    ${STAGE_ID},
                    ${PROCESSING_VERSION},
                    'failed_transient',
                    now() + interval '10 minutes',
                    now()
                )
            `;

            const rows = await findEmbeddingCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).not.toContain(track.id);
        });

        it('excludes tracks with completed status', async () => {
            const artist = createTestArtist({
                title: 'MusicEmb Backlog Artist D',
            });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'MusicEmb Backlog Album D',
            });
            await insertTestAlbum(sql, album);
            const track = createTestTrack(album.id, 1, {
                title: 'MusicEmb Backlog Completed',
            });
            await insertTestTrack(sql, track);

            await insertCoverageRow(sql, track.id, 'completed');

            const rows = await findEmbeddingCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).not.toContain(track.id);
        });

        it('excludes tracks with no coverage row at all', async () => {
            const artist = createTestArtist({
                title: 'MusicEmb Backlog Artist E',
            });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'MusicEmb Backlog Album E',
            });
            await insertTestAlbum(sql, album);
            const track = createTestTrack(album.id, 1, {
                title: 'MusicEmb Backlog NoCoverage',
            });
            await insertTestTrack(sql, track);

            const rows = await findEmbeddingCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).not.toContain(track.id);
        });

        it('returns tracks with obsolete status', async () => {
            const artist = createTestArtist({
                title: 'MusicEmb Backlog Artist F',
            });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'MusicEmb Backlog Album F',
            });
            await insertTestAlbum(sql, album);
            const track = createTestTrack(album.id, 1, {
                title: 'MusicEmb Backlog Obsolete',
            });
            await insertTestTrack(sql, track);

            await insertCoverageRow(sql, track.id, 'obsolete');

            const rows = await findEmbeddingCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(track.id);
        });

        it('respects the limit parameter', async () => {
            const artist = createTestArtist({ title: 'MusicEmb Limit Artist' });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'MusicEmb Limit Album',
            });
            await insertTestAlbum(sql, album);

            for (let i = 1; i <= 5; i++) {
                const track = createTestTrack(album.id, i, {
                    title: `MusicEmb Limit Track ${i}`,
                });
                await insertTestTrack(sql, track);
                await insertCoverageRow(sql, track.id, 'pending');
            }

            const rows = await findEmbeddingCoverageTableBacklog(sql, STAGE_ID, 3);
            expect(rows).toHaveLength(3);
        });
    });

    // ── C: read-path flag — candidateSource shape and filtering ───────────────

    describe('candidateSource wiring (read-path flag)', () => {
        it('returns rows with the { id } shape expected by generateMusicEmbeddings', async () => {
            const artist = createTestArtist({
                title: 'MusicEmb ReadPath Artist A',
            });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'MusicEmb ReadPath Album A',
            });
            await insertTestAlbum(sql, album);
            const track = createTestTrack(album.id, 1, {
                title: 'MusicEmb ReadPath Shape',
            });
            await insertTestTrack(sql, track);
            await insertCoverageRow(sql, track.id, 'pending');

            const rows = await findEmbeddingCoverageTableBacklog(sql, STAGE_ID, 100);
            expect(rows.length).toBeGreaterThan(0);
            expect(rows[0]).toHaveProperty('id');
            expect(typeof rows[0].id).toBe('string');
        });

        it('excludes completed tracks so the coverage-driven path skips already-embedded tracks', async () => {
            const artist = createTestArtist({
                title: 'MusicEmb ReadPath Artist B',
            });
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'MusicEmb ReadPath Album B',
            });
            await insertTestAlbum(sql, album);

            const pendingTrack = createTestTrack(album.id, 1, {
                title: 'MusicEmb ReadPath Pending',
            });
            const doneTrack = createTestTrack(album.id, 2, {
                title: 'MusicEmb ReadPath Done',
            });
            await insertTestTrack(sql, pendingTrack);
            await insertTestTrack(sql, doneTrack);
            await insertCoverageRow(sql, pendingTrack.id, 'pending');
            await insertCoverageRow(sql, doneTrack.id, 'completed');

            const rows = await findEmbeddingCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(pendingTrack.id);
            expect(ids).not.toContain(doneTrack.id);
        });
    });
});
