// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for LiveTV Channels Query Module
 *
 * Covers core channel CRUD, categories, visibility, and purge queries.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';

import {
    createChannelWithMediaItem,
    bulkCreateChannels,
    getChannelsBySourceId,
    deleteChannelsBySourceId,
    listCategories,
    getCategoryById,
    createCategory,
    renameCategory,
    categoryExists,
    mergeCategories,
    deleteEmptyCategory,
    getCategoryChannelCount,
    updateChannel,
    bulkUpdateChannels,
    updateCategoryVisibility,
    purgeArchivedChannels,
    purgeEmptyCategories,
    batchUpdateChannelSortOrder,
    getFavoriteChannelIds,
    setChannelFavorite,
    healNullFavoriteOrder,
    getFavoritesForUpdate,
    batchUpdateFavoriteSortOrder,
    shareBackupGroupLogos,
    getAllVisibleChannels,
    searchChannels,
    getChannelsForAdmin,
    setBackupGroupPrimary,
    setBackupGroupsOnAir,
    isChannelStreamableByViewer,
    getStationFeeds,
} from './livetv-channels.queries.js';
import { computeFavoriteOrder } from '$lib/server/api/defs/livetv/favorites/order.js';

async function insertSource(sql: postgres.Sql, id: string, name = 'Test Source'): Promise<void> {
    await sql`
        INSERT INTO livetv_sources (id, name, source_type, max_streams)
        VALUES (${id}::uuid, ${name}, 'm3u', 2)
    `;
}

