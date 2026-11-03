// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Device Code Service for OAuth 2.0 Device Authorization Grant
// Manages device authorization codes and their lifecycle

import { randomBytes, randomInt, randomUUID } from 'crypto';
import type { UserId } from '$lib/shared/user-id';
import type postgres from 'postgres';
import { Database } from '../database/connection.js';
import { config } from '../config';
import { appPath } from '$lib/shared/api-urls.js';
import { Logger } from '../utils/logger';
import { getRegisteredDeviceRedirect } from './device-client-redirects.js';
import {
    getDeviceCodeByDeviceCode,
    getDeviceCodeByUserCode,
    createDeviceCode,
    authorizeDeviceCode,
    denyDeviceCode,
    updateDeviceCodeStatus,
    recordDeviceCodePoll,
    deleteDeviceCode,
    consumeAuthorizedDeviceCode,
    cleanupExpiredDeviceCodes,
    countPendingDeviceCodes,
} from '../database/queries/oauth-device-codes.queries.js';

import { withTx } from '../database/with-tx.js';
import {
    getDeviceApprover,
    lockDeviceSessions,
} from '../database/queries/oauth-refresh-tokens.queries.js';

const logger = Logger.for('OAuth:DeviceCode');

// Approval codes have a small search space; even hashes are offline guessable.
export function redactUserCode(_code: string): string {
    return '[REDACTED]';
}

/** Canonical spelling used by lookups and guessing budgets. */
export function normalizeUserCode(userCode: string): string {
    const code = userCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : userCode.toUpperCase();
}

export interface DeviceCodeRequest {
    clientId: string;
    scope?: string;
    deviceName?: string;
    /** Client-provided persistent device identifier (e.g., from Keychain) */
    deviceId?: string;
    createdByDeviceSessionId?: string;
}

export interface DeviceCodeResponse {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
}

export interface DeviceCodeRecord {
    id: number;
    device_code: string;
    user_code: string;
    client_id: string;
    device_name: string | null;
    scope: string | null;
    user_id: string | null;
    status: 'pending' | 'authorized' | 'denied' | 'expired';
    verification_uri: string | null;
    verification_uri_complete: string | null;
    last_poll_at: Date | null;
    created_at: Date;
    expires_at: Date;
    /** Unique session ID for this device authorization - persists across token refreshes */
    device_session_id: string;
    /** Client-provided persistent device identifier - used to reuse device_session_id */
    device_id: string | null;
    approved_by_device_session_id: string | null;
    created_by_device_session_id: string | null;
    /** Server-resolved by client_id (see device-client-redirects.ts) — never client-supplied. */
    redirect_uri: string | null;
}

export type DeviceCodeStatus = 'pending' | 'authorized' | 'denied' | 'expired';

export class DeviceCodeService {
    private readonly db: Database;
    private readonly sql: postgres.Sql;

    constructor() {
        this.db = new Database();
        this.sql = this.db.getSql();
    }

    /**
     * Generate a new device code and user code pair
     */
    async createDeviceCode(
        request: DeviceCodeRequest,
        baseUrl: string,
    ): Promise<DeviceCodeResponse> {
        // Generate cryptographically secure device code (64 chars hex)
        const deviceCode = randomBytes(32).toString('hex');

        // Generate user-friendly code (XXXX-XXXX format)
        const userCode = this.generateUserCode();

        // Generate unique device session ID - this persists across token refreshes
        // and is used to uniquely identify this device for Jellyfin playback sessions
        const deviceSessionId = randomUUID();

        const expiresIn = config.DEVICE_CODE_TTL_SECONDS;
        const expiresAt = new Date(Date.now() + expiresIn * 1000);

        const verificationUrl = new URL(baseUrl);
        // A configured public path replaces BASE_PATH (it can be a proxy alias).
        // An origin-only base uses the same appPath as all other app links.
        const publicPath = verificationUrl.pathname.replace(/\/+$/, '');
        verificationUrl.pathname = publicPath ? `${publicPath}/device` : appPath('/device');
        verificationUrl.search = '';
        verificationUrl.hash = '';
        const verificationUri = verificationUrl.href;
        verificationUrl.searchParams.set('code', userCode);
        const verificationUriComplete = verificationUrl.href;

        // Resolved from the first-party registry by client_id — request.clientId
        // is caller-supplied (this endpoint is unauthenticated) and never used to
        // pick a redirect target directly; see device-client-redirects.ts.
        const redirectUri = getRegisteredDeviceRedirect(request.clientId) ?? null;

        // Store in database - include device_id if provided for session reuse
        await createDeviceCode(this.sql, {
            deviceCode,
            userCode,
            clientId: request.clientId,
            deviceName: request.deviceName || null,
            scope: request.scope || null,
            verificationUri,
            verificationUriComplete,
            expiresAt,
            deviceSessionId,
            deviceId: request.deviceId || null,
            createdByDeviceSessionId: request.createdByDeviceSessionId,
            redirectUri,
        });

        logger.info('Device code created', {
            clientId: request.clientId,
            userCode: redactUserCode(userCode),
            deviceSessionId: deviceSessionId.substring(0, 8) + '...',
            hasDeviceId: !!request.deviceId,
            expiresIn,
        });

        return {
            device_code: deviceCode,
            user_code: userCode,
            verification_uri: verificationUri,
            verification_uri_complete: verificationUriComplete,
            expires_in: expiresIn,
            interval: config.DEVICE_CODE_POLL_INTERVAL_SECONDS,
        };
    }

