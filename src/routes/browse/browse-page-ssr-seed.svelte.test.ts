// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * /browse's genre carousels + Recently Added are now SSR'd (see
 * browse/+page.server.ts). This pins the client half of that contract: when
 * the server load seeded `data.browseSsr`, the page must NOT re-fetch the
 * same data via `browseApi.getBrowse()` on its initial mount — otherwise the
 * SSR trip was wasted bandwidth AND still paid the full client round-trip
 * latency the SSR was meant to remove. A null/absent `browseSsr` (SSR
 * failed, or no server load at all) keeps the existing client-fetch
 * fallback.
 */

import { render, cleanup, fireEvent, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';

const mockGetBrowse = vi.fn();
const mockGetBrowseKeywords = vi.fn();
const mockGetLibraries = vi.fn();
const mockGetAzBrowse = vi.fn();
const mockGetRecentlyAdded = vi.fn();

const { pageStore } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { writable: hoistedWritable } = require('svelte/store') as typeof import('svelte/store');
    return {
        pageStore: hoistedWritable({
            url: new URL('http://localhost/browse'),
            params: {},
            data: {} as Record<string, unknown>,
        }),
    };
});

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$app/stores', () => ({ page: pageStore, navigating: readable(null) }));
vi.mock('$app/navigation', () => ({
    goto: vi.fn(async () => undefined),
    replaceState: vi.fn(),
    afterNavigate: vi.fn(),
    beforeNavigate: vi.fn(),
}));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/api/browse', () => ({
    getBrowse: (...args: unknown[]) => mockGetBrowse(...args),
    getBrowseKeywords: (...args: unknown[]) => mockGetBrowseKeywords(...args),
    getLibraries: (...args: unknown[]) => mockGetLibraries(...args),
    getAzBrowse: (...args: unknown[]) => mockGetAzBrowse(...args),
    getRecentlyAdded: (...args: unknown[]) => mockGetRecentlyAdded(...args),
}));
vi.mock('$lib/api/content', () => ({ search: vi.fn(async () => ({ data: null, error: null })) }));
vi.mock('$lib/services/browse-data.service', () => ({
    loadWatchingData: vi.fn(async () => ({ sections: [] })),
}));
vi.mock('$lib/services/sse/watch-state-sse', () => ({
    setChangedRevision: readable(0),
    sessionChangedRevision: readable(0),
}));

import BrowsePage from './+page.svelte';

const RECENTLY_ADDED_ITEM = {
    id: 'r1',
    name: 'Recent One',
    type: 'movie' as const,
    overview: 'An overview',
    imageId: 'r1',
};
const GENRE_ROW = {
    genre: 'Action',
    items: [
        {
            id: 'g1',
            name: 'Genre One',
            type: 'movie' as const,
            overview: 'An overview',
            imageId: 'g1',
        },
    ],
};

function makePageData(browseSsr: unknown) {
    return {
        watching: null,
        watchingSuppressed: true,
        browseSsr,
        branding: { appName: 'Lumastra' },
        user: { hasRequestPermission: true },
        browse: {
            searchDebounceMs: 200,
            azPageSize: 50,
            keywordsInitial: 5,
            keywordsPageSize: 5,
            scrollMargin: '400px',
        },
    };
}

class MockIntersectionObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    vi.stubGlobal(
        'matchMedia',
        vi.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        })),
    );
    localStorage.clear();
    pageStore.set({
        url: new URL('http://localhost/browse'),
        params: {},
        data: makePageData(null),
    });
    mockGetBrowse.mockResolvedValue({
        data: { recentlyAdded: [], genres: [] },
        error: null,
    });
    mockGetBrowseKeywords.mockResolvedValue({
        data: { items: [], availableKeywords: [], page: { limit: 5, offset: 0, hasMore: false } },
        error: null,
    });
    mockGetLibraries.mockResolvedValue({ data: { libraries: [] }, error: null });
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('/browse SSR genre-row seed', () => {
    test('does NOT call getBrowse on mount when the server already seeded browseSsr', async () => {
        const data = makePageData({
            recentlyAdded: [RECENTLY_ADDED_ITEM],
            genres: [GENRE_ROW],
        });

        render(BrowsePage, { data } as never);

        // Let the onMount IIFE and any microtasks it schedules settle.
        await vi.waitFor(() => expect(mockGetBrowseKeywords).toHaveBeenCalled());

        expect(mockGetBrowse).not.toHaveBeenCalled();
    });

    test('DOES call getBrowse on mount when there is no SSR seed (fallback)', async () => {
        const data = makePageData(null);

        render(BrowsePage, { data } as never);

        await vi.waitFor(() => expect(mockGetBrowse).toHaveBeenCalled());

        expect(mockGetBrowse).toHaveBeenCalledWith('all');
    });
});

describe('/browse selection consistency', () => {
    test('reloads Discover for a type selected while in Library', async () => {
        mockGetAzBrowse.mockResolvedValue({
            data: { items: [], totalCount: 0, hasMore: false },
            error: null,
        });
        render(BrowsePage, { data: makePageData({ recentlyAdded: [], genres: [] }) } as never);
        await fireEvent.click(screen.getByRole('button', { name: 'Library · A–Z' }));
        await fireEvent.click(screen.getByRole('tab', { name: 'Movies' }));
        await fireEvent.click(screen.getByRole('button', { name: 'Discover' }));
        await vi.waitFor(() => expect(mockGetBrowse).toHaveBeenLastCalledWith('movies'));
    });

    test('discards theme pages from the previous media tab', async () => {
        let finishMovies!: (value: unknown) => void;
        mockGetBrowseKeywords.mockImplementation((options: { type: string }) =>
            options.type === 'movies'
                ? new Promise((resolve) => {
                      finishMovies = resolve;
                  })
                : Promise.resolve({
                      data: {
                          items: [],
                          availableKeywords: [],
                          page: { limit: 5, offset: 0, hasMore: false },
                      },
                      error: null,
                  }),
        );
        render(BrowsePage, { data: makePageData({ recentlyAdded: [], genres: [] }) } as never);
        await fireEvent.click(screen.getByRole('tab', { name: 'Movies' }));
        await fireEvent.click(screen.getByRole('tab', { name: 'Series' }));
        finishMovies({
            data: {
                items: [],
                availableKeywords: [],
                page: { limit: 5, offset: 0, hasMore: true },
            },
            error: null,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(screen.queryByRole('button', { name: 'Load more themes' })).toBeNull();
    });

    test('discards an older tab response that finishes after the current tab', async () => {
        let finishMovies!: (value: unknown) => void;
        mockGetBrowse.mockImplementation((type: string) =>
            type === 'movies'
                ? new Promise((resolve) => {
                      finishMovies = resolve;
                  })
                : Promise.resolve({
                      data: { recentlyAdded: [], genres: [{ genre: 'Current series', items: [] }] },
                      error: null,
                  }),
        );
        render(BrowsePage, { data: makePageData({ recentlyAdded: [], genres: [] }) } as never);
        await fireEvent.click(screen.getByRole('tab', { name: 'Movies' }));
        await fireEvent.click(screen.getByRole('tab', { name: 'Series' }));
        await screen.findByRole('link', { name: 'Current series' });
        finishMovies({
            data: { recentlyAdded: [], genres: [{ genre: 'Stale movies', items: [] }] },
            error: null,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(screen.queryByRole('link', { name: 'Stale movies' })).toBeNull();
        expect(screen.getByRole('link', { name: 'Current series' })).toBeTruthy();
    });
});
