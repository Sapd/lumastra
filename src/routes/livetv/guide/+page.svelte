<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { goto } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import ProgramGuide from '$lib/components/livetv/ProgramGuide.svelte';
    import { saveReturnPath } from '$lib/stores/playerNavigation.js';
    import type { LiveTvStation } from '$lib/schemas/livetv.js';
    import { page } from '$app/state';
    import { GENRE_PARAM, filterByGenre } from '$lib/shared/livetv-genres.js';

    let { data } = $props();

    let scoped = $derived(
        filterByGenre(data.channels, data.categories, page.url.searchParams.get(GENRE_PARAM)),
    );

    function handleChannelClick(channel: LiveTvStation): void {
        saveReturnPath();
        void goto(resolve(`/watch/${channel.id}`));
    }
</script>

<svelte:head>
    <title>{m.media_live_tv()} — {m.livetv_view_guide()}</title>
</svelte:head>

{#if data.loadError}
    <!-- The layout owns the explicit load error and Retry action. -->
{:else if data.channels.length === 0}
    <div class="flex items-center justify-center p-12">
        <p class="text-surface-400 text-lg">{m.livetv_no_channels()}</p>
    </div>
{:else}
    <ProgramGuide
        channels={scoped.channels}
        categories={scoped.categories}
        onChannelClick={handleChannelClick} />
{/if}
