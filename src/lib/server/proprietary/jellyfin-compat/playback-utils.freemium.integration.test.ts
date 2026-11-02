// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * The free-tier /j stream cap against real play_sessions rows.
 *
 * The cap is per SERVER (two /j streams on the free tier; the cases below set
 * it explicitly). The unit tests mock the session query,
 * so they cannot show that the query really picks /j rows across users and
 * leaves web / native-app rows alone. This does, with sessions created the way
 * the routes create them (findOrCreateJellyfinSession for /j, createPlaySession
 * with surface 'web' for the web app).
 *
 * Only the entitlement (the cap) and the Valkey-backed play-token helpers are
 * mocked. The integration config runs files one at a time, and beforeEach
 * closes any live /j rows left by other files, so the server-wide count starts
 * from zero.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';

const h = vi.hoisted(() => ({ cap: 1 as number | null }));

vi.mock('$lib/server/licensing/entitlements', () => ({
    getEffectiveEntitlements: async () => ({ jellyfinMaxConcurrentStreams: h.cap }),
}));
vi.mock('./play-token', () => ({
    revokePlayTokenBySession: vi.fn(async () => {}),
    markStreamLimitBan: vi.fn(async () => {}),
    isStreamLimitBanned: vi.fn(async () => false),
}));

import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { createPlaySession } from '$lib/server/database/queries/play-sessions.queries.js';
import { isPolicyError } from '$lib/server/services/play-sessions.service.js';
import { enforceFreemiumStreamLimit, findOrCreateJellyfinSession } from './playback-utils.js';
import { streamCapReachedByOthers } from './stream-limit-notice.js';

