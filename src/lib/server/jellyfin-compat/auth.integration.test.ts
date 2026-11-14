// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the /j (Jellyfin-compat) client-password
 * auth against a REAL Postgres database — no mocked query modules.
 *
 * Fix round 1 on Group G, item 17: the unit-level test in
 * `auth-disabled-user.test.ts` mocks `getPasswordByUsername` to reproduce
 * the real `AND u.disabled_at IS NULL` join clause, but `validatePassword`
 * itself has no disabled-user logic of its own — the predicate lives
 * entirely in the SQL (`jellyfin-client-passwords.queries.ts`). This file
 * drives the real, unmocked `validatePassword` (and `getOrCreatePassword` to
 * seed a genuine scrypt-hashed, sealed row) against a real disabled user, so
 * the predicate is pinned at the function-level seam.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { getOrCreatePassword, validatePassword } from './auth.js';

describe('Jellyfin-compat validatePassword (integration): disabled user rejected at the real SQL predicate', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM users WHERE username LIKE 'jfcompat_authitest_%'`;
    });

    async function createTestUser(username: string, disabled: boolean): Promise<string> {
        const [user] = await sql<{ id: string }[]>`
            INSERT INTO users (username, is_admin)
            VALUES (${username}, false)
            RETURNING id
        `;
        if (disabled) {
            await sql`UPDATE users SET disabled_at = NOW() WHERE id = ${user!.id}`;
        }
        return user!.id;
    }

    it('validatePassword accepts a correct password for an ENABLED user (control)', async () => {
        const username = 'jfcompat_authitest_enabled';
        const userId = await createTestUser(username, false);
        const pin = await getOrCreatePassword(userId);

        const result = await validatePassword(username, pin);

        expect(result).not.toBeNull();
        expect(result?.userId).toBe(userId);
    });

    it('validatePassword refuses a DISABLED user even with the correct password (real SQL predicate)', async () => {
        const username = 'jfcompat_authitest_disabled';
        const userId = await createTestUser(username, true);
        const pin = await getOrCreatePassword(userId);

        const result = await validatePassword(username, pin);

        expect(result).toBeNull();
    });
});
