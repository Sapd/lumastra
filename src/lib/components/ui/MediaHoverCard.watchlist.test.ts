// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Wiring test for the hover popup's watchlist button.
 *
 * The popup is built as imperative DOM, so this button is not the shared
 * <WatchlistButton> component and nothing re-renders it — it repaints itself.
 * Three things can therefore silently break, and each has a test here:
 *
 *   1. it must appear only for movies/series (the rule `canWatchlistMedia`
 *      enforces for the context menu),
 *   2. clicking it must NOT close the popup — every other action in that row
 *      does, via the shared `[data-action]` delegation, so the button
 *      deliberately opts out of that attribute, and
 *   3. the icon/label must flip after a toggle, and must NOT flip when the
 *      call failed.
 */

import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRawSnippet } from 'svelte';
import { get, readable } from 'svelte/store';

// Explicit result type — inference from the default implementation would pin
// `error` to `null` and reject the failure case below.
type MutationResult = { error: string | null };

const saveMovie = vi.fn(async (_body: unknown): Promise<MutationResult> => ({ error: null }));
const unsaveMovie = vi.fn(async (_body: unknown): Promise<MutationResult> => ({ error: null }));

vi.mock('$app/navigation', () => ({
    goto: async () => {},
    beforeNavigate: () => {},
    invalidate: async () => {},
}));
vi.mock('$app/stores', () => ({
    page: readable({ data: { features: {}, user: {} }, url: new URL('http://localhost/') }),
}));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/api/ai', () => ({
    saveMovie: (body: unknown) => saveMovie(body),
    unsaveMovie: (body: unknown) => unsaveMovie(body),
    submitRating: async () => ({ error: null }),
}));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('$lib/api/playback', () => ({
    releasePreviewPlayback: vi.fn(),
    createPreviewSession: async () => ({ error: 'not expected', data: null }),
}));
// happy-dom cannot lay out a floating element; positioning is not under test.
vi.mock('@floating-ui/dom', () => ({
    computePosition: async () => ({ x: 0, y: 0, placement: 'top', strategy: 'absolute' }),
    autoUpdate: () => () => {},
    offset: () => ({}),
    shift: () => ({}),
    flip: () => ({}),
}));
vi.mock('$lib/utils/video-player-utils', () => ({
    ensureYouTubeApi: () => {},
    waitForYouTubeApi: () => {},
    createYouTubePlayer: () => null,
    destroyYouTubePlayer: () => null,
    calculateSmartPreviewPosition: () => ({ x: 0, y: 0 }),
    PREVIEW_FALLBACK_START_SECONDS: 0,
}));

import MediaHoverCard from './MediaHoverCard.svelte';
import { setWatchlistItems, watchlistItems } from '$lib/stores/watchlist';
import type { UniversalMediaItem } from '$lib/types/server-driven-ui';

const MOVIE_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const BOOK_UUID = '11111111-2222-4333-8444-555555555555';

const movieItem: UniversalMediaItem = {
    id: MOVIE_UUID,
    externalIds: { internal: MOVIE_UUID, tmdb: '949' },
    mediaType: 'movie',
    title: 'Haze',
    image: `/api/media/${MOVIE_UUID}/images/poster`,
    isAvailable: true,
    hasFiles: true,
    canRequest: false,
};

const audiobookItem: UniversalMediaItem = {
    id: BOOK_UUID,
    externalIds: { internal: BOOK_UUID },
    mediaType: 'audiobook',
    title: 'Der Sternwind',
    image: `/api/media/${BOOK_UUID}/images/poster`,
    isAvailable: true,
    hasFiles: true,
    canRequest: false,
};

const cardSnippet = createRawSnippet(() => ({
    render: () => '<div data-play-button data-testid="card">card</div>',
}));

