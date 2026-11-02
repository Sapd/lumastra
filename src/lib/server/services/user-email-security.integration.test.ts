// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getTestDb,
    closeTestDb,
    getTestDatabaseUrl,
} from '../../../../tests/integration/setup/test-database.js';
import { config } from '$lib/server/config.js';
import {
    adminCreateUser,
    adminSetUserEmail,
    getActiveUsersByEmail,
    getUserById,
} from '$lib/server/database/queries/users.queries.js';
import { resolveOrProvisionOidcUser } from './oidc.service.js';
import { oidcProviderKey, provisionUserWithIdentity } from './user-identity.service.js';
import type { OidcClaims } from './oidc-claims.js';

const sql = getTestDb();
const prefix = 'test_email_security_';
const issuer = 'https://email-security.example.test/';
const provider = oidcProviderKey(issuer);
function claims(email: string, verified = true): OidcClaims {
    return {
        issuer,
        subject: randomUUID(),
        email,
        emailVerified: verified,
        preferredUsername: prefix + randomUUID(),
        name: null,
        groups: [],
    };
}
async function native(email: string): Promise<string> {
    const id = await adminCreateUser(sql, {
        username: prefix + randomUUID(),
        passwordHash: 'known-native-password-hash',
        isAdmin: false,
        groups: [],
        email,
    });
    return id!;
}
beforeEach(() => {
    vi.spyOn(config, 'AUTH_OIDC_LINK_BY_VERIFIED_EMAIL', 'get').mockReturnValue(true);
    vi.spyOn(config, 'AUTH_OIDC_LINK_BY_USERNAME', 'get').mockReturnValue(false);
});
afterEach(async () => {
    vi.restoreAllMocks();
    await sql`DELETE FROM users WHERE username LIKE ${prefix + '%'}`;
});
afterAll(closeTestDb);

describe('email account-link security', () => {
    it('does not link a victim into a password account with an email predating admin provenance', async () => {
        const email = 'victim@example.test';
        const [victimTrap] = await sql`INSERT INTO users (username, email, password_hash)
            VALUES (${prefix + randomUUID()}, ${email}, 'attacker-knows-this') RETURNING id`;
        const result = await resolveOrProvisionOidcUser(sql, claims(email), {
            firstRunRequiresAdmin: false,
        });
        expect(result.userId).not.toBe(victimTrap.id);
        expect(result.linkType).toBe('provisioned');
        expect((await getUserById(sql, result.userId))?.email).toBeNull();
    });

    it('never stores an unverified IdP email, leaving it free for the real owner', async () => {
        const email = 'unverified@example.test';
        const attacker = await resolveOrProvisionOidcUser(sql, claims(email, false), {
            firstRunRequiresAdmin: false,
        });
        expect((await getUserById(sql, attacker.userId))?.email).toBeNull();
        const owner = await resolveOrProvisionOidcUser(sql, claims(email), {
            firstRunRequiresAdmin: false,
        });
        expect(owner.userId).not.toBe(attacker.userId);
        expect((await getUserById(sql, owner.userId))?.email).toBe(email);
    });

    it('normalizes verified provisioning emails and keeps login working on a unique-email conflict', async () => {
        const email = 'verified@example.test';
        vi.spyOn(config, 'AUTH_OIDC_LINK_BY_VERIFIED_EMAIL', 'get').mockReturnValue(false);
        const first = await resolveOrProvisionOidcUser(sql, claims(' Verified@Example.Test '), {
            firstRunRequiresAdmin: false,
        });
        expect((await getUserById(sql, first.userId))?.email).toBe(email);
        const second = await resolveOrProvisionOidcUser(sql, claims(email), {
            firstRunRequiresAdmin: false,
        });
        expect(second.userId).not.toBe(first.userId);
        expect((await getUserById(sql, second.userId))?.email).toBeNull();
    });

    it('matches both stored and incoming email with LOWER(BTRIM(email))', async () => {
        const id = await native('match@example.test');
        await sql`UPDATE users SET email = ' Match@Example.Test ' WHERE id = ${id}`;
        expect(await getActiveUsersByEmail(sql, 'MATCH@example.test')).toEqual([
            expect.objectContaining({ id }),
        ]);
        const result = await resolveOrProvisionOidcUser(sql, claims(' MATCH@example.test '), {
            firstRunRequiresAdmin: false,
        });
        expect(result).toMatchObject({ userId: id, linkType: 'linked-by-email' });
    });

    it('refuses email linking when that provider already has a different subject on the target', async () => {
        const email = 'recycled@example.test';
        const id = await native(email);
        await sql`INSERT INTO user_identities (provider, subject, user_id, last_login_at)
            VALUES (${provider}, 'previous-subject', ${id}, NOW())`;
        const result = await resolveOrProvisionOidcUser(sql, claims(email), {
            firstRunRequiresAdmin: false,
        });
        expect(result.userId).not.toBe(id);
        expect(result.linkType).toBe('provisioned');
        expect(
            await sql`SELECT subject FROM user_identities WHERE user_id = ${id} AND provider = ${provider}`,
        ).toEqual([expect.objectContaining({ subject: 'previous-subject' })]);
    });

    it('records admin email provenance on create/edit and removes it on clear', async () => {
        const id = await native('provenance@example.test');
        expect(
            (await sql`SELECT email_set_by_admin_at FROM users WHERE id = ${id}`)[0]
                .email_set_by_admin_at,
        ).toBeInstanceOf(Date);
        await adminSetUserEmail(sql, id, 'changed@example.test');
        expect(
            (await sql`SELECT email_set_by_admin_at FROM users WHERE id = ${id}`)[0]
                .email_set_by_admin_at,
        ).toBeInstanceOf(Date);
        await adminSetUserEmail(sql, id, '');
        expect(
            (await sql`SELECT email, email_set_by_admin_at FROM users WHERE id = ${id}`)[0],
        ).toMatchObject({ email: null, email_set_by_admin_at: null });
    });

    it('enforces normalized uniqueness for every users writer', async () => {
        await native('unique@example.test');
        await expect(
            sql`INSERT INTO users (username, email) VALUES (${prefix + randomUUID()}, ' Unique@Example.Test ')`,
        ).rejects.toMatchObject({
            code: '23505',
            constraint_name: 'users_email_normalized_unique_idx',
        });
    });

    it('keeps concurrent federated provisions working when both claim the same verified email', async () => {
        const workers = [
            postgres(getTestDatabaseUrl(), { max: 1 }),
            postgres(getTestDatabaseUrl(), { max: 1 }),
        ];
        try {
            const results = await Promise.all(
                workers.map((worker) =>
                    provisionUserWithIdentity(worker, {
                        baseUsername: prefix + randomUUID(),
                        isAdmin: false,
                        groups: [],
                        email: 'concurrent@example.test',
                        emailVerified: true,
                        identity: { provider, subject: randomUUID() },
                    }),
                ),
            );
            expect(new Set(results.map((result) => result.userId)).size).toBe(2);
            const rows =
                await sql`SELECT email FROM users WHERE id IN ${sql(results.map((result) => result.userId))}`;
            expect(rows.map((row) => row.email).sort()).toEqual(['concurrent@example.test', null]);
        } finally {
            await Promise.all(workers.map((worker) => worker.end()));
        }
    });
});
