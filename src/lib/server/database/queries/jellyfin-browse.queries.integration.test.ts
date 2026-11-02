// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Integration Tests for Jellyfin Browse Query Module
 *
 * Tests media browsing, latest items, resume items, next-up episodes,
 * series episodes/seasons, and genre listing.
 *
 * Note: These queries are complex with many builder fragments.
 * Tests focus on verifying the queries execute correctly with
 * representative data rather than exhaustive branch coverage.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    createAndInsertTestSeries,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { ensureWatchlistPlaylist } from './watchlist-playlist.queries.js';

import {
    browseMediaItems,
    getLatestItems,
    getResumeItems,
    getNextUpEpisodes,
    getSeriesEpisodes,
    getSeriesSeasons,
    enrichMediaItemsByIds,
    getDistinctGenresForLibrary,
} from './jellyfin-browse.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';

describe('Jellyfin Browse Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'play_sessions',
            'playlist_items',
            'playlists',
            'user_media_flags',
            'user_media_state',
            'provider_metadata',
            'media_file_items',
            'media_files',
            'library_groups',
            'media_items',
            'external_ids',
        ]);
    });

    async function attachFileToMediaItem(mediaItemId: string, path: string): Promise<void> {
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, created_at, updated_at)
            VALUES (${path}, NOW(), NOW())
            RETURNING id
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${file.id}::uuid, ${mediaItemId}::uuid, true)
        `;
        await sql`UPDATE media_items SET has_files = true WHERE id = ${mediaItemId}::uuid`;
    }

    async function getEpisodeIdsForSeries(seriesId: string): Promise<string[]> {
        const episodes = await sql<{ id: string }[]>`
            SELECT ep.id
            FROM media_items season
            JOIN media_items ep ON ep.parent_id = season.id
            WHERE season.parent_id = ${seriesId}::uuid
              AND season.media_type = 'season'
              AND ep.media_type = 'episode'
            ORDER BY season.season_number ASC NULLS LAST, ep.episode_number ASC NULLS LAST
        `;
        return episodes.map((episode) => episode.id);
    }

    async function getFirstEpisodeIdForSeason(
        seriesId: string,
        seasonNumber: number,
    ): Promise<string> {
        const [episode] = await sql<{ id: string }[]>`
            SELECT ep.id
            FROM media_items season
            JOIN media_items ep ON ep.parent_id = season.id
            WHERE season.parent_id = ${seriesId}::uuid
              AND season.media_type = 'season'
              AND season.season_number = ${seasonNumber}
              AND ep.media_type = 'episode'
            ORDER BY ep.episode_number ASC NULLS LAST
            LIMIT 1
        `;
        if (!episode) {
            throw new Error(`No test episode found for season ${seasonNumber}`);
        }
        return episode.id;
    }

    // ========================================================================
    // browseMediaItems
    // ========================================================================

    describe('browseMediaItems', () => {
        it('returns media items with count', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            // Add file to satisfy has_files condition
            const [fileRow] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path)
                VALUES ('/movies/test.mkv')
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileRow.id}::uuid, ${item.id}::uuid)
            `;
            await sql`
                UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid
            `;

            const result = await browseMediaItems(sql, {
                mediaTypes: ['movie'],
                parentId: null,
                searchTerm: null,
                genres: [],
                years: [],
                nameStartsWith: null,
                isFavoriteFilter: false,
                isPlayedFilter: false,
                isUnplayedFilter: false,
                enableUserData: false,
                userId: undefined,
                idList: [],
                sortBy: 'SortName',
                sortOrder: 'Ascending',
                limit: 10,
                startIndex: 0,
                access: unrestrictedAccess(),
            });

            expect(result.totalCount).toBeGreaterThan(0);
            expect(result.rows.length).toBeGreaterThan(0);
        });

        it('filters by media type', async () => {
            const movie = createTestMediaItem({ media_type: 'movie' });
            const tv = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, movie);
            await insertTestMediaItem(sql, tv);

            const result = await browseMediaItems(sql, {
                mediaTypes: ['movie'],
                parentId: null,
                searchTerm: null,
                genres: [],
                years: [],
                nameStartsWith: null,
                isFavoriteFilter: false,
                isPlayedFilter: false,
                isUnplayedFilter: false,
                enableUserData: false,
                userId: undefined,
                idList: [],
                sortBy: 'SortName',
                sortOrder: 'Ascending',
                limit: 10,
                startIndex: 0,
                access: unrestrictedAccess(),
            });

            const types = result.rows.map((r) => r.media_type);
            expect(types).not.toContain('tv');
        });

        it('returns empty results for no matches', async () => {
            const result = await browseMediaItems(sql, {
                mediaTypes: ['movie'],
                parentId: null,
                searchTerm: 'xyznonexistent123',
                genres: [],
                years: [],
                nameStartsWith: null,
                isFavoriteFilter: false,
                isPlayedFilter: false,
                isUnplayedFilter: false,
                enableUserData: false,
                userId: undefined,
                idList: [],
                sortBy: 'SortName',
                sortOrder: 'Ascending',
                limit: 10,
                startIndex: 0,
                access: unrestrictedAccess(),
            });

            expect(result.totalCount).toBe(0);
            expect(result.rows.length).toBe(0);
        });

        it('excludes stale fileless movies and series from Jellyfin library scans', async () => {
            const staleMovie = createTestMediaItem({
                media_type: 'movie',
                title: 'Stale Movie',
                has_files: true,
            });
            await insertTestMediaItem(sql, staleMovie);

            const staleSeries = await createAndInsertTestSeries(sql, {
                title: 'Stale Series',
                tmdbId: 991_001,
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            const visibleSeries = await createAndInsertTestSeries(sql, {
                title: 'Visible Series',
                tmdbId: 991_002,
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            await sql`
                UPDATE media_items
                SET has_files = true
                WHERE id IN (${staleSeries.seriesId}::uuid, ${visibleSeries.seriesId}::uuid)
                   OR parent_id IN (${staleSeries.seriesId}::uuid, ${visibleSeries.seriesId}::uuid)
            `;
            const [visibleEpisodeId] = await getEpisodeIdsForSeries(visibleSeries.seriesId);
            await attachFileToMediaItem(visibleEpisodeId, '/shows/visible/s01e01.mkv');
            await sql`
                UPDATE media_items
                SET has_files = false
                WHERE id = ${visibleSeries.seriesId}::uuid
                   OR parent_id = ${visibleSeries.seriesId}::uuid
            `;

            const result = await browseMediaItems(sql, {
                mediaTypes: ['movie', 'tv'],
                parentId: null,
                searchTerm: null,
                genres: [],
                years: [],
                nameStartsWith: null,
                isFavoriteFilter: false,
                isPlayedFilter: false,
                isUnplayedFilter: false,
                enableUserData: false,
                userId: undefined,
                idList: [],
                sortBy: 'SortName',
                sortOrder: 'Ascending',
                limit: 10,
                startIndex: 0,
                access: unrestrictedAccess(),
            });

            expect(result.rows.map((row) => row.id)).toEqual([visibleSeries.seriesId]);
            expect(result.totalCount).toBe(1);
        });

        it('browsing a TV library ParentId without IncludeItemTypes returns the series, not its episodes', async () => {
            // Reproduces: a client (e.g. Moonfin) opens the "Series" library tab,
            // sending GET /Items?ParentId=<tvLibraryId> with no IncludeItemTypes.
            // Each episode's own file lives in the same library group as the
            // series, so the ParentId EXISTS chain's unguarded "own file in this
            // library" branch previously matched episodes directly, flooding the
            // series listing with individual episode rows.
            const [tvLibrary] = await sql<{ id: string }[]>`
                INSERT INTO library_groups (name, sort_order, created_at, updated_at)
                VALUES ('TV', 1, NOW(), NOW())
                RETURNING id
            `;

            const series = await createAndInsertTestSeries(sql, {
                title: 'Leaking Series',
                tmdbId: 991_101,
                seasonCount: 1,
                episodesPerSeason: 2,
            });
            const episodeIds = await getEpisodeIdsForSeries(series.seriesId);
            expect(episodeIds.length).toBe(2);
            for (const [index, episodeId] of episodeIds.entries()) {
                const [file] = await sql<{ id: string }[]>`
                    INSERT INTO media_files (file_path, library_group_id, created_at, updated_at)
                    VALUES (${`/shows/leaking/s01e0${index + 1}.mkv`}, ${tvLibrary.id}::uuid, NOW(), NOW())
                    RETURNING id
                `;
                await sql`
                    INSERT INTO media_file_items (file_id, media_item_id, is_default)
                    VALUES (${file.id}::uuid, ${episodeId}::uuid, true)
                `;
                await sql`UPDATE media_items SET has_files = true WHERE id = ${episodeId}::uuid`;
            }

            const result = await browseMediaItems(sql, {
                mediaTypes: [],
                parentId: tvLibrary.id,
                searchTerm: null,
                genres: [],
                years: [],
                nameStartsWith: null,
                isFavoriteFilter: false,
                isPlayedFilter: false,
                isUnplayedFilter: false,
                enableUserData: false,
                userId: undefined,
                idList: [],
                sortBy: 'SortName',
                sortOrder: 'Ascending',
                limit: 50,
                startIndex: 0,
                access: unrestrictedAccess(),
            });

            const types = result.rows.map((row) => row.media_type);
            expect(types).not.toContain('episode');
            expect(result.rows.map((row) => row.id)).toContain(series.seriesId);
        });

        it('still returns episodes for a library ParentId when IncludeItemTypes=Episode is explicit', async () => {
            // The episode-suppression above must be scoped to the "no type
            // filter" case only — a recursive per-episode library scan (e.g.
            // Jellyseerr's getLibraryContents with IncludeItemTypes=Episode)
            // still needs episode rows back.
            const [tvLibrary] = await sql<{ id: string }[]>`
                INSERT INTO library_groups (name, sort_order, created_at, updated_at)
                VALUES ('TV', 1, NOW(), NOW())
                RETURNING id
            `;

            const series = await createAndInsertTestSeries(sql, {
                title: 'Recursive Scan Series',
                tmdbId: 991_102,
                seasonCount: 1,
                episodesPerSeason: 2,
            });
            const episodeIds = await getEpisodeIdsForSeries(series.seriesId);
            for (const [index, episodeId] of episodeIds.entries()) {
                const [file] = await sql<{ id: string }[]>`
                    INSERT INTO media_files (file_path, library_group_id, created_at, updated_at)
                    VALUES (${`/shows/recursive/s01e0${index + 1}.mkv`}, ${tvLibrary.id}::uuid, NOW(), NOW())
                    RETURNING id
                `;
                await sql`
                    INSERT INTO media_file_items (file_id, media_item_id, is_default)
                    VALUES (${file.id}::uuid, ${episodeId}::uuid, true)
                `;
                await sql`UPDATE media_items SET has_files = true WHERE id = ${episodeId}::uuid`;
            }

            const result = await browseMediaItems(sql, {
                mediaTypes: ['episode'],
                parentId: tvLibrary.id,
                searchTerm: null,
                genres: [],
                years: [],
                nameStartsWith: null,
                isFavoriteFilter: false,
                isPlayedFilter: false,
                isUnplayedFilter: false,
                enableUserData: false,
                userId: undefined,
                idList: [],
                sortBy: 'SortName',
                sortOrder: 'Ascending',
                limit: 50,
                startIndex: 0,
                access: unrestrictedAccess(),
            });

            expect(result.rows.map((row) => row.id).sort()).toEqual(episodeIds.sort());
        });
    });

    // ========================================================================
    // getLatestItems
    // ========================================================================

    describe('getLatestItems', () => {
        it('returns latest items ordered by created_at DESC', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            // Add file
            const [fileRow] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path)
                VALUES ('/movies/test.mkv')
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileRow.id}::uuid, ${item.id}::uuid)
            `;
            await sql`
                UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid
            `;

            const result = await getLatestItems(sql, {
                limit: 10,
                parentId: null,
                groupItems: true,
                access: unrestrictedAccess(),
            });

            expect(result.length).toBeGreaterThan(0);
        });

        it('newest-file windows return exactly what the full listing returns', async () => {
            // The windowed path must be exact, not approximate: compare it with the
            // full listing (fileWindows: []) across limits, library filters and
            // grouping, on a fixture where most new files land in ANOTHER library,
            // ties sit on the window boundary, and a series ranks by an episode file.
            const [groupA] = await sql<{ id: string }[]>`
                INSERT INTO library_groups (name) VALUES ('latest-window-a') RETURNING id`;
            const [groupB] = await sql<{ id: string }[]>`
                INSERT INTO library_groups (name) VALUES ('latest-window-b') RETURNING id`;
            let n = 0;
            const fileFor = async (itemId: string, groupId: string, at: string): Promise<void> => {
                const [f] = await sql<{ id: string }[]>`
                    INSERT INTO media_files (file_path, created_at, library_group_id)
                    VALUES (${`/latest-window/${n++}.mkv`}, ${at}::timestamptz, ${groupId}::uuid)
                    RETURNING id`;
                await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${f.id}::uuid, ${itemId}::uuid)`;
                await sql`UPDATE media_items SET has_files = true WHERE id = ${itemId}::uuid`;
            };
            const item = async (
                type: 'movie' | 'tv' | 'season' | 'episode',
                parentId: string | null = null,
            ): Promise<string> => {
                const it = createTestMediaItem({ media_type: type, parent_id: parentId });
                await insertTestMediaItem(sql, it);
                return it.id;
            };

            for (let i = 0; i < 6; i++) {
                await fileFor(await item('movie'), groupA.id, `2025-01-0${i + 1}T00:00:00Z`);
            }
            for (let i = 0; i < 8; i++) {
                // Newer than everything in A, and two share a timestamp.
                const at = `2025-06-0${Math.min(i, 6) + 1}T00:00:00Z`;
                await fileFor(await item('movie'), groupB.id, at);
            }
            const series = await item('tv');
            const season = await item('season', series);
            const ep = await item('episode', season);
            // The newest file of all sits on an EPISODE, so the series can only
            // rank first if its grandchild's file maps back to it.
            await fileFor(ep, groupA.id, '2025-07-01T00:00:00Z');

            for (const parentId of [null, groupA.id, groupB.id]) {
                for (const groupItems of [true, false]) {
                    for (const limit of [1, 3, 5, 20]) {
                        const base = { limit, parentId, groupItems, access: unrestrictedAccess() };
                        const full = await getLatestItems(sql, { ...base, fileWindows: [] });
                        const windowed = await getLatestItems(sql, {
                            ...base,
                            fileWindows: [2, 5],
                        });
                        expect(
                            windowed.map((r) => r.id),
                            `parentId=${parentId} groupItems=${groupItems} limit=${limit}`,
                        ).toEqual(full.map((r) => r.id));
                    }
                }
            }
        });

        it('full listing library filter keeps every membership route the windowed pass keeps', async () => {
            // The full pass filters by the library's member set; the windowed pass
            // by the correlated per-row form. A window larger than the file count
            // is complete, so it answers with the correlated form over every title.
            const [lib] = await sql<{ id: string }[]>`
                INSERT INTO library_groups (name) VALUES ('latest-lib') RETURNING id`;
            const [other] = await sql<{ id: string }[]>`
                INSERT INTO library_groups (name) VALUES ('latest-other') RETURNING id`;
            let n = 0;
            const fileFor = async (itemId: string, groupId: string): Promise<void> => {
                const [f] = await sql<{ id: string }[]>`
                    INSERT INTO media_files (file_path, created_at, library_group_id)
                    VALUES (${`/latest-lib/${n}.mkv`}, ${`2025-03-${String(++n).padStart(2, '0')}T00:00:00Z`}::timestamptz, ${groupId}::uuid)
                    RETURNING id`;
                await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${f.id}::uuid, ${itemId}::uuid)`;
                await sql`UPDATE media_items SET has_files = true WHERE id = ${itemId}::uuid`;
            };
            const item = async (
                type: 'movie' | 'tv' | 'season' | 'episode',
                parentId: string | null = null,
            ): Promise<string> => {
                const it = createTestMediaItem({ media_type: type, parent_id: parentId });
                await insertTestMediaItem(sql, it);
                return it.id;
            };

            const ownFile = await item('movie');
            await fileFor(ownFile, lib.id);
            const byJellyfinId = await item('movie');
            await fileFor(byJellyfinId, other.id);
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${byJellyfinId}::uuid, 'jellyfin', ${sql.json({ jellyfin_library_id: lib.id })})`;
            const series = await item('tv');
            const ep = await item('episode', await item('season', series));
            await fileFor(ep, lib.id);
            const outside = await item('movie');
            await fileFor(outside, other.id);

            for (const groupItems of [true, false]) {
                const base = {
                    limit: 20,
                    parentId: lib.id,
                    groupItems,
                    access: unrestrictedAccess(),
                };
                const full = await getLatestItems(sql, { ...base, fileWindows: [] });
                const windowed = await getLatestItems(sql, { ...base, fileWindows: [1000] });
                expect(full.map((r) => r.id)).toEqual(windowed.map((r) => r.id));
                const ids = full.map((r) => r.id);
                expect(ids).toEqual(expect.arrayContaining([ownFile, byJellyfinId, series]));
                expect(ids).not.toContain(outside);
            }
        });

        it('filters by parentId', async () => {
            const result = await getLatestItems(sql, {
                limit: 10,
                parentId: '00000000-0000-0000-0000-000000000000',
                groupItems: true,
                access: unrestrictedAccess(),
            });

            expect(Array.isArray(result)).toBe(true);
        });

        it('orders by file-added time, not catalog created_at', async () => {
            // oldCatalog: discovered long ago, file landed just now → must rank FIRST.
            // newCatalog: catalog row created now, file landed long ago → must rank after.
            // This is the request-then-download case: ordering by mi.created_at would
            // bury the freshly-downloaded title so it never surfaces in the latest
            // window (the Jellyseerr recently-added-scan gap this fixes).
            const oldCatalog = createTestMediaItem({
                media_type: 'movie',
                title: 'Old Catalog New File',
            });
            const newCatalog = createTestMediaItem({
                media_type: 'movie',
                title: 'New Catalog Old File',
            });
            await insertTestMediaItem(sql, oldCatalog);
            await insertTestMediaItem(sql, newCatalog);

            await sql`UPDATE media_items SET created_at = '2024-01-01T00:00:00Z' WHERE id = ${oldCatalog.id}::uuid`;
            await sql`UPDATE media_items SET created_at = NOW() WHERE id = ${newCatalog.id}::uuid`;

            const [newFile] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, created_at)
                VALUES ('/movies/old-catalog-new-file.mkv', NOW())
                RETURNING id
            `;
            const [oldFile] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, created_at)
                VALUES ('/movies/new-catalog-old-file.mkv', '2024-02-01T00:00:00Z')
                RETURNING id
            `;
            await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${newFile.id}::uuid, ${oldCatalog.id}::uuid)`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${oldFile.id}::uuid, ${newCatalog.id}::uuid)`;
            await sql`UPDATE media_items SET has_files = true WHERE id = ${oldCatalog.id}::uuid`;
            await sql`UPDATE media_items SET has_files = true WHERE id = ${newCatalog.id}::uuid`;

            const result = await getLatestItems(sql, {
                limit: 10,
                parentId: null,
                groupItems: true,
                access: unrestrictedAccess(),
            });

            const ids = result.map((r) => r.id as string);
            const idxOldCatalog = ids.indexOf(oldCatalog.id);
            const idxNewCatalog = ids.indexOf(newCatalog.id);

            expect(idxOldCatalog).toBeGreaterThanOrEqual(0);
            expect(idxNewCatalog).toBeGreaterThanOrEqual(0);
            // Newer file wins despite older catalog created_at.
            expect(idxOldCatalog).toBeLessThan(idxNewCatalog);
        });
    });

    // ========================================================================
    // getResumeItems
    // ========================================================================

    describe('getResumeItems', () => {
        it('returns resume items for user with active sessions', async () => {
            const userId: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);

            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const [fileRow] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path)
                VALUES ('/movies/test.mkv')
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileRow.id}::uuid, ${item.id}::uuid)
            `;
            await sql`
                UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid
            `;

            // Create an active play session
            await sql`
                INSERT INTO play_sessions (
                    media_id, user_id, device_id, ip_address, play_method, status, position_ms, runtime_ms, last_heartbeat_at
                ) VALUES (
                    ${item.id}::uuid,
                    ${userId}::uuid,
                    'test-device',
                    '127.0.0.1',
                    'direct',
                    'ACTIVE',
                    300000,
                    7200000,
                    NOW()
                )
            `;

            const result = await getResumeItems(sql, userId, 10, unrestrictedAccess());
            expect(Array.isArray(result)).toBe(true);
        });

        it('returns resume items for user with watch state', async () => {
            const userId: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);

            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const [fileRow] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path)
                VALUES ('/movies/test.mkv')
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileRow.id}::uuid, ${item.id}::uuid)
            `;
            await sql`
                UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid
            `;

            await sql`
                INSERT INTO user_media_state (
                    user_id, media_id, resume_position_ms, runtime_ms, is_watched
                ) VALUES (
                    ${userId}::uuid,
                    ${item.id}::uuid,
                    600000,
                    7200000,
                    false
                )
            `;

            const result = await getResumeItems(sql, userId, 10, unrestrictedAccess());
            expect(Array.isArray(result)).toBe(true);
        });

        it('returns empty array for user with no activity', async () => {
            const result = await getResumeItems(
                sql,
                toUserId(randomUUID()),
                10,
                unrestrictedAccess(),
            );
            expect(Array.isArray(result)).toBe(true);
        });

        /** Seed a movie + a single migration-sourced resume row; return its id. */
        async function seedMigrationMovieResume(
            userId: UserId,
            resumeMs: number,
            runtimeMs: number,
        ): Promise<string> {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const [fileRow] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path) VALUES ('/movies/mig.mkv') RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileRow.id}::uuid, ${item.id}::uuid)
            `;
            await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;
            await sql`
                INSERT INTO user_media_state (
                    user_id, media_id, resume_position_ms, runtime_ms, is_watched,
                    last_event_at, last_event_source, highest_session_elapsed_ms
                ) VALUES (
                    ${userId}::uuid, ${item.id}::uuid, ${resumeMs}, ${runtimeMs}, false,
                    NOW() - INTERVAL '5 days', 'migration', ${resumeMs}
                )
            `;
            return item.id;
        }

        it('excludes a sub-10% migration-sourced movie (Avatar phantom)', async () => {
            const userId: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);

            const movieId = await seedMigrationMovieResume(userId, 66_000, 193 * 60 * 1000);

            const result = await getResumeItems(sql, userId, 10, unrestrictedAccess());
            expect(result.map((r) => r.id)).not.toContain(movieId);
        });

        it('keeps a migration-sourced movie with real ≥10% progress', async () => {
            const userId: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);

            const movieId = await seedMigrationMovieResume(userId, 50 * 60 * 1000, 100 * 60 * 1000);

            const result = await getResumeItems(sql, userId, 10, unrestrictedAccess());
            expect(result.map((r) => r.id)).toContain(movieId);
        });
    });

    // ========================================================================
    // getNextUpEpisodes
    // ========================================================================

    describe('getNextUpEpisodes', () => {
        it('returns next episodes for watched series', async () => {
            const userId: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);

            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 3,
            });

            const episodes = await sql<{ id: string; episode_number: number }[]>`
                SELECT id, episode_number FROM media_items
                WHERE media_type = 'episode'
                  AND parent_id IN (
                      SELECT id FROM media_items
                      WHERE parent_id = ${series.seriesId} AND media_type = 'season'
                  )
                ORDER BY episode_number
            `;

            // Mark first episode as watched
            await sql`
                INSERT INTO user_media_state (
                    user_id, media_id, is_watched, resume_position_ms, runtime_ms
                ) VALUES (
                    ${userId}::uuid,
                    ${episodes[0].id}::uuid,
                    true,
                    0,
                    2700000
                )
            `;

            const result = await getNextUpEpisodes(sql, userId, 10, unrestrictedAccess());
            expect(Array.isArray(result)).toBe(true);
        });

        it('returns empty array when no series are being watched', async () => {
            const result = await getNextUpEpisodes(
                sql,
                toUserId(randomUUID()),
                10,
                unrestrictedAccess(),
            );
            expect(Array.isArray(result)).toBe(true);
        });

        /**
         * Seed one season of `episodeCount` file-backed episodes and mark the
         * 1-based episode numbers in `watched` as watched, one minute apart so
         * the anchor is unambiguous.
         */
        let nextUpSeedSeq = 0;
        async function seedSeriesWithProgress(
            userId: UserId,
            episodeCount: number,
            watched: number[],
        ): Promise<{ seriesId: string; episodeIds: string[] }> {
            const seq = ++nextUpSeedSeq;
            const series = await createAndInsertTestSeries(sql, {
                title: `Next Up Fixture ${seq}`,
                tmdbId: 970_000 + seq,
                seasonCount: 1,
                episodesPerSeason: episodeCount,
            });
            const episodeIds = await getEpisodeIdsForSeries(series.seriesId);
            for (let i = 0; i < episodeIds.length; i++) {
                await attachFileToMediaItem(
                    episodeIds[i],
                    `/shows/next-up/${seq}/s01e0${i + 1}.mkv`,
                );
            }
            for (let i = 0; i < watched.length; i++) {
                await sql`
                    INSERT INTO user_media_state (
                        user_id, media_id, is_watched, resume_position_ms, runtime_ms,
                        last_watched_at, last_event_source
                    ) VALUES (
                        ${userId}::uuid,
                        ${episodeIds[watched[i] - 1]}::uuid,
                        true,
                        0,
                        2700000,
                        NOW() - (${watched.length - i} || ' minutes')::interval,
                        'lumastra'
                    )
                `;
            }
            return { seriesId: series.seriesId, episodeIds };
        }

        it('follows the most-recently-watched anchor, not the earliest gap', async () => {
            // The reported bug: an unwatched episode BEHIND the user's current
            // position pinned Next Up to the front of the series forever. Real
            // case on prod — 176/178 episodes of TNG watched, S01E02 never
            // marked, and Next Up offered S01E02 indefinitely.
            const userId: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);

            const { episodeIds } = await seedSeriesWithProgress(userId, 5, [2, 3, 4]);

            const result = await getNextUpEpisodes(sql, userId, 10, unrestrictedAccess());

            expect(result.map((r) => r.id)).toEqual([episodeIds[4]]);
            expect(result[0].episode_number).toBe(5);
        });

        it('offers nothing for a series finished past its only gap', async () => {
            // Same shape, no episode left after the anchor: the series is done
            // and must drop out of Next Up entirely rather than rewinding to
            // the unwatched pilot.
            const userId: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);

            await seedSeriesWithProgress(userId, 3, [2, 3]);

            const result = await getNextUpEpisodes(sql, userId, 10, unrestrictedAccess());

            expect(result).toHaveLength(0);
        });

        it('scopes to one series when seriesId is given', async () => {
            const userId: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);

            const first = await seedSeriesWithProgress(userId, 4, [1]);
            const second = await seedSeriesWithProgress(userId, 4, [1]);

            const scoped = await getNextUpEpisodes(
                sql,
                userId,
                10,
                unrestrictedAccess(),
                second.seriesId,
            );

            expect(scoped.map((r) => r.series_id)).toEqual([second.seriesId]);
            expect(scoped.map((r) => r.id)).toEqual([second.episodeIds[1]]);
            expect(scoped.map((r) => r.id)).not.toContain(first.episodeIds[1]);
        });

        it('drops a series the user dismissed from Continue Watching', async () => {
            const userId: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);

            const { seriesId } = await seedSeriesWithProgress(userId, 4, [1]);
            await sql`
                INSERT INTO user_media_flags (user_id, target_id, target_type, flag_type)
                VALUES (${userId}::uuid, ${seriesId}, 'series', 'dismissed_cw')
            `;

            const result = await getNextUpEpisodes(sql, userId, 10, unrestrictedAccess());

            expect(result).toHaveLength(0);
        });

        it('drops a series whose last activity is older than the age cutoff', async () => {
            const userId: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);

            const { seriesId, episodeIds } = await seedSeriesWithProgress(userId, 4, [1]);
            await sql`
                UPDATE user_media_state
                SET last_watched_at = NOW() - INTERVAL '400 days'
                WHERE user_id = ${userId}::uuid AND media_id = ${episodeIds[0]}::uuid
            `;

            const withCutoff = await getNextUpEpisodes(
                sql,
                userId,
                10,
                unrestrictedAccess(),
                null,
                60,
            );
            const withoutCutoff = await getNextUpEpisodes(sql, userId, 10, unrestrictedAccess());

            expect(withCutoff).toHaveLength(0);
            expect(withoutCutoff.map((r) => r.series_id)).toEqual([seriesId]);
        });
    });

    // ========================================================================
    // getSeriesEpisodes
    // ========================================================================

    describe('getSeriesEpisodes', () => {
        it('returns episodes for a series', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 2,
            });
            const episodeIds = await getEpisodeIdsForSeries(series.seriesId);
            await attachFileToMediaItem(episodeIds[0], '/shows/visible/s01e01.mkv');
            await attachFileToMediaItem(episodeIds[1], '/shows/visible/s01e02.mkv');

            const result = await getSeriesEpisodes(sql, {
                seriesId: series.seriesId,
                seasonId: null,
                seasonNumber: null,
                enableUserData: false,
                userId: undefined,
                limit: 10,
                startIndex: 0,
                access: unrestrictedAccess(),
            });

            expect(result.length).toBe(2);
            expect(result[0].media_type).toBe('episode');
        });

        it('filters by season ID', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 2,
                episodesPerSeason: 2,
            });
            const episodeIds = await getEpisodeIdsForSeries(series.seriesId);
            for (const [index, episodeId] of episodeIds.entries()) {
                await attachFileToMediaItem(episodeId, `/shows/season-filter/e${index + 1}.mkv`);
            }

            const seasons = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE media_type = 'season' AND parent_id = ${series.seriesId}
                LIMIT 1
            `;
            const seasonId = seasons[0].id;

            const result = await getSeriesEpisodes(sql, {
                seriesId: series.seriesId,
                seasonId,
                seasonNumber: null,
                enableUserData: false,
                userId: undefined,
                limit: 10,
                startIndex: 0,
                access: unrestrictedAccess(),
            });

            expect(result.length).toBe(2);
        });

        it('carries the series tmdb poster and backdrop paths on every episode row', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 2,
            });
            const episodeIds = await getEpisodeIdsForSeries(series.seriesId);
            await attachFileToMediaItem(episodeIds[0], '/shows/art/s01e01.mkv');
            await attachFileToMediaItem(episodeIds[1], '/shows/art/s01e02.mkv');
            await sql`DELETE FROM provider_metadata WHERE media_id = ${series.seriesId}::uuid`;
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (
                    ${series.seriesId}::uuid,
                    'tmdb',
                    ${sql.json({ poster_path: '/series-poster.jpg', backdrop_path: '/series-backdrop.jpg' })}
                )
            `;

            const options = {
                seriesId: series.seriesId,
                seasonId: null,
                seasonNumber: null,
                enableUserData: false,
                userId: undefined,
                limit: 10,
                startIndex: 0,
                access: unrestrictedAccess(),
            };
            const result = await getSeriesEpisodes(sql, options);

            expect(result.length).toBe(2);
            for (const row of result) {
                expect(row.series_poster_path).toBe('/series-poster.jpg');
                expect(row.series_backdrop_path).toBe('/series-backdrop.jpg');
            }

            // The item browse reads the same art through its own lateral.
            const browsed = await browseMediaItems(sql, {
                mediaTypes: ['episode'],
                parentId: null,
                searchTerm: null,
                genres: [],
                years: [],
                nameStartsWith: null,
                isFavoriteFilter: false,
                isPlayedFilter: false,
                isUnplayedFilter: false,
                enableUserData: false,
                userId: undefined,
                idList: episodeIds,
                sortBy: 'SortName',
                sortOrder: 'Ascending',
                limit: 10,
                startIndex: 0,
                access: unrestrictedAccess(),
            });
            expect(browsed.rows.length).toBe(2);
            for (const row of browsed.rows) {
                expect(row.series_poster_path).toBe('/series-poster.jpg');
                expect(row.series_backdrop_path).toBe('/series-backdrop.jpg');
            }

            // A series without a tmdb row still yields the episodes, with null art.
            await sql`DELETE FROM provider_metadata WHERE media_id = ${series.seriesId}::uuid`;
            const bare = await getSeriesEpisodes(sql, options);
            expect(bare.length).toBe(2);
            expect(bare[0].series_poster_path).toBeNull();
            expect(bare[0].series_backdrop_path).toBeNull();
        });

        it('excludes metadata-only episodes from Jellyfin episode lists', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 2,
            });
            const episodeIds = await getEpisodeIdsForSeries(series.seriesId);
            await sql`
                UPDATE media_items
                SET has_files = true
                WHERE id = ANY(${episodeIds}::uuid[])
            `;
            await attachFileToMediaItem(episodeIds[1], '/shows/partial/s01e02.mkv');

            const result = await getSeriesEpisodes(sql, {
                seriesId: series.seriesId,
                seasonId: null,
                seasonNumber: null,
                enableUserData: false,
                userId: undefined,
                limit: 10,
                startIndex: 0,
                access: unrestrictedAccess(),
            });

            expect(result.map((row) => row.id)).toEqual([episodeIds[1]]);
        });

        it('returns empty array for non-existent series', async () => {
            const result = await getSeriesEpisodes(sql, {
                seriesId: '00000000-0000-0000-0000-000000000000',
                seasonId: null,
                seasonNumber: null,
                enableUserData: false,
                userId: undefined,
                limit: 10,
                startIndex: 0,
                access: unrestrictedAccess(),
            });

            expect(result.length).toBe(0);
        });

        // Coverage gap closed (task 5 fix round 2): every OTHER test in this
        // describe block passes userId: undefined, so none of them exercise
        // is_favorite's true/false branches for THIS call site —
        // watchlistExistsFragment is shared code, but a scoping regression
        // specific to getSeriesEpisodes' own wiring (wrong alias, wrong
        // userId variable, etc.) would not be caught by the builder's own
        // unit tests, which only prove the fragment itself is correct in
        // isolation. Asserting on the real exported getSeriesEpisodes row
        // proves the wiring at this specific site.
        //
        // The row is seeded DIRECTLY rather than through upsertWatchlistItem:
        // WATCHLIST_POLICY.allowedMediaTypes is movie/tv/audiobook, so that
        // write path rejects an episode with WatchlistMediaTypeNotAllowedError
        // by design ("a watchlist is a SET of things you intend to watch, not
        // an ordered list of playable items"). An episode-keyed row in a
        // watchlist playlist is still a legal DB state — the sibling
        // jellyfin-favorite-watchlist test seeds one the same way — and what
        // is under test here is the READ side: this call site's is_favorite
        // wiring and its per-user scoping.
        it('is_favorite is true for a watchlisted episode, false for a different user', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 2,
            });
            const episodeIds = await getEpisodeIdsForSeries(series.seriesId);
            await attachFileToMediaItem(episodeIds[0], '/shows/favorite/s01e01.mkv');
            await attachFileToMediaItem(episodeIds[1], '/shows/favorite/s01e02.mkv');

            const userId: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);
            const watchlistId = await ensureWatchlistPlaylist(sql, userId);
            await sql`
                INSERT INTO playlist_items (playlist_id, media_id, title, position)
                VALUES (${watchlistId}, ${episodeIds[0]}::uuid, 'Favorite S01E01', 0)
            `;

            const otherUserId: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, otherUserId);

            const asOwner = await getSeriesEpisodes(sql, {
                seriesId: series.seriesId,
                seasonId: null,
                seasonNumber: null,
                enableUserData: false,
                userId,
                limit: 10,
                startIndex: 0,
                access: unrestrictedAccess(),
            });
            const watchlistedRow = asOwner.find((row) => row.id === episodeIds[0]);
            const otherRow = asOwner.find((row) => row.id === episodeIds[1]);
            expect(watchlistedRow?.is_favorite).toBe(true);
            expect(otherRow?.is_favorite).toBe(false);

            const asOtherUser = await getSeriesEpisodes(sql, {
                seriesId: series.seriesId,
                seasonId: null,
                seasonNumber: null,
                enableUserData: false,
                userId: otherUserId,
                limit: 10,
                startIndex: 0,
                access: unrestrictedAccess(),
            });
            const notLeakedRow = asOtherUser.find((row) => row.id === episodeIds[0]);
            expect(notLeakedRow?.is_favorite).toBe(false);
        });
    });

    // ========================================================================
    // getSeriesSeasons
    // ========================================================================

    describe('getSeriesSeasons', () => {
        it('returns seasons for a series', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 2,
                episodesPerSeason: 2,
            });
            await attachFileToMediaItem(
                await getFirstEpisodeIdForSeason(series.seriesId, 1),
                '/shows/test/s01e01.mkv',
            );
            await attachFileToMediaItem(
                await getFirstEpisodeIdForSeason(series.seriesId, 2),
                '/shows/test/s02e01.mkv',
            );

            const result = await getSeriesSeasons(sql, {
                seriesId: series.seriesId,
                enableUserData: false,
                userId: undefined,
                access: unrestrictedAccess(),
            });

            expect(result.length).toBe(2);
            expect(result[0].media_type).toBe('season');
        });

        it('only returns seasons with file-backed episodes for Jellyfin availability scans', async () => {
            const series = await createAndInsertTestSeries(sql, {
                title: 'Metadata Complete, Files Partial',
                seasonCount: 6,
                episodesPerSeason: 2,
            });

            // Reproduce stale parent roll-up flags: the series and all season
            // folders say has_files=true, but only seasons 5 and 6 have
            // file-backed episode rows. Seerr must not infer seasons 1-4 are
            // available from the metadata-only season folders.
            await sql`
                UPDATE media_items
                SET has_files = true
                WHERE id = ${series.seriesId}::uuid
                   OR parent_id = ${series.seriesId}::uuid
            `;
            await attachFileToMediaItem(
                await getFirstEpisodeIdForSeason(series.seriesId, 5),
                '/shows/test/s05e01.mkv',
            );
            await attachFileToMediaItem(
                await getFirstEpisodeIdForSeason(series.seriesId, 6),
                '/shows/test/s06e01.mkv',
            );

            const result = await getSeriesSeasons(sql, {
                seriesId: series.seriesId,
                enableUserData: false,
                userId: undefined,
                access: unrestrictedAccess(),
            });

            expect(result.map((row) => row.season_number)).toEqual([5, 6]);
            expect(result.map((row) => row.child_count)).toEqual([1, 1]);
        });

        it('returns empty array for non-existent series', async () => {
            const result = await getSeriesSeasons(sql, {
                seriesId: '00000000-0000-0000-0000-000000000000',
                enableUserData: false,
                userId: undefined,
                access: unrestrictedAccess(),
            });

            expect(result.length).toBe(0);
        });

        // C8 (2026-09-16 security review 3, task 4): getSeriesSeasons applied
        // NO library predicate at all — a mixed-group series (one season
        // allowed, one in a denied group, both file-backed) leaked the denied
        // season's title/overview/poster/backdrop/premiere_date/child_count
        // to a restricted user even though checkMediaAccess(seriesId) passed
        // for the series itself (the sticky library_group_id state a series
        // reaches when it gains episodes in a new group after first scan).
        it('excludes a season whose only episode file is in a denied library group (C8)', async () => {
            const deniedGroupId = randomUUID();
            await sql`
                INSERT INTO library_groups (id, name) VALUES (${deniedGroupId}::uuid, 'C8 Denied Group')
            `;

            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 2,
                episodesPerSeason: 1,
            });
            await attachFileToMediaItem(
                await getFirstEpisodeIdForSeason(series.seriesId, 1),
                '/shows/c8/s01e01.mkv',
            );
            const deniedEpisodeId = await getFirstEpisodeIdForSeason(series.seriesId, 2);
            const [deniedFile] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, library_group_id, created_at, updated_at)
                VALUES (${'/shows/c8/s02e01.mkv'}, ${deniedGroupId}::uuid, NOW(), NOW())
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${deniedFile.id}::uuid, ${deniedEpisodeId}::uuid, true)
            `;
            await sql`UPDATE media_items SET has_files = true WHERE id = ${deniedEpisodeId}::uuid`;

            const open = await getSeriesSeasons(sql, {
                seriesId: series.seriesId,
                enableUserData: false,
                userId: undefined,
                access: unrestrictedAccess(),
            });
            expect(open.map((row) => row.season_number)).toEqual([1, 2]);

            const restricted = await getSeriesSeasons(sql, {
                seriesId: series.seriesId,
                enableUserData: false,
                userId: undefined,
                access: restrictedAccess({
                    deniedGroupIds: [deniedGroupId],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
            });
            expect(restricted.map((row) => row.season_number)).toEqual([1]);
        });
    });

    // ========================================================================
    // enrichMediaItemsByIds
    // ========================================================================

    describe('enrichMediaItemsByIds', () => {
        it('returns enriched items for given IDs', async () => {
            const item = createTestMediaItem({ media_type: 'movie', has_files: true });
            await insertTestMediaItem(sql, item);

            const result = await enrichMediaItemsByIds(sql, [item.id], unrestrictedAccess());

            expect(result.length).toBe(1);
            expect(result[0].id).toBe(item.id);
        });

        it('filters out items without local files', async () => {
            const item = createTestMediaItem({ media_type: 'movie', has_files: false });
            await insertTestMediaItem(sql, item);

            expect(await enrichMediaItemsByIds(sql, [item.id], unrestrictedAccess())).toEqual([]);
        });

        it('filters out deleted items', async () => {
            const item = createTestMediaItem({
                media_type: 'movie',
                status: 'deleted',
            });
            await insertTestMediaItem(sql, item);

            const result = await enrichMediaItemsByIds(sql, [item.id], unrestrictedAccess());
            expect(result.length).toBe(0);
        });
    });

    // ========================================================================
    // getDistinctGenresForLibrary
    // ========================================================================

    describe('getDistinctGenresForLibrary', () => {
        async function insertGenres(mediaId: string, names: string[]): Promise<void> {
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (
                    ${mediaId}::uuid,
                    'tmdb',
                    ${sql.json({ genres: names.map((name, i) => ({ id: i + 1, name })) })},
                    NOW()
                )
            `;
        }

        it('returns distinct genres from provider metadata', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await attachFileToMediaItem(item.id, '/movies/genre-source.mkv');

            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (
                    ${item.id}::uuid,
                    'tmdb',
                    ${sql.json({
                        genres: [
                            { id: 28, name: 'Action' },
                            { id: 12, name: 'Adventure' },
                        ],
                    })},
                    NOW()
                )
            `;

            const result = await getDistinctGenresForLibrary(sql, null, unrestrictedAccess());
            const names = result.map((g) => g.name);

            expect(names).toContain('Action');
            expect(names).toContain('Adventure');

            // itemCount matters, not just the name: clients drop genres whose
            // count is 0 before rendering, so an accurate name with no count
            // still renders as empty client-side.
            const action = result.find((g) => g.name === 'Action');
            expect(action?.itemCount).toBe(1);
        });

        it('counts only file-backed items, like /j Items browsing', async () => {
            // File-backed movie: counts.
            const backed = createTestMediaItem({ media_type: 'movie', title: 'Backed' });
            await insertTestMediaItem(sql, backed);
            await attachFileToMediaItem(backed.id, '/movies/backed.mkv');
            await insertGenres(backed.id, ['Drama', 'Shared']);

            // TMDB discovery row: never had a file.
            const discovery = createTestMediaItem({ media_type: 'movie', title: 'Discovery' });
            await insertTestMediaItem(sql, discovery);
            await insertGenres(discovery.id, ['DiscoveryOnly', 'Shared']);

            // Lost files: the file row is gone but the has_files roll-up is stale.
            const lost = createTestMediaItem({ media_type: 'movie', title: 'Luma' });
            await insertTestMediaItem(sql, lost);
            await attachFileToMediaItem(lost.id, '/movies/lost.mkv');
            await sql`DELETE FROM media_file_items WHERE media_item_id = ${lost.id}::uuid`;
            await insertGenres(lost.id, ['LostOnly', 'Shared']);

            // Series: availability comes from an episode's file, not the series row.
            const series = await createAndInsertTestSeries(sql, {
                title: 'Genre Series',
                tmdbId: 991_301,
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            const [episodeId] = await getEpisodeIdsForSeries(series.seriesId);
            await attachFileToMediaItem(episodeId, '/shows/genre-series/s01e01.mkv');
            await insertGenres(series.seriesId, ['Shared']);

            const result = await getDistinctGenresForLibrary(sql, null, unrestrictedAccess());

            expect(result).toEqual([
                { name: 'Drama', itemCount: 1 },
                { name: 'Shared', itemCount: 2 },
            ]);

            // The same set /j Items browsing returns for the shared genre.
            const browsed = await browseMediaItems(sql, {
                mediaTypes: [],
                parentId: null,
                searchTerm: null,
                genres: ['Shared'],
                years: [],
                nameStartsWith: null,
                isFavoriteFilter: false,
                isPlayedFilter: false,
                isUnplayedFilter: false,
                enableUserData: false,
                userId: undefined,
                idList: [],
                sortBy: 'SortName',
                sortOrder: 'Ascending',
                limit: 50,
                startIndex: 0,
                access: unrestrictedAccess(),
            });
            expect(browsed.totalCount).toBe(2);
            expect(browsed.rows.map((r) => r.id).sort()).toEqual(
                [backed.id, series.seriesId].sort(),
            );
        });

        it('returns empty array when no genres exist', async () => {
            const result = await getDistinctGenresForLibrary(sql, null, unrestrictedAccess());
            expect(Array.isArray(result)).toBe(true);
        });

        it('filters by library group when parentId provided', async () => {
            const result = await getDistinctGenresForLibrary(
                sql,
                '00000000-0000-0000-0000-000000000000',
                unrestrictedAccess(),
            );
            expect(Array.isArray(result)).toBe(true);
        });
    });

    // ========================================================================
    // Access boundary — differential coverage
    //
    // Every query below is run TWICE against the same fixture: once with an
    // explicitly unrestricted boundary, once with a restricted one. The
    // restricted result must be a STRICT subset of the unrestricted one, and a
    // denyAll boundary must return nothing.
    //
    // This is what catches a boundary argument that arrived but was never
    // spliced into the SQL (the query would return identical sets both times),
    // and a predicate attached to the wrong table alias (the query would throw
    // or return the wrong set).
    // ========================================================================

    describe('access boundary', () => {
        /** Deny the restricted library group AND cap the age at 12, unrated hidden. */
        function restrictedBoundary(deniedGroupId: string) {
            return restrictedAccess({
                deniedGroupIds: [deniedGroupId],
                maxAgeRating: 12,
                allowUnrated: false,
            });
        }

        async function createLibraryGroup(name: string): Promise<string> {
            const [row] = await sql<{ id: string }[]>`
                INSERT INTO library_groups (name, sort_order, created_at, updated_at)
                VALUES (${name}, 1, NOW(), NOW())
                RETURNING id
            `;
            return row.id;
        }

        async function attachFile(
            mediaItemId: string,
            libraryGroupId: string,
            path: string,
        ): Promise<void> {
            const [file] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, library_group_id, created_at, updated_at)
                VALUES (${path}, ${libraryGroupId}::uuid, NOW(), NOW())
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${file.id}::uuid, ${mediaItemId}::uuid)
            `;
            await sql`UPDATE media_items SET has_files = true WHERE id = ${mediaItemId}::uuid`;
        }

        interface MovieFixture {
            allowedGroupId: string;
            deniedGroupId: string;
            /** Visible under the restricted boundary. */
            visibleId: string;
            /** Hidden by the LIBRARY axis only. */
            deniedLibraryId: string;
            /** Hidden by the AGE axis only. */
            deniedAgeId: string;
        }

        /**
         * Three movies that isolate each axis: one passes both, one fails only
         * the library axis, one fails only the age axis. A query that drops the
         * library predicate keeps `deniedLibraryId`; one that drops the age
         * predicate keeps `deniedAgeId`.
         */
        async function seedMovies(): Promise<MovieFixture> {
            const allowedGroupId = await createLibraryGroup('Allowed');
            const deniedGroupId = await createLibraryGroup('Denied');

            const visible = createTestMediaItem({ media_type: 'movie', title: 'AAA Visible' });
            const deniedLibrary = createTestMediaItem({
                media_type: 'movie',
                title: 'BBB Denied Library',
            });
            const deniedAge = createTestMediaItem({ media_type: 'movie', title: 'CCC Denied Age' });
            await insertTestMediaItem(sql, visible);
            await insertTestMediaItem(sql, deniedLibrary);
            await insertTestMediaItem(sql, deniedAge);

            await attachFile(visible.id, allowedGroupId, '/movies/visible.mkv');
            await attachFile(deniedLibrary.id, deniedGroupId, '/movies/denied-library.mkv');
            await attachFile(deniedAge.id, allowedGroupId, '/movies/denied-age.mkv');

            await sql`UPDATE media_items SET age_rating = 6 WHERE id = ${visible.id}::uuid`;
            await sql`UPDATE media_items SET age_rating = 6 WHERE id = ${deniedLibrary.id}::uuid`;
            await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${deniedAge.id}::uuid`;

            return {
                allowedGroupId,
                deniedGroupId,
                visibleId: visible.id,
                deniedLibraryId: deniedLibrary.id,
                deniedAgeId: deniedAge.id,
            };
        }

        /** Assert `restricted` is a strict subset of `unrestricted`. */
        function expectStrictSubset(restricted: string[], unrestricted: string[]): void {
            for (const id of restricted) {
                expect(unrestricted).toContain(id);
            }
            expect(restricted.length).toBeLessThan(unrestricted.length);
        }

        function browseOptions(access: MediaAccessBoundary) {
            return {
                mediaTypes: ['movie'],
                parentId: null,
                searchTerm: null,
                genres: [],
                years: [],
                nameStartsWith: null,
                isFavoriteFilter: false,
                isPlayedFilter: false,
                isUnplayedFilter: false,
                enableUserData: false,
                userId: undefined,
                idList: [],
                sortBy: 'SortName',
                sortOrder: 'Ascending',
                limit: 50,
                startIndex: 0,
                access,
            };
        }

        it('browseMediaItems: restricted rows are a strict subset and totalCount agrees', async () => {
            const fx = await seedMovies();

            const open = await browseMediaItems(sql, browseOptions(unrestrictedAccess()));
            const closed = await browseMediaItems(
                sql,
                browseOptions(restrictedBoundary(fx.deniedGroupId)),
            );

            const openIds = open.rows.map((r) => r.id as string);
            const closedIds = closed.rows.map((r) => r.id as string);

            expect(openIds).toEqual(
                expect.arrayContaining([fx.visibleId, fx.deniedLibraryId, fx.deniedAgeId]),
            );
            expect(closedIds).toEqual([fx.visibleId]);
            expectStrictSubset(closedIds, openIds);

            // The count query and the rows query carry the SAME predicate block.
            // If a refactor updates one and not the other, these diverge.
            expect(open.totalCount).toBe(openIds.length);
            expect(closed.totalCount).toBe(closedIds.length);
        });

        it('browseMediaItems: denyAll returns no rows and a zero count', async () => {
            await seedMovies();

            const result = await browseMediaItems(sql, browseOptions(denyAllAccess()));

            expect(result.rows.length).toBe(0);
            expect(result.totalCount).toBe(0);
        });

        it('getLatestItems: restricted is a strict subset; denyAll is empty', async () => {
            const fx = await seedMovies();

            const open = await getLatestItems(sql, {
                limit: 50,
                parentId: null,
                groupItems: true,
                access: unrestrictedAccess(),
            });
            const closed = await getLatestItems(sql, {
                limit: 50,
                parentId: null,
                groupItems: true,
                access: restrictedBoundary(fx.deniedGroupId),
            });
            const none = await getLatestItems(sql, {
                limit: 50,
                parentId: null,
                groupItems: true,
                access: denyAllAccess(),
            });

            const openIds = open.map((r) => r.id as string);
            const closedIds = closed.map((r) => r.id as string);

            expect(closedIds).toEqual([fx.visibleId]);
            expectStrictSubset(closedIds, openIds);
            expect(none.length).toBe(0);
        });

        it('enrichMediaItemsByIds: restricted is a strict subset; denyAll is empty', async () => {
            const fx = await seedMovies();
            const ids = [fx.visibleId, fx.deniedLibraryId, fx.deniedAgeId];

            const open = await enrichMediaItemsByIds(sql, ids, unrestrictedAccess());
            const closed = await enrichMediaItemsByIds(
                sql,
                ids,
                restrictedBoundary(fx.deniedGroupId),
            );
            const none = await enrichMediaItemsByIds(sql, ids, denyAllAccess());

            const openIds = open.map((r) => r.id as string);
            const closedIds = closed.map((r) => r.id as string);

            expect(closedIds).toEqual([fx.visibleId]);
            expectStrictSubset(closedIds, openIds);
            expect(none.length).toBe(0);
        });

        it('getResumeItems: restricted is a strict subset; denyAll is empty', async () => {
            const userId: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);
            const fx = await seedMovies();

            // Movies each land in their own ROW_NUMBER partition, so the
            // series-dedup window cannot mask an access-filter regression here.
            for (const id of [fx.visibleId, fx.deniedLibraryId, fx.deniedAgeId]) {
                await sql`
                    INSERT INTO user_media_state (
                        user_id, media_id, resume_position_ms, runtime_ms, is_watched,
                        last_watched_at, last_event_source
                    ) VALUES (
                        ${userId}::uuid, ${id}::uuid, 600000, 7200000, false,
                        NOW(), 'lumastra'
                    )
                `;
            }

            const open = await getResumeItems(sql, userId, 50, unrestrictedAccess());
            const closed = await getResumeItems(
                sql,
                userId,
                50,
                restrictedBoundary(fx.deniedGroupId),
            );
            const none = await getResumeItems(sql, userId, 50, denyAllAccess());

            const openIds = open.map((r) => r.id as string);
            const closedIds = closed.map((r) => r.id as string);

            expect(closedIds).toEqual([fx.visibleId]);
            expectStrictSubset(closedIds, openIds);
            expect(none.length).toBe(0);
        });

        it('getDistinctGenresForLibrary: restricted is a strict subset; denyAll is empty', async () => {
            const fx = await seedMovies();

            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${fx.visibleId}::uuid, 'tmdb', ${sql.json({
                    genres: [{ id: 28, name: 'Action' }],
                })}, NOW())
            `;
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${fx.deniedLibraryId}::uuid, 'tmdb', ${sql.json({
                    genres: [{ id: 99, name: 'SecretLibraryGenre' }],
                })}, NOW())
            `;
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${fx.deniedAgeId}::uuid, 'tmdb', ${sql.json({
                    genres: [{ id: 27, name: 'SecretAgeGenre' }],
                })}, NOW())
            `;

            const open = (await getDistinctGenresForLibrary(sql, null, unrestrictedAccess())).map(
                (g) => g.name,
            );
            const closed = (
                await getDistinctGenresForLibrary(sql, null, restrictedBoundary(fx.deniedGroupId))
            ).map((g) => g.name);
            const none = await getDistinctGenresForLibrary(sql, null, denyAllAccess());

            expect(open).toEqual(
                expect.arrayContaining(['Action', 'SecretLibraryGenre', 'SecretAgeGenre']),
            );
            expect(closed).toEqual(['Action']);
            expectStrictSubset(closed, open);
            expect(none).toEqual([]);
        });

        it('getSeriesEpisodes: restricted is a strict subset; denyAll is empty', async () => {
            const allowedGroupId = await createLibraryGroup('Allowed');
            const deniedGroupId = await createLibraryGroup('Denied');

            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 3,
            });
            const episodes = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE media_type = 'episode'
                  AND parent_id IN (
                      SELECT id FROM media_items
                      WHERE parent_id = ${series.seriesId} AND media_type = 'season'
                  )
                ORDER BY episode_number
            `;
            expect(episodes.length).toBe(3);

            await attachFile(episodes[0].id, allowedGroupId, '/tv/e1.mkv');
            await attachFile(episodes[1].id, deniedGroupId, '/tv/e2.mkv');
            await attachFile(episodes[2].id, allowedGroupId, '/tv/e3.mkv');
            // Age policy belongs to the series: episode rows keep a NULL rating.
            await sql`UPDATE media_items SET age_rating = 6 WHERE id = ${series.seriesId}::uuid`;

            const base = {
                seriesId: series.seriesId,
                seasonId: null,
                seasonNumber: null,
                enableUserData: false,
                userId: undefined,
                limit: 50,
                startIndex: 0,
            };

            const open = await getSeriesEpisodes(sql, { ...base, access: unrestrictedAccess() });
            const closed = await getSeriesEpisodes(sql, {
                ...base,
                access: restrictedBoundary(deniedGroupId),
            });
            const none = await getSeriesEpisodes(sql, { ...base, access: denyAllAccess() });

            const openIds = open.map((r) => r.id as string);
            const closedIds = closed.map((r) => r.id as string);

            expect(closedIds).toEqual([episodes[0].id, episodes[2].id]);
            expectStrictSubset(closedIds, openIds);
            expect(none.length).toBe(0);
        });

        it('getNextUpEpisodes: applies the boundary; denyAll is empty', async () => {
            const userId: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);
            const allowedGroupId = await createLibraryGroup('Allowed');
            const deniedGroupId = await createLibraryGroup('Denied');

            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 2,
            });
            const episodes = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE media_type = 'episode'
                  AND parent_id IN (
                      SELECT id FROM media_items
                      WHERE parent_id = ${series.seriesId} AND media_type = 'season'
                  )
                ORDER BY episode_number
            `;
            await attachFile(episodes[0].id, allowedGroupId, '/tv/n1.mkv');
            await attachFile(episodes[1].id, deniedGroupId, '/tv/n2.mkv');
            await sql`UPDATE media_items SET age_rating = 6 WHERE id = ${series.seriesId}::uuid`;

            // Episode 1 watched -> episode 2 is "next up".
            await sql`
                INSERT INTO user_media_state (user_id, media_id, is_watched, resume_position_ms, runtime_ms, last_watched_at)
                VALUES (${userId}::uuid, ${episodes[0].id}::uuid, true, 0, 2700000, NOW())
            `;

            const open = await getNextUpEpisodes(sql, userId, 50, unrestrictedAccess());
            const closed = await getNextUpEpisodes(
                sql,
                userId,
                50,
                restrictedBoundary(deniedGroupId),
            );
            const none = await getNextUpEpisodes(sql, userId, 50, denyAllAccess());

            expect(open.map((r) => r.id as string)).toContain(episodes[1].id);
            // Pre-existing behaviour, deliberately preserved: DISTINCT ON picks
            // the next episode BEFORE the boundary is applied, so a denied next
            // episode removes the whole series rather than falling through.
            expect(closed.length).toBe(0);
            expect(none.length).toBe(0);
        });
    });
});
