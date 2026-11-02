// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OAuth Refresh Tokens Query Module
 *
 * Centralized queries for oauth_refresh_tokens table operations.
 * Used by RefreshTokenService.
 *
 * Revoking a row here (any `revoked_at = NOW()` below) deactivates that
 * device's push tokens automatically: migration 16.200.0 adds an
 * `AFTER UPDATE` trigger on `oauth_refresh_tokens` that does this for every
 * revocation path in the codebase, not just the ones in this file. Do not
 * re-add a push-token deactivation call here — see the migration file for
 * why a trigger was chosen over a hand-maintained call-site list.
 *
 * @module queries/oauth-refresh-tokens
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { withTx } from '../with-tx.js';

// =============================================================================
// Types
// =============================================================================

export interface RefreshTokenRow {
    id: number;
    token_hash: string;
    user_id: string;
    client_id: string;
    scope: string | null;
    device_name: string | null;
    user_groups: string[] | null;
    provider_user_id: string | null;
    created_at: Date;
    expires_at: Date;
    revoked_at: Date | null;
    last_used_at: Date | null;
    device_session_id: string | null;
    /**
     * Client-generated device id. Links the session to its `user_devices` row so
     * device continuity no longer depends on the Jellyfin provider table (which
     * is empty when Jellyfin sync is disabled).
     */
    device_id: string | null;
    approved_by_device_session_id: string | null;
    approved_by_device_name: string | null;
    /**
     * When this token was rotated away from, or NULL if it is the current token
     * of its session.
     *
     * A superseded token is still VALID: rotation no longer revokes what it
     * replaces (migration 16.218.0). The predecessor is revoked only once its
     * successor is actually used, so a client that lost the rotation response
     * can still refresh with the token it holds instead of being signed out
     * permanently.
     */
    superseded_at: Date | null;
    /** `id` of the token minted to replace this one. */
    superseded_by: number | null;
}

export interface CreateRefreshTokenParams {
    tokenHash: string;
    userId: UserId;
    clientId: string;
    scope: string | null;
    deviceName: string | null;
    groups: string[];
    jellyfinUserId: string | null;
    expiresAt: Date;
    deviceSessionId: string;
    deviceId?: string | null;
    approvedByDeviceSessionId?: string | null;
    approvedByDeviceName?: string | null;
}

// =============================================================================
// Read Queries
// =============================================================================

/**
 * Validate a refresh token by its hash.
 * Returns null if invalid, expired, or revoked.
 */
export async function validateRefreshToken(
    sql: postgres.Sql,
    tokenHash: string,
): Promise<RefreshTokenRow | null> {
    const rows = await sql<RefreshTokenRow[]>`
        SELECT * FROM oauth_refresh_tokens
        WHERE token_hash = ${tokenHash}
          AND revoked_at IS NULL
          AND expires_at > NOW()
    `;
    return rows[0] || null;
}

/**
 * Get the current (non-superseded) live token of every session for a user.
 *
 * `superseded_at IS NULL` matters since 16.218.0: a rotated-away token stays
 * valid until its successor is used, so without this filter each session would
 * report two live rows. Callers use this for device listings and for resolving
 * "the token of this device session", both of which want exactly the current
 * one.
 */
export async function getActiveRefreshTokens(
    sql: postgres.Sql,
    userId: UserId,
): Promise<RefreshTokenRow[]> {
    return await sql<RefreshTokenRow[]>`
        SELECT * FROM oauth_refresh_tokens
        WHERE user_id = ${userId}::uuid
          AND revoked_at IS NULL
          AND superseded_at IS NULL
          AND expires_at > NOW()
        ORDER BY created_at DESC
    `;
}

/**
 * Get device name from refresh tokens by device session ID.
 */
export async function getDeviceNameBySession(
    sql: postgres.Sql,
    deviceSessionId: string,
): Promise<string | null> {
    const rows = await sql<{ device_name: string | null }[]>`
        SELECT device_name FROM oauth_refresh_tokens
        WHERE device_session_id = ${deviceSessionId}
          AND revoked_at IS NULL
          AND superseded_at IS NULL
        LIMIT 1
    `;
    return rows[0]?.device_name || null;
}

