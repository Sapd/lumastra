// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

const { getSeriesSeasons, getSeriesEpisodes } = vi.hoisted(() => ({
    getSeriesSeasons: vi.fn(),
    getSeriesEpisodes: vi.fn(),
}));
vi.mock('$lib/components/player/preferences-sync.svelte', () => ({
    playbackPreferences: { showEpisodeLanguages: true, ready: true },
    initializePreferences: vi.fn(async () => {}),
}));
vi.mock('$lib/api/content', () => ({ getSeriesSeasons, getSeriesEpisodes }));
vi.mock('$lib/api/user', () => ({ markWatched: vi.fn(), unmarkWatched: vi.fn() }));

import EpisodeBrowser from './EpisodeBrowser.svelte';

/**
 * The player's season dropdown must open centred on the season being watched,
 * the same as the modal picker's. happy-dom has no layout engine, so the three
 * geometry reads behind that are stubbed: option rows are `OPTION_H` tall and
 * stacked inside a `LIST_H`-tall scroll container.
 */
const OPTION_H = 60;
const LIST_H = 300;

function stubDropdownGeometry(): () => void {
    const saved = new Map<string, PropertyDescriptor | undefined>();
    const define = (prop: string, get: (this: HTMLElement) => number) => {
        saved.set(prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop));
        Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get });
    };
    const isOption = (el: HTMLElement) => el.getAttribute('role') === 'option';
    define('offsetTop', function (this: HTMLElement) {
        if (!isOption(this)) return 0;
        const siblings = Array.from(this.parentElement?.querySelectorAll('[role="option"]') ?? []);
        return siblings.indexOf(this) * OPTION_H;
    });
    define('offsetHeight', function (this: HTMLElement) {
        return isOption(this) ? OPTION_H : 0;
    });
    define('clientHeight', function (this: HTMLElement) {
        return this.getAttribute('role') === 'listbox' ? LIST_H : 0;
    });
    return () => {
        for (const [prop, descriptor] of saved) {
            if (descriptor) Object.defineProperty(HTMLElement.prototype, prop, descriptor);
            else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
        }
    };
}

