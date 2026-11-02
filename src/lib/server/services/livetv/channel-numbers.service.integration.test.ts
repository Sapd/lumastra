// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stable channel numbers against a real PostgreSQL: assignment, uniqueness,
 * what a refresh / hide / reorder / delete does to them, admin pins and swaps,
 * renumbering, and a destructive re-import carrying numbers over to the new rows.
 *
 * Real: PostgreSQL, the M3U parser, the auto-processor, the import service.
 * Faked: the HTTP fetch and the Valkey source lock (as in the lineup test).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

vi.mock('$lib/server/cache/valkey.js', () => ({
    acquireLock: vi.fn().mockResolvedValue('lock-token'),
    releaseLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/server/cache', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/cache')>()),
    cacheInvalidation: { onContentAdded: vi.fn().mockResolvedValue(undefined) },
}));

const keepHidden = vi.hoisted(() => ({ value: false }));
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...real,
        config: new Proxy(real.config, {
            get: (target, prop, receiver) =>
                prop === 'LIVETV_KEEP_HIDDEN_CHANNEL_NUMBERS'
                    ? keepHidden.value
                    : Reflect.get(target, prop, receiver),
        }),
    };
});

const playlist = vi.hoisted(() => ({ text: '' }));
vi.mock('./fetch-source.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./fetch-source.js')>()),
    fetchSsrfValidatedText: vi.fn(async () => playlist.text),
}));

import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    ensureChannelNumbers,
    renumberChannels,
    setChannelNumber,
    unpinChannelNumber,
} from './channel-numbers.service.js';
import { importM3uSource } from './livetv-import.service.js';

