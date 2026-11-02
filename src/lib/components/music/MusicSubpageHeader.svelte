<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  MusicSubpageHeader — shared header for all 7 sonic music sub-pages.

  Renders:
    (a) correct top offset to clear the fixed navbar (pt-20, matching /music)
    (b) a "← Music" back link to /music
    (c) the page title + icon
    (d) a compact feature-switcher pill row (enabled features only, current highlighted)

  Usage:
    <MusicSubpageHeader title={m.music_feature_map_label()} icon={GlobeAlt} />

  The outer page wrapper must NOT add its own pt-* — this component owns the top offset.
  Active pill detection is automatic via $page.url.pathname — no currentHref prop needed.
-->

<script lang="ts">
    import { page } from '$app/stores';
    import { Icon, ChevronLeft } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';
    import type { IconSource } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import { SONIC_FEATURE_DEFS } from '$lib/components/music/sonic-feature-defs';
    import MusicNavigation from './MusicNavigation.svelte';

    interface Props {
        /** Localised page title — caller passes the evaluated i18n string */
        title: string;
        /** Page icon shown next to the title */
        icon: IconSource;
        /** Overlay layout for viewport-filling music tools. */
        compact?: boolean;
    }

    const { title, icon, compact = false }: Props = $props();

    interface SwitcherPill {
        href: string;
        label: string;
        icon: IconSource;
        active: boolean;
    }

    /** Only pills for enabled + visible features */
    const pills = $derived<SwitcherPill[]>(
        SONIC_FEATURE_DEFS.filter((def) => def.enabled($page.data?.features)).map((def) => ({
            href: def.href,
            label: def.label(),
            icon: def.icon,
            active: $page.url.pathname === resolve(def.href),
        })),
    );
</script>

<!--
  lg:pt-20 = 5 rem = 80 px — clears the *fixed* desktop navbar (≥1024 px) with a
  ~4 px buffer. On mobile (<1024 px) the navbar sits in normal document flow and
  scrolls with content, so only a small pt-4 gap is needed there — the old flat
  pt-20 double-counted the navbar and left a large empty band above the title.
  Matches the pattern used by /music and /music/radio.
  The max-w-7xl + px-4 container matches the /music page outer wrapper.
-->
<div class={['music-subpage-header-wrap pt-4 lg:pt-20', { compact }]}>
    <div class="mx-auto max-w-7xl px-4">
        {#if !compact}
            <div class="mb-3">
                <MusicNavigation />
            </div>
        {/if}
        <!-- Back link -->
        <nav
            class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 {compact ? '' : 'lg:hidden'}"
            aria-label={m.music_nav_back_to_music_aria()}>
            <a
                href={resolve('/music')}
                class="inline-flex min-h-11 items-center gap-1 rounded text-sm text-surface-300 transition-colors hover:text-surface-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary-300"
                aria-label={m.music_nav_back_to_music_aria()}>
                <Icon src={ChevronLeft} class="h-4 w-4" aria-hidden="true" />
                {m.music_nav_back_to_music()}
            </a>
            <a
                href={resolve('/music/explore')}
                class="inline-flex min-h-11 items-center rounded text-sm font-medium text-primary-200 hover:text-primary-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary-300">
                {m.music_tab_explore()}
            </a>
        </nav>

        <!-- Page title -->
        <div class="mb-4 flex items-center gap-2">
            <Icon src={icon} class="h-6 w-6 text-surface-300" aria-hidden="true" />
            <h1 class="text-2xl font-bold text-white">{title}</h1>
        </div>

        <!-- Feature switcher -->
        {#if pills.length > 1}
            <nav class="mb-1 flex flex-wrap gap-2" aria-label={m.music_nav_features_aria()}>
                {#each pills as pill (pill.href)}
                    {#if pill.active}
                        <span
                            class="inline-flex items-center gap-1.5 rounded-full bg-primary-500/20 px-3 py-1 text-xs font-semibold text-primary-300 ring-1 ring-primary-500/40 {compact
                                ? ''
                                : 'min-h-11'}"
                            aria-current="page">
                            <Icon src={pill.icon} class="h-3.5 w-3.5" aria-hidden="true" />
                            {pill.label}
                        </span>
                    {:else}
                        <a
                            href={resolve(pill.href)}
                            class="inline-flex items-center gap-1.5 rounded-full bg-surface-800/70 px-3 py-1 text-xs font-medium text-surface-300 ring-1 ring-surface-700/50 transition-all hover:bg-surface-700/80 hover:text-surface-100 hover:ring-surface-600/60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary-300 {compact
                                ? ''
                                : 'min-h-11'}">
                            <Icon src={pill.icon} class="h-3.5 w-3.5" aria-hidden="true" />
                            {pill.label}
                        </a>
                    {/if}
                {/each}
            </nav>
        {/if}
    </div>
    <!-- Subtle divider between the header block and page content -->
    <div class="mx-auto mt-3 max-w-7xl border-b border-surface-700/30 px-4"></div>
</div>

<style>
    .compact {
        padding-top: 0.5rem;
    }

    .compact .max-w-7xl {
        max-width: none;
    }

    .compact nav.mb-3 {
        margin-bottom: 0.25rem;
    }

    .compact nav.mb-3 a {
        min-height: 0;
    }

    .compact div.mb-4 {
        margin-bottom: 0.5rem;
    }

    .compact h1 {
        font-size: 1.125rem;
    }

    .compact .mt-3 {
        display: none;
    }
</style>
