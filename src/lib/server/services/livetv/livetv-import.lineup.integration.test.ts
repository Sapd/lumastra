// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A re-import must publish the new channel set and the source's stored
 * Configure Lineup in ONE transaction: no reader may see the replaced channels
 * all visible, and a lineup that cannot be applied rolls the re-import back.
 *
 * Real: PostgreSQL, the M3U parser, the auto-processor, the import service and
 * the setup service. Faked: the HTTP fetch, the Valkey source lock, and a probe
 * wrapped around applySetupPreferences that reads the source from a SECOND
 * connection (committed state only) right before the lineup is applied.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

const probe = vi.hoisted(() => ({
    failWith: null as Error | null,
    /** Committed rows of the source, read on another connection before the lineup ran. */
    seen: null as null | Array<{ title: string; is_visible: boolean }>,
    reader: null as null | (() => Promise<Array<{ title: string; is_visible: boolean }>>),
}));

vi.mock('$lib/server/cache/valkey.js', () => ({
    acquireLock: vi.fn().mockResolvedValue('lock-token'),
    releaseLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/server/cache', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/cache')>()),
    cacheInvalidation: { onContentAdded: vi.fn().mockResolvedValue(undefined) },
}));

const playlist = vi.hoisted(() => ({ text: '' }));
vi.mock('./fetch-source.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./fetch-source.js')>()),
    fetchSsrfValidatedText: vi.fn(async () => playlist.text),
}));

vi.mock('./livetv-setup.service.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('./livetv-setup.service.js')>();
    return {
        ...real,
        applySetupPreferences: async (
            ...args: Parameters<typeof real.applySetupPreferences>
        ): Promise<Awaited<ReturnType<typeof real.applySetupPreferences>>> => {
            probe.seen = (await probe.reader?.()) ?? null;
            if (probe.failWith) throw probe.failWith;
            return real.applySetupPreferences(...args);
        },
    };
});

import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { importM3uSource, importEpgSource } from './livetv-import.service.js';

const HIDDEN_GROUP = 'Rivage+';

function m3u(): string {
    const entry = (n: number, name: string, group: string) =>
        `#EXTINF:-1 tvg-id="ch${n}" tvg-name="${name}" group-title="${group}",${name}\n` +
        `http://203.0.113.${n}/live/${n}.ts\n`;
    return (
        '#EXTM3U\n' +
        entry(1, 'Alpha News', 'News') +
        entry(2, 'Beta News', 'News') +
        entry(3, 'Gamma Late', HIDDEN_GROUP) +
        entry(4, 'Delta Late', HIDDEN_GROUP)
    );
}

