<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { tick } from 'svelte';
    import { base } from '$app/paths';
    import { popup, type PopupSettings } from '$lib/utils/popup';
    import { Z } from '$lib/utils/z-index';
    import { Icon, ChevronDown } from 'svelte-hero-icons';
    import { navigationIconMap } from './navigation-icons';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        value?: string;
        placeholder?: string;
        availableIcons?: string[];
        /**
         * Icons worth reaching for on this particular surface. They are listed
         * first under their own heading; everything else in `availableIcons`
         * follows. Purely presentational — any icon stays selectable.
         */
        suggestedIcons?: string[];
        availableLocalIcons?: string[];
        onChange?: (value: string) => void;
    }

    let {
        value = $bindable(''),
        placeholder = 'No icon',
        availableIcons = [],
        suggestedIcons = [],
        availableLocalIcons = [],
        onChange,
    }: Props = $props();

    const popupId = `nav-icon-dropdown-${Math.random().toString(36).substring(2, 9)}`;
    const listboxId = `${popupId}-listbox`;
    const popupSettings: PopupSettings = {
        event: 'click',
        target: popupId,
        placement: 'bottom',
    };

    // A free-text filter earns its place once the list is long enough to scroll
    // past (the catalog is ~220 icons); short curated lists keep the plain
    // dropdown they had.
    let query = $state('');
    const FILTER_THRESHOLD = 24;
    let showFilter = $derived(
        availableIcons.length + availableLocalIcons.length > FILTER_THRESHOLD,
    );

    function matchesQuery(candidate: string): boolean {
        const needle = query.trim().toLowerCase();
        if (!needle) return true;
        return candidate.toLowerCase().includes(needle);
    }

    let filteredLocalIcons = $derived(availableLocalIcons.filter(matchesQuery));
    // `suggestedIcons.includes` rather than a Set: svelte/prefer-svelte-reactivity
    // bans native Sets in components, and these lists are short.
    let filteredSuggested = $derived(
        availableIcons.filter((icon) => suggestedIcons.includes(icon) && matchesQuery(icon)),
    );
    let filteredOther = $derived(
        availableIcons.filter((icon) => !suggestedIcons.includes(icon) && matchesQuery(icon)),
    );

    // Flat option order for keyboard navigation — derived from the SAME filtered
    // lists the markup renders, so the index a button carries always addresses
    // the option a user sees at that position.
    let allOptionValues = $derived([
        '',
        '__custom__',
        ...filteredLocalIcons,
        ...filteredSuggested,
        ...filteredOther,
    ]);

    // aria-expanded: track visibility by observing the popup-visible class
    let isOpen = $state(false);
    let activeIndex = $state(-1);

    let popupEl: HTMLDivElement | undefined = $state(undefined);
    let triggerEl: HTMLButtonElement | undefined = $state(undefined);

    $effect(() => {
        if (!popupEl) return;
        const observer = new MutationObserver(() => {
            isOpen = popupEl!.classList.contains('popup-visible');
            if (!isOpen) {
                activeIndex = -1;
            }
        });
        observer.observe(popupEl, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    });

    function optionId(optionValue: string): string {
        return `${popupId}-opt-${optionValue.replace(/[^a-zA-Z0-9]/g, '_')}`;
    }

    function resolveIconPath(icon: string): string {
        if (icon.startsWith('http://') || icon.startsWith('https://') || icon.startsWith('//')) {
            return icon;
        }
        if (icon.startsWith('/')) {
            return `${base}${icon}`;
        }
        return icon;
    }

    function isCustomIconPath(icon: string | undefined): boolean {
        if (!icon) return false;
        return icon.startsWith('/') || icon.startsWith('http://') || icon.startsWith('https://');
    }

    function formatLocalIconLabel(iconPath: string): string {
        const filename = iconPath.split('/').pop() ?? iconPath;
        return filename.replace(/\.[^/.]+$/, '');
    }

    function getSelectedLabel(): string {
        if (!value) return placeholder;
        if (value === '__custom__') return m.admin_navigation_item_icon_custom_path();
        if (availableLocalIcons.includes(value)) {
            return formatLocalIconLabel(value);
        }
        if (availableIcons.includes(value)) return value;
        if (isCustomIconPath(value)) {
            return value.split('/').pop() ?? value;
        }
        return value;
    }

    let selectedBuiltInIcon = $derived(
        value && !isCustomIconPath(value) ? navigationIconMap[value] : undefined,
    );
    let selectedImageIcon = $derived(
        value && isCustomIconPath(value) ? resolveIconPath(value) : '',
    );

    async function selectOption(optionValue: string) {
        value = optionValue;
        await tick();
        onChange?.(optionValue);

        if (popupEl) {
            popupEl.classList.remove('popup-visible');
        }
        triggerEl?.focus();
    }

    function closeDropdown() {
        if (popupEl) {
            popupEl.classList.remove('popup-visible');
        }
        triggerEl?.focus();
    }

    function focusOption(index: number) {
        const el = popupEl?.querySelector<HTMLElement>(`[data-option-index="${index}"]`);
        el?.focus();
    }

    function handleTriggerKeydown(e: KeyboardEvent) {
        if (!isOpen) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            closeDropdown();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            const next = 0;
            activeIndex = next;
            focusOption(next);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const prev = allOptionValues.length - 1;
            activeIndex = prev;
            focusOption(prev);
        }
    }

    function handleFilterKeydown(e: KeyboardEvent) {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeDropdown();
        } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
            // Hand off to the list — and skip the two fixed options ("No icon",
            // "Custom path...") when a query is active, since someone who typed
            // a filter is after a match, not the placeholder rows. Enter is
            // swallowed here so it never submits the surrounding settings form.
            e.preventDefault();
            const first = query.trim() && allOptionValues.length > 2 ? 2 : 0;
            activeIndex = first;
            focusOption(first);
        }
    }

    function handleListboxKeydown(e: KeyboardEvent) {
        const target = e.target as HTMLElement;
        const indexStr = target.dataset.optionIndex;
        const currentIndex = indexStr !== undefined ? parseInt(indexStr, 10) : -1;

        if (e.key === 'Escape') {
            e.preventDefault();
            closeDropdown();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            const next = currentIndex < allOptionValues.length - 1 ? currentIndex + 1 : 0;
            activeIndex = next;
            focusOption(next);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const prev = currentIndex > 0 ? currentIndex - 1 : allOptionValues.length - 1;
            activeIndex = prev;
            focusOption(prev);
        } else if (e.key === 'Home') {
            e.preventDefault();
            activeIndex = 0;
            focusOption(0);
        } else if (e.key === 'End') {
            e.preventDefault();
            const last = allOptionValues.length - 1;
            activeIndex = last;
            focusOption(last);
        } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const targetValue = allOptionValues[currentIndex];
            if (targetValue !== undefined) {
                void selectOption(targetValue);
            }
        } else if (e.key === 'Tab') {
            closeDropdown();
        }
    }

    let activeDescendant = $derived(
        activeIndex >= 0 && activeIndex < allOptionValues.length
            ? optionId(allOptionValues[activeIndex])
            : undefined,
    );
