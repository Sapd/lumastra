// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The /playlists list page: the watchlist (a system playlist, `isSystem`)
 * must be pinned first among the owned cards and must not offer the
 * three-dot row menu (rename/delete) that the server would 409 on.
 *
 * Renders the REAL `+page.svelte` with `data.owned` the way the loader
 * produces it (Task 8, Step 2/3) and asserts on rendered DOM — not on the
 * `orderedOwned` derivation in isolation — so a regression that re-hides
 * the sort or re-shows the menu actually fails this test.
 */

import { render, screen, cleanup, within, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { get } from 'svelte/store';
import * as navigation from '$app/navigation';
import { userPlaylists, applyPlaylistSummary, type Playlist } from '$lib/stores/playlists';

const routeContext = vi.hoisted(() => ({
    url: 'http://localhost/playlists',
    routeId: '/playlists',
}));

vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$app/state', () => ({
    page: {
        get url() {
            return new URL(routeContext.url);
        },
        get route() {
            return { id: routeContext.routeId };
        },
        data: { user: { username: 'denis' } },
        state: {},
    },
}));
vi.mock('$app/stores', async () => {
    const { readable } = await import('svelte/store');
    return {
        page: readable({
            get url() {
                return new URL(routeContext.url);
            },
            get route() {
                return { id: routeContext.routeId };
            },
            data: { user: { username: 'denis' } },
        }),
        navigating: readable(null),
    };
});
vi.mock('$app/navigation', () => ({
    goto: vi.fn(),
    replaceState: vi.fn(),
    afterNavigate: vi.fn(),
    invalidateAll: vi.fn(),
}));
vi.mock('$lib/paths', () => ({ resolve: (p: string) => p, base: '' }));

import PlaylistsPage from './+page.svelte';
import type { PageData } from './$types';

function makePlaylist(overrides: Partial<Playlist>): Playlist {
    return {
        id: 1,
        owner: {
            userId: '550e8400-e29b-41d4-a716-446655440000',
            displayName: 'denis',
            images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
        },
        revision: 0,
        memberCount: 0,
        isSystem: false,
        description: null,
        images: {},
        name: 'A playlist',
        visibility: 'private',
        playlistType: 'general',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        role: 'owner',
        itemCount: 0,
        ...overrides,
    };
}

const WATCHLIST = makePlaylist({
    id: 1,
    name: 'Watchlist',
    playlistType: 'watchlist',
    isSystem: true,
    // Oldest updatedAt of the bunch — proves the ordering is NOT falling out
    // of the server's default updated_at DESC order by coincidence.
    updatedAt: '2020-01-01T00:00:00.000Z',
});

const REGULAR = makePlaylist({
    id: 2,
    name: 'My Mix',
    playlistType: 'general',
    updatedAt: '2026-09-22T00:00:00.000Z',
});

// Two more non-system playlists, placed on EITHER SIDE of the watchlist in
// the input array below — so the pinning can't be mistaken for "whatever
// happened to sort first" and their own relative order (a stand-in for the
// server's updated_at DESC ordering, which this page's sort does not
// re-derive) must survive untouched.
const REGULAR_B = makePlaylist({
    id: 3,
    name: 'Second Mix',
    playlistType: 'general',
    updatedAt: '2026-05-01T00:00:00.000Z',
});

const REGULAR_C = makePlaylist({
    id: 4,
    name: 'Third Mix',
    playlistType: 'general',
    updatedAt: '2024-01-01T00:00:00.000Z',
});

type SuccessfulPageData = Exclude<PageData, { error: string }>;

function baseData(): SuccessfulPageData {
    // Watchlist sits in the MIDDLE of the input array, not at an edge —
    // pinning it first is only convincing if it moves regardless of where
    // the server happened to place it.
    //
    // `PageData` also carries the whole root layout payload (branding, feature
    // flags, …) that this page never reads — same cast the admin media page
    // test uses for the fields it does not exercise.
    return {
        owned: [REGULAR, REGULAR_B, WATCHLIST, REGULAR_C],
        shared: [],
        pendingInvites: [],
        username: 'denis',
    } as unknown as SuccessfulPageData;
}

