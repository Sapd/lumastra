// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';
import { tick } from 'svelte';
import Search from './Search.svelte';
import type { PlaylistAddItem, PlaylistAddOutcome } from '$lib/types/playlist';
import * as m from '$lib/paraglide/messages';
import type { SearchResultItem } from '$lib/api/content';
import type { executeSearchGroups, fetchSearchGroupPage } from '$lib/utils/search/search-execution';

const mocks = vi.hoisted(() => ({
    execute: vi.fn<typeof executeSearchGroups>(),
    open: vi.fn(),
    preference: vi.fn(),
    getPreference: vi.fn(),
    page: vi.fn<typeof fetchSearchGroupPage>(),
    programs: vi.fn(),
    modalOpen: vi.fn(),
    similar: vi.fn(),
    musicPlay: vi.fn(),
    musicMore: vi.fn(),
}));
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$app/paths', () => ({ base: '', resolve: (path: string): string => path }));
vi.mock('$app/navigation', () => ({ beforeNavigate: vi.fn(), goto: vi.fn() }));
vi.mock('$app/stores', () => ({
    page: writable({
        data: { user: { hasLiveTvPermission: false } },
        url: new URL('http://localhost/'),
    }),
}));
vi.mock('$lib/components/sections', async () => ({
    SectionRenderer: (await import('./__fixtures__/SearchRichCards.svelte')).default,
}));
vi.mock('$lib/components/media', async () => ({
    SeriesEpisodePicker: (await import('./__fixtures__/SearchPlaylistEpisodes.svelte')).default,
}));
vi.mock('$lib/paraglide/messages', async (original) => ({
    ...(await original<object>()),
    viewer_playlist_adding_item: () => 'Adding…',
    viewer_playlist_add_failed: () => 'Could not add this item. Try again.',
}));
vi.mock('$lib/stores/modal-registry.store', () => ({ getModalComponent: vi.fn() }));
vi.mock('$lib/stores/modal.store', () => ({
    modals: { open: mocks.modalOpen },
    hasModals: writable(false),
}));
vi.mock('$lib/api/content', () => ({
    getAvailableCategories: async () => ({ data: {} }),
    getSimilarMedia: mocks.similar,
}));
vi.mock('$lib/api/user', () => ({
    getSearchPreference: mocks.getPreference,
    updateSearchPreference: mocks.preference,
}));
vi.mock('$lib/api/ai', () => ({}));
vi.mock('$lib/api/livetv-playback', async (original) => ({
    ...(await original<object>()),
    searchPrograms: mocks.programs,
}));
vi.mock('$lib/utils/search/item-open-handlers', () => ({
    getItemOpenHandler: () => mocks.open,
    handleAudiobookOpen: vi.fn(),
}));
vi.mock('$lib/utils/music-item-handlers.svelte', () => ({
    createMusicItemHandlers: () => ({
        handleItemPlay: mocks.musicPlay,
        handleItemMore: mocks.musicMore,
    }),
}));
vi.mock('$lib/utils/search/search-execution', () => ({
    executeSearchGroups: mocks.execute,
    fetchSearchGroupPage: mocks.page,
}));

function makeItem(overrides: Partial<SearchResultItem> = {}): SearchResultItem {
    return {
        id: 'tmdb:1:movie',
        catalogId: null,
        type: 'movie',
        title: 'Test',
        ids: {},
        images: {},
        score: 0,
        ...overrides,
    };
}

function items(type: 'movie' | 'series', count: number): SearchResultItem[] {
    return Array.from({ length: count }, (_, i) =>
        makeItem({
            id: `${type}-${i}`,
            type,
            title: `${type} result ${i}`,
            ids: { tmdb: String(i + 1) },
        }),
    );
}

function sectionOrder(container: HTMLElement): string[] {
    return [...container.querySelectorAll<HTMLElement>('[data-search-category]')].map(
        (node) => node.dataset.searchCategory ?? '',
    );
}

beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.getPreference.mockResolvedValue({ data: { fulltextSearch: false } });
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.scrollTo = vi.fn();
    mocks.execute.mockImplementation(async (groups, _params, version, deliver, current) => {
        if (version !== current()) return;
        for (const group of groups)
            deliver({
                categories: group.categories,
                items: [
                    ...(group.categories.includes('movie') ? items('movie', 5) : []),
                    ...(group.categories.includes('tv') ? items('series', 4) : []),
                ],
            });
    });
});
afterEach(cleanup);

