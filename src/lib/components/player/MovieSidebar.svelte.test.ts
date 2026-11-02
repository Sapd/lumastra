// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
const { getMovieDetails, getMediaDetailsByQuery, getSimilarMedia } = vi.hoisted(() => ({
    getMovieDetails: vi.fn(),
    getMediaDetailsByQuery: vi.fn().mockResolvedValue({ data: { actors: [] } }),
    getSimilarMedia: vi.fn().mockResolvedValue({ data: { similar: [] } }),
}));
vi.mock('$lib/api/content', () => ({ getMovieDetails, getMediaDetailsByQuery, getSimilarMedia }));
import MovieSidebar from './MovieSidebar.svelte';
afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

it('ignores old movie details that arrive after changing the playing movie', async () => {
    let finishOld!: (value: unknown) => void;
    getMovieDetails.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finishOld = resolve;
            }),
    );
    getMovieDetails.mockResolvedValue({
        data: { title: 'New movie', type: 'movie', ids: {}, genres: [], user: {} },
    });
    const view = render(MovieSidebar, { itemId: 'old-movie', isOpen: true });
    await waitFor(() => expect(getMovieDetails).toHaveBeenCalledWith('old-movie'));
    await view.rerender({ itemId: 'new-movie', isOpen: true });
    await view.findByRole('heading', { name: 'New movie' });
    finishOld({ data: { title: 'Old movie', type: 'movie', ids: {}, genres: [], user: {} } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.queryByRole('heading', { name: 'Old movie' })).toBeNull();
    expect(view.getByRole('heading', { name: 'New movie' })).toBeTruthy();
});
