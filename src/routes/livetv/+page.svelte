<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { goto } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import { SvelteSet } from 'svelte/reactivity';
    import { setLiveTvFavorite } from '$lib/api/livetv-favorites.js';
    import { saveReturnPath } from '$lib/stores/playerNavigation.js';
    import { toasts } from '$lib/stores/toast.store.js';
    import type { LiveTvStation } from '$lib/schemas/livetv.js';
    import { page } from '$app/state';
    import { GENRE_PARAM, filterByGenre } from '$lib/shared/livetv-genres.js';

    import type { PageData } from './$types';
    let { data }: { data: PageData } = $props();

    // The layout's genre chips set ?genre=; an unknown value shows everything.
    let scoped = $derived(
        filterByGenre(data.channels, data.categories, page.url.searchParams.get(GENRE_PARAM)),
    );

    // Drives per-card remaining-time recomputation in the For You row, mirroring
    // ChannelGrid's own tick. Gated behind document.hidden so a backgrounded tab
    // doesn't recompute derived state.
    let now = $state(Date.now());
    $effect(() => {
        const id = setInterval(() => {
            if (!document.hidden) now = Date.now();
        }, 60_000);
        return () => clearInterval(id);
    });

    // Re-derives whenever the server-provided list changes (e.g. on navigation
    // reload). SvelteSet is itself reactive, so optimistic add()/delete() calls
    // in toggleFavorite below mutate this same instance and are picked up
    // immediately, without triggering a re-derive.
    let favoriteIds = $derived(new SvelteSet(data.favoriteChannelIds));

    function handleForYouClick(channel: LiveTvStation): void {
        saveReturnPath();
        goto(resolve(`/watch/${channel.id}`));
    }

    function handleSimpleWatch(channel: LiveTvStation): void {
        saveReturnPath();
        void goto(resolve(`/watch/${channel.id}`));
    }

    async function toggleFavorite(channel: LiveTvStation): Promise<void> {
        const wasFavorite = favoriteIds.has(channel.id);
        if (wasFavorite) {
            favoriteIds.delete(channel.id);
        } else {
            favoriteIds.add(channel.id);
        }

        const result = await setLiveTvFavorite(channel.id, !wasFavorite);
        if (result.error) {
            if (wasFavorite) {
                favoriteIds.add(channel.id);
            } else {
                favoriteIds.delete(channel.id);
            }
            toasts.error(result.error);
        }
    }
</script>

<svelte:head>
    <title>{m.media_live_tv()}</title>
</svelte:head>

{#if data.simpleMode && data.simpleHome}
    {@const SimpleLiveTvHome = data.simpleHome}
    <!-- Live TV simple mode: the viewer's own numbered channels, large and calm. -->
    <SimpleLiveTvHome
        mode={data.simpleMode}
        channels={data.channels}
        username={page.data.user?.username}
        loadError={data.loadError === true}
        onwatch={handleSimpleWatch} />
{:else if data.loadError}
    <!-- The layout owns the explicit load error and Retry action. -->
{:else if data.channels.length === 0}
    <div class="flex items-center justify-center p-12">
        <p class="text-surface-400 text-lg">{m.livetv_no_channels()}</p>
    </div>
{:else}
    {#if data.personalizedChannels.length > 0 && !scoped.active && data.channelCard}
        {@const ChannelCard = data.channelCard}
        <div class="mx-auto max-w-7xl px-4 pt-4 pb-2">
            <h2
                class="mb-3 text-sm font-semibold uppercase tracking-wide text-surface-400 border-b border-surface-700/50 pb-2">
                {m.livetv_for_you()}
            </h2>
            <div class="flex gap-3 overflow-x-auto pb-2">
                {#each data.personalizedChannels as channel (channel.id)}
                    <div class="w-72 shrink-0">
                        <ChannelCard
                            {channel}
                            {now}
                            onclick={handleForYouClick}
                            favorite={favoriteIds.has(channel.id)}
                            onToggleFavorite={toggleFavorite} />
                    </div>
                {/each}
            </div>
        </div>
    {/if}
    {#if data.channelGrid}
        {@const ChannelGrid = data.channelGrid}
        <ChannelGrid
            channels={scoped.channels}
            categories={scoped.categories}
            showSearchBar={false}
            favoriteChannelIds={favoriteIds}
            onToggleFavorite={toggleFavorite}
            feedChoice={data.liveTvFeedChoice === true} />
    {/if}
{/if}
