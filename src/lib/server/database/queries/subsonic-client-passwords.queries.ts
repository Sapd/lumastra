// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OpenSubsonic Client Passwords Query Module
 *
 * Pure SQL queries for subsonic_client_passwords table operations.
 * Supports the OpenSubsonic compatibility layer token-based authentication.
 */

import { defineQuery, defineWriteQuery } from '../typed-query.js';

// =============================================================================
// Types
// =============================================================================

export interface SubsonicPasswordRow {
    id: number;
    user_id: string;
    /**
     * Legacy plaintext token. NULL once the row has been upgraded to the
     * sealed representation — read `token_sealed` instead. Exactly one of the
     * two is populated; never read this without checking `token_sealed` first.
     */
    token: string | null;
    /** AES-256-GCM envelope (`enc:v1:<base64>`) of the token. NULL on legacy rows. */
    token_sealed: string | null;
    /**
     * HMAC-SHA256(masterKey, token) — a blind index, the only way to do the
     * apiKeyAuthentication reverse lookup against a sealed token (the envelope
     * itself is non-deterministic). NULL on legacy rows.
     */
    token_lookup: string | null;
    created_at: Date;
    last_used_at: Date | null;
}

export interface SubsonicAuthRow extends SubsonicPasswordRow {
    username: string;
    is_admin: boolean;
    display_name: string | null;
    groups: string[] | null;
}

export interface UserWithTokenRow {
    user_id: string;
    username: string;
    display_name: string | null;
    is_admin: boolean;
}

// =============================================================================
// Read Queries
// =============================================================================

/**
 * Get subsonic token record by user ID.
 */
export const getTokenByUserId = defineQuery<{ userId: string }, SubsonicPasswordRow>(
    'getTokenByUserId',
    (sql, { userId }) => sql`
        SELECT id, user_id, token, token_sealed, token_lookup, created_at, last_used_at
        FROM subsonic_client_passwords
        WHERE user_id = ${userId}
    `,
);

/**
 * Get subsonic token record joined with user data, looked up by user ID.
 * Used when we have a userId (e.g. during token reset/delete) and need the
 * username to invalidate the per-username auth cache entry.
 */
export const getTokenWithUserByUserId = defineQuery<{ userId: string }, SubsonicAuthRow>(
    'getTokenWithUserByUserId',
    (sql, { userId }) => sql`
        SELECT scp.id, scp.user_id, scp.token, scp.token_sealed, scp.token_lookup, scp.created_at, scp.last_used_at,
               u.username, u.is_admin, u.display_name, u.groups
        FROM subsonic_client_passwords scp
        JOIN users u ON u.id = scp.user_id
        WHERE scp.user_id = ${userId}
    `,
);

/**
 * Get subsonic token record joined with user data, looked up by username.
 *
 * Excludes a disabled account (`u.disabled_at IS NOT NULL`) — the admin
 * kill-switch must be honoured here too (security review 2026-09-13, C2), so
 * `validateCredentials` sees the same "no such row" outcome (constant-time
 * dummy compare, no enumeration) as a genuinely unknown username. Note the
 * caller ALSO checks a per-username Valkey auth cache before reaching this
 * query — `setDisabled` invalidates that cache directly so a cached entry
 * can't outlive this predicate.
 */
export const getTokenByUsername = defineQuery<{ username: string }, SubsonicAuthRow>(
    'getTokenByUsername',
    (sql, { username }) => sql`
        SELECT scp.id, scp.user_id, scp.token, scp.token_sealed, scp.token_lookup, scp.created_at, scp.last_used_at,
               u.username, u.is_admin, u.display_name, u.groups
        FROM subsonic_client_passwords scp
        JOIN users u ON u.id = scp.user_id
        WHERE LOWER(u.username) = LOWER(${username})
          AND u.disabled_at IS NULL
    `,
);

