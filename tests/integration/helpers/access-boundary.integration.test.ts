// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the shared differential access-boundary helper
 * (`tests/integration/helpers/access-boundary.ts`).
 *
 * This is the FOUNDATION unit of effort E5. It has two responsibilities:
 *
 *   1. `expectAccessFiltered` — the differential invariant itself (positive
 *      control + strict subset + deny-empty). Exercised here with a controlled
 *      fake `run` so every branch, including each FAILURE mode, is pinned
 *      without a database.
 *   2. `denyGroups` / `ageLimit` boundary constructors and
 *      `createLibraryGroup` / `insertItemInGroup` / `attachFile` fixture
 *      helpers — verified against the real test database, plus one true drop-in
 *      case driving `searchMedia` through `expectAccessFiltered`.
 *
 * Run with:
 *   npm run test:integration -- tests/integration/helpers/access-boundary.integration.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../setup/test-database.js';
import { truncateTables, TEST_TABLES } from './cleanup.js';
import {
    isUnrestricted,
    deniesEverything,
    type MediaAccessBoundary,
} from '$lib/server/database/queries/builders/media-access-boundary';
import { searchMedia } from '../../../src/lib/server/database/queries/search.queries.js';
import {
    expectAccessFiltered,
    denyGroups,
    ageLimit,
    createLibraryGroup,
    insertItemInGroup,
    attachFile,
} from './access-boundary.js';

// A token unique enough that FTS/trigram cannot collide with other fixtures.
const TAG = 'Qxrbulnov';

// =============================================================================
// Pure invariant logic — no database
// =============================================================================

/**
 * Build a fake `run` that answers the three calls `expectAccessFiltered`
 * makes purely from the boundary shape it is handed.
 */
function fakeRun<T>(
    open: T[],
    narrowed: T[],
    denied: T[],
): (access: MediaAccessBoundary) => Promise<T[]> {
    return (access) => {
        if (deniesEverything(access)) return Promise.resolve(denied);
        if (isUnrestricted(access)) return Promise.resolve(open);
        return Promise.resolve(narrowed);
    };
}

describe('access-boundary helper — boundary constructors', () => {
    it('denyGroups() denies the listed groups and leaves age unrestricted', () => {
        const b = denyGroups('g1', 'g2');
        expect(b.library).toEqual({ kind: 'denyGroups', ids: ['g1', 'g2'] });
        expect(b.age).toEqual({ kind: 'any' });
    });

    it('ageLimit() caps the age axis and leaves the library unrestricted', () => {
        const b = ageLimit(12);
        expect(b.library).toEqual({ kind: 'all' });
        expect(b.age).toEqual({ kind: 'limit', maxAgeRating: 12, allowUnrated: false });
    });
});

describe('access-boundary helper — expectAccessFiltered invariant', () => {
    it('returns { open, narrowed } when the restricted result is a strict subset', async () => {
        const result = await expectAccessFiltered(
            fakeRun([{ k: 'a' }, { k: 'b' }], [{ k: 'a' }], []),
            (r) => r.k,
            denyGroups('g'),
        );
        expect(result).toEqual({ open: ['a', 'b'], narrowed: ['a'] });
    });

    it('fails the positive control when the unrestricted result is empty', async () => {
        await expect(
            expectAccessFiltered(fakeRun<{ k: string }>([], [], []), (r) => r.k, denyGroups('g')),
        ).rejects.toThrow();
    });

    it('fails when the restricted result introduces a row absent from the open set', async () => {
        await expect(
            expectAccessFiltered(
                fakeRun([{ k: 'a' }, { k: 'b' }], [{ k: 'c' }], []),
                (r) => r.k,
                denyGroups('g'),
            ),
        ).rejects.toThrow();
    });

    it('fails when the restricted result drops nothing (not a strict subset)', async () => {
        await expect(
            expectAccessFiltered(
                fakeRun([{ k: 'a' }, { k: 'b' }], [{ k: 'a' }, { k: 'b' }], []),
                (r) => r.k,
                denyGroups('g'),
            ),
        ).rejects.toThrow();
    });

    it('fails when denyAll returns a non-empty result', async () => {
        await expect(
            expectAccessFiltered(
                fakeRun([{ k: 'a' }, { k: 'b' }], [{ k: 'a' }], [{ k: 'a' }]),
                (r) => r.k,
                denyGroups('g'),
            ),
        ).rejects.toThrow();
    });
});

// =============================================================================
// DB-backed fixtures + drop-in proof
// =============================================================================

describe('access-boundary helper — fixtures against the test database', () => {
    let sql: postgres.Sql;
    let groupA: string;
    let groupB: string;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        groupA = await createLibraryGroup(sql, 'Group A');
        groupB = await createLibraryGroup(sql, 'Group B');
    });

    it('createLibraryGroup inserts a library_groups row and returns its id', async () => {
        const rows = await sql<Array<{ name: string }>>`
            SELECT name FROM library_groups WHERE id = ${groupA}::uuid
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe('Group A');
    });

    it('insertItemInGroup wires the item to a file in the requested group', async () => {
        const id = await insertItemInGroup(sql, {
            title: `${TAG} Solo`,
            mediaType: 'movie',
            libraryGroupId: groupA,
        });

        const [item] = await sql<Array<{ has_files: boolean }>>`
            SELECT has_files FROM media_items WHERE id = ${id}::uuid
        `;
        expect(item.has_files).toBe(true);

        const [file] = await sql<Array<{ library_group_id: string }>>`
            SELECT mf.library_group_id
            FROM media_files mf
            JOIN media_file_items mfi ON mfi.file_id = mf.id
            WHERE mfi.media_item_id = ${id}::uuid
        `;
        expect(file.library_group_id).toBe(groupA);
    });

    it('attachFile links a media_files row (with group) to an existing item', async () => {
        const id = await insertItemInGroup(sql, {
            title: `${TAG} Rewire`,
            mediaType: 'movie',
            libraryGroupId: null,
        });
        await attachFile(sql, id, groupB);

        const rows = await sql<Array<{ library_group_id: string | null }>>`
            SELECT mf.library_group_id
            FROM media_files mf
            JOIN media_file_items mfi ON mfi.file_id = mf.id
            WHERE mfi.media_item_id = ${id}::uuid
        `;
        expect(rows.some((r) => r.library_group_id === groupB)).toBe(true);
    });

    it('drives a real query (searchMedia) through expectAccessFiltered end-to-end', async () => {
        await insertItemInGroup(sql, {
            title: `${TAG} Alpha`,
            mediaType: 'movie',
            libraryGroupId: groupA,
        });
        await insertItemInGroup(sql, {
            title: `${TAG} Beta`,
            mediaType: 'movie',
            libraryGroupId: groupB,
        });

        const { narrowed } = await expectAccessFiltered(
            (access) => searchMedia(sql, TAG, access, { availableOnly: true }),
            (r) => String(r.internal_id),
            denyGroups(groupA),
        );
        expect(narrowed).toHaveLength(1);
    });
});
