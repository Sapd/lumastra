// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    closeStaleDownloadEvents,
    getDownloadTitles,
    getUsernamesByIds,
    listOpenDownloadEvents,
    deleteDownloadEventsOlderThan,
    endDownloadEvent,
    listDownloadEvents,
    recordRefusedDownload,
    startDownloadEvent,
    updateDownloadEvent,
} from './download-events.queries.js';

const ITEM = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';

describe('download-events queries', () => {
    let sql: postgres.Sql;
    let userId: string;

    const base = () => ({
        userId,
        mediaItemId: ITEM,
        fileId: FILE,
        surface: 'api' as const,
        deviceKey: 'dev-1',
        clientName: 'Test',
        bytesTotal: 100,
    });

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`TRUNCATE download_events`;
        const rows = await sql<{ id: string }[]>`
            INSERT INTO users (username) VALUES (${'dl-' + Math.random().toString(36).slice(2)})
            RETURNING id`;
        userId = rows[0]!.id;
    });

    it('start -> update -> end round trip, completed once everything was sent', async () => {
        const id = await startDownloadEvent(sql, base());
        await updateDownloadEvent(sql, id, { bytesSentDelta: 60 });
        await endDownloadEvent(sql, id, 'completed', { bytesSentDelta: 40 });
        const [row] = await listDownloadEvents(sql, { userId, limit: 10 });
        expect(row).toMatchObject({
            id,
            surface: 'api',
            deviceKey: 'dev-1',
            clientName: 'Test',
            bytesTotal: 100,
            bytesSent: 100,
            outcome: 'completed',
        });
        expect(row!.endedAt).not.toBeNull();
    });

    it('a stream that ended without covering the file is recorded as aborted', async () => {
        const id = await startDownloadEvent(sql, base());
        await endDownloadEvent(sql, id, 'completed', { bytesSentDelta: 10 });
        const [row] = await listDownloadEvents(sql, { userId, limit: 10 });
        expect(row!.outcome).toBe('aborted');
        const id2 = await startDownloadEvent(sql, { ...base(), deviceKey: 'dev-2' });
        await endDownloadEvent(sql, id2, 'error');
        const rows = await listDownloadEvents(sql, { userId, limit: 10 });
        expect(rows.find((r) => r.id === id2)!.outcome).toBe('error');
    });

    it('keeps the given outcome when the total size is unknown', async () => {
        const id = await startDownloadEvent(sql, { ...base(), bytesTotal: null });
        await endDownloadEvent(sql, id, 'completed', { bytesSentDelta: 5 });
        const [row] = await listDownloadEvents(sql, { userId, limit: 10 });
        expect(row!.outcome).toBe('completed');
    });

    it('an aborted download resumed within 10 min reuses the row and adds bytes', async () => {
        const id = await startDownloadEvent(sql, base());
        await endDownloadEvent(sql, id, 'aborted', { bytesSentDelta: 30 });
        const again = await startDownloadEvent(sql, base());
        expect(again).toBe(id);
        await endDownloadEvent(sql, again, 'completed', { bytesSentDelta: 70 });
        const rows = await listDownloadEvents(sql, { userId, limit: 10 });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ bytesSent: 100, outcome: 'completed' });
    });

    it('a completed download is never re-opened: a re-download aborted after 1 MB is a second row', async () => {
        const total = 10_000_000;
        const first = await startDownloadEvent(sql, { ...base(), bytesTotal: total });
        await endDownloadEvent(sql, first, 'completed', { bytesSentDelta: total });
        const second = await startDownloadEvent(sql, { ...base(), bytesTotal: total });
        expect(second).not.toBe(first);
        await endDownloadEvent(sql, second, 'aborted', { bytesSentDelta: 1_048_576 });
        const rows = await listDownloadEvents(sql, { userId, limit: 10 });
        expect(rows).toHaveLength(2);
        expect(rows.find((r) => r.id === first)).toMatchObject({ outcome: 'completed' });
        expect(rows.find((r) => r.id === second)).toMatchObject({
            outcome: 'aborted',
            bytesSent: 1_048_576,
        });
    });

    it('an open row is reused; another device or an old ended row starts a new one', async () => {
        const id = await startDownloadEvent(sql, base());
        expect(await startDownloadEvent(sql, base())).toBe(id);
        expect(await startDownloadEvent(sql, { ...base(), deviceKey: 'dev-2' })).not.toBe(id);

        await endDownloadEvent(sql, id, 'aborted');
        await endDownloadEvent(sql, id, 'aborted'); // two streams joined the row
        await sql`UPDATE download_events SET ended_at = now() - interval '11 minutes'
                  WHERE id = ${id}`;
        expect(await startDownloadEvent(sql, base())).not.toBe(id);
    });

    it('a refusal row is never re-opened', async () => {
        await recordRefusedDownload(sql, base(), 'rate_limited');
        const id = await startDownloadEvent(sql, base());
        const rows = await listDownloadEvents(sql, { userId, limit: 10 });
        expect(rows).toHaveLength(2);
        expect(rows.find((r) => r.id === id)!.outcome).toBeNull();
        expect(rows.find((r) => r.id !== id)!.outcome).toBe('rate_limited');
    });

    it('records a denied row with no bytes', async () => {
        await recordRefusedDownload(sql, { ...base(), fileId: null }, 'denied');
        const [row] = await listDownloadEvents(sql, { userId, limit: 10 });
        expect(row).toMatchObject({ outcome: 'denied', bytesSent: 0, fileId: null });
        expect(row!.endedAt).not.toBeNull();
    });

    it('lists newest first, for one user, before a cursor, within a limit', async () => {
        const a = await startDownloadEvent(sql, { ...base(), deviceKey: 'a' });
        const b = await startDownloadEvent(sql, { ...base(), deviceKey: 'b' });
        await sql`UPDATE download_events SET started_at = now() - interval '1 hour'
                  WHERE id = ${a}`;
        const all = await listDownloadEvents(sql, { userId, limit: 10 });
        expect(all.map((r) => r.id)).toEqual([b, a]);
        expect(await listDownloadEvents(sql, { userId, limit: 1 })).toHaveLength(1);
        const before = await listDownloadEvents(sql, {
            userId,
            limit: 10,
            before: all[0]!.cursor,
        });
        expect(before.map((r) => r.id)).toEqual([a]);
        expect(await listDownloadEvents(sql, { limit: 10 })).toHaveLength(2);
    });

    it('prune deletes only old rows', async () => {
        const old = await startDownloadEvent(sql, { ...base(), deviceKey: 'old' });
        await startDownloadEvent(sql, { ...base(), deviceKey: 'new' });
        await sql`UPDATE download_events
                  SET started_at = now() - interval '100 days',
                      last_activity_at = now() - interval '100 days'
                  WHERE id = ${old}`;
        expect(await deleteDownloadEventsOlderThan(sql, 90)).toBe(1);
        const rows = await listDownloadEvents(sql, { userId, limit: 10 });
        expect(rows.map((r) => r.deviceKey)).toEqual(['new']);
    });

    it('lists open rows only for the given users', async () => {
        const open = await startDownloadEvent(sql, base());
        const done = await startDownloadEvent(sql, { ...base(), deviceKey: 'dev-2' });
        await endDownloadEvent(sql, done, 'completed', { bytesSentDelta: 100 });
        const other = await sql<{ id: string }[]>`
            INSERT INTO users (username) VALUES (${'dl-o-' + Math.random().toString(36).slice(2)})
            RETURNING id`;
        await startDownloadEvent(sql, { ...base(), userId: other[0]!.id, deviceKey: 'dev-3' });

        const rows = await listOpenDownloadEvents(sql, [userId]);
        expect(rows.map((r) => r.id)).toEqual([open]);
        expect(await listOpenDownloadEvents(sql, [])).toEqual([]);
    });

    it('resolves usernames by id', async () => {
        const map = await getUsernamesByIds(sql, [userId]);
        expect(map.get(userId)).toMatch(/^dl-/);
        expect((await getUsernamesByIds(sql, [])).size).toBe(0);
    });

    it('resolves titles for a movie and for episodes with and without a season row', async () => {
        const ids = {
            movie: '44444444-4444-4444-8444-000000000001',
            series: '44444444-4444-4444-8444-000000000002',
            season: '44444444-4444-4444-8444-000000000003',
            ep: '44444444-4444-4444-8444-000000000004',
            epDirect: '44444444-4444-4444-8444-000000000005',
        };
        await sql`DELETE FROM media_items WHERE id IN ${sql(Object.values(ids))}`;
        await sql`INSERT INTO media_items (id, title, media_type, status) VALUES
            (${ids.movie}, 'A Movie', 'movie', 'active'),
            (${ids.series}, 'Example Show', 'tv', 'active')`;
        await sql`INSERT INTO media_items (id, title, media_type, status, parent_id, season_number) VALUES
            (${ids.season}, 'Season 2', 'season', 'active', ${ids.series}, 2)`;
        await sql`INSERT INTO media_items (id, title, media_type, status, parent_id, season_number, episode_number) VALUES
            (${ids.ep}, 'Pilot', 'episode', 'active', ${ids.season}, 2, 5),
            (${ids.epDirect}, 'Special', 'episode', 'active', ${ids.series}, 0, 1)`;
        try {
            const t = await getDownloadTitles(sql, Object.values(ids));
            expect(t.get(ids.movie)).toEqual({
                title: 'A Movie',
                seriesTitle: null,
                season: null,
                episode: null,
            });
            expect(t.get(ids.ep)).toEqual({
                title: 'Pilot',
                seriesTitle: 'Example Show',
                season: 2,
                episode: 5,
            });
            expect(t.get(ids.epDirect)).toMatchObject({
                title: 'Special',
                seriesTitle: 'Example Show',
            });
            expect((await getDownloadTitles(sql, [])).size).toBe(0);
        } finally {
            await sql`DELETE FROM media_items WHERE id IN ${sql(Object.values(ids))}`;
        }
    });

    it('closes stale open rows as aborted at their last activity, leaving fresh and ended rows', async () => {
        const stale = await startDownloadEvent(sql, base());
        const fresh = await startDownloadEvent(sql, { ...base(), deviceKey: 'dev-fresh' });
        const ended = await startDownloadEvent(sql, { ...base(), deviceKey: 'dev-ended' });
        await endDownloadEvent(sql, ended, 'completed', { bytesSentDelta: 100 });
        await sql`UPDATE download_events SET last_activity_at = now() - interval '30 minutes'
                  WHERE id = ${stale}`;

        const n = await closeStaleDownloadEvents(sql, new Date(Date.now() - 15 * 60_000));
        expect(n).toBe(1);
        const rows = await listDownloadEvents(sql, { userId, limit: 10 });
        const byId = new Map(rows.map((r) => [r.id, r]));
        expect(byId.get(stale)).toMatchObject({ outcome: 'aborted' });
        expect(byId.get(stale)!.endedAt!.getTime()).toBe(byId.get(stale)!.lastActivityAt.getTime());
        expect(byId.get(fresh)!.endedAt).toBeNull();
        expect(byId.get(ended)!.outcome).toBe('completed');
    });

    it('two concurrent starts for one transfer end up on ONE open row with 2 streams', async () => {
        const [x, y] = await Promise.all([
            startDownloadEvent(sql, base()),
            startDownloadEvent(sql, base()),
        ]);
        expect(x).toBe(y);
        const rows = await sql`SELECT open_streams FROM download_events WHERE user_id = ${userId}`;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.open_streams).toBe(2);
    });

    it('the row only closes when its last stream ends', async () => {
        const id = await startDownloadEvent(sql, base());
        await startDownloadEvent(sql, base());
        await endDownloadEvent(sql, id, 'completed', { bytesSentDelta: 40 });
        let [row] = await listDownloadEvents(sql, { userId, limit: 10 });
        expect(row).toMatchObject({ endedAt: null, outcome: null, bytesSent: 40 });
        await endDownloadEvent(sql, id, 'completed', { bytesSentDelta: 60 });
        [row] = await listDownloadEvents(sql, { userId, limit: 10 });
        expect(row).toMatchObject({ outcome: 'completed', bytesSent: 100 });
        expect(row!.endedAt).not.toBeNull();
    });

    it('a Range request for the tail that ran to its end completes the row; bytes are capped at the total', async () => {
        const id = await startDownloadEvent(sql, { ...base(), rangeStart: 50 });
        await endDownloadEvent(sql, id, 'completed', { bytesSentDelta: 50, reachedEnd: true });
        let [row] = await listDownloadEvents(sql, { userId, limit: 10 });
        expect(row!.outcome).toBe('completed');

        const id2 = await startDownloadEvent(sql, { ...base(), deviceKey: 'dev-cap' });
        await updateDownloadEvent(sql, id2, { bytesSentDelta: 80 });
        await endDownloadEvent(sql, id2, 'aborted', { bytesSentDelta: 80 });
        [row] = (await listDownloadEvents(sql, { userId, limit: 10 })).filter((r) => r.id === id2);
        expect(row!.bytesSent).toBe(100);
    });

    it('keyset cursor pages rows with identical started_at without gaps or repeats', async () => {
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
            ids.push(await startDownloadEvent(sql, { ...base(), deviceKey: `k${i}` }));
        }
        await sql`UPDATE download_events SET started_at = '2026-11-16T10:00:00.123456Z'
                  WHERE user_id = ${userId}`;
        const seen: string[] = [];
        let before: string | undefined;
        for (let i = 0; i < 3; i++) {
            const page = await listDownloadEvents(sql, { userId, limit: 2, before });
            seen.push(...page.map((r) => r.id));
            before = page.at(-1)?.cursor;
        }
        expect([...seen].sort()).toEqual([...ids].sort());
        expect(new Set(seen).size).toBe(5);
    });
});
