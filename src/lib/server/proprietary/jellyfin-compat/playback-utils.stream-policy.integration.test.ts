// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * P5 (2026-09-16 security report): `findOrCreateJellyfinSession` keyed the
 * `enforceStreamPolicy` lookup on the user UUID with a comment claiming "no
 * username available on this path". Tracing every `/j` route that calls it
 * (Sessions/Playing, Sessions/Playing/Progress, Users/{id}/PlayingItems/{id},
 * Users/{id}/PlayingItems/{id}/Progress — all under
 * `src/routes/(proprietary)/j/`) showed each one destructures
 * `locals.user?.username` right next to `locals.user?.userId`, under the
 * SAME `if (!username || !userId) return unauthorized()` guard, but never
 * passed it into the params object. The comment was not a documented
 * limitation — it was stale/incorrect. See the task report for the full
 * per-route trace.
 *
 * This test proves the practical consequence: an admin per-user
 * `user_stream_policies` row (keyed on USERNAME — `user_stream_policies` is
 * an intentional TEXT exception, mig 16.46.0) must apply to a `/j` session
 * created this way. `user_id = username` is TEXT-keyed, so passing the UUID
 * as the policy key can only ever match the `__default__` fallback.
 *
 * Run locally:
 *   npm run test:integration src/lib/server/proprietary/jellyfin-compat/playback-utils.stream-policy.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { toUserId } from '$lib/shared/user-id.js';
import { findOrCreateJellyfinSession } from './playback-utils.js';
import { PlaySessionLifecycleService } from '$lib/server/services/play-session-lifecycle.service.js';
import * as queries from '$lib/server/database/queries/play-sessions.queries.js';
import { getMusicState } from '$lib/server/database/queries/music-tracking.queries.js';
import { isPolicyError } from '$lib/server/services/play-sessions.service.js';

describe('findOrCreateJellyfinSession — per-user stream policy (P5)', () => {
    let sql: postgres.Sql;
    const userId = randomUUID();
    const username = `p5_test_${userId.slice(0, 8)}`;
    const itemId = randomUUID();

    beforeAll(async () => {
        sql = await getTestDb();
        await sql`
            INSERT INTO users (id, username) VALUES (${userId}::uuid, ${username})
            ON CONFLICT (id) DO NOTHING
        `;
        // A per-user policy row keyed on the USERNAME (the TEXT exception —
        // user_stream_policies.user_id actually stores a username) that caps
        // concurrent streams at ZERO. With zero active sessions, the mint's
        // own COUNT(*) >= 0 comparison trips immediately — this isolates the
        // policy-key bug from having to actually race a second session.
        // user_stream_policies.user_id is keyed by USERNAME, not the UUID — intentional.

        await sql`
            INSERT INTO user_stream_policies (user_id, max_concurrent_streams)
            VALUES (${username}, 0)
            ON CONFLICT (user_id) DO UPDATE SET max_concurrent_streams = 0
        `;
        // FK target for play_sessions.media_id — only reached if the policy
        // check fails to block (the pre-fix bug), so this must exist for the
        // RED run to fail on the actual assertion rather than an FK error.
        await sql`
            INSERT INTO media_items (id, title, media_type, has_files)
            VALUES (${itemId}::uuid, 'P5 test item', 'movie', true)
            ON CONFLICT (id) DO NOTHING
        `;
    });

    afterAll(async () => {
        await sql`DELETE FROM play_sessions WHERE user_id = ${userId}::uuid`;
        // eslint-disable-next-line callback-safety/no-username-in-user-id-sql
        await sql`DELETE FROM user_stream_policies WHERE user_id = ${username}`;
        await sql`DELETE FROM user_devices WHERE user_id = ${userId}::uuid`;
        await sql`DELETE FROM media_items WHERE id = ${itemId}::uuid`;
        await sql`DELETE FROM users WHERE id = ${userId}::uuid`;
        await closeTestDb();
    });

    it('keeps Jellyfin Playing counts and completion listening totals idempotent', async () => {
        // /j Playing is a protocol playback signal, unlike a native preload allocation.
        // The adapter has no heard-time accumulator; retain its protocol timing.
        // eslint-disable-next-line callback-safety/no-username-in-user-id-sql
        await sql`UPDATE user_stream_policies SET max_concurrent_streams = 2 WHERE user_id = ${username}`;
        await sql`UPDATE media_items SET media_type = 'track' WHERE id = ${itemId}::uuid`;
        try {
            const input = {
                userId: toUserId(userId),
                username,
                itemId,
                positionMs: 0,
                ipAddress: '127.0.0.1',
            };
            const started = await findOrCreateJellyfinSession(sql, input);
            if (isPolicyError(started)) throw new Error(started.kind);
            expect(await findOrCreateJellyfinSession(sql, input)).toMatchObject({ id: started.id });
            expect((await getMusicState(sql, input.userId, itemId))?.play_count).toBe(1);
            const lifecycle = new PlaySessionLifecycleService({
                queries,
                getSql: () => sql,
                watchManager: { reportProgress: vi.fn(), markWatched: vi.fn() },
                watchHistoryService: { recordCompletedSession: vi.fn() },
                getMediaMetadata: async () => null,
            });
            await lifecycle.update(started.id, {
                status: 'ACTIVE',
                position_ms: 1000,
                event_seq: 1,
            });
            for (let retry = 0; retry < 2; retry++) {
                await lifecycle.update(started.id, {
                    status: 'COMPLETED',
                    position_ms: 2000,
                    event_seq: 2,
                    end_reason: 'completion',
                });
            }
            const state = await getMusicState(sql, input.userId, itemId);
            expect(state?.play_count).toBe(1);
            expect(Number(state?.total_listen_ms)).toBe(2000);
        } finally {
            // eslint-disable-next-line callback-safety/no-username-in-user-id-sql
            await sql`UPDATE user_stream_policies SET max_concurrent_streams = 0 WHERE user_id = ${username}`;
            await sql`UPDATE media_items SET media_type = 'movie' WHERE id = ${itemId}::uuid`;
        }
    });

    it('applies the admin-set per-user policy (max_concurrent_streams=0) to a /j-created session', async () => {
        const result = await findOrCreateJellyfinSession(sql, {
            userId: toUserId(userId),
            username,
            itemId,
            positionMs: 0,
            ipAddress: '127.0.0.1',
        });

        expect(isPolicyError(result)).toBe(true);
        if (isPolicyError(result)) {
            expect(result.kind).toBe('stream_limit_exceeded');
        }
    });
});
