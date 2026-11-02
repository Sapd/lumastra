// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the Access Control service (standalone multi-user).
 *
 * Proves the resolve+merge contract: synced-only, in-app-only, union, OR boolean
 * caps, MIN (most-restrictive) age merge, admin short-circuit, and cache
 * invalidation on membership/capability changes.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
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
import {
    resolveEffectiveAccess,
    createAccessGroup,
    addMember,
    removeMember,
    updateAccessGroupWithCaps,
    deleteAccessGroupGuarded,
    mergeCapabilityRows,
} from './access-control.service.js';
import { clearUserAccessCache } from '$lib/server/cache/user-access-cache.js';
import { buildUserPermissions, hasGroupPermission } from '$lib/server/auth.js';
import {
    getAccessGroupById,
    getAccessGroupByName,
    removeAccessGroupMember,
} from '$lib/server/database/queries/access-groups.queries.js';
import { def as membershipDef } from '$lib/server/api/defs/access/groups/[id]/members/[userId].js';
import { mount } from '$lib/server/api/mount.js';
import { principalLocals } from '$lib/server/api/principal-locals.test-helpers.js';
import type { RequestEvent } from '@sveltejs/kit';
import { config } from '$lib/server/config.js';
import { getPatService } from '$lib/server/oauth/pat.service.js';
import { toUserId } from '$lib/shared/user-id.js';
import { setUserAdmin } from './admin-user.service.js';
import { adminExists, createNativeAdmin } from '$lib/server/database/queries/users.queries.js';
import { completeNativeSetup, completeForwardAuthSetup } from './native-auth.service.js';

describe('mergeCapabilityRows (pure)', () => {
    it('OR-unions boolean caps and takes MIN age', () => {
        const merged = mergeCapabilityRows([
            { capability: 'livetv', value: null },
            { capability: 'watch', value: null },
            { capability: 'max_age_rating', value: '18' },
            { capability: 'max_age_rating', value: '12' },
        ]);
        expect(merged.hasLiveTvPermission).toBe(true);
        expect(merged.hasWatchPermission).toBe(true);
        expect(merged.maxAgeRating).toBe(12); // most restrictive
    });

    it('admin capability sets isAdmin', () => {
        expect(mergeCapabilityRows([{ capability: 'admin', value: null }]).ownerIsAdmin).toBe(true);
    });

    it('ignores invalid age values', () => {
        const merged = mergeCapabilityRows([{ capability: 'max_age_rating', value: 'nan' }]);
        expect(merged.maxAgeRating).toBeUndefined();
    });
});

