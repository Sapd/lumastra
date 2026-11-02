// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for File Scanner Runs Query Module
 *
 * Tests insertScannerRun, updateScannerRun, markAbandonedScannerRuns,
 * and getRecentScannerRuns against a real PostgreSQL test database.
 */

import { randomUUID } from 'crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';

import {
    insertScannerRun as insertScannerRunQuery,
    updateScannerRun,
    markAbandonedScannerRuns,
    getRecentScannerRuns,
    getLatestScannerRunPerLibrary,
    ABANDONED_RUN_ERRORS_SENTINEL,
    getInitialScanKeys,
} from './file-scanner-runs.queries.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestLibraryPath(sql: postgres.Sql, suffix: string): Promise<string> {
    const groupId = randomUUID();
    const pathId = randomUUID();

    await sql`
        INSERT INTO library_groups (id, name)
        VALUES (${groupId}, ${`test-group-${suffix}`})
    `;

    await sql`
        INSERT INTO library_paths (id, path, media_type, library_group_id)
        VALUES (
            ${pathId},
            ${`/test/fsr/${suffix}`},
            'movie',
            ${groupId}
        )
    `;

    return pathId;
}

/**
 * Insert a folder into a CALLER-SUPPLIED group, for tests that need two
 * folders sharing one `library_group_id` (the `library_group_id` scanner-runs
 * filter, which is otherwise indistinguishable from `library_path_id`
 * filtering with one folder per group). `suffix` only disambiguates the
 * folder's own path/name for uniqueness — it carries no meaning the query
 * under test could key off, matching the group's own name here.
 */
