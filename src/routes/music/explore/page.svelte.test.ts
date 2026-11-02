// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { writable, type Writable } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$app/stores', () => ({
    page: writable({
        url: new URL('https://example.test/music/explore'),
        route: { id: '/music/explore' },
        data: { features: { sonicEmbeddings: true, musicAlchemy: true } },
    }),
}));
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }));
vi.mock('$lib/api/music', () => ({ pinMusicGenre: vi.fn(), unpinMusicGenre: vi.fn() }));
vi.mock('$lib/stores/music-player.store', () => ({
    musicPlayerStore: { ...writable({ autoplaySeed: null }), seedAutoplay: vi.fn() },
}));

import { page } from '$app/stores';
import Explore from './+page.svelte';

const pageStore = page as unknown as Writable<{
    url: URL;
    route: { id: string };
    data: { features: { sonicEmbeddings: boolean; musicAlchemy: boolean } };
}>;
const libraryGenres = Array.from({ length: 24 }, (_, i) => ({
    genre: `Genre ${i + 1}`,
    trackCount: 10,
    albumCount: 1,
}));
const data = {
    libraryGenres,
    pinnedGenreNames: ['Genre 1'],
    genreCovers: Object.fromEntries(libraryGenres.map(({ genre }, i) => [genre, [`album-${i}`]])),
    moodChips: [{ genre: 'focus', label: 'Focus', emoji: '🎧' }],
};

beforeEach(() => {
    pageStore.set({
        url: new URL('https://example.test/music/explore'),
        route: { id: '/music/explore' },
        data: { features: { sonicEmbeddings: true, musicAlchemy: true } },
    });
});
afterEach(cleanup);

describe('Explore discovery flow', () => {
    it('places enabled tools and moods before a genre grid that expands and collapses', async () => {
        const { container } = render(Explore, { data });
        const grid = screen.getByTestId('genre-cover-grid');
        const tools = screen.getByTestId('music-feature-tiles');
        const moods = screen.getByRole('heading', { name: 'Moods' });
        expect(tools.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(moods.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(grid.querySelectorAll('a')).toHaveLength(12);
        const toggle = screen.getByRole('button', { name: 'Show all 24 genres' });
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        await fireEvent.click(toggle);
        expect(grid.querySelectorAll('a')).toHaveLength(24);
        expect(grid.querySelector('a[href="/music/genres/Genre%2024"]')).toBeTruthy();
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        await fireEvent.click(screen.getByRole('button', { name: 'Show fewer genres' }));
        expect(grid.querySelectorAll('a')).toHaveLength(12);
        expect(container.querySelector('details[open]')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Unpin from home' })).toBeTruthy();
        expect(tools.querySelector('a[href="/music/path"]')).toBeTruthy();
        expect(tools.querySelector('a[href="/music/alchemy"]')).toBeTruthy();
        expect(tools.querySelector('a[href="/music/map"]')).toBeNull();
    });

    it('keeps disabled tools hidden and the complete genre browser available', async () => {
        pageStore.update((current) => ({
            ...current,
            data: { features: { sonicEmbeddings: false, musicAlchemy: false } },
        }));
        const { container } = render(Explore, { data });
        expect(container.querySelector('[data-testid="feature-tile"]')).toBeNull();
        await fireEvent.click(screen.getByRole('button', { name: '+12 more' }));
        expect(container.querySelector('details a[href="/music/genres/Genre%2024"]')).toBeTruthy();
    });
});
