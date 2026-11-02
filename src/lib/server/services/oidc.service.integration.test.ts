// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the OIDC account-resolution heart against a real DB.
 *
 * These exercise resolveOrProvisionOidcUser directly with hand-built verified
 * claims (no IdP / network needed — the discovery + token exchange is a separate
 * concern) and PROVE the account-takeover guard: a verified email links to an
 * existing account; an UNVERIFIED email never does.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi, afterEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    resolveOrProvisionOidcUser,
    OidcFirstUserNotAdminError,
    OidcAccountDisabledError,
} from './oidc.service.js';
import type { OidcClaims } from './oidc-claims.js';
import { config } from '$lib/server/config.js';
import { getPatService } from '$lib/server/oauth/pat.service.js';
import { toUserId } from '$lib/shared/user-id.js';
import {
    adminCreateUser,
    adminSetUserEmail,
    getUserById,
} from '$lib/server/database/queries/users.queries.js';
import { isUserAdmin } from '$lib/server/auth.js';

const PREFIX = 'test_oidc_';
const ISSUER = 'https://idp.test.example.com/';
// Use the ambient admin group (the dev .env sets a custom ADMIN_GROUPS) so the
// admin-derivation assertion holds regardless of the runtime's configured value.
const ADMIN_GROUP = config.ADMIN_GROUPS[0] ?? 'admin';

function claims(overrides: Partial<OidcClaims>): OidcClaims {
    return {
        issuer: ISSUER,
        subject: 'sub-default',
        email: null,
        emailVerified: false,
        preferredUsername: null,
        name: null,
        groups: [],
        ...overrides,
    };
}

async function seedUser(
    sql: postgres.Sql,
    username: string,
    opts: {
        email?: string | null;
        isAdmin?: boolean;
        adminPinned?: boolean;
        disabled?: boolean;
    } = {},
): Promise<string> {
    const rows = await sql<{ id: string }[]>`
        INSERT INTO users (username, is_admin, admin_pinned, email, disabled_at, updated_at)
        VALUES (
            ${username.toLowerCase()},
            ${opts.isAdmin ?? false},
            ${opts.adminPinned ?? (opts.isAdmin ? true : false)},
            ${opts.email ?? null},
            ${opts.disabled ? sql`NOW()` : sql`NULL`},
            NOW()
        )
        RETURNING id
    `;
    if (opts.email) await adminSetUserEmail(sql, rows[0].id, opts.email);
    return rows[0].id;
}

async function getForceNonAdmin(
    sql: postgres.Sql,
    patId: number,
): Promise<{ force_non_admin: boolean }> {
    const [row] = await sql<{ force_non_admin: boolean }[]>`
        SELECT force_non_admin FROM personal_access_tokens WHERE id = ${patId}
    `;
    return row;
}

