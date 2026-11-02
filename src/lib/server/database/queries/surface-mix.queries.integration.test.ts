// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/server/database/queries/surface-mix.queries.integration.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../../tests/integration/fixtures/user.fixtures.js';
import type { UserId } from '$lib/shared/user-id.js';
import { getSurfaceMix } from './admin-stats.queries.js';
import { createPlaySession } from './play-sessions.queries.js';

const MOVIE_ID = '00000000-0000-0000-0000-0000000000a1';
const CHANNEL_ID = '00000000-0000-0000-0000-0000000000a2';

describe('getSurfaceMix', () => {
    let sql: postgres.Sql;
    let userId: UserId;

    beforeAll(async () => {
        sql = await getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['play_sessions', 'media_items']);
        userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        await sql`
            INSERT INTO media_items (id, media_type, title)
            VALUES (${MOVIE_ID}::uuid, 'movie', 'A Movie'),
                   (${CHANNEL_ID}::uuid, 'tvchannel', 'A Channel')
        `;
    });

    async function seed(
        surface: string | null,
        mediaId: string,
        startedDaysAgo: number,
    ): Promise<void> {
        await sql`
            INSERT INTO play_sessions
                (media_id, user_id, device_id, ip_address, play_method, position_ms, surface, started_at)
            VALUES (
                ${mediaId}::uuid, ${userId}, 'dev', '127.0.0.1'::inet, 'direct', 0,
                ${surface},
                NOW() - (${startedDaysAgo}::text || ' days')::interval
            )
        `;
    }

    it('groups by surface and shares out of ALL sessions in the window', async () => {
        await seed('web', MOVIE_ID, 1);
        await seed('web', MOVIE_ID, 2);
        await seed('subsonic', MOVIE_ID, 3);
        await seed('jellyfin_compat', MOVIE_ID, 4);

        const stats = await getSurfaceMix(sql, 90);

        expect(stats.totalSessions).toBe(4);
        expect(stats.attributedSessions).toBe(4);
        // Sorted by session count descending.
        expect(stats.segments[0]).toMatchObject({ surface: 'web', sessions: 2 });
        expect(stats.segments[0]!.percentage).toBeCloseTo(50, 5);
        expect(stats.segments.map((s) => s.surface).sort()).toEqual([
            'jellyfin_compat',
            'subsonic',
            'web',
        ]);
    });

    it('collapses NULL surface to unknown and excludes it from attributedSessions', async () => {
        // The forward-only reality: rows predating the column, and the paths
        // that legitimately cannot know (restart replay, transcode stub).
        await seed(null, MOVIE_ID, 1);
        await seed(null, MOVIE_ID, 2);
        await seed('web', MOVIE_ID, 3);

        const stats = await getSurfaceMix(sql, 90);

        expect(stats.totalSessions).toBe(3);
        expect(stats.attributedSessions).toBe(1);
        const unknown = stats.segments.find((s) => s.surface === 'unknown');
        expect(unknown).toMatchObject({ sessions: 2 });
        // Crucially NOT dropped from the denominator: 'web' is 1 of 3, not 1 of 1.
        expect(stats.segments.find((s) => s.surface === 'web')!.percentage).toBeCloseTo(100 / 3, 5);
    });

    it('excludes sessions older than the window', async () => {
        await seed('web', MOVIE_ID, 5);
        await seed('web', MOVIE_ID, 200);

        const stats = await getSurfaceMix(sql, 90);

        expect(stats.totalSessions).toBe(1);
    });

    it('counts Live TV sessions across surfaces without splitting the surface buckets', async () => {
        // Live TV is a media_type, not a surface: a channel watched in the
        // browser is surface='web'. The partition must be additional
        // information, never a seventh bucket.
        await seed('web', CHANNEL_ID, 1);
        await seed('web', MOVIE_ID, 1);
        await seed('jellyfin_compat', CHANNEL_ID, 1);

        const stats = await getSurfaceMix(sql, 90);

        expect(stats.liveTvSessions).toBe(2);
        expect(stats.totalSessions).toBe(3);
        expect(stats.segments.find((s) => s.surface === 'web')!.sessions).toBe(2);
    });

    it('keeps a surface supplied later when a transcode stub created the row first', async () => {
        // transcode-jobs.queries.ts inserts a bare play_sessions row (id +
        // media/user/device only) and can win the race against the real
        // session create. Without the ON CONFLICT COALESCE, that row would
        // keep surface NULL forever — inflating 'unknown' on exactly the
        // transcode-heavy sessions. The required-parameter compile check
        // cannot catch this, because the stub is raw SQL.
        const stubId = '00000000-0000-0000-0000-0000000000b1';
        await sql`
            INSERT INTO play_sessions (id, media_id, user_id, device_id, ip_address, play_method)
            VALUES (${stubId}::uuid, ${MOVIE_ID}::uuid, ${userId}, 'dev', '127.0.0.1'::inet, 'direct')
        `;
        const [before] = await sql<{ surface: string | null }[]>`
            SELECT surface FROM play_sessions WHERE id = ${stubId}::uuid
        `;
        expect(before!.surface).toBeNull();

        await createPlaySession(sql, {
            surface: 'native_app',
            id: stubId,
            media_id: MOVIE_ID,
            user_id: userId,
            device_id: 'dev',
            ip_address: '127.0.0.1',
            play_method: 'direct',
            position_ms: 0,
        });

        const [after] = await sql<{ surface: string | null }[]>`
            SELECT surface FROM play_sessions WHERE id = ${stubId}::uuid
        `;
        expect(after!.surface).toBe('native_app');

        const stats = await getSurfaceMix(sql, 90);
        expect(stats.attributedSessions).toBe(1);
        expect(stats.segments).toEqual([
            expect.objectContaining({ surface: 'native_app', sessions: 1 }),
        ]);
    });

    it('returns a zeroed payload rather than throwing on an empty window', async () => {
        const stats = await getSurfaceMix(sql, 90);

        expect(stats).toMatchObject({
            segments: [],
            liveTvSessions: 0,
            totalSessions: 0,
            attributedSessions: 0,
            windowDays: 90,
        });
    });
});
