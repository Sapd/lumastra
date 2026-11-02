// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Last-admin guards agree with the runtime admin verdict (fix plan 6, deferred
 * Task 3 item).
 *
 * The guards in `admin-user.service.ts` (disable, delete, demote, unpin) and
 * `access-control.service.ts` (drop the admin capability, delete a group,
 * remove a member) refuse a change that would leave no effective admin. Who
 * counts as one must be decided by Formula A — the verdict every sign-in path
 * computes (`buildUserPermissions`): a pin is authoritative, otherwise an
 * ADMIN_GROUPS name match (`hasGroupPermission`) over the synced IdP groups plus
 * in-app group names, or an in-app `admin` capability. A guard that counts
 * someone Formula A calls a non-admin can let the real last admin go.
 *
 * Everything is real: PG, the services, the counts and the resolver. The only
 * stub is the `ADMIN_GROUPS` getter where a case needs a specific name.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import type postgres from 'postgres';
import postgresConnect from 'postgres';
import {
    getTestDb,
    closeTestDb,
    getTestDatabaseUrl,
} from '../../../../tests/integration/setup/test-database.js';
import {
    generateTestUserId,
    ensureTestUser,
    derivedUsername,
} from '../../../../tests/integration/fixtures/index.js';
import { config } from '$lib/server/config.js';
import { clearUserAccessCache } from '$lib/server/cache/user-access-cache.js';
import { resolveOwnerAdminStatusById } from '$lib/server/auth/resolve-owner-admin-status.js';
import {
    countEffectiveAdmins,
    insertAccessGroupCapabilities,
} from '$lib/server/database/queries/access-groups.queries.js';
import { setDisabled, setUserAdmin, deleteUser } from './admin-user.service.js';
import { addMember, removeMember } from './access-control.service.js';

/** Same string as `LAST_ADMIN_GUARD_LOCK_KEY` in access-groups.queries.ts. */
const GUARD_LOCK_KEY = 'lumastra:admin:last-admin-guard';
const ACTOR = { username: 'guard-test-actor' };

interface UserShape {
    isAdmin?: boolean;
    pinned?: boolean;
    groups?: string[] | null;
}

