// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for OAuth Refresh Tokens Query Module
 *
 * Tests token validation, creation, updates, revocation, and cleanup.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    generateTestUserId,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';

// Import query functions to test
import {
    validateRefreshToken,
    getActiveRefreshTokens,
    getDeviceNameBySession,
    createRefreshToken,
    updateRefreshTokenLastUsed,
    revokeRefreshToken,
    revokeAllUserRefreshTokens,
    revokeUserClientRefreshTokens,
    updateRefreshTokenGroups,
    cleanupRefreshTokens,
    type CreateRefreshTokenParams,
} from './oauth-refresh-tokens.queries.js';
import { upsertPushToken, getActivePushTokensForUser } from './user-push-tokens.queries.js';
import { RefreshTokenService } from '$lib/server/oauth/refresh-token.service.js';

describe('OAuth Refresh Tokens Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['oauth_refresh_tokens', 'user_push_tokens', 'user_devices']);
    });

    // Helper to create test token params
    function createTestTokenParams(
        overrides: Partial<CreateRefreshTokenParams> = {},
    ): CreateRefreshTokenParams {
        return {
            tokenHash: `hash_${crypto.randomUUID()}`,
            userId: generateTestUserId(),
            clientId: 'test-client',
            scope: 'openid profile',
            deviceName: 'Test Device',
            groups: ['users', 'viewers'],
            jellyfinUserId: 'jf-user-001',
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
            deviceSessionId: crypto.randomUUID(),
            ...overrides,
        };
    }

    async function createToken(params: CreateRefreshTokenParams) {
        await ensureTestUser(sql, params.userId);
        return createRefreshToken(sql, params);
    }

    /**
     * Creates a `user_devices` row and returns both its uuid PK (what
     * `user_push_tokens.device_id` points at) and its client-generated
     * `device_id` (what `oauth_refresh_tokens.device_id` holds). The two are
     * different columns — see "## The two `device_id` columns" in migration
     * 16.200.0_push_token_revocation_trigger.ts.
     */
    async function makeLinkedDevice(
        userId: UserId,
        deviceKey: string,
    ): Promise<{ deviceRowId: string; deviceKey: string }> {
        await ensureTestUser(sql, userId);
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO user_devices (user_id, device_id, reported_name)
            VALUES (${userId}::uuid, ${deviceKey}, 'Test Device')
            RETURNING id
        `;
        return { deviceRowId: row.id, deviceKey };
    }

    /** Creates and persists a refresh token, returning its hash (revocation key). */
    async function makeRefreshToken(
        userId: UserId,
        deviceId: string | null = null,
    ): Promise<string> {
        const params = createTestTokenParams({ userId, deviceId });
        await createToken(params);
        return params.tokenHash;
    }

    // ==========================================================================
    // Read Queries
    // ==========================================================================

    describe('validateRefreshToken', () => {
        it('returns token when valid', async () => {
            const params = createTestTokenParams();
            await createToken(params);

            const result = await validateRefreshToken(sql, params.tokenHash);

            expect(result).not.toBeNull();
            expect(result?.user_id).toBe(params.userId);
            expect(result?.client_id).toBe(params.clientId);
        });

        it('returns null for non-existent token', async () => {
            const result = await validateRefreshToken(sql, 'non-existent-hash');
            expect(result).toBeNull();
        });

        it('returns null for revoked token', async () => {
            const params = createTestTokenParams();
            await createToken(params);
            await revokeRefreshToken(sql, params.tokenHash);

            const result = await validateRefreshToken(sql, params.tokenHash);
            expect(result).toBeNull();
        });

        it('returns null for expired token', async () => {
            const expiredDate = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
            const params = createTestTokenParams({
                expiresAt: expiredDate,
            });

            // Verify the token was created with the correct expiry
            await createToken(params);

            // Query to see what was actually inserted
            const [inserted] =
                await sql`SELECT expires_at FROM oauth_refresh_tokens WHERE token_hash = ${params.tokenHash}`;

            // The token should be expired (expires_at should be in the past)
            expect(new Date(inserted.expires_at) < new Date()).toBe(true);

            const result = await validateRefreshToken(sql, params.tokenHash);
            expect(result).toBeNull();
        });
    });

    describe('getActiveRefreshTokens', () => {
        it('returns all active tokens for user', async () => {
            const userId = generateTestUserId();

            const token1 = createTestTokenParams({
                userId,
                deviceName: 'Device 1',
            });
            const token2 = createTestTokenParams({
                userId,
                deviceName: 'Device 2',
            });

            await createToken(token1);
            await createToken(token2);

            const result = await getActiveRefreshTokens(sql, userId);

            expect(result.length).toBe(2);
            expect(result.map((t) => t.device_name)).toContain('Device 1');
            expect(result.map((t) => t.device_name)).toContain('Device 2');
        });

        it('excludes revoked tokens', async () => {
            const userId = generateTestUserId();

            const activeToken = createTestTokenParams({
                userId,
                deviceName: 'Active',
            });
            const revokedToken = createTestTokenParams({
                userId,
                deviceName: 'Revoked',
            });

            await createToken(activeToken);
            await createToken(revokedToken);
            await revokeRefreshToken(sql, revokedToken.tokenHash);

            const result = await getActiveRefreshTokens(sql, userId);

            expect(result.length).toBe(1);
            expect(result[0].device_name).toBe('Active');
        });

        it('excludes expired tokens', async () => {
            const userId = generateTestUserId();

            const validToken = createTestTokenParams({ userId });
            const expiredToken = createTestTokenParams({
                userId,
                expiresAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
            });

            await createToken(validToken);
            await createToken(expiredToken);

            const result = await getActiveRefreshTokens(sql, userId);

            expect(result.length).toBe(1);
        });

        it('returns empty array when user has no tokens', async () => {
            // Pass a valid UUID that has no tokens (mig 16.46.0 — user_id is now uuid)
            const result = await getActiveRefreshTokens(sql, toUserId(crypto.randomUUID()));
            expect(result).toEqual([]);
        });
    });

    describe('getDeviceNameBySession', () => {
        it('returns device name for session', async () => {
            const params = createTestTokenParams({ deviceName: 'My Phone' });
            await createToken(params);

            const result = await getDeviceNameBySession(sql, params.deviceSessionId);
            expect(result).toBe('My Phone');
        });

        it('returns null for non-existent session', async () => {
            const result = await getDeviceNameBySession(sql, 'non-existent-session');
            expect(result).toBeNull();
        });

        it('returns null for revoked session token', async () => {
            const params = createTestTokenParams();
            await createToken(params);
            await revokeRefreshToken(sql, params.tokenHash);

            const result = await getDeviceNameBySession(sql, params.deviceSessionId);
            expect(result).toBeNull();
        });
    });

    // ==========================================================================
    // Write Queries
    // ==========================================================================

    describe('createRefreshToken', () => {
        it('creates new refresh token', async () => {
            const params = createTestTokenParams();

            await createToken(params);

            const [row] = await sql<{ user_id: string; client_id: string }[]>`
                SELECT user_id, client_id FROM oauth_refresh_tokens
                WHERE token_hash = ${params.tokenHash}
            `;

            expect(row.user_id).toBe(params.userId);
            expect(row.client_id).toBe(params.clientId);
        });

        it('stores groups array correctly', async () => {
            const params = createTestTokenParams({
                groups: ['admin', 'users', 'premium'],
            });

            await createToken(params);

            const [row] = await sql<{ user_groups: string[] }[]>`
                SELECT user_groups FROM oauth_refresh_tokens
                WHERE token_hash = ${params.tokenHash}
            `;

            expect(row.user_groups).toEqual(['admin', 'users', 'premium']);
        });
    });

    describe('updateRefreshTokenLastUsed', () => {
        it('updates last_used_at timestamp', async () => {
            const params = createTestTokenParams();
            await createToken(params);

            // Get initial state
            const [before] = await sql<{ last_used_at: Date | null }[]>`
                SELECT last_used_at FROM oauth_refresh_tokens
                WHERE token_hash = ${params.tokenHash}
            `;
            expect(before.last_used_at).toBeNull();

            // Update
            await updateRefreshTokenLastUsed(sql, params.tokenHash);

            const [after] = await sql<{ last_used_at: Date | null }[]>`
                SELECT last_used_at FROM oauth_refresh_tokens
                WHERE token_hash = ${params.tokenHash}
            `;
            expect(after.last_used_at).not.toBeNull();
        });
    });

    describe('revokeRefreshToken', () => {
        it('revokes single token and returns count', async () => {
            const params = createTestTokenParams();
            await createToken(params);

            const count = await revokeRefreshToken(sql, params.tokenHash);

            expect(count).toBe(1);

            const [row] = await sql<{ revoked_at: Date | null }[]>`
                SELECT revoked_at FROM oauth_refresh_tokens
                WHERE token_hash = ${params.tokenHash}
            `;
            expect(row.revoked_at).not.toBeNull();
        });

        it('returns 0 for non-existent token', async () => {
            const count = await revokeRefreshToken(sql, 'non-existent');
            expect(count).toBe(0);
        });

        it('returns 0 for already revoked token', async () => {
            const params = createTestTokenParams();
            await createToken(params);
            await revokeRefreshToken(sql, params.tokenHash);

            const count = await revokeRefreshToken(sql, params.tokenHash);
            expect(count).toBe(0);
        });
    });

    describe('revokeAllUserRefreshTokens', () => {
        it('revokes all tokens for a user', async () => {
            const userId = generateTestUserId();

            await createToken(createTestTokenParams({ userId }));
            await createToken(createTestTokenParams({ userId }));
            await createToken(createTestTokenParams({ userId }));

            const count = await revokeAllUserRefreshTokens(sql, userId);

            expect(count).toBe(3);

            const active = await getActiveRefreshTokens(sql, userId);
            expect(active.length).toBe(0);
        });

        it('does not revoke other users tokens', async () => {
            const user1 = generateTestUserId();
            const user2 = generateTestUserId();

            await createToken(createTestTokenParams({ userId: user1 }));
            await createToken(createTestTokenParams({ userId: user2 }));

            await revokeAllUserRefreshTokens(sql, user1);

            const user2Tokens = await getActiveRefreshTokens(sql, user2);
            expect(user2Tokens.length).toBe(1);
        });
    });

    describe('revokeUserClientRefreshTokens', () => {
        it('revokes tokens for specific user and client', async () => {
            const userId = generateTestUserId();

            await createToken(createTestTokenParams({ userId, clientId: 'client-a' }));
            await createToken(createTestTokenParams({ userId, clientId: 'client-a' }));
            await createToken(createTestTokenParams({ userId, clientId: 'client-b' }));

            const count = await revokeUserClientRefreshTokens(sql, userId, 'client-a');

            expect(count).toBe(2);

            const remaining = await getActiveRefreshTokens(sql, userId);
            expect(remaining.length).toBe(1);
            expect(remaining[0].client_id).toBe('client-b');
        });
    });

    describe('updateRefreshTokenGroups', () => {
        it('updates groups for all active user tokens', async () => {
            const userId = generateTestUserId();

            await createToken(createTestTokenParams({ userId, groups: ['users'] }));
            await createToken(createTestTokenParams({ userId, groups: ['users'] }));

            const count = await updateRefreshTokenGroups(sql, userId, ['users', 'premium']);

            expect(count).toBe(2);

            const tokens = await getActiveRefreshTokens(sql, userId);
            for (const token of tokens) {
                expect(token.user_groups).toEqual(['users', 'premium']);
            }
        });

        it('does not update revoked tokens', async () => {
            const userId = generateTestUserId();

            const activeParams = createTestTokenParams({
                userId,
                groups: ['old'],
            });
            const revokedParams = createTestTokenParams({
                userId,
                groups: ['old'],
            });

            await createToken(activeParams);
            await createToken(revokedParams);
            await revokeRefreshToken(sql, revokedParams.tokenHash);

            const count = await updateRefreshTokenGroups(sql, userId, ['new']);

            expect(count).toBe(1);
        });
    });

    describe('cleanupRefreshTokens', () => {
        it('deletes expired tokens older than 7 days', async () => {
            const params = createTestTokenParams();
            await createToken(params);

            // Manually set expiry to 8 days ago
            await sql`
                UPDATE oauth_refresh_tokens
                SET expires_at = NOW() - INTERVAL '8 days'
                WHERE token_hash = ${params.tokenHash}
            `;

            const count = await cleanupRefreshTokens(sql);

            expect(count).toBe(1);

            const [exists] = await sql<{ count: string }[]>`
                SELECT COUNT(*) as count FROM oauth_refresh_tokens
                WHERE token_hash = ${params.tokenHash}
            `;
            expect(Number(exists.count)).toBe(0);
        });

        it('deletes revoked tokens older than 7 days', async () => {
            const params = createTestTokenParams();
            await createToken(params);

            // Revoke and set revoked_at to 8 days ago
            await sql`
                UPDATE oauth_refresh_tokens
                SET revoked_at = NOW() - INTERVAL '8 days'
                WHERE token_hash = ${params.tokenHash}
            `;

            const count = await cleanupRefreshTokens(sql);

            expect(count).toBe(1);
        });

        it('keeps recently revoked tokens so a sign-out complaint is still investigable', async () => {
            // Retention was 1 day, which routinely deleted the evidence before anyone
            // looked into "I got signed out at the weekend". Now 7 days, matching
            // expired rows.
            const params = createTestTokenParams();
            await createToken(params);

            await sql`
                UPDATE oauth_refresh_tokens
                SET revoked_at = NOW() - INTERVAL '2 days'
                WHERE token_hash = ${params.tokenHash}
            `;

            const count = await cleanupRefreshTokens(sql);

            expect(count).toBe(0);

            const [exists] = await sql<{ count: string }[]>`
                SELECT COUNT(*) as count FROM oauth_refresh_tokens
                WHERE token_hash = ${params.tokenHash}
            `;
            expect(Number(exists.count)).toBe(1);
        });

        it('does not delete recently expired tokens', async () => {
            const params = createTestTokenParams({
                expiresAt: new Date(Date.now() - 1000), // Just expired
            });
            await createToken(params);

            const count = await cleanupRefreshTokens(sql);

            expect(count).toBe(0);
        });

        it('does not delete recently revoked tokens', async () => {
            const params = createTestTokenParams();
            await createToken(params);
            await revokeRefreshToken(sql, params.tokenHash);

            const count = await cleanupRefreshTokens(sql);

            expect(count).toBe(0);
        });
    });

    describe('push token deactivation on revocation', () => {
        it('deactivates the device push tokens when its last session is revoked', async () => {
            const userId = generateTestUserId();
            const { deviceRowId, deviceKey } = await makeLinkedDevice(userId, 'dev-1');
            const refreshId = await makeRefreshToken(userId, deviceKey);
            await upsertPushToken(sql, {
                userId,
                deviceId: deviceRowId,
                token: 'tok-1',
                bundleId: 'de.hinterthaner.stellar-tvos.ios',
                environment: 'production',
                locale: 'en-US',
                payloadVersion: 1,
            });

            await revokeRefreshToken(sql, refreshId);

            expect(await getActivePushTokensForUser(sql, userId)).toHaveLength(0);
            const [row] = await sql<{ deactivation_reason: string }[]>`
                SELECT deactivation_reason FROM user_push_tokens WHERE token = 'tok-1'
            `;
            expect(row.deactivation_reason).toBe('session_revoked');
        });

        it('leaves push tokens active while another session for the device survives', async () => {
            const userId = generateTestUserId();
            const { deviceRowId, deviceKey } = await makeLinkedDevice(userId, 'dev-1');
            const first = await makeRefreshToken(userId, deviceKey);
            await makeRefreshToken(userId, deviceKey); // second, stays live
            await upsertPushToken(sql, {
                userId,
                deviceId: deviceRowId,
                token: 'tok-1',
                bundleId: 'de.hinterthaner.stellar-tvos.ios',
                environment: 'production',
                locale: 'en-US',
                payloadVersion: 1,
            });

            await revokeRefreshToken(sql, first);

            expect(await getActivePushTokensForUser(sql, userId)).toHaveLength(1);
        });

        it("does not touch another device's push tokens", async () => {
            const userId = generateTestUserId();
            const a = await makeLinkedDevice(userId, 'dev-a');
            const b = await makeLinkedDevice(userId, 'dev-b');
            const refreshA = await makeRefreshToken(userId, a.deviceKey);
            await makeRefreshToken(userId, b.deviceKey);
            await upsertPushToken(sql, {
                userId,
                deviceId: a.deviceRowId,
                token: 'tok-a',
                bundleId: 'de.hinterthaner.stellar-tvos.ios',
                environment: 'production',
                locale: 'en-US',
                payloadVersion: 1,
            });
            await upsertPushToken(sql, {
                userId,
                deviceId: b.deviceRowId,
                token: 'tok-b',
                bundleId: 'de.hinterthaner.stellar-tvos.ios',
                environment: 'production',
                locale: 'en-US',
                payloadVersion: 1,
            });

            await revokeRefreshToken(sql, refreshA);

            const active = await getActivePushTokensForUser(sql, userId);
            expect(active.map((t) => t.token)).toEqual(['tok-b']);
        });

        it('deactivates push tokens via the admin revoke-all-for-user path', async () => {
            // revokeAllUserRefreshTokens backs the "revoke all devices"
            // endpoints — a distinct code path from revokeRefreshToken above
            // (a transaction holding the device-session locks). It must trip
            // the same deactivation.
            const userId = generateTestUserId();
            const { deviceRowId, deviceKey } = await makeLinkedDevice(userId, 'dev-1');
            await makeRefreshToken(userId, deviceKey);
            await upsertPushToken(sql, {
                userId,
                deviceId: deviceRowId,
                token: 'tok-admin',
                bundleId: 'de.hinterthaner.stellar-tvos.ios',
                environment: 'production',
                locale: 'en-US',
                payloadVersion: 1,
            });

            await revokeAllUserRefreshTokens(sql, userId);

            expect(await getActivePushTokensForUser(sql, userId)).toHaveLength(0);
        });

        it('deactivates push tokens even when revoked_at is set by a raw UPDATE outside any query module', async () => {
            // Proves the guarantee is structural (a DB trigger — see migration
            // 16.200.0), not a hand-maintained list of call sites: this bypasses
            // every exported revoke function, including the ones this describe
            // block exercises above, the same way an as-yet-unwritten call site
            // would.
            const userId = generateTestUserId();
            const { deviceRowId, deviceKey } = await makeLinkedDevice(userId, 'dev-1');
            await makeRefreshToken(userId, deviceKey);
            await upsertPushToken(sql, {
                userId,
                deviceId: deviceRowId,
                token: 'tok-raw',
                bundleId: 'de.hinterthaner.stellar-tvos.ios',
                environment: 'production',
                locale: 'en-US',
                payloadVersion: 1,
            });

            await sql`
                UPDATE oauth_refresh_tokens
                SET revoked_at = NOW()
                WHERE user_id = ${userId}::uuid AND revoked_at IS NULL
            `;

            expect(await getActivePushTokensForUser(sql, userId)).toHaveLength(0);
        });

        it('keeps the push token active across RefreshTokenService.rotate() (regression: token rotation must not trip the revoke trigger)', async () => {
            // rotate() revokes the old row and inserts the replacement in ONE
            // transaction (grant_type=refresh_token, which the iOS app performs
            // roughly hourly per JWT_ACCESS_TOKEN_TTL_SECONDS). A non-deferred
            // trigger fires between the UPDATE and the INSERT, sees zero live
            // sessions for the device, and deactivates the push token even
            // though the session is about to be recreated. The trigger must be
            // DEFERRABLE INITIALLY DEFERRED so it only runs at COMMIT, after the
            // INSERT — this test drives the real service, not a simulation.
            const userId = generateTestUserId();
            const { deviceRowId, deviceKey } = await makeLinkedDevice(userId, 'dev-1');

            const refreshTokenService = new RefreshTokenService();
            const oldToken = await refreshTokenService.create({
                userId,
                clientId: 'test-client',
                groups: ['users'],
                deviceSessionId: crypto.randomUUID(),
                deviceId: deviceKey,
            });

            await upsertPushToken(sql, {
                userId,
                deviceId: deviceRowId,
                token: 'tok-rotate',
                bundleId: 'de.hinterthaner.stellar-tvos.ios',
                environment: 'production',
                locale: 'en-US',
                payloadVersion: 1,
            });

            const result = await refreshTokenService.rotate(oldToken);

            expect(result.ok).toBe(true);
            const active = await getActivePushTokensForUser(sql, userId);
            expect(active.map((t) => t.token)).toEqual(['tok-rotate']);
        });
    });
    // =========================================================================
    // Rotation grace (migration 16.218.0)
    // =========================================================================

    describe('rotation grace', () => {
        /** Row state for a plaintext token, by its stored SHA-256 hash. */
        async function rowFor(token: string) {
            const hash = createHash('sha256').update(token).digest('hex');
            const rows = await sql<
                { id: number; revoked_at: Date | null; superseded_at: Date | null }[]
            >`
                SELECT id, revoked_at, superseded_at
                FROM oauth_refresh_tokens WHERE token_hash = ${hash}
            `;
            return rows[0];
        }

        async function seedSession(userId: UserId, deviceSessionId: string) {
            await ensureTestUser(sql, userId);
            const service = new RefreshTokenService();
            const token = await service.create({
                userId,
                clientId: 'lumastra-ios',
                groups: ['users'],
                deviceSessionId,
            });
            return { service, token };
        }

        it('lets a client that lost the rotation response refresh again with the token it still holds', async () => {
            // The prod failure this fixes: iOS is suspended mid-request, never sees the
            // replacement, and comes back holding a token the server already consumed.
            // Before 16.218.0 that was a permanent, unrecoverable sign-out.
            const userId = generateTestUserId();
            const { service, token } = await seedSession(userId, crypto.randomUUID());

            const first = await service.rotate(token);
            expect(first.ok).toBe(true);

            // The response is "lost" — the client retries with the ORIGINAL token.
            const retry = await service.rotate(token);
            expect(retry.ok).toBe(true);

            // And the token it presented was superseded, never revoked.
            const original = await rowFor(token);
            expect(original.superseded_at).not.toBeNull();
            expect(original.revoked_at).toBeNull();
        });

        it('does not revoke the device session when two refreshes race on the same token', async () => {
            // This is the case the old reuse-detection killed outright: both racers
            // passed validate(), the loser saw the row already revoked, and the whole
            // device_session_id family was wiped — signing out a legitimate device.
            const userId = generateTestUserId();
            const deviceSessionId = crypto.randomUUID();
            const { service, token } = await seedSession(userId, deviceSessionId);

            const [a, b] = await Promise.all([service.rotate(token), service.rotate(token)]);

            expect(a.ok).toBe(true);
            expect(b.ok).toBe(true);

            // The session survives with at least one usable token.
            const live = await sql<{ count: string }[]>`
                SELECT COUNT(*) AS count FROM oauth_refresh_tokens
                WHERE device_session_id = ${deviceSessionId}
                  AND revoked_at IS NULL AND expires_at > NOW()
            `;
            expect(Number(live[0].count)).toBeGreaterThan(0);

            // Whatever each racer was handed actually works.
            if (a.ok) expect(await service.validate(a.token)).not.toBeNull();
            if (b.ok) expect(await service.validate(b.token)).not.toBeNull();
        });

        it('revokes the predecessor once its successor is actually used', async () => {
            // The grace window closes on evidence, not on a timer: the old token dies
            // the moment the client proves it received the replacement.
            const userId = generateTestUserId();
            const { service, token } = await seedSession(userId, crypto.randomUUID());

            const first = await service.rotate(token);
            expect(first.ok).toBe(true);
            if (!first.ok) return;

            expect((await rowFor(token)).revoked_at).toBeNull();

            // Using the replacement is the proof.
            const second = await service.rotate(first.token);
            expect(second.ok).toBe(true);

            expect((await rowFor(token)).revoked_at).not.toBeNull();
            // ...and the one now in the client's hands is merely superseded.
            expect((await rowFor(first.token)).revoked_at).toBeNull();
            expect((await rowFor(first.token)).superseded_at).not.toBeNull();
        });

        it('reports only the current token per session as active', async () => {
            // A superseded row is still valid, so without the superseded_at filter the
            // device list would show two live sessions for one device.
            const userId = generateTestUserId();
            const deviceSessionId = crypto.randomUUID();
            const { service, token } = await seedSession(userId, deviceSessionId);

            await service.rotate(token);

            const active = await getActiveRefreshTokens(sql, userId);
            expect(active.filter((t) => t.device_session_id === deviceSessionId)).toHaveLength(1);
        });

        it('leaves the losing sibling of a race valid instead of revoking it (guards the race fix)', async () => {
            // The contract both server and client now depend on: after two rotations
            // race, BOTH results are valid; the client keeps whichever response it got
            // and never re-presents an older one; using the one it kept revokes the
            // original but NOT the sibling, which is simply never used and expires.
            //
            // This asserts the residue deliberately, because "tidying it up" by
            // revoking siblings is precisely how the original bug comes back: the
            // sibling belongs to a request that may well have reached the client, and
            // killing it is indistinguishable from killing a legitimate session.
            const userId = generateTestUserId();
            const { service, token } = await seedSession(userId, crypto.randomUUID());

            const [a, b] = await Promise.all([service.rotate(token), service.rotate(token)]);
            expect(a.ok && b.ok).toBe(true);
            if (!a.ok || !b.ok) return;

            // A replay-cache hit would hand both racers the same token; that is a
            // correct outcome too, but there is no sibling to assert about.
            if (a.token === b.token) return;

            // The client kept one of them and uses it.
            const next = await service.rotate(b.token);
            expect(next.ok).toBe(true);

            // The token it moved on from is dead...
            expect((await rowFor(token)).revoked_at).not.toBeNull();
            expect(await service.validate(token)).toBeNull();

            // ...but the sibling it never received is left alone, not revoked.
            expect((await rowFor(a.token)).revoked_at).toBeNull();
            expect(await service.validate(a.token)).not.toBeNull();
        });

        it('revokes the superseded predecessor too when the session is signed out', async () => {
            // Revoking only the current token hash would leave the "logged out" device
            // holding a still-valid predecessor it could refresh back to life.
            const userId = generateTestUserId();
            const deviceSessionId = crypto.randomUUID();
            const { service, token } = await seedSession(userId, deviceSessionId);

            const rotated = await service.rotate(token);
            expect(rotated.ok).toBe(true);

            await service.revokeByDeviceSessionId(deviceSessionId);

            expect((await rowFor(token)).revoked_at).not.toBeNull();
            expect(await service.validate(token)).toBeNull();
            if (rotated.ok) expect(await service.validate(rotated.token)).toBeNull();
        });
    });
});
