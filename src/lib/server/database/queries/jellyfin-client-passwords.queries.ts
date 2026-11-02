// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin Client Passwords Query Module
 *
 * Pure SQL queries for jellyfin_client_passwords table operations.
 * Supports the Jellyfin compatibility layer password authentication.
 */

import { defineQuery, defineWriteQuery } from '../typed-query.js';

// =============================================================================
// Types
// =============================================================================

export interface ClientPasswordRow {
    id: number;
    user_id: string;
    password_hash: string;
    /**
     * AES-256-GCM sealed copy of the generated PIN (`enc:v1:<base64>`), kept
     * ONLY so the settings UI can re-reveal it. Authentication never reads this
     * — it verifies against `password_hash`. NULL for rows written before
     * migration 16.170.0, which the UI surfaces as "reset to see it again".
     */
    password_sealed: string | null;
    created_at: Date;
    last_used_at: Date | null;
}

/**
 * Auth-path projection. Deliberately does NOT carry `password_sealed`: the
 * login path has no use for the reversible copy, so it never pulls that secret
 * into memory. Only the reveal path (`getPasswordByUserId`) selects it.
 */
export interface ClientPasswordWithUserRow extends Omit<ClientPasswordRow, 'password_sealed'> {
    username: string;
    native_password_hash: string | null;
    is_admin: boolean;
    display_name: string | null;
    groups: string[] | null;
}

export interface UserWithPasswordRow {
    user_id: string;
    username: string;
    display_name: string | null;
    is_admin: boolean;
}

// =============================================================================
// Read Queries
// =============================================================================

/**
 * Get client password record by user ID.
 */
export const getPasswordByUserId = defineQuery<{ userId: string }, ClientPasswordRow>(
    'getPasswordByUserId',
    (sql, { userId }) => sql`
        SELECT id, user_id, password_hash, password_sealed, created_at, last_used_at
        FROM jellyfin_client_passwords
        WHERE user_id = ${userId}
    `,
);

/**
 * Get client password record joined with user data, looked up by username.
 *
 * Excludes a disabled account (`u.disabled_at IS NOT NULL`) — the admin
 * kill-switch must be honoured here too (security review 2026-09-13, C2), so
 * `POST /j/Users/AuthenticateByName` sees the same "no such row" outcome as a
 * genuinely unknown username (`validatePassword` runs its constant-time dummy
 * compare either way — no enumeration).
 */
export const getPasswordByUsername = defineQuery<{ username: string }, ClientPasswordWithUserRow>(
    'getPasswordByUsername',
    (sql, { username }) => sql`
        SELECT jcp.id, jcp.user_id, jcp.password_hash, jcp.created_at, jcp.last_used_at,
               u.username, u.password_hash AS native_password_hash, u.is_admin, u.display_name, u.groups
        FROM jellyfin_client_passwords jcp
        JOIN users u ON u.id = jcp.user_id
        WHERE u.username = ${username}
          AND u.disabled_at IS NULL
          AND u.deleted_at IS NULL
    `,
);

/**
 * Get all users that have a client password set.
 */
export const getUsersWithPasswords = defineQuery<Record<string, never>, UserWithPasswordRow>(
    'getUsersWithPasswords',
    (sql, _params) => sql`
        SELECT u.id as user_id, u.username, u.display_name, u.is_admin
        FROM users u
        JOIN jellyfin_client_passwords jcp ON jcp.user_id = u.id
        ORDER BY u.username
    `,
);

// =============================================================================
// Write Queries
// =============================================================================

/**
 * Insert or update client password for a user.
 * Resets created_at on update to track when the password was last regenerated.
 */
export const upsertPassword = defineWriteQuery<
    { userId: string; passwordHash: string; passwordSealed: string | null },
    { id: number }
>(
    'upsertPassword',
    (sql, { userId, passwordHash, passwordSealed }) => sql`
        INSERT INTO jellyfin_client_passwords (user_id, password_hash, password_sealed)
        VALUES (${userId}, ${passwordHash}, ${passwordSealed})
        ON CONFLICT (user_id) DO UPDATE SET
            password_hash = ${passwordHash},
            password_sealed = ${passwordSealed},
            created_at = NOW()
        RETURNING id
    `,
);

/**
 * Update last_used_at timestamp for a user's password record.
 */
export const updateLastUsed = defineWriteQuery<{ userId: string }, { id: number }>(
    'updateLastUsed',
    (sql, { userId }) => sql`
        UPDATE jellyfin_client_passwords
        SET last_used_at = NOW()
        WHERE user_id = ${userId}
        RETURNING id
    `,
);

/**
 * Delete client password for a user (revokes Jellyfin compat access).
 */
export const deletePassword = defineWriteQuery<{ userId: string }, { id: number }>(
    'deletePassword',
    (sql, { userId }) => sql`
        DELETE FROM jellyfin_client_passwords
        WHERE user_id = ${userId}
        RETURNING id
    `,
);