describe('free-tier /j stream cap — per server (integration)', () => {
    let sql: postgres.Sql;
    const alice = randomUUID();
    const bob = randomUUID();
    const carol = randomUUID();
    const items = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

    async function startJ(userId: string, itemId: string): Promise<string> {
        const result = await findOrCreateJellyfinSession(sql, {
            userId: toUserId(userId),
            username: `fj_${userId.slice(0, 8)}`,
            itemId,
            positionMs: 0,
            ipAddress: '127.0.0.1',
        });
        if (isPolicyError(result)) throw new Error(`policy blocked: ${result.kind}`);
        return result.id;
    }

    async function startWeb(userId: string, itemId: string): Promise<string> {
        const row = await createPlaySession(sql, {
            surface: 'web',
            media_id: itemId,
            user_id: toUserId(userId),
            device_id: 'web-browser',
            ip_address: '127.0.0.1',
            play_method: 'direct',
            position_ms: 0,
        });
        return row.id;
    }

    /** Push a session's start back so it is past the 10s grace. */
    async function age(id: string, seconds: number): Promise<void> {
        await sql`
            UPDATE play_sessions
            SET started_at = now() - make_interval(secs => ${seconds})
            WHERE id = ${id}::uuid
        `;
    }

    async function status(id: string): Promise<string> {
        const [row] = await sql<{ status: string }[]>`
            SELECT status FROM play_sessions WHERE id = ${id}::uuid
        `;
        return row!.status;
    }

    beforeAll(async () => {
        sql = await getTestDb();
        for (const id of [alice, bob, carol]) {
            await sql`
                INSERT INTO users (id, username) VALUES (${id}::uuid, ${`fj_${id.slice(0, 8)}`})
                ON CONFLICT (id) DO NOTHING
            `;
        }
        for (const id of items) {
            await sql`
                INSERT INTO media_items (id, title, media_type, has_files)
                VALUES (${id}::uuid, 'Free-tier cap test item', 'movie', true)
                ON CONFLICT (id) DO NOTHING
            `;
        }
    });

    beforeEach(async () => {
        h.cap = 1;
        await sql`
            UPDATE play_sessions SET status = 'COMPLETED', stopped_at = now()
            WHERE status IN ('ACTIVE', 'PAUSED')
              AND (surface = 'jellyfin_compat' OR user_id IN (${alice}::uuid, ${bob}::uuid, ${carol}::uuid))
        `;
    });

    afterAll(async () => {
        await sql`DELETE FROM play_sessions WHERE user_id IN (${alice}::uuid, ${bob}::uuid, ${carol}::uuid)`;
        await sql`DELETE FROM user_devices WHERE user_id IN (${alice}::uuid, ${bob}::uuid, ${carol}::uuid)`;
        await sql`DELETE FROM media_items WHERE id = ANY(${items}::uuid[])`;
        await sql`DELETE FROM users WHERE id IN (${alice}::uuid, ${bob}::uuid, ${carol}::uuid)`;
        await closeTestDb();
    });

    it('two different users each start one /j stream: the second is kicked', async () => {
        const first = await startJ(alice, items[0]!);
        await age(first, 120);
        const second = await startJ(bob, items[1]!);
        await age(second, 30);

        expect(await enforceFreemiumStreamLimit(sql, alice as UserId, first, 0)).toBe(false);
        expect(await enforceFreemiumStreamLimit(sql, bob as UserId, second, 0)).toBe(true);
        expect(await status(first)).toBe('ACTIVE');
        expect(await status(second)).toBe('COMPLETED');
    });

    it('a web-app stream plus one /j stream: nothing is kicked', async () => {
        const web = await startWeb(alice, items[0]!);
        await age(web, 120);
        const j = await startJ(alice, items[1]!);
        await age(j, 30);

        expect(await enforceFreemiumStreamLimit(sql, alice as UserId, j, 0)).toBe(false);
        // Even if a caller asks about the web row, it is not a /j stream.
        expect(await enforceFreemiumStreamLimit(sql, alice as UserId, web, 0)).toBe(false);
        expect(await status(web)).toBe('ACTIVE');
        expect(await status(j)).toBe('ACTIVE');
    });

    it('licensed (cap null): two users on /j, nothing is kicked', async () => {
        h.cap = null;
        const first = await startJ(alice, items[0]!);
        await age(first, 120);
        const second = await startJ(bob, items[1]!);
        await age(second, 30);

        expect(await enforceFreemiumStreamLimit(sql, bob as UserId, second, 0)).toBe(false);
        expect(await status(second)).toBe('ACTIVE');
    });
    /** Make a session look like its client vanished: no progress report for `seconds`. */
    async function silence(id: string, seconds: number): Promise<void> {
        await sql`
            UPDATE play_sessions
            SET last_heartbeat_at = now() - make_interval(secs => ${seconds})
            WHERE id = ${id}::uuid
        `;
    }

    async function pause(id: string, pausedSecondsAgo: number): Promise<void> {
        await sql`
            UPDATE play_sessions
            SET status = 'PAUSED',
                paused_at = now() - make_interval(secs => ${pausedSecondsAgo}),
                last_heartbeat_at = now() - make_interval(secs => ${pausedSecondsAgo})
            WHERE id = ${id}::uuid
        `;
    }

    describe('playback start: who gets the limit clip', () => {
        it('cap not reached → real media', async () => {
            h.cap = 2;
            await startJ(alice, items[0]!);
            expect(await streamCapReachedByOthers(sql, toUserId(carol), items[2]!)).toBeNull();
        });

        it('cap reached by live sessions of other streams → clip', async () => {
            h.cap = 2;
            await startJ(alice, items[0]!);
            await startJ(bob, items[1]!);
            expect(await streamCapReachedByOthers(sql, toUserId(carol), items[2]!)).toBe(2);
            // The same user starting a different item is also "another" stream.
            expect(await streamCapReachedByOthers(sql, toUserId(alice), items[2]!)).toBe(2);
        });

        it('a stream that is already playing keeps its media when it re-asks', async () => {
            h.cap = 2;
            await startJ(alice, items[0]!);
            await startJ(bob, items[1]!);
            // Bob seeks / switches audio → PlaybackInfo for his own item again.
            expect(await streamCapReachedByOthers(sql, toUserId(bob), items[1]!)).toBeNull();
            // Someone ELSE asking for bob's item is not bob's stream.
            expect(await streamCapReachedByOthers(sql, toUserId(carol), items[1]!)).toBe(2);
        });

        it('a stale ACTIVE row (client gone >2 min, not yet reaped) does not count', async () => {
            h.cap = 2;
            await startJ(alice, items[0]!);
            const zombie = await startJ(bob, items[1]!);
            await silence(zombie, 3 * 60);
            // Still ACTIVE in the table — the reaper has not run — but not live.
            expect(await status(zombie)).toBe('ACTIVE');
            expect(await streamCapReachedByOthers(sql, toUserId(carol), items[2]!)).toBeNull();
        });

        it('a recently paused stream still holds its slot', async () => {
            h.cap = 2;
            await startJ(alice, items[0]!);
            const paused = await startJ(bob, items[1]!);
            await pause(paused, 5 * 60); // paused 5 min ago, no reports since
            expect(await streamCapReachedByOthers(sql, toUserId(carol), items[2]!)).toBe(2);
        });

        it('a stream paused past the 30-minute grace does not count', async () => {
            h.cap = 2;
            await startJ(alice, items[0]!);
            const abandoned = await startJ(bob, items[1]!);
            await pause(abandoned, 31 * 60);
            expect(await streamCapReachedByOthers(sql, toUserId(carol), items[2]!)).toBeNull();
        });

        it('licensed (cap null) → real media however many /j streams run', async () => {
            h.cap = null;
            await startJ(alice, items[0]!);
            await startJ(bob, items[1]!);
            await startJ(carol, items[3]!);
            expect(await streamCapReachedByOthers(sql, toUserId(carol), items[2]!)).toBeNull();
        });

        it('web / native-app streams never fill the /j cap', async () => {
            h.cap = 2;
            await startWeb(alice, items[0]!);
            await startWeb(bob, items[1]!);
            expect(await streamCapReachedByOthers(sql, toUserId(carol), items[2]!)).toBeNull();
        });

        it('race: two starts both pass the check, the teardown backstop kicks the newer', async () => {
            h.cap = 2;
            const first = await startJ(alice, items[0]!);
            await age(first, 300);
            // Bob and Carol ask for PlaybackInfo at the same moment: one slot
            // left, so both are told "real media".
            expect(await streamCapReachedByOthers(sql, toUserId(bob), items[1]!)).toBeNull();
            expect(await streamCapReachedByOthers(sql, toUserId(carol), items[2]!)).toBeNull();
            const bobs = await startJ(bob, items[1]!);
            await age(bobs, 60);
            const carols = await startJ(carol, items[2]!);
            await age(carols, 30);

            expect(await enforceFreemiumStreamLimit(sql, alice as UserId, first, 0)).toBe(false);
            expect(await enforceFreemiumStreamLimit(sql, bob as UserId, bobs, 0)).toBe(false);
            expect(await enforceFreemiumStreamLimit(sql, carol as UserId, carols, 0)).toBe(true);
            expect(await status(carols)).toBe('COMPLETED');
        });

        it('backstop ignores a zombie: a live newcomer behind a stale row is not kicked', async () => {
            h.cap = 1;
            const zombie = await startJ(alice, items[0]!);
            await age(zombie, 600);
            await silence(zombie, 3 * 60);
            const live = await startJ(bob, items[1]!);
            await age(live, 30);
            expect(await enforceFreemiumStreamLimit(sql, bob as UserId, live, 0)).toBe(false);
            expect(await status(live)).toBe('ACTIVE');
        });
    });
});
