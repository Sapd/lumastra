// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';

const api = vi.hoisted(() => ({
    getMovieDetails: vi.fn(),
    getMediaDetailsByQuery: vi.fn(),
}));
vi.mock('$lib/api/content', () => api);
vi.mock('$app/stores', () => ({ page: writable({ data: { user: {} } }) }));

import MovieSidebar from './MovieSidebar.svelte';
import { playerStore } from './playerStore.svelte';

beforeEach(() => {
    api.getMovieDetails.mockResolvedValue({
        data: {
            id: 'movie-one',
            title: 'Test movie',
            type: 'movie',
            ids: {},
            overview: 'The complete synopsis.',
            genres: [],
            year: 2026,
        },
    });
    api.getMediaDetailsByQuery.mockResolvedValue({
        data: { actors: [{ name: 'Test performer', character: 'The pilot' }] },
    });
    playerStore.chapters = [
        { name: 'Opening', startMs: 0, endMs: 60_000, index: 0, image: null },
        { name: 'Awakening', startMs: 60_000, endMs: 120_000, index: 1, image: null },
    ];
    playerStore.currentTime = 65;
});
afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    playerStore.playbackInfo = null;
    playerStore.chapters = [];
});

describe('movie drawer', () => {
    it('shows synopsis and optional cast, marks the current chapter, and seeks in seconds', async () => {
        const onseek = vi.fn(),
            onclose = vi.fn();
        const view = render(MovieSidebar, { isOpen: true, itemId: 'movie-one', onseek, onclose });
        await waitFor(() => expect(view.getByText('The complete synopsis.')).toBeTruthy());
        expect(view.getByText('Test performer')).toBeTruthy();
        const chapter = view.getByRole('button', { name: /Awakening/ });
        expect(chapter.getAttribute('aria-current')).toBe('true');
        await fireEvent.click(chapter);
        expect(onseek).toHaveBeenCalledWith(60);
        expect(onclose).toHaveBeenCalledOnce();
    });
    it('keeps chapter navigation disabled for watch-party guests', async () => {
        const onseek = vi.fn();
        const view = render(MovieSidebar, {
            isOpen: true,
            itemId: 'movie-one',
            readOnly: true,
            onseek,
        });
        await waitFor(() => expect(view.getByRole('button', { name: /Awakening/ })).toBeTruthy());
        const chapter = view.getByRole('button', { name: /Awakening/ }) as HTMLButtonElement;
        expect(chapter.disabled).toBe(true);
        await fireEvent.click(chapter);
        expect(onseek).not.toHaveBeenCalled();
    });
    it('keeps metadata usable when the optional cast request fails', async () => {
        api.getMediaDetailsByQuery.mockRejectedValue(new Error('offline'));
        const view = render(MovieSidebar, { isOpen: true, itemId: 'movie-one' });
        await waitFor(() => expect(view.getByText('The complete synopsis.')).toBeTruthy());
        expect(view.queryByText('Test performer')).toBeNull();
        expect(
            (view.getByRole('button', { name: /Awakening/ }) as HTMLButtonElement).disabled,
        ).toBe(true);
    });
});
