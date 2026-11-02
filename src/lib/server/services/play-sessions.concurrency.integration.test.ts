// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/server/services/play-sessions.concurrency.integration.test.ts
//
// Proves H2: the per-user advisory lock in enforceStreamPolicy actually serializes
// concurrent session starts so the concurrent-stream cap cannot be exceeded by a
// race. Without the lock, SELECT ... FOR UPDATE only locks existing rows, so N
// simultaneous starts at the limit all read the same pre-insert count and all
// insert past the cap. This test fires N genuinely-concurrent transactions (each on
// its own pooled connection) and asserts the resulting ACTIVE session count never
// exceeds the policy limit.
//
// Run locally:
//   npm run test:integration src/lib/server/services/play-sessions.concurrency.integration.test.ts

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../tests/integration/fixtures/user.fixtures.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { enforceStreamPolicy } from '$lib/server/services/play-sessions.service.js';
import {
    createPlaySession,
    upsertStreamPolicy,
} from '$lib/server/database/queries/play-sessions.queries.js';
import { config } from '$lib/server/config.js';

const TEST_MEDIA_ID = '00000000-0000-4000-a000-0000000000c1';
const TEST_USER = generateTestUserId();

// The default policy is unlimited (DEFAULT_MAX_CONCURRENT_STREAMS = -1), so the test
// user gets its own policy row with this cap.
const LIMIT = 2;
const CONCURRENCY = 8; // comfortably above LIMIT, within the default pg pool (10)

/**
 * Mirrors startPlaySession's count-then-insert core in a single transaction:
 * enforceStreamPolicy (which holds the per-user advisory lock) then, if admitted,
 * createPlaySession. Distinct device_id per call so the same-device supersede in the
 * real path can't collapse them — each is a distinct concurrent stream.
 */
async function attemptStart(
    sql: postgres.Sql,
    userId: string,
    deviceId: string,
    sessionId: string,
): Promise<'admitted' | 'rejected'> {
    return withTx(sql, async (rawTx) => {
        const txSql = rawTx as unknown as postgres.Sql;
        const policyError = await enforceStreamPolicy(
            txSql,
            userId as never,
            userId, // policyKey — the per-user row upserted in beforeEach
            '127.0.0.1',
            'direct',
            { session_id: sessionId, device_id: deviceId, media_id: TEST_MEDIA_ID },
        );
        if (policyError) return 'rejected';
        await createPlaySession(txSql, {
            surface: 'web',
            id: sessionId,
            media_id: TEST_MEDIA_ID,
            user_id: userId as never,
            device_id: deviceId,
            ip_address: '127.0.0.1',
            play_method: 'direct',
            position_ms: 0,
        });
        return 'admitted';
    });
}

