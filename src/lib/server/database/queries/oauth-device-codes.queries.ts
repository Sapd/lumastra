// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OAuth Device Codes Query Module
 *
 * Centralized queries for oauth_device_codes table operations.
 * Used by DeviceCodeService for device authorization flow.
 *
 * @module queries/oauth-device-codes
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';

// =============================================================================
// Types
// =============================================================================

export type DeviceCodeStatus = 'pending' | 'authorized' | 'denied' | 'expired';

export interface DeviceCodeRow {
    id: number;
    device_code: string;
    user_code: string;
    client_id: string;
    device_name: string | null;
    scope: string | null;
    user_id: string | null;
    status: DeviceCodeStatus;
    verification_uri: string | null;
    verification_uri_complete: string | null;
    last_poll_at: Date | null;
    created_at: Date;
    expires_at: Date;
    device_session_id: string;
    device_id: string | null;
    approved_by_device_session_id: string | null;
    created_by_device_session_id: string | null;
    /** Server-resolved by client_id (see device-client-redirects.ts) — never client-supplied. */
    redirect_uri: string | null;
}

export interface CreateDeviceCodeParams {
    deviceCode: string;
    userCode: string;
    clientId: string;
    deviceName: string | null;
    scope: string | null;
    verificationUri: string;
    verificationUriComplete: string;
    expiresAt: Date;
    deviceSessionId: string;
    deviceId: string | null;
    createdByDeviceSessionId?: string | null;
    /** Server-resolved by client_id (see device-client-redirects.ts) — never client-supplied. */
    redirectUri: string | null;
}

// =============================================================================
// Read Queries
// =============================================================================

/**
 * Get device code by device_code (for polling).
 */
export async function getDeviceCodeByDeviceCode(
    sql: postgres.Sql,
    deviceCode: string,
): Promise<DeviceCodeRow | null> {
    const rows = await sql<DeviceCodeRow[]>`
        SELECT * FROM oauth_device_codes
        WHERE device_code = ${deviceCode}
    `;
    return rows[0] || null;
}

/**
 * Get device code by user_code (for authorization page).
 */
export async function getDeviceCodeByUserCode(
    sql: postgres.Sql,
    userCode: string,
): Promise<DeviceCodeRow | null> {
    const rows = await sql<DeviceCodeRow[]>`
        SELECT * FROM oauth_device_codes
        WHERE user_code = ${userCode}
    `;
    return rows[0] || null;
}

/**
 * Count pending device codes for a client.
 * Used for rate limiting.
 */
export async function countPendingDeviceCodes(
    sql: postgres.Sql,
    clientId: string,
): Promise<number> {
    const result = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count
        FROM oauth_device_codes
        WHERE client_id = ${clientId}
          AND status = 'pending'
          AND expires_at > NOW()
    `;
    return parseInt(result[0]?.count || '0', 10);
}

// =============================================================================
// Write Queries
// =============================================================================

/**
 * Create a new device code.
 */
export async function createDeviceCode(
    sql: postgres.Sql,
    params: CreateDeviceCodeParams,
): Promise<void> {
    await sql`
        INSERT INTO oauth_device_codes (
            device_code, user_code, client_id, device_name, scope,
            verification_uri, verification_uri_complete, expires_at, device_session_id, device_id,
            redirect_uri, created_by_device_session_id
        ) VALUES (
            ${params.deviceCode},
            ${params.userCode},
            ${params.clientId},
            ${params.deviceName},
            ${params.scope},
            ${params.verificationUri},
            ${params.verificationUriComplete},
            ${params.expiresAt},
            ${params.deviceSessionId},
            ${params.deviceId},
            ${params.redirectUri}, ${params.createdByDeviceSessionId ?? null}::uuid
        )
    `;
}

/**
 * Authorize a device code (user approved).
 */
export async function authorizeDeviceCode(
    sql: postgres.Sql,
    deviceCode: string,
    userId: UserId,
    approvedByDeviceSessionId?: string,
): Promise<boolean> {
    const rows = await sql<{ id: number }[]>`
        UPDATE oauth_device_codes
        SET approved_by_device_session_id = ${approvedByDeviceSessionId ?? null}::uuid, status = 'authorized', user_id = ${userId}::uuid
        WHERE device_code = ${deviceCode} AND status = 'pending' AND expires_at > NOW()
          AND EXISTS (SELECT 1 FROM users WHERE id = ${userId}::uuid
                      AND disabled_at IS NULL AND deleted_at IS NULL)
        RETURNING id
    `;
    return rows.length > 0;
}

/**
 * Update device code status.
 */
export async function updateDeviceCodeStatus(
    sql: postgres.Sql,
    deviceCode: string,
    status: DeviceCodeStatus,
): Promise<void> {
    await sql`
        UPDATE oauth_device_codes
        SET status = ${status}
        WHERE device_code = ${deviceCode}
    `;
}

/**
 * Record a poll attempt (for rate limiting).
 */
export async function recordDeviceCodePoll(sql: postgres.Sql, deviceCode: string): Promise<void> {
    await sql`
        UPDATE oauth_device_codes
        SET last_poll_at = NOW()
        WHERE device_code = ${deviceCode}
    `;
}

/**
 * Delete a device code after token exchange.
 */
export async function deleteDeviceCode(sql: postgres.Sql, deviceCode: string): Promise<void> {
    await sql`
        DELETE FROM oauth_device_codes
        WHERE device_code = ${deviceCode}
    `;
}

/**
 * Cleanup expired device codes.
 */
export async function cleanupExpiredDeviceCodes(sql: postgres.Sql): Promise<number> {
    const result = await sql<{ id: number }[]>`
        DELETE FROM oauth_device_codes
        WHERE expires_at < NOW() - INTERVAL '1 hour'
        RETURNING id
    `;
    return result.length;
}

/** A denial must not overwrite a concurrent authorization (or an expired code). */
export async function denyDeviceCode(
    sql: postgres.Sql,
    deviceCode: string,
    userId?: UserId,
): Promise<boolean> {
    const rows = await sql<{ id: number }[]>`
        UPDATE oauth_device_codes SET status = 'denied'
        WHERE device_code = ${deviceCode} AND status = 'pending' AND expires_at > NOW()
          AND (${userId ?? null}::uuid IS NULL OR EXISTS (
              SELECT 1 FROM users WHERE id = ${userId ?? null}::uuid
              AND disabled_at IS NULL AND deleted_at IS NULL
          ))
        RETURNING id
    `;
    return rows.length > 0;
}

/** Consume before minting, on the issuance transaction so failures restore it. */
export async function consumeAuthorizedDeviceCode(
    sql: postgres.Sql,
    deviceCode: string,
    clientId: string,
): Promise<DeviceCodeRow | null> {
    const rows = await sql<DeviceCodeRow[]>`
        DELETE FROM oauth_device_codes
        WHERE device_code = ${deviceCode} AND client_id = ${clientId}
          AND status = 'authorized' AND expires_at + INTERVAL '2 minutes' > clock_timestamp()
        RETURNING *
    `;
    return rows[0] ?? null;
}
