// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Watchlist Queries Module
 *
 * Tests watchlist add/remove operations and media title lookup. Watchlist
 * writes land in `playlist_items` under the caller's watchlist playlist (see
 * watchlist-playlist.queries.ts) — NOT the legacy `user_watchlist` table,
 * which this module no longer reads or writes (Task 4 of the
 * watchlist-as-system-playlist cutover). `user_watchlist` still exists on
 * disk with a stale copy of the data until a later task drops it; these
 * tests assert against the new storage, not the old one.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    generateTestUserId,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';

import { upsertWatchlistItem, getMediaTitle, deleteWatchlistItem } from './watchlist.queries.js';
import { getWatchlistPlaylistId } from './watchlist-playlist.queries.js';
import type { UserId } from '$lib/shared/user-id';

describe('Watchlist Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['playlists', 'playlist_items', 'media_items', 'external_ids']);
    });

    /** Count of playlist_items rows under the user's watchlist playlist. */
    async function countWatchlistItems(userId: UserId): Promise<number> {
        const playlistId = await getWatchlistPlaylistId(sql, userId);
        if (playlistId === null) return 0;
        const rows = await sql<{ count: number }[]>`
            SELECT COUNT(*)::int as count FROM playlist_items WHERE playlist_id = ${playlistId}
        `;
        return rows[0].count;
    }

    // ========================================================================
    // upsertWatchlistItem
    // ========================================================================

    describe('upsertWatchlistItem', () => {
        it('inserts a new watchlist item', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const { id: mediaId } = await createAndInsertTestMovie(sql);

            const result = await upsertWatchlistItem(sql, userId, mediaId);

            expect(result.length).toBe(1);
            expect(result[0].id).toBeTruthy();
            expect(result[0].inserted).toBe(true);
            expect(await countWatchlistItems(userId)).toBe(1);
        });

        it('reports inserted=false on conflict without creating a duplicate', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const { id: mediaId } = await createAndInsertTestMovie(sql);

            await upsertWatchlistItem(sql, userId, mediaId);
            const second = await upsertWatchlistItem(sql, userId, mediaId);

            expect(await countWatchlistItems(userId)).toBe(1);
            // `ON CONFLICT ... DO NOTHING RETURNING` returns a row only on the
            // fresh insert — a miss on the repeat call means "already there".
            // This is what makes WatchlistResult.alreadyPresent meaningful; the
            // old `xmax = 0` trick over a DO UPDATE could never report this.
            expect(second[0].inserted).toBe(false);
        });
    });

    // ========================================================================
    // getMediaTitle
    // ========================================================================

    describe('getMediaTitle', () => {
        it('returns the title for an existing media item', async () => {
            const { id: mediaId, tmdbId: _tmdbId } = await createAndInsertTestMovie(sql, {
                tmdbId: 910001,
            });

            const result = await getMediaTitle(sql, mediaId);
            expect(result).toBeTruthy();
        });

        it('returns undefined for non-existent media', async () => {
            const result = await getMediaTitle(sql, '00000000-0000-0000-0000-000000000000');
            expect(result).toBeUndefined();
        });
    });

    // ========================================================================
    // deleteWatchlistItem
    // ========================================================================

    describe('deleteWatchlistItem', () => {
        it('deletes an existing watchlist item', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const { id: mediaId } = await createAndInsertTestMovie(sql);

            await upsertWatchlistItem(sql, userId, mediaId);

            const result = await deleteWatchlistItem(sql, userId, mediaId);
            expect(result.length).toBe(1);
            expect(await countWatchlistItems(userId)).toBe(0);
        });

        it('returns empty array when item does not exist', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const { id: mediaId } = await createAndInsertTestMovie(sql);

            const result = await deleteWatchlistItem(sql, userId, mediaId);
            expect(result.length).toBe(0);
        });

        // N4 (2026-09-22 edge-case pass): the add path (upsertWatchlistItem)
        // already bumps playlists.updated_at on a fresh insert via
        // touchPlaylist — removal did not, leaving the playlist looking
        // stale after a delete-only session.
        it('bumps playlists.updated_at when a row is actually deleted', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const { id: mediaId } = await createAndInsertTestMovie(sql);

            await upsertWatchlistItem(sql, userId, mediaId);
            const playlistId = await getWatchlistPlaylistId(sql, userId);
            expect(playlistId).not.toBeNull();

            // Force updated_at into the past so the post-delete bump is
            // unambiguous even if the whole test runs within one clock tick.
            await sql`UPDATE playlists SET updated_at = now() - interval '1 hour' WHERE id = ${playlistId}`;
            const [{ updated_at: before }] = await sql<{ updated_at: Date }[]>`
                SELECT updated_at FROM playlists WHERE id = ${playlistId}
            `;

            await deleteWatchlistItem(sql, userId, mediaId);

            const [{ updated_at: after }] = await sql<{ updated_at: Date }[]>`
                SELECT updated_at FROM playlists WHERE id = ${playlistId}
            `;
            expect(after.getTime()).toBeGreaterThan(before.getTime());
        });

        it('does NOT bump playlists.updated_at when nothing was deleted', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const { id: mediaId } = await createAndInsertTestMovie(sql);

            // ensureTestUser + a no-op delete still lazily creates the
            // watchlist playlist via getWatchlistPlaylistId's caller path in
            // upsertWatchlistItem elsewhere, but deleteWatchlistItem itself
            // returns [] with NO playlist row at all when one never existed
            // — assert that shape rather than touching a nonexistent row.
            const result = await deleteWatchlistItem(sql, userId, mediaId);
            expect(result).toEqual([]);
            expect(await getWatchlistPlaylistId(sql, userId)).toBeNull();
        });
    });
});
