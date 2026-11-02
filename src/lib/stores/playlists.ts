// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { writable, get } from 'svelte/store';
import type { ExternalIds } from '$lib/types/api-common';
import type { Playlist, PlaylistEntry, PlaylistMember } from '$lib/types/api-playlists';
import type { PlaylistSummary } from '$lib/schemas/playlists';
import * as playlistsApi from '$lib/api/playlists';
import { unwrapApiResult } from '$lib/api/unwrap';
import { getExternalIdFor } from '$lib/utils/external-ids';
import {
    addToWatchlistStore,
    removeFromWatchlistStore,
    type WatchlistItem,
} from '$lib/stores/watchlist';

// Re-export types for consumers
export type { Playlist, PlaylistEntry, PlaylistMember };

/** Local picker metadata; the API receives only the selected catalog UUID. */
export type AddToPlaylistItem = Omit<AddToPlaylistModalState, 'isOpen'>;

// Add-to-playlist modal store (rendered outside Skeleton Modal for proper z-index stacking)
export interface AddToPlaylistModalState {
    isOpen: boolean;
    /** External IDs from various providers */
    externalIds: ExternalIds;
    mediaType: 'movie' | 'tv' | 'episode' | 'track';
    title: string;
    overview?: string;
    posterPath?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    seriesName?: string;
    /** External IDs for the parent series (for episodes) */
    seriesExternalIds?: ExternalIds;
}

export const addToPlaylistModal = writable<AddToPlaylistModalState | null>(null);

export function openAddToPlaylistModal(item: Omit<AddToPlaylistModalState, 'isOpen'>) {
    addToPlaylistModal.set({ ...item, isOpen: true });
}

export function closeAddToPlaylistModal() {
    addToPlaylistModal.set(null);
}

// Stores
export const userPlaylists = writable<{
    owned: Playlist[];
    shared: Playlist[];
    loading: boolean;
    error: string | null;
}>({
    owned: [],
    shared: [],
    loading: false,
    error: null,
});

export const currentPlaylist = writable<Playlist | null>(null);
export const currentPlaylistItems = writable<PlaylistEntry[]>([]);
export const currentPlaylistMembers = writable<PlaylistMember[]>([]);
export const playlistLoading = writable(false);
export const playlistError = writable<string | null>(null);

/**
 * Apply playlist mutation summary to all relevant stores.
 * Updates itemCount and updatedAt on both currentPlaylist and userPlaylists.
 */
export function applyPlaylistSummary(playlistId: number, summary: PlaylistSummary): void {
    currentPlaylist.update((p) =>
        p?.id === playlistId
            ? {
                  ...p,
                  itemCount: summary.itemCount,
                  updatedAt: summary.updatedAt,
                  revision: summary.revision,
              }
            : p,
    );
    userPlaylists.update((s) => ({
        ...s,
        owned: s.owned.map((p) =>
            p.id === playlistId
                ? {
                      ...p,
                      itemCount: summary.itemCount,
                      updatedAt: summary.updatedAt,
                      revision: summary.revision,
                  }
                : p,
        ),
        shared: s.shared.map((p) =>
            p.id === playlistId
                ? {
                      ...p,
                      itemCount: summary.itemCount,
                      updatedAt: summary.updatedAt,
                      revision: summary.revision,
                  }
                : p,
        ),
    }));
}

/**
 * Whether `playlistId` is the caller's watchlist, using whichever
 * playlist-scoped store already has its type loaded.
 *
 * Both "Add to playlist" entry points (`AddToPlaylistModal.svelte`,
 * `AddToPlaylistSubmenu.svelte`) load `userPlaylists` to build the target
 * list the user picks from, and `currentPlaylist` is populated whenever the
 * playlist detail page itself is what's driving the mutation — so the type
 * is always already in scope here, with no extra request and no new
 * parameter threaded from the callers.
 */
