// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';
const { getTrending, getListItems, getLists } = vi.hoisted(() => ({
    getTrending: vi.fn(),
    getListItems: vi.fn(),
    getLists: vi.fn(),
}));
// The ids must be built-in list ids from Trending.svelte's DEFAULT_DROPDOWN_GROUPS, or the
// dropdown hides the lists; only the display names are free text.
const DEFAULT_LISTS = {
    data: {
        items: [
            { id: 'netflix-movies', name: 'Harborline movies' },
            { id: 'disney-movies', name: 'Lanternbox movies' },
        ],
    },
    error: null,
};
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$app/stores', () => ({
    navigating: readable(null),
    page: readable({ data: {}, url: new URL('http://localhost/') }),
}));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/api/content', () => ({
    getTrending,
    getListItems,
    getLists,
}));
import Trending from './Trending.svelte';
afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});
beforeEach(() => getLists.mockResolvedValue(DEFAULT_LISTS));

// A fresh install has no curated lists synced, yet /api/lists names every
// configured list (itemCount 0, lastSyncedAt null). The empty-trending fallback
// fetched 'trending-movies' regardless — a 404, i.e. a console error on every
// Home load.
test.each([
    ['absent from the index', DEFAULT_LISTS],
    [
        'configured but never synced',
        {
            data: {
                items: [
                    {
                        id: 'trending-movies',
                        name: 'Trending movies',
                        itemCount: 0,
                        lastSyncedAt: null,
                    },
                ],
            },
            error: null,
        },
    ],
])('empty trending does not request a fallback list that is %s', async (_label, lists) => {
    getLists.mockResolvedValue(lists);
    getTrending.mockResolvedValue({ data: { items: [] }, error: null });
    render(Trending);
    await waitFor(() => expect(getTrending).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getLists).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(getListItems).not.toHaveBeenCalled();
});

test('empty trending still falls back to the curated list once it exists', async () => {
    getTrending.mockResolvedValue({ data: { items: [] }, error: null });
    getLists.mockResolvedValue({
        data: { items: [{ id: 'trending-movies', name: 'Trending movies', itemCount: 20 }] },
        error: null,
    });
    getListItems.mockResolvedValue({ data: { items: [] }, error: null });
    render(Trending);
    await waitFor(() => expect(getListItems).toHaveBeenCalledWith('trending-movies', 20));
});

test('a late initial response cannot overwrite the selected curated list', async () => {
    let finish!: (value: { data: { items: never[] }; error: null }) => void;
    getTrending.mockReturnValue(
        new Promise((resolve) => {
            finish = resolve;
        }),
    );
    getListItems.mockResolvedValue({
        data: {
            items: [
                {
                    id: 'tmdb:123:movie',
                    catalogId: null,
                    title: 'Selected movie',
                    type: 'movie',
                    ids: { tmdb: '123' },
                    images: {},
                    availability: { isAvailable: true, canRequest: false },
                },
            ],
        },
        error: null,
    });
    render(Trending);
    await fireEvent.click(await screen.findByRole('button', { name: 'Trending', expanded: false }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Harborline movies' }));
    await screen.findByText('Selected movie');
    finish({ data: { items: [] }, error: null });
    await waitFor(() => expect(getTrending).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Selected movie')).toBeTruthy();
    expect(getListItems).toHaveBeenCalledTimes(1);
});
