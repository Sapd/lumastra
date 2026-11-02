// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the native-login session + password queries against a
 * real PostgreSQL database. Validates migration 16.42.0 (user_sessions table +
 * users.password_hash) and the SQL paths the auth flow depends on.
 *
 * Run: npm run test:integration src/lib/server/database/queries/user-sessions.queries.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { createHash, randomUUID } from 'node:crypto';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    createSession,
    findValidSessionWithUser,
    touchSession,
    revokeSession,
    revokeAllUserSessions,
    revokeAllUserSessionsExcept,
    listUserSessions,
    cleanupExpiredSessions,
    getAccountSignInFacts,
} from './user-sessions.queries.js';
import {
    adminExists,
    createNativeAdmin,
    getNativeLoginRecord,
    setUserPassword,
} from './users.queries.js';

const PREFIX = 'native_test_';
const h = (t: string) => createHash('sha256').update(t).digest('hex');

let sql: postgres.Sql;

async function insertUser(opts: {
    username: string;
    isAdmin?: boolean;
    groups?: string[];
}): Promise<string> {
    const rows = await sql<{ id: string }[]>`
        INSERT INTO users (username, is_admin, admin_pinned, groups, groups_updated_at)
        VALUES (${opts.username}, ${opts.isAdmin ?? false}, ${opts.isAdmin ?? false}, ${opts.groups ?? []}, NOW())
        RETURNING id
    `;
    return rows[0].id;
}

async function cleanup(): Promise<void> {
    await sql`DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE ${PREFIX + '%'})`;
    await sql`DELETE FROM users WHERE username LIKE ${PREFIX + '%'}`;
}

beforeAll(() => {
    sql = getTestDb();
});

afterAll(async () => {
    await cleanup();
    await closeTestDb();
});

beforeEach(async () => {
    await cleanup();
});

