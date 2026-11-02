// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Final-review fix: the watchlist detail page (`+page.svelte`) rendered two
 * controls that the server 409s for a system playlist:
 *
 *  - `PlaylistChat` was gated only on `data.featureChatEnabled &&
 *    typedUsername`. Since `FEATURE_PLAYLIST_CHAT` defaults to true, the
 *    watchlist's detail page showed a chat panel whose `GET
 *    /playlists/{id}/chat` and send box both 409 (`is_system` guard).
 *  - `dndzone`'s `dragDisabled` was `!data.canEdit` only, so the owner could
 *    drag-reorder the watchlist; `reorderItems` 409s but the API client
 *    returns `{error}` rather than throwing, so the reorder silently
 *    reverted on next load instead of surfacing an error.
 *
 * These tests drive the REAL `+page.svelte` (not a hand-rolled replica of
 * the guard expression) so a regression that re-enables either control
 * actually fails here — same model as
 * `src/lib/components/playlist/PlaylistHeader.svelte.test.ts` and
 * `src/routes/playlists/page.svelte.test.ts`.
 */

import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerPlaylist } from './playlist-detail-transform';
import type { PlaylistEntry } from '$lib/types/api-playlists';

vi.mock('$env/dynamic/public', () => ({ env: {} }));
const location = vi.hoisted(() => ({
    url: 'http://localhost/playlists/1',
    routeId: '/playlists/[id]',
    pageData: {} as Record<string, unknown>,
    state: {} as Record<string, unknown>,
}));
vi.mock('$lib/paraglide/messages.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('$lib/paraglide/messages.js')>();
    return {
        ...original,
        viewer_playlist_invitation_role: () => 'Role for new members',
        viewer_playlist_member_role: () => 'Member role',
    };
});
vi.mock('$app/stores', async () => {
    const { readable } = await import('svelte/store');
    return {
        page: readable({
            get url() {
                return new URL(location.url);
            },
            get route() {
                return { id: location.routeId };
            },
            get data() {
                return location.pageData;
            },
            get state() {
                return location.state;
            },
        }),
        navigating: readable(null),
    };
});
const invalidate = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('$app/navigation', () => ({
    goto: vi.fn(),
    invalidate,
    invalidateAll: vi.fn(),
    beforeNavigate: vi.fn(),
    afterNavigate: vi.fn(),
}));
vi.mock('$lib/paths', () => ({ resolve: (p: string) => p, base: '' }));

// The chat panel is heavy (fetches messages on mount, has its own send box);
// this suite only cares WHETHER it renders at all, so stub it with something
// identifiable and inert.
vi.mock('$lib/components/playlist/PlaylistChat.svelte', async () => {
    const mod = await import('./__fixtures__/PlaylistChatStub.svelte');
    return { default: mod.default };
});
vi.mock('$lib/Search.svelte', async () => ({
    default: (await import('./__fixtures__/SearchAddStub.svelte')).default,
}));

// `dndzone` is a Svelte action, not something a rendered-DOM assertion can
// read back reliably in happy-dom (it depends on getBoundingClientRect /
// ResizeObserver internals). Spy on it directly so the test asserts on the
// exact option this fix touches (`dragDisabled`) as it is really passed by
// the component, rather than re-deriving the guard expression by hand.
const dndzoneCalls: Array<Record<string, unknown>> = [];
vi.mock('svelte-dnd-action', async (importOriginal) => {
    const actual = await importOriginal<typeof import('svelte-dnd-action')>();
    return {
        ...actual,
        dndzone: (node: HTMLElement, options: Record<string, unknown>) => {
            dndzoneCalls.push(options);
            return {
                destroy() {},
                update(opts: Record<string, unknown>) {
                    dndzoneCalls.push(opts);
                },
            };
        },
    };
});

vi.mock('$lib/stores/music-player.store', () => ({
    musicPlayerStore: { play: vi.fn() },
}));

vi.mock('$lib/api/playlists', () => ({
    getPlaylistProgress: vi.fn(async () => ({ data: null, error: null })),
    toggleItemWatched: vi.fn(),
    saveViewState: vi.fn(async () => ({ data: null, error: null })),
    reorderItems: vi.fn(async () => ({ data: null, error: null })),
    updatePlaylist: vi.fn(async () => ({ data: null, error: null })),
    deletePlaylist: vi.fn(async () => ({ data: null, error: null })),
    updateMemberRole: vi.fn(async () => ({ data: null, error: null })),
    addItem: vi.fn(),
    getPlaylist: vi.fn(async () => ({ data: null, error: 'offline', status: 500 })),
}));

vi.mock('$lib/stores/playlists', () => ({
    applyPlaylistSummary: vi.fn(),
    syncWatchlistStoreAdded: vi.fn(),
    syncWatchlistStoreRemoved: vi.fn(),
}));

vi.mock('$lib/api/music', () => ({ getTrack: vi.fn() }));

import Page from './+page.svelte';
import {
    addToWatchlistStore,
    setWatchlistItems,
    setWatchlistState,
    type WatchlistItem,
} from '$lib/stores/watchlist';
import { PLAYLIST_DETAIL_DEPENDENCY } from './playlist-detail-transform';
import type { PageData } from './$types';
import * as playlistsApi from '$lib/api/playlists';
import { TRIGGERS, SOURCES } from 'svelte-dnd-action';

function makeServerPlaylist(overrides: Partial<ServerPlaylist> = {}): ServerPlaylist {
    return {
        id: 1,
        owner: {
            userId: '550e8400-e29b-41d4-a716-446655440000',
            displayName: 'denis',
            images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
        },
        revision: 0,
        memberCount: 0,
        name: 'Watchlist',
        description: null,
        visibility: 'private',
        playlistType: 'watchlist',
        images: {},
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        role: 'owner',
        itemCount: 0,
        isSystem: true,
        ...overrides,
    };
}

function makeItem(overrides: Partial<PlaylistEntry> = {}): PlaylistEntry {
    return {
        id: 1,
        mediaId: '550e8400-e29b-41d4-a716-446655440000',
        mediaType: 'movie',
        title: 'A Movie',
        position: 0,
        addedAt: '2026-01-01T00:00:00.000Z',
        watched: false,
        ...overrides,
    } as PlaylistEntry;
}

function makeData(playlist: ServerPlaylist, items: PlaylistEntry[]): PageData {
    // `PageData` also carries the whole root layout payload (branding, feature
    // flags, …) that these guards never read — same cast the admin media page
    // test uses for the fields it does not exercise.
    return {
        playlist,
        items,
        members: [],
        userId: '550e8400-e29b-41d4-a716-446655440000',
        canEdit: true,
        canManageMembers: true,
        featureChatEnabled: true,
        collapsedGroups: { series: [], season: [] },
    } as unknown as PageData;
}

describe('playlist detail page — system playlist affordance guards', () => {
    afterEach(() => {
        cleanup();
        dndzoneCalls.length = 0;
    });

    it('hides PlaylistChat and disables drag for the watchlist (isSystem: true)', () => {
        const data = makeData(makeServerPlaylist({ isSystem: true }), [makeItem()]);
        render(Page, { props: { data } });

        // The chat send box / thread must not render for the watchlist.
        expect(screen.queryByTestId('playlist-chat-stub')).toBeNull();

        // dndzone must have been wired up with dragDisabled: true even
        // though data.canEdit is true — isSystem overrides it.
        expect(dndzoneCalls.length).toBeGreaterThan(0);
        expect(dndzoneCalls[0].dragDisabled).toBe(true);
    });

    it('offers Continue for a video playlist and starts the first unwatched item in context', async () => {
        const { goto } = await import('$app/navigation');
        const data = makeData(
            makeServerPlaylist({ id: 7, isSystem: false, playlistType: 'general', name: 'Trek' }),
            [
                makeItem({ id: 1, title: 'Ep 1', watched: true, mediaId: 'a' }),
                makeItem({ id: 2, title: 'Ep 2', watched: false, mediaId: 'b' }),
                makeItem({ id: 3, title: 'Ep 3', watched: false, mediaId: 'c' }),
            ],
        );
        render(Page, { props: { data } });

        await fireEvent.click(screen.getByRole('button', { name: /^Continue$/ }));
        await vi.waitFor(() =>
            expect(goto).toHaveBeenCalledWith('/watch/b?playlist=7&position=1', {
                replaceState: false,
            }),
        );
    });

    it('keeps video controls in a mixed playlist and skips audio when starting video', async () => {
        const { goto } = await import('$app/navigation');
        const data = makeData(
            makeServerPlaylist({ id: 7, isSystem: false, playlistType: 'general' }),
            [
                makeItem({
                    id: 1,
                    mediaType: 'track',
                    title: 'Song',
                    mediaId: 'song',
                }),
                makeItem({
                    id: 2,
                    mediaType: 'audiobook',
                    title: 'Book',
                    mediaId: 'book',
                }),
                makeItem({ id: 3, title: 'Movie', mediaId: 'movie' }),
            ],
        );
        render(Page, { data });
        expect(screen.getByRole('button', { name: 'Play songs' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Shuffle songs' })).toBeTruthy();
        expect(screen.getByText('Audiobook')).toBeTruthy();
        expect(screen.getAllByRole('button', { name: 'Mark as watched' })).toHaveLength(1);
        expect(document.querySelector('a[href*="/watch/book"]')).toBeNull();
        await fireEvent.click(screen.getByTitle('Starts Movie'));
        await vi.waitFor(() =>
            expect(goto).toHaveBeenCalledWith('/watch/movie?playlist=7&position=2', {
                replaceState: false,
            }),
        );
    });

    it('offers Play again once every item is watched, from the first item', async () => {
        const { goto } = await import('$app/navigation');
        vi.mocked(goto).mockClear();
        const data = makeData(
            makeServerPlaylist({ id: 7, isSystem: false, playlistType: 'general', name: 'Trek' }),
            [
                makeItem({ id: 1, title: 'Ep 1', watched: true, mediaId: 'a' }),
                makeItem({ id: 2, title: 'Ep 2', watched: true, mediaId: 'b' }),
            ],
        );
        render(Page, { props: { data } });

        await fireEvent.click(screen.getByRole('button', { name: /^Play again$/ }));
        await vi.waitFor(() =>
            expect(goto).toHaveBeenCalledWith('/watch/a?playlist=7&position=0', {
                replaceState: false,
            }),
        );
    });

    it('shows PlaylistChat and allows drag for a regular editable playlist (isSystem: false)', () => {
        const data = makeData(
            makeServerPlaylist({ isSystem: false, playlistType: 'general', name: 'My Mix' }),
            [makeItem()],
        );
        render(Page, { props: { data } });

        expect(screen.queryByTestId('playlist-chat-stub')).not.toBeNull();
        expect(dndzoneCalls.length).toBeGreaterThan(0);
        expect(dndzoneCalls[0].dragDisabled).toBe(false);
    });
});

describe('playlist detail page — music library navigation', () => {
    afterEach(() => {
        cleanup();
        location.url = 'http://localhost/playlists/1';
        location.routeId = '/playlists/[id]';
        location.pageData = {};
        location.state = {};
        vi.clearAllMocks();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('shows Music and selects Library for an empty typed music playlist', async () => {
        const { goto } = await import('$app/navigation');
        location.url = 'http://localhost/playlists/7?type=music';
        const data = makeData(
            makeServerPlaylist({
                id: 7,
                name: 'Empty Music Mix',
                playlistType: 'music',
                isSystem: false,
            }),
            [],
        );
        location.pageData = { playlist: data.playlist };
        render(Page, { props: { data } });

        expect(
            screen.getByText('Create a collection, then add titles from their menus.'),
        ).toBeTruthy();
        expect(screen.queryByText('Add movies, series or episodes to get started.')).toBeNull();

        const musicNav = screen.getByRole('navigation', { name: 'Music navigation' });
        expect(musicNav.querySelector('a[aria-current="page"]')?.textContent).toContain('Library');
        const libraryTabs = screen.getByRole('navigation', { name: 'Browse the Library' });
        expect(
            libraryTabs
                .querySelector('a[href="/playlists?type=music"]')
                ?.getAttribute('aria-current'),
        ).toBe('page');

        await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
        await waitFor(() =>
            expect(goto).toHaveBeenCalledWith('/playlists?type=music', { replaceState: true }),
        );
    });

    it.each(['general', 'video'] as const)(
        'does not treat a %s detail as Music when the URL only has type=music',
        (playlistType) => {
            location.url = 'http://localhost/playlists/8?type=music';
            const data = makeData(
                makeServerPlaylist({
                    id: 8,
                    name: 'Not a Music Mix',
                    playlistType,
                    isSystem: false,
                }),
                [],
            );
            location.pageData = { playlist: data.playlist };
            render(Page, { props: { data } });

            expect(screen.queryByRole('navigation', { name: 'Music navigation' })).toBeNull();
            expect(screen.queryByRole('navigation', { name: 'Browse the Library' })).toBeNull();
        },
    );

    it('shows music navigation for a typed music detail without a type query', () => {
        location.url = 'http://localhost/playlists/7';
        const data = makeData(
            makeServerPlaylist({ id: 7, playlistType: 'music', isSystem: false }),
            [],
        );
        location.pageData = { playlist: data.playlist };
        render(Page, { props: { data } });

        expect(screen.getByRole('navigation', { name: 'Music navigation' })).toBeTruthy();
        expect(screen.getByRole('navigation', { name: 'Browse the Library' })).toBeTruthy();
    });

    it.each([
        { playlistType: 'music' as const, query: '?type=music', href: '/playlists?type=music' },
        {
            playlistType: 'music' as const,
            query: '?type=music&from=music',
            href: '/music',
        },
        {
            playlistType: 'general' as const,
            query: '?type=music&from=music',
            href: '/music',
        },
    ])('uses $href as the back fallback for $playlistType with $query', async (scenario) => {
        const { goto } = await import('$app/navigation');
        location.url = `http://localhost/playlists/9${scenario.query}`;
        const data = makeData(
            makeServerPlaylist({ id: 9, playlistType: scenario.playlistType, isSystem: false }),
            [],
        );
        location.pageData = { playlist: data.playlist };
        render(Page, { props: { data } });

        await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
        await waitFor(() =>
            expect(goto).toHaveBeenCalledWith(scenario.href, { replaceState: true }),
        );
    });

    it('uses history for a detail opened from Music', async () => {
        location.url = 'http://localhost/playlists/10?type=music';
        location.state = { musicPlaylistOrigin: true };
        const data = makeData(
            makeServerPlaylist({ id: 10, playlistType: 'music', isSystem: false }),
            [],
        );
        location.pageData = { playlist: data.playlist };
        const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {});
        render(Page, { props: { data } });

        await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
        expect(historyBack).toHaveBeenCalledOnce();
    });

    it.each([
        { playlistType: 'music' as const, query: '?type=music', href: '/playlists?type=music' },
        {
            playlistType: 'general' as const,
            query: '?type=music&from=music',
            href: '/music',
        },
    ])('uses $href after deleting a $playlistType detail', async (scenario) => {
        const { goto } = await import('$app/navigation');
        vi.stubGlobal(
            'confirm',
            vi.fn(() => true),
        );
        location.url = `http://localhost/playlists/11${scenario.query}`;
        const data = makeData(
            makeServerPlaylist({ id: 11, playlistType: scenario.playlistType, isSystem: false }),
            [],
        );
        location.pageData = { playlist: data.playlist };
        render(Page, { props: { data } });

        await fireEvent.click(screen.getByRole('button', { name: 'Delete playlist' }));
        await waitFor(() => expect(playlistsApi.deletePlaylist).toHaveBeenCalledWith(11));
        await waitFor(() =>
            expect(goto).toHaveBeenCalledWith(scenario.href, { replaceState: false }),
        );
    });
});

