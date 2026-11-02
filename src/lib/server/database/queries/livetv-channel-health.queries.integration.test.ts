// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real-Postgres cover for per-feed Live TV health: the upsert counting, the reset, the FK to
 * livetv_channels and the "every feed of the station is failing" query behind
 * LIVETV_HIDE_OFFLINE_AFTER_FAILURES.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { closeTestDb, getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { bulkCreateChannels } from './livetv-channels.queries.js';
import {
    listForChannels,
    listOfflineStationIds,
    recordFailure,
    recordSuccess,
    reset,
} from './livetv-channel-health.queries.js';

describe('livetv-channel-health queries', () => {
    let sql: postgres.Sql;
    let sourceId: string;
    const solo = crypto.randomUUID();
    const groupId = crypto.randomUUID();
    const groupA = crypto.randomUUID();
    const groupB = crypto.randomUUID();

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql.unsafe(
            'TRUNCATE TABLE livetv_channel_health, livetv_channels, livetv_backup_groups, livetv_sources, media_items RESTART IDENTITY CASCADE',
        );
        sourceId = crypto.randomUUID();
        await sql`
            INSERT INTO livetv_sources (id, name, source_type, max_streams)
            VALUES (${sourceId}::uuid, 'Health source', 'm3u', 2)
        `;
        await bulkCreateChannels(sql, {
            channels: [
                { id: solo, name: 'Solo', sortOrder: 0, streamUrl: 'http://s.test/solo', sourceId },
                {
                    id: groupA,
                    name: 'Group A',
                    sortOrder: 1,
                    streamUrl: 'http://s.test/a',
                    sourceId,
                    backupGroupId: groupId,
                },
                {
                    id: groupB,
                    name: 'Group B',
                    sortOrder: 2,
                    streamUrl: 'http://s.test/b',
                    sourceId,
                    backupGroupId: groupId,
                },
            ],
            categories: [],
            backupGroups: [{ id: groupId, name: 'Group', sourceId, primaryChannelId: groupA }],
        });
    });

    it('counts consecutive failures per feed and remembers the last reason', async () => {
        await recordFailure(sql, solo, 'channel_offline', new Date('2026-10-20T10:00:00Z'));
        await recordFailure(sql, solo, 'provider_auth_failed', new Date('2026-10-20T10:05:00Z'));
        const [row] = await listForChannels(sql, [solo, groupA]);
        expect(row).toMatchObject({
            channel_id: solo,
            consecutive_failures: 2,
            last_reason: 'provider_auth_failed',
        });
        expect(row.last_failure_at?.toISOString()).toBe('2026-10-20T10:05:00.000Z');
        expect(await listForChannels(sql, [groupA])).toEqual([]);
    });

    it('never moves last_failure_at backwards for a late event', async () => {
        await recordFailure(sql, solo, 'channel_offline', new Date('2026-10-20T10:05:00Z'));
        await recordFailure(sql, solo, 'channel_offline', new Date('2026-10-20T10:00:00Z'));
        const [row] = await listForChannels(sql, [solo]);
        expect(row.last_failure_at?.toISOString()).toBe('2026-10-20T10:05:00.000Z');
    });

    it('a success ends the streak and stamps last_success_at; a first success makes a row', async () => {
        await recordFailure(sql, solo, 'channel_offline');
        await recordFailure(sql, solo, 'channel_offline');
        await recordSuccess(sql, solo);
        await recordSuccess(sql, groupA);
        const rows = await listForChannels(sql, [solo, groupA]);
        const byId = new Map(rows.map((r) => [r.channel_id, r]));
        expect(byId.get(solo)).toMatchObject({
            consecutive_failures: 0,
            last_reason: 'channel_offline',
        });
        expect(byId.get(solo)?.last_success_at).toBeInstanceOf(Date);
        expect(byId.get(groupA)?.consecutive_failures).toBe(0);
    });

    it('reset deletes the row and reports an unknown channel', async () => {
        await recordFailure(sql, solo, 'channel_offline');
        expect(await reset(sql, solo)).toBe(true);
        expect(await listForChannels(sql, [solo])).toEqual([]);
        expect(await reset(sql, crypto.randomUUID())).toBe(false);
        expect(await reset(sql, 'not-a-uuid')).toBe(false);
    });

    it('ignores a feed that does not exist instead of failing on the foreign key', async () => {
        await expect(
            recordFailure(sql, crypto.randomUUID(), 'channel_offline'),
        ).resolves.toBeUndefined();
        await expect(recordSuccess(sql, crypto.randomUUID())).resolves.toBeUndefined();
        await expect(recordFailure(sql, 'not-a-uuid', 'channel_offline')).resolves.toBeUndefined();
        expect(await sql`SELECT 1 FROM livetv_channel_health`).toHaveLength(0);
    });

    it('is deleted with its channel', async () => {
        await recordFailure(sql, solo, 'channel_offline');
        await sql`DELETE FROM livetv_channels WHERE id = ${solo}`;
        expect(await sql`SELECT 1 FROM livetv_channel_health`).toHaveLength(0);
    });

    describe('listOfflineStationIds', () => {
        const fail = async (id: string, times: number, at = new Date()): Promise<void> => {
            for (let i = 0; i < times; i++) await recordFailure(sql, id, 'channel_offline', at);
        };

        it('hides a single-feed station at the threshold, not below', async () => {
            await fail(solo, 2);
            expect(await listOfflineStationIds(sql, 3, 6)).toEqual([]);
            await fail(solo, 1);
            expect(await listOfflineStationIds(sql, 3, 6)).toEqual([solo]);
        });

        it('keeps a group visible while one of its feeds is healthy or untested', async () => {
            await fail(groupA, 5);
            expect(await listOfflineStationIds(sql, 3, 6)).toEqual([]);
            await fail(groupB, 3);
            expect(await listOfflineStationIds(sql, 3, 6)).toEqual([groupId]);
            await recordSuccess(sql, groupB);
            expect(await listOfflineStationIds(sql, 3, 6)).toEqual([]);
        });

        it('lets a station reappear once its last failure is older than the window', async () => {
            await fail(solo, 4, new Date(Date.now() - 7 * 60 * 60_000));
            expect(await listOfflineStationIds(sql, 3, 6)).toEqual([]);
            await fail(solo, 1, new Date(Date.now() - 5 * 60 * 60_000));
            expect(await listOfflineStationIds(sql, 3, 6)).toEqual([solo]);
        });

        it('only considers the feeds that are usable members of the station', async () => {
            await fail(groupA, 3);
            // groupB is healthy but absent from the last three imports: not a usable feed.
            await sql`UPDATE livetv_channels SET consecutive_absences = 3 WHERE id = ${groupB}`;
            expect(await listOfflineStationIds(sql, 3, 6)).toEqual([groupId]);
            // Back in the import: its health (none) counts again and keeps the station visible.
            await sql`UPDATE livetv_channels SET consecutive_absences = 0 WHERE id = ${groupB}`;
            expect(await listOfflineStationIds(sql, 3, 6)).toEqual([]);
        });

        it('ignores a failing feed in a hidden category', async () => {
            const categoryId = crypto.randomUUID();
            await sql`INSERT INTO livetv_categories (id, name, is_visible) VALUES (${categoryId}::uuid, ${'Hidden ' + categoryId}, false)`;
            await sql`UPDATE livetv_channels SET category_id = ${categoryId}::uuid WHERE id = ${groupB}`;
            await fail(groupA, 3);
            // groupB (healthy) sits in a hidden category: only groupA counts.
            try {
                expect(await listOfflineStationIds(sql, 3, 6)).toEqual([groupId]);
            } finally {
                await sql`UPDATE livetv_channels SET category_id = NULL WHERE id = ${groupB}`;
                await sql`DELETE FROM livetv_categories WHERE id = ${categoryId}::uuid`;
            }
        });

        it('returns every offline station without being handed a list of ids', async () => {
            await fail(solo, 3);
            await fail(groupA, 3);
            await fail(groupB, 3);
            expect((await listOfflineStationIds(sql, 3, 6)).sort()).toEqual([solo, groupId].sort());
        });

        it('is off at a threshold of 0', async () => {
            await fail(solo, 9);
            expect(await listOfflineStationIds(sql, 0, 6)).toEqual([]);
        });
    });
});
