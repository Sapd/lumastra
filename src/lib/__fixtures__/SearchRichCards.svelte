<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
     SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
    import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';
    import SearchPlaylistActions from './SearchPlaylistActions.svelte';
    let {
        section,
        onitemClick,
        onitemMore,
        onitemPlay,
        onitemRequest,
        ...rest
    }: {
        section: PageSection;
        onitemClick: (data: { section: PageSection; item: UniversalMediaItem }) => void;
        onitemMore?: (data: { section: PageSection; item: UniversalMediaItem }) => void;
        onitemPlay?: (data: { section: PageSection; item: UniversalMediaItem }) => void;
        onitemRequest?: (data: { section: PageSection; item: UniversalMediaItem }) => void;
        showAddButton?: boolean;
        playlistItemKeys: Set<string>;
        onitemAddToPlaylist: (data: { section: PageSection; item: UniversalMediaItem }) => void;
    } = $props();
</script>

{#each section.items as item (item.id)}
    <button onclick={() => onitemClick({ section, item })}>{item.title}</button>
    {#if onitemPlay && (item.isAvailable || ['track', 'album', 'artist'].includes(item.mediaType))}
        <button onclick={() => onitemPlay?.({ section, item })}>Play {item.title}</button>
    {/if}
    {#if onitemRequest && item.canRequest}
        <button onclick={() => onitemRequest?.({ section, item })}>Request {item.title}</button>
    {/if}
    {#if onitemMore}
        <button onclick={() => onitemMore({ section, item })}>Similar to {item.title}</button>
    {/if}
    {#if item.overview}<p>{item.overview}</p>{/if}
{/each}
<SearchPlaylistActions {section} {...rest} />
