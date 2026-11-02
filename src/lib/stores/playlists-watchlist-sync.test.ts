// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * The watchlist became a real `playlists` row (`playlist_type = 'watchlist'`,
 * `is_system = true`) and a valid target in the "Add to playlist" UI. Both
 * entry points (`AddToPlaylistModal.svelte`, `AddToPlaylistSubmenu.svelte`)
 * write the row through `addItemToPlaylist` in this module, which only ever
 * updated the playlist-scoped stores (`currentPlaylistItems`, `userPlaylists`)
 * — never the `watchlistItems` store that every in-watchlist indicator
 * (`WatchlistButton`, `MediaHoverCard`, `UniversalMediaCard`,
 * `StandardSection`, `HeroSection`, `FeaturedPickSection`) actually reads.
 * The membership index stayed stale until a hard reload (which re-hydrates
 * from `GET /api/watchlist`).
 *
 * The server side is correct (verified separately against real Postgres) —
 * this file pins the client-side sync only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';

const addItem = vi.fn();
const removeItem = vi.fn();
const bulkDeleteItemsApi = vi.fn();

vi.mock('$lib/api/playlists', () => ({
    getPlaylists: vi.fn(),
    createPlaylist: vi.fn(),
    addItem: (...a: unknown[]) => addItem(...a),
    removeItem: (...a: unknown[]) => removeItem(...a),
    bulkDeleteItems: (...a: unknown[]) => bulkDeleteItemsApi(...a),
    getPlaylist: vi.fn(),
    updatePlaylist: vi.fn(),
    deletePlaylist: vi.fn(),
    reorderItems: vi.fn(),
}));

import {
    addItemToPlaylist,
    removeItemFromPlaylist,
    bulkDeleteItems,
    syncWatchlistStoreAdded,
    syncWatchlistStoreRemoved,
    currentPlaylist,
    currentPlaylistItems,
    userPlaylists,
} from './playlists';
import { watchlistItems } from './watchlist';
import { mediaCompositeKey } from '$lib/utils/media-id-helpers';
import type { Playlist, PlaylistEntry } from '$lib/types/api-playlists';

const WATCHLIST_PLAYLIST: Playlist = {
    id: 42,
    owner: { userId: 'owner-id', displayName: 'Denis', images: { primary: { href: '/avatar', revision: '0', source: 'self' } } },
    revision: 0,
    memberCount: 0,
    description: null,
    images: {},
    name: 'Watchlist',
    visibility: 'private',
    playlistType: 'watchlist',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    role: 'owner',
    itemCount: 0,
    isSystem: true,
};

const ORDINARY_PLAYLIST: Playlist = {
    ...WATCHLIST_PLAYLIST,
    id: 43,
    playlistType: 'general',
    isSystem: false,
};

// Carries `internal` — the UUID-first pattern the real add-item response
// always carries — so `mediaCompositeKey` resolves through it regardless of
// mediaType casing/vocabulary quirks.
const ITEM_EXTERNAL_IDS = { internal: 'movie-uuid-1', tmdb: '550' };

function makePlaylistItem(overrides: Partial<PlaylistEntry> = {}): PlaylistEntry {
    return {
        id: 1,
        mediaId: ITEM_EXTERNAL_IDS.internal,
        mediaType: 'movie',
        title: 'Quiet Orbit',
        position: 0,
        addedAt: '2026-09-23T00:00:00.000Z',
        watched: false,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    currentPlaylist.set(null);
    currentPlaylistItems.set([]);
    userPlaylists.set({ owned: [], shared: [], loading: false, error: null });
    watchlistItems.set([]);
});

describe('addItemToPlaylist — watchlist sync', () => {
    it('adds a matching entry to watchlistItems when the target playlist is the watchlist, with a composite key equal to what an indicator would compute', async () => {
        userPlaylists.set({ owned: [WATCHLIST_PLAYLIST], shared: [], loading: false, error: null });
        const item = makePlaylistItem();
        addItem.mockResolvedValue({
            data: {
                results: [{ status: 'added', expanded: false, entries: [item] }],
                summary: { revision: 1, itemCount: 1, updatedAt: '' },
            },
            error: null,
            status: 200,
        });

        await addItemToPlaylist(WATCHLIST_PLAYLIST.id, {
            externalIds: ITEM_EXTERNAL_IDS,
            mediaType: 'movie',
            title: 'Quiet Orbit',
        });

        const stored = get(watchlistItems);
        expect(stored).toHaveLength(1);

        // This is the assertion that catches "present but never matches": the
        // stored entry must produce the SAME key an indicator computes for
        // the same media — not merely exist in the array.
        const indicatorKey = mediaCompositeKey({ internal: item.mediaId }, 'movie');
        const storedKey = mediaCompositeKey(stored[0].externalIds, stored[0].mediaType);
        expect(storedKey).toBe(indicatorKey);
    });

    it('does NOT touch watchlistItems when adding to an ordinary playlist', async () => {
        userPlaylists.set({ owned: [ORDINARY_PLAYLIST], shared: [], loading: false, error: null });
        const item = makePlaylistItem({ id: 2 });
        addItem.mockResolvedValue({
            data: {
                results: [{ status: 'added', expanded: false, entries: [item] }],
                summary: { revision: 1, itemCount: 1, updatedAt: '' },
            },
            error: null,
            status: 200,
        });

        await addItemToPlaylist(ORDINARY_PLAYLIST.id, {
            externalIds: ITEM_EXTERNAL_IDS,
            mediaType: 'movie',
            title: 'Quiet Orbit',
        });

        expect(get(watchlistItems)).toHaveLength(0);
    });
});

