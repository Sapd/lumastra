// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the server-side preview start-position default.
 *
 * The critical case is an explicit 0: trailers and Live TV pin it, and treating
 * "0" as "absent" would silently move them off the start of the clip.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { resolvePreviewStartPosition } from './preview-start-position.js';
import {
    calculateSmartPreviewPosition,
    PREVIEW_FALLBACK_START_SECONDS,
} from '$lib/shared/preview-position.js';
import { getTestDatabaseUrl } from '../../../../tests/integration/setup/test-database.js';

const TEST_DATABASE_URL = getTestDatabaseUrl();

let sql: postgres.Sql;
const createdIds: string[] = [];

beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL, { max: 2 });
});

afterAll(async () => {
    if (createdIds.length > 0) {
        await sql`DELETE FROM media_items WHERE id = ANY(${createdIds}::uuid[])`;
    }
    await sql.end();
});

async function makeMovie(runtimeSeconds: number | null): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, status, runtime_seconds)
        VALUES ('Preview Start Fixture', 'movie', 'active', ${runtimeSeconds})
        RETURNING id
    `;
    createdIds.push(row.id);
    return row.id;
}

describe('resolvePreviewStartPosition', () => {
    it('honours an explicit 0 — trailers and Live TV depend on it', async () => {
        const id = await makeMovie(7200);
        expect(await resolvePreviewStartPosition(sql, id, 0)).toBe(0);
    });

    it('honours an explicit resume position verbatim', async () => {
        const id = await makeMovie(7200);
        expect(await resolvePreviewStartPosition(sql, id, 1234)).toBe(1234);
    });

    it('computes a runtime-proportional start when the client omits the field', async () => {
        const id = await makeMovie(7200); // 120 minutes
        const start = await resolvePreviewStartPosition(sql, id, undefined);

        // Well past the 30-90s studio-logo window, and inside the content.
        expect(start).toBeGreaterThan(PREVIEW_FALLBACK_START_SECONDS);
        expect(start).toBeLessThan(7200);
    });

    it('matches the web client heuristic exactly for the same item', async () => {
        // This is the whole point of the shared module: server and client must
        // not drift. Same UUID + same runtime => same seek.
        const id = await makeMovie(7200);
        const server = await resolvePreviewStartPosition(sql, id, undefined);
        const client = calculateSmartPreviewPosition({ runtimeMinutes: 120, itemKey: id });
        expect(server).toBe(client);
    });

    it('is deterministic so repeat requests stay cache-coalescable', async () => {
        const id = await makeMovie(5400);
        const a = await resolvePreviewStartPosition(sql, id, undefined);
        const b = await resolvePreviewStartPosition(sql, id, undefined);
        expect(a).toBe(b);
    });

    it('falls back to the post-logo constant when runtime is unknown', async () => {
        const id = await makeMovie(null);
        expect(await resolvePreviewStartPosition(sql, id, undefined)).toBe(
            PREVIEW_FALLBACK_START_SECONDS,
        );
    });

    it('falls back rather than throwing for an unknown media id', async () => {
        expect(
            await resolvePreviewStartPosition(
                sql,
                '00000000-0000-0000-0000-000000000000',
                undefined,
            ),
        ).toBe(PREVIEW_FALLBACK_START_SECONDS);
    });

    it('falls back when there is no database', async () => {
        expect(await resolvePreviewStartPosition(null, 'whatever', undefined)).toBe(
            PREVIEW_FALLBACK_START_SECONDS,
        );
    });
});
