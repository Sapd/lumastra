<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import type { Snippet } from 'svelte';
    import { Icon, type IconSource } from 'svelte-hero-icons';

    interface Props {
        /** Row label (left). */
        label: string;
        /** Optional hint shown under the label. */
        hint?: string;
        /** Optional leading icon. */
        icon?: IconSource;
        /** Optional anchor id so search results can scroll/highlight this row. */
        anchorId?: string;
        /** Whether this row is the active highlight target (deep-link). */
        highlighted?: boolean;
        /** The control rendered on the right. */
        control?: Snippet;
    }
    let {
        label,
        hint = '',
        icon = undefined,
        anchorId = undefined,
        highlighted = false,
        control,
    }: Props = $props();
</script>

<div
    id={anchorId}
    class="flex flex-wrap items-center justify-between py-3 px-4 gap-4 scroll-mt-24 {highlighted
        ? 'ring-2 ring-primary-500/60 rounded-lg'
        : ''}">
    <div class="flex items-center gap-2 min-w-0">
        {#if icon}
            <Icon src={icon} class="w-4 h-4 text-surface-400 shrink-0" />
        {/if}
        <div class="min-w-0">
            <span class="text-sm">{label}</span>
            {#if hint}
                <p class="text-xs text-surface-500 mt-0.5">{hint}</p>
            {/if}
        </div>
    </div>
    <div class="max-w-full flex flex-wrap items-center gap-2">
        {@render control?.()}
    </div>
</div>
