// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * "Listed for a viewer" means the same thing everywhere: the stream gate, the
 * lineup (shownGroupMember), simple mode, failover, on-air and the guide.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import {
    bulkCreateChannels,
    resolveStation,
    stationIdsOfFeeds,
    getAllVisibleChannels,
    getBackupGroupUrls,
    getStationFeeds,
    isChannelStreamableByViewer,
    searchChannels,
    setBackupGroupsOnAir,
} from './livetv-channels.queries.js';
import {
    countLineupChannels,
    resolveLineupChannelIds,
    simpleModeAutostarts,
} from './livetv-simple-mode.queries.js';
import {
    getGuideEndDate,
    getGuidePrograms,
    searchProgramAirings,
    searchProgramsByTextGrouped,
} from './livetv-programs.queries.js';
import { getSimpleMode } from '$lib/server/services/livetv/simple-mode.service.js';

describe('Live TV lineup consistency', () => {
    let sql: postgres.Sql;
    let sourceId: string;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql.unsafe(
            'TRUNCATE TABLE livetv_simple_mode, livetv_channel_favorites, livetv_programs, livetv_channels, livetv_categories, livetv_backup_groups, livetv_sources, media_items RESTART IDENTITY CASCADE',
        );
        sourceId = crypto.randomUUID();
        await sql`
            INSERT INTO livetv_sources (id, name, source_type, max_streams)
            VALUES (${sourceId}::uuid, 'Test Source', 'm3u', 2)
        `;
    });

    async function category(name: string, isVisible: boolean): Promise<string> {
        const id = crypto.randomUUID();
        await sql`
            INSERT INTO livetv_categories (id, name, sort_order, is_visible)
            VALUES (${id}::uuid, ${name}, 0, ${isVisible})
        `;
        return id;
    }

    interface Feed {
        name: string;
        tier?: 'uhd' | 'fhd' | 'hd' | 'sd';
        sort?: number;
        categoryId?: string;
        visible?: boolean;
        absences?: number;
    }

    /** One backup group; the first feed is the primary. Returns the feed ids in order. */
    async function group(feeds: Feed[], primaryIndex = 0): Promise<{ bg: string; ids: string[] }> {
        const bg = crypto.randomUUID();
        const ids = feeds.map(() => crypto.randomUUID());
        await bulkCreateChannels(sql, {
            channels: feeds.map((f, i) => ({
                id: ids[i],
                name: f.name,
                qualityTier: f.tier ?? 'fhd',
                streamUrl: `http://${f.name.replace(/\W/g, '')}.test/live`,
                sourceId,
                backupGroupId: bg,
                categoryId: f.categoryId,
                sortOrder: f.sort ?? i,
            })),
            categories: [],
            backupGroups: [
                { id: bg, name: 'Station', sourceId, primaryChannelId: ids[primaryIndex] },
            ],
        });
        await sql`UPDATE livetv_backup_groups SET primary_channel_id = ${ids[primaryIndex]} WHERE id = ${bg}`;
        for (let i = 0; i < feeds.length; i++) {
            await sql`
                UPDATE livetv_channels
                   SET is_visible = ${feeds[i].visible ?? true},
                       consecutive_absences = ${feeds[i].absences ?? 0}
                 WHERE id = ${ids[i]}
            `;
        }
        return { bg, ids };
    }

    async function single(name: string, categoryId?: string): Promise<string> {
        const id = crypto.randomUUID();
        await bulkCreateChannels(sql, {
            channels: [{ id, name, streamUrl: `http://${name}.test/live`, sourceId, categoryId }],
            categories: [],
            backupGroups: [],
        });
        return id;
    }

    describe('failover (getBackupGroupUrls)', () => {
        it('leaves out feeds in a hidden category and feeds gone from the playlist', async () => {
            const hidden = await category('Hidden', false);
            const shown = await category('Shown', true);
            const { bg, ids } = await group([
                { name: 'Alpha A' },
                { name: 'Alpha B', categoryId: hidden },
                { name: 'Alpha C', absences: 3 },
                { name: 'Alpha D', visible: false },
                { name: 'Alpha E', categoryId: shown },
            ]);
            const urls = await getBackupGroupUrls(sql, bg, ids[0]);
            // D is hidden on its own (a backup by design), E sits in a visible category.
            expect(urls).toEqual(['http://AlphaD.test/live', 'http://AlphaE.test/live']);
        });
    });

    it('resolves stable station identity through shown-feed changes and maps stored feeds in order', async () => {
        const { bg, ids } = await group([
            { name: 'Resolver FHD' },
            { name: 'Resolver HD', tier: 'hd' },
        ]);
        const lone = await single('Resolver lone');
        expect(await resolveStation(sql, bg)).toEqual({
            stationId: bg,
            shownFeedId: ids[0],
            groupId: bg,
        });
        expect(await resolveStation(sql, ids[0])).toBeNull();
        expect(await resolveStation(sql, lone)).toEqual({
            stationId: lone,
            shownFeedId: lone,
            groupId: null,
        });
        await sql`UPDATE livetv_channels SET is_visible = false WHERE id = ${ids[0]}`;
        expect((await resolveStation(sql, bg))?.shownFeedId).toBe(ids[1]);
        expect(
            await stationIdsOfFeeds(sql, [lone, ids[0], ids[1], lone, crypto.randomUUID()]),
        ).toEqual([lone, bg]);
        await sql`UPDATE livetv_channels SET is_visible = false WHERE backup_group_id = ${bg}`;
        expect(await resolveStation(sql, bg)).toBeNull();
    });

    describe('simple mode lineup', () => {
        it('counts only the shown member of a backup group', async () => {
            const { ids } = await group([{ name: 'Beta FHD' }, { name: 'Beta HD', tier: 'hd' }]);
            const lone = await single('Lonely');
            expect(await countLineupChannels(sql, [ids[0], ids[1], lone])).toBe(2);
            expect(await countLineupChannels(sql, [ids[1]])).toBe(0);
        });

        it('does not count a channel in a hidden category or a hidden channel', async () => {
            const hidden = await category('Hidden', false);
            const inHidden = await single('In hidden', hidden);
            const lone = await single('Lonely');
            await sql`UPDATE livetv_channels SET is_visible = false WHERE id = ${lone}`;
            expect(await countLineupChannels(sql, [inHidden, lone])).toBe(0);
        });

        it('resolves a saved feed to the shown feed of its station, in order, without repeats', async () => {
            const { ids } = await group([{ name: 'Beta FHD' }, { name: 'Beta HD', tier: 'hd' }]);
            const lone = await single('Lonely');
            expect(await resolveLineupChannelIds(sql, [lone, ids[1], ids[0]])).toEqual([
                lone,
                ids[0],
            ]);
        });

        it('drops saved channels the lineup has nothing for', async () => {
            const hidden = await category('Hidden', false);
            const inHidden = await single('In hidden', hidden);
            const { ids } = await group([
                { name: 'Gamma', categoryId: hidden },
                { name: 'Gamma HD', categoryId: hidden },
            ]);
            expect(await resolveLineupChannelIds(sql, [inHidden, ids[0]])).toEqual([]);
        });

        async function userWithMode(favorites: string[], startChannelId?: string): Promise<UserId> {
            const [row] = await sql<{ id: string }[]>`
                INSERT INTO users (username) VALUES (${`lineup-${crypto.randomUUID()}`}) RETURNING id
            `;
            const userId = toUserId(row.id);
            for (const [i, id] of favorites.entries()) {
                await sql`
                    INSERT INTO livetv_channel_favorites (user_id, channel_id, sort_order)
                    VALUES (${userId}, ${id}::uuid, ${i})
                `;
            }
            await sql`
                INSERT INTO livetv_simple_mode (user_id, enabled, autostart, start_channel_id)
                VALUES (${userId}, true, true, ${startChannelId ?? null})
            `;
            return userId;
        }

        it('getSimpleMode follows a saved feed to the shown one, start channel included', async () => {
            const { ids, bg } = await group([
                { name: 'Beta FHD' },
                { name: 'Beta HD', tier: 'hd' },
            ]);
            // The user saved the HD feed; the lineup shows the FHD primary.
            const userId = await userWithMode([ids[1]], ids[1]);
            const mode = await getSimpleMode(sql, userId);
            expect(mode.stationIds).toEqual([bg]);
            expect(mode.startStationId).toBe(bg);
        });

        it('autostart needs at least one channel the lineup lists', async () => {
            const hidden = await category('Hidden', false);
            const inHidden = await single('In hidden', hidden);
            const { ids } = await group([{ name: 'Beta FHD' }, { name: 'Beta HD', tier: 'hd' }]);

            const onlyHidden = await userWithMode([inHidden]);
            expect(await simpleModeAutostarts(sql, onlyHidden)).toBe(false);

            // A non-shown member still resolves to the station's shown feed.
            const viaStation = await userWithMode([ids[1]]);
            expect(await simpleModeAutostarts(sql, viaStation)).toBe(true);
        });
    });

    describe('shown member ordering', () => {
        it('puts a feed gone from the playlist behind a present one, even the primary', async () => {
            const { ids } = await group([
                { name: 'Delta FHD', absences: 3 },
                { name: 'Delta HD', tier: 'hd' },
            ]);
            expect((await getAllVisibleChannels(sql)).map((r) => r.id)).toEqual([ids[1]]);
            expect((await searchChannels(sql, 'Delta')).map((r) => r.id)).toEqual([ids[1]]);
            const feeds = await getStationFeeds(sql, ids[1]);
            expect(feeds.find((f) => f.is_shown)?.id).toBe(ids[1]);
        });

        it('still shows the gone feed when it is the only one', async () => {
            const { ids } = await group([
                { name: 'Delta FHD', absences: 3 },
                { name: 'Delta HD', tier: 'hd', visible: false },
            ]);
            expect((await getAllVisibleChannels(sql)).map((r) => r.id)).toEqual([ids[0]]);
        });
    });

    describe('setBackupGroupsOnAir', () => {
        it('never picks a feed in a hidden category or one gone from the playlist', async () => {
            const hidden = await category('Hidden', false);
            const { bg, ids } = await group([
                { name: 'Eps FHD', categoryId: hidden },
                { name: 'Eps UHD', tier: 'uhd', absences: 3 },
                { name: 'Eps HD', tier: 'hd' },
            ]);
            expect(await setBackupGroupsOnAir(sql, [bg], true)).toBe(1);
            const visible = await sql<{ id: string }[]>`
                SELECT id FROM livetv_channels WHERE is_visible
            `;
            expect(visible.map((r) => r.id)).toEqual([ids[2]]);
        });

        it('leaves a group with no eligible feed as it is and does not count it', async () => {
            const hidden = await category('Hidden', false);
            const ok = await group([{ name: 'Zeta A', visible: false }]);
            const none = await group([
                { name: 'Eta A', categoryId: hidden, visible: false },
                { name: 'Eta B', absences: 5, visible: false },
            ]);
            expect(await setBackupGroupsOnAir(sql, [ok.bg, none.bg], true)).toBe(1);
            const visible = await sql<{ id: string }[]>`
                SELECT id FROM livetv_channels WHERE is_visible
            `;
            expect(visible.map((r) => r.id)).toEqual([ok.ids[0]]);
        });
    });

    describe('one answer for the gate and the failover', () => {
        it('failover candidates are streamable by the gate', async () => {
            const hidden = await category('Hidden', false);
            const { bg, ids } = await group([
                { name: 'Theta A' },
                { name: 'Theta B', categoryId: hidden },
                { name: 'Theta C', visible: false },
            ]);
            const urls = await getBackupGroupUrls(sql, bg, ids[0]);
            expect(urls).toEqual(['http://ThetaC.test/live']);
            expect(await isChannelStreamableByViewer(sql, ids[1], true)).toBe(false);
            expect(await isChannelStreamableByViewer(sql, ids[2], true)).toBe(true);
        });
    });

    describe('guide', () => {
        async function program(channelId: string, title: string): Promise<void> {
            await sql`
                INSERT INTO livetv_programs (id, channel_id, title, start_time, end_time)
                VALUES (
                    ${crypto.randomUUID()}, ${channelId}::uuid, ${title},
                    NOW() - INTERVAL '10 minutes', NOW() + INTERVAL '50 minutes'
                )
            `;
        }

        it('leaves out programmes of channels in a hidden category', async () => {
            const hidden = await category('Hidden', false);
            const shown = await category('Shown', true);
            const a = await single('Open channel', shown);
            const b = await single('Closed channel', hidden);
            const c = await single('No category');
            await program(a, 'Quizshow open');
            await program(b, 'Quizshow closed');
            await program(c, 'Quizshow plain');

            const from = new Date(Date.now() - 3600_000);
            const to = new Date(Date.now() + 3600_000);
            const guide = await getGuidePrograms(sql, from, to);
            expect(guide.map((p) => p.channel_id).sort()).toEqual([a, c].sort());

            const found = await searchProgramsByTextGrouped(sql, 'Quizshow');
            const names = found.flatMap((g) => g.channels.map((ch) => ch.id));
            expect(names.sort()).toEqual([a, c].sort());
        });

        it('EPG search returns the owner feed airing once per station, keyed by station', async () => {
            const hidden = await category('Hidden', false);
            const { bg, ids } = await group([
                { name: 'Quiz primary' },
                { name: 'Quiz backup', tier: 'hd' },
                { name: 'Quiz hidden feed', categoryId: hidden },
            ]);
            const plain = await single('Quiz plain');
            const closed = await single('Quiz closed', hidden);
            for (const id of [...ids, plain, closed]) await program(id, 'Quizshow nightly');

            const found = await searchProgramAirings(sql, 'Quizshow', 20);
            expect(found.map((row) => row.station_id).sort()).toEqual([bg, plain].sort());
            expect(found.every((row) => row.temporal_status === 'live')).toBe(true);

            const paged = await searchProgramAirings(sql, 'Quizshow', 1, 1);
            expect(paged).toHaveLength(1);
            expect(paged[0].id).not.toBe((await searchProgramAirings(sql, 'Quizshow', 1, 0))[0].id);
        });

        it('does not replace a non-matching primary with a matching backup', async () => {
            const { ids } = await group([
                { name: 'Aurora primary' },
                { name: 'Aurora backup', tier: 'hd' },
            ]);
            await program(ids[0], 'Orchard journal');
            await program(ids[1], 'Nebula expedition');

            expect(await searchProgramAirings(sql, 'Nebula', 20)).toEqual([]);
            expect(await searchProgramAirings(sql, 'Orchard', 20)).toHaveLength(1);
        });

        it('keeps matching owner airings beyond the owner-selection horizon', async () => {
            const channel = await single('Aurora future');
            await program(channel, 'Orchard journal');
            await sql`
                INSERT INTO livetv_programs (id, channel_id, title, start_time, end_time)
                VALUES (
                    ${crypto.randomUUID()}, ${channel}::uuid, 'Nebula expedition',
                    NOW() + INTERVAL '40 days', NOW() + INTERVAL '40 days 1 hour'
                )
            `;
            const found = await searchProgramAirings(sql, 'Nebula', 20);
            expect(found).toHaveLength(1);
            expect(found[0].temporal_status).toBe('future');
        });

        it('the guide end date ignores channels in a hidden category', async () => {
            const hidden = await category('Hidden', false);
            const b = await single('Closed channel', hidden);
            await program(b, 'Late show');
            expect(await getGuideEndDate(sql)).toBeNull();
        });
    });
});
