// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Regression coverage for the desktop /music search-input-wipe bug.
 *
 * MusicSearchResults owns two effects that keep `query` and the `?q=` URL
 * param in sync. The URL -> state effect must NEVER treat "the URL hasn't
 * caught up with state yet" (its own first run, before the state -> URL
 * effect has had a chance to write `?q=`) as a real navigation and stomp
 * freshly-typed state. On desktop /music the component only mounts once
 * `isSearchMode` flips true (2nd keystroke) — at that exact instant `$page.url`
 * still has no `q`, while `query` is already "ab". The URL -> state effect
 * must leave `query` alone on that first run, and only apply the URL over
 * state when the URL has ACTUALLY CHANGED since the effect last observed it
 * (a genuine back/forward navigation or external link).
 *
 * Assertions read the rendered "No results for "<query>"" copy (rather than
 * poking at the bindable prop object directly) because:
 *   1. It is what a user actually sees — the reported bug ("typed text
 *      instantly reverts") is a DOM-visible symptom: a wipe drops `query`
 *      below the 2-char `isSearchMode` threshold, which unmounts the whole
 *      panel underneath the still-showing "ab" in the real host's <input>.
 *   2. testing-library/svelte's bindable-prop-echo mechanism (mutating the
 *      literal props object passed into `render()`) only reflects
 *      component-initiated writes made against that exact object reference;
 *      it does not survive a `rerender()` call (which swaps in a merged
 *      object), so it can't validate every scenario here uniformly.
 *
 * `$app/stores`' `page` is mocked with a minimal hand-rolled store so tests
 * can simulate a SvelteKit navigation changing `$page.url` after mount.
 * `$app/environment`'s `browser` is mocked true (the component only ever
 * runs client-side in production) — the component's own "stale $page
 * mid-navigation" guard cross-checks `$page.url` against `window.location`,
 * so tests drive both together via `setUrl()`.
 */

import { render, cleanup, fireEvent } from '@testing-library/svelte';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    test,
    vi,
} from 'vitest';
import { tick, flushSync } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import type { MusicItemHandlers } from '$lib/utils/music-item-handlers.svelte';

// $lib/paths — resolve() is an identity function in tests (no base path).
vi.mock('$lib/paths', () => ({
    resolve: (path: string) => path,
}));

// SectionRenderer / SectionSkeleton import $env/dynamic/public transitively
// (see SemanticSearchSection.test.ts for the same requirement).
vi.mock('$env/dynamic/public', () => ({ env: {} }));

// $app/environment — the component only runs client-side; mock browser=true
// to exercise the same code path production hits (raw History API writes,
// the stale-$page cross-check).
vi.mock('$app/environment', () => ({
    browser: true,
}));

// $app/stores — a minimal hand-rolled Svelte store (subscribe/set) so tests
// can push new $page values to simulate SvelteKit navigation (back/forward)
// after mount. Declared via vi.hoisted() since vi.mock() factories are
// hoisted above module-top-level const declarations and even above regular
// imports — a real `svelte/store` import isn't guaranteed to be initialized
// yet at that point, so the store contract is implemented inline instead.
const pageStore = vi.hoisted(() => {
    // happy-dom's default document origin is http://localhost:3000 — match it
    // so History.pushState() (used by setUrl() below) doesn't SecurityError.
    let value: { url: URL; data: Record<string, unknown> } = {
        url: new URL('http://localhost:3000/music'),
        data: {},
    };
    const subscribers = new Set<(v: typeof value) => void>();
    return {
        subscribe(fn: (v: typeof value) => void): () => void {
            fn(value);
            subscribers.add(fn);
            return () => subscribers.delete(fn);
        },
        set(next: typeof value): void {
            value = next;
            subscribers.forEach((fn) => fn(value));
        },
    };
});

const navigatingStore = vi.hoisted(() => ({
    subscribe(fn: (v: null) => void): () => void {
        fn(null);
        return () => {};
    },
}));

vi.mock('$app/stores', () => ({
    page: pageStore,
    navigating: navigatingStore,
}));

// The search fetch — mock the api client modules the component imports so no
// real network call happens. Results are irrelevant to these tests (query
// sync is the concern), so return empty payloads — that also keeps the
// component on its "No results for ..." branch, which we assert against.
vi.mock('$lib/api/content', () => ({
    search: vi.fn(),
}));

