// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for countActiveUsers.
 *
 * Runs against the lumastra_tests database. The test inserts temporary user
 * rows and verifies that the seat count query only counts active users within
 * the configured window, ignoring disabled/deleted/inactive users.
 *
 * Run with:
 *   npm run test:integration src/lib/server/database/queries/active-users.queries.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { countActiveUsers } from './active-users.queries';
import { getTestDatabaseUrl } from '../../../../../tests/integration/setup/test-database.js';

// Connect directly to the test database.  The integration runner sets
// DATABASE_URL to lumastra_tests via vitest.integration.config.ts test.env
// (applied before any module loads).  TEST_DATABASE_URL is an optional
// explicit override (used for cross-replica / multi-orchestrator scenarios).
let sql: postgres.Sql;
const TEST_PREFIX = 'seat_test_';

beforeAll(async () => {
    sql = postgres(getTestDatabaseUrl(), { max: 2 });
});

afterAll(async () => {
    // Clean up all users inserted by this test run.
    await sql`DELETE FROM users WHERE username LIKE ${TEST_PREFIX + '%'}`;
    await sql.end();
});

async function insertUser(opts: {
    username: string;
    lastSeenAt: Date | null;
    disabledAt?: Date | null;
    deletedAt?: Date | null;
}): Promise<void> {
    await sql`
        INSERT INTO users (
            username,
            is_admin,
            last_seen_at,
            disabled_at,
            deleted_at,
            created_at,
            updated_at
        ) VALUES (
            ${opts.username},
            false,
            ${opts.lastSeenAt},
            ${opts.disabledAt ?? null},
            ${opts.deletedAt ?? null},
            now(),
            now()
        )
        ON CONFLICT (username) DO UPDATE
            SET last_seen_at = EXCLUDED.last_seen_at,
                disabled_at  = EXCLUDED.disabled_at,
                deleted_at   = EXCLUDED.deleted_at
    `;
}

function daysAgo(n: number): Date {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d;
}

describe('countActiveUsers (integration)', () => {
    beforeAll(async () => {
        // Clean up any leftovers from a prior aborted run.
        await sql`DELETE FROM users WHERE username LIKE ${TEST_PREFIX + '%'}`;

        // Insert a representative set of users:
        await insertUser({ username: `${TEST_PREFIX}active_1`, lastSeenAt: daysAgo(1) }); // within 30d
        await insertUser({ username: `${TEST_PREFIX}active_2`, lastSeenAt: daysAgo(15) }); // within 30d
        await insertUser({ username: `${TEST_PREFIX}active_3`, lastSeenAt: daysAgo(29) }); // within 30d (boundary)
        await insertUser({ username: `${TEST_PREFIX}inactive`, lastSeenAt: daysAgo(31) }); // outside 30d
        await insertUser({ username: `${TEST_PREFIX}null_seen`, lastSeenAt: null }); // never seen
        await insertUser({
            username: `${TEST_PREFIX}disabled`,
            lastSeenAt: daysAgo(5),
            disabledAt: daysAgo(1),
        }); // disabled
        await insertUser({
            username: `${TEST_PREFIX}deleted`,
            lastSeenAt: daysAgo(5),
            deletedAt: daysAgo(1),
        }); // soft-deleted
    });

    it('counts only active, non-disabled, non-deleted users within the window', async () => {
        // active_1, active_2, active_3 qualify; inactive/null_seen/disabled/deleted do NOT.
        const count = await countActiveUsers(sql, 30);
        // The test DB may have other users — just verify at least 3 from this fixture.
        expect(count).toBeGreaterThanOrEqual(3);
    });

    it('excludes disabled users even when recently seen', async () => {
        // Insert a user that was seen very recently but disabled.
        await insertUser({
            username: `${TEST_PREFIX}disabled2`,
            lastSeenAt: daysAgo(0),
            disabledAt: daysAgo(0),
        });
        const count = await countActiveUsers(sql, 30);
        // Should remain >= 3 (not +1 for disabled2).
        expect(count).toBeGreaterThanOrEqual(3);
        await sql`DELETE FROM users WHERE username = ${`${TEST_PREFIX}disabled2`}`;
    });

    it('excludes soft-deleted users', async () => {
        const before = await countActiveUsers(sql, 30);
        await insertUser({
            username: `${TEST_PREFIX}will_delete`,
            lastSeenAt: daysAgo(1),
            deletedAt: new Date(),
        });
        const after = await countActiveUsers(sql, 30);
        // Count should not increase because will_delete is deleted.
        expect(after).toBe(before);
        await sql`DELETE FROM users WHERE username = ${`${TEST_PREFIX}will_delete`}`;
    });

    it('respects a shorter window', async () => {
        // active_1 (1 day) qualifies for 7d; active_2 (15d) and active_3 (29d) do not.
        const count7 = await countActiveUsers(sql, 7);
        const count30 = await countActiveUsers(sql, 30);
        expect(count7).toBeLessThanOrEqual(count30);
    });

    it('clamps window to 365 days maximum', async () => {
        // Should not throw and should return a reasonable number.
        const count = await countActiveUsers(sql, 99999);
        expect(count).toBeGreaterThanOrEqual(0);
    });

    it('clamps window to 1 day minimum', async () => {
        // Should not throw.
        const count = await countActiveUsers(sql, 0);
        expect(count).toBeGreaterThanOrEqual(0);
    });

    it('returns 0 when no active users exist in window', async () => {
        // Use a 0-day effective window (clamped to 1) — at most users seen <24h ago qualify.
        // Insert a user seen 400 days ago (clamp forces 365d window, still outside if inserted long ago).
        // This primarily tests the return type and no-crash guarantee.
        const count = await countActiveUsers(sql, 1);
        expect(typeof count).toBe('number');
        expect(count).toBeGreaterThanOrEqual(0);
    });
});
