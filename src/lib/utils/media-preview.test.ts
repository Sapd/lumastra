// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { MediaPreview } from '$lib/schemas/api-media-preview';
import { mediaPreviewToUniversal } from './media-preview';
import { pickVariant } from '$lib/utils/image-utils.js';

vi.mock('$lib/paths', () => ({
    url: (path: string) => (path.startsWith('/app/') ? path : `/app${path}`),
}));

const item: MediaPreview = {
    id: 'tmdb:123:series',
    catalogId: null,
    ids: { tmdb: '123' },
    type: 'episode',
    title: 'Pilot',
    images: {
        thumb: {
            href: '/api/media/episode/images/thumb',
            variants: { card: '/api/media/episode/images/thumb?size=card' },
            revision: '1',
            source: 'series',
        },
    },
    context: {
        series: { id: 'tmdb:123:series', catalogId: null, title: 'Show' },
        seasonNumber: 0,
        episodeNumber: 2,
    },
    availability: { isAvailable: false, canRequest: true, hasFile: false },
    progress: {
        positionMs: 25_000,
        durationMs: 100_000,
        fraction: 0.25,
        finished: false,
        updatedAt: null,
    },
    score: 0.99,
};

describe('mediaPreviewToUniversal', () => {
    it('uses playback fraction independently from relevance and keeps opaque handles', () => {
        expect(mediaPreviewToUniversal(item)).toMatchObject({
            id: item.id,
            externalIds: { tmdb: '123', internal: undefined },
            progress: 25,
            similarityScore: 0.99,
            seriesId: 'tmdb:123:series',
            seasonNumber: 0,
            episodeNumber: 2,
            isAvailable: false,
            canRequest: true,
            hasFiles: false,
            image: '/app/api/media/episode/images/thumb?size=card',
        });
    });

    it('does not invent progress or availability when absent', () => {
        const result = mediaPreviewToUniversal({
            ...item,
            progress: undefined,
            availability: undefined,
        });
        expect(result.progress).toBeUndefined();
        expect(result.isAvailable).toBe(false);
        expect(result.hasFiles).toBe(false);
    });

    it('keeps unknown fraction absent', () => {
        expect(
            mediaPreviewToUniversal({ ...item, progress: { ...item.progress!, fraction: null } })
                .progress,
        ).toBeUndefined();
    });
});


describe('pickVariant', () => {
    const descriptor = { href: '/image', revision: '1', source: 'self' as const };

    it('falls back to href when variants or the requested size are absent', () => {
        expect(pickVariant(descriptor, 'card')).toBe('/image');
        expect(pickVariant({ ...descriptor, variants: { thumb: '/small' } }, 'card')).toBe(
            '/image',
        );
    });

    it('uses the requested variant and leaves missing artwork absent', () => {
        expect(pickVariant({ ...descriptor, variants: { card: '/card' } }, 'card')).toBe(
            '/card',
        );
        expect(pickVariant(undefined, 'card')).toBeUndefined();
    });
});