describe('search playlist additions', () => {
    async function open(
        onaddToPlaylist: (item: PlaylistAddItem) => Promise<PlaylistAddOutcome>,
        series = false,
    ) {
        const view = render(Search, {
            isOpen: true,
            playlistMode: true,
            playlistId: 1,
            debounceMs: 0,
            onaddToPlaylist,
        });
        await fireEvent.input(view.getByRole('textbox'), { target: { value: 'result' } });
        await waitFor(() => expect(view.getByText('movie result 0')).toBeTruthy());
        if (series) await fireEvent.click(view.getByText('series result 0'));
        return view;
    }

    it('waits for confirmation, rejects duplicate clicks and retries failures', async () => {
        let finish!: (outcome: PlaylistAddOutcome) => void;
        const add = vi
            .fn<(item: PlaylistAddItem) => Promise<PlaylistAddOutcome>>()
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finish = resolve;
                    }),
            )
            .mockResolvedValueOnce('added');
        const view = await open(add);
        const button = view.getByRole('button', { name: 'Add movie result 0' });
        await fireEvent.click(button);
        await fireEvent.click(button);
        expect(add).toHaveBeenCalledTimes(1);
        expect(view.queryByText('Confirmed movie result 0')).toBeNull();
        finish('failed');
        await waitFor(() => expect(view.getByRole('alert')).toBeTruthy());
        expect(view.queryByText('Confirmed movie result 0')).toBeNull();
        await fireEvent.click(view.getByRole('button', { name: m.common_retry() }));
        await waitFor(() => expect(view.getByText('Confirmed movie result 0')).toBeTruthy());
        expect(view.queryByRole('alert')).toBeNull();
    });

    it('treats a confirmed duplicate as already added', async () => {
        const view = await open(vi.fn().mockResolvedValue('duplicate'));
        await fireEvent.click(view.getByRole('button', { name: 'Add movie result 0' }));
        await waitFor(() => expect(view.getByText('Confirmed movie result 0')).toBeTruthy());
    });

    it('adds seasons sequentially, preserves successes and retries only failed episodes', async () => {
        const pending: Array<(outcome: PlaylistAddOutcome) => void> = [];
        const add = vi
            .fn<(item: PlaylistAddItem) => Promise<PlaylistAddOutcome>>()
            .mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
        const view = await open(add, true);
        await fireEvent.click(view.getByRole('button', { name: 'Add season' }));
        await fireEvent.click(view.getByRole('button', { name: 'Add season' }));
        expect(add).toHaveBeenCalledTimes(1);
        pending[0]('added');
        await waitFor(() => expect(add).toHaveBeenCalledTimes(2));
        expect(view.getByText('Confirmed Episode 1')).toBeTruthy();
        pending[1]('failed');
        await waitFor(() => expect(add).toHaveBeenCalledTimes(3));
        pending[2]('duplicate');
        await waitFor(() => expect(view.getByText('Confirmed Episode 3')).toBeTruthy());
        expect(view.queryByText('Confirmed Episode 2')).toBeNull();
        await fireEvent.click(view.getByRole('button', { name: m.common_retry() }));
        expect(add.mock.calls.at(-1)?.[0].episodeNumber).toBe(2);
        pending[3]('added');
        await waitFor(() => expect(view.getByText('Confirmed Episode 2')).toBeTruthy());
    });

    it.each(['query', 'close', 'playlist'])(
        'ignores late feedback and stops season submission after a %s change',
        async (change) => {
            let finish!: (outcome: PlaylistAddOutcome) => void;
            const add = vi
                .fn<(item: PlaylistAddItem) => Promise<PlaylistAddOutcome>>()
                .mockImplementation(
                    () =>
                        new Promise((resolve) => {
                            finish = resolve;
                        }),
                );
            const view = await open(add, true);
            await fireEvent.click(view.getByRole('button', { name: 'Add season' }));
            if (change === 'query')
                await fireEvent.input(view.getByRole('textbox'), { target: { value: 'other' } });
            else await view.rerender(change === 'close' ? { isOpen: false } : { playlistId: 2 });
            finish('failed');
            await tick();
            expect(add).toHaveBeenCalledTimes(1);
            expect(view.queryByRole('alert')).toBeNull();
            expect(view.queryByText('Confirmed Episode 1')).toBeNull();
        },
    );
});

