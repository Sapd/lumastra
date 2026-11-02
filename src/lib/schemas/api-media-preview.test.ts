// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { MediaPreviewSchema, MediaPreviewContextSchema } from './api-media-preview.js';
import { buildPlaybackProgress } from './api-playback-progress.js';

const uuid = '550e8400-e29b-41d4-a716-446655440000';
const preview = { id: 'tmdb:550:movie', catalogId: null, type: 'movie', ids: { tmdb: '550' },
    title: 'Example', images: {} };

describe('MediaPreview', () => {
    it.each(['movie', 'series', 'season', 'episode', 'album', 'track', 'artist', 'audiobook'])('accepts %s previews', (type) => {
        expect(MediaPreviewSchema.parse({ ...preview, type }).type).toBe(type);
    });
    it('retains typed context, image descriptors, progress and discovery metadata', () => {
        const item = { ...preview, id: uuid, catalogId: uuid, type: 'episode', subtitle: 'Episode',
            year: 2026, overview: 'Overview', rating: 8, genres: ['Drama'], durationMs: 2_520_000,
            score: 0.8, reason: { kind: 'upcoming', label: 'Tomorrow', seed: 'seed' },
            availability: { isAvailable: false, canRequest: true },
            context: { series: { id: 'tmdb:123:series', catalogId: null, title: 'Series' },
                seasonNumber: 0, episodeNumber: 1, airDate: '2026-10-18' },
            progress: buildPlaybackProgress({ positionMs: 100, durationMs: 1000 }),
            images: { thumb: { href: '/api/v1/media/example/images/thumb?v=1',
                revision: '1', source: 'series', variants: { card: '/image?size=card' } } } };
        expect(MediaPreviewSchema.parse(item)).toEqual(item);
        expect(MediaPreviewContextSchema.parse(item.context)).toEqual(item.context);
    });
    it.each([{ id: '' }, { catalogId: 'bad' }, { type: 'tv' }, { ids: { tmdb: 550 } },
        { images: { thumb: { href: '/image' } } }, { progress: 50 },
        { availability: { isAvailable: true } }, { context: { seasonNumber: 1.5 } }])('rejects malformed fields %j', (fields) => {
        expect(MediaPreviewSchema.safeParse({ ...preview, ...fields }).success).toBe(false);
    });
    it('requires the core fields and exports the OpenAPI identity', () => {
        for (const field of ['id', 'catalogId', 'type', 'ids', 'title', 'images']) {
            const incomplete: Record<string, unknown> = { ...preview };
            delete incomplete[field];
            expect(MediaPreviewSchema.safeParse(incomplete).success).toBe(false);
        }
        expect(MediaPreviewSchema.meta()?.id).toBe('MediaPreview');
        expect('audiobook' in MediaPreviewSchema.shape).toBe(true);
    });
});
