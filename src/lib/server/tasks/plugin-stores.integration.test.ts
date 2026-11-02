// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real-Postgres coverage for `buildPlaylistStore(...).listOwned` — added
 * for Task 3 of the watchlist-as-system-playlist project.
 *
 * `plugin-stores.test.ts` mocks `sql` entirely and never exercises this
 * query, so the `AND p.is_system = false` filter that keeps a user's
 * watchlist out of every plugin's playlist store had no test that would
 * catch its removal. This file runs the real query against a real watchlist
 * row.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import { createTestUser } from '../../../../tests/integration/helpers/users.js';
import { toUserId } from '$lib/shared/user-id.js';
import { ensureWatchlistPlaylist } from '$lib/server/database/queries/watchlist-playlist.queries.js';
import { createAndInsertTestMovie } from '../../../../tests/integration/fixtures/index.js';
import { buildPlaylistStore } from './plugin-stores.js';

describe('buildPlaylistStore(...).listOwned', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    it('excludes the watchlist and includes an ordinary playlist for the same user', async () => {
        const user = await createTestUser(sql);
        const watchlistId = await ensureWatchlistPlaylist(sql, toUserId(user.id));
        const [{ id: ordinaryId }] = await sql<{ id: number }[]>`
            INSERT INTO playlists (user_id, name, visibility, playlist_type)
            VALUES (${user.id}::uuid, 'Ordinary', 'private', 'general')
            RETURNING id
        `;

        const owned = await buildPlaylistStore(sql, 'test-plugin').listOwned(user.id);
        const ids = owned.map((p) => p.id);

        expect(ids).not.toContain(watchlistId);
        expect(ids).toContain(ordinaryId);
    });
});

describe('buildPlaylistStore(...).replaceItems bumps playlists.revision', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    const revisionOf = async (id: number): Promise<number> => {
        const rows = await sql<{ revision: number }[]>`SELECT revision FROM playlists WHERE id = ${id}`;
        return rows[0].revision;
    };

    it('bumps once for a non-empty replacement and once for clearing', async () => {
        const user = await createTestUser(sql);
        const store = buildPlaylistStore(sql, 'rev-plugin');
        const playlistId = await store.create({ userId: toUserId(user.id), name: 'Plugin list' });
        const { id: movieId } = await createAndInsertTestMovie(sql, {});
        const start = await revisionOf(playlistId);

        expect(await store.replaceItems(playlistId, [movieId])).toBe(1);
        expect(await revisionOf(playlistId)).toBe(start + 1);

        expect(await store.replaceItems(playlistId, [])).toBe(0);
        expect(await revisionOf(playlistId)).toBe(start + 2);
    });

    it('does not touch the revision of a playlist the plugin did not create', async () => {
        const user = await createTestUser(sql);
        const [{ id }] = await sql<{ id: number }[]>`
            INSERT INTO playlists (user_id, name, visibility, playlist_type)
            VALUES (${user.id}::uuid, 'Mine', 'private', 'general')
            RETURNING id
        `;
        const before = await revisionOf(id);
        await expect(
            buildPlaylistStore(sql, 'rev-plugin').replaceItems(id, []),
        ).rejects.toThrow(/may not replace/);
        expect(await revisionOf(id)).toBe(before);
    });
});
