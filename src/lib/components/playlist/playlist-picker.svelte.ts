// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import * as api from '$lib/api/playlists';
import * as m from '$lib/paraglide/messages';
import {
    createPlaylist,
    addItemToPlaylist,
    syncWatchlistStoreAdded,
    type Playlist,
    type AddToPlaylistItem,
} from '$lib/stores/playlists';
import { WATCHLIST_MEDIA_TYPES } from '$lib/utils/playlist/watchlist-media-types';

export interface PlaylistPickerState {
    playlists: Playlist[];
    loading: boolean;
    loadError: boolean;
    error: string;
    query: string;
    showCreate: boolean;
    name: string;
    description: string;
    creating: boolean;
    addingId: number | null;
    outcomes: Record<number, string>;
    message: string;
}

export interface PlaylistPicker {
    state: PlaylistPickerState;
    readonly busy: boolean;
    readonly matches: Playlist[];
    load: () => Promise<void>;
    add: (playlist: Playlist) => Promise<void>;
    createAndAdd: () => Promise<void>;
    dispose: () => void;
}

/** Local picker state; reads never replace the shared playlist cache. */
export function createPlaylistPicker(
    getItem: () => AddToPlaylistItem,
    onSuccess?: () => void,
): PlaylistPicker {
    const state = $state<PlaylistPickerState>({
        playlists: [] as Playlist[],
        loading: true,
        loadError: false,
        error: '',
        query: '',
        showCreate: false,
        name: '',
        description: '',
        creating: false,
        addingId: null as number | null,
        outcomes: {} as Record<number, string>,
        message: '',
    });
    let disposed = false;
    const busy = $derived(state.creating || state.addingId !== null);
    const matches = $derived(
        state.playlists.filter((p) =>
            p.name.toLocaleLowerCase().includes(state.query.trim().toLocaleLowerCase()),
        ),
    );

    async function load(): Promise<void> {
        if (busy) return;
        state.loading = true;
        state.loadError = false;
        try {
            const mediaType = getItem().mediaType;
            const { data, error } = await api.getPlaylists(
                mediaType === 'track' ? 'music' : undefined,
            );
            if (disposed) return;
            if (error || !data) {
                state.loadError = true;
                return;
            }
            state.playlists = (data.items ?? []).filter(
                (p) =>
                    (p.role === 'owner' || p.role === 'editor') &&
                    (mediaType !== 'track' || p.playlistType === 'music') &&
                    (p.playlistType !== 'watchlist' || WATCHLIST_MEDIA_TYPES.has(mediaType)),
            );
        } catch {
            if (!disposed) state.loadError = true;
        } finally {
            if (!disposed) state.loading = false;
        }
    }

    async function performAdd(playlist: Playlist): Promise<boolean> {
        state.addingId = playlist.id;
        state.error = '';
        state.message = '';
        try {
            const result = await addItemToPlaylist(playlist.id, getItem());
            // Local reads need not populate the store's playlist-type cache.
            if (playlist.playlistType === 'watchlist' && result && !('expanded' in result)) {
                syncWatchlistStoreAdded(result);
            }
            if (!disposed) {
                const name = playlist.name;
                const message =
                    result === null
                        ? m.viewer_playlist_add_existing({ name })
                        : 'expanded' in result && result.expanded
                          ? m.viewer_playlist_add_expanded({ name, count: result.episodesAdded })
                          : m.viewer_playlist_add_added({ name });
                state.outcomes[playlist.id] = message;
                state.message = message;
                onSuccess?.();
            }
            return true;
        } catch {
            if (!disposed) state.error = m.playlist_add_error();
            return false;
        } finally {
            if (!disposed) state.addingId = null;
        }
    }

    async function add(playlist: Playlist): Promise<void> {
        if (busy || disposed || state.outcomes[playlist.id]) return;
        await performAdd(playlist);
    }

    async function createAndAdd(): Promise<void> {
        if (busy || disposed || !state.showCreate || !state.name.trim()) return;
        state.creating = true;
        state.error = '';
        try {
            const playlist = await createPlaylist(
                state.name.trim(),
                state.description.trim() || undefined,
                'private',
                getItem().mediaType === 'track' ? 'music' : 'general',
            );
            if (!playlist) {
                if (!disposed) state.error = m.playlist_create_failed();
                return;
            }
            // Keep the new destination if adding fails. Retrying its row never creates again.
            state.playlists = [playlist, ...state.playlists.filter((p) => p.id !== playlist.id)];
            state.query = '';
            state.showCreate = false;
            state.name = '';
            state.description = '';
            if (!(await performAdd(playlist)) && !disposed) {
                state.error = m.viewer_playlist_add_created_retry({ name: playlist.name });
            }
        } catch {
            if (!disposed) state.error = m.playlist_create_error();
        } finally {
            if (!disposed) state.creating = false;
        }
    }

    return {
        state,
        get busy(): boolean {
            return busy;
        },
        get matches(): Playlist[] {
            return matches;
        },
        load,
        add,
        createAndAdd,
        dispose(): void {
            disposed = true;
        },
    };
}
