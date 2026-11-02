// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OAuth Admin Query Module
 *
 * Centralized queries for OAuth-related admin operations including:
 * - User groups management
 * - OAuth token revocation
 *
 * @module queries/oauth-admin
 */

import { buildUserPermissions } from '$lib/server/auth.js';
import type postgres from 'postgres';
import { defaultActivitySharing } from '$lib/server/config/activity-sharing.js';
import type { UserId } from '$lib/shared/user-id';
import { foldUsername } from '$lib/shared/username-fold.js';
import { revokeRefreshTokensByDeviceSessionId } from './oauth-refresh-tokens.queries.js';

// =============================================================================
// User Groups Queries
// =============================================================================

/**
 * Upsert a user's IdP group projection (`users.groups`). Reached through
 * `syncUserGroups` (user-groups.service.ts) from forward-auth's per-request
 * sync, the device-authorize route (forward-auth sessions only) and the OIDC
 * login sync, and directly from `user-identity.service.ts` when an OIDC or
 * auth-plugin identity is provisioned. Not pin-aware and not the whole writer
 * set: the native-admin and admin-create paths in `users.queries.ts` write the
 * column themselves.
 */
export async function upsertUserGroups(
    sql: postgres.Sql,
    username: string,
    groups: string[],
): Promise<void> {
    const usernameLower = username.toLowerCase();
    const sharing = defaultActivitySharing();
    await sql`
        INSERT INTO users (allow_live_tv, hide_streams, share_listening_activity, share_audiobook_activity, username, groups, groups_updated_at, updated_at)
        VALUES (${buildUserPermissions(groups).isAgeRestricted ? false : null}, ${!sharing}, ${sharing}, ${sharing}, ${usernameLower}, ${groups}, NOW(), NOW())
        ON CONFLICT (username) DO UPDATE SET
            groups = ${groups},
            groups_updated_at = NOW(),
            updated_at = NOW()
    `;
}

// =============================================================================
// OAuth Token Revocation Queries
// =============================================================================

export interface TokenRevocationResult {
    revokedCount: number;
}

/**
 * Revoke OAuth refresh token by device session ID (user-scoped), under the
 * device session's lock — see `revokeRefreshTokensByDeviceSessionId`.
 * Production callers use `oauth/device-session-revocation.ts`.
 */
export async function revokeOAuthTokenBySessionId(
    sql: postgres.Sql,
    deviceSessionId: string,
    userId: UserId,
): Promise<TokenRevocationResult> {
    return {
        revokedCount: await revokeRefreshTokensByDeviceSessionId(sql, deviceSessionId, userId),
    };
}

// =============================================================================
// Privacy Settings Queries
// =============================================================================

export interface PrivacySetting {
    username: string;
    hideFromOthers: boolean;
}

/**
 * Get all users with privacy enabled (hidden from others).
 */
export async function getHiddenUsers(sql: postgres.Sql): Promise<PrivacySetting[]> {
    const result = await sql<{ username: string; hide_streams: boolean }[]>`
        SELECT username, hide_streams
        FROM users
        WHERE hide_streams = true
    `;
    return result.map((setting) => ({
        username: setting.username,
        hideFromOthers: setting.hide_streams,
    }));
}

/**
 * Set an existing user's "hide my streams" flag. Returns false when no
 * (non-deleted) user has that name.
 *
 * Never inserts: it used to upsert by the raw name, so a typo or a
 * differently-cased name created a phantom `users` row and left the real
 * user's flag unchanged while the admin UI reported success. Stamps
 * `privacy_prefs_updated_at` and the explicit-choice marker like self-service,
 * so applying an instance default cannot undo an admin's per-user override.
 */
export async function setUserPrivacySetting(
    sql: postgres.Sql,
    username: string,
    hideFromOthers: boolean,
): Promise<boolean> {
    const rows = await sql<{ username: string }[]>`
        UPDATE users
        SET hide_streams = ${hideFromOthers},
            sharing_explicitly_set_by_user = true,
            privacy_prefs_updated_at = NOW(),
            updated_at = NOW()
        WHERE username = ${foldUsername(username)}
          AND deleted_at IS NULL
        RETURNING username
    `;
    return rows.length > 0;
}
