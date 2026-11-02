<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { onMount, type Snippet } from 'svelte';
    import * as m from '$lib/paraglide/messages';
    import {
        initializePreferences,
        playbackPreferences,
    } from '$lib/components/player/preferences-sync.svelte';

    let { children }: { children: Snippet } = $props();
    const blocked = $derived(!playbackPreferences.ready || playbackPreferences.storageUnavailable);

    onMount(() => {
        void initializePreferences();
    });
</script>

{#if blocked}
    <div class="mb-4 text-sm text-surface-400" aria-live="polite">
        {#if playbackPreferences.storageUnavailable}
            <p role="alert" class="mb-2">{m.admin_redesign_settings_storage_unknown()}</p>
        {/if}
        {#if playbackPreferences.loading}
            {m.common_loading()}
        {:else}
            <button
                type="button"
                class="btn btn-sm variant-ghost-surface"
                onclick={() => void initializePreferences()}>
                {m.common_retry()}
            </button>
        {/if}
    </div>
{/if}

<fieldset
    class="m-0 min-w-0 border-0 p-0"
    disabled={blocked}
    aria-busy={playbackPreferences.loading}>
    {@render children()}
</fieldset>
