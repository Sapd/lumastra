// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({ bandwidthTracker: { trackImage: vi.fn() } }));
const fetchImage = vi.fn();
vi.mock('$lib/server/services/image-proxy/index.js', async () => ({
    ...(await import('$lib/server/services/image-proxy/response.js')),
    PersonRateLimitError: class extends Error {},
    getImageProxyService: () => ({ getImageByCatalogId: fetchImage, getPersonImage: fetchImage, getUserAvatar: fetchImage }),
}));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => null }));
vi.mock('$lib/server/utils/provider-config.js', () => ({ getPrimaryExternalIdProvider: () => 'tmdb' }));
const { def } = await import('./[role].js');
const { def: indexed } = await import('./[role]/[index].js');
const id = '11111111-1111-4111-8111-111111111111';
function event(query: string, role: string, entityId = id): RequestEvent {
    const request = new Request(`http://localhost/image?${query}`);
    return { request, url: new URL(request.url), params: { id: entityId, role, index: '0' }, locals: {} } as unknown as RequestEvent;
}
beforeEach(() => {
    fetchImage.mockReset().mockResolvedValue({ buffer: Buffer.from('image'), contentType: 'image/webp', cacheControl: 'public, max-age=2592000' });
});

describe.each([['role', def], ['index 0', indexed]])('avatar %s', (_, endpoint) => {
    it.each([['size=card', false], ['size=card&v=r', true], ['size=card&v=r&exact=true', false]])('cache policy %s', async (query, immutable) => {
        const res = await endpoint.handlers.GET!(event(query, 'avatar'), {} as never);
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe(immutable
            ? 'private, max-age=2592000, stale-while-revalidate=86400, immutable'
            : 'private, max-age=300, stale-while-revalidate=86400');
    });
});
