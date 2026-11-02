// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Task 4 cutover test (watchlist-as-system-playlist project): asserts
 * `upsertWatchlistItem`/`deleteWatchlistItem` (`watchlist.queries.ts`) write
 * into the caller's watchlist playlist's `playlist_items` rows rather than
 * the legacy `user_watchlist` table.
 *
 * Despite the filename this file was born with
 * (`watchlist-manager.service.integration.test.ts`, under `services/`), it
 * never references `WatchlistManager` — every call here drives the query
 * functions in `database/queries/watchlist.queries.ts` directly. Renamed and
 * relocated to sit next to the module it actually tests (review finding,
 * Task 4 fix pass). This is intentionally narrower and more redundant with
 * `watchlist.queries.integration.test.ts` than a fresh file would be — it
 * stays because it was the brief's Step 1 RED/GREEN test for the cutover
 * itself and is cheap to keep passing.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import { createTestUser } from '../../../../../tests/integration/helpers/users.js';
import { toUserId } from '$lib/shared/user-id';
import {
    upsertWatchlistItem,
    deleteWatchlistItem,
} from '$lib/server/database/queries/watchlist.queries.js';
import { getWatchlistPlaylistId } from '$lib/server/database/queries/watchlist-playlist.queries.js';
import type postgres from 'postgres';

describe('watchlist writes land in the watchlist playlist', () => {
    let sql: postgres.Sql;
    let mediaId: string;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        // Clears the LAST test's media row too — `beforeEach` only cleans up
        // what the PREVIOUS test left, so without this the final test's
        // insert survives the file. This integration DB is shared across
        // five more tasks' test runs, so nothing here should outlive the file.
        await truncateTables(sql, ['playlists', 'playlist_items', 'media_items', 'external_ids']);
        await closeTestDb();
    });

    // Fresh media row per test (rather than one shared `beforeAll` row) so
    // truncating `media_items` between tests can't leave a stale FK target
    // for a test that hasn't run yet, and so nothing from this file survives
    // it — this integration DB is shared across five more tasks' test runs.
    beforeEach(async () => {
        await truncateTables(sql, ['playlists', 'playlist_items', 'media_items', 'external_ids']);
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status)
            VALUES ('movie', 'Cutover Test Movie', 'active')
            RETURNING id::text AS id
        `;
        mediaId = row.id;
    });

    it('creates the playlist on first add and reports inserted', async () => {
        const user = await createTestUser(sql);
        const rows = await upsertWatchlistItem(sql, toUserId(user.id), mediaId);

        expect(rows).toHaveLength(1);
        expect(rows[0].inserted).toBe(true);

        const playlistId = await getWatchlistPlaylistId(sql, toUserId(user.id));
        expect(playlistId).not.toBeNull();

        const items = await sql<{ season_number: number | null }[]>`
            SELECT season_number FROM playlist_items WHERE playlist_id = ${playlistId!}
        `;
        expect(items).toHaveLength(1);
        expect(items[0].season_number).toBeNull();
    });

    it('reports inserted=false on a repeat add and does not duplicate', async () => {
        const user = await createTestUser(sql);
        await upsertWatchlistItem(sql, toUserId(user.id), mediaId);
        const again = await upsertWatchlistItem(sql, toUserId(user.id), mediaId);

        expect(again[0].inserted).toBe(false);

        const playlistId = await getWatchlistPlaylistId(sql, toUserId(user.id));
        const [{ count }] = await sql<{ count: string }[]>`
            SELECT COUNT(*)::text AS count FROM playlist_items WHERE playlist_id = ${playlistId!}
        `;
        expect(count).toBe('1');
    });

    it('removes the row', async () => {
        const user = await createTestUser(sql);
        await upsertWatchlistItem(sql, toUserId(user.id), mediaId);
        const deleted = await deleteWatchlistItem(sql, toUserId(user.id), mediaId);

        expect(deleted).toHaveLength(1);

        const playlistId = await getWatchlistPlaylistId(sql, toUserId(user.id));
        const [{ count }] = await sql<{ count: string }[]>`
            SELECT COUNT(*)::text AS count FROM playlist_items WHERE playlist_id = ${playlistId!}
        `;
        expect(count).toBe('0');
    });
});
