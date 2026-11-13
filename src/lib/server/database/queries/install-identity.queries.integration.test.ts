// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the install-identity query against a real PostgreSQL
 * test database. Verifies the singleton install UUID is stable across calls and
 * that the table genuinely permits only one row.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { getInstallUuid } from './install-identity.queries.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';

describe('install identity', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    it('returns a valid UUID', async () => {
        const uuid = await getInstallUuid(sql);
        expect(uuid).toMatch(UUID_RE);
    });

    it('returns the SAME UUID across calls (stable per deployment)', async () => {
        const a = await getInstallUuid(sql);
        const b = await getInstallUuid(sql);
        expect(b).toBe(a);
    });

    it('holds exactly one row', async () => {
        await getInstallUuid(sql);
        const [{ count }] = await sql<{ count: string }[]>`
            SELECT COUNT(*)::text AS count FROM license_install
        `;
        expect(count).toBe('1');
    });
});
