// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Library Permissions Query Module
 *
 * Centralized queries for user_library_permissions table operations.
 * Used by JellyfinPermissionsService for caching user permissions from Jellyfin.
 *
 * @module queries/library-permissions
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';

// =============================================================================
// Types
// =============================================================================

export interface JellyfinPermissionsRow {
    username: string;
    jellyfinUserId: string;
    enabledLibraries: string[];
    maxParentalRating: number | null;
    enableMediaPlayback: boolean;
    enableAudioTranscoding: boolean;
    enableVideoTranscoding: boolean;
    enableRemuxing: boolean;
    enableContentDownloading: boolean;
    enableRemoteAccess: boolean;
    remoteClientBitrateLimit: number | null;
    updatedAt: Date;
}

export interface UpsertPermissionsParams {
    userId: UserId;
    jellyfinUserId: string;
    enabledLibraries: string[];
    maxParentalRating: number | null;
    enableMediaPlayback: boolean;
    enableAudioTranscoding: boolean;
    enableVideoTranscoding: boolean;
    enableRemuxing: boolean;
    enableContentDownloading: boolean;
    enableRemoteAccess: boolean;
    remoteClientBitrateLimit: number | null;
}

// =============================================================================
// Read Queries
// =============================================================================

/**
 * Get cached permissions for a user.
 */
export async function getCachedPermissions(
    sql: postgres.Sql,
    userId: UserId,
): Promise<JellyfinPermissionsRow | null> {
    const rows = await sql<JellyfinPermissionsRow[]>`
        SELECT
            u.username as "username",
            ulp.provider_user_id as "jellyfinUserId",
            ulp.enabled_libraries as "enabledLibraries",
            ulp.max_parental_rating as "maxParentalRating",
            ulp.enable_media_playback as "enableMediaPlayback",
            ulp.enable_audio_transcoding as "enableAudioTranscoding",
            ulp.enable_video_transcoding as "enableVideoTranscoding",
            ulp.enable_remuxing as "enableRemuxing",
            ulp.enable_content_downloading as "enableContentDownloading",
            ulp.enable_remote_access as "enableRemoteAccess",
            ulp.remote_client_bitrate_limit as "remoteClientBitrateLimit",
            ulp.updated_at as "updatedAt"
        FROM user_library_permissions ulp
        JOIN users u ON u.id = ulp.user_id
        WHERE ulp.user_id = ${userId}::uuid
    `;
    return rows[0] || null;
}

/**
 * Get usernames with stale permissions.
 */
export async function getStalePermissionUsers(
    sql: postgres.Sql,
    maxAgeHours: number,
): Promise<string[]> {
    const rows = await sql<{ user_id: string }[]>`
        SELECT user_id
        FROM user_library_permissions
        WHERE updated_at < NOW() - INTERVAL '1 hour' * ${maxAgeHours}
    `;
    return rows.map((r) => r.user_id);
}

// =============================================================================
// Write Queries
// =============================================================================

/**
 * Upsert permissions for a user.
 */
export async function upsertPermissions(
    sql: postgres.Sql,
    params: UpsertPermissionsParams,
): Promise<void> {
    await sql`
        INSERT INTO user_library_permissions (
            user_id, provider_user_id,
            enabled_libraries, max_parental_rating,
            enable_media_playback, enable_audio_transcoding,
            enable_video_transcoding, enable_remuxing,
            enable_content_downloading, enable_remote_access,
            remote_client_bitrate_limit, updated_at
        ) VALUES (
            ${params.userId}::uuid,
            ${params.jellyfinUserId},
            ${params.enabledLibraries},
            ${params.maxParentalRating},
            ${params.enableMediaPlayback},
            ${params.enableAudioTranscoding},
            ${params.enableVideoTranscoding},
            ${params.enableRemuxing},
            ${params.enableContentDownloading},
            ${params.enableRemoteAccess},
            ${params.remoteClientBitrateLimit},
            NOW()
        )
        ON CONFLICT (user_id) DO UPDATE SET
            provider_user_id = ${params.jellyfinUserId},
            enabled_libraries = ${params.enabledLibraries},
            max_parental_rating = ${params.maxParentalRating},
            enable_media_playback = ${params.enableMediaPlayback},
            enable_audio_transcoding = ${params.enableAudioTranscoding},
            enable_video_transcoding = ${params.enableVideoTranscoding},
            enable_remuxing = ${params.enableRemuxing},
            enable_content_downloading = ${params.enableContentDownloading},
            enable_remote_access = ${params.enableRemoteAccess},
            remote_client_bitrate_limit = ${params.remoteClientBitrateLimit},
            updated_at = NOW()
    `;
}

/**
 * Delete cached permissions for a user.
 */
export async function deletePermissions(sql: postgres.Sql, userId: UserId): Promise<void> {
    await sql`
        DELETE FROM user_library_permissions
        WHERE user_id = ${userId}::uuid
    `;
}
