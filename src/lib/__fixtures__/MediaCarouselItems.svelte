<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
     SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
    import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';

    let {
        section,
        onitemClick,
    }: {
        section: PageSection;
        onitemClick: (data: { section: PageSection; item: UniversalMediaItem }) => void;
    } = $props();
</script>

{#each section.items as item (item.id)}
    <button data-testid={`stats-${item.title}`} onclick={() => onitemClick({ section, item })}>
        {item.title}:{String(item.isAvailable)}
    </button>
{/each}