describe('search popup', () => {
    it.each([false, true])(
        'connects Request to details even in watch-party mode=%s',
        async (watchPartyMode) => {
            mocks.execute.mockImplementation(async (_groups, _params, _version, deliver) => {
                deliver({
                    categories: ['movie'],
                    items: [
                        makeItem({
                            id: '10000000-0000-0000-0000-000000000001',
                            catalogId: '10000000-0000-0000-0000-000000000001',
                            availability: { isAvailable: false, canRequest: true },
                        }),
                    ],
                });
            });
            const onselectitem = vi.fn();
            const onclose = vi.fn();
            const view = render(Search, {
                isOpen: true,
                debounceMs: 0,
                watchPartyMode,
                onselectitem,
                onclose,
            });
            await fireEvent.input(view.getByRole('textbox'), { target: { value: 'result' } });
            await fireEvent.click(await view.findByRole('button', { name: 'Request Test' }));
            expect(mocks.open).toHaveBeenCalledWith(
                expect.objectContaining({ isAvailable: false, canRequest: true }),
                expect.anything(),
            );
            expect(onselectitem).not.toHaveBeenCalled();
            expect(onclose).not.toHaveBeenCalled();
        },
    );

    it('routes track Similar to the music handlers with its catalog UUID', async () => {
        const id = '10000000-0000-0000-0000-000000000001';
        mocks.execute.mockImplementation(async (_groups, _params, _version, deliver) => {
            deliver({
                categories: ['music'],
                items: [makeItem({ id, catalogId: id, type: 'track' })],
            });
        });
        const view = render(Search, { isOpen: true, debounceMs: 0 });
        await fireEvent.input(view.getByRole('textbox'), { target: { value: 'result' } });
        await fireEvent.click(await view.findByRole('button', { name: 'Similar to Test' }));
        expect(mocks.musicMore).toHaveBeenCalledWith(
            expect.objectContaining({
                item: expect.objectContaining({ id, mediaType: 'track' }),
            }),
        );
    });

    it.each(['track', 'album', 'artist'] as const)(
        'routes %s Play to the music handlers with its catalog UUID',
        async (type) => {
            const id = '10000000-0000-0000-0000-000000000001';
            mocks.execute.mockImplementation(async (_groups, _params, _version, deliver) => {
                deliver({
                    categories: ['music'],
                    items: [
                        makeItem({
                            id,
                            catalogId: id,
                            type,
                            availability: { isAvailable: true, canRequest: false },
                        }),
                    ],
                });
            });
            const view = render(Search, { isOpen: true, debounceMs: 0 });
            await fireEvent.input(view.getByRole('textbox'), { target: { value: 'result' } });
            await fireEvent.click(await view.findByRole('button', { name: 'Play Test' }));
            expect(mocks.musicPlay).toHaveBeenCalledWith(
                expect.objectContaining({
                    item: expect.objectContaining({ id, mediaType: type }),
                }),
            );
            expect(mocks.open).not.toHaveBeenCalled();
        },
    );

    it.each(['movie', 'series'] as const)(
        'opens AI Similar for a %s immediately and lets the modal fetch',
        async (mediaType) => {
            // A pending API call must not delay opening the dialog.
            mocks.similar.mockImplementation(() => new Promise(() => {}));
            const view = render(Search, { isOpen: true, debounceMs: 0 });
            await fireEvent.input(view.getByRole('textbox'), { target: { value: 'result' } });
            const button = await view.findByRole('button', {
                name: `Similar to ${mediaType} result 0`,
            });
            await fireEvent.click(button);
            expect(mocks.modalOpen).toHaveBeenCalledWith(undefined, {
                sourceMedia: {
                    externalIds: expect.objectContaining({ tmdb: '1' }),
                    name: `${mediaType} result 0`,
                    type: mediaType === 'series' ? 'tv' : 'movie',
                },
                similar: [],
                loading: true,
            });
            expect(mocks.similar).not.toHaveBeenCalled();
        },
    );

    it('excludes cached other categories and their hasMore from filtered counts', async () => {
        mocks.execute.mockImplementation(async (_groups, _params, _version, deliver) => {
            deliver({ categories: ['movie'], items: items('movie', 5), hasMore: false });
            deliver({ categories: ['tv'], items: items('series', 4), hasMore: true });
        });
        const view = render(Search, { isOpen: true, debounceMs: 0 });
        await fireEvent.input(view.getByRole('textbox'), { target: { value: 'result' } });
        await waitFor(() => expect(view.getByText('series result 0')).toBeTruthy());
        await fireEvent.click(view.getByRole('button', { name: /View all Movies/i }));
        await waitFor(() =>
            expect(view.container.querySelector('[data-search-footer]')?.textContent).toContain(
                m.search_results_count({ count: 5 }),
            ),
        );
        expect(view.container.querySelector('[data-search-footer]')?.textContent).not.toContain(
            '+',
        );
        expect(view.queryByText('series result 0')).toBeNull();
    });

    it.each([false, true])(
        'shows loaded counts beyond previews, with hasMore=%s',
        async (hasMore) => {
            mocks.execute.mockImplementation(async (_groups, _params, _version, deliver) => {
                deliver({ categories: ['movie'], items: items('movie', 5), hasMore });
            });
            const view = render(Search, { isOpen: true, debounceMs: 0 });
            await fireEvent.input(view.getByRole('textbox'), { target: { value: 'result' } });
            await waitFor(() =>
                expect(view.container.querySelectorAll('[data-search-item-id]')).toHaveLength(3),
            );
            expect(
                view.getByRole('heading', { name: `Movies 5${hasMore ? '+' : ''}` }),
            ).toBeTruthy();
            const footer = view.container.querySelector('[data-search-footer]');
            expect(footer?.textContent).toContain(
                m.search_results_count({ count: `5${hasMore ? '+' : ''}` }),
            );
            expect(footer?.querySelectorAll('kbd')).toHaveLength(3);
            expect(view.container.querySelector('details')).toBeNull();
            expect(
                view.queryByRole('button', {
                    name: m.search_result_details({ title: 'movie result 0' }),
                }),
            ).toBeNull();
        },
    );

    it('requests each category separately, so hasMore and counts stay per category', async () => {
        mocks.execute.mockImplementation(async (groups, _params, _version, deliver) => {
            for (const group of groups)
                deliver({
                    categories: group.categories,
                    items: group.categories.includes('movie')
                        ? items('movie', 1)
                        : group.categories.includes('tv')
                          ? items('series', 4)
                          : [],
                    hasMore: group.categories.includes('tv'),
                });
        });
        const view = render(Search, { isOpen: true, debounceMs: 0 });
        await fireEvent.input(view.getByRole('textbox'), { target: { value: 'result' } });
        await waitFor(() =>
            expect(view.getByRole('textbox').getAttribute('aria-busy')).toBe('false'),
        );
        expect(mocks.execute.mock.calls[0][0].every((g) => g.categories.length === 1)).toBe(true);
        const chips = view.getByRole('navigation', { name: m.search_filtering() });
        const chip = (label: string) =>
            [...chips.querySelectorAll('button')].find((b) =>
                b.querySelector('.category-label')?.textContent?.includes(label),
            )!;
        expect(chip('Movies').textContent).toMatch(/Movies\s*1$/);
        expect(chip('Series').textContent).toMatch(/Series\s*4\+$/);
        // A settled category without results is dimmed and shows no "0".
        expect(chip('Episodes').classList.contains('empty')).toBe(true);
        expect(chip('Episodes').querySelector('.count')).toBeNull();
        expect(chip('Movies').classList.contains('empty')).toBe(false);
    });

    it('renders synopsis and playlist actions before keyboard selection', async () => {
        mocks.execute.mockImplementation(async (_groups, _params, _version, deliver) => {
            deliver({
                categories: ['movie'],
                items: [{ ...items('movie', 1)[0], overview: 'A journey through deep space.' }],
            });
        });
        const view = render(Search, { isOpen: true, debounceMs: 0, playlistMode: true });
        await fireEvent.input(view.getByRole('textbox'), { target: { value: 'result' } });
        await waitFor(() => expect(view.getByText('A journey through deep space.')).toBeTruthy());
        expect(view.getByRole('button', { name: 'Add movie result 0' })).toBeTruthy();
        const openButton = view.getByRole('button', { name: m.search_open() });
        expect(openButton.querySelector('svg')).toBeTruthy();
        expect(openButton.textContent?.trim()).toBe('');
        const row = view.container.querySelector('[data-search-item-id]');
        expect(row?.classList.contains('selected')).toBe(false);
        await fireEvent.keyDown(view.getByRole('textbox'), { key: 'ArrowDown' });
        expect(row?.classList.contains('selected')).toBe(true);
        expect(view.getByText('A journey through deep space.')).toBeTruthy();
    });

    it('moves the single filter navigation from the empty prompt to above results', async () => {
        const view = render(Search, { isOpen: true, debounceMs: 0 });
        const region = view.getByRole('region', { name: m.common_search() });
        expect(view.getAllByRole('navigation')).toHaveLength(1);
        expect(region.contains(view.getByRole('navigation'))).toBe(true);
        await fireEvent.input(view.getByRole('textbox'), { target: { value: 'result' } });
        await waitFor(() => expect(view.getByText('movie result 0')).toBeTruthy());
        expect(view.getAllByRole('navigation')).toHaveLength(1);
        expect(region.contains(view.getByRole('navigation'))).toBe(false);
        await fireEvent.click(view.getAllByRole('button', { name: m.search_open() })[0]);
        expect(mocks.open.mock.calls[0]?.[0].title).toBe('movie result 0');
    });

    it('dispatches titles at 150ms idle and descriptions at 400ms idle', async () => {
        vi.useFakeTimers();
        try {
            mocks.getPreference.mockResolvedValue({ data: { fulltextSearch: true } });
            const view = render(Search, { isOpen: true });
            await tick();
            await fireEvent.input(view.getByRole('textbox'), { target: { value: 'spaceship' } });
            await vi.advanceTimersByTimeAsync(149);
            expect(mocks.execute).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(mocks.execute).toHaveBeenCalledTimes(1);
            expect(mocks.execute.mock.calls[0][1].fulltextMode).toBe(false);
            await vi.advanceTimersByTimeAsync(249);
            expect(mocks.execute).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(mocks.execute).toHaveBeenCalledTimes(2);
            expect(mocks.execute.mock.calls[1][1].fulltextMode).toBe(true);
        } finally {
            cleanup();
            vi.useRealTimers();
        }
    });

    it('does not let a high-ranked description hit steal relevance scrolling from a title hit', async () => {
        mocks.getPreference.mockResolvedValue({ data: { fulltextSearch: true } });
        mocks.execute.mockImplementation(async (_groups, params, _version, deliver) => {
            if (params.fulltextMode)
                deliver({
                    categories: ['movie'],
                    items: [
                        {
                            ...items('movie', 1)[0],
                            title: 'Quiet Orbit',
                            reason: { kind: 'overview' },
                            score: 1000,
                        },
                    ],
                });
            else
                deliver({
                    categories: ['tv'],
                    items: [
                        {
                            ...items('series', 1)[0],
                            title: 'Space Station',
                            reason: { kind: 'title' },
                            score: 0.1,
                        },
                    ],
                });
        });
        const view = render(Search, { isOpen: true, debounceMs: 0 });
        await waitFor(() =>
            expect(
                view.getByRole('button', { name: m.search_include_descriptions(), pressed: true }),
            ).toBeTruthy(),
        );
        await fireEvent.input(view.getByRole('textbox'), { target: { value: 'space stat' } });
        await waitFor(() => expect(view.getByText('Quiet Orbit')).toBeTruthy());
        await waitFor(() => expect(sectionOrder(view.container)[0]).toBe('tv'));
        expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    });
    it('loads titles first, adds descriptions later, and reuses both sets across toggles', async () => {
        mocks.getPreference.mockResolvedValue({ data: { fulltextSearch: true } });
        const extra: SearchResultItem = {
            ...items('movie', 1)[0],
            id: 'description-only',
            title: 'Quiet Orbit',
            overview: 'A spaceship arrives.',
            reason: { kind: 'overview' },
        };
        mocks.execute.mockImplementation(async (groups, params, version, deliver, current) => {
            if (version !== current()) return;
            for (const group of groups)
                deliver({
                    categories: group.categories,
                    items: group.categories.includes('movie')
                        ? params.fulltextMode
                            ? [...items('movie', 1), extra]
                            : items('movie', 1)
                        : [],
                });
        });
        const view = render(Search, { isOpen: true, debounceMs: 0 });
        await waitFor(() =>
            expect(
                view.getByRole('button', { name: m.search_include_descriptions(), pressed: true }),
            ).toBeTruthy(),
        );
        await fireEvent.input(view.getByRole('textbox'), { target: { value: 'spaceship' } });
        await waitFor(() => expect(view.getByText('movie result 0')).toBeTruthy());
        expect(mocks.execute).toHaveBeenCalledTimes(1);
        expect(mocks.execute.mock.calls[0][1].fulltextMode).toBe(false);
        const toggle = view.getByRole('button', { name: m.search_include_descriptions() });
        expect(toggle.getAttribute('aria-busy')).toBe('true');
        expect(
            toggle.contains(view.getByRole('status', { name: m.search_descriptions_loading() })),
        ).toBe(true);
        await waitFor(() => expect(view.getByText('Quiet Orbit')).toBeTruthy());
        expect(view.getByText('A spaceship arrives.')).toBeTruthy();
        expect(mocks.execute.mock.calls[1][0].map((g) => g.types)).toEqual([
            'movie',
            'tv',
            'episode',
            'audiobook',
        ]);
        expect(view.container.querySelectorAll('[data-search-item-id]')).toHaveLength(2);
        vi.mocked(Element.prototype.scrollTo).mockClear();
        await fireEvent.click(view.getByRole('button', { name: m.search_include_descriptions() }));
        expect(view.queryByText('Quiet Orbit')).toBeNull();
        expect(view.getByText('movie result 0')).toBeTruthy();
        await fireEvent.click(view.getByRole('button', { name: m.search_include_descriptions() }));
        expect(view.getByText('Quiet Orbit')).toBeTruthy();
        expect(mocks.execute).toHaveBeenCalledTimes(2);
        expect(Element.prototype.scrollTo).not.toHaveBeenCalled();
    });

    it('ignores a description response after switching off without losing primary results', async () => {
        let finish: (() => void) | undefined;
        mocks.execute.mockImplementation((groups, params, version, deliver, current) => {
            if (!params.fulltextMode) {
                for (const group of groups)
                    deliver({
                        categories: group.categories,
                        items: group.categories.includes('movie') ? items('movie', 1) : [],
                    });
                return Promise.resolve();
            }
            return new Promise<void>((resolve) => {
                finish = () => {
                    if (version === current())
                        deliver({
                            categories: ['movie'],
                            items: [
                                {
                                    ...items('movie', 1)[0],
                                    id: 'stale',
                                    title: 'Stale description',
                                    reason: { kind: 'overview' },
                                },
                            ],
                        });
                    resolve();
                };
            });
        });
        const view = render(Search, { isOpen: true, debounceMs: 0 });
        await fireEvent.input(view.getByRole('textbox'), { target: { value: 'result' } });
        await waitFor(() => expect(view.getByText('movie result 0')).toBeTruthy());
        await fireEvent.click(view.getByRole('button', { name: m.search_include_descriptions() }));
        await waitFor(() => expect(finish).toBeTypeOf('function'));
        await fireEvent.click(view.getByRole('button', { name: m.search_include_descriptions() }));
        finish?.();
        expect(view.queryByText('Stale description')).toBeNull();
        expect(view.getByText('movie result 0')).toBeTruthy();
        expect(mocks.execute).toHaveBeenCalledTimes(2);
    });

    it('paginates from the description page offset rather than the merged result count', async () => {
        mocks.getPreference.mockResolvedValue({ data: { fulltextSearch: true } });
        mocks.execute.mockImplementation(async (groups, params, _version, deliver) => {
            for (const group of groups)
                deliver({
                    categories: group.categories,
                    hasMore: true,
                    items: group.categories.includes('movie')
                        ? [
                              {
                                  ...items('movie', 1)[0],
                                  id: params.fulltextMode ? 'description' : 'primary',
                                  title: params.fulltextMode
                                      ? 'Description result'
                                      : 'Primary result',
                                  reason: { kind: params.fulltextMode ? 'overview' : 'title' },
                              },
                          ]
                        : [],
                });
        });
        mocks.page.mockResolvedValue({ categories: ['movie'], items: [], hasMore: false });
        const view = render(Search, { isOpen: true, debounceMs: 0, restrictToTypes: 'movie' });
        await waitFor(() =>
            expect(
                view.getByRole('button', { name: m.search_include_descriptions(), pressed: true }),
            ).toBeTruthy(),
        );
        await fireEvent.input(view.getByRole('textbox'), { target: { value: 'result' } });
        await waitFor(() => expect(view.getByText('Description result')).toBeTruthy());
        await fireEvent.click(view.getByRole('button', { name: /View all Movies/i }));
        await waitFor(() => expect(view.getByText('Description result')).toBeTruthy());
        const more = view.getByRole('button', { name: /Load more/i });
        await fireEvent.click(more);
        await waitFor(() => expect(mocks.page).toHaveBeenCalled());
        expect(mocks.page.mock.calls[0][1]).toMatchObject({ offset: 1, fulltextMode: true });
    });
    it('shows a single persistent filter row and labeled preference', async () => {
        const view = render(Search, { isOpen: true });
        expect(view.getAllByRole('navigation')).toHaveLength(1);
        expect(view.getByRole('button', { name: m.close() })).toBeTruthy();
        const toggle = view.getByRole('button', {
            name: m.search_include_descriptions(),
        });
        await waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe('false'));
        expect(toggle.title).toBe(m.search_include_descriptions());
        expect(toggle.parentElement?.contains(view.getByRole('textbox'))).toBe(true);
        await fireEvent.click(toggle);
        expect(toggle.getAttribute('aria-pressed')).toBe('true');
        expect(mocks.preference).toHaveBeenCalledWith({ fulltextSearch: true });
        expect(view.container.querySelector('details')?.open).toBe(false);
    });

    it('shows loading during debounce, previews three per category, and expands a category', async () => {
        const view = render(Search, { isOpen: true, debounceMs: 100 });
        await fireEvent.input(view.getByRole('textbox'), { target: { value: 'result' } });
        expect(view.queryByText(m.search_no_results_for({ query: 'result' }))).toBeNull();
        expect(view.getByRole('textbox').getAttribute('aria-busy')).toBe('true');
        await waitFor(() =>
            expect(view.container.querySelectorAll('[data-search-item-id]')).toHaveLength(6),
        );
        const category = view.getByRole('button', { name: /View all Movies/i });
        await fireEvent.click(category);
        await waitFor(() =>
            expect(view.container.querySelectorAll('[data-search-item-id]')).toHaveLength(5),
        );
        expect(view.queryByText('series result 0')).toBeNull();
    });

    it('navigates only visible results and opens the selected result on Enter', async () => {
        const view = render(Search, { isOpen: true, debounceMs: 0 });
        const input = view.getByRole('textbox');
        await fireEvent.input(input, { target: { value: 'result' } });
        await waitFor(() =>
            expect(view.container.querySelectorAll('[data-search-item-id]')).toHaveLength(6),
        );
        for (let i = 0; i < 4; i++) await fireEvent.keyDown(input, { key: 'ArrowDown' });
        await fireEvent.keyDown(input, { key: 'Enter' });
        expect(mocks.open.mock.calls[0]?.[0].title).toBe('series result 0');
    });

    it('limits catalog operators to sources that can apply them', async () => {
        const view = render(Search, { isOpen: true, debounceMs: 0 });
        await fireEvent.input(view.getByRole('textbox'), {
            target: { value: 'year:2020 genre:action' },
        });
        await waitFor(() => expect(mocks.execute).toHaveBeenCalled());
        expect(mocks.execute.mock.calls[0][0]).toEqual([
            { types: 'movie', categories: ['movie'] },
            { types: 'tv', categories: ['tv'] },
        ]);
    });

    it('keeps IME composition keys inside the input', async () => {
        const onclose = vi.fn();
        const view = render(Search, { isOpen: true, debounceMs: 0, onclose });
        const input = view.getByRole('textbox');
        await fireEvent.input(input, { target: { value: 'result' } });
        await waitFor(() =>
            expect(view.container.querySelectorAll('[data-search-item-id]')).toHaveLength(6),
        );
        await fireEvent.keyDown(input, { key: 'ArrowDown' });
        await fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
        await fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
        expect(mocks.open).not.toHaveBeenCalled();
        expect(onclose).not.toHaveBeenCalled();
    });

    it('preserves successful results when another category fails', async () => {
        mocks.execute.mockImplementation(async (_groups, _params, _version, deliver) => {
            deliver({ categories: ['movie'], items: items('movie', 2) });
            deliver({ categories: ['tv'], items: [], failed: true });
        });
        const view = render(Search, { isOpen: true, debounceMs: 0 });
        await fireEvent.input(view.getByRole('textbox'), { target: { value: 'result' } });
        await waitFor(() => expect(view.getByText('movie result 0')).toBeTruthy());
        expect(view.getByRole('alert').textContent).toContain(m.browse_filter_search_error());
    });

    it('shows a retryable failure instead of claiming there are no matches', async () => {
        mocks.execute.mockImplementation(async (groups, _params, _version, deliver) => {
            for (const group of groups)
                deliver({ categories: group.categories, items: [], failed: true });
        });
        const view = render(Search, { isOpen: true, debounceMs: 0 });
        await fireEvent.input(view.getByRole('textbox'), { target: { value: 'result' } });
        await waitFor(() =>
            expect(view.getByRole('alert').textContent).toContain(m.browse_filter_search_error()),
        );
        expect(view.queryByText(m.search_no_results_for({ query: 'result' }))).toBeNull();
        mocks.execute.mockImplementation(async (_groups, _params, _version, deliver) => {
            deliver({ categories: ['movie'], items: items('movie', 2) });
        });
        await fireEvent.click(view.getByRole('button', { name: m.common_retry() }));
        await waitFor(() => expect(view.getByText('movie result 0')).toBeTruthy());
        expect(view.queryByRole('alert')).toBeNull();
    });

    it('closes on Escape from a filter, not just the input', async () => {
        const onclose = vi.fn();
        const view = render(Search, { isOpen: true, onclose });
        await fireEvent.keyDown(view.getByRole('button', { name: m.search_all_categories() }), {
            key: 'Escape',
        });
        expect(onclose).toHaveBeenCalledOnce();
    });

    it('invalidates an in-flight query immediately when cleared', async () => {
        let finish: (() => void) | undefined;
        mocks.execute.mockImplementation(
            (_groups, _params, version, deliver, current) =>
                new Promise<void>((resolve) => {
                    finish = () => {
                        if (version === current())
                            deliver({ categories: ['movie'], items: items('movie', 2) });
                        resolve();
                    };
                }),
        );
        const view = render(Search, { isOpen: true, debounceMs: 0 });
        await fireEvent.input(view.getByRole('textbox'), { target: { value: 'old' } });
        await waitFor(() => expect(finish).toBeTypeOf('function'));
        await fireEvent.click(view.getByRole('button', { name: m.btn_clear_search() }));
        finish?.();
        await waitFor(() =>
            expect(view.getByRole('textbox').getAttribute('aria-busy')).toBe('false'),
        );
        expect(view.container.querySelectorAll('[data-search-item-id]')).toHaveLength(0);
    });

    it('offers recovery after a genuinely empty search', async () => {
        mocks.execute.mockImplementation(async (groups, _params, _version, deliver) => {
            for (const group of groups) deliver({ categories: group.categories, items: [] });
        });
        const view = render(Search, { isOpen: true, debounceMs: 0 });
        await fireEvent.input(view.getByRole('textbox'), { target: { value: 'nothing' } });
        await waitFor(() => expect(view.getByText(m.search_recovery_hint())).toBeTruthy());
        expect(view.container.querySelector('[data-search-footer]')?.textContent).toContain(
            m.search_results_count({ count: '0' }),
        );
        expect(view.queryByText(m.search_tips())).toBeNull();
        expect(view.getAllByRole('button', { name: m.search_include_descriptions() })).toHaveLength(
            2,
        );
    });

    it.each([false, true])(
        'reveals a late stronger match unless the user interacted: %s',
        async (interacted) => {
            let finish: (() => void) | undefined;
            mocks.execute.mockImplementation(
                (_groups, _params, _version, deliver) =>
                    new Promise<void>((resolve) => {
                        deliver({
                            categories: ['movie'],
                            items: [{ ...items('movie', 1)[0], title: 'A result story', score: 3 }],
                        });
                        finish = () => {
                            deliver({
                                categories: ['tv'],
                                items: [{ ...items('series', 1)[0], title: 'result', score: 0.1 }],
                            });
                            resolve();
                        };
                    }),
            );
            const view = render(Search, { isOpen: true, debounceMs: 0 });
            await fireEvent.input(view.getByRole('textbox'), { target: { value: 'result' } });
            await waitFor(() => expect(finish).toBeTypeOf('function'));
            const resultContainer = view.container.querySelector('.overflow-y-auto')!;
            if (interacted) await fireEvent.wheel(resultContainer);
            finish?.();
            await waitFor(() =>
                expect(view.getByRole('textbox').getAttribute('aria-busy')).toBe('false'),
            );
            // The stronger late match moves to the top instead of being scrolled
            // to, so the earlier categories stay visible below it.
            if (interacted) expect(sectionOrder(view.container)).toEqual(['movie', 'tv']);
            else await waitFor(() => expect(sectionOrder(view.container)).toEqual(['tv', 'movie']));
            expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
        },
    );

    it('preserves the watch-party selection callback', async () => {
        const onselectitem = vi.fn();
        const view = render(Search, {
            isOpen: true,
            watchPartyMode: true,
            onselectitem,
            debounceMs: 0,
        });
        await fireEvent.input(view.getByRole('textbox'), { target: { value: 'result' } });
        await waitFor(() =>
            expect(view.getByRole('button', { name: /^movie result 0/ })).toBeTruthy(),
        );
        await fireEvent.click(view.getByRole('button', { name: /^movie result 0/ }));
        expect(onselectitem).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'movie result 0', mediaType: 'movie' }),
        );
        expect(mocks.open).not.toHaveBeenCalled();
    });

    it('keeps the selected result stable when an earlier category arrives', async () => {
        let finish: (() => void) | undefined;
        mocks.execute.mockImplementation(
            (_groups, _params, _version, deliver) =>
                new Promise<void>((resolve) => {
                    deliver({ categories: ['tv'], items: items('series', 2) });
                    finish = () => {
                        deliver({ categories: ['movie'], items: items('movie', 2) });
                        resolve();
                    };
                }),
        );
        const view = render(Search, { isOpen: true, debounceMs: 0 });
        const input = view.getByRole('textbox');
        await fireEvent.input(input, { target: { value: 'result' } });
        await waitFor(() => expect(finish).toBeTypeOf('function'));
        await fireEvent.keyDown(input, { key: 'ArrowDown' });
        finish?.();
        await waitFor(() => expect(input.getAttribute('aria-busy')).toBe('false'));
        await fireEvent.keyDown(input, { key: 'Enter' });
        expect(mocks.open.mock.calls[0]?.[0].title).toBe('series result 0');
    });

    it('keeps restricted playlist search requests within the requested types', async () => {
        const view = render(Search, {
            isOpen: true,
            playlistMode: true,
            restrictToTypes: 'movie',
            debounceMs: 0,
        });
        await fireEvent.input(view.getByRole('textbox'), { target: { value: 'result' } });
        await waitFor(() => expect(mocks.execute).toHaveBeenCalled());
        expect(mocks.execute.mock.calls[0]?.[0]).toEqual([
            { types: 'movie', categories: ['movie'] },
        ]);
        expect(view.queryByRole('button', { name: /Series/ })).toBeNull();
    });
});