describe('user_sessions queries', () => {
    it('creates a session and validates it with joined user identity', async () => {
        const userId = await insertUser({
            username: PREFIX + 'alice',
            isAdmin: true,
            groups: ['admin'],
        });
        const token = 'lsess_' + randomUUID().replace(/-/g, '');
        const expiresAt = new Date(Date.now() + 60_000);

        await createSession(sql, { userId, tokenHash: h(token), expiresAt, ip: '1.2.3.4' });

        const row = await findValidSessionWithUser(sql, h(token));
        expect(row).not.toBeNull();
        expect(row?.user_id).toBe(userId);
        expect(row?.username).toBe(PREFIX + 'alice');
        expect(row?.groups).toEqual(['admin']);
        expect(row?.is_admin).toBe(true);
    });

    it('does not return an expired session', async () => {
        const userId = await insertUser({ username: PREFIX + 'bob' });
        const token = 'lsess_' + randomUUID().replace(/-/g, '');
        await createSession(sql, {
            userId,
            tokenHash: h(token),
            expiresAt: new Date(Date.now() - 1000),
        });
        expect(await findValidSessionWithUser(sql, h(token))).toBeNull();
    });

    it('revokes a single session', async () => {
        const userId = await insertUser({ username: PREFIX + 'carol' });
        const token = 'lsess_' + randomUUID().replace(/-/g, '');
        await createSession(sql, {
            userId,
            tokenHash: h(token),
            expiresAt: new Date(Date.now() + 60_000),
        });
        expect(await revokeSession(sql, h(token))).toBe(1);
        expect(await findValidSessionWithUser(sql, h(token))).toBeNull();
        // Idempotent: revoking again affects 0 rows.
        expect(await revokeSession(sql, h(token))).toBe(0);
    });

    it('revokes ALL sessions for a user (password change / logout-everywhere)', async () => {
        const userId = await insertUser({ username: PREFIX + 'dave' });
        const tokens = [1, 2, 3].map(() => 'lsess_' + randomUUID().replace(/-/g, ''));
        for (const t of tokens) {
            await createSession(sql, {
                userId,
                tokenHash: h(t),
                expiresAt: new Date(Date.now() + 60_000),
            });
        }
        expect((await listUserSessions(sql, userId)).length).toBe(3);
        const revoked = await revokeAllUserSessions(sql, userId);
        expect(revoked).toBe(3);
        expect((await listUserSessions(sql, userId)).length).toBe(0);
        for (const t of tokens) {
            expect(await findValidSessionWithUser(sql, h(t))).toBeNull();
        }
    });

    it('revokeAllUserSessionsExcept keeps the named session (password-change rotation)', async () => {
        const userId = await insertUser({ username: PREFIX + 'rota' });
        const keep = 'lsess_' + randomUUID().replace(/-/g, '');
        const others = [1, 2].map(() => 'lsess_' + randomUUID().replace(/-/g, ''));
        for (const t of [keep, ...others]) {
            await createSession(sql, {
                userId,
                tokenHash: h(t),
                expiresAt: new Date(Date.now() + 60_000),
            });
        }
        const revoked = await revokeAllUserSessionsExcept(sql, userId, h(keep));
        expect(revoked).toBe(2);
        // The kept session is still valid; the others are gone.
        expect(await findValidSessionWithUser(sql, h(keep))).not.toBeNull();
        for (const t of others) {
            expect(await findValidSessionWithUser(sql, h(t))).toBeNull();
        }
    });

    it('touchSession updates last_used_at', async () => {
        const userId = await insertUser({ username: PREFIX + 'erin' });
        const token = 'lsess_' + randomUUID().replace(/-/g, '');
        await createSession(sql, {
            userId,
            tokenHash: h(token),
            expiresAt: new Date(Date.now() + 60_000),
        });
        await touchSession(sql, h(token));
        const rows = await listUserSessions(sql, userId);
        expect(rows[0].last_used_at).not.toBeNull();
    });

    it('cleanupExpiredSessions removes expired rows', async () => {
        const userId = await insertUser({ username: PREFIX + 'frank' });
        const expiredToken = 'lsess_' + randomUUID().replace(/-/g, '');
        const liveToken = 'lsess_' + randomUUID().replace(/-/g, '');
        await createSession(sql, {
            userId,
            tokenHash: h(expiredToken),
            expiresAt: new Date(Date.now() - 1000),
        });
        await createSession(sql, {
            userId,
            tokenHash: h(liveToken),
            expiresAt: new Date(Date.now() + 60_000),
        });
        const removed = await cleanupExpiredSessions(sql);
        expect(removed).toBeGreaterThanOrEqual(1);
        // The live one survives.
        expect(await findValidSessionWithUser(sql, h(liveToken))).not.toBeNull();
    });

    it('cascade-deletes sessions when the user is deleted', async () => {
        const userId = await insertUser({ username: PREFIX + 'gail' });
        const token = 'lsess_' + randomUUID().replace(/-/g, '');
        await createSession(sql, {
            userId,
            tokenHash: h(token),
            expiresAt: new Date(Date.now() + 60_000),
        });
        await sql`DELETE FROM users WHERE id = ${userId}`;
        const rows = await sql`SELECT 1 FROM user_sessions WHERE user_id = ${userId}`;
        expect(rows.length).toBe(0);
    });
});

