// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pins the postgres.js behaviour primeArrayTypes works around: on a NEW pool, a
 * first query that passes an untyped `sql.array(strings)` is sent as text and
 * fails with 22P02. If the first case starts passing, postgres.js fixed it and
 * primeArrayTypes (and its call in the task worker sandbox) can go.
 */

import { describe, it, expect, afterEach } from 'vitest';
import postgres from 'postgres';
import { getTestDatabaseUrl } from '../../../../tests/integration/setup/test-database.js';
import { primeArrayTypes } from './prime-array-types.js';

const IDS = ['c79091c3-fcfa-4dbf-8a1b-a69bb944a0f6', '41228eb2-3e66-41ed-a571-6cd08462b4d5'];

describe('primeArrayTypes', () => {
    let pool: postgres.Sql | null = null;

    afterEach(async () => {
        await pool?.end({ timeout: 5 });
        pool = null;
    });

    function freshPool(): postgres.Sql {
        pool = postgres(getTestDatabaseUrl(), { max: 2, onnotice: () => {} });
        return pool;
    }

    it("a cold pool's first sql.array query is sent as text (22P02)", async () => {
        const sql = freshPool();
        await expect(
            sql`SELECT ${IDS[0]}::uuid = ANY(${sql.array(IDS)}::uuid[]) AS hit`,
        ).rejects.toMatchObject({ code: '22P02' });
    });

    it('after priming, the same first array query works', async () => {
        const sql = freshPool();
        await primeArrayTypes(sql);
        const rows = await sql<{ hit: boolean }[]>`
            SELECT ${IDS[0]}::uuid = ANY(${sql.array(IDS)}::uuid[]) AS hit
        `;
        expect(rows[0].hit).toBe(true);
    });
});
