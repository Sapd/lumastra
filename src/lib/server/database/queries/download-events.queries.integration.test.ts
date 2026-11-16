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
    mergeTinyRangeEvent,
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

    it('joining an abandoned open row (dead replica) resets open_streams instead of inheriting it', async () => {
        const id = await startDownloadEvent(sql, base());
        await startDownloadEvent(sql, base());
        await startDownloadEvent(sql, base()); // 3 streams, then the replica dies
        await sql`UPDATE download_events SET last_activity_at = now() - interval '2 minutes'
                  WHERE id = ${id}`;
        expect(await startDownloadEvent(sql, base())).toBe(id);
        const [r] = await sql<{ open_streams: number }[]>`
            SELECT open_streams FROM download_events WHERE id = ${id}`;
        expect(r!.open_streams).toBe(1);
        await endDownloadEvent(sql, id, 'completed', { bytesSentDelta: 100 });
        const [after] = await sql<{ ended_at: Date | null }[]>`
            SELECT ended_at FROM download_events WHERE id = ${id}`;
        expect(after!.ended_at).not.toBeNull(); // one end closes it: no ghost streams left
    });

    it('joining a live open row still adds a stream', async () => {
        const id = await startDownloadEvent(sql, base());
        await startDownloadEvent(sql, base());
        const [r] = await sql<{ open_streams: number }[]>`
            SELECT open_streams FROM download_events WHERE id = ${id}`;
        expect(r!.open_streams).toBe(2);
    });

    describe('tiny successful ranges', () => {
        const total = 50_000_000;
        const insertEnded = async (
            outcome: string,
            bytes: number,
            rangeStart: number | null,
            agoSeconds: number,
        ): Promise<string> => {
            const [r] = await sql<{ id: string }[]>`
                INSERT INTO download_events (user_id, media_item_id, file_id, surface, device_key,
                    bytes_total, bytes_sent, range_start, started_at, last_activity_at, ended_at,
                    outcome, open_streams)
                VALUES (${userId}, ${ITEM}, ${FILE}, 'api', 'dev-1', ${total}, ${bytes},
                    ${rangeStart}, now() - ${agoSeconds} * interval '1 second', now(), now(),
                    ${outcome}, 0)
                RETURNING id`;
            return r!.id;
        };

        it('add their bytes to the latest earlier row, keep the better outcome, delete the tiny row', async () => {
            const first = await insertEnded('error', 3_000_000, 0, 60);
            const tiny = await insertEnded('completed', 4096, 40_000_000, 0);
            expect(await mergeTinyRangeEvent(sql, tiny)).toBe(true);
            const rows = await listDownloadEvents(sql, { userId, limit: 10 });
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                id: first,
                bytesSent: 3_000_000 + 4096,
                outcome: 'completed',
            });
        });

        it('never downgrades a completed row', async () => {
            const first = await insertEnded('completed', 50_000_000, 0, 60);
            const tiny = await insertEnded('aborted', 10, 5, 0);
            expect(await mergeTinyRangeEvent(sql, tiny)).toBe(true);
            const rows = await listDownloadEvents(sql, { userId, limit: 10 });
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ id: first, bytesSent: total, outcome: 'completed' });
        });

        it('a flood of tiny ranges folds into one row', async () => {
            await insertEnded('aborted', 1000, 0, 120);
            for (let i = 0; i < 20; i++) {
                const tiny = await insertEnded('completed', 100, 1000 + i, 0);
                expect(await mergeTinyRangeEvent(sql, tiny)).toBe(true);
            }
            const rows = await listDownloadEvents(sql, { userId, limit: 50 });
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ bytesSent: 3000, outcome: 'completed' });
        });

        it('a join that reopens the source row while the merge waits for the lock is not lost', async () => {
            await insertEnded('aborted', 1000, 0, 120);
            const tiny = await insertEnded('completed', 100, 5, 0);
            const key = `${userId}|dev-1|${FILE}`;
            let merged: Promise<boolean> | undefined;
            await sql.begin(async (tx) => {
                await tx`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
                merged = mergeTinyRangeEvent(sql, tiny); // blocks on the lock we hold
                await new Promise((r) => setTimeout(r, 300));
                // a new request joins (reopens) the tiny row in the meantime
                await tx`UPDATE download_events SET ended_at = NULL, outcome = NULL, open_streams = 1
                         WHERE id = ${tiny}`;
            });
            expect(await merged).toBe(false);
            const rows = await listDownloadEvents(sql, { userId, limit: 10 });
            expect(rows).toHaveLength(2); // nothing deleted, nothing merged
            expect(rows.find((r) => r.id === tiny)?.endedAt).toBeNull();
        });

        it('leaves the row alone when it is still open or nothing earlier exists', async () => {
            const open = await startDownloadEvent(sql, {
                ...base(),
                bytesTotal: total,
                rangeStart: 10,
            });
            expect(await mergeTinyRangeEvent(sql, open)).toBe(false);
            await endDownloadEvent(sql, open, 'completed', {
                bytesSentDelta: 10,
                reachedEnd: true,
            });
            expect(await mergeTinyRangeEvent(sql, open)).toBe(false);
            expect(await listDownloadEvents(sql, { userId, limit: 10 })).toHaveLength(1);
        });

        it('merges into a refusal row too (outcome-independent); the completed outcome replaces the refusal', async () => {
            await recordRefusedDownload(sql, { ...base(), bytesTotal: total }, 'denied');
            const tiny = await insertEnded('completed', 100, 5, 0);
            expect(await mergeTinyRangeEvent(sql, tiny)).toBe(true);
            const rows = await listDownloadEvents(sql, { userId, limit: 10 });
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ bytesSent: 100, outcome: 'completed' });
        });

        it('never merges into a row older than the window', async () => {
            const old = await insertEnded('aborted', 10, 0, 3600);
            await sql`UPDATE download_events SET ended_at = now() - interval '11 minutes'
                      WHERE id = ${old}`;
            const tiny = await insertEnded('completed', 100, 5, 0);
            expect(await mergeTinyRangeEvent(sql, tiny)).toBe(false);
            expect(await listDownloadEvents(sql, { userId, limit: 10 })).toHaveLength(2);
        });

        it('allowInsert is asked for a new row only, and false skips the insert', async () => {
            const asked: number[] = [];
            const none = await startDownloadEvent(sql, base(), {
                allowInsert: () => (asked.push(1), false),
            });
            expect(none).toBeNull();
            expect(await listDownloadEvents(sql, { userId, limit: 10 })).toHaveLength(0);
            const id = (await startDownloadEvent(sql, base()))!;
            // a join and a re-open never ask
            expect(
                await startDownloadEvent(sql, base(), {
                    allowInsert: () => (asked.push(1), false),
                }),
            ).toBe(id);
            expect(asked).toHaveLength(1);
        });
    });

    describe('archive downloads (kind = archive)', () => {
        const SERIES = '44444444-4444-4444-8444-444444444444';
        const SEASON = '55555555-5555-4555-8555-555555555555';
        const archive = (mediaItemId: string, over: Record<string, unknown> = {}) => ({
            userId,
            mediaItemId,
            archive: true,
            surface: 'web' as const,
            deviceKey: 'dev-zip',
            clientName: 'Test',
            bytesTotal: 1000,
            ...over,
        });

        it('stores kind archive with no file and no rendition id', async () => {
            await startDownloadEvent(sql, archive(SERIES));
            const [row] = await listOpenDownloadEvents(sql, [userId]);
            expect(row).toMatchObject({
                kind: 'archive',
                mediaItemId: SERIES,
                fileId: null,
                renditionId: null,
            });
        });

        it('every request is its own row, even for the same item on the same device', async () => {
            const a = await startDownloadEvent(sql, archive(SERIES));
            const b = await startDownloadEvent(sql, archive(SERIES));
            const c = await startDownloadEvent(sql, archive(SEASON));
            expect(new Set([a, b, c]).size).toBe(3);
            const open = await listOpenDownloadEvents(sql, [userId]);
            expect(open).toHaveLength(3);
            expect(open.every((r) => r.kind === 'archive')).toBe(true);
        });

        it('repeated aborts never accumulate: each attempt is one row with its own bytes', async () => {
            const ids: string[] = [];
            for (let i = 0; i < 3; i++) {
                const id = await startDownloadEvent(sql, archive(SERIES));
                await updateDownloadEvent(sql, id, { bytesSentDelta: 400 });
                await endDownloadEvent(sql, id, 'aborted', { bytesSentDelta: 100 });
                ids.push(id);
            }
            expect(new Set(ids).size).toBe(3);
            const rows = await listDownloadEvents(sql, { userId, limit: 10 });
            expect(rows).toHaveLength(3);
            for (const r of rows) {
                expect(r).toMatchObject({ outcome: 'aborted', bytesSent: 500, bytesTotal: 1000 });
            }
        });

        it('completed only when that one stream sent the whole archive', async () => {
            const part = await startDownloadEvent(sql, archive(SERIES));
            await endDownloadEvent(sql, part, 'completed', { bytesSentDelta: 999 });
            const full = await startDownloadEvent(sql, archive(SERIES));
            await endDownloadEvent(sql, full, 'completed', { bytesSentDelta: 1000 });
            const rows = await listDownloadEvents(sql, { userId, limit: 10 });
            expect(rows.find((r) => r.id === part)!.outcome).toBe('aborted');
            expect(rows.find((r) => r.id === full)!.outcome).toBe('completed');
        });

        it('does not touch the open row of a single file of the same item', async () => {
            const f = await startDownloadEvent(sql, {
                ...base(),
                mediaItemId: SERIES,
                deviceKey: 'dev-zip',
            });
            const a = await startDownloadEvent(sql, archive(SERIES));
            expect(a).not.toBe(f);
            const [file] = await sql<{ open_streams: number; kind: string }[]>`
                SELECT open_streams, kind FROM download_events WHERE id = ${f}`;
            expect(file).toMatchObject({ open_streams: 1, kind: 'file' });
        });

        it('a refused archive attempt is an archive row; a refused single file stays a file row', async () => {
            await recordRefusedDownload(sql, archive(SERIES, { bytesTotal: null }), 'denied');
            await recordRefusedDownload(
                sql,
                { userId, mediaItemId: ITEM, surface: 'web', deviceKey: 'dev-zip' },
                'denied',
            );
            const rows = await listDownloadEvents(sql, { userId, limit: 10 });
            expect(rows.find((r) => r.mediaItemId === SERIES)!.kind).toBe('archive');
            // no file id (a movie/episode denied before a file was chosen) is NOT a ZIP
            expect(rows.find((r) => r.mediaItemId === ITEM)).toMatchObject({
                kind: 'file',
                fileId: null,
            });
        });
    });
});
