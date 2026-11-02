// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';
import * as m from '$lib/paraglide/messages';

vi.mock('$app/stores', () => ({
    page: readable({ data: {}, url: new URL('http://localhost/') }),
}));
vi.mock('$lib/paraglide/runtime', () => ({
    getLocale: () => 'en',
    setLocale: vi.fn(),
    locales: ['en', 'de'],
    isLocale: (v: string) => v === 'en' || v === 'de',
    experimentalStaticLocale: null,
}));

const { getSeriesSeasons, getSeriesEpisodes } = vi.hoisted(() => ({
    getSeriesSeasons: vi.fn(),
    getSeriesEpisodes: vi.fn(),
}));
vi.mock('$lib/components/player/preferences-sync.svelte', () => ({
    playbackPreferences: { showEpisodeLanguages: true, ready: true },
    initializePreferences: vi.fn(async () => {}),
}));
vi.mock('$lib/api/content', () => ({ getSeriesSeasons, getSeriesEpisodes }));

/**
 * Minimal Svelte-store-contract stub. Hand-rolled rather than `writable()`
 * because vi.hoisted factories run before module imports resolve.
 *
 * `hasModals` must be provided too: media-hover-coordinator imports it from this
 * same module, so mocking the module replaces that export as well.
 */
const { modalCountStore } = vi.hoisted(() => {
    let value = 0;
    const subs = new Set<(v: number) => void>();
    return {
        modalCountStore: {
            subscribe(fn: (v: number) => void): () => void {
                subs.add(fn);
                fn(value);
                return () => {
                    subs.delete(fn);
                };
            },
            set(v: number): void {
                value = v;
                for (const fn of subs) fn(value);
            },
        },
    };
});

vi.mock('$lib/stores/modal.store', () => ({
    modalCount: modalCountStore,
    hasModals: {
        subscribe(fn: (v: boolean) => void): () => void {
            fn(false);
            return () => {};
        },
    },
}));

import SeriesEpisodePicker from './SeriesEpisodePicker.svelte';

// Keep the real user API functions: verify which HTTP operation and row ID
// the component actually sends, not a duplicate implementation in a callback.
const { apiPost, apiDelete, toastError } = vi.hoisted(() => ({
    apiPost: vi.fn(),
    apiDelete: vi.fn(),
    toastError: vi.fn(),
}));
vi.mock('$lib/api/client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/api/client')>()),
    apiPost,
    apiDelete,
}));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { error: toastError } }));
beforeEach(() => {
    apiPost.mockReset().mockResolvedValue({ data: { watched: true }, error: null });
    apiDelete.mockReset().mockResolvedValue({ data: { watched: false }, error: null });
    toastError.mockClear();
});

