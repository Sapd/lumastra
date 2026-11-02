// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UniversalMediaItem } from '$lib/schemas/api-responses';
import UniversalMediaCard from './UniversalMediaCard.svelte';
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/utils/modal-utils', () => ({ openArtistModal: vi.fn() }));
const series: UniversalMediaItem = {
    id: '10000000-0000-0000-0000-000000000001',
    mediaType: 'series',
    title: 'A series',
    image: '/test-poster.png',
    externalIds: {},
    isAvailable: true,
    canRequest: false,
    seasonCount: 3,
    episodeCount: 60,
    availableEpisodeCount: 24,
    watchedEpisodeCount: 12,
    unwatchedEpisodeCount: 12,
};
beforeEach(() => {
    window.matchMedia = vi.fn().mockImplementation(
        () =>
            ({
                matches: false,
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
            }) as unknown as MediaQueryList,
    );
});
afterEach(cleanup);
describe('library and discovery series cards', () => {
    it('shows the playable unwatched count in library mode and completion after a refresh', async () => {
        const { container, rerender } = render(UniversalMediaCard, {
            item: series,
            showSeriesCountBadge: true,
        });
        expect(container.querySelector('[aria-label="12 unwatched episodes"]')?.textContent).toBe(
            '12',
        );
        expect(container.textContent).toContain('3 seasons · 60 episodes');
        await rerender({
            item: { ...series, isPlayed: true, watchedEpisodeCount: 24, unwatchedEpisodeCount: 0 },
            showSeriesCountBadge: true,
        });
        expect(
            container.querySelector('[aria-label="All available episodes watched"]')?.textContent,
        ).toBe('✓');
        expect(
            container.querySelectorAll('[aria-label="All available episodes watched"]'),
        ).toHaveLength(1);
    });
    it('shows count and completion badges in the list layout too', async () => {
        const { container, rerender } = render(UniversalMediaCard, {
            item: series,
            variant: 'list',
            showSeriesCountBadge: true,
        });
        expect(container.querySelector('[aria-label="12 unwatched episodes"]')?.textContent).toBe(
            '12',
        );
        await rerender({
            item: { ...series, unwatchedEpisodeCount: 0, watchedEpisodeCount: 24 },
            variant: 'list',
            showSeriesCountBadge: true,
        });
        expect(
            container.querySelector('[aria-label="All available episodes watched"]')?.textContent,
        ).toBe('✓');
    });
    it('shows discovery metadata without an unwatched badge', () => {
        const { container } = render(UniversalMediaCard, { item: series });
        expect(container.querySelector('[aria-label="12 unwatched episodes"]')).toBeNull();
        expect(container.textContent).toContain('60 episodes');
        expect(container.querySelector('[title="3 seasons · 60 episodes"]')).toBeTruthy();
    });
    it('shows no completion badge for zero availability or a movie', () => {
        const unavailable = render(UniversalMediaCard, {
            item: { ...series, isPlayed: true, availableEpisodeCount: 0, unwatchedEpisodeCount: 0 },
            showSeriesCountBadge: true,
        });
        expect(
            unavailable.container.querySelector('[aria-label="All available episodes watched"]'),
        ).toBeNull();
        expect(unavailable.container.textContent).not.toContain('✓');
        const movie = render(UniversalMediaCard, {
            item: { ...series, mediaType: 'movie' },
            showSeriesCountBadge: true,
        });
        expect(movie.container.querySelector('[aria-label="12 unwatched episodes"]')).toBeNull();
        expect(movie.container.textContent).not.toContain('60 episodes');
    });
});
