// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { bulkCreateChannels } from './livetv-channels.queries.js';
import type { StationAiringRow } from './livetv-programs.queries.js';
import { getStationAirings } from './livetv-programs.queries.js';

const from = new Date('2026-10-17T10:00:00Z');
const to = new Date('2026-10-17T14:00:00Z');

describe('station airing ownership (PostgreSQL)', () => {
    let sql: postgres.Sql;
    let sourceId: string;
    let groupId: string;
    let shown: string;
    let sibling: string;
    beforeAll(() => { sql = getTestDb(); });
    afterAll(async () => { await closeTestDb(); });
    beforeEach(async () => {
        await sql`TRUNCATE TABLE livetv_programs, livetv_channels, livetv_backup_groups,
            livetv_categories, livetv_sources RESTART IDENTITY CASCADE`;
        sourceId = crypto.randomUUID();
        groupId = crypto.randomUUID();
        shown = crypto.randomUUID();
        sibling = crypto.randomUUID();
        await sql`INSERT INTO livetv_sources (id, name, source_type)
            VALUES (${sourceId}, 'Station airings test', 'm3u')`;
        await bulkCreateChannels(sql, {
            channels: [shown, sibling].map((id, index) => ({
                id, name: index === 0 ? 'News FHD' : 'News HD', sourceId,
                backupGroupId: groupId, sortOrder: index,
                streamUrl: 'http://stream.test/channel', qualityTier: index === 0 ? 'fhd' as const : 'hd' as const,
            })),
            categories: [],
            backupGroups: [{ id: groupId, name: 'News', sourceId, primaryChannelId: shown }],
        });
        await sql`UPDATE livetv_backup_groups SET primary_channel_id = ${shown} WHERE id = ${groupId}`;
    });

    async function program(channel: string, title: string, start = from, end = to): Promise<string> {
        const id = crypto.randomUUID();
        await sql`INSERT INTO livetv_programs (id, channel_id, title, start_time, end_time)
            VALUES (${id}, ${channel}, ${title}, ${start}, ${end})`;
        return id;
    }
    async function airings(): Promise<StationAiringRow[]> {
        return getStationAirings(sql, [groupId], from, to);
    }

    it('falls back to a visible sibling when the shown feed has no overlapping airings', async () => {
        await program(shown, 'Outside', new Date('2026-10-17T08:00:00Z'), from);
        const id = await program(sibling, 'Fallback');
        expect(await airings()).toMatchObject([{ id, station_id: groupId, channel_id: sibling }]);
    });
    it('prefers the shown feed and never fills its gaps with sibling airings', async () => {
        const id = await program(shown, 'Shown', from, new Date('2026-10-17T11:00:00Z'));
        await program(sibling, 'Sibling all day');
        expect((await airings()).map((row) => row.id)).toEqual([id]);
    });
    it('does not leak a hidden sibling', async () => {
        await program(sibling, 'Hidden');
        await sql`UPDATE livetv_channels SET is_visible = false WHERE id = ${sibling}`;
        expect(await airings()).toEqual([]);
    });
    it('does not leak a sibling in a hidden category', async () => {
        const category = crypto.randomUUID();
        await sql`INSERT INTO livetv_categories (id, name, is_visible) VALUES (${category}, 'Hidden', false)`;
        await sql`UPDATE livetv_channels SET category_id = ${category} WHERE id = ${sibling}`;
        await program(sibling, 'Hidden category');
        expect(await airings()).toEqual([]);
    });
    it('does not use an absent feed, including an absent primary', async () => {
        await program(shown, 'Gone primary');
        const id = await program(sibling, 'Present sibling');
        await sql`UPDATE livetv_channels SET consecutive_absences = 3 WHERE id = ${shown}`;
        expect((await airings()).map((row) => row.id)).toEqual([id]);
        await sql`UPDATE livetv_channels SET consecutive_absences = 3 WHERE id = ${sibling}`;
        expect(await airings()).toEqual([]);
    });
    it('collapses duplicate and overlapping rows within the owner feed', async () => {
        const middle = new Date('2026-10-17T12:00:00Z');
        await program(shown, 'First', from, middle);
        await program(shown, 'Duplicate', from, middle);
        await program(shown, 'Second', middle, to);
        await program(shown, 'Coarse overlap');
        await program(sibling, 'Other schedule');
        const rows = await airings();
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.channel_id === shown && row.station_id === groupId)).toBe(true);
        expect(rows[0].end_time).toEqual(rows[1].start_time);
    });
    it('includes whole boundary airings, excludes nonoverlaps and handles empty scopes', async () => {
        const early = new Date('2026-10-17T09:00:00Z');
        const late = new Date('2026-10-17T15:00:00Z');
        await program(shown, 'Before', new Date('2026-10-17T08:00:00Z'), early);
        const id = await program(shown, 'Boundary', early, late);
        await program(shown, 'After', late, new Date('2026-10-17T16:00:00Z'));
        expect(await airings()).toMatchObject([{ id, start_time: early, end_time: late }]);
        expect(await getStationAirings(sql, [], from, to)).toEqual([]);
        expect(await getStationAirings(sql, [crypto.randomUUID()], from, to)).toEqual([]);
    });
    it('handles ungrouped stations independently', async () => {
        await sql`UPDATE livetv_channels SET backup_group_id = NULL WHERE id = ${sibling}`;
        const id = await program(sibling, 'Ungrouped');
        expect(await getStationAirings(sql, [groupId, sibling], from, to)).toMatchObject([
            { id, station_id: sibling, channel_id: sibling },
        ]);
    });
});
