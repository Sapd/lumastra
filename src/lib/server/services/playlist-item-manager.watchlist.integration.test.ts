// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the watchlist no-expansion fork in
 * `PlaylistItemManager.addItems`.
 *
 * `playlist-kind-policy.test.ts` unit-tests `getPlaylistKindPolicy` and
 * `isMediaTypeAllowed` in isolation — it never calls `addItems`.
 * `playlist-item-manager.service.test.ts` calls `addItems`, but behind 47
 * `vi.mock` calls, so it only proves the mocks were invoked, not that the
 * right rows reached Postgres. Neither file would fail if the type gate
 * consulted the wrong policy, if either `&& policy.expandContainers` guard
 * were dropped, or if the season/episode gating on the single-item insert
 * were inverted.
 *
 * This file drives `addItems` against a real database with
 * `playlistType: 'watchlist'` and asserts on the actual `playlist_items`
 * rows it produces.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import { createTestUser } from '../../../../tests/integration/helpers/users.js';
import { createAndInsertTestSeries } from '../../../../tests/integration/fixtures/index.js';
import { toUserId } from '$lib/shared/user-id';
import { ensureWatchlistPlaylist } from '$lib/server/database/queries/watchlist-playlist.queries.js';
import { playlistItemManager } from './playlist-item-manager.service.js';

async function markAllEpisodesHasFiles(sql: postgres.Sql, seriesId: string): Promise<void> {
    await sql`
        UPDATE media_items SET has_files = true
        WHERE parent_id IN (SELECT id FROM media_items WHERE parent_id = ${seriesId}::uuid)
    `;
}

