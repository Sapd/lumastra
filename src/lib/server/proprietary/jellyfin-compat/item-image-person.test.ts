// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// Person headshots on the public /j/Items/{id}/Images route: only a signed tag
// unlocks one, and the route never looks a person up (anti-oracle).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const { mockGetPersonImage, mockGetImageByCatalogId, mockGetDb } = vi.hoisted(() => ({
    mockGetPersonImage: vi.fn(),
    mockGetImageByCatalogId: vi.fn(),
    mockGetDb: vi.fn(() => null),
}));

vi.mock('$lib/server/config', () => ({ config: { JWT_SECRET: 'test-jwt-secret' } }));
vi.mock('$lib/server/services/image-proxy', () => ({
    getImageProxyService: () => ({
        getPersonImage: mockGetPersonImage,
        getImageByCatalogId: mockGetImageByCatalogId,
    }),
    imageResponse: (r: { tag: string; cacheControl: string }) =>
        new Response(r.tag, { headers: { 'Cache-Control': r.cacheControl } }),
}));
vi.mock('$lib/server/utils/placeholder-image.js', () => ({
    noImageResponse: async () =>
        new Response('placeholder', { headers: { 'X-Lumastra-Placeholder': 'default' } }),
}));
vi.mock('$lib/server/database', () => ({ getDb: mockGetDb }));
vi.mock('$lib/server/database/queries/jellyfin-people.queries', () => ({}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { handleItemImage } from './item-image-handler';
import { personImageTag } from './people-studios';

const PERSON = '7d77590c-beb3-3d09-2b32-c0d51e5e359e';

function get(itemId: string, query: string): Promise<Response> {
    const url = new URL(`https://example.test/j/Items/${itemId}/Images/Primary${query}`);
    return handleItemImage({
        params: { itemId, imageType: 'Primary' },
        url,
        request: new Request(url),
        locals: {},
    } as unknown as RequestEvent);
}

describe('/j/Items/{personId}/Images/Primary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetPersonImage.mockResolvedValue({ tag: 'headshot', cacheControl: 'x' });
        mockGetImageByCatalogId.mockResolvedValue(null);
    });

    it('a signed tag serves the TMDB headshot, sized by the request', async () => {
        const tag = personImageTag(PERSON, 101)!;
        const res = await get(PERSON, `?tag=${tag}&maxHeight=600`);
        expect(await res.text()).toBe('headshot');
        expect(res.headers.get('Cache-Control')).toContain('immutable');
        expect(mockGetPersonImage).toHaveBeenCalledWith(
            '101',
            expect.objectContaining({ rawSize: 'h632' }),
        );

        await get(PERSON, `?tag=${tag}&fillWidth=120`);
        expect(mockGetPersonImage).toHaveBeenLastCalledWith(
            '101',
            expect.objectContaining({ rawSize: 'w185' }),
        );
    });

    it('no tag, a tag for another id, or a forged id: the placeholder, no TMDB call', async () => {
        const tag = personImageTag('0d0f9b5e-2f0e-4a59-9a3e-5d0c2b3e1a11', 101)!;
        for (const q of ['', `?tag=${tag}`, `?tag=${'0'.repeat(40)}`]) {
            const res = await get(PERSON, q);
            expect(res.headers.get('X-Lumastra-Placeholder')).toBe('default');
        }
        expect(mockGetPersonImage).not.toHaveBeenCalled();
    });

    it('a headshot TMDB does not have: the placeholder', async () => {
        mockGetPersonImage.mockResolvedValue(null);
        const res = await get(PERSON, `?tag=${personImageTag(PERSON, 101)}`);
        expect(res.headers.get('X-Lumastra-Placeholder')).toBe('default');
        mockGetPersonImage.mockRejectedValue(new Error('rate limited'));
        const res2 = await get(PERSON, `?tag=${personImageTag(PERSON, 101)}`);
        expect(res2.headers.get('X-Lumastra-Placeholder')).toBe('default');
    });
});
