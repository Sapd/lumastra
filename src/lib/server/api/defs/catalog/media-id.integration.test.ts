// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Def-level integration test for `buildMediaDetail` (media-id.ts).
 *
 * `media-id.test.ts` covers the JS shape against a `fakeSql` stub that
 * intercepts the tagged template and returns a canned row — it never runs the
 * real SQL, so it cannot prove the `?include=user` per-user query actually
 * reads the watchlist correctly. This test calls `buildMediaDetail` against
 * the real test database, seeded only through `upsertWatchlistItem` (the
 * real write path), and proves the def is genuinely wired to
 * `watchlistExistsFragment` (`builders/watchlist-exists.builder.ts`) — not
 * just shaped to expect an `in_watchlist` field.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../../tests/integration/helpers/cleanup.js';
import { createTestUser } from '../../../../../../tests/integration/helpers/users.js';
import { toUserId } from '$lib/shared/user-id.js';
import { upsertWatchlistItem } from '$lib/server/database/queries/watchlist.queries.js';
import { getWatchlistPlaylistId } from '$lib/server/database/queries/watchlist-playlist.queries.js';
import { buildMediaDetail } from './media-id.js';

const TABLES = ['playlist_items', 'playlists', 'media_items', 'user_profiles', 'users'];

describe('buildMediaDetail — ?include=user wiring (real DB)', () => {
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

    it('reports inWatchlist: true for an item added via upsertWatchlistItem, unaffected by a fan-out row', async () => {
        const user = await createTestUser(sql);
        const [media] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status)
            VALUES ('movie', 'Media Detail Fixture', 'active')
            RETURNING id::text AS id
        `;

        await upsertWatchlistItem(sql, toUserId(user.id), media.id);
        const playlistId = await getWatchlistPlaylistId(sql, toUserId(user.id));
        // Stray same-media/different-season row — legal under
        // idx_playlist_items_unique_media, must not affect the boolean.
        await sql`
            INSERT INTO playlist_items (playlist_id, media_id, season_number, episode_number, title, position)
            VALUES (${playlistId!}, ${media.id}::uuid, 1, NULL, 'Media Detail Fixture', 99)
        `;

        const body = await buildMediaDetail(sql, media.id, 'v1', 'user', user.id);
        expect(body).not.toBeNull();
        const userField = (body as Record<string, unknown>).user as
            { inWatchlist?: boolean } | undefined;
        expect(userField?.inWatchlist).toBe(true);
    });

    it('reports inWatchlist: false for an item never watchlisted', async () => {
        const user = await createTestUser(sql);
        const [media] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status)
            VALUES ('movie', 'Never Watchlisted Fixture', 'active')
            RETURNING id::text AS id
        `;

        const body = await buildMediaDetail(sql, media.id, 'v1', 'user', user.id);
        expect(body).not.toBeNull();
        const userField = (body as Record<string, unknown>).user as
            { inWatchlist?: boolean } | undefined;
        expect(userField?.inWatchlist).toBe(false);
    });

    it("reports inWatchlist: false for a DIFFERENT user's watchlisted item (no cross-user leak)", async () => {
        const owner = await createTestUser(sql);
        const viewer = await createTestUser(sql);
        const [media] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status)
            VALUES ('movie', 'Cross User Fixture', 'active')
            RETURNING id::text AS id
        `;
        await upsertWatchlistItem(sql, toUserId(owner.id), media.id);

        const body = await buildMediaDetail(sql, media.id, 'v1', 'user', viewer.id);
        const userField = (body as Record<string, unknown>).user as
            { inWatchlist?: boolean } | undefined;
        expect(userField?.inWatchlist).toBe(false);
    });
});
