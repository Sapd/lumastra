<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  MusicBottomNav — the app's first bottom tab bar. Mobile-only (< lg), rendered
  only on music routes (see isMusicBottomNavRoute). Four tabs: Home / Explore /
  Library / Search. Pads with env(safe-area-inset-bottom) for notch/PWA. The
  MiniPlayer docks directly above this bar (see Task 3's --music-bottom-nav-h).
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import { page } from '$app/stores';
    import { resolve } from '$lib/paths';
    import { Icon, Home, Squares2x2, RectangleStack, MagnifyingGlass } from 'svelte-hero-icons';
    import type { IconSource } from 'svelte-hero-icons';
    import { Z } from '$lib/utils/z-index';
    import {
        activeMusicTab,
        DEFAULT_LIBRARY_SEGMENT,
        libraryHref,
        segmentFromRoute,
        type MusicTab,
    } from '$lib/utils/music-bottom-nav';
    import { musicLibrarySegment } from '$lib/utils/music-library-navigation';
    import * as m from '$lib/paraglide/messages.js';

    let mounted = $state(false);
    let navElement: HTMLElement;
    onMount(() => {
        mounted = true;
        const rootStyle = document.documentElement.style;
        const measure = (): void => {
            const height = navElement.getBoundingClientRect().height;
            if (height > 0) rootStyle.setProperty('--music-bottom-nav-measured-h', `${height}px`);
            else rootStyle.removeProperty('--music-bottom-nav-measured-h');
        };
        measure();
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
        observer?.observe(navElement, { box: 'border-box' });
        return (): void => {
            observer?.disconnect();
            rootStyle.removeProperty('--music-bottom-nav-measured-h');
        };
    });
    // Keep the hydration href identical to SSR before applying browser-only memory.
    const librarySegment = $derived(
        mounted
            ? $musicLibrarySegment
            : (segmentFromRoute(
                  $page.route.id,
                  $page.url.searchParams,
                  $page.data?.playlist?.playlistType,
              ) ?? DEFAULT_LIBRARY_SEGMENT),
    );

    const active = $derived<MusicTab | null>(
        activeMusicTab(
            $page.route.id ?? null,
            $page.url.searchParams,
            $page.data?.playlist?.playlistType,
        ),
    );

    interface Tab {
        key: MusicTab;
        label: string;
        icon: IconSource;
        href: string;
    }

    const tabs = $derived<Tab[]>([
        { key: 'home', label: m.music_tab_home(), icon: Home, href: '/music' },
        { key: 'explore', label: m.music_tab_explore(), icon: Squares2x2, href: '/music/explore' },
        {
            key: 'library',
            label: m.music_tab_library(),
            icon: RectangleStack,
            href: libraryHref(librarySegment),
        },
        {
            key: 'search',
            label: m.music_tab_search(),
            icon: MagnifyingGlass,
            href: '/music/search',
        },
    ]);
</script>

<nav
    bind:this={navElement}
    data-music-bottom-nav
    data-testid="music-bottom-nav"
    aria-label={m.music_bottom_nav_aria()}
    class="fixed inset-x-0 bottom-0 grid grid-cols-4 border-t border-surface-700/40 bg-surface-900/95 backdrop-blur-lg lg:hidden"
    style="z-index: {Z.BOTTOM_NAV}; padding-bottom: env(safe-area-inset-bottom);">
    {#each tabs as tab (tab.key)}
        <a
            href={resolve(tab.href)}
            data-testid="music-bottom-nav-tab"
            data-tab={tab.key}
            aria-current={active === tab.key ? 'page' : undefined}
            class="music-tab flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 text-[11px] font-medium leading-tight transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary-300 {active ===
            tab.key
                ? 'text-primary-300'
                : 'text-surface-400 hover:text-surface-200'}">
            <span
                class="flex h-6 w-12 shrink-0 items-center justify-center rounded-full {active ===
                tab.key
                    ? 'bg-primary-500/20 ring-1 ring-inset ring-primary-400/30'
                    : ''}">
                <Icon
                    src={tab.icon}
                    class="h-5 w-5"
                    solid={active === tab.key}
                    aria-hidden="true" />
            </span>
            <span class="w-full break-words text-center">{tab.label}</span>
        </a>
    {/each}
</nav>

<style>
    .music-tab {
        min-height: calc(3.5rem - 1px);
    }
</style>