describe('LiveTV Channels Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql.unsafe(
            'TRUNCATE TABLE livetv_channel_watch_history, livetv_programs, livetv_epg_channels, livetv_channels, livetv_categories, livetv_backup_groups, livetv_sources, media_items RESTART IDENTITY CASCADE',
        );
    });

    describe('setBackupGroupsOnAir', () => {
        it('takes stations off air and back on with one clean feed each', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const a = crypto.randomUUID();
            const b = crypto.randomUUID();
            const ids = {
                aTrans: crypto.randomUUID(),
                aFhd: crypto.randomUUID(),
                aHd: crypto.randomUUID(),
                bFhd: crypto.randomUUID(),
                bHd: crypto.randomUUID(),
            };
            await bulkCreateChannels(sql, {
                channels: [
                    {
                        id: ids.aTrans,
                        name: 'Alpha (Transcoded)',
                        streamUrl: 'http://1',
                        sourceId,
                        backupGroupId: a,
                        qualityTier: 'uhd',
                    },
                    {
                        id: ids.aFhd,
                        name: 'Alpha FHD',
                        streamUrl: 'http://2',
                        sourceId,
                        backupGroupId: a,
                        qualityTier: 'fhd',
                    },
                    {
                        id: ids.aHd,
                        name: 'Alpha HD',
                        streamUrl: 'http://3',
                        sourceId,
                        backupGroupId: a,
                        qualityTier: 'hd',
                    },
                    {
                        id: ids.bFhd,
                        name: 'Beta FHD',
                        streamUrl: 'http://4',
                        sourceId,
                        backupGroupId: b,
                        qualityTier: 'fhd',
                    },
                    {
                        id: ids.bHd,
                        name: 'Beta HD',
                        streamUrl: 'http://5',
                        sourceId,
                        backupGroupId: b,
                        qualityTier: 'hd',
                    },
                ],
                categories: [],
                backupGroups: [
                    // Alpha's primary is the degraded transcoded feed.
                    { id: a, name: 'Alpha', primaryChannelId: ids.aTrans, sourceId },
                    { id: b, name: 'Beta', primaryChannelId: ids.bHd, sourceId },
                ],
            });
            const visible = async (): Promise<string[]> =>
                (
                    await sql<Array<{ id: string }>>`
                        SELECT id FROM livetv_channels WHERE is_visible ORDER BY id
                    `
                ).map((r) => r.id);

            expect(await setBackupGroupsOnAir(sql, [a, b], false)).toBe(2);
            expect(await visible()).toEqual([]);

            expect(await setBackupGroupsOnAir(sql, [a, b, crypto.randomUUID()], true)).toBe(2);
            // Alpha: best normal feed (FHD) instead of the transcoded primary; Beta: its primary.
            expect(await visible()).toEqual([ids.aFhd, ids.bHd].sort());
        });
    });

    describe('setBackupGroupPrimary', () => {
        it('makes a member the primary and refuses a channel of another group', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const bg = crypto.randomUUID();
            const other = crypto.randomUUID();
            const ids = {
                fhd: crypto.randomUUID(),
                plus: crypto.randomUUID(),
                x: crypto.randomUUID(),
            };
            await bulkCreateChannels(sql, {
                channels: [
                    {
                        id: ids.fhd,
                        name: 'Station FHD',
                        streamUrl: 'http://a',
                        sourceId,
                        backupGroupId: bg,
                    },
                    {
                        id: ids.plus,
                        name: 'Station FHD+',
                        streamUrl: 'http://b',
                        sourceId,
                        backupGroupId: bg,
                    },
                    {
                        id: ids.x,
                        name: 'Other HD',
                        streamUrl: 'http://c',
                        sourceId,
                        backupGroupId: other,
                    },
                ],
                categories: [],
                backupGroups: [
                    { id: bg, name: 'Station', primaryChannelId: ids.fhd, sourceId },
                    { id: other, name: 'Other', primaryChannelId: ids.x, sourceId },
                ],
            });

            expect(await setBackupGroupPrimary(sql, bg, ids.plus)).toBe('ok');
            const [row] =
                await sql`SELECT primary_channel_id FROM livetv_backup_groups WHERE id = ${bg}::uuid`;
            expect(row.primary_channel_id).toBe(ids.plus);

            expect(await setBackupGroupPrimary(sql, bg, ids.x)).toBe('not-member');
            expect(await setBackupGroupPrimary(sql, crypto.randomUUID(), ids.plus)).toBe(
                'not-member',
            );
            const [after] =
                await sql`SELECT primary_channel_id FROM livetv_backup_groups WHERE id = ${bg}::uuid`;
            expect(after.primary_channel_id).toBe(ids.plus);
        });
    });

    describe('getChannelsForAdmin', () => {
        it('returns a name match (no EPG channel id) with a numeric confidence and its signals', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const matched = crypto.randomUUID();
            const plain = crypto.randomUUID();
            await createChannelWithMediaItem(sql, {
                id: matched,
                name: 'Premieren FHD',
                streamUrl: 'http://a',
                sourceId,
            });
            await createChannelWithMediaItem(sql, {
                id: plain,
                name: 'Plain',
                streamUrl: 'http://b',
                sourceId,
            });
            await sql`
                UPDATE livetv_channels
                SET epg_match_confidence = 0.900, epg_match_signals = ${['name_exact']}::text[]
                WHERE id = ${matched}::uuid
            `;

            const rows = await getChannelsForAdmin(sql, sourceId);
            const row = rows.find((r) => r.id === matched);
            expect(row?.epg_channel_id).toBeNull();
            // numeric would come back as the string "0.900" without the cast.
            expect(row?.epg_match_confidence).toBe(0.9);
            expect(row?.epg_match_signals).toEqual(['name_exact']);
            const other = rows.find((r) => r.id === plain);
            expect(other?.epg_match_confidence).toBeNull();
            expect(other?.epg_match_signals).toBeNull();
        });
    });

    describe('getAllVisibleChannels — one channel per backup group', () => {
        async function setup(): Promise<{ ids: Record<string, string>; bg: string }> {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const bg = crypto.randomUUID();
            const ids = {
                fhd: crypto.randomUUID(),
                plus: crypto.randomUUID(),
                raw: crypto.randomUUID(),
            };
            await bulkCreateChannels(sql, {
                channels: [
                    {
                        id: ids.fhd,
                        name: 'Station FHD',
                        qualityTier: 'fhd',
                        streamUrl: 'http://a',
                        sourceId,
                        backupGroupId: bg,
                        sortOrder: 3,
                    },
                    {
                        id: ids.plus,
                        name: 'Station FHD+',
                        qualityTier: 'fhd',
                        streamUrl: 'http://b',
                        sourceId,
                        backupGroupId: bg,
                        sortOrder: 1,
                    },
                    {
                        id: ids.raw,
                        name: 'Station HDraw',
                        qualityTier: 'hd',
                        streamUrl: 'http://c',
                        sourceId,
                        backupGroupId: bg,
                        sortOrder: 2,
                    },
                ],
                categories: [],
                backupGroups: [{ id: bg, name: 'Station', sourceId, primaryChannelId: ids.fhd }],
            });
            await sql`UPDATE livetv_backup_groups SET primary_channel_id = ${ids.fhd} WHERE id = ${bg}`;
            return { ids, bg };
        }
        const visibleIds = async (): Promise<string[]> =>
            (await getAllVisibleChannels(sql)).map((r) => r.id);

        it('shows the primary when it is visible, and only it', async () => {
            const { ids } = await setup();
            expect(await visibleIds()).toEqual([ids.fhd]);
        });

        it('shows the first visible feed when the primary is hidden (the station stays)', async () => {
            const { ids } = await setup();
            await sql`UPDATE livetv_channels SET is_visible = false WHERE id = ${ids.fhd}`;
            expect(await visibleIds()).toEqual([ids.plus]);
            await sql`UPDATE livetv_channels SET is_visible = false WHERE id = ${ids.plus}`;
            expect(await visibleIds()).toEqual([ids.raw]);
        });

        it('skips a feed in a hidden category and falls back without a primary', async () => {
            const { ids, bg } = await setup();
            const hiddenCat = crypto.randomUUID();
            await sql`INSERT INTO livetv_categories (id, name, is_visible) VALUES (${hiddenCat}::uuid, 'Hidden', false)`;
            await sql`UPDATE livetv_channels SET category_id = ${hiddenCat}::uuid WHERE id = ${ids.plus}`;
            await sql`UPDATE livetv_backup_groups SET primary_channel_id = NULL WHERE id = ${bg}`;
            // No primary; FHD+ (lowest sort_order) sits in a hidden category: FHD (better than HDraw) shows.
            expect(await visibleIds()).toEqual([ids.fhd]);
        });

        it('prefers a normal feed over a transcoded one when the primary is hidden', async () => {
            const { ids } = await setup();
            await sql`UPDATE media_items SET title = 'Station FHD (Transcoded)' WHERE id = ${ids.plus}`;
            await sql`UPDATE livetv_channels SET is_visible = false WHERE id = ${ids.fhd}`;
            expect(await visibleIds()).toEqual([ids.raw]);
        });

        it('decides per group, not across groups', async () => {
            const a = await setup();
            const b = await setup();
            await sql`UPDATE livetv_channels SET is_visible = false WHERE id = ${a.ids.fhd}`;
            expect((await visibleIds()).sort()).toEqual([a.ids.plus, b.ids.fhd].sort());
        });

        it('search finds the same channel per group as the viewer list', async () => {
            const { ids } = await setup();
            expect((await searchChannels(sql, 'Station')).map((r) => r.id)).toEqual([ids.fhd]);
            await sql`UPDATE livetv_channels SET is_visible = false WHERE id = ${ids.fhd}`;
            expect((await searchChannels(sql, 'Station')).map((r) => r.id)).toEqual([ids.plus]);
            await sql`UPDATE livetv_channels SET is_visible = false WHERE id IN ${sql([ids.plus, ids.raw])}`;
            expect(await searchChannels(sql, 'Station')).toEqual([]);
        });

        it('drops the group only when none of its feeds is visible', async () => {
            const { ids } = await setup();
            await sql`UPDATE livetv_channels SET is_visible = false WHERE id IN ${sql(Object.values(ids))}`;
            expect(await visibleIds()).toEqual([]);
        });
    });

    describe('viewer feed choice — isChannelStreamableByViewer + getStationFeeds', () => {
        async function setup(): Promise<{ ids: Record<string, string>; bg: string }> {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const bg = crypto.randomUUID();
            const ids = {
                fhd: crypto.randomUUID(),
                plus: crypto.randomUUID(),
                mobile: crypto.randomUUID(),
                lone: crypto.randomUUID(),
            };
            const feed = (
                id: string,
                name: string,
                qualityTier: 'fhd' | 'hd' | 'sd',
                sortOrder: number,
            ) => ({
                id,
                name,
                qualityTier,
                streamUrl: `http://${name.replace(/\W/g, '')}`,
                sourceId,
                backupGroupId: bg,
                sortOrder,
            });
            await bulkCreateChannels(sql, {
                channels: [
                    feed(ids.fhd, 'Station FHD', 'fhd', 3),
                    feed(ids.plus, 'Station FHD+', 'fhd', 1),
                    feed(ids.mobile, 'Station (Mobil)', 'sd', 2),
                    {
                        id: ids.lone,
                        name: 'Lonely HD',
                        qualityTier: 'hd',
                        streamUrl: 'http://lone',
                        sourceId,
                        sortOrder: 4,
                    },
                ],
                categories: [],
                backupGroups: [{ id: bg, name: 'Station', sourceId, primaryChannelId: ids.fhd }],
            });
            await sql`UPDATE livetv_backup_groups SET primary_channel_id = ${ids.fhd} WHERE id = ${bg}`;
            // The lineup shows only the primary; the other feeds are hidden.
            await sql`UPDATE livetv_channels SET is_visible = false WHERE id IN ${sql([ids.plus, ids.mobile])}`;
            return { ids, bg };
        }
        const streamable = (id: string, feedChoice = true): Promise<boolean> =>
            isChannelStreamableByViewer(sql, id, feedChoice);

        it('lets a viewer stream a hidden feed of a visible station only while feed choice is on', async () => {
            const { ids } = await setup();
            expect(await streamable(ids.fhd)).toBe(true);
            expect(await streamable(ids.plus)).toBe(true);
            expect(await streamable(ids.plus, false)).toBe(false);
            expect(await streamable(ids.fhd, false)).toBe(true);
        });

        it('refuses every feed once no feed of the station is visible', async () => {
            const { ids } = await setup();
            await sql`UPDATE livetv_channels SET is_visible = false WHERE id = ${ids.fhd}`;
            expect(await streamable(ids.fhd)).toBe(false);
            expect(await streamable(ids.plus)).toBe(false);
        });

        it('refuses a hidden channel without a backup group, and an unknown id', async () => {
            const { ids } = await setup();
            expect(await streamable(ids.lone)).toBe(true);
            await sql`UPDATE livetv_channels SET is_visible = false WHERE id = ${ids.lone}`;
            expect(await streamable(ids.lone)).toBe(false);
            expect(await streamable(crypto.randomUUID())).toBe(false);
        });

        it('refuses a feed in a hidden category, and a station whose only visible feed sits in one', async () => {
            const { ids } = await setup();
            const hiddenCat = crypto.randomUUID();
            await sql`INSERT INTO livetv_categories (id, name, is_visible) VALUES (${hiddenCat}::uuid, 'Hidden', false)`;
            await sql`UPDATE livetv_channels SET category_id = ${hiddenCat}::uuid WHERE id = ${ids.plus}`;
            expect(await streamable(ids.plus)).toBe(false);
            expect(await streamable(ids.mobile)).toBe(true);
            await sql`UPDATE livetv_channels SET category_id = ${hiddenCat}::uuid WHERE id = ${ids.fhd}`;
            expect(await streamable(ids.fhd)).toBe(false);
            expect(await streamable(ids.mobile)).toBe(false);
        });

        it('refuses a hidden feed gone from the playlist (3+ absences)', async () => {
            const { ids } = await setup();
            await sql`UPDATE livetv_channels SET consecutive_absences = 3 WHERE id = ${ids.plus}`;
            expect(await streamable(ids.plus)).toBe(false);
        });

        it('lists the station feeds in viewer rank, the shown feed marked, hidden ones included', async () => {
            const { ids, bg } = await setup();
            const feeds = await getStationFeeds(sql, ids.plus);
            expect(feeds.map((f) => f.id)).toEqual([ids.fhd, ids.plus, ids.mobile]);
            expect(feeds[0]).toMatchObject({
                name: 'Station FHD',
                quality_tier: 'fhd',
                is_visible: true,
                is_primary: true,
                is_shown: true,
                backup_group_id: bg,
            });
            expect(feeds[1]).toMatchObject({
                is_visible: false,
                is_primary: false,
                is_shown: false,
            });
        });

        it('marks the fallback feed as shown when the primary is hidden', async () => {
            const { ids } = await setup();
            await sql`UPDATE livetv_channels SET is_visible = true WHERE id = ${ids.plus}`;
            await sql`UPDATE livetv_channels SET is_visible = false WHERE id = ${ids.fhd}`;
            const feeds = await getStationFeeds(sql, ids.fhd);
            expect(feeds.find((f) => f.is_shown)?.id).toBe(ids.plus);
            expect(feeds.filter((f) => f.is_shown)).toHaveLength(1);
        });

        it('leaves out feeds in hidden categories and hidden feeds gone from the playlist', async () => {
            const { ids } = await setup();
            const hiddenCat = crypto.randomUUID();
            await sql`INSERT INTO livetv_categories (id, name, is_visible) VALUES (${hiddenCat}::uuid, 'Hidden', false)`;
            await sql`UPDATE livetv_channels SET category_id = ${hiddenCat}::uuid WHERE id = ${ids.mobile}`;
            await sql`UPDATE livetv_channels SET consecutive_absences = 5 WHERE id = ${ids.plus}`;
            expect((await getStationFeeds(sql, ids.fhd)).map((f) => f.id)).toEqual([ids.fhd]);
        });

        it('shows the admin rename, keeps the playlist title for degraded detection', async () => {
            const { ids } = await setup();
            await sql`UPDATE livetv_channels SET admin_display_name = 'Station Handy' WHERE id = ${ids.mobile}`;
            const mobile = (await getStationFeeds(sql, ids.fhd)).find((f) => f.id === ids.mobile);
            expect(mobile).toMatchObject({ name: 'Station Handy', raw_name: 'Station (Mobil)' });
        });

        it('returns a channel without a backup group alone', async () => {
            const { ids } = await setup();
            const feeds = await getStationFeeds(sql, ids.lone);
            expect(feeds.map((f) => f.id)).toEqual([ids.lone]);
            expect(feeds[0].backup_group_id).toBeNull();
        });
    });

    describe('shareBackupGroupLogos', () => {
        it('fills empty logos from another feed of the same backup group only', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const bg = crypto.randomUUID();
            const ids = {
                hd: crypto.randomUUID(),
                plus: crypto.randomUUID(),
                raw: crypto.randomUUID(),
                other: crypto.randomUUID(),
                pinned: crypto.randomUUID(),
            };
            await bulkCreateChannels(sql, {
                channels: [
                    {
                        id: ids.hd,
                        name: 'Station HD',
                        streamUrl: 'http://a',
                        sourceId,
                        backupGroupId: bg,
                        logoUrl: 'https://logo.example/station.png',
                        sortOrder: 1,
                    },
                    {
                        id: ids.plus,
                        name: 'Station HD+',
                        streamUrl: 'http://b',
                        sourceId,
                        backupGroupId: bg,
                        sortOrder: 2,
                    },
                    {
                        id: ids.raw,
                        name: 'Station HDraw',
                        streamUrl: 'http://c',
                        sourceId,
                        backupGroupId: bg,
                        logoUrl: '  ',
                        sortOrder: 3,
                    },
                    {
                        id: ids.pinned,
                        name: 'Station SD',
                        streamUrl: 'http://e',
                        sourceId,
                        backupGroupId: bg,
                        sortOrder: 5,
                    },
                    {
                        id: ids.other,
                        name: 'Other HD',
                        streamUrl: 'http://d',
                        sourceId,
                        sortOrder: 4,
                    },
                ],
                categories: [],
                backupGroups: [{ id: bg, name: 'Station', sourceId }],
            });
            await sql`UPDATE livetv_channels SET epg_manual_override = TRUE WHERE id = ${ids.pinned}`;

            expect(await shareBackupGroupLogos(sql, sourceId)).toBe(2);

            const rows = await sql<Array<{ id: string; logo: string | null }>>`
                SELECT id, custom_poster_url AS logo FROM media_items
                 WHERE id IN ${sql(Object.values(ids))}
            `;
            const logo = new Map(rows.map((r) => [r.id, r.logo]));
            expect(logo.get(ids.plus)).toBe('https://logo.example/station.png');
            expect(logo.get(ids.raw)).toBe('https://logo.example/station.png');
            expect(logo.get(ids.other)).toBeNull();
            expect(logo.get(ids.pinned)).toBeNull();
            // Idempotent: nothing left to fill.
            expect(await shareBackupGroupLogos(sql, sourceId)).toBe(0);
        });
    });

    // ========================================================================
    // createChannelWithMediaItem
    // ========================================================================

    describe('createChannelWithMediaItem', () => {
        it('inserts channel and media item atomically', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const channelId = crypto.randomUUID();

            const id = await createChannelWithMediaItem(sql, {
                id: channelId,
                name: 'Test Channel',
                streamUrl: 'http://stream.test/live.m3u8',
                sourceId,
                logoUrl: 'http://logo.test.png',
                qualityTier: 'hd',
            });

            expect(id).toBe(channelId);
            const [mi] = await sql`
                SELECT title, media_type, custom_poster_url FROM media_items WHERE id = ${channelId}::uuid
            `;
            expect(mi.title).toBe('Test Channel');
            expect(mi.media_type).toBe('tvchannel');
            expect(mi.custom_poster_url).toBe('http://logo.test.png');
        });
    });

    // ========================================================================
    // bulkCreateChannels
    // ========================================================================

    describe('bulkCreateChannels', () => {
        it('inserts channels, categories, and backup groups', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const channelId = crypto.randomUUID();
            const catId = crypto.randomUUID();
            const bgId = crypto.randomUUID();

            const result = await bulkCreateChannels(sql, {
                channels: [
                    {
                        id: channelId,
                        name: 'Bulk Ch',
                        streamUrl: 'http://bulk',
                        sourceId,
                        categoryId: catId,
                        backupGroupId: bgId,
                    },
                ],
                categories: [{ id: catId, name: 'Sports' }],
                backupGroups: [{ id: bgId, name: 'Backup 1', sourceId }],
            });

            expect(result.channelCount).toBe(1);
            expect(result.categoryCount).toBe(1);
            expect(result.backupGroupCount).toBe(1);
        });

        it('remaps channel category_id when the category name already exists (FK regression)', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);

            // A "Sports" category already exists — e.g. from a prior refresh.
            const existingCatId = crypto.randomUUID();
            await sql`INSERT INTO livetv_categories (id, name) VALUES (${existingCatId}::uuid, 'Sports')`;

            // A later refresh generates a FRESH optimistic id for the same name
            // and a channel referencing it. Before the fix this hit
            // livetv_channels_category_id_fkey: the optimistic id was never
            // inserted (ON CONFLICT (name) DO NOTHING kept the existing row),
            // so the channel pointed at a non-existent category.
            const optimisticCatId = crypto.randomUUID();
            const channelId = crypto.randomUUID();

            await expect(
                bulkCreateChannels(sql, {
                    channels: [
                        {
                            id: channelId,
                            name: 'Sports HD',
                            streamUrl: 'http://sports',
                            sourceId,
                            categoryId: optimisticCatId,
                        },
                    ],
                    categories: [{ id: optimisticCatId, name: 'Sports' }],
                    backupGroups: [],
                }),
            ).resolves.toBeDefined();

            // Channel points at the pre-existing category row; no duplicate created.
            const [channel] = await sql<{ category_id: string }[]>`
                SELECT category_id FROM livetv_channels WHERE id = ${channelId}::uuid
            `;
            expect(channel.category_id).toBe(existingCatId);

            const cats = await sql<{ count: string }[]>`
                SELECT count(*)::text AS count FROM livetv_categories WHERE name = 'Sports'
            `;
            expect(cats[0].count).toBe('1');
        });

        it('imports a playlist above the 65534 bind-parameter limit', async () => {
            // livetv_channels binds 10 parameters per row, so a single
            // statement overflowed above ~6550 channels (MAX_PARAMETERS_EXCEEDED).
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const total = 7000;
            const catId = crypto.randomUUID();
            const channels = Array.from({ length: total }, (_, i) => ({
                id: crypto.randomUUID(),
                name: `Channel ${i}`,
                streamUrl: `http://bulk/${i}`,
                sourceId,
                categoryId: catId,
                sortOrder: i,
                playlistIndex: i,
            }));
            // A backup group in every chunk, each pointing at its own primary.
            const backupGroups = [0, 2500, 6999].map((i) => {
                const id = crypto.randomUUID();
                channels[i] = { ...channels[i], backupGroupId: id } as (typeof channels)[number];
                return { id, name: `Group ${i}`, sourceId, primaryChannelId: channels[i].id };
            });

            const result = await bulkCreateChannels(sql, {
                channels,
                categories: [{ id: catId, name: `Bulk ${sourceId}` }],
                backupGroups,
            });

            expect(result.channelCount).toBe(total);
            const [count] = await sql<{ n: number }[]>`
                SELECT count(*)::int AS n FROM livetv_channels WHERE source_id = ${sourceId}::uuid
            `;
            expect(count.n).toBe(total);
            const groups = await sql<{ id: string; primary_channel_id: string | null }[]>`
                SELECT id, primary_channel_id FROM livetv_backup_groups WHERE source_id = ${sourceId}::uuid
            `;
            expect(new Map(groups.map((g) => [g.id, g.primary_channel_id]))).toEqual(
                new Map(backupGroups.map((g) => [g.id, g.primaryChannelId])),
            );
        });
    });

    // ========================================================================
    // getChannelsBySourceId / deleteChannelsBySourceId
    // ========================================================================

    describe('getChannelsBySourceId', () => {
        it('returns channels for a source', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const chId = crypto.randomUUID();
            await createChannelWithMediaItem(sql, {
                id: chId,
                name: 'Ch1',
                streamUrl: 'http://ch1',
                sourceId,
            });

            const channels = await getChannelsBySourceId(sql, sourceId);
            expect(channels).toHaveLength(1);
            expect(channels[0].name).toBe('Ch1');
        });

        it('returns empty array for unknown source', async () => {
            const channels = await getChannelsBySourceId(
                sql,
                '00000000-0000-0000-0000-000000000000',
            );
            expect(channels).toEqual([]);
        });
    });

    describe('deleteChannelsBySourceId', () => {
        it('deletes all channels for a source', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const chId = crypto.randomUUID();
            await createChannelWithMediaItem(sql, {
                id: chId,
                name: 'Ch1',
                streamUrl: 'http://ch1',
                sourceId,
            });

            const deleted = await deleteChannelsBySourceId(sql, sourceId);
            expect(deleted).toBe(1);
            expect(await getChannelsBySourceId(sql, sourceId)).toEqual([]);
        });
    });

    // ========================================================================
    // Category queries
    // ========================================================================

    describe('listCategories', () => {
        it('returns categories ordered by sort_order', async () => {
            const _cat1 = await createCategory(sql, 'News');
            const _cat2 = await createCategory(sql, 'Sports');

            const rows = await listCategories(sql);
            expect(rows.length).toBeGreaterThanOrEqual(2);
            const names = rows.map((r) => r.name);
            expect(names).toContain('News');
            expect(names).toContain('Sports');
        });
    });

    describe('getCategoryById', () => {
        it('returns the category when found', async () => {
            const created = await createCategory(sql, 'TestCat');
            const row = await getCategoryById(sql, created.id);
            expect(row).not.toBeNull();
            expect(row!.name).toBe('TestCat');
        });

        it('returns null for unknown id', async () => {
            const row = await getCategoryById(sql, '00000000-0000-0000-0000-000000000000');
            expect(row).toBeNull();
        });
    });

    describe('createCategory', () => {
        it('creates a category with auto sort_order', async () => {
            const cat = await createCategory(sql, 'AutoSort');
            expect(cat.id).toBeTruthy();
            expect(cat.name).toBe('AutoSort');
            expect(typeof cat.sortOrder).toBe('number');
        });

        it('accepts explicit sort_order', async () => {
            const cat = await createCategory(sql, 'Explicit', 42);
            expect(cat.sortOrder).toBe(42);
        });
    });

    describe('renameCategory', () => {
        it('renames an existing category', async () => {
            const cat = await createCategory(sql, 'OldName');
            const ok = await renameCategory(sql, cat.id, 'NewName');
            expect(ok).toBe(true);
            const row = await getCategoryById(sql, cat.id);
            expect(row!.name).toBe('NewName');
        });

        it('returns false for non-existent category', async () => {
            const ok = await renameCategory(sql, '00000000-0000-0000-0000-000000000000', 'X');
            expect(ok).toBe(false);
        });
    });

    describe('categoryExists', () => {
        it('returns true when category exists', async () => {
            const cat = await createCategory(sql, 'Exists');
            expect(await categoryExists(sql, cat.id)).toBe(true);
        });

        it('returns false when category does not exist', async () => {
            expect(await categoryExists(sql, '00000000-0000-0000-0000-000000000000')).toBe(false);
        });
    });

    describe('mergeCategories', () => {
        it('moves channels and deletes source category', async () => {
            const sourceCat = await createCategory(sql, 'Source');
            const targetCat = await createCategory(sql, 'Target');
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const chId = crypto.randomUUID();
            await createChannelWithMediaItem(sql, {
                id: chId,
                name: 'Ch',
                streamUrl: 'http://ch',
                sourceId,
                categoryId: sourceCat.id,
            });

            const result = await mergeCategories(sql, sourceCat.id, targetCat.id);
            expect(result.movedChannelCount).toBe(1);
            expect(await categoryExists(sql, sourceCat.id)).toBe(false);
        });
    });

    describe('deleteEmptyCategory', () => {
        it('deletes an empty category', async () => {
            const cat = await createCategory(sql, 'Empty');
            const result = await deleteEmptyCategory(sql, cat.id);
            expect(result).toEqual({ deleted: true });
            expect(await categoryExists(sql, cat.id)).toBe(false);
        });

        it('refuses to delete category with channels', async () => {
            const cat = await createCategory(sql, 'WithChannels');
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const chId = crypto.randomUUID();
            await createChannelWithMediaItem(sql, {
                id: chId,
                name: 'Ch',
                streamUrl: 'http://ch',
                sourceId,
                categoryId: cat.id,
            });

            const result = await deleteEmptyCategory(sql, cat.id);
            expect(result).toEqual({
                deleted: false,
                reason: 'has_channels',
            });
        });
    });

    describe('getCategoryChannelCount', () => {
        it('returns the number of channels in a category', async () => {
            const cat = await createCategory(sql, 'CountCat');
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const chId = crypto.randomUUID();
            await createChannelWithMediaItem(sql, {
                id: chId,
                name: 'Ch',
                streamUrl: 'http://ch',
                sourceId,
                categoryId: cat.id,
            });

            const count = await getCategoryChannelCount(sql, cat.id);
            expect(count).toBe(1);
        });
    });

    // ========================================================================
    // updateChannel / bulkUpdateChannels / updateCategoryVisibility
    // ========================================================================

    describe('updateChannel', () => {
        it('updates visible and quality_tier', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const chId = crypto.randomUUID();
            await createChannelWithMediaItem(sql, {
                id: chId,
                name: 'Ch',
                streamUrl: 'http://ch',
                sourceId,
            });

            const ok = await updateChannel(sql, chId, {
                isVisible: false,
                qualityTier: 'uhd',
            });
            expect(ok).toBe(true);
            const [row] = await sql`
                SELECT is_visible, quality_tier FROM livetv_channels WHERE id = ${chId}::uuid
            `;
            expect(row.is_visible).toBe(false);
            expect(row.quality_tier).toBe('uhd');
        });

        it('returns false for non-existent channel', async () => {
            const ok = await updateChannel(sql, '00000000-0000-0000-0000-000000000000', {
                isVisible: false,
            });
            expect(ok).toBe(false);
        });
    });

    describe('bulkUpdateChannels', () => {
        it('updates multiple channels', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const ch1 = crypto.randomUUID();
            const ch2 = crypto.randomUUID();
            await createChannelWithMediaItem(sql, {
                id: ch1,
                name: 'Ch1',
                streamUrl: 'http://ch1',
                sourceId,
            });
            await createChannelWithMediaItem(sql, {
                id: ch2,
                name: 'Ch2',
                streamUrl: 'http://ch2',
                sourceId,
            });

            const count = await bulkUpdateChannels(sql, [ch1, ch2], {
                isVisible: false,
            });
            expect(count).toBe(2);
        });

        it('returns 0 for empty channel ids', async () => {
            const count = await bulkUpdateChannels(sql, [], {
                isVisible: false,
            });
            expect(count).toBe(0);
        });
    });

    describe('updateCategoryVisibility', () => {
        it('toggles visibility for category and its channels', async () => {
            const cat = await createCategory(sql, 'Toggle');
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const chId = crypto.randomUUID();
            await createChannelWithMediaItem(sql, {
                id: chId,
                name: 'Ch',
                streamUrl: 'http://ch',
                sourceId,
                categoryId: cat.id,
            });

            const updated = await updateCategoryVisibility(sql, cat.id, false);
            expect(updated).toBe(1);
            const [chRow] = await sql`
                SELECT is_visible FROM livetv_channels WHERE id = ${chId}::uuid
            `;
            expect(chRow.is_visible).toBe(false);
            const [catRow] = await sql`
                SELECT is_visible FROM livetv_categories WHERE id = ${cat.id}::uuid
            `;
            expect(catRow.is_visible).toBe(false);
        });
    });

    // ========================================================================
    // purgeArchivedChannels
    // ========================================================================

    describe('purgeArchivedChannels', () => {
        it('deletes channels the provider dropped, untouched since before the cutoff', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const chId = crypto.randomUUID();
            await createChannelWithMediaItem(sql, {
                id: chId,
                name: 'Old',
                streamUrl: 'http://old',
                sourceId,
                sortOrder: 0,
            });
            await sql`
                UPDATE livetv_channels
                SET is_visible = false, consecutive_absences = 3,
                    updated_at = NOW() - INTERVAL '10 days'
                WHERE id = ${chId}::uuid
            `;

            const deleted = await purgeArchivedChannels(
                sql,
                new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
            );
            expect(deleted).toBe(1);
            const [mi] = await sql`
                SELECT 1 FROM media_items WHERE id = ${chId}::uuid
            `;
            expect(mi).toBeUndefined();
        });

        it('does not delete recently hidden channels', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const chId = crypto.randomUUID();
            await createChannelWithMediaItem(sql, {
                id: chId,
                name: 'Recent',
                streamUrl: 'http://recent',
                sourceId,
            });
            await sql`
                UPDATE livetv_channels
                SET is_visible = false, consecutive_absences = 3,
                    updated_at = NOW() - INTERVAL '1 day'
                WHERE id = ${chId}::uuid
            `;

            const deleted = await purgeArchivedChannels(
                sql,
                new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
            );
            expect(deleted).toBe(0);
        });

        it('never deletes a channel hidden by an admin or Configure Lineup', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const chId = crypto.randomUUID();
            await createChannelWithMediaItem(sql, {
                id: chId,
                name: 'Hidden on purpose',
                streamUrl: 'http://hidden',
                sourceId,
            });
            await sql`
                UPDATE livetv_channels
                SET is_visible = false, updated_at = NOW() - INTERVAL '400 days'
                WHERE id = ${chId}::uuid
            `;

            const deleted = await purgeArchivedChannels(sql, new Date());
            expect(deleted).toBe(0);
            const [mi] = await sql`SELECT 1 FROM media_items WHERE id = ${chId}::uuid`;
            expect(mi).toBeDefined();
        });

        it('deletes by absence count within one source, without a cutoff', async () => {
            const sourceA = crypto.randomUUID();
            const sourceB = crypto.randomUUID();
            await insertSource(sql, sourceA, 'A');
            await insertSource(sql, sourceB, 'B');
            const gone = crypto.randomUUID();
            const recentlyMissing = crypto.randomUUID();
            const otherSource = crypto.randomUUID();
            for (const [id, src, absences] of [
                [gone, sourceA, 14],
                [recentlyMissing, sourceA, 5],
                [otherSource, sourceB, 20],
            ] as const) {
                await createChannelWithMediaItem(sql, {
                    id,
                    name: id,
                    streamUrl: `http://${id}`,
                    sourceId: src,
                });
                await sql`
                    UPDATE livetv_channels
                    SET is_visible = false, consecutive_absences = ${absences}
                    WHERE id = ${id}::uuid
                `;
            }

            const deleted = await purgeArchivedChannels(sql, null, {
                sourceId: sourceA,
                minAbsences: 14,
            });
            expect(deleted).toBe(1);
            const left = await sql<{ id: string }[]>`
                SELECT id::text FROM livetv_channels WHERE id IN (${recentlyMissing}::uuid, ${otherSource}::uuid, ${gone}::uuid)
            `;
            expect(left.map((r) => r.id).sort()).toEqual([recentlyMissing, otherSource].sort());
        });
    });

    describe('purgeEmptyCategories', () => {
        it('deletes old categories without channels, keeps used and fresh ones', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const [used] = await sql<{ id: string }[]>`
                INSERT INTO livetv_categories (name, sort_order, updated_at)
                VALUES ('Used Genre', 1, NOW() - INTERVAL '10 days') RETURNING id::text
            `;
            const [stale] = await sql<{ id: string }[]>`
                INSERT INTO livetv_categories (name, sort_order, updated_at)
                VALUES ('Stale Genre', 2, NOW() - INTERVAL '10 days') RETURNING id::text
            `;
            const [fresh] = await sql<{ id: string }[]>`
                INSERT INTO livetv_categories (name, sort_order)
                VALUES ('Just Created', 3) RETURNING id::text
            `;
            await createChannelWithMediaItem(sql, {
                id: crypto.randomUUID(),
                name: 'In Used',
                streamUrl: 'http://used',
                sourceId,
                categoryId: used.id,
            });

            const deleted = await purgeEmptyCategories(sql);
            expect(deleted).toBeGreaterThanOrEqual(1);
            const ids = (
                await sql<{ id: string }[]>`
                    SELECT id::text FROM livetv_categories
                    WHERE id IN (${used.id}::uuid, ${stale.id}::uuid, ${fresh.id}::uuid)
                `
            ).map((r) => r.id);
            expect(ids.sort()).toEqual([used.id, fresh.id].sort());
        });
    });

    // ========================================================================
    // batchUpdateChannelSortOrder — sort + optional cross-category move
    // ========================================================================

    describe('batchUpdateChannelSortOrder', () => {
        async function seedChannel(
            sourceId: string,
            opts: { name: string; categoryId?: string; sortOrder?: number },
        ): Promise<string> {
            const id = crypto.randomUUID();
            await createChannelWithMediaItem(sql, {
                id,
                name: opts.name,
                streamUrl: `http://${opts.name}`,
                sourceId,
                categoryId: opts.categoryId,
                sortOrder: opts.sortOrder ?? 0,
            });
            return id;
        }

        async function readChannel(
            id: string,
        ): Promise<{ sort_order: number; category_id: string | null }> {
            const [row] = await sql<{ sort_order: number; category_id: string | null }[]>`
                SELECT sort_order, category_id FROM livetv_channels WHERE id = ${id}::uuid
            `;
            return row;
        }

        it('returns 0 for empty updates', async () => {
            expect(await batchUpdateChannelSortOrder(sql, [])).toBe(0);
        });

        it('updates sort_order and leaves category unchanged when categoryId is omitted', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const cat = await createCategory(sql, 'Sports');
            const ch = await seedChannel(sourceId, { name: 'A', categoryId: cat.id, sortOrder: 0 });

            const count = await batchUpdateChannelSortOrder(sql, [{ id: ch, sortOrder: 7 }]);
            expect(count).toBe(1);

            const row = await readChannel(ch);
            expect(row.sort_order).toBe(7);
            expect(row.category_id).toBe(cat.id); // unchanged
        });

        it('moves a channel between two real categories', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const sports = await createCategory(sql, 'Sports');
            const news = await createCategory(sql, 'News');
            const ch = await seedChannel(sourceId, {
                name: 'A',
                categoryId: sports.id,
                sortOrder: 3,
            });

            await batchUpdateChannelSortOrder(sql, [{ id: ch, sortOrder: 0, categoryId: news.id }]);

            const row = await readChannel(ch);
            expect(row.category_id).toBe(news.id);
            expect(row.sort_order).toBe(0);
        });

        it('moves a channel INTO uncategorized (categoryId null → category_id NULL)', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const sports = await createCategory(sql, 'Sports');
            const ch = await seedChannel(sourceId, {
                name: 'A',
                categoryId: sports.id,
                sortOrder: 0,
            });

            await batchUpdateChannelSortOrder(sql, [{ id: ch, sortOrder: 1, categoryId: null }]);

            const row = await readChannel(ch);
            expect(row.category_id).toBeNull();
            expect(row.sort_order).toBe(1);
        });

        it('moves a channel OUT OF uncategorized into a category', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const sports = await createCategory(sql, 'Sports');
            const ch = await seedChannel(sourceId, { name: 'A', sortOrder: 0 }); // no category → NULL

            expect((await readChannel(ch)).category_id).toBeNull();

            await batchUpdateChannelSortOrder(sql, [
                { id: ch, sortOrder: 2, categoryId: sports.id },
            ]);

            const row = await readChannel(ch);
            expect(row.category_id).toBe(sports.id);
            expect(row.sort_order).toBe(2);
        });

        it('handles a mixed batch: a move-to-NULL alongside an unchanged-category update', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const sports = await createCategory(sql, 'Sports');
            const news = await createCategory(sql, 'News');
            const moving = await seedChannel(sourceId, { name: 'M', categoryId: sports.id });
            const staying = await seedChannel(sourceId, { name: 'S', categoryId: news.id });

            await batchUpdateChannelSortOrder(sql, [
                { id: moving, sortOrder: 0, categoryId: null }, // → uncategorized
                { id: staying, sortOrder: 1 }, // category omitted → unchanged
            ]);

            expect((await readChannel(moving)).category_id).toBeNull();
            const stayRow = await readChannel(staying);
            expect(stayRow.category_id).toBe(news.id);
            expect(stayRow.sort_order).toBe(1);
        });

        it('moves a group of channels into one category in a single batch (survives reload)', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const sports = await createCategory(sql, 'Sports');
            const news = await createCategory(sql, 'News');
            const a = await seedChannel(sourceId, {
                name: 'A',
                categoryId: sports.id,
                sortOrder: 0,
            });
            const b = await seedChannel(sourceId, { name: 'B', sortOrder: 1 }); // uncategorized
            const c = await seedChannel(sourceId, { name: 'C', categoryId: news.id, sortOrder: 0 });

            const count = await batchUpdateChannelSortOrder(sql, [
                { id: a, sortOrder: 0, categoryId: news.id },
                { id: b, sortOrder: 1, categoryId: news.id },
                { id: c, sortOrder: 2, categoryId: news.id },
            ]);
            expect(count).toBe(3);

            for (const [id, order] of [
                [a, 0],
                [b, 1],
                [c, 2],
            ] as const) {
                const row = await readChannel(id);
                expect(row.category_id).toBe(news.id);
                expect(row.sort_order).toBe(order);
            }
        });
    });

    // ========================================================================
    // channel favorites
    // ========================================================================

    describe('channel favorites', () => {
        async function insertUser(): Promise<UserId> {
            const [row] = await sql<{ id: string }[]>`
                INSERT INTO users (username) VALUES (${`fav-user-${crypto.randomUUID()}`})
                RETURNING id
            `;
            return toUserId(row.id);
        }

        async function insertChannel(sourceId: string): Promise<string> {
            const id = crypto.randomUUID();
            await createChannelWithMediaItem(sql, {
                id,
                name: `Fav Channel ${id.slice(0, 8)}`,
                streamUrl: 'http://stream.test/live.m3u8',
                sourceId,
            });
            return id;
        }

        it('adds (appending), lists, and removes favorites idempotently', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const userId = await insertUser();
            const first = await insertChannel(sourceId);
            const second = await insertChannel(sourceId);

            await setChannelFavorite(sql, userId, first, true);
            await setChannelFavorite(sql, userId, second, true);
            // Re-adding must not duplicate or reorder
            await setChannelFavorite(sql, userId, first, true);

            expect(await getFavoriteChannelIds(sql, userId)).toEqual([first, second]);

            await setChannelFavorite(sql, userId, first, false);
            // Removing an already-removed favorite is a no-op
            await setChannelFavorite(sql, userId, first, false);

            expect(await getFavoriteChannelIds(sql, userId)).toEqual([second]);
        });

        it('scopes favorites per user', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const userA = await insertUser();
            const userB = await insertUser();
            const channel = await insertChannel(sourceId);

            await setChannelFavorite(sql, userA, channel, true);

            expect(await getFavoriteChannelIds(sql, userA)).toEqual([channel]);
            expect(await getFavoriteChannelIds(sql, userB)).toEqual([]);
        });

        it('throws FK violation (23503) for an unknown channel', async () => {
            const userId = await insertUser();
            await expect(
                setChannelFavorite(sql, userId, crypto.randomUUID(), true),
            ).rejects.toMatchObject({ code: '23503' });
        });

        it('cascades away when the channel is deleted', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const userId = await insertUser();
            const channel = await insertChannel(sourceId);

            await setChannelFavorite(sql, userId, channel, true);
            // media_items delete cascades to livetv_channels → favorites
            await sql`DELETE FROM media_items WHERE id = ${channel}::uuid`;

            expect(await getFavoriteChannelIds(sql, userId)).toEqual([]);
        });

        it('appends new favorites when existing rows have NULL sort_order (all-NULL)', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const userId = await insertUser();
            const a = await insertChannel(sourceId);
            const b = await insertChannel(sourceId);
            const c = await insertChannel(sourceId);

            // Simulate two rows written by the PREVIOUS release (no sort_order).
            await sql`
                INSERT INTO livetv_channel_favorites (user_id, channel_id, created_at, sort_order)
                VALUES (${userId}, ${a}::uuid, now() - interval '2 min', NULL),
                       (${userId}, ${b}::uuid, now() - interval '1 min', NULL)
            `;

            await healNullFavoriteOrder(sql, userId);
            await setChannelFavorite(sql, userId, c, true);

            // The new favorite must land LAST, not first.
            expect(await getFavoriteChannelIds(sql, userId)).toEqual([a, b, c]);

            const [{ nulls }] = await sql<{ nulls: string }[]>`
                SELECT count(*) AS nulls FROM livetv_channel_favorites
                WHERE user_id = ${userId} AND sort_order IS NULL
            `;
            expect(Number(nulls)).toBe(0);
        });

        it('appends new favorites when existing rows have NULL sort_order (mixed)', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const userId = await insertUser();
            const a = await insertChannel(sourceId);
            const b = await insertChannel(sourceId);
            const c = await insertChannel(sourceId);

            await sql`
                INSERT INTO livetv_channel_favorites (user_id, channel_id, created_at, sort_order)
                VALUES (${userId}, ${a}::uuid, now() - interval '2 min', 0),
                       (${userId}, ${b}::uuid, now() - interval '1 min', NULL)
            `;

            await healNullFavoriteOrder(sql, userId);
            await setChannelFavorite(sql, userId, c, true);

            expect(await getFavoriteChannelIds(sql, userId)).toEqual([a, b, c]);
        });

        it('locks and returns favorites for update in channel_id order', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const userId = await insertUser();
            const first = await insertChannel(sourceId);
            const second = await insertChannel(sourceId);

            await setChannelFavorite(sql, userId, first, true);
            await setChannelFavorite(sql, userId, second, true);

            const rows = await sql.begin(async (tx) => {
                return getFavoritesForUpdate(tx as unknown as typeof sql, userId);
            });

            expect(rows.map((r) => r.channel_id)).toEqual([first, second].sort());
            expect(rows.every((r) => typeof r.sort_order === 'number')).toBe(true);
            expect(rows.every((r) => r.created_at instanceof Date)).toBe(true);
        });

        it('rewrites ranks to the given order and heals NULLs', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const userId = await insertUser();
            const a = await insertChannel(sourceId);
            const b = await insertChannel(sourceId);
            const c = await insertChannel(sourceId);

            await setChannelFavorite(sql, userId, a, true);
            await setChannelFavorite(sql, userId, b, true);
            await sql`
                INSERT INTO livetv_channel_favorites (user_id, channel_id, sort_order)
                VALUES (${userId}, ${c}::uuid, NULL)
            `;

            await batchUpdateFavoriteSortOrder(sql, userId, [c, b, a]);

            expect(await getFavoriteChannelIds(sql, userId)).toEqual([c, b, a]);
        });

        it('scopes rank rewrites to the target user', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const userA = await insertUser();
            const userB = await insertUser();
            const first = await insertChannel(sourceId);
            const second = await insertChannel(sourceId);

            await setChannelFavorite(sql, userA, first, true);
            await setChannelFavorite(sql, userA, second, true);
            await setChannelFavorite(sql, userB, first, true);
            await setChannelFavorite(sql, userB, second, true);

            await batchUpdateFavoriteSortOrder(sql, userA, [second, first]);

            expect(await getFavoriteChannelIds(sql, userA)).toEqual([second, first]);
            expect(await getFavoriteChannelIds(sql, userB)).toEqual([first, second]);
        });
    });

    // ========================================================================
    // favorites reorder — the ordering rules applied against a real database
    // ========================================================================

    describe('favorites reorder', () => {
        async function insertUser(): Promise<UserId> {
            const [row] = await sql<{ id: string }[]>`
                INSERT INTO users (username) VALUES (${`reorder-user-${crypto.randomUUID()}`})
                RETURNING id
            `;
            return toUserId(row.id);
        }

        async function insertChannel(sourceId: string): Promise<string> {
            const id = crypto.randomUUID();
            await createChannelWithMediaItem(sql, {
                id,
                name: `Reorder Channel ${id.slice(0, 8)}`,
                streamUrl: 'http://stream.test/live.m3u8',
                sourceId,
            });
            return id;
        }

        /** Mirrors the def handler: lock, compute, rewrite, re-read. */
        async function reorder(userId: UserId, requestedIds: string[]): Promise<string[]> {
            return sql.begin(async (txRaw) => {
                const tx = txRaw as unknown as typeof sql;
                const locked = await getFavoritesForUpdate(tx, userId);
                await batchUpdateFavoriteSortOrder(
                    tx,
                    userId,
                    computeFavoriteOrder(locked, requestedIds),
                );
                return getFavoriteChannelIds(tx, userId);
            });
        }

        async function seedFavorites(count: number): Promise<{ userId: UserId; ids: string[] }> {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const userId = await insertUser();
            const ids: string[] = [];
            for (let i = 0; i < count; i++) {
                const id = await insertChannel(sourceId);
                await setChannelFavorite(sql, userId, id, true);
                ids.push(id);
            }
            return { userId, ids };
        }

        it('permutes to the requested order', async () => {
            const { userId, ids } = await seedFavorites(5);
            const [a, b, c, d, e] = ids;

            expect(await reorder(userId, [c, a, e, b, d])).toEqual([c, a, e, b, d]);
        });

        it('appends favorites the payload did not mention, in existing order', async () => {
            // Four unmentioned favorites: with two this passes ~50% by chance.
            const { userId, ids } = await seedFavorites(5);
            const [a, b, c, d, e] = ids;

            expect(await reorder(userId, [e])).toEqual([e, a, b, c, d]);
        });

        it('ignores ids that are not current favorites and never deletes', async () => {
            const { userId, ids } = await seedFavorites(3);
            const [a, b, c] = ids;
            const stranger = crypto.randomUUID();

            expect(await reorder(userId, [stranger, c, stranger, a])).toEqual([c, a, b]);
        });

        it('rewrites all ranks for an empty payload, healing NULLs', async () => {
            const { userId, ids } = await seedFavorites(3);
            await sql`
                UPDATE livetv_channel_favorites SET sort_order = NULL WHERE user_id = ${userId}
            `;

            expect(await reorder(userId, [])).toEqual(ids);

            const [{ nulls }] = await sql<{ nulls: string }[]>`
                SELECT count(*) AS nulls FROM livetv_channel_favorites
                WHERE user_id = ${userId} AND sort_order IS NULL
            `;
            expect(Number(nulls)).toBe(0);
        });

        it('leaves other users untouched', async () => {
            const { userId: userA, ids: aIds } = await seedFavorites(3);
            const { userId: userB, ids: bIds } = await seedFavorites(3);

            await reorder(userA, [aIds[2], aIds[0], aIds[1]]);

            expect(await getFavoriteChannelIds(sql, userB)).toEqual(bIds);
        });

        it('comparator agrees with the SQL sort key on mixed NULL and duplicate ranks', async () => {
            const { userId, ids } = await seedFavorites(4);
            // Force an adversarial mix: a NULL, a duplicate rank, and a gap.
            await sql`UPDATE livetv_channel_favorites SET sort_order = NULL
                       WHERE user_id = ${userId} AND channel_id = ${ids[1]}::uuid`;
            await sql`UPDATE livetv_channel_favorites SET sort_order = 7
                       WHERE user_id = ${userId} AND channel_id IN (${ids[2]}::uuid, ${ids[3]}::uuid)`;

            const fromSql = await getFavoriteChannelIds(sql, userId);
            const rows = await getFavoritesForUpdate(sql, userId);
            const fromComparator = computeFavoriteOrder(rows, []);

            expect(fromComparator).toEqual(fromSql);
        });
    });
});
