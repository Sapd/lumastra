// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for MAL Credentials Query Module
 *
 * Tests read/delete paths that do not require encryption.
 * upsert/update paths require LUMASTRA_MASTER_KEY and PluginSecrets.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/index.js';
import { toUserId } from '$lib/shared/user-id.js';

import {
    getMalLinkStatus,
    deleteMalCredential,
    upsertMalCredential,
    markMalAuthFailed,
} from './mal-credentials.queries.js';

const MAL_PLUGIN_ID = 'mal-watch-sync';

describe('MAL Credentials Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM plugin_user_credentials WHERE plugin_id = ${MAL_PLUGIN_ID}`;
    });

    it('reports failed auth and clears it on relink', async () => {
        const userId = toUserId(randomUUID());
        await ensureTestUser(sql, userId);
        await sql`INSERT INTO plugin_user_credentials (plugin_id,user_id,key,value_encrypted) VALUES
            (${MAL_PLUGIN_ID},${userId}::uuid,'access_token',${Buffer.from([0])}),
            (${MAL_PLUGIN_ID},${userId}::uuid,'auth_failed',${Buffer.from([0])})`;
        expect(await getMalLinkStatus(sql, userId)).toMatchObject({ authFailed: true });
        await upsertMalCredential(sql, { userId, providerUsername: 'joe', accessToken: 'new' });
        expect(await getMalLinkStatus(sql, userId)).toMatchObject({ authFailed: false });
    });

    it('marks an existing connection and never recreates an unlinked connection', async () => {
        const userId = toUserId(randomUUID());
        await ensureTestUser(sql, userId);
        await markMalAuthFailed(sql, userId);
        expect(await getMalLinkStatus(sql, userId)).toBeNull();
        await upsertMalCredential(sql, { userId, providerUsername: 'joe', accessToken: 'expired' });
        await markMalAuthFailed(sql, userId);
        await markMalAuthFailed(sql, userId);
        expect(await getMalLinkStatus(sql, userId)).toMatchObject({ authFailed: true });
    });

    // ========================================================================
    // getMalLinkStatus
    // ========================================================================

    describe('getMalLinkStatus', () => {
        it('returns null when user has no access_token row', async () => {
            const result = await getMalLinkStatus(sql, toUserId(randomUUID()));
            expect(result).toBeNull();
        });

        it('returns createdAt when access_token row exists', async () => {
            const userId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);
            const now = new Date();
            await sql`
                INSERT INTO plugin_user_credentials
                    (plugin_id, user_id, key, value_encrypted, created_at)
                VALUES
                    (${MAL_PLUGIN_ID}, ${userId}::uuid, 'access_token', ${Buffer.from([0])}, ${now})
            `;

            const result = await getMalLinkStatus(sql, userId);
            expect(result).not.toBeNull();
            expect(result!.providerUsername).toBeNull();
            expect(result!.createdAt).toBeInstanceOf(Date);
        });

        it('attempts to decrypt provider_username when present', async () => {
            const userId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);
            // Insert a row with provider_username that will fail to decrypt,
            // which is caught and returns null providerUsername
            await sql`
                INSERT INTO plugin_user_credentials
                    (plugin_id, user_id, key, value_encrypted)
                VALUES
                    (${MAL_PLUGIN_ID}, ${userId}::uuid, 'access_token', ${Buffer.from([0])}),
                    (${MAL_PLUGIN_ID}, ${userId}::uuid, 'provider_username', ${Buffer.from([0])})
            `;

            const result = await getMalLinkStatus(sql, userId);
            expect(result).not.toBeNull();
            // Decryption fails (bad ciphertext) → providerUsername is null
            expect(result!.providerUsername).toBeNull();
        });
    });

    // ========================================================================
    // deleteMalCredential
    // ========================================================================

    describe('deleteMalCredential', () => {
        it('deletes all rows for a user and returns true', async () => {
            const userId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);
            await sql`
                INSERT INTO plugin_user_credentials
                    (plugin_id, user_id, key, value_encrypted)
                VALUES
                    (${MAL_PLUGIN_ID}, ${userId}::uuid, 'access_token', ${Buffer.from([0])}),
                    (${MAL_PLUGIN_ID}, ${userId}::uuid, 'refresh_token', ${Buffer.from([0])})
            `;

            const deleted = await deleteMalCredential(sql, userId);
            expect(deleted).toBe(true);

            const remaining = await sql`
                SELECT 1 FROM plugin_user_credentials
                WHERE plugin_id = ${MAL_PLUGIN_ID} AND user_id = ${userId}::uuid
            `;
            expect(remaining).toHaveLength(0);
        });

        it('returns false when no rows exist for user', async () => {
            const deleted = await deleteMalCredential(sql, toUserId(randomUUID()));
            expect(deleted).toBe(false);
        });
    });
});
