// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Builds the "Add to Playlist" context-menu entry for music tracks.
 *
 * Music tracks get an inline flyout (AddToPlaylistSubmenu) instead of the
 * centered AddToPlaylistModal — the modal is still what movies, series and
 * episodes use, since those need the series-expansion hint and item counts.
 */
import { QueueList } from 'svelte-hero-icons';
import { submenuComponent, type ContextMenuSubmenu } from '$lib/components/ui/context-menu-types';
import type { ExternalIds } from '$lib/types/api-common';
import type { MusicTrack } from '$lib/schemas/music';
import * as m from '$lib/paraglide/messages';
import AddToPlaylistSubmenu from './AddToPlaylistSubmenu.svelte';

export interface AddToPlaylistTarget {
    /** Track identity. `internal` (our UUID) is what the API resolves against. */
    externalIds: ExternalIds;
    title: string;
    /** Credit line — stored as the playlist item's overview. */
    subtitle?: string | undefined;
    posterPath?: string | undefined;
}

export function addToPlaylistEntry(target: AddToPlaylistTarget): ContextMenuSubmenu {
    return {
        kind: 'submenu',
        label: m.music_add_to_playlist(),
        icon: QueueList,
        ...submenuComponent(AddToPlaylistSubmenu, {
            externalIds: target.externalIds,
            title: target.title,
            subtitle: target.subtitle,
            posterPath: target.posterPath,
        }),
    };
}

/** Convenience wrapper for the common "I have a track id" call site. */
export function addTrackToPlaylistEntry(
    track: Pick<MusicTrack, 'id' | 'title' | 'artists' | 'images'>,
): ContextMenuSubmenu {
    return addToPlaylistEntry({
        externalIds: { internal: track.id },
        title: track.title,
        subtitle: track.artists.map((artist) => artist.title).join(', '),
        posterPath: track.images.primary?.variants?.thumb ?? track.images.primary?.href,
    });
}
