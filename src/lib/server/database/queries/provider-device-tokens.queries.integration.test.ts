// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Provider Device Tokens Query Module
 *
 * Tests getJellyfinTokenBySession, getActiveJellyfinTokens,
 * upsertJellyfinToken, updateJellyfinTokenLastUsed, deleteJellyfinToken,
 * revokeJellyfinToken, revokeAllUserJellyfinTokens,
 * cleanupOrphanedJellyfinTokens, cleanupRevokedJellyfinTokens.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/index.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';

import {
    getJellyfinTokenBySession,
    getActiveJellyfinTokens,
    upsertJellyfinToken,
    updateJellyfinTokenLastUsed,
    deleteJellyfinToken,
    revokeJellyfinToken,
    revokeAllUserJellyfinTokens,
    cleanupOrphanedJellyfinTokens,
    cleanupRevokedJellyfinTokens,
} from './provider-device-tokens.queries.js';

describe('Provider Device Tokens Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['user_provider_device_tokens']);
        // pdt_test_* usernames are derived by ensureTestUser; clean up by username prefix
        await sql`DELETE FROM users WHERE username LIKE 'u_pdt_test%' OR username LIKE 'pdt_test_%'`;
    });

    // Returns a stable UUID to use as users.id (mig 16.46.0 — user_provider_device_tokens.user_id is now uuid).
    // The suffix is embedded in the derived username so the user_id is both unique
    // and traceable in cleanup queries.
    async function createTestUser(_label: string): Promise<UserId> {
        const userId = toUserId(randomUUID());
        await ensureTestUser(sql, userId);
        return userId;
    }

    // ========================================================================
    // getJellyfinTokenBySession
    // ========================================================================

    describe('getJellyfinTokenBySession', () => {
        it('returns active token by session ID', async () => {
            const userId = await createTestUser('pdt_test_a');
            const sessionId = 'session-a';
            await upsertJellyfinToken(sql, {
                userId,
                jellyfinUserId: 'jf-user-a',
                deviceSessionId: sessionId,
                deviceName: 'Device A',
                accessToken: 'tok-a',
                deviceId: 'dev-a',
            });

            const row = await getJellyfinTokenBySession(sql, sessionId);

            expect(row).not.toBeNull();
            expect(row!.device_session_id).toBe(sessionId);
            expect(row!.provider_access_token).toBe('tok-a');
        });

        it('returns null for revoked token', async () => {
            const userId = await createTestUser('pdt_test_b');
            const sessionId = 'session-b';
            await upsertJellyfinToken(sql, {
                userId,
                jellyfinUserId: 'jf-user-b',
                deviceSessionId: sessionId,
                deviceName: 'Device B',
                accessToken: 'tok-b',
                deviceId: 'dev-b',
            });
            await revokeJellyfinToken(sql, sessionId);

            const row = await getJellyfinTokenBySession(sql, sessionId);
            expect(row).toBeNull();
        });

        it('returns null for unknown session', async () => {
            const row = await getJellyfinTokenBySession(sql, 'no-such-session');
            expect(row).toBeNull();
        });
    });

    // ========================================================================
    // getActiveJellyfinTokens
    // ========================================================================

    describe('getActiveJellyfinTokens', () => {
        it('returns only active tokens for user', async () => {
            const userId = await createTestUser('pdt_test_c');

            await upsertJellyfinToken(sql, {
                userId,
                jellyfinUserId: 'jf-user-c',
                deviceSessionId: 's1',
                deviceName: 'D1',
                accessToken: 't1',
                deviceId: null,
            });
            await upsertJellyfinToken(sql, {
                userId,
                jellyfinUserId: 'jf-user-c',
                deviceSessionId: 's2',
                deviceName: 'D2',
                accessToken: 't2',
                deviceId: null,
            });
            await revokeJellyfinToken(sql, 's2');

            const rows = await getActiveJellyfinTokens(sql, userId);
            expect(rows).toHaveLength(1);
            expect(rows[0].device_session_id).toBe('s1');
        });

        it('orders by created_at DESC', async () => {
            const userId = await createTestUser('pdt_test_d');

            await upsertJellyfinToken(sql, {
                userId,
                jellyfinUserId: 'jf-user-d',
                deviceSessionId: 's-older',
                deviceName: 'D',
                accessToken: 't1',
                deviceId: null,
            });
            await new Promise((r) => setTimeout(r, 50));
            await upsertJellyfinToken(sql, {
                userId,
                jellyfinUserId: 'jf-user-d',
                deviceSessionId: 's-newer',
                deviceName: 'D',
                accessToken: 't2',
                deviceId: null,
            });

            const rows = await getActiveJellyfinTokens(sql, userId);
            expect(rows[0].device_session_id).toBe('s-newer');
            expect(rows[1].device_session_id).toBe('s-older');
        });
    });

    // ========================================================================
    // upsertJellyfinToken
    // ========================================================================

    describe('upsertJellyfinToken', () => {
        it('inserts a new token', async () => {
            const userId = await createTestUser('pdt_test_e');
            await upsertJellyfinToken(sql, {
                userId,
                jellyfinUserId: 'jf-e',
                deviceSessionId: 's-e',
                deviceName: 'D',
                accessToken: 'tok-e',
                deviceId: 'dev-e',
            });

            const row = await getJellyfinTokenBySession(sql, 's-e');
            expect(row).not.toBeNull();
            expect(row!.device_id).toBe('dev-e');
        });

        it('updates on conflict and preserves existing device_id if new is null', async () => {
            const userId = await createTestUser('pdt_test_f');
            await upsertJellyfinToken(sql, {
                userId,
                jellyfinUserId: 'jf-f',
                deviceSessionId: 's-f',
                deviceName: 'D',
                accessToken: 'tok-f',
                deviceId: 'dev-f',
            });

            await upsertJellyfinToken(sql, {
                userId,
                jellyfinUserId: 'jf-f2',
                deviceSessionId: 's-f',
                deviceName: 'D2',
                accessToken: 'tok-f2',
                deviceId: null,
            });

            const row = await getJellyfinTokenBySession(sql, 's-f');
            expect(row!.device_id).toBe('dev-f');
            expect(row!.provider_access_token).toBe('tok-f2');
        });
    });

    // ========================================================================
    // updateJellyfinTokenLastUsed
    // ========================================================================

    describe('updateJellyfinTokenLastUsed', () => {
        it('updates last_used_at', async () => {
            const userId = await createTestUser('pdt_test_g');
            await upsertJellyfinToken(sql, {
                userId,
                jellyfinUserId: 'jf-g',
                deviceSessionId: 's-g',
                deviceName: 'D',
                accessToken: 't',
                deviceId: null,
            });

            await updateJellyfinTokenLastUsed(sql, 's-g');

            const row = await getJellyfinTokenBySession(sql, 's-g');
            expect(row!.last_used_at).not.toBeNull();
        });
    });

    // ========================================================================
    // deleteJellyfinToken
    // ========================================================================

    describe('deleteJellyfinToken', () => {
        it('removes token by session', async () => {
            const userId = await createTestUser('pdt_test_h');
            await upsertJellyfinToken(sql, {
                userId,
                jellyfinUserId: 'jf-h',
                deviceSessionId: 's-h',
                deviceName: 'D',
                accessToken: 't',
                deviceId: null,
            });

            await deleteJellyfinToken(sql, 's-h');

            const row = await getJellyfinTokenBySession(sql, 's-h');
            expect(row).toBeNull();
        });
    });

    // ========================================================================
    // revokeJellyfinToken
    // ========================================================================

    describe('revokeJellyfinToken', () => {
        it('revokes token without user filter', async () => {
            const userId = await createTestUser('pdt_test_i');
            await upsertJellyfinToken(sql, {
                userId,
                jellyfinUserId: 'jf-i',
                deviceSessionId: 's-i',
                deviceName: 'D',
                accessToken: 't',
                deviceId: null,
            });

            const count = await revokeJellyfinToken(sql, 's-i');

            expect(count).toBe(1);
            const row = await getJellyfinTokenBySession(sql, 's-i');
            expect(row).toBeNull();
        });

        it('only revokes when userId matches', async () => {
            const userId = await createTestUser('pdt_test_j');
            const otherUserId = await createTestUser('pdt_test_j2');
            await upsertJellyfinToken(sql, {
                userId: otherUserId,
                jellyfinUserId: 'jf-j',
                deviceSessionId: 's-j',
                deviceName: 'D',
                accessToken: 't',
                deviceId: null,
            });

            const count = await revokeJellyfinToken(sql, 's-j', userId);

            expect(count).toBe(0);
            const row = await getJellyfinTokenBySession(sql, 's-j');
            expect(row).not.toBeNull();
        });
    });

    // ========================================================================
    // revokeAllUserJellyfinTokens
    // ========================================================================

    describe('revokeAllUserJellyfinTokens', () => {
        it('revokes every active token for the user', async () => {
            const userId = await createTestUser('pdt_test_k');
            await upsertJellyfinToken(sql, {
                userId,
                jellyfinUserId: 'jf-k',
                deviceSessionId: 's-k1',
                deviceName: 'D1',
                accessToken: 't1',
                deviceId: null,
            });
            await upsertJellyfinToken(sql, {
                userId,
                jellyfinUserId: 'jf-k',
                deviceSessionId: 's-k2',
                deviceName: 'D2',
                accessToken: 't2',
                deviceId: null,
            });

            const count = await revokeAllUserJellyfinTokens(sql, userId);

            expect(count).toBe(2);
            const rows = await getActiveJellyfinTokens(sql, userId);
            expect(rows).toHaveLength(0);
        });
    });

    // ========================================================================
    // cleanupOrphanedJellyfinTokens
    // ========================================================================

    describe('cleanupOrphanedJellyfinTokens', () => {
        it('deletes tokens older than threshold', async () => {
            const userId = await createTestUser('pdt_test_l');
            await upsertJellyfinToken(sql, {
                userId,
                jellyfinUserId: 'jf-l',
                deviceSessionId: 's-old',
                deviceName: 'D',
                accessToken: 't',
                deviceId: null,
            });
            // Artificially age the token
            await sql`
                UPDATE user_provider_device_tokens
                SET created_at = NOW() - INTERVAL '100 days'
                WHERE device_session_id = 's-old'
            `;

            const deleted = await cleanupOrphanedJellyfinTokens(
                sql,
                new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            );

            expect(deleted.length).toBe(1);
            expect(deleted[0].device_session_id).toBe('s-old');
        });
    });

    // ========================================================================
    // cleanupRevokedJellyfinTokens
    // ========================================================================

    describe('cleanupRevokedJellyfinTokens', () => {
        it('deletes revoked tokens older than 7 days', async () => {
            const userId = await createTestUser('pdt_test_m');
            await upsertJellyfinToken(sql, {
                userId,
                jellyfinUserId: 'jf-m',
                deviceSessionId: 's-revoked',
                deviceName: 'D',
                accessToken: 't',
                deviceId: null,
            });
            // Revoke and age
            await revokeJellyfinToken(sql, 's-revoked');
            await sql`
                UPDATE user_provider_device_tokens
                SET revoked_at = NOW() - INTERVAL '10 days'
                WHERE device_session_id = 's-revoked'
            `;

            const count = await cleanupRevokedJellyfinTokens(sql);

            expect(count).toBe(1);
        });

        it('keeps recently revoked tokens', async () => {
            const userId = await createTestUser('pdt_test_n');
            await upsertJellyfinToken(sql, {
                userId,
                jellyfinUserId: 'jf-n',
                deviceSessionId: 's-recent',
                deviceName: 'D',
                accessToken: 't',
                deviceId: null,
            });
            await revokeJellyfinToken(sql, 's-recent');

            const count = await cleanupRevokedJellyfinTokens(sql);

            expect(count).toBe(0);
        });
    });
});