describe('re-import applies the stored lineup in the same transaction', () => {
    let sql: postgres.Sql;
    let sourceId: string;

    const rows = () =>
        sql<Array<{ id: string; title: string; is_visible: boolean }>>`
            SELECT lc.id, mi.title, lc.is_visible
            FROM livetv_channels lc JOIN media_items mi ON mi.id = lc.id
            WHERE lc.source_id = ${sourceId} ORDER BY mi.title
        `;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql.unsafe(
            'TRUNCATE TABLE livetv_channel_watch_history, livetv_programs, livetv_epg_channels, livetv_channels, livetv_categories, livetv_backup_groups, livetv_sources, media_items RESTART IDENTITY CASCADE',
        );
        sourceId = crypto.randomUUID();
        await sql`
            INSERT INTO livetv_sources (id, name, source_type, m3u_url, max_streams)
            VALUES (${sourceId}::uuid, 'Reimport', 'm3u', 'http://203.0.113.250/list.m3u', 2)
        `;
        playlist.text = m3u();
        probe.failWith = null;
        probe.seen = null;
        probe.reader = async () =>
            sql.reserve().then(async (other) => {
                try {
                    return await other<Array<{ title: string; is_visible: boolean }>>`
                        SELECT mi.title, lc.is_visible
                        FROM livetv_channels lc JOIN media_items mi ON mi.id = lc.id
                        WHERE lc.source_id = ${sourceId} ORDER BY mi.title
                    `;
                } finally {
                    other.release();
                }
            });
    });

    async function storeLineup(): Promise<void> {
        await sql`
            UPDATE livetv_sources
            SET lineup_filter = ${sql.json({
                countries: [],
                includeUntagged: true,
                hideLoopChannels: false,
                hiddenCategories: [HIDDEN_GROUP],
                channelOrder: 'traditional',
                preferHighQuality: true,
            })}
            WHERE id = ${sourceId}
        `;
    }

    it('carries every viewer favourite and its order over changed URL credentials, atomically', async () => {
        await importM3uSource(sql, sourceId);
        const before = await rows();
        const users = await sql<{ id: string }[]>`
            INSERT INTO users (username) VALUES ('fr-livetv-fav-a'), ('fr-livetv-fav-b')
            ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username RETURNING id
        `;
        await sql`INSERT INTO livetv_channel_favorites (user_id, channel_id, sort_order, created_at)
            VALUES (${users[0].id}, ${before[0].id}, 7, '2026-01-01'),
                   (${users[0].id}, ${before[1].id}, 2, '2026-01-02'),
                   (${users[1].id}, ${before[0].id}, 4, '2026-01-03')`;
        const favourites = () => sql`
            SELECT f.user_id, mi.title, f.sort_order, f.created_at FROM livetv_channel_favorites f
            JOIN media_items mi ON mi.id = f.channel_id ORDER BY f.user_id, f.sort_order
        `;
        const expected = await favourites();
        playlist.text = m3u().replaceAll('/live/', '/changed-token/');
        await importM3uSource(sql, sourceId);
        expect((await rows()).every((ch) => !before.some((old) => old.id === ch.id))).toBe(true);
        expect(await favourites()).toEqual(expected);
        await storeLineup();
        probe.failWith = new Error('lineup rollback');
        await expect(importM3uSource(sql, sourceId)).rejects.toThrow('lineup rollback');
        expect(await favourites()).toEqual(expected);
    });
    it('records guide failure separately without moving the playlist schedule or losing its summary', async () => {
        await importM3uSource(sql, sourceId);
        await sql`UPDATE livetv_sources SET xmltv_url = 'http://203.0.113.250/guide.xml',
            last_refresh_at = '2026-01-01', last_refresh_summary = '{"channelCount":4,"warnings":["playlist warning"]}'::jsonb
            WHERE id = ${sourceId}`;
        const [before] =
            await sql`SELECT last_refresh_at, last_refresh_status FROM livetv_sources WHERE id = ${sourceId}`;
        const { fetchSsrfValidatedText } = await import('./fetch-source.js');
        vi.mocked(fetchSsrfValidatedText).mockRejectedValueOnce(
            new Error('Guide failed http://user:secret@provider.example/guide'),
        );
        await expect(importEpgSource(sql, sourceId)).rejects.toThrow('Guide failed');
        const [after] =
            await sql`SELECT last_refresh_at, last_refresh_status, last_refresh_summary FROM livetv_sources WHERE id = ${sourceId}`;
        expect(after.last_refresh_at).toEqual(before.last_refresh_at);
        expect(after.last_refresh_status).toBe(before.last_refresh_status);
        expect(after.last_refresh_summary).toMatchObject({
            channelCount: 4,
            warnings: ['playlist warning'],
            epg: { status: 'failed' },
        });
        expect(JSON.stringify(after.last_refresh_summary)).not.toContain('secret');
    });
    it('clears all programmes and EPG metadata when removing XMLTV, safely twice', async () => {
        await importM3uSource(sql, sourceId);
        const [channel] = await rows();
        await sql`UPDATE livetv_sources SET xmltv_url = 'http://203.0.113.250/guide.xml' WHERE id = ${sourceId}`;
        await sql`INSERT INTO livetv_programs (id, channel_id, title, start_time, end_time)
            VALUES (${crypto.randomUUID()}, ${channel.id}, 'Old guide', now(), now() + interval '1 hour')`;
        const { updateSource } =
            await import('$lib/server/database/queries/livetv-sources.queries.js');
        await updateSource(sql, sourceId, { xmltv_url: null });
        await updateSource(sql, sourceId, { xmltv_url: null });
        expect(
            await sql`SELECT id FROM livetv_programs WHERE channel_id = ${channel.id}`,
        ).toHaveLength(0);
    });
    function guide(): string {
        return (
            '<tv><channel id="ch1"><display-name>Alpha News</display-name></channel>' +
            '<programme channel="ch1" start="20261030000000 +0000" stop="20261030010000 +0000"><title>Guide</title></programme></tv>'
        );
    }
    it('preserves playlist status, timestamp and summary after a successful guide import', async () => {
        await importM3uSource(sql, sourceId);
        await sql`UPDATE livetv_sources SET xmltv_url = 'http://203.0.113.250/guide.xml',
            last_refresh_status = 'failed', last_refresh_at = '2026-01-01',
            last_refresh_summary = '{"channelCount":4,"error":"Playlist failure"}'::jsonb WHERE id = ${sourceId}`;
        playlist.text = guide();
        await importEpgSource(sql, sourceId);
        const [after] =
            await sql`SELECT last_refresh_at, last_refresh_status, last_refresh_summary FROM livetv_sources WHERE id = ${sourceId}`;
        expect(after.last_refresh_at).toEqual(new Date('2026-01-01T00:00:00Z'));
        expect(after.last_refresh_status).toBe('failed');
        expect(after.last_refresh_summary).toMatchObject({
            channelCount: 4,
            error: 'Playlist failure',
            epg: { status: 'success', programCount: 1 },
        });
        playlist.text = m3u();
        await importM3uSource(sql, sourceId);
        const [fresh] =
            await sql`SELECT last_refresh_summary FROM livetv_sources WHERE id = ${sourceId}`;
        expect(fresh.last_refresh_summary.epg.status).toBe('success');
    });
    it('does not resurrect programmes when XMLTV is cleared during an in-flight guide fetch', async () => {
        await importM3uSource(sql, sourceId);
        await sql`UPDATE livetv_sources SET xmltv_url = 'http://203.0.113.250/guide.xml' WHERE id = ${sourceId}`;
        playlist.text = guide();
        const { updateSource } =
            await import('$lib/server/database/queries/livetv-sources.queries.js');
        const run = importEpgSource(sql, sourceId, async (progress) => {
            if (progress.phase === 'persisting')
                await updateSource(sql, sourceId, { xmltv_url: null });
        });
        await expect(run).rejects.toMatchObject({ name: 'LiveTvImportCancelledError' });
        expect(
            await sql`SELECT id FROM livetv_programs WHERE channel_id IN (SELECT id FROM livetv_channels WHERE source_id = ${sourceId})`,
        ).toHaveLength(0);
    });
    it('keeps a source without a stored filter fully visible', async () => {
        await importM3uSource(sql, sourceId);
        const after = await rows();
        expect(after).toHaveLength(4);
        expect(after.every((r) => r.is_visible)).toBe(true);
    });

    it('hides the filtered channels the moment the import returns, never exposing them visible', async () => {
        await importM3uSource(sql, sourceId);
        const before = await rows();
        expect(before.every((r) => r.is_visible)).toBe(true);
        await storeLineup();

        await importM3uSource(sql, sourceId);

        const after = await rows();
        expect(after).toHaveLength(4);
        const oldIds = new Set(before.map((r) => r.id));
        expect(after.some((r) => oldIds.has(r.id))).toBe(false);
        expect(after.filter((r) => r.is_visible).map((r) => r.title)).toEqual([
            'Alpha News',
            'Beta News',
        ]);
        expect(after.filter((r) => !r.is_visible).map((r) => r.title)).toEqual([
            'Delta Late',
            'Gamma Late',
        ]);

        // Just before the lineup ran, a concurrent reader (other connection) saw
        // only the committed OLD rows: the unfiltered new set was not published.
        expect(probe.seen).not.toBeNull();
        // The probe rows carry no ids; the new rows have fresh ids (asserted
        // above), so what it saw is the old committed set, all visible.
        expect(probe.seen).toEqual(before.map(({ title, is_visible }) => ({ title, is_visible })));
    });

    it('rolls the whole re-import back when the stored lineup cannot be applied', async () => {
        await importM3uSource(sql, sourceId);
        const before = await rows();
        await storeLineup();
        probe.failWith = new Error('lineup exploded');

        await expect(importM3uSource(sql, sourceId)).rejects.toThrow('lineup exploded');

        const after = await rows();
        expect(after).toEqual(before);
        const [{ last_refresh_status: status }] = await sql<Array<{ last_refresh_status: string }>>`
            SELECT last_refresh_status FROM livetv_sources WHERE id = ${sourceId}
        `;
        expect(status).toBe('failed');
    });

    it("drops the replaced channels' backup groups instead of piling them up per re-import", async () => {
        const feed = (n: number, name: string) =>
            `#EXTINF:-1 tvg-name="${name}" group-title="News",${name}\n` +
            `http://203.0.113.${n}/live/${n}.ts\n`;
        playlist.text =
            '#EXTM3U\n' +
            feed(11, 'Omega News HD') +
            feed(12, 'Omega News FHD') +
            feed(13, 'Sigma Sport HD') +
            feed(14, 'Sigma Sport FHD');
        const groups = () =>
            sql<Array<{ total: number; unused: number }>>`
                SELECT count(*)::int AS total,
                       count(*) FILTER (WHERE NOT EXISTS (
                           SELECT 1 FROM livetv_channels c WHERE c.backup_group_id = g.id
                       ))::int AS unused
                FROM livetv_backup_groups g WHERE g.source_id = ${sourceId}
            `;

        await importM3uSource(sql, sourceId);
        const [first] = await groups();
        expect(first.total).toBeGreaterThan(0);
        expect(first.unused).toBe(0);

        await importM3uSource(sql, sourceId);
        await importM3uSource(sql, sourceId);
        const [third] = await groups();
        expect(third).toEqual({ total: first.total, unused: 0 });
    });
});
