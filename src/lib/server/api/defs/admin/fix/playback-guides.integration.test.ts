// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `/admin/fix/why-transcode` reads two endpoints against play_sessions:
 *   - recent-plays scans a bounded window of the newest sessions, newest item first
 *   - playback-decision tells a session the planner recorded (plan_reasons set,
 *     even empty) from one it never saw (null), whose method is the app's claim
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';

vi.mock('$lib/server/database/connection.js', async () => {
    const { getTestDb: db } =
        await import('../../../../../../../tests/integration/setup/test-database.js');
    return { getAdminDb: () => db() };
});

import { def as recentDef } from './recent-plays.js';
import { def as decisionDef } from './playback-decision.js';
import { RecentPlaysSchema } from '$lib/components/admin/fix/recent-plays.schema.js';
import { PlaybackDecisionSchema } from '$lib/components/admin/fix/playback-decision.schema.js';

const TAG = `pbg${Date.now().toString(36)}`;
let sql: postgres.Sql;
let userId: string;

async function movie(): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, created_at, updated_at)
        VALUES (${id}::uuid, ${`${TAG} movie`}, 'movie', 'active', true, now(), now())
    `;
    return id;
}

async function play(mediaId: string, startedAt: Date, planReasons: string[] | null): Promise<void> {
    await sql`
        INSERT INTO play_sessions (media_id, user_id, device_id, ip_address, play_method, status, started_at, plan_reasons)
        VALUES (${mediaId}::uuid, ${userId}, ${TAG}, '127.0.0.1', 'direct', 'COMPLETED', ${startedAt},
                ${planReasons === null ? null : sql.array(planReasons)})
    `;
}

beforeAll(async () => {
    sql = getTestDb();
    [{ id: userId }] = await sql<[{ id: string }]>`
        INSERT INTO users (username, is_admin, admin_pinned, groups)
        VALUES (${TAG}, false, true, ${[]}::text[])
        RETURNING id
    `;
});

afterEach(async () => {
    await sql`DELETE FROM play_sessions WHERE device_id = ${TAG}`;
    await sql`DELETE FROM media_items WHERE title LIKE ${`${TAG}%`}`;
});

afterAll(async () => {
    await sql`DELETE FROM users WHERE username = ${TAG}`;
    await closeTestDb();
});

describe('playback guides (integration)', () => {
    it('recent-plays lists the newest items first, one row per item', async () => {
        const a = await movie();
        const b = await movie();
        const future = Date.now() + 86_400_000;
        await play(a, new Date(future), null);
        await play(b, new Date(future + 1000), null);
        await play(a, new Date(future + 2000), null);

        const resp = await recentDef.handlers.GET!({} as never, {} as never);
        const body = RecentPlaysSchema.parse(await (resp as Response).json());
        const ours = body.plays.filter((p) => p.mediaId === a || p.mediaId === b);
        expect(ours.map((p) => p.mediaId)).toEqual([a, b]);
    });

    it('playback-decision separates "no plan recorded" from "a plan with no reasons"', async () => {
        const id = await movie();
        await play(id, new Date(Date.now() - 2000), null);
        await play(id, new Date(Date.now() - 1000), []);

        const resp = await decisionDef.handlers.GET!(
            {} as never,
            { input: { query: { mediaId: id } } } as never,
        );
        const body = PlaybackDecisionSchema.parse(await (resp as Response).json());
        expect(body.sessions.map((s) => s.planRecorded)).toEqual([true, false]);
    });
});
