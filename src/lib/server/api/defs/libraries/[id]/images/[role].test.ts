// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeAll } from 'vitest';
import sharp from 'sharp';
import type { RequestEvent } from '@sveltejs/kit';
vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({ bandwidthTracker: { trackImage: vi.fn() } }));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
let buffer: Buffer;
vi.mock('$lib/server/services/library-backdrop.service.js', () => ({
    isLibraryGroup: vi.fn(async () => true),
    getLibraryBackdrop: vi.fn(async () => ({ buffer, contentType: 'image/webp', contentHash: 'mosaic' })),
    getLibraryPlaceholder: vi.fn(),
    getLibraryBackdropHash: vi.fn(async () => 'mosaic'),
}));
const { def } = await import('./[role].js');
const { def: indexed } = await import('./[role]/[index].js');
const { def: listing } = await import('./index.js');
const id = '11111111-1111-4111-8111-111111111111';
function event(query: string, etag?: string): RequestEvent {
    const request = new Request(`http://localhost/image?${query}`, { headers: etag ? { 'If-None-Match': etag } : {} });
    return { request, url: new URL(request.url), params: { id, role: 'backdrop', index: '0' }, locals: { user: { username: 'alice' } } } as unknown as RequestEvent;
}
beforeAll(async () => { buffer = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#abc' } }).webp().toBuffer(); });
describe.each([['role', def], ['index 0', indexed]])('library %s', (_, endpoint) => {
    it.each([['thumb', 256], ['card', 512], ['hd', 1280], ['full', 1600]])('renders %s at width %s with a size ETag', async (size, width) => {
        const res = await endpoint.handlers.GET!(event(`size=${size}&v=r`), {} as never);
        expect(res.status).toBe(200);
        expect((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).width).toBe(width);
        expect(res.headers.get('etag')).toBe(`"mosaic-${size}"`);
        expect(res.headers.get('cache-control')).toBe(size === 'full'
            ? 'private, max-age=3600, stale-while-revalidate=86400'
            : 'private, max-age=86400, stale-while-revalidate=86400, immutable');
        expect(res.headers.get('vary')).toContain('Authorization, Cookie');
    });
    it('returns the same private headers on 304 and never immutable without v', async () => {
        const res = await endpoint.handlers.GET!(event('size=thumb', '"mosaic-thumb"'), {} as never);
        expect(res.status).toBe(304);
        expect(res.headers.get('cache-control')).toBe('private, max-age=3600, stale-while-revalidate=86400');
        expect(res.headers.get('vary')).toContain('Authorization, Cookie');
    });
});
it('advertises exactly the four implemented library sizes', async () => {
    const res = await listing.handlers.GET!(event(''), { surface: 'v1' } as never);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.id).toBe(id);
    expect(Object.keys(body.images).sort()).toEqual(['backdrop', 'primary']);
    for (const [role, entry] of Object.entries(body.images)) {
        expect(entry).toEqual({
            href: `/api/v1/libraries/${id}/images/${role}?size=${role === 'backdrop' ? 'hd' : 'card'}&v=mosaic`,
            revision: 'mosaic',
            source: 'generated',
            provider: 'generated',
            variants: Object.fromEntries(
                ['thumb', 'card', 'hd', 'full'].map((size) => [
                    size,
                    `/api/v1/libraries/${id}/images/${role}?size=${size}&v=mosaic`,
                ]),
            ),
        });
    }
});
