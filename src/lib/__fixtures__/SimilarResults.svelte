<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
     SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
    import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';
    let {
        section,
        onitemMore,
        onitemClick,
        onitemPlay,
    }: {
        section: PageSection;
        onitemMore: (data: { section: PageSection; item: UniversalMediaItem }) => void;
        onitemClick: (data: { section: PageSection; item: UniversalMediaItem }) => void;
        onitemPlay: (data: { section: PageSection; item: UniversalMediaItem }) => void;
    } = $props();
</script>

{#each section.items as item (item.id)}
    <button onclick={() => onitemMore({ section, item })}>Similar to {item.title}</button>
    <button onclick={() => onitemClick({ section, item })}>Details {item.title}</button>
    <button onclick={() => onitemPlay({ section, item })}>Play {item.title}</button>
{/each}
