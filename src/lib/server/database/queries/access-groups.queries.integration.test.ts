// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the Access Groups query module (standalone multi-user).
 *
 * Exercises group CRUD, capability rows, membership, effective-access resolution,
 * and the effective-admin counters against a real PostgreSQL test DB.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    generateTestUserId,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';
import {
    insertAccessGroup,
    getAccessGroupById,
    getAccessGroupByName,
    listAccessGroups,
    updateAccessGroup,
    deleteAccessGroup,
    insertAccessGroupCapabilities,
    deleteAccessGroupCapabilities,
    addAccessGroupMember,
    removeAccessGroupMember,
    listAccessGroupMembers,
    getEffectiveGroupsAndCaps,
    getAccessGroupMemberIds,
    countOtherInAppAdmins,
    countOtherEffectiveAdmins,
    countEffectiveAdmins,
    isLastEffectiveAdmin,
} from './access-groups.queries.js';

// config.ADMIN_GROUPS default for the runtime name-conferred admin path.
const ADMIN_NAMES = ['admin'];

describe('Access Groups Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        // Clean only the non-system groups + memberships; keep the seeded
        // `admins` system group out of the way by deleting test-created groups.
        await sql`DELETE FROM user_access_groups`;
        await sql`DELETE FROM access_groups WHERE is_system = false`;
    });

    async function makeGroup(name: string): Promise<string> {
        const g = await insertAccessGroup(sql, {
            name,
            displayName: name,
            description: null,
        });
        return g.id;
    }

    it('creates and reads a group with capabilities + member count', async () => {
        const id = await makeGroup('LiveTV Cohort');
        await insertAccessGroupCapabilities(sql, id, [
            { capability: 'livetv', value: null },
            { capability: 'max_age_rating', value: '12' },
        ]);

        const row = await getAccessGroupById(sql, id);
        expect(row).not.toBeNull();
        expect(row?.name).toBe('LiveTV Cohort');
        expect(row?.member_count).toBe(0);
        const caps = (row?.capabilities ?? []).map((c) => c.capability).sort();
        expect(caps).toEqual(['livetv', 'max_age_rating']);
    });

    it('enforces case-insensitive unique name', async () => {
        await makeGroup('Editors');
        await expect(makeGroup('editors')).rejects.toThrow();
    });

    it('getAccessGroupByName is case-insensitive', async () => {
        const id = await makeGroup('Trainees');
        const byName = await getAccessGroupByName(sql, 'TRAINEES');
        expect(byName?.id).toBe(id);
    });

    it('updates display/description and replaces capabilities', async () => {
        const id = await makeGroup('Temp');
        await insertAccessGroupCapabilities(sql, id, [{ capability: 'watch', value: null }]);
        await updateAccessGroup(sql, id, { displayName: 'Temp 2', description: 'desc' });
        await deleteAccessGroupCapabilities(sql, id);
        await insertAccessGroupCapabilities(sql, id, [{ capability: 'livetv', value: null }]);

        const row = await getAccessGroupById(sql, id);
        expect(row?.display_name).toBe('Temp 2');
        expect(row?.description).toBe('desc');
        expect((row?.capabilities ?? []).map((c) => c.capability)).toEqual(['livetv']);
    });

    it('rejects an out-of-vocabulary capability via CHECK', async () => {
        const id = await makeGroup('Bad');
        await expect(
            sql`INSERT INTO access_group_capabilities (group_id, capability) VALUES (${id}::uuid, 'wat')`,
        ).rejects.toThrow();
    });

    it('membership add is idempotent and reflected in member_count + listing', async () => {
        const id = await makeGroup('Cohort');
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        await addAccessGroupMember(sql, id, userId, null);
        await addAccessGroupMember(sql, id, userId, null); // idempotent

        const members = await listAccessGroupMembers(sql, id);
        expect(members).toHaveLength(1);
        expect(members[0].user_id).toBe(userId);

        const row = await getAccessGroupById(sql, id);
        expect(row?.member_count).toBe(1);

        const ids = await getAccessGroupMemberIds(sql, id);
        expect(ids).toEqual([userId]);

        await removeAccessGroupMember(sql, id, userId);
        expect(await listAccessGroupMembers(sql, id)).toHaveLength(0);
    });

    it('getEffectiveGroupsAndCaps returns names + union of caps across groups', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const g1 = await makeGroup('LiveTVers');
        const g2 = await makeGroup('Watchers');
        await insertAccessGroupCapabilities(sql, g1, [{ capability: 'livetv', value: null }]);
        await insertAccessGroupCapabilities(sql, g2, [{ capability: 'watch', value: null }]);
        await addAccessGroupMember(sql, g1, userId, null);
        await addAccessGroupMember(sql, g2, userId, null);

        const eff = await getEffectiveGroupsAndCaps(sql, userId);
        expect(eff.groupNames.sort()).toEqual(['LiveTVers', 'Watchers']);
        const caps = eff.capabilities.map((c) => c.capability).sort();
        expect(caps).toEqual(['livetv', 'watch']);
    });

    it('cascade deletes capabilities + memberships on group delete', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const id = await makeGroup('Doomed');
        await insertAccessGroupCapabilities(sql, id, [{ capability: 'admin', value: null }]);
        await addAccessGroupMember(sql, id, userId, null);

        await deleteAccessGroup(sql, id);
        expect(await getAccessGroupById(sql, id)).toBeNull();
        const caps =
            await sql`SELECT 1 FROM access_group_capabilities WHERE group_id = ${id}::uuid`;
        expect(caps).toHaveLength(0);
        const mem = await sql`SELECT 1 FROM user_access_groups WHERE group_id = ${id}::uuid`;
        expect(mem).toHaveLength(0);
    });

    describe('effective-admin counters (last-admin protection)', () => {
        it('isLastEffectiveAdmin: an in-app-capability admin alone is the last admin', async () => {
            await sql`UPDATE users SET is_admin = false, groups = NULL`;
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            expect(await isLastEffectiveAdmin(sql, userId, ADMIN_NAMES)).toBe(false);

            const id = await makeGroup('Admins2');
            await insertAccessGroupCapabilities(sql, id, [{ capability: 'admin', value: null }]);
            await addAccessGroupMember(sql, id, userId, null);
            expect(await isLastEffectiveAdmin(sql, userId, ADMIN_NAMES)).toBe(true);

            // A second (pinned) admin means the first is no longer the last.
            const other = generateTestUserId();
            await ensureTestUser(sql, other);
            await sql`UPDATE users SET is_admin = true, admin_pinned = true WHERE id = ${other}::uuid`;
            expect(await isLastEffectiveAdmin(sql, userId, ADMIN_NAMES)).toBe(false);
        });

        it('isLastEffectiveAdmin detects NAME-conferred admin (group named per ADMIN_GROUPS)', async () => {
            await sql`UPDATE users SET is_admin = false, groups = NULL`;
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            // A group named `admin` with NO admin capability confers admin via name.
            const id = await makeGroup('admin');
            await addAccessGroupMember(sql, id, userId, null);
            expect(await isLastEffectiveAdmin(sql, userId, ADMIN_NAMES)).toBe(true);
            // ...but only when the name matches the configured admin-group names.
            expect(await isLastEffectiveAdmin(sql, userId, ['something-else'])).toBe(false);
        });

        it('a blank ADMIN_GROUPS counts pinned and capability admins (Formula A has no name axis) instead of throwing', async () => {
            await sql`UPDATE users SET is_admin = false, groups = NULL`;
            const pinned = generateTestUserId();
            const byCap = generateTestUserId();
            const byName = generateTestUserId();
            await ensureTestUser(sql, pinned);
            await ensureTestUser(sql, byCap);
            await ensureTestUser(sql, byName);
            await sql`UPDATE users SET is_admin = true, admin_pinned = true WHERE id = ${pinned}::uuid`;
            await sql`UPDATE users SET groups = ${['admin']} WHERE id = ${byName}::uuid`;
            const cap = await makeGroup('BlankCfgCap');
            await insertAccessGroupCapabilities(sql, cap, [{ capability: 'admin', value: null }]);
            await addAccessGroupMember(sql, cap, byCap, null);

            for (const blank of [[], [''], ['   ']]) {
                expect(await countEffectiveAdmins(sql, blank)).toBe(2);
            }
            expect(await countEffectiveAdmins(sql, ADMIN_NAMES)).toBe(3);
        });

        it('countOtherInAppAdmins counts active in-app admins except self', async () => {
            const a = generateTestUserId();
            const b = generateTestUserId();
            await ensureTestUser(sql, a);
            await ensureTestUser(sql, b);
            const id = await makeGroup('AdminCohort');
            await insertAccessGroupCapabilities(sql, id, [{ capability: 'admin', value: null }]);
            await addAccessGroupMember(sql, id, a, null);
            await addAccessGroupMember(sql, id, b, null);

            expect(await countOtherInAppAdmins(sql, a)).toBe(1); // b
            expect(await countOtherInAppAdmins(sql, b)).toBe(1); // a
        });

        it('countOtherEffectiveAdmins unions direct pins + in-app admins, distinct', async () => {
            // Baseline from a non-admin observer; other test runs may have left
            // admin rows behind (users table isn't truncated), so assert deltas.
            const other = generateTestUserId();
            await ensureTestUser(sql, other);
            const baseline = await countOtherEffectiveAdmins(sql, other, ADMIN_NAMES);

            const directAdmin = generateTestUserId();
            const inAppAdmin = generateTestUserId();
            const both = generateTestUserId();
            await ensureTestUser(sql, directAdmin);
            await ensureTestUser(sql, inAppAdmin);
            await ensureTestUser(sql, both);
            await sql`UPDATE users SET is_admin = true, admin_pinned = true WHERE id IN (${directAdmin}::uuid, ${both}::uuid)`;

            const id = await makeGroup('AdminGrp');
            await insertAccessGroupCapabilities(sql, id, [{ capability: 'admin', value: null }]);
            await addAccessGroupMember(sql, id, inAppAdmin, null);
            await addAccessGroupMember(sql, id, both, null); // also direct → counted once

            // 3 NEW distinct admins added (directAdmin, inAppAdmin, both-once).
            expect(await countOtherEffectiveAdmins(sql, other, ADMIN_NAMES)).toBe(baseline + 3);

            // Excluding `both` leaves baseline + directAdmin + inAppAdmin = baseline + 2.
            expect(await countOtherEffectiveAdmins(sql, both, ADMIN_NAMES)).toBe(baseline + 2);
        });

        it('countOtherEffectiveAdmins counts NAME-conferred admins', async () => {
            // The count reads users.groups too; a leftover IdP-admin row would
            // differ between ADMIN_NAMES and ['nope'] below.
            await sql`UPDATE users SET groups = NULL`;
            const other = generateTestUserId();
            await ensureTestUser(sql, other);
            const baseline = await countOtherEffectiveAdmins(sql, other, ADMIN_NAMES);

            const nameAdmin = generateTestUserId();
            await ensureTestUser(sql, nameAdmin);
            const id = await makeGroup('admin'); // matches ADMIN_NAMES, no caps
            await addAccessGroupMember(sql, id, nameAdmin, null);

            expect(await countOtherEffectiveAdmins(sql, other, ADMIN_NAMES)).toBe(baseline + 1);
            // With a different configured admin-name set, the name no longer confers.
            expect(await countOtherEffectiveAdmins(sql, other, ['nope'])).toBe(baseline);
        });

        it('countEffectiveAdmins counts ALL effective admins (no exclusion)', async () => {
            await sql`UPDATE users SET is_admin = false, groups = NULL`;
            await sql`DELETE FROM user_access_groups`;
            await sql`DELETE FROM access_groups WHERE is_system = false`;
            expect(await countEffectiveAdmins(sql, ADMIN_NAMES)).toBe(0);

            const a = generateTestUserId();
            await ensureTestUser(sql, a);
            const id = await makeGroup('AdminCap');
            await insertAccessGroupCapabilities(sql, id, [{ capability: 'admin', value: null }]);
            await addAccessGroupMember(sql, id, a, null);
            expect(await countEffectiveAdmins(sql, ADMIN_NAMES)).toBe(1);
        });

        it('countOtherEffectiveAdmins excludes disabled users', async () => {
            // Measure baseline (other tests in this DB may have left admin rows),
            // then assert that adding a DISABLED admin does not increase the count.
            const other = generateTestUserId();
            await ensureTestUser(sql, other);
            const baseline = await countOtherEffectiveAdmins(sql, other, ADMIN_NAMES);

            const a = generateTestUserId();
            await ensureTestUser(sql, a);
            await sql`UPDATE users SET is_admin = true, admin_pinned = true, disabled_at = NOW() WHERE id = ${a}::uuid`;

            // Disabled admin must not be counted → count unchanged.
            expect(await countOtherEffectiveAdmins(sql, other, ADMIN_NAMES)).toBe(baseline);
        });
    });

    it('seeded system admins group exists with admin capability', async () => {
        const admins = await getAccessGroupByName(sql, 'admins');
        expect(admins).not.toBeNull();
        expect(admins?.is_system).toBe(true);
        const full = await getAccessGroupById(sql, admins!.id);
        expect((full?.capabilities ?? []).map((c) => c.capability)).toContain('admin');
        // listAccessGroups surfaces it
        const all = await listAccessGroups(sql);
        expect(all.some((g) => g.name === 'admins')).toBe(true);
    });
});
