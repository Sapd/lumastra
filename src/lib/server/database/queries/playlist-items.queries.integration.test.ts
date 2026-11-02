// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Playlist Items Query Module
 *
 * Tests episode and track expansion for playlists.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestSeries,
    createAndInsertTestMusicHierarchy,
} from '../../../../../tests/integration/fixtures/index.js';

import { getSeriesEpisodesForPlaylist, getAlbumTracks } from './playlist-items.queries.js';

describe('Playlist Items Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.mediaFiles, ...TEST_TABLES.media]);
    });

    // ========================================================================
    // getSeriesEpisodesForPlaylist
    // ========================================================================

    describe('getSeriesEpisodesForPlaylist', () => {
        it('returns all episodes for a TV series ordered by season and episode', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 2,
            });
            await sql`
                UPDATE media_items SET has_files = true
                WHERE parent_id IN (SELECT id FROM media_items WHERE parent_id = ${series.seriesId}::uuid)
            `;

            const episodes = await getSeriesEpisodesForPlaylist(sql, series.seriesId);
            expect(episodes.length).toBe(2);
            expect(episodes[0].season_number).toBe(1);
            expect(episodes[0].episode_number).toBe(1);
            expect(episodes[1].episode_number).toBe(2);
        });

        it('returns empty array for a series with no episodes', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 0,
                episodesPerSeason: 0,
            });

            const episodes = await getSeriesEpisodesForPlaylist(sql, series.seriesId);
            expect(episodes).toEqual([]);
        });

        it('excludes catalog-only episodes with no local file (has_files = false)', async () => {
            // Regression test: episodes without files (e.g. discovery-only bonus/alternate
            // versions synced from TMDB metadata but never matched to a library file) must
            // not be surfaced as playable playlist items — tapping them 404s at
            // /api/v1/playback/{id}/info since there is no media to build sources from.
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 2,
            });
            await sql`
                UPDATE media_items SET has_files = true
                WHERE parent_id IN (SELECT id FROM media_items WHERE parent_id = ${series.seriesId}::uuid)
            `;

            // Add a ghost episode (has_files defaults to false) into the same season.
            const seasonId = await sql`
                SELECT id FROM media_items WHERE parent_id = ${series.seriesId}::uuid AND media_type = 'season' LIMIT 1
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, status)
                VALUES (gen_random_uuid(), 'Ghost Bonus Episode', 'episode', ${seasonId[0].id}::uuid, 1, 99, 'active')
            `;

            const episodes = await getSeriesEpisodesForPlaylist(sql, series.seriesId);
            expect(episodes.length).toBe(2);
            expect(episodes.every((e) => e.episode_number !== 99)).toBe(true);
        });
    });

    // ========================================================================
    // getAlbumTracks
    // ========================================================================

    describe('getAlbumTracks', () => {
        it('returns tracks for an album ordered by sort_order', async () => {
            const { albumId, trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 3,
            });

            const tracks = await getAlbumTracks(sql, albumId);
            expect(tracks.length).toBe(3);
            expect(tracks.map((t) => t.id)).toEqual(trackIds);
        });

        it('returns empty array for an album with no tracks', async () => {
            const { albumId } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 0,
            });

            const tracks = await getAlbumTracks(sql, albumId);
            expect(tracks).toEqual([]);
        });
    });
});
