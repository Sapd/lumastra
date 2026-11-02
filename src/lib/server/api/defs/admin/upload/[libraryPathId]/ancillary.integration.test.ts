// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import type { RequestEvent } from '@sveltejs/kit';
import { afterAll, expect, it, vi } from 'vitest';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../tests/integration/setup/test-database.js';
import { adminSession } from '$lib/server/api/principal-locals.test-helpers.js';
const database = vi.hoisted(() => ({ sql: null as postgres.Sql | null }));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => database.sql }));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: { startRun: vi.fn().mockResolvedValue({ runId: 'sidecar-test-run' }) },
}));
vi.mock('$lib/server/tasks/builtin/native/file-delta-ingest-queue.js', () => ({
    enqueueDeltaPayload: vi.fn().mockResolvedValue(undefined),
}));
import { mount } from '$lib/server/api/mount.js';
import { def } from './ancillary.js';
afterAll(closeTestDb);
async function fixture(
    run: (
        upload: (name: string, type: string, bytes: string) => Promise<Response>,
        dir: string,
    ) => Promise<void>,
): Promise<void> {
    const sql = getTestDb();
    database.sql = sql;
    const dir = await mkdtemp(join(tmpdir(), 'ancillary-route-'));
    const owner = randomUUID(),
        file = randomUUID(),
        group = randomUUID(),
        library = randomUUID();
    try {
        await sql`INSERT INTO library_groups(id,name) VALUES (${group},'Lantern Workshop')`;
        await sql`INSERT INTO library_paths(id,path,media_type,library_group_id) VALUES (${library},${dir},'home_video',${group})`;
        await sql`INSERT INTO media_items(id,title,media_type) VALUES (${owner},'Lantern Workshop Film','movie')`;
        await sql`INSERT INTO media_files(id,file_path,library_group_id) VALUES (${file},${join(dir, 'Lantern.mkv')},${group})`;
        await sql`INSERT INTO media_file_items(file_id,media_item_id,is_default) VALUES (${file},${owner},true)`;
        await writeFile(join(dir, 'Lantern.mkv'), 'fictional video bytes');
        await run(async (name, type, bytes) => {
            const url = new URL(`http://localhost/api/admin/upload/${library}/ancillary/${owner}`);
            const form = new FormData();
            form.set('type', type);
            form.set(
                'file',
                new File([bytes], name, {
                    type: type === 'chapter' ? 'application/json' : 'application/x-subrip',
                }),
            );
            const event = {
                url,
                request: new Request(url, {
                    method: 'POST',
                    headers: { Origin: url.origin },
                    body: form,
                }),
                params: { libraryPathId: library, mediaItemId: owner },
                locals: adminSession(),
                route: { id: '/api/admin/upload/[libraryPathId]/ancillary/[mediaItemId]' },
                cookies: { get: vi.fn(), set: vi.fn() },
                getClientAddress: () => '127.0.0.1',
                setHeaders: vi.fn(),
                fetch: vi.fn(),
            } as unknown as RequestEvent;
            return mount(def, { surface: 'internal' }).POST!(event);
        }, dir);
    } finally {
        await sql`DELETE FROM media_items WHERE id=${owner}`;
        await sql`DELETE FROM media_files WHERE id=${file}`;
        await sql`DELETE FROM library_paths WHERE id=${library}`;
        await sql`DELETE FROM library_groups WHERE id=${group}`;
        await rm(dir, { recursive: true, force: true });
    }
}
it('refuses an existing subtitle sidecar without changing its bytes', async () => {
    await fixture(async (upload, dir) => {
        await writeFile(join(dir, 'Lantern.en.srt'), 'previous subtitle');
        const response = await upload('en.srt', 'subtitle', 'replacement subtitle');
        expect(response.status).toBe(409);
        expect(await readFile(join(dir, 'Lantern.en.srt'), 'utf8')).toBe('previous subtitle');
    });
});
it('a rejected database chapter write leaves no sidecar and cannot block a valid retry', async () => {
    await fixture(async (upload, dir) => {
        // PostgreSQL rejects NUL in text. This exercises a real failed INSERT,
        // after JSON validation, without replacing the chapter query with a mock.
        const failed = await upload(
            'chapters.json',
            'chapter',
            JSON.stringify([{ title: 'Bad\u0000marker', startMs: 0 }]),
        );
        expect(failed.status).toBeGreaterThanOrEqual(400);
        await expect(access(join(dir, 'Lantern.chapters.json'))).rejects.toThrow();
        const retried = await upload(
            'chapters.json',
            'chapter',
            '[{"title":"Arrival","startMs":0}]',
        );
        expect(retried.status).toBe(200);
        expect(await retried.json()).toHaveProperty('undoId');
    });
});