describe('SeriesEpisodePicker watched persistence', () => {
    afterEach(() => cleanup());

    async function setup(played = false, onwatchedChange = vi.fn()) {
        getSeriesSeasons.mockResolvedValue({
            data: {
                items: [1, 2].map((n) => ({
                    id: `season-${n}`,
                    title: `Season ${n}`,
                    seasonNumber: n,
                    episodeCount: 2,
                    watchedCount: played ? 2 : 0,
                    images: {},
                    episodes: { href: '/api/series/series-1/episodes?season=' + n },
                })),
            },
            error: null,
        });
        getSeriesEpisodes.mockImplementation((_id: string, season: number) =>
            Promise.resolve({
                data: {
                    items: [9, 10].map((number) => ({
                        id: `episode-${season}-${number}`,
                        title: `S${season} E${number}`,
                        context: { seasonNumber: season, episodeNumber: number },
                        availability: { isAvailable: true, canRequest: false, hasFile: true },
                        progress: {
                            finished: played,
                            fraction: 0 / 100,
                            positionMs: 0 / 10000,
                            durationMs: null,
                            updatedAt: null,
                        },
                        images: {},
                        audioLanguages: ['jpn'],
                        subtitleLanguages: ['deu'],
                    })),
                },
                error: null,
            }),
        );
        const rendered = render(SeriesEpisodePicker, {
            series: { id: 'series-1' },
            inline: true,
            onwatchedChange,
        });
        await screen.findByText('S1 E10');
        return { ...rendered, onwatchedChange };
    }

    function button(title = 'S1 E10'): HTMLButtonElement {
        const row = screen.getByText(title).closest('.episode-item');
        const toggle = row?.querySelector<HTMLButtonElement>('button[aria-pressed]');
        if (!toggle) throw new Error(`Missing watched button for ${title}`);
        return toggle;
    }

    async function selectSeason(container: HTMLElement, number: number): Promise<void> {
        await fireEvent.click(container.querySelector('[aria-haspopup="listbox"]')!);
        const option = screen
            .getAllByRole('option')
            .find((el) => el.textContent?.includes(`Season ${number}`));
        if (!option) throw new Error('Missing season option');
        await fireEvent.click(option);
        await screen.findByText(`S${number} E10`);
    }

    test('shows episode audio and subtitle languages from the preview response', async () => {
        await setup();
        expect(screen.getAllByText('JA').length).toBeGreaterThan(0);
        expect(screen.getAllByText('DE').length).toBeGreaterThan(0);
    });

    test('Escape closes the season menu without reaching the enclosing modal', async () => {
        const { container } = await setup();
        const trigger = container.querySelector('[aria-haspopup="listbox"]')!;
        await fireEvent.click(trigger);
        const parentEscape = vi.fn();
        window.addEventListener('keydown', parentEscape);
        try {
            await fireEvent.keyDown(trigger, { key: 'Escape' });
            expect(screen.queryByRole('listbox')).toBeNull();
            expect(parentEscape).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener('keydown', parentEscape);
        }
    });

    test('failed season requests clear stale episodes and retry the selected season', async () => {
        const { container } = await setup();
        getSeriesEpisodes.mockResolvedValueOnce({ data: null, error: 'offline' });
        await fireEvent.click(container.querySelector('[aria-haspopup="listbox"]')!);
        await fireEvent.click(screen.getByRole('option', { name: /Season 2/ }));
        await screen.findByText('Could not load episodes');
        expect(screen.queryByText('S1 E10')).toBeNull();
        await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await screen.findByText('S2 E10');
        expect(getSeriesEpisodes).toHaveBeenLastCalledWith('series-1', 2, expect.anything());
    });

    test('changing series reloads episodes instead of retaining the previous series', async () => {
        const { rerender } = await setup();
        getSeriesEpisodes.mockResolvedValue({
            data: {
                items: [
                    {
                        id: 'different-episode',
                        title: 'Different series episode',
                        context: { seasonNumber: 1, episodeNumber: 1 },
                        availability: { isAvailable: true, canRequest: false, hasFile: true },
                        progress: {
                            finished: false,
                            fraction: 0 / 100,
                            positionMs: 0 / 10000,
                            durationMs: null,
                            updatedAt: null,
                        },
                        images: {},
                    },
                ],
            },
            error: null,
        });
        await rerender({ series: { id: 'series-2' } });
        await screen.findByText('Different series episode');
        expect(screen.queryByText('S1 E10')).toBeNull();
        expect(getSeriesSeasons).toHaveBeenLastCalledWith('series-2');
    });

    test('ignores seasons that finish after a newer series has loaded', async () => {
        const { rerender } = await setup();
        let finish!: (value: { data: { items: never[] }; error: null }) => void;
        getSeriesSeasons.mockReturnValueOnce(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        await rerender({ series: { id: 'slow-series' } });
        await waitFor(() => expect(getSeriesSeasons).toHaveBeenLastCalledWith('slow-series'));
        await rerender({ series: { id: 'latest-series' } });
        await screen.findByText('S1 E10');
        const requestCount = getSeriesEpisodes.mock.calls.length;
        finish({ data: { items: [] }, error: null });
        await Promise.resolve();
        expect(getSeriesEpisodes).toHaveBeenCalledTimes(requestCount);
        expect(screen.getByText('S1 E10')).toBeTruthy();
    });

    test.each([9, 10])(
        'marks episode %s with POST (including the finale), then unmarks with DELETE',
        async (number) => {
            const { onwatchedChange } = await setup();
            const toggle = button(`S1 E${number}`);
            await fireEvent.click(toggle);
            await waitFor(() => expect(onwatchedChange).toHaveBeenCalledTimes(1));
            expect(apiPost).toHaveBeenCalledWith(
                `/api/watched/episode-1-${number}`,
                expect.anything(),
                undefined,
            );
            expect(apiDelete).not.toHaveBeenCalled();
            expect(toggle.getAttribute('aria-pressed')).toBe('true');
            await fireEvent.click(toggle);
            await waitFor(() => expect(onwatchedChange).toHaveBeenCalledTimes(2));
            expect(apiDelete).toHaveBeenCalledWith(
                `/api/watched/episode-1-${number}`,
                expect.anything(),
            );
            expect(toggle.getAttribute('aria-pressed')).toBe('false');
        },
    );

    test('saves with no parent callback (Search usage)', async () => {
        const { rerender } = await setup();
        await rerender({ onwatchedChange: undefined });
        await fireEvent.click(button());
        await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
        expect(button().getAttribute('aria-pressed')).toBe('true');
    });

    test('a fresh picker reads the saved finale state, independent of optimistic state', async () => {
        const { unmount, onwatchedChange } = await setup();
        // Simulated server state survives destruction of the entire component.
        let saved = false;
        apiPost.mockImplementation(async () => {
            saved = true;
            return { data: { watched: true }, error: null };
        });
        apiDelete.mockImplementation(async () => {
            saved = false;
            return { data: { watched: false }, error: null };
        });
        getSeriesEpisodes.mockImplementation(async () => ({
            data: {
                items: [
                    {
                        id: 'episode-1-10',
                        title: 'S1 E10',
                        context: { seasonNumber: 1, episodeNumber: 10 },
                        availability: { isAvailable: true, canRequest: false, hasFile: true },
                        progress: {
                            finished: saved,
                            fraction: 0 / 100,
                            positionMs: 0 / 10000,
                            durationMs: null,
                            updatedAt: null,
                        },
                        images: {},
                    },
                ],
            },
            error: null,
        }));
        await fireEvent.click(button());
        await waitFor(() => expect(onwatchedChange).toHaveBeenCalledTimes(1));
        unmount();
        render(SeriesEpisodePicker, { series: { id: 'series-1' }, inline: true });
        await screen.findByText('S1 E10');
        expect(button().getAttribute('aria-pressed')).toBe('true');
    });

    test.each(['api-error', 'rejection', 'wrong-state'])(
        'rolls back %s and allows retry',
        async (failure) => {
            const { onwatchedChange } = await setup();
            if (failure === 'rejection')
                apiPost.mockRejectedValueOnce(new Error('Network failure'));
            else
                apiPost.mockResolvedValueOnce({
                    data: { watched: false },
                    error: failure === 'api-error' ? 'Save failed' : null,
                });
            await fireEvent.click(button());
            await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
            expect(button().getAttribute('aria-pressed')).toBe('false');
            expect(button().disabled).toBe(false);
            expect(onwatchedChange).not.toHaveBeenCalled();
            await fireEvent.click(button());
            await waitFor(() => expect(onwatchedChange).toHaveBeenCalledTimes(1));
        },
    );

    test('restores watched state when DELETE fails', async () => {
        await setup(true);
        apiDelete.mockResolvedValueOnce({ data: null, error: 'Save failed' });
        await fireEvent.click(button());
        await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
        expect(button().getAttribute('aria-pressed')).toBe('true');
    });

    test('blocks duplicate clicks but preserves successful changes to other rows during rollback', async () => {
        const { onwatchedChange } = await setup();
        let finish!: (result: unknown) => void;
        apiPost.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        await fireEvent.click(button());
        expect(button().disabled).toBe(true);
        expect(onwatchedChange).not.toHaveBeenCalled();
        await fireEvent.click(button());
        expect(apiPost).toHaveBeenCalledTimes(1);
        await fireEvent.click(button('S1 E9'));
        await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));
        finish({ data: null, error: 'Save failed' });
        await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
        expect(button().getAttribute('aria-pressed')).toBe('false');
        expect(button('S1 E9').getAttribute('aria-pressed')).toBe('true');
    });

    test('rolls back the original season cache and count after switching seasons', async () => {
        const { container } = await setup();
        let finish!: (result: unknown) => void;
        apiPost.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        await fireEvent.click(button());
        await selectSeason(container, 2);
        await fireEvent.click(button('S2 E9'));
        await waitFor(() => expect(button('S2 E9').disabled).toBe(false));
        finish({ data: null, error: 'Save failed' });
        await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
        expect(button('S2 E9').getAttribute('aria-pressed')).toBe('true');
        expect(container.querySelector('[aria-haspopup="listbox"]')?.textContent).toContain('1/2');
        await selectSeason(container, 1);
        expect(button().getAttribute('aria-pressed')).toBe('false');
        expect(button('S1 E9').getAttribute('aria-pressed')).toBe('false');
        expect(container.querySelector('[aria-haspopup="listbox"]')?.textContent).not.toContain(
            '1/2',
        );
    });
});