describe('playlist detail page — live watchlist', () => {
    // Opening a title's detail modal from this page (search, "similar" titles)
    // and pressing its Watchlist button writes the watchlist playlist on the
    // server and the client store — the list on screen must follow.
    const saved = (id: string, title: string): WatchlistItem =>
        ({
            externalIds: { internal: id },
            mediaType: 'movie',
            title,
            overview: '',
            rating: '0',
            savedAt: '2026-01-01T00:00:00.000Z',
        }) as unknown as WatchlistItem;
    const A = '00000000-0000-4000-8000-00000000000a';
    const B = '00000000-0000-4000-8000-00000000000b';

    afterEach(() => {
        cleanup();
        invalidate.mockClear();
        setWatchlistItems([]);
        setWatchlistState({ loading: true });
    });

    it('re-loads the watchlist page when a title is added elsewhere, and shows it', async () => {
        setWatchlistItems([saved(A, 'A Movie')]);
        setWatchlistState({ loading: false });
        const first = makeData(makeServerPlaylist(), [makeItem({ mediaId: A, title: 'A Movie' })]);
        const { rerender } = render(Page, { props: { data: first } });
        expect(invalidate).not.toHaveBeenCalled();

        addToWatchlistStore(saved(B, 'B Movie'));
        await waitFor(() => expect(invalidate).toHaveBeenCalledWith(PLAYLIST_DETAIL_DEPENDENCY));

        // What the re-run load returns: the server bumped updatedAt on insert.
        await rerender({
            data: makeData(makeServerPlaylist({ updatedAt: '2026-01-02T00:00:00.000Z' }), [
                makeItem({ id: 2, mediaId: B, title: 'B Movie' }),
                makeItem({ mediaId: A, title: 'A Movie' }),
            ]),
        });
        expect(await screen.findByText('B Movie')).toBeTruthy();
    });

    it('does not re-load a regular playlist on watchlist changes', async () => {
        setWatchlistState({ loading: false });
        render(Page, {
            props: {
                data: makeData(
                    makeServerPlaylist({ isSystem: false, playlistType: 'general', name: 'Mix' }),
                    [makeItem()],
                ),
            },
        });
        addToWatchlistStore(saved(B, 'B Movie'));
        await new Promise((r) => setTimeout(r, 20));
        expect(invalidate).not.toHaveBeenCalled();
    });

    it("the store's first hydration after mount is not treated as a change", async () => {
        render(Page, { props: { data: makeData(makeServerPlaylist(), [makeItem()]) } });
        setWatchlistItems([saved(A, 'A Movie')]);
        setWatchlistState({ loading: false });
        await new Promise((r) => setTimeout(r, 20));
        expect(invalidate).not.toHaveBeenCalled();

        addToWatchlistStore(saved(B, 'B Movie'));
        await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    });
});

