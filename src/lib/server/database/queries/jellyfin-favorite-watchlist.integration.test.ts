// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import { createTestUser } from '../../../../../tests/integration/helpers/users.js';
import { toUserId } from '$lib/shared/user-id';
import { upsertWatchlistItem } from './watchlist.queries.js';
import { getWatchlistPlaylistId } from './watchlist-playlist.queries.js';
import { browseMediaItems } from './jellyfin-browse.queries.js';
import { unrestrictedAccess } from './builders/media-access-boundary.js';
import type postgres from 'postgres';

const TABLES = [
    'media_file_items',
    'media_files',
    'playlist_items',
    'playlists',
    'media_items',
    'user_profiles',
    'users',
];

describe('/j IsFavorite reads the watchlist playlist without fanning out', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TABLES);
    });

    it('counts a watchlisted item exactly once even with a stray season row', async () => {
        const user = await createTestUser(sql);
        const [media] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status)
            VALUES ('movie', 'Fanout Probe', 'active')
            RETURNING id::text AS id
        `;

        await upsertWatchlistItem(sql, toUserId(user.id), media.id);
        const playlistId = await getWatchlistPlaylistId(sql, toUserId(user.id));

        // A second row for the SAME media under a different season key is legal
        // under idx_playlist_items_unique_media. A join-based IsFavorite would
        // return this item twice; a semi-join must not.
        await sql`
            INSERT INTO playlist_items (playlist_id, media_id, season_number, episode_number, title, position)
            VALUES (${playlistId!}, ${media.id}::uuid, 1, NULL, 'Fanout Probe', 99)
        `;

        const [{ count }] = await sql<{ count: string }[]>`
            SELECT COUNT(*)::text AS count
            FROM media_items mi
            WHERE mi.id = ${media.id}::uuid
              AND EXISTS (
                  SELECT 1 FROM playlist_items wpi
                  JOIN playlists wp ON wp.id = wpi.playlist_id
                  WHERE wpi.media_id = mi.id
                    AND wp.user_id = ${user.id}::uuid
                    AND wp.playlist_type = 'watchlist'
              )
        `;
        expect(count).toBe('1');
    });

    // Extra end-to-end evidence (beyond the brief's pinned-SQL test above):
    // exercises the real exported `browseMediaItems` function with
    // isFavoriteFilter: true, seeded ONLY via the playlist-based
    // `upsertWatchlistItem` (Task 4's write path). Before Task 5's rewrite,
    // `browseMediaItems` still read the old `user_watchlist` table, which
    // Task 4 stopped writing to — so this reproduces the exact staleness bug
    // described in the task brief, plus (with the stray season row) the
    // fan-out risk of a naive JOIN rewrite.
    it('browseMediaItems sees a playlist-seeded watchlist item exactly once', async () => {
        const user = await createTestUser(sql);
        const [media] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files)
            VALUES ('movie', 'Fanout Probe E2E', 'active', true)
            RETURNING id::text AS id
        `;
        const [fileRow] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES ('/movies/fanout-probe-e2e.mkv') RETURNING id
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${fileRow.id}::uuid, ${media.id}::uuid)
        `;

        await upsertWatchlistItem(sql, toUserId(user.id), media.id);
        const playlistId = await getWatchlistPlaylistId(sql, toUserId(user.id));

        // Stray same-media/different-season row, legal under
        // idx_playlist_items_unique_media — must not duplicate the result.
        await sql`
            INSERT INTO playlist_items (playlist_id, media_id, season_number, episode_number, title, position)
            VALUES (${playlistId!}, ${media.id}::uuid, 1, NULL, 'Fanout Probe E2E', 99)
        `;

        const result = await browseMediaItems(sql, {
            mediaTypes: ['movie'],
            parentId: null,
            searchTerm: null,
            genres: [],
            years: [],
            nameStartsWith: null,
            isFavoriteFilter: true,
            isPlayedFilter: false,
            isUnplayedFilter: false,
            enableUserData: false,
            userId: toUserId(user.id),
            idList: [],
            sortBy: 'SortName',
            sortOrder: 'Ascending',
            limit: 10,
            startIndex: 0,
            access: unrestrictedAccess(),
        });

        expect(result.totalCount).toBe(1);
        expect(result.rows.length).toBe(1);
        expect(result.rows[0].is_favorite).toBe(true);
    });
});