async function hover(): Promise<void> {
    const card = document.querySelector('[data-play-button]');
    if (!card) throw new Error('card not rendered');
    await fireEvent.mouseOver(card);
    for (let i = 0; i < 4; i++) {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
}

function watchlistButton(): HTMLElement {
    const btn = document.querySelector('[data-watchlist-toggle]');
    if (!(btn instanceof HTMLElement)) throw new Error('watchlist button not rendered');
    return btn;
}

/** 'none' while unsaved, 'currentColor' once saved. */
function iconFill(btn: HTMLElement): string | null {
    return btn.querySelector('svg')?.getAttribute('fill') ?? null;
}

describe('MediaHoverCard — watchlist button', () => {
    beforeEach(() => {
        saveMovie.mockClear();
        unsaveMovie.mockClear();
        saveMovie.mockImplementation(async () => ({ error: null }));
        unsaveMovie.mockImplementation(async () => ({ error: null }));
        setWatchlistItems([]);
    });

    afterEach(() => {
        cleanup();
        document.body.querySelectorAll('.media-hover-portal').forEach((el) => {
            el.textContent = '';
        });
    });

    test('renders unsaved for a movie that is not on the watchlist', async () => {
        render(MediaHoverCard, { item: movieItem, children: cardSnippet, delay: 0 });
        await hover();

        const btn = watchlistButton();
        expect(btn.getAttribute('aria-pressed')).toBe('false');
        expect(btn.getAttribute('aria-label')).toBe('Add to Watchlist');
        expect(iconFill(btn)).toBe('none');
    });

    test('renders saved when the store already holds the item', async () => {
        setWatchlistItems([
            {
                externalIds: movieItem.externalIds,
                mediaType: 'movie',
                title: 'Haze',
                savedAt: '2026-08-11T00:00:00.000Z',
            },
        ]);

        render(MediaHoverCard, { item: movieItem, children: cardSnippet, delay: 0 });
        await hover();

        const btn = watchlistButton();
        expect(btn.getAttribute('aria-pressed')).toBe('true');
        expect(btn.getAttribute('aria-label')).toBe('Remove from Watchlist');
        expect(iconFill(btn)).toBe('currentColor');
    });

    test('a click saves, repaints in place, and leaves the popup open', async () => {
        render(MediaHoverCard, { item: movieItem, children: cardSnippet, delay: 0 });
        await hover();

        await fireEvent.click(watchlistButton());

        expect(saveMovie).toHaveBeenCalledTimes(1);
        // The popup must survive — every other action in this row hides it.
        expect(document.querySelector('.popup-content')).toBeTruthy();

        const btn = watchlistButton();
        expect(btn.getAttribute('aria-pressed')).toBe('true');
        expect(btn.getAttribute('aria-label')).toBe('Remove from Watchlist');
        expect(iconFill(btn)).toBe('currentColor');
        expect(btn.querySelector('.tooltip-text')?.textContent).toBe('Remove from Watchlist');
        // The shared membership index is what every other surface reads.
        expect(get(watchlistItems)).toHaveLength(1);
    });

    test('a second click removes it again', async () => {
        render(MediaHoverCard, { item: movieItem, children: cardSnippet, delay: 0 });
        await hover();

        await fireEvent.click(watchlistButton());
        await fireEvent.click(watchlistButton());

        expect(unsaveMovie).toHaveBeenCalledTimes(1);
        const btn = watchlistButton();
        expect(btn.getAttribute('aria-pressed')).toBe('false');
        expect(iconFill(btn)).toBe('none');
        expect(get(watchlistItems)).toHaveLength(0);
    });

    test('a failed save leaves the button showing the old state', async () => {
        saveMovie.mockImplementation(async () => ({ error: 'boom' }));

        render(MediaHoverCard, { item: movieItem, children: cardSnippet, delay: 0 });
        await hover();
        await fireEvent.click(watchlistButton());

        const btn = watchlistButton();
        expect(btn.getAttribute('aria-pressed')).toBe('false');
        expect(iconFill(btn)).toBe('none');
        expect(get(watchlistItems)).toHaveLength(0);
    });

    test('an audiobook gets no watchlist button', async () => {
        render(MediaHoverCard, { item: audiobookItem, children: cardSnippet, delay: 0 });
        await hover();

        expect(document.querySelector('.popup-content')).toBeTruthy();
        expect(document.querySelector('[data-watchlist-toggle]')).toBeNull();
    });

    test('an episode gets no watchlist button', async () => {
        render(MediaHoverCard, {
            item: { ...movieItem, mediaType: 'episode' },
            children: cardSnippet,
            delay: 0,
        });
        await hover();

        expect(document.querySelector('.popup-content')).toBeTruthy();
        expect(document.querySelector('[data-watchlist-toggle]')).toBeNull();
    });
});
