// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for signed URL utility
 */

import { describe, it, expect, vi } from 'vitest';

// Mock config before importing the module
vi.mock('$lib/server/config', () => ({
    config: {
        JWT_SECRET: 'test-secret-key-for-unit-tests',
    },
}));

import { signUrl, verifySignedUrl } from '../signed-url';

describe('signUrl', () => {
    it('generates a URL with expires, purpose, and sig params', () => {
        const result = signUrl('/api/v1/media/abc/images/poster', {
            expiresIn: 600,
            purpose: 'image',
        });

        expect(result).toContain('/api/v1/media/abc/images/poster?');
        expect(result).toContain('expires=');
        expect(result).toContain('purpose=image');
        expect(result).toContain('sig=');
    });

    it('throws if path contains query params', () => {
        expect(() =>
            signUrl('/path?existing=param', {
                expiresIn: 600,
                purpose: 'image',
            }),
        ).toThrow('path must not contain query params');
    });

    it('sets expiry to current time + expiresIn seconds', () => {
        const now = Math.floor(Date.now() / 1000);
        const result = signUrl('/path', { expiresIn: 300, purpose: 'test' });
        const url = new URL(result, 'http://localhost');
        const expires = parseInt(url.searchParams.get('expires')!, 10);

        // Allow 2 second tolerance
        expect(expires).toBeGreaterThanOrEqual(now + 298);
        expect(expires).toBeLessThanOrEqual(now + 302);
    });
});

describe('verifySignedUrl', () => {
    it('returns valid for a correctly signed URL', () => {
        const signed = signUrl('/api/image/test', {
            expiresIn: 600,
            purpose: 'image',
        });
        const url = new URL(signed, 'http://localhost');
        const result = verifySignedUrl(url, 'image');
        expect(result).toEqual({ valid: true });
    });

    it('returns missing_params when sig is absent', () => {
        const url = new URL('http://localhost/path?expires=999999999&purpose=image');
        const result = verifySignedUrl(url, 'image');
        expect(result).toEqual({ valid: false, reason: 'missing_params' });
    });

    it('returns missing_params when expires is absent', () => {
        const url = new URL('http://localhost/path?purpose=image&sig=abc');
        const result = verifySignedUrl(url, 'image');
        expect(result).toEqual({ valid: false, reason: 'missing_params' });
    });

    it('returns expired for a past expiry', () => {
        const url = new URL('http://localhost/path?expires=1000000000&purpose=image&sig=abc');
        const result = verifySignedUrl(url, 'image');
        expect(result).toEqual({ valid: false, reason: 'expired' });
    });

    it('returns expired for non-numeric expires value', () => {
        const url = new URL('http://localhost/path?expires=notanumber&purpose=image&sig=abc');
        const result = verifySignedUrl(url, 'image');
        expect(result).toEqual({ valid: false, reason: 'expired' });
    });

    it('returns purpose_mismatch for wrong purpose', () => {
        const signed = signUrl('/api/test', {
            expiresIn: 600,
            purpose: 'image',
        });
        const url = new URL(signed, 'http://localhost');
        const result = verifySignedUrl(url, 'api-access');
        expect(result).toEqual({ valid: false, reason: 'purpose_mismatch' });
    });

    it('returns invalid_signature for tampered URL', () => {
        const signed = signUrl('/api/test', {
            expiresIn: 600,
            purpose: 'image',
        });
        // Tamper with the path
        const tampered = signed.replace('/api/test', '/api/hacked');
        const url = new URL(tampered, 'http://localhost');
        const result = verifySignedUrl(url, 'image');
        expect(result).toEqual({ valid: false, reason: 'invalid_signature' });
    });

    it('returns invalid_signature for tampered sig', () => {
        const signed = signUrl('/api/test', {
            expiresIn: 600,
            purpose: 'image',
        });
        const url = new URL(signed, 'http://localhost');
        url.searchParams.set('sig', 'tampered-signature');
        const result = verifySignedUrl(url, 'image');
        expect(result).toEqual({ valid: false, reason: 'invalid_signature' });
    });

    it('purpose-scoping prevents cross-feature reuse', () => {
        const signed = signUrl('/api/image/123', {
            expiresIn: 600,
            purpose: 'image',
        });
        const url = new URL(signed, 'http://localhost');

        // Correct purpose works
        expect(verifySignedUrl(url, 'image')).toEqual({ valid: true });

        // Different purpose fails
        expect(verifySignedUrl(url, 'download')).toEqual({
            valid: false,
            reason: 'purpose_mismatch',
        });
    });
});

describe('roundtrip with different paths', () => {
    it('works with nested paths', () => {
        const signed = signUrl('/api/v1/media/uuid-123/images/poster', {
            expiresIn: 600,
            purpose: 'image',
        });
        const url = new URL(signed, 'http://localhost');
        expect(verifySignedUrl(url, 'image')).toEqual({ valid: true });
    });

    it('works with user avatar paths', () => {
        const signed = signUrl('/api/v1/users/user-456/images/avatar', {
            expiresIn: 600,
            purpose: 'image',
        });
        const url = new URL(signed, 'http://localhost');
        expect(verifySignedUrl(url, 'image')).toEqual({ valid: true });
    });
});