describe('playlist detail search add outcomes', () => {
    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
    });

    async function openSearch() {
        const data = makeData(makeServerPlaylist({ isSystem: false }), []);
        const view = render(Page, { props: { data } });
        await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
        return { ...view, data };
    }

    it('returns failure on an API error and success only after a confirmed add', async () => {
        vi.mocked(playlistsApi.addItem)
            .mockResolvedValueOnce({ data: null, error: 'offline', status: 500 })
            .mockResolvedValueOnce({
                data: {
                    results: [
                        {
                            mediaId: '550e8400-e29b-41d4-a716-446655440000',
                            status: 'added',
                            entries: [makeItem({ id: 7, title: 'Added movie' })],
                            expanded: false,
                            reason: null,
                        },
                    ],
                    summary: { itemCount: 1, revision: 1, updatedAt: '' },
                },
                error: null,
                status: 200,
            });
        await openSearch();
        await fireEvent.click(screen.getByRole('button', { name: 'Submit search item' }));
        await waitFor(() => expect(screen.getByTestId('add-outcome').textContent).toBe('failed'));
        expect(screen.queryByText('Added movie')).toBeNull();
        await fireEvent.click(screen.getByRole('button', { name: 'Submit search item' }));
        await waitFor(() => expect(screen.getByTestId('add-outcome').textContent).toBe('added'));
        await waitFor(() => expect(screen.getByText('Added movie')).toBeTruthy());
    });

    it('returns duplicate from the per-input outcome without requiring a refresh', async () => {
        vi.mocked(playlistsApi.addItem).mockResolvedValueOnce({
            data: {
                results: [
                    {
                        mediaId: '550e8400-e29b-41d4-a716-446655440000',
                        status: 'duplicate',
                        entries: [],
                        expanded: false,
                        reason: null,
                    },
                ],
                summary: { itemCount: 1, revision: 1, updatedAt: '' },
            },
            error: null,
            status: 200,
        });
        vi.mocked(playlistsApi.getPlaylist).mockRejectedValueOnce(new Error('offline'));
        await openSearch();
        await fireEvent.click(screen.getByRole('button', { name: 'Submit search item' }));
        await waitFor(() =>
            expect(screen.getByTestId('add-outcome').textContent).toBe('duplicate'),
        );
        expect(playlistsApi.addItem).toHaveBeenCalledTimes(1);
    });

    it('coalesces repeated submissions while an add is pending', async () => {
        let finish!: (value: Awaited<ReturnType<typeof playlistsApi.addItem>>) => void;
        vi.mocked(playlistsApi.addItem).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        await openSearch();
        const submit = screen.getByRole('button', { name: 'Submit search item' });
        await fireEvent.click(submit);
        await fireEvent.click(submit);
        expect(playlistsApi.addItem).toHaveBeenCalledTimes(1);
        finish({
            data: {
                results: [
                    {
                        mediaId: '550e8400-e29b-41d4-a716-446655440000',
                        status: 'added',
                        entries: [makeItem({ id: 7, title: 'Added movie' })],
                        expanded: false,
                        reason: null,
                    },
                ],
                summary: { itemCount: 1, revision: 1, updatedAt: '' },
            },
            error: null,
            status: 200,
        });
        await waitFor(() => expect(screen.getByTestId('add-outcome').textContent).toBe('added'));
        await waitFor(() => expect(screen.getAllByText('Added movie')).toHaveLength(1));
    });

    it('never appends an old playlist response after navigating to another playlist', async () => {
        let finish!: (value: Awaited<ReturnType<typeof playlistsApi.addItem>>) => void;
        vi.mocked(playlistsApi.addItem).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const { rerender } = await openSearch();
        await fireEvent.click(screen.getByRole('button', { name: 'Submit search item' }));
        await rerender({
            data: makeData(
                makeServerPlaylist({ id: 2, isSystem: false, name: 'Other playlist' }),
                [],
            ),
        });
        finish({
            data: {
                results: [
                    {
                        mediaId: '550e8400-e29b-41d4-a716-446655440000',
                        status: 'added',
                        entries: [makeItem({ id: 7, title: 'Added movie' })],
                        expanded: false,
                        reason: null,
                    },
                ],
                summary: { itemCount: 1, revision: 1, updatedAt: '' },
            },
            error: null,
            status: 200,
        });
        await waitFor(() => expect(screen.getByTestId('add-outcome').textContent).toBe('added'));
        expect(screen.queryByText('Added movie')).toBeNull();
        expect(screen.getByRole('heading', { name: 'Other playlist' })).toBeTruthy();
    });
});

