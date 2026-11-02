// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for OAuth Admin Query Module
 *
 * Tests user groups, token revocation, and privacy settings.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestOAuthToken,
    insertTestOAuthToken,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    upsertUserGroups,
    revokeOAuthTokenBySessionId,
    getHiddenUsers,
    setUserPrivacySetting,
} from './oauth-admin.queries.js';
import { revokeAllUserRefreshTokensDetailed } from './oauth-refresh-tokens.queries.js';

describe('OAuth Admin Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.sessions);
        // Clean up test users created by this suite
        await sql`DELETE FROM users WHERE username LIKE 'test_oauth_admin_%'`;
    });

    // ========================================================================
    // upsertUserGroups
    // ========================================================================

    describe('upsertUserGroups', () => {
        it('inserts a new user with groups', async () => {
            const username = 'test_oauth_admin_groups';
            await upsertUserGroups(sql, username, ['admin', 'user']);

            const row = await sql<{ username: string; groups: string[] }[]>`
                SELECT username, groups FROM users WHERE username = ${username.toLowerCase()}
            `;
            expect(row[0].groups).toEqual(['admin', 'user']);
        });

        it('updates groups for existing user', async () => {
            const username = 'test_oauth_admin_groups2';
            await upsertUserGroups(sql, username, ['user']);
            await upsertUserGroups(sql, username, ['admin']);

            const row = await sql<{ groups: string[] }[]>`
                SELECT groups FROM users WHERE username = ${username.toLowerCase()}
            `;
            expect(row[0].groups).toEqual(['admin']);
        });
    });

    // ========================================================================
    // revokeOAuthTokenBySessionId
    // ========================================================================

    describe('revokeOAuthTokenBySessionId', () => {
        it('revokes token by session id', async () => {
            // user_id in oauth_refresh_tokens is now uuid (mig 16.46.0)
            const userId: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);
            const token = createTestOAuthToken(userId, { revoked: false });
            await insertTestOAuthToken(sql, token);

            const result = await revokeOAuthTokenBySessionId(sql, token.device_session_id, userId);
            expect(result.revokedCount).toBe(1);

            const row = await sql<{ revoked_at: Date | null }[]>`
                SELECT revoked_at FROM oauth_refresh_tokens WHERE device_session_id = ${token.device_session_id}
            `;
            expect(row[0].revoked_at).not.toBeNull();
        });

        it('returns zero when no matching active token', async () => {
            const result = await revokeOAuthTokenBySessionId(
                sql,
                'no_session',
                toUserId(randomUUID()),
            );
            expect(result.revokedCount).toBe(0);
        });
    });

    // ========================================================================
    // revokeAllUserRefreshTokensDetailed (replaced the dead
    // revokeAllOAuthTokensForUser, which skipped the session lock + hook)
    // ========================================================================

    describe('revokeAllUserRefreshTokensDetailed', () => {
        it('revokes all active tokens for a user', async () => {
            // user_id in oauth_refresh_tokens is now uuid (mig 16.46.0)
            const userId: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);
            const t1 = createTestOAuthToken(userId, { revoked: false });
            const t2 = createTestOAuthToken(userId, { revoked: false });
            await insertTestOAuthToken(sql, t1);
            await insertTestOAuthToken(sql, t2);

            const result = await revokeAllUserRefreshTokensDetailed(sql, userId);
            expect(result.count).toBe(2);

            const rows = await sql<{ count: number }[]>`
                SELECT COUNT(*)::int AS count FROM oauth_refresh_tokens
                WHERE user_id = ${userId}::uuid AND revoked_at IS NULL
            `;
            expect(rows[0].count).toBe(0);
        });
    });

    // ========================================================================
    // getHiddenUsers
    // ========================================================================

    describe('getHiddenUsers', () => {
        it('returns users with hide_streams enabled', async () => {
            const username = 'test_oauth_admin_hidden';
            await sql`INSERT INTO users (username) VALUES (${username})`;
            await setUserPrivacySetting(sql, username, true);

            const hidden = await getHiddenUsers(sql);
            expect(hidden.some((u) => u.username === username)).toBe(true);
        });

        it('does not return users without privacy enabled', async () => {
            const username = 'test_oauth_admin_visible';
            await sql`INSERT INTO users (username) VALUES (${username})`;
            await setUserPrivacySetting(sql, username, false);

            const hidden = await getHiddenUsers(sql);
            expect(hidden.some((u) => u.username === username)).toBe(false);
        });
    });

    // ========================================================================
    // setUserPrivacySetting
    // ========================================================================

    describe('setUserPrivacySetting', () => {
        it('sets hide_streams and stamps privacy_prefs_updated_at', async () => {
            const username = 'test_oauth_admin_privacy';
            await sql`INSERT INTO users (username) VALUES (${username})`;
            expect(await setUserPrivacySetting(sql, username, true)).toBe(true);

            const row = await sql<
                { hide_streams: boolean; privacy_prefs_updated_at: Date | null }[]
            >`
                SELECT hide_streams, privacy_prefs_updated_at FROM users WHERE username = ${username}
            `;
            expect(row[0].hide_streams).toBe(true);
            expect(row[0].privacy_prefs_updated_at).not.toBeNull();
        });

        it('matches the stored lowercase name when the admin sends another case', async () => {
            const username = 'test_oauth_admin_mixed';
            await sql`INSERT INTO users (username) VALUES (${username})`;
            expect(await setUserPrivacySetting(sql, 'Test_OAuth_Admin_Mixed', true)).toBe(true);

            const rows = await sql<{ username: string; hide_streams: boolean }[]>`
                SELECT username, hide_streams FROM users
                WHERE lower(username) = ${username}
            `;
            expect(rows).toEqual([{ username, hide_streams: true }]);
        });

        it('returns false and creates no row for an unknown user', async () => {
            expect(await setUserPrivacySetting(sql, 'test_oauth_admin_ghost', true)).toBe(false);
            const rows = await sql`
                SELECT 1 FROM users WHERE username = 'test_oauth_admin_ghost'
            `;
            expect(rows).toHaveLength(0);
        });
    });
});
