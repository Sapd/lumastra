<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { tick } from 'svelte';
    import { Icon, ChevronDown } from 'svelte-hero-icons';
    import { popup, type PopupSettings } from '$lib/utils/popup';
    import { Z } from '$lib/utils/z-index';
    import {
        NetflixIcon,
        DisneyIcon,
        PrimeIcon,
        HboIcon,
        AppleTvIcon,
        TrendingIcon,
        PopularIcon,
        CertifiedFreshIcon,
        BoxOfficeIcon,
        AnimeIcon,
    } from '$lib/icons/streaming';

    interface OptionGroup {
        label: string;
        options: Option[];
    }

    interface Option {
        value: string;
        label: string;
        icon?: string;
    }

    interface Props {
        value?: string;
        disabled?: boolean;
        placeholder?: string;
        groups?: OptionGroup[];
        onchange?: (value: string) => void;
    }

    let {
        value = $bindable(''),
        disabled = false,
        placeholder = 'Select...',
        groups = [],
        onchange,
    }: Props = $props();

    // Unique popup ID for this instance
    const popupId = `icon-dropdown-${Math.random().toString(36).substring(2, 9)}`;
    const popupSettings: PopupSettings = {
        event: 'click',
        target: popupId,
        placement: 'bottom',
    };

    // Map list IDs to their icon components
    const iconMap: Record<string, typeof NetflixIcon> = {
        'netflix-movies': NetflixIcon,
        'netflix-shows': NetflixIcon,
        'disney-movies': DisneyIcon,
        'disney-shows': DisneyIcon,
        'amazon-prime-movies': PrimeIcon,
        'amazon-prime-shows': PrimeIcon,
        'hbo-shows': HboIcon,
        'apple-tv-movies': AppleTvIcon,
        'apple-tv-all': AppleTvIcon,
        'trending-movies': TrendingIcon,
        'trending-shows': TrendingIcon,
        'popular-movies': PopularIcon,
        'popular-shows': PopularIcon,
        'certified-fresh': CertifiedFreshIcon,
        'box-office': BoxOfficeIcon,
        'latest-anime': AnimeIcon,
        'latest-anime-movies': AnimeIcon,
    };

    function getIconComponent(listId: string) {
        return iconMap[listId] || TrendingIcon;
    }

    function getSelectedLabel(): string {
        if (!value) return placeholder;
        for (const group of groups) {
            const option = group.options.find((o) => o.value === value);
            if (option) {
                // Remove emoji from label if present
                return option.label.replace(
                    /^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]\s*/u,
                    '',
                );
            }
        }
        return placeholder;
    }

    async function selectOption(optionValue: string) {
        value = optionValue;
        await tick();
        onchange?.(optionValue);

        // Close the popup by removing the visible class
        const popupElement = document.querySelector(`[data-popup="${popupId}"]`);
        if (popupElement) {
            popupElement.classList.remove('popup-visible');
        }
    }
</script>

<div class="relative inline-block">
    <button
        type="button"
        class="flex items-center gap-2 px-3 py-1.5 bg-surface-700 border border-surface-600 rounded text-sm text-surface-200 hover:bg-surface-600 transition-colors min-w-[160px] justify-between"
        class:opacity-50={disabled}
        class:cursor-not-allowed={disabled}
        use:popup={popupSettings}
        {disabled}>
        <span class="flex items-center gap-2">
            {#if value && iconMap[value]}
                {@const SvelteComponent = getIconComponent(value)}
                <SvelteComponent size="w-4 h-4" />
            {/if}
            <span class="truncate">{getSelectedLabel()}</span>
        </span>
        <Icon src={ChevronDown} class="w-4 h-4 text-surface-400 shrink-0" />
    </button>

    <div
        class="dropdown-popup w-56 max-h-80 overflow-auto bg-surface-800 border border-surface-600 rounded-lg shadow-xl"
        style="z-index: {Z.NAV_POPUP}"
        data-popup={popupId}
        role="listbox">
        <!-- Default/placeholder option -->
        <button
            type="button"
            class="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-surface-700 transition-colors"
            class:bg-surface-700={value === ''}
            onclick={() => selectOption('')}>
            <span class="w-4 h-4"></span>
            <span>{placeholder}</span>
        </button>

        {#each groups as group (group.label)}
            <div class="border-t border-surface-600">
                <div
                    class="px-3 py-1.5 text-xs font-semibold text-surface-400 uppercase tracking-wide bg-surface-900/50">
                    {group.label}
                </div>
                {#each group.options as option (option.value)}
                    <button
                        type="button"
                        class="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-surface-700 transition-colors"
                        class:bg-surface-700={value === option.value}
                        onclick={() => selectOption(option.value)}>
                        {#if iconMap[option.value]}
                            {@const SvelteComponent_1 = getIconComponent(option.value)}
                            <SvelteComponent_1 size="w-4 h-4" />
                        {:else}
                            <span class="w-4 h-4"></span>
                        {/if}
                        <span class="truncate">
                            {option.label.replace(
                                /^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]\s*/u,
                                '',
                            )}
                        </span>
                    </button>
                {/each}
            </div>
        {/each}
    </div>
</div>

<style>
    .dropdown-popup {
        display: none;
    }
    .dropdown-popup:global(.popup-visible) {
        display: block;
    }
</style>
