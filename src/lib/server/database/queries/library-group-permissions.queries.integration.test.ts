// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Library Group Permissions Query Module
 *
 * Tests CRUD operations on the library_group_permissions table.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';

import {
    getAllLibraryGroupPermissions,
    upsertLibraryGroupPermission,
    deleteLibraryGroupPermission,
} from './library-group-permissions.queries.js';

describe('Library Group Permissions Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['library_group_permissions', 'library_groups']);
    });

    async function createLibraryGroup(id: string): Promise<void> {
        await sql`
            INSERT INTO library_groups (id, name)
            VALUES (${id}, 'Test Group')
            ON CONFLICT DO NOTHING
        `;
    }

    // ========================================================================
    // getAllLibraryGroupPermissions
    // ========================================================================

    describe('getAllLibraryGroupPermissions', () => {
        it('returns empty array when no permissions exist', async () => {
            const result = await getAllLibraryGroupPermissions(sql);
            expect(result).toEqual([]);
        });

        it('returns all permission rows', async () => {
            await createLibraryGroup('00000000-0000-0000-0000-000000000001');
            await createLibraryGroup('00000000-0000-0000-0000-000000000002');
            await sql`
                INSERT INTO library_group_permissions (library_group_id, allowed_groups)
                VALUES ('00000000-0000-0000-0000-000000000001', ${['group-a', 'group-b']})
            `;
            await sql`
                INSERT INTO library_group_permissions (library_group_id, allowed_groups)
                VALUES ('00000000-0000-0000-0000-000000000002', ${['admin']})
            `;

            const result = await getAllLibraryGroupPermissions(sql);
            expect(result).toHaveLength(2);

            const ids = result.map((r) => r.library_group_id);
            expect(ids).toContain('00000000-0000-0000-0000-000000000001');
            expect(ids).toContain('00000000-0000-0000-0000-000000000002');
        });

        it('includes allowed_groups array in results', async () => {
            await createLibraryGroup('00000000-0000-0000-0000-000000000003');
            await sql`
                INSERT INTO library_group_permissions (library_group_id, allowed_groups)
                VALUES ('00000000-0000-0000-0000-000000000003', ${['users']})
            `;

            const result = await getAllLibraryGroupPermissions(sql);
            expect(result[0].allowed_groups).toEqual(['users']);
        });
    });

    // ========================================================================
    // upsertLibraryGroupPermission
    // ========================================================================

    describe('upsertLibraryGroupPermission', () => {
        it('inserts a new permission row', async () => {
            await createLibraryGroup('00000000-0000-0000-0000-000000000004');
            await upsertLibraryGroupPermission(sql, {
                libraryGroupId: '00000000-0000-0000-0000-000000000004',
                allowedGroups: ['family', 'kids'],
            });

            const rows = await getAllLibraryGroupPermissions(sql);
            expect(rows).toHaveLength(1);
            expect(rows[0].allowed_groups).toEqual(['family', 'kids']);
        });

        it('updates existing permission on conflict', async () => {
            const groupId = '00000000-0000-0000-0000-000000000005';
            await createLibraryGroup(groupId);

            await upsertLibraryGroupPermission(sql, {
                libraryGroupId: groupId,
                allowedGroups: ['old-group'],
            });

            await upsertLibraryGroupPermission(sql, {
                libraryGroupId: groupId,
                allowedGroups: ['new-group'],
            });

            const rows = await getAllLibraryGroupPermissions(sql);
            expect(rows).toHaveLength(1);
            expect(rows[0].allowed_groups).toEqual(['new-group']);
        });

        it('allows empty allowed_groups array', async () => {
            const groupId = '00000000-0000-0000-0000-000000000006';
            await createLibraryGroup(groupId);

            await upsertLibraryGroupPermission(sql, {
                libraryGroupId: groupId,
                allowedGroups: [],
            });

            const rows = await getAllLibraryGroupPermissions(sql);
            expect(rows[0].allowed_groups).toEqual([]);
        });

        it('updates updated_at timestamp', async () => {
            const groupId = '00000000-0000-0000-0000-000000000007';
            await createLibraryGroup(groupId);

            await upsertLibraryGroupPermission(sql, {
                libraryGroupId: groupId,
                allowedGroups: ['a'],
            });

            const firstRows = await getAllLibraryGroupPermissions(sql);
            const firstUpdated = firstRows[0].updated_at;

            await new Promise((r) => setTimeout(r, 50));

            await upsertLibraryGroupPermission(sql, {
                libraryGroupId: groupId,
                allowedGroups: ['b'],
            });

            const secondRows = await getAllLibraryGroupPermissions(sql);
            expect(secondRows[0].updated_at.getTime()).toBeGreaterThan(firstUpdated.getTime());
        });
    });

    // ========================================================================
    // deleteLibraryGroupPermission
    // ========================================================================

    describe('deleteLibraryGroupPermission', () => {
        it('deletes a permission row', async () => {
            const groupId = '00000000-0000-0000-0000-000000000008';
            await createLibraryGroup(groupId);

            await upsertLibraryGroupPermission(sql, {
                libraryGroupId: groupId,
                allowedGroups: ['a'],
            });

            let rows = await getAllLibraryGroupPermissions(sql);
            expect(rows).toHaveLength(1);

            await deleteLibraryGroupPermission(sql, groupId);

            rows = await getAllLibraryGroupPermissions(sql);
            expect(rows).toHaveLength(0);
        });

        it('is a no-op when row does not exist', async () => {
            await expect(
                deleteLibraryGroupPermission(sql, '00000000-0000-0000-0000-000000000999'),
            ).resolves.toBeUndefined();
        });
    });
});
