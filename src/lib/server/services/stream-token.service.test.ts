// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for Stream Token Service
 *
 * Tests JWT issue/verify, expiry, tamper, and payload validation.
 */

import { describe, it, expect, vi } from 'vitest';
import { SignJWT } from 'jose';
import {
    generateShowcaseStreamToken,
    verifyShowcaseStreamToken,
    SHOWCASE_TOKEN_TTL_SECONDS,
    type ShowcaseStreamTokenPayload,
} from './stream-token.service.js';

vi.mock('$lib/server/config.js', () => ({
    config: {
        JWT_SECRET: 'test-stream-token-secret-32bytes!!',
    },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        }),
    },
}));

// ─── SHOWCASE_TOKEN_TTL_SECONDS export ──────────────────────────────────────

describe('SHOWCASE_TOKEN_TTL_SECONDS', () => {
    it('is exported and a positive integer (2 hours)', () => {
        expect(typeof SHOWCASE_TOKEN_TTL_SECONDS).toBe('number');
        expect(Number.isInteger(SHOWCASE_TOKEN_TTL_SECONDS)).toBe(true);
        expect(SHOWCASE_TOKEN_TTL_SECONDS).toBe(2 * 60 * 60);
    });

    it('matches the actual JWT expiry (token minted near now + TTL)', async () => {
        const before = Math.floor(Date.now() / 1000);
        const token = await generateShowcaseStreamToken({
            username: '__showcase__',
            session_id: 'ttl-test-sess',
            media_id: 'ttl-test-media',
        });
        const after = Math.floor(Date.now() / 1000);

        // Decode the JWT payload (base64url middle segment) to check exp claim.
        const [, payloadB64] = token.split('.');
        const decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
            exp: number;
            iat: number;
        };

        // exp should be approximately iat + SHOWCASE_TOKEN_TTL_SECONDS
        expect(decoded.exp - decoded.iat).toBe(SHOWCASE_TOKEN_TTL_SECONDS);

        // exp should be within [before + TTL, after + TTL + 1] (clock skew tolerance)
        expect(decoded.exp).toBeGreaterThanOrEqual(before + SHOWCASE_TOKEN_TTL_SECONDS);
        expect(decoded.exp).toBeLessThanOrEqual(after + SHOWCASE_TOKEN_TTL_SECONDS + 1);
    });
});

// ─── Showcase stream tokens ─────────────────────────────────────────────────

const showcasePayload: ShowcaseStreamTokenPayload = {
    username: '__showcase__',
    session_id: 'showcase-sess-abc-123',
    media_id: 'product-media-uuid-789',
};

describe('generateShowcaseStreamToken', () => {
    it('generates a non-empty token string', async () => {
        const token = await generateShowcaseStreamToken(showcasePayload);
        expect(typeof token).toBe('string');
        expect(token.length).toBeGreaterThan(0);
        expect(token.split('.')).toHaveLength(3);
    });
});

describe('verifyShowcaseStreamToken', () => {
    it('verifies a valid showcase token', async () => {
        const token = await generateShowcaseStreamToken(showcasePayload);
        const result = await verifyShowcaseStreamToken(token);
        expect(result).not.toBeNull();
        expect(result?.username).toBe('__showcase__');
        expect(result?.media_id).toBe(showcasePayload.media_id);
    });

    it('returns null for a tampered showcase token', async () => {
        const token = await generateShowcaseStreamToken(showcasePayload);
        const result = await verifyShowcaseStreamToken(token.slice(0, -5) + 'xxxxx');
        expect(result).toBeNull();
    });

    it('regular stream token is REJECTED by verifyShowcaseStreamToken (type isolation)', async () => {
        // A regular stream token must NEVER verify as a showcase token.
        const token = await new SignJWT({
            token_type: 'stream',
            username: 'denis',
            session_id: 'legacy',
            media_id: 'legacy',
        })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuer('Lumastra')
            .setExpirationTime('1h')
            .sign(new TextEncoder().encode('test-stream-token-secret-32bytes!!'));
        const result = await verifyShowcaseStreamToken(token);
        expect(result).toBeNull();
    });
});
