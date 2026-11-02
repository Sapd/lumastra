// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Two-connection concurrency proof for `ServiceTokenService
 * .clearForceNonAdminForUserAndCreator()` (fix-plan-5 Task 9 review round 1,
 * CRITICAL).
 *
 * The single-statement restore (carried C2) first shipped as a
 * `WITH candidates AS (SELECT ...) UPDATE service_tokens st ... FROM
 * candidates c` — closing the crash-atomicity gap the two-statement version
 * had, but opening a CONCURRENT-WRITER one: under READ COMMITTED, when this
 * statement's target row is locked by a concurrent `UPDATE` and must wait,
 * PostgreSQL's EvalPlanQual re-fetches only the ROW BEING UPDATED once the
 * lock is released — a JOINed/FROM-clause subquery (the CTE) is NOT
 * re-evaluated against the new row; it keeps the values it read BEFORE the
 * wait. A restore call whose CTE read a STALE `by_creator=false` could
 * silently overwrite a reason flag a concurrent, now-committed narrowing
 * call had just set to `true` — erasing that narrowing and returning a
 * demoted creator's impersonation token to admin (fails OPEN).
 *
 * The fix drops the CTE/JOIN: every SET/WHERE/RETURNING expression
 * references the target row's OWN columns directly (no other relation in
 * the query), which is the case EvalPlanQual handles correctly — a plain
 * single-table UPDATE always re-evaluates against the freshly-locked row.
 *
 * This file drives TWO independent Postgres connections (a manually-held
 * transaction via `sql.reserve()`, and the real `ServiceTokenService`'s own
 * pool) to force the exact interleaving the review reproduced, rather than
 * asserting on the SQL text.
 *
 * Run:
 *   TEST_DATABASE_URL=postgres://lumastra:lumastra@127.0.0.1:5432/lumastra_review5_fix_tests \
 *     npm run test:integration -- src/lib/server/oauth/service-token.narrow-restore-concurrency.integration.test.ts
 */

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import { toUserId } from '$lib/shared/user-id.js';
import { getServiceTokenService } from '$lib/server/oauth/service-token.service.js';

const serviceTokenService = getServiceTokenService();
const createdUsernames = new Set<string>();

async function insertUser(username: string): Promise<string> {
    const sql = getTestDb();
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO users (username, is_admin, admin_pinned, groups)
        VALUES (${username}, false, true, ${[]}::text[])
        RETURNING id
    `;
    createdUsernames.add(username);
    return row.id;
}

async function mintServiceToken(createdBy: string, actAsUser: string): Promise<number> {
    const created = await serviceTokenService.create({
        name: 'concurrency-race-token',
        createdBy,
        actAsUser: toUserId(actAsUser),
        scopes: ['admin'],
    });
    return created.id;
}

/** Seeds the row as already-narrowed with the given reason flags, bypassing
 * the normal narrowing method so the test controls the starting shape
 * exactly (mirrors the seam file's fixture-8 legacy-row technique). */
async function seedNarrowed(
    id: number,
    flags: { byTarget: boolean; byCreator: boolean },
): Promise<void> {
    const sql = getTestDb();
    await sql`
        UPDATE service_tokens
        SET force_non_admin = true,
            force_non_admin_narrowed_at = NOW(),
            force_non_admin_narrowed_by_target = ${flags.byTarget},
            force_non_admin_narrowed_by_creator = ${flags.byCreator}
        WHERE id = ${id}
    `;
}

async function getNarrowState(id: number): Promise<{
    force_non_admin: boolean;
    force_non_admin_narrowed_at: Date | null;
    force_non_admin_narrowed_by_target: boolean;
    force_non_admin_narrowed_by_creator: boolean;
}> {
    const sql = getTestDb();
    const [row] = await sql<
        Array<{
            force_non_admin: boolean;
            force_non_admin_narrowed_at: Date | null;
            force_non_admin_narrowed_by_target: boolean;
            force_non_admin_narrowed_by_creator: boolean;
        }>
    >`
        SELECT force_non_admin, force_non_admin_narrowed_at,
               force_non_admin_narrowed_by_target, force_non_admin_narrowed_by_creator
        FROM service_tokens WHERE id = ${id}
    `;
    return row;
}

/**
 * Polls `pg_stat_activity` for at least `minBlocked` backends blocked waiting
 * on a lock while querying `service_tokens`, so the test commits the
 * lock-holder only once the expected number of connections have genuinely
 * started waiting — avoiding a sleep-based race.
 *
 * FIX (security review 2026-09-23 final fix wave, M1): the double-restore
 * test below drives TWO concurrent restore calls and needs BOTH queued
 * behind the lock before it commits, to force real contention between them.
 * The old `blocked > 0` threshold was satisfied by just ONE of the two
 * connections blocking — the COMMIT could fire before the second connection
 * had even started its query, letting it run AFTER the lock was free with no
 * contention at all. That test therefore passed against BOTH the buggy CTE
 * restore (see `service-token.service.ts`'s `clearForceNonAdminForUserAndCreator`
 * doc comment for the EvalPlanQual bug) and the fixed single-table UPDATE —
 * it could not distinguish them. `datname = current_database()` additionally
 * scopes the count to THIS test database, so a concurrent test run against a
 * different database on the same shared Postgres instance can't inflate the
 * count and cause a false-early match.
 */