/** Fresh, database-backed authority for issuing another device credential. */
export async function getDeviceApprover(
    sql: postgres.Sql,
    userId: UserId,
    deviceSessionId: string,
): Promise<RefreshTokenRow | null> {
    const rows = await sql<RefreshTokenRow[]>`
        SELECT rt.*, COALESCE(ud.custom_name, ud.reported_name, rt.device_name) AS device_name
        FROM oauth_refresh_tokens rt
        LEFT JOIN user_devices ud ON ud.user_id = rt.user_id AND ud.device_id = rt.device_id
        WHERE rt.user_id = ${userId}::uuid AND rt.device_session_id = ${deviceSessionId}
          AND rt.approved_by_device_session_id IS NULL
          AND rt.revoked_at IS NULL AND rt.expires_at > NOW()
          AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens child
              WHERE child.device_session_id = ${deviceSessionId}
                AND child.approved_by_device_session_id IS NOT NULL)
        ORDER BY rt.created_at DESC LIMIT 1
    `;
    return rows[0] ?? null;
}

/** Never mix independent and dependent credentials under one session ID. */
export async function hasConflictingDeviceSessionLineage(
    sql: postgres.Sql,
    deviceSessionId: string,
    parent: string | null,
): Promise<boolean> {
    const rows = await sql`
        SELECT 1 FROM oauth_refresh_tokens WHERE device_session_id = ${deviceSessionId}
          AND approved_by_device_session_id IS DISTINCT FROM ${parent}::uuid LIMIT 1
    `;
    return rows.length > 0;
}

/** Include even already revoked children so retries repeat JWT/stream cutoff. */
export async function listApprovedDeviceSessionIds(
    sql: postgres.Sql,
    ids: readonly string[],
): Promise<string[]> {
    const parentIds = ids.filter((id) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id));
    if (!parentIds.length) return [];
    const rows = await sql<{ id: string }[]>`
        SELECT DISTINCT device_session_id AS id FROM oauth_refresh_tokens
        WHERE approved_by_device_session_id = ANY(${parentIds}::uuid[]) AND device_session_id IS NOT NULL
    `;
    return rows.map((r) => r.id);
}

/** The caller holds all root locks. New exchanges cannot escape this snapshot. */
async function revokeSessionTrees(tx: postgres.Sql, ids: string[]): Promise<RevokedRefreshTokens> {
    const all = [...new Set([...ids, ...(await listApprovedDeviceSessionIds(tx, ids))])];
    if (!all.length) return { count: 0, deviceSessionIds: [] };
    await lockDeviceSessions(tx, all);
    const parentIds = all.filter((id) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id));
    if (parentIds.length)
        await tx`UPDATE oauth_device_codes SET status = 'denied'
        WHERE approved_by_device_session_id = ANY(${parentIds}::uuid[]) AND status = 'authorized'`;
    const rows = await tx<{ device_session_id: string | null }[]>`
        UPDATE oauth_refresh_tokens SET revoked_at = NOW()
        WHERE device_session_id = ANY(${all}) AND revoked_at IS NULL RETURNING device_session_id
    `;
    return { count: rows.length, deviceSessionIds: all };
}

/**
 * Is this device session still signed in?
 *
 * A session is live while ANY of its refresh-token rows is unrevoked. Not
 * filtered on `superseded_at` or `expires_at`: rotation supersedes the presented
 * row without revoking it and inserts an unrevoked successor (16.218.0), so a
 * normal refresh never leaves a session with zero unrevoked rows. Only an
 * explicit revocation (logout, device revoke, revoke-all, backchannel logout)
 * does — which is exactly the event the access-JWT liveness check
 * (`oauth/device-session-liveness.ts`) must observe. Uses
 * `idx_oauth_refresh_tokens_device_session_id`.
 */