describe('SeriesEpisodePicker missing images payloads (H25)', () => {
    afterEach(() => cleanup());

    test('season without artwork renders inherited episode descriptor variants', async () => {
        getSeriesSeasons.mockResolvedValue({
            data: {
                items: [
                    {
                        id: 'season-1',
                        title: 'Season 1',
                        seasonNumber: 1,
                        episodeCount: 1,
                        watchedCount: 0,
                        images: {},
                        episodes: { href: '/api/series/series-1/episodes?season=' + 1 },
                    },
                ],
            },
            error: null,
        });
        getSeriesEpisodes.mockResolvedValue({
            data: {
                items: [
                    {
                        id: 'ep-1',
                        title: 'Pilot',
                        images: {
                            thumb: {
                                href: 'https://example.com/still.jpg?v=2',
                                variants: {
                                    thumb: 'https://example.com/still-thumb.jpg?v=2',
                                    card: 'https://example.com/still-card.jpg?v=2',
                                },
                                source: 'series',
                                revision: '2',
                            },
                        },
                        ids: {},
                        context: { seasonNumber: 1, episodeNumber: 1 },
                        availability: { isAvailable: true, canRequest: false, hasFile: true },
                        progress: {
                            finished: false,
                            fraction: 0 / 100,
                            positionMs: 0 / 10000,
                            durationMs: null,
                            updatedAt: null,
                        },
                    },
                ],
            },
            error: null,
        });

        expect(() =>
            render(SeriesEpisodePicker, { series: { id: 'series-1', name: 'A Series' } }),
        ).not.toThrow();

        await waitFor(() => expect(screen.getByText('Pilot')).toBeTruthy());
        expect(screen.getByRole('img', { name: 'Pilot' }).getAttribute('src')).toBe(
            'https://example.com/still-thumb.jpg?v=2',
        );
        // Season mapping must not have thrown and fallen back to the "no
        // season" recovery path (which would request season 0 instead of the
        // season's actual number) — confirms the season row survived intact.
        expect(getSeriesEpisodes).toHaveBeenCalledWith(expect.anything(), 1, expect.anything());
    });

    test('episode without artwork falls back to the play placeholder', async () => {
        getSeriesSeasons.mockResolvedValue({
            data: {
                items: [
                    {
                        id: 'season-1',
                        title: 'Season 1',
                        seasonNumber: 1,
                        episodeCount: 1,
                        watchedCount: 0,
                        images: {
                            poster: {
                                href: 'https://example.com/poster.jpg',
                                revision: '1',
                                source: 'self',
                            },
                        },
                        episodes: { href: '/api/series/series-1/episodes?season=' + 1 },
                    },
                ],
            },
            error: null,
        });
        getSeriesEpisodes.mockResolvedValue({
            data: {
                items: [
                    {
                        id: 'ep-1',
                        title: 'No Thumbnail',
                        ids: {},
                        context: { seasonNumber: 1, episodeNumber: 1 },
                        availability: { isAvailable: true, canRequest: false, hasFile: true },
                        images: {},
                    },
                ],
            },
            error: null,
        });

        expect(() =>
            render(SeriesEpisodePicker, { series: { id: 'series-1', name: 'A Series' } }),
        ).not.toThrow();

        await waitFor(() => expect(screen.getByText('No Thumbnail')).toBeTruthy());
        // No imageTag → falls back to the plain play-icon placeholder, no <img> rendered
        // for the episode thumbnail.
        expect(document.querySelector('.episodes-list img')).toBeNull();
    });
});