function isWatchlistPlaylist(playlistId: number): boolean {
    const current = get(currentPlaylist);
    if (current?.id === playlistId) {
        return current.playlistType === 'watchlist';
    }
    const { owned, shared } = get(userPlaylists);
    const match = owned.find((p) => p.id === playlistId) ?? shared.find((p) => p.id === playlistId);
    return match?.playlistType === 'watchlist';
}

/**
 * Normalise a playlist item's public `mediaType` ('movie' | 'series' | ...)
 * to the flat 'movie' | 'tv' vocabulary the watchlist store and every
 * in-watchlist indicator (`WatchlistButton`, `MediaHoverCard`,
 * `UniversalMediaCard`, `StandardSection`, `HeroSection`,
 * `FeaturedPickSection`) compare against. Anything else (episode, music,
 * audiobook, ...) has no watchlist indicator to keep in sync — return null
 * so the caller skips the sync instead of pushing a mismatched entry.
 */
function toWatchlistMediaType(mediaType: string): 'movie' | 'tv' | null {
    if (mediaType === 'movie') return 'movie';
    if (mediaType === 'series' || mediaType === 'tv') return 'tv';
    // The watchlist also holds audiobooks, and hydration stores every
    // non-series entry as 'movie' (watchlist-hydrate.service) — so must a
    // removal, or the audiobook's Watchlist buttons keep reading "saved".
    if (mediaType === 'audiobook') return 'movie';
    return null;
}

/**
 * Build the flat `WatchlistItem` the watchlist store holds from a playlist
 * item the server just returned for a watchlist-typed playlist.
 *
 * `externalIds` is passed through UNCHANGED. The UUID-first pattern means
 * the add-item response already carries `externalIds.internal`, and
 * `mediaCompositeKey` prefers that id over anything else — so the entry
 * produces the SAME key an indicator computes for the same media regardless
 * of the exact `mediaType` value. `mediaType` still needs normalising for
 * the fallback case where no UUID is present and the key falls back to
 * `provider:id:mediaType`.
 */
function toWatchlistStoreItemFromPlaylistItem(item: PlaylistEntry): WatchlistItem | null {
    const mediaType = toWatchlistMediaType(item.mediaType);
    if (!mediaType) return null;
    return {
        externalIds: { internal: item.mediaId },
        mediaType,
        title: item.title,
        overview: item.overview,
        savedAt: item.addedAt,
    };
}

/**
 * Mirror a watchlist-playlist change made OUTSIDE this store (the playlist
 * detail page calls the API directly) into the watchlist store, so every
 * Watchlist button stays in step with the list.
 */
export function syncWatchlistStoreAdded(item: PlaylistEntry): void {
    const watchlistItem = toWatchlistStoreItemFromPlaylistItem(item);
    if (watchlistItem) addToWatchlistStore(watchlistItem);
}

/** See {@link syncWatchlistStoreAdded}. */
export function syncWatchlistStoreRemoved(
    item: Pick<PlaylistEntry, 'mediaId' | 'mediaType'>,
): void {
    const mediaType = toWatchlistMediaType(item.mediaType);
    if (mediaType) removeFromWatchlistStore({ internal: item.mediaId }, mediaType);
}

// Actions

/**
 * Load user's playlists (owned and shared)
 */
export async function loadUserPlaylists(type?: 'general' | 'music' | 'video'): Promise<void> {
    userPlaylists.update((s) => ({ ...s, loading: true, error: null }));

    const { data, error } = await playlistsApi.getPlaylists(type);

    if (error || !data) {
        userPlaylists.update((s) => ({
            ...s,
            loading: false,
            error: error || 'Failed to load playlists',
        }));
        return;
    }

    // New contract: { items: Playlist[], page }. Separate by role.
    const allItems = data.items ?? [];
    userPlaylists.set({
        owned: allItems.filter((p) => p.role === 'owner'),
        shared: allItems.filter((p) => p.role !== 'owner'),
        loading: false,
        error: null,
    });
}

