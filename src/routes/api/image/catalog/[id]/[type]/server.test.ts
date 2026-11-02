// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/image/catalog/[id]/[type] — access gate for legacy Jellyfin ids.
 *
 * The image service serves a 32-hex Jellyfin id as the item it maps to through
 * external_ids. The raw id is not a media_items row, and the library check
 * passes an unknown id, so the route must also gate the mapped item.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from './$types.js';

const mockCheckMediaAccess = vi.fn();
const mockLookupLegacy = vi.fn();
const mockGetImageByCatalogId = vi.fn();
const mockGetImageByCompositeKey = vi.fn();
const mockGetTmdbImage = vi.fn();
const mockResolveByProvider = vi.fn();
const fakeSql = {};

vi.mock('$lib/server/middleware/error-handler', () => ({
    withErrorHandler: (handler: unknown) => handler,
}));
vi.mock('$lib/server/middleware/valkey-rate-limit', () => ({
    withImageProxyRateLimit: (handler: unknown) => handler,
}));
vi.mock('$lib/server/cache/library-group-permissions-cache.js', async (original) => ({
    ...(await original<typeof import('$lib/server/cache/library-group-permissions-cache.js')>()),
    getDeniedLibraryGroups: async () => null,
}));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => fakeSql }));
vi.mock('$lib/server/database/queries/resolvers/media-id.resolver.js', () => ({
    resolveMediaIdByProvider: mockResolveByProvider,
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: mockCheckMediaAccess,
}));
vi.mock('$lib/server/services/image-proxy', () => ({
    getImageProxyService: () => ({
        getImageByCatalogId: mockGetImageByCatalogId,
        getImageByCompositeKey: mockGetImageByCompositeKey,
        getTmdbImage: mockGetTmdbImage,
        cachedResolveMediaIdByProvider: mockResolveByProvider,
    }),
    imageResponse: () => new Response('img', { status: 200 }),
    lookupLegacyJellyfinImageMediaId: mockLookupLegacy,
}));

const LEGACY_ID = '0123456789abcdef0123456789abcdef';
const MAPPED_ID = '11111111-2222-3333-4444-555555555555';

function event(id: string): RequestEvent {
    const url = new URL(`http://localhost/api/image/catalog/${id}/poster`);
    return {
        params: { id, type: 'poster' },
        url,
        request: new Request(url),
        locals: { user: { username: 'kid', ownerIsAdmin: false, userGroups: [] } },
    } as unknown as RequestEvent;
}

describe('catalog image route: legacy Jellyfin id gate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetImageByCatalogId.mockResolvedValue({ buffer: Buffer.from('x') });
        mockGetImageByCompositeKey.mockResolvedValue({ buffer: Buffer.from('x') });
        mockGetTmdbImage.mockResolvedValue({ buffer: Buffer.from('x') });
        mockResolveByProvider.mockResolvedValue(MAPPED_ID);
        mockLookupLegacy.mockImplementation(async (_sql: unknown, id: string) =>
            id === LEGACY_ID ? MAPPED_ID : null,
        );
        // The raw id is unknown to media_items (accessible); the mapped item is denied.
        mockCheckMediaAccess.mockImplementation(
            async (_sql: unknown, id: string) => id !== MAPPED_ID,
        );
    });

    it('404s when the item a legacy id maps to is denied, without serving it', async () => {
        const { GET } = await import('./+server.js');
        const res = await GET(event(LEGACY_ID));
        expect(res.status).toBe(404);
        expect(mockCheckMediaAccess).toHaveBeenCalledWith(fakeSql, MAPPED_ID, expect.anything());
        expect(mockGetImageByCatalogId).not.toHaveBeenCalled();
    });

    it('serves an accessible legacy id', async () => {
        mockCheckMediaAccess.mockResolvedValue(true);
        const { GET } = await import('./+server.js');
        const res = await GET(event(LEGACY_ID));
        expect(res.status).toBe(200);
        expect(mockGetImageByCatalogId).toHaveBeenCalledWith(
            LEGACY_ID,
            'poster',
            expect.anything(),
        );
    });

    it('only an admin credential may have an unmapped Jellyfin id fetched from Jellyfin', async () => {
        mockCheckMediaAccess.mockResolvedValue(true);
        const { GET } = await import('./+server.js');
        await GET(event(LEGACY_ID));
        expect(mockGetImageByCatalogId.mock.calls[0][2]).toMatchObject({
            allowUnmappedJellyfinFetch: false,
        });

        const admin = event(LEGACY_ID);
        (admin.locals as unknown as Record<string, unknown>).principal = { isAdmin: true };
        await GET(admin);
        expect(mockGetImageByCatalogId.mock.calls[1][2]).toMatchObject({
            allowUnmappedJellyfinFetch: true,
        });
    });

    it('an internal id is gated once, with no legacy mapping', async () => {
        const { GET } = await import('./+server.js');
        const res = await GET(event(MAPPED_ID));
        expect(res.status).toBe(404);
        expect(mockCheckMediaAccess).toHaveBeenCalledTimes(1);
    });

    it('gates a composite key that resolves to a denied catalog item', async () => {
        const { GET } = await import('./+server.js');
        const res = await GET(event('tmdb:550:movie'));
        expect(res.status).toBe(404);
        expect(mockResolveByProvider).toHaveBeenCalledWith(fakeSql, 'tmdb', '550', 'movie');
        expect(mockGetImageByCompositeKey).not.toHaveBeenCalled();
    });

    it('denies anonymous composite lookup while preserving anonymous UUID artwork', async () => {
        const { GET } = await import('./+server.js');
        const external = event('tmdb:550:movie');
        external.locals = {} as RequestEvent['locals'];
        expect((await GET(external)).status).toBe(401);
        expect(mockResolveByProvider).not.toHaveBeenCalled();
        const internal = event(MAPPED_ID);
        internal.locals = {} as RequestEvent['locals'];
        expect((await GET(internal)).status).toBe(200);
    });

    it('serves a composite key with no catalog item (discovery artwork)', async () => {
        mockResolveByProvider.mockResolvedValue(null);
        const { GET } = await import('./+server.js');
        const res = await GET(event('tmdb:550:movie'));
        expect(res.status).toBe(200);
        expect(mockGetTmdbImage).toHaveBeenCalled();
        expect(mockGetImageByCompositeKey).not.toHaveBeenCalled();
    });
});
