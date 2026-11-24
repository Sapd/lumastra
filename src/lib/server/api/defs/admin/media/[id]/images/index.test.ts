// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import {
    MediaImagesResponseSchema,
    ImageDeleteResponseSchema,
    ImageUploadResponseSchema,
} from '$lib/schemas/media-image-upload';

const { readArtwork, readOwner } = vi.hoisted(() => ({
    readArtwork: vi.fn(),
    readOwner: vi.fn(),
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/config.js', () => ({ config: {} }));
vi.mock('$lib/server/utils/admin-media-id.js', () => ({
    adminMediaId: () => '11111111-1111-4111-8111-111111111111',
}));
vi.mock('$lib/server/services/media-image-storage.service.js', () => ({
    storeMediaImage: vi.fn(),
    deleteMediaImage: vi.fn(),
    deleteMediaImageSlot: vi.fn(),
}));
vi.mock('$lib/server/database/queries/admin-media.queries.js', () => ({
    getMediaItemById: readOwner,
}));
vi.mock('$lib/server/database/queries/media-artwork.queries.js', () => ({
    getArtworkWithInheritance: readArtwork,
}));
import { def } from './index';

beforeEach(() => {
    vi.clearAllMocks();
    readArtwork.mockResolvedValue([
        {
            id: 'image',
            artworkType: 'poster',
            url: '/album-cover',
            source: 'album',
            sourceId: 'album',
            sourceName: 'Album',
        },
    ]);
});

it.each(['/album-cover', '/uploaded'])(
    'credits inherited artwork only when the owner still uses the sourced value: %s',
    async (poster) => {
        readOwner.mockResolvedValue({
            media_type: 'album',
            custom_poster_url: poster,
            custom_metadata: {
                album_enrichment: {
                    provenance: {
                        poster: {
                            provider: 'discogs',
                            value: '/album-cover',
                            url: 'https://www.discogs.com/release/42',
                        },
                    },
                },
            },
        });
        const response = await def.handlers.GET!({} as RequestEvent, { surface: 'internal' });
        const [item] = MediaImagesResponseSchema.parse(await response.json());
        expect(item.discogsUrl).toBe(
            poster === '/album-cover' ? 'https://www.discogs.com/release/42' : undefined,
        );
        expect(readOwner).toHaveBeenCalledWith({}, 'album');
    },
);

// The web client decodes these responses strictly in dev and reports every
// mismatch in prod; a `success` field the server no longer sent made "Remove
// logo" throw before the radio list reloaded (2026-11-24).
it('DELETE answers exactly what the client schema decodes', async () => {
    const { deleteMediaImage } =
        await import('$lib/server/services/media-image-storage.service.js');
    vi.mocked(deleteMediaImage).mockResolvedValue(true);
    const url = new URL('http://localhost/api/admin/media/x/images?type=poster');
    const response = await def.handlers.DELETE!(
        { url, locals: { user: { username: 'admin' } } } as unknown as RequestEvent,
        { surface: 'internal' },
    );
    expect(ImageDeleteResponseSchema.strict().parse(await response.json())).toEqual({
        deleted: true,
    });
});

it('POST (url) answers exactly what the client schema decodes', async () => {
    const { storeMediaImage } = await import('$lib/server/services/media-image-storage.service.js');
    vi.mocked(storeMediaImage).mockResolvedValue({
        filePath: '/config/.metadata/x/poster.png',
        serveUrl: '/api/image/custom/x/poster',
    });
    const request = new Request('http://localhost/api/admin/media/x/images', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ artworkType: 'poster', url: 'https://images.invalid/a.png' }),
    });
    const response = await def.handlers.POST!(
        {
            request,
            url: new URL(request.url),
            locals: { user: { username: 'admin' } },
        } as unknown as RequestEvent,
        { surface: 'internal' },
    );
    expect(response.status).toBe(200);
    expect(ImageUploadResponseSchema.strict().parse(await response.json())).toMatchObject({
        serveUrl: '/api/image/custom/x/poster',
    });
});

it('DELETE all=1 empties the slot instead of hiding one image', async () => {
    const { deleteMediaImage, deleteMediaImageSlot } =
        await import('$lib/server/services/media-image-storage.service.js');
    vi.mocked(deleteMediaImageSlot).mockResolvedValue(true);
    const url = new URL('http://localhost/api/admin/media/x/images?type=poster&all=1');
    const response = await def.handlers.DELETE!(
        { url, locals: { user: { username: 'admin' } } } as unknown as RequestEvent,
        { surface: 'internal' },
    );
    expect(await response.json()).toEqual({ deleted: true });
    expect(deleteMediaImageSlot).toHaveBeenCalledWith(
        {},
        '11111111-1111-4111-8111-111111111111',
        'poster',
        'admin',
    );
    expect(deleteMediaImage).not.toHaveBeenCalled();
});
