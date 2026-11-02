// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `audiobookshelf-sync.execute()` against a LIVE AudiobookShelf server.
 *
 * Skipped unless `AUDIOURL`, `AUDIOAPIKEY` and `AUDIOBOOKSHELF_TEST_LIBRARY_ID`
 * are set. Point the library id at a SMALL library.
 *
 * The loader is covered by `audiobookshelf-sync.integration.test.ts`. What only a
 * real run can establish is that `execute()` hands the media source a WORKING
 * context: it deliberately builds `buildPluginContext(AUDIOBOOKSHELF_SOURCE_ID)`
 * instead of passing its own `ctx`, and a context assembled for the wrong plugin
 * id type-checks perfectly while silently resolving the wrong `plugin_settings`
 * row and — if the `database` capability gate misses — handing the sweep a
 * throwing `sql` stub.
 *
 * Run: AUDIOURL=… AUDIOAPIKEY=… AUDIOBOOKSHELF_TEST_LIBRARY_ID=… \
 *   npm run test:integration \
 *   src/lib/server/tasks/builtin/native/audiobookshelf-sync.live.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';

const BASE_URL = process.env.AUDIOURL ?? '';
const API_KEY = process.env.AUDIOAPIKEY ?? '';
const ABS_LIBRARY_ID = process.env.AUDIOBOOKSHELF_TEST_LIBRARY_ID ?? '';
const LIVE = Boolean(BASE_URL && API_KEY && ABS_LIBRARY_ID);

const GROUP_ID = '00000000-0000-0000-0000-0000000abe00';
const PATH_ID = '00000000-0000-0000-0000-0000000abe01';

const configMock = vi.hoisted(() => ({ AUDIOURL: '', AUDIOAPIKEY: '' }));
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        get config() {
            return { ...(actual.config as object), ...configMock };
        },
    };
});

const suite = LIVE ? describe : describe.skip;

suite('audiobookshelf-sync execute (live)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        configMock.AUDIOURL = BASE_URL;
        configMock.AUDIOAPIKEY = API_KEY;
        sql = await getTestDb();

        await sql`
            INSERT INTO library_groups (id, name)
            VALUES (${GROUP_ID}, 'Audiobooks (live sync test)')
            ON CONFLICT (id) DO NOTHING
        `;
        await sql`DELETE FROM library_paths WHERE id = ${PATH_ID}`;
        await sql`
            INSERT INTO library_paths (id, path, media_type, language, provider, provider_path, library_group_id, enabled)
            VALUES (${PATH_ID}, ${`abs://${ABS_LIBRARY_ID}`}, 'audiobook', 'de', 'audiobookshelf',
                    ${ABS_LIBRARY_ID}, ${GROUP_ID}, true)
        `;
    }, 60_000);

    afterAll(async () => {
        await sql`
            DELETE FROM media_items
            WHERE library_group_id = ${GROUP_ID} AND media_type = 'audiobook'
        `;
        await sql`DELETE FROM library_paths WHERE id = ${PATH_ID}`;
        await sql`DELETE FROM library_groups WHERE id = ${GROUP_ID}`;
        await sql`DELETE FROM plugin_settings WHERE plugin_id = 'audiobookshelf-media-source'`;
        await closeTestDb();
    }, 60_000);

    it('ingests real books through the task, reporting counters', async () => {
        const { audiobookshelfSyncTask } = await import('./audiobookshelf-sync.js');
        const { buildPluginContext } = await import('../../plugin-context.js');

        // A real task context for THIS task, exactly as the runner would build it.
        const ctx = buildPluginContext(audiobookshelfSyncTask.id, { sql });
        const result = await audiobookshelfSyncTask.execute({
            ...ctx,
            input: { libraryPathId: PATH_ID },
        } as unknown as Parameters<typeof audiobookshelfSyncTask.execute>[0]);

        expect(result.success).toBe(true);

        // Real ingest, not a no-op: the counters must add up to the rows that
        // actually landed. A context whose `sql` was a throwing stub, or whose
        // settings resolved empty, would surface here as zero rows.
        const [{ n }] = await sql<{ n: number }[]>`
            SELECT COUNT(*)::int AS n
            FROM media_items
            WHERE library_group_id = ${GROUP_ID} AND media_type = 'audiobook'
        `;
        expect(n).toBeGreaterThan(0);
        expect(result.itemsProcessed).toBeGreaterThan(0);

        const counters = result.result as Record<string, unknown>;
        expect(counters.added).toBe(n);
        expect(counters.errors).toEqual([]);
    }, 600_000);

    it('is idempotent — a second run adds nothing', async () => {
        const { audiobookshelfSyncTask } = await import('./audiobookshelf-sync.js');
        const { buildPluginContext } = await import('../../plugin-context.js');

        const [{ n: before }] = await sql<{ n: number }[]>`
            SELECT COUNT(*)::int AS n
            FROM media_items
            WHERE library_group_id = ${GROUP_ID} AND media_type = 'audiobook'
        `;

        const ctx = buildPluginContext(audiobookshelfSyncTask.id, { sql });
        const result = await audiobookshelfSyncTask.execute({
            ...ctx,
            input: { libraryPathId: PATH_ID },
        } as unknown as Parameters<typeof audiobookshelfSyncTask.execute>[0]);

        const counters = result.result as Record<string, unknown>;
        expect(counters.added).toBe(0);
        // Crucially NOT `dismissed` — a reconcile that hid everything it had just
        // added would also report "added 0" on the second pass.
        expect(counters.dismissed).toBe(0);

        const [{ n: after }] = await sql<{ n: number }[]>`
            SELECT COUNT(*)::int AS n
            FROM media_items
            WHERE library_group_id = ${GROUP_ID} AND media_type = 'audiobook'
        `;
        expect(after).toBe(before);
    }, 600_000);
});
