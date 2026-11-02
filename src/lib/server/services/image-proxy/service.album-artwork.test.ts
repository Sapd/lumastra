// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type postgres from 'postgres';
import type { ImageCandidate } from '$lib/schemas/image-candidates.js';
import type { RequestEvent } from '@sveltejs/kit';
import { def as imageEndpoint } from '$lib/server/api/defs/media/[id]/images/[role].js';
import { ImageProxyService } from './service.js';
import {
    getImageDescriptorOwners,
    type ImageOwnerRow,
} from '$lib/server/database/queries/image-descriptor.queries.js';
import {
    getImageMetadata,
    type ImageMetadataRow,
} from '$lib/server/database/queries/catalog-operations.queries.js';
import type { ImageOptions, ImageProviderType, ImageResponse, ImageType } from './types.js';

vi.mock('$lib/server/database/queries/image-candidates.queries.js', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('$lib/server/database/queries/image-candidates.queries.js')
    >()),
    getSuppressedImageProviders: vi.fn().mockResolvedValue([]),
}));

vi.mock('$lib/server/database/queries/image-descriptor.queries.js', () => ({
    getImageDescriptorOwners: vi.fn(),
}));
vi.mock('$lib/server/database/queries/catalog-operations.queries.js', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('$lib/server/database/queries/catalog-operations.queries.js')
    >()),
    getImageMetadata: vi.fn(),
}));

vi.mock('$lib/server/services/image-proxy/index.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/services/image-proxy/index.js')>()),
    getImageProxyService: () => activeService,
}));
vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({
    bandwidthTracker: { trackImage: vi.fn() },
}));

