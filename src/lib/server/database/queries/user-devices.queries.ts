// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * User Devices Query Module
 *
 * `user_devices` is the single owner of a device's display name. Everything else
 * that once stored a "device name" is either a credential
 * (`user_provider_device_tokens.provider_device_binding`), a user-agent snapshot
 * (`play_sessions.user_agent`), or an immutable archive row
 * (`watch_history.device_name`).
 *
 * Display name resolves as COALESCE(custom_name, reported_name): a name the user
 * chose always beats whatever the client last reported. That precedence lives in
 * the schema rather than in a conditional, so no write path can forget it.
 *
 * @module queries/user-devices
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';

// =============================================================================
// Types
// =============================================================================

export interface UserDeviceRow {
    id: string;
    user_id: string;
    device_id: string;
    /** Last name reported by the client. May be null for provider-only devices. */
    reported_name: string | null;
    /** User-assigned override. Wins over reported_name. */
    custom_name: string | null;
    device_type: string | null;
    client_id: string | null;
    first_seen_at: Date;
    last_seen_at: Date;
}

export interface UpsertUserDeviceParams {
    userId: UserId;
    deviceId: string;
    /** Pass null when the caller has no name to report; never clears an existing one. */
    reportedName: string | null;
    deviceType?: string | null;
    clientId?: string | null;
}

// =============================================================================
// Read Queries
// =============================================================================

/**
 * All devices belonging to a user, most recently seen first.
 */
export async function getUserDeviceRows(
    sql: postgres.Sql,
    userId: UserId,
): Promise<UserDeviceRow[]> {
    return await sql<UserDeviceRow[]>`
        SELECT * FROM user_devices
        WHERE user_id = ${userId}::uuid
        ORDER BY last_seen_at DESC
    `;
}

/**
 * Resolve a single device by its client-generated id, scoped to the owning user.
 *
 * Always scope by user: device_id is client-supplied free text, so an unscoped
 * lookup lets any client read another user's device by claiming its identifier.
 */
export async function getUserDeviceByDeviceId(
    sql: postgres.Sql,
    userId: UserId,
    deviceId: string,
): Promise<UserDeviceRow | null> {
    const rows = await sql<UserDeviceRow[]>`
        SELECT * FROM user_devices
        WHERE user_id = ${userId}::uuid
          AND device_id = ${deviceId}
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/**
 * Find the device session id previously issued to this (user, device) pair.
 *
 * This replaces the old lookup against `user_provider_device_tokens`, which only
 * ever had rows when Jellyfin sync was enabled — so with Jellyfin off every login
 * minted a fresh device_session_id and the device list grew a phantom entry per
 * login. `oauth_refresh_tokens` exists on every install, so continuity no longer
 * depends on an optional integration.
 */
export async function findDeviceSessionIdForDevice(
    sql: postgres.Sql,
    userId: UserId,
    deviceId: string,
): Promise<string | null> {
    const rows = await sql<{ device_session_id: string | null }[]>`
        SELECT device_session_id
        FROM oauth_refresh_tokens
        WHERE user_id = ${userId}::uuid
          AND device_id = ${deviceId}
          AND approved_by_device_session_id IS NULL
          AND device_session_id IS NOT NULL
          AND revoked_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
    `;
    return rows[0]?.device_session_id ?? null;
}

/**
 * Resolve the client-generated device_id behind an auth session.
 *
 * The heartbeat endpoint is authenticated by a device JWT that carries only a
 * device_session_id, so it needs this hop to reach the device entity. Core-only:
 * reads oauth_refresh_tokens, never the Jellyfin provider table.
 *
 * User-scoped: device_session_id is not a secret to the rest of the system, so a
 * lookup that ignored the owner could be pointed at someone else's session.
 */
export async function getDeviceIdForSession(
    sql: postgres.Sql,
    userId: UserId,
    deviceSessionId: string,
): Promise<string | null> {
    const rows = await sql<{ device_id: string | null }[]>`
        SELECT device_id
        FROM oauth_refresh_tokens
        WHERE user_id = ${userId}::uuid
          AND device_session_id = ${deviceSessionId}
          AND device_id IS NOT NULL
          AND revoked_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
    `;
    return rows[0]?.device_id ?? null;
}

/**
 * Does this session belong to this user, and is it still live?
 *
 * Separate from the device lookup so a caller can tell "not yours / revoked"
 * apart from "yours, but not linked to a device" — those want different answers
 * (404 vs 409) and collapsing them produces a misleading message.
 */
export async function sessionBelongsToUser(
    sql: postgres.Sql,
    userId: UserId,
    deviceSessionId: string,
): Promise<boolean> {
    const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one
        FROM oauth_refresh_tokens
        WHERE user_id = ${userId}::uuid
          AND device_session_id = ${deviceSessionId}
          AND revoked_at IS NULL
        LIMIT 1
    `;
    return rows.length > 0;
}

// =============================================================================
// Write Queries
// =============================================================================

/**
 * Register a device sighting and refresh its reported name.
 *
 * Invariants:
 *   - `custom_name` is never written here. A client report cannot overwrite a
 *     name the user chose.
 *   - A null/absent `reportedName` never clears a stored one — clients that
 *     simply don't send a name must not erase it.
 *   - `last_seen_at` always advances, so the device list can sort by recency
 *     without a separate touch query.
 */
export async function upsertUserDevice(
    sql: postgres.Sql,
    params: UpsertUserDeviceParams,
): Promise<UserDeviceRow> {
    const rows = await sql<UserDeviceRow[]>`
        INSERT INTO user_devices (
            user_id, device_id, reported_name, device_type, client_id, last_seen_at
        ) VALUES (
            ${params.userId}::uuid,
            ${params.deviceId},
            ${params.reportedName},
            ${params.deviceType ?? null},
            ${params.clientId ?? null},
            NOW()
        )
        ON CONFLICT (user_id, device_id) DO UPDATE
        SET reported_name = COALESCE(EXCLUDED.reported_name, user_devices.reported_name),
            device_type   = COALESCE(EXCLUDED.device_type, user_devices.device_type),
            client_id     = COALESCE(EXCLUDED.client_id, user_devices.client_id),
            last_seen_at  = NOW()
        RETURNING *
    `;
    return rows[0];
}

/**
 * Set (or clear, with null) the user's chosen name for a device.
 * Scoped by user so one user cannot rename another's device.
 */
export async function setUserDeviceCustomName(
    sql: postgres.Sql,
    userId: UserId,
    deviceId: string,
    customName: string | null,
): Promise<UserDeviceRow | null> {
    const rows = await sql<UserDeviceRow[]>`
        UPDATE user_devices
        SET custom_name = ${customName}
        WHERE user_id = ${userId}::uuid
          AND device_id = ${deviceId}
        RETURNING *
    `;
    return rows[0] ?? null;
}

/**
 * Backfill the device_id on a refresh token so the session resolves to a device
 * without going through the Jellyfin provider table.
 */
export async function linkRefreshTokenToDevice(
    sql: postgres.Sql,
    deviceSessionId: string,
    deviceId: string,
): Promise<void> {
    await sql`
        UPDATE oauth_refresh_tokens
        SET device_id = ${deviceId}
        WHERE device_session_id = ${deviceSessionId}
          AND device_id IS DISTINCT FROM ${deviceId}
    `;
}
