<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { page } from '$app/stores';
    import { Icon, PlayCircle } from 'svelte-hero-icons';

    interface Props {
        size?: string;
        color?: string;
    }

    let { size = 'w-4 h-4', color = '' }: Props = $props();

    // Get custom logo from layout data (if configured)
    let logoPlay = $derived($page.data?.branding?.logoPlay || '');
    let hasCustomLogo = $derived(!!logoPlay);

    // Check if we need to make the icon white/bright (for use on colored backgrounds)
    let needsBrightness = $derived(color === 'text-white' || color.includes('white'));
</script>

<!-- Branded play button icon - shows custom logo or default play icon -->
{#if hasCustomLogo}
    <img
        src={logoPlay}
        alt="Play"
        class="{size} object-contain"
        class:icon-white={needsBrightness} />
{:else}
    <span class={color}>
        <Icon src={PlayCircle} class={size} />
    </span>
{/if}

<style>
    /* Make image icon white using CSS filter - for use on colored buttons */
    .icon-white {
        filter: brightness(0) invert(1);
    }
</style>
