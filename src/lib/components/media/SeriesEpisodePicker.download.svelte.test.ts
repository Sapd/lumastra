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
    test('one season/series icon, no text buttons; click starts the season download', async () => {
        const enqueue = vi.spyOn(downloadQueue, 'enqueue').mockResolvedValue();
        render(SeriesEpisodePicker, { series: { id: 'series-1' }, inline: true });
        const icon = await screen.findByRole('button', { name: 'Download season or series' });
        expect(icon.textContent?.trim()).toBe('');
        expect(screen.queryByText('Download season')).toBeNull();
        expect(screen.queryByText('Download series')).toBeNull();
        await fireEvent.click(icon);
        expect(enqueue).toHaveBeenCalledWith('series-1', { season: 1 }, 1);
    });

    test('episode icons: only for downloadable rows, revealed on hover', async () => {
        render(SeriesEpisodePicker, { series: { id: 'series-1' }, inline: true });
        await screen.findByText('Ep 1');
        await waitFor(() =>
            expect(screen.getAllByRole('button', { name: 'Download episode' })).toHaveLength(1),
        );
        // missing on disk (Ep 2) and unreleased (Ep 3) get none
        const icon = screen.getByRole('button', { name: 'Download episode' });
        expect(icon.classList.contains('download-reveal')).toBe(true);
        expect(icon.closest('.download-row')).toBeTruthy();
    });
});
