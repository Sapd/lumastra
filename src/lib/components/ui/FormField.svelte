<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    // Additional classes for the wrapper
    interface Props {
        // Label
        label?: string;
        // Input name/id
        name?: string;
        // Input type
        type?: 'text' | 'email' | 'password' | 'number' | 'url' | 'tel' | 'textarea';
        // Value binding
        value?: string | number;
        // Placeholder
        placeholder?: string;
        // States
        required?: boolean;
        disabled?: boolean;
        readonly?: boolean;
        // Validation
        error?: string;
        helpText?: string;
        // Size
        size?: 'sm' | 'md' | 'lg';
        // Textarea rows
        rows?: number;
        // Number input constraints
        min?: number | undefined;
        max?: number | undefined;
        step?: number | undefined;
        class?: string;
        prefix?: import('svelte').Snippet;
        suffix?: import('svelte').Snippet;
        oninput?: (detail: { value: string | number }) => void;
        onchange?: (detail: { value: string | number }) => void;
        onblur?: () => void;
        onfocus?: () => void;
        [key: string]: unknown;
    }

    let {
        label = '',
        name = '',
        type = 'text',
        value = $bindable(''),
        placeholder = '',
        required = false,
        disabled = false,
        readonly = false,
        error = '',
        helpText = '',
        size = 'md',
        rows = 3,
        min = undefined,
        max = undefined,
        step = undefined,
        class: className = '',
        prefix,
        suffix,
        oninput,
        onchange,
        onblur,
        onfocus,
        ...rest
    }: Props = $props();

    // Size classes
    const inputSizeClasses: Record<typeof size, string> = {
        sm: 'input-sm',
        md: '',
        lg: 'px-4 py-3 text-lg',
    };

    const labelSizeClasses: Record<typeof size, string> = {
        sm: 'text-xs',
        md: 'text-sm',
        lg: 'text-base',
    };

    let inputClasses = $derived(
        [
            type === 'textarea' ? 'textarea' : 'input',
            inputSizeClasses[size],
            error ? (type === 'textarea' ? 'textarea-error' : 'input-error') : '',
            prefix ? 'pl-10' : '',
            suffix ? 'pr-10' : '',
        ]
            .filter(Boolean)
            .join(' '),
    );

    function handleInput(event: Event) {
        const target = event.target as HTMLInputElement | HTMLTextAreaElement;
        value = type === 'number' ? Number(target.value) : target.value;
        oninput?.({ value });
    }

    function handleChange(event: Event) {
        const target = event.target as HTMLInputElement | HTMLTextAreaElement;
        value = type === 'number' ? Number(target.value) : target.value;
        onchange?.({ value });
    }
</script>

<div class="form-field {className}">
    {#if label}
        <label
            for={name || undefined}
            class="block font-medium text-surface-200 mb-1.5 {labelSizeClasses[size]}">
            {label}
            {#if required}
                <span class="text-red-400 ml-0.5">*</span>
            {/if}
        </label>
    {/if}

    <div class="relative">
        {#if prefix}
            <div
                class="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400 pointer-events-none">
                {@render prefix?.()}
            </div>
        {/if}

        {#if type === 'textarea'}
            <textarea
                id={name || undefined}
                {name}
                {placeholder}
                {disabled}
                {readonly}
                {required}
                {rows}
                class={inputClasses}
                oninput={handleInput}
                onchange={handleChange}
                onblur={() => onblur?.()}
                onfocus={() => onfocus?.()}
                {...rest}>{value}</textarea>
        {:else}
            <input
                id={name || undefined}
                {name}
                {type}
                {placeholder}
                {disabled}
                {readonly}
                {required}
                {min}
                {max}
                {step}
                {value}
                class={inputClasses}
                oninput={handleInput}
                onchange={handleChange}
                onblur={() => onblur?.()}
                onfocus={() => onfocus?.()}
                {...rest} />
        {/if}

        {#if suffix}
            <div class="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400">
                {@render suffix?.()}
            </div>
        {/if}
    </div>

    {#if error}
        <p class="mt-1 text-sm text-red-400">{error}</p>
    {:else if helpText}
        <p class="mt-1 text-sm text-surface-500">{helpText}</p>
    {/if}
</div>