async function createTestLibraryPathInGroup(
    sql: postgres.Sql,
    groupId: string,
    suffix: string,
): Promise<string> {
    const pathId = randomUUID();
    await sql`
        INSERT INTO library_paths (id, path, media_type, library_group_id)
        VALUES (
            ${pathId},
            ${`/test/fsr-group/${suffix}`},
            'movie',
            ${groupId}
        )
    `;
    return pathId;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('File Scanner Runs Queries', () => {
    let sql: postgres.Sql;
    const createdPathIds: string[] = [];
    const createdRunIds: string[] = [];

    async function insertScannerRun(
        sql: postgres.Sql,
        params: Parameters<typeof insertScannerRunQuery>[1],
    ): Promise<string> {
        const id = await insertScannerRunQuery(sql, params);
        createdRunIds.push(id);
        return id;
    }

    async function cleanupRuns(): Promise<void> {
        if (createdRunIds.length > 0) {
            await sql`DELETE FROM file_scanner_runs WHERE id = ANY(${createdRunIds}::uuid[])`;
            createdRunIds.length = 0;
        }
    }

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await cleanupRuns();
        if (createdPathIds.length > 0) {
            await sql`DELETE FROM file_scanner_runs WHERE library_path_id IN ${sql(createdPathIds)}`;
            await sql`DELETE FROM library_paths WHERE id IN ${sql(createdPathIds)}`;
        }
        await closeTestDb();
    });

    beforeEach(async () => {
        await cleanupRuns();
        if (createdPathIds.length > 0) {
            await sql`DELETE FROM file_scanner_runs WHERE library_path_id IN ${sql(createdPathIds)}`;
        }
    });

    // ========================================================================
    // insertScannerRun
    // ========================================================================

    describe('initial scans', () => {
        it('ignores malformed scan keys without losing valid paths or the all scope', async () => {
            const path = await createTestLibraryPath(sql, 'onboarding-invalid-keys');
            createdPathIds.push(path);
            const invalid = [
                '',
                'bad',
                'not-a-uuid',
                `${path}\n`,
                '00000000-0000-0000-0000-zzzzzzzzzzzz',
            ];
            expect(await getInitialScanKeys(sql, [...invalid, path, 'all'])).toEqual([path, 'all']);
            expect(await getInitialScanKeys(sql, invalid)).toEqual([]);
        });
        it('distinguishes new paths, completed paths, failed scans, and global coverage', async () => {
            const first = await createTestLibraryPath(sql, 'onboarding-first');
            const done = await createTestLibraryPath(sql, 'onboarding-done');
            createdPathIds.push(first, done);
            const run = await insertScannerRun(sql, { libraryPathId: done, startedAt: new Date() });
            await sql`UPDATE file_scanner_runs SET completed_at = NOW(), errors = 0 WHERE id = ${run}`;
            const failed = await insertScannerRun(sql, {
                libraryPathId: first,
                startedAt: new Date(),
            });
            await sql`UPDATE file_scanner_runs SET completed_at = NOW(), errors = -1 WHERE id = ${failed}`;
            expect(await getInitialScanKeys(sql, [first, done])).toEqual([first]);
            const global = await insertScannerRun(sql, { startedAt: new Date() });
            await sql`UPDATE file_scanner_runs SET completed_at = NOW(), errors = 0 WHERE id = ${global}`;
            expect(await getInitialScanKeys(sql, [first, done, 'all'])).toEqual([]);
            const addedLater = await createTestLibraryPath(sql, 'onboarding-added-later');
            createdPathIds.push(addedLater);
            expect(await getInitialScanKeys(sql, [addedLater, 'all'])).toEqual([addedLater, 'all']);
        });
    });

    describe('insertScannerRun', () => {
        it('inserts a new scanner run and returns a UUID', async () => {
            const pathId = await createTestLibraryPath(sql, '001');
            createdPathIds.push(pathId);

            const id = await insertScannerRun(sql, {
                libraryPathId: pathId,
                startedAt: new Date(),
            });

            expect(id).toBeTruthy();
            expect(typeof id).toBe('string');

            const rows = await sql`
                SELECT * FROM file_scanner_runs WHERE id = ${id}
            `;
            expect(rows.length).toBe(1);
            expect(rows[0].library_path_id).toBe(pathId);
            expect(rows[0].completed_at).toBeNull();
        });

        it('allows null libraryPathId for global scans', async () => {
            const id = await insertScannerRun(sql, {
                startedAt: new Date(),
            });

            const rows = await sql`
                SELECT * FROM file_scanner_runs WHERE id = ${id}
            `;
            expect(rows[0].library_path_id).toBeNull();
        });
    });

    // ========================================================================
    // updateScannerRun
    // ========================================================================

    describe('updateScannerRun', () => {
        it('updates run fields on completion', async () => {
            const pathId = await createTestLibraryPath(sql, '002');
            createdPathIds.push(pathId);

            const id = await insertScannerRun(sql, {
                libraryPathId: pathId,
                startedAt: new Date(),
            });

            const completedAt = new Date();
            await updateScannerRun(sql, {
                id,
                completedAt,
                totalFiles: 100,
                matched: 80,
                updated: 10,
                unmatched: 5,
                errors: 5,
                errorSamples: [],
            });

            const rows = await sql`
                SELECT * FROM file_scanner_runs WHERE id = ${id}
            `;
            expect(rows[0].completed_at).toBeInstanceOf(Date);
            expect(rows[0].total_files).toBe(100);
            expect(rows[0].matched).toBe(80);
            expect(rows[0].updated).toBe(10);
            expect(rows[0].unmatched).toBe(5);
            expect(rows[0].errors).toBe(5);
        });
    });

    // ========================================================================
    // markAbandonedScannerRuns
    // ========================================================================

    describe('markAbandonedScannerRuns', () => {
        it('marks old uncompleted runs as abandoned for a specific path', async () => {
            const pathId = await createTestLibraryPath(sql, 'abandon');
            createdPathIds.push(pathId);

            const runId = await insertScannerRun(sql, {
                libraryPathId: pathId,
                startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000), // 3 hours ago
            });

            const count = await markAbandonedScannerRuns(sql, pathId);
            expect(count).toBeGreaterThanOrEqual(1);

            const rows = await sql`
                SELECT * FROM file_scanner_runs WHERE id = ${runId}
            `;
            expect(rows[0].completed_at).not.toBeNull();
            expect(rows[0].errors).toBe(ABANDONED_RUN_ERRORS_SENTINEL);
        });

        it('does not mark recent uncompleted runs', async () => {
            const pathId = await createTestLibraryPath(sql, 'recent');
            createdPathIds.push(pathId);

            const runId = await insertScannerRun(sql, {
                libraryPathId: pathId,
                startedAt: new Date(), // now
            });

            const count = await markAbandonedScannerRuns(sql, pathId);

            const rows = await sql`
                SELECT * FROM file_scanner_runs WHERE id = ${runId}
            `;
            expect(rows[0].completed_at).toBeNull();
            expect(count).toBe(0);
        });

        it('marks global scans when libraryPathId is null', async () => {
            const runId = await insertScannerRun(sql, {
                startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
            });

            const count = await markAbandonedScannerRuns(sql, null);
            expect(count).toBeGreaterThanOrEqual(1);

            const rows = await sql`
                SELECT * FROM file_scanner_runs WHERE id = ${runId}
            `;
            expect(rows[0].errors).toBe(ABANDONED_RUN_ERRORS_SENTINEL);
        });
    });

    // ========================================================================
    // getRecentScannerRuns
    // ========================================================================

    describe('getRecentScannerRuns', () => {
        it('returns runs ordered by started_at descending', async () => {
            const pathId = await createTestLibraryPath(sql, 'recent-list');
            createdPathIds.push(pathId);

            const id1 = await insertScannerRun(sql, {
                libraryPathId: pathId,
                startedAt: new Date(Date.now() - 10 * 60 * 1000),
            });
            const id2 = await insertScannerRun(sql, {
                libraryPathId: pathId,
                startedAt: new Date(),
            });

            const rows = await getRecentScannerRuns(sql, 10, pathId);
            expect(rows.length).toBe(2);
            expect(rows[0].id).toBe(id2);
            expect(rows[1].id).toBe(id1);
        });

        it('respects the limit parameter', async () => {
            const pathId = await createTestLibraryPath(sql, 'limit');
            createdPathIds.push(pathId);

            for (let i = 0; i < 5; i++) {
                await insertScannerRun(sql, {
                    libraryPathId: pathId,
                    startedAt: new Date(Date.now() - i * 1000),
                });
            }

            const rows = await getRecentScannerRuns(sql, 2, pathId);
            expect(rows.length).toBe(2);
        });

        it('filters by libraryPathId when provided', async () => {
            const pathA = await createTestLibraryPath(sql, 'a');
            const pathB = await createTestLibraryPath(sql, 'b');
            createdPathIds.push(pathA, pathB);

            await insertScannerRun(sql, {
                libraryPathId: pathA,
                startedAt: new Date(),
            });
            await insertScannerRun(sql, {
                libraryPathId: pathB,
                startedAt: new Date(),
            });

            const rows = await getRecentScannerRuns(sql, 10, pathA);
            expect(rows.every((r) => r.library_path_id === pathA)).toBe(true);
        });

        it('returns all runs when libraryPathId is omitted', async () => {
            const pathA = await createTestLibraryPath(sql, `all-a-${Date.now()}`);
            const pathB = await createTestLibraryPath(sql, `all-b-${Date.now()}`);
            createdPathIds.push(pathA, pathB);

            await insertScannerRun(sql, {
                libraryPathId: pathA,
                startedAt: new Date(),
            });
            await insertScannerRun(sql, {
                libraryPathId: pathB,
                startedAt: new Date(),
            });

            const rows = (await getRecentScannerRuns(sql, 50)).filter(
                (r) => r.library_path_id === pathA || r.library_path_id === pathB,
            );
            expect(rows.length).toBe(2);
        });

        it('includes the generated match_rate column', async () => {
            const pathId = await createTestLibraryPath(sql, 'match-rate');
            createdPathIds.push(pathId);

            const id = await insertScannerRun(sql, {
                libraryPathId: pathId,
                startedAt: new Date(),
            });
            await updateScannerRun(sql, {
                id,
                completedAt: new Date(),
                totalFiles: 100,
                matched: 80,
                updated: 10,
                unmatched: 5,
                errors: 5,
                errorSamples: [],
            });

            const rows = await getRecentScannerRuns(sql, 10, pathId);
            expect(rows.length).toBe(1);
            expect(rows[0].match_rate).toBeTruthy();
        });
    });

    // ========================================================================
    // library_group_id filter (library-sources restructure, step 1)
    // ========================================================================
    //
    // Group and folder names below deliberately don't describe a media type —
    // "grp-alpha"/"grp-beta", folders under /test/fsr-group/ — this filter
    // must key ONLY off library_paths.library_group_id, never off a name.

    describe('library_group_id filter', () => {
        it("narrows getRecentScannerRuns to one group's folders", async () => {
            const groupA = randomUUID();
            const groupB = randomUUID();
            await sql`INSERT INTO library_groups (id, name) VALUES (${groupA}, 'grp-alpha')`;
            await sql`INSERT INTO library_groups (id, name) VALUES (${groupB}, 'grp-beta')`;

            const pathA1 = await createTestLibraryPathInGroup(sql, groupA, 'a1');
            const pathA2 = await createTestLibraryPathInGroup(sql, groupA, 'a2');
            const pathB1 = await createTestLibraryPathInGroup(sql, groupB, 'b1');
            createdPathIds.push(pathA1, pathA2, pathB1);

            await insertScannerRun(sql, { libraryPathId: pathA1, startedAt: new Date() });
            await insertScannerRun(sql, { libraryPathId: pathA2, startedAt: new Date() });
            await insertScannerRun(sql, { libraryPathId: pathB1, startedAt: new Date() });

            const rows = await getRecentScannerRuns(sql, 50, undefined, groupA);
            expect(rows.length).toBe(2);
            expect(rows.every((r) => [pathA1, pathA2].includes(r.library_path_id ?? ''))).toBe(
                true,
            );

            await sql`DELETE FROM library_paths WHERE id IN ${sql([pathA1, pathA2, pathB1])}`;
            await sql`DELETE FROM library_groups WHERE id IN ${sql([groupA, groupB])}`;
        });

        it('excludes a global (scope=all) run once a group filter is set', async () => {
            const groupA = randomUUID();
            await sql`INSERT INTO library_groups (id, name) VALUES (${groupA}, 'grp-gamma')`;
            const pathA1 = await createTestLibraryPathInGroup(sql, groupA, 'g1');
            createdPathIds.push(pathA1);

            await insertScannerRun(sql, { libraryPathId: pathA1, startedAt: new Date() });
            await insertScannerRun(sql, { startedAt: new Date() }); // global scan

            const rows = await getRecentScannerRuns(sql, 50, undefined, groupA);
            expect(rows.length).toBe(1);
            expect(rows[0].library_path_id).toBe(pathA1);

            await markAbandonedScannerRuns(sql, null); // best-effort tidy of the global row
            await sql`DELETE FROM library_paths WHERE id = ${pathA1}`;
            await sql`DELETE FROM library_groups WHERE id = ${groupA}`;
        });

        it("narrows getLatestScannerRunPerLibrary to one group's folders", async () => {
            const groupA = randomUUID();
            const groupB = randomUUID();
            await sql`INSERT INTO library_groups (id, name) VALUES (${groupA}, 'grp-delta')`;
            await sql`INSERT INTO library_groups (id, name) VALUES (${groupB}, 'grp-epsilon')`;

            const pathA1 = await createTestLibraryPathInGroup(sql, groupA, 'd1');
            const pathB1 = await createTestLibraryPathInGroup(sql, groupB, 'e1');
            createdPathIds.push(pathA1, pathB1);

            await insertScannerRun(sql, { libraryPathId: pathA1, startedAt: new Date() });
            await insertScannerRun(sql, { libraryPathId: pathB1, startedAt: new Date() });

            const rows = await getLatestScannerRunPerLibrary(sql, groupA);
            expect(rows.map((r) => r.library_path_id)).toEqual([pathA1]);

            await sql`DELETE FROM library_paths WHERE id IN ${sql([pathA1, pathB1])}`;
            await sql`DELETE FROM library_groups WHERE id IN ${sql([groupA, groupB])}`;
        });
    });
});
