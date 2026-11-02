// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../tests/integration/setup/test-database.js';
import { adminSession } from '$lib/server/api/principal-locals.test-helpers.js';
const database = vi.hoisted(() => ({ sql: null as postgres.Sql | null }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => database.sql }));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({ orchestrator: { startRun: vi.fn() } }));
import { mount } from '$lib/server/api/mount.js';
import { def } from './segments.js';
let sql: postgres.Sql;
const series = randomUUID(),
    season = randomUUID(),
    file = randomUUID();
const episodes = Array.from({ length: 1001 }, () => randomUUID());
beforeAll(async () => {
    sql = getTestDb();
    await sql`INSERT INTO media_items(id,title,media_type,status,parent_id) VALUES (${series},'Fictional long series','tv','active',null),(${season},'Fictional season','season','active',${series})`;
    await sql`INSERT INTO media_items(id,title,media_type,status,parent_id,episode_number) SELECT id,'Fictional episode','episode','active',${season}::uuid,ordinality::int FROM unnest(${episodes}::uuid[]) WITH ORDINALITY AS entry(id,ordinality)`;
    await sql`INSERT INTO media_files(id,file_path,duration_seconds) VALUES (${file},'/fictional/long-parent.mkv',1200)`;
    await sql`INSERT INTO media_file_items(file_id,media_item_id,is_default) SELECT ${file}::uuid,id,true FROM unnest(${episodes}::uuid[]) AS entry(id)`;
    await sql`INSERT INTO media_streams(file_id,stream_type,stream_index) VALUES (${file},'video',0)`;
});
afterAll(async () => {
    await sql`DELETE FROM media_items WHERE id=ANY(${[...episodes, season, series]}::uuid[])`;
    await sql`DELETE FROM media_files WHERE id=${file}`;
    await closeTestDb();
});
it('serves 1001 canonical child readiness results through the mounted endpoint in bounded database round trips', async () => {
    let queries = 0;
    let receiptQueries = 0;
    database.sql = new Proxy(sql, {
        apply(target, thisArg, args) {
            const source = Array.isArray(args[0]) ? args[0].join('') : '';
            const query = Reflect.apply(target, thisArg, args) as postgres.PendingQuery<
                postgres.Row[]
            >;
            return new Proxy(query, {
                get(pending, key) {
                    if (key === 'then')
                        return (...values: unknown[]) => {
                            queries++;
                            if (source.includes('admin_media_change_receipts')) receiptQueries++;
                            return Reflect.apply(pending.then, pending, values);
                        };
                    return Reflect.get(pending, key);
                },
            });
        },
    });
    const url = new URL(`http://localhost/api/admin/media/${series}/segments`);
    const event = {
        url,
        request: new Request(url),
        params: { id: series },
        locals: adminSession(),
        route: { id: '/api/admin/media/[id]/segments' },
        cookies: { get: vi.fn(), set: vi.fn() },
        getClientAddress: () => '127.0.0.1',
        setHeaders: vi.fn(),
        fetch: vi.fn(),
    } as unknown as RequestEvent;
    const response = await mount(def, { surface: 'internal' }).GET!(event);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.analysisInputs).toHaveLength(1001);
    expect(
        payload.analysisInputs.every(
            (input: { state: string; fileId: string }) =>
                input.state === 'ready' && input.fileId === file,
        ),
    ).toBe(true);
    expect(queries).toBeGreaterThan(0);
    // One indexed lookup exposes the latest Undo receipt, independent of child count.
    expect(receiptQueries).toBe(1);
    expect(queries).toBeLessThanOrEqual(8);
});

it('omits deleted episodes and deleted ancestor seasons from canonical parent readiness', async () => {
    database.sql = sql;
    const url = new URL(`http://localhost/api/admin/media/${series}/segments`);
    const event = {
        url,
        request: new Request(url),
        params: { id: series },
        locals: adminSession(),
        route: { id: '/api/admin/media/[id]/segments' },
        cookies: { get: vi.fn(), set: vi.fn() },
        getClientAddress: () => '127.0.0.1',
        setHeaders: vi.fn(),
        fetch: vi.fn(),
    } as unknown as RequestEvent;
    try {
        await sql`UPDATE media_items SET status='deleted' WHERE id=${episodes[0]!}`;
        expect(
            (await (await mount(def, { surface: 'internal' }).GET!(event)).json()).analysisInputs,
        ).toHaveLength(1000);
        await sql`UPDATE media_items SET status='deleted' WHERE id=${season}`;
        expect(
            (await (await mount(def, { surface: 'internal' }).GET!(event)).json()).analysisInputs,
        ).toEqual([]);
    } finally {
        await sql`UPDATE media_items SET status='active' WHERE id=ANY(${[season, episodes[0]!]}::uuid[])`;
    }
});