    /**
     * Generate a user-friendly code in XXXX-XXXX format
     * Uses characters that are easy to type and distinguish
     */
    private generateUserCode(): string {
        // Exclude ambiguous characters: 0/O, 1/I/L, 5/S
        const chars = 'ABCDEFGHJKMNPQRTUVWXYZ2346789';
        let code = '';
        for (let i = 0; i < 8; i++) {
            if (i === 4) code += '-';
            // randomInt rejects out-of-range draws: no modulo bias toward early characters.
            code += chars[randomInt(chars.length)];
        }
        return code;
    }

    /**
     * Get device code by device_code (for polling)
     */
    async getByDeviceCode(deviceCode: string): Promise<DeviceCodeRecord | null> {
        const record = (await getDeviceCodeByDeviceCode(
            this.sql,
            deviceCode,
        )) as DeviceCodeRecord | null;

        if (!record) {
            return null;
        }

        // Approved TVs have two minutes after the normal deadline to collect.
        const graceMs = record.status === 'authorized' ? 120_000 : 0;
        if (
            (record.status === 'pending' || record.status === 'authorized') &&
            Date.now() > record.expires_at.getTime() + graceMs
        ) {
            await this.updateStatus(deviceCode, 'expired');
            return { ...record, status: 'expired' };
        }

        return record;
    }

    /**
     * Get device code by user_code (for authorization page)
     */
    async getByUserCode(userCode: string): Promise<DeviceCodeRecord | null> {
        const formattedCode = normalizeUserCode(userCode);

        const record = (await getDeviceCodeByUserCode(
            this.sql,
            formattedCode,
        )) as DeviceCodeRecord | null;

        if (!record) {
            return null;
        }

        // Check if expired
        if (new Date() > record.expires_at && record.status === 'pending') {
            await this.updateStatus(record.device_code, 'expired');
            return { ...record, status: 'expired' };
        }

        return record;
    }

    /**
     * Authorize a device code (user approved)
     */
    async authorize(
        userCode: string,
        userId: UserId,
        approvedByDeviceSessionId?: string,
    ): Promise<boolean> {
        const record = await this.getByUserCode(userCode);

        if (!record) {
            logger.warn('Authorize failed: code not found', {
                userCode: redactUserCode(userCode),
            });
            return false;
        }

        if (record.status !== 'pending') {
            logger.warn('Authorize failed: code not pending', {
                userCode: redactUserCode(userCode),
                status: record.status,
            });
            return false;
        }

        if (new Date() > record.expires_at) {
            logger.warn('Authorize failed: code expired', {
                userCode: redactUserCode(userCode),
            });
            await this.updateStatus(record.device_code, 'expired');
            return false;
        }

        const changed = await withTx(this.sql, async (tx) => {
            if (approvedByDeviceSessionId) {
                await lockDeviceSessions(tx, [approvedByDeviceSessionId]);
                const approver = await getDeviceApprover(tx, userId, approvedByDeviceSessionId);
                const target = await getDeviceCodeByDeviceCode(tx, record.device_code);
                if (
                    !approver ||
                    !target ||
                    target.device_session_id === approvedByDeviceSessionId ||
                    target.created_by_device_session_id === approvedByDeviceSessionId ||
                    target.client_id === approver.client_id ||
                    (target.device_id && target.device_id === approver.device_id)
                )
                    return false;
            }
            return authorizeDeviceCode(tx, record.device_code, userId, approvedByDeviceSessionId);
        });
        if (!changed) return false;

        logger.info('Device code authorized', {
            userCode: redactUserCode(userCode),
            userId,
        });
        return true;
    }