/**
 * Look up a token record by its value.
 * Used for apiKeyAuthentication — the key IS the token, reversed lookup.
 *
 * Matches on the blind index (`token_lookup`) for sealed rows and on the raw
 * value for not-yet-upgraded legacy rows, so both representations resolve
 * through one query. Pass `lookup: null` when no master key is available:
 * `token_lookup = NULL` is never true in SQL, so the sealed branch simply
 * never matches instead of needing a separate query.
 *
 * Excludes a disabled account (`u.disabled_at IS NOT NULL`) — the admin
 * kill-switch must be honoured here too (security review 2026-09-13, C2), so
 * `validateApiKey` treats a disabled user's key the same as an unknown one
 * (constant-time dummy compare, no enumeration).
 */
export const getTokenByValue = defineQuery<
    { token: string; lookup: string | null },
    SubsonicAuthRow
>(
    'getTokenByValue',
    (sql, { token, lookup }) => sql`
        SELECT scp.id, scp.user_id, scp.token, scp.token_sealed, scp.token_lookup, scp.created_at, scp.last_used_at,
               u.username, u.is_admin, u.display_name, u.groups
        FROM subsonic_client_passwords scp
        JOIN users u ON u.id = scp.user_id
        WHERE (scp.token_lookup = ${lookup} OR scp.token = ${token})
          AND u.disabled_at IS NULL
    `,
);

/**
 * Get all users that have a subsonic token set.
 */
export const getUsersWithTokens = defineQuery<Record<string, never>, UserWithTokenRow>(
    'getUsersWithTokens',
    (sql, _params) => sql`
        SELECT u.id as user_id, u.username, u.display_name, u.is_admin
        FROM users u
        JOIN subsonic_client_passwords scp ON scp.user_id = u.id
        ORDER BY u.username
    `,
);

// =============================================================================
// Write Queries
// =============================================================================

/**
 * Insert or update subsonic token for a user.
 * Resets created_at on update to track when the token was last regenerated.
 *
 * Callers pass EITHER the sealed pair (`token: null` + sealed + lookup) or the
 * plaintext fallback (`token` set + both others null) — all three are written
 * unconditionally so an upgrade to sealed clears the plaintext, and a degraded
 * write clears a stale envelope rather than leaving the two disagreeing.
 */
export const upsertToken = defineWriteQuery<
    {
        userId: string;
        token: string | null;
        tokenSealed: string | null;
        tokenLookup: string | null;
    },
    { id: number }
>(
    'upsertToken',
    (sql, { userId, token, tokenSealed, tokenLookup }) => sql`
        INSERT INTO subsonic_client_passwords (user_id, token, token_sealed, token_lookup)
        VALUES (${userId}, ${token}, ${tokenSealed}, ${tokenLookup})
        ON CONFLICT (user_id) DO UPDATE SET
            token = ${token},
            token_sealed = ${tokenSealed},
            token_lookup = ${tokenLookup},
            created_at = NOW()
        RETURNING id
    `,
);

/**
 * Upgrade a legacy plaintext row to the sealed representation in place.
 *
 * Scoped to `token_sealed IS NULL` so a concurrent reset (which writes a NEW
 * token) can never be clobbered by an in-flight upgrade carrying the OLD one —
 * the reset populates token_sealed, and this UPDATE then matches nothing.
 */
export const upgradeTokenToSealed = defineWriteQuery<
    { userId: string; tokenSealed: string; tokenLookup: string },
    { id: number }
>(
    'upgradeTokenToSealed',
    (sql, { userId, tokenSealed, tokenLookup }) => sql`
        UPDATE subsonic_client_passwords
        SET token = NULL,
            token_sealed = ${tokenSealed},
            token_lookup = ${tokenLookup}
        WHERE user_id = ${userId} AND token_sealed IS NULL
        RETURNING id
    `,
);

/**
 * Update last_used_at timestamp for a user's token record.
 */
export const updateLastUsed = defineWriteQuery<{ userId: string }, { id: number }>(
    'updateLastUsed',
    (sql, { userId }) => sql`
        UPDATE subsonic_client_passwords
        SET last_used_at = NOW()
        WHERE user_id = ${userId}
        RETURNING id
    `,
);

/**
 * Delete subsonic token for a user (revokes OpenSubsonic access).
 */
export const deleteToken = defineWriteQuery<{ userId: string }, { id: number }>(
    'deleteToken',
    (sql, { userId }) => sql`
        DELETE FROM subsonic_client_passwords
        WHERE user_id = ${userId}
        RETURNING id
    `,
);
