// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared right-click menu for a music track shown outside the queue list.
 *
 * QueueTrackItem builds its own menu because it leads with queue-position
 * actions (play now / play next / remove). Everything else that shows a
 * single track — the mini-player artwork, the mini-player up-next strip, the
 * queue's "Now Playing" row — wants exactly the same set, so it lives here
 * instead of being copy-pasted per surface.
 */
import {
    Sparkles,
    UserCircle,
    MusicalNote,
    WrenchScrewdriver,
    ArrowRight,
    Beaker,
} from 'svelte-hero-icons';
import type { MusicTrack } from '$lib/schemas/music';
import type { ContextMenuEntry } from '$lib/components/ui/context-menu-types';
import { openAlbumModal, openArtistModal, openSimilarTracksModal } from '$lib/utils/modal-utils';
import { addTrackToPlaylistEntry } from '$lib/components/playlist/add-to-playlist-menu';
import * as m from '$lib/paraglide/messages';

export interface MusicTrackMenuOptions {
    /** FEATURE_MUSIC_SONIC — gates similarity and song-path entries. */
    sonicEnabled?: boolean;
    /** FEATURE_MUSIC_ALCHEMY — gates the mixing-desk shortcut. */
    alchemyEnabled?: boolean;
    /** Adds the admin deeplink (desktop only). */
    isAdmin?: boolean;
    /** Client-side navigation, injected so this module stays framework-free. */
    navigate?: (path: string) => void;
}

/**
 * Returns the entries for `track`, or an empty array when there is nothing
 * meaningful to offer — no track, or a radio stream, which has no catalog id
 * to hang album/artist/playlist actions off.
 */
export function buildMusicTrackMenu(
    track: MusicTrack | null | undefined,
    options: MusicTrackMenuOptions = {},
): ContextMenuEntry[] {
    if (!track || track.isRadio) return [];
    const { sonicEnabled = false, alchemyEnabled = false, isAdmin = false, navigate } = options;

    const out: ContextMenuEntry[] = [];

    if (track.artists[0]?.id) {
        out.push({
            label: m.music_go_to_artist(),
            icon: UserCircle,
            onSelect: () => openArtistModal(track.artists[0]?.id ?? ''),
        });
    }
    if (track.album?.id) {
        out.push({
            label: m.music_go_to_album(),
            icon: MusicalNote,
            onSelect: () => openAlbumModal(track.album?.id ?? ''),
        });
    }
    out.push({
        label: m.music_more_tracks_like_this(),
        icon: Sparkles,
        onSelect: () => openSimilarTracksModal(track.id, sonicEnabled),
    });
    if (sonicEnabled && navigate) {
        out.push({
            label: m.card_music_song_paths(),
            icon: ArrowRight,
            onSelect: () => navigate(`/music/path?from=${track.id}`),
        });
    }
    if (alchemyEnabled && navigate) {
        out.push({
            label: m.card_music_open_mixing_desk(),
            icon: Beaker,
            onSelect: () => navigate('/music/alchemy'),
        });
    }

    out.push(addTrackToPlaylistEntry(track));

    if (isAdmin) {
        out.push({
            label: m.music_manage_in_admin(),
            icon: WrenchScrewdriver,
            hideOnMobile: true,
            onSelect: () => {
                if (typeof window === 'undefined') return;
                window.open(
                    `/admin/library/media/${encodeURIComponent(track.id)}`,
                    '_blank',
                    'noopener,noreferrer',
                );
            },
        });
    }

    return out;
}