describe('last-admin guards use Formula A (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        // Nobody but this test's fixtures may be an admin by ANY axis.
        await sql`UPDATE users SET is_admin = false, admin_pinned = false, groups = NULL`;
        await sql`DELETE FROM user_access_groups`;
        await sql`DELETE FROM access_groups WHERE is_system = false`;
        clearUserAccessCache();
        // The local .env may name other admin groups; every case assumes 'admin'.
        vi.spyOn(config, 'ADMIN_GROUPS', 'get').mockReturnValue(['admin']);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        clearUserAccessCache();
    });

    async function makeUser(shape: UserShape = {}): Promise<{ id: string; username: string }> {
        const id = generateTestUserId();
        await ensureTestUser(sql, id);
        await sql`
            UPDATE users
            SET is_admin = ${shape.isAdmin ?? false},
                admin_pinned = ${shape.pinned ?? false},
                groups = ${shape.groups ?? null},
                disabled_at = NULL
            WHERE id = ${id}::uuid
        `;
        return { id, username: derivedUsername(id) };
    }

    /**
     * Inserted directly: `createAccessGroup` reserves names that collide with
     * ADMIN_GROUPS, and name-conferred admin groups are exactly those.
     */
    async function inAppGroup(name: string, withAdminCap: boolean): Promise<string> {
        const [{ id }] = await sql<{ id: string }[]>`
            INSERT INTO access_groups (name, display_name, description, is_system)
            VALUES (${name}, ${name}, NULL, FALSE)
            RETURNING id
        `;
        if (withAdminCap) {
            await insertAccessGroupCapabilities(sql, id, [{ capability: 'admin', value: null }]);
        }
        return id;
    }

    async function formulaA(userId: string): Promise<boolean> {
        const status = await resolveOwnerAdminStatusById(sql, userId);
        return status?.isAdmin === true;
    }

    function disable(username: string) {
        return setDisabled(sql, {
            targetUsername: username,
            disabled: true,
            actingUsername: ACTOR.username,
            actor: ACTOR,
        });
    }

    // ── RED before the fix: a phantom admin let the real last admin go ──────

    it('a PINNED non-admin in an admin-capability group is not an admin: disabling the only real admin is refused', async () => {
        const realAdmin = await makeUser({ isAdmin: true, pinned: true });
        const pinnedNonAdmin = await makeUser({ isAdmin: false, pinned: true });
        await addMember(sql, await inAppGroup('guard-cap-cohort', true), pinnedNonAdmin.id, null);

        // The runtime agrees: the pin wins over the in-app capability.
        expect(await formulaA(pinnedNonAdmin.id)).toBe(false);
        expect(await formulaA(realAdmin.id)).toBe(true);

        const res = await disable(realAdmin.username);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.status).toBe(409);
    });

    it('an in-app group name that only Postgres folds to ADMIN_GROUPS is not an admin source: removing the only real admin is refused', async () => {
        // Postgres LOWER('ΟΔΟΣ') = 'οδοσ'; JS lowercases it to 'οδος' (final
        // sigma), so Formula A does not match it against 'οδοσ'.
        vi.spyOn(config, 'ADMIN_GROUPS', 'get').mockReturnValue(['οδοσ']);
        const realAdmin = await makeUser({ isAdmin: true, pinned: true });
        const phantom = await makeUser();
        await addMember(sql, await inAppGroup('ΟΔΟΣ', false), phantom.id, null);
        expect(await formulaA(phantom.id)).toBe(false);

        const res = await deleteUser(sql, {
            targetUsername: realAdmin.username,
            actingUsername: ACTOR.username,
        });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.status).toBe(409);
    });

    it('an unpinned stale is_admin column with no admin groups is not an admin: demoting the only real admin is refused', async () => {
        const realAdmin = await makeUser({ isAdmin: true, pinned: true });
        const stale = await makeUser({ isAdmin: true, pinned: false, groups: ['viewers'] });
        expect(await formulaA(stale.id)).toBe(false);

        const res = await setUserAdmin(sql, {
            targetUsername: realAdmin.username,
            actingUsername: ACTOR.username,
            change: { kind: 'set', value: false },
            actor: ACTOR,
        });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.status).toBe(409);
    });

    it('the only admin, an IdP-groups admin whose column is stale false, cannot be disabled', async () => {
        const idpAdmin = await makeUser({ isAdmin: false, pinned: false, groups: ['admin'] });
        expect(await formulaA(idpAdmin.id)).toBe(true);

        const res = await disable(idpAdmin.username);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.status).toBe(409);
    });

    it('the pinned non-admin also does not satisfy the in-app remove-member guard', async () => {
        const groupId = await inAppGroup('guard-remove-cohort', true);
        const realAdmin = await makeUser();
        const pinnedNonAdmin = await makeUser({ isAdmin: false, pinned: true });
        await addMember(sql, groupId, realAdmin.id, null);
        await addMember(sql, groupId, pinnedNonAdmin.id, null);
        expect(await formulaA(realAdmin.id)).toBe(true);
        expect(await formulaA(pinnedNonAdmin.id)).toBe(false);

        const res = await removeMember(sql, groupId, realAdmin.id);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.status).toBe(409);
    });

    it('countEffectiveAdmins equals the number of users Formula A calls admin, over pin, fold and source shapes', async () => {
        // An in-app group following the age convention never joins the
        // effective group set, even when ADMIN_GROUPS names it.
        const ageName = `${config.AGE_RATING_GROUP_PREFIX}18`;
        vi.spyOn(config, 'ADMIN_GROUPS', 'get').mockReturnValue([
            'admin',
            'οδοσ',
            'idare',
            ageName,
        ]);
        const users = [
            await makeUser({ isAdmin: true, pinned: true }), // pinned admin
            await makeUser({ isAdmin: false, pinned: true, groups: ['admin'] }), // pin demotes
            await makeUser({ isAdmin: true, pinned: false }), // stale column, no groups
            await makeUser({ isAdmin: false, pinned: false, groups: ['ADMIN'] }), // IdP admin
            await makeUser({ groups: ['ΟΔΟΣ'] }), // PG folds to 'οδοσ', JS does not
            await makeUser({ groups: ['İDARE'] }), // PG folds to 'idare', JS does not
            await makeUser(), // in-app capability
            await makeUser({ isAdmin: false, pinned: true }), // pinned non-admin + capability
            await makeUser(), // in-app group NAMED ΟΔΟΣ
            await makeUser(), // in-app group NAMED admin
            await makeUser(), // in-app group NAMED like an age group
        ];
        const cap = await inAppGroup('guard-parity-cap', true);
        await addMember(sql, cap, users[6].id, null);
        await addMember(sql, cap, users[7].id, null);
        await addMember(sql, await inAppGroup('ΟΔΟΣ', false), users[8].id, null);
        await addMember(sql, await inAppGroup('admin', false), users[9].id, null);
        await addMember(sql, await inAppGroup(ageName, false), users[10].id, null);

        const verdicts = await Promise.all(users.map((u) => formulaA(u.id)));
        expect(verdicts).toEqual([
            true,
            false,
            false,
            true,
            false,
            false,
            true,
            false,
            false,
            true,
            false,
        ]);
        expect(await countEffectiveAdmins(sql, config.ADMIN_GROUPS)).toBe(
            verdicts.filter(Boolean).length,
        );
    });

    // ── RED before the fix: check-then-act across concurrent guards ─────────

    it('a guarded change waits for a concurrent guarded change and then sees it (disable)', async () => {
        const a = await makeUser({ isAdmin: true, pinned: true });
        const b = await makeUser({ isAdmin: true, pinned: true });
        const holder = postgresConnect(getTestDatabaseUrl(), { max: 1 });
        try {
            // Another guarded change is in flight: it holds the guard lock.
            await holder`SELECT pg_advisory_lock(hashtext(${GUARD_LOCK_KEY}))`;
            let settled = false;
            const pending = disable(a.username).finally(() => {
                settled = true;
            });
            await new Promise((r) => setTimeout(r, 300));
            expect(settled).toBe(false);

            // ...and it demotes B before releasing the lock.
            await sql`UPDATE users SET is_admin = false WHERE id = ${b.id}::uuid`;
            await holder`SELECT pg_advisory_unlock(hashtext(${GUARD_LOCK_KEY}))`;

            const res = await pending;
            expect(res.ok).toBe(false);
            if (!res.ok) expect(res.status).toBe(409);
        } finally {
            await holder.end();
        }
    });

    it('a guarded change waits for a concurrent guarded change and then sees it (remove member)', async () => {
        const groupId = await inAppGroup('guard-lock-cohort', true);
        const a = await makeUser();
        const b = await makeUser();
        await addMember(sql, groupId, a.id, null);
        await addMember(sql, groupId, b.id, null);
        const holder = postgresConnect(getTestDatabaseUrl(), { max: 1 });
        try {
            await holder`SELECT pg_advisory_lock(hashtext(${GUARD_LOCK_KEY}))`;
            let settled = false;
            const pending = removeMember(sql, groupId, a.id).finally(() => {
                settled = true;
            });
            await new Promise((r) => setTimeout(r, 300));
            expect(settled).toBe(false);

            await sql`
                DELETE FROM user_access_groups
                WHERE group_id = ${groupId}::uuid AND user_id = ${b.id}::uuid
            `;
            await holder`SELECT pg_advisory_unlock(hashtext(${GUARD_LOCK_KEY}))`;

            const res = await pending;
            expect(res.ok).toBe(false);
            if (!res.ok) expect(res.status).toBe(409);
        } finally {
            await holder.end();
        }
    });

    // ── Controls: GREEN before and after ────────────────────────────────────

    it('control: with a second real admin, disabling one admin is allowed', async () => {
        const a = await makeUser({ isAdmin: true, pinned: true });
        await makeUser({ isAdmin: true, pinned: true });
        const res = await disable(a.username);
        expect(res.ok).toBe(true);
    });

    it('control: the only pinned admin cannot be disabled', async () => {
        const a = await makeUser({ isAdmin: true, pinned: true });
        const res = await disable(a.username);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.status).toBe(409);
    });

    it('control: removing one of two in-app admins is allowed', async () => {
        const groupId = await inAppGroup('guard-control-cohort', true);
        const a = await makeUser();
        const b = await makeUser();
        await addMember(sql, groupId, a.id, null);
        await addMember(sql, groupId, b.id, null);
        const res = await removeMember(sql, groupId, a.id);
        expect(res.ok).toBe(true);
    });

    it('control: disabling a non-admin is never guarded', async () => {
        await makeUser({ isAdmin: true, pinned: true });
        const viewer = await makeUser({ groups: ['viewers'] });
        const res = await disable(viewer.username);
        expect(res.ok).toBe(true);
    });
});
