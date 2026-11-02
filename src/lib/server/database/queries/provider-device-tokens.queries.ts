// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Provider Device Tokens Query Module
 *
 * Centralized queries for user_provider_device_tokens table operations.
 * Used by JellyfinTokenService.
 *
 * @module queries/provider-device-tokens
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';

// =============================================================================
// Types
// =============================================================================

export interface JellyfinDeviceTokenRow {
    id: number;
    user_id: string;
    provider_user_id: string;
    device_session_id: string;
    provider_device_binding: string | null;
    provider_access_token: string;
    device_id: string | null;
    created_at: Date;
    last_used_at: Date | null;
    revoked_at: Date | null;
}

export interface CreateJellyfinTokenParams {
    userId: UserId;
    jellyfinUserId: string;
    deviceSessionId: string;
    deviceName: string;
    accessToken: string;
    deviceId: string | null;
}

// =============================================================================
// Read Queries
// =============================================================================

/**
 * Get token by device session ID.
 */
export async function getJellyfinTokenBySession(
    sql: postgres.Sql,
    deviceSessionId: string,
): Promise<JellyfinDeviceTokenRow | null> {
    const rows = await sql<JellyfinDeviceTokenRow[]>`
        SELECT * FROM user_provider_device_tokens
        WHERE device_session_id = ${deviceSessionId}
          AND revoked_at IS NULL
    `;
    return rows[0] || null;
}

/**
 * Get all active tokens for a user.
 */
export async function getActiveJellyfinTokens(
    sql: postgres.Sql,
    userId: UserId,
): Promise<JellyfinDeviceTokenRow[]> {
    return await sql<JellyfinDeviceTokenRow[]>`
        SELECT * FROM user_provider_device_tokens
        WHERE user_id = ${userId}::uuid
          AND revoked_at IS NULL
        ORDER BY created_at DESC
    `;
}

// =============================================================================
// Write Queries
// =============================================================================

/**
 * Create or update a provider device token.
 * Uses ON CONFLICT to handle race conditions.
 */
export async function upsertJellyfinToken(
    sql: postgres.Sql,
    params: CreateJellyfinTokenParams,
): Promise<void> {
    await sql`
        INSERT INTO user_provider_device_tokens (
            user_id, provider_user_id, device_session_id,
            provider_device_binding, provider_access_token, device_id
        ) VALUES (
            ${params.userId}::uuid,
            ${params.jellyfinUserId},
            ${params.deviceSessionId},
            ${params.deviceName},
            ${params.accessToken},
            ${params.deviceId}
        )
        ON CONFLICT (device_session_id) DO UPDATE
        SET user_id = EXCLUDED.user_id,
            provider_user_id = EXCLUDED.provider_user_id,
            provider_access_token = EXCLUDED.provider_access_token,
            provider_device_binding = EXCLUDED.provider_device_binding,
            device_id = COALESCE(EXCLUDED.device_id, user_provider_device_tokens.device_id),
            last_used_at = NOW()
    `;
}

/**
 * Update last_used_at for a token.
 */
export async function updateJellyfinTokenLastUsed(
    sql: postgres.Sql,
    deviceSessionId: string,
): Promise<void> {
    await sql`
        UPDATE user_provider_device_tokens
        SET last_used_at = NOW()
        WHERE device_session_id = ${deviceSessionId}
    `;
}

/**
 * Delete a token by device session ID.
 */
export async function deleteJellyfinToken(
    sql: postgres.Sql,
    deviceSessionId: string,
): Promise<void> {
    await sql`
        DELETE FROM user_provider_device_tokens
        WHERE device_session_id = ${deviceSessionId}
    `;
}

/**
 * Revoke a token by device session ID.
 * Optionally verify ownership by username.
 */
export async function revokeJellyfinToken(
    sql: postgres.Sql,
    deviceSessionId: string,
    userId?: UserId,
): Promise<number> {
    if (userId) {
        const result = await sql<{ id: number }[]>`
            UPDATE user_provider_device_tokens
            SET revoked_at = NOW()
            WHERE device_session_id = ${deviceSessionId}
              AND user_id = ${userId}::uuid
              AND revoked_at IS NULL
            RETURNING id
        `;
        return result.length;
    }

    const result = await sql<{ id: number }[]>`
        UPDATE user_provider_device_tokens
        SET revoked_at = NOW()
        WHERE device_session_id = ${deviceSessionId}
          AND revoked_at IS NULL
        RETURNING id
    `;
    return result.length;
}

/**
 * Revoke all tokens for a user.
 */
export async function revokeAllUserJellyfinTokens(
    sql: postgres.Sql,
    userId: UserId,
): Promise<number> {
    const result = await sql<{ id: number }[]>`
        UPDATE user_provider_device_tokens
        SET revoked_at = NOW()
        WHERE user_id = ${userId}::uuid
          AND revoked_at IS NULL
        RETURNING id
    `;
    return result.length;
}

/**
 * Cleanup orphaned tokens not used in threshold days.
 */
export async function cleanupOrphanedJellyfinTokens(
    sql: postgres.Sql,
    thresholdDate: Date,
): Promise<Array<{ id: number; user_id: string; device_session_id: string }>> {
    return await sql<Array<{ id: number; user_id: string; device_session_id: string }>>`
        DELETE FROM user_provider_device_tokens
        WHERE revoked_at IS NULL
          AND (
            (last_used_at IS NULL AND created_at < ${thresholdDate})
            OR (last_used_at IS NOT NULL AND last_used_at < ${thresholdDate})
          )
        RETURNING id, user_id, device_session_id
    `;
}

/**
 * Cleanup old revoked tokens.
 */
export async function cleanupRevokedJellyfinTokens(sql: postgres.Sql): Promise<number> {
    const result = await sql<{ id: number }[]>`
        DELETE FROM user_provider_device_tokens
        WHERE revoked_at IS NOT NULL
          AND revoked_at < NOW() - INTERVAL '7 days'
        RETURNING id
    `;
    return result.length;
}