/**
 * Create a new playlist
 */
export async function createPlaylist(
    name: string,
    description?: string,
    visibility: 'private' | 'public' = 'private',
    playlistType: 'general' | 'music' | 'video' = 'general',
): Promise<Playlist | null> {
    const { data, error } = await playlistsApi.createPlaylist({
        name,
        description,
        visibility,
        playlistType,
    });

    if (error || !data) {
        console.error('Failed to create playlist:', error);
        return null;
    }

    // New contract: bare playlist object (no success/playlist wrapper).
    userPlaylists.update((s) => ({
        ...s,
        owned: [data, ...s.owned],
    }));

    return data;
}

/**
 * Load a single playlist with its items
 */
export async function loadPlaylist(playlistId: number): Promise<boolean> {
    playlistLoading.set(true);
    playlistError.set(null);

    const [metadata, entries] = await Promise.all([
        playlistsApi.getPlaylist(playlistId),
        playlistsApi.getAllPlaylistItems(playlistId),
    ]);
    if (!metadata.data || !entries.data || metadata.error || entries.error) {
        playlistError.set(metadata.error || entries.error || 'Failed to load playlist');
        playlistLoading.set(false);
        return false;
    }
    currentPlaylist.set(metadata.data);
    currentPlaylistItems.set(entries.data.items);
    playlistLoading.set(false);
    return true;
}

/**
 * Update playlist metadata
 */
export async function updatePlaylist(
    playlistId: number,
    updates: {
        name?: string;
        description?: string;
        visibility?: 'private' | 'public';
    },
): Promise<boolean> {
    const data = await unwrapApiResult(playlistsApi.updatePlaylist(playlistId, updates), {
        defaultValue: null as Playlist | null,
        onError: (error) => console.error('Failed to update playlist:', error),
    });

    if (!data) {
        return false;
    }

    // Update current playlist if it's the same
    currentPlaylist.update((p) => (p?.id === playlistId ? { ...p, ...data } : p));

    // Update in user playlists list
    userPlaylists.update((s) => ({
        ...s,
        owned: s.owned.map((p) => (p.id === playlistId ? { ...p, ...data } : p)),
        shared: s.shared.map((p) => (p.id === playlistId ? { ...p, ...data } : p)),
    }));

    return true;
}

/**
 * Delete a playlist
 */
export async function deletePlaylist(playlistId: number): Promise<boolean> {
    const { error } = await playlistsApi.deletePlaylist(playlistId);

    if (error) {
        console.error('Failed to delete playlist:', error);
        return false;
    }

    // Remove from user playlists
    userPlaylists.update((s) => ({
        ...s,
        owned: s.owned.filter((p) => p.id !== playlistId),
        shared: s.shared.filter((p) => p.id !== playlistId),
    }));

    // Clear current if deleted
    currentPlaylist.update((p) => (p?.id === playlistId ? null : p));

    return true;
}

/**
 * Add an item to a playlist
 * For TV series, automatically expands to all episodes
 * Returns the added item, or { expanded: true, episodes_added: N } for series
 */
export async function addItemToPlaylist(
    playlistId: number,
    item: AddToPlaylistItem,
): Promise<PlaylistEntry | { expanded: true; episodesAdded: number; seriesName: string } | null> {
    const mediaId = getExternalIdFor(item.externalIds, 'internal');
    if (!mediaId) throw new Error('A catalog media ID is required');
    const { data, error } = await playlistsApi.addItem(playlistId, { mediaIds: [mediaId] });
    if (error || !data) throw new Error(error || 'Unable to add item');
    if (!Array.isArray(data.results) || !data.summary) throw new Error('Unexpected response');
    applyPlaylistSummary(playlistId, data.summary);
    const result = data.results[0];
    if (!result || result.status === 'rejected') throw new Error(result?.reason || 'Item rejected');
    if (get(currentPlaylist)?.id === playlistId) {
        currentPlaylistItems.update((entries) => {
            const ids = new Set(entries.map((entry) => entry.id));
            return [...entries, ...result.entries.filter((entry) => !ids.has(entry.id))];
        });
    }
    if (isWatchlistPlaylist(playlistId)) result.entries.forEach(syncWatchlistStoreAdded);
    if (result.status === 'duplicate') return null;
    return result.expanded
        ? { expanded: true, episodesAdded: result.entries.length, seriesName: item.title }
        : result.entries[0];
}

