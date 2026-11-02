// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Jellyfin Client Passwords Query Module
 *
 * Tests typed query wrappers for jellyfin_client_passwords CRUD operations.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';

import {
    getPasswordByUserId,
    getPasswordByUsername,
    getUsersWithPasswords,
    upsertPassword,
    updateLastUsed,
    deletePassword,
} from './jellyfin-client-passwords.queries.js';

describe('Jellyfin Client Passwords Queries', () => {
    let sql: postgres.Sql;
    let testUserId: string;
    let testUsername: string;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['jellyfin_client_passwords']);
        // Clean up test users from prior runs
        await sql`DELETE FROM users WHERE username LIKE 'jf_pw_test_%'`;

        testUsername = 'jf_pw_test_' + Date.now();
        const [userRow] = await sql<{ id: string }[]>`
            INSERT INTO users (username) VALUES (${testUsername}) RETURNING id
        `;
        testUserId = userRow.id;
    });

    // ========================================================================
    // upsertPassword
    // ========================================================================

    describe('upsertPassword', () => {
        it('inserts a new password record', async () => {
            const result = await upsertPassword.execute(sql, {
                userId: testUserId,
                passwordHash: 'hash123',
                passwordSealed: null,
            });

            expect(result).toHaveLength(1);
            expect(result[0].id).toBeGreaterThan(0);
        });

        it('updates password on conflict', async () => {
            await upsertPassword.execute(sql, {
                userId: testUserId,
                passwordHash: 'hash_old',
                passwordSealed: null,
            });

            const result = await upsertPassword.execute(sql, {
                userId: testUserId,
                passwordHash: 'hash_new',
                passwordSealed: null,
            });

            expect(result).toHaveLength(1);

            const row = await getPasswordByUserId.one(sql, {
                userId: testUserId,
            });
            expect(row!.password_hash).toBe('hash_new');
        });

        it('round-trips the sealed display copy', async () => {
            await upsertPassword.execute(sql, {
                userId: testUserId,
                passwordHash: 'hash123',
                passwordSealed: 'enc:v1:abc',
            });

            const row = await getPasswordByUserId.one(sql, { userId: testUserId });
            expect(row!.password_sealed).toBe('enc:v1:abc');
        });

        it('clears a stale sealed copy when the password is replaced without one', async () => {
            await upsertPassword.execute(sql, {
                userId: testUserId,
                passwordHash: 'hash_old',
                passwordSealed: 'enc:v1:old',
            });

            // Sealing can fail (no master key) — the new hash must not be left
            // paired with the PREVIOUS password's sealed copy, or reveal would
            // hand out a credential that no longer works.
            await upsertPassword.execute(sql, {
                userId: testUserId,
                passwordHash: 'hash_new',
                passwordSealed: null,
            });

            const row = await getPasswordByUserId.one(sql, { userId: testUserId });
            expect(row!.password_hash).toBe('hash_new');
            expect(row!.password_sealed).toBeNull();
        });
    });

    // ========================================================================
    // getPasswordByUserId
    // ========================================================================

    describe('getPasswordByUserId', () => {
        it('returns password record by user ID', async () => {
            await upsertPassword.execute(sql, {
                userId: testUserId,
                passwordHash: 'abc123',
                passwordSealed: null,
            });

            const row = await getPasswordByUserId.one(sql, {
                userId: testUserId,
            });

            expect(row).not.toBeNull();
            expect(row!.user_id).toBe(testUserId);
            expect(row!.password_hash).toBe('abc123');
        });

        it('returns null for user without password', async () => {
            const row = await getPasswordByUserId.one(sql, {
                userId: '00000000-0000-0000-0000-000000000000',
            });
            expect(row).toBeNull();
        });

        it('returns all rows via all()', async () => {
            await upsertPassword.execute(sql, {
                userId: testUserId,
                passwordHash: 'abc123',
                passwordSealed: null,
            });

            const rows = await getPasswordByUserId.all(sql, {
                userId: testUserId,
            });
            expect(rows).toHaveLength(1);
        });
    });

    // ========================================================================
    // getPasswordByUsername
    // ========================================================================

    describe('getPasswordByUsername', () => {
        it('returns password joined with user data', async () => {
            await upsertPassword.execute(sql, {
                userId: testUserId,
                passwordHash: 'hash456',
                passwordSealed: null,
            });

            const row = await getPasswordByUsername.one(sql, {
                username: testUsername,
            });

            expect(row).not.toBeNull();
            expect(row!.username).toBe(testUsername);
            expect(row!.password_hash).toBe('hash456');
            expect(row!.user_id).toBe(testUserId);
        });

        it('returns null for unknown username', async () => {
            const row = await getPasswordByUsername.one(sql, {
                username: 'nobody_xyz',
            });
            expect(row).toBeNull();
        });

        it('returns null for a disabled user (security review 2026-09-13, C2)', async () => {
            await upsertPassword.execute(sql, {
                userId: testUserId,
                passwordHash: 'hash_disabled',
                passwordSealed: null,
            });
            await sql`UPDATE users SET disabled_at = NOW() WHERE id = ${testUserId}::uuid`;
            try {
                const row = await getPasswordByUsername.one(sql, {
                    username: testUsername,
                });
                expect(row).toBeNull();
            } finally {
                await sql`UPDATE users SET disabled_at = NULL WHERE id = ${testUserId}::uuid`;
            }
        });
    });

    // ========================================================================
    // getUsersWithPasswords
    // ========================================================================

    describe('getUsersWithPasswords', () => {
        it('returns users that have passwords', async () => {
            await upsertPassword.execute(sql, {
                userId: testUserId,
                passwordHash: 'hash789',
                passwordSealed: null,
            });

            const rows = await getUsersWithPasswords.all(sql, {});
            const found = rows.find((r) => r.user_id === testUserId);

            expect(found).toBeDefined();
            expect(found!.username).toBe(testUsername);
        });

        it('excludes users without passwords', async () => {
            const rows = await getUsersWithPasswords.all(sql, {});
            const found = rows.find((r) => r.username === testUserId);
            expect(found).toBeUndefined();
        });
    });

    // ========================================================================
    // updateLastUsed
    // ========================================================================

    describe('updateLastUsed', () => {
        it('updates last_used_at timestamp', async () => {
            await upsertPassword.execute(sql, {
                userId: testUserId,
                passwordHash: 'hash000',
                passwordSealed: null,
            });

            const before = await getPasswordByUserId.one(sql, {
                userId: testUserId,
            });
            expect(before!.last_used_at).toBeNull();

            await updateLastUsed.execute(sql, { userId: testUserId });

            const after = await getPasswordByUserId.one(sql, {
                userId: testUserId,
            });
            expect(after!.last_used_at).not.toBeNull();
        });

        it('returns empty array for non-existent user', async () => {
            const result = await updateLastUsed.execute(sql, {
                userId: '00000000-0000-0000-0000-000000000000',
            });
            expect(result).toEqual([]);
        });
    });

    // ========================================================================
    // deletePassword
    // ========================================================================

    describe('deletePassword', () => {
        it('deletes password record', async () => {
            await upsertPassword.execute(sql, {
                userId: testUserId,
                passwordHash: 'todelete',
                passwordSealed: null,
            });

            const before = await getPasswordByUserId.one(sql, {
                userId: testUserId,
            });
            expect(before).not.toBeNull();

            await deletePassword.execute(sql, { userId: testUserId });

            const after = await getPasswordByUserId.one(sql, {
                userId: testUserId,
            });
            expect(after).toBeNull();
        });

        it('returns empty array for non-existent user', async () => {
            const result = await deletePassword.execute(sql, {
                userId: '00000000-0000-0000-0000-000000000000',
            });
            expect(result).toEqual([]);
        });
    });
});