</script>

<div class="relative inline-block w-full">
    <button
        bind:this={triggerEl}
        type="button"
        class="flex items-center gap-2 px-3 py-2 bg-surface-800 border border-surface-600 rounded-lg text-sm text-surface-200 hover:bg-surface-700 transition-colors w-full justify-between"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        onkeydown={handleTriggerKeydown}
        use:popup={popupSettings}>
        <span class="flex items-center gap-2 min-w-0">
            {#if selectedBuiltInIcon}
                <Icon src={selectedBuiltInIcon} class="w-4 h-4 shrink-0" />
            {:else if selectedImageIcon}
                <img src={selectedImageIcon} alt="" class="w-4 h-4 object-contain shrink-0" />
            {:else}
                <span class="w-4 h-4 shrink-0"></span>
            {/if}
            <span class="truncate">{getSelectedLabel()}</span>
        </span>
        <Icon src={ChevronDown} class="w-4 h-4 text-surface-400 shrink-0" />
    </button>

    <div
        bind:this={popupEl}
        class="dropdown-popup w-full bg-surface-800 border border-surface-600 rounded-lg shadow-xl"
        style="z-index: {Z.NAV_POPUP}"
        data-popup={popupId}>
        {#if showFilter}
            <div class="p-2 border-b border-surface-700">
                <input
                    type="text"
                    bind:value={query}
                    placeholder={m.admin_navigation_item_icon_search()}
                    aria-controls={listboxId}
                    class="w-full px-2 py-1.5 bg-surface-900 border border-surface-600 rounded text-sm text-surface-200 placeholder:text-surface-500 focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                    onkeydown={handleFilterKeydown} />
            </div>
        {/if}

        <div
            id={listboxId}
            class="max-h-72 overflow-auto"
            role="listbox"
            tabindex="-1"
            aria-activedescendant={activeDescendant}
            onkeydown={handleListboxKeydown}>
            <button
                type="button"
                id={optionId('')}
                data-option-index="0"
                class="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-surface-700 transition-colors"
                class:bg-surface-700={value === ''}
                role="option"
                aria-selected={value === ''}
                onclick={() => selectOption('')}>
                <span class="w-4 h-4"></span>
                <span>{placeholder}</span>
            </button>
            <button
                type="button"
                id={optionId('__custom__')}
                data-option-index="1"
                class="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-surface-700 transition-colors"
                class:bg-surface-700={value === '__custom__'}
                role="option"
                aria-selected={value === '__custom__'}
                onclick={() => selectOption('__custom__')}>
                <span class="w-4 h-4"></span>
                <span>{m.admin_navigation_item_icon_custom_path()}</span>
            </button>

            {#if filteredLocalIcons.length > 0}
                <div class="border-t border-surface-700">
                    <div
                        class="px-3 py-1.5 text-xs font-semibold text-surface-400 uppercase tracking-wide bg-surface-900/50">
                        {m.admin_navigation_item_icon_builtin_images()}
                    </div>
                    {#each filteredLocalIcons as iconPath, i (iconPath)}
                        <button
                            type="button"
                            id={optionId(iconPath)}
                            data-option-index={2 + i}
                            class="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-surface-700 transition-colors"
                            class:bg-surface-700={value === iconPath}
                            role="option"
                            aria-selected={value === iconPath}
                            onclick={() => selectOption(iconPath)}>
                            <img
                                src={resolveIconPath(iconPath)}
                                alt=""
                                class="w-4 h-4 object-contain shrink-0" />
                            <span class="truncate">
                                {formatLocalIconLabel(iconPath)}
                            </span>
                        </button>
                    {/each}
                </div>
            {/if}

            {#if filteredSuggested.length > 0}
                <div class="border-t border-surface-700">
                    <div
                        class="px-3 py-1.5 text-xs font-semibold text-surface-400 uppercase tracking-wide bg-surface-900/50">
                        {m.admin_navigation_item_icon_suggested()}
                    </div>
                    {#each filteredSuggested as iconName, i (iconName)}
                        {@render iconOption(iconName, 2 + filteredLocalIcons.length + i)}
                    {/each}
                </div>
            {/if}

            {#if filteredOther.length > 0}
                <div class="border-t border-surface-700">
                    <div
                        class="px-3 py-1.5 text-xs font-semibold text-surface-400 uppercase tracking-wide bg-surface-900/50">
                        {m.admin_navigation_item_icon_builtin_icons()}
                    </div>
                    {#each filteredOther as iconName, i (iconName)}
                        {@render iconOption(
                            iconName,
                            2 + filteredLocalIcons.length + filteredSuggested.length + i,
                        )}
                    {/each}
                </div>
            {/if}
        </div>
    </div>
</div>

{#snippet iconOption(iconName: string, index: number)}
    <button
        type="button"
        id={optionId(iconName)}
        data-option-index={index}
        class="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-surface-700 transition-colors"
        class:bg-surface-700={value === iconName}
        role="option"
        aria-selected={value === iconName}
        onclick={() => selectOption(iconName)}>
        {#if navigationIconMap[iconName]}
            <Icon src={navigationIconMap[iconName]} class="w-4 h-4 shrink-0" />
        {:else}
            <span class="w-4 h-4"></span>
        {/if}
        <span class="truncate">{iconName}</span>
    </button>
{/snippet}

<style>
    .dropdown-popup {
        display: none;
    }
    .dropdown-popup:global(.popup-visible) {
        display: block;
    }
</style>
