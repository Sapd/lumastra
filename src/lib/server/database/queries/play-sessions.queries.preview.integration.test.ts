// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A hover preview owns a `play_sessions` row (it needs one for its media grant) but is
 * never playback. After the 2026-10-21 playback-grant deploy the server ignored
 * `purpose: 'preview'`, so every hover showed up as "Playing now", moved a card to the
 * top of "Jump back in", appeared in the admin active streams and ate a concurrent-stream
 * slot. Every reader of "who is playing right now" must skip `is_preview` rows; the
 * reaper must not (a preview row is closed like any other).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../../tests/integration/fixtures/user.fixtures.js';
import {
    claimStaleSessions,
    countLiveSessionsAnnouncing,
    createPlaySession,
    findActiveSession,
    getActiveSessionsForUser,
    getActiveSessionsView,
    getAllActiveSessions,
    getAllActiveSessionsWithMedia,
} from '$lib/server/database/queries/play-sessions.queries.js';
import { listUsers } from '$lib/server/database/queries/users.queries.js';
import type { UserId } from '$lib/shared/user-id.js';

describe('hover-preview sessions are not playback (integration)', () => {
    let sql: postgres.Sql;
    let userId: UserId;
    let movieId: string;
    let previewId: string;
    let playId: string;

    beforeAll(async () => {
        sql = getTestDb();
        await sql`SELECT 1`;
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['play_sessions', 'user_devices', 'media_items']);
        userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        movieId = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, runtime_seconds)
            VALUES (${movieId}::uuid, 'Example Film', 'movie', 'active', 6000)
        `;
        const common = {
            surface: 'web' as const,
            media_id: movieId,
            user_id: userId,
            ip_address: '127.0.0.1',
            play_method: 'full_transcode' as const,
            position_ms: 1_000_000,
            runtime_ms: 6_000_000,
            client_features: ['admin_message'],
        };
        previewId = (
            await createPlaySession(sql, { ...common, device_id: 'hover', is_preview: true })
        ).id;
        playId = (await createPlaySession(sql, { ...common, device_id: 'player' })).id;
    });

    it('stores the flag, defaulting to false', async () => {
        const rows = await sql<{ id: string; is_preview: boolean }[]>`
            SELECT id, is_preview FROM play_sessions
        `;
        expect(new Map(rows.map((r) => [r.id, r.is_preview]))).toEqual(
            new Map([
                [previewId, true],
                [playId, false],
            ]),
        );
    });

    it('keeps a preview out of every live-playback read', async () => {
        const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
        expect(ids(await getActiveSessionsForUser(sql, userId))).toEqual([playId]);
        expect(ids(await getAllActiveSessions(sql))).toEqual([playId]);
        expect(ids(await getAllActiveSessionsWithMedia(sql))).toEqual([playId]);
        expect(ids(await getActiveSessionsView(sql, { userId }))).toEqual([playId]);
        expect(ids(await getActiveSessionsView(sql, { userId, includeStale: true }))).toEqual([
            playId,
        ]);
        expect(await countLiveSessionsAnnouncing(sql, 'admin_message')).toEqual({
            total: 1,
            supporting: 1,
        });
        expect((await findActiveSession(sql, { userId, itemId: movieId }))?.id).toBe(playId);
    });

    it('projects file availability without hiding active or paused admin-visible sessions', async () => {
        await sql`UPDATE media_items SET has_files = true WHERE id = ${movieId}::uuid`;
        const [active] = await getActiveSessionsView(sql, { userId });
        expect(active.id).toBe(playId);
        expect(active.has_files).toBe(true);

        await sql`UPDATE media_items SET has_files = false WHERE id = ${movieId}::uuid`;
        await sql`UPDATE play_sessions SET status = 'PAUSED' WHERE id = ${playId}::uuid`;
        const [paused] = await getActiveSessionsView(sql, { userId });
        expect(paused.id).toBe(playId);
        expect(paused.has_files).toBe(false);
    });

    it('does not mark a user as streaming because of a preview', async () => {
        await sql`UPDATE play_sessions SET status = 'COMPLETED' WHERE id = ${playId}::uuid`;
        const summaries = await listUsers(sql);
        const mine = summaries.find((u) => u.id === userId);
        expect(mine?.currently_streaming ?? false).toBe(false);
    });

    it('still reaps a stale preview like any other session', async () => {
        await sql`
            UPDATE play_sessions
               SET last_heartbeat_at = now() - interval '10 minutes'
             WHERE id = ${previewId}::uuid
        `;
        const claimed = await claimStaleSessions(sql);
        expect(claimed.map((r) => r.id)).toContain(previewId);
        const [row] = await sql<{ status: string }[]>`
            SELECT status FROM play_sessions WHERE id = ${previewId}::uuid
        `;
        expect(row.status).toBe('CRASHED');
    });
});
