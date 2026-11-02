// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for `resolveRunMediaItems` — the media-title join C4
 * (2026-09-18 fix-plan-4, Task 2) flags. Real Postgres, two rows: one in a
 * library group the boundary allows, one it denies. Seam per Global
 * Constraint 2: the function under test is the exact one `defs/runs/index.ts`
 * calls, driven with a real `MediaAccessBoundary` (the real `restrictedAccess`
 * constructor) — never a mocked row shape.
 *
 * 2026-09-13 P4 ruled the run LIST endpoint stays on `runs:read` for every
 * non-admin session — this test does not touch that; it proves the JOIN
 * respects the boundary it is handed, independent of how that boundary is
 * derived for a given caller (see scope-gated-access-boundary.ts for that).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { Run } from '@sapd/lumastra-plugin-sdk';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import {
    restrictedAccess,
    unrestrictedAccess,
} from '$lib/server/database/queries/builders/media-access-boundary.js';
import { resolveRunMediaItems } from './index.js';

function fixtureRun(id: string, subjectId: string): Run {
    return {
        id,
        taskId: 'itest-c4-task',
        label: 'itest run',
        state: 'completed',
        input: {},
        scope: { subjectId },
        trigger: { kind: 'manual' },
        startedAt: new Date().toISOString(),
        stages: [],
        actor: { type: 'user' },
    } as Run;
}

describe('resolveRunMediaItems (integration) — C4', () => {
    let sql: postgres.Sql;
    const mediaIds: string[] = [];
    const fileIds: string[] = [];
    const groupIds: string[] = [];

    beforeAll(async () => {
        sql = getTestDb();
        await sql`SELECT 1 FROM media_items LIMIT 0`;
    });

    afterAll(async () => {
        await closeTestDb();
    });

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

    it('omits the media item for a run whose subject is in a denied library group, and includes it for an allowed group', async () => {
        const allowedGroup = await insertGroup('itest-c4-allowed');
        const deniedGroup = await insertGroup('itest-c4-denied');
        const allowedItemId = await insertMovie('Allowed', allowedGroup);
        const deniedItemId = await insertMovie('Denied', deniedGroup);

        const runs = [
            fixtureRun('run-allowed', allowedItemId),
            fixtureRun('run-denied', deniedItemId),
        ];

        const access = restrictedAccess({
            deniedGroupIds: [deniedGroup],
            maxAgeRating: null,
            allowUnrated: true,
        });

        const result = await resolveRunMediaItems(sql, runs, access);

        expect(result.get(allowedItemId)?.title).toBe('Allowed Movie');
        expect(result.has(deniedItemId)).toBe(false);
    });

    it('resolves both titles under an unrestricted boundary (sanity: the predicate is not just always-false)', async () => {
        const groupA = await insertGroup('itest-c4-unrestricted-a');
        const groupB = await insertGroup('itest-c4-unrestricted-b');
        const itemA = await insertMovie('SanityA', groupA);
        const itemB = await insertMovie('SanityB', groupB);

        const runs = [fixtureRun('run-a', itemA), fixtureRun('run-b', itemB)];

        const result = await resolveRunMediaItems(sql, runs, unrestrictedAccess());

        expect(result.get(itemA)?.title).toBe('SanityA Movie');
        expect(result.get(itemB)?.title).toBe('SanityB Movie');
    });
});