export async function isDeviceSessionLiveInDb(
    sql: postgres.Sql,
    deviceSessionId: string,
): Promise<boolean> {
    const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM oauth_refresh_tokens
        WHERE device_session_id = ${deviceSessionId}
          AND revoked_at IS NULL
        LIMIT 1
    `;
    return rows.length > 0;
}

// =============================================================================
// Write Queries
// =============================================================================

/**
 * Create a new refresh token.
 */
export async function createRefreshToken(
    sql: postgres.Sql,
    params: CreateRefreshTokenParams,
): Promise<void> {
    await sql`
        INSERT INTO oauth_refresh_tokens (
            token_hash, user_id, client_id, scope, device_name,
            user_groups, provider_user_id, expires_at, device_session_id,
            device_id, approved_by_device_session_id, approved_by_device_name
        ) VALUES (
            ${params.tokenHash},
            ${params.userId}::uuid,
            ${params.clientId},
            ${params.scope},
            ${params.deviceName},
            ${params.groups},
            ${params.jellyfinUserId},
            ${params.expiresAt},
            ${params.deviceSessionId},
            ${params.deviceId ?? null},
            ${params.approvedByDeviceSessionId ?? null}::uuid,
            ${params.approvedByDeviceName ?? null}
        )
    `;
}

/**
 * Update last_used_at for a token.
 */
export async function updateRefreshTokenLastUsed(
    sql: postgres.Sql,
    tokenHash: string,
): Promise<void> {
    await sql`
        UPDATE oauth_refresh_tokens
        SET last_used_at = NOW()
        WHERE token_hash = ${tokenHash}
    `;
}

/**
 * Revoke a specific token by hash. Not a device-session revoke: the session
 * stays live while it has another unrevoked row. No production caller; kept
 * for tests and fixtures.
 */
export async function revokeRefreshToken(sql: postgres.Sql, tokenHash: string): Promise<number> {
    const result = await sql<{ id: number }[]>`
        UPDATE oauth_refresh_tokens
        SET revoked_at = NOW()
        WHERE token_hash = ${tokenHash}
          AND revoked_at IS NULL
        RETURNING id
    `;
    return result.length;
}

// -----------------------------------------------------------------------------
// Device-session revocation
//
// Every query that revokes a whole device session (or every session of a user
// or client) takes a per-session advisory transaction lock first, and so do
// refresh rotation (`RefreshTokenService.rotate`) and refresh-token creation
// (`RefreshTokenService.create`). Without it a revoke racing a rotation could
// revoke the presented token while the successor the rotation just inserted
// (invisible to the revoke's snapshot) stayed unrevoked, resurrecting the
// "revoked" device. With the lock, either the rotation sees the revoke (and
// refuses), or the revoke runs after the rotation committed and sees the
// successor.
//
// Production callers go through `oauth/device-session-revocation.ts`, which
// also cuts off the sessions' access JWTs and stream tokens. Do not call these
// directly from a route.
// -----------------------------------------------------------------------------

/**
 * Take the per-device-session advisory lock(s) for the current transaction.
 * Roots first, sorted within each generation to avoid deadlocks. MUST run inside a
 * transaction (the lock is released at commit/rollback).
 */
export async function lockDeviceSessions(
    tx: postgres.Sql,
    deviceSessionIds: readonly string[],
): Promise<void> {
    const ids = [...new Set(deviceSessionIds)].sort();
    // Every operation locks roots before children. Child rotation/revocation
    // must use the same order as parent revocation and new child creation.
    const lineage = ids.length
        ? await tx<{ id: string; parent: string }[]>`
        SELECT DISTINCT device_session_id AS id, approved_by_device_session_id::text AS parent
        FROM oauth_refresh_tokens WHERE device_session_id = ANY(${ids})
          AND approved_by_device_session_id IS NOT NULL
    `
        : [];
    const children = new Set(lineage.map((r) => r.id));
    const roots = [
        ...new Set([...lineage.map((r) => r.parent), ...ids.filter((id) => !children.has(id))]),
    ].sort();
    for (const id of [...roots, ...ids.filter((id) => children.has(id))]) {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'oauth_dsess:' + id}, 0))`;
    }
}