async function waitForBlockedWriter(
    sql: postgres.Sql,
    minBlocked = 1,
    timeoutMs = 5000,
): Promise<void> {
    const start = Date.now();
    for (;;) {
        const [row] = await sql<{ blocked: number }[]>`
            SELECT count(*)::int AS blocked
            FROM pg_stat_activity
            WHERE wait_event_type = 'Lock'
              AND pid <> pg_backend_pid()
              AND datname = current_database()
              AND query ILIKE '%service_tokens%'
        `;
        if (row.blocked >= minBlocked) return;
        if (Date.now() - start > timeoutMs) {
            throw new Error(
                `Timed out waiting for ${minBlocked} blocked writer(s) on service_tokens (saw ${row.blocked})`,
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

afterAll(async () => {
    const sql = getTestDb();
    const usernames = Array.from(createdUsernames);
    if (usernames.length > 0) {
        await sql`
            DELETE FROM service_tokens
            WHERE LOWER(created_by) = ANY(${usernames.map((u) => u.toLowerCase())}::text[])
               OR act_as_user IN (SELECT id FROM users WHERE username = ANY(${usernames}::text[]))
        `;
        await sql`DELETE FROM users WHERE username = ANY(${usernames}::text[])`;
    }
});

describe('ServiceTokenService.clearForceNonAdminForUserAndCreator — concurrent-writer safety', () => {
    it('a concurrent CREATOR narrowing, committed WHILE this TARGET restore is blocked, is not erased', async () => {
        const suffix = randomUUID().slice(0, 8);
        const creatorUsername = `itest_race_creator_${suffix}`;
        const targetUsername = `itest_race_target_${suffix}`;
        await insertUser(creatorUsername);
        const targetId = await insertUser(targetUsername);
        const tokenId = await mintServiceToken(creatorUsername, targetId);

        // Starting shape: narrowed via the TARGET relationship only —
        // matches the review's reproduction (by_target=true, by_creator=false).
        await seedNarrowed(tokenId, { byTarget: true, byCreator: false });

        // Session 1 (a manually-held transaction on its OWN connection):
        // simulate the narrowing method setting by_creator=true, WITHOUT
        // committing yet — holding the row lock.
        const reserved = await getTestDb().reserve();
        await reserved.unsafe('BEGIN');
        await reserved`
            UPDATE service_tokens
            SET force_non_admin_narrowed_by_creator = true
            WHERE id = ${tokenId}
        `;

        try {
            // Session 2: the REAL restore, for the TARGET relationship, via
            // the service's own (different) connection pool. This blocks on
            // session 1's row lock.
            const restorePromise = serviceTokenService.clearForceNonAdminForUserAndCreator(
                toUserId(targetId),
                targetUsername,
            );

            // Confirm session 2 is genuinely blocked before releasing the lock.
            await waitForBlockedWriter(getTestDb());

            // Session 1 commits — by_creator=true is now durable.
            await reserved.unsafe('COMMIT');

            await restorePromise;
        } finally {
            await reserved.release();
        }

        // The creator's narrowing must survive: still narrowed, by_creator
        // still true, by_target correctly cleared (this call's own
        // relationship), narrowed_at still set. The bug returned
        // by_creator=false (erased) and force_non_admin=false (fails open).
        const row = await getNarrowState(tokenId);
        expect(row.force_non_admin).toBe(true);
        expect(row.force_non_admin_narrowed_by_creator).toBe(true);
        expect(row.force_non_admin_narrowed_by_target).toBe(false);
        expect(row.force_non_admin_narrowed_at).not.toBeNull();
    }, 15000);

    it('a target restore and a creator restore racing on the SAME row both settle fully restored, not stranded', async () => {
        const suffix = randomUUID().slice(0, 8);
        const creatorUsername = `itest_race2_creator_${suffix}`;
        const targetUsername = `itest_race2_target_${suffix}`;
        const creatorId = await insertUser(creatorUsername);
        const targetId = await insertUser(targetUsername);
        const tokenId = await mintServiceToken(creatorUsername, targetId);

        // Narrowed by BOTH relationships — both parties are about to be
        // re-promoted concurrently.
        await seedNarrowed(tokenId, { byTarget: true, byCreator: true });

        // Hold the row locked (SELECT ... FOR UPDATE, no data change) so
        // both restore calls queue up and get released together, forcing
        // real contention rather than hoping two async calls happen to
        // overlap.
        const reserved = await getTestDb().reserve();
        await reserved.unsafe('BEGIN');
        await reserved`SELECT id FROM service_tokens WHERE id = ${tokenId} FOR UPDATE`;

        try {
            const targetRestore = serviceTokenService.clearForceNonAdminForUserAndCreator(
                toUserId(targetId),
                targetUsername,
            );
            const creatorRestore = serviceTokenService.clearForceNonAdminForUserAndCreator(
                toUserId(creatorId),
                creatorUsername,
            );

            // M1 fix: wait for BOTH connections to be genuinely queued behind
            // the lock — the whole point of this test is that they contend
            // with each other, which a threshold of 1 cannot guarantee (see
            // waitForBlockedWriter's doc comment).
            await waitForBlockedWriter(getTestDb(), 2);
            await reserved.unsafe('COMMIT');

            await Promise.all([targetRestore, creatorRestore]);
        } finally {
            await reserved.release();
        }

        const row = await getNarrowState(tokenId);
        expect(row.force_non_admin).toBe(false);
        expect(row.force_non_admin_narrowed_by_target).toBe(false);
        expect(row.force_non_admin_narrowed_by_creator).toBe(false);
        expect(row.force_non_admin_narrowed_at).toBeNull();
    }, 15000);
});
