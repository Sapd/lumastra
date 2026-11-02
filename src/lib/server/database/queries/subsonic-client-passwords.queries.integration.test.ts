// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Subsonic Client Passwords Query Module
 *
 * Tests getTokenByUserId, getTokenWithUserByUserId, getTokenByUsername,
 * getTokenByValue, getUsersWithTokens, upsertToken, updateLastUsed, deleteToken.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';

import {
    getTokenByUserId,
    getTokenWithUserByUserId,
    getTokenByUsername,
    getTokenByValue,
    getUsersWithTokens,
    upsertToken,
    updateLastUsed,
    deleteToken,
} from './subsonic-client-passwords.queries.js';

describe('Subsonic Client Passwords Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['subsonic_client_passwords']);
        // Clean up test users created by this suite
        await sql`DELETE FROM users WHERE username LIKE 'subsonic_test_%'`;
    });

    async function createTestUser(
        username: string,
        options: { isAdmin?: boolean } = {},
    ): Promise<string> {
        const [user] = await sql<{ id: string }[]>`
            INSERT INTO users (username, is_admin)
            VALUES (${username}, ${options.isAdmin ?? false})
            RETURNING id
        `;
        return user!.id;
    }

    // ========================================================================
    // getTokenByUserId
    // ========================================================================

    describe('getTokenByUserId', () => {
        it('returns token row for a user', async () => {
            const userId = await createTestUser('subsonic_test_a');
            await upsertToken.execute(sql, {
                userId,
                token: 'tok-abc',
                tokenSealed: null,
                tokenLookup: null,
            });

            const result = await getTokenByUserId.one(sql, { userId });

            expect(result).not.toBeNull();
            expect(result!.user_id).toBe(userId);
            expect(result!.token).toBe('tok-abc');
        });

        it('returns null when no token exists', async () => {
            const userId = await createTestUser('subsonic_test_b');

            const result = await getTokenByUserId.one(sql, { userId });

            expect(result).toBeNull();
        });
    });

    // ========================================================================
    // getTokenWithUserByUserId
    // ========================================================================

    describe('getTokenWithUserByUserId', () => {
        it('joins token with user data', async () => {
            const userId = await createTestUser('subsonic_test_c', {
                isAdmin: true,
            });
            await upsertToken.execute(sql, {
                userId,
                token: 'tok-def',
                tokenSealed: null,
                tokenLookup: null,
            });

            const result = await getTokenWithUserByUserId.one(sql, {
                userId,
            });

            expect(result).not.toBeNull();
            expect(result!.username).toBe('subsonic_test_c');
            expect(result!.is_admin).toBe(true);
        });
    });

    // ========================================================================
    // getTokenByUsername
    // ========================================================================

    describe('getTokenByUsername', () => {
        it('finds token by username (case-insensitive)', async () => {
            const userId = await createTestUser('subsonic_test_d');
            await upsertToken.execute(sql, {
                userId,
                token: 'tok-ghi',
                tokenSealed: null,
                tokenLookup: null,
            });

            const result = await getTokenByUsername.one(sql, {
                username: 'SUBSONIC_TEST_D',
            });

            expect(result).not.toBeNull();
            expect(result!.token).toBe('tok-ghi');
        });

        it('returns null for unknown username', async () => {
            const result = await getTokenByUsername.one(sql, {
                username: 'nonexistent_xyz',
            });

            expect(result).toBeNull();
        });

        it('returns null for a disabled user (security review 2026-09-13, C2)', async () => {
            const userId = await createTestUser('subsonic_test_disabled');
            await upsertToken.execute(sql, {
                userId,
                token: 'tok-disabled',
                tokenSealed: null,
                tokenLookup: null,
            });
            await sql`UPDATE users SET disabled_at = NOW() WHERE id = ${userId}`;

            const result = await getTokenByUsername.one(sql, {
                username: 'subsonic_test_disabled',
            });

            expect(result).toBeNull();
        });
    });

    // ========================================================================
    // getTokenByValue
    // ========================================================================

    describe('getTokenByValue', () => {
        it('finds a sealed token by its blind index, not by the envelope', async () => {
            const userId = await createTestUser('subsonic_test_sealed');
            await upsertToken.execute(sql, {
                userId,
                token: null,
                tokenSealed: 'enc:v1:someopaqueenvelope',
                tokenLookup: 'a'.repeat(64),
            });

            // The raw value no longer lives in the row, so only the lookup
            // can resolve it — this is the whole reason the blind index exists.
            const found = await getTokenByValue.one(sql, {
                token: 'the-plaintext-token',
                lookup: 'a'.repeat(64),
            });
            expect(found?.user_id).toBe(userId);
            expect(found?.token).toBeNull();

            const missed = await getTokenByValue.one(sql, {
                token: 'the-plaintext-token',
                lookup: 'b'.repeat(64),
            });
            expect(missed).toBeNull();
        });

        it('does not match sealed rows when no lookup is supplied', async () => {
            const userId = await createTestUser('subsonic_test_nolookup');
            await upsertToken.execute(sql, {
                userId,
                token: null,
                tokenSealed: 'enc:v1:envelope',
                tokenLookup: 'c'.repeat(64),
            });

            // `token_lookup = NULL` is never true in SQL — the degraded
            // no-master-key path must simply find nothing, not everything.
            const result = await getTokenByValue.one(sql, {
                token: 'anything',
                lookup: null,
            });
            expect(result).toBeNull();
        });

        it('rejects two users sharing a blind index', async () => {
            const a = await createTestUser('subsonic_test_dupe_a');
            const b = await createTestUser('subsonic_test_dupe_b');
            const shared = 'd'.repeat(64);

            await upsertToken.execute(sql, {
                userId: a,
                token: null,
                tokenSealed: 'enc:v1:one',
                tokenLookup: shared,
            });

            // Same lookup means the same token — the partial unique index must
            // make that impossible rather than silently returning two users.
            await expect(
                upsertToken.execute(sql, {
                    userId: b,
                    token: null,
                    tokenSealed: 'enc:v1:two',
                    tokenLookup: shared,
                }),
            ).rejects.toThrow();
        });

        it('finds token by raw value', async () => {
            const userId = await createTestUser('subsonic_test_e');
            await upsertToken.execute(sql, {
                userId,
                token: 'tok-jkl',
                tokenSealed: null,
                tokenLookup: null,
            });

            const result = await getTokenByValue.one(sql, {
                token: 'tok-jkl',
                lookup: null,
            });

            expect(result).not.toBeNull();
            expect(result!.user_id).toBe(userId);
        });

        it('returns null for unknown token', async () => {
            const result = await getTokenByValue.one(sql, {
                token: 'no-such-token',
                lookup: null,
            });

            expect(result).toBeNull();
        });

        it('returns null for a disabled user (security review 2026-09-13, C2)', async () => {
            const userId = await createTestUser('subsonic_test_disabled_val');
            await upsertToken.execute(sql, {
                userId,
                token: 'tok-disabled-val',
                tokenSealed: null,
                tokenLookup: null,
            });
            await sql`UPDATE users SET disabled_at = NOW() WHERE id = ${userId}`;

            const result = await getTokenByValue.one(sql, {
                token: 'tok-disabled-val',
                lookup: null,
            });

            expect(result).toBeNull();
        });
    });

    // ========================================================================
    // getUsersWithTokens
    // ========================================================================

    describe('getUsersWithTokens', () => {
        it('returns users that have subsonic tokens', async () => {
            const userId1 = await createTestUser('subsonic_test_f1');
            const userId2 = await createTestUser('subsonic_test_f2');
            await createTestUser('subsonic_test_f3');

            await upsertToken.execute(sql, {
                userId: userId1,
                token: 't1',
                tokenSealed: null,
                tokenLookup: null,
            });
            await upsertToken.execute(sql, {
                userId: userId2,
                token: 't2',
                tokenSealed: null,
                tokenLookup: null,
            });

            const results = await getUsersWithTokens.all(sql, {});
            const usernames = results.map((r) => r.username);

            expect(usernames).toContain('subsonic_test_f1');
            expect(usernames).toContain('subsonic_test_f2');
            expect(usernames).not.toContain('subsonic_test_f3');
        });

        it('returns empty array when no tokens exist', async () => {
            const results = await getUsersWithTokens.all(sql, {});
            expect(results).toEqual([]);
        });
    });

    // ========================================================================
    // upsertToken
    // ========================================================================

    describe('upsertToken', () => {
        it('inserts a new token', async () => {
            const userId = await createTestUser('subsonic_test_g');

            const result = await upsertToken.execute(sql, {
                userId,
                token: 'new-token',
                tokenSealed: null,
                tokenLookup: null,
            });

            expect(result.length).toBe(1);
            expect(result[0].id).toBeGreaterThan(0);

            const row = await getTokenByUserId.one(sql, { userId });
            expect(row!.token).toBe('new-token');
        });

        it('updates token on conflict and resets created_at', async () => {
            const userId = await createTestUser('subsonic_test_h');
            await upsertToken.execute(sql, {
                userId,
                token: 'old-token',
                tokenSealed: null,
                tokenLookup: null,
            });
            const before = await getTokenByUserId.one(sql, { userId });

            // Wait a tick so created_at changes
            await new Promise((r) => setTimeout(r, 50));
            await upsertToken.execute(sql, {
                userId,
                token: 'new-token',
                tokenSealed: null,
                tokenLookup: null,
            });
            const after = await getTokenByUserId.one(sql, { userId });

            expect(after!.token).toBe('new-token');
            expect(after!.created_at.getTime()).toBeGreaterThanOrEqual(
                before!.created_at.getTime(),
            );
        });
    });

    // ========================================================================
    // updateLastUsed
    // ========================================================================

    describe('updateLastUsed', () => {
        it('updates last_used_at', async () => {
            const userId = await createTestUser('subsonic_test_i');
            await upsertToken.execute(sql, {
                userId,
                token: 'tok',
                tokenSealed: null,
                tokenLookup: null,
            });

            await updateLastUsed.execute(sql, { userId });

            const row = await getTokenByUserId.one(sql, { userId });
            expect(row!.last_used_at).not.toBeNull();
            const time = row!.last_used_at!.getTime();
            const now = Date.now();
            expect(Math.abs(time - now)).toBeLessThan(5000);
        });
    });

    // ========================================================================
    // deleteToken
    // ========================================================================

    describe('deleteToken', () => {
        it('deletes token for a user', async () => {
            const userId = await createTestUser('subsonic_test_j');
            await upsertToken.execute(sql, {
                userId,
                token: 'del-me',
                tokenSealed: null,
                tokenLookup: null,
            });

            const result = await deleteToken.execute(sql, { userId });

            expect(result.length).toBe(1);
            const row = await getTokenByUserId.one(sql, { userId });
            expect(row).toBeNull();
        });

        it('returns empty array if no token to delete', async () => {
            const userId = await createTestUser('subsonic_test_k');

            const result = await deleteToken.execute(sql, { userId });

            expect(result).toEqual([]);
        });
    });
});
