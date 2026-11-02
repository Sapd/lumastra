// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ImageMetadataRow } from '$lib/server/database/queries/catalog-operations.queries';
import type { ImageOptions, ImageResponse, ImageType } from './types';

vi.mock('$lib/server/database/queries/catalog-operations.queries', async (original) => ({
    ...(await original<typeof import('$lib/server/database/queries/catalog-operations.queries')>()),
    getImageMetadata: vi.fn(async () => null),
}));
vi.mock('$lib/server/database/queries/media-artwork.queries', async (original) => ({
    ...(await original<typeof import('$lib/server/database/queries/media-artwork.queries')>()),
    getOwnLocalArtwork: vi.fn(async () => null),
}));
vi.mock('../image-descriptor/selected.js', () => ({ resolveSelectedImageCandidate: vi.fn(async () => null) }));
vi.mock('$lib/server/database/queries/image-candidates.queries.js', async original => ({
    ...await original<typeof import('$lib/server/database/queries/image-candidates.queries.js')>(),
    getSuppressedImageProviders: vi.fn(async () => []),
}));
import { getImageMetadata } from '$lib/server/database/queries/catalog-operations.queries';
import { getOwnLocalArtwork } from '$lib/server/database/queries/media-artwork.queries';
import { ImageProxyService } from './service';

const id = '11111111-1111-4111-8111-111111111111';
interface ServiceSeams {
    cachedGetImageMetadata: (id: string, type: ImageType) => Promise<ImageMetadataRow | null>;
    cachedGetLocalArtwork: (id: string, type: string) => Promise<unknown>;
    tryLocalArtwork: (id: string, type: ImageType, options: ImageOptions) => Promise<ImageResponse | null>;
    tryTmdb: (row: ImageMetadataRow, type: ImageType, options: ImageOptions, id?: string) => Promise<ImageResponse | null>;
    getProviderPriority: () => string[];
    tryProvider: (provider: string, id: string, type: ImageType, options: ImageOptions, row: ImageMetadataRow | null) => Promise<ImageResponse | null>;
}
beforeEach(() => vi.clearAllMocks());

describe('own-only artwork resolution', () => {
    it('bypasses inherited metadata and isolates in-flight work from default requests', async () => {
        const service = new ImageProxyService({} as never);
        const seams = service as unknown as ServiceSeams;
        const inherited = { metadata_source_id: 'ancestor', media_type: 'episode' } as ImageMetadataRow;
        seams.cachedGetImageMetadata = vi.fn(async () => inherited);
        seams.getProviderPriority = () => ['local'];
        seams.tryProvider = vi.fn(async (_provider, _id, _type, _options, row) => row
            ? { buffer: Buffer.from('ancestor'), contentType: 'image/webp', cacheControl: 'public, max-age=86400' }
            : null);
        const [own, chain] = await Promise.all([
            service.getImageByCatalogId(id, 'poster', { inherit: 'none' }),
            service.getImageByCatalogId(id, 'poster'),
        ]);
        expect(own).toBeNull();
        expect(chain).not.toBeNull();
        expect(getImageMetadata).toHaveBeenCalledWith(expect.anything(), id, 'poster', 'none');
        expect(seams.cachedGetImageMetadata).toHaveBeenCalledTimes(1);
    });
    it('never consults the local ancestor cache in own-only mode', async () => {
        const service = new ImageProxyService({} as never);
        const seams = service as unknown as ServiceSeams;
        seams.cachedGetLocalArtwork = vi.fn(async () => null);
        expect(await seams.tryLocalArtwork(id, 'poster', { inherit: 'none' })).toBeNull();
        expect(getOwnLocalArtwork).toHaveBeenCalledWith(expect.anything(), id, 'poster');
        expect(seams.cachedGetLocalArtwork).not.toHaveBeenCalled();
        await seams.tryLocalArtwork(id, 'poster', {});
        expect(seams.cachedGetLocalArtwork).toHaveBeenCalledTimes(1);
    });
    it('does not ask TMDB to look up a missing own path', async () => {
        const service = new ImageProxyService({} as never);
        const fetch = vi.spyOn(service, 'getTmdbImage').mockResolvedValue(null);
        const seams = service as unknown as ServiceSeams;
        const row = { tmdb_id: '123', media_type: 'episode', metadata_media_type: 'episode', poster_path: null } as ImageMetadataRow;
        expect(await seams.tryTmdb(row, 'poster', { inherit: 'none' }, id)).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
        await seams.tryTmdb(row, 'poster', {}, id);
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
