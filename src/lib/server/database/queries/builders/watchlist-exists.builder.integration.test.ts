// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the shared `watchlistExistsFragment` builder.
 *
 * All seven call sites (`jellyfin-browse.queries.ts` x3, `jellyfin-item-detail.
 * queries.ts` x1, and the three catalog per-item detail defs) now compose this
 * one predicate instead of five/six near-identical hand-written EXISTS blocks,
 * so covering it here covers all of them for the underlying SQL shape.
 *
 * `mediaIdExpr` has two real shapes in the callers:
 *   - a raw column reference (`` sql`mi.id` ``) — jellyfin-browse /
 *     jellyfin-item-detail, which already select FROM media_items AS mi.
 *   - a bound parameter (`` sql`${internalId}::uuid` ``) — the three catalog
 *     defs, which have no media_items row in scope (`FROM (SELECT 1) as dummy`).
 * Both are exercised below, against the SAME seeded fan-out-prone data.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../../tests/integration/helpers/cleanup.js';
import { createTestUser } from '../../../../../../tests/integration/helpers/users.js';
import { toUserId } from '$lib/shared/user-id';
import { upsertWatchlistItem } from '../watchlist.queries.js';
import { getWatchlistPlaylistId } from '../watchlist-playlist.queries.js';
import { watchlistExistsFragment } from './watchlist-exists.builder.js';

const TABLES = ['playlist_items', 'playlists', 'media_items', 'user_profiles', 'users'];

describe('watchlistExistsFragment', () => {
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

    /** Seeds a user + watchlisted media item, plus a stray same-media/different-season row. */
    async function seedWatchlistedItemWithFanoutRow(): Promise<{
        userId: string;
        mediaId: string;
    }> {
        const user = await createTestUser(sql);
        const [media] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status)
            VALUES ('movie', 'Fragment Fixture', 'active')
            RETURNING id::text AS id
        `;
        await upsertWatchlistItem(sql, toUserId(user.id), media.id);
        const playlistId = await getWatchlistPlaylistId(sql, toUserId(user.id));

        // Legal under idx_playlist_items_unique_media: same (playlist_id, media_id),
        // different season_number. A JOIN-based predicate would double-count this.
        await sql`
            INSERT INTO playlist_items (playlist_id, media_id, season_number, episode_number, title, position)
            VALUES (${playlistId!}, ${media.id}::uuid, 1, NULL, 'Fragment Fixture', 99)
        `;

        return { userId: user.id, mediaId: media.id };
    }

    it('column-mode: true for a watchlisted item, without duplicating on the fan-out row', async () => {
        const { userId, mediaId } = await seedWatchlistedItemWithFanoutRow();

        const rows = await sql<{ result: boolean }[]>`
            SELECT ${watchlistExistsFragment(sql, sql`mi.id`, sql`${userId}::uuid`)} as result
            FROM media_items mi
            WHERE mi.id = ${mediaId}::uuid
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0].result).toBe(true);
    });

    it('value-mode: true for a watchlisted item, without duplicating on the fan-out row', async () => {
        const { userId, mediaId } = await seedWatchlistedItemWithFanoutRow();

        const rows = await sql<{ result: boolean }[]>`
            SELECT ${watchlistExistsFragment(sql, sql`${mediaId}::uuid`, sql`${userId}::uuid`)} as result
            FROM (SELECT 1) as dummy
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0].result).toBe(true);
    });

    it('false for a different user (no cross-user leak)', async () => {
        const { mediaId } = await seedWatchlistedItemWithFanoutRow();
        const otherUser = await createTestUser(sql);

        const rows = await sql<{ result: boolean }[]>`
            SELECT ${watchlistExistsFragment(sql, sql`mi.id`, sql`${otherUser.id}::uuid`)} as result
            FROM media_items mi
            WHERE mi.id = ${mediaId}::uuid
        `;
        expect(rows[0].result).toBe(false);
    });

    it('false (not a crash) for a null userId — the browse call sites pass `userId ?? null`', async () => {
        const { mediaId } = await seedWatchlistedItemWithFanoutRow();

        const rows = await sql<{ result: boolean }[]>`
            SELECT ${watchlistExistsFragment(sql, sql`mi.id`, sql`${null}::uuid`)} as result
            FROM media_items mi
            WHERE mi.id = ${mediaId}::uuid
        `;
        expect(rows[0].result).toBe(false);
    });

    it('false for an item never added to the watchlist', async () => {
        const user = await createTestUser(sql);
        const [media] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status)
            VALUES ('movie', 'Never Watchlisted', 'active')
            RETURNING id::text AS id
        `;

        const rows = await sql<{ result: boolean }[]>`
            SELECT ${watchlistExistsFragment(sql, sql`mi.id`, sql`${user.id}::uuid`)} as result
            FROM media_items mi
            WHERE mi.id = ${media.id}::uuid
        `;
        expect(rows[0].result).toBe(false);
    });
});
