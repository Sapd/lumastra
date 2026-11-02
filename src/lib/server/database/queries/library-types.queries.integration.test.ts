// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Library Types Query Module
 *
 * Tests getActiveLibraryTypes and getActiveNonEntertainmentLibraries.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';

import {
    getActiveLibraryTypes,
    getActiveNonEntertainmentLibraries,
} from './library-types.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';

// These match NON_ENTERTAINMENT_LIBRARY_TYPES from shared/media-types
const _NON_ENTERTAINMENT_TYPES = ['home_video', 'training', 'educational', 'personal'];

describe('Library Types Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        // Clean up on the way OUT as well, not just on the way in. This file
        // only TRUNCATEd in beforeEach, so the LAST test's rows survived the
        // file — leaving 2 library_paths rows in the shared lumastra_tests DB.
        // library_paths.library_group_id FKs library_groups ON DELETE RESTRICT,
        // so those orphans made the unscoped `DELETE FROM library_groups` in
        // the sonic-queue / sonic-taste / sonic-fingerprint / mood-vector
        // fixtures throw 23503, failing 14 tests in 4 unrelated files depending
        // on file order.
        await sql.unsafe(
            'TRUNCATE TABLE library_paths, library_type_settings, library_groups RESTART IDENTITY CASCADE',
        );
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql.unsafe(
            'TRUNCATE TABLE library_paths, library_type_settings, library_groups RESTART IDENTITY CASCADE',
        );
    });

    async function createLibraryGroup(): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name)
            VALUES ('Test Group')
            RETURNING id
        `;
        return row.id;
    }

    // ========================================================================
    // getActiveLibraryTypes
    // ========================================================================

    describe('getActiveLibraryTypes', () => {
        it('returns an empty array when no library paths exist', async () => {
            const types = await getActiveLibraryTypes(sql);
            expect(types).toEqual([]);
        });

        it('returns distinct enabled media types', async () => {
            const groupId = await createLibraryGroup();
            await sql`
                INSERT INTO library_paths (id, media_type, path, enabled, library_group_id)
                VALUES
                    (gen_random_uuid(), 'movie', '/movies', true, ${groupId}),
                    (gen_random_uuid(), 'tv', '/tv', true, ${groupId}),
                    (gen_random_uuid(), 'movie', '/movies2', true, ${groupId})
            `;

            const types = await getActiveLibraryTypes(sql);
            expect(types.sort()).toEqual(['movie', 'tv']);
        });

        it('ignores disabled library paths', async () => {
            const groupId = await createLibraryGroup();
            await sql`
                INSERT INTO library_paths (id, media_type, path, enabled, library_group_id)
                VALUES
                    (gen_random_uuid(), 'movie', '/movies', true, ${groupId}),
                    (gen_random_uuid(), 'tv', '/tv', false, ${groupId})
            `;

            const types = await getActiveLibraryTypes(sql);
            expect(types).toEqual(['movie']);
        });
    });

    // ========================================================================
    // getActiveNonEntertainmentLibraries
    // ========================================================================

    describe('getActiveNonEntertainmentLibraries', () => {
        it('returns an empty array when no matching paths exist', async () => {
            const libs = await getActiveNonEntertainmentLibraries(sql, unrestrictedAccess());
            expect(libs).toEqual([]);
        });

        it('returns non-entertainment types with joined settings', async () => {
            const pathId = crypto.randomUUID();
            const groupId = await createLibraryGroup();
            await sql`
                INSERT INTO library_paths (id, media_type, path, enabled, library_group_id)
                VALUES (${pathId}::uuid, 'home_video', '/home_videos', true, ${groupId})
            `;
            await sql`
                INSERT INTO library_type_settings (media_type, display_name, sidebar_visible, icon, sort_order)
                VALUES ('home_video', 'Home Videos', true, 'video', 1)
            `;

            const libs = await getActiveNonEntertainmentLibraries(sql, unrestrictedAccess());
            expect(libs).toHaveLength(1);
            expect(libs[0].media_type).toBe('home_video');
            expect(libs[0].display_name).toBe('Home Videos');
            expect(libs[0].sidebar_visible).toBe(true);
            expect(libs[0].icon).toBe('video');
            expect(libs[0].sort_order).toBe(1);
        });

        it('uses defaults when no library_type_settings row exists', async () => {
            const groupId = await createLibraryGroup();
            await sql`
                INSERT INTO library_paths (id, media_type, path, enabled, library_group_id)
                VALUES (${crypto.randomUUID()}::uuid, 'training', '/training', true, ${groupId})
            `;

            const libs = await getActiveNonEntertainmentLibraries(sql, unrestrictedAccess());
            expect(libs).toHaveLength(1);
            expect(libs[0].media_type).toBe('training');
            expect(libs[0].display_name).toBeNull();
            expect(libs[0].sidebar_visible).toBe(true);
            expect(libs[0].icon).toBeNull();
            expect(libs[0].sort_order).toBe(0);
        });

        it('ignores entertainment media types', async () => {
            const groupId = await createLibraryGroup();
            await sql`
                INSERT INTO library_paths (id, media_type, path, enabled, library_group_id)
                VALUES
                    (gen_random_uuid(), 'movie', '/movies', true, ${groupId}),
                    (gen_random_uuid(), 'tv', '/tv', true, ${groupId})
            `;

            const libs = await getActiveNonEntertainmentLibraries(sql, unrestrictedAccess());
            expect(libs).toEqual([]);
        });

        it('ignores disabled paths', async () => {
            const groupId = await createLibraryGroup();
            await sql`
                INSERT INTO library_paths (id, media_type, path, enabled, library_group_id)
                VALUES (gen_random_uuid(), 'educational', '/edu', false, ${groupId})
            `;

            const libs = await getActiveNonEntertainmentLibraries(sql, unrestrictedAccess());
            expect(libs).toEqual([]);
        });
    });

    // ========================================================================
    // Access boundary — differential coverage
    //
    // These run the SAME query against the SAME fixture under three boundaries
    // and compare the results to each other. That is what catches a boundary
    // argument which arrived but was never used: an ignored argument makes the
    // restricted run equal the unrestricted run, and makes denyAll non-empty.
    // ========================================================================

    describe('getActiveNonEntertainmentLibraries — access boundary', () => {
        async function createNamedGroup(name: string): Promise<string> {
            const [row] = await sql<{ id: string }[]>`
                INSERT INTO library_groups (name) VALUES (${name}) RETURNING id
            `;
            return row.id;
        }

        /** Two non-entertainment libraries in two distinct library groups. */
        async function seedTwoGroups(): Promise<{ allowedId: string; deniedId: string }> {
            const allowedId = await createNamedGroup('Allowed Group');
            const deniedId = await createNamedGroup('Denied Group');
            await sql`
                INSERT INTO library_paths (id, media_type, path, enabled, library_group_id)
                VALUES
                    (gen_random_uuid(), 'training', '/training', true, ${allowedId}),
                    (gen_random_uuid(), 'personal', '/personal', true, ${deniedId})
            `;
            return { allowedId, deniedId };
        }

        it('restricted result is a strict subset of the unrestricted result', async () => {
            const { deniedId } = await seedTwoGroups();

            const unrestricted = await getActiveNonEntertainmentLibraries(
                sql,
                unrestrictedAccess(),
            );
            const restricted = await getActiveNonEntertainmentLibraries(
                sql,
                restrictedAccess({
                    deniedGroupIds: [deniedId],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
            );

            const unrestrictedTypes = unrestricted.map((l) => l.media_type).sort();
            const restrictedTypes = restricted.map((l) => l.media_type).sort();

            expect(unrestrictedTypes).toEqual(['personal', 'training']);
            // Subset...
            for (const t of restrictedTypes) expect(unrestrictedTypes).toContain(t);
            // ...and STRICTLY so. Without this the test passes on an ignored argument.
            expect(restrictedTypes.length).toBeLessThan(unrestrictedTypes.length);
            expect(restrictedTypes).toEqual(['training']);
        });

        it('a denyAll boundary returns an empty list', async () => {
            await seedTwoGroups();

            const unrestricted = await getActiveNonEntertainmentLibraries(
                sql,
                unrestrictedAccess(),
            );
            expect(unrestricted.length).toBeGreaterThan(0);

            expect(await getActiveNonEntertainmentLibraries(sql, denyAllAccess())).toEqual([]);
        });

        it('a denyGroups boundary listing no denied group behaves like unrestricted', async () => {
            await seedTwoGroups();

            const unrestricted = await getActiveNonEntertainmentLibraries(
                sql,
                unrestrictedAccess(),
            );
            // restrictedAccess collapses an empty denied list to { kind: 'all' } —
            // matching the legacy builders, which emitted no predicate for [].
            const emptyDenied = await getActiveNonEntertainmentLibraries(
                sql,
                restrictedAccess({
                    deniedGroupIds: [],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
            );

            expect(emptyDenied.map((l) => l.media_type).sort()).toEqual(
                unrestricted.map((l) => l.media_type).sort(),
            );
        });

        it('an age-only restriction does not hide libraries (library_paths carry no age)', async () => {
            await seedTwoGroups();

            const unrestricted = await getActiveNonEntertainmentLibraries(
                sql,
                unrestrictedAccess(),
            );
            const ageLimited = await getActiveNonEntertainmentLibraries(
                sql,
                restrictedAccess({
                    deniedGroupIds: [],
                    maxAgeRating: 12,
                    allowUnrated: false,
                }),
            );

            expect(ageLimited.map((l) => l.media_type).sort()).toEqual(
                unrestricted.map((l) => l.media_type).sort(),
            );
        });

        it('denying every group empties the list', async () => {
            const { allowedId, deniedId } = await seedTwoGroups();

            const restricted = await getActiveNonEntertainmentLibraries(
                sql,
                restrictedAccess({
                    deniedGroupIds: [allowedId, deniedId],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
            );

            expect(restricted).toEqual([]);
        });
    });
});
