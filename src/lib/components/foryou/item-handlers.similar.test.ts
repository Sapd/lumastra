// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';

const mocks = vi.hoisted(() => ({ open: vi.fn(), replace: vi.fn(), similar: vi.fn() }));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/stores/modal.store', () => ({
    modals: { open: mocks.open, replace: mocks.replace, close: vi.fn() },
}));
vi.mock('$lib/api/content', () => ({ getSimilarMedia: mocks.similar }));
vi.mock('$lib/components/SimilarMoviesModal.svelte', () => ({ default: {} }));

import { handleItemMore } from './item-handlers';

beforeEach(() => {
    vi.clearAllMocks();
    mocks.similar.mockResolvedValue({ data: { items: [{ title: 'A match' }], truncated: false } });
});

describe('For You AI Similar', () => {
    it.each(['movie', 'series', 'tv'] as const)(
        'lets the modal fetch for %s without replacing it with stale results',
        async (mediaType) => {
            const item: UniversalMediaItem = {
                id: 'tmdb:42:movie',
                externalIds: { tmdb: '42' },
                title: 'Source title',
                // Legacy runtime rows may still carry the storage spelling 'tv'.
                mediaType: mediaType as UniversalMediaItem['mediaType'],
                image: '',
                isAvailable: true,
                canRequest: false,
            };
            await handleItemMore({ section: {} as PageSection, item });
            expect(mocks.open).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
                sourceMedia: {
                    externalIds: item.externalIds,
                    name: item.title,
                    type: mediaType === 'movie' ? 'movie' : 'tv',
                },
                similar: [],
                loading: true,
            });
            expect(mocks.similar).not.toHaveBeenCalled();
            expect(mocks.replace).not.toHaveBeenCalled();
        },
    );
});
