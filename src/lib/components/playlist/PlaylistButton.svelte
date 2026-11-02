<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * PlaylistButton - Add to Playlist button
     *
     * Opens a modal to select or create a playlist to add the item to.
     * Uses a store-based modal that renders outside Skeleton's Modal for proper z-index stacking.
     *
     * Uses externalIds for provider-agnostic ID handling.
     */
    import { Icon, QueueList } from 'svelte-hero-icons';
    import type { ExternalIds } from '$lib/types/api-common';
    import * as m from '$lib/paraglide/messages';
    import { openAddToPlaylistModal } from '$lib/stores/playlists';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import { stopPropagation } from '$lib/utils/event-helpers';

    interface Props {
        // Props - Media info (uses externalIds for provider-agnostic ID handling)
        externalIds: ExternalIds;
        mediaType: 'movie' | 'tv' | 'episode';
        title: string;
        overview?: string;
        posterPath?: string;
        seasonNumber?: number | undefined;
        episodeNumber?: number | undefined;
        seriesName?: string;
        /** External IDs for the parent series (for episodes) */
        seriesExternalIds?: ExternalIds | undefined;
        // Props - Appearance
        variant?: 'button' | 'icon' | 'ghost';
        size?: 'sm' | 'md' | 'lg';
        // Callbacks
        onadded?: (detail: { playlistId: number; playlistName: string }) => void;
    }

    let {
        externalIds,
        mediaType,
        title,
        overview = '',
        posterPath = '',
        seasonNumber = undefined,
        episodeNumber = undefined,
        seriesName = '',
        seriesExternalIds = undefined,
        variant = 'button',
        size = 'md',
        onadded,
    }: Props = $props();

    function handleClick() {
        openAddToPlaylistModal({
            externalIds,
            mediaType,
            title,
            overview,
            posterPath,
            seasonNumber,
            episodeNumber,
            seriesName,
            seriesExternalIds,
        });
    }

    let sizeClass = $derived(
        {
            sm: 'text-sm',
            md: '',
            lg: 'text-lg',
        }[size],
    );

    let iconSize = $derived(
        {
            sm: 'w-4 h-4',
            md: 'w-5 h-5',
            lg: 'w-6 h-6',
        }[size],
    );
</script>

{#if variant === 'icon'}
    <Tooltip text={m.playlist_add_to_playlist()} position="top" fixed>
        <button
            type="button"
            class="btn-icon {size === 'sm' ? 'btn-icon-sm' : ''} variant-ghost-surface"
            onclick={stopPropagation(handleClick)}
            aria-label={m.playlist_add_to_playlist()}>
            <Icon src={QueueList} class={iconSize} />
        </button>
    </Tooltip>
{:else if variant === 'ghost'}
    <Tooltip text={m.playlist_add_to_playlist()} position="top" fixed>
        <button
            type="button"
            class="btn variant-ghost-surface flex items-center gap-2 min-h-10 {sizeClass}"
            aria-label={m.playlist_add_to_playlist()}
            onclick={stopPropagation(handleClick)}>
            <Icon src={QueueList} class={iconSize} />
            <span class="hidden sm:inline">{m.playlist_button_label()}</span>
        </button>
    </Tooltip>
{:else}
    <Tooltip text={m.playlist_add_to_playlist()} position="top" fixed>
        <button
            type="button"
            class="btn variant-soft-primary flex items-center gap-2 {sizeClass}"
            onclick={stopPropagation(handleClick)}>
            <Icon src={QueueList} class={iconSize} />
            <span>{m.playlist_to_playlist()}</span>
        </button>
    </Tooltip>
{/if}
