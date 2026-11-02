// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real-PG seam tests for the plugin-login group re-sync (security review 7,
 * the plugin admin-assert cohort): a RETURNING login for an auth-provider
 * plugin identity now rewrites `users.groups` from the groups the provider
 * reported for THIS login, then applies the Formula-A admin transition that
 * follows (`plugin-auth-group-sync.ts`'s `syncPluginLoginGroups`).
 *
 * Drives `resolvePluginIdentity` (`plugin-auth.service.ts`) with the REAL
 * deps `plugin-auth-session.ts` wires it with — `resolveUserIdByIdentity` /
 * `provisionUserWithIdentity` (`user-identity.service.ts`), `anAdminExists:
 * (s) => adminExists(s, config.ADMIN_GROUPS)`, and `syncReturningIdentityGroups:
 * syncPluginLoginGroups` — against a real Postgres. `AUTH_PLUGIN_PROVIDERS`,
 * `AUTH_PLUGIN_PROVISION`, `AUTH_PLUGIN_ADMIN_ASSERT` and `ADMIN_GROUPS` are
 * spied on the `config` getters (mutating `process.env` after module load does
 * not reach these).
 *
 * The setup gate (`adminExists`) is a whole-table EXISTS, so a leftover admin
 * row or `setup_lock` row from an earlier test — or from this session's own
 * ambient dev config — makes "no admin" / "unlocked" assertions meaningless.
 * Every test resets `users`, `user_access_groups`/`access_groups`,
 * `user_identities` for this provider and `setup_lock` first, and the
 * admin-less/unlocked tests assert that precondition explicitly before acting.
 *
 * Run:
 *   TEST_DATABASE_URL=... npm run test:integration -- \
 *     src/lib/server/services/plugin-auth.group-resync.integration.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import type { AuthProviderIdentity } from '@sapd/lumastra-plugin-sdk';

import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { config } from '$lib/server/config.js';
import { resolvePluginIdentity, type PluginAuthDeps } from './plugin-auth.service.js';
import { syncPluginLoginGroups } from './plugin-auth-group-sync.js';
import { resolveUserIdByIdentity, provisionUserWithIdentity } from './user-identity.service.js';
import {
    adminExists,
    isSetupLocked,
    setIsAdmin,
} from '$lib/server/database/queries/users.queries.js';
import { countEffectiveAdmins } from '$lib/server/database/queries/access-groups.queries.js';
import { resolveOwnerAdminStatus } from '$lib/server/auth/resolve-owner-admin-status.js';

const PLUGIN_ID = 'ldap';
const PROVIDER = `plugin:${PLUGIN_ID}`;
const PREFIX = 'plugin_resync_';
const ADMIN_GROUP = 'Admins';

let sql: postgres.Sql;

function deps(): PluginAuthDeps {
    return {
        resolveUserIdByIdentity,
        provisionUserWithIdentity,
        anAdminExists: (s) => adminExists(s, config.ADMIN_GROUPS),
        syncReturningIdentityGroups: syncPluginLoginGroups,
    };
}

/** A fresh subject for this run, doubling as the username (so cleanup's LIKE matches it). */
function freshSubject(label: string): string {
    return `${PREFIX}${label}_${randomUUID().slice(0, 8)}`;
}

function identity(subject: string, groups: string[] | undefined): AuthProviderIdentity {
    return { subject, username: subject, groups };
}

async function userRow(
    id: string,
): Promise<{ is_admin: boolean; admin_pinned: boolean; groups: string[] | null } | null> {
    const rows = await sql<{ is_admin: boolean; admin_pinned: boolean; groups: string[] | null }[]>`
        SELECT is_admin, admin_pinned, groups FROM users WHERE id = ${id}
    `;
    return rows[0] ?? null;
}

async function usernameOf(id: string): Promise<string> {
    const rows = await sql<{ username: string }[]>`SELECT username FROM users WHERE id = ${id}`;
    return rows[0].username;
}

/** A seeded admin, independent of the plugin identity under test, that also completes setup. */
async function seedAdminAndLockSetup(label: string): Promise<string> {
    const username = `${PREFIX}${label}_${randomUUID().slice(0, 8)}`;
    const rows = await sql<{ id: string }[]>`
        INSERT INTO users (username, is_admin, admin_pinned, groups, updated_at)
        VALUES (${username}, true, true, ${[ADMIN_GROUP]}, NOW())
        RETURNING id
    `;
    const id = rows[0].id;
    await sql`
        INSERT INTO setup_lock (id, completed_by) VALUES (1, ${id}::uuid)
        ON CONFLICT (id) DO NOTHING
    `;
    return id;
}

/**
 * Reset every admin-existence source and this provider's identities/users to a
 * clean slate: no admin, no lock, no leftover plugin identity from a previous
 * test. Run at the START of every test (VACUOUS-GREEN TRAP: `adminExists()` is
 * a whole-table EXISTS, so a stray row anywhere makes "no admin" meaningless).
 */
async function resetAll(): Promise<void> {
    await sql`DELETE FROM user_access_groups`;
    await sql`DELETE FROM access_groups WHERE is_system = false`;
    await sql`DELETE FROM user_identities WHERE provider = ${PROVIDER}`;
    await sql`DELETE FROM users WHERE username LIKE ${PREFIX + '%'}`;
    await sql`UPDATE users SET is_admin = false, admin_pinned = false, groups = NULL`;
    await sql`DELETE FROM setup_lock`;
}

beforeAll(() => {
    sql = getTestDb();
});

beforeEach(async () => {
    vi.spyOn(config, 'ADMIN_GROUPS', 'get').mockReturnValue([ADMIN_GROUP]);
    vi.spyOn(config, 'AUTH_PLUGIN_PROVIDERS', 'get').mockReturnValue([PLUGIN_ID]);
    vi.spyOn(config, 'AUTH_PLUGIN_PROVISION', 'get').mockReturnValue([PLUGIN_ID]);
    vi.spyOn(config, 'AUTH_PLUGIN_ADMIN_ASSERT', 'get').mockReturnValue([PLUGIN_ID]);
    await resetAll();
});

afterAll(async () => {
    await resetAll();
    await closeTestDb();
});

describe('plugin login group re-sync — resolvePluginIdentity + syncPluginLoginGroups', () => {
    it('case 1: a returning login re-syncs groups and the admin verdict; an absent groups list leaves the row unchanged', async () => {
        await seedAdminAndLockSetup('seed1');
        expect(await adminExists(sql, config.ADMIN_GROUPS)).toBe(true);

        const subject = freshSubject('sub1');

        // First login: provisions (setup is complete, so the asserted admin
        // group is allowed to confer admin via users.groups).
        const first = await resolvePluginIdentity(
            sql,
            PLUGIN_ID,
            identity(subject, [ADMIN_GROUP]),
            deps(),
        );
        expect(first.kind).toBe('user');
        const userId = (first as { kind: 'user'; userId: string }).userId;
        const username = await usernameOf(userId);

        expect((await userRow(userId))?.groups).toEqual([ADMIN_GROUP]);
        expect((await resolveOwnerAdminStatus(sql, username))?.isAdmin).toBe(true);

        // Second login, same subject, groups now empty: re-sync demotes.
        const second = await resolvePluginIdentity(sql, PLUGIN_ID, identity(subject, []), deps());
        expect(second).toEqual({ kind: 'user', userId });
        expect((await userRow(userId))?.groups).toEqual([]);
        expect((await resolveOwnerAdminStatus(sql, username))?.isAdmin).toBe(false);

        // Third login, groups ABSENT (not reported): row stays exactly as the
        // second login left it.
        const third = await resolvePluginIdentity(
            sql,
            PLUGIN_ID,
            identity(subject, undefined),
            deps(),
        );
        expect(third).toEqual({ kind: 'user', userId });
        expect((await userRow(userId))?.groups).toEqual([]);
        expect((await resolveOwnerAdminStatus(sql, username))?.isAdmin).toBe(false);
    });

    it('case 2: setup stays locked when the plugin account is demoted as the last admin', async () => {
        const seededAdminId = await seedAdminAndLockSetup('seed2');

        const subject = freshSubject('sub2');
        const provisioned = await resolvePluginIdentity(
            sql,
            PLUGIN_ID,
            identity(subject, [ADMIN_GROUP]),
            deps(),
        );
        expect(provisioned.kind).toBe('user');
        const pluginUserId = (provisioned as { kind: 'user'; userId: string }).userId;
        const pluginUsername = await usernameOf(pluginUserId);
        expect((await resolveOwnerAdminStatus(sql, pluginUsername))?.isAdmin).toBe(true);

        // Remove the seeded admin: the plugin account is now the only admin.
        await sql`DELETE FROM users WHERE id = ${seededAdminId}`;
        expect(await countEffectiveAdmins(sql, config.ADMIN_GROUPS)).toBe(1);
        expect(await isSetupLocked(sql)).toBe(true);

        // Log in with empty groups: the group re-sync demotes the last admin.
        const demoted = await resolvePluginIdentity(sql, PLUGIN_ID, identity(subject, []), deps());
        expect(demoted).toEqual({ kind: 'user', userId: pluginUserId });

        expect((await resolveOwnerAdminStatus(sql, pluginUsername))?.isAdmin).toBe(false);
        expect(await countEffectiveAdmins(sql, config.ADMIN_GROUPS)).toBe(0);
        // Setup stays closed: the lock row survives the demotion, and the
        // broad setup gate still reports true because of it.
        expect(await isSetupLocked(sql)).toBe(true);
        expect(await adminExists(sql, config.ADMIN_GROUPS)).toBe(true);
    });

    it('case 3: no admin is minted before setup is complete, even under AUTH_PLUGIN_ADMIN_ASSERT', async () => {
        const seededAdminId = await seedAdminAndLockSetup('seed3');

        const subject = freshSubject('sub3');
        // Provision the plugin account as a non-admin while setup is complete.
        const provisioned = await resolvePluginIdentity(
            sql,
            PLUGIN_ID,
            identity(subject, []),
            deps(),
        );
        expect(provisioned.kind).toBe('user');
        const pluginUserId = (provisioned as { kind: 'user'; userId: string }).userId;
        const pluginUsername = await usernameOf(pluginUserId);
        expect((await resolveOwnerAdminStatus(sql, pluginUsername))?.isAdmin).toBe(false);

        // Remove every admin AND the setup lock so setup is genuinely incomplete.
        await sql`DELETE FROM users WHERE id = ${seededAdminId}`;
        await sql`DELETE FROM setup_lock`;
        expect(await adminExists(sql, config.ADMIN_GROUPS)).toBe(false);

        // A returning login asserting the admin group must not mint the first
        // admin, even with AUTH_PLUGIN_ADMIN_ASSERT covering this plugin.
        const returning = await resolvePluginIdentity(
            sql,
            PLUGIN_ID,
            identity(subject, [ADMIN_GROUP]),
            deps(),
        );
        expect(returning).toEqual({ kind: 'user', userId: pluginUserId });

        expect((await userRow(pluginUserId))?.groups).not.toContain(ADMIN_GROUP);
        expect((await resolveOwnerAdminStatus(sql, pluginUsername))?.isAdmin).toBe(false);
        expect(await adminExists(sql, config.ADMIN_GROUPS)).toBe(false);
        expect(await isSetupLocked(sql)).toBe(false);
    });

    it('case 4: a promotion while setup is complete writes the setup lock; without AUTH_PLUGIN_ADMIN_ASSERT the admin group is stripped', async () => {
        const seededAdminId = await seedAdminAndLockSetup('seed4');
        // Setup is complete via the seeded admin's is_admin column, independent
        // of the lock row — drop the lock row to prove the promotion path below
        // actually WRITES it, rather than finding it already there.
        await sql`DELETE FROM setup_lock`;
        expect(await adminExists(sql, config.ADMIN_GROUPS)).toBe(true);
        expect(await isSetupLocked(sql)).toBe(false);

        const subject = freshSubject('sub4');
        const provisioned = await resolvePluginIdentity(
            sql,
            PLUGIN_ID,
            identity(subject, []),
            deps(),
        );
        expect(provisioned.kind).toBe('user');
        const pluginUserId = (provisioned as { kind: 'user'; userId: string }).userId;
        const pluginUsername = await usernameOf(pluginUserId);
        expect((await resolveOwnerAdminStatus(sql, pluginUsername))?.isAdmin).toBe(false);

        // Promotion: AUTH_PLUGIN_ADMIN_ASSERT is on (beforeEach default).
        const promoted = await resolvePluginIdentity(
            sql,
            PLUGIN_ID,
            identity(subject, [ADMIN_GROUP]),
            deps(),
        );
        expect(promoted).toEqual({ kind: 'user', userId: pluginUserId });
        expect((await resolveOwnerAdminStatus(sql, pluginUsername))?.isAdmin).toBe(true);
        expect(await isSetupLocked(sql)).toBe(true);

        // Now flip AUTH_PLUGIN_ADMIN_ASSERT off: a reported admin group no
        // longer confers admin, but the other reported group still applies.
        vi.spyOn(config, 'AUTH_PLUGIN_ADMIN_ASSERT', 'get').mockReturnValue([]);
        const withoutAssert = await resolvePluginIdentity(
            sql,
            PLUGIN_ID,
            identity(subject, [ADMIN_GROUP, 'family']),
            deps(),
        );
        expect(withoutAssert).toEqual({ kind: 'user', userId: pluginUserId });
        expect((await userRow(pluginUserId))?.groups).toEqual(['family']);
        expect((await resolveOwnerAdminStatus(sql, pluginUsername))?.isAdmin).toBe(false);

        void seededAdminId; // kept alive only to hold the setup gate open throughout
    });

    it('case 5: a pin still wins over a reported admin group', async () => {
        await seedAdminAndLockSetup('seed5');

        const subject = freshSubject('sub5');
        const provisioned = await resolvePluginIdentity(
            sql,
            PLUGIN_ID,
            identity(subject, []),
            deps(),
        );
        expect(provisioned.kind).toBe('user');
        const pluginUserId = (provisioned as { kind: 'user'; userId: string }).userId;
        const pluginUsername = await usernameOf(pluginUserId);

        // Admin-pin the plugin account as explicitly non-admin.
        const pinned = await setIsAdmin(sql, pluginUsername, false);
        expect(pinned?.admin_pinned).toBe(true);

        // AUTH_PLUGIN_ADMIN_ASSERT is on (beforeEach default): the reported
        // admin group would confer admin if unpinned, but the pin wins.
        const outcome = await resolvePluginIdentity(
            sql,
            PLUGIN_ID,
            identity(subject, [ADMIN_GROUP]),
            deps(),
        );
        expect(outcome).toEqual({ kind: 'user', userId: pluginUserId });
        expect((await resolveOwnerAdminStatus(sql, pluginUsername))?.isAdmin).toBe(false);
    });
});
