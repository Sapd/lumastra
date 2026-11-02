// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for Signed URL Utility
 *
 * Tests HMAC signing, tamper detection, expiry, and purpose validation.
 */

import { describe, it, expect, vi } from 'vitest';
import { signUrl, verifySignedUrl } from './signed-url';

// Mock server config to provide a stable JWT_SECRET for tests
vi.mock('$lib/server/config', () => ({
    config: {
        JWT_SECRET: 'test-secret-for-signed-urls-only',
    },
}));

describe('signUrl', () => {
    it('generates a URL with expires, purpose, and sig params', () => {
        const signed = signUrl('/api/stream/123', {
            expiresIn: 3600,
            purpose: 'playback',
        });

        expect(signed).toContain('/api/stream/123?');
        expect(signed).toContain('expires=');
        expect(signed).toContain('purpose=playback');
        expect(signed).toContain('sig=');
    });

    it('produces different signatures for different purposes', () => {
        const signedA = signUrl('/api/stream/123', {
            expiresIn: 3600,
            purpose: 'playback',
        });
        const signedB = signUrl('/api/stream/123', {
            expiresIn: 3600,
            purpose: 'download',
        });

        expect(signedA).not.toBe(signedB);
    });

    it('throws if path contains query params', () => {
        expect(() =>
            signUrl('/api/stream/123?foo=bar', {
                expiresIn: 3600,
                purpose: 'playback',
            }),
        ).toThrow('path must not contain query params');
    });
});

