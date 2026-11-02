// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Device Sessions Query Module
 *
 * Tests OAuth token operations, session management, and cleanup.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestOAuthToken,
    createTestOAuthTokensBatch,
    insertTestOAuthToken,
    insertTestOAuthTokens,
    generateTestUserId,
} from '../../../../../tests/integration/fixtures/index.js';

// Import query functions to test
import {
    getActiveSessions,
    getAllSessions,
    getDeviceSummary,
    updateSessionLastUsed,
    cleanupExpiredSessions,
} from './device-sessions.queries.js';
import { revokeAllUserRefreshTokensDetailed } from './oauth-refresh-tokens.queries.js';
import type { UserId } from '$lib/shared/user-id.js';

describe('Device Sessions Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.sessions);
    });

    // ==========================================================================
    // Read Queries
    // ==========================================================================

    describe('getActiveSessions', () => {
        it('returns only active (non-revoked, non-expired) sessions', async () => {
            const username = generateTestUserId();

            const tokens = [
                createTestOAuthToken(username, {
                    deviceName: 'Active 1',
                    revoked: false,
                }),
                createTestOAuthToken(username, {
                    deviceName: 'Active 2',
                    revoked: false,
                }),
                createTestOAuthToken(username, {
                    deviceName: 'Revoked',
                    revoked: true,
                }),
            ];
            await insertTestOAuthTokens(sql, tokens);

            const result = await getActiveSessions.all(sql, {
                userId: username,
            });

            expect(result.length).toBe(2);
            result.forEach((session) => {
                expect(session.revoked_at).toBeNull();
            });
        });

        it('excludes expired sessions', async () => {
            const username = generateTestUserId();

            const futureToken = createTestOAuthToken(username, {
                deviceName: 'Valid',
                expiresInDays: 30,
            });

            // Manually create an expired token
            const expiredToken = createTestOAuthToken(username, {
                deviceName: 'Expired',
                expiresInDays: -1, // Already expired
            });

            await insertTestOAuthToken(sql, futureToken);
            await insertTestOAuthToken(sql, expiredToken);

            const result = await getActiveSessions.all(sql, {
                userId: username,
            });

            expect(result.length).toBe(1);
            expect(result[0].device_name).toBe('Valid');
        });

        it('orders by last_used_at DESC', async () => {
            const username = generateTestUserId();

            const now = new Date();
            const tokens = [
                createTestOAuthToken(username, {
                    deviceName: 'Oldest',
                    lastUsed: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
                }),
                createTestOAuthToken(username, {
                    deviceName: 'Newest',
                    lastUsed: new Date(),
                }),
                createTestOAuthToken(username, {
                    deviceName: 'Middle',
                    lastUsed: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),
                }),
            ];
            await insertTestOAuthTokens(sql, tokens);

            const result = await getActiveSessions.all(sql, {
                userId: username,
            });

            expect(result[0].device_name).toBe('Newest');
            expect(result[2].device_name).toBe('Oldest');
        });
    });

    describe('getAllSessions', () => {
        it('returns all sessions including revoked', async () => {
            const username = generateTestUserId();

            const tokens = [
                createTestOAuthToken(username, { revoked: false }),
                createTestOAuthToken(username, { revoked: true }),
                createTestOAuthToken(username, { revoked: false }),
            ];
            await insertTestOAuthTokens(sql, tokens);

            const result = await getAllSessions.all(sql, { userId: username });

            expect(result.length).toBe(3);
            const revokedCount = result.filter((s) => s.revoked_at !== null).length;
            expect(revokedCount).toBe(1);
        });

        it('orders by created_at DESC', async () => {
            const username = generateTestUserId();

            const tokens = createTestOAuthTokensBatch(username, 3);
            await insertTestOAuthTokens(sql, tokens);

            const result = await getAllSessions.all(sql, { userId: username });

            expect(result.length).toBe(3);
            // Sessions should be ordered by creation time
            for (let i = 1; i < result.length; i++) {
                expect(result[i - 1].created_at.getTime()).toBeGreaterThanOrEqual(
                    result[i].created_at.getTime(),
                );
            }
        });
    });

    describe('getDeviceSummary', () => {
        it('groups sessions by device', async () => {
            const username = generateTestUserId();

            // Multiple sessions from same device
            const deviceId = 'shared-device-001';
            const tokens = [
                createTestOAuthToken(username, {
                    deviceSessionId: deviceId,
                    deviceName: 'My Phone',
                }),
                createTestOAuthToken(username, {
                    deviceSessionId: deviceId,
                    deviceName: 'My Phone',
                }),
                createTestOAuthToken(username, { deviceName: 'My Laptop' }),
            ];
            await insertTestOAuthTokens(sql, tokens);

            const result = await getDeviceSummary.all(sql, {
                userId: username,
            });

            expect(result.length).toBe(2); // 2 unique devices
        });

        it('shows is_revoked as true only if all sessions for device are revoked', async () => {
            const username = generateTestUserId();
            const deviceId = 'multi-session-device';

            const tokens = [
                createTestOAuthToken(username, {
                    deviceSessionId: deviceId,
                    revoked: true,
                }),
                createTestOAuthToken(username, {
                    deviceSessionId: deviceId,
                    revoked: false,
                }),
            ];
            await insertTestOAuthTokens(sql, tokens);

            const result = await getDeviceSummary.all(sql, {
                userId: username,
            });
            const device = result.find((d) => d.device_session_id === deviceId);

            expect(device?.is_revoked).toBe(false); // Not all are revoked
        });
    });

    // ==========================================================================
    // Write Queries
    // ==========================================================================

    describe('revokeAllUserRefreshTokensDetailed (revoke all device sessions)', () => {
        it('revokes all active sessions for a user', async () => {
            const username = generateTestUserId();

            const tokens = createTestOAuthTokensBatch(username, 5);
            await insertTestOAuthTokens(sql, tokens);

            const result = await revokeAllUserRefreshTokensDetailed(sql, username as UserId);

            expect(result.count).toBe(5);

            // Verify all revoked
            const active = await getActiveSessions.all(sql, {
                userId: username,
            });
            expect(active.length).toBe(0);
        });

        it('does not double-revoke already revoked sessions', async () => {
            const username = generateTestUserId();

            // Create mix of active and revoked
            const tokens = createTestOAuthTokensBatch(username, 4, {
                activeCount: 2,
            });
            await insertTestOAuthTokens(sql, tokens);

            const result = await revokeAllUserRefreshTokensDetailed(sql, username as UserId);

            // Should only revoke the 2 active ones
            expect(result.count).toBe(2);
        });

        it('does not affect other users', async () => {
            const user1 = generateTestUserId();
            const user2 = generateTestUserId();

            await insertTestOAuthToken(sql, createTestOAuthToken(user1));
            await insertTestOAuthToken(sql, createTestOAuthToken(user2));

            await revokeAllUserRefreshTokensDetailed(sql, user1 as UserId);

            // User 2's session should still be active
            const user2Sessions = await getActiveSessions.all(sql, {
                userId: user2,
            });
            expect(user2Sessions.length).toBe(1);
        });
    });

    describe('updateSessionLastUsed', () => {
        it('updates last_used_at timestamp', async () => {
            const username = generateTestUserId();
            const oldDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

            const token = createTestOAuthToken(username, { lastUsed: oldDate });
            const tokenId = await insertTestOAuthToken(sql, token);

            const result = await updateSessionLastUsed.execute(sql, {
                sessionId: tokenId,
            });

            expect(result.length).toBe(1);

            // Verify updated
            const sessions = await getAllSessions.all(sql, {
                userId: username,
            });
            expect(sessions[0].last_used_at!.getTime()).toBeGreaterThan(oldDate.getTime());
        });
    });

    describe('cleanupExpiredSessions', () => {
        it('deletes sessions expired more than N days ago', async () => {
            const username = generateTestUserId();

            // Create tokens with different expiration dates
            const recentlyExpired = createTestOAuthToken(username, {
                expiresInDays: -5, // Expired 5 days ago
                deviceName: 'Recently Expired',
            });
            const oldExpired = createTestOAuthToken(username, {
                expiresInDays: -100, // Expired 100 days ago
                deviceName: 'Old Expired',
            });
            const valid = createTestOAuthToken(username, {
                expiresInDays: 30,
                deviceName: 'Valid',
            });

            await insertTestOAuthTokens(sql, [recentlyExpired, oldExpired, valid]);

            // Clean up sessions expired more than 30 days ago
            const result = await cleanupExpiredSessions.execute(sql, {
                daysOld: 30,
            });

            expect(result[0].count).toBe(1); // Only the 100-day-old one

            // Verify remaining
            const remaining = await getAllSessions.all(sql, {
                userId: username,
            });
            expect(remaining.length).toBe(2);
        });

        it('returns count of 0 when no expired sessions', async () => {
            const username = generateTestUserId();

            const validToken = createTestOAuthToken(username, {
                expiresInDays: 30,
            });
            await insertTestOAuthToken(sql, validToken);

            const result = await cleanupExpiredSessions.execute(sql, {
                daysOld: 30,
            });

            expect(result[0].count).toBe(0);
        });
    });
});
