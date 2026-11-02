// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * series-sync freshness guard, against a REAL database.
 *
 * This exists because the guard shipped inert and no test noticed. It is the
 * guard that stops the per-episode fan-out — one series was matched once per
 * episode, so 773 episodes produced 2,130 runs and 44,580 TMDB calls in a week.
 *
 * Its coverage clause tested `status = 'completed'` on the stage row. But the
 * guard runs INSIDE execute(), and by then the framework has flipped that row to
 * 'running' for the current run. The CTE matched nothing on every invocation,
 * the outer WHERE EXISTS dropped every row, and the skip branch was unreachable.
 * Prod kept re-syncing SpongeBob 13x/hour, flat for hours, with force=false,
 * fresh metadata and nothing new below it.
 *
 * The unit tests passed the whole time, and could not have failed: they fed the
 * probe's ANSWER through a mocked `sql`, so they asserted what the caller does
 * with the result, never what the SQL matches. Only a real row in the real
 * intermediate state shows it — hence an integration test.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { seriesSyncIsFresh } from './media-item-tasks.js';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../../tests/integration/helpers/cleanup.js';

const TEST_TABLES = [
    'media_item_stage_state',
    'provider_metadata',
    'media_file_items',
    'media_files',
    'media_items',
] as const;

describe('series-sync freshness guard (integration)', () => {
    let sql: postgres.Sql;
    let seriesId: string;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES);
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type) VALUES ('SpongeBob', 'tv') RETURNING id
        `;
        seriesId = row.id;
        // One season + one episode, both created in the past, so nothing is "new below".
        const [season] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, created_at)
            VALUES ('S1', 'season', ${seriesId}::uuid, now() - interval '30 days') RETURNING id
        `;
        await sql`
            INSERT INTO media_items (title, media_type, parent_id, created_at)
            VALUES ('E1', 'episode', ${season.id}::uuid, now() - interval '30 days')
        `;
        // Freshly synced series-level metadata.
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
            VALUES (${seriesId}::uuid, 'tmdb', '{}'::jsonb, now(), now())
        `;
    });

    /** Seed the stage row the way the framework leaves it in a given state. */
    async function seedStageRow(opts: {
        status: string;
        completedAt: Date | null;
        invalidatedAt?: Date | null;
    }): Promise<void> {
        await sql`
            INSERT INTO media_item_stage_state
                (media_item_id, stage_id, processing_version, status, completed_at, invalidated_at)
            VALUES (${seriesId}::uuid, 'series-sync', 1, ${opts.status},
                    ${opts.completedAt}, ${opts.invalidatedAt ?? null})
        `;
    }

    it('skips while the row is RUNNING — the state it is always in when this is asked', async () => {
        // THE regression. The guard evaluates from inside the run, so 'running' is
        // not an edge case: it is the only state this code ever observes.
        await seedStageRow({ status: 'running', completedAt: new Date() });
        expect(await seriesSyncIsFresh(sql, seriesId)).toBe(true);
    });

    it('skips when the row is completed and idle', async () => {
        await seedStageRow({ status: 'completed', completedAt: new Date() });
        expect(await seriesSyncIsFresh(sql, seriesId)).toBe(true);
    });

    it('does NOT skip a series that has never completed a sync', async () => {
        // The false-coverage case the original status test was reaching for: a first
        // run that dies attaching episodes must not let the next one skip and report
        // coverage for episodes that never synced.
        await seedStageRow({ status: 'running', completedAt: null });
        expect(await seriesSyncIsFresh(sql, seriesId)).toBe(false);
    });

    it('does NOT skip after an invalidation', async () => {
        await sql`
            INSERT INTO media_item_stage_state
                (media_item_id, stage_id, processing_version, status, completed_at, invalidated_at)
            VALUES (${seriesId}::uuid, 'series-sync', 1, 'pending',
                    now() - interval '1 hour', now())
        `;
        expect(await seriesSyncIsFresh(sql, seriesId)).toBe(false);
    });

    it('does NOT skip with no stage row at all (fail open)', async () => {
        expect(await seriesSyncIsFresh(sql, seriesId)).toBe(false);
    });

    it('does NOT skip when the provider metadata is older than the window', async () => {
        await seedStageRow({ status: 'running', completedAt: new Date() });
        // DELETE + re-INSERT, not UPDATE: `update_provider_metadata_updated_at` is a
        // BEFORE UPDATE trigger that stamps now(), so this column cannot be backdated
        // by an UPDATE at all — an attempt to do so silently produces a FRESH row and
        // the test passes for the wrong reason. The trigger does not fire on INSERT.
        await sql`DELETE FROM provider_metadata WHERE media_id = ${seriesId}::uuid`;
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
            VALUES (${seriesId}::uuid, 'tmdb', '{}'::jsonb, now(), now() - interval '7 hours')
        `;
        expect(await seriesSyncIsFresh(sql, seriesId)).toBe(false);
    });

    it('does NOT skip when a new episode appeared below it', async () => {
        await seedStageRow({ status: 'running', completedAt: new Date() });
        const [season] = await sql<{ id: string }[]>`
            SELECT id FROM media_items WHERE parent_id = ${seriesId}::uuid LIMIT 1
        `;
        await sql`
            INSERT INTO media_items (title, media_type, parent_id, created_at)
            VALUES ('E2 (just aired)', 'episode', ${season.id}::uuid, now())
        `;
        expect(await seriesSyncIsFresh(sql, seriesId)).toBe(false);
    });

    it('does NOT skip when a new FILE appeared below it', async () => {
        await seedStageRow({ status: 'running', completedAt: new Date() });
        const [ep] = await sql<{ id: string }[]>`
            SELECT e.id FROM media_items e JOIN media_items s ON e.parent_id = s.id
             WHERE s.parent_id = ${seriesId}::uuid LIMIT 1
        `;
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, is_missing, created_at, updated_at)
            VALUES ('/media/sb-e1.mkv', false, now(), now()) RETURNING id
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${file.id}::uuid, ${ep.id}::uuid)
        `;
        expect(await seriesSyncIsFresh(sql, seriesId)).toBe(false);
    });
});
