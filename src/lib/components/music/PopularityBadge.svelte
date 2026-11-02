<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import { base } from '$app/paths';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import type { PopularitySummary } from '$lib/schemas/music';

    interface Props {
        popularity: PopularitySummary;
        variant: 'artist' | 'track';
        showListeners?: boolean;
        /**
         * Replace the default "listeners"/"plays" label — used where the
         * number belongs to a DIFFERENT subject than the surrounding header
         * (the album modal shows the artist's popularity, which unlabeled
         * reads as an album stat).
         */
        labelOverrides?: { listeners?: string; plays?: string };
    }

    let { popularity, variant, showListeners = false, labelOverrides }: Props = $props();

    let attributionImage = $derived(
        popularity.attribution.source === 'lastfm'
            ? {
                  src: `${base}/attribution/powered-by-audioscrobbler.png`,
                  alt: m.attribution_lastfm_powered(),
                  width: 127,
                  height: 31,
              }
            : undefined,
    );

    function formatCount(n: number): string {
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
        if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
        return String(n);
    }

    // Returns { value, label } or null when nothing meaningful to show.
    let countDisplay = $derived.by((): { value: string; label: string } | null => {
        if (popularity.listeners != null && popularity.listeners > 0) {
            return {
                value: formatCount(popularity.listeners),
                label: labelOverrides?.listeners ?? 'listeners',
            };
        }
        if (popularity.playcount != null && popularity.playcount > 0) {
            return {
                value: formatCount(popularity.playcount),
                label: labelOverrides?.plays ?? 'plays',
            };
        }
        return null;
    });

    let hasRank = $derived(
        popularity.rankInArtist != null &&
            popularity.rankInArtist >= 1 &&
            popularity.rankInArtist <= 30,
    );
</script>

{#if variant === 'artist'}
    {#if countDisplay}
        <Tooltip text={popularity.attribution.text} image={attributionImage}>
            <svelte:element
                this={popularity.attribution.url ? 'a' : 'span'}
                href={popularity.attribution.url || undefined}
                role={popularity.attribution.url ? 'link' : undefined}
                onclickcapture={popularity.attribution.url
                    ? (event: MouseEvent) => event.stopPropagation()
                    : undefined}
                onkeydowncapture={popularity.attribution.url
                    ? (event: KeyboardEvent) => {
                          if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
                      }
                    : undefined}
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-1 text-xs text-surface-400 hover:text-surface-200 transition-colors">
                <span class="font-medium text-white">{countDisplay.value}</span>
                <span>{countDisplay.label}</span>
            </svelte:element>
        </Tooltip>
    {/if}
{:else if variant === 'track'}
    {#if hasRank || (showListeners && countDisplay)}
        <Tooltip text={popularity.attribution.text} image={attributionImage}>
            <svelte:element
                this={popularity.attribution.url ? 'a' : 'span'}
                href={popularity.attribution.url || undefined}
                role={popularity.attribution.url ? 'link' : undefined}
                onclickcapture={popularity.attribution.url
                    ? (event: MouseEvent) => event.stopPropagation()
                    : undefined}
                onkeydowncapture={popularity.attribution.url
                    ? (event: KeyboardEvent) => {
                          if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
                      }
                    : undefined}
                target={popularity.attribution.url ? '_blank' : undefined}
                rel={popularity.attribution.url ? 'noopener noreferrer' : undefined}
                class="inline-flex items-center gap-1 flex-shrink-0">
                {#if hasRank}
                    <!-- Star icon -->
                    <svg
                        class="w-3 h-3 text-amber-400 flex-shrink-0"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                        aria-hidden="true">
                        <path
                            d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                    </svg>
                    <span class="text-[11px] text-amber-400 font-medium"
                        >#{popularity.rankInArtist}</span>
                {/if}
                {#if showListeners && countDisplay}
                    <span class="text-[11px] text-surface-400">
                        {countDisplay.value}
                    </span>
                {/if}
            </svelte:element>
        </Tooltip>
    {/if}
{/if}
