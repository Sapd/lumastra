// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests: New Episode Arrival → Visibility
 *
 * Characterization tests proving that when a new episode of an existing series
 * arrives via the file-scanner ingest seam (findOrCreateSeries →
 * findOrCreatePersonalSeason → findOrCreatePersonalEpisode →
 * upsertMediaFile → attachFileToItem), it lands correctly in the DB and
 * becomes viewable to a normal user.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from './setup/test-database.js';
import { truncateTables, TEST_TABLES } from './helpers/cleanup.js';
import {
    findOrCreateSeries,
    findOrCreatePersonalSeason,
    findOrCreatePersonalEpisode,
} from '$lib/server/database/queries/media-items.queries.js';
import {
    upsertMediaFile,
    attachFileToItem,
} from '$lib/server/database/queries/media-files.queries.js';
import { getSeriesEpisodesWithWatchState } from '$lib/server/database/queries/episode-detail.queries.js';
import { getRecentlyAddedMedia } from '$lib/server/database/queries/browse.queries.js';
import { unrestrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { generateTestUserId, ensureTestUser } from './fixtures/user.fixtures.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unique file path so each test run doesn't hit upsertMediaFile ON CONFLICT. */
function uniqueFilePath(label: string): string {
    return `/test/series/${label}-${crypto.randomUUID()}.mkv`;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('New episode arrival → DB correctness + user visibility (Integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.watchStatus]);
    });

    // -------------------------------------------------------------------------
    // Test 1: Lands in DB with correct hierarchy
    // -------------------------------------------------------------------------
    it('TC1 – episode row lands in DB with correct media_type, parent_id, season/episode numbers, and a media_file_items link', async () => {
        // Seed existing series + season (prior scan)
        const seriesId = await findOrCreateSeries(sql, {
            title: 'Ghost Protocol',
            year: 2022,
        });
        const seasonId = await findOrCreatePersonalSeason(sql, {
            seriesId,
            seasonNumber: 2,
        });

        // Existing episode in the same season (to prove new one is separate)
        await findOrCreatePersonalEpisode(sql, {
            seasonId,
            seasonNumber: 2,
            episodeNumber: 1,
            title: 'Old Episode',
        });

        // New episode arrives
        const { id: newEpisodeId, created } = await findOrCreatePersonalEpisode(sql, {
            seasonId,
            seasonNumber: 2,
            episodeNumber: 2,
            title: 'New Arrival',
        });
        expect(created).toBe(true);

        // Attach file
        const { id: fileId } = await upsertMediaFile(sql, {
            filePath: uniqueFilePath('ghost-protocol-s02e02'),
        });
        await attachFileToItem(sql, fileId, newEpisodeId);

        // Episode row assertions
        const [epRow] = await sql<
            {
                id: string;
                media_type: string;
                parent_id: string;
                season_number: number;
                episode_number: number;
            }[]
        >`
            SELECT id, media_type, parent_id, season_number, episode_number
            FROM media_items
            WHERE id = ${newEpisodeId}
        `;
        expect(epRow).toBeDefined();
        expect(epRow.media_type).toBe('episode');
        expect(epRow.parent_id).toBe(seasonId); // parent is SEASON, not series
        expect(epRow.season_number).toBe(2);
        expect(epRow.episode_number).toBe(2);

        // media_file_items link
        const [link] = await sql<{ file_id: string; media_item_id: string }[]>`
            SELECT file_id, media_item_id
            FROM media_file_items
            WHERE file_id = ${fileId} AND media_item_id = ${newEpisodeId}
        `;
        expect(link).toBeDefined();
        expect(link.file_id).toBe(fileId);
        expect(link.media_item_id).toBe(newEpisodeId);
    });

    // -------------------------------------------------------------------------
    // Test 2: has_files propagates episode → season → series
    // -------------------------------------------------------------------------
    it('TC2 – has_files=true propagates atomically to episode, season, and series after attachFileToItem', async () => {
        const seriesId = await findOrCreateSeries(sql, {
            title: 'Neon Corridor',
            year: 2023,
        });
        const seasonId = await findOrCreatePersonalSeason(sql, {
            seriesId,
            seasonNumber: 1,
        });
        const { id: episodeId } = await findOrCreatePersonalEpisode(sql, {
            seasonId,
            seasonNumber: 1,
            episodeNumber: 3,
            title: 'Into the Neon',
        });

        // Before attach: all three should have has_files=false (new items default)
        const [seriesBefore] = await sql<{ has_files: boolean }[]>`
            SELECT has_files FROM media_items WHERE id = ${seriesId}
        `;
        expect(seriesBefore.has_files).toBe(false);

        const { id: fileId } = await upsertMediaFile(sql, {
            filePath: uniqueFilePath('neon-corridor-s01e03'),
        });
        await attachFileToItem(sql, fileId, episodeId);

        // After attach: episode, season, series must all be true
        const rows = await sql<{ id: string; has_files: boolean }[]>`
            SELECT id, has_files FROM media_items
            WHERE id = ANY(ARRAY[${episodeId}, ${seasonId}, ${seriesId}]::uuid[])
        `;
        const byId = Object.fromEntries(rows.map((r) => [r.id, r.has_files]));
        expect(byId[episodeId]).toBe(true);
        expect(byId[seasonId]).toBe(true);
        expect(byId[seriesId]).toBe(true);
    });

    // -------------------------------------------------------------------------
    // Test 3: No duplication — idempotent series + season; episode count +1
    // -------------------------------------------------------------------------
    it('TC3 – after new episode arrival, exactly one series and one season row exist; calling findOrCreateSeries again returns the same series id', async () => {
        const seriesId = await findOrCreateSeries(sql, {
            title: 'Static Horizon',
            year: 2021,
        });
        const seasonId = await findOrCreatePersonalSeason(sql, {
            seriesId,
            seasonNumber: 1,
        });

        // Pre-existing episode
        await findOrCreatePersonalEpisode(sql, {
            seasonId,
            seasonNumber: 1,
            episodeNumber: 1,
            title: 'Episode One',
        });

        // New episode arrives
        const { id: newEpId } = await findOrCreatePersonalEpisode(sql, {
            seasonId,
            seasonNumber: 1,
            episodeNumber: 2,
            title: 'Episode Two',
        });
        const { id: fileId } = await upsertMediaFile(sql, {
            filePath: uniqueFilePath('static-horizon-s01e02'),
        });
        await attachFileToItem(sql, fileId, newEpId);

        // Exactly one series row
        const [{ series_count }] = await sql<{ series_count: string }[]>`
            SELECT COUNT(*) AS series_count FROM media_items
            WHERE media_type = 'tv' AND title = 'Static Horizon' AND parent_id IS NULL
        `;
        expect(Number(series_count)).toBe(1);

        // Exactly one season row under the series
        const [{ season_count }] = await sql<{ season_count: string }[]>`
            SELECT COUNT(*) AS season_count FROM media_items
            WHERE media_type = 'season' AND parent_id = ${seriesId} AND season_number = 1
        `;
        expect(Number(season_count)).toBe(1);

        // findOrCreateSeries returns the same id (idempotent)
        const seriesId2 = await findOrCreateSeries(sql, {
            title: 'Static Horizon',
            year: 2021,
        });
        expect(seriesId2).toBe(seriesId);

        // Season now has exactly 2 episodes
        const [{ ep_count }] = await sql<{ ep_count: string }[]>`
            SELECT COUNT(*) AS ep_count FROM media_items
            WHERE media_type = 'episode' AND parent_id = ${seasonId}
        `;
        expect(Number(ep_count)).toBe(2);
    });

    // -------------------------------------------------------------------------
    // Test 4: Viewable — episode list via getSeriesEpisodesWithWatchState
    // -------------------------------------------------------------------------
    it('TC4 – getSeriesEpisodesWithWatchState returns the new episode with has_file=true and unwatched state for a brand-new user', async () => {
        const seriesId = await findOrCreateSeries(sql, {
            title: 'Vapor Trails',
            year: 2024,
        });
        const seasonId = await findOrCreatePersonalSeason(sql, {
            seriesId,
            seasonNumber: 1,
        });
        const { id: episodeId } = await findOrCreatePersonalEpisode(sql, {
            seasonId,
            seasonNumber: 1,
            episodeNumber: 5,
            title: 'Into the Vapor',
        });
        const { id: fileId } = await upsertMediaFile(sql, {
            filePath: uniqueFilePath('vapor-trails-s01e05'),
        });
        await attachFileToItem(sql, fileId, episodeId);

        // Use a real UUID user so the uuid cast in the LEFT JOIN succeeds.
        // The user has no watch state for this episode, which is what the test asserts.
        const testUserId = generateTestUserId('tc4-user');
        await ensureTestUser(sql, testUserId);

        // The series is addressed by its internal UUID.
        const episodes = await getSeriesEpisodesWithWatchState(
            sql,
            seriesId,
            testUserId, // UUID — mig 16.46.0 re-keyed user_id columns to uuid
            undefined, // all seasons
        );

        expect(episodes).toHaveLength(1);
        const ep = episodes[0];
        expect(ep.id).toBe(episodeId);
        expect(ep.has_file).toBe(true);
        expect(ep.season_number).toBe(1);
        expect(ep.episode_number).toBe(5);
        // No watch state for brand-new user
        expect(ep.is_watched).toBeNull();
        expect(ep.resume_position_ms).toBeNull();
    });

    // -------------------------------------------------------------------------
    // Test 5: Viewable — discovery (getRecentlyAddedMedia)
    // -------------------------------------------------------------------------
    it('TC5 – series appears in getRecentlyAddedMedia (status=active + has_files=true gate) after file attach', async () => {
        const seriesId = await findOrCreateSeries(sql, {
            title: 'Orbital Decay',
            year: 2023,
        });
        const seasonId = await findOrCreatePersonalSeason(sql, {
            seriesId,
            seasonNumber: 1,
        });
        const { id: episodeId } = await findOrCreatePersonalEpisode(sql, {
            seasonId,
            seasonNumber: 1,
            episodeNumber: 1,
            title: 'Pilot',
        });

        // Before attach: series must NOT appear in discovery
        const resultsBefore = await getRecentlyAddedMedia(sql, {
            mediaType: 'tv',
            limit: 100,
            access: unrestrictedAccess(),
        });
        const idsBeforeAttach = resultsBefore.map((r) => r.id);
        expect(idsBeforeAttach).not.toContain(seriesId);

        // Attach file → has_files propagates up to series
        const { id: fileId } = await upsertMediaFile(sql, {
            filePath: uniqueFilePath('orbital-decay-s01e01'),
        });
        await attachFileToItem(sql, fileId, episodeId);

        // After attach: series appears in discovery
        const resultsAfter = await getRecentlyAddedMedia(sql, {
            mediaType: 'tv',
            limit: 100,
            access: unrestrictedAccess(),
        });
        const idsAfterAttach = resultsAfter.map((r) => r.id);
        expect(idsAfterAttach).toContain(seriesId);
    });

    // -------------------------------------------------------------------------
    // Test 6 (negative): Episode without file does NOT affect has_files or discovery
    // -------------------------------------------------------------------------
    it('TC6 (negative) – episode created without a file does not flip has_files on the series, and series stays out of discovery', async () => {
        const seriesId = await findOrCreateSeries(sql, {
            title: 'Silent Frequency',
            year: 2025,
        });
        const seasonId = await findOrCreatePersonalSeason(sql, {
            seriesId,
            seasonNumber: 1,
        });

        // Create episode but do NOT attach any file
        await findOrCreatePersonalEpisode(sql, {
            seasonId,
            seasonNumber: 1,
            episodeNumber: 1,
            title: 'Unaired',
        });

        // has_files stays false on episode, season, series
        const rows = await sql<{ id: string; has_files: boolean }[]>`
            SELECT id, has_files FROM media_items
            WHERE id = ANY(ARRAY[${seriesId}, ${seasonId}]::uuid[])
        `;
        for (const row of rows) {
            expect(row.has_files).toBe(false);
        }

        // Series does not appear in discovery
        const results = await getRecentlyAddedMedia(sql, {
            mediaType: 'tv',
            limit: 100,
            access: unrestrictedAccess(),
        });
        expect(results.map((r) => r.id)).not.toContain(seriesId);
    });

    // -------------------------------------------------------------------------
    // Test 7: findOrCreatePersonalEpisode reports `created` accurately
    // (regression guard for the created-flag fix — a second find-or-create for
    // the same (season, season#, episode#) must report created=false, not a
    // false-positive created=true)
    // -------------------------------------------------------------------------
    it('TC7 – findOrCreatePersonalEpisode returns created=true on first insert and created=false on the second (idempotent identity)', async () => {
        const seriesId = await findOrCreateSeries(sql, {
            title: 'Echo Chamber',
            year: 2024,
        });
        const seasonId = await findOrCreatePersonalSeason(sql, {
            seriesId,
            seasonNumber: 1,
        });

        // First arrival: actually inserts → created=true
        const first = await findOrCreatePersonalEpisode(sql, {
            seasonId,
            seasonNumber: 1,
            episodeNumber: 7,
            title: 'Reverb',
        });
        expect(first.created).toBe(true);

        // Same episode identity again: must resolve to the SAME row, created=false
        const second = await findOrCreatePersonalEpisode(sql, {
            seasonId,
            seasonNumber: 1,
            episodeNumber: 7,
            title: 'Reverb',
        });
        expect(second.id).toBe(first.id);
        expect(second.created).toBe(false);

        // Exactly one episode row exists for that identity (no duplicate)
        const [{ ep_count }] = await sql<{ ep_count: string }[]>`
            SELECT COUNT(*) AS ep_count FROM media_items
            WHERE media_type = 'episode' AND parent_id = ${seasonId}
              AND season_number = 1 AND episode_number = 7
        `;
        expect(Number(ep_count)).toBe(1);
    });
});
