// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = (await importOriginal()) as {
        config: Record<string, unknown>;
    };
    return {
        ...actual,
        config: {
            ...actual.config,
            IMAGE_SYNC_AUTO_VIDEO_EXTRACTION: true,
            EPISODE_THUMBNAIL_PREFERENCE: 'generated',
        },
    };
});

import { config } from '$lib/server/config.js';
import { materializeMissingEpisodeThumbnails } from './provider-artwork-materialization.service';

function setEpisodeThumbnailConfig(
    values: Partial<{
        IMAGE_SYNC_AUTO_VIDEO_EXTRACTION: boolean;
        EPISODE_THUMBNAIL_PREFERENCE: 'provider' | 'generated';
    }>,
) {
    Object.assign(config as Record<string, unknown>, values);
}

describe('materializeMissingEpisodeThumbnails', () => {
    beforeEach(() => {
        setEpisodeThumbnailConfig({
            IMAGE_SYNC_AUTO_VIDEO_EXTRACTION: true,
            EPISODE_THUMBNAIL_PREFERENCE: 'generated',
        });
    });

    it('prefers ffmpeg extraction when video is first in the priority', async () => {
        const episodeId = '2a49f020-65f2-4abc-92a4-b5b68d15934a';
        const getImageByCatalogId = vi.fn(async () => ({
            buffer: Buffer.from('still'),
            contentType: 'image/jpeg',
            cacheControl: 'public, max-age=86400',
        }));
        const storeImage = vi.fn();
        const extractFrame = vi.fn(async () => ({
            extracted: true,
            filePath: '/metadata/episode/thumb.jpg',
        }));
        const shouldForceVideoExtraction = vi.fn(async () => false);

        const result = await materializeMissingEpisodeThumbnails(
            {} as never,
            {},
            {
                candidates: [{ id: episodeId, title: 'Episode 1' }],
                imageService: { getImageByCatalogId },
                storeImage,
                extractFrame,
                shouldForceVideoExtraction,
            },
        );

        expect(shouldForceVideoExtraction).toHaveBeenCalledWith(
            {},
            { id: episodeId, title: 'Episode 1' },
        );
        expect(extractFrame).toHaveBeenCalledWith(
            {},
            {
                mediaItemId: episodeId,
                artworkType: 'thumb',
            },
        );
        expect(getImageByCatalogId).not.toHaveBeenCalled();
        expect(storeImage).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            attemptedProvider: 0,
            storedProvider: 0,
            attemptedExtraction: 1,
            extracted: 1,
            errors: 0,
        });
    });

    it('lets ffmpeg replace a provider-materialized thumb when video is first', async () => {
        const episodeId = '2a49f020-65f2-4abc-92a4-b5b68d15934a';
        const getImageByCatalogId = vi.fn();
        const storeImage = vi.fn();
        const extractFrame = vi.fn(async () => ({
            extracted: true,
            filePath: '/metadata/episode/thumb.jpg',
        }));
        const shouldForceVideoExtraction = vi.fn(async () => true);

        const result = await materializeMissingEpisodeThumbnails(
            {} as never,
            {},
            {
                candidates: [{ id: episodeId, title: 'Episode 1' }],
                imageService: { getImageByCatalogId },
                storeImage,
                extractFrame,
                shouldForceVideoExtraction,
            },
        );

        expect(extractFrame).toHaveBeenCalledWith(
            {},
            {
                mediaItemId: episodeId,
                artworkType: 'thumb',
                force: true,
            },
        );
        expect(getImageByCatalogId).not.toHaveBeenCalled();
        expect(storeImage).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            attemptedProvider: 0,
            storedProvider: 0,
            attemptedExtraction: 1,
            extracted: 1,
            errors: 0,
        });
    });

    it('keeps whole-file-only bounded episodes eligible when window extraction fails', async () => {
        setEpisodeThumbnailConfig({ EPISODE_THUMBNAIL_PREFERENCE: 'provider' });
        const episodeId = '2a49f020-65f2-4abc-92a4-b5b68d15934a';
        const getImageByCatalogId = vi.fn();
        const storeImage = vi.fn();
        const extractFrame = vi.fn(async () => ({
            extracted: false,
            reason: 'extraction_failed' as const,
        }));
        const result = await materializeMissingEpisodeThumbnails(
            {} as never,
            {},
            {
                candidates: [{ id: episodeId, title: 'Bounded', needsWindowExtraction: true }],
                imageService: { getImageByCatalogId },
                storeImage,
                extractFrame,
            },
        );
        expect(extractFrame).toHaveBeenCalledWith(
            {},
            {
                mediaItemId: episodeId,
                artworkType: 'thumb',
                force: true,
            },
        );
        expect(getImageByCatalogId).not.toHaveBeenCalled();
        expect(storeImage).not.toHaveBeenCalled();
        expect(result).toMatchObject({ attemptedExtraction: 1, extracted: 0, errors: 1 });
    });

    it('stores provider episode stills as local Lumastra thumbs when provider is first', async () => {
        setEpisodeThumbnailConfig({
            EPISODE_THUMBNAIL_PREFERENCE: 'provider',
        });
        const episodeId = '2a49f020-65f2-4abc-92a4-b5b68d15934a';
        const getImageByCatalogId = vi.fn(async () => ({
            buffer: Buffer.from('still'),
            contentType: 'image/jpeg',
            cacheControl: 'public, max-age=86400',
        }));
        const storeImage = vi.fn(async () => ({
            filePath: '/metadata/episode/thumb.jpg',
            serveUrl: '/api/image/custom/episode/thumb',
        }));
        const extractFrame = vi.fn();

        const result = await materializeMissingEpisodeThumbnails(
            {} as never,
            {},
            {
                candidates: [{ id: episodeId, title: 'Episode 1' }],
                imageService: { getImageByCatalogId },
                storeImage,
                extractFrame,
            },
        );

        expect(getImageByCatalogId).toHaveBeenCalledWith(episodeId, 'still', {
            size: 'full',
        });
        expect(storeImage).toHaveBeenCalledWith({}, episodeId, 'thumb', {
            type: 'file',
            buffer: Buffer.from('still'),
            contentType: 'image/jpeg',
            sourceTag: 'provider:unknown',
            provider: undefined,
            providerRef: undefined,
        });
        expect(extractFrame).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            attemptedProvider: 1,
            storedProvider: 1,
            attemptedExtraction: 0,
            extracted: 0,
            errors: 0,
        });
    });

    it('falls back to ffmpeg extraction when no provider still exists', async () => {
        setEpisodeThumbnailConfig({
            EPISODE_THUMBNAIL_PREFERENCE: 'provider',
        });
        const episodeId = '2a49f020-65f2-4abc-92a4-b5b68d15934a';
        const getImageByCatalogId = vi.fn(async () => null);
        const storeImage = vi.fn();
        const extractFrame = vi.fn(async () => ({
            extracted: true,
            filePath: '/metadata/episode/thumb.jpg',
        }));
        const shouldForceVideoExtraction = vi.fn(async () => false);

        const result = await materializeMissingEpisodeThumbnails(
            {} as never,
            {},
            {
                candidates: [{ id: episodeId, title: 'Episode 1' }],
                imageService: { getImageByCatalogId },
                storeImage,
                extractFrame,
                shouldForceVideoExtraction,
            },
        );

        expect(storeImage).not.toHaveBeenCalled();
        expect(extractFrame).toHaveBeenCalledWith(
            {},
            {
                mediaItemId: episodeId,
                artworkType: 'thumb',
            },
        );
        expect(result).toMatchObject({
            attemptedProvider: 1,
            storedProvider: 0,
            attemptedExtraction: 1,
            extracted: 1,
            skipped: 0,
            errors: 0,
        });
    });
});