vi.mock('$lib/api/music', () => ({
    getMusicGenres: vi.fn().mockResolvedValue({ data: { genres: [] }, error: null, status: 200 }),
}));

// The track list reads the now-playing id and starts playback directly.
const playerStore = vi.hoisted(() => ({
    subscribe(fn: (v: { currentTrack: null; isPlaying: boolean }) => void): () => void {
        fn({ currentTrack: null, isPlaying: false });
        return () => {};
    },
    startPlayback: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/stores/music-player.store', () => ({ musicPlayerStore: playerStore }));

// The song rows' artist/album links open the entity modals directly (like the
// mini player); spy on them instead of mounting a modal.
const modals = vi.hoisted(() => ({ openArtistModal: vi.fn(), openAlbumModal: vi.fn() }));
vi.mock('$lib/utils/modal-utils', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/utils/modal-utils')>()),
    ...modals,
}));

import MusicSearchResults from './MusicSearchResults.svelte';
import { search } from '$lib/api/content';

const emptySearch: Awaited<ReturnType<typeof search>> = {
    data: { items: [], page: { limit: 30, hasMore: false } },
    error: null,
    status: 200,
};

// Translation integration belongs to the main worker; keep this focused suite
// runnable while that generated export is pending.
vi.mock('$lib/paraglide/messages.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    viewer_music_search_error: () => 'Some music results could not be loaded. Try again.',
}));

async function settleSearch(): Promise<void> {
    flushSync();
    await vi.advanceTimersByTimeAsync(200);
    flushSync();
}

const noopHandlers: MusicItemHandlers = {
    hiddenTrackIds: new SvelteSet<string>(),
    posterImages: () => undefined,
    getTrackInternalId: () => undefined,
    handleItemClick: () => {},
    handleItemPlay: async () => {},
    handleItemMore: () => {},
    handleItemRemove: () => {},
};

/**
 * Point `$page.url` AND `window.location` at the same URL — the component's
 * stale-snapshot guard requires them to agree before it trusts `$page.url`,
 * matching what a real completed SvelteKit navigation looks like.
 */
function setUrl(q: string): void {
    const url = new URL(q ? `http://localhost:3000/music?q=${q}` : 'http://localhost:3000/music');
    window.history.pushState({}, '', url);
    pageStore.set({ url, data: {} });
}

