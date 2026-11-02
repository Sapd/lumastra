// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';
import { getSetupJellyfinStatus, refreshSetupJellyfinCounts } from './onboarding.queries.js';
import { upsertTaskSettings } from './task-settings.queries.js';

describe('setup Jellyfin status (PostgreSQL)', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, 'task_history']);
        await sql`DELETE FROM plugin_settings WHERE plugin_id = 'jellyfin-setup-sync'`;
    });

    async function run(taskId: string, state: string, ageMinutes = 0): Promise<void> {
        await sql`
            INSERT INTO task_history (id, task_id, label, state, input, scope, trigger, actor, processing_version, started_at)
            VALUES (${crypto.randomUUID()}, ${taskId}, 'Jellyfin setup test', ${state}, '{}', '{}', '{}', '{}', '1', NOW() - ${ageMinutes} * INTERVAL '1 minute')
            RETURNING id
        `;
        const [latest] = await sql<
            { id: string }[]
        >`SELECT id FROM task_history WHERE task_id = ${taskId} ORDER BY started_at DESC LIMIT 1`;
        if (taskId === 'watch-sync-pull' || taskId === 'jellyfin-file-inventory')
            await upsertTaskSettings(sql, 'jellyfin-setup-sync', {
                [taskId === 'watch-sync-pull' ? 'pull-run' : 'inventory-run']: { runId: latest.id },
            });
    }

    it('reports zeros on an empty install', async () => {
        expect(await getSetupJellyfinStatus(sql)).toMatchObject({
            paired: 0,
            waiting: 0,
            syncing: false,
            failed: false,
        });
    });

    it('reads stored inventory counts instead of scanning the media catalog on every poll', async () => {
        await upsertTaskSettings(sql, 'jellyfin-setup-sync', { counts: { paired: 7, waiting: 3 } });
        expect(await getSetupJellyfinStatus(sql)).toMatchObject({ paired: 7, waiting: 3 });
        await createAndInsertTestMovie(sql, { withFileItem: true });
        expect(await getSetupJellyfinStatus(sql)).toMatchObject({ paired: 7, waiting: 3 });
    });

    it('has existing primary-key indexes for the stored run IDs and settings lookups', async () => {
        const rows = await sql<{ table_name: string; definition: string }[]>`
            SELECT indrelid::regclass::text AS table_name, pg_get_indexdef(indexrelid) AS definition
            FROM pg_index WHERE indisprimary
              AND indrelid IN ('task_history'::regclass, 'plugin_settings'::regclass)
        `;
        expect(rows.find((row) => row.table_name === 'task_history')?.definition).toContain('(id)');
        expect(rows.find((row) => row.table_name === 'plugin_settings')?.definition).toContain(
            '(plugin_id, key)',
        );
    });

    it('shows a persisted trigger failure without treating the saved connection as invalid', async () => {
        await upsertTaskSettings(sql, 'jellyfin-setup-sync', { 'kick-error': true });
        expect(await getSetupJellyfinStatus(sql)).toMatchObject({
            syncStarted: false,
            syncing: false,
        });
    });

    it('counts paired and unpaired file-backed movies and episodes, excluding discovery and containers', async () => {
        await createAndInsertTestMovie(sql, { withFileItem: true });
        for (const item of [
            createTestMediaItem({ media_type: 'movie', has_files: true }),
            createTestMediaItem({ media_type: 'episode', has_files: true }),
            createTestMediaItem({ media_type: 'movie', has_files: false }),
            createTestMediaItem({ media_type: 'tv' }),
            createTestMediaItem({ media_type: 'track', has_files: true }),
            createTestMediaItem({ media_type: 'movie', has_files: true, status: 'deleted' }),
        ])
            await insertTestMediaItem(sql, item);
        await refreshSetupJellyfinCounts(sql);
        expect(await getSetupJellyfinStatus(sql)).toMatchObject({
            paired: 1,
            waiting: 2,
            syncing: false,
            failed: false,
        });
    });

    it('tracks inventory then pull, and ignores older failed runs after a successful retry', async () => {
        await run('jellyfin-file-inventory', 'failed', 10);
        await run('jellyfin-file-inventory', 'active', 5);
        await run('unrelated-task', 'active');
        expect(await getSetupJellyfinStatus(sql)).toMatchObject({ syncing: true, failed: false });
        await sql`UPDATE task_history SET state = 'completed' WHERE task_id = 'jellyfin-file-inventory' AND state = 'active'`;
        await run('watch-sync-pull', 'pending');
        expect(await getSetupJellyfinStatus(sql)).toMatchObject({ syncing: true, failed: false });
        await sql`UPDATE task_history SET state = 'failed' WHERE task_id = 'watch-sync-pull'`;
        expect(await getSetupJellyfinStatus(sql)).toMatchObject({ syncing: false, failed: true });
        await run('watch-sync-pull', 'completed', -1);
        expect(await getSetupJellyfinStatus(sql)).toMatchObject({ syncing: false, failed: false });
    });

    it('treats cancellation as an automatic retry, not a failed sync', async () => {
        await run('jellyfin-file-inventory', 'cancelled');
        expect(await getSetupJellyfinStatus(sql)).toMatchObject({
            syncing: false,
            failed: false,
            retrying: true,
        });
    });

    it('does not show zombie runs past the hard timeout as syncing forever', async () => {
        await run('jellyfin-file-inventory', 'active', 31);
        await run('watch-sync-pull', 'active', 121);
        expect(await getSetupJellyfinStatus(sql)).toMatchObject({ syncing: false, retrying: true });
    });
});
