// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { RequestEvent } from '@sveltejs/kit';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../../../../tests/integration/fixtures/index.js';
const mocks = vi.hoisted(() => ({ db: vi.fn() }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: mocks.db }));
import { def, FilesResponseSchema } from './files.js';
let sql: postgres.Sql;
beforeAll(() => {
    sql = getTestDb();
    mocks.db.mockReturnValue(sql);
});
afterAll(async () => {
    await closeTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, TEST_TABLES.media);
});

it('admin files endpoint keeps malformed and mixed warnings visible without transferring raw blobs', async () => {
    const item = createTestMediaItem({
        media_type: 'movie',
        title: 'Health fixture',
        has_files: true,
    });
    await insertTestMediaItem(sql, item);
    const payloads: unknown[] = [
        { unexpected: 'raw object', giant: 'x'.repeat(50000) },
        [
            { type: 'range_superseded', detected_at: '2026-10-25T00:00:00Z' },
            { type: 'truncated_video', detected_at: '2026-10-25T00:00:00Z' },
        ],
    ];
    for (let i = 0; i < payloads.length; i++) {
        const [row] = await sql<{ id: string }[]>`INSERT INTO media_files (file_path, health_issues)
            VALUES (${`/test/admin-files-${i}.mkv`}, ${sql.json(payloads[i] as postgres.JSONValue)}) RETURNING id`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${row.id}::uuid, ${item.id}::uuid, ${i === 0})`;
    }
    const event = {
        locals: { resolvedIds: { internalId: item.id } },
        params: { id: item.id },
        url: new URL(`http://localhost/api/admin/media/${item.id}/files`),
    } as unknown as RequestEvent;
    const response = await def.handlers.GET!(event, { input: { query: {} } } as never);
    expect(response.status).toBe(200);
    const body = FilesResponseSchema.parse(await response.json());
    expect(body.files).toHaveLength(2);
    expect(body.files.every((file) => file.health_classification === 'actionable')).toBe(true);
    expect(
        body.files.some((file) =>
            file.health_issues?.some((issue) => issue.type === 'unknown_recorded_evidence'),
        ),
    ).toBe(true);
    expect(JSON.stringify(body).length).toBeLessThan(10000);
});
