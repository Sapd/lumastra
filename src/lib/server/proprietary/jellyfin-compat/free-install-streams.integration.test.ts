// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Guard: five concurrent /j streams on one server, no licence key, nothing is
 * kicked and nobody is shown a "stream limit" clip.
 *
 * Real play_sessions rows, real entitlements registry, real config. Only the
 * optional licensing module is replaced by an inert stand-in ("no key": no
 * provider ever vouches for the install) and the Valkey-backed play-token
 * helpers are stubbed.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';

vi.mock('$lib/server/proprietary/licensing/init', () => ({
    initProprietaryLicensing: () => {},
}));
vi.mock('./play-token', () => ({
    revokePlayTokenBySession: vi.fn(async () => {}),
    markStreamLimitBan: vi.fn(async () => {}),
    isStreamLimitBanned: vi.fn(async () => false),
}));

import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { isPolicyError } from '$lib/server/services/play-sessions.service.js';
import { enforceFreemiumStreamLimit, findOrCreateJellyfinSession } from './playback-utils.js';
import { streamCapReachedByOthers } from './stream-limit-notice.js';

describe('free install: five concurrent /j streams (integration)', () => {
    let sql: postgres.Sql;
    const users = Array.from({ length: 5 }, () => randomUUID());
    const items = Array.from({ length: 5 }, () => randomUUID());

    async function startJ(userId: string, itemId: string): Promise<string> {
        const result = await findOrCreateJellyfinSession(sql, {
            userId: toUserId(userId),
            username: `fi_${userId.slice(0, 8)}`,
            itemId,
            positionMs: 0,
            ipAddress: '127.0.0.1',
        });
        if (isPolicyError(result)) throw new Error(`policy blocked: ${result.kind}`);
        return result.id;
    }

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
        for (const id of users) {
            await sql`
                INSERT INTO users (id, username) VALUES (${id}::uuid, ${`fi_${id.slice(0, 8)}`})
                ON CONFLICT (id) DO NOTHING
            `;
        }
        for (const id of items) {
            await sql`
                INSERT INTO media_items (id, title, media_type, has_files)
                VALUES (${id}::uuid, 'Free install stream test item', 'movie', true)
                ON CONFLICT (id) DO NOTHING
            `;
        }
    });

    beforeEach(async () => {
        await sql`
            UPDATE play_sessions SET status = 'COMPLETED', stopped_at = now()
            WHERE status IN ('ACTIVE', 'PAUSED')
              AND (surface = 'jellyfin_compat' OR user_id = ANY(${users}::uuid[]))
        `;
    });

    afterAll(async () => {
        await sql`DELETE FROM play_sessions WHERE user_id = ANY(${users}::uuid[])`;
        await sql`DELETE FROM user_devices WHERE user_id = ANY(${users}::uuid[])`;
        await sql`DELETE FROM media_items WHERE id = ANY(${items}::uuid[])`;
        await sql`DELETE FROM users WHERE id = ANY(${users}::uuid[])`;
        await closeTestDb();
    });

    it('none of five concurrent streams is kicked, none gets a notice clip', async () => {
        const sessions: string[] = [];
        for (let i = 0; i < 5; i++) {
            const id = await startJ(users[i]!, items[i]!);
            // Well past any start grace, oldest first.
            await age(id, 600 - i * 60);
            sessions.push(id);
        }

        for (let i = 0; i < 5; i++) {
            expect(await enforceFreemiumStreamLimit(sql, users[i] as UserId, sessions[i]!, 0)).toBe(
                false,
            );
            expect(await streamCapReachedByOthers(sql, toUserId(users[i]!), items[i]!)).toBeNull();
        }
        for (const id of sessions) expect(await status(id)).toBe('ACTIVE');

        // A sixth user starting a sixth stream is not shown the clip either.
        const sixth = toUserId(randomUUID());
        expect(await streamCapReachedByOthers(sql, sixth, items[0]!)).toBeNull();
    });
});