describe('playlist detail editing and save feedback', () => {
    beforeEach(() => {
        location.url = 'http://localhost/playlists/1';
        vi.mocked(playlistsApi.updatePlaylist).mockResolvedValue({
            data: null,
            error: null,
            status: 200,
        });
        vi.mocked(playlistsApi.reorderItems).mockResolvedValue({
            data: null,
            error: null,
            status: 200,
        });
    });
    afterEach(() => {
        cleanup();
        location.url = 'http://localhost/playlists/1';
        vi.clearAllMocks();
    });

    it('opens the name editor from edit=1 and keeps a failed draft for retry', async () => {
        location.url += '?edit=1';
        vi.mocked(playlistsApi.updatePlaylist).mockResolvedValueOnce({
            data: null,
            error: 'Failed',
            status: 500,
        });
        render(Page, { props: { data: makeData(makeServerPlaylist({ isSystem: false }), []) } });
        const input = await screen.findByRole('textbox', { name: 'Name' });
        expect((input as HTMLInputElement).value).toBe('Watchlist');
        await fireEvent.input(input, { target: { value: 'Friday night' } });
        await fireEvent.submit(input.closest('form')!);
        expect((await screen.findByRole('alert')).textContent).toContain(
            'Changes could not be saved',
        );
        expect((input as HTMLInputElement).value).toBe('Friday night');
        expect(screen.queryByRole('heading', { name: 'Friday night' })).toBeNull();
        await fireEvent.submit(input.closest('form')!);
        expect(await screen.findByRole('heading', { name: 'Friday night' })).toBeTruthy();
        expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
        expect(playlistsApi.updatePlaylist).toHaveBeenCalledTimes(2);
    });

    it.each(['system', 'readonly'])('ignores edit=1 for a %s playlist', async (mode) => {
        location.url += '?edit=1';
        const data = makeData(makeServerPlaylist({ isSystem: mode === 'system' }), []);
        data.canEdit = mode !== 'readonly';
        render(Page, { props: { data } });
        expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
        expect(playlistsApi.updatePlaylist).not.toHaveBeenCalled();
    });

    it('does not claim a failed visibility change succeeded', async () => {
        vi.mocked(playlistsApi.updatePlaylist).mockResolvedValueOnce({
            data: null,
            error: 'Failed',
            status: 500,
        });
        render(Page, { props: { data: makeData(makeServerPlaylist({ isSystem: false }), []) } });
        await fireEvent.click(screen.getByRole('button', { name: 'Private' }));
        expect((await screen.findByRole('alert')).textContent).toContain(
            'Changes could not be saved',
        );
        expect(screen.getByRole('button', { name: 'Private' })).toBeTruthy();
    });

    it('restores item order when the API returns a reorder error', async () => {
        const items = [makeItem(), makeItem({ id: 2, title: 'B Movie', position: 1 })];
        vi.mocked(playlistsApi.reorderItems).mockResolvedValueOnce({
            data: null,
            error: 'Failed',
            status: 500,
        });
        render(Page, { props: { data: makeData(makeServerPlaylist({ isSystem: false }), items) } });
        const list = screen.getByLabelText('Playlist items');
        await fireEvent(
            list,
            new CustomEvent('consider', {
                detail: { items, info: { trigger: TRIGGERS.DRAG_STARTED, id: 1 } },
            }),
        );
        await fireEvent(
            list,
            new CustomEvent('finalize', {
                detail: { items: [...items].reverse(), info: { id: 1 } },
            }),
        );
        expect((await screen.findByRole('alert')).textContent).toContain(
            'previous order has been restored',
        );
        // The latest action options reflect the rendered/restored list, not just API input.
        const latest = dndzoneCalls.at(-1)?.items as PlaylistEntry[];
        expect(latest.map((item) => item.id)).toEqual([1, 2]);
        expect(playlistsApi.reorderItems).toHaveBeenCalledWith(1, {
            expectedRevision: 0,
            entryIds: [2, 1],
        });
    });

    it('keeps the previous member role when saving it fails', async () => {
        vi.mocked(playlistsApi.updateMemberRole).mockResolvedValueOnce({
            data: null,
            error: 'Failed',
            status: 500,
        });
        const data = makeData(makeServerPlaylist({ isSystem: false }), []);
        data.members = [
            {
                userId: '110e8400-e29b-41d4-a716-446655440000',
                author: {
                    userId: '110e8400-e29b-41d4-a716-446655440000',
                    displayName: 'Viewer',
                    images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
                },
                role: 'readonly',
                status: 'accepted',
                invitedAt: '2026-01-01T00:00:00.000Z',
            },
        ];
        render(Page, { props: { data } });
        await fireEvent.click(screen.getByRole('button', { name: 'Sharing & members' }));
        const role = screen.getByRole('combobox', { name: 'Member role: Viewer' });
        await fireEvent.change(role, { target: { value: 'editor' } });
        expect((await screen.findByRole('alert')).textContent).toContain(
            'Changes could not be saved',
        );
        await waitFor(() => expect((role as HTMLSelectElement).value).toBe('readonly'));
    });

    it('keeps a collapsed series together across repeated keyboard moves', async () => {
        const episode = makeItem({
            id: 1,
            mediaType: 'episode',
            seriesName: 'Series',
            seasonNumber: 1,
            episodeNumber: 1,
        });
        const second = makeItem({ ...episode, id: 2, episodeNumber: 2 });
        const movie = makeItem({ id: 3, title: 'Movie' });
        const other = makeItem({ id: 4, title: 'Other movie' });
        const items = [episode, second, movie, other];
        const data = makeData(makeServerPlaylist({ isSystem: false }), items);
        data.collapsedGroups = { series: ['Series'], season: [] };
        render(Page, { props: { data } });
        const list = screen.getByLabelText('Playlist items');
        await fireEvent(
            list,
            new CustomEvent('consider', {
                detail: {
                    items,
                    info: { trigger: TRIGGERS.DRAG_STARTED, id: 1, source: SOURCES.KEYBOARD },
                },
            }),
        );
        await fireEvent(
            list,
            new CustomEvent('finalize', {
                detail: {
                    items: [second, movie, episode, other],
                    info: { id: 1, source: SOURCES.KEYBOARD },
                },
            }),
        );
        await waitFor(() => expect(dndzoneCalls.at(-1)?.dragDisabled).toBe(false));
        expect((dndzoneCalls.at(-1)?.items as PlaylistEntry[]).map((item) => item.id)).toEqual([
            3, 1, 2, 4,
        ]);
        await fireEvent(
            list,
            new CustomEvent('finalize', {
                detail: {
                    items: [movie, second, other, episode],
                    info: { id: 1, source: SOURCES.KEYBOARD },
                },
            }),
        );
        await waitFor(() => expect(dndzoneCalls.at(-1)?.dragDisabled).toBe(false));
        expect((dndzoneCalls.at(-1)?.items as PlaylistEntry[]).map((item) => item.id)).toEqual([
            3, 4, 1, 2,
        ]);
    });
});

describe('playlist watched failures', () => {
    afterEach(cleanup);
    it('reports a rejected watched change without changing progress', async () => {
        vi.mocked(playlistsApi.toggleItemWatched).mockResolvedValue({
            data: null,
            error: 'Offline',
            status: 503,
        });
        render(Page, {
            data: makeData(makeServerPlaylist(), [makeItem({ mediaId: 'movie' })]),
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Mark as watched' }));
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Mark as watched' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Mark as unwatched' })).toBeNull();
    });
});