describe('SeriesEpisodePicker late-arriving initialSeason/initialEpisode', () => {
    afterEach(() => cleanup());

    // Opening the modal from a series card (not a deep link) leaves
    // initialSeason/initialEpisode undefined at mount — the "continue
    // watching" season/episode only arrives later, once the parent's async
    // next-episode lookup resolves and rerenders this component with the
    // props populated. loadSeriesData() only reads them once, in onMount, so
    // this proves the picker still catches up instead of staying on the
    // season it defaulted to at mount.
    test('switches season and scrolls to episode once initialSeason/initialEpisode arrive post-mount', async () => {
        getSeriesSeasons.mockResolvedValue({
            data: {
                items: [
                    {
                        id: 's1',
                        title: 'Season 1',
                        seasonNumber: 1,
                        episodeCount: 1,
                        images: {},
                        episodes: { href: '/api/series/series-1/episodes?season=' + 1 },
                    },
                    {
                        id: 's3',
                        title: 'Season 3',
                        seasonNumber: 3,
                        episodeCount: 1,
                        images: {},
                        episodes: { href: '/api/series/series-1/episodes?season=' + 3 },
                    },
                ],
            },
            error: null,
        });
        getSeriesEpisodes.mockImplementation((_seriesId: string, seasonNum: number) => {
            if (seasonNum === 3) {
                return Promise.resolve({
                    data: {
                        items: [
                            {
                                id: 'ep-s3-12',
                                title: 'The Best of Both Worlds',
                                context: { seasonNumber: 3, episodeNumber: 12 },
                                progress: {
                                    finished: false,
                                    fraction: 0 / 100,
                                    positionMs: 0 / 10000,
                                    durationMs: null,
                                    updatedAt: null,
                                },
                                images: {},
                            },
                        ],
                    },
                    error: null,
                });
            }
            return Promise.resolve({
                data: {
                    items: [
                        {
                            id: 'ep-1',
                            title: 'Pilot',
                            context: { seasonNumber: 1, episodeNumber: 1 },
                            progress: {
                                finished: false,
                                fraction: 0 / 100,
                                positionMs: 0 / 10000,
                                durationMs: null,
                                updatedAt: null,
                            },
                            images: {},
                        },
                    ],
                },
                error: null,
            });
        });

        const { rerender } = render(SeriesEpisodePicker, {
            props: {
                series: { seriesId: 'series-1', name: 'Star Harbor: NG' },
                inline: true,
                initialSeason: undefined,
                initialEpisode: undefined,
            },
        });

        // Mounted with no context yet — defaults to the first regular season.
        await waitFor(() => expect(screen.getByText('Pilot')).toBeTruthy());
        expect(screen.getByText('Season 1')).toBeTruthy();

        // The "continue watching" lookup resolves and the parent passes S3E12 down.
        await rerender({
            series: { seriesId: 'series-1', name: 'Star Harbor: NG' },
            inline: true,
            initialSeason: 3,
            initialEpisode: 12,
        });

        await waitFor(() => expect(screen.getByText('The Best of Both Worlds')).toBeTruthy());
        expect(screen.getByText('Season 3')).toBeTruthy();
        expect(getSeriesEpisodes).toHaveBeenCalledWith('series-1', 3, expect.anything());
    });
});

