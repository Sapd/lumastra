// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Device Sessions Query Module
 *
 * Centralized queries for OAuth token and device session management.
 * Handles oauth_refresh_tokens table operations.
 */

import { defineQuery, defineWriteQuery } from '../typed-query.js';
import type { UserId } from '$lib/shared/user-id';

// =============================================================================
// Types
// =============================================================================

export interface OAuthRefreshTokenRow {
    id: number;
    user_id: string;
    device_session_id: string;
    device_name: string | null;
    created_at: Date;
    expires_at: Date;
    revoked_at: Date | null;
    last_used_at: Date | null;
}

export interface DeviceSessionRow {
    device_session_id: string;
    device_name: string | null;
    created_at: Date;
    last_used_at: Date | null;
    is_revoked: boolean;
}

// =============================================================================
// Read Queries
// =============================================================================

/**
 * Get all active (non-revoked) sessions for a user.
 */
export const getActiveSessions = defineQuery<{ userId: UserId }, OAuthRefreshTokenRow>(
    'getActiveSessions',
    (sql, { userId }) => sql`
        SELECT id, user_id, device_session_id, device_name, created_at, expires_at, revoked_at, last_used_at
        FROM oauth_refresh_tokens
        WHERE user_id = ${userId}
          AND revoked_at IS NULL
          AND expires_at > NOW()
        ORDER BY last_used_at DESC NULLS LAST
    `,
);

/**
 * Get all sessions (including revoked) for a user.
 */
export const getAllSessions = defineQuery<{ userId: UserId }, OAuthRefreshTokenRow>(
    'getAllSessions',
    (sql, { userId }) => sql`
        SELECT id, user_id, device_session_id, device_name, created_at, expires_at, revoked_at, last_used_at
        FROM oauth_refresh_tokens
        WHERE user_id = ${userId}
        ORDER BY created_at DESC
    `,
);

/**
 * Get device summary (grouped by device).
 */
export const getDeviceSummary = defineQuery<{ userId: UserId }, DeviceSessionRow>(
    'getDeviceSummary',
    (sql, { userId }) => sql`
        SELECT
            device_session_id,
            MAX(device_name) as device_name,
            MIN(created_at) as created_at,
            MAX(last_used_at) as last_used_at,
            BOOL_AND(revoked_at IS NOT NULL) as is_revoked
        FROM oauth_refresh_tokens
        WHERE user_id = ${userId}
        GROUP BY device_session_id
        ORDER BY MAX(last_used_at) DESC NULLS LAST
    `,
);

// =============================================================================
// Write Queries
// =============================================================================

/**
 * Update last used timestamp for a session.
 */
export const updateSessionLastUsed = defineWriteQuery<{ sessionId: number }, { id: number }>(
    'updateSessionLastUsed',
    (sql, { sessionId }) => sql`
        UPDATE oauth_refresh_tokens
        SET last_used_at = NOW()
        WHERE id = ${sessionId}
        RETURNING id
    `,
);

/**
 * Clean up expired sessions (maintenance query).
 */
export const cleanupExpiredSessions = defineWriteQuery<{ daysOld: number }, { count: number }>(
    'cleanupExpiredSessions',
    (sql, { daysOld }) => sql`
        WITH deleted AS (
            DELETE FROM oauth_refresh_tokens
            WHERE expires_at < NOW() - (${daysOld} || ' days')::interval
            RETURNING 1
        )
        SELECT COUNT(*)::int as count FROM deleted
    `,
);
