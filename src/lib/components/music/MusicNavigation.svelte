<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { onMount } from 'svelte';
    import { page } from '$app/stores';
    import { Icon, Home, Squares2x2, RectangleStack, MagnifyingGlass } from 'svelte-hero-icons';
    import {
        activeMusicTab,
        DEFAULT_LIBRARY_SEGMENT,
        libraryHref,
        segmentFromRoute,
    } from '$lib/utils/music-bottom-nav';
    import { musicLibrarySegment } from '$lib/utils/music-library-navigation';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';

    let mounted = $state(false);
    onMount(() => {
        mounted = true;
    });

    const playlistType = $derived($page.data?.playlist?.playlistType);
    // Match SSR during hydration; storage-backed links become available after mount.
    const librarySegment = $derived(
        mounted
            ? $musicLibrarySegment
            : (segmentFromRoute($page.route.id, $page.url.searchParams, playlistType) ??
                  DEFAULT_LIBRARY_SEGMENT),
    );
    const links = $derived([
        { tab: 'home', href: '/music', label: m.music_tab_home(), icon: Home },
        { tab: 'explore', href: '/music/explore', label: m.music_tab_explore(), icon: Squares2x2 },
        {
            tab: 'library',
            href: libraryHref(librarySegment),
            label: m.music_tab_library(),
            icon: RectangleStack,
        },
        {
            tab: 'search',
            href: '/music/search',
            label: m.music_tab_search(),
            icon: MagnifyingGlass,
        },
    ]);

    const activeTab = $derived(
        activeMusicTab($page.route.id, $page.url.searchParams, playlistType),
    );
</script>

<nav
    aria-label={m.music_bottom_nav_aria()}
    class="hidden flex-wrap gap-2 border-b border-surface-700/50 pb-3 lg:flex">
    {#each links as link (link.tab)}
        <a
            href={resolve(link.href)}
            aria-current={activeTab === link.tab ? 'page' : undefined}
            class="inline-flex min-h-11 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-300 {activeTab ===
            link.tab
                ? 'bg-primary-500/15 text-primary-300'
                : 'text-surface-300 hover:bg-surface-800 hover:text-surface-50'}">
            <Icon
                src={link.icon}
                class="h-5 w-5 shrink-0"
                solid={activeTab === link.tab}
                aria-hidden="true" />
            {link.label}
        </a>
    {/each}
</nav>