function mockSeasons(count: number, combined = false) {
    getSeriesSeasons.mockResolvedValue({
        data: {
            items: Array.from({ length: count }, (_, i) => ({
                id: `s${i + 1}`,
                title: `Season ${i + 1}`,
                seasonNumber: i + 1,
                episodeCount: 1,
                watchedCount: 0,
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
                        title: `S${seasonNum}E1`,
                        overview: '',
                        audioLanguages: ['jpn'],
                        subtitleLanguages: ['deu'],
                        segments: combined
                            ? [
                                  { episodeNumber: 1, title: 'First half' },
                                  { episodeNumber: 2, title: 'Second half' },
                              ]
                            : undefined,
                        images: {},
                        context: { seasonNumber: seasonNum, episodeNumber: 1 },
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
        }),
    );
}

describe('EpisodeBrowser delayed current episode scroll', () => {
    afterEach(() => {
        cleanup();
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    async function renderLoadedBrowser(combined = false) {
        vi.useFakeTimers();
        mockSeasons(1, combined);
        const view = render(EpisodeBrowser, {
            seriesId: 'series-1',
            currentSeasonNumber: 1,
            currentEpisodeId: 'ep-s1-1',
            isOpen: true,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(view.container.querySelector('.episode-current')).toBeTruthy();
        return view;
    }

    test('preserves language badges and combined episode titles', async () => {
        const view = await renderLoadedBrowser(true);
        expect(view.getByText('JA')).toBeTruthy();
        expect(view.getByText('DE')).toBeTruthy();
        expect(view.getByText('First half')).toBeTruthy();
        expect(view.getByText('Second half')).toBeTruthy();
    });

    test('scrolls to the current episode after its rows render', async () => {
        const view = await renderLoadedBrowser();
        const episode = view.container.querySelector('.episode-current')!;
        const scroll = vi.spyOn(episode, 'scrollIntoView');

        await vi.advanceTimersByTimeAsync(100);

        expect(scroll).toHaveBeenCalledExactlyOnceWith({ behavior: 'smooth', block: 'center' });
    });

    test('does not access the document after unmount', async () => {
        const view = await renderLoadedBrowser();
        await view.unmount();
        const query = vi.spyOn(document, 'querySelector');

        await vi.advanceTimersByTimeAsync(100);

        expect(query).not.toHaveBeenCalledWith('.episode-current');
    });

    test('cancels the pending scroll when the browser closes', async () => {
        const view = await renderLoadedBrowser();
        await view.rerender({ isOpen: false });
        const query = vi.spyOn(document, 'querySelector');

        await vi.advanceTimersByTimeAsync(100);

        expect(query).not.toHaveBeenCalledWith('.episode-current');
    });
});

describe('EpisodeBrowser season dropdown scroll position', () => {
    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
    });

    test('opening the dropdown centres the season being watched', async () => {
        mockSeasons(20);
        const restoreGeometry = stubDropdownGeometry();
        try {
            const { container } = render(EpisodeBrowser, {
                props: {
                    seriesId: 'series-1',
                    currentSeasonNumber: 15,
                    currentEpisodeId: 'ep-s15-1',
                    seriesName: 'South Harbor',
                    isOpen: true,
                },
            });
            await waitFor(() => expect(container.querySelector('[aria-haspopup="listbox"]')));

            const trigger = container.querySelector('[aria-haspopup="listbox"]');
            if (!trigger) throw new Error('season dropdown trigger not rendered');
            await fireEvent.click(trigger);

            const list = await waitFor(() => {
                const el = container.querySelector('[role="listbox"]') as HTMLElement | null;
                if (!el?.querySelector('[role="option"]')) throw new Error('seasons not loaded');
                return el;
            });
            const selected = list.querySelector('[role="option"][aria-selected="true"]');
            expect(selected?.textContent).toContain('Season 15');

            // Season 15 is the 15th option: 14 * 60 = 840px from the top, minus
            // half the leftover viewport height ((300 - 60) / 2 = 120) so it
            // lands in the middle of the list.
            await waitFor(() => expect(list.scrollTop).toBe(720));
        } finally {
            restoreGeometry();
        }
    });

    test('a dropdown opened before the seasons arrive still centres once they do', async () => {
        // Hold the seasons fetch open so the dropdown renders its spinner first,
        // proving the effect re-runs when the rows finally exist.
        let resolveSeasons: (value: unknown) => void = () => {};
        getSeriesSeasons.mockReturnValue(
            new Promise((resolve) => {
                resolveSeasons = resolve;
            }),
        );
        getSeriesEpisodes.mockResolvedValue({ data: { items: [] }, error: null });

        const restoreGeometry = stubDropdownGeometry();
        try {
            const { container } = render(EpisodeBrowser, {
                props: {
                    seriesId: 'series-1',
                    currentSeasonNumber: 15,
                    currentEpisodeId: 'ep-s15-1',
                    seriesName: 'South Harbor',
                    isOpen: true,
                },
            });

            const trigger = container.querySelector('[aria-haspopup="listbox"]');
            if (!trigger) throw new Error('season dropdown trigger not rendered');
            await fireEvent.click(trigger);

            const list = container.querySelector('[role="listbox"]') as HTMLElement;
            expect(list).toBeTruthy();
            expect(list.querySelector('[role="option"]')).toBeNull();
            expect(list.scrollTop).toBe(0);

            resolveSeasons({
                data: {
                    items: Array.from({ length: 20 }, (_, i) => ({
                        id: `s${i + 1}`,
                        title: `Season ${i + 1}`,
                        seasonNumber: i + 1,
                        episodeCount: 1,
                        watchedCount: 0,
                        images: {},
                        episodes: { href: '/api/series/series-1/episodes?season=' + (i + 1) },
                    })),
                },
                error: null,
            });

            await waitFor(() => expect(list.scrollTop).toBe(720));
        } finally {
            restoreGeometry();
        }
    });
});

describe('EpisodeBrowser request ordering and nested Escape', () => {
    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
    });

    test('a slow old season cannot replace the latest season', async () => {
        mockSeasons(3);
        let resolveOld!: (value: unknown) => void;
        getSeriesEpisodes.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveOld = resolve;
                }),
        );
        const view = render(EpisodeBrowser, {
            seriesId: 'series-1',
            currentSeasonNumber: 1,
            currentEpisodeId: 'ep-s1-1',
            isOpen: true,
        });
        await waitFor(() =>
            expect(getSeriesEpisodes).toHaveBeenCalledWith('series-1', 1, expect.anything()),
        );
        await fireEvent.click(view.container.querySelector('[aria-haspopup="listbox"]')!);
        await fireEvent.click(await view.findByRole('option', { name: /Season 2/ }));
        await view.findByText('S2E1');
        resolveOld({
            data: {
                items: [
                    {
                        id: 'old',
                        title: 'Old episode',
                        images: {},
                        context: { seasonNumber: 1, episodeNumber: 1 },
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
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(view.queryByText('Old episode')).toBeNull();
        expect(view.getByText('S2E1')).toBeTruthy();
    });

    test('Escape closes the season selector before the episode browser', async () => {
        mockSeasons(3);
        const onclose = vi.fn();
        const view = render(EpisodeBrowser, {
            seriesId: 'series-1',
            currentSeasonNumber: 1,
            currentEpisodeId: 'ep-s1-1',
            isOpen: true,
            onclose,
        });
        await fireEvent.click(view.container.querySelector('[aria-haspopup="listbox"]')!);
        await fireEvent.keyDown(window, { key: 'Escape' });
        expect(view.queryByRole('listbox')).toBeNull();
        expect(onclose).not.toHaveBeenCalled();
        await fireEvent.keyDown(window, { key: 'Escape' });
        expect(onclose).toHaveBeenCalledOnce();
    });
});

test('a failed episode request offers retry instead of claiming the season is empty', async () => {
    mockSeasons(3);
    getSeriesEpisodes.mockResolvedValueOnce({ data: null, error: 'Temporarily unavailable' });
    const view = render(EpisodeBrowser, {
        seriesId: 'series-1',
        currentSeasonNumber: 1,
        currentEpisodeId: 'ep-s1-1',
        isOpen: true,
    });
    try {
        await view.findByRole('alert');
        expect(view.queryByText('No episodes found')).toBeNull();
        await fireEvent.click(view.getByRole('button', { name: 'Retry' }));
        await view.findByText('S1E1');
        expect(view.queryByRole('alert')).toBeNull();
    } finally {
        cleanup();
        vi.clearAllMocks();
    }
});

test('language overflow never activates the episode; row keyboard activation still works', async () => {
    mockSeasons(1);
    const result = await getSeriesEpisodes('series-1', 1);
    result.data.items[0].audioLanguages = ['deu', 'eng', 'fra', 'jpn'];
    getSeriesEpisodes.mockResolvedValue(result);
    const onselect = vi.fn();
    const onclose = vi.fn();
    const view = render(EpisodeBrowser, {
        onclose,
        seriesId: 'series-1',
        currentSeasonNumber: 1,
        currentEpisodeId: 'other',
        isOpen: true,
        onselectepisode: onselect,
    });
    const title = await view.findByText('S1E1');
    const row = title.closest('[role="button"]') as HTMLElement;
    const overflow = row.querySelector('button') as HTMLButtonElement;
    expect(overflow).toBeTruthy();
    await fireEvent.click(overflow);
    await fireEvent.keyDown(overflow, { key: 'Enter' });
    expect(onselect).not.toHaveBeenCalled();
    await fireEvent.keyDown(overflow, { key: 'Escape' });
    expect(onclose).not.toHaveBeenCalled();
    expect(overflow.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.keyDown(row, { key: 'Enter' });
    expect(onselect).toHaveBeenCalledTimes(1);
    await fireEvent.keyDown(row, { key: ' ' });
    expect(onselect).toHaveBeenCalledTimes(2);
    await view.rerender({
        seriesId: 'series-1',
        currentSeasonNumber: 1,
        currentEpisodeId: 'other',
        isOpen: true,
        readOnly: true,
        onselectepisode: onselect,
    });
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.tabIndex).toBe(-1);
    await fireEvent.click(row);
    await fireEvent.keyDown(row, { key: 'Enter' });
    expect(onselect).toHaveBeenCalledTimes(2);
});
