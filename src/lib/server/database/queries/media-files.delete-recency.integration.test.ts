// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * deleteStaleMediaFile reports which items lost the file, so callers can refresh
 * the recently-added recency of just those titles; and it takes the ancestor-
 * chain lock BEFORE it touches the file's rows (same order as the air-date
 * relink, which keeps the two from deadlocking over the same junction row).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { deleteStaleMediaFile, lockAncestorChain } from './media-files.queries.js';
import {
    refreshRecentlyAddedRecency,
    refreshRecentlyAddedRecencyForItems,
} from './browse.queries.js';

describe('deleteStaleMediaFile: affected items, recency and lock order', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    async function item(mediaType: string, parentId: string | null): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files, parent_id)
            VALUES (${mediaType}, 'Fixture', 'active', true, ${parentId}) RETURNING id`;
        return row.id;
    }

    // Only one link per item may be the default (idx_media_file_items_one_default).
    async function linkedFile(
        path: string,
        itemIds: string[],
        createdAt = '2026-01-01T00:00:00Z',
    ): Promise<void> {
        const [f] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, created_at, updated_at)
            VALUES (${path}, ${createdAt}::timestamptz, ${createdAt}::timestamptz) RETURNING id`;
        for (const itemId of itemIds) {
            const [other] = await sql<{ n: number }[]>`
                SELECT count(*)::int AS n FROM media_file_items WHERE media_item_id = ${itemId}`;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${f.id}, ${itemId}, ${other.n === 0})`;
        }
    }

    async function firstFileAt(id: string): Promise<string | null> {
        const [r] = await sql<{ first_file_at: Date | null }[]>`
            SELECT first_file_at FROM media_items WHERE id = ${id}`;
        return r?.first_file_at?.toISOString() ?? null;
    }

    it('returns the items the deleted file was linked to', async () => {
        const series = await item('tv', null);
        const season = await item('season', series);
        const ep1 = await item('episode', season);
        const ep2 = await item('episode', season);
        await linkedFile('/fixtures/double-episode.mkv', [ep1, ep2]);

        const result = await deleteStaleMediaFile(sql, '/fixtures/double-episode.mkv');

        expect(result.deleted).toBe(true);
        expect([...result.affectedItemIds].sort()).toEqual([ep1, ep2].sort());
    });

    it('reports nothing for a path with no row', async () => {
        await expect(deleteStaleMediaFile(sql, '/fixtures/never-ingested.mkv')).resolves.toEqual({
            deleted: false,
            affectedItemIds: [],
        });
    });

    it('lets the caller reset or move a title recency after removals', async () => {
        const series = await item('tv', null);
        const season = await item('season', series);
        const ep1 = await item('episode', season);
        const ep2 = await item('episode', season);
        await linkedFile('/fixtures/early.mkv', [ep1], '2026-01-01T00:00:00Z');
        await linkedFile('/fixtures/late.mkv', [ep2], '2026-02-01T00:00:00Z');
        await refreshRecentlyAddedRecency(sql);
        expect(await firstFileAt(series)).toBe('2026-01-01T00:00:00.000Z');

        // Earliest file removed: the title's recency moves to the survivor.
        const first = await deleteStaleMediaFile(sql, '/fixtures/early.mkv');
        await refreshRecentlyAddedRecencyForItems(sql, first.affectedItemIds);
        expect(await firstFileAt(series)).toBe('2026-02-01T00:00:00.000Z');

        // Last file removed: the (soft-dismissed) episode still resolves to its
        // title, whose recency is reset to NULL.
        const last = await deleteStaleMediaFile(sql, '/fixtures/late.mkv');
        await refreshRecentlyAddedRecencyForItems(sql, last.affectedItemIds);
        expect(await firstFileAt(series)).toBeNull();
    });

    it('locks the ancestor chain before it touches the file row', async () => {
        const series = await item('tv', null);
        const season = await item('season', series);
        const ep = await item('episode', season);
        await linkedFile('/fixtures/lock-order.mkv', [ep]);

        let releaseHolder!: () => void;
        const holderMayCommit = new Promise<void>((r) => (releaseHolder = r));
        let holderHolds!: () => void;
        const holderHoldsLock = new Promise<void>((r) => (holderHolds = r));
        const holder = sql.begin(async (tx) => {
            await lockAncestorChain(tx as unknown as postgres.Sql, [ep]);
            holderHolds();
            await holderMayCommit;
        });

        let deletion: Promise<unknown> | undefined;
        let fileRowLockedByDeleter: boolean | undefined;
        try {
            await holderHoldsLock;
            deletion = deleteStaleMediaFile(sql, '/fixtures/lock-order.mkv');

            // Wait until the deletion is parked on the chain lock.
            for (let i = 0; i < 200; i++) {
                const [row] = await sql<{ n: number }[]>`
                    SELECT count(*)::int AS n FROM pg_stat_activity
                    WHERE datname = current_database()
                      AND wait_event_type = 'Lock'
                      AND query LIKE '%FOR NO KEY UPDATE%'`;
                if (row.n > 0) break;
                if (i === 199) throw new Error('the deletion never blocked on the chain lock');
                await new Promise((r) => setTimeout(r, 20));
            }

            // If the deleter had already deleted the file row (old order), that row
            // would be locked and SKIP LOCKED would skip it.
            const rows = await sql`
                SELECT id FROM media_files WHERE file_path = '/fixtures/lock-order.mkv'
                FOR UPDATE SKIP LOCKED`;
            fileRowLockedByDeleter = rows.length === 0;
        } finally {
            releaseHolder();
        }
        await Promise.all([holder, deletion]);

        expect(fileRowLockedByDeleter).toBe(false);
    });
});
