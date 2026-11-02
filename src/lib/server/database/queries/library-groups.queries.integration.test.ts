// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Library Groups Query Module
 *
 * Tests CRUD operations and group counting queries for library_groups.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    getAllLibraryGroups,
    getLibraryGroupById,
    createLibraryGroup,
    updateLibraryGroup,
    deleteLibraryGroup,
    getLibraryGroupsWithCounts,
} from './library-groups.queries.js';

describe('Library Groups Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'media_file_items',
            'media_files',
            'media_items',
            'library_groups',
        ]);
    });

    // ========================================================================
    // getAllLibraryGroups
    // ========================================================================

    describe('getAllLibraryGroups', () => {
        it('returns empty array when no groups exist', async () => {
            const result = await getAllLibraryGroups(sql);
            expect(result).toEqual([]);
        });

        it('returns groups ordered by sort_order then name', async () => {
            await createLibraryGroup(sql, {
                name: 'Z Group',
                sort_order: 1,
            });
            await createLibraryGroup(sql, {
                name: 'A Group',
                sort_order: 0,
            });

            const result = await getAllLibraryGroups(sql);
            expect(result).toHaveLength(2);
            expect(result[0].name).toBe('A Group');
            expect(result[1].name).toBe('Z Group');
        });
    });

    // ========================================================================
    // getLibraryGroupById
    // ========================================================================

    describe('getLibraryGroupById', () => {
        it('returns group by id', async () => {
            const created = await createLibraryGroup(sql, {
                name: 'Test Group',
                description: 'A test group',
            });

            const result = await getLibraryGroupById(sql, created.id);

            expect(result).not.toBeNull();
            expect(result!.id).toBe(created.id);
            expect(result!.name).toBe('Test Group');
            expect(result!.description).toBe('A test group');
        });

        it('returns null for non-existent id', async () => {
            const result = await getLibraryGroupById(sql, '00000000-0000-0000-0000-000000000000');
            expect(result).toBeNull();
        });
    });

    // ========================================================================
    // createLibraryGroup
    // ========================================================================

    describe('createLibraryGroup', () => {
        it('creates a group with all fields', async () => {
            const result = await createLibraryGroup(sql, {
                name: 'Full Group',
                description: 'Desc',
                icon: 'film',
                sort_order: 5,
                max_age_rating: 13,
                metadata_provider_chain: ['aggregated', 'tmdb'],
            });

            expect(result.id).toBeTruthy();
            expect(result.name).toBe('Full Group');
            expect(result.description).toBe('Desc');
            expect(result.icon).toBe('film');
            expect(result.sort_order).toBe(5);
            expect(result.max_age_rating).toBe(13);
            expect(result.metadata_provider_chain).toEqual(['aggregated', 'tmdb']);
        });

        it('uses defaults for optional fields', async () => {
            const result = await createLibraryGroup(sql, {
                name: 'Minimal Group',
            });

            expect(result.name).toBe('Minimal Group');
            expect(result.sort_order).toBe(0);
            expect(result.max_age_rating).toBeNull();
            expect(result.metadata_provider_chain).toBeNull();
            // display_name defaults to name when omitted.
            expect(result.display_name).toBe('Minimal Group');
        });

        it('stores an explicit display_name distinct from name', async () => {
            const result = await createLibraryGroup(sql, {
                name: 'Movies',
                display_name: 'My Movies',
            });

            expect(result.name).toBe('Movies');
            expect(result.display_name).toBe('My Movies');
        });

        it('stores field_priority_overrides as JSONB', async () => {
            const overrides = { poster_path: ['jellyfin', 'tmdb'] };
            const result = await createLibraryGroup(sql, {
                name: 'Overrides Group',
                field_priority_overrides: overrides,
            });

            expect(result.field_priority_overrides).toEqual(overrides);
        });
    });

    // ========================================================================
    // updateLibraryGroup
    // ========================================================================

    describe('updateLibraryGroup', () => {
        it('updates specified fields only', async () => {
            const created = await createLibraryGroup(sql, {
                name: 'Original',
                description: 'Original desc',
                sort_order: 1,
            });

            const updated = await updateLibraryGroup(sql, created.id, {
                name: 'Updated',
                sort_order: 2,
            });

            expect(updated).not.toBeNull();
            expect(updated!.name).toBe('Updated');
            expect(updated!.description).toBe('Original desc'); // Unchanged
            expect(updated!.sort_order).toBe(2);
            expect(updated!.display_name).toBe('Original'); // Unchanged (defaulted at insert)
        });

        it('updates display_name independently of name', async () => {
            const created = await createLibraryGroup(sql, { name: 'Movies' });

            const updated = await updateLibraryGroup(sql, created.id, {
                display_name: 'Renamed Label',
            });

            expect(updated!.name).toBe('Movies'); // Unchanged
            expect(updated!.display_name).toBe('Renamed Label');
        });

        it('returns null for non-existent id', async () => {
            const result = await updateLibraryGroup(sql, '00000000-0000-0000-0000-000000000000', {
                name: 'Nope',
            });
            expect(result).toBeNull();
        });

        it('updates field_priority_overrides', async () => {
            const created = await createLibraryGroup(sql, {
                name: 'To Update',
            });

            const overrides = { overview: ['mdblist', 'tmdb'] };
            const updated = await updateLibraryGroup(sql, created.id, {
                field_priority_overrides: overrides,
            });

            expect(updated!.field_priority_overrides).toEqual(overrides);
        });
    });

    // ========================================================================
    // deleteLibraryGroup
    // ========================================================================

    describe('deleteLibraryGroup', () => {
        it('deletes a group and returns true', async () => {
            const created = await createLibraryGroup(sql, {
                name: 'To Delete',
            });

            const deleted = await deleteLibraryGroup(sql, created.id);
            expect(deleted).toBe(true);

            const remaining = await getLibraryGroupById(sql, created.id);
            expect(remaining).toBeNull();
        });

        it('returns false for non-existent id', async () => {
            const result = await deleteLibraryGroup(sql, '00000000-0000-0000-0000-000000000000');
            expect(result).toBe(false);
        });
    });

    // ========================================================================
    // getLibraryGroupsWithCounts
    // ========================================================================

    describe('getLibraryGroupsWithCounts', () => {
        it('returns groups with item counts', async () => {
            const group = await createLibraryGroup(sql, {
                name: 'Count Group',
            });

            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            // Link file to group
            const [fileRow] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, library_group_id)
                VALUES ('/movies/test.mkv', ${group.id}::uuid)
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileRow.id}::uuid, ${item.id}::uuid)
            `;
            await sql`
                UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid
            `;

            const result = await getLibraryGroupsWithCounts(sql);
            const found = result.find((r) => r.id === group.id);

            expect(found).toBeDefined();
            expect(found!.item_count).toBe(1);
        });

        it('filters out denied group IDs', async () => {
            const group1 = await createLibraryGroup(sql, { name: 'Allowed' });
            const group2 = await createLibraryGroup(sql, { name: 'Denied' });

            // Add an item to group1 so it shows up in results
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const [fileRow] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, library_group_id)
                VALUES ('/movies/allowed.mkv', ${group1.id}::uuid)
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileRow.id}::uuid, ${item.id}::uuid)
            `;
            await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;

            const result = await getLibraryGroupsWithCounts(sql, [group2.id]);
            const ids = result.map((r) => r.id);

            expect(ids).toContain(group1.id);
            expect(ids).not.toContain(group2.id);
        });

        it('filters by max_age_rating', async () => {
            const group = await createLibraryGroup(sql, {
                name: 'Adult Group',
                max_age_rating: 18,
            });

            // User with max age rating 13 should not see this
            const result = await getLibraryGroupsWithCounts(sql, null, 13);
            const found = result.find((r) => r.id === group.id);

            // max_age_rating 18 > 13, so should be filtered out
            expect(found).toBeUndefined();
        });

        it('includes group when max_age_rating is null', async () => {
            const group = await createLibraryGroup(sql, {
                name: 'Unrated Group',
                max_age_rating: null,
            });

            // Add an item so the group passes the HAVING clause
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const [fileRow] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, library_group_id)
                VALUES ('/movies/unrated.mkv', ${group.id}::uuid)
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileRow.id}::uuid, ${item.id}::uuid)
            `;
            await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;

            const result = await getLibraryGroupsWithCounts(sql, null, 13);
            const found = result.find((r) => r.id === group.id);

            expect(found).toBeDefined();
        });

        it('excludes groups with no items (HAVING clause)', async () => {
            const group = await createLibraryGroup(sql, {
                name: 'Empty Group',
            });

            const result = await getLibraryGroupsWithCounts(sql);
            const found = result.find((r) => r.id === group.id);

            expect(found).toBeUndefined();
        });
    });

    // ========================================================================
    // getLibraryGroupsWithCounts — file-less libraries
    // ========================================================================

    /**
     * Group membership has TWO sources and only one of them sees every library.
     *
     * `media_files.library_group_id` is the primary source, but AudiobookShelf-backed
     * items carry no media_files rows at all — their bytes live upstream. Reaching
     * media_items only through that join meant those groups produced no rows, the
     * HAVING dropped them from the result entirely, and the admin media browser's
     * LIBRARY selector (which filters groups by `media_types`) had nothing to render
     * in the audiobook domain. Measured on production: two groups holding 536 and
     * 673 real audiobooks were both absent.
     *
     * `media_items.library_group_id` is the fallback, and it is deliberately gated on
     * the group having NO file-linked items whatsoever. It holds ROOTS, so applying it
     * unconditionally would contaminate every file-backed group.
     */
    describe('getLibraryGroupsWithCounts — file-less libraries', () => {
        /** Direct group assignment; the fixture factory does not carry the column. */
        async function assignToGroup(itemId: string, groupId: string): Promise<void> {
            await sql`
                UPDATE media_items SET library_group_id = ${groupId}::uuid WHERE id = ${itemId}::uuid
            `;
        }

        /** A file in `groupId`, linked to `itemId`, and the item marked playable. */
        async function attachFile(itemId: string, groupId: string, path: string): Promise<void> {
            const [fileRow] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, library_group_id)
                VALUES (${path}, ${groupId}::uuid)
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileRow.id}::uuid, ${itemId}::uuid)
            `;
            await sql`UPDATE media_items SET has_files = true WHERE id = ${itemId}::uuid`;
        }

        it('reports media types and item count for a group whose items have no files', async () => {
            const group = await createLibraryGroup(sql, { name: 'Hoerbuecher' });

            // ABS marks playable books has_files = true despite owning no file rows.
            for (const title of ['Book One', 'Book Two']) {
                const book = createTestMediaItem({
                    media_type: 'audiobook',
                    title,
                    has_files: true,
                });
                await insertTestMediaItem(sql, book);
                await assignToGroup(book.id, group.id);
            }

            const result = await getLibraryGroupsWithCounts(sql);
            const found = result.find((r) => r.id === group.id);

            expect(found).toBeDefined();
            expect(found!.item_count).toBe(2);
            expect(found!.media_types).toEqual(['audiobook']);
        });

        it('does not let the fallback add items or types to a file-backed group', async () => {
            const group = await createLibraryGroup(sql, { name: 'Mixed' });

            // One file-linked movie — this alone makes the group file-backed.
            const movie = createTestMediaItem({ media_type: 'movie', title: 'Filed Movie' });
            await insertTestMediaItem(sql, movie);
            await attachFile(movie.id, group.id, '/movies/filed.mkv');
            // ...and it is ALSO directly assigned, the both-paths case.
            await assignToGroup(movie.id, group.id);

            // A file-less audiobook directly assigned to the SAME group. The
            // fallback must stay shut here, or a file-backed group's numbers move.
            const book = createTestMediaItem({
                media_type: 'audiobook',
                title: 'Unfiled Book',
                has_files: true,
            });
            await insertTestMediaItem(sql, book);
            await assignToGroup(book.id, group.id);

            const result = await getLibraryGroupsWithCounts(sql);
            const found = result.find((r) => r.id === group.id);

            expect(found).toBeDefined();
            // The movie counts ONCE despite being reachable both ways, and the
            // directly-assigned audiobook does not join it.
            expect(found!.item_count).toBe(1);
            expect(found!.media_types).toEqual(['movie']);
        });

        it('keeps browsable_item_count at zero for a file-less group of browsable-typed items', async () => {
            const group = await createLibraryGroup(sql, { name: 'Fileless Series' });

            // media_type 'tv' + has_files = true clears both of browsable's own
            // predicates. Only the file-membership gate keeps it out — and it must,
            // because every library-scoped browse query joins media_files to resolve
            // the group, so this library returns nothing in A-Z.
            const series = createTestMediaItem({
                media_type: 'tv',
                title: 'Fileless Show',
                has_files: true,
            });
            await insertTestMediaItem(sql, series);
            await assignToGroup(series.id, group.id);

            const result = await getLibraryGroupsWithCounts(sql);
            const found = result.find((r) => r.id === group.id);

            expect(found).toBeDefined();
            expect(found!.item_count).toBe(1);
            expect(found!.media_types).toEqual(['tv']);
            expect(found!.browsable_item_count).toBe(0);
        });

        it('applies the denied-group and age filters to file-less groups too', async () => {
            const denied = await createLibraryGroup(sql, { name: 'Denied Books' });
            const adult = await createLibraryGroup(sql, {
                name: 'Adult Books',
                max_age_rating: 18,
            });
            // The control: file-less, allowed, under the age cap. Without it every
            // assertion here is a not.toContain that a fully broken query satisfies.
            const allowed = await createLibraryGroup(sql, { name: 'Allowed Books' });

            for (const group of [denied, adult, allowed]) {
                const book = createTestMediaItem({
                    media_type: 'audiobook',
                    title: `Book in ${group.name}`,
                    has_files: true,
                });
                await insertTestMediaItem(sql, book);
                await assignToGroup(book.id, group.id);
            }

            const result = await getLibraryGroupsWithCounts(sql, [denied.id], 13);
            const ids = result.map((r) => r.id);

            expect(ids).toContain(allowed.id);
            expect(ids).not.toContain(denied.id);
            expect(ids).not.toContain(adult.id);
        });
    });
});
