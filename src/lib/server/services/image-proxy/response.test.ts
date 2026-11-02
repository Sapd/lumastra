// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({
    bandwidthTracker: { trackImage: vi.fn() },
}));

import { imageResponse } from './response';

describe('imageResponse', () => {
    it('sets Vary: Accept, Save-Data so caches partition by both headers', () => {
        // Without this header, a CDN can serve an AVIF response to a non-AVIF
        // client (or a Save-Data downgrade to a non-saver client) and break
        // image rendering. Critical regression to pin.
        const res = imageResponse({
            buffer: Buffer.from('hello'),
            contentType: 'image/webp',
            cacheControl: 'public, max-age=3600',
        });
        expect(res.headers.get('vary')).toBe('Accept, Save-Data');
    });

    it('appends stale-while-revalidate when missing', () => {
        const res = imageResponse({
            buffer: Buffer.from('hello'),
            contentType: 'image/webp',
            cacheControl: 'public, max-age=3600',
        });
        expect(res.headers.get('cache-control')).toBe(
            'public, max-age=3600, stale-while-revalidate=86400',
        );
    });

    it('normalizes mutable cacheControl even when SWR already present', () => {
        const res = imageResponse({
            buffer: Buffer.from('hello'),
            contentType: 'image/webp',
            cacheControl: 'public, max-age=3600, stale-while-revalidate=600',
        });
        expect(res.headers.get('cache-control')).toBe(
            'public, max-age=3600, stale-while-revalidate=86400',
        );
    });

    it('uses provided ETag when set', () => {
        const res = imageResponse({
            buffer: Buffer.from('hello'),
            contentType: 'image/webp',
            cacheControl: 'public, max-age=3600',
            etag: 'W/"custom-etag"',
        });
        expect(res.headers.get('etag')).toBe('W/"custom-etag"');
    });

    it('generates an ETag when not provided', () => {
        const res = imageResponse({
            buffer: Buffer.from('hello'),
            contentType: 'image/webp',
            cacheControl: 'public, max-age=3600',
        });
        expect(res.headers.get('etag')).toMatch(/^W\/".+"$/);
    });

    it('includes X-Cache when cacheStatus present', () => {
        const res = imageResponse({
            buffer: Buffer.from('hello'),
            contentType: 'image/webp',
            cacheControl: 'public, max-age=3600',
            cacheStatus: 'HIT',
        });
        expect(res.headers.get('x-cache')).toBe('HIT');
    });

    it('omits X-Cache when cacheStatus absent', () => {
        const res = imageResponse({
            buffer: Buffer.from('hello'),
            contentType: 'image/webp',
            cacheControl: 'public, max-age=3600',
        });
        expect(res.headers.has('x-cache')).toBe(false);
    });

    it('adds immutable for bounded preset variants (keeps stale-while-revalidate)', () => {
        const res = imageResponse(
            {
                buffer: Buffer.from('hello'),
                contentType: 'image/webp',
                cacheControl: 'public, max-age=3600',
            },
            undefined,
            { hasRevision: true, bounded: true },
        );
        expect(res.headers.get('cache-control')).toBe(
            'public, max-age=3600, stale-while-revalidate=86400, immutable',
        );
    });

    it('does NOT add immutable for custom/exact variants', () => {
        const res = imageResponse(
            {
                buffer: Buffer.from('hello'),
                contentType: 'image/webp',
                cacheControl: 'public, max-age=3600',
            },
            undefined,
            { hasRevision: true, bounded: false },
        );
        expect(res.headers.get('cache-control')).not.toContain('immutable');
    });

    it('does not double-append immutable', () => {
        const res = imageResponse(
            {
                buffer: Buffer.from('hello'),
                contentType: 'image/webp',
                cacheControl: 'public, max-age=3600, immutable',
            },
            undefined,
            { hasRevision: true, bounded: true },
        );
        const cc = res.headers.get('cache-control') ?? '';
        expect(cc.match(/immutable/g)?.length).toBe(1);
    });
});


describe('revision cache policy', () => {
    it.each([false, true])('never trusts a source immutable directive without v (bounded=%s)', (bounded) => {
        const res = imageResponse({ buffer: Buffer.from('x'), contentType: 'image/webp',
            cacheControl: 'public, max-age=172800, immutable' }, undefined, { bounded });
        expect(res.headers.get('cache-control')).toBe('public, max-age=3600, stale-while-revalidate=86400');
    });
    it.each(['', '0', '1'])('v=%j is not a revision: never immutable', (v) => {
        const res = imageResponse({ buffer: Buffer.from('x'), contentType: 'image/webp',
            cacheControl: 'public, max-age=86400' }, new Request(`http://localhost/i?size=card&v=${v}`), { bounded: true });
        expect(res.headers.get('cache-control')).toBe('public, max-age=3600, stale-while-revalidate=86400');
    });
    it('a source with a short max-age is not stretched to an hour when unrevisioned', () => {
        const res = imageResponse({ buffer: Buffer.from('x'), contentType: 'image/webp',
            cacheControl: 'public, max-age=60' });
        expect(res.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=86400');
    });
    it('keepCacheControl serves the result Cache-Control as is (content-addressed /j tags)', () => {
        const res = imageResponse({ buffer: Buffer.from('x'), contentType: 'image/webp',
            cacheControl: 'public, max-age=31536000, immutable' }, undefined, { keepCacheControl: true });
        expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable, stale-while-revalidate=86400');
    });
    it('keeps private cache metadata on conditional requests', () => {
        const result = { buffer: Buffer.from('x'), contentType: 'image/webp', etag: '"x"', cacheControl: 'public, max-age=86400' };
        const request = new Request('http://localhost/image?size=card&v=abc123', { headers: { 'If-None-Match': '"x"' } });
        const res = imageResponse(result, request, { scope: 'private', bounded: true });
        expect(res.status).toBe(304);
        expect(res.headers.get('cache-control')).toBe('private, max-age=86400, stale-while-revalidate=86400, immutable');
        expect(res.headers.get('vary')).toBe('Accept, Save-Data, Authorization, Cookie');
    });
});
