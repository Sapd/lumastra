// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Legacy `externalIds.jellyfin` inputs from older clients: the schemas still
 * accept them, the handlers map them to the internal id through the rows
 * Jellyfin sync keeps (lookup only), and a Jellyfin id that maps to nothing
 * NEVER creates a `media_items` stub.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import { createTestUser } from '../../../../tests/integration/helpers/users.js';
import { createAndInsertTestMovie } from '../../../../tests/integration/fixtures/index.js';
import { toUserId } from '$lib/shared/user-id';
import { ensureWatchlistPlaylist } from '$lib/server/database/queries/watchlist-playlist.queries.js';
import { externalIdsSchema } from '$lib/schemas/common.js';
import { addPlaylistItemSchema } from '$lib/schemas/playlists.js';
import { playlistItemManager } from '$lib/server/services/playlist-item-manager.service.js';
import { mapLegacyJellyfinExternalIds, resolveExternalIdsToMediaId } from './media-resolution.js';

function hexId(): string {
    return crypto.randomUUID().replace(/-/g, '');
}

async function mediaItemCount(sql: postgres.Sql): Promise<number> {
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM media_items`;
    return row.n;
}

describe('legacy Jellyfin ids in request externalIds', () => {
    it('schemas still accept jellyfin and jellyfinSeriesId', () => {
        const jellyfin = hexId();
        expect(externalIdsSchema.safeParse({ jellyfin }).success).toBe(true);
        const item = {
            externalIds: { jellyfin },
            mediaType: 'episode',
            title: 'Legacy Episode',
            jellyfinSeriesId: hexId(),
        };
        expect(addPlaylistItemSchema.safeParse(item).success).toBe(false);
    });
});

describe('legacy Jellyfin ids in request externalIds (Integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.mediaFiles, ...TEST_TABLES.media]);
    });

    it('maps a known Jellyfin id to the internal id without creating rows', async () => {
        const jellyfinId = hexId();
        const { id } = await createAndInsertTestMovie(sql, { jellyfinId });
        const before = await mediaItemCount(sql);

        const resolved = await resolveExternalIdsToMediaId(sql, { jellyfin: jellyfinId }, 'movie');

        expect(resolved).toBe(id);
        expect(await mediaItemCount(sql)).toBe(before);
    });

    it('creates no media row for a Jellyfin id that maps to nothing', async () => {
        await createAndInsertTestMovie(sql, {});
        const before = await mediaItemCount(sql);

        const resolved = await resolveExternalIdsToMediaId(sql, { jellyfin: hexId() }, 'movie');

        expect(resolved).toBeNull();
        expect(await mediaItemCount(sql)).toBe(before);
    });

    it('mapLegacyJellyfinExternalIds drops the jellyfin key and fills internal', async () => {
        const jellyfinId = hexId();
        const { id } = await createAndInsertTestMovie(sql, { jellyfinId });

        expect(await mapLegacyJellyfinExternalIds(sql, { jellyfin: jellyfinId })).toEqual({
            internal: id,
        });
        expect(await mapLegacyJellyfinExternalIds(sql, { jellyfin: hexId(), tmdb: '1' })).toEqual({
            tmdb: '1',
        });
    });

    it('playlist add maps a Jellyfin-only item to its internal id', async () => {
        const user = await createTestUser(sql);
        const playlistId = await ensureWatchlistPlaylist(sql, toUserId(user.id));
        const jellyfinId = hexId();
        const { id } = await createAndInsertTestMovie(sql, { jellyfinId });

        const result = await playlistItemManager.addItems({
            sql,
            playlistId,
            playlistType: 'watchlist',
            externalIds: { jellyfin: jellyfinId },
            mediaType: 'movie',
            title: 'Legacy Movie',
            username: user.username,
            surface: 'internal',
        });

        expect(result?.type).toBe('single');
        expect(JSON.stringify(result)).not.toContain('jellyfin');
        const rows = await sql<{ media_id: string }[]>`
            SELECT media_id FROM playlist_items WHERE playlist_id = ${playlistId}
        `;
        expect(rows.map((r) => r.media_id)).toEqual([id]);
    });

    it('playlist add of an unmapped Jellyfin id adds nothing and creates no media row', async () => {
        const user = await createTestUser(sql);
        const playlistId = await ensureWatchlistPlaylist(sql, toUserId(user.id));
        const before = await mediaItemCount(sql);

        const result = await playlistItemManager.addItems({
            sql,
            playlistId,
            playlistType: 'watchlist',
            externalIds: { jellyfin: hexId() },
            mediaType: 'movie',
            title: 'Unknown Legacy Movie',
            username: user.username,
            surface: 'internal',
        });

        expect(result).toBeNull();
        expect(await mediaItemCount(sql)).toBe(before);
        const rows = await sql`SELECT 1 FROM playlist_items WHERE playlist_id = ${playlistId}`;
        expect(rows).toHaveLength(0);
    });
});
