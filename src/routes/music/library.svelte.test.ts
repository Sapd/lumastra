// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, type RenderResult } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { flushSync, tick } from 'svelte';
import { readable } from 'svelte/store';
import Albums from './albums/+page.svelte';
import Artists from './artists/+page.svelte';
import { search } from '$lib/api/content';
import type { PageData as AlbumsPageData } from './albums/$types';
import type { PageData as ArtistsPageData } from './artists/$types';

const emptySearch: Awaited<ReturnType<typeof search>> = {
    data: { items: [], page: { limit: 100, hasMore: false } },
    error: null,
    status: 200,
};

function renderAlbums(): RenderResult<typeof Albums> {
    return render(Albums, { data: { albums: [], hasMore: false } as AlbumsPageData });
}

function renderArtists(): RenderResult<typeof Artists> {
    return render(Artists, { data: { artists: [], hasMore: false } as ArtistsPageData });
}

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
const pageUrl = vi.hoisted(() => ({ current: 'http://localhost:3000/music/albums' }));
vi.mock('$app/stores', () => ({
    get page() {
        return readable({
            route: { id: '/music/albums' },
            url: new URL(pageUrl.current),
            data: {},
        });
    },
    navigating: readable(null),
}));
vi.mock('$lib/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/api/content', () => ({ search: vi.fn() }));
vi.mock('$lib/api/music', () => ({ getAlbums: vi.fn(), getArtists: vi.fn() }));
// Main owns generated message integration. No generated files are changed here.
vi.mock('$lib/paraglide/messages.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    viewer_music_search_error: () => 'Search failed',
    viewer_music_search_start: () => 'Enter at least two characters',
    viewer_music_sort: () => 'Sort library',
    viewer_music_album_scope: () => 'Search albums across music',
    viewer_music_artist_scope: () => 'Search artists across music',
    viewer_music_by_year: () => 'By year',
}));

async function settleSearch(): Promise<void> {
    flushSync();
    await vi.advanceTimersByTimeAsync(200);
    flushSync();
}

describe.each([
    { label: 'albums', renderPage: renderAlbums, type: 'album' },
    { label: 'artists', renderPage: renderArtists, type: 'artist' },
])('Music library $label', ({ renderPage, type }) => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.mocked(search).mockResolvedValue(emptySearch);
    });
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    test('labels search and sort, disables browse sort during search, and recovers from failure', async () => {
        vi.mocked(search).mockRejectedValueOnce(new Error('offline'));
        const view = renderPage();
        const input = view.getByRole('searchbox');
        expect(input.getAttribute('aria-label')).toBeTruthy();
        await fireEvent.input(input, { target: { value: 'test' } });
        await settleSearch();
        expect(view.getByRole('alert').textContent).toContain('Search failed');
        expect(
            (view.getByRole('combobox', { name: 'Sort library' }) as HTMLSelectElement).disabled,
        ).toBe(true);
        await fireEvent.click(view.getByRole('button', { name: 'Retry' }));
        await tick();
        flushSync();
        expect(view.container.querySelector('[role="alert"]')).toBeNull();
    });

    test('opens already searching the ?q= from the URL (the "See all" link)', async () => {
        pageUrl.current = 'http://localhost:3000/music/x?q=lantern%20pitch';
        try {
            const view = renderPage();
            await settleSearch();
            expect((view.getByRole('searchbox') as HTMLInputElement).value).toBe('lantern pitch');
            expect(search).toHaveBeenCalledWith(
                'lantern pitch',
                expect.objectContaining({ types: type }),
            );
        } finally {
            pageUrl.current = 'http://localhost:3000/music/albums';
        }
    });

    test('asks the server for its own type only, so other types cannot fill the window', async () => {
        const view = renderPage();
        await fireEvent.input(view.getByRole('searchbox'), { target: { value: 'test' } });
        await settleSearch();
        expect(search).toHaveBeenCalledWith('test', expect.objectContaining({ types: type }));
    });

    test('shortening a query invalidates a pending response and resets loading', async () => {
        let rejectOld!: (reason: Error) => void;
        vi.mocked(search).mockImplementationOnce(
            () =>
                new Promise((_resolve, reject) => {
                    rejectOld = reject;
                }),
        );
        const view = renderPage();
        const input = view.getByRole('searchbox');
        await fireEvent.input(input, { target: { value: 'old' } });
        await settleSearch();
        await fireEvent.input(input, { target: { value: 'o' } });
        rejectOld(new Error('old request failed'));
        await tick();
        flushSync();
        expect(view.container.querySelector('[role="alert"]')).toBeNull();
        expect(view.getByRole('status').textContent).toContain('two characters');
        expect((view.getByRole('combobox') as HTMLSelectElement).disabled).toBe(false);
    });
});