describe('MusicSearchResults — URL/state sync (search-revert regression)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.mocked(search).mockResolvedValue(emptySearch);
    });
    afterEach(() => {
        cleanup();
        setUrl('');
        vi.useRealTimers();
    });

    test('mounting mid-type with an un-synced URL must not wipe the typed query', async () => {
        // Desktop /music mounts this component only once isSearchMode flips true
        // (2nd keystroke) — at that instant the state -> URL effect has not yet
        // written ?q= to the address bar, so $page.url still has no `q`. This is
        // the exact repro for the reported bug: typed text instantly reverts.
        setUrl('');
        const { container } = render(MusicSearchResults, { query: 'ab', handlers: noopHandlers });
        flushSync();

        await settleSearch();

        // If `query` got wiped to '', isSearchMode flips false and the ENTIRE
        // panel (including this text) disappears from the DOM.
        expect(container.textContent).toContain('No results for "ab"');
    });

    test('deep link /music?q=xy: query is preserved (not blanked) on first mount', async () => {
        setUrl('xy');
        const { container } = render(MusicSearchResults, { query: 'xy', handlers: noopHandlers });
        await settleSearch();

        expect(container.textContent).toContain('No results for "xy"');
    });

    test('a genuine URL change after mount (back/forward nav) IS applied to query', async () => {
        setUrl('a1');
        const { container } = render(MusicSearchResults, { query: 'a1', handlers: noopHandlers });
        await settleSearch();
        expect(container.textContent).toContain('No results for "a1"');

        // Simulate back/forward: $page.url changes to a different value than the
        // one the effect last observed — this is a real, effect-visible change.
        setUrl('b2');
        await tick();
        await settleSearch();

        expect(container.textContent).toContain('No results for "b2"');
    });

    test('back navigation to a bare URL (no q) clears the query and closes the panel', async () => {
        setUrl('a1');
        const { container } = render(MusicSearchResults, { query: 'a1', handlers: noopHandlers });
        await settleSearch();
        expect(container.textContent).toContain('No results for "a1"');

        setUrl('');
        await tick();
        flushSync();

        // query cleared -> below the 2-char threshold -> panel closes entirely.
        expect(container.textContent).not.toContain('No results for');
    });

    test('typing more characters while mounted does not trigger a URL -> state re-sync', async () => {
        // Mounts with the URL already agreeing with `query` (post the state -> URL
        // effect having run once), then the host's bound `query` advances from
        // further typing WITHOUT the URL having caught up yet.
        setUrl('ab');
        const { container, rerender } = render(MusicSearchResults, {
            query: 'ab',
            handlers: noopHandlers,
        });
        flushSync();

        // If `query` were a tracked (non-untrack'd) dependency of the URL -> state
        // effect, this rerender would re-run it, see urlQ ('ab') differ from the
        // new query, and wipe the newly typed text back down to 'ab'.
        await rerender({ query: 'abc', handlers: noopHandlers });
        await settleSearch();

        expect(container.textContent).toContain('No results for "abc"');
    });

    test('keeps loading through a newer query debounce when an older request settles', async () => {
        let finishOld!: (value: Awaited<ReturnType<typeof search>>) => void;
        vi.mocked(search).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishOld = resolve;
                }),
        );
        const { container, rerender } = render(MusicSearchResults, {
            query: 'old',
            handlers: noopHandlers,
        });
        await settleSearch();
        await rerender({ query: 'new', handlers: noopHandlers });
        finishOld(emptySearch);
        await tick();
        flushSync();
        expect(container.querySelector('[role="status"]')).not.toBeNull();
        expect(container.textContent).not.toContain('No results for');
        await settleSearch();
        expect(container.textContent).toContain('No results for "new"');
    });

    test('failed searches show an error and retry instead of a false empty state', async () => {
        vi.mocked(search).mockRejectedValueOnce(new Error('offline'));
        const { container, getByRole } = render(MusicSearchResults, {
            query: 'test',
            handlers: noopHandlers,
        });
        await settleSearch();
        expect(getByRole('alert').textContent).toContain('could not be loaded');
        expect(container.textContent).not.toContain('No results for');
        await fireEvent.click(getByRole('button', { name: 'Retry' }));
        await tick();
        flushSync();
        expect(container.querySelector('[role="alert"]')).toBeNull();
        expect(container.textContent).toContain('No results for "test"');
    });
});

