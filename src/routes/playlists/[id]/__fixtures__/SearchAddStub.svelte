<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
     SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
    import type { PlaylistAddItem, PlaylistAddOutcome } from '$lib/types/playlist';
    let {
        isOpen,
        onaddToPlaylist,
    }: {
        isOpen?: boolean;
        onaddToPlaylist: (item: PlaylistAddItem) => Promise<PlaylistAddOutcome>;
    } = $props();
    let outcome = $state('');
    async function add(): Promise<void> {
        outcome = await onaddToPlaylist({
            externalIds: { internal: '550e8400-e29b-41d4-a716-446655440000' },
            mediaType: 'movie',
            title: 'Added movie',
        });
    }
</script>

{#if isOpen}
    <button type="button" onclick={add}>Submit search item</button>
    <p data-testid="add-outcome">{outcome}</p>
{/if}