describe('SeriesEpisodePicker hover panel', () => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

    afterEach(() => {
        cleanup();
        HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
        delete (document.documentElement as unknown as Record<string, unknown>).clientWidth;
        delete (window as unknown as Record<string, unknown>).innerHeight;
    });

    /**
     * Stubs viewport + rect measurements so a `.modal-root`-wrapped row reports
     * a visible gutter. `openHoverPanel` (F1 fix) gates on this exact
     * `computePanelPlacement` check, so every test that expects the panel to
     * actually open needs both this AND a `.modal-root` ancestor — see
     * `renderWithEpisodes({ gutter: true })` below.
     */
    function stubGutterViewport(): void {
        Object.defineProperty(document.documentElement, 'clientWidth', {
            configurable: true,
            value: 2560,
        });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1200 });
        HTMLElement.prototype.getBoundingClientRect = () =>
            ({
                top: 100,
                left: 0,
                right: 100,
                bottom: 700,
                width: 100,
                height: 600,
                x: 0,
                y: 100,
                toJSON: () => ({}),
            }) as DOMRect;
    }

    /**
     * Renders the picker with one season of two episodes and waits for rows.
     * Pass `{ gutter: true }` to mount inside a `.modal-root` ancestor with the
     * viewport stubbed wide enough for the hover panel's gutter to exist —
     * required by every test that expects the panel to actually open (F1
     * gates `openHoverPanel` on that placement check, not just render-time
     * visibility). Without it, the default happy-dom tree has no `.modal-root`
     * ancestor at all, matching the search-overlay surface where the panel
     * must never appear.
     */
    async function renderWithEpisodes(options: { gutter?: boolean } = {}) {
        getSeriesSeasons.mockResolvedValue({
            data: {
                items: [
                    {
                        id: 's1',
                        title: 'Season 1',
                        seasonNumber: 1,
                        episodeCount: 2,
                        images: {},
                        episodes: { href: '/api/series/series-1/episodes?season=' + 1 },
                    },
                ],
            },
            error: null,
        });
        getSeriesEpisodes.mockResolvedValue({
            data: {
                items: [
                    {
                        id: 'ep-1',
                        title: 'Pilot',
                        overview: 'First episode overview.',
                        context: { seasonNumber: 1, episodeNumber: 1 },
                        progress: {
                            finished: false,
                            fraction: 0 / 100,
                            positionMs: 0 / 10000,
                            durationMs: null,
                            updatedAt: null,
                        },
                        images: {},
                    },
                    {
                        id: 'ep-2',
                        title: 'Cat in the Bag',
                        overview: 'Second episode overview.',
                        context: { seasonNumber: 1, episodeNumber: 2 },
                        progress: {
                            finished: false,
                            fraction: 0 / 100,
                            positionMs: 0 / 10000,
                            durationMs: null,
                            updatedAt: null,
                        },
                        images: {},
                    },
                ],
            },
            error: null,
        });

        const props = { series: { seriesId: 'series-1', name: 'Drifting Clouds' }, inline: true };
        let result;
        if (options.gutter) {
            stubGutterViewport();
            const modalRoot = document.createElement('div');
            modalRoot.className = 'modal-root';
            document.body.appendChild(modalRoot);
            result = render(
                SeriesEpisodePicker,
                { target: modalRoot, props },
                { baseElement: document.body },
            );
        } else {
            result = render(SeriesEpisodePicker, { props });
        }
        await waitFor(() => expect(screen.getByText('Pilot')).toBeTruthy());
        return result;
    }

    function firstRow(container: Element): HTMLElement {
        const row = container.querySelector('.episode-item');
        if (!row) throw new Error('no episode row rendered');
        return row as HTMLElement;
    }

    /** The Play tooltip's own wrapper — a direct child of the row. Tooltip
     *  shows on ITS wrapper's `mouseenter`, not the row's `pointerenter`. */
    function playTooltipWrapper(row: HTMLElement): HTMLElement {
        const found = Array.from(row.children).find(
            (c) => c.classList.contains('relative') && c.classList.contains('inline-flex'),
        );
        if (!found) throw new Error('play tooltip wrapper not rendered');
        return found as HTMLElement;
    }

    /** The details Tooltip's own wrapper — nested one level inside the row,
     *  under the `.flex-1.min-w-0` info block. */
    function detailsTooltipWrapper(row: HTMLElement): HTMLElement {
        const infoBlock = Array.from(row.children).find(
            (c) => c.classList.contains('flex-1') && c.classList.contains('min-w-0'),
        );
        if (!infoBlock) throw new Error('episode info block not rendered');
        const found = Array.from(infoBlock.children).find(
            (c) => c.classList.contains('relative') && c.classList.contains('inline-flex'),
        );
        if (!found) throw new Error('details tooltip wrapper not rendered');
        return found as HTMLElement;
    }

    /** The watched-toggle button inside the details block. */
    function watchedToggleButton(row: HTMLElement): HTMLElement {
        const found = row.querySelector('button.p-1.rounded');
        if (!found) throw new Error('watched-toggle button not rendered');
        return found as HTMLElement;
    }

    /** The focusable `role="button" tabindex="0"` details block itself — the
     *  element the picker sets `aria-describedby` on. Distinct from the outer
     *  `.episode-item` wrapper, which must never carry the attribute. */
    function detailsFocusableElement(row: HTMLElement): HTMLElement {
        const found = row.querySelector('[role="button"][tabindex="0"]');
        if (!found) throw new Error('details focusable element not rendered');
        return found as HTMLElement;
    }

    test('a mouse pointer opens the panel after the intent delay', async () => {
        const { container, baseElement } = await renderWithEpisodes({ gutter: true });
        await fireEvent.pointerEnter(firstRow(container), { pointerType: 'mouse' });

        expect(baseElement.querySelector('[role="tooltip"].episode-hover-panel')).toBeNull();
        await waitFor(
            () =>
                expect(
                    baseElement.querySelector('[role="tooltip"].episode-hover-panel'),
                ).toBeTruthy(),
            { timeout: 1000 },
        );
    });

    test('a touch pointer never opens the panel', async () => {
        const { container, baseElement } = await renderWithEpisodes({ gutter: true });
        await fireEvent.pointerEnter(firstRow(container), { pointerType: 'touch' });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(baseElement.querySelector('[role="tooltip"].episode-hover-panel')).toBeNull();
    });

    // F1 regression: `openHoverPanel` used to set `hoveredEpisode` unconditionally,
    // regardless of viewport width or whether a `.modal-root` gutter existed —
    // visibility was decided only inside `EpisodeHoverPanel` at render time. That
    // disabled both row tooltips via their `disabled` prop even though the panel
    // meant to replace them stayed `visibility: hidden` (no gutter here, the
    // default happy-dom tree with no `.modal-root` ancestor — same as the search
    // overlay, which never has one at any width), so hovering a row showed both
    // tooltips briefly then lost them permanently with nothing to replace them.
    test('below the gutter threshold (no .modal-root ancestor), hovering leaves both tooltips intact and opens no panel', async () => {
        const { container, baseElement } = await renderWithEpisodes();
        const row = firstRow(container);
        await fireEvent.pointerEnter(row, { pointerType: 'mouse' });

        // Each tooltip is exercised on its OWN wrapper (mouseenter doesn't
        // bubble), one at a time — showing one dismisses any other via
        // Tooltip's own mutual-exclusion broadcast ('tooltip-show'), which is
        // unrelated to the bug under test. `disabled` staying false is what's
        // being proven, for both tooltips independently.
        await fireEvent.mouseEnter(playTooltipWrapper(row));
        await waitFor(() => expect(screen.queryByText(m.episode_picker_play())).toBeTruthy());
        await fireEvent.mouseLeave(playTooltipWrapper(row));
        await waitFor(() => expect(screen.queryByText(m.episode_picker_play())).toBeNull());

        await fireEvent.mouseEnter(detailsTooltipWrapper(row));
        await waitFor(() => expect(screen.queryByText(m.episode_picker_details())).toBeTruthy());

        // Long enough for the panel's open-intent delay to have fired if the
        // width/gutter gate were broken.
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(baseElement.querySelector('[role="tooltip"].episode-hover-panel')).toBeNull();
    });

    test('pointerleave closes the panel after the grace period', async () => {
        const { container, baseElement } = await renderWithEpisodes({ gutter: true });
        const row = firstRow(container);
        await fireEvent.pointerEnter(row, { pointerType: 'mouse' });
        await waitFor(() =>
            expect(baseElement.querySelector('[role="tooltip"].episode-hover-panel')).toBeTruthy(),
        );

        await fireEvent.pointerLeave(row);
        await waitFor(() =>
            expect(baseElement.querySelector('[role="tooltip"].episode-hover-panel')).toBeNull(),
        );
    });

    test('suppresses both row tooltips while the panel is open', async () => {
        const { container, baseElement } = await renderWithEpisodes({ gutter: true });
        const row = firstRow(container);

        // Tooltip shows on its OWN wrapper's `mouseenter` (Tooltip.svelte),
        // not the ancestor row's `pointerenter` — mouseenter doesn't bubble
        // and is a different event type, so exercise each wrapper directly.
        // The details tooltip fires at 200ms, ahead of the panel's 180ms intent
        // delay — so without the `disabled` prop both would be on screen at once.
        await fireEvent.mouseEnter(playTooltipWrapper(row));
        await fireEvent.mouseEnter(detailsTooltipWrapper(row));
        await fireEvent.pointerEnter(row, { pointerType: 'mouse' });

        await waitFor(
            () =>
                expect(
                    baseElement.querySelector('[role="tooltip"].episode-hover-panel'),
                ).toBeTruthy(),
            { timeout: 1000 },
        );

        expect(screen.queryByText(m.episode_picker_play())).toBeNull();
        expect(screen.queryByText(m.episode_picker_details())).toBeNull();
    });

    test('keyboard focus opens the panel with no delay', async () => {
        const { container, baseElement } = await renderWithEpisodes({ gutter: true });
        await fireEvent.focusIn(firstRow(container));
        await waitFor(() =>
            expect(baseElement.querySelector('[role="tooltip"].episode-hover-panel')).toBeTruthy(),
        );
    });

    test('a modal opening closes the panel', async () => {
        const { container, baseElement } = await renderWithEpisodes({ gutter: true });
        await fireEvent.pointerEnter(firstRow(container), { pointerType: 'mouse' });
        await waitFor(() =>
            expect(baseElement.querySelector('[role="tooltip"].episode-hover-panel')).toBeTruthy(),
        );

        modalCountStore.set(1);
        await waitFor(() =>
            expect(baseElement.querySelector('[role="tooltip"].episode-hover-panel')).toBeNull(),
        );
    });

    test('Escape closes the panel without propagating to the modal', async () => {
        const { container, baseElement } = await renderWithEpisodes({ gutter: true });
        await fireEvent.pointerEnter(firstRow(container), { pointerType: 'mouse' });
        await waitFor(() =>
            expect(baseElement.querySelector('[role="tooltip"].episode-hover-panel')).toBeTruthy(),
        );

        const windowHandler = vi.fn();
        window.addEventListener('keydown', windowHandler);
        document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
        window.removeEventListener('keydown', windowHandler);

        await waitFor(() =>
            expect(baseElement.querySelector('[role="tooltip"].episode-hover-panel')).toBeNull(),
        );
        expect(windowHandler).not.toHaveBeenCalled();
    });

    test('marking an episode watched while the panel is open does not close it', async () => {
        const { container, baseElement } = await renderWithEpisodes({ gutter: true });
        const row = firstRow(container);
        await fireEvent.pointerEnter(row, { pointerType: 'mouse' });
        await waitFor(() =>
            expect(baseElement.querySelector('[role="tooltip"].episode-hover-panel')).toBeTruthy(),
        );

        // The optimistic watched-toggle reassigns `episodes` for its in-place
        // update — the hovered row's id is still present afterwards, so the
        // panel must stay open (the pointer never left the row).
        await fireEvent.click(watchedToggleButton(row));

        await waitFor(() =>
            expect(baseElement.querySelector('[role="tooltip"].episode-hover-panel')).toBeTruthy(),
        );
    });

    test('switching seasons while the panel is open closes it', async () => {
        getSeriesSeasons.mockResolvedValue({
            data: {
                items: [
                    {
                        id: 's1',
                        title: 'Season 1',
                        seasonNumber: 1,
                        episodeCount: 2,
                        images: {},
                        episodes: { href: '/api/series/series-1/episodes?season=' + 1 },
                    },
                    {
                        id: 's2',
                        title: 'Season 2',
                        seasonNumber: 2,
                        episodeCount: 1,
                        images: {},
                        episodes: { href: '/api/series/series-1/episodes?season=' + 2 },
                    },
                ],
            },
            error: null,
        });
        getSeriesEpisodes.mockImplementation((_seriesId: string, seasonNum: number) => {
            if (seasonNum === 2) {
                return Promise.resolve({
                    data: {
                        items: [
                            {
                                id: 'ep-s2-1',
                                title: 'Season Two Premiere',
                                overview: 'Second season overview.',
                                context: { seasonNumber: 2, episodeNumber: 1 },
                                progress: {
                                    finished: false,
                                    fraction: 0 / 100,
                                    positionMs: 0 / 10000,
                                    durationMs: null,
                                    updatedAt: null,
                                },
                                images: {},
                            },
                        ],
                    },
                    error: null,
                });
            }
            return Promise.resolve({
                data: {
                    items: [
                        {
                            id: 'ep-1',
                            title: 'Pilot',
                            overview: 'First episode overview.',
                            context: { seasonNumber: 1, episodeNumber: 1 },
                            progress: {
                                finished: false,
                                fraction: 0 / 100,
                                positionMs: 0 / 10000,
                                durationMs: null,
                                updatedAt: null,
                            },
                            images: {},
                        },
                    ],
                },
                error: null,
            });
        });

        stubGutterViewport();
        const modalRoot = document.createElement('div');
        modalRoot.className = 'modal-root';
        document.body.appendChild(modalRoot);
        const { container, baseElement } = render(
            SeriesEpisodePicker,
            {
                target: modalRoot,
                props: { series: { seriesId: 'series-1', name: 'Drifting Clouds' }, inline: true },
            },
            { baseElement: document.body },
        );
        await waitFor(() => expect(screen.getByText('Pilot')).toBeTruthy());

        await fireEvent.pointerEnter(firstRow(container), { pointerType: 'mouse' });
        await waitFor(() =>
            expect(baseElement.querySelector('[role="tooltip"].episode-hover-panel')).toBeTruthy(),
        );

        const dropdownTrigger = container.querySelector('[aria-haspopup="listbox"]');
        if (!dropdownTrigger) throw new Error('season dropdown trigger not rendered');
        await fireEvent.click(dropdownTrigger);
        const options = container.querySelectorAll('[role="option"]');
        if (options.length < 2) throw new Error('season options not rendered');
        await fireEvent.click(options[1]);

        await waitFor(() =>
            expect(baseElement.querySelector('[role="tooltip"].episode-hover-panel')).toBeNull(),
        );
    });

    // F3 regression: the picker sets `aria-describedby` on the focusable details
    // block (not the outer `.episode-item` wrapper) so screen readers announce
    // the open hover panel. Confirms the linkage lands on the right element and
    // is cleared once the panel closes.
    test('the focusable details element carries aria-describedby matching the open panel, cleared on close', async () => {
        const { container, baseElement } = await renderWithEpisodes({ gutter: true });
        const row = firstRow(container);
        const focusable = detailsFocusableElement(row);

        expect(focusable.getAttribute('aria-describedby')).toBeNull();

        await fireEvent.pointerEnter(row, { pointerType: 'mouse' });
        await waitFor(() =>
            expect(baseElement.querySelector('[role="tooltip"].episode-hover-panel')).toBeTruthy(),
        );

        const panel = baseElement.querySelector(
            '[role="tooltip"].episode-hover-panel',
        ) as HTMLElement;
        expect(panel.id).toBeTruthy();
        expect(focusable.getAttribute('aria-describedby')).toBe(panel.id);

        await fireEvent.pointerLeave(row);
        await waitFor(() =>
            expect(baseElement.querySelector('[role="tooltip"].episode-hover-panel')).toBeNull(),
        );
        expect(focusable.getAttribute('aria-describedby')).toBeNull();
    });
});

