// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Non-Entertainment Browse Query Module
 *
 * Tests library-type listings, metadata values, series episodes, and metadata updates.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { createTestMediaItem } from '../../../../../tests/integration/fixtures/index.js';

import {
    listItemsByLibraryType,
    getDistinctMetadataValues,
    countItemsByGroup,
    getSeriesWithEpisodes,
    updateItemCustomMetadata,
} from './non-entertainment-browse.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';

describe('Non-Entertainment Browse Queries', () => {
    let sql: postgres.Sql;
    const MEDIA_TYPE = 'home_video';

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.mediaFiles, ...TEST_TABLES.media]);
    });

    // ========================================================================
    // listItemsByLibraryType
    // ========================================================================

    describe('listItemsByLibraryType', () => {
        it('projects canonical file availability for personal video search', async () => {
            const id = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, has_files)
                VALUES (${id}::uuid, 'A personal video', ${MEDIA_TYPE}, 'active', false)
            `;
            const options = { mediaType: MEDIA_TYPE, access: unrestrictedAccess() };
            expect(
                (await listItemsByLibraryType(sql, options)).items.find((i) => i.id === id)
                    ?.has_files,
            ).toBe(false);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${id}::uuid`;
            expect(
                (await listItemsByLibraryType(sql, options)).items.find((i) => i.id === id)
                    ?.has_files,
            ).toBe(true);
        });

        it('returns items of a given media type', async () => {
            const _item = createTestMediaItem({ media_type: 'movie' }); // Use movie as proxy since custom type may not be in enum
            // Actually let's insert with raw SQL using home_video to avoid type issues
            const id = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, created_at, updated_at)
                VALUES (${id}::uuid, 'Test Home Video', ${MEDIA_TYPE}, 'active', NOW(), NOW())
            `;

            const result = await listItemsByLibraryType(sql, {
                mediaType: MEDIA_TYPE,
                access: unrestrictedAccess(),
            });

            expect(result.items.some((i) => i.id === id)).toBe(true);
            expect(result.total).toBeGreaterThanOrEqual(1);
        });

        it('supports pagination via limit and offset', async () => {
            for (let i = 0; i < 3; i++) {
                const id = crypto.randomUUID();
                await sql`
                    INSERT INTO media_items (id, title, media_type, status, created_at, updated_at)
                    VALUES (${id}::uuid, ${`Video ${i}`}, ${MEDIA_TYPE}, 'active', NOW(), NOW())
                `;
            }

            const result = await listItemsByLibraryType(sql, {
                mediaType: MEDIA_TYPE,
                limit: 2,
                offset: 0,
                access: unrestrictedAccess(),
            });

            expect(result.items.length).toBe(2);
            expect(result.total).toBeGreaterThanOrEqual(3);
        });

        it('returns empty result when no items match', async () => {
            const result = await listItemsByLibraryType(sql, {
                mediaType: 'nonexistent_type_xyz',
                access: unrestrictedAccess(),
            });
            expect(result.items).toEqual([]);
            expect(result.total).toBe(0);
        });
    });

    // ========================================================================
    // getDistinctMetadataValues
    // ========================================================================

    describe('getDistinctMetadataValues', () => {
        it('returns distinct custom_metadata values for a key', async () => {
            const id1 = crypto.randomUUID();
            const id2 = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, custom_metadata, created_at, updated_at)
                VALUES
                    (${id1}::uuid, 'A', ${MEDIA_TYPE}, 'active', ${sql.json({ department: 'Sales' })}, NOW(), NOW()),
                    (${id2}::uuid, 'B', ${MEDIA_TYPE}, 'active', ${sql.json({ department: 'Engineering' })}, NOW(), NOW())
            `;

            const values = await getDistinctMetadataValues(sql, MEDIA_TYPE, 'department', {
                access: unrestrictedAccess(),
            });

            expect(values.sort()).toEqual(['Engineering', 'Sales']);
        });

        it('ignores empty or null values', async () => {
            const id = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, custom_metadata, created_at, updated_at)
                VALUES (${id}::uuid, 'A', ${MEDIA_TYPE}, 'active', ${sql.json({ department: '' })}, NOW(), NOW())
            `;

            const values = await getDistinctMetadataValues(sql, MEDIA_TYPE, 'department', {
                access: unrestrictedAccess(),
            });
            expect(values).toEqual([]);
        });
    });

    // ========================================================================
    // listItemsByLibraryType — metadata filter wiring
    // ========================================================================

    describe('listItemsByLibraryType filters', () => {
        it('filters items by metadata key=value', async () => {
            const idEng = crypto.randomUUID();
            const idHr = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, custom_metadata, created_at, updated_at)
                VALUES
                    (${idEng}::uuid, 'Eng Course', ${MEDIA_TYPE}, 'active', ${sql.json({ department: 'Engineering' })}, NOW(), NOW()),
                    (${idHr}::uuid, 'HR Course', ${MEDIA_TYPE}, 'active', ${sql.json({ department: 'HR' })}, NOW(), NOW())
            `;

            const result = await listItemsByLibraryType(sql, {
                mediaType: MEDIA_TYPE,
                filters: { department: 'Engineering' },
                access: unrestrictedAccess(),
            });

            expect(
                result.items.every(
                    (i) => (i.custom_metadata?.department as string) === 'Engineering',
                ),
            ).toBe(true);
            expect(result.items.some((i) => i.id === idEng)).toBe(true);
            expect(result.items.some((i) => i.id === idHr)).toBe(false);
            expect(result.total).toBeGreaterThanOrEqual(1);
        });
    });

    // ========================================================================
    // countItemsByGroup
    // ========================================================================

    describe('countItemsByGroup', () => {
        it('returns per-group counts for a metadata key', async () => {
            // Insert 3 Engineering + 2 HR items
            for (let i = 0; i < 3; i++) {
                const id = crypto.randomUUID();
                await sql`
                    INSERT INTO media_items (id, title, media_type, status, custom_metadata, created_at, updated_at)
                    VALUES (${id}::uuid, ${`Eng ${i}`}, ${MEDIA_TYPE}, 'active', ${sql.json({ department: 'Engineering' })}, NOW(), NOW())
                `;
            }
            for (let i = 0; i < 2; i++) {
                const id = crypto.randomUUID();
                await sql`
                    INSERT INTO media_items (id, title, media_type, status, custom_metadata, created_at, updated_at)
                    VALUES (${id}::uuid, ${`HR ${i}`}, ${MEDIA_TYPE}, 'active', ${sql.json({ department: 'HR' })}, NOW(), NOW())
                `;
            }

            const groups = await countItemsByGroup(sql, {
                mediaType: MEDIA_TYPE,
                groupKey: 'department',
                access: unrestrictedAccess(),
            });

            const engGroup = groups.find((g) => g.group_value === 'Engineering');
            const hrGroup = groups.find((g) => g.group_value === 'HR');
            expect(engGroup).toBeDefined();
            expect(hrGroup).toBeDefined();
            expect(engGroup!.count).toBeGreaterThanOrEqual(3);
            expect(hrGroup!.count).toBeGreaterThanOrEqual(2);
        });

        it('returns Uncategorized bucket for items without the group key', async () => {
            const id = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, custom_metadata, created_at, updated_at)
                VALUES (${id}::uuid, 'No Dept', ${MEDIA_TYPE}, 'active', ${sql.json({ other: 'value' })}, NOW(), NOW())
            `;

            const groups = await countItemsByGroup(sql, {
                mediaType: MEDIA_TYPE,
                groupKey: 'department',
                access: unrestrictedAccess(),
            });

            const uncatGroup = groups.find((g) => g.group_value === 'Uncategorized');
            expect(uncatGroup).toBeDefined();
            expect(uncatGroup!.count).toBeGreaterThanOrEqual(1);
        });

        it('returns empty array when no items of that media_type exist', async () => {
            const groups = await countItemsByGroup(sql, {
                mediaType: 'nonexistent_type_xyz_group',
                groupKey: 'department',
                access: unrestrictedAccess(),
            });
            expect(groups).toEqual([]);
        });

        it('sorts Uncategorized last, before alphabetically later groups', async () => {
            // Insert: Zoning (alphabetically after U) + item without department (→ Uncategorized)
            const idZoning = crypto.randomUUID();
            const idNoGroup = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, custom_metadata, created_at, updated_at)
                VALUES
                    (${idZoning}::uuid, 'Zoning Item', ${MEDIA_TYPE}, 'active', ${sql.json({ department: 'Zoning' })}, NOW(), NOW()),
                    (${idNoGroup}::uuid, 'No Dept Item', ${MEDIA_TYPE}, 'active', ${sql.json({ other: 'x' })}, NOW(), NOW())
            `;

            const groups = await countItemsByGroup(sql, {
                mediaType: MEDIA_TYPE,
                groupKey: 'department',
                access: unrestrictedAccess(),
            });

            const groupValues = groups.map((g) => g.group_value);
            const zoningIdx = groupValues.indexOf('Zoning');
            const uncatIdx = groupValues.indexOf('Uncategorized');
            expect(zoningIdx).toBeGreaterThanOrEqual(0);
            expect(uncatIdx).toBeGreaterThanOrEqual(0);
            // Uncategorized must come after Zoning (alphabetically Zoning > Uncategorized
            // but the CASE WHEN ordering pushes Uncategorized to the end)
            expect(uncatIdx).toBeGreaterThan(zoningIdx);
        });
    });

    // ========================================================================
    // getSeriesWithEpisodes
    // ========================================================================

    describe('getSeriesWithEpisodes', () => {
        it('returns series and episodes ordered by season and episode', async () => {
            const seriesId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, created_at, updated_at)
                VALUES (${seriesId}::uuid, 'Training Series', ${MEDIA_TYPE}, 'active', NOW(), NOW())
            `;

            const seasonId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, sort_order, status, created_at, updated_at)
                VALUES (${seasonId}::uuid, 'Season 1', 'season', ${seriesId}::uuid, 1, 'active', NOW(), NOW())
            `;

            const ep1 = crypto.randomUUID();
            const ep2 = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, episode_number, status, created_at, updated_at)
                VALUES
                    (${ep1}::uuid, 'Episode 1', 'episode', ${seasonId}::uuid, 1, 'active', NOW(), NOW()),
                    (${ep2}::uuid, 'Episode 2', 'episode', ${seasonId}::uuid, 2, 'active', NOW(), NOW())
            `;

            const result = await getSeriesWithEpisodes(sql, seriesId);
            expect(result.series).not.toBeNull();
            expect(result.series!.id).toBe(seriesId);
            expect(result.series!.has_files).toBe(false);
            expect(result.episodes.length).toBe(2);
            expect(result.episodes[0].id).toBe(ep1);
            expect(result.episodes[1].id).toBe(ep2);
        });

        it("returns each episode's file NAME, never its server path (the row reaches the browser)", async () => {
            const seriesId = crypto.randomUUID();
            const seasonId = crypto.randomUUID();
            const epId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, created_at, updated_at)
                VALUES (${seriesId}::uuid, 'Path Series', ${MEDIA_TYPE}, 'active', NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, sort_order, status, created_at, updated_at)
                VALUES (${seasonId}::uuid, 'Season 1', 'season', ${seriesId}::uuid, 1, 'active', NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, episode_number, status, created_at, updated_at)
                VALUES (${epId}::uuid, 'S01E01', 'episode', ${seasonId}::uuid, 1, 'active', NOW(), NOW())
            `;
            const [{ id: fileId }] = await sql<[{ id: string }]>`
                INSERT INTO media_files (file_path)
                VALUES (${`/srv/private/${epId}/spring-planting.mkv`})
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${epId}::uuid)
            `;

            const { episodes } = await getSeriesWithEpisodes(sql, seriesId);
            expect(episodes).toHaveLength(1);
            expect(episodes[0]).not.toHaveProperty('file_path');
            expect(episodes[0].file_name).toBe('spring-planting.mkv');

            // A Windows-style stored path must not survive either.
            await sql`UPDATE media_files SET file_path = ${`D:\\media\\${epId}\\summer.mkv`}
                      WHERE id = ${fileId}::uuid`;
            const again = await getSeriesWithEpisodes(sql, seriesId);
            expect(again.episodes[0].file_name).toBe('summer.mkv');
        });

        it('returns null series and empty episodes for unknown id', async () => {
            const result = await getSeriesWithEpisodes(sql, crypto.randomUUID());
            expect(result.series).toBeNull();
            expect(result.episodes).toEqual([]);
        });
    });

    // ========================================================================
    // updateItemCustomMetadata
    // ========================================================================

    describe('updateItemCustomMetadata', () => {
        it('merges new metadata into existing', async () => {
            const id = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, custom_metadata, created_at, updated_at)
                VALUES (${id}::uuid, 'Meta Test', ${MEDIA_TYPE}, 'active', ${sql.json({ key1: 'val1' })}, NOW(), NOW())
            `;

            const ok = await updateItemCustomMetadata(sql, id, {
                key2: 'val2',
            });
            expect(ok).toBe(true);

            const row = await sql<{ custom_metadata: Record<string, unknown> }[]>`
                SELECT custom_metadata FROM media_items WHERE id = ${id}::uuid
            `;
            expect(row[0].custom_metadata).toMatchObject({
                key1: 'val1',
                key2: 'val2',
            });
        });

        it('returns false when item does not exist', async () => {
            const ok = await updateItemCustomMetadata(sql, crypto.randomUUID(), { key: 'val' });
            expect(ok).toBe(false);
        });
    });
});

// ============================================================================
// Differential access-boundary tests
// ============================================================================

/**
 * Types guarantee the boundary ARRIVES; they cannot guarantee it is USED, that
 * it lands on the right table alias, or that it sits in the right subquery
 * scope. Each query is therefore run three ways against ONE fixture:
 *
 *   1. `unrestrictedAccess()` — POSITIVE CONTROL. Must be non-empty.
 *   2. a restricted boundary  — must be a STRICT SUBSET of (1).
 *   3. `denyAllAccess()`      — must be EMPTY.
 *
 * `keyOf` is deliberately scoped to the TOP-LEVEL row id. The episode_count /
 * first_episode_id / completed_count LATERALs are not access-gated (see the
 * module header), so widening keyOf to include them would assert a property
 * this module does not currently hold.
 */
describe('non-entertainment browse — access boundary is honoured (differential)', () => {
    let sql: postgres.Sql;
    const MEDIA_TYPE = 'home_video';

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.mediaFiles, ...TEST_TABLES.media]);
    });

    async function createLibraryGroup(name: string): Promise<string> {
        const id = crypto.randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES (${id}::uuid, ${name})`;
        return id;
    }

    /**
     * Insert a top-level non-entertainment item owning a file in `libraryGroupId`.
     * The module's private buildLibraryFilter requires an accessible file on self
     * OR on a descendant episode, so a file-less row would be dropped by ANY
     * library restriction — the fixture must carry a real file.
     */
    async function insertItemWithFile(opts: {
        title: string;
        libraryGroupId: string | null;
        department: string;
        ageRating?: number | null;
    }): Promise<string> {
        const id = crypto.randomUUID();
        await sql`
            INSERT INTO media_items
                (id, title, media_type, status, has_files, age_rating, custom_metadata, created_at, updated_at)
            VALUES (
                ${id}::uuid, ${opts.title}, ${MEDIA_TYPE}, 'active', true,
                ${opts.ageRating ?? null},
                ${sql.json({ department: opts.department })}, NOW(), NOW()
            )
        `;
        const [{ id: fileId }] = await sql<[{ id: string }]>`
            INSERT INTO media_files (file_path, library_group_id)
            VALUES (${`/data/${id}.mkv`}, ${opts.libraryGroupId}::uuid)
            ON CONFLICT (file_path) DO UPDATE SET library_group_id = EXCLUDED.library_group_id
            RETURNING id
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${fileId}::uuid, ${id}::uuid)
            ON CONFLICT DO NOTHING
        `;
        return id;
    }

    /** Run under all three boundaries and assert subset / positive control / empty. */
    async function expectAccessFiltered<T>(
        run: (access: MediaAccessBoundary) => Promise<T[]>,
        keyOf: (row: T) => string,
        restricted: MediaAccessBoundary,
    ): Promise<{ open: string[]; narrowed: string[] }> {
        const open = (await run(unrestrictedAccess())).map(keyOf);
        expect(open.length, 'unrestricted boundary must return rows').toBeGreaterThan(0);

        const narrowed = (await run(restricted)).map(keyOf);
        const openSet = new Set(open);
        expect(narrowed.every((k) => openSet.has(k))).toBe(true);
        expect(narrowed.length).toBeLessThan(open.length);

        const denied = (await run(denyAllAccess())).map(keyOf);
        expect(denied).toEqual([]);

        return { open, narrowed };
    }

    function denyGroups(...ids: string[]): MediaAccessBoundary {
        return restrictedAccess({ deniedGroupIds: ids, maxAgeRating: null, allowUnrated: true });
    }

    function ageLimit(maxAgeRating: number): MediaAccessBoundary {
        return restrictedAccess({ deniedGroupIds: [], maxAgeRating, allowUnrated: false });
    }

    describe('library scope', () => {
        it('listItemsByLibraryType hides denied-group rows', async () => {
            const groupA = await createLibraryGroup(`A ${crypto.randomUUID()}`);
            const groupB = await createLibraryGroup(`B ${crypto.randomUUID()}`);
            const allowed = await insertItemWithFile({
                title: 'Allowed Video',
                libraryGroupId: groupA,
                department: 'Engineering',
            });
            const hidden = await insertItemWithFile({
                title: 'Hidden Video',
                libraryGroupId: groupB,
                department: 'HR',
            });

            const { narrowed } = await expectAccessFiltered(
                async (access) =>
                    (await listItemsByLibraryType(sql, { mediaType: MEDIA_TYPE, access })).items,
                (row) => row.id,
                denyGroups(groupB),
            );

            expect(narrowed).toContain(allowed);
            expect(narrowed).not.toContain(hidden);
        });

        it('countItemsByGroup applies the boundary INSIDE the grouping subquery', async () => {
            const groupA = await createLibraryGroup(`A ${crypto.randomUUID()}`);
            const groupB = await createLibraryGroup(`B ${crypto.randomUUID()}`);
            await insertItemWithFile({
                title: 'Eng Video',
                libraryGroupId: groupA,
                department: 'Engineering',
            });
            await insertItemWithFile({
                title: 'HR Video',
                libraryGroupId: groupB,
                department: 'HR',
            });

            const { narrowed } = await expectAccessFiltered(
                (access) =>
                    countItemsByGroup(sql, {
                        mediaType: MEDIA_TYPE,
                        groupKey: 'department',
                        access,
                    }),
                (row) => row.group_value,
                denyGroups(groupB),
            );

            // The whole HR bucket disappears — not merely its count shrinking.
            expect(narrowed).toEqual(['Engineering']);
        });

        it('getDistinctMetadataValues does not leak values that exist only on denied items', async () => {
            const groupA = await createLibraryGroup(`A ${crypto.randomUUID()}`);
            const groupB = await createLibraryGroup(`B ${crypto.randomUUID()}`);
            await insertItemWithFile({
                title: 'Eng Video',
                libraryGroupId: groupA,
                department: 'Engineering',
            });
            await insertItemWithFile({
                title: 'Secret Video',
                libraryGroupId: groupB,
                department: 'ClassifiedDept',
            });

            const { narrowed } = await expectAccessFiltered(
                (access) => getDistinctMetadataValues(sql, MEDIA_TYPE, 'department', { access }),
                (value) => value,
                denyGroups(groupB),
            );

            expect(narrowed).toEqual(['Engineering']);
        });
    });

    describe('age scope', () => {
        it('listItemsByLibraryType hides items above the age cap', async () => {
            const group = await createLibraryGroup(`A ${crypto.randomUUID()}`);
            const mild = await insertItemWithFile({
                title: 'Mild Video',
                libraryGroupId: group,
                department: 'Engineering',
                ageRating: 6,
            });
            const adult = await insertItemWithFile({
                title: 'Adult Video',
                libraryGroupId: group,
                department: 'Engineering',
                ageRating: 18,
            });

            const { narrowed } = await expectAccessFiltered(
                async (access) =>
                    (await listItemsByLibraryType(sql, { mediaType: MEDIA_TYPE, access })).items,
                (row) => row.id,
                ageLimit(12),
            );

            expect(narrowed).toContain(mild);
            expect(narrowed).not.toContain(adult);
        });
    });

    describe('denyAll short-circuits', () => {
        it('returns an empty page with total 0 even when rows exist', async () => {
            const group = await createLibraryGroup(`A ${crypto.randomUUID()}`);
            await insertItemWithFile({
                title: 'Present Video',
                libraryGroupId: group,
                department: 'Engineering',
            });

            const result = await listItemsByLibraryType(sql, {
                mediaType: MEDIA_TYPE,
                access: denyAllAccess(),
            });
            expect(result.items).toEqual([]);
            expect(result.total).toBe(0);
        });
    });

    // REGRESSION: `{ kind: 'denyGroups', ids: [] }` is representable under the new
    // type and would reach `!= ALL(${[]}::uuid[])`, which postgres.js binds as a
    // parameter ($N) instead of inlining — a RUNTIME "syntax error at or near $N".
    // Only an executed query catches this.
    it('an empty denyGroups id list does not blow up the query', async () => {
        const group = await createLibraryGroup(`A ${crypto.randomUUID()}`);
        const id = await insertItemWithFile({
            title: 'Empty Deny Video',
            libraryGroupId: group,
            department: 'Engineering',
        });

        const result = await listItemsByLibraryType(sql, {
            mediaType: MEDIA_TYPE,
            access: { library: { kind: 'denyGroups', ids: [] }, age: { kind: 'any' } },
        });
        expect(result.items.map((i) => i.id)).toContain(id);
    });
});
