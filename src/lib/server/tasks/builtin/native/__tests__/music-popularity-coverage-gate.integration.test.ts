// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * music-popularity coverage-gate integration tests.
 *
 * Verifies two complementary behaviours:
 *
 * A) `upsertCompletedRow` is called after a successful popularity fetch — i.e.
 *    a `completed` row lands in `media_item_stage_state` for the artist.
 *
 * B) `findPopularityCoverageTableBacklog` returns artists whose coverage row is
 *    in a retriable state, and excludes artists that are `completed` or have no
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
import { findPopularityCoverageTableBacklog } from '../../../../database/queries/popularity.queries.js';
import { upsertCompletedRow } from '../../../../database/queries/stage-state.queries.js';
import { runStageDisposition } from '../../../stage-disposition-runner.js';
import { musicPopularityTask } from '../music-popularity.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const STAGE_ID = 'music-popularity';
const PROCESSING_VERSION = 1;

// ─── Tables ───────────────────────────────────────────────────────────────────

const TEST_TABLES = [
    'media_item_stage_state',
    'media_popularity',
    'media_file_items',
    'media_files',
    'media_items',
    'external_ids',
    'plugin_secrets',
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

describe('music-popularity coverage gate (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        // beforeEach only truncates BEFORE a test: the last test's placeholder
        // LASTFM_API_KEY row (a non-enc:v2 blob) would otherwise outlive the
        // file and show up as a legacy envelope in the security self-check.
        await sql`DELETE FROM plugin_secrets WHERE plugin_id = ${STAGE_ID}`;
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES);
    });

    // ── A: upsertCompletedRow writes a completed coverage row ─────────────────

    describe('upsertCompletedRow', () => {
        it('inserts a completed row when none exists', async () => {
            const artist = createTestArtist({ title: 'Pop Coverage Artist A' });
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
            const artist = createTestArtist({ title: 'Pop Coverage Artist B' });
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
            const artist = createTestArtist({ title: 'Pop Coverage Artist C' });
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

    // ── B: findPopularityCoverageTableBacklog fetches only retriable rows ──────

    describe('findPopularityCoverageTableBacklog', () => {
        it('returns artists with pending status', async () => {
            const artist = createTestArtist({
                title: 'Pop Backlog Artist Pending',
            });
            await insertTestArtist(sql, artist);

            await insertCoverageRow(sql, artist.id, 'pending');

            const rows = await findPopularityCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.artistId);
            expect(ids).toContain(artist.id);
        });

        it('returns artists with failed_transient status when past next_eligible_at', async () => {
            const artist = createTestArtist({
                title: 'Pop Backlog Artist FailedTransient',
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

            const rows = await findPopularityCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.artistId);
            expect(ids).toContain(artist.id);
        });

        it('excludes artists with failed_transient status still within backoff window', async () => {
            const artist = createTestArtist({
                title: 'Pop Backlog Artist BackoffActive',
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

            const rows = await findPopularityCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.artistId);
            expect(ids).not.toContain(artist.id);
        });

        it('excludes artists with completed status', async () => {
            const artist = createTestArtist({
                title: 'Pop Backlog Artist Completed',
            });
            await insertTestArtist(sql, artist);

            await insertCoverageRow(sql, artist.id, 'completed');

            const rows = await findPopularityCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.artistId);
            expect(ids).not.toContain(artist.id);
        });

        it('excludes artists with no coverage row at all', async () => {
            const artist = createTestArtist({
                title: 'Pop Backlog Artist NoCoverage',
            });
            await insertTestArtist(sql, artist);

            const rows = await findPopularityCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.artistId);
            expect(ids).not.toContain(artist.id);
        });

        it('returns artists with obsolete status', async () => {
            const artist = createTestArtist({
                title: 'Pop Backlog Artist Obsolete',
            });
            await insertTestArtist(sql, artist);

            await insertCoverageRow(sql, artist.id, 'obsolete');

            const rows = await findPopularityCoverageTableBacklog(sql, STAGE_ID, 100);
            const ids = rows.map((r) => r.artistId);
            expect(ids).toContain(artist.id);
        });

        it('respects the limit parameter', async () => {
            for (let i = 0; i < 5; i++) {
                const artist = createTestArtist({
                    title: `Pop Limit Artist ${i}`,
                });
                await insertTestArtist(sql, artist);
                await insertCoverageRow(sql, artist.id, 'pending');
            }

            const rows = await findPopularityCoverageTableBacklog(sql, STAGE_ID, 3);
            expect(rows).toHaveLength(3);
        });
    });

    // ── C: terminalDisposition drains the "Various Artists" placeholder ───────
    //
    // Regression coverage for the fresh-install pipeline-map phantom: the
    // canonical VA row (media_type='artist', is_various_artists=true) is a
    // synthetic compilation bucket seeded on every install (migration
    // 16.132.0), not a real artist Last.fm can report popularity for. The
    // `various-artists-placeholder` terminalDisposition must drain any
    // sweepable stage row for it to `skipped_permanent`, while leaving a real
    // artist's row untouched.

    describe('various-artists placeholder disposition', () => {
        function stubLogger(): {
            info: () => void;
            warn: () => void;
            error: () => void;
            debug: () => void;
        } {
            return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
        }

        // The stage's own `music-popularity-provider-configured` global-guard
        // drains the WHOLE stage to skipped_transient when no Last.fm key is
        // present — orthogonal to the VA predicate under test here. Seed a
        // presence-only row (the guard only checks EXISTS, never decrypts) so
        // the global-guard passes and the VA predicate's effect is isolated.
        beforeEach(async () => {
            await sql`
                INSERT INTO plugin_secrets (plugin_id, key, value_encrypted, encryption_version)
                VALUES (${STAGE_ID}, 'LASTFM_API_KEY', ${Buffer.from('placeholder')}, 1)
            `;
        });

        it('drains a pending row for the canonical Various Artists row to skipped_permanent', async () => {
            const va = createTestArtist({ title: 'Various Artists' });
            await insertTestArtist(sql, va);
            await sql`UPDATE media_items SET is_various_artists = true WHERE id = ${va.id}::uuid`;
            await insertCoverageRow(sql, va.id, 'pending');

            const stage = musicPopularityTask.coversStages![0];
            await runStageDisposition(sql, stage, { sql, logger: stubLogger() as never });

            const row = await getCoverageRow(sql, va.id);
            expect(row!.status).toBe('skipped_permanent');
        });

        it('leaves a real (non-VA) artist row pending', async () => {
            const artist = createTestArtist({ title: 'Real Artist Not VA' });
            await insertTestArtist(sql, artist);
            await insertCoverageRow(sql, artist.id, 'pending');

            const stage = musicPopularityTask.coversStages![0];
            await runStageDisposition(sql, stage, { sql, logger: stubLogger() as never });

            const row = await getCoverageRow(sql, artist.id);
            expect(row!.status).toBe('pending');
        });
    });
});