describe('Access Control Service (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        clearUserAccessCache();
        await sql`DELETE FROM user_access_groups`;
        await sql`DELETE FROM access_groups WHERE is_system = false`;
        // Setup lock (S-C5c-2): with the row present every setup-gate
        // assertion below is true regardless of the admin predicate it tests.
        // Each test starts unlocked; tests that complete setup write it again.
        await sql`DELETE FROM setup_lock`;
    });

    it('addressed membership PUT is idempotent, bodyless, scoped and preserves the admin ceiling', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const created = await createAccessGroup(sql, { name: 'p2-members' });
        if (!created.ok) throw new Error('create group');
        const groupId = created.data.id;
        const event = (method: string, locals: RequestEvent['locals']): RequestEvent =>
            ({
                locals,
                params: { id: groupId, userId },
                url: new URL(`http://localhost/api/v1/access/groups/${groupId}/members/${userId}`),
                request: new Request(
                    `http://localhost/api/v1/access/groups/${groupId}/members/${userId}`,
                    { method },
                ),
                getClientAddress: () => '127.0.0.1',
            }) as unknown as RequestEvent;
        const handlers = mount(membershipDef, { surface: 'v1' });
        expect(
            (
                await handlers.PUT!(
                    event(
                        'PUT',
                        principalLocals({
                            kind: 'pat',
                            ownerIsAdmin: false,
                            tokenScopes: ['media:write'],
                        }),
                    ),
                )
            ).status,
        ).toBe(403);
        const admin = principalLocals({ kind: 'session', ownerIsAdmin: true, userId });
        expect((await handlers.PUT!(event('PUT', admin))).status).toBe(204);
        const [before] =
            await sql`SELECT * FROM user_access_groups WHERE user_id = ${userId} AND group_id = ${groupId}`;
        expect((await handlers.PUT!(event('PUT', admin))).status).toBe(204);
        const rows =
            await sql`SELECT * FROM user_access_groups WHERE user_id = ${userId} AND group_id = ${groupId}`;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toEqual(before);
        await updateAccessGroupWithCaps(sql, groupId, { capabilities: [{ capability: 'admin' }] });
        const delegate = principalLocals({
            kind: 'pat',
            ownerIsAdmin: false,
            tokenScopes: ['access:admin'],
            userId,
        });
        expect((await handlers.PUT!(event('PUT', delegate))).status).toBe(403);
    });

    it.each(['internal', 'v1'] as const)(
        '%s membership PUT returns 404 for an unknown user without inserting a row',
        async (surface) => {
            const actorId = generateTestUserId();
            const userId = generateTestUserId();
            await ensureTestUser(sql, actorId);
            const created = await createAccessGroup(sql, { name: `missing-user-${surface}` });
            if (!created.ok) throw new Error('create group');
            const groupId = created.data.id;
            const url = new URL(
                `http://localhost/api${surface === 'v1' ? '/v1' : '/admin'}/access/groups/${groupId}/members/${userId}`,
            );
            const response = await mount(membershipDef, { surface }).PUT!({
                url,
                request: new Request(url, { method: 'PUT' }),
                params: { id: groupId, userId },
                locals: principalLocals({ kind: 'session', ownerIsAdmin: true, userId: actorId }),
                getClientAddress: () => '127.0.0.1',
            } as unknown as RequestEvent);
            expect(response.status).toBe(404);
            expect(await response.json()).toMatchObject({
                code: 'not_found',
                error: 'User not found',
            });
            const rows = await sql`SELECT * FROM user_access_groups WHERE group_id = ${groupId}`;
            expect(rows).toHaveLength(0);
        },
    );

    it('synced-only: returns synced groups, no extra caps', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const res = await resolveEffectiveAccess(sql, userId, ['editors']);
        expect(res.effectiveGroups).toEqual(['editors']);
        expect(res.capabilities).toEqual({});
    });

    it('in-app-only: surfaces in-app group name + caps', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const created = await createAccessGroup(sql, {
            name: 'LiveTV Cohort',
            capabilities: [{ capability: 'livetv' }],
        });
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        await addMember(sql, created.data.id, userId, null);

        const res = await resolveEffectiveAccess(sql, userId, []);
        expect(res.effectiveGroups).toEqual(['LiveTV Cohort']);
        expect(res.capabilities.hasLiveTvPermission).toBe(true);
    });

    it('union: dedupes synced ∪ in-app by case-insensitive name', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const created = await createAccessGroup(sql, { name: 'editors' });
        if (!created.ok) throw new Error('setup');
        await addMember(sql, created.data.id, userId, null);

        // synced has 'Editors' (different case) — must dedupe to one effective group.
        const res = await resolveEffectiveAccess(sql, userId, ['Editors', 'staff']);
        const lower = res.effectiveGroups.map((g) => g.toLowerCase()).sort();
        expect(lower).toEqual(['editors', 'staff']);
    });

    it('most-restrictive age merge: kid cohort caps a default cohort', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const kid = await createAccessGroup(sql, {
            name: 'Kids',
            capabilities: [{ capability: 'max_age_rating', value: '6' }],
        });
        const def = await createAccessGroup(sql, {
            name: 'Default',
            capabilities: [{ capability: 'max_age_rating', value: '18' }],
        });
        if (!kid.ok || !def.ok) throw new Error('setup');
        await addMember(sql, kid.data.id, userId, null);
        await addMember(sql, def.data.id, userId, null);

        const res = await resolveEffectiveAccess(sql, userId, []);
        expect(res.capabilities.maxAgeRating).toBe(6);

        // and through buildUserPermissions the user is capped at 6
        const perms = buildUserPermissions(res.effectiveGroups, {
            extraCapabilities: res.capabilities,
        });
        expect(perms.maxAgeRating).toBe(6);
        expect(perms.isAgeRestricted).toBe(true);
    });

    it('admin short-circuit: in-app admin confers everything via buildUserPermissions', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const created = await createAccessGroup(sql, {
            name: 'Admins2',
            capabilities: [{ capability: 'admin' }, { capability: 'max_age_rating', value: '6' }],
        });
        if (!created.ok) throw new Error('setup');
        await addMember(sql, created.data.id, userId, null);

        const res = await resolveEffectiveAccess(sql, userId, []);
        const perms = buildUserPermissions(res.effectiveGroups, {
            extraCapabilities: res.capabilities,
        });
        expect(perms.ownerIsAdmin).toBe(true);
        expect(perms.hasLiveTvPermission).toBe(true);
        expect(perms.maxAgeRating).toBeNull(); // admin ignores the restrictive cap
    });

    it('cache invalidation: revoking membership drops the capability', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        // Use a name that is NOT in LIVETV_GROUPS/ADMIN_GROUPS to avoid the
        // isReservedGroupName guard (the guard correctly blocks shadowing config
        // groups; this test only cares about cache invalidation, not the name).
        const created = await createAccessGroup(sql, {
            name: 'LiveTV-Cohort',
            capabilities: [{ capability: 'livetv' }],
        });
        if (!created.ok) throw new Error('setup');
        await addMember(sql, created.data.id, userId, null); // invalidates cache

        let res = await resolveEffectiveAccess(sql, userId, []); // populates cache
        expect(res.capabilities.hasLiveTvPermission).toBe(true);

        await removeMember(sql, created.data.id, userId); // invalidates cache
        res = await resolveEffectiveAccess(sql, userId, []);
        expect(res.capabilities.hasLiveTvPermission).toBeUndefined();
    });

    it('cache invalidation: editing group capabilities re-resolves for members', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const created = await createAccessGroup(sql, {
            name: 'Mutable',
            capabilities: [{ capability: 'livetv' }],
        });
        if (!created.ok) throw new Error('setup');
        await addMember(sql, created.data.id, userId, null);
        let res = await resolveEffectiveAccess(sql, userId, []); // cache warm
        expect(res.capabilities.hasLiveTvPermission).toBe(true);

        // Replace caps with watch only — should invalidate the member's cache.
        await updateAccessGroupWithCaps(sql, created.data.id, {
            capabilities: [{ capability: 'watch' }],
        });
        res = await resolveEffectiveAccess(sql, userId, []);
        expect(res.capabilities.hasLiveTvPermission).toBeUndefined();
        expect(res.capabilities.hasWatchPermission).toBe(true);
    });

    it('createAccessGroup rejects a duplicate name with 409', async () => {
        const a = await createAccessGroup(sql, { name: 'Dup' });
        expect(a.ok).toBe(true);
        const b = await createAccessGroup(sql, { name: 'dup' });
        expect(b.ok).toBe(false);
        if (!b.ok) expect(b.status).toBe(409);
    });

    it('deleteAccessGroupGuarded refuses system groups', async () => {
        const admins = await sql<
            { id: string }[]
        >`SELECT id FROM access_groups WHERE name = 'admins'`;
        const res = await deleteAccessGroupGuarded(sql, admins[0].id);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.status).toBe(403);
    });

    // -------------------------------------------------------------------------
    // Critical: in-app group NAME must never raise a child's age ceiling.
    // -------------------------------------------------------------------------
    it('age-prefix in-app group NAME is excluded from effectiveGroups (no age escalation)', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        // Insert the group directly via SQL: isReservedGroupName correctly blocks
        // creating `age-18` through createAccessGroup (the guard prevents shadowing
        // the age-prefix convention). We bypass the service here to set up the
        // exact DB state the stripInAppAgeNames defense-in-depth is designed to
        // handle (e.g. groups imported from a pre-guard backup or a migration).
        const [{ id: groupId }] = await sql<{ id: string }[]>`
            INSERT INTO access_groups (name, display_name, description, is_system)
            VALUES ('age-18', 'age-18', NULL, FALSE)
            RETURNING id
        `;
        await addMember(sql, groupId, userId, null);

        // synced/IdP cohort caps the kid at 6 via the age-name convention.
        const res = await resolveEffectiveAccess(sql, userId, ['age-6']);
        // The in-app `age-18` name is stripped — only `age-6` remains.
        expect(res.effectiveGroups).toEqual(['age-6']);
        expect(res.inAppGroupNames).toEqual([]); // age-prefix name filtered out

        // Through buildUserPermissions the kid stays capped at 6, never raised to 18.
        const perms = buildUserPermissions(res.effectiveGroups, {
            extraCapabilities: res.capabilities,
        });
        expect(perms.maxAgeRating).toBe(6);
    });

    it('resolveEffectiveAccess returns inAppGroupNames separately (augment, not merged)', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const created = await createAccessGroup(sql, { name: 'Cohort-X' });
        if (!created.ok) throw new Error('setup');
        await addMember(sql, created.data.id, userId, null);

        const res = await resolveEffectiveAccess(sql, userId, ['synced-team']);
        expect(res.inAppGroupNames).toEqual(['Cohort-X']);
        expect(res.effectiveGroups.map((g) => g.toLowerCase()).sort()).toEqual([
            'cohort-x',
            'synced-team',
        ]);
    });

    // -------------------------------------------------------------------------
    // Critical: last-admin / self-lockout guards on the access API mutations.
    // -------------------------------------------------------------------------
    async function makeSoleAdminCohort(
        name = 'OnlyAdmins',
    ): Promise<{ groupId: string; userId: string }> {
        // Wipe ALL admin sources so the cohort below is the only effective admin.
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        const created = await createAccessGroup(sql, {
            name,
            capabilities: [{ capability: 'admin' }],
        });
        if (!created.ok) throw new Error('setup');
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        await addMember(sql, created.data.id, userId, null);
        return { groupId: created.data.id, userId };
    }

    it('removeMember refuses to remove the last effective admin', async () => {
        const { groupId, userId } = await makeSoleAdminCohort();
        const res = await removeMember(sql, groupId, userId);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.status).toBe(409);
        // membership intact
        const still =
            await sql`SELECT 1 FROM user_access_groups WHERE group_id = ${groupId}::uuid AND user_id = ${userId}::uuid`;
        expect(still).toHaveLength(1);
    });

    it('removeMember allows removal when another effective admin exists', async () => {
        const { groupId, userId } = await makeSoleAdminCohort();
        // Add a second admin (direct pin) so removal is safe.
        const other = generateTestUserId();
        await ensureTestUser(sql, other);
        await sql`UPDATE users SET is_admin = true, admin_pinned = true WHERE id = ${other}::uuid`;

        const res = await removeMember(sql, groupId, userId);
        expect(res.ok).toBe(true);
    });

    // -------------------------------------------------------------------------
    // X1(b) (security review 2026-09-23, final fix wave): in-app writes that
    // change a user's EFFECTIVE admin verdict must narrow/restore their
    // admin-scoped credentials — the second half of the X1 blocker chain (the
    // admin ceiling on the write DEFS stops a non-admin from re-granting
    // admin; this stops a credential minted while genuinely admin from
    // surviving a legitimate removal).
    // -------------------------------------------------------------------------

    async function getPatForceNonAdmin(patId: number): Promise<boolean> {
        const [row] = await sql<{ force_non_admin: boolean }[]>`
            SELECT force_non_admin FROM personal_access_tokens WHERE id = ${patId}
        `;
        return row.force_non_admin;
    }

    it('removeMember narrows an admin-scoped PAT when it demotes the target (X1b)', async () => {
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        const created = await createAccessGroup(sql, {
            name: 'AdminCohortRM',
            capabilities: [{ capability: 'admin' }],
        });
        if (!created.ok) throw new Error('setup');
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        await addMember(sql, created.data.id, userId, null);
        // Another effective admin so the last-admin guard does not block this.
        const other = generateTestUserId();
        await ensureTestUser(sql, other);
        await sql`UPDATE users SET is_admin = true, admin_pinned = true WHERE id = ${other}::uuid`;

        const pat = await getPatService().create({
            userId: toUserId(userId),
            name: 'x1b-rm',
            scopes: ['admin'],
            groups: [],
        });
        expect(await getPatForceNonAdmin(pat.id)).toBe(false);

        const res = await removeMember(sql, created.data.id, userId);
        expect(res.ok).toBe(true);
        expect(await getPatForceNonAdmin(pat.id)).toBe(true);
    });

    it('removeMember does NOT narrow when the user remains admin via a SECOND admin-conferring group (dual membership)', async () => {
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        const groupA = await createAccessGroup(sql, {
            name: 'AdminCohortDualA',
            capabilities: [{ capability: 'admin' }],
        });
        const groupB = await createAccessGroup(sql, {
            name: 'AdminCohortDualB',
            capabilities: [{ capability: 'admin' }],
        });
        if (!groupA.ok || !groupB.ok) throw new Error('setup');
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        await addMember(sql, groupA.data.id, userId, null);
        await addMember(sql, groupB.data.id, userId, null);
        const other = generateTestUserId();
        await ensureTestUser(sql, other);
        await sql`UPDATE users SET is_admin = true, admin_pinned = true WHERE id = ${other}::uuid`;

        const pat = await getPatService().create({
            userId: toUserId(userId),
            name: 'x1b-dual',
            scopes: ['admin'],
            groups: [],
        });

        // Removing from ONE of the two admin-conferring groups: Formula A
        // still says admin (group B). Must NOT narrow.
        const res = await removeMember(sql, groupA.data.id, userId);
        expect(res.ok).toBe(true);
        expect(await getPatForceNonAdmin(pat.id)).toBe(false);
    });

    it('addMember restores a previously-narrowed admin-scoped PAT when it (re-)promotes the target (X1b)', async () => {
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        const created = await createAccessGroup(sql, {
            name: 'AdminCohortAM',
            capabilities: [{ capability: 'admin' }],
        });
        if (!created.ok) throw new Error('setup');
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        const pat = await getPatService().create({
            userId: toUserId(userId),
            name: 'x1b-am',
            scopes: ['admin'],
            groups: [],
        });
        // Simulate a PRIOR (unrelated) demotion that already narrowed this PAT.
        await getPatService().markAdminScopedForceNonAdminForUser(toUserId(userId));
        expect(await getPatForceNonAdmin(pat.id)).toBe(true);

        const res = await addMember(sql, created.data.id, userId, null);
        expect(res.ok).toBe(true);
        expect(await getPatForceNonAdmin(pat.id)).toBe(false);
    });

    it('updateAccessGroupWithCaps (capability replace dropping admin) narrows every affected member (X1b)', async () => {
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        const created = await createAccessGroup(sql, {
            name: 'AdminCohortCapDrop',
            capabilities: [{ capability: 'admin' }],
        });
        if (!created.ok) throw new Error('setup');
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        await addMember(sql, created.data.id, userId, null);
        const other = generateTestUserId();
        await ensureTestUser(sql, other);
        await sql`UPDATE users SET is_admin = true, admin_pinned = true WHERE id = ${other}::uuid`;

        const pat = await getPatService().create({
            userId: toUserId(userId),
            name: 'x1b-capdrop',
            scopes: ['admin'],
            groups: [],
        });

        const res = await updateAccessGroupWithCaps(sql, created.data.id, {
            capabilities: [{ capability: 'watch' }], // drops admin
        });
        expect(res.ok).toBe(true);
        expect(await getPatForceNonAdmin(pat.id)).toBe(true);
    });

    it('deleteAccessGroupGuarded narrows every remaining member of the deleted admin-conferring group (X1b)', async () => {
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        const created = await createAccessGroup(sql, {
            name: 'AdminCohortDelete',
            capabilities: [{ capability: 'admin' }],
        });
        if (!created.ok) throw new Error('setup');
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        await addMember(sql, created.data.id, userId, null);
        const other = generateTestUserId();
        await ensureTestUser(sql, other);
        await sql`UPDATE users SET is_admin = true, admin_pinned = true WHERE id = ${other}::uuid`;

        const pat = await getPatService().create({
            userId: toUserId(userId),
            name: 'x1b-delete',
            scopes: ['admin'],
            groups: [],
        });

        const res = await deleteAccessGroupGuarded(sql, created.data.id);
        expect(res.ok).toBe(true);
        expect(await getPatForceNonAdmin(pat.id)).toBe(true);
    });

    // -------------------------------------------------------------------------
    // Fix round 2, Important 1 (reviewer-found regression in the X3/X1b fix
    // above): `setUserAdmin()`'s unpin branch must write the GROUPS-ONLY
    // verdict to `users.is_admin`, never the Formula-A (in-app-inclusive) one.
    // `countEffectiveAdmins()`/`countOtherEffectiveAdmins()` read
    // `u.is_admin = true` UNCONDITIONALLY (irrespective of pin) as one half of
    // their own OR (the other half is their OWN live in-app EXISTS check).
    // Writing the in-app-inclusive verdict into the column double-books that
    // admin source: the column keeps saying "admin" even after the in-app
    // membership it was derived from is later removed, so a real last-admin
    // scenario is silently missed.
    // -------------------------------------------------------------------------
    it('unpin writes the GROUPS-ONLY verdict to the column, so a later removeMember of the same (only) admin source correctly detects zero remaining admins (X important 1)', async () => {
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        const created = await createAccessGroup(sql, {
            name: 'ImportantOneCohort',
            capabilities: [{ capability: 'admin' }],
        });
        if (!created.ok) throw new Error('setup');
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        await addMember(sql, created.data.id, userId, null);
        const targetUsername = derivedUsername(userId);

        // Explicitly PIN this user as admin (is_admin=true, admin_pinned=true)
        // — they are ALSO an in-app admin (the group above), but have NO
        // admin-conferring GROUPS of their own.
        const pinResult = await setUserAdmin(sql, {
            targetUsername,
            actingUsername: 'someone-else',
            change: { kind: 'set', value: true },
            actor: { username: 'someone-else' },
        });
        expect(pinResult.ok).toBe(true);
        let row = await sql<{ is_admin: boolean; admin_pinned: boolean }[]>`
            SELECT is_admin, admin_pinned FROM users WHERE id = ${userId}::uuid
        `;
        expect(row[0].is_admin).toBe(true);
        expect(row[0].admin_pinned).toBe(true);

        // Unpin. This user has NO admin-conferring groups of their own
        // (`target.groups` is empty) — the groups-ONLY verdict is `false`,
        // even though Formula A (in-app included) is still `true`.
        const unpinResult = await setUserAdmin(sql, {
            targetUsername,
            actingUsername: 'someone-else',
            change: { kind: 'unpin' },
            actor: { username: 'someone-else' },
        });
        expect(unpinResult.ok).toBe(true);
        if (unpinResult.ok) expect(unpinResult.data.isAdmin).toBe(true); // Formula A (response)

        row = await sql<{ is_admin: boolean; admin_pinned: boolean }[]>`
            SELECT is_admin, admin_pinned FROM users WHERE id = ${userId}::uuid
        `;
        // THE FIX: the COLUMN reflects the groups-only verdict (false), not
        // the Formula-A response value (true) above.
        expect(row[0].is_admin).toBe(false);
        expect(row[0].admin_pinned).toBe(false);

        // Now remove them from their ONLY admin source. If the column had
        // been (incorrectly) left `true`, countEffectiveAdmins() would still
        // count this user as an effective admin via the stale column and
        // ALLOW the removal — leaving the instance with ZERO real admins.
        // With the fix, the column already reads `false`, so removing their
        // last in-app admin source is correctly refused.
        const removeResult = await removeMember(sql, created.data.id, userId);
        expect(removeResult.ok).toBe(false);
        if (!removeResult.ok) expect(removeResult.status).toBe(409);
    });

    // -------------------------------------------------------------------------
    // Fix round 3, CRITICAL: `adminExists()` (`users.queries.ts`) gates the
    // PUBLIC, unauthenticated first-run setup surfaces. Before this fix it read
    // ONLY `users.is_admin`. The Important-1 fix above (correctly) made the
    // unpin branch write the GROUPS-ONLY verdict to that column — so the exact
    // scenario above (in-app-only admin who is ALSO the pinned column-admin,
    // no admin-conferring groups of their own, unpinned) now legitimately
    // reaches `is_admin = false` on every row while a real, currently-effective
    // admin (via the in-app group) still exists. `adminExists()` must not
    // mistake that for "no admin" and reopen /setup to an anonymous visitor.
    // -------------------------------------------------------------------------
    it('adminExists() stays true (and completeNativeSetup stays refused) after unpinning the only column-admin who is also an in-app admin (X critical, adminExists broadening)', async () => {
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        const created = await createAccessGroup(sql, {
            name: 'CriticalAdminExistsCohort',
            capabilities: [{ capability: 'admin' }],
        });
        if (!created.ok) throw new Error('setup');
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        await addMember(sql, created.data.id, userId, null);
        const targetUsername = derivedUsername(userId);

        // Pin this user as a column-admin. They are ALSO an in-app admin via
        // the group above, but have no admin-conferring groups of their own.
        const pinResult = await setUserAdmin(sql, {
            targetUsername,
            actingUsername: 'someone-else',
            change: { kind: 'set', value: true },
            actor: { username: 'someone-else' },
        });
        expect(pinResult.ok).toBe(true);
        expect(await adminExists(sql, config.ADMIN_GROUPS)).toBe(true);

        // Unpin. Per the Important-1 fix, this writes the groups-only verdict
        // (false — this user has no admin-conferring groups of their own) to
        // the column, even though they remain a real effective admin via the
        // in-app group.
        const unpinResult = await setUserAdmin(sql, {
            targetUsername,
            actingUsername: 'someone-else',
            change: { kind: 'unpin' },
            actor: { username: 'someone-else' },
        });
        expect(unpinResult.ok).toBe(true);
        const row = await sql<{ is_admin: boolean }[]>`
            SELECT is_admin FROM users WHERE id = ${userId}::uuid
        `;
        expect(row[0].is_admin).toBe(false); // column now says "no admin" everywhere

        // THE FIX: adminExists() still sees the in-app admin and returns true.
        expect(await adminExists(sql, config.ADMIN_GROUPS)).toBe(true);

        // And the public, unauthenticated first-run setup surface stays shut.
        const setupResult = await completeNativeSetup(sql, {
            username: 'rogue-admin',
            password: 'irrelevant-short-circuits-before-validation',
        });
        expect(setupResult.ok).toBe(false);
        if (!setupResult.ok) {
            expect(setupResult.status).toBe(409);
            expect(setupResult.message).toBe('Setup has already been completed.');
        }
    });

    it('adminExists() is false (setup stays open) on a genuinely admin-less AND unlocked install', async () => {
        // No is_admin=true rows, no admin-conferring groups column entries,
        // and no admin-conferring in-app memberships — the beforeEach already
        // cleared user_access_groups/non-system groups; also clear any
        // is_admin/groups left over from a prior test in this file. C5:
        // adminExists() now ALSO has a `users.groups` term (S-C5b), so a
        // leftover `groups ∋ admin` row from an earlier test in this shared
        // DB would make this vacuously green without also clearing groups.
        // Setup lock (S-C5c-2, amends fix-plan-5 ledger :259/:262): only an
        // install whose setup never completed (no setup_lock row, cleared in
        // beforeEach) or whose operator ran SETUP_UNLOCK opens setup again.
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        expect(await adminExists(sql, config.ADMIN_GROUPS)).toBe(false);

        // Positive: the PUBLIC route itself actually opens, not just the bare
        // predicate in isolation.
        try {
            const setupResult = await completeNativeSetup(sql, {
                username: 'c5-guard-open',
                password: 'Correct-Horse-Battery-42!',
            });
            expect(setupResult.ok).toBe(true);
        } finally {
            await sql`DELETE FROM users WHERE username = 'c5-guard-open'`;
        }
    });

    // -------------------------------------------------------------------------
    // Fix round 4, CRITICAL correction to round 3's own ruling: adminExists()
    // used to inherit countEffectiveAdmins()'s `disabled_at IS NULL AND
    // deleted_at IS NULL` lifecycle filter. That's correct for a COUNT ("how
    // many admins can act right now") but wrong for a setup GATE ("has an
    // admin ever been created") -- disabling is reversible (two admins racing
    // to disable each other, or an operator disabling every admin in SQL), so
    // a disabled admin row still PROVES setup was completed. With the
    // lifecycle filter in place, disabling the only admin made adminExists()
    // return false, reopening the public /setup wizard and the OIDC-config
    // first-run gate to an anonymous caller.
    // -------------------------------------------------------------------------
    it('adminExists() stays true (and completeNativeSetup stays refused) when the only admin row is disabled', async () => {
        // C5 follow-up (fix round 1): also clear `groups` — adminExists() now
        // has a `users.groups` term (S-C5b), so a leftover `groups ∋ admin`
        // row from an earlier test/run in this shared DB would satisfy the
        // gate on its own, making this test pass VACUOUSLY even against a
        // mutant that wrongly reintroduces the lifecycle filter fix-plan-5
        // round 4 rejected (reproduced: seeded such a leftover row, the
        // mutant passed this test unchanged; adding `groups = NULL` here
        // makes it catch the mutant again).
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const targetUsername = derivedUsername(userId);
        await setUserAdmin(sql, {
            targetUsername,
            actingUsername: 'someone-else',
            change: { kind: 'set', value: true },
            actor: { username: 'someone-else' },
        });
        let row = await sql<{ is_admin: boolean; disabled_at: Date | null }[]>`
            SELECT is_admin, disabled_at FROM users WHERE id = ${userId}::uuid
        `;
        expect(row[0].is_admin).toBe(true);
        expect(row[0].disabled_at).toBeNull();

        // Disable the (only) admin -- reversible, not a deletion.
        await sql`UPDATE users SET disabled_at = NOW() WHERE id = ${userId}::uuid`;
        row = await sql<{ is_admin: boolean; disabled_at: Date | null }[]>`
            SELECT is_admin, disabled_at FROM users WHERE id = ${userId}::uuid
        `;
        expect(row[0].is_admin).toBe(true);
        expect(row[0].disabled_at).not.toBeNull();

        // THE FIX: adminExists() must not fail open just because the sole
        // admin is (reversibly) disabled.
        expect(await adminExists(sql, config.ADMIN_GROUPS)).toBe(true);

        const setupResult = await completeNativeSetup(sql, {
            username: 'rogue-admin-2',
            password: 'irrelevant-short-circuits-before-validation',
        });
        expect(setupResult.ok).toBe(false);
        if (!setupResult.ok) {
            expect(setupResult.status).toBe(409);
            expect(setupResult.message).toBe('Setup has already been completed.');
        }
    });

    it('updateAccessGroupWithCaps refuses to strip admin cap from the last admin group', async () => {
        const { groupId } = await makeSoleAdminCohort();
        const res = await updateAccessGroupWithCaps(sql, groupId, {
            capabilities: [{ capability: 'watch' }], // drops admin
        });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.status).toBe(409);
        // admin cap intact (rolled back)
        const full = await getAccessGroupById(sql, groupId);
        expect((full?.capabilities ?? []).map((c) => c.capability)).toContain('admin');
    });

    it('deleteAccessGroupGuarded refuses to delete the last admin-conferring group', async () => {
        const { groupId } = await makeSoleAdminCohort();
        const res = await deleteAccessGroupGuarded(sql, groupId);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.status).toBe(409);
        const full = await getAccessGroupById(sql, groupId);
        expect(full).not.toBeNull();
    });

    it('name-conferred admin (group named per ADMIN_GROUPS) counts as effective admin', async () => {
        // A group whose NAME is in config.ADMIN_GROUPS (resolved live from env)
        // with NO admin capability still confers admin at runtime via the config
        // name path — removeMember must guard against removing the last such member.
        //
        // Insert directly via SQL: isReservedGroupName correctly blocks creating a
        // group named after an ADMIN_GROUPS entry via createAccessGroup (the guard
        // prevents shadowing config admin names). We bypass the service here to test
        // the removeMember last-admin guard against name-conferred admin sources
        // (e.g. groups that existed before the guard was introduced, or that were
        // inserted by an admin directly in the DB).
        //
        // The group under test must confer admin ONLY through its name, never
        // through the `admin` capability — otherwise the 409 below comes from
        // groupConfersAdmin()'s capability check and the name path goes
        // untested. Under ADMIN_GROUPS=Admins, config.ADMIN_GROUPS[0] names the
        // schema-seeded SYSTEM group `admins`, which CARRIES the `admin`
        // capability (and must never be deleted or re-inserted: a 23505 unique
        // violation). So: reuse an existing group by that name only when it has
        // no `admin` capability; otherwise create a fresh, uniquely named group
        // and point ADMIN_GROUPS at it through the config getter. Clean up only
        // what this test created, by id, plus the membership it added — in
        // `finally`, regardless of the guard's refusal below.
        const configuredName = config.ADMIN_GROUPS[0];
        expect(configuredName).toBeTruthy();
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        const existingByName = await getAccessGroupByName(sql, configuredName);
        const existingGroup = existingByName
            ? await getAccessGroupById(sql, existingByName.id)
            : null;
        const reuseExisting =
            existingGroup !== null &&
            !existingGroup.capabilities.some((c) => c.capability === 'admin');
        const adminGroupName = reuseExisting
            ? configuredName
            : `name-admin-${crypto.randomUUID().slice(0, 8)}`;
        const adminGroupsSpy = reuseExisting
            ? null
            : vi.spyOn(config, 'ADMIN_GROUPS', 'get').mockReturnValue([adminGroupName]);
        let createdGroupId: string | null = null;

        try {
            let groupId: string;
            if (reuseExisting && existingGroup) {
                groupId = existingGroup.id;
            } else {
                createdGroupId = (
                    await sql<{ id: string }[]>`
                        INSERT INTO access_groups (name, display_name, description, is_system)
                        VALUES (${adminGroupName}, ${adminGroupName}, NULL, FALSE)
                        RETURNING id
                    `
                )[0].id;
                groupId = createdGroupId;
            }
            const group = await getAccessGroupById(sql, groupId);
            expect((group?.capabilities ?? []).map((c) => c.capability)).not.toContain('admin');

            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            await addMember(sql, groupId, userId, null);

            try {
                const res = await removeMember(sql, groupId, userId);
                expect(res.ok).toBe(false); // would leave zero effective admins
                if (!res.ok) expect(res.status).toBe(409);
            } finally {
                await removeAccessGroupMember(sql, groupId, userId);
            }
        } finally {
            adminGroupsSpy?.mockRestore();
            if (createdGroupId) {
                await sql`DELETE FROM access_groups WHERE id = ${createdGroupId}::uuid`;
            }
        }
    });

    // -------------------------------------------------------------------------
    // Fix plan 6, C5 (S-C5b): `adminExists()` and `createNativeAdmin()`'s
    // in-lock re-check used to have no `users.groups` term at all — only
    // `is_admin = true` OR an in-app admin-conferring membership. A user whose
    // ONLY admin source is the raw IdP-groups column (`users.groups`, written
    // by forward-auth's per-request sync, NOT the in-app `user_access_groups`
    // tables) was invisible to the setup gate: the outer `adminExists()`
    // check in `completeNativeSetup`/`completeForwardAuthSetup` would say "no
    // admin", and the SAME narrower predicate is what `createNativeAdmin`'s
    // atomic in-lock `WHERE NOT EXISTS` used, so a concurrent submission would
    // still mint a second admin even if the outer check had been fixed alone
    // (fix-plan-5 round 4's exact "would pass on old code too" trap). A shared
    // `setupGateAdminPredicate` fragment now case-folds `users.groups` against
    // `config.ADMIN_GROUPS` for BOTH callers.
    //
    // C5 fix round 1, Minor 5: this used to be ONE test chaining all four
    // assertions. At HEAD (pre-task-3), the FIRST assertion
    // (`adminExists() === true`) already threw, so the LATER
    // `createNativeAdmin()` in-lock assertion was never independently
    // observed RED — a chained test proves the outer gate is broken, not
    // that the in-lock copy specifically needs its own fix (fix-plan-5 round
    // 4's own lesson: "the F1 test's 'setup refused' half would pass on old
    // code too"). Split into 4 tests, each establishing its OWN groups-only
    // fixture, so each assertion can fail independently. The in-lock half
    // additionally has its own discrimination proof (temporarily revert ONLY
    // that call site to the pre-S-C5b hand-copied predicate, observe RED,
    // restore by hand) — see the report for the recorded run.
    // -------------------------------------------------------------------------
    it('adminExists() sees a groups-only admin via the raw IdP-groups column (C5)', async () => {
        // Global reset: column, groups AND in-app memberships (this file's
        // beforeEach only clears user_access_groups/non-system access_groups
        // — a leftover `is_admin=true` or `groups ∋ admin` row from an
        // earlier test in this shared DB would make this vacuously green).
        await sql`UPDATE users SET is_admin = false, groups = NULL`;

        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        // Upper-cased on purpose: proves the predicate case-folds
        // `LOWER(ug.name) = ANY(adminNames)` the same way `hasGroupPermission()`
        // does, not just an exact-case match.
        await sql`
            UPDATE users
            SET groups = ${[config.ADMIN_GROUPS[0].toUpperCase()]}
            WHERE id = ${userId}::uuid
        `;

        expect(await adminExists(sql, config.ADMIN_GROUPS)).toBe(true);
    });

    it('completeNativeSetup() refuses when only a groups-only admin exists (C5)', async () => {
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        await sql`
            UPDATE users
            SET groups = ${[config.ADMIN_GROUPS[0].toUpperCase()]}
            WHERE id = ${userId}::uuid
        `;

        // HEAD's narrower predicate lets this through and actually creates
        // 'c5-rogue', so clean it up regardless of RED/GREEN.
        try {
            const setupResult = await completeNativeSetup(sql, {
                username: 'c5-rogue',
                password: 'irrelevant-short-circuits-before-validation',
            });
            expect(setupResult.ok).toBe(false);
            if (!setupResult.ok) {
                expect(setupResult.status).toBe(409);
                expect(setupResult.message).toBe('Setup has already been completed.');
            }
        } finally {
            await sql`DELETE FROM users WHERE username = 'c5-rogue'`;
        }
    });

    // Proves the in-lock copy SEPARATELY from the outer adminExists() check
    // above (fix-plan-5 round 4's trap: the outer check alone is not enough
    // if the in-lock re-check disagrees with it under concurrency) — calls
    // createNativeAdmin() directly rather than through completeNativeSetup(),
    // so this assertion can only pass because of the in-lock re-check itself.
    it("createNativeAdmin()'s in-lock re-check refuses when only a groups-only admin exists (C5)", async () => {
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        await sql`
            UPDATE users
            SET groups = ${[config.ADMIN_GROUPS[0].toUpperCase()]}
            WHERE id = ${userId}::uuid
        `;

        try {
            const created = await createNativeAdmin(sql, {
                username: 'c5-rogue-2',
                passwordHash: 'x',
                groups: [],
                adminGroupNames: config.ADMIN_GROUPS,
            });
            expect(created).toBeNull();
        } finally {
            await sql`DELETE FROM users WHERE username = 'c5-rogue-2'`;
        }
    });

    it('completeForwardAuthSetup() refuses when only a groups-only admin exists (C5)', async () => {
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        await sql`
            UPDATE users
            SET groups = ${[config.ADMIN_GROUPS[0].toUpperCase()]}
            WHERE id = ${userId}::uuid
        `;

        try {
            const fwResult = await completeForwardAuthSetup(sql, {
                username: 'c5-fa',
                groups: [config.ADMIN_GROUPS[0]],
                isAdmin: true,
            });
            expect(fwResult.ok).toBe(false);
            if (!fwResult.ok) {
                expect(fwResult.status).toBe(409);
                expect(fwResult.message).toBe('Setup has already been completed.');
            }
        } finally {
            await sql`DELETE FROM users WHERE username = 'c5-fa'`;
        }
    });

    // GUARD (documents S-C5b's deliberate over-count for the pinned/demotion
    // axis): a pin explicitly demoted this user (admin_pinned=true,
    // is_admin=false), and they carry a STALE IdP-admin-group entry in
    // `users.groups` that no longer reflects reality (the IdP-side removal
    // hasn't landed, or never will because they're pinned). Formula A says
    // this user is NOT an admin (the pin wins unconditionally). The setup
    // GATE still counts the row — over-counting is the safe direction for a
    // gate (fix-plan-5 ledger, round 3/4 rulings: a false "admin exists" keeps
    // a closed install closed; a false "no admin exists" hands out the
    // wizard). This is intentionally NOT the same verdict `countEffectiveAdmins`
    // must give (S-C5b: never reuse this fragment there).
    it('adminExists() stays true for a pinned-demoted row whose stale groups column still names an admin group (GUARD: documents the over-count ruling)', async () => {
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        // Built directly via SQL (not setUserAdmin()): an explicit pin-demote
        // via the service goes through the last-admin guard, which this
        // fixture would trip since it's the only admin-shaped row in the
        // test DB at this point. The row shape below — admin_pinned=true,
        // is_admin=false, groups still naming an admin group — is exactly
        // what `setUserAdmin({kind:'set', value:false})` on an ALREADY-PINNED
        // admin (admin-user.service.ts's non-unpin `set` branch) leaves
        // behind in production once the IdP-side removal hasn't landed yet,
        // or never will because they're pinned; constructing it directly
        // isolates the GATE'S read of that state from the WRITER that
        // produces it.
        await sql`
            UPDATE users
            SET groups = ${[config.ADMIN_GROUPS[0]]}, admin_pinned = true, is_admin = false
            WHERE id = ${userId}::uuid
        `;
        const row = await sql<{ is_admin: boolean; admin_pinned: boolean; groups: string[] }[]>`
            SELECT is_admin, admin_pinned, groups FROM users WHERE id = ${userId}::uuid
        `;
        expect(row[0].is_admin).toBe(false);
        expect(row[0].admin_pinned).toBe(true);
        expect(row[0].groups).toEqual([config.ADMIN_GROUPS[0]]);

        expect(await adminExists(sql, config.ADMIN_GROUPS)).toBe(true);
    });

    // GUARD: forward-auth first-run still works end-to-end on real PG after
    // the change — the genesis admin stays unpinned (S-C5c) and is provisioned
    // via the groups the identity carries.
    it('completeForwardAuthSetup() still provisions the forward-auth genesis admin on a cleared DB (GUARD)', async () => {
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        expect(await adminExists(sql, config.ADMIN_GROUPS)).toBe(false);

        try {
            const fwResult = await completeForwardAuthSetup(sql, {
                username: 'c5-genesis',
                groups: [config.ADMIN_GROUPS[0]],
                isAdmin: true,
            });
            expect(fwResult.ok).toBe(true);
            expect(await adminExists(sql, config.ADMIN_GROUPS)).toBe(true);
            const row = await sql<{ is_admin: boolean; admin_pinned: boolean }[]>`
                SELECT is_admin, admin_pinned FROM users WHERE username = 'c5-genesis'
            `;
            expect(row[0].is_admin).toBe(true);
            expect(row[0].admin_pinned).toBe(false); // S-C5c: genesis admin stays unpinned
        } finally {
            await sql`DELETE FROM users WHERE username = 'c5-genesis'`;
        }
    });

    // C5 fix round 1, Minor 4: adminExists()'s groups term used to compare a
    // JS-pre-lowered `ADMIN_GROUPS` constant (the since-removed `normalizeAdminGroupNames()`,
    // `.trim().toLowerCase()`) against a Postgres-`LOWER()`ed row value — an
    // ASYMMETRIC fold. JS `toLowerCase()` and Postgres `LOWER()` (under this
    // DB's `en_US.utf8` collation) disagree on Turkish `İ` (U+0130): JS turns
    // 'İDARE'.toLowerCase() into 'i̇dare' (6 chars, dotted i + combining mark),
    // while Postgres LOWER('İDARE') gives 'idare' (5 chars, the combining
    // dot dropped) — the two never compared equal, so a groups-only admin
    // whose ADMIN_GROUPS entry contained a Turkish dotted capital I was
    // invisible to the setup gate even though Formula A (hasGroupPermission,
    // JS toLowerCase on BOTH sides) says they ARE an admin — a gate NARROWER
    // than Formula A, the wrong direction for a fail-closed setup gate.
    it('adminExists() case-folds a non-ASCII (Turkish İ) admin group name the same as Formula A (C5 fix round 1, Minor 4)', async () => {
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        await sql`UPDATE users SET groups = ${['İDARE']} WHERE id = ${userId}::uuid`;

        // Formula A agrees this is an admin — the gate must too.
        expect(hasGroupPermission(['İDARE'], ['İdare'])).toBe(true);

        expect(await adminExists(sql, ['İdare'])).toBe(true);
    });

    // -------------------------------------------------------------------------
    // C5 fix round 2 (controller ruling). Fix round 1's "fold both sides in
    // SQL" fix for Minor 4 was ITSELF wrong: JS `String.prototype.
    // toLowerCase()` (full Unicode special casing, V8's Unicode tables) and
    // Postgres `LOWER()` (this DB's glibc `en_US.utf8` collation, simple
    // per-character mapping from glibc's OWN, independently-versioned
    // tables) are two INDEPENDENT case-folding implementations that can
    // disagree in BOTH directions — a gate that UNDER-counts relative to
    // Formula A is the exact reopen this gate exists to prevent. The fix:
    // the name axis no longer folds in SQL at all — it reads raw candidate
    // names out of Postgres and asks Formula A's OWN `hasGroupPermission()`
    // function, so there is no second fold to disagree with.
    //
    // Each fixture below is exercised through BOTH `adminExists()` (the
    // outer gate) and `createNativeAdmin()`'s in-lock re-check (the SAME
    // `setupGateAdminExists()` function, called from inside the advisory
    // lock) — S-C5b's ruling that the two must share one implementation and
    // can never disagree.
    // -------------------------------------------------------------------------

    /** Global reset + one user whose `users.groups` (IdP-groups projection)
     * is set to `groupNames` — the ONLY admin-shaped state in the DB. */
    async function seedGroupsOnlyAdmin(groupNames: string[]): Promise<void> {
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        await sql`UPDATE users SET groups = ${groupNames} WHERE id = ${userId}::uuid`;
    }

    /** Global reset + an in-app access group named `groupName` (no `admin`
     * capability) with exactly one member — the ONLY admin-shaped state. */
    async function seedInAppNameOnlyAdmin(groupName: string): Promise<void> {
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const [{ id: groupId }] = await sql<{ id: string }[]>`
            INSERT INTO access_groups (name, display_name, description, is_system)
            VALUES (${groupName}, ${groupName}, NULL, FALSE)
            RETURNING id
        `;
        await sql`
            INSERT INTO user_access_groups (group_id, user_id, assigned_by)
            VALUES (${groupId}::uuid, ${userId}::uuid, NULL)
        `;
    }

    /** Proves createNativeAdmin()'s in-lock check independently: succeeds
     * (non-null, and the row gets cleaned up) when NO admin exists, returns
     * null (nothing inserted) when one does. */
    async function createNativeAdminProbe(
        username: string,
        adminGroupNames: readonly string[],
    ): Promise<string | null> {
        try {
            return await createNativeAdmin(sql, {
                username,
                passwordHash: 'x',
                groups: [],
                adminGroupNames,
            });
        } finally {
            await sql`DELETE FROM users WHERE username = ${username.toLowerCase()}`;
        }
    }

    it('adminExists()/createNativeAdmin() agree with Formula A for a Greek final-sigma admin group name, orientation 1 (C5 fix round 2)', async () => {
        // Row carries the CAPITAL form (regular, non-final, sigma: ΟΔΟΣ);
        // config carries the lowercase form (final sigma: οδος, the form
        // JS's context-aware toLowerCase() produces).
        await seedGroupsOnlyAdmin(['ΟΔΟΣ']);
        expect(hasGroupPermission(['ΟΔΟΣ'], ['οδος'])).toBe(true); // Formula A's own verdict
        expect(await adminExists(sql, ['οδος'])).toBe(true);
        expect(await createNativeAdminProbe('c5-sigma1-rogue', ['οδος'])).toBeNull();
    });

    it('adminExists()/createNativeAdmin() agree with Formula A for a Greek final-sigma admin group name, orientation 2 — the fix round 1 REGRESSION case (C5 fix round 2)', async () => {
        // The mirror orientation: row carries the lowercase final-sigma
        // form; config carries the capital form. Fix round 1's SQL-symmetric
        // fold got exactly THIS orientation wrong (Postgres LOWER('ΟΔΟΣ')
        // yields regular sigma 'οδοσ', not final sigma 'οδος' — a REGRESSION
        // relative to the naive pre-round-1 asymmetric fold, which happened
        // to match here by coincidence).
        await seedGroupsOnlyAdmin(['οδος']);
        expect(hasGroupPermission(['οδος'], ['ΟΔΟΣ'])).toBe(true);
        expect(await adminExists(sql, ['ΟΔΟΣ'])).toBe(true);
        expect(await createNativeAdminProbe('c5-sigma2-rogue', ['ΟΔΟΣ'])).toBeNull();
    });

    it('adminExists()/createNativeAdmin() agree with Formula A for a decomposed-İ admin group NAME (C5 fix round 2)', async () => {
        // Row carries the PRECOMPOSED Turkish dotted capital İ (U+0130);
        // config is spelled with the DECOMPOSED sequence (plain 'i' +
        // COMBINING DOT ABOVE U+0307 + 'dare') — the exact byte sequence JS
        // toLowerCase() of İDARE happens to produce, but a DIFFERENT string
        // (different length/bytes) from what Postgres LOWER('İDARE') gives
        // ('idare', the combining mark dropped entirely under this DB's
        // glibc collation).
        const decomposedConfig = 'i̇dare'; // i + combining dot above + dare
        await seedGroupsOnlyAdmin(['İDARE']);
        expect(hasGroupPermission(['İDARE'], [decomposedConfig])).toBe(true);
        expect(await adminExists(sql, [decomposedConfig])).toBe(true);
        expect(await createNativeAdminProbe('c5-decomposed-rogue', [decomposedConfig])).toBeNull();
    });

    it('adminExists()/createNativeAdmin() agree with Formula A for an in-app group NAME with Greek final sigma (C5 fix round 2)', async () => {
        // Same Greek final-sigma mismatch as above, but through the IN-APP
        // group-name axis (access_groups.name), not the raw users.groups
        // column — proves the fix covers BOTH name sources uniformly.
        await seedInAppNameOnlyAdmin('ΟΔΟΣ');
        expect(await adminExists(sql, ['οδος'])).toBe(true);
        expect(await createNativeAdminProbe('c5-inapp-sigma-rogue', ['οδος'])).toBeNull();
    });

    it("adminExists()/createNativeAdmin() agree with Formula A for a codepoint newer than this DB's glibc case tables (U+A7DC, C5 fix round 2)", async () => {
        // U+A7DC (LATIN CAPITAL LETTER LAMBDA WITH STROKE) is recent enough
        // that this DB's Postgres LOWER() (glibc 2.36) doesn't know its
        // lowercase form at all and leaves it UNCHANGED, while V8's
        // toLowerCase() correctly maps it to U+019B.
        const upper = 'Ƛ';
        const lower = 'Ƛ'.toLowerCase();
        expect(lower).not.toBe(upper); // confirms JS DOES know this mapping
        await seedGroupsOnlyAdmin([upper]);
        expect(hasGroupPermission([upper], [lower])).toBe(true);
        expect(await adminExists(sql, [lower])).toBe(true);
        expect(await createNativeAdminProbe('c5-a7dc-rogue', [lower])).toBeNull();
    });

    it('CONTROL: a non-admin group name is not counted by adminExists()/createNativeAdmin() (C5 fix round 2)', async () => {
        await seedGroupsOnlyAdmin(['definitely-not-an-admin-group']);
        const unrelatedAdminNames = ['οδος', 'İdare', 'Ƛ'.toLowerCase()];
        expect(await adminExists(sql, unrelatedAdminNames)).toBe(false);
        expect(
            await createNativeAdminProbe('c5-control-rogue', unrelatedAdminNames),
        ).not.toBeNull();
    });

    it('trims whitespace-padded ADMIN_GROUPS entries the same way Formula A does (C5 fix round 2)', async () => {
        await seedGroupsOnlyAdmin(['admin']);
        expect(await adminExists(sql, ['  admin  '])).toBe(true);
        expect(await createNativeAdminProbe('c5-trim-rogue', ['  admin  '])).toBeNull();
    });

    it('fails CLOSED by THROWING (not a silent true) when ADMIN_GROUPS is empty, blank, or all-NULL/whitespace AND no column/capability admin exists (C5 fix round 3; guard for round 4)', async () => {
        // C5 fix round 3 (controller ruling, overrides fix round 2): fix
        // round 2 made this return `true` — but that silently changed
        // OBSERVABLE, non-setup-gate behaviour versus the pre-C5 NUL-byte
        // throw (isFreshUnconfiguredInstall() would say "not fresh" and let
        // the TMDB background sync run against a genuinely admin-less,
        // unconfigured install; a plugin sign-in would provision before any
        // admin exists; the OIDC callback would skip first-user-admin
        // provisioning; native setup would answer a misleading 409 with
        // nothing logged). Every caller already treats a THROWN rejection as
        // closed, so this now throws explicitly instead.
        //
        // A genuinely admin-less DB — NOT the "groups-only admin" shape used
        // by the fixtures above. An empty/blank ADMIN_GROUPS must never let
        // the gate silently conclude "no admin" just because the name axis
        // has nothing valid to compare against — nor silently conclude
        // "admin exists" without telling anyone the config is broken.
        await sql`UPDATE users SET is_admin = false, groups = NULL`;

        const expectedMessage =
            'ADMIN_GROUPS is empty; the first-run setup gate cannot be evaluated';
        for (const blankAdminGroups of [[], [''], ['   '], ['', '  ']]) {
            await expect(adminExists(sql, blankAdminGroups)).rejects.toThrow(expectedMessage);
            await expect(
                createNativeAdminProbe('c5-blank-rogue', blankAdminGroups),
            ).rejects.toThrow(expectedMessage);
        }
    });

    // C5 fix round 4 (controller ruling): the blank-ADMIN_GROUPS throw must
    // fire ONLY when the column/capability axis finds no admin. Round 3
    // threw BEFORE reading the database, so an INSTALLED instance whose admin
    // is a column admin or an in-app `admin`-capability admin also threw —
    // reachable by saving ADMIN_GROUPS as "" in settings (parses to []) or
    // env `ADMIN_GROUPS=,` — which 500'd `/login` for anonymous visitors and
    // failed every OIDC callback (both call adminExists() outside a try): a
    // sign-in outage an admin could trigger but not undo from the UI. For a
    // blank config Formula A's name axis is empty, so `cap === true` is the
    // exact answer; only `cap === false` is undecidable and throws.
    it('answers true (no throw) for a blank ADMIN_GROUPS when a COLUMN admin exists (C5 fix round 4)', async () => {
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        await sql`UPDATE users SET is_admin = true WHERE id = ${userId}::uuid`;

        for (const blankAdminGroups of [[], [''], ['   '], ['', '  ']]) {
            expect(await adminExists(sql, blankAdminGroups)).toBe(true);
            expect(await createNativeAdminProbe('c5-blank-col-rogue', blankAdminGroups)).toBeNull();
        }
    });

    it("answers true (no throw) for a blank ADMIN_GROUPS when an in-app 'admin'-capability admin exists (C5 fix round 4)", async () => {
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        const created = await createAccessGroup(sql, {
            name: 'c5-blank-cap-admins',
            capabilities: [{ capability: 'admin' }],
        });
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        await addMember(sql, created.data.id, userId, null);

        for (const blankAdminGroups of [[], [''], ['   '], ['', '  ']]) {
            expect(await adminExists(sql, blankAdminGroups)).toBe(true);
            expect(await createNativeAdminProbe('c5-blank-cap-rogue', blankAdminGroups)).toBeNull();
        }
    });

    it("doesn't crash and correctly ignores NULL/empty groups-column shapes ({}, {NULL}, {NULL,'ADMIN'}) (C5 fix round 2)", async () => {
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        const emptyArrId = generateTestUserId();
        await ensureTestUser(sql, emptyArrId);
        await sql`UPDATE users SET groups = ARRAY[]::text[] WHERE id = ${emptyArrId}::uuid`; // {}

        const nullElemId = generateTestUserId();
        await ensureTestUser(sql, nullElemId);
        await sql`UPDATE users SET groups = ARRAY[NULL]::text[] WHERE id = ${nullElemId}::uuid`; // {NULL}

        // Neither {} nor {NULL} confers admin on its own.
        expect(await adminExists(sql, ['admin'])).toBe(false);

        // {NULL,'ADMIN'} DOES confer admin (the real, non-NULL element still
        // counts; the NULL element must be skipped, not crash the query).
        await sql`UPDATE users SET groups = ARRAY[NULL, 'ADMIN']::text[] WHERE id = ${nullElemId}::uuid`;
        expect(await adminExists(sql, ['admin'])).toBe(true);
        expect(await createNativeAdminProbe('c5-nullelem-rogue', ['admin'])).toBeNull();
    });

    it('PARITY PROPERTY: adminExists() agrees with hasGroupPermission() for a battery of tricky strings, single-row case (C5 fix round 2)', async () => {
        const trickyPairs: Array<[row: string, config: string]> = [
            ['ΟΔΟΣ', 'οδος'],
            ['οδος', 'ΟΔΟΣ'],
            ['İDARE', 'İdare'],
            ['İDARE', 'i̇dare'],
            ['Ƛ', 'Ƛ'.toLowerCase()],
            ['ᲈ', 'ᲈ'.toLowerCase()], // another recent-Unicode letter
            ['admin', 'ADMIN'],
            ['  admin  ', 'admin'],
            ['totally-unrelated', 'admin'],
        ];
        for (const [rowName, configName] of trickyPairs) {
            await seedGroupsOnlyAdmin([rowName]);
            const formulaA = hasGroupPermission([rowName], [configName]);
            const gate = await adminExists(sql, [configName]);
            expect({ rowName, configName, gate }).toEqual({ rowName, configName, gate: formulaA });
        }
    });

    // -------------------------------------------------------------------------
    // C5 fix round 3 (controller ruling, NEW Important, reproduced on a
    // scratch DB by the reviewer and independently re-reproduced here with
    // the SAME deterministic technique before writing this test): fix round
    // 2's `setupGateAdminExists()` was THREE separate statements — a
    // capability/column EXISTS check, then two candidate-name queries — each
    // its own READ COMMITTED snapshot. A single concurrent COMMIT that moves
    // the instance's ONLY admin from one axis to another (e.g. an in-app
    // admin-conferring membership removed in the SAME commit that pins
    // `is_admin=true` on that same user) could land BETWEEN those
    // statements: the capability query's snapshot (before the commit) does
    // not see the new `is_admin=true`, and the name-query snapshots (after)
    // no longer see the removed membership — every one of the three misses
    // it, even though an admin existed continuously throughout. Fixed by
    // collapsing all three into ONE statement (see `setupGateAdminExists()`
    // in `users.queries.ts`), so there is exactly one snapshot and no
    // window for a concurrent commit to straddle.
    //
    // DETERMINISM: an ACCESS EXCLUSIVE lock on `access_groups`, held from a
    // SECOND, independent connection, blocks `setupGateAdminExists()`'s
    // single SELECT at the start of execution (it needs at least ACCESS
    // SHARE on every table it references, including `access_groups`) —
    // deterministically pausing the check until the lock is released. The
    // "move" (pin the column, remove the in-app membership) runs in the
    // SAME transaction as the lock, so releasing the lock (via COMMIT) and
    // making the move visible happen atomically — no gap for the blocked
    // check to observe a partial state.
    it('createNativeAdmin() sees ONE internally-consistent snapshot even when the sole admin moves from an in-app membership to the pinned COLUMN in one concurrent commit (C5 fix round 3)', async () => {
        await sql`UPDATE users SET is_admin = false, groups = NULL`;
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const groupName = 'c5-snapshot-probe-group';
        const [{ id: groupId }] = await sql<{ id: string }[]>`
            INSERT INTO access_groups (name, display_name, is_system)
            VALUES (${groupName}, ${groupName}, FALSE)
            RETURNING id
        `;
        await sql`
            INSERT INTO user_access_groups (group_id, user_id, assigned_by)
            VALUES (${groupId}::uuid, ${userId}::uuid, NULL)
        `;
        // In-app membership alone does NOT confer admin: the group above has
        // no `admin` capability, so the user is an admin only because the
        // group's NAME matches an ADMIN_GROUPS entry (setupGateAdminExists()'s
        // `inapp` array is matched against adminGroupNames through Formula A's
        // hasGroupPermission(), exactly like the users.groups names). So
        // adminGroupNames MUST name this group, or the fixture has no admin
        // before the move and models "an admin appears" rather than "the sole
        // admin moves" (C5 fix round 4 — round 3 passed an unrelated name).
        const adminGroupNames = [groupName];
        // Precondition: exactly one admin exists BEFORE the move, via the
        // in-app name axis only (no column admin anywhere).
        expect(await adminExists(sql, adminGroupNames)).toBe(true);
        expect(await sql`SELECT 1 FROM users WHERE is_admin = true`).toHaveLength(0);

        // Second, independent connection — used only to hold the blocking
        // lock and perform the concurrent "move" in one commit. Never the
        // shared `sql` singleton (that would self-deadlock: this same test
        // also runs createNativeAdmin() on `sql`).
        const w = postgresConnect(getTestDatabaseUrl(), { max: 1, onnotice: () => {} });
        try {
            let releaseHold: () => void = () => undefined;
            const holdReleased = new Promise<void>((resolve) => {
                releaseHold = resolve;
            });
            let lockAcquired: () => void = () => undefined;
            const lockAcquiredP = new Promise<void>((resolve) => {
                lockAcquired = resolve;
            });

            const wTx = w.begin(async (t) => {
                await t`LOCK TABLE access_groups IN ACCESS EXCLUSIVE MODE`;
                lockAcquired();
                await holdReleased;
                // The move, in ONE commit: the sole admin goes from
                // in-app-membership-conferred to pinned-column-conferred.
                await t`UPDATE users SET is_admin = true, admin_pinned = true WHERE id = ${userId}::uuid`;
                await t`DELETE FROM user_access_groups WHERE user_id = ${userId}::uuid`;
            });

            await lockAcquiredP;
            const resultPromise = createNativeAdmin(sql, {
                username: 'c5-snapshot-rogue',
                passwordHash: 'x',
                groups: [],
                adminGroupNames,
            });

            // Wait until createNativeAdmin()'s check is actually queued as a
            // lock waiter on access_groups before releasing the hold, so the
            // schedule is deterministic rather than a race against its own
            // connection setup.
            let blocked = false;
            for (let i = 0; i < 100; i++) {
                const r = await sql<{ n: number }[]>`
                    SELECT count(*)::int AS n
                    FROM pg_locks l
                    JOIN pg_class c ON c.oid = l.relation
                    WHERE c.relname = 'access_groups' AND NOT l.granted
                `;
                if (r[0].n > 0) {
                    blocked = true;
                    break;
                }
                await new Promise((res) => setTimeout(res, 20));
            }
            expect(blocked).toBe(true); // proves the check really paused mid-statement

            releaseHold();
            await wTx;
            const result = await resultPromise;

            // THE FIX: no second admin minted. The one-statement snapshot
            // either sees the move complete (admin via column) or not yet
            // started (admin via membership) — never a state with neither.
            expect(result).toBeNull();
            const admins = await sql<{ username: string }[]>`
                SELECT username FROM users WHERE is_admin = true
            `;
            expect(admins).toHaveLength(1);
            expect(admins[0].username).toBe(derivedUsername(userId));
        } finally {
            await w.end();
            await sql`DELETE FROM users WHERE username = 'c5-snapshot-rogue'`;
            await sql`DELETE FROM user_access_groups WHERE group_id = ${groupId}::uuid`;
            await sql`DELETE FROM access_groups WHERE id = ${groupId}::uuid`;
        }
    });
});

describe('mergeCapabilityRows — capability value handling', () => {
    it('drops negative and non-numeric age values', () => {
        expect(
            mergeCapabilityRows([{ capability: 'max_age_rating', value: '-3' }]).maxAgeRating,
        ).toBeUndefined();
        expect(
            mergeCapabilityRows([{ capability: 'max_age_rating', value: 'x' }]).maxAgeRating,
        ).toBeUndefined();
    });
});