describe('SeriesEpisodePicker season dropdown scroll position', () => {
    afterEach(() => cleanup());

    const OPTION_H = 60;
    const LIST_H = 300;

    /**
     * happy-dom has no layout, so every offset reads 0 and an assertion on
     * `scrollTop` would be vacuously true. Stub the three geometry reads the
     * centring math uses: option rows are stacked `OPTION_H` apart inside a
     * `LIST_H`-tall scroll container.
     */
    function stubDropdownGeometry(): () => void {
        const saved = new Map<string, PropertyDescriptor | undefined>();
        const define = (prop: string, get: (this: HTMLElement) => number) => {
            saved.set(prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop));
            Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get });
        };
        const isOption = (el: HTMLElement) => el.getAttribute('role') === 'option';
        define('offsetTop', function (this: HTMLElement) {
            if (!isOption(this)) return 0;
            const siblings = Array.from(
                this.parentElement?.querySelectorAll('[role="option"]') ?? [],
            );
            return siblings.indexOf(this) * OPTION_H;
        });
        define('offsetHeight', function (this: HTMLElement) {
            return isOption(this) ? OPTION_H : 0;
        });
        define('clientHeight', function (this: HTMLElement) {
            return this.classList.contains('seasons-dropdown') ? LIST_H : 0;
        });
        return () => {
            for (const [prop, descriptor] of saved) {
                if (descriptor) Object.defineProperty(HTMLElement.prototype, prop, descriptor);
                else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
            }
        };
    }

    test('opening the dropdown centres the selected season instead of starting at the top', async () => {
        getSeriesSeasons.mockResolvedValue({
            data: {
                items: Array.from({ length: 20 }, (_, i) => ({
                    id: `s${i + 1}`,
                    title: `Season ${i + 1}`,
                    seasonNumber: i + 1,
                    episodeCount: 1,
                    images: {},
                    episodes: { href: '/api/series/series-1/episodes?season=' + (i + 1) },
                })),
            },
            error: null,
        });
        getSeriesEpisodes.mockImplementation((_seriesId: string, seasonNum: number) =>
            Promise.resolve({
                data: {
                    items: [
                        {
                            id: `ep-s${seasonNum}-1`,
                            title: `S${seasonNum} Pilot`,
                            context: { seasonNumber: seasonNum, episodeNumber: 1 },
                            progress: {
                                finished: false,
                                fraction: 0 / 100,
                                positionMs: 0 / 10000,
                                durationMs: null,
                                updatedAt: null,
                            },
                            images: {},
                        },
                    ],
                },
                error: null,
            }),
        );

        const restoreGeometry = stubDropdownGeometry();
        try {
            const { container } = render(SeriesEpisodePicker, {
                props: {
                    series: { seriesId: 'series-1', name: 'South Harbor' },
                    inline: true,
                    initialSeason: 15,
                },
            });
            await waitFor(() => expect(screen.getByText('S15 Pilot')).toBeTruthy());

            const trigger = container.querySelector('[aria-haspopup="listbox"]');
            if (!trigger) throw new Error('season dropdown trigger not rendered');
            await fireEvent.click(trigger);

            const list = container.querySelector('.seasons-dropdown') as HTMLElement;
            expect(list).toBeTruthy();
            const selected = list.querySelector('[role="option"][aria-selected="true"]');
            expect(selected?.textContent).toContain('Season 15');

            // Season 15 is the 15th option: 14 * 60 = 840px from the top, minus
            // half the leftover viewport height ((300 - 60) / 2 = 120) to sit in
            // the middle of the list.
            await waitFor(() => expect(list.scrollTop).toBe(720));
        } finally {
            restoreGeometry();
        }
    });
});
