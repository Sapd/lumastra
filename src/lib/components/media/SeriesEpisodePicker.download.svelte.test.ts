// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';

vi.mock('$app/stores', () => ({
    page: readable({
        data: { features: { mediaDownload: true } },
        url: new URL('http://localhost/'),
    }),
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
vi.mock('$lib/stores/modal.store', () => ({
    modalCount: {
        subscribe(fn: (v: number) => void) {
            fn(0);
            return () => {};
        },
    },
    hasModals: {
        subscribe(fn: (v: boolean) => void) {
            fn(false);
            return () => {};
        },
    },
}));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { error: vi.fn(), info: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));

import SeriesEpisodePicker from './SeriesEpisodePicker.svelte';
import { downloadQueue } from '$lib/downloads/download-queue.svelte';

beforeEach(() => {
    vi.stubGlobal(
        'fetch',
        vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        allowed: true,
                        maxParallel: 3,
                        seriesFolder: 'Show',
                        missingCount: 0,
                        items: [],
                    }),
                ),
        ),
    );
    getSeriesSeasons.mockResolvedValue({
        data: {
            items: [1, 2].map((n) => ({
                id: `season-${n}`,
                title: `Season ${n}`,
                seasonNumber: n,
                episodeCount: 3,
                watchedCount: 0,
                images: {},
                episodes: { href: `/api/series/series-1/episodes?season=${n}` },
            })),
        },
        error: null,
    });
    const ep = (number: number, extra: Record<string, unknown>) => ({
        id: `episode-${number}`,
        title: `Ep ${number}`,
        context: { seasonNumber: 1, episodeNumber: number, ...(extra.context as object) },
        availability: {
            isAvailable: true,
            canRequest: false,
            hasFile: true,
            ...(extra.availability as object),
        },
        progress: {
            finished: false,
            fraction: 0,
            positionMs: 0,
            durationMs: null,
            updatedAt: null,
        },
        images: {},
        audioLanguages: [],
        subtitleLanguages: [],
    });
    getSeriesEpisodes.mockResolvedValue({
        data: {
            items: [
                ep(1, {}),
                ep(2, {
                    context: { airDate: '2001-01-01' },
                    availability: { hasFile: false, isAvailable: false },
                }),
                ep(3, { context: { airDate: '2999-01-01' } }),
                // undated: no air date and no file
                ep(4, { availability: { hasFile: false, isAvailable: false } }),
            ],
        },
        error: null,
    });
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('SeriesEpisodePicker download icons', () => {
    test('no season/series download element next to the season selector', async () => {
        render(SeriesEpisodePicker, { series: { id: 'series-1' }, inline: true });
        await screen.findByText('Ep 1');
        expect(screen.queryByRole('button', { name: 'Download season or series' })).toBeNull();
        expect(screen.queryByTestId('series-download')).toBeNull();
        expect(screen.queryByText('Download season')).toBeNull();
        expect(screen.queryByText('Download series')).toBeNull();
    });

    test('the picker tells the download store which series and season it shows, and clears it', async () => {
        const { unmount } = render(SeriesEpisodePicker, {
            series: { id: 'series-1' },
            inline: true,
        });
        await screen.findByText('Ep 1');
        await waitFor(() =>
            expect(downloadQueue.pickerContext).toEqual({ seriesId: 'series-1', season: 1 }),
        );
        unmount();
        expect(downloadQueue.pickerContext).toBeNull();
    });

    test('an episode icon opens the sheet with "This episode" for that episode', async () => {
        const enqueueSeries = vi.spyOn(downloadQueue, 'enqueueSeries').mockResolvedValue();
        render(SeriesEpisodePicker, { series: { id: 'series-1' }, inline: true });
        await screen.findByText('Ep 1');
        await fireEvent.click(await screen.findByRole('button', { name: 'Download episode' }));
        expect(enqueueSeries).toHaveBeenCalledWith('series-1', {
            scope: 'episode',
            episodeId: 'episode-1',
        });
    });

    test('episode icons: only for downloadable rows, revealed on hover', async () => {
        render(SeriesEpisodePicker, { series: { id: 'series-1' }, inline: true });
        await screen.findByText('Ep 1');
        await waitFor(() =>
            expect(screen.getAllByRole('button', { name: 'Download episode' })).toHaveLength(1),
        );
        // missing on disk (Ep 2), unreleased (Ep 3) and undated without a file (Ep 4) get none
        const icon = screen.getByRole('button', { name: 'Download episode' });
        expect(icon.classList.contains('download-reveal')).toBe(true);
        expect(icon.closest('.download-row')).toBeTruthy();
    });

    test('Enter and Space on the download icon do not also open the episode details', async () => {
        const onshowEpisodeDetails = vi.fn();
        vi.spyOn(downloadQueue, 'enqueueSeries').mockResolvedValue();
        render(SeriesEpisodePicker, {
            series: { id: 'series-1' },
            inline: true,
            onshowEpisodeDetails,
        });
        await screen.findByText('Ep 1');
        const icon = await screen.findByRole('button', { name: 'Download episode' });
        await fireEvent.keyDown(icon, { key: 'Enter' });
        await fireEvent.keyDown(icon, { key: ' ' });
        expect(onshowEpisodeDetails).not.toHaveBeenCalled();
        // the row's own details control still answers the keyboard
        const row = icon.closest('[role="button"][tabindex="0"]:not([aria-label])') as HTMLElement;
        expect(row).toBeTruthy();
        expect(row).not.toBe(icon);
        await fireEvent.keyDown(row, { key: 'Enter' });
        expect(onshowEpisodeDetails).toHaveBeenCalledTimes(1);
    });
});