describe('PlaylistItemManager.addItems — watchlist fork (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        // Series in this file use fixed, explicit tmdb ids (not the fixture's
        // random SAMPLE_TV_SHOWS pick) so two series created in one test run
        // never collide — see media_items/external_ids truncation below,
        // which also keeps a rerun of this file from colliding with itself.
        await truncateTables(sql, [...TEST_TABLES.mediaFiles, ...TEST_TABLES.media]);
    });

    it('rejects a disallowed media type (episode) and inserts no row', async () => {
        const user = await createTestUser(sql);
        const playlistId = await ensureWatchlistPlaylist(sql, toUserId(user.id));

        const result = await playlistItemManager.addItems({
            sql,
            playlistId,
            playlistType: 'watchlist',
            externalIds: { internal: crypto.randomUUID() },
            mediaType: 'episode',
            title: 'Some Episode',
            username: user.username,
            surface: 'internal',
        });

        expect(result).toEqual({ type: 'rejected', reason: 'media_type_not_allowed' });

        const rows = await sql`SELECT * FROM playlist_items WHERE playlist_id = ${playlistId}`;
        expect(rows).toHaveLength(0);
    });

    it('rejects an album outright — not merely un-expanded — and inserts no row', async () => {
        const user = await createTestUser(sql);
        const playlistId = await ensureWatchlistPlaylist(sql, toUserId(user.id));

        const result = await playlistItemManager.addItems({
            sql,
            playlistId,
            playlistType: 'watchlist',
            externalIds: { internal: crypto.randomUUID() },
            mediaType: 'album',
            title: 'Some Album',
            username: user.username,
            surface: 'internal',
        });

        expect(result).toEqual({ type: 'rejected', reason: 'media_type_not_allowed' });

        const rows = await sql`SELECT * FROM playlist_items WHERE playlist_id = ${playlistId}`;
        expect(rows).toHaveLength(0);
    });

    it('adds a tv series to the watchlist as exactly one row with no season/episode, without expanding', async () => {
        const user = await createTestUser(sql);
        const playlistId = await ensureWatchlistPlaylist(sql, toUserId(user.id));

        // A series that genuinely HAS episodes in the DB: if the
        // `policy.expandContainers` guard on the series-expansion branch were
        // dropped, this would insert many rows instead of one, and the
        // row-count assertion below would fail. A series with zero episodes
        // would pass whether or not the guard exists — that vacuous shape is
        // exactly what the previous review round flagged.
        const series = await createAndInsertTestSeries(sql, {
            tmdbId: 900101,
            seasonCount: 1,
            episodesPerSeason: 3,
        });
        await markAllEpisodesHasFiles(sql, series.seriesId);

        const result = await playlistItemManager.addItems({
            sql,
            playlistId,
            playlistType: 'watchlist',
            externalIds: { internal: series.seriesId },
            mediaType: 'tv',
            title: 'Watchlisted Series',
            username: user.username,
            surface: 'internal',
            // Stray season/episode numbers a client should never send for a
            // whole-series add, but nothing stops one from doing so. If the
            // season/episode gate in the single-item insert were dropped or
            // inverted, these would leak straight into the row instead of
            // being forced to NULL — this is what makes the NULL assertions
            // below non-vacuous.
            seasonNumber: 1,
            episodeNumber: 1,
        });

        expect(result?.type).toBe('single');

        const rows = await sql<
            { media_id: string; season_number: number | null; episode_number: number | null }[]
        >`
            SELECT media_id, season_number, episode_number FROM playlist_items WHERE playlist_id = ${playlistId}
        `;

        // Exactly one row — not the 3 episodes a dropped expandContainers
        // guard would have produced.
        expect(rows).toHaveLength(1);
        expect(rows[0].media_id).toBe(series.seriesId);

        // idx_playlist_items_unique_media includes COALESCE(season_number,-1),
        // so a non-NULL season/episode on a non-expanding playlist would let
        // the same series occupy more than one row.
        expect(rows[0].season_number).toBeNull();
        expect(rows[0].episode_number).toBeNull();
    });

    it('rejects an episode whose UUID is smuggled in under a claimed mediaType of "movie"', async () => {
        // B2 (2026-09-22 edge-case pass): the kind-policy gate near the top
        // of addItems only checks the CALLER-CLAIMED mediaType.
        // `resolvePreferredToMediaId`'s `internal`-UUID fast path returns a
        // caller-supplied UUID verbatim with no type check of its own, so a
        // caller can claim `mediaType: 'movie'` while handing over an
        // episode's real UUID and sail past that first gate. This proves the
        // second, resolved-row check (right after `resolvePreferredToMediaId`
        // in the "Single Item" branch) actually runs and rejects it.
        const user = await createTestUser(sql);
        const playlistId = await ensureWatchlistPlaylist(sql, toUserId(user.id));

        const series = await createAndInsertTestSeries(sql, {
            tmdbId: 900103,
            seasonCount: 1,
            episodesPerSeason: 1,
        });
        const [{ id: episodeId }] = await sql<{ id: string }[]>`
            SELECT ep.id::text AS id
            FROM media_items ep
            JOIN media_items season ON season.id = ep.parent_id
            WHERE season.parent_id = ${series.seriesId}::uuid AND ep.media_type = 'episode'
            LIMIT 1
        `;

        const result = await playlistItemManager.addItems({
            sql,
            playlistId,
            playlistType: 'watchlist',
            externalIds: { internal: episodeId },
            mediaType: 'movie', // LIE: the id above resolves to an episode.
            title: 'Not Actually A Movie',
            username: user.username,
            surface: 'internal',
        });

        expect(result).toEqual({ type: 'rejected', reason: 'media_type_not_allowed' });

        const rows = await sql`
            SELECT id FROM playlist_items WHERE playlist_id = ${playlistId} AND media_id = ${episodeId}::uuid
        `;
        expect(rows).toHaveLength(0);
    });

    it('control: the same tv add DOES expand into its episodes when playlistType is omitted', async () => {
        const user = await createTestUser(sql);

        // An ordinary (non-watchlist) playlist for the same user.
        const [{ id: playlistId }] = await sql<{ id: number }[]>`
            INSERT INTO playlists (user_id, name, visibility, playlist_type, is_system)
            VALUES (${toUserId(user.id)}::uuid, 'My Playlist', 'private', 'general', false)
            RETURNING id
        `;

        const series = await createAndInsertTestSeries(sql, {
            tmdbId: 900102,
            seasonCount: 1,
            episodesPerSeason: 3,
        });
        await markAllEpisodesHasFiles(sql, series.seriesId);

        const result = await playlistItemManager.addItems({
            sql,
            playlistId,
            // playlistType intentionally omitted — this is the historical,
            // pre-Task-2 call shape every existing caller still uses.
            externalIds: { internal: series.seriesId },
            mediaType: 'tv',
            title: 'Ordinary Series',
            username: user.username,
            surface: 'internal',
        });

        expect(result?.type).toBe('expanded');
        expect(result?.episodesAdded).toBe(3);

        const rows = await sql`SELECT id FROM playlist_items WHERE playlist_id = ${playlistId}`;
        expect(rows).toHaveLength(3);
    });
});
