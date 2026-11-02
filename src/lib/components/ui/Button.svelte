<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, type IconSource } from 'svelte-hero-icons';

    // Additional classes
    interface Props {
        // Button variants
        variant?:
            | 'primary'
            | 'secondary'
            | 'danger'
            | 'success'
            | 'warning'
            | 'ghost'
            | 'ghost-primary'
            | 'ghost-danger'
            | 'soft-primary'
            | 'soft-danger'
            | 'soft-warning'
            | 'surface';
        // Button sizes
        size?: 'xs' | 'sm' | 'md' | 'lg';
        // Button states
        disabled?: boolean;
        loading?: boolean;
        // Toggle ARIA attributes
        pressed?: boolean | undefined;
        expanded?: boolean | undefined;
        // Button type
        type?: 'button' | 'submit' | 'reset';
        // Icon support
        icon?: IconSource | null;
        iconRight?: IconSource | null;
        // Full width
        fullWidth?: boolean;
        class?: string;
        children?: import('svelte').Snippet;
        onclick?: (event: MouseEvent) => void;
        onmouseenter?: (event: MouseEvent) => void;
        onmouseleave?: (event: MouseEvent) => void;
        onfocus?: (event: FocusEvent) => void;
        onblur?: (event: FocusEvent) => void;
        [key: string]: unknown;
    }

    let {
        variant = 'primary',
        size = 'md',
        disabled = false,
        loading = false,
        pressed = undefined,
        expanded = undefined,
        type = 'button',

        icon = null,

        iconRight = null,
        fullWidth = false,
        class: className = '',
        children,
        onclick,
        onmouseenter,
        onmouseleave,
        onfocus,
        onblur,
        ...rest
    }: Props = $props();

    // Variant class mappings
    const variantClasses: Record<typeof variant, string> = {
        primary: 'btn-primary',
        secondary: 'btn-gray',
        danger: 'btn-red',
        success: 'btn-green',
        warning: 'btn-yellow',
        ghost: 'btn-ghost',
        'ghost-primary': 'btn-ghost-primary',
        'ghost-danger': 'btn-ghost-red',
        'soft-primary': 'btn-soft-blue',
        'soft-danger': 'btn-soft-red',
        'soft-warning': 'btn-soft-amber',
        surface: 'btn-surface',
    };

    // Size class mappings
    const sizeClasses: Record<typeof size, string> = {
        xs: 'px-2 py-1 text-xs',
        sm: 'btn-sm',
        md: '',
        lg: 'btn-lg',
    };

    // Icon size mappings
    const iconSizes: Record<typeof size, string> = {
        xs: 'w-3 h-3',
        sm: 'w-4 h-4',
        md: 'w-5 h-5',
        lg: 'w-6 h-6',
    };

    let buttonClasses = $derived(
        [
            'btn',
            variantClasses[variant],
            sizeClasses[size],
            fullWidth ? 'w-full' : '',
            loading ? 'opacity-70 cursor-wait' : '',
            className,
        ]
            .filter(Boolean)
            .join(' '),
    );
</script>

<button
    {type}
    disabled={disabled || loading}
    class={buttonClasses}
    aria-pressed={pressed}
    aria-expanded={expanded}
    {onclick}
    {onmouseenter}
    {onmouseleave}
    {onfocus}
    {onblur}
    {...rest}>
    {#if loading}
        <span class="loading-spinner loading-spinner-white {iconSizes[size]}"></span>
    {:else if icon}
        <Icon src={icon} class={iconSizes[size]} />
    {/if}

    {#if children}
        <span class:opacity-0={loading && !children}>
            {@render children?.()}
        </span>
    {/if}

    {#if iconRight && !loading}
        <Icon src={iconRight} class={iconSizes[size]} />
    {/if}
</button>
