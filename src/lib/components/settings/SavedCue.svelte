<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { Icon, Check } from 'svelte-hero-icons';
    import { fade } from 'svelte/transition';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        /** Bump this number on each successful save to flash the cue. */
        savedAt?: number;
    }
    let { savedAt = 0 }: Props = $props();

    let visible = $state(false);
    let lastShown = -1;

    // Show the cue for ~1.8s whenever savedAt advances.
    $effect(() => {
        if (savedAt > 0 && savedAt !== lastShown) {
            lastShown = savedAt;
            visible = true;
            const t = setTimeout(() => (visible = false), 1800);
            return () => clearTimeout(t);
        }
    });
</script>

<span class="inline-flex min-h-5 items-center gap-1 text-xs text-success-400" role="status">
    {#if visible}
        <span transition:fade={{ duration: 120 }} class="inline-flex items-center gap-1">
            <Icon src={Check} class="w-3.5 h-3.5" />
            {m.viewer_settings_applied()}
        </span>
    {/if}
</span>
