<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, ChevronDown } from 'svelte-hero-icons';

    // Options - can be simple strings or objects
    type Option = string | { value: string | number; label: string; disabled?: boolean };

    // Additional classes
    interface Props {
        // Value binding
        value?: string | number | undefined;
        options?: Option[];
        // Optional label
        label?: string;
        // Placeholder for empty state
        placeholder?: string;
        // States
        disabled?: boolean;
        required?: boolean;
        error?: string;
        // Size
        size?: 'sm' | 'md' | 'lg';
        // Name attribute for forms
        name?: string;
        class?: string;
        onchange?: (detail: { value: string | number | undefined }) => void;
        onfocus?: (event: FocusEvent) => void;
        onblur?: (event: FocusEvent) => void;
        [key: string]: unknown;
    }

    let {
        value = $bindable(undefined),
        options = [],
        label = '',
        placeholder = 'Select...',
        disabled = false,
        required = false,
        error = '',
        size = 'md',
        name = '',
        class: className = '',
        onchange,
        onfocus,
        onblur,
        ...rest
    }: Props = $props();

    // Normalize options to objects
    let normalizedOptions = $derived(
        options.map((opt) => (typeof opt === 'string' ? { value: opt, label: opt } : opt)),
    );

    let selectId = $derived(
        name || (label ? `select-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined),
    );

    // Size classes
    const sizeClasses: Record<typeof size, string> = {
        sm: 'px-2 py-1.5 text-sm pr-7',
        md: 'px-3 py-2 pr-8',
        lg: 'px-4 py-3 text-lg pr-10',
    };

    const iconSizeClasses: Record<typeof size, string> = {
        sm: 'w-3 h-3 right-2',
        md: 'w-4 h-4 right-2',
        lg: 'w-5 h-5 right-3',
    };

    let selectClasses = $derived(
        [
            'select appearance-none cursor-pointer',
            sizeClasses[size],
            error ? 'select-error' : '',
            disabled ? 'opacity-50 cursor-not-allowed' : '',
            className,
        ]
            .filter(Boolean)
            .join(' '),
    );

    function handleChange(event: Event) {
        const target = event.target as HTMLSelectElement;
        // Convert to number if the original value was a number
        const newValue =
            typeof options[0] === 'object' &&
            typeof (options[0] as { value: string | number }).value === 'number'
                ? Number(target.value)
                : target.value;

        value = newValue || undefined;
        onchange?.({ value });
    }
</script>

<div class="select-wrapper">
    {#if label}
        <label for={selectId} class="block text-sm font-medium text-surface-200 mb-1">
            {label}
            {#if required}
                <span class="text-red-400">*</span>
            {/if}
        </label>
    {/if}

    <div class="relative">
        <select
            id={selectId}
            {name}
            {disabled}
            {required}
            class={selectClasses}
            onchange={handleChange}
            {onblur}
            {onfocus}
            {...rest}>
            {#if placeholder}
                <option value="" disabled selected={value === undefined}>
                    {placeholder}
                </option>
            {/if}

            {#each normalizedOptions as option (option.value)}
                <option
                    value={option.value}
                    disabled={option.disabled}
                    selected={value === option.value}>
                    {option.label}
                </option>
            {/each}
        </select>

        <!-- Custom dropdown arrow -->
        <div
            class="absolute top-1/2 -translate-y-1/2 pointer-events-none text-surface-400 {iconSizeClasses[
                size
            ]}">
            <Icon src={ChevronDown} class="w-full h-full" />
        </div>
    </div>

    {#if error}
        <p class="mt-1 text-sm text-red-400">{error}</p>
    {/if}
</div>

<style>
    /* Hide default browser dropdown arrow */
    select {
        -webkit-appearance: none;
        -moz-appearance: none;
        appearance: none;
    }

    select::-ms-expand {
        display: none;
    }
</style>
