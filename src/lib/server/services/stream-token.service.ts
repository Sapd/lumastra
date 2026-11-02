// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/server/services/stream-token.service.ts
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';
import { Logger } from '../utils/logger.js';

const logger = Logger.for('StreamToken');

function getSecret(): Uint8Array {
    const secret = config.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET not configured');
    return new TextEncoder().encode(secret);
}

// ─────────────────── Showcase stream tokens ────────────────────────────────
// A distinct token_type so showcase tokens can NEVER be replayed against the
// authenticated stream path (and vice-versa). The caller must additionally
// verify group-membership at segment-serve time (this token proves the media_id
// was requested while FEATURE_PUBLIC_SHOWCASE was on, not that the group still
// allows it at replay time).

// Showcase tokens are short-lived: 2 hours (product demos are short).
// Exported so callers (e.g. the stream-token endpoint) can compute expiresAt
// from the same constant, preventing silent drift if the TTL changes.
export const SHOWCASE_TOKEN_TTL_SECONDS = 2 * 60 * 60;

export interface ShowcaseStreamTokenPayload {
    /** Synthetic principal — always '__showcase__' for anonymous viewers. */
    username: string;
    session_id: string;
    media_id: string;
}

/**
 * Mint a showcase-scoped stream token for an anonymous viewer.
 * Uses `token_type: 'showcase'` so it can never be verified as a regular stream
 * token (a distinct token_type prevents cross-path replay).
 */
export async function generateShowcaseStreamToken(
    payload: ShowcaseStreamTokenPayload,
): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
        username: payload.username,
        session_id: payload.session_id,
        media_id: payload.media_id,
        token_type: 'showcase',
    })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuedAt(now)
        .setExpirationTime(now + SHOWCASE_TOKEN_TTL_SECONDS)
        .setIssuer('Lumastra')
        .sign(getSecret());
}

/**
 * Verify a showcase-scoped stream token.
 * Returns null (not throws) on any failure.
 * The caller MUST additionally check group-membership at segment-serve time.
 */
export async function verifyShowcaseStreamToken(
    token: string,
): Promise<ShowcaseStreamTokenPayload | null> {
    try {
        const { payload } = await jwtVerify(token, getSecret(), {
            issuer: 'Lumastra',
        });
        if (
            payload.token_type !== 'showcase' ||
            typeof payload.username !== 'string' ||
            typeof payload.session_id !== 'string' ||
            typeof payload.media_id !== 'string'
        ) {
            return null;
        }
        return {
            username: payload.username,
            session_id: payload.session_id,
            media_id: payload.media_id,
        };
    } catch (error) {
        logger.debug('Showcase stream token verification failed', { error });
        return null;
    }
}
