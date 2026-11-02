// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Jellyfin Item Detail Query Module
 *
 * Tests item detail retrieval, chapter lookup, trickplay lookup,
 * and library group info queries.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';
import { upsertWatchlistItem } from './watchlist.queries.js';

import {
    getItemDetail,
    getChaptersForItem,
    getTrickplayForItem,
    getLibraryGroupInfo,
    getAncestorItemIds,
    getLibraryGroupForItem,
} from './jellyfin-item-detail.queries.js';

describe('Jellyfin Item Detail Queries', () => {
    let sql: postgres.Sql;
    const testUserId: UserId = toUserId(randomUUID());

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'trickplay_params',
            'episode_chapters',
            'media_file_items',
            'media_files',
            'playlist_items',
            'playlists',
            'user_media_state',
            'provider_metadata',
            'library_paths',
            'media_items',
            'external_ids',
        ]);
    });

    // ========================================================================
    // getItemDetail
    // ========================================================================

    describe('getItemDetail', () => {
        it('returns item detail for a movie', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const result = await getItemDetail(sql, item.id, testUserId);

            expect(result).not.toBeNull();
            expect(result!.id).toBe(item.id);
            expect(result!.title).toBe(item.title);
            expect(result!.media_type).toBe('movie');
        });

        it('returns null for deleted items', async () => {
            const item = createTestMediaItem({
                media_type: 'movie',
                status: 'deleted',
            });
            await insertTestMediaItem(sql, item);

            const result = await getItemDetail(sql, item.id, testUserId);
            expect(result).toBeNull();
        });

        it('returns watch state when user has watched', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await ensureTestUser(sql, testUserId);
            await sql`
                INSERT INTO user_media_state (user_id, media_id, is_watched, resume_position_ms, runtime_ms)
                VALUES (${testUserId}::uuid, ${item.id}::uuid, true, 0, 7200000)
            `;

            const result = await getItemDetail(sql, item.id, testUserId);
            expect(result).not.toBeNull();
            expect(result!.is_watched).toBe(true);
        });

        it('returns favorite status when user has favorited', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await ensureTestUser(sql, testUserId);
            await upsertWatchlistItem(sql, testUserId, item.id);

            const result = await getItemDetail(sql, item.id, testUserId);
            expect(result).not.toBeNull();
            expect(result!.is_favorite).toBe(true);
        });

        it('includes provider metadata when available', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (
                    ${item.id}::uuid,
                    'tmdb',
                    ${sql.json({ overview: 'Test overview', vote_average: 8.5 })},
                    NOW()
                )
            `;

            const result = await getItemDetail(sql, item.id, testUserId);
            expect(result).not.toBeNull();
            expect(result!.pm_overview).toBe('Test overview');
            expect(result!.vote_average).toBe(8.5);
        });
    });

    // ========================================================================
    // getChaptersForItem
    // ========================================================================

    describe('getChaptersForItem', () => {
        it('returns chapters for an item', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const [fileRow] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path)
                VALUES ('/movie.mkv')
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileRow.id}::uuid, ${item.id}::uuid)
            `;

            await sql`
                INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks)
                VALUES
                    (${fileRow.id}::uuid, 0, 'Intro', 0),
                    (${fileRow.id}::uuid, 1, 'Main', 10000000)
            `;

            const result = await getChaptersForItem(sql, item.id);
            expect(result).toHaveLength(2);
            expect(result[0].chapter_index).toBe(0);
            expect(result[1].chapter_name).toBe('Main');
        });

        it('returns empty array for item with no chapters', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const result = await getChaptersForItem(sql, item.id);
            expect(result).toEqual([]);
        });
    });

    // ========================================================================
    // getTrickplayForItem
    // ========================================================================

    describe('getTrickplayForItem', () => {
        it('returns trickplay params for an item', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const [fileRow] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path)
                VALUES ('/movie.mkv')
                RETURNING id
            `;

            await sql`
                INSERT INTO trickplay_params (
                    media_item_id, file_id, width, height,
                    tile_width, tile_height, thumbnail_count, interval_ms, bandwidth, source
                )
                VALUES (
                    ${item.id}::uuid, ${fileRow.id}::uuid,
                    320, 180, 10, 10, 100, 10000, 5000,
                    'intro'
                )
            `;

            const result = await getTrickplayForItem(sql, item.id);
            expect(result).toHaveLength(1);
            expect(result[0].width).toBe(320);
            expect(result[0].height).toBe(180);
            expect(result[0].thumbnail_count).toBe(100);
        });

        it('returns empty array for item with no trickplay', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const result = await getTrickplayForItem(sql, item.id);
            expect(result).toEqual([]);
        });
    });

    // ========================================================================
    // getLibraryGroupInfo
    // ========================================================================

    describe('getLibraryGroupInfo', () => {
        it('returns library group info for an enabled path', async () => {
            const [groupRow] = await sql<{ id: string }[]>`
                INSERT INTO library_groups (name)
                VALUES ('Test Lib')
                RETURNING id
            `;

            await sql`
                INSERT INTO library_paths (library_group_id, media_type, path, enabled)
                VALUES (${groupRow.id}::uuid, 'movie', '/data/movies', true)
            `;

            const result = await getLibraryGroupInfo(sql, groupRow.id, null);
            expect(result).not.toBeNull();
            expect(result!.library_group_id).toBe(groupRow.id);
            expect(result!.media_type).toBe('movie');
            expect(result!.path).toBe('/data/movies');
            expect(result!.group_name).toBe('Test Lib');
        });

        it('prefers display_name over name when both are set', async () => {
            const [groupRow] = await sql<{ id: string }[]>`
                INSERT INTO library_groups (name, display_name)
                VALUES ('4kmovies', '4K Movies')
                RETURNING id
            `;

            await sql`
                INSERT INTO library_paths (library_group_id, media_type, path, enabled)
                VALUES (${groupRow.id}::uuid, 'movie', '/data/4kmovies', true)
            `;

            const result = await getLibraryGroupInfo(sql, groupRow.id, null);
            expect(result!.group_name).toBe('4K Movies');
        });

        it('returns null when no enabled path exists', async () => {
            const result = await getLibraryGroupInfo(
                sql,
                '00000000-0000-0000-0000-000000000000',
                null,
            );
            expect(result).toBeNull();
        });

        it('still returns info for a disabled path (item-level browsing does not gate on enabled)', async () => {
            const [groupRow] = await sql<{ id: string }[]>`
                INSERT INTO library_groups (name)
                VALUES ('Test Lib')
                RETURNING id
            `;

            await sql`
                INSERT INTO library_paths (library_group_id, media_type, path, enabled)
                VALUES (${groupRow.id}::uuid, 'movie', '/data/movies', false)
            `;

            const result = await getLibraryGroupInfo(sql, groupRow.id, null);
            expect(result).not.toBeNull();
            expect(result!.library_group_id).toBe(groupRow.id);
        });
    });

    // ========================================================================
    // getAncestorItemIds / getLibraryGroupForItem (GET /j/Items/{id}/Ancestors)
    // ========================================================================

    async function seedSeriesTree(): Promise<{
        seriesId: string;
        seasonId: string;
        episodeId: string;
    }> {
        const seriesId = await insertTestMediaItem(
            sql,
            createTestMediaItem({ media_type: 'tv', title: 'Ancestors Series' }),
        );
        const seasonId = await insertTestMediaItem(
            sql,
            createTestMediaItem({ media_type: 'season', title: 'Season 1', parent_id: seriesId }),
        );
        const episodeId = await insertTestMediaItem(
            sql,
            createTestMediaItem({ media_type: 'episode', title: 'Pilot', parent_id: seasonId }),
        );
        return { seriesId, seasonId, episodeId };
    }

    async function seedLibraryFile(mediaItemId: string): Promise<string> {
        const [groupRow] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name)
            VALUES ('Ancestors Lib')
            RETURNING id
        `;
        await sql`
            INSERT INTO library_paths (library_group_id, media_type, path, enabled)
            VALUES (${groupRow.id}::uuid, 'tv', '/data/series', true)
        `;
        const [fileRow] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, library_group_id)
            VALUES (${'/data/series/x/' + mediaItemId + '.mkv'}, ${groupRow.id}::uuid)
            RETURNING id
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${fileRow.id}::uuid, ${mediaItemId}::uuid)
        `;
        return groupRow.id;
    }

    describe('getAncestorItemIds', () => {
        it('returns [season, series] for an episode, nearest first', async () => {
            const { seriesId, seasonId, episodeId } = await seedSeriesTree();

            const chain = await getAncestorItemIds(sql, episodeId);

            expect(chain.map((r) => r.id)).toEqual([seasonId, seriesId]);
            expect(chain.map((r) => r.media_type)).toEqual(['season', 'tv']);
        });

        it('returns [series] for a season', async () => {
            const { seriesId, seasonId } = await seedSeriesTree();

            const chain = await getAncestorItemIds(sql, seasonId);

            expect(chain.map((r) => r.id)).toEqual([seriesId]);
        });

        it('returns [] for an item without a parent', async () => {
            const movieId = await insertTestMediaItem(
                sql,
                createTestMediaItem({ media_type: 'movie' }),
            );

            expect(await getAncestorItemIds(sql, movieId)).toEqual([]);
        });

        it('stops at inactive ancestors', async () => {
            const { seriesId, seasonId, episodeId } = await seedSeriesTree();
            await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${seriesId}`;

            const chain = await getAncestorItemIds(sql, episodeId);

            expect(chain.map((r) => r.id)).toEqual([seasonId]);
        });
    });

    describe('getLibraryGroupForItem', () => {
        it('resolves the library group from the item own file', async () => {
            const { episodeId } = await seedSeriesTree();
            const groupId = await seedLibraryFile(episodeId);

            expect(await getLibraryGroupForItem(sql, episodeId)).toBe(groupId);
        });

        it('resolves the library group for a folder item via descendant files', async () => {
            const { seriesId, episodeId } = await seedSeriesTree();
            const groupId = await seedLibraryFile(episodeId);

            expect(await getLibraryGroupForItem(sql, seriesId)).toBe(groupId);
        });

        it('returns null when neither the item nor its descendants have files', async () => {
            const { seriesId } = await seedSeriesTree();

            expect(await getLibraryGroupForItem(sql, seriesId)).toBeNull();
        });

        // Fallback path: mf.library_group_id IS NULL, so resolution falls
        // through to matching the file's path against library_paths.
        describe('LIKE-prefix fallback (file has no library_group_id of its own)', () => {
            async function seedPathGroup(path: string): Promise<string> {
                const [groupRow] = await sql<{ id: string }[]>`
                    INSERT INTO library_groups (name)
                    VALUES (${'Fallback Lib ' + randomUUID()})
                    RETURNING id
                `;
                await sql`
                    INSERT INTO library_paths (library_group_id, media_type, path, enabled)
                    VALUES (${groupRow.id}::uuid, 'tv', ${path}, true)
                `;
                return groupRow.id;
            }

            async function seedUngroupedFile(mediaItemId: string, filePath: string): Promise<void> {
                const [fileRow] = await sql<{ id: string }[]>`
                    INSERT INTO media_files (file_path, library_group_id)
                    VALUES (${filePath}, NULL)
                    RETURNING id
                `;
                await sql`
                    INSERT INTO media_file_items (file_id, media_item_id)
                    VALUES (${fileRow.id}::uuid, ${mediaItemId}::uuid)
                `;
            }

            it('resolves via the LIKE-prefix fallback when the file has no library_group_id', async () => {
                const { episodeId } = await seedSeriesTree();
                const groupId = await seedPathGroup('/itest/fallback');
                await seedUngroupedFile(episodeId, '/itest/fallback/show/episode.mkv');

                expect(await getLibraryGroupForItem(sql, episodeId)).toBe(groupId);
            });

            it('matches a trailing-slash library_paths.path', async () => {
                const { episodeId } = await seedSeriesTree();
                const groupId = await seedPathGroup('/itest/trailing-slash/');
                await seedUngroupedFile(episodeId, '/itest/trailing-slash/show/episode.mkv');

                expect(await getLibraryGroupForItem(sql, episodeId)).toBe(groupId);
            });

            it('treats "_" in library_paths.path as a literal character, not a wildcard', async () => {
                const { episodeId } = await seedSeriesTree();
                // If '_' were an unescaped wildcard, this path would also match
                // a file under '/itest/mediaXmovies' (any single char for '_').
                await seedPathGroup('/itest/media_movies');
                await seedUngroupedFile(episodeId, '/itest/mediaXmovies/episode.mkv');

                expect(await getLibraryGroupForItem(sql, episodeId)).toBeNull();
            });

            it('treats "%" in library_paths.path as a literal character, not a wildcard', async () => {
                const { episodeId } = await seedSeriesTree();
                // If '%' were an unescaped wildcard, this path would also match
                // a file under '/itest/100XYZ Club' (any chars for '%').
                await seedPathGroup('/itest/100% Club');
                await seedUngroupedFile(episodeId, '/itest/100XYZ Club/episode.mkv');

                expect(await getLibraryGroupForItem(sql, episodeId)).toBeNull();
            });

            // No integration test for the `ORDER BY ..., lp.id ASC` tie-break:
            // `library_paths.path` has a UNIQUE constraint, so two rows can
            // never share a path value, and an actual ORDER BY tie on
            // length(lp.path) would require two equal-length prefixes of the
            // same file_path — which forces them to be the same string. The
            // tie-break is defensive (schema-independent correctness), not
            // reachable through this schema today.
        });
    });
});