describe('search category chips', () => {
    function chip(label: string): HTMLButtonElement {
        const nav = screen.getByRole('navigation', { name: m.search_filtering() });
        return [...nav.querySelectorAll<HTMLButtonElement>('button')].find(
            (b) => b.querySelector('.category-label')?.textContent?.trim() === label,
        )!;
    }
    const lastGroups = () => mocks.execute.mock.calls.at(-1)?.[0].map((g) => g.types);

    afterEach(() => history.replaceState(null, '', '/'));

    it('combines chips: Movies + Series searches both, unpressing one keeps the other', async () => {
        const view = render(Search, { isOpen: true, debounceMs: 0 });
        await fireEvent.input(view.getByRole('textbox'), { target: { value: 'result' } });
        await waitFor(() => expect(view.getByText('series result 0')).toBeTruthy());

        await fireEvent.click(chip('Movies'));
        await fireEvent.click(chip('Series'));
        expect(chip('Movies').getAttribute('aria-pressed')).toBe('true');
        expect(chip('Series').getAttribute('aria-pressed')).toBe('true');
        await waitFor(() => expect(lastGroups()).toEqual(['movie', 'tv']));
        // Both selected categories show their full lists (no 3-item preview).
        await waitFor(() =>
            expect(view.container.querySelectorAll('[data-search-item-id]')).toHaveLength(9),
        );
        expect(JSON.parse(localStorage.getItem('lumastra:search-category-filters:v1')!)).toEqual([
            'movie',
            'tv',
        ]);

        await fireEvent.click(chip('Movies'));
        expect(chip('Movies').getAttribute('aria-pressed')).toBe('false');
        expect(chip('Series').getAttribute('aria-pressed')).toBe('true');
        await waitFor(() => expect(lastGroups()).toEqual(['tv']));

        // Unpressing the last chip goes back to "all categories".
        await fireEvent.click(chip('Series'));
        expect(
            view
                .getByRole('button', { name: m.search_all_categories() })
                .getAttribute('aria-pressed'),
        ).toBe('true');
        await waitFor(() => expect(lastGroups()).toContain('episode'));
    });

    it('opens a shared ?q=&types= link with those chips and keeps the URL in step', async () => {
        history.replaceState(null, '', '/?q=result&types=movie,series');
        const view = render(Search, { syncToUrl: true, debounceMs: 0 });
        await waitFor(() => expect(view.getByText('series result 0')).toBeTruthy());
        expect(chip('Movies').getAttribute('aria-pressed')).toBe('true');
        expect(chip('Series').getAttribute('aria-pressed')).toBe('true');
        expect(lastGroups()).toEqual(['movie', 'tv']);

        await fireEvent.click(chip('Movies'));
        expect(new URL(window.location.href).searchParams.get('types')).toBe('series');
        await fireEvent.click(chip('Episodes'));
        expect(new URL(window.location.href).searchParams.get('types')).toBe('episode,series');
        await fireEvent.click(view.getByRole('button', { name: m.search_all_categories() }));
        expect(new URL(window.location.href).searchParams.has('types')).toBe(false);
        expect(new URL(window.location.href).searchParams.get('q')).toBe('result');
    });

    it('ignores unknown types in a shared link', async () => {
        history.replaceState(null, '', '/?q=result&types=bogus,series');
        const view = render(Search, { syncToUrl: true, debounceMs: 0 });
        await waitFor(() => expect(view.getByText('series result 0')).toBeTruthy());
        expect(lastGroups()).toEqual(['tv']);
    });
});
