<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon } from 'svelte-hero-icons';
    import type { IconSource } from 'svelte-hero-icons';

    interface Props {
        /**
         * Reusable empty state component
         * Displays when lists/grids have no data
         */
        icon?: IconSource | undefined;
        title?: string;
        description?: string;
        iconColor?: string;
        variant?: 'card' | 'minimal';
        children?: import('svelte').Snippet;
    }

    let {
        icon = undefined,
        title = 'No items found',
        description = '',
        iconColor = 'text-gray-500',
        variant = 'card',
        children,
    }: Props = $props();
</script>

{#if variant === 'card'}
    <div class="bg-gray-800/50 border border-gray-600 rounded-lg p-6 text-center">
        {#if icon}
            <Icon src={icon} class={`w-12 h-12 ${iconColor} mx-auto mb-3`} />
        {/if}
        <h3 class="text-gray-300 font-medium mb-2">{title}</h3>
        {#if description}
            <p class="text-muted">{description}</p>
        {/if}
        {#if children}
            <div class="mt-4">
                {@render children?.()}
            </div>
        {/if}
    </div>
{:else}
    <div class="text-center py-8">
        {#if icon}
            <Icon src={icon} class={`h-16 w-16 ${iconColor} mx-auto mb-4`} />
        {/if}
        <p class="text-surface-400 mb-2">{title}</p>
        {#if description}
            <p class="text-surface-500 text-sm">{description}</p>
        {/if}
        {#if children}
            <div class="mt-4">
                {@render children?.()}
            </div>
        {/if}
    </div>
{/if}
