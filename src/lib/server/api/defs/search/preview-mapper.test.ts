// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { buildImageRefs } from '$lib/shared/api-urls.js';
import { buildImageSet } from '$lib/shared/image-descriptor.js';
import { buildPlaybackProgress } from '$lib/schemas/api-playback-progress.js';
import { MediaPreviewSchema } from '$lib/schemas/api-media-preview.js';
import { SearchResponseSchema, SuggestResponseSchema } from './search-item.schemas.js';

const resolveImages = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/services/image-descriptor/resolver.js', () => ({
    resolveImageSets: resolveImages,
}));
const { searchPreviews, suggestPreviews } = await import('./preview-mapper.js');
const sql = {} as Sql;
const ID = '11111111-1111-4111-8111-111111111111';
const ARTIST = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
    resolveImages.mockReset();
    resolveImages.mockResolvedValue(new Map());
});

describe('search MediaPreview contract', () => {
    it('uses catalog identity, resolved artwork, score and reason without mutating cached input', async () => {
        const images = buildImageSet('v1', { poster: { ownerId: ID, revision: 'art-v2' } });
        resolveImages.mockResolvedValue(new Map([[ID, images]]));
        const row = {
            id: ID,
            type: 'episode' as const,
            ids: { internal: ID, tmdb: '123' },
            title: 'Pilot',
            rank: 3.5,
            matchSource: 'fts',
            images: { poster: { href: 'old' } },
            seriesId: ARTIST,
            seriesName: 'Show',
            seasonNumber: 1,
            episodeNumber: 2,
            isAvailable: true,
        };
        const items = await searchPreviews(sql, 'v1', [row]);
        expect(
            SearchResponseSchema.safeParse({
                items,
                page: { limit: 20, offset: 0, hasMore: false },
            }).success,
        ).toBe(true);
        expect(items[0]).toMatchObject({
            id: ID,
            catalogId: ID,
            ids: { tmdb: '123' },
            score: 3.5,
            reason: { kind: 'fts' },
            images,
            context: {
                series: { id: ARTIST, catalogId: ARTIST, title: 'Show' },
                seasonNumber: 1,
                episodeNumber: 2,
            },
            availability: { isAvailable: true, canRequest: false },
        });
        expect(items[0].ids).not.toHaveProperty('internal');
        expect(items[0]).not.toHaveProperty('rank');
        expect(items[0]).not.toHaveProperty('seriesId');
        expect(row.ids.internal).toBe(ID);
        expect(row.images.poster.href).toBe('old');
    });

    it('keeps playback progress and emits structured music artists as previews', async () => {
        const progress = buildPlaybackProgress({ positionMs: 60000, durationMs: 120000 });
        const [item] = await searchPreviews(sql, 'v1', [
            {
                id: ID,
                type: 'track',
                ids: {},
                title: 'Song',
                images: { poster: { href: 'old' } },
                rank: 2.3,
                matchSource: 'music',
                duration: 120,
                artists: [{ id: ARTIST, title: 'Artist' }],
                progress,
            },
        ]);
        expect(item.durationMs).toBe(120_000);
        expect(item.progress).toEqual(progress);
        expect(MediaPreviewSchema.safeParse(item.artists?.[0]).success).toBe(true);
        expect(resolveImages).toHaveBeenCalledTimes(1);
        expect(resolveImages.mock.calls[0][2]).toContainEqual({ id: ARTIST, mediaType: 'artist' });
    });

    it('retains auxiliary search types and wraps their external cover as an ImageSet descriptor', async () => {
        const [item] = await searchPreviews(sql, 'v1', [
            {
                id: 'kavita:42',
                type: 'book',
                ids: { kavita: '42' },
                title: 'Book',
                images: { poster: { href: '/covers/42' } },
                rank: 1,
                matchSource: 'title',
            },
        ]);
        expect(item.catalogId).toBeNull();
        expect(item.images.poster).toMatchObject({
            href: '/covers/42',
            variants: { full: '/covers/42' },
            source: 'self',
        });
        expect(
            SearchResponseSchema.safeParse({
                items: [item],
                page: { limit: 20, offset: 0, hasMore: false },
            }).success,
        ).toBe(true);
    });

    it('suggestions use the same core with external ids and a bounded envelope', async () => {
        const items = await suggestPreviews(sql, 'v1', [
            {
                id: ID,
                title: 'Series',
                mediaType: 'series',
                ids: { tmdb: '123' },
                images: buildImageRefs(ID, 'v1'),
                isAvailable: false,
            },
        ]);
        expect(SuggestResponseSchema.safeParse({ items, truncated: true }).success).toBe(true);
        expect(items[0]).toMatchObject({
            catalogId: ID,
            type: 'series',
            ids: { tmdb: '123' },
            availability: { isAvailable: false, canRequest: true },
        });
        expect(items[0]).not.toHaveProperty('mediaType');
    });
});
