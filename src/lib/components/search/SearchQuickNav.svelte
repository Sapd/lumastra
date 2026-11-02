<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	SearchQuickNav.svelte

	Quick category navigation - vertical dots with labels on the right side.
	Extracted from Search.svelte to improve maintainability.

	Generic over a minimal category shape so it can be reused outside the
	global search modal (e.g. the inline /music search results): categories
	only need key/label, plus optional icon/iconColor. Counts are read from
	`groupedResults[key]` and omitted when no entry exists — that lets a
	caller list a lazily-fetched section (unknown count) without showing a
	misleading "(0)".
-->
<script lang="ts">
    import { Icon } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';
    import { getCategoryIcon } from '$lib/constants/search-categories';

    /**
     * Structural subset of SearchCategory — full SearchCategory objects
     * satisfy this, and lightweight callers can pass plain objects.
     */
    interface QuickNavCategory {
        key: string;
        label: string;
        icon?: ReturnType<typeof getCategoryIcon>;
        iconColor?: string;
    }

    interface Props {
        // Props
        categoriesWithResults: QuickNavCategory[];
        activeCategory: string | null;
        groupedResults?: Record<string, readonly unknown[] | undefined>;
        onscrollTo?: (detail: string) => void;
        /** Positioning of the whole rail — override for non-modal hosts. */
        positionClass?: string;
        /** Which side of the dots the labels sit on. */
        labelSide?: 'left' | 'right';
    }

    let {
        categoriesWithResults,
        activeCategory,
        groupedResults = {},
        onscrollTo,
        positionClass = 'absolute -right-6 top-1/2 -translate-y-1/2 z-20 hidden sm:block',
        labelSide = 'right',
    }: Props = $props();
</script>

{#if categoriesWithResults.length > 1}
    <nav class="quick-nav {positionClass}" aria-label={m.search_category_navigation_aria()}>
        <div class="group/nav relative">
            <!-- Vertical line -->
            <div class="absolute left-1/2 -translate-x-1/2 top-2 bottom-2 w-px bg-surface-500/50">
            </div>

            <!-- Dots -->
            <div class="relative flex flex-col items-center gap-3">
                {#each categoriesWithResults as cat (cat.key)}
                    <button
                        class="relative center w-5 h-5 transition-transform hover:scale-110"
                        class:scale-125={activeCategory === cat.key}
                        onclick={() => onscrollTo?.(cat.key)}
                        aria-label={m.search_jump_to_aria({ label: cat.label })}
                        title={cat.label}>
                        <span
                            class="w-2.5 h-2.5 rounded-full transition-all duration-200 border-2"
                            class:bg-primary-500={activeCategory === cat.key}
                            class:border-primary-500={activeCategory === cat.key}
                            class:bg-transparent={activeCategory !== cat.key}
                            class:border-surface-400={activeCategory !== cat.key}></span>
                    </button>
                {/each}
            </div>

            <!-- Labels (always visible, on the configured side of the dots) -->
            <div
                class="absolute top-0 flex flex-col gap-3 {labelSide === 'right'
                    ? 'left-full pl-3'
                    : 'right-full pr-3 items-end'}">
                {#each categoriesWithResults as cat (cat.key)}
                    {@const IconComponent = cat.icon ?? getCategoryIcon(cat.key)}
                    {@const count = groupedResults[cat.key]?.length}
                    <button class="h-5 flex items-center" onclick={() => onscrollTo?.(cat.key)}>
                        <span
                            class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-all duration-150 shadow-lg backdrop-blur-sm {activeCategory ===
                            cat.key
                                ? 'bg-primary-500/30 text-primary-300 border border-primary-500/50'
                                : 'bg-surface-900/90 text-surface-200 border border-surface-700'}">
                            <Icon src={IconComponent} class="w-3.5 h-3.5 {cat.iconColor ?? ''}" />
                            {cat.label}
                            {#if count !== undefined}
                                <span class="text-surface-400 ml-0.5">({count})</span>
                            {/if}
                        </span>
                    </button>
                {/each}
            </div>
        </div>
    </nav>
{/if}