describe('stable channel numbers', () => {
    let sql: postgres.Sql;
    let sourceId: string;
    let newsId: string;
    let sportId: string;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql.unsafe(
            'TRUNCATE TABLE livetv_channel_numbers, livetv_channel_watch_history, livetv_programs, livetv_epg_channels, livetv_channels, livetv_categories, livetv_backup_groups, livetv_sources, media_items RESTART IDENTITY CASCADE',
        );
        keepHidden.value = false;
        sourceId = crypto.randomUUID();
        await sql`
            INSERT INTO livetv_sources (id, name, source_type, m3u_url, max_streams)
            VALUES (${sourceId}::uuid, 'Numbers', 'm3u', 'http://203.0.113.250/list.m3u', 2)
        `;
        [{ id: newsId }] = await sql<{ id: string }[]>`
            INSERT INTO livetv_categories (name, sort_order) VALUES ('News', 0) RETURNING id
        `;
        [{ id: sportId }] = await sql<{ id: string }[]>`
            INSERT INTO livetv_categories (name, sort_order) VALUES ('Sport', 1) RETURNING id
        `;
    });

    async function channel(
        title: string,
        categoryId: string,
        sortOrder: number,
        opts: { groupId?: string; isVisible?: boolean } = {},
    ): Promise<string> {
        const id = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status)
            VALUES (${id}::uuid, ${title}, 'tvchannel', 'active')
        `;
        await sql`
            INSERT INTO livetv_channels (id, m3u_url, source_id, sort_order, is_visible, category_id, backup_group_id)
            VALUES (${id}::uuid, ${'http://203.0.113.9/' + id}, ${sourceId}::uuid, ${sortOrder},
                    ${opts.isVisible ?? true}, ${categoryId}::uuid, ${opts.groupId ?? null}::uuid)
        `;
        return id;
    }

    async function group(name: string): Promise<string> {
        const [{ id }] = await sql<{ id: string }[]>`
            INSERT INTO livetv_backup_groups (name, source_id) VALUES (${name}, ${sourceId}::uuid)
            RETURNING id
        `;
        return id;
    }

    async function numbersByTitle(): Promise<Record<string, number>> {
        const state = await ensureChannelNumbers(sql);
        const rows = await sql<{ id: string; title: string; backup_group_id: string | null }[]>`
            SELECT lc.id, mi.title, lc.backup_group_id
              FROM livetv_channels lc JOIN media_items mi ON mi.id = lc.id
        `;
        const out: Record<string, number> = {};
        for (const row of rows) {
            const n = state.numbers.get(row.backup_group_id ?? row.id);
            if (n !== undefined) out[row.title] = n;
        }
        return out;
    }

    it('numbers each station once (backup feeds share it) in display order, and is idempotent', async () => {
        const station = await group('Herald');
        await channel('Herald HD', newsId, 0, { groupId: station });
        await channel('Herald SD', newsId, 1, { groupId: station });
        await channel('Daily', newsId, 2);
        await channel('Arena', sportId, 0);

        const first = await ensureChannelNumbers(sql);
        expect([...first.numbers.values()].sort()).toEqual([1, 2, 3]);
        expect(first.numbers.get(station)).toBe(1);

        const [{ count }] = await sql<{ count: number }[]>`
            SELECT count(*)::int AS count FROM livetv_channel_numbers
        `;
        expect(count).toBe(3);
        const second = await ensureChannelNumbers(sql);
        expect(second.numbers).toEqual(first.numbers);
    });

    it('keeps numbers on reorder and numbers a refreshed-in channel after the highest', async () => {
        await channel('Herald', newsId, 0);
        await channel('Daily', newsId, 1);
        await channel('Arena', sportId, 0);
        expect(await numbersByTitle()).toEqual({ Herald: 1, Daily: 2, Arena: 3 });

        // Sport moves above News, Daily above Herald.
        await sql`UPDATE livetv_categories SET sort_order = -1 WHERE id = ${sportId}::uuid`;
        await sql`UPDATE livetv_channels SET sort_order = 5 WHERE sort_order = 0`;
        await channel('Courier', newsId, 3);
        expect(await numbersByTitle()).toEqual({ Herald: 1, Daily: 2, Arena: 3, Courier: 4 });
    });

    it('frees the number of a hidden or deleted channel; shown again it gets a new one', async () => {
        await channel('Herald', newsId, 0);
        const daily = await channel('Daily', newsId, 1);
        const arena = await channel('Arena', sportId, 0);
        await numbersByTitle();

        await sql`UPDATE livetv_channels SET is_visible = false WHERE id = ${daily}::uuid`;
        await sql`DELETE FROM media_items WHERE id = ${arena}::uuid`;
        expect(await numbersByTitle()).toEqual({ Herald: 1 });

        await sql`UPDATE livetv_channels SET is_visible = true WHERE id = ${daily}::uuid`;
        expect(await numbersByTitle()).toEqual({ Herald: 1, Daily: 2 });
    });

    it('with "Keep numbers of hidden channels" a hidden channel gets its own number back', async () => {
        keepHidden.value = true;
        await channel('Herald', newsId, 0);
        const daily = await channel('Daily', newsId, 1);
        await numbersByTitle();
        await sql`UPDATE livetv_channels SET is_visible = false WHERE id = ${daily}::uuid`;
        await channel('Courier', newsId, 2);
        expect(await numbersByTitle()).toEqual({ Herald: 1, Courier: 3 });
        await sql`UPDATE livetv_channels SET is_visible = true WHERE id = ${daily}::uuid`;
        expect(await numbersByTitle()).toEqual({ Herald: 1, Daily: 2, Courier: 3 });
    });

    it('pins an admin number, refuses a taken one, swaps on request and keeps pins on renumber', async () => {
        const herald = await channel('Herald', newsId, 0);
        const daily = await channel('Daily', newsId, 1);
        await channel('Arena', sportId, 0);
        await numbersByTitle();

        expect(await setChannelNumber(sql, herald, 50, { swap: false })).toEqual({
            status: 'ok',
            number: 50,
        });
        const conflict = await setChannelNumber(sql, daily, 50, { swap: false });
        expect(conflict).toEqual({ status: 'conflict', holderName: 'Herald' });

        expect(await setChannelNumber(sql, daily, 50, { swap: true })).toEqual({
            status: 'ok',
            number: 50,
        });
        expect(await numbersByTitle()).toEqual({ Daily: 50, Herald: 2, Arena: 3 });

        // A hidden channel keeps a pinned number even though hidden numbers are freed.
        await sql`UPDATE livetv_channels SET is_visible = false WHERE id = ${herald}::uuid`;
        await numbersByTitle();
        const [{ pinned }] = await sql<{ pinned: boolean }[]>`
            SELECT pinned FROM livetv_channel_numbers WHERE number = 2
        `;
        expect(pinned).toBe(true);
        await sql`UPDATE livetv_channels SET is_visible = true WHERE id = ${herald}::uuid`;

        // Renumber: Daily (50) and Herald (2) are pinned and stay; Arena moves to 1.
        await renumberChannels(sql);
        expect(await numbersByTitle()).toEqual({ Herald: 2, Daily: 50, Arena: 1 });

        await unpinChannelNumber(sql, daily);
        await renumberChannels(sql);
        expect(await numbersByTitle()).toEqual({ Herald: 2, Daily: 1, Arena: 3 });

        expect(await setChannelNumber(sql, daily, 10_000, { swap: false })).toEqual({
            status: 'invalid',
        });
    });

    it('starts a category at its "Numbers start at"', async () => {
        await sql`UPDATE livetv_categories SET number_start = 100 WHERE id = ${sportId}::uuid`;
        await channel('Herald', newsId, 0);
        await channel('Arena', sportId, 0);
        await channel('Court', sportId, 1);
        expect(await numbersByTitle()).toEqual({ Herald: 1, Arena: 100, Court: 101 });
    });

    it('a re-import (all new channel ids) keeps every station on its number', async () => {
        const entry = (n: number, name: string, groupTitle: string): string =>
            `#EXTINF:-1 tvg-id="st${n}" tvg-name="${name}" group-title="${groupTitle}",${name}\n` +
            `http://203.0.113.${n}/live/${n}.ts\n`;
        playlist.text =
            '#EXTM3U\n' +
            entry(1, 'Alpha News', 'News') +
            entry(2, 'Beta News', 'News') +
            entry(3, 'Gamma Sport', 'Sport');
        await importM3uSource(sql, sourceId);
        const before = await numbersByTitle();
        expect(Object.keys(before).sort()).toEqual(['Alpha News', 'Beta News', 'Gamma Sport']);

        const beta = await sql<{ id: string }[]>`
            SELECT lc.id FROM livetv_channels lc JOIN media_items mi ON mi.id = lc.id
             WHERE mi.title = 'Beta News'
        `;
        await setChannelNumber(sql, beta[0].id, 42, { swap: false });
        const oldIds = (await sql<{ id: string }[]>`SELECT id FROM livetv_channels`).map(
            (r) => r.id,
        );

        // The provider reorders its list and adds a station.
        playlist.text =
            '#EXTM3U\n' +
            entry(3, 'Gamma Sport', 'Sport') +
            entry(4, 'Delta News', 'News') +
            entry(2, 'Beta News', 'News') +
            entry(1, 'Alpha News', 'News');
        await importM3uSource(sql, sourceId);

        const newIds = (await sql<{ id: string }[]>`SELECT id FROM livetv_channels`).map(
            (r) => r.id,
        );
        expect(newIds.some((id) => oldIds.includes(id))).toBe(false);
        const after = await numbersByTitle();
        expect(after['Alpha News']).toBe(before['Alpha News']);
        expect(after['Gamma Sport']).toBe(before['Gamma Sport']);
        expect(after['Beta News']).toBe(42);
        // After the highest UNPINNED number (a pin does not anchor new channels).
        expect(after['Delta News']).toBe(4);
        const [{ pinned }] = await sql<{ pinned: boolean }[]>`
            SELECT pinned FROM livetv_channel_numbers WHERE number = 42
        `;
        expect(pinned).toBe(true);
    });

    it('a re-import keeps a station with several feeds on its one number', async () => {
        const feed = (n: number, id: string, name: string): string =>
            `#EXTINF:-1 tvg-id="${id}" tvg-name="${name}" group-title="News",${name}\n` +
            `http://203.0.113.${n}/live/${n}.ts\n`;
        playlist.text =
            '#EXTM3U\n' +
            feed(1, 'herald.uk', 'Herald News HD') +
            feed(2, 'herald.uk', 'Herald News SD') +
            feed(3, 'daily.uk', 'Daily Post');
        await importM3uSource(sql, sourceId);
        const groups = await sql<{ id: string }[]>`
            SELECT DISTINCT backup_group_id AS id FROM livetv_channels WHERE backup_group_id IS NOT NULL
        `;
        expect(groups).toHaveLength(1);
        const before = await ensureChannelNumbers(sql);
        const heraldBefore = before.numbers.get(groups[0].id);
        expect(heraldBefore).toBeDefined();

        playlist.text =
            '#EXTM3U\n' +
            feed(3, 'daily.uk', 'Daily Post') +
            feed(2, 'herald.uk', 'Herald News SD') +
            feed(1, 'herald.uk', 'Herald News HD');
        await importM3uSource(sql, sourceId);
        const [newGroup] = await sql<{ id: string }[]>`
            SELECT DISTINCT backup_group_id AS id FROM livetv_channels WHERE backup_group_id IS NOT NULL
        `;
        expect(newGroup.id).not.toBe(groups[0].id);
        const after = await ensureChannelNumbers(sql);
        expect(after.numbers.get(newGroup.id)).toBe(heraldBefore);
        const [{ count }] = await sql<{ count: number }[]>`
            SELECT count(*)::int AS count FROM livetv_channel_numbers
        `;
        expect(count).toBe(2);
    });

    it('a re-import still matches a channel the admin renamed (provider name is compared)', async () => {
        // No tvg-id: only the URL and the name identify the channel.
        const bare = (n: number, name: string): string =>
            `#EXTINF:-1 group-title="News",${name}\nhttp://203.0.113.${n}/live/${n}.ts\n`;
        playlist.text = '#EXTM3U\n' + bare(1, 'Alpha News') + bare(2, 'Beta News');
        await importM3uSource(sql, sourceId);
        const [beta] = await sql<{ id: string }[]>`
            SELECT lc.id FROM livetv_channels lc JOIN media_items mi ON mi.id = lc.id
             WHERE mi.title = 'Beta News'
        `;
        await setChannelNumber(sql, beta.id, 77, { swap: false });
        await sql`UPDATE livetv_channels SET admin_display_name = 'My Evening News' WHERE id = ${beta.id}::uuid`;

        await importM3uSource(sql, sourceId);
        const after = await numbersByTitle();
        expect(after['Beta News']).toBe(77);
    });

    it("a re-import leaves a group that also holds another source's feed on its number", async () => {
        const feed = (n: number, name: string): string =>
            `#EXTINF:-1 tvg-id="herald.uk" tvg-name="${name}" group-title="News",${name}\n` +
            `http://203.0.113.${n}/live/${n}.ts\n`;
        playlist.text = '#EXTM3U\n' + feed(1, 'Herald News HD') + feed(2, 'Herald News SD');
        await importM3uSource(sql, sourceId);
        const [{ id: groupId }] = await sql<{ id: string }[]>`
            SELECT DISTINCT backup_group_id AS id FROM livetv_channels WHERE backup_group_id IS NOT NULL
        `;
        // A feed of the same station from a second source, put into the group by hand.
        const otherSource = crypto.randomUUID();
        await sql`
            INSERT INTO livetv_sources (id, name, source_type, m3u_url, max_streams)
            VALUES (${otherSource}::uuid, 'Second', 'm3u', 'http://203.0.113.251/list.m3u', 1)
        `;
        const other = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status)
            VALUES (${other}::uuid, 'Herald News Backup', 'tvchannel', 'active')
        `;
        await sql`
            INSERT INTO livetv_channels (id, m3u_url, source_id, sort_order, backup_group_id)
            VALUES (${other}::uuid, 'http://203.0.113.99/x.ts', ${otherSource}::uuid, 0, ${groupId}::uuid)
        `;
        const [{ id: anyFeed }] = await sql<{ id: string }[]>`
            SELECT id FROM livetv_channels WHERE source_id = ${sourceId}::uuid LIMIT 1
        `;
        await ensureChannelNumbers(sql);
        await setChannelNumber(sql, anyFeed, 42, { swap: false });

        await importM3uSource(sql, sourceId);
        const [owner] = await sql<{ backup_group_id: string | null; pinned: boolean }[]>`
            SELECT backup_group_id, pinned FROM livetv_channel_numbers WHERE number = 42
        `;
        expect(owner).toEqual({ backup_group_id: groupId, pinned: true });
    });
});
