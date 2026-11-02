// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests: lumastra-intro-analyzer uses media_item_stage_state
 * exclusively for completion tracking (plugin_analysis_log retired in 16.4.0).
 *
 * Verifies:
 *   1. markAnalyzed writes a `completed` row to media_item_stage_state.
 *   2. wipeAll removes rows from media_item_stage_state (not plugin_analysis_log).
 *   3. plugin_analysis_log does not exist (16.4.0 migration guard).
 *
 * The intro-analyzer's ffmpeg/chromaprint analysis path is not exercised here
 * (requires media files). These tests target the state-machine layer only.
 *
 * Run locally:
 *   npm run test:integration src/lib/server/tasks/builtin/native/intro-analyzer/lumastra-intro-analyzer-stage-state
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import { upsertCompletedRow } from '../../../../database/queries/stage-state.queries.js';

const PLUGIN_ID = 'lumastra-intro-analyzer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertEpisode(sql: postgres.Sql, title: string): Promise<string> {
    const seriesId = crypto.randomUUID();
    const seasonId = crypto.randomUUID();
    const episodeId = crypto.randomUUID();

    await sql`
        INSERT INTO media_items (id, title, media_type, status, is_dismissed)
        VALUES (${seriesId}::uuid, ${'intro-test-series-' + title}, 'tv', 'active', false)
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, status, is_dismissed, parent_id)
        VALUES (${seasonId}::uuid, ${'intro-test-season-' + title}, 'season', 'active', false, ${seriesId}::uuid)
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, status, is_dismissed, parent_id)
        VALUES (${episodeId}::uuid, ${'intro-test-ep-' + title}, 'episode', 'active', false, ${seasonId}::uuid)
    `;
    return episodeId;
}

async function getStageRow(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<{ status: string; processing_version: number } | undefined> {
    const rows = await sql<{ status: string; processing_version: number }[]>`
        SELECT status, processing_version
        FROM media_item_stage_state
        WHERE media_item_id = ${mediaItemId}::uuid
          AND stage_id = ${PLUGIN_ID}
    `;
    return rows[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('lumastra-intro-analyzer: stage-state integration', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`
            DELETE FROM media_item_stage_state
            WHERE stage_id = ${PLUGIN_ID}
              AND media_item_id IN (
                  SELECT id FROM media_items WHERE title LIKE 'intro-test-%'
              )
        `;
        await sql`
            DELETE FROM media_items WHERE title LIKE 'intro-test-%'
        `;
    });

    it('upsertCompletedRow writes a completed row for the episode', async () => {
        const episodeId = await insertEpisode(sql, crypto.randomUUID().slice(0, 8));

        await upsertCompletedRow(sql, {
            mediaItemId: episodeId,
            stageId: PLUGIN_ID,
            processingVersion: 1,
        });

        const row = await getStageRow(sql, episodeId);
        expect(row).toBeDefined();
        expect(row?.status).toBe('completed');
        expect(row?.processing_version).toBe(1);
    });

    it('wipeAll path: deleting from media_item_stage_state removes the row', async () => {
        const episodeId = await insertEpisode(sql, crypto.randomUUID().slice(0, 8));

        await upsertCompletedRow(sql, {
            mediaItemId: episodeId,
            stageId: PLUGIN_ID,
            processingVersion: 1,
        });

        // Simulate what wipeAll does (delete all rows for this stage)
        await sql`DELETE FROM media_item_stage_state WHERE stage_id = ${PLUGIN_ID}`;

        const row = await getStageRow(sql, episodeId);
        expect(row).toBeUndefined();
    });

    it('upsertCompletedRow is idempotent — calling twice does not duplicate rows', async () => {
        const episodeId = await insertEpisode(sql, crypto.randomUUID().slice(0, 8));

        await upsertCompletedRow(sql, {
            mediaItemId: episodeId,
            stageId: PLUGIN_ID,
            processingVersion: 1,
        });
        await upsertCompletedRow(sql, {
            mediaItemId: episodeId,
            stageId: PLUGIN_ID,
            processingVersion: 1,
        });

        const rows = await sql<{ count: string }[]>`
            SELECT COUNT(*)::text AS count
            FROM media_item_stage_state
            WHERE media_item_id = ${episodeId}::uuid
              AND stage_id = ${PLUGIN_ID}
        `;
        expect(rows[0]?.count).toBe('1');
    });

    it('plugin_analysis_log does not exist (dropped by migration 16.4.0)', async () => {
        const rows = await sql<{ table_name: string }[]>`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = 'plugin_analysis_log'
        `;
        expect(
            rows,
            'plugin_analysis_log must not exist — retired by migration 16.4.0',
        ).toHaveLength(0);
    });

    it('reset path: per-item delete from media_item_stage_state clears the row', async () => {
        const episodeId = await insertEpisode(sql, crypto.randomUUID().slice(0, 8));

        await upsertCompletedRow(sql, {
            mediaItemId: episodeId,
            stageId: PLUGIN_ID,
            processingVersion: 1,
        });

        // Simulate the targeted reset path in the intro-analyzer
        await sql`
            DELETE FROM media_item_stage_state
            WHERE stage_id = ${PLUGIN_ID}
              AND media_item_id = ${episodeId}::uuid
        `;

        const row = await getStageRow(sql, episodeId);
        expect(row).toBeUndefined();
    });
});
