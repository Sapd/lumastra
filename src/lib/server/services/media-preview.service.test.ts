// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
vi.mock('./image-descriptor/resolver.js', () => ({
    resolveImageSets: vi.fn(async () => new Map()),
}));
import { resolveImageSets } from './image-descriptor/resolver.js';
const catalog = vi.hoisted(() => ({ previews: vi.fn() }));
vi.mock('$lib/server/database/queries/audiobook-catalog.queries.js', () => ({
    audiobookPreviewsForAdmittedIds: catalog.previews,
}));
import {
    buildMediaPreview,
    buildMediaPreviews,
    recommendationPreviews,
} from './media-preview.service.js';
import { MediaPreviewSchema } from '$lib/schemas/api-media-preview.js';
const id = '123e4567-e89b-42d3-a456-426614174000';

describe('media preview producer', () => {
    it('separates catalog identity from external IDs', () => {
        const item = buildMediaPreview({
            id,
            type: 'tv',
            title: 'Show',
            ids: { internal: id, tmdb: 123 },
        });
        expect(item).toMatchObject({ id, catalogId: id, type: 'series', ids: { tmdb: '123' } });
        expect(item?.ids).not.toHaveProperty('internal');
        expect(MediaPreviewSchema.safeParse(item).success).toBe(true);
    });
    it('builds discovery handles and drops unresolvable rows', () => {
        expect(
            buildMediaPreview({ type: 'movie', title: 'Film', ids: { tmdb: 550 } }),
        ).toMatchObject({ id: 'tmdb:550:movie', catalogId: null });
        expect(
            buildMediaPreview({ id: 'sonarr:1:series', type: 'series', title: 'Bad' }),
        ).toBeNull();
    });
    it('uses a series handle for a missing upcoming episode', () => {
        expect(
            buildMediaPreview({
                type: 'episode',
                title: 'Pilot',
                context: {
                    series: { id: 'tmdb:123:series', catalogId: null, title: 'Show' },
                    seasonNumber: 1,
                    episodeNumber: 1,
                },
            }),
        ).toMatchObject({ id: 'tmdb:123:series', catalogId: null, type: 'episode' });
    });
    it('keeps ranking score distinct from progress and preserves millisecond precision', () => {
        const item = buildMediaPreview({
            id,
            type: 'movie',
            title: 'Film',
            score: 0.9,
            progress: { positionMs: 12345, durationMs: 60001, finished: false },
            isAvailable: false,
            canRequest: true,
        });
        expect(item).toMatchObject({
            score: 0.9,
            progress: { positionMs: 12345, durationMs: 60001 },
            availability: { isAvailable: false, canRequest: true },
        });
    });
    it('resolves a page of artwork in one batch', async () => {
        await buildMediaPreviews({} as postgres.Sql, 'v1', [{ id, type: 'movie', title: 'Film' }]);
        expect(resolveImageSets).toHaveBeenCalledWith(expect.anything(), 'v1', [
            {
                id,
                mediaType: 'movie',
            },
        ]);
    });
    it('turns watch progress into milliseconds without score or duplicate fields', async () => {
        const [item] = await recommendationPreviews({} as postgres.Sql, 'v1', [
            {
                media: { id, type: 'movie', title: 'Film', ids: {} },
                score: 0.25,
                positionSeconds: 30,
                durationSeconds: 120,
                reason: { kind: 'continue-watching' },
            },
        ]);
        expect(item.progress).toMatchObject({
            positionMs: 30000,
            durationMs: 120000,
            fraction: 0.25,
        });
        expect(item).not.toHaveProperty('score');
        expect(item).not.toHaveProperty('positionSeconds');
    });
});

describe('audiobook decoration', () => {
    const person = { id: '11111111-1111-4111-8111-111111111111', name: 'M.K. Fenwick' };
    const book = {
        id,
        catalogId: id,
        type: 'audiobook' as const,
        ids: { isbn: '9780000000001' },
        title: 'Book',
        subtitle: 'M.K. Fenwick',
        images: { primary: { href: '/media/x/images/primary', revision: '1', source: 'self' } },
        audiobook: { authors: [person], narrators: [], series: null },
    };
    it('adds the audiobook block, isbn/asin and the cover to audiobook items only', async () => {
        catalog.previews.mockResolvedValue([book]);
        const sql = vi.fn(async () => []) as unknown as postgres.Sql;
        const [item, film] = await buildMediaPreviews(
            sql,
            'v1',
            [
                { id, type: 'audiobook', title: 'Book', ids: { internal: id } },
                {
                    id: '223e4567-e89b-42d3-a456-426614174000',
                    type: 'movie',
                    title: 'Film',
                    ids: {},
                },
            ],
            'u1',
        );
        expect(item.audiobook?.authors).toEqual([person]);
        expect(item.ids).toMatchObject({ isbn: '9780000000001' });
        expect(item.images.primary).toBeDefined();
        expect(item.subtitle).toBe('M.K. Fenwick');
        expect(film.audiobook).toBeUndefined();
    });
    it('keeps the plain preview when the catalog read fails', async () => {
        catalog.previews.mockRejectedValue(new Error('db down'));
        const sql = vi.fn(async () => []) as unknown as postgres.Sql;
        const [item] = await buildMediaPreviews(
            sql,
            'v1',
            [{ id, type: 'audiobook', title: 'Book', ids: { internal: id } }],
            'u1',
        );
        expect(item.title).toBe('Book');
        expect(item.audiobook).toBeUndefined();
    });
});