describe('MusicSearchResults — song list', () => {
    const trackSearch: Awaited<ReturnType<typeof search>> = {
        data: {
            items: Array.from({ length: 12 }, (_, i) => ({
                id: `track-${i}`,
                type: 'track' as const,
                ids: { internal: `track-${i}` },
                title: `Song ${i}`,
                overview: `Artist ${i} · Album ${i}`,
                album: `Album ${i}`,
                albumId: `album-${i}`,
                artistId: `artist-${i}`,
                durationMs: 185000,
                year: 2020,
                isAvailable: true,
                rank: 1,
            })),
            page: { limit: 30, hasMore: false },
        },
        error: null,
        status: 200,
    } as unknown as Awaited<ReturnType<typeof search>>;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.mocked(search).mockResolvedValue(trackSearch);
        playerStore.startPlayback.mockClear();
    });
    afterEach(() => {
        cleanup();
        setUrl('');
        vi.useRealTimers();
    });

    test('renders every fetched song as a compact row with credit and duration', async () => {
        const { container, queryByRole } = render(MusicSearchResults, {
            query: 'song',
            handlers: noopHandlers,
        });
        await settleSearch();
        // No client-side fold: a ranked hit at row 11 used to hide behind
        // "Show all" and read as "not found".
        expect(container.querySelectorAll('[data-track-row]')).toHaveLength(12);
        // The play button is stretched over the row; the visible text sits beside it.
        const row = container.querySelector('[data-track-row]')!.closest('li')!;
        expect(row.textContent).toContain('Song 0');
        expect(row.textContent).toContain('Artist 0 · Album 0 · 2020');
        expect(row.textContent).toContain('3:05');
        expect(queryByRole('button', { name: 'Load more' })).toBeNull();
    });

    test('asks for each section separately so songs get their own window', async () => {
        vi.mocked(search).mockClear();
        render(MusicSearchResults, { query: 'song', handlers: noopHandlers });
        await settleSearch();
        const types = vi.mocked(search).mock.calls.map(([, opts]) => opts?.types);
        expect(types.sort()).toEqual(['album', 'artist', 'track']);
    });

    test('"Load more" pages the next songs in from the server', async () => {
        const page = (from: number, count: number, hasMore: boolean) =>
            ({
                ...trackSearch,
                data: {
                    items: trackSearch.data!.items.slice(0, count).map((item, i) => ({
                        ...item,
                        id: `track-${from + i}`,
                        ids: { internal: `track-${from + i}` },
                        title: `Song ${from + i}`,
                    })),
                    page: { limit: 20, hasMore },
                },
            }) as Awaited<ReturnType<typeof search>>;
        vi.mocked(search).mockImplementation(async (_q, opts) =>
            opts?.types !== 'track'
                ? emptySearch
                : (opts.offset ?? 0) === 0
                  ? page(0, 12, true)
                  : page(12, 3, false),
        );
        const { container, getByRole, queryByRole } = render(MusicSearchResults, {
            query: 'song',
            handlers: noopHandlers,
        });
        await settleSearch();
        expect(container.querySelectorAll('[data-track-row]')).toHaveLength(12);
        await fireEvent.click(getByRole('button', { name: 'Load more' }));
        await tick();
        flushSync();
        expect(vi.mocked(search)).toHaveBeenLastCalledWith(
            'song',
            expect.objectContaining({ types: 'track', offset: 12 }),
        );
        expect(container.querySelectorAll('[data-track-row]')).toHaveLength(15);
        expect(queryByRole('button', { name: 'Load more' })).toBeNull();
    });

    /** First page: 12 songs with more on the server; later pages via `next`. */
    function pagedSearch(next: () => Promise<Awaited<ReturnType<typeof search>>>) {
        vi.mocked(search).mockImplementation(async (_q, opts) => {
            if (opts?.types !== 'track') return emptySearch;
            if ((opts.offset ?? 0) > 0) return next();
            return {
                ...trackSearch,
                data: { ...trackSearch.data!, page: { limit: 20, hasMore: true } },
            } as Awaited<ReturnType<typeof search>>;
        });
    }

    test('a failed "Load more" keeps the songs and offers it again', async () => {
        pagedSearch(async () => ({ data: null, error: { message: 'boom' }, status: 500 }) as never);
        const { container, getByRole } = render(MusicSearchResults, {
            query: 'song',
            handlers: noopHandlers,
        });
        await settleSearch();
        await fireEvent.click(getByRole('button', { name: 'Load more' }));
        await tick();
        flushSync();
        expect(container.querySelectorAll('[data-track-row]')).toHaveLength(12);
        expect(getByRole('alert').textContent).toContain('could not be loaded');
        expect(getByRole('button', { name: 'Load more' }).getAttribute('aria-disabled')).toBe(
            'false',
        );
    });

    test('a "Load more" that lands after the query changed is dropped', async () => {
        let finish!: (value: Awaited<ReturnType<typeof search>>) => void;
        pagedSearch(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const { container, getByRole, rerender } = render(MusicSearchResults, {
            query: 'song',
            handlers: noopHandlers,
        });
        await settleSearch();
        await fireEvent.click(getByRole('button', { name: 'Load more' }));
        vi.mocked(search).mockResolvedValue(emptySearch);
        await rerender({ query: 'other', handlers: noopHandlers });
        await settleSearch();
        finish(trackSearch);
        await tick();
        flushSync();
        expect(container.querySelectorAll('[data-track-row]')).toHaveLength(0);
        expect(container.textContent).toContain('No results for "other"');
    });

    test('Retry while a "Load more" is pending leaves the button usable', async () => {
        // Albums fail (so the Retry banner shows); songs have more; page 2 hangs.
        vi.mocked(search).mockImplementation(async (_q, opts) => {
            if (opts?.types === 'album') {
                return { data: null, error: { message: 'boom' }, status: 500 } as never;
            }
            if (opts?.types !== 'track') return emptySearch;
            if (opts.offset) return new Promise(() => {});
            return {
                ...trackSearch,
                data: { ...trackSearch.data!, page: { limit: 20, hasMore: true } },
            } as Awaited<ReturnType<typeof search>>;
        });
        const { getByRole } = render(MusicSearchResults, { query: 'song', handlers: noopHandlers });
        await settleSearch();
        await fireEvent.click(getByRole('button', { name: 'Load more' }));
        expect(getByRole('button', { name: 'Load more' }).getAttribute('aria-disabled')).toBe(
            'true',
        );
        await fireEvent.click(getByRole('button', { name: 'Retry' }));
        await tick();
        flushSync();
        expect(getByRole('button', { name: 'Load more' }).getAttribute('aria-disabled')).toBe(
            'false',
        );
    });

    test('albums and artists link to their pages when the server has more', async () => {
        const one = (type: 'album' | 'artist', hasMore: boolean) =>
            ({
                data: {
                    items: [
                        {
                            ...trackSearch.data!.items[0],
                            id: `${type}-1`,
                            type,
                            ids: { internal: `${type}-1` },
                            title: `A ${type}`,
                        },
                    ],
                    page: { limit: 24, hasMore },
                },
                error: null,
                status: 200,
            }) as Awaited<ReturnType<typeof search>>;
        vi.mocked(search).mockImplementation(async (_q, opts) =>
            opts?.types === 'album'
                ? one('album', true)
                : opts?.types === 'artist'
                  ? one('artist', false)
                  : trackSearch,
        );
        const { getAllByRole } = render(MusicSearchResults, {
            query: 'lantern pitch',
            handlers: noopHandlers,
        });
        await settleSearch();
        const links = getAllByRole('link', { name: 'See all' });
        // Only albums has more; artists fit on the page.
        expect(links.map((l) => l.getAttribute('href'))).toEqual([
            '/music/albums?q=lantern%20pitch',
        ]);
    });

    test('an empty page ends paging even if the server still claims more', async () => {
        pagedSearch(
            async () =>
                ({
                    data: { items: [], page: { limit: 20, hasMore: true } },
                    error: null,
                    status: 200,
                }) as Awaited<ReturnType<typeof search>>,
        );
        const { getByRole, queryByRole } = render(MusicSearchResults, {
            query: 'song',
            handlers: noopHandlers,
        });
        await settleSearch();
        await fireEvent.click(getByRole('button', { name: 'Load more' }));
        await tick();
        flushSync();
        expect(queryByRole('button', { name: 'Load more' })).toBeNull();
    });

    test('clicking a row plays that track with its album metadata', async () => {
        const { container } = render(MusicSearchResults, { query: 'song', handlers: noopHandlers });
        await settleSearch();
        await fireEvent.click(container.querySelectorAll('[data-track-row]')[1]);
        expect(playerStore.startPlayback).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'track-1',
                title: 'Song 1',
                artists: [{ id: 'artist-1', title: 'Artist 1' }],
                album: { id: 'album-1', title: 'Album 1' },
                durationMs: 185000,
            }),
        );
    });

    test('artist and album in the credit line open their modals without playing', async () => {
        modals.openArtistModal.mockClear();
        modals.openAlbumModal.mockClear();
        const { container } = render(MusicSearchResults, { query: 'song', handlers: noopHandlers });
        await settleSearch();
        const row = container.querySelectorAll('[data-track-row]')[1].closest('li')!;
        const link = (name: string) =>
            Array.from(row.querySelectorAll('button')).find((b) => b.textContent === name)!;
        await fireEvent.click(link('Artist 1'));
        expect(modals.openArtistModal).toHaveBeenCalledWith('artist-1');
        await fireEvent.click(link('Album 1'));
        expect(modals.openAlbumModal).toHaveBeenCalledWith('album-1');
        expect(playerStore.startPlayback).not.toHaveBeenCalled();
    });

    test('keeps the previous results visible while a follow-up query loads', async () => {
        const { container, rerender } = render(MusicSearchResults, {
            query: 'song',
            handlers: noopHandlers,
        });
        await settleSearch();
        vi.mocked(search).mockImplementationOnce(() => new Promise(() => {}));
        await rerender({ query: 'songs', handlers: noopHandlers });
        await settleSearch();
        expect(container.querySelectorAll('[data-track-row]')).toHaveLength(12);
        expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    });

    test('focusFirstResult moves focus to the first song row', async () => {
        const { container, component } = render(MusicSearchResults, {
            query: 'song',
            handlers: noopHandlers,
        });
        await settleSearch();
        component.focusFirstResult();
        expect(document.activeElement).toBe(container.querySelector('[data-track-row]'));
    });
});
