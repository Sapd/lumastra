<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Mobile music Search tab. Reuses MusicSearchResults (shared with the desktop
  inline search on /music). iOS may not raise the keyboard on programmatic
  focus after navigation — accepted, verified in the manual phone pass.
-->

<script lang="ts">
    import { page } from '$app/stores';
    import { onMount } from 'svelte';
    import { Icon, MagnifyingGlass, XMark } from 'svelte-hero-icons';
    import MusicSearchResults from '$lib/components/music/MusicSearchResults.svelte';
    import MusicNavigation from '$lib/components/music/MusicNavigation.svelte';
    import { createMusicItemHandlers } from '$lib/utils/music-item-handlers.svelte';
    import {
        handleMusicSearchShortcut,
        musicSearchShortcutLabel,
    } from '$lib/utils/music-search-shortcut';
    import * as m from '$lib/paraglide/messages.js';

    const handlers = createMusicItemHandlers();

    let searchQuery = $state($page.url.searchParams.get('q') ?? '');
    let searchInputRef: HTMLInputElement | undefined = $state();
    let searchResultsRef: MusicSearchResults | undefined = $state();
    let shortcutLabel = $state('');

    onMount(() => {
        shortcutLabel = musicSearchShortcutLabel();
        searchInputRef?.focus();
        searchInputRef?.select();
    });

    function clearSearch(): void {
        searchQuery = '';
        searchInputRef?.focus();
    }

    function handleSearchInputKeydown(e: KeyboardEvent): void {
        if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
        if ((e.key === 'ArrowDown' || e.key === 'Enter') && searchQuery.trim().length >= 2) {
            e.preventDefault();
            searchResultsRef?.focusFirstResult();
        } else if (e.key === 'Escape' && searchQuery) {
            e.preventDefault();
            searchQuery = '';
        }
    }
</script>

<svelte:window onkeydown={(e) => handleMusicSearchShortcut(e, searchInputRef)} />

<svelte:head>
    <title>{m.route_music_title()}</title>
</svelte:head>

<div class="mx-auto max-w-7xl space-y-6 px-4 pt-4 lg:pt-20 pb-20">
    <MusicNavigation />
    <header>
        <h1 class="text-3xl font-bold text-surface-50">{m.music_tab_search()}</h1>
        <p id="music-search-scope" class="mt-2 text-sm text-surface-400">
            {m.viewer_music_search_scope()}
        </p>
    </header>
    <div class="relative">
        <span class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-surface-400">
            <Icon src={MagnifyingGlass} class="h-4 w-4" />
        </span>
        <input
            type="search"
            aria-label={m.route_music_search_placeholder()}
            aria-describedby="music-search-scope"
            placeholder={m.route_music_search_placeholder()}
            aria-keyshortcuts="Meta+F Control+F /"
            autocomplete="off"
            spellcheck="false"
            enterkeyhint="search"
            bind:value={searchQuery}
            bind:this={searchInputRef}
            onkeydown={handleSearchInputKeydown}
            class="peer w-full rounded-lg border border-surface-600/50 bg-surface-800/80 py-2 pr-8 pl-9 text-base text-surface-50 placeholder-surface-500 outline-none transition-colors focus:border-primary-500/50 focus:ring-1 focus:ring-primary-500/30" />
        {#if searchQuery}
            <button
                class="absolute top-1/2 right-0 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-surface-400 hover:text-surface-50 focus-visible:outline-2 focus-visible:outline-primary-400"
                aria-label={m.btn_clear_search()}
                onclick={clearSearch}>
                <Icon src={XMark} class="h-4 w-4" />
            </button>
        {/if}
    </div>

    <MusicSearchResults
        bind:this={searchResultsRef}
        bind:query={searchQuery}
        {handlers}
        onfocusinput={() => searchInputRef?.focus()} />
    {#if searchQuery.trim().length < 2}
        <p class="py-8 text-center text-surface-400">{m.viewer_music_search_start()}</p>
    {/if}
</div>
