// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Query module for the `user_sessions` table — server-side session store backing
 * native (built-in) browser login. Pure SQL; `sql: postgres.Sql` first param, no
 * side effects. Session tokens are opaque and only their SHA-256 hash is stored.
 */

import type postgres from 'postgres';

export interface UserSessionRow {
    id: string;
    user_id: string;
    token_hash: string;
    created_at: Date;
    expires_at: Date;
    last_used_at: Date | null;
    revoked_at: Date | null;
    user_agent: string | null;
    ip: string | null;
}

/**
 * A validated session joined with the identity fields needed to build a
 * UserContext, so session validation is a single round-trip.
 */
export interface ValidatedSessionRow {
    session_id: string;
    user_id: string;
    username: string;
    groups: string[] | null;
    is_admin: boolean;
    admin_pinned: boolean;
    max_age_rating: number | null;
    age_rating_pinned: boolean;
}

export async function createSession(
    sql: postgres.Sql,
    params: {
        userId: string;
        tokenHash: string;
        expiresAt: Date;
        userAgent?: string | null;
        ip?: string | null;
        oidcIss?: string | null;
        oidcSub?: string | null;
        oidcSid?: string | null;
    },
): Promise<string> {
    const rows = await sql<{ id: string }[]>`
        INSERT INTO user_sessions (
            user_id, token_hash, expires_at, user_agent, ip,
            oidc_iss, oidc_sub, oidc_sid
        )
        VALUES (
            ${params.userId},
            ${params.tokenHash},
            ${params.expiresAt},
            ${params.userAgent ?? null},
            ${params.ip ?? null},
            ${params.oidcIss ?? null},
            ${params.oidcSub ?? null},
            ${params.oidcSid ?? null}
        )
        RETURNING id
    `;
    return rows[0].id;
}

/**
 * Look up a live (non-revoked, non-expired) session by token hash and join the
 * owning user's identity fields. Returns null if no live session matches.
 */
