// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// JWT Token Service for OAuth 2.0 Device Authorization Grant
// Uses the jose library for JWT operations

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { config } from '../config';
import { Logger } from '../utils/logger';

const logger = Logger.for('OAuth:JWT');

// JWT payload structure for access tokens
export interface AccessTokenPayload extends JWTPayload {
    username: string;
    client_id: string;
    scope?: string;
    groups: string[];
    /** Unique session ID for this device - persists across token refreshes */
    device_session_id?: string;
    token_type: 'access';
}

// JWT payload structure for validation
export interface ValidatedTokenPayload {
    username: string;
    clientId: string;
    scope?: string;
    groups: string[];
    /** Unique session ID for this device - used as Jellyfin deviceId */
    deviceSessionId?: string;
    issuedAt: number;
    expiresAt: number;
}

// Get the JWT secret as Uint8Array for jose
function getSecretKey(): Uint8Array {
    if (!config.JWT_SECRET) {
        throw new Error('JWT_SECRET is not configured');
    }
    return new TextEncoder().encode(config.JWT_SECRET);
}

/**
 * Generate a new access token
 */
export async function generateAccessToken(payload: {
    username: string;
    clientId: string;
    scope?: string;
    groups: string[];
    /** Unique device session ID - used for Jellyfin playback device identification */
    deviceSessionId?: string;
}): Promise<string> {
    const secret = getSecretKey();
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = config.JWT_ACCESS_TOKEN_TTL_SECONDS;

    const token = await new SignJWT({
        username: payload.username,
        client_id: payload.clientId,
        scope: payload.scope,
        groups: payload.groups,
        device_session_id: payload.deviceSessionId,
        token_type: 'access',
    } as AccessTokenPayload)
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuedAt(now)
        .setExpirationTime(now + expiresIn)
        .setIssuer('Lumastra')
        .sign(secret);

    logger.debug('Generated access token', {
        username: payload.username,
        clientId: payload.clientId,
        deviceSessionId: payload.deviceSessionId?.substring(0, 8) + '...',
        expiresIn,
    });

    return token;
}

/**
 * Verify and decode an access token
 * Returns null if the token is invalid or expired
 */
export async function verifyAccessToken(token: string): Promise<ValidatedTokenPayload | null> {
    try {
        const secret = getSecretKey();
        const { payload } = await jwtVerify(token, secret, {
            issuer: 'Lumastra',
        });

        // Validate required fields
        const typedPayload = payload as AccessTokenPayload;
        if (
            !typedPayload.username ||
            !typedPayload.client_id ||
            typedPayload.token_type !== 'access'
        ) {
            logger.warn('Invalid token payload structure');
            return null;
        }

        return {
            username: typedPayload.username,
            clientId: typedPayload.client_id,
            scope: typedPayload.scope,
            groups: typedPayload.groups || [],
            deviceSessionId: typedPayload.device_session_id,
            issuedAt: typedPayload.iat || 0,
            expiresAt: typedPayload.exp || 0,
        };
    } catch (error) {
        // Token verification failed (invalid signature, expired, etc.)
        if (error instanceof Error) {
            logger.debug('Token verification failed', { error: error.message });
        }
        return null;
    }
}

/**
 * Extract token from Authorization header
 * Returns null if header is missing or malformed
 */
export function extractBearerToken(authHeader: string | null): string | null {
    if (!authHeader) {
        return null;
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
        return null;
    }

    return parts[1];
}

/**
 * Check if device auth is properly configured
 */
export function isDeviceAuthEnabled(): boolean {
    return config.FEATURE_DEVICE_AUTH && !!config.JWT_SECRET;
}
