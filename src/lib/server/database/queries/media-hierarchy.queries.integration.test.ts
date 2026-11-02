// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Media Hierarchy Query Module
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    getHierarchyItem,
    getParentBasicInfo,
    getSeasonsForSeries,
    getEpisodesForSeriesHierarchy,
    flattenSeriesEpisodesRaw,
} from './media-hierarchy.queries.js';

describe('Media Hierarchy Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, 'media_file_items', 'media_files']);
    });

    // ========================================================================
    // getHierarchyItem
    // ========================================================================

    describe('getHierarchyItem', () => {
        it('returns item with mediaType and jellyfinId', async () => {
            const item = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, item);
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${item.id}::uuid, 'jellyfin', 'jf123', 'tv', false)
            `;

            const row = await getHierarchyItem(sql, item.id);
            expect(row).not.toBeNull();
            expect(row!.id).toBe(item.id);
            expect(row!.mediaType).toBe('tv');
            expect(row!.jellyfinId).toBe('jf123');
        });

        it('returns null for non-existent item', async () => {
            const row = await getHierarchyItem(sql, '00000000-0000-0000-0000-000000000000');
            expect(row).toBeNull();
        });
    });

    // ========================================================================
    // getParentBasicInfo
    // ========================================================================

    describe('getParentBasicInfo', () => {
        it('returns parent info', async () => {
            const parent = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, parent);

            const info = await getParentBasicInfo(sql, parent.id);
            expect(info).not.toBeNull();
            expect(info!.id).toBe(parent.id);
            expect(info!.mediaType).toBe('tv');
        });

        it('returns null for non-existent parent', async () => {
            const info = await getParentBasicInfo(sql, '00000000-0000-0000-0000-000000000000');
            expect(info).toBeNull();
        });
    });

    // ========================================================================
    // getSeasonsForSeries
    // ========================================================================

    describe('getSeasonsForSeries', () => {
        it('returns seasons with episode counts', async () => {
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const season1 = crypto.randomUUID();
            const season2 = crypto.randomUUID();
            await insertTestMediaItem(
                sql,
                createTestMediaItem({
                    media_type: 'season',
                    id: season1,
                    title: 'Season 1',
                }),
            );
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid, season_number = 1 WHERE id = ${season1}::uuid`;

            await insertTestMediaItem(
                sql,
                createTestMediaItem({
                    media_type: 'season',
                    id: season2,
                    title: 'Season 2',
                }),
            );
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid, season_number = 2 WHERE id = ${season2}::uuid`;

            // Add episodes under season1
            for (let i = 1; i <= 3; i++) {
                const epId = crypto.randomUUID();
                await insertTestMediaItem(
                    sql,
                    createTestMediaItem({
                        media_type: 'episode',
                        id: epId,
                        title: `S1E${i}`,
                    }),
                );
                await sql`UPDATE media_items SET parent_id = ${season1}::uuid, season_number = 1, episode_number = ${i} WHERE id = ${epId}::uuid`;
            }

            const rows = await getSeasonsForSeries(sql, series.id);
            expect(rows).toHaveLength(2);
            const s1 = rows.find((r) => r.season_number === 1);
            expect(s1).toBeDefined();
            expect(Number(s1!.episode_count)).toBe(3);
        });

        it('returns empty array for series with no seasons', async () => {
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const rows = await getSeasonsForSeries(sql, series.id);
            expect(rows).toEqual([]);
        });
    });

    // ========================================================================
    // getEpisodesForSeriesHierarchy
    // ========================================================================

    describe('getEpisodesForSeriesHierarchy', () => {
        it('returns episodes for a series', async () => {
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const season1 = crypto.randomUUID();
            await insertTestMediaItem(
                sql,
                createTestMediaItem({
                    media_type: 'season',
                    id: season1,
                }),
            );
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid WHERE id = ${season1}::uuid`;

            const epId = crypto.randomUUID();
            await insertTestMediaItem(
                sql,
                createTestMediaItem({
                    media_type: 'episode',
                    id: epId,
                }),
            );
            await sql`UPDATE media_items SET parent_id = ${season1}::uuid, season_number = 1, episode_number = 1 WHERE id = ${epId}::uuid`;

            const rows = await getEpisodesForSeriesHierarchy(sql, series.id);
            expect(rows).toHaveLength(1);
            expect(rows[0].id).toBe(epId);
        });

        it('includes has_file when episode has linked file', async () => {
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const epId = crypto.randomUUID();
            await insertTestMediaItem(
                sql,
                createTestMediaItem({
                    media_type: 'episode',
                    id: epId,
                }),
            );
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid, media_type = 'episode', season_number = 1, episode_number = 1 WHERE id = ${epId}::uuid`;

            // Link a media file
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path)
                VALUES (${fileId}::uuid, '/episodes/s01e01.mkv')
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${fileId}::uuid, ${epId}::uuid, true)
            `;

            const rows = await getEpisodesForSeriesHierarchy(sql, series.id);
            expect(rows).toHaveLength(1);
            expect(rows[0].has_file).toBe(true);
        });
    });

    // ========================================================================
    // flattenSeriesEpisodesRaw
    // ========================================================================

    describe('flattenSeriesEpisodesRaw', () => {
        it('returns episodes in season/episode order', async () => {
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const season1 = crypto.randomUUID();
            await insertTestMediaItem(
                sql,
                createTestMediaItem({
                    media_type: 'season',
                    id: season1,
                }),
            );
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid WHERE id = ${season1}::uuid`;

            // Episodes out of order
            const ep2 = crypto.randomUUID();
            const ep1 = crypto.randomUUID();
            await insertTestMediaItem(
                sql,
                createTestMediaItem({
                    media_type: 'episode',
                    id: ep2,
                }),
            );
            await sql`UPDATE media_items SET parent_id = ${season1}::uuid, media_type = 'episode', season_number = 1, episode_number = 2 WHERE id = ${ep2}::uuid`;
            await insertTestMediaItem(
                sql,
                createTestMediaItem({
                    media_type: 'episode',
                    id: ep1,
                }),
            );
            await sql`UPDATE media_items SET parent_id = ${season1}::uuid, media_type = 'episode', season_number = 1, episode_number = 1 WHERE id = ${ep1}::uuid`;

            const rows = await flattenSeriesEpisodesRaw(sql, series.id);
            expect(rows).toHaveLength(2);
            expect(rows[0].episode_id).toBe(ep1);
            expect(rows[1].episode_id).toBe(ep2);
        });

        it('excludes specials (season_number = 0)', async () => {
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const ep0 = crypto.randomUUID();
            await insertTestMediaItem(sql, createTestMediaItem({ media_type: 'episode', id: ep0 }));
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid, media_type = 'episode', season_number = 0, episode_number = 1 WHERE id = ${ep0}::uuid`;

            const rows = await flattenSeriesEpisodesRaw(sql, series.id);
            expect(rows).toHaveLength(0);
        });

        it('returns empty array when no episodes exist', async () => {
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const rows = await flattenSeriesEpisodesRaw(sql, series.id);
            expect(rows).toEqual([]);
        });
    });
});
