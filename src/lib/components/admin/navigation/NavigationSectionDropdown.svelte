<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { tick } from 'svelte';
    import { popup, type PopupSettings } from '$lib/utils/popup';
    import { Z } from '$lib/utils/z-index';
    import { Icon, ChevronDown } from 'svelte-hero-icons';
    import { navigationIconMap } from './navigation-icons';

    interface SectionOption {
        id: string;
        label: string;
        icon?: string;
    }

    interface Props {
        value?: string;
        placeholder?: string;
        sections?: SectionOption[];
        onChange?: (value: string) => void;
    }

    let {
        value = $bindable(''),
        placeholder = 'No section (top level)',
        sections = [],
        onChange,
    }: Props = $props();

    const popupId = `nav-section-dropdown-${Math.random().toString(36).substring(2, 9)}`;
    const listboxId = `${popupId}-listbox`;
    const popupSettings: PopupSettings = {
        event: 'click',
        target: popupId,
        placement: 'bottom',
    };

    // Flat ordered list: empty-value option first, then sections
    let allOptionValues = $derived(['', ...sections.map((s) => s.id)]);

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
        return `${popupId}-opt-${optionValue.replace(/[^a-zA-Z0-9]/g, '_') || 'empty'}`;
    }

    function getSelectedLabel(): string {
        if (!value) return placeholder;
        const match = sections.find((section) => section.id === value);
        return match?.label ?? placeholder;
    }

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
            activeIndex = 0;
            focusOption(0);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const prev = allOptionValues.length - 1;
            activeIndex = prev;
            focusOption(prev);
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
            {#if value}
                {@const selectedSection = sections.find((section) => section.id === value)}
                {#if selectedSection?.icon && navigationIconMap[selectedSection.icon]}
                    <Icon src={navigationIconMap[selectedSection.icon]} class="w-4 h-4 shrink-0" />
                {:else}
                    <span class="w-4 h-4 shrink-0"></span>
                {/if}
            {:else}
                <span class="w-4 h-4 shrink-0"></span>
            {/if}
            <span class="truncate">{getSelectedLabel()}</span>
        </span>
        <Icon src={ChevronDown} class="w-4 h-4 text-surface-400 shrink-0" />
    </button>

    <div
        bind:this={popupEl}
        id={listboxId}
        class="dropdown-popup w-full max-h-80 overflow-auto bg-surface-800 border border-surface-600 rounded-lg shadow-xl"
        style="z-index: {Z.NAV_POPUP}"
        data-popup={popupId}
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

        {#if sections.length > 0}
            <div class="border-t border-surface-700">
                {#each sections as section, i (section.id)}
                    <button
                        type="button"
                        id={optionId(section.id)}
                        data-option-index={1 + i}
                        class="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-surface-700 transition-colors"
                        class:bg-surface-700={value === section.id}
                        role="option"
                        aria-selected={value === section.id}
                        onclick={() => selectOption(section.id)}>
                        {#if section.icon && navigationIconMap[section.icon]}
                            <Icon src={navigationIconMap[section.icon]} class="w-4 h-4 shrink-0" />
                        {:else}
                            <span class="w-4 h-4"></span>
                        {/if}
                        <span class="truncate">{section.label}</span>
                    </button>
                {/each}
            </div>
        {/if}
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