describe('verifySignedUrl', () => {
    const base = 'http://localhost';

    it('accepts a valid signed URL', () => {
        const signed = signUrl('/api/stream/123', {
            expiresIn: 3600,
            purpose: 'playback',
        });

        const result = verifySignedUrl(new URL(signed, base), 'playback');
        expect(result.valid).toBe(true);
    });

    it('rejects tampered signature', () => {
        const signed = signUrl('/api/stream/123', {
            expiresIn: 3600,
            purpose: 'playback',
        });

        // Tamper with the signature
        const tampered = signed.replace(/sig=[a-f0-9]+/, 'sig=aaaaaaaa');
        const result = verifySignedUrl(new URL(tampered, base), 'playback');
        expect(result.valid).toBe(false);
        if (result.valid) throw new Error('expected failure result');
        expect(result.reason).toBe('invalid_signature');
    });

    it('rejects tampered path', () => {
        const signed = signUrl('/api/stream/123', {
            expiresIn: 3600,
            purpose: 'playback',
        });

        // Tamper with the path portion
        const tampered = signed.replace('/api/stream/123', '/api/stream/999');
        const result = verifySignedUrl(new URL(tampered, base), 'playback');
        expect(result.valid).toBe(false);
        if (result.valid) throw new Error('expected failure result');
        expect(result.reason).toBe('invalid_signature');
    });

    it('rejects expired URL', () => {
        const signed = signUrl('/api/stream/123', {
            expiresIn: -1, // Already expired
            purpose: 'playback',
        });

        const result = verifySignedUrl(new URL(signed, base), 'playback');
        expect(result.valid).toBe(false);
        if (result.valid) throw new Error('expected failure result');
        expect(result.reason).toBe('expired');
    });

    it('rejects wrong purpose', () => {
        const signed = signUrl('/api/stream/123', {
            expiresIn: 3600,
            purpose: 'playback',
        });

        const result = verifySignedUrl(new URL(signed, base), 'download');
        expect(result.valid).toBe(false);
        if (result.valid) throw new Error('expected failure result');
        expect(result.reason).toBe('purpose_mismatch');
    });

    it('rejects missing params', () => {
        const result = verifySignedUrl(new URL('http://example.com/api/stream/123'), 'playback');
        expect(result.valid).toBe(false);
        if (result.valid) throw new Error('expected failure result');
        expect(result.reason).toBe('missing_params');
    });

    it('rejects URL with only some params', () => {
        const result = verifySignedUrl(
            new URL('http://example.com/api/stream/123?expires=9999999999'),
            'playback',
        );
        expect(result.valid).toBe(false);
        if (result.valid) throw new Error('expected failure result');
        expect(result.reason).toBe('missing_params');
    });

    it('rejects malformed expires (NaN)', () => {
        const signed =
            'http://example.com/api/stream/123?expires=notanumber&purpose=playback&sig=abc123';
        const result = verifySignedUrl(new URL(signed), 'playback');
        expect(result.valid).toBe(false);
        if (result.valid) throw new Error('expected failure result');
        expect(result.reason).toBe('expired');
    });

    it('accepts URL with encoded purpose', () => {
        const signed = signUrl('/api/stream/123', {
            expiresIn: 3600,
            purpose: 'my purpose',
        });

        const result = verifySignedUrl(new URL(signed, base), 'my purpose');
        expect(result.valid).toBe(true);
    });

    // M16 audit: the HMAC canonical string is `${pathname}:${expires}:${purpose}` —
    // it does NOT cover extra query params. A signature is safe to reuse across
    // query-param variations ONLY because the media-image route (the sole `?sig=`
    // consumer) keeps the identity-bearing values (media id, image role, index) in
    // the PATH, not the query string — so "rejects tampered path" above already
    // proves a signature can't be replayed against a different id/role/index. This
    // test documents that query-only params (e.g. a resize/format param) are
    // correctly NOT part of what's signed, so callers must never rely on `?sig=`
    // to authorize a MORE-restricted asset via a query param alone.
    it('does not cover extra/rewritten query params (only pathname+expires+purpose are signed)', () => {
        const signed = signUrl('/api/v1/media/abc-123/images/poster', {
            expiresIn: 3600,
            purpose: 'image',
        });

        const withExtraQuery = new URL(signed, base);
        withExtraQuery.searchParams.set('size', 'full');
        withExtraQuery.searchParams.set('format', 'avif');

        const result = verifySignedUrl(withExtraQuery, 'image');
        expect(result.valid).toBe(true);
    });

    it('rejects the signature when reused for a DIFFERENT media id in the path', () => {
        const signed = signUrl('/api/v1/media/abc-123/images/poster', {
            expiresIn: 3600,
            purpose: 'image',
        });

        const differentId = new URL(signed.replace('abc-123', 'other-user-item'), base);
        const result = verifySignedUrl(differentId, 'image');
        expect(result.valid).toBe(false);
        if (result.valid) throw new Error('expected failure result');
        expect(result.reason).toBe('invalid_signature');
    });

    it('rejects the signature when reused for a DIFFERENT image role in the path', () => {
        const signed = signUrl('/api/v1/media/abc-123/images/poster', {
            expiresIn: 3600,
            purpose: 'image',
        });

        const differentRole = new URL(signed.replace('/images/poster', '/images/backdrop'), base);
        const result = verifySignedUrl(differentRole, 'image');
        expect(result.valid).toBe(false);
        if (result.valid) throw new Error('expected failure result');
        expect(result.reason).toBe('invalid_signature');
    });

    // Top Shelf preview/cinemagraph MP4s (§9.1) — new purpose 'topshelf-preview'.
    describe("'topshelf-preview' purpose (tvOS Top Shelf mint/serve)", () => {
        const itemPath = '/api/v1/media/item-a/topshelf-preview/file/preview.mp4';

        it('mint→verify round-trips successfully', () => {
            const signed = signUrl(itemPath, { expiresIn: 172800, purpose: 'topshelf-preview' });
            const result = verifySignedUrl(new URL(signed, base), 'topshelf-preview');
            expect(result.valid).toBe(true);
        });

        it('an expired topshelf-preview signature is rejected with reason=expired', () => {
            const signed = signUrl(itemPath, { expiresIn: -1, purpose: 'topshelf-preview' });
            const result = verifySignedUrl(new URL(signed, base), 'topshelf-preview');
            expect(result.valid).toBe(false);
            if (result.valid) throw new Error('expected failure result');
            expect(result.reason).toBe('expired');
        });

        it('a purpose:"image" signature fails verification on the topshelf-preview path', () => {
            const signed = signUrl(itemPath, { expiresIn: 3600, purpose: 'image' });
            const result = verifySignedUrl(new URL(signed, base), 'topshelf-preview');
            expect(result.valid).toBe(false);
            if (result.valid) throw new Error('expected failure result');
            expect(result.reason).toBe('purpose_mismatch');
        });

        it('a topshelf-preview signature does not verify against the image purpose either', () => {
            const signed = signUrl(itemPath, { expiresIn: 3600, purpose: 'topshelf-preview' });
            const result = verifySignedUrl(new URL(signed, base), 'image');
            expect(result.valid).toBe(false);
            if (result.valid) throw new Error('expected failure result');
            expect(result.reason).toBe('purpose_mismatch');
        });

        it("a signature minted for item A fails when replayed against item B's path", () => {
            const signed = signUrl(itemPath, { expiresIn: 3600, purpose: 'topshelf-preview' });
            const otherItem = new URL(signed.replace('item-a', 'item-b'), base);
            const result = verifySignedUrl(otherItem, 'topshelf-preview');
            expect(result.valid).toBe(false);
            if (result.valid) throw new Error('expected failure result');
            expect(result.reason).toBe('invalid_signature');
        });

        it('swapping preview↔cinemagraph in the path invalidates the signature', () => {
            const signed = signUrl(itemPath, { expiresIn: 3600, purpose: 'topshelf-preview' });
            const swapped = new URL(signed.replace('/preview.mp4', '/cinemagraph.mp4'), base);
            const result = verifySignedUrl(swapped, 'topshelf-preview');
            expect(result.valid).toBe(false);
            if (result.valid) throw new Error('expected failure result');
            expect(result.reason).toBe('invalid_signature');
        });
    });
});
