// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the user_identities federation table + the identity
 * service's transactional provisioning, against a real PostgreSQL database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    getIdentity,
    upsertIdentity,
    insertIdentityIfAbsent,
    getIdentitiesForUser,
} from './user-identities.queries.js';
import { getActiveUsersByEmail } from './users.queries.js';
import {
    provisionUserWithIdentity,
    resolveUserIdByIdentity,
    recordIdentityBestEffort,
    IdentityProvisionRaceError,
} from '../../services/user-identity.service.js';

const PREFIX = 'test_ident_';

async function makeUser(
    sql: postgres.Sql,
    username: string,
    opts: { email?: string | null; disabled?: boolean } = {},
): Promise<string> {
    const rows = await sql<{ id: string }[]>`
        INSERT INTO users (username, is_admin, email, disabled_at, updated_at)
        VALUES (
            ${username.toLowerCase()},
            false,
            ${opts.email ?? null},
            ${opts.disabled ? sql`NOW()` : sql`NULL`},
            NOW()
        )
        RETURNING id
    `;
    return rows[0].id;
}

describe('user_identities queries + provisioning', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        // identities cascade on user delete, but delete explicitly for any orphans
        await sql`DELETE FROM user_identities WHERE subject LIKE ${PREFIX + '%'} OR provider LIKE 'oidc:%'`;
        await sql`DELETE FROM users WHERE username LIKE ${PREFIX + '%'}`;
        // The reserved-username test below provisions from a literal `system`
        // base (not `${PREFIX}...`), since reservation only fires on the exact
        // reserved name — clean up its `system` / `system-2` rows too.
        await sql`DELETE FROM users WHERE username LIKE 'system%'`;
    });

    describe('getIdentity / upsertIdentity', () => {
        it('returns null for an unknown identity', async () => {
            expect(await getIdentity(sql, 'native', `${PREFIX}nobody`)).toBeNull();
        });

        it('inserts then resolves an identity, and never re-points user_id on conflict', async () => {
            const userA = await makeUser(sql, `${PREFIX}a`);
            const userB = await makeUser(sql, `${PREFIX}b`);
            const subject = `${PREFIX}sub1`;

            await upsertIdentity(sql, { provider: 'native', subject, userId: userA });
            let row = await getIdentity(sql, 'native', subject);
            expect(row?.user_id).toBe(userA);

            // A repeat "login" must refresh email/last_login but MUST NOT hijack the
            // link to a different user_id.
            await upsertIdentity(sql, {
                provider: 'native',
                subject,
                userId: userB,
                email: 'x@example.com',
                emailVerified: true,
            });
            row = await getIdentity(sql, 'native', subject);
            expect(row?.user_id).toBe(userA); // unchanged
            expect(row?.email).toBe('x@example.com');
            expect(row?.email_verified).toBe(true);
            expect(row?.last_login_at).not.toBeNull();
        });
    });

    describe('insertIdentityIfAbsent', () => {
        it('returns true on first insert, false when already present', async () => {
            const userA = await makeUser(sql, `${PREFIX}c`);
            const subject = `${PREFIX}sub2`;
            expect(
                await insertIdentityIfAbsent(sql, { provider: 'native', subject, userId: userA }),
            ).toBe(true);
            expect(
                await insertIdentityIfAbsent(sql, { provider: 'native', subject, userId: userA }),
            ).toBe(false);
        });
    });

    describe('getActiveUsersByEmail', () => {
        it('matches case-insensitively and excludes null-email and disabled users', async () => {
            await makeUser(sql, `${PREFIX}match`, { email: 'Found@Example.com' });
            await makeUser(sql, `${PREFIX}nomail`, { email: null });
            await makeUser(sql, `${PREFIX}disabled`, {
                email: 'disabled@example.com',
                disabled: true,
            });

            const matches = await getActiveUsersByEmail(sql, 'found@EXAMPLE.com');
            expect(matches).toHaveLength(1);
            expect(matches[0].username).toBe(`${PREFIX}match`);
            expect(await getActiveUsersByEmail(sql, 'disabled@example.com')).toEqual([]);
        });
    });

    describe('provisionUserWithIdentity', () => {
        it('creates a user + identity link and resolves it', async () => {
            const provider = 'oidc:deadbeef';
            const { userId, username } = await provisionUserWithIdentity(sql, {
                baseUsername: `${PREFIX}new`,
                isAdmin: true,
                groups: ['admin'],
                email: 'new@example.com',
                emailVerified: true,
                identity: { provider, subject: 'sub-new' },
            });
            expect(username).toBe(`${PREFIX}new`);

            const resolved = await resolveUserIdByIdentity(sql, provider, 'sub-new');
            expect(resolved).toBe(userId);

            const userRow = await sql<{ is_admin: boolean; groups: string[]; email: string }[]>`
                SELECT is_admin, groups, email FROM users WHERE id = ${userId}
            `;
            expect(userRow[0].is_admin).toBe(true);
            expect(userRow[0].groups).toContain('admin');
            expect(userRow[0].email).toBe('new@example.com');

            const idents = await getIdentitiesForUser(sql, userId);
            expect(idents).toHaveLength(1);
            expect(idents[0].email_verified).toBe(true);
        });

        it('collision-suffixes the username when the base is taken', async () => {
            await makeUser(sql, `${PREFIX}dup`);
            const { username } = await provisionUserWithIdentity(sql, {
                baseUsername: `${PREFIX}dup`,
                isAdmin: false,
                groups: [],
                identity: { provider: 'oidc:deadbeef', subject: 'sub-dup' },
            });
            expect(username).toBe(`${PREFIX}dup-2`);
        });

        it('never mints the reserved "system" username — treats it exactly like a collision', async () => {
            const { username } = await provisionUserWithIdentity(sql, {
                baseUsername: 'system',
                isAdmin: false,
                groups: [],
                identity: { provider: 'oidc:deadbeef', subject: 'sub-system-plugin' },
            });
            expect(username).toBe('system-2');

            const bare = await sql`SELECT 1 FROM users WHERE username = 'system'`;
            expect(bare).toHaveLength(0);
        });

        it('throws IdentityProvisionRaceError if the subject was linked concurrently', async () => {
            const provider = 'oidc:deadbeef';
            const subject = 'sub-race';
            // Pre-link the subject to a different user, simulating the race winner.
            const winner = await makeUser(sql, `${PREFIX}winner`);
            await insertIdentityIfAbsent(sql, { provider, subject, userId: winner });

            await expect(
                provisionUserWithIdentity(sql, {
                    baseUsername: `${PREFIX}loser`,
                    isAdmin: false,
                    groups: [],
                    identity: { provider, subject },
                }),
            ).rejects.toBeInstanceOf(IdentityProvisionRaceError);

            // The orphan user must have been rolled back.
            const orphan = await sql`SELECT 1 FROM users WHERE username = ${PREFIX + 'loser'}`;
            expect(orphan).toHaveLength(0);
        });
    });

    describe('recordIdentityBestEffort', () => {
        it('records an identity for an existing user', async () => {
            const userId = await makeUser(sql, `${PREFIX}rec`);
            const ok = await recordIdentityBestEffort(sql, {
                provider: 'forward_auth',
                subject: `${PREFIX}rec`,
                userId,
            });
            expect(ok).toBe(true);
            expect(await resolveUserIdByIdentity(sql, 'forward_auth', `${PREFIX}rec`)).toBe(userId);
        });
    });
});
