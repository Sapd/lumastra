// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Task 10: `/browse/+page.svelte` no longer statically imports AzBrowseView
 * (17.7 KB brotli on `/browse`, never rendered during SSR — azMode is driven
 * entirely by client-only code in `onMount`, so it's always false on the
 * server, even for a direct navigation to `/browse/az`; see the import
 * comment in +page.svelte). It is now `{#await import(...)}`ed once azMode
 * flips true on the client.
 *
 * This pins that: a direct navigation carrying `?mode=az` in the URL (the
 * same signal `azStore.initFromUrl` reads inside `onMount`) must still
 * mount AzBrowseView and have it fetch its own data, proving the dynamic
 * import actually resolves and the component actually renders — not just
 * that azMode flips true with nothing to show for it.
 */
import { render, cleanup, fireEvent, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';

const mockGetBrowse = vi.fn();
const mockGetBrowseKeywords = vi.fn();
const mockGetLibraries = vi.fn();
const mockGetAzBrowse = vi.fn();
const mockGetRecentlyAdded = vi.fn();

const { pageStore, navigationCallbacks, beforeNavigationCallbacks, mockReplaceState } = vi.hoisted(
    () => {
        const { writable: hoistedWritable } =
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require('svelte/store') as typeof import('svelte/store');
        return {
            navigationCallbacks: [] as Array<(nav: { type: string; to: { url: URL } }) => void>,
            beforeNavigationCallbacks: [] as Array<() => void>,
            mockReplaceState: vi.fn(),
            pageStore: hoistedWritable({
                url: new URL('http://localhost/browse?mode=az'),
                params: {},
                data: {} as Record<string, unknown>,
            }),
        };
    },
);

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$app/stores', () => ({ page: pageStore, navigating: readable(null) }));
vi.mock('$app/navigation', () => ({
    goto: vi.fn(async () => undefined),
    replaceState: mockReplaceState,
    beforeNavigate: (callback: () => void) => beforeNavigationCallbacks.push(callback),
    afterNavigate: (callback: (typeof navigationCallbacks)[number]) =>
        navigationCallbacks.push(callback),
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
import { loadBrowseSelection, saveBrowseSelection } from '$lib/stores/browse-selection';
import { LANGUAGE_LABELS } from '$lib/shared/track-language';

function makePageData(browseSsr: unknown = null) {
    return {
        watching: null,
        watchingSuppressed: true,
        browseSsr,
        branding: { appName: 'Lumastra' },
        user: {
            userId: 'browse-user' as string | undefined,
            username: 'browse-user',
            hasRequestPermission: true,
        },
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
    navigationCallbacks.length = 0;
    beforeNavigationCallbacks.length = 0;
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
        url: new URL('http://localhost/browse?mode=az'),
        params: {},
        data: makePageData(),
    });
    mockGetBrowse.mockResolvedValue({ data: { recentlyAdded: [], genres: [] }, error: null });
    mockGetBrowseKeywords.mockResolvedValue({
        data: { items: [], availableKeywords: [], page: { limit: 5, offset: 0, hasMore: false } },
        error: null,
    });
    mockGetLibraries.mockResolvedValue({ data: { libraries: [] }, error: null });
    mockGetAzBrowse.mockResolvedValue({
        data: { items: [], page: { total: 0, offset: 0, limit: 50, hasMore: false } },
        error: null,
    });
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('/browse?mode=az lazy AzBrowseView', () => {
    test('mounts AzBrowseView and fetches A-Z data once the dynamic import resolves', async () => {
        const { container } = render(BrowsePage, { data: makePageData() } as never);

        // AzBrowseView is the single fetch owner for A-Z data (see the page's
        // own comment on `azStore`) — this only happens once it actually
        // mounts, which only happens once the dynamic import resolves.
        await vi.waitFor(() => expect(mockGetAzBrowse).toHaveBeenCalled());

        expect(container.querySelector('.az-browse-container')).not.toBeNull();
    });

    test('shows a pending placeholder that reserves space before AzBrowseView resolves', async () => {
        const { container } = render(BrowsePage, { data: makePageData() } as never);

        // Assert synchronously, before awaiting anything: the dynamic
        // import's promise is still pending right after render, so the
        // pending branch — not AzBrowseView itself — must already be in the
        // DOM (an `{#await}` with no pending branch renders nothing here,
        // collapsing the region to zero height).
        expect(container.querySelector('.az-lazy-pending')).not.toBeNull();
        expect(container.querySelector('.az-browse-container')).toBeNull();

        // Let the import resolve so the test doesn't leak a pending mount
        // into the next test.
        await vi.waitFor(() => expect(mockGetAzBrowse).toHaveBeenCalled());
    });
});

function setUrl(path: string, userId = 'browse-user'): void {
    const data = makePageData();
    data.user.userId = userId;
    pageStore.set({ url: new URL(path, 'http://localhost'), params: {}, data });
}

function lastAzRequest(): Record<string, unknown> {
    return mockGetAzBrowse.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

function seedSelection(): void {
    saveBrowseSelection(
        'id:browse-user',
        new URLSearchParams({
            mode: 'az',
            type: 'series',
            libraryGroupId: '11111111-1111-4111-8111-111111111111',
            layout: 'list',
            q: 'blue',
            genre: 'Animation',
            tag: 'family',
            sort: 'year_desc',
            audio: 'de',
            subs: 'en',
            res: '4K',
            hdr: 'hdr',
            codec: 'hevc',
            includeUnknown: 'true',
            qUnknown: 'true',
        }),
    );
}

function setupLibraries(): void {
    mockGetLibraries.mockResolvedValue({
        data: {
            libraries: [
                {
                    id: '11111111-1111-4111-8111-111111111111',
                    name: 'Kids',
                    mediaType: 'mixed',
                    itemCount: 20,
                },
                { id: 'other', name: 'Other', mediaType: 'mixed', itemCount: 20 },
            ],
        },
        error: null,
    });
    mockGetAzBrowse.mockResolvedValue({
        data: {
            items: [],
            page: { total: 0, offset: 0, limit: 50, hasMore: false },
            genreCounts: [{ name: 'Animation', count: 20 }],
            keywordCounts: [{ keyword: 'family', count: 20 }],
        },
        error: null,
    });
}

async function chooseLibrary(container: HTMLElement, value: string): Promise<void> {
    const select = container.querySelector<HTMLSelectElement>('.catalog-library-field select')!;
    await vi.waitFor(() =>
        expect(
            select.querySelector('option[value="11111111-1111-4111-8111-111111111111"]'),
        ).not.toBeNull(),
    );
    await fireEvent.change(select, { target: { value } });
}

async function choosePlayback(container: HTMLElement, group: number, text: string): Promise<void> {
    const button = [
        ...container.querySelectorAll('fieldset')[group].querySelectorAll('button'),
    ].find((candidate) => candidate.textContent === text)!;
    expect(button).toBeDefined();
    await fireEvent.click(button);
}

describe('Browse selection persistence through the real controls', () => {
    test('restores library, presentation, type, content, language, quality and sort after remount', async () => {
        setupLibraries();
        const first = render(BrowsePage, { data: makePageData() } as never);
        await vi.waitFor(() => expect(mockGetAzBrowse).toHaveBeenCalled());
        await fireEvent.click(first.container.querySelector('#tab-series')!);
        await chooseLibrary(first.container, '11111111-1111-4111-8111-111111111111');
        await fireEvent.click(first.container.querySelector('.view-switch button:nth-child(2)')!);
        await fireEvent.change(first.container.querySelector('.az-sort-select')!, {
            target: { value: 'year_desc' },
        });
        await fireEvent.click(
            [...first.container.querySelectorAll('.facet-options button')].find(
                (button) => button.textContent === 'Animation',
            )!,
        );
        await fireEvent.click(first.container.querySelectorAll('.facet-options button')[1]);
        await choosePlayback(first.container, 0, LANGUAGE_LABELS.de);
        await choosePlayback(first.container, 1, LANGUAGE_LABELS.en);
        await choosePlayback(first.container, 2, '4K');
        await choosePlayback(first.container, 3, 'HDR');
        await choosePlayback(first.container, 4, 'HEVC');
        await fireEvent.click(first.container.querySelector('.unknown input')!);
        await fireEvent.input(first.container.querySelector('.search-input')!, {
            target: { value: 'blue' },
        });
        await first.unmount();
        mockGetAzBrowse.mockClear();
        setUrl('/browse');
        const fresh = render(BrowsePage, { data: makePageData() } as never);
        await vi.waitFor(() =>
            expect(lastAzRequest()).toMatchObject({
                libraryGroupId: '11111111-1111-4111-8111-111111111111',
                type: 'tv',
                sort: 'year_desc',
                q: 'blue',
                genre: 'Animation',
                tag: 'family',
                audio: ['de'],
                subs: ['en'],
                res: ['4K'],
                hdr: ['hdr'],
                codec: ['hevc'],
                includeUnknown: true,
                qualityIncludeUnknown: true,
            }),
        );
        expect(
            fresh.container.querySelector<HTMLSelectElement>('.catalog-library-field select')!
                .value,
        ).toBe('11111111-1111-4111-8111-111111111111');
        expect(fresh.container.querySelector<HTMLSelectElement>('.az-sort-select')!.value).toBe(
            'year_desc',
        );
        expect(
            fresh.container
                .querySelector('.view-switch button:nth-child(2)')!
                .getAttribute('aria-pressed'),
        ).toBe('true');
        expect(fresh.container.querySelector('#tab-series')!.getAttribute('aria-selected')).toBe(
            'true',
        );
        expect(fresh.container.querySelector<HTMLInputElement>('.search-input')!.value).toBe(
            'blue',
        );
        await vi.waitFor(() => expect(mockReplaceState).toHaveBeenCalled());
        const canonical = new URL(mockReplaceState.mock.calls.at(-1)![0], 'http://localhost');
        expect(canonical.searchParams.get('libraryGroupId')).toBe(
            '11111111-1111-4111-8111-111111111111',
        );
        expect(canonical.searchParams.get('layout')).toBe('list');
    });

    test('restores state before the router is ready and defers its canonical URL until the next task', async () => {
        setupLibraries();
        seedSelection();
        setUrl('/browse');
        const view = render(BrowsePage, { data: makePageData() } as never);
        expect(view.container.querySelector('#tab-az')!.getAttribute('aria-pressed')).toBe('true');
        expect(view.container.querySelector<HTMLInputElement>('.search-input')!.value).toBe('blue');
        expect(mockReplaceState).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(mockReplaceState).toHaveBeenCalledTimes(1));
        expect(
            new URL(mockReplaceState.mock.calls[0][0], 'http://localhost').searchParams.get('mode'),
        ).toBe('az');
    });

    test('cancels deferred restoration when a control changes the URL first', async () => {
        setupLibraries();
        seedSelection();
        setUrl('/browse');
        const view = render(BrowsePage, { data: makePageData() } as never);
        await fireEvent.click(view.container.querySelector('.browse-modes button:first-child')!);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(mockReplaceState).toHaveBeenCalledTimes(1);
        expect(
            new URL(mockReplaceState.mock.calls[0][0], 'http://localhost').searchParams.get('mode'),
        ).toBe('discover');
    });

    test.each(['navigation', 'unmount', 'later restoration'])(
        'cancels deferred canonicalization on %s',
        async (cause) => {
            setupLibraries();
            seedSelection();
            setUrl('/browse');
            const view = render(BrowsePage, { data: makePageData() } as never);
            expect(mockReplaceState).not.toHaveBeenCalled();
            if (cause === 'navigation') beforeNavigationCallbacks.at(-1)!();
            else if (cause === 'unmount') await view.unmount();
            else
                navigationCallbacks.at(-1)!({
                    type: 'link',
                    to: { url: new URL('http://localhost/browse?mode=discover') },
                });
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(mockReplaceState).not.toHaveBeenCalled();
        },
    );

    test('keeps cleared filters, default sort, grid and all types after remount', async () => {
        setupLibraries();
        seedSelection();
        setUrl('/browse');
        const first = render(BrowsePage, { data: makePageData() } as never);
        await vi.waitFor(() =>
            expect(lastAzRequest()?.libraryGroupId).toBe('11111111-1111-4111-8111-111111111111'),
        );
        await fireEvent.click(first.container.querySelector('.filter-dialog footer button')!);
        await fireEvent.click(first.container.querySelector('.clear-search')!);
        await fireEvent.click(first.container.querySelector('.view-switch button:first-child')!);
        await fireEvent.change(first.container.querySelector('.az-sort-select')!, {
            target: { value: 'title_asc' },
        });
        await fireEvent.click(first.container.querySelector('#tab-all')!);
        await first.unmount();
        // Simulate stale legacy preferences: complete saved empties must win.
        localStorage.setItem('browse-az-lang-filter', JSON.stringify({ audioLangs: ['ja'] }));
        localStorage.setItem(
            'browse-az-view-prefs',
            JSON.stringify({ sort: 'rating_desc', resolutions: ['SD'] }),
        );
        mockGetAzBrowse.mockClear();
        setUrl('/browse');
        const fresh = render(BrowsePage, { data: makePageData() } as never);
        await vi.waitFor(() => expect(mockGetAzBrowse).toHaveBeenCalled());
        expect(lastAzRequest()).toMatchObject({ type: 'all', sort: 'title_asc', q: '' });
        for (const key of [
            'libraryGroupId',
            'genre',
            'tag',
            'audio',
            'subs',
            'res',
            'hdr',
            'codec',
            'includeUnknown',
            'qualityIncludeUnknown',
        ])
            expect(lastAzRequest()).not.toHaveProperty(key);
        expect(
            fresh.container
                .querySelector('.view-switch button:first-child')!
                .getAttribute('aria-pressed'),
        ).toBe('true');
    });

    test.each(['/browse?mode=az&type=movies&genre=Drama', '/browse/az'])(
        'honors explicit destination %s independently of the saved selection',
        async (path) => {
            setupLibraries();
            seedSelection();
            setUrl(path);
            const view = render(BrowsePage, { data: makePageData() } as never);
            await vi.waitFor(() => expect(mockGetAzBrowse).toHaveBeenCalled());
            expect(lastAzRequest()).not.toHaveProperty('libraryGroupId');
            expect(lastAzRequest()).not.toHaveProperty('tag');
            expect(lastAzRequest().q).toBe('');
            expect(
                view.container
                    .querySelector('.view-switch button:first-child')!
                    .getAttribute('aria-pressed'),
            ).toBe('true');
            expect(lastAzRequest().type).toBe(path.includes('movies') ? 'movie' : 'all');
            expect(mockReplaceState).not.toHaveBeenCalled();
        },
    );

    test('restores the saved type and presentation on a real navigation in the same page instance', async () => {
        setupLibraries();
        seedSelection();
        setUrl('/browse?mode=az&type=movies');
        const view = render(BrowsePage, { data: makePageData() } as never);
        await vi.waitFor(() => expect(mockGetAzBrowse).toHaveBeenCalled());
        mockGetAzBrowse.mockClear();
        setUrl('/browse');
        navigationCallbacks.at(-1)!({
            type: 'link',
            to: { url: new URL('http://localhost/browse') },
        });
        await vi.waitFor(() =>
            expect(lastAzRequest()).toMatchObject({
                type: 'tv',
                libraryGroupId: '11111111-1111-4111-8111-111111111111',
            }),
        );
        expect(view.container.querySelector('#tab-series')!.getAttribute('aria-selected')).toBe(
            'true',
        );
        expect(
            view.container
                .querySelector('.view-switch button:nth-child(2)')!
                .getAttribute('aria-pressed'),
        ).toBe('true');
    });

    test('reloads the restored Discover type when SSR seeded the all-media tab', async () => {
        saveBrowseSelection('id:browse-user', new URLSearchParams('mode=discover&type=series'));
        setUrl('/browse');
        mockGetBrowse.mockResolvedValue({
            data: { recentlyAdded: [], genres: [{ genre: 'Current series', items: [] }] },
            error: null,
        });
        const data = makePageData({
            recentlyAdded: [],
            genres: [{ genre: 'Stale movies', items: [] }],
        });
        const view = render(BrowsePage, { data } as never);
        await screen.findByRole('link', { name: 'Current series' });
        expect(mockGetBrowse).toHaveBeenCalledExactlyOnceWith('series');
        expect(screen.queryByRole('link', { name: 'Stale movies' })).toBeNull();
        expect(view.container.querySelector('#tab-series')!.getAttribute('aria-selected')).toBe(
            'true',
        );
        expect(
            view.container
                .querySelector('.browse-modes button:first-child')!
                .getAttribute('aria-pressed'),
        ).toBe('true');
        expect(mockGetAzBrowse).not.toHaveBeenCalled();
    });

    test.each(['/browse#catalog', '/%62rowse#catalog'])(
        'restores bare destination %s and preserves its fragment',
        async (path) => {
            setupLibraries();
            seedSelection();
            setUrl(path);
            render(BrowsePage, { data: makePageData() } as never);
            await vi.waitFor(() =>
                expect(lastAzRequest()).toMatchObject({
                    libraryGroupId: '11111111-1111-4111-8111-111111111111',
                    type: 'tv',
                }),
            );
            await vi.waitFor(() => expect(mockReplaceState).toHaveBeenCalled());
            const canonical = new URL(mockReplaceState.mock.calls.at(-1)![0], 'http://localhost');
            expect(canonical.hash).toBe('#catalog');
        },
    );

    test('clears a saved library after a successful empty library response and remembers the clear', async () => {
        seedSelection();
        setUrl('/browse');
        render(BrowsePage, { data: makePageData() } as never);
        await vi.waitFor(() => {
            expect(mockGetAzBrowse).toHaveBeenCalled();
            expect(lastAzRequest()).not.toHaveProperty('libraryGroupId');
            expect(loadBrowseSelection('id:browse-user')?.get('libraryGroupId')).toBe('');
        });
        expect(
            new URL(mockReplaceState.mock.calls.at(-1)![0], 'http://localhost').searchParams.has(
                'libraryGroupId',
            ),
        ).toBe(false);
    });

    test('preserves the saved library when the library list request fails', async () => {
        seedSelection();
        setUrl('/browse');
        mockGetLibraries.mockResolvedValue({ data: null, error: 'temporarily unavailable' });
        render(BrowsePage, { data: makePageData() } as never);
        await vi.waitFor(() =>
            expect(lastAzRequest()).toHaveProperty(
                'libraryGroupId',
                '11111111-1111-4111-8111-111111111111',
            ),
        );
        expect(loadBrowseSelection('id:browse-user')?.get('libraryGroupId')).toBe(
            '11111111-1111-4111-8111-111111111111',
        );
    });

    test('restores a letter selected through the jump rail after remount', async () => {
        setupLibraries();
        mockGetAzBrowse.mockResolvedValue({
            data: {
                items: [],
                page: { total: 200, offset: 0, limit: 50, hasMore: false },
                letterCounts: [
                    { letter: 'A', count: 100 },
                    { letter: 'B', count: 100 },
                ],
            },
            error: null,
        });
        const first = render(BrowsePage, { data: makePageData() } as never);
        await vi.waitFor(() =>
            expect(first.container.querySelector('.az-letter-rail')).not.toBeNull(),
        );
        const letter = [...first.container.querySelectorAll('.az-letter-rail button')].find(
            (button) => button.textContent?.trim() === 'B',
        )!;
        await fireEvent.click(letter);
        await first.unmount();
        mockGetAzBrowse.mockClear();
        setUrl('/browse');
        const fresh = render(BrowsePage, { data: makePageData() } as never);
        await vi.waitFor(() => expect(lastAzRequest()).toHaveProperty('letter', 'B'));
        const restored = [...fresh.container.querySelectorAll('.az-letter-rail button')].find(
            (button) => button.textContent?.trim() === 'B',
        )!;
        expect(restored.getAttribute('aria-pressed')).toBe('true');
    });

    test.each([
        [true, false],
        [false, true],
    ])(
        'preserves separate unknown flags (%s/%s) through layout changes and remount',
        async (languageUnknown, qualityUnknown) => {
            setupLibraries();
            saveBrowseSelection(
                'id:browse-user',
                new URLSearchParams({
                    mode: 'az',
                    layout: 'list',
                    includeUnknown: String(languageUnknown),
                    qUnknown: String(qualityUnknown),
                }),
            );
            setUrl('/browse');
            const first = render(BrowsePage, { data: makePageData() } as never);
            await vi.waitFor(() => expect(mockGetAzBrowse).toHaveBeenCalled());
            expect(lastAzRequest().includeUnknown ?? false).toBe(languageUnknown);
            expect(lastAzRequest().qualityIncludeUnknown ?? false).toBe(qualityUnknown);
            await fireEvent.click(
                first.container.querySelector('.view-switch button:first-child')!,
            );
            const saved = loadBrowseSelection('id:browse-user')!;
            expect(saved.get('includeUnknown')).toBe(String(languageUnknown));
            expect(saved.get('qUnknown')).toBe(String(qualityUnknown));
            await first.unmount();
            mockGetAzBrowse.mockClear();
            setUrl('/browse');
            const fresh = render(BrowsePage, { data: makePageData() } as never);
            await vi.waitFor(() => expect(mockGetAzBrowse).toHaveBeenCalled());
            expect(lastAzRequest().includeUnknown ?? false).toBe(languageUnknown);
            expect(lastAzRequest().qualityIncludeUnknown ?? false).toBe(qualityUnknown);
            expect(
                fresh.container
                    .querySelector('.view-switch button:first-child')!
                    .getAttribute('aria-pressed'),
            ).toBe('true');
        },
    );

    test('does not restore another user’s library or presentation', async () => {
        setupLibraries();
        seedSelection();
        setUrl('/browse', 'other-user');
        const data = makePageData();
        data.user.userId = 'other-user';
        const view = render(BrowsePage, { data } as never);
        expect(
            view.container
                .querySelector('.browse-modes button:first-child')!
                .getAttribute('aria-pressed'),
        ).toBe('true');
        expect(mockReplaceState).not.toHaveBeenCalled();
    });

    test('remembers a signed-in username when the layout has no userId', async () => {
        setupLibraries();
        const data = makePageData();
        data.user.userId = undefined;
        const first = render(BrowsePage, { data } as never);
        await vi.waitFor(() => expect(mockGetAzBrowse).toHaveBeenCalled());
        await chooseLibrary(first.container, '11111111-1111-4111-8111-111111111111');
        await first.unmount();
        mockGetAzBrowse.mockClear();
        setUrl('/browse');
        render(BrowsePage, { data } as never);
        await vi.waitFor(() =>
            expect(lastAzRequest()).toMatchObject({
                libraryGroupId: '11111111-1111-4111-8111-111111111111',
            }),
        );
    });

    test.each(['{invalid', '{"version":1,"selection":{}}'])(
        'falls back to legacy preferences for bad storage %s',
        async (raw) => {
            setupLibraries();
            setUrl('/browse');
            localStorage.setItem('browse-selection:v1:id%3Abrowse-user', raw);
            localStorage.setItem('browse-az-mode-preference', JSON.stringify({ enabled: true }));
            localStorage.setItem('browse-az-lang-filter', JSON.stringify({ audioLangs: ['de'] }));
            render(BrowsePage, { data: makePageData() } as never);
            await vi.waitFor(() => expect(lastAzRequest()).toMatchObject({ audio: ['de'] }));
            expect(lastAzRequest()).not.toHaveProperty('libraryGroupId');
        },
    );

    test('keeps actual controls usable when storage reads and writes throw', async () => {
        setupLibraries();
        setUrl('/browse');
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('quota');
        });
        try {
            const view = render(BrowsePage, { data: makePageData() } as never);
            await fireEvent.click(view.container.querySelector('#tab-az')!);
            await vi.waitFor(() => expect(mockGetAzBrowse).toHaveBeenCalled());
            await chooseLibrary(view.container, '11111111-1111-4111-8111-111111111111');
            await fireEvent.change(view.container.querySelector('.az-sort-select')!, {
                target: { value: 'year_desc' },
            });
            await choosePlayback(view.container, 0, LANGUAGE_LABELS.de);
            await vi.waitFor(() =>
                expect(lastAzRequest()).toMatchObject({
                    libraryGroupId: '11111111-1111-4111-8111-111111111111',
                    sort: 'year_desc',
                    audio: ['de'],
                }),
            );
            expect(mockReplaceState).toHaveBeenCalled();
        } finally {
            vi.restoreAllMocks();
        }
    });
});