    /**
     * Deny a device code (user rejected)
     */
    async deny(userCode: string, userId?: UserId): Promise<boolean> {
        const record = await this.getByUserCode(userCode);

        if (!record) {
            logger.warn('Deny failed: code not found', {
                userCode: redactUserCode(userCode),
            });
            return false;
        }

        if (record.status !== 'pending') {
            logger.warn('Deny failed: code not pending', {
                userCode: redactUserCode(userCode),
                status: record.status,
            });
            return false;
        }

        if (!(await denyDeviceCode(this.sql, record.device_code, userId))) return false;
        logger.info('Device code denied', {
            userCode: redactUserCode(userCode),
        });
        return true;
    }

    /**
     * Update device code status
     */
    private async updateStatus(deviceCode: string, status: DeviceCodeStatus): Promise<void> {
        await updateDeviceCodeStatus(this.sql, deviceCode, status);
    }

    /**
     * Record a poll attempt (for rate limiting)
     */
    async recordPoll(deviceCode: string): Promise<void> {
        await recordDeviceCodePoll(this.sql, deviceCode);
    }

    /**
     * Check if polling too fast (rate limiting)
     * Returns true if client should slow down
     */
    async isPollTooFast(deviceCode: string): Promise<boolean> {
        const minIntervalMs = config.DEVICE_CODE_POLL_INTERVAL_SECONDS * 1000;
        const thresholdMs = minIntervalMs - 1000;

        // Do comparison entirely in PostgreSQL to avoid any clock issues
        const result = await this.sql<[{ is_too_fast: boolean; time_since_ms: number | null }]>`
            SELECT
                CASE
                    WHEN last_poll_at IS NULL THEN false
                    WHEN EXTRACT(EPOCH FROM (NOW() - last_poll_at)) * 1000 < ${thresholdMs} THEN true
                    ELSE false
                END as is_too_fast,
                EXTRACT(EPOCH FROM (NOW() - last_poll_at)) * 1000 as time_since_ms
            FROM oauth_device_codes
            WHERE device_code = ${deviceCode}
        `;

        if (!result.length) {
            return false;
        }

        const { is_too_fast, time_since_ms } = result[0];

        logger.info('isPollTooFast check', {
            timeSinceLastPoll: time_since_ms,
            minInterval: minIntervalMs,
            threshold: thresholdMs,
            isTooFast: is_too_fast,
        });

        return is_too_fast;
    }

    /**
     * Cleanup expired device codes (run periodically)
     */
    async cleanupExpired(): Promise<number> {
        const count = await cleanupExpiredDeviceCodes(this.sql);

        if (count > 0) {
            logger.info('Cleaned up expired device codes', {
                count,
            });
        }

        return count;
    }

    /** The code and issued refresh token commit together; throws restore both. */
    async exchangeAuthorized<T>(
        deviceCode: string,
        clientId: string,
        issue: (record: DeviceCodeRecord, tx: postgres.Sql) => Promise<T>,
    ): Promise<T | null> {
        return withTx(this.sql, async (tx) => {
            const record = await consumeAuthorizedDeviceCode(tx, deviceCode, clientId);
            return record ? issue(record, tx) : null;
        });
    }

    /**
     * Mark device code as used (after token exchange)
     */
    async markAsUsed(deviceCode: string): Promise<void> {
        await deleteDeviceCode(this.sql, deviceCode);
        logger.debug('Device code consumed and deleted');
    }

    /**
     * Count pending device codes for a client_id
     * Used for rate limiting to prevent creating too many pending codes
     */
    async countPendingForClient(clientId: string): Promise<number> {
        return await countPendingDeviceCodes(this.sql, clientId);
    }
}

// Singleton instance
let instance: DeviceCodeService | null = null;

export function getDeviceCodeService(): DeviceCodeService {
    if (!instance) {
        instance = new DeviceCodeService();
    }
    return instance;
}
