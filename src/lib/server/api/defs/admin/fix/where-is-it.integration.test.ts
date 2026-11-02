// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `/admin/fix/where-is-it` against real tables. The trace is only useful if
 * "where it stopped" is true, so these pin the cases that used to report a
 * healthy item as broken or a broken one as complete:
 *   - an item found by TITLE whose file path does not contain the title
 *   - an item with two files, one of them missing
 *   - an item whose stage gave up (failed_permanent)
 *   - `%` / `_` in the query are literal, not wildcards
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';

vi.mock('$lib/server/database/connection.js', async () => {
    const { getTestDb: db } =
        await import('../../../../../../../tests/integration/setup/test-database.js');
    return { getAdminDb: () => db() };
});

import { def } from './where-is-it.js';
import { WhereIsItSchema, type WhereIsIt } from '$lib/components/admin/fix/where-is-it.schema.js';

const TAG = `wii${Date.now().toString(36)}`;

let sql: postgres.Sql;

async function item(title: string, stages: string[] = ['completed']): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, created_at, updated_at)
        VALUES (${id}::uuid, ${title}, 'movie', 'active', true, now(), now())
    `;
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type)
        VALUES (${id}::uuid, 'tmdb', ${String(90_000_000 + Math.floor(Math.random() * 9_999_999))}, 'movie')
    `;
    for (const [i, status] of stages.entries()) {
        await sql`
            INSERT INTO media_item_stage_state
                (media_item_id, stage_id, processing_version, status, attempt, updated_at)
            VALUES (${id}::uuid, ${`${TAG}-stage-${i}`}, 1, ${status}, 0, now())
        `;
    }
    return id;
}

async function file(
    itemId: string,
    path: string,
    missing = false,
    isDefault = true,
): Promise<void> {
    const [{ id }] = await sql<[{ id: string }]>`
        INSERT INTO media_files (file_path, is_missing, probed_at)
        VALUES (${path}, ${missing}, now())
        RETURNING id
    `;
    await sql`
        INSERT INTO media_file_items (file_id, media_item_id, is_default)
        VALUES (${id}::uuid, ${itemId}::uuid, ${isDefault})
    `;
}

async function trace(q: string): Promise<WhereIsIt> {
    const resp = await def.handlers.GET!({} as never, { input: { query: { q } } } as never);
    return WhereIsItSchema.parse(await (resp as Response).json());
}

beforeAll(() => {
    sql = getTestDb();
});

afterEach(async () => {
    await sql`DELETE FROM media_files WHERE file_path LIKE ${`%/${TAG}/%`}`;
    await sql`DELETE FROM media_items WHERE title LIKE ${`%${TAG}%`}`;
});

afterAll(async () => {
    await closeTestDb();
});

describe('where-is-it (integration)', () => {
    it('traces a title match through its own file even when the path differs', async () => {
        const id = await item(`Amelie ${TAG}`);
        await file(id, `/data/${TAG}/Le.Fabuleux.Destin.2001.mkv`);
        const body = await trace(`Amelie ${TAG}`);
        const match = body.matches.find((x) => x.mediaItemId === id);
        expect(match?.filePath).toBe(`/data/${TAG}/Le.Fabuleux.Destin.2001.mkv`);
        expect(match?.stoppedAt).toBeNull();
        expect(match?.steps.find((s) => s.step === 'file-on-disk')?.status).toBe('ok');
        expect(match?.steps.find((s) => s.step === 'file-on-disk')?.code).toBe('file-present');
    });

    it('an item is as far along as its worst file', async () => {
        const id = await item(`Two Files ${TAG}`);
        await file(id, `/data/${TAG}/two-files-b.mkv`);
        // The missing copy sorts FIRST by path, so a last-row-wins merge would hide it.
        await file(id, `/data/${TAG}/two-files-a.mkv`, true, false);
        const body = await trace(`${TAG}/two-files`);
        const match = body.matches.find((x) => x.mediaItemId === id);
        expect(match?.stoppedAt).toBe('file-on-disk');
        expect(match?.fileMissing).toBe(true);
    });

    it('a stage that gave up stops the chain at processing', async () => {
        const id = await item(`Dead Letter ${TAG}`, ['completed', 'failed_permanent']);
        await file(id, `/data/${TAG}/dead-letter.mkv`);
        const match = (await trace(`${TAG}/dead-letter`)).matches.find((x) => x.mediaItemId === id);
        expect(match?.stoppedAt).toBe('stages-processed');
        expect(match?.steps.find((x) => x.step === 'stages-processed')).toMatchObject({
            code: 'stages-gave-up',
            params: { count: 1, total: 2 },
        });
    });

    it('stages still queued are not "all the way through"', async () => {
        const id = await item(`Queued ${TAG}`, ['completed', 'pending']);
        await file(id, `/data/${TAG}/queued.mkv`);
        const match = (await trace(`${TAG}/queued`)).matches.find((x) => x.mediaItemId === id);
        expect(match?.stoppedAt).toBeNull();
        expect(match?.steps.find((s) => s.step === 'stages-processed')?.status).toBe('unknown');
    });

    it('treats % and _ in the query as literal characters', async () => {
        const id = await item(`Plain ${TAG}`);
        await file(id, `/data/${TAG}/plain.mkv`);
        const body = await trace(`${TAG}/__ain`);
        expect(body.matches.some((x) => x.mediaItemId === id)).toBe(false);
        expect(body.unreadable).toEqual([]);
    });
});
