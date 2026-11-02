// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { unrestrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { exactSeriesRows } from './exact-series.js';

describe('exact series title branch', () => {
    let sql: postgres.Sql;
    const title = `Exact ${randomUUID()}`;
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    beforeAll(async () => {
        sql = getTestDb();
        for (const [index, id] of ids.entries()) {
            await sql`INSERT INTO media_items (id, title, media_type, year)
                VALUES (${id}, ${index === 3 ? `${title} extra` : title}, ${index === 2 ? 'movie' : 'tv'}, ${2000 + index})`;
        }
    });
    afterAll(async () => {
        await sql`DELETE FROM media_items WHERE id = ANY(${sql.array(ids)}::uuid[])`;
        await closeTestDb();
    });
    it('matches trimmed case-insensitive titles, series only, and pages in stable rank order', async () => {
        const all = await exactSeriesRows(
            sql,
            ` ${title.toUpperCase()} `,
            undefined,
            10,
            0,
            unrestrictedAccess(),
            false,
        );
        expect(all.map((row) => row.internal_id)).toEqual([ids[1], ids[0]]);
        const page = await exactSeriesRows(
            sql,
            title,
            undefined,
            1,
            1,
            unrestrictedAccess(),
            false,
        );
        expect(page.map((row) => row.internal_id)).toEqual([ids[0]]);
    });
    it('applies the year before paging', async () => {
        const rows = await exactSeriesRows(sql, title, 2000, 1, 0, unrestrictedAccess(), false);
        expect(rows.map((row) => row.internal_id)).toEqual([ids[0]]);
    });
});
