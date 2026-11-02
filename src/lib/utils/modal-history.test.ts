// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as contentApi from '$lib/api/content';
import { modals } from '$lib/stores/modal.store';
import { openMediaModalFromUrl } from './modal-utils';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/api/content', () => ({ getMediaDetails: vi.fn() }));
vi.mock('$lib/stores/modal-registry.store', () => ({ getModalComponent: () => ({}) }));
vi.mock('$lib/utils/image-utils', () => ({
    imageFromIds: () => '',
    getCatalogPosterUrl: () => '',
    createPlaceholderDataUrl: () => '',
    pickVariant: () => undefined,
}));

const mediaId = 'a3f5e8c7-1234-4678-90ab-cdef12345678';
const episodeId = 'b3f5e8c7-1234-4678-90ab-cdef12345678';
const originalState = {
    'sveltekit:history': 42,
    'sveltekit:navigation': 39,
    'sveltekit:states': { musicPlaylistOrigin: true },
    opaqueRouterData: { retained: ['unknown', 'future', 'keys'] },
};

function respondWith(data: unknown): void {
    vi.mocked(contentApi.getMediaDetails).mockResolvedValueOnce({
        data,
    } as Awaited<ReturnType<typeof contentApi.getMediaDetails>>);
}

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(async () => {
    await modals.closeAll();
});

describe('modal URL canonicalization preserves browser history state', () => {
    it('replaces a provider key and slug without losing router or application state', async () => {
        window.history.replaceState(originalState, '', '/?modal=tmdb:782:movie&q=harbor#details');
        respondWith({
            type: 'movie',
            ids: { internal: mediaId, tmdb: '782' },
            title: 'The Lantern Harbor',
            isAvailable: true,
        });

        expect(await openMediaModalFromUrl({ tmdb: '782' }, 'movie')).toBe(true);

        const url = new URL(window.location.href);
        expect(url.searchParams.get('modal')).toBe(mediaId);
        expect(url.searchParams.get('slug')).toBe('movie-the-lantern-harbor');
        expect(url.searchParams.get('q')).toBe('harbor');
        expect(url.hash).toBe('#details');
        expect(window.history.state).toEqual(originalState);
    });

    it('replaces an episode with its parent series while retaining state and episode selection', async () => {
        window.history.replaceState(originalState, '', `/?modal=${episodeId}&q=harbor`);
        respondWith({
            type: 'episode',
            ids: { internal: episodeId },
            seriesId: mediaId,
            title: 'The Lantern Harbor',
            seasonNumber: 2,
            episodeNumber: 3,
        });
        respondWith({
            type: 'series',
            ids: { internal: mediaId },
            title: 'The Lantern Harbor',
            isAvailable: true,
        });

        expect(await openMediaModalFromUrl({ internal: episodeId }, 'tv', 2, 3)).toBe(true);

        const url = new URL(window.location.href);
        expect(url.searchParams.get('modal')).toBe(mediaId);
        expect(url.searchParams.get('season')).toBe('2');
        expect(url.searchParams.get('episode')).toBe('3');
        expect(url.searchParams.get('q')).toBe('harbor');
        expect(window.history.state).toEqual(originalState);
    });
});