/**
 * Remove an item from a playlist
 */
export async function removeItemFromPlaylist(playlistId: number, itemId: number): Promise<boolean> {
    const { data, error } = await playlistsApi.removeItem(playlistId, itemId);

    if (error) {
        console.error('Failed to remove item from playlist:', error);
        return false;
    }

    // Update current playlist items if viewing this playlist
    const current = get(currentPlaylist);
    if (current?.id === playlistId) {
        // The DELETE response carries no media identity — only
        // currentPlaylistItems (loaded for this exact playlist) knows what
        // is being removed, so capture it before filtering.
        const removedItem = get(currentPlaylistItems).find((i) => i.id === itemId);

        currentPlaylistItems.update((items) => {
            const filtered = items.filter((i) => i.id !== itemId);
            return filtered.map((item, idx) => ({
                ...item,
                position: idx,
            }));
        });

        if (current.playlistType === 'watchlist' && removedItem) {
            const watchlistMediaType = toWatchlistMediaType(removedItem.mediaType);
            if (watchlistMediaType) {
                removeFromWatchlistStore({ internal: removedItem.mediaId }, watchlistMediaType);
            }
        }
    }

    if (data) {
        applyPlaylistSummary(playlistId, data);
    }

    return true;
}

/**
 * Bulk delete items from a playlist
 */
export async function bulkDeleteItems(
    playlistId: number,
    itemIds: number[],
): Promise<{ deletedCount: number } | null> {
    const { data, error } = await playlistsApi.bulkDeleteItems(playlistId, itemIds);

    if (error || !data) {
        console.error('Failed to bulk delete items:', error);
        return null;
    }

    // Remove deleted items from current playlist items and reindex
    const deletedSet = new Set(itemIds);
    const current = get(currentPlaylist);
    if (current?.id === playlistId) {
        // Same reasoning as removeItemFromPlaylist: the bulk-delete response
        // carries no media identity, so capture it from currentPlaylistItems
        // before filtering.
        const removedItems = get(currentPlaylistItems).filter((i) => deletedSet.has(i.id));

        currentPlaylistItems.update((items) => {
            const filtered = items.filter((i) => !deletedSet.has(i.id));
            return filtered.map((item, idx) => ({
                ...item,
                position: idx,
            }));
        });

        if (current.playlistType === 'watchlist') {
            for (const removedItem of removedItems) {
                const watchlistMediaType = toWatchlistMediaType(removedItem.mediaType);
                if (watchlistMediaType) {
                    removeFromWatchlistStore({ internal: removedItem.mediaId }, watchlistMediaType);
                }
            }
        }
    }

    if (data) {
        applyPlaylistSummary(playlistId, data);
    }

    return { deletedCount: itemIds.length };
}

/**
 * Reorder items in a playlist (after drag-and-drop)
 */
export async function reorderItems(
    playlistId: number,
    items: { id: number; position: number }[],
): Promise<boolean> {
    const { data, error, code } = await playlistsApi.reorderItems(playlistId, {
        expectedRevision: get(currentPlaylist)?.revision ?? 0,
        entryIds: [...items].sort((a, b) => a.position - b.position).map((item) => item.id),
    });

    if (error) {
        console.error('Failed to reorder items:', error);
        if (code === 'conflict') await loadPlaylist(playlistId);
        return false;
    }

    // Update positions in current playlist items from the order sent to the server
    const positionMap = new Map(items.map((i) => [i.id, i.position]));
    currentPlaylistItems.update((currentItems) =>
        currentItems
            .map((item) => {
                const newPos = positionMap.get(item.id);
                return newPos !== undefined ? { ...item, position: newPos } : item;
            })
            .sort((a, b) => a.position - b.position),
    );

    if (data) {
        applyPlaylistSummary(playlistId, data);
    }

    return true;
}

