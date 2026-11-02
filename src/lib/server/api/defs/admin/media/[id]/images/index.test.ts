// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { MediaImagesResponseSchema } from '$lib/schemas/media-image-upload';

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
    storeMediaImage: vi.fn(), deleteMediaImage: vi.fn(),
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
    readArtwork.mockResolvedValue([{
        id: 'image', artworkType: 'poster', url: '/album-cover', source: 'album',
        sourceId: 'album', sourceName: 'Album',
    }]);
});

it.each(['/album-cover', '/uploaded'])(
    'credits inherited artwork only when the owner still uses the sourced value: %s',
    async (poster) => {
        readOwner.mockResolvedValue({
            media_type: 'album', custom_poster_url: poster,
            custom_metadata: { album_enrichment: { provenance: { poster: {
                provider: 'discogs', value: '/album-cover',
                url: 'https://www.discogs.com/release/42',
            } } } },
        });
        const response = await def.handlers.GET!({} as RequestEvent, { surface: 'internal' });
        const [item] = MediaImagesResponseSchema.parse(await response.json());
        expect(item.discogsUrl).toBe(poster === '/album-cover'
            ? 'https://www.discogs.com/release/42' : undefined);
        expect(readOwner).toHaveBeenCalledWith({}, 'album');
    },
);
