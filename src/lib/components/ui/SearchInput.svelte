<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onDestroy } from 'svelte';
    import { Icon, MagnifyingGlass, XCircle } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';

    // Additional classes
    interface Props {
        // Value binding
        value?: string;
        // Placeholder text
        placeholder?: string;
        // Show search icon
        showIcon?: boolean;
        // Show clear button when has value
        clearable?: boolean;
        // Loading state
        loading?: boolean;
        // Debounce delay in ms (0 = no debounce)
        debounce?: number;
        // Size
        size?: 'sm' | 'md' | 'lg';
        // Autofocus
        autofocus?: boolean;
        // Name attribute
        name?: string;
        // Reference to input element
        inputElement?: HTMLInputElement | undefined;
        class?: string;
        oninput?: (detail: { value: string }) => void;
        onchange?: (detail: { value: string }) => void;
        onclear?: () => void;
        onsubmit?: (detail: { value: string }) => void;
        onfocus?: (event: FocusEvent) => void;
        onblur?: (event: FocusEvent) => void;
        [key: string]: unknown;
    }

    let {
        value = $bindable(''),
        placeholder = 'Search...',
        showIcon = true,
        clearable = true,
        loading = false,
        debounce = 0,
        size = 'md',
        autofocus = false,
        name = '',
        inputElement = $bindable(undefined),
        class: className = '',
        oninput,
        onchange,
        onclear,
        onsubmit,
        onfocus,
        onblur,
        ...rest
    }: Props = $props();

    interface SearchInputStyles {
        wrapper: string;
        input: string;
        icon: string;
    }

    type SearchInputSize = typeof size;

    // Debounce timer
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    // Size classes
    const sizeClasses: Record<SearchInputSize, SearchInputStyles> = {
        sm: {
            wrapper: 'h-8',
            input: 'text-sm pl-8 pr-7',
            icon: 'w-4 h-4 left-2',
        },
        md: {
            wrapper: 'h-10',
            input: 'pl-10 pr-8',
            icon: 'w-5 h-5 left-3',
        },
        lg: {
            wrapper: 'h-12',
            input: 'text-lg pl-12 pr-10',
            icon: 'w-6 h-6 left-3',
        },
    };

    const clearButtonSizes: Record<SearchInputSize, string> = {
        sm: 'w-4 h-4 right-2',
        md: 'w-5 h-5 right-2',
        lg: 'w-6 h-6 right-3',
    };

    function handleInput(event: Event) {
        const target = event.target as HTMLInputElement;
        value = target.value;

        if (debounce > 0) {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }
            debounceTimer = setTimeout(() => {
                oninput?.({ value });
            }, debounce);
        } else {
            oninput?.({ value });
        }
    }

    function handleChange() {
        onchange?.({ value });
    }

    function handleClear() {
        value = '';
        onclear?.();
        oninput?.({ value: '' });
        inputElement?.focus();
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Enter') {
            event.preventDefault();
            onsubmit?.({ value });
        } else if (event.key === 'Escape' && value) {
            handleClear();
        }
    }

    onDestroy(() => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
    });

    function bindInput(node: HTMLInputElement) {
        inputElement = node;
        return () => {
            if (inputElement === node) {
                inputElement = undefined;
            }
        };
    }

    // Reactive class assignments
    let wrapperClass = $derived(sizeClasses[size].wrapper);
    let iconClass = $derived(sizeClasses[size].icon);
    let inputClass = $derived(sizeClasses[size].input);
</script>

<div class="search-input-wrapper relative {wrapperClass} {className}">
    {#if showIcon}
        <div
            class="absolute top-1/2 -translate-y-1/2 text-surface-400 pointer-events-none {iconClass}">
            <Icon src={MagnifyingGlass} class="w-full h-full" />
        </div>
    {/if}

    <!-- svelte-ignore a11y_autofocus -->
    <input
        {@attach bindInput}
        type="search"
        {name}
        {placeholder}
        {value}
        oninput={handleInput}
        onchange={handleChange}
        onkeydown={handleKeydown}
        {onfocus}
        {onblur}
        {autofocus}
        autocomplete="off"
        autocorrect="off"
        spellcheck="false"
        class="input w-full h-full {inputClass} {showIcon ? '' : 'pl-3'}"
        {...rest} />

    {#if loading}
        <div class="absolute top-1/2 -translate-y-1/2 {clearButtonSizes[size]}">
            <span class="loading-spinner loading-spinner-primary w-full h-full"></span>
        </div>
    {:else if clearable && value}
        <button
            type="button"
            onclick={handleClear}
            class="absolute top-1/2 -translate-y-1/2 text-surface-500 hover:text-surface-200 transition-colors {clearButtonSizes[
                size
            ]}"
            aria-label={m.btn_clear_search()}>
            <Icon src={XCircle} class="w-full h-full" solid />
        </button>
    {/if}
</div>

<style>
    /* Hide browser's default clear button */
    input[type='search']::-webkit-search-cancel-button {
        -webkit-appearance: none;
        appearance: none;
    }
</style>
