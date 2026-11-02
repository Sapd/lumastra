<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { page } from '$app/stores';
    import { browser } from '$app/environment';
    import { onMount } from 'svelte';
    import { Icon, XMark } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import { SONIC_FEATURE_DEFS } from '$lib/components/music/sonic-feature-defs';

    interface FeatureTile {
        href: string;
        label: string;
        description: string;
        icon: import('svelte-hero-icons').IconSource;
        enabled: boolean;
        desktopBest: boolean;
    }

    interface Props {
        /** Render the tile grid at mobile widths too. Default (false) keeps the
         * desktop-only behavior used on /music. /music/explore passes true — it's
         * the mobile-reachable surface for the sonic tools. */
        showOnMobile?: boolean;
    }

    const { showOnMobile = false }: Props = $props();

    const ONBOARDING_DISMISS_KEY = 'lumastra:music:hide-sonic-onboarding';

    let onboardingDismissed = $state(false);
    // Coarse pointer = touch device. Used to flag desktop-best surfaces (the
    // Music Map's pan/zoom/lasso canvas) so mobile users know before tapping in.
    let isCoarsePointer = $state(false);

    onMount(() => {
        if (!browser) return;
        try {
            onboardingDismissed = localStorage.getItem(ONBOARDING_DISMISS_KEY) === 'true';
        } catch {
            // Blocked / private-mode — silently skip
        }
        try {
            isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
        } catch {
            // matchMedia unavailable — assume fine pointer
        }
    });

    function dismissOnboarding(): void {
        onboardingDismissed = true;
        if (!browser) return;
        try {
            localStorage.setItem(ONBOARDING_DISMISS_KEY, 'true');
        } catch {
            // ignore quota / private-mode errors
        }
    }

    const tiles = $derived<FeatureTile[]>(
        SONIC_FEATURE_DEFS.map((def) => ({
            href: def.href,
            label: def.label(),
            description: def.description(),
            icon: def.icon,
            enabled: def.enabled($page.data?.features),
            desktopBest: def.desktopBest ?? false,
        })),
    );

    const visibleTiles = $derived(tiles.filter((t) => t.enabled));
    const anyEnabled = $derived(visibleTiles.length > 0);
</script>

{#if anyEnabled}
    <!-- Desktop-only by default (hidden lg:block). /music/explore passes
         showOnMobile so the sonic tools stay reachable on mobile — it's the
         designated mobile surface for this grid; /music keeps desktop-only. -->
    <div
        class={showOnMobile ? 'space-y-3' : 'hidden space-y-3 lg:block'}
        data-testid="music-feature-tiles">
        <h3 class="text-sm font-semibold uppercase tracking-wider text-surface-300">
            {m.music_feature_explore()}
        </h3>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {#each visibleTiles as tile (tile.href)}
                <a
                    href={resolve(tile.href)}
                    class="group flex min-w-0 items-start gap-3 rounded-xl border border-surface-700 bg-surface-800/60 p-4 text-left transition-colors hover:border-primary-400/60 hover:bg-surface-700/70 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary-300"
                    data-testid="feature-tile">
                    <div
                        class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-500/15 text-primary-200 transition-colors group-hover:bg-primary-500/25">
                        <Icon src={tile.icon} class="h-5 w-5" />
                    </div>
                    <div class="min-w-0 space-y-1">
                        <p class="text-base font-semibold text-surface-50">{tile.label}</p>
                        <p class="text-sm leading-relaxed text-surface-300">{tile.description}</p>
                        {#if tile.desktopBest && isCoarsePointer}
                            <p class="text-xs font-medium leading-normal text-amber-300">
                                {m.music_feature_desktop_best()}
                            </p>
                        {/if}
                    </div>
                </a>
            {/each}
        </div>
    </div>
{:else if !onboardingDismissed}
    <div
        class="relative rounded-xl border border-surface-700/40 bg-surface-800/60 px-4 py-3"
        data-testid="music-feature-tiles">
        <div class="flex items-start justify-between gap-4">
            <p class="text-sm text-surface-300">
                {m.music_feature_unlock_hint()}
                <a
                    href={resolve('/admin/developer/sonic-embeddings')}
                    class="ml-1 text-primary-400 underline-offset-2 hover:underline"
                    aria-label={m.music_feature_sound_search_label()}>
                    {m.route_music_empty_admin_sonic_cta()}
                </a>
            </p>
            <button
                class="shrink-0 text-surface-500 hover:text-surface-300"
                onclick={dismissOnboarding}
                aria-label={m.music_feature_dismiss_onboarding()}>
                <Icon src={XMark} class="h-4 w-4" />
            </button>
        </div>
    </div>
{/if}
