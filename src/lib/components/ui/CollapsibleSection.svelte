<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, ChevronDown, ChevronUp } from 'svelte-hero-icons';
    import { createCollapseHandler } from '$lib/utils/ui-state';
    import { onMount } from 'svelte';

    interface Props {
        /**
         * Reusable collapsible section component
         * Handles collapse state with localStorage persistence
         */
        storageKey: string;
        title?: string;
        /** Initial collapsed state - captured once, not reactive */
        defaultCollapsed?: boolean;
        showToggle?: boolean;
        header?: import('svelte').Snippet;
        children?: import('svelte').Snippet;
    }

    let {
        storageKey,
        title = '',
        defaultCollapsed = false,
        showToggle = true,
        header,
        children,
    }: Props = $props();

    // svelte-ignore state_referenced_locally
    let isCollapsed = $state(defaultCollapsed);
    // svelte-ignore state_referenced_locally
    const collapseHandler = createCollapseHandler(storageKey);

    onMount(() => {
        isCollapsed = collapseHandler.loadState();
    });

    function toggle() {
        isCollapsed = collapseHandler.toggle(isCollapsed);
    }
</script>

<div class="w-full">
    <!-- Header Slot -->
    <div class="between mb-4">
        {#if header}{@render header()}{:else if title}
            <h2 class="h2">{title}</h2>
        {/if}

        {#if showToggle}
            <button
                onclick={toggle}
                class="p-1 hover:bg-gray-700 rounded-full transition-colors"
                title={isCollapsed ? 'Expand' : 'Collapse'}
                aria-label={isCollapsed ? 'Expand section' : 'Collapse section'}
                aria-expanded={!isCollapsed}>
                <Icon
                    src={isCollapsed ? ChevronDown : ChevronUp}
                    class="w-4 h-4 text-gray-400 hover:text-white" />
            </button>
        {/if}
    </div>

    <!-- Content -->
    {#if !isCollapsed}
        <div class="fade-in">
            {@render children?.()}
        </div>
    {/if}
</div>
