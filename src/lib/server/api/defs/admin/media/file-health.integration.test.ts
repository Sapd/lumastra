// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { RequestEvent } from '@sveltejs/kit';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../tests/integration/helpers/cleanup.js';

const mocks = vi.hoisted(() => ({ db: vi.fn() }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: mocks.db }));
import { def, FileHealthResponseSchema } from './file-health.js';

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

it('GET transfers actionable JSONB warnings without non-finite or giant duration values', async () => {
    await sql`INSERT INTO media_files (file_path, health_issues)
        VALUES ('/test/nonfinite-duration.mkv', jsonb_build_array(jsonb_build_object(
            'type', 'truncated_video', 'expected_duration', 1e400::numeric,
            'actual_duration', repeat('9', 400))))`;
    const event = { url: new URL('http://localhost/api/admin/media/file-health') } as RequestEvent;
    const response = await def.handlers.GET!(event, { input: { query: {} } } as never);
    expect(response.status).toBe(200);
    const body = FileHealthResponseSchema.parse(await response.json());
    expect(body.actionable).toBe(1);
    expect(body.files[0]?.health_issues[0]?.type).toBe('truncated_video');
    expect(body.files[0]?.health_issues[0]?.expected_duration).toBeUndefined();
    expect(body.files[0]?.health_issues[0]?.actual_duration).toBeUndefined();
    expect(JSON.stringify(body).length).toBeLessThan(5000);
});
