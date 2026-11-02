// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for OAuth Device Codes Query Module
 *
 * Tests device code CRUD, authorization, polling, and cleanup.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { toUserId } from '$lib/shared/user-id.js';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/index.js';

import {
    createDeviceCode,
    getDeviceCodeByDeviceCode,
    getDeviceCodeByUserCode,
    countPendingDeviceCodes,
    authorizeDeviceCode,
    denyDeviceCode,
    updateDeviceCodeStatus,
    recordDeviceCodePoll,
    deleteDeviceCode,
    cleanupExpiredDeviceCodes,
    type CreateDeviceCodeParams,
} from './oauth-device-codes.queries.js';

describe('OAuth Device Codes Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM oauth_device_codes WHERE device_code LIKE 'test_dc_%'`;
    });

    function makeParams(overrides: Partial<CreateDeviceCodeParams> = {}): CreateDeviceCodeParams {
        const suffix = Math.random().toString(36).substring(2, 7);
        return {
            deviceCode: `test_dc_${suffix}`,
            userCode: `U${suffix.toUpperCase()}`,
            clientId: 'test-client',
            deviceName: 'Test Device',
            scope: null,
            verificationUri: 'https://example.com/verify',
            verificationUriComplete: 'https://example.com/verify?code=TEST',
            expiresAt: new Date(Date.now() + 600_000),
            deviceSessionId: `sess_${suffix}`,
            deviceId: `dev_${suffix}`,
            redirectUri: null,
            ...overrides,
        };
    }

    // ========================================================================
    // createDeviceCode / getDeviceCodeByDeviceCode
    // ========================================================================

    describe('createDeviceCode / getDeviceCodeByDeviceCode', () => {
        it('creates and retrieves a device code', async () => {
            const params = makeParams();
            await createDeviceCode(sql, params);

            const row = await getDeviceCodeByDeviceCode(sql, params.deviceCode);
            expect(row).not.toBeNull();
            expect(row!.device_code).toBe(params.deviceCode);
            expect(row!.status).toBe('pending');
        });

        it('returns null for unknown device code', async () => {
            const row = await getDeviceCodeByDeviceCode(sql, 'test_dc_unknown');
            expect(row).toBeNull();
        });
    });

    // ========================================================================
    // getDeviceCodeByUserCode
    // ========================================================================

    describe('getDeviceCodeByUserCode', () => {
        it('retrieves by user_code', async () => {
            const params = makeParams();
            await createDeviceCode(sql, params);

            const row = await getDeviceCodeByUserCode(sql, params.userCode);
            expect(row).not.toBeNull();
            expect(row!.user_code).toBe(params.userCode);
        });
    });

    // ========================================================================
    // countPendingDeviceCodes
    // ========================================================================

    describe('countPendingDeviceCodes', () => {
        it('counts only pending non-expired codes for a client', async () => {
            const clientId = 'test-client-count';
            const p1 = makeParams({ clientId });
            const p2 = makeParams({
                clientId,
                expiresAt: new Date(Date.now() - 1000),
            });
            await createDeviceCode(sql, p1);
            await createDeviceCode(sql, p2);

            const count = await countPendingDeviceCodes(sql, clientId);
            expect(count).toBe(1);
        });
    });

    // ========================================================================
    // authorizeDeviceCode
    // ========================================================================

    describe('authorizeDeviceCode', () => {
        it('refuses expired, disabled and already decided grants atomically', async () => {
            const userId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);
            const expired = makeParams({ expiresAt: new Date(Date.now() - 1000) });
            await createDeviceCode(sql, expired);
            const changed = await authorizeDeviceCode(sql, expired.deviceCode, userId);
            expect((await getDeviceCodeByDeviceCode(sql, expired.deviceCode))?.status).toBe(
                'pending',
            );
            expect(changed).toBe(false);
            const pending = makeParams();
            await createDeviceCode(sql, pending);
            expect(await authorizeDeviceCode(sql, pending.deviceCode, userId)).toBe(true);
            const otherId = toUserId(randomUUID());
            await ensureTestUser(sql, otherId);
            expect(await authorizeDeviceCode(sql, pending.deviceCode, otherId)).toBe(false);
            expect(await denyDeviceCode(sql, pending.deviceCode, otherId)).toBe(false);
            expect((await getDeviceCodeByDeviceCode(sql, pending.deviceCode))?.user_id).toBe(
                userId,
            );
            expect(await denyDeviceCode(sql, expired.deviceCode, userId)).toBe(false);
            const disabled = makeParams();
            await createDeviceCode(sql, disabled);
            await sql`UPDATE users SET disabled_at = NOW() WHERE id = ${userId}::uuid`;
            expect(await authorizeDeviceCode(sql, disabled.deviceCode, userId)).toBe(false);
            expect(await denyDeviceCode(sql, disabled.deviceCode, userId)).toBe(false);
        });

        it('sets status to authorized and records user_id', async () => {
            // oauth_device_codes.user_id is now uuid (mig 16.46.0)
            const authorizedUserId = toUserId(randomUUID());
            const params = makeParams();
            await createDeviceCode(sql, params);
            await ensureTestUser(sql, authorizedUserId);
            await authorizeDeviceCode(sql, params.deviceCode, authorizedUserId);

            const row = await getDeviceCodeByDeviceCode(sql, params.deviceCode);
            expect(row!.status).toBe('authorized');
            expect(row!.user_id).toBe(authorizedUserId);
        });
    });

    // ========================================================================
    // updateDeviceCodeStatus
    // ========================================================================

    describe('updateDeviceCodeStatus', () => {
        it('updates status to denied', async () => {
            const params = makeParams();
            await createDeviceCode(sql, params);
            await updateDeviceCodeStatus(sql, params.deviceCode, 'denied');

            const row = await getDeviceCodeByDeviceCode(sql, params.deviceCode);
            expect(row!.status).toBe('denied');
        });
    });

    // ========================================================================
    // recordDeviceCodePoll
    // ========================================================================

    describe('recordDeviceCodePoll', () => {
        it('updates last_poll_at', async () => {
            const params = makeParams();
            await createDeviceCode(sql, params);
            await recordDeviceCodePoll(sql, params.deviceCode);

            const row = await getDeviceCodeByDeviceCode(sql, params.deviceCode);
            expect(row!.last_poll_at).not.toBeNull();
        });
    });

    // ========================================================================
    // deleteDeviceCode
    // ========================================================================

    describe('deleteDeviceCode', () => {
        it('removes the device code', async () => {
            const params = makeParams();
            await createDeviceCode(sql, params);
            await deleteDeviceCode(sql, params.deviceCode);

            const row = await getDeviceCodeByDeviceCode(sql, params.deviceCode);
            expect(row).toBeNull();
        });
    });

    // ========================================================================
    // cleanupExpiredDeviceCodes
    // ========================================================================

    describe('cleanupExpiredDeviceCodes', () => {
        it('deletes codes expired more than 1 hour ago', async () => {
            const params = makeParams({
                expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
            });
            await createDeviceCode(sql, params);

            const deleted = await cleanupExpiredDeviceCodes(sql);
            expect(deleted).toBeGreaterThanOrEqual(1);

            const row = await getDeviceCodeByDeviceCode(sql, params.deviceCode);
            expect(row).toBeNull();
        });

        it('preserves recently expired codes', async () => {
            const params = makeParams({
                expiresAt: new Date(Date.now() - 10 * 60 * 1000),
            });
            await createDeviceCode(sql, params);

            const deleted = await cleanupExpiredDeviceCodes(sql);
            // Should not delete because less than 1 hour old
            expect(deleted).toBe(0);
        });
    });
});