describe('/playlists — pinned watchlist card', () => {
    afterEach(() => {
        cleanup();
        routeContext.url = 'http://localhost/playlists';
        routeContext.routeId = '/playlists';
        userPlaylists.set({ owned: [], shared: [], loading: false, error: null });
    });

    it('renders the Watchlist card first and preserves the other three cards in their given order', () => {
        render(PlaylistsPage, { data: baseData() });

        const headings = screen.getAllByRole('heading', { level: 3 });
        const names = headings.map((h) => h.textContent?.trim());
        expect(names).toEqual(['Watchlist', 'My Mix', 'Second Mix', 'Third Mix']);
    });

    it('pins the Watchlist first even for a user who has never watchlisted anything', () => {
        // Only the system playlist exists — the loader's ensureWatchlistPlaylist
        // call is what guarantees this row exists at all (Task 8, Step 2).
        render(PlaylistsPage, {
            data: {
                owned: [WATCHLIST],
                shared: [],
                pendingInvites: [],
                username: 'denis',
            } as unknown as PageData,
        });

        expect(screen.getByRole('heading', { level: 3, name: 'Watchlist' })).toBeTruthy();
    });

    it('does not render the row menu (rename/delete) on the Watchlist card', () => {
        render(PlaylistsPage, { data: baseData() });

        const watchlistHeading = screen.getByRole('heading', { level: 3, name: 'Watchlist' });
        const watchlistCard = watchlistHeading.closest('article') as HTMLElement;
        expect(watchlistCard).toBeTruthy();
        expect(within(watchlistCard).queryByLabelText('Actions for Watchlist')).toBeNull();

        const regularHeading = screen.getByRole('heading', { level: 3, name: 'My Mix' });
        const regularCard = regularHeading.closest('article') as HTMLElement;
        expect(within(regularCard).queryByLabelText('Actions for My Mix')).toBeTruthy();
    });

    it('filters a larger owned/shared library without losing cards when cleared', async () => {
        const lists = Array.from({ length: 39 }, (_, i) =>
            makePlaylist({
                id: i + 10,
                name: `Lunar Collection ${String(i).padStart(2, '0')}`,
                role: i < 20 ? 'owner' : 'readonly',
            }),
        );
        render(PlaylistsPage, {
            data: { ...baseData(), owned: lists.slice(0, 20), shared: lists.slice(20) },
        });
        expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(39);
        await fireEvent.input(screen.getByRole('searchbox'), {
            target: { value: 'Collection 38' },
        });
        expect(
            screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent?.trim()),
        ).toEqual(['Lunar Collection 38']);
        await fireEvent.input(screen.getByRole('searchbox'), { target: { value: '' } });
        await fireEvent.click(screen.getByRole('button', { name: 'Shared with me' }));
        expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(19);
        await fireEvent.click(screen.getByRole('button', { name: 'All playlists' }));
        expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(39);
    });

    it('narrows the rendered cards and offers a clear path out of no matches', async () => {
        render(PlaylistsPage, { data: baseData() });
        const search = screen.getByRole('searchbox');
        await fireEvent.input(search, { target: { value: 'Second' } });
        expect(
            screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent?.trim()),
        ).toEqual(['Second Mix']);
        await fireEvent.input(search, { target: { value: 'missing' } });
        expect(screen.getByText('No playlists match.')).toBeTruthy();
        await fireEvent.click(screen.getAllByRole('button', { name: 'Clear all filters' })[0]);
        expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(4);
    });

    it('keeps Music navigation and playlist scope while clearing music-list filters', async () => {
        routeContext.url = 'http://localhost/playlists?type=music&q=missing&scope=owned';
        const playlist = makePlaylist({ id: 9, name: 'Night Drive', playlistType: 'music' });
        render(PlaylistsPage, {
            data: { ...baseData(), owned: [playlist] },
        });

        const musicNav = screen.getByRole('navigation', { name: 'Music navigation' });
        expect(musicNav.querySelector('a[href="/music"]')).toBeTruthy();
        expect(
            musicNav.querySelector('a[href="/playlists?type=music"]')?.getAttribute('aria-current'),
        ).toBe('page');
        expect(
            screen
                .getByRole('navigation', { name: 'Browse the Library' })
                .querySelector('a[href="/playlists?type=music"]')
                ?.getAttribute('aria-current'),
        ).toBe('page');
        expect(screen.queryByRole('group', { name: 'Playlist type' })).toBeNull();
        expect(screen.getByText('Your music mixes and collections, ready to play.')).toBeTruthy();

        await fireEvent.click(screen.getAllByRole('button', { name: 'Clear all filters' })[0]);
        expect(screen.getByRole('heading', { level: 3, name: 'Night Drive' })).toBeTruthy();
        expect(navigation.replaceState).toHaveBeenCalledWith('/playlists?type=music', {});
        expect(screen.queryByRole('button', { name: 'Clear all filters' })).toBeNull();
    });

    it('uses real links and sends edit to the existing detail page', () => {
        render(PlaylistsPage, { data: baseData() });
        const card = screen
            .getByRole('heading', { name: 'My Mix' })
            .closest('article') as HTMLElement;
        expect(
            within(card)
                .getByRole('link', { name: /My Mix/ })
                .getAttribute('href'),
        ).toBe('/playlists/2');
        expect(card.querySelector('.action-menu a')?.getAttribute('href')).toBe(
            '/playlists/2?edit=1',
        );
    });

    it('renders playlists created through the client store after mount', async () => {
        render(PlaylistsPage, { data: baseData() });
        const created = makePlaylist({ id: 5, name: 'Created from queue', playlistType: 'music' });
        userPlaylists.update((state) => ({ ...state, owned: [created, ...state.owned] }));
        await tick();
        expect(screen.getByRole('heading', { level: 3, name: created.name })).toBeTruthy();
        expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(5);
    });

    it('updates counts and ordering from store summaries for owned and shared cards', async () => {
        const shared = makePlaylist({
            id: 6,
            name: 'Shared mix',
            owner: {
                userId: '550e8400-e29b-41d4-a716-446655440000',
                displayName: 'friend',
                images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
            },
            revision: 0,
            memberCount: 0,
            isSystem: false,
            description: null,
            role: 'editor',
        });
        render(PlaylistsPage, { data: { ...baseData(), shared: [shared] } });
        applyPlaylistSummary(REGULAR_C.id, {
            itemCount: 9,
            revision: 1,
            updatedAt: '2026-09-27T00:00:00.000Z',
        });
        applyPlaylistSummary(shared.id, {
            itemCount: 7,
            revision: 1,
            updatedAt: '2026-09-28T00:00:00.000Z',
        });
        await tick();
        const ownedCard = screen.getByRole('heading', { name: 'Third Mix' }).closest('article')!;
        const sharedCard = screen.getByRole('heading', { name: 'Shared mix' }).closest('article')!;
        expect(within(ownedCard).getByText(/9\s+entries/)).toBeTruthy();
        expect(within(sharedCard).getByText(/7\s+entries/)).toBeTruthy();
        expect(
            screen
                .getAllByRole('heading', { level: 3 })
                .map((heading) => heading.textContent?.trim()),
        ).toEqual(['Watchlist', 'Shared mix', 'Third Mix', 'My Mix', 'Second Mix']);
    });

    it('prioritizes incoming server data over stale store contents on mount and refresh', async () => {
        const stale = makePlaylist({ id: 7, name: 'Stale other snapshot' });
        userPlaylists.set({ owned: [stale], shared: [stale], loading: false, error: null });
        const { rerender } = render(PlaylistsPage, { data: baseData() });
        expect(screen.queryByRole('heading', { name: stale.name })).toBeNull();
        expect(get(userPlaylists).owned.map((playlist) => playlist.id)).toEqual([2, 3, 1, 4]);

        userPlaylists.update((state) => ({ ...state, owned: [stale, ...state.owned] }));
        await tick();
        expect(screen.getByRole('heading', { name: stale.name })).toBeTruthy();
        const fresh = makePlaylist({ id: 8, name: 'Fresh server snapshot' });
        await rerender({ data: { ...baseData(), owned: [fresh], shared: [] } });
        expect(
            screen
                .getAllByRole('heading', { level: 3 })
                .map((heading) => heading.textContent?.trim()),
        ).toEqual([fresh.name]);
        expect(get(userPlaylists).owned.map((playlist) => playlist.id)).toEqual([fresh.id]);

        applyPlaylistSummary(fresh.id, {
            itemCount: 12,
            revision: 1,
            updatedAt: '2026-09-29T00:00:00.000Z',
        });
        await tick();
        expect(screen.getByText(/12\s+entries/)).toBeTruthy();
    });
});
