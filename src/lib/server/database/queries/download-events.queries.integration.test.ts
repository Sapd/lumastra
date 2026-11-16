// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
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
            before: new Date(Date.now() - 60_000),
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
});