describe('removeItemFromPlaylist — watchlist sync', () => {
    it('removes the matching entry from watchlistItems when removing from the watchlist playlist', async () => {
        currentPlaylist.set(WATCHLIST_PLAYLIST);
        const item = makePlaylistItem({ id: 5 });
        currentPlaylistItems.set([item]);
        watchlistItems.set([
            {
                externalIds: { internal: item.mediaId },
                mediaType: 'movie',
                title: item.title,
                savedAt: item.addedAt,
            },
        ]);
        removeItem.mockResolvedValue({
            data: { itemCount: 0, revision: 1, updatedAt: '' },
            error: null,
        });

        await removeItemFromPlaylist(WATCHLIST_PLAYLIST.id, 5);

        expect(get(watchlistItems)).toHaveLength(0);
    });

    it('does NOT touch watchlistItems when removing from an ordinary playlist', async () => {
        currentPlaylist.set(ORDINARY_PLAYLIST);
        const item = makePlaylistItem({ id: 6 });
        currentPlaylistItems.set([item]);
        watchlistItems.set([
            {
                externalIds: { internal: item.mediaId },
                mediaType: 'movie',
                title: item.title,
                savedAt: item.addedAt,
            },
        ]);
        removeItem.mockResolvedValue({
            data: { itemCount: 0, revision: 1, updatedAt: '' },
            error: null,
        });

        await removeItemFromPlaylist(ORDINARY_PLAYLIST.id, 6);

        expect(get(watchlistItems)).toHaveLength(1);
    });
});

describe('bulkDeleteItems — watchlist sync', () => {
    it('removes every deleted item from watchlistItems when bulk-deleting from the watchlist playlist', async () => {
        currentPlaylist.set(WATCHLIST_PLAYLIST);
        const itemA = makePlaylistItem({ id: 7, mediaId: 'uuid-a' });
        const itemB = makePlaylistItem({ id: 8, mediaId: 'uuid-b' });
        currentPlaylistItems.set([itemA, itemB]);
        watchlistItems.set([
            {
                externalIds: { internal: itemA.mediaId },
                mediaType: 'movie',
                title: itemA.title,
                savedAt: '',
            },
            {
                externalIds: { internal: itemB.mediaId },
                mediaType: 'movie',
                title: itemB.title,
                savedAt: '',
            },
        ]);
        bulkDeleteItemsApi.mockResolvedValue({
            data: { itemCount: 0, revision: 1, updatedAt: '' },
            error: null,
        });

        await bulkDeleteItems(WATCHLIST_PLAYLIST.id, [7, 8]);

        expect(get(watchlistItems)).toHaveLength(0);
    });
});

describe("syncWatchlistStoreAdded / syncWatchlistStoreRemoved — the detail page's own writes", () => {
    // The playlist detail page calls the API directly, not through this store,
    // so it mirrors its adds/removes into the watchlist store with these.
    const internal = '00000000-0000-4000-8000-0000000000ab';

    beforeEach(() => watchlistItems.set([]));

    it('an audiobook removed from the watchlist page stops reading "saved"', () => {
        // Hydration stores every non-series watchlist entry as 'movie'.
        watchlistItems.set([
            { externalIds: { internal }, mediaType: 'movie', title: 'Book', savedAt: 'x' } as never,
        ]);
        syncWatchlistStoreRemoved({ mediaId: internal, mediaType: 'audiobook' } as never);
        expect(get(watchlistItems)).toEqual([]);
    });

    it('an add on the watchlist page appears in the store under the indicator key', () => {
        syncWatchlistStoreAdded({
            id: 1,
            mediaId: internal,
            mediaType: 'series',
            title: 'Show',
            addedAt: '2026-01-01T00:00:00.000Z',
        } as never);
        const [entry] = get(watchlistItems);
        expect(mediaCompositeKey(entry.externalIds, entry.mediaType)).toBe(
            mediaCompositeKey({ internal }, 'tv'),
        );
    });

    it('ignores types the watchlist has no indicator for (episode, track)', () => {
        syncWatchlistStoreAdded({
            id: 2,
            mediaId: internal,
            mediaType: 'episode',
        } as never);
        expect(get(watchlistItems)).toEqual([]);
    });
});
