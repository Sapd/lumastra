// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for Subsonic-compat auth against a REAL Postgres
 * database — no mocked query modules.
 *
 * Fix round 1 on Group G, item 17: the unit-level tests in
 * `auth-disabled-user.test.ts` mock `getTokenByUsername` / `getTokenByValue`
 * to reproduce the real `AND u.disabled_at IS NULL` join clause, but
 * `subsonic-compat/auth.ts` itself has NO disabled-user logic — the
 * predicate lives entirely in the SQL. That means those unit tests do not
 * discriminate against a regression that removes the predicate from the real
 * query (confirmed independently: removing both `disabled_at` clauses from
 * `subsonic-client-passwords.queries.ts` left all five unit tests green).
 * This file drives the real, unmocked `validateCredentials` / `validateApiKey`
 * against a real seeded row, so the predicate itself is pinned at the
 * function-level seam the original brief asked for.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { validateCredentials, validateApiKey } from './auth.js';

describe('Subsonic compat auth (integration): disabled user rejected at the real SQL predicate', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM users WHERE username LIKE 'subsonic_authitest_%'`;
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

    async function seedPlaintextToken(userId: string, token: string): Promise<void> {
        await sql`
            INSERT INTO subsonic_client_passwords (user_id, token, token_sealed, token_lookup)
            VALUES (${userId}, ${token}, NULL, NULL)
        `;
    }

    it('validateCredentials accepts a correct password for an ENABLED user (control)', async () => {
        const username = 'subsonic_authitest_pw_enabled';
        const userId = await createTestUser(username, false);
        await seedPlaintextToken(userId, 'tok-enabled-pw');

        const result = await validateCredentials(username, { password: 'tok-enabled-pw' });

        expect(result).not.toBeNull();
        expect(result?.userId).toBe(userId);
    });

    it('validateCredentials refuses a DISABLED user even with the correct password (real SQL predicate)', async () => {
        const username = 'subsonic_authitest_pw_disabled';
        const userId = await createTestUser(username, true);
        await seedPlaintextToken(userId, 'tok-disabled-pw');

        const result = await validateCredentials(username, { password: 'tok-disabled-pw' });

        expect(result).toBeNull();
    });

    it('validateApiKey accepts a correct token for an ENABLED user (control)', async () => {
        const username = 'subsonic_authitest_key_enabled';
        const userId = await createTestUser(username, false);
        await seedPlaintextToken(userId, 'tok-enabled-key');

        const result = await validateApiKey('tok-enabled-key', sql);

        expect(result).not.toBeNull();
        expect(result?.userId).toBe(userId);
    });

    it('validateApiKey refuses a DISABLED user even with the correct token as api key (real SQL predicate)', async () => {
        const username = 'subsonic_authitest_key_disabled';
        const userId = await createTestUser(username, true);
        await seedPlaintextToken(userId, 'tok-disabled-key');

        const result = await validateApiKey('tok-disabled-key', sql);

        expect(result).toBeNull();
    });
});
