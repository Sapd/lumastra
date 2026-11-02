// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for `buildTaskFailuresList` — the composition function
 * backing GET /api/v1/tasks/{taskId}/failures. Exercises real inserted rows
 * against Postgres rather than a mock, because `plugin_failure_events.id`
 * is BIGINT and this app's global type parser (connection.ts) returns
 * bigint columns as JS `number` unless a query explicitly casts to text —
 * a mocked row would happily hand back whatever type the test author
 * typed in, hiding exactly this class of bug.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import { recordFailure } from '$lib/server/database/queries/plugin-failure-events.queries.js';
import {
    restrictedAccess,
    unrestrictedAccess,
} from '$lib/server/database/queries/builders/media-access-boundary.js';
import { buildTaskFailuresList, taskFailuresResponse } from './failures.js';

describe('buildTaskFailuresList (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM plugin_failure_events WHERE plugin_id LIKE 'itest_failureslist_%'`;
    });

    it('returns a real bigint id as a string, and validates against the response schema', async () => {
        await recordFailure(sql, 'itest_failureslist_a', 'item-1', 'boom', null);

        const result = await buildTaskFailuresList(
            sql,
            'itest_failureslist_a',
            {
                limit: 50,
                cursorId: null,
            },
            unrestrictedAccess(),
        );

        expect(result.failures).toHaveLength(1);
        expect(typeof result.failures[0].id).toBe('string');
        expect(result.failures[0].id).toMatch(/^\d+$/);

        // This is the assertion that would have caught the original bug: the
        // real handler maps these database rows through
        // taskFailuresResponse() before they reach the client, and a
        // bare (unparsed) mock id never exercises that boundary.
        expect(() => taskFailuresResponse(result, 50)).not.toThrow();
    });

    it('redacts credentials in the reason, as the per-item history endpoint does', async () => {
        await recordFailure(
            sql,
            'itest_failureslist_redact',
            'item-1',
            'GET https://tmdb.example/3/movie?api_key=supersecret123 failed',
            null,
        );

        const result = await buildTaskFailuresList(
            sql,
            'itest_failureslist_redact',
            { limit: 50, cursorId: null },
            unrestrictedAccess(),
        );

        expect(result.failures[0].reason).toContain('api_key=<redacted>');
        expect(result.failures[0].reason).not.toContain('supersecret123');
    });

    it('paginates with a real numeric-shaped cursor across two real rows', async () => {
        await recordFailure(sql, 'itest_failureslist_b', 'item-1', 'first', null);
        await recordFailure(sql, 'itest_failureslist_b', 'item-2', 'second', null);

        const firstPage = await buildTaskFailuresList(
            sql,
            'itest_failureslist_b',
            {
                limit: 1,
                cursorId: null,
            },
            unrestrictedAccess(),
        );

        expect(firstPage.failures).toHaveLength(1);
        expect(firstPage.nextCursor).toBeDefined();

        const cursorId = Buffer.from(firstPage.nextCursor!, 'base64').toString('utf8');
        const secondPage = await buildTaskFailuresList(
            sql,
            'itest_failureslist_b',
            {
                limit: 1,
                cursorId,
            },
            unrestrictedAccess(),
        );

        expect(secondPage.failures).toHaveLength(1);
        expect(secondPage.failures[0].id).not.toBe(firstPage.failures[0].id);
    });

    it('groups repeated failures for the same item into one row with a failureCount, not one row per event', async () => {
        // plugin_failure_events is append-only: an item that fails on every
        // periodic run accumulates one unresolved row per attempt. The list
        // must not surface that as N separate rows for one item.
        await recordFailure(sql, 'itest_failureslist_c', 'repeat-item', 'first attempt', null);
        await recordFailure(sql, 'itest_failureslist_c', 'repeat-item', 'second attempt', null);
        await recordFailure(sql, 'itest_failureslist_c', 'other-item', 'unrelated', null);

        const result = await buildTaskFailuresList(
            sql,
            'itest_failureslist_c',
            {
                limit: 50,
                cursorId: null,
            },
            unrestrictedAccess(),
        );

        // Two distinct items, not three raw event rows.
        expect(result.total).toBe(2);
        expect(result.failures).toHaveLength(2);

        const repeated = result.failures.find((f) => f.itemId === 'repeat-item');
        expect(repeated).toBeDefined();
        // Surfaces the MOST RECENT event's reason...
        expect(repeated!.reason).toBe('second attempt');
        // ...while keeping the dropped earlier event visible as a count.
        expect(repeated!.failureCount).toBe(2);

        const other = result.failures.find((f) => f.itemId === 'other-item');
        expect(other?.failureCount).toBe(1);

        expect(() => taskFailuresResponse(result, 50)).not.toThrow();
    });

    // ========================================================================
    // C2 (2026-09-18 fix-plan-4, Task 2) — the title join must respect the
    // caller's access boundary. Real Postgres, two rows: one in a group the
    // boundary allows, one in a group it denies. Seam per Global Constraint 2:
    // the query is exercised through `buildTaskFailuresList` exactly as the
    // route calls it, with an explicit `MediaAccessBoundary` (the real
    // `restrictedAccess()` constructor) — never a mocked row shape.
    // ========================================================================
    describe('C2 — title join respects the access boundary', () => {
        const mediaIds: string[] = [];
        const fileIds: string[] = [];
        const groupIds: string[] = [];

        afterEach(async () => {
            if (mediaIds.length > 0) {
                await sql`DELETE FROM media_items WHERE id = ANY(${mediaIds}::uuid[])`;
                mediaIds.length = 0;
            }
            if (fileIds.length > 0) {
                await sql`DELETE FROM media_files WHERE id = ANY(${fileIds}::uuid[])`;
                fileIds.length = 0;
            }
            if (groupIds.length > 0) {
                await sql`DELETE FROM library_groups WHERE id = ANY(${groupIds}::uuid[])`;
                groupIds.length = 0;
            }
        });

        /** Insert a plain movie row with a file pinned to `libraryGroupId`. */
        async function insertMovie(tag: string, libraryGroupId: string): Promise<string> {
            const itemId = randomUUID();
            const fileId = randomUUID();
            mediaIds.push(itemId);
            fileIds.push(fileId);
            await sql`
                INSERT INTO media_items (id, title, media_type, status, has_files)
                VALUES (${itemId}::uuid, ${`${tag} Movie`}, 'movie', 'active', true)
            `;
            await sql`
                INSERT INTO media_files (id, file_path, library_group_id)
                VALUES (${fileId}::uuid, ${`/test/${itemId}.mkv`}, ${libraryGroupId}::uuid)
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${itemId}::uuid)
            `;
            return itemId;
        }

        async function insertGroup(name: string): Promise<string> {
            const id = randomUUID();
            groupIds.push(id);
            await sql`INSERT INTO library_groups (id, name) VALUES (${id}::uuid, ${name})`;
            return id;
        }

        it('omits the title for an item in a library group the boundary denies, and includes it for an allowed group', async () => {
            const allowedGroup = await insertGroup('itest-c2-allowed');
            const deniedGroup = await insertGroup('itest-c2-denied');
            const allowedItemId = await insertMovie('Allowed', allowedGroup);
            const deniedItemId = await insertMovie('Denied', deniedGroup);

            await recordFailure(sql, 'itest_failureslist_c2', allowedItemId, 'boom', null);
            await recordFailure(sql, 'itest_failureslist_c2', deniedItemId, 'boom', null);

            const access = restrictedAccess({
                deniedGroupIds: [deniedGroup],
                maxAgeRating: null,
                allowUnrated: true,
            });

            const result = await buildTaskFailuresList(
                sql,
                'itest_failureslist_c2',
                { limit: 50, cursorId: null },
                access,
            );

            const allowedFailure = result.failures.find((f) => f.itemId === allowedItemId);
            const deniedFailure = result.failures.find((f) => f.itemId === deniedItemId);

            expect(allowedFailure).toBeDefined();
            expect(allowedFailure!.title).toBe('Allowed Movie');

            // The row is still LISTED (plugin_failure_events itself is not
            // access-filtered — only the title enrichment is), but the title
            // must be absent for the denied item.
            expect(deniedFailure).toBeDefined();
            expect(deniedFailure!.title).toBeUndefined();
        });

        it('resolves both titles under an unrestricted boundary (sanity: the predicate is not just always-false)', async () => {
            const groupA = await insertGroup('itest-c2-unrestricted-a');
            const groupB = await insertGroup('itest-c2-unrestricted-b');
            const itemA = await insertMovie('SanityA', groupA);
            const itemB = await insertMovie('SanityB', groupB);

            await recordFailure(sql, 'itest_failureslist_c2b', itemA, 'boom', null);
            await recordFailure(sql, 'itest_failureslist_c2b', itemB, 'boom', null);

            const result = await buildTaskFailuresList(
                sql,
                'itest_failureslist_c2b',
                { limit: 50, cursorId: null },
                unrestrictedAccess(),
            );

            expect(result.failures.find((f) => f.itemId === itemA)?.title).toBe('SanityA Movie');
            expect(result.failures.find((f) => f.itemId === itemB)?.title).toBe('SanityB Movie');
        });
    });
});
