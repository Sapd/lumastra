<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
     SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
    import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';
    import { getEpisodeKey } from '$lib/utils/media-types';
    let {
        section,
        showAddButton,
        playlistItemKeys,
        onitemAddToPlaylist,
    }: {
        section: PageSection;
        showAddButton?: boolean;
        playlistItemKeys: Set<string>;
        onitemAddToPlaylist: (data: { section: PageSection; item: UniversalMediaItem }) => void;
    } = $props();
</script>

{#if showAddButton}
    {#each section.items as item (item.id)}
        <button type="button" onclick={() => onitemAddToPlaylist({ section, item })}
            >Add {item.title}</button>
        {#if playlistItemKeys.has(getEpisodeKey( { externalIds: item.externalIds ?? {}, mediaType: item.mediaType, seasonNumber: item.seasonNumber, episodeNumber: item.episodeNumber } ))}
            <span>Confirmed {item.title}</span>
        {/if}
    {/each}
{/if}