/**
 * Toggle watched status for an item
 */
export async function toggleWatched(
    playlistId: number,
    itemId: number,
    watched: boolean,
): Promise<boolean> {
    const data = await unwrapApiResult(
        playlistsApi.toggleItemWatched(playlistId, itemId, { watched }),
        {
            defaultValue: null as {
                watched: boolean;
                watchedAt?: string | null;
                playlistSummary?: PlaylistSummary;
            } | null,
            onError: (error) => console.error('Failed to toggle watched status:', error),
        },
    );

    if (!data) {
        return false;
    }

    // Update in current items
    currentPlaylistItems.update((items) =>
        items.map((i) =>
            i.id === itemId
                ? {
                      ...i,
                      watched: data.watched,
                      watchedAt: data.watchedAt ?? undefined,
                  }
                : i,
        ),
    );

    if (data.playlistSummary) {
        applyPlaylistSummary(playlistId, data.playlistSummary);
    }

    return true;
}

/**
 * Load playlist members
 */
export async function loadPlaylistMembers(playlistId: number): Promise<boolean> {
    // New contract: { items: Member[], page } (paginated list).
    const data = await unwrapApiResult(playlistsApi.getMembers(playlistId), {
        defaultValue: null as { items: PlaylistMember[]; page: unknown } | null,
        onError: (error) => console.error('Failed to load members:', error),
    });

    if (!data) {
        return false;
    }

    currentPlaylistMembers.set(data.items || []);
    return true;
}

/**
 * Invite a user to a playlist.
 * Requires the invitee's stable UUID (from user search) — the /api/playlists/[id]/members
 * POST endpoint switched to userId-based invites (Q8).
 */
export async function inviteMember(
    playlistId: number,
    userId: string,
    role: 'editor' | 'readonly',
): Promise<PlaylistMember | null> {
    // New contract: bare member object (no success/member/timestamp wrapper).
    const data = await unwrapApiResult(playlistsApi.inviteMember(playlistId, { userId, role }), {
        defaultValue: null as PlaylistMember | null,
        onError: (error) => console.error('Failed to invite member:', error),
    });

    if (!data) {
        return null;
    }

    // data IS the member (bare object)
    currentPlaylistMembers.update((members) => [...members, data]);

    return data;
}

/**
 * Update a member's role
 */
export async function updateMemberRole(
    playlistId: number,
    userId: string,
    role: 'editor' | 'readonly',
): Promise<boolean> {
    const { error } = await playlistsApi.updateMemberRole(playlistId, userId, { role });

    if (error) {
        console.error('Failed to update member role:', error);
        return false;
    }

    // Update in members list
    currentPlaylistMembers.update((members) =>
        members.map((m) => (m.author.userId === userId ? { ...m, role } : m)),
    );

    return true;
}

/**
 * Remove a member from a playlist
 */
export async function removeMember(playlistId: number, userId: string): Promise<boolean> {
    const { error } = await playlistsApi.removeMember(playlistId, userId);

    if (error) {
        console.error('Failed to remove member:', error);
        return false;
    }

    // Remove from members list
    currentPlaylistMembers.update((members) => members.filter((m) => m.author.userId !== userId));

    return true;
}

/**
 * Search for users (for invite autocomplete)
 * Returns { id, username }[] from the new { items, page } contract.
 */
export async function searchUsers(query: string): Promise<{ username: string; id: string }[]> {
    if (!query || query.length < 2) {
        return [];
    }

    const { data } = await playlistsApi.searchUsers(query);

    return data?.items || [];
}
