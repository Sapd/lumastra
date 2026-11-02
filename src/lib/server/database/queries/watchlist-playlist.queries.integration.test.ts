// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll } from 'vitest';
import { getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { createTestUser } from '../../../../../tests/integration/helpers/users.js';
import { toUserId } from '$lib/shared/user-id';
import {
    ensureWatchlistPlaylist,
    getWatchlistPlaylistId,
    WATCHLIST_PLAYLIST_NAME,
} from './watchlist-playlist.queries.js';
import type postgres from 'postgres';

describe('watchlist playlist resolution', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    it('returns null before the playlist exists', async () => {
        const user = await createTestUser(sql);
        expect(await getWatchlistPlaylistId(sql, toUserId(user.id))).toBeNull();
    });

    it('creates the playlist once and returns the same id', async () => {
        const user = await createTestUser(sql);
        const first = await ensureWatchlistPlaylist(sql, toUserId(user.id));
        const second = await ensureWatchlistPlaylist(sql, toUserId(user.id));
        expect(first).toBe(second);

        const rows = await sql<{ name: string; is_system: boolean; visibility: string }[]>`
            SELECT name, is_system, visibility FROM playlists WHERE id = ${first}
        `;
        expect(rows[0].name).toBe(WATCHLIST_PLAYLIST_NAME);
        expect(rows[0].is_system).toBe(true);
        expect(rows[0].visibility).toBe('private');
    });

    it('survives concurrent callers without a unique violation', async () => {
        const user = await createTestUser(sql);
        const ids = await Promise.all([
            ensureWatchlistPlaylist(sql, toUserId(user.id)),
            ensureWatchlistPlaylist(sql, toUserId(user.id)),
            ensureWatchlistPlaylist(sql, toUserId(user.id)),
        ]);
        expect(new Set(ids).size).toBe(1);
    });
});
