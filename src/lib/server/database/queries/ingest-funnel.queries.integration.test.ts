// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The funnel's library-wide counts against real tables: a file never linked
 * is an orphan, a file linked only to a deleted or merged entry is
 * `removedEntryFiles`, and each sample kind lists exactly the files its count
 * holds. Measured as deltas, so rows other tests left behind do not matter.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { loadIngestFunnel, loadIngestFunnelSamples } from './ingest-funnel.queries.js';

const TAG = `fun${Date.now().toString(36)}`;
let sql: postgres.Sql;

async function file(itemStatus: 'active' | 'deleted' | 'merged' | null): Promise<string> {
    const path = `/data/${TAG}/${crypto.randomUUID()}.mkv`;
    const [{ id }] = await sql<[{ id: string }]>`
        INSERT INTO media_files (file_path, probed_at) VALUES (${path}, now()) RETURNING id
    `;
    if (itemStatus !== null) {
        const itemId = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, created_at, updated_at)
            VALUES (${itemId}::uuid, ${`${TAG} item`}, 'movie', ${itemStatus}, true, now(), now())
        `;
        await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${id}::uuid, ${itemId}::uuid)`;
    }
    return path;
}

async function samplePaths(kind: 'orphans' | 'removed-entry'): Promise<string[]> {
    const rows = await loadIngestFunnelSamples(sql, kind, null, 10_000);
    return rows.map((r) => r.filePath).filter((p) => p.includes(`/${TAG}/`));
}

beforeAll(() => {
    sql = getTestDb();
});

afterEach(async () => {
    await sql`DELETE FROM media_files WHERE file_path LIKE ${`/data/${TAG}/%`}`;
    await sql`DELETE FROM media_items WHERE title LIKE ${`${TAG}%`}`;
});

afterAll(async () => {
    await closeTestDb();
});

describe('ingest funnel orphan split (integration)', () => {
    it('separates never-linked files from files of removed entries', async () => {
        const before = await loadIngestFunnel(sql);
        const never = await file(null);
        const deleted = await file('deleted');
        const merged = await file('merged');
        await file('active');

        const after = await loadIngestFunnel(sql);
        expect(after.orphanFiles - before.orphanFiles).toBe(1);
        expect(after.removedEntryFiles - before.removedEntryFiles).toBe(2);

        expect(await samplePaths('orphans')).toEqual([never]);
        expect((await samplePaths('removed-entry')).sort()).toEqual([deleted, merged].sort());
    });
});