describe('resolveOrProvisionOidcUser', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`DELETE FROM user_identities WHERE provider LIKE 'oidc:%'`;
        await sql`DELETE FROM users WHERE username LIKE ${PREFIX + '%'}`;
    });

    it('provisions a new user and derives+persists admin from the groups claim', async () => {
        const result = await resolveOrProvisionOidcUser(
            sql,
            claims({
                subject: 'sub-new',
                preferredUsername: `${PREFIX}newbie`,
                groups: [ADMIN_GROUP],
            }),
            { firstRunRequiresAdmin: false },
        );
        expect(result.linkType).toBe('provisioned');
        expect(result.username).toBe(`${PREFIX}newbie`);
        // admin is derived from ADMIN_GROUPS and persisted to the row
        expect(result.isAdmin).toBe(isUserAdmin([ADMIN_GROUP]));
        const row = await sql<{ is_admin: boolean }[]>`
            SELECT is_admin FROM users WHERE id = ${result.userId}
        `;
        expect(row[0].is_admin).toBe(result.isAdmin);
    });

    it('resolves the SAME user by (provider, sub) on a second login', async () => {
        const first = await resolveOrProvisionOidcUser(
            sql,
            claims({ subject: 'sub-stable', preferredUsername: `${PREFIX}stable` }),
            { firstRunRequiresAdmin: false },
        );
        const second = await resolveOrProvisionOidcUser(
            sql,
            claims({ subject: 'sub-stable', preferredUsername: `${PREFIX}ignored` }),
            { firstRunRequiresAdmin: false },
        );
        expect(second.userId).toBe(first.userId);
        expect(second.linkType).toBe('existing-identity');
        // The username is NOT changed by a later login (stable data key).
        expect(second.username).toBe(`${PREFIX}stable`);
    });

    it('links the first SSO login to a pre-created restricted native account by its admin-set email', async () => {
        vi.spyOn(config, 'AUTH_OIDC_LINK_BY_VERIFIED_EMAIL', 'get').mockReturnValue(true);
        vi.spyOn(config, 'AUTH_OIDC_LINK_BY_USERNAME', 'get').mockReturnValue(false);
        const username = `${PREFIX}anna`;
        const id = await adminCreateUser(sql, {
            username,
            passwordHash: 'test-hash',
            isAdmin: false,
            groups: [],
            email: ' Anna@Example.Test ',
        });
        await sql`UPDATE users SET max_age_rating = 12, age_rating_pinned = true WHERE id = ${id}`;
        const result = await resolveOrProvisionOidcUser(
            sql,
            claims({
                subject: 'sub-precreated',
                preferredUsername: username,
                email: 'anna@example.test',
                emailVerified: true,
            }),
            { firstRunRequiresAdmin: false },
        );
        expect(result).toMatchObject({
            userId: id,
            username,
            isAdmin: false,
            linkType: 'linked-by-email',
        });
        expect(await getUserById(sql, id!)).toMatchObject({
            max_age_rating: 12,
            age_rating_pinned: true,
            admin_pinned: true,
            is_admin: false,
        });
        expect(await sql`SELECT id FROM users WHERE username = ${username + '-2'}`).toHaveLength(0);
        const again = await resolveOrProvisionOidcUser(
            sql,
            claims({
                subject: 'sub-precreated',
                preferredUsername: username,
                email: 'anna@example.test',
                emailVerified: true,
            }),
            { firstRunRequiresAdmin: false },
        );
        expect(again).toMatchObject({ userId: id, linkType: 'existing-identity' });
        expect(await getUserById(sql, id!)).toMatchObject({ max_age_rating: 12, is_admin: false });
    });

    it('LINKS to an existing account on a VERIFIED matching email', async () => {
        const existingId = await seedUser(sql, `${PREFIX}alice`, {
            email: 'alice@corp.example',
        });
        const result = await resolveOrProvisionOidcUser(
            sql,
            claims({
                subject: 'sub-alice-oidc',
                email: 'Alice@Corp.Example',
                emailVerified: true,
            }),
            { firstRunRequiresAdmin: false },
        );
        expect(result.linkType).toBe('linked-by-email');
        expect(result.userId).toBe(existingId);
    });

    it('NEVER links on an UNVERIFIED email — provisions a new account (takeover guard)', async () => {
        const adminId = await seedUser(sql, `${PREFIX}admin`, {
            email: 'admin@corp.example',
            isAdmin: true,
        });
        const result = await resolveOrProvisionOidcUser(
            sql,
            claims({
                subject: 'sub-attacker',
                email: 'admin@corp.example', // same email as the admin...
                emailVerified: false, // ...but NOT verified
                preferredUsername: `${PREFIX}attacker`,
            }),
            { firstRunRequiresAdmin: false },
        );
        // Must NOT have taken over the admin account.
        expect(result.userId).not.toBe(adminId);
        expect(result.linkType).toBe('provisioned');
    });

    it('NEVER demotes a non-pinned admin via OIDC (promote-only; link preserves)', async () => {
        // A forward-auth-style admin: is_admin=true but NOT pinned, with an email.
        const adminId = await seedUser(sql, `${PREFIX}faadmin`, {
            email: 'faadmin@corp.example',
            isAdmin: true,
            adminPinned: false,
        });

        // First OIDC login links by verified email; groups carry NO admin.
        const linked = await resolveOrProvisionOidcUser(
            sql,
            claims({
                subject: 'sub-faadmin',
                email: 'faadmin@corp.example',
                emailVerified: true,
                groups: [],
            }),
            { firstRunRequiresAdmin: false },
        );
        expect(linked.linkType).toBe('linked-by-email');
        expect(linked.userId).toBe(adminId);
        expect(linked.isAdmin).toBe(true); // linking preserved admin
        let row = await sql<
            { is_admin: boolean }[]
        >`SELECT is_admin FROM users WHERE id = ${adminId}`;
        expect(row[0].is_admin).toBe(true);

        // Second login resolves via existing-identity; groups STILL lack admin →
        // promote-only sync must not demote.
        const second = await resolveOrProvisionOidcUser(
            sql,
            claims({ subject: 'sub-faadmin', groups: [] }),
            { firstRunRequiresAdmin: false },
        );
        expect(second.linkType).toBe('existing-identity');
        expect(second.isAdmin).toBe(true);
        row = await sql<{ is_admin: boolean }[]>`SELECT is_admin FROM users WHERE id = ${adminId}`;
        expect(row[0].is_admin).toBe(true);
    });

    it('X3: an OIDC re-promotion restores a previously-narrowed admin-scoped PAT', async () => {
        // security review 2026-09-23, final fix wave, X3: syncUserOnLogin()
        // used to discard upsertUser()'s return value entirely, so an OIDC
        // re-promotion never restored admin-scoped credentials narrowed by an
        // earlier (unrelated) demotion. A non-pinned user whose is_admin is
        // currently false, holding a PAT that is ALREADY narrowed
        // (force_non_admin=true, as any prior demotion path would leave it),
        // logs in via OIDC with groups that now grant admin — the promotion
        // must restore the PAT.
        const userId = await seedUser(sql, `${PREFIX}reproqmote`, {
            email: 'repromote@corp.example',
            isAdmin: false,
            adminPinned: false,
        });
        const pat = await getPatService().create({
            userId: toUserId(userId),
            name: 'seam-oidc-repromote',
            scopes: ['admin'],
            groups: [],
        });
        const narrowedCount = await getPatService().markAdminScopedForceNonAdminForUser(
            toUserId(userId),
        );
        expect(narrowedCount).toBe(1);

        // First OIDC login establishes the (provider, sub) identity; groups
        // carry no admin — user stays non-admin, PAT stays narrowed.
        const first = await resolveOrProvisionOidcUser(
            sql,
            claims({
                subject: 'sub-repromote',
                email: 'repromote@corp.example',
                emailVerified: true,
                groups: [],
            }),
            { firstRunRequiresAdmin: false },
        );
        expect(first.linkType).toBe('linked-by-email');
        expect(first.userId).toBe(userId);
        expect(first.isAdmin).toBe(false);
        let patRow = await sql<{ force_non_admin: boolean }[]>`
            SELECT force_non_admin FROM personal_access_tokens WHERE id = ${pat.id}
        `;
        expect(patRow[0].force_non_admin).toBe(true);

        // Second login (existing-identity path): groups NOW grant admin.
        const second = await resolveOrProvisionOidcUser(
            sql,
            claims({ subject: 'sub-repromote', groups: [ADMIN_GROUP] }),
            { firstRunRequiresAdmin: false },
        );
        expect(second.linkType).toBe('existing-identity');
        expect(second.isAdmin).toBe(true);

        patRow = await sql<{ force_non_admin: boolean }[]>`
            SELECT force_non_admin FROM personal_access_tokens WHERE id = ${pat.id}
        `;
        expect(patRow[0].force_non_admin).toBe(false);
    });

    it('X3 fix round 2 (refuted "structurally unreachable" claim): an unpinned admin-by-group user losing the IdP group on OIDC login narrows their PAT, even though the column stays true (promote-only)', async () => {
        // security review 2026-09-23, final fix wave, fix round 2: the round-1
        // fix decided the narrow/restore purely from upsertUser()'s
        // column-based demoted/promoted flags, which by this function's own
        // promote-only design can NEVER see a demotion. But syncUserGroups()
        // rewrites users.groups on every login, and for an UNPINNED user
        // Formula A does NOT read the column at all — it reads groups + in-app.
        // Losing the IdP admin group on an OIDC login IS therefore a real
        // Formula-A demotion, invisible to the column-based flags.
        const userId = await seedUser(sql, `${PREFIX}groupdemote`, {
            email: 'groupdemote@corp.example',
            isAdmin: true, // admin-by-group, NOT pinned
            adminPinned: false,
        });
        await sql`UPDATE users SET groups = ${[ADMIN_GROUP]} WHERE id = ${userId}::uuid`;
        const pat = await getPatService().create({
            userId: toUserId(userId),
            name: 'x3-oidc-groupdemote',
            scopes: ['admin'],
            groups: [],
        });
        expect((await getForceNonAdmin(sql, pat.id)).force_non_admin).toBe(false);

        // First login: verified-email LINK only (never calls syncUserOnLogin —
        // groups/admin are preserved as-is on a link, by design).
        const linked = await resolveOrProvisionOidcUser(
            sql,
            claims({
                subject: 'sub-groupdemote',
                email: 'groupdemote@corp.example',
                emailVerified: true,
                groups: [ADMIN_GROUP],
            }),
            { firstRunRequiresAdmin: false },
        );
        expect(linked.linkType).toBe('linked-by-email');
        expect(linked.userId).toBe(userId);

        // Second login (existing-identity -> syncUserOnLogin): groups NO
        // LONGER include the admin group. Formula A: true -> false. The
        // COLUMN, by design, never decreases from this call.
        const demoted = await resolveOrProvisionOidcUser(
            sql,
            claims({ subject: 'sub-groupdemote', groups: [] }),
            { firstRunRequiresAdmin: false },
        );
        expect(demoted.linkType).toBe('existing-identity');
        const afterDemote = await getForceNonAdmin(sql, pat.id);
        expect(afterDemote.force_non_admin).toBe(true); // THE FIX: narrowed.
        const rowAfterDemote = await sql<{ is_admin: boolean }[]>`
            SELECT is_admin FROM users WHERE id = ${userId}::uuid
        `;
        expect(rowAfterDemote[0].is_admin).toBe(true); // promote-only: column UNCHANGED.

        // Third login: the admin group is back. Formula A: false -> true.
        const promoted = await resolveOrProvisionOidcUser(
            sql,
            claims({ subject: 'sub-groupdemote', groups: [ADMIN_GROUP] }),
            { firstRunRequiresAdmin: false },
        );
        expect(promoted.linkType).toBe('existing-identity');
        const afterPromote = await getForceNonAdmin(sql, pat.id);
        expect(afterPromote.force_non_admin).toBe(false); // THE FIX: restored.
    });

    it('prevents ambiguous matching emails at the database boundary', async () => {
        await seedUser(sql, `${PREFIX}dup1`, { email: 'shared@corp.example' });
        await expect(
            seedUser(sql, `${PREFIX}dup2`, { email: ' SHARED@corp.example ' }),
        ).rejects.toMatchObject({
            code: '23505',
            constraint_name: 'users_email_normalized_unique_idx',
        });
    });

    it('refuses a first-run OIDC user that is not in an admin group', async () => {
        await expect(
            resolveOrProvisionOidcUser(
                sql,
                claims({ subject: 'sub-nonadmin', preferredUsername: `${PREFIX}nonadmin` }),
                { firstRunRequiresAdmin: true },
            ),
        ).rejects.toBeInstanceOf(OidcFirstUserNotAdminError);
    });

    it('rejects login for a disabled linked account', async () => {
        // First provision, then disable, then attempt re-login by the same sub.
        const first = await resolveOrProvisionOidcUser(
            sql,
            claims({ subject: 'sub-dis', preferredUsername: `${PREFIX}dis` }),
            { firstRunRequiresAdmin: false },
        );
        await sql`UPDATE users SET disabled_at = NOW() WHERE id = ${first.userId}`;
        await expect(
            resolveOrProvisionOidcUser(
                sql,
                claims({ subject: 'sub-dis', preferredUsername: `${PREFIX}dis` }),
                { firstRunRequiresAdmin: false },
            ),
        ).rejects.toBeInstanceOf(OidcAccountDisabledError);
    });

    describe('link-by-username (opt-in)', () => {
        afterEach(() => vi.restoreAllMocks());

        it('does NOT link by username when the flag is OFF (default) — provisions instead', async () => {
            const adminId = await seedUser(sql, `${PREFIX}natadmin`, {
                email: 'natadmin@corp.example',
                isAdmin: true,
            });
            // Attacker presents the admin's username; flag OFF → must NOT take over.
            const result = await resolveOrProvisionOidcUser(
                sql,
                claims({ subject: 'sub-uatk', preferredUsername: `${PREFIX}natadmin` }),
                { firstRunRequiresAdmin: false },
            );
            expect(result.linkType).toBe('provisioned');
            expect(result.userId).not.toBe(adminId);
            expect(result.username).toBe(`${PREFIX}natadmin-2`); // collision-suffixed
        });

        it('LINKS by username when the flag is ON (migration case)', async () => {
            vi.spyOn(config, 'AUTH_OIDC_LINK_BY_USERNAME', 'get').mockReturnValue(true);
            const existingId = await seedUser(sql, `${PREFIX}migrant`, {
                email: 'migrant@corp.example',
            });
            const result = await resolveOrProvisionOidcUser(
                sql,
                claims({ subject: 'sub-migrant', preferredUsername: `${PREFIX}migrant` }),
                { firstRunRequiresAdmin: false },
            );
            expect(result.linkType).toBe('linked-by-username');
            expect(result.userId).toBe(existingId);
        });

        it('never links by username to a DISABLED account even when ON', async () => {
            vi.spyOn(config, 'AUTH_OIDC_LINK_BY_USERNAME', 'get').mockReturnValue(true);
            const disabledId = await seedUser(sql, `${PREFIX}gone`, { disabled: true });
            const result = await resolveOrProvisionOidcUser(
                sql,
                claims({ subject: 'sub-gone', preferredUsername: `${PREFIX}gone` }),
                { firstRunRequiresAdmin: false },
            );
            expect(result.linkType).toBe('provisioned');
            expect(result.userId).not.toBe(disabledId);
        });
    });

    it('syncs groups to the user on provision', async () => {
        const result = await resolveOrProvisionOidcUser(
            sql,
            claims({
                subject: 'sub-groups',
                preferredUsername: `${PREFIX}grouped`,
                groups: ['admin', 'watchers'],
            }),
            { firstRunRequiresAdmin: false },
        );
        const row = await sql<{ groups: string[] }[]>`
            SELECT groups FROM users WHERE id = ${result.userId}
        `;
        expect(row[0].groups).toEqual(expect.arrayContaining(['admin', 'watchers']));
    });
});
