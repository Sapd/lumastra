// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({
    bandwidthTracker: { trackImage: vi.fn() },
}));
const fetchImage = vi.fn();
vi.mock('$lib/server/services/image-proxy/index.js', async () => ({
    ...(await import('$lib/server/services/image-proxy/response.js')),
    PersonRateLimitError: class extends Error {},
    getImageProxyService: () => ({
        getImageByCatalogId: fetchImage,
        getPersonImage: fetchImage,
        getUserAvatar: fetchImage,
    }),
}));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/services/image-descriptor/resolver.js', () => ({
    resolveImageSet: vi.fn(async () => ({ poster: { revision: 'r' } })),
}));
vi.mock('$lib/server/utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: () => 'tmdb',
}));
const { def } = await import('./[role].js');
const { def: indexed } = await import('./[role]/[index].js');
const id = '11111111-1111-4111-8111-111111111111';
function event(query: string, role: string, entityId = id): RequestEvent {
    const request = new Request(`http://localhost/image?${query}`);
    return {
        request,
        url: new URL(request.url),
        params: { id: entityId, role, index: '0' },
        locals: {},
    } as unknown as RequestEvent;
}
beforeEach(() => {
    fetchImage.mockReset().mockResolvedValue({
        servedRevision: 'r',
        buffer: Buffer.from('image'),
        contentType: 'image/webp',
        cacheControl: 'public, max-age=2592000',
    });
});

describe.each([
    ['role', def],
    ['index 0', indexed],
])('media %s cache and inheritance', (_, endpoint) => {
    it.each([
        ['size=card', false],
        ['size=card&v=r', true],
        ['size=full&v=r', false],
        ['width=480&v=r', true],
        ['width=777&v=r', false],
        ['width=480&exact=true&v=r', false],
        ['size=card&v=stale', false],
        ['size=card&v=0', false],
    ])('cache policy for %s', async (query, immutable) => {
        const res = await endpoint.handlers.GET!(event(query, 'poster'), {
            surface: 'v1',
        } as never);
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')?.includes('immutable')).toBe(immutable);
        expect(res.headers.get('cache-control')).toMatch(/^public,/);
        expect(res.headers.get('etag')).toBeTruthy();
    });
    it('withholds immutable for fallback bytes with no served selection proof', async () => {
        fetchImage.mockResolvedValue({
            buffer: Buffer.from('fallback image'),
            contentType: 'image/webp',
            cacheControl: 'public, max-age=86400',
        });
        const res = await endpoint.handlers.GET!(event('size=card&v=r', 'poster'), {
            surface: 'v1',
        } as never);
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).not.toContain('immutable');
    });
    it('own-only misses always return 404 without a placeholder', async () => {
        fetchImage.mockResolvedValue(null);
        const res = await endpoint.handlers.GET!(event('inherit=none', 'poster'), {
            surface: 'v1',
        } as never);
        expect(res.status).toBe(404);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(fetchImage).toHaveBeenCalledWith(
            id,
            'poster',
            expect.objectContaining({ inherit: 'none' }),
        );
    });
    it('default requests retain the chain and browser placeholder', async () => {
        fetchImage.mockResolvedValue(null);
        const res = await endpoint.handlers.GET!(event('', 'poster'), { surface: 'v1' } as never);
        expect(fetchImage).toHaveBeenCalledWith(
            id,
            'poster',
            expect.objectContaining({ inherit: undefined }),
        );
        expect(res.headers.get('x-lumastra-placeholder')).toBe('1');
    });
});
