// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * `/browse` used to mount every genre/keyword row (and its ~20 cards) eagerly
 * on first render, most of them below the fold. Rows beyond the first 3 are
 * now wrapped in `LazyMount`: the server still emits a height-reserved
 * placeholder for them (so there is no layout shift and Back/Forward's
 * offset-based scroll restore keeps working — see
 * src/lib/utils/scroll-restoration.ts), and the real row only mounts once an
 * IntersectionObserver reports it near the viewport.
 *
 * This pins the seam: with browseSsr seeding 5 genre rows, the first 3
 * render immediately; rows 4 and 5 render only after their placeholder's
 * IntersectionObserver fires.
 */

import { render, cleanup } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { tick } from 'svelte';
import { readable } from 'svelte/store';

const mockGetBrowse = vi.fn();
const mockGetBrowseKeywords = vi.fn();
const mockGetLibraries = vi.fn();
const mockGetAzBrowse = vi.fn();
const mockGetRecentlyAdded = vi.fn();
const mockGetWatchStats = vi.fn();

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
vi.mock('$lib/api/watch-stats', () => ({
    getWatchStats: (...args: unknown[]) => mockGetWatchStats(...args),
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

function genreRow(name: string) {
    return {
        genre: name,
        items: [
            {
                id: `${name}-item`,
                name: `${name} Item`,
                type: 'movie' as const,
                overview: 'An overview',
                imageId: `${name}-item`,
            },
        ],
    };
}

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

type IOCallback = (entries: Array<{ isIntersecting: boolean }>) => void;

class MockIntersectionObserver {
    static instances: MockIntersectionObserver[] = [];
    callback: IOCallback;
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();

    constructor(callback: IOCallback) {
        this.callback = callback;
        MockIntersectionObserver.instances.push(this);
    }

    static reset(): void {
        MockIntersectionObserver.instances = [];
    }

    /** Fire every registered observer as intersecting — simulates every
     * below-the-fold placeholder scrolling near the viewport at once. */
    static triggerAll(): void {
        for (const instance of MockIntersectionObserver.instances) {
            instance.callback([{ isIntersecting: true }]);
        }
    }
}

beforeEach(() => {
    vi.clearAllMocks();
    MockIntersectionObserver.reset();
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
    mockGetWatchStats.mockResolvedValue({ data: { stats: [] }, error: null });
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('/browse lazy-mounted rows', () => {
    test.each([false, true])('global statistics requests respect admin=%s', async (isAdmin) => {
        mockGetBrowseKeywords.mockResolvedValue({
            data: {
                items: [
                    {
                        keyword: 'Crafted Theme',
                        keywordId: 779,
                        items: [
                            {
                                id: 'theme-movie',
                                catalogId: null,
                                type: 'movie',
                                ids: {},
                                title: 'Amber Passage',
                                images: {},
                                availability: { isAvailable: true, canRequest: false },
                            },
                        ],
                    },
                ],
                page: { limit: 5, offset: 0, hasMore: false },
            },
            error: null,
        });
        const data = {
            ...makePageData({ recentlyAdded: [], genres: [] }),
            user: { hasRequestPermission: true, isAdmin },
        };
        pageStore.set({ url: new URL('http://localhost/browse'), params: {}, data });
        const { container, queryAllByText } = render(BrowsePage, { data } as never);
        await vi.waitFor(() => expect(queryAllByText('Amber Passage').length).toBeGreaterThan(0));
        await tick();
        expect(mockGetWatchStats).not.toHaveBeenCalled();
        MockIntersectionObserver.triggerAll();
        await tick();
        if (isAdmin) {
            await vi.waitFor(() => expect(mockGetWatchStats).toHaveBeenCalledTimes(3));
        } else {
            expect(mockGetWatchStats).not.toHaveBeenCalled();
            expect(container.querySelector('.popular-stats-sentinel')).toBeNull();
        }
    });

    test('rows beyond the first 3 do not mount until their placeholder intersects', async () => {
        const genreNames = ['GenreZero', 'GenreOne', 'GenreTwo', 'GenreThree', 'GenreFour'];
        const data = makePageData({
            recentlyAdded: [],
            genres: genreNames.map(genreRow),
        });

        const { queryAllByText, getAllByText } = render(BrowsePage, { data } as never);
        await tick();

        // First 3 rows (index 0-2) are eager: their titles are in the DOM
        // immediately (the genre name appears twice — once as the row's <h2>
        // heading, once as its destination chip — hence *AllByText), and so
        // are their cards' item titles.
        expect(getAllByText('GenreZero').length).toBeGreaterThan(0);
        expect(getAllByText('GenreOne').length).toBeGreaterThan(0);
        expect(getAllByText('GenreTwo').length).toBeGreaterThan(0);
        expect(getAllByText('GenreZero Item').length).toBeGreaterThan(0);

        // Rows beyond index 2 are behind LazyMount: their row heading has not
        // mounted (the chip rail still lists the genre name as a navigation
        // destination — that's unaffected by lazy-mounting the row — so only
        // the card content is a reliable "not mounted" signal here).
        expect(queryAllByText('GenreThree Item')).toHaveLength(0);
        expect(queryAllByText('GenreFour Item')).toHaveLength(0);

        // Simulate every placeholder's IntersectionObserver firing (as
        // happens once the user scrolls near it, or immediately for
        // near-fold rows thanks to LazyMount's rootMargin).
        MockIntersectionObserver.triggerAll();
        await tick();

        expect(getAllByText('GenreThree Item').length).toBeGreaterThan(0);
        expect(getAllByText('GenreFour Item').length).toBeGreaterThan(0);
    });
});
