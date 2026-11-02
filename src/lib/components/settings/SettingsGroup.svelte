<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import type { Snippet } from 'svelte';

    interface Props {
        /** Optional uppercase micro-label rendered above the card. */
        label?: string;
        /** Optional one-line description under the label. */
        description?: string;
        /** Optional controls on the label line (e.g. "Stop all"). */
        actions?: Snippet;
        /** Optional content under the card (e.g. a "sign out all" row). */
        footer?: Snippet;
        children?: Snippet;
    }
    let { label = '', description = '', actions, footer, children }: Props = $props();
    const id = $props.id();
</script>

<section class="mb-8" aria-labelledby={label ? id : undefined}>
    {#if label || actions}
        <div class="flex flex-wrap items-end justify-between gap-2 mb-2">
            {#if label}
                <h3 {id} class="text-xs font-semibold text-surface-300 uppercase tracking-wide">
                    {label}
                </h3>
            {/if}
            {#if actions}
                <div class="flex flex-wrap items-center gap-2">{@render actions()}</div>
            {/if}
        </div>
    {/if}
    {#if description}
        <p class="text-sm text-surface-400 mb-2">{description}</p>
    {/if}
    <div class="card-glass divide-y divide-surface-700/50">
        {@render children?.()}
    </div>
    {#if footer}
        <div class="mt-3 flex flex-wrap items-center gap-3">{@render footer()}</div>
    {/if}
</section>