async function countActive(sql: postgres.Sql, userId: string): Promise<number> {
    const [row] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count
        FROM play_sessions
        WHERE user_id = ${userId} AND status IN ('ACTIVE', 'PAUSED')
    `;
    return parseInt(row?.count ?? '0', 10);
}

describe('startPlaySession concurrency (H2 advisory lock)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = await getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['play_sessions', 'users', 'user_profiles', 'media_items']);
        await sql`
            INSERT INTO media_items (id, title, media_type, status, runtime_seconds)
            VALUES (${TEST_MEDIA_ID}::uuid, 'Concurrency Test Movie', 'movie', 'active', 3600)
        `;
        await ensureTestUser(sql, TEST_USER);
        await upsertStreamPolicy(sql, TEST_USER, { max_concurrent_streams: LIMIT }, 'system');
    });

    it('never admits more than the configured limit under concurrent starts', async () => {
        expect(config.STREAM_LIMITS_ENFORCED).toBe(true);
        expect(LIMIT).toBeGreaterThan(0);

        const results = await Promise.all(
            Array.from({ length: CONCURRENCY }, (_, i) =>
                attemptStart(sql, TEST_USER, `dev-${i}`, `11111111-0000-4000-a000-00000000000${i}`),
            ),
        );

        const admitted = results.filter((r) => r === 'admitted').length;
        const activeRows = await countActive(sql, TEST_USER);

        // The core invariant: the cap is never exceeded, no matter the interleaving.
        expect(activeRows).toBeLessThanOrEqual(LIMIT);
        expect(admitted).toBeLessThanOrEqual(LIMIT);
        // And the limit is actually reached (the lock serializes, it doesn't starve).
        expect(activeRows).toBe(LIMIT);
        expect(admitted).toBe(LIMIT);
    });

    it('does not count native-Jellyfin / Subsonic mirror sessions toward the limit', async () => {
        // Fill the user with more than LIMIT external-mirror rows (source
        // 'jellyfin'/'subsonic') — these mirror playback on a separate server
        // Lumastra can neither enforce nor kill, so they must NOT consume a
        // stream slot. A fresh first-party start must still be admitted.
        for (let i = 0; i < LIMIT + 2; i++) {
            const source = i % 2 === 0 ? 'jellyfin' : 'subsonic';
            await sql`
                INSERT INTO play_sessions (
                    media_id, user_id, device_id, user_agent, client_name,
                    ip_address, play_method, position_ms, status, source,
                    source_session_id, last_seen_at, last_heartbeat_at
                ) VALUES (
                    ${TEST_MEDIA_ID}::uuid, ${TEST_USER}, ${`ext-dev-${i}`},
                    'External', 'External', '10.0.0.1'::inet, 'direct', 0, 'ACTIVE',
                    ${source}, ${`ext-sess-${i}`}, now(), now()
                )
            `;
        }

        const result = await attemptStart(
            sql,
            TEST_USER,
            'lumastra-dev',
            '44444444-0000-4000-a000-000000000001',
        );

        // Admitted despite LIMIT+2 active mirror rows — they don't count.
        expect(result).toBe('admitted');
    });

    // Prod 2026-08-13: a tab paused overnight kept heartbeating, so the
    // admission-time reap (which measured the PAUSED grace from
    // last_heartbeat_at, unlike the shared staleSessionCondition) never saw it
    // as stale. It plus one music session filled both default slots and every
    // new stream was refused — with no second viewer anywhere.
    it('admits past a paused-but-heartbeating session whose paused_at is beyond the grace', async () => {
        for (let i = 0; i < LIMIT; i++) {
            await sql`
                INSERT INTO play_sessions (
                    media_id, user_id, device_id, ip_address, play_method,
                    position_ms, status, paused_at, last_heartbeat_at, last_seen_at
                ) VALUES (
                    ${TEST_MEDIA_ID}::uuid, ${TEST_USER}, ${`ghost-dev-${i}`},
                    '10.0.0.1'::inet, 'direct', 0, 'PAUSED',
                    now() - INTERVAL '6 hours', now(), now()
                )
            `;
        }

        const result = await attemptStart(
            sql,
            TEST_USER,
            'fresh-dev',
            '55555555-0000-4000-a000-000000000001',
        );

        expect(result).toBe('admitted');
        const ghosts = await sql<{ status: string }[]>`
            SELECT status FROM play_sessions
            WHERE user_id = ${TEST_USER} AND device_id LIKE 'ghost-dev-%'
        `;
        expect(ghosts.every((row) => row.status === 'CRASHED')).toBe(true);
    });

    it('still refuses when a freshly paused session holds the slot', async () => {
        for (let i = 0; i < LIMIT; i++) {
            await sql`
                INSERT INTO play_sessions (
                    media_id, user_id, device_id, ip_address, play_method,
                    position_ms, status, paused_at, last_heartbeat_at, last_seen_at
                ) VALUES (
                    ${TEST_MEDIA_ID}::uuid, ${TEST_USER}, ${`paused-dev-${i}`},
                    '10.0.0.1'::inet, 'direct', 0, 'PAUSED',
                    now() - INTERVAL '2 minutes', now(), now()
                )
            `;
        }

        const result = await attemptStart(
            sql,
            TEST_USER,
            'fresh-dev',
            '66666666-0000-4000-a000-000000000001',
        );

        // A stream paused two minutes ago is someone's living-room TV — it keeps
        // its slot, and the caller gets the honest refusal.
        expect(result).toBe('rejected');
    });

    // A book paused for HOURS is not stale on its own — audiobooks are paused
    // for hours by design, and the ABS byte proxy only serves ACTIVE/PAUSED
    // rows, so reaping a genuinely-paused one 404s mid-book. What made this a
    // bug (prod, same class as the Lumastra ghost above) is that the player's
    // heartbeat used to keep pinging every 10s regardless of play state, which
    // kept last_seen_at fresh forever and meant a book paused overnight was
    // NEVER reaped, permanently squatting a slot. The predicate now measures
    // an audiobookshelf PAUSED row from paused_at (set once, at the pause
    // transition — see the queries-level tests for the direct proof), not
    // last_seen_at, mirroring the Lumastra case.
    it('reaps a paused audiobookshelf ghost even with a fresh last_seen_at', async () => {
        await sql`
            INSERT INTO play_sessions (
                media_id, user_id, device_id, ip_address, play_method,
                position_ms, status, source, source_session_id,
                paused_at, last_heartbeat_at, last_seen_at
            ) VALUES (
                ${TEST_MEDIA_ID}::uuid, ${TEST_USER}, 'abs-dev', '10.0.0.1'::inet,
                'direct', 0, 'PAUSED', 'audiobookshelf', 'abs-sess-1',
                now() - INTERVAL '6 hours', now() - INTERVAL '6 hours', now()
            )
        `;

        const result = await attemptStart(
            sql,
            TEST_USER,
            'fresh-dev',
            '77777777-0000-4000-a000-000000000001',
        );

        expect(result).toBe('admitted');
        const [book] = await sql<{ status: string }[]>`
            SELECT status FROM play_sessions
            WHERE user_id = ${TEST_USER} AND device_id = 'abs-dev'
        `;
        expect(book.status).toBe('CRASHED');
    });

    it('still grants a freshly paused audiobookshelf session its slot', async () => {
        for (let i = 0; i < LIMIT; i++) {
            await sql`
                INSERT INTO play_sessions (
                    media_id, user_id, device_id, ip_address, play_method,
                    position_ms, status, source, source_session_id,
                    paused_at, last_heartbeat_at, last_seen_at
                ) VALUES (
                    ${TEST_MEDIA_ID}::uuid, ${TEST_USER}, ${`abs-dev-fresh-${i}`}, '10.0.0.1'::inet,
                    'direct', 0, 'PAUSED', 'audiobookshelf', ${`abs-sess-fresh-${i}`},
                    now() - INTERVAL '2 minutes', now() - INTERVAL '2 minutes',
                    now() - INTERVAL '2 minutes'
                )
            `;
        }

        const result = await attemptStart(
            sql,
            TEST_USER,
            'second-dev',
            '88888888-0000-4000-a000-000000000001',
        );

        // A book paused two minutes ago is someone actually listening — it
        // keeps its slot, and the caller gets the honest refusal rather than
        // an admission bought by wrongly reaping a fresh pause.
        expect(result).toBe('rejected');
        const books = await sql<{ status: string }[]>`
            SELECT status FROM play_sessions
            WHERE user_id = ${TEST_USER} AND device_id LIKE 'abs-dev-fresh-%'
        `;
        expect(books.every((row) => row.status === 'PAUSED')).toBe(true);
    });

    it('holds the cap across repeated concurrent bursts', async () => {
        // Two back-to-back bursts — the second must still see the first burst's
        // committed rows through the lock and admit nothing.
        await Promise.all(
            Array.from({ length: CONCURRENCY }, (_, i) =>
                attemptStart(sql, TEST_USER, `a-${i}`, `22222222-0000-4000-a000-00000000000${i}`),
            ),
        );
        const secondBurst = await Promise.all(
            Array.from({ length: CONCURRENCY }, (_, i) =>
                attemptStart(sql, TEST_USER, `b-${i}`, `33333333-0000-4000-a000-00000000000${i}`),
            ),
        );

        expect(secondBurst.every((r) => r === 'rejected')).toBe(true);
        expect(await countActive(sql, TEST_USER)).toBe(LIMIT);
    });
});
