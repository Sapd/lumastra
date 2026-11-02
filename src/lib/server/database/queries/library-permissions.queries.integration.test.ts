// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Library Permissions Query Module
 *
 * Tests cached Jellyfin permission reads and writes.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    ensureTestUser,
    derivedUsername,
} from '../../../../../tests/integration/fixtures/index.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';

import {
    getCachedPermissions,
    getStalePermissionUsers,
    upsertPermissions,
    deletePermissions,
} from './library-permissions.queries.js';

describe('Library Permissions Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['user_library_permissions']);
        // Clean up test users from prior runs
        await sql`DELETE FROM users WHERE username LIKE 'u_lib_perm%'`;
    });

    async function createTestUser(): Promise<UserId> {
        const userId = toUserId(randomUUID());
        await ensureTestUser(sql, userId);
        return userId;
    }

    // ========================================================================
    // upsertPermissions
    // ========================================================================

    describe('upsertPermissions', () => {
        it('inserts new permissions', async () => {
            const userId = await createTestUser();

            await upsertPermissions(sql, {
                userId,
                jellyfinUserId: 'jf-user-123',
                enabledLibraries: ['Movies', 'TV Shows'],
                maxParentalRating: 13,
                enableMediaPlayback: true,
                enableAudioTranscoding: true,
                enableVideoTranscoding: true,
                enableRemuxing: false,
                enableContentDownloading: false,
                enableRemoteAccess: true,
                remoteClientBitrateLimit: 10000000,
            });

            const result = await getCachedPermissions(sql, userId);
            expect(result).not.toBeNull();
            expect(result!.jellyfinUserId).toBe('jf-user-123');
            expect(result!.enabledLibraries).toEqual(['Movies', 'TV Shows']);
            expect(result!.maxParentalRating).toBe(13);
            expect(result!.enableMediaPlayback).toBe(true);
            expect(result!.enableRemuxing).toBe(false);
        });

        it('updates existing permissions on conflict', async () => {
            const userId = await createTestUser();

            await upsertPermissions(sql, {
                userId,
                jellyfinUserId: 'old-id',
                enabledLibraries: ['Movies'],
                maxParentalRating: null,
                enableMediaPlayback: false,
                enableAudioTranscoding: false,
                enableVideoTranscoding: false,
                enableRemuxing: false,
                enableContentDownloading: false,
                enableRemoteAccess: false,
                remoteClientBitrateLimit: null,
            });

            await upsertPermissions(sql, {
                userId,
                jellyfinUserId: 'new-id',
                enabledLibraries: ['Movies', 'TV'],
                maxParentalRating: 18,
                enableMediaPlayback: true,
                enableAudioTranscoding: true,
                enableVideoTranscoding: true,
                enableRemuxing: true,
                enableContentDownloading: true,
                enableRemoteAccess: true,
                remoteClientBitrateLimit: 20000000,
            });

            const result = await getCachedPermissions(sql, userId);
            expect(result!.jellyfinUserId).toBe('new-id');
            expect(result!.enabledLibraries).toEqual(['Movies', 'TV']);
            expect(result!.maxParentalRating).toBe(18);
            expect(result!.enableMediaPlayback).toBe(true);
        });
    });

    // ========================================================================
    // getCachedPermissions
    // ========================================================================

    describe('getCachedPermissions', () => {
        it('returns null for user without permissions', async () => {
            const result = await getCachedPermissions(sql, toUserId(randomUUID()));
            expect(result).toBeNull();
        });

        it('returns all permission fields mapped correctly', async () => {
            const userId = await createTestUser();

            await upsertPermissions(sql, {
                userId,
                jellyfinUserId: 'jf-456',
                enabledLibraries: ['Music'],
                maxParentalRating: null,
                enableMediaPlayback: true,
                enableAudioTranscoding: false,
                enableVideoTranscoding: false,
                enableRemuxing: false,
                enableContentDownloading: false,
                enableRemoteAccess: false,
                remoteClientBitrateLimit: null,
            });

            const result = await getCachedPermissions(sql, userId);
            expect(result).not.toBeNull();
            // The query joins users → `username` is the human-readable handle
            // (derivedUsername, as ensureTestUser inserted it), NOT the users.id UUID.
            expect(result!.username).toBe(derivedUsername(userId));
            expect(result!.updatedAt).toBeInstanceOf(Date);
        });
    });

    // ========================================================================
    // getStalePermissionUsers
    // ========================================================================

    describe('getStalePermissionUsers', () => {
        it('returns users with stale permissions', async () => {
            const userId = await createTestUser();

            await sql`
                INSERT INTO user_library_permissions (
                    user_id, provider_user_id, enabled_libraries,
                    enable_media_playback, enable_audio_transcoding,
                    enable_video_transcoding, enable_remuxing,
                    enable_content_downloading, enable_remote_access,
                    updated_at
                ) VALUES (
                    ${userId}::uuid, 'jf', '{}', true, true, true, false, false, false,
                    NOW() - INTERVAL '3 hours'
                )
            `;

            const result = await getStalePermissionUsers(sql, 2);
            expect(result).toContain(userId);
        });

        it('does not return fresh permissions', async () => {
            const userId = await createTestUser();

            await upsertPermissions(sql, {
                userId,
                jellyfinUserId: 'jf',
                enabledLibraries: [],
                maxParentalRating: null,
                enableMediaPlayback: true,
                enableAudioTranscoding: true,
                enableVideoTranscoding: true,
                enableRemuxing: false,
                enableContentDownloading: false,
                enableRemoteAccess: false,
                remoteClientBitrateLimit: null,
            });

            const result = await getStalePermissionUsers(sql, 1);
            expect(result).not.toContain(userId);
        });

        it('returns empty array when no permissions exist', async () => {
            const result = await getStalePermissionUsers(sql, 1);
            expect(result).toEqual([]);
        });
    });

    // ========================================================================
    // deletePermissions
    // ========================================================================

    describe('deletePermissions', () => {
        it('deletes cached permissions', async () => {
            const userId = await createTestUser();

            await upsertPermissions(sql, {
                userId,
                jellyfinUserId: 'jf',
                enabledLibraries: [],
                maxParentalRating: null,
                enableMediaPlayback: true,
                enableAudioTranscoding: true,
                enableVideoTranscoding: true,
                enableRemuxing: false,
                enableContentDownloading: false,
                enableRemoteAccess: false,
                remoteClientBitrateLimit: null,
            });

            let result = await getCachedPermissions(sql, userId);
            expect(result).not.toBeNull();

            await deletePermissions(sql, userId);

            result = await getCachedPermissions(sql, userId);
            expect(result).toBeNull();
        });

        it('is a no-op for non-existent user', async () => {
            await expect(deletePermissions(sql, toUserId(randomUUID()))).resolves.toBeUndefined();
        });
    });
});
