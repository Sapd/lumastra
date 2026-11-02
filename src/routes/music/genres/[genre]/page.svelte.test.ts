// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, render, screen, within } from '@testing-library/svelte';
import { writable } from 'svelte/store';
import { afterEach, expect, it, vi } from 'vitest';
import GenrePage from './+page.svelte';
import type { PageData } from './$types';

vi.mock('$app/stores', () => ({
    page: writable({
        route: { id: '/music/genres/[genre]' },
        url: new URL('https://example.test/base/music/genres/rock'),
        data: {},
    }),
}));
vi.mock('$lib/paths', () => ({ resolve: (path: string) => `/base${path}` }));
vi.mock('$lib/api/music', () => ({ pinMusicGenre: vi.fn(), unpinMusicGenre: vi.fn() }));
vi.mock('$lib/stores/music-player.store', () => ({
    musicPlayerStore: { seedAutoplay: vi.fn(), play: vi.fn() },
}));
vi.mock('$lib/utils/modal-utils', () => ({ openAlbumModal: vi.fn() }));

afterEach(cleanup);

it('renders primary navigation and a separate contextual Explore return', () => {
    const { container } = render(GenrePage, {
        data: { genre: 'rock', albums: [], tracks: [], isPinned: false } as unknown as PageData,
    });
    const nav = container.querySelector('nav');
    expect(container.querySelectorAll('nav')).toHaveLength(1);
    expect(nav).toBeTruthy();
    if (!nav) throw new Error('Missing primary music navigation');
    for (const name of ['Home', 'Explore', 'Library', 'Search'])
        expect(within(nav).getByRole('link', { name })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'Explore' }).getAttribute('aria-current')).toBe(
        'page',
    );
    const returns = screen.getAllByRole('link', { name: 'Explore' });
    expect(returns).toHaveLength(2);
    expect(returns.find((link) => !nav.contains(link))?.getAttribute('href')).toBe(
        '/base/music/explore',
    );
});