let activeService: ImageProxyService;
const albumId = '11111111-1111-4111-8111-111111111111';
const artistId = '22222222-2222-4222-8222-222222222222';
const sql = {} as postgres.Sql;
function owner(id: string, media_type: string, parent_id: string | null = null): ImageOwnerRow {
    return {
        id,
        media_type,
        parent_id,
        is_various_artists: false,
        preferred_provider: null,
        poster_blurhash: null,
        backdrop_blurhash: null,
        local_artwork: {},
        provider_paths: {},
        custom_urls: {},
    };
}
function metadata(media_type: string): ImageMetadataRow {
    return {
        media_type,
        metadata_media_type: media_type,
        metadata_source_id: null,
        poster_path: null,
        backdrop_path: null,
        logo_path: null,
        still_path: null,
        primary_ext_id: null,
        primary_provider: null,
        tmdb_id: null,
        jellyfin_id: null,
        custom_poster_url: null,
        custom_thumb_url: null,
        audiobookshelf_id: null,
        audiobookshelf_revision: null,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

interface ImageProxyInternals {
    cachedGetImageMetadata(uuid: string, type: ImageType): Promise<ImageMetadataRow | null>;
    tryProvider(
        provider: ImageProviderType,
        uuid: string,
        type: ImageType,
        options: ImageOptions,
        row: ImageMetadataRow | null,
    ): Promise<ImageResponse | null>;
    maybeSaveBlurhash(uuid: string, type: ImageType, buffer: Buffer): Promise<void>;
}
interface AlbumArtworkFixture {
    album: ImageOwnerRow;
    artist: ImageOwnerRow;
    service: ImageProxyService;
    provider: MockInstance<ImageProxyInternals['tryProvider']>;
    blurhash: MockInstance<ImageProxyInternals['maybeSaveBlurhash']>;
}

describe('album poster/primary byte resolution', () => {
    function setup(): AlbumArtworkFixture {
        const album = owner(albumId, 'album', artistId);
        const artist = owner(artistId, 'artist');
        artist.local_artwork.poster = { path: '/artist.jpg', updatedAt: 'now' };
        vi.mocked(getImageDescriptorOwners).mockResolvedValue([album, artist]);
        vi.mocked(getImageMetadata).mockImplementation(async (_sql, id) =>
            metadata(id === albumId ? 'album' : 'artist'),
        );
        const service = new ImageProxyService(sql);
        activeService = service;
        const internals = service as unknown as ImageProxyInternals;
        // Deliberately stale/inherited metadata must never select the displayed owner.
        vi.spyOn(internals, 'cachedGetImageMetadata').mockResolvedValue({
            ...metadata('album'),
            custom_poster_url: 'https://example.com/artist.jpg',
        });
        const provider = vi
            .spyOn(internals, 'tryProvider')
            .mockImplementation(
                async (
                    _provider: string,
                    id: string,
                    _type: string,
                    options: { inherit?: string },
                ): Promise<ImageResponse | null> => {
                    expect(options.inherit).toBe('none');
                    const row = id === albumId ? album : artist;
                    return row.local_artwork.poster?.path
                        ? {
                              buffer: Buffer.from(id),
                              contentType: 'image/jpeg',
                              cacheControl: 'public, max-age=3600',
                          }
                        : null;
                },
            );
        const blurhash = vi.spyOn(internals, 'maybeSaveBlurhash').mockResolvedValue(undefined);
        return { album, artist, service, provider, blurhash };
    }

    it.each(['poster', 'primary'] as const)(
        '%s uses the artist own picture when the album has none',
        async (role) => {
            const { service, provider, blurhash } = setup();
            const result = await service.getImageByCatalogId(albumId, role, { size: 'thumb' });
            expect(result?.buffer.toString()).toBe(artistId);
            expect(provider).toHaveBeenCalledWith(
                'local',
                artistId,
                'poster',
                expect.objectContaining({ size: 'thumb', inherit: 'none' }),
                expect.objectContaining({ media_type: 'artist' }),
            );
            expect(getImageMetadata).toHaveBeenCalledWith(sql, artistId, 'poster', 'none');
            expect(blurhash).toHaveBeenCalledWith(artistId, 'poster', expect.any(Buffer));
            expect(blurhash).not.toHaveBeenCalledWith(
                albumId,
                expect.anything(),
                expect.anything(),
            );
        },
    );
    it.each(['poster', 'primary'] as const)(
        '%s prefers a real album cover even after serving an artist fallback',
        async (role) => {
            const { service, album } = setup();
            expect((await service.getImageByCatalogId(albumId, role))?.buffer.toString()).toBe(
                artistId,
            );
            album.local_artwork.poster = { path: '/album.jpg', updatedAt: 'later' };
            expect((await service.getImageByCatalogId(albumId, role))?.buffer.toString()).toBe(
                albumId,
            );
            expect(getImageMetadata).toHaveBeenLastCalledWith(sql, albumId, 'poster', 'none');
        },
    );
    it.each(['missing', 'various-artists'] as const)(
        'returns no artwork for %s',
        async (scenario) => {
            const { service, artist, provider } = setup();
            if (scenario === 'missing') artist.local_artwork = {};
            else artist.is_various_artists = true;
            expect(
                await service.getImageByCatalogId(albumId, 'poster', { size: 'thumb' }),
            ).toBeNull();
            expect(provider).not.toHaveBeenCalled();
        },
    );
    it.each(['poster', 'primary'] as const)(
        'serves the same chain through the direct web %s route without v',
        async (role) => {
            const { artist } = setup();
            const request = new Request(
                `http://localhost/api/media/${albumId}/images/${role}?size=thumb`,
            );
            const event = {
                request,
                url: new URL(request.url),
                params: { id: albumId, role },
                locals: {},
            } as unknown as RequestEvent;
            const response = await imageEndpoint.handlers.GET!(event, {
                surface: 'internal',
            } as never);
            expect(response.status).toBe(200);
            expect(await response.text()).toBe(artistId);
            expect(response.headers.get('x-lumastra-placeholder')).toBeNull();
            expect(response.headers.get('cache-control')).not.toContain('immutable');
            artist.is_various_artists = true;
            const missing = await imageEndpoint.handlers.GET!(event, {
                surface: 'internal',
            } as never);
            expect(missing.headers.get('x-lumastra-placeholder')).toBe('1');
            expect(missing.headers.get('cache-control')).toBe('no-store');
        },
    );
    it.each(['poster', 'primary'] as const)(
        '%s prefers an album selection and preserves artist candidate provenance only for fallback',
        async (role) => {
            const { service, album, artist, provider } = setup();
            const candidate: ImageCandidate = {
                id: '33333333-3333-4333-8333-333333333333',
                media_item_id: artistId,
                artwork_type: 'poster',
                provider: 'discogs',
                provider_ref: 'https://i.discogs.com/artist.jpg',
                remote_url: 'https://i.discogs.com/artist.jpg',
                file_path: null,
                language: '',
                width: 700,
                height: 700,
                chosen_by: 'admin',
                fetched_at: '2026-10-24',
                locked: true,
                selected: true,
                sort_order: 0,
            };
            artist.selected_candidates = { poster: candidate };
            const serve = vi.spyOn(service, 'serveImageCandidate').mockResolvedValue({
                buffer: Buffer.from('selected'),
                contentType: 'image/jpeg',
                cacheControl: 'public, max-age=3600',
            });
            expect((await service.getImageByCatalogId(albumId, role))?.provenance).toEqual({
                provider: 'discogs',
                providerRef: candidate.provider_ref,
            });
            // An album cover must win over even a locked artist selection.
            album.local_artwork.poster = { path: '/album.jpg', updatedAt: 'later' };
            expect((await service.getImageByCatalogId(albumId, role))?.buffer.toString()).toBe(
                albumId,
            );
            const ownCandidate = {
                ...candidate,
                media_item_id: albumId,
                provider_ref: 'https://i.discogs.com/album.jpg',
            };
            album.selected_candidates = { poster: ownCandidate };
            expect((await service.getImageByCatalogId(albumId, role))?.provenance).toEqual({
                provider: 'discogs',
                providerRef: ownCandidate.provider_ref,
            });
            expect(serve).toHaveBeenLastCalledWith(
                expect.objectContaining({ ...ownCandidate, contentRevision: expect.any(String) }),
                'poster',
                expect.objectContaining({ inherit: 'none' }),
                expect.objectContaining({ media_type: 'album' }),
            );
            expect(provider).toHaveBeenCalled();
        },
    );
    it('own-only requests do not resolve or serve an artist fallback', async () => {
        const { service } = setup();
        expect(
            await service.getImageByCatalogId(albumId, 'poster', { inherit: 'none' }),
        ).toBeNull();
        // Candidate lookup still reads the owners, but own-only never walks to the artist.
        expect(getImageDescriptorOwners).toHaveBeenCalledWith(sql, [albumId]);
        expect(getImageMetadata).toHaveBeenCalledWith(sql, albumId, 'poster', 'none');
    });
});