describe('native-login user queries', () => {
    it('setUserPassword + getNativeLoginRecord round-trip', async () => {
        const userId = await insertUser({ username: PREFIX + 'hank', groups: ['admin'] });
        const fakeHash = 'scrypt$N=65536,r=8,p=1$YWJj$ZGVm';
        expect(await setUserPassword(sql, userId, fakeHash)).toBe(true);

        const rec = await getNativeLoginRecord(sql, PREFIX + 'HANK'); // case-insensitive
        expect(rec).not.toBeNull();
        expect(rec?.id).toBe(userId);
        expect(rec?.password_hash).toBe(fakeHash);
    });

    it('getNativeLoginRecord returns null for unknown user', async () => {
        expect(await getNativeLoginRecord(sql, PREFIX + 'nobody')).toBeNull();
    });

    it('createNativeAdmin promotes a same-named NON-admin row during first-run', async () => {
        // Isolated in a rolled-back transaction so the "no admin exists anywhere"
        // precondition can be established without disturbing the shared test DB.
        await expect(
            sql.begin(async (tx) => {
                // The query modules accept a plain Sql; a TransactionSql is
                // runtime-compatible (same tagged-template API), so cast for typing.
                const txSql = tx as unknown as postgres.Sql;
                await txSql`DELETE FROM users WHERE is_admin = true`; // rolled back
                // C5 follow-up (fix round 1): adminExists()/createNativeAdmin()'s
                // in-lock re-check now also has a `users.groups` term (S-C5b) —
                // a leftover `groups ∋ admin` row from another test/run in this
                // shared DB (the DELETE above only targets is_admin=true rows)
                // would make the in-lock NOT EXISTS see "an admin exists" and
                // refuse the promotion below, breaking this test's "no admin
                // exists anywhere" precondition. Also rolled back.
                await txSql`UPDATE users SET groups = NULL`;
                // The gate's in-app terms too: a leftover membership in an
                // admin-capability group (the seeded `admins`) or in a group
                // named per ADMIN_GROUPS reads as "an admin exists" and refuses
                // the promotion. Rolled back.
                await txSql`DELETE FROM user_access_groups`;
                // Setup lock (S-C5c-2): a lock row left by another file would
                // make the gate say "set up" and refuse the promotion. Rolled back.
                await txSql`DELETE FROM setup_lock`;
                const rows = await txSql<{ id: string }[]>`
                    INSERT INTO users (username, is_admin, admin_pinned, groups, groups_updated_at)
                    VALUES (${PREFIX + 'promote'}, false, false, ${[]}, NOW())
                    RETURNING id
                `;
                const existingId = rows[0].id;

                const id = await createNativeAdmin(txSql, {
                    username: PREFIX + 'promote',
                    passwordHash: 'scrypt$N=65536,r=8,p=1$YWJj$ZGVm',
                    groups: ['admin'],
                    adminGroupNames: ['admin'],
                });
                expect(id).toBe(existingId); // same row, promoted in place
                const rec = await getNativeLoginRecord(txSql, PREFIX + 'promote');
                expect(rec?.is_admin).toBe(true);
                expect(rec?.password_hash).toBe('scrypt$N=65536,r=8,p=1$YWJj$ZGVm');

                throw new Error('__rollback__');
            }),
        ).rejects.toThrow('__rollback__');
    });

    it('createNativeAdmin refuses when an admin already exists (race guard)', async () => {
        // Ensure at least one admin exists.
        await insertUser({ username: PREFIX + 'existing_admin', isAdmin: true, groups: ['admin'] });
        expect(await adminExists(sql, ['admin'])).toBe(true);

        const id = await createNativeAdmin(sql, {
            username: PREFIX + 'second_admin',
            passwordHash: 'scrypt$N=65536,r=8,p=1$YWJj$ZGVm',
            groups: ['admin'],
            adminGroupNames: ['admin'],
        });
        expect(id).toBeNull();
    });

    // -------------------------------------------------------------------------
    // Fix round 4: createNativeAdmin()'s in-lock re-check used to be the bare
    // column check `WHERE is_admin = true` — narrower than adminExists()'s own
    // (fix round 3) broadened predicate. An in-app-only admin (an access group
    // carrying the `admin` capability, no `is_admin` column set anywhere) would
    // make the OUTER adminExists() check in completeNativeSetup() refuse in the
    // common case, but the re-check inside createNativeAdmin's atomic insert
    // would still find its narrower NOT EXISTS true and mint a second admin
    // under the advisory lock. The re-check now mirrors adminExists()'s exact
    // predicate.
    // -------------------------------------------------------------------------
    it('createNativeAdmin refuses when only an in-app-only admin exists (no is_admin column set anywhere)', async () => {
        // This test's claim is specifically about the absence of a column
        // admin, so neutralize any is_admin=true rows left by OTHER test
        // files sharing this DB (this file's own `cleanup()` only scopes to
        // its own username prefix) -- same defensive reset pattern used by
        // access-control.service.integration.test.ts's own admin-count tests.
        // C5 follow-up (fix round 1): also clear `groups` -- adminExists()/
        // createNativeAdmin() now have a `users.groups` term (S-C5b), so a
        // leftover `groups ∋ admin` row would widen this test's "no admin
        // anywhere except the in-app fixture below" precondition too.
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        // Setup lock (S-C5c-2): a leftover lock row would refuse the rogue
        // admin on its own and make this test pass without the in-app term.
        await sql`DELETE FROM setup_lock`;
        const groupName = PREFIX + 'inapp_admin_cohort';
        const [{ id: groupId }] = await sql<{ id: string }[]>`
            INSERT INTO access_groups (name, display_name, description, is_system)
            VALUES (${groupName}, ${groupName}, NULL, FALSE)
            RETURNING id
        `;
        try {
            await sql`
                INSERT INTO access_group_capabilities (group_id, capability)
                VALUES (${groupId}::uuid, 'admin')
            `;
            const userId = await insertUser({ username: PREFIX + 'inapp_admin', isAdmin: false });
            await sql`
                INSERT INTO user_access_groups (group_id, user_id, assigned_by)
                VALUES (${groupId}::uuid, ${userId}::uuid, NULL)
            `;

            // This admin's own row has no is_admin column set -- the OLD
            // column-only re-check would have missed them entirely. (Not
            // asserting a global is_admin=true count here: this DB is shared
            // across test files/runs and may hold unrelated admin rows.)
            const ownRow = await sql<{ is_admin: boolean }[]>`
                SELECT is_admin FROM users WHERE id = ${userId}::uuid
            `;
            expect(ownRow[0].is_admin).toBe(false);
            expect(await adminExists(sql, ['admin'])).toBe(true);

            const id = await createNativeAdmin(sql, {
                username: PREFIX + 'rogue',
                passwordHash: 'scrypt$N=65536,r=8,p=1$YWJj$ZGVm',
                groups: ['admin'],
                adminGroupNames: ['admin'],
            });
            expect(id).toBeNull();
        } finally {
            await sql`DELETE FROM user_access_groups WHERE group_id = ${groupId}::uuid`;
            await sql`DELETE FROM access_groups WHERE id = ${groupId}::uuid`;
        }
    });
});