export async function findValidSessionWithUser(
    sql: postgres.Sql,
    tokenHash: string,
): Promise<ValidatedSessionRow | null> {
    const rows = await sql<ValidatedSessionRow[]>`
        SELECT
            s.id            AS session_id,
            s.user_id       AS user_id,
            u.username      AS username,
            u.groups        AS groups,
            u.is_admin      AS is_admin,
            u.admin_pinned  AS admin_pinned,
            u.max_age_rating AS max_age_rating,
            u.age_rating_pinned AS age_rating_pinned
        FROM user_sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ${tokenHash}
          AND s.revoked_at IS NULL
          AND s.expires_at > NOW()
          AND u.disabled_at IS NULL
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/**
 * Update last_used_at for a session (best-effort liveness tracking). Callers
 * throttle this so it doesn't fire on every request.
 */
export async function touchSession(sql: postgres.Sql, tokenHash: string): Promise<void> {
    await sql`
        UPDATE user_sessions
        SET last_used_at = NOW()
        WHERE token_hash = ${tokenHash}
          AND revoked_at IS NULL
    `;
}

/** Revoke a single session by token hash. Returns the number of rows affected. */
export async function revokeSession(sql: postgres.Sql, tokenHash: string): Promise<number> {
    const rows = await sql`
        UPDATE user_sessions
        SET revoked_at = NOW()
        WHERE token_hash = ${tokenHash}
          AND revoked_at IS NULL
        RETURNING id
    `;
    return rows.length;
}

/**
 * Revoke ALL of a user's sessions (logout-everywhere / password change).
 * Returns the number of sessions revoked.
 */
export async function revokeAllUserSessions(sql: postgres.Sql, userId: string): Promise<number> {
    const rows = await sql`
        UPDATE user_sessions
        SET revoked_at = NOW()
        WHERE user_id = ${userId}
          AND revoked_at IS NULL
        RETURNING id
    `;
    return rows.length;
}

/**
 * Revoke all of a user's sessions EXCEPT the one identified by `keepTokenHash`.
 * Used on password change to log the user out everywhere else while keeping the
 * just-issued current-device session valid (no window with zero live sessions).
 * Returns the number revoked.
 */
export async function revokeAllUserSessionsExcept(
    sql: postgres.Sql,
    userId: string,
    keepTokenHash: string,
): Promise<number> {
    const rows = await sql`
        UPDATE user_sessions
        SET revoked_at = NOW()
        WHERE user_id = ${userId}
          AND revoked_at IS NULL
          AND token_hash <> ${keepTokenHash}
        RETURNING id
    `;
    return rows.length;
}

/**
 * Revoke a single session identified by its row id, scoped to its owner.
 * The user_id predicate makes this IDOR-safe: a caller can only revoke a row
 * that both matches the given id AND belongs to `userId`. Returns rows affected
 * (0 = not found or not owned).
 */
export async function revokeUserSessionByIdScoped(
    sql: postgres.Sql,
    id: string,
    userId: string,
): Promise<number> {
    const rows = await sql`
        UPDATE user_sessions
        SET revoked_at = NOW()
        WHERE id = ${id}
          AND user_id = ${userId}
          AND revoked_at IS NULL
        RETURNING id
    `;
    return rows.length;
}

/**
 * List a user's live sessions (most recently used first) — for an
 * active-sessions UI. Excludes revoked/expired rows.
 */
export async function listUserSessions(
    sql: postgres.Sql,
    userId: string,
): Promise<UserSessionRow[]> {
    return sql<UserSessionRow[]>`
        SELECT id, user_id, token_hash, created_at, expires_at, last_used_at, revoked_at, user_agent, ip
        FROM user_sessions
        WHERE user_id = ${userId}
          AND revoked_at IS NULL
          AND expires_at > NOW()
        ORDER BY last_used_at DESC NULLS LAST, created_at DESC
    `;
}

/**
 * Delete expired and long-revoked sessions. Returns the number of rows removed.
 * Run periodically; revoked rows are kept for a short window for audit, then GC'd.
 */
export async function cleanupExpiredSessions(sql: postgres.Sql): Promise<number> {
    const rows = await sql`
        DELETE FROM user_sessions
        WHERE expires_at < NOW()
           OR (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '7 days')
        RETURNING id
    `;
    return rows.length;
}

/**
 * Revoke every live session bound to the OP session identified by (iss, sid).
 * Used by OIDC Back-Channel Logout for a sid-scoped logout (one specific
 * browser session). Returns the number of rows newly revoked.
 */
export async function revokeSessionsByOidcSid(
    sql: postgres.Sql,
    iss: string,
    sid: string,
): Promise<number> {
    // Defensive: an empty iss/sid must never match rows (those columns are NULL
    // for native sessions, but guard anyway so a bad caller can't mass-revoke).
    if (!iss || !sid) return 0;
    const rows = await sql<{ id: string }[]>`
        UPDATE user_sessions
        SET revoked_at = now()
        WHERE oidc_iss = ${iss}
          AND oidc_sid = ${sid}
          AND revoked_at IS NULL
        RETURNING id
    `;
    return rows.length;
}

/**
 * Revoke every live session for the End-User identified by (iss, sub) — a
 * sub-scoped Back-Channel Logout ("logged out everywhere"). Returns the distinct
 * affected user ids so the caller can optionally cascade to device tokens.
 */
export async function revokeSessionsByOidcSub(
    sql: postgres.Sql,
    iss: string,
    sub: string,
): Promise<string[]> {
    if (!iss || !sub) return [];
    const rows = await sql<{ user_id: string }[]>`
        UPDATE user_sessions
        SET revoked_at = now()
        WHERE oidc_iss = ${iss}
          AND oidc_sub = ${sub}
          AND revoked_at IS NULL
        RETURNING user_id
    `;
    return [...new Set(rows.map((r) => r.user_id))];
}

/** How an account can sign in, for the Settings → Account "signed in with" line. */
export interface AccountSignInFacts {
    /** The account has a local (built-in login) password. */
    hasPassword: boolean;
    /** The given session was minted by an OIDC sign-in (it carries an issuer). */
    sessionIsOidc: boolean;
}

/**
 * Whether `userId` has a local password, and whether `sessionId` (the session
 * serving the current request, or null for a non-session request) came from an
 * OIDC sign-in. The session is matched on BOTH id and owner, so a caller can
 * never read another user's session. Returns null when the user doesn't exist.
 */
export async function getAccountSignInFacts(
    sql: postgres.Sql,
    userId: string,
    sessionId: string | null,
): Promise<AccountSignInFacts | null> {
    const rows = await sql<{ has_password: boolean; session_is_oidc: boolean }[]>`
        SELECT
            (u.password_hash IS NOT NULL) AS has_password,
            EXISTS (
                SELECT 1 FROM user_sessions s
                WHERE s.id = ${sessionId}::uuid
                  AND s.user_id = u.id
                  AND s.oidc_iss IS NOT NULL
            ) AS session_is_oidc
        FROM users u
        WHERE u.id = ${userId}
        LIMIT 1
    `;
    const row = rows[0];
    return row ? { hasPassword: row.has_password, sessionIsOidc: row.session_is_oidc } : null;
}