/**
 * A session that has refresh-token rows but none unrevoked was revoked. A
 * session with no rows at all is new (or was cleaned up long ago) — not
 * revoked.
 */
export async function isDeviceSessionRevokedInDb(
    sql: postgres.Sql,
    deviceSessionId: string,
): Promise<boolean> {
    const rows = await sql<{ any_rows: boolean; live_rows: boolean }[]>`
        SELECT
            EXISTS (SELECT 1 FROM oauth_refresh_tokens
                    WHERE device_session_id = ${deviceSessionId}) AS any_rows,
            EXISTS (SELECT 1 FROM oauth_refresh_tokens
                    WHERE device_session_id = ${deviceSessionId}
                      AND revoked_at IS NULL) AS live_rows
    `;
    return rows[0].any_rows && !rows[0].live_rows;
}

/** Whether this device session belongs (or belonged — any state) to the user. */
export async function isDeviceSessionOwnedBy(
    sql: postgres.Sql,
    deviceSessionId: string,
    userId: UserId,
): Promise<boolean> {
    const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM oauth_refresh_tokens
        WHERE device_session_id = ${deviceSessionId}
          AND user_id = ${userId}::uuid
        LIMIT 1
    `;
    return rows.length > 0;
}

/**
 * Every device session id a user has rows for, in any state (revoked rows are
 * kept 7 days). Optionally limited to one OAuth client.
 */
export async function listDeviceSessionIdsForUser(
    sql: postgres.Sql,
    userId: UserId,
    clientId?: string,
): Promise<string[]> {
    const clientFilter = clientId !== undefined ? sql`AND client_id = ${clientId}` : sql``;
    const rows = await sql<{ device_session_id: string }[]>`
        SELECT DISTINCT device_session_id FROM oauth_refresh_tokens
        WHERE user_id = ${userId}::uuid
          AND device_session_id IS NOT NULL
          ${clientFilter}
    `;
    return rows.map((r) => r.device_session_id);
}

/**
 * The user's device sessions that are revoked: rows exist, none unrevoked.
 * Optionally limited to one OAuth client. A session that logged in after a
 * revoke has an unrevoked row and is not listed.
 */
export async function listRevokedDeviceSessionIdsForUser(
    sql: postgres.Sql,
    userId: UserId,
    clientId?: string,
): Promise<string[]> {
    const clientFilter = clientId !== undefined ? sql`AND client_id = ${clientId}` : sql``;
    const rows = await sql<{ device_session_id: string }[]>`
        SELECT device_session_id FROM oauth_refresh_tokens
        WHERE user_id = ${userId}::uuid
          AND device_session_id IS NOT NULL
          ${clientFilter}
        GROUP BY device_session_id
        HAVING bool_and(revoked_at IS NOT NULL)
    `;
    return rows.map((r) => r.device_session_id);
}

/** Result of a revocation that also reports which device sessions it ended. */
export interface RevokedRefreshTokens {
    count: number;
    /** Distinct non-null device_session_id values of the rows just revoked. */
    deviceSessionIds: string[];
}

/**
 * Revoke every unrevoked row of a user (optionally of one client), holding the
 * lock of each affected device session.
 */
async function revokeUserRows(
    sql: postgres.Sql,
    userId: UserId,
    clientId: string | undefined,
): Promise<RevokedRefreshTokens> {
    return await withTx(sql, async (tx) => {
        const clientFilter = clientId !== undefined ? tx`AND client_id = ${clientId}` : tx``;
        const sessions = await tx<{ device_session_id: string }[]>`
            SELECT DISTINCT device_session_id FROM oauth_refresh_tokens
            WHERE user_id = ${userId}::uuid
              AND device_session_id IS NOT NULL
              ${clientFilter}
        `;
        await lockDeviceSessions(
            tx,
            sessions.map((r) => r.device_session_id),
        );
        const tree = await revokeSessionTrees(
            tx,
            sessions.map((r) => r.device_session_id),
        );
        const legacy = await tx<{ device_session_id: string | null }[]>`
            UPDATE oauth_refresh_tokens SET revoked_at = NOW()
            WHERE user_id = ${userId}::uuid AND device_session_id IS NULL
              AND revoked_at IS NULL ${clientFilter} RETURNING device_session_id
        `;
        return { ...tree, count: tree.count + legacy.length };
    });
}

/**
 * Revoke all tokens for a user.
 */
export async function revokeAllUserRefreshTokens(
    sql: postgres.Sql,
    userId: UserId,
): Promise<number> {
    return (await revokeAllUserRefreshTokensDetailed(sql, userId)).count;
}

/**
 * {@link revokeAllUserRefreshTokens}, also returning the device sessions it
 * revoked so the caller can cut off their access JWTs and stream tokens.
 */
export async function revokeAllUserRefreshTokensDetailed(
    sql: postgres.Sql,
    userId: UserId,
): Promise<RevokedRefreshTokens> {
    return await revokeUserRows(sql, userId, undefined);
}

/**
 * Revoke all tokens for a user on a specific client.
 */
export async function revokeUserClientRefreshTokens(
    sql: postgres.Sql,
    userId: UserId,
    clientId: string,
): Promise<number> {
    return (await revokeUserClientRefreshTokensDetailed(sql, userId, clientId)).count;
}

/** {@link revokeUserClientRefreshTokens}, also returning the revoked device sessions. */
export async function revokeUserClientRefreshTokensDetailed(
    sql: postgres.Sql,
    userId: UserId,
    clientId: string,
): Promise<RevokedRefreshTokens> {
    return await revokeUserRows(sql, userId, clientId);
}

/**
 * Revoke every unrevoked row of one device session (optionally only if it
 * belongs to `userId`), under the session's lock. Returns the number of rows
 * revoked.
 */
export async function revokeRefreshTokensByDeviceSessionId(
    sql: postgres.Sql,
    deviceSessionId: string,
    userId?: UserId,
): Promise<number> {
    return (await revokeDeviceSessionTree(sql, deviceSessionId, userId)).count;
}

export async function revokeDeviceSessionTree(
    sql: postgres.Sql,
    deviceSessionId: string,
    userId?: UserId,
): Promise<RevokedRefreshTokens> {
    return await withTx(sql, async (tx) => {
        await lockDeviceSessions(tx, [deviceSessionId]);
        if (userId !== undefined && !(await isDeviceSessionOwnedBy(tx, deviceSessionId, userId)))
            return { count: 0, deviceSessionIds: [] };
        return revokeSessionTrees(tx, [deviceSessionId]);
    });
}

/**
 * Update groups for all active tokens of a user.
 */
export async function updateRefreshTokenGroups(
    sql: postgres.Sql,
    userId: UserId,
    groups: string[],
): Promise<number> {
    const result = await sql<{ id: number }[]>`
        UPDATE oauth_refresh_tokens
        SET user_groups = ${groups}
        WHERE user_id = ${userId}::uuid
          AND revoked_at IS NULL
          AND expires_at > NOW()
        RETURNING id
    `;
    return result.length;
}

/**
 * Cleanup expired and old revoked tokens.
 *
 * Revoked rows are kept for 7 days, matching expired ones. They used to be
 * dropped after 1 day, which made sign-out complaints nearly impossible to
 * investigate: by the time anyone looked, the evidence of what revoked the
 * session was already deleted, and container logs did not reach back that far
 * either. Seven days covers "this happened to me over the weekend".
 */
export async function cleanupRefreshTokens(sql: postgres.Sql): Promise<number> {
    const result = await sql<{ id: number }[]>`
        DELETE FROM oauth_refresh_tokens
        WHERE expires_at < NOW() - INTERVAL '7 days'
           OR (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '7 days')
        RETURNING id
    `;
    return result.length;
}