describe('getAccountSignInFacts', () => {
    it('tells an OIDC session from a password login, scoped to the session owner', async () => {
        const oidcUser = await insertUser({ username: PREFIX + 'sso' });
        const pwUser = await insertUser({ username: PREFIX + 'pw' });
        await setUserPassword(sql, pwUser, 'argon2-hash-placeholder');
        const expiresAt = new Date(Date.now() + 60_000);
        const oidcSession = await createSession(sql, {
            userId: oidcUser,
            tokenHash: h('oidc-' + randomUUID()),
            expiresAt,
            oidcIss: 'https://dex.example',
            oidcSub: 'sub-1',
        });
        const pwSession = await createSession(sql, {
            userId: pwUser,
            tokenHash: h('pw-' + randomUUID()),
            expiresAt,
        });

        expect(await getAccountSignInFacts(sql, oidcUser, oidcSession)).toEqual({
            hasPassword: false,
            sessionIsOidc: true,
        });
        expect(await getAccountSignInFacts(sql, pwUser, pwSession)).toEqual({
            hasPassword: true,
            sessionIsOidc: false,
        });
        // Another user's OIDC session never counts for this user.
        expect((await getAccountSignInFacts(sql, pwUser, oidcSession))?.sessionIsOidc).toBe(false);
        // Non-session request (forward auth, token).
        expect(await getAccountSignInFacts(sql, oidcUser, null)).toEqual({
            hasPassword: false,
            sessionIsOidc: false,
        });
        expect(await getAccountSignInFacts(sql, randomUUID(), null)).toBeNull();
    });
});
