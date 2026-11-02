<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, type IconSource } from 'svelte-hero-icons';

    interface Props {
        variant?: 'primary' | 'secondary' | 'danger' | 'success' | 'warning';
        loading?: boolean;
        disabled?: boolean;
        icon?: IconSource | null;
        loadingIcon?: IconSource | null;
        loadingText?: string | null;
        size?: 'sm' | 'md' | 'lg';
        fullWidth?: boolean;
        children?: import('svelte').Snippet;
        onclick?: (event: MouseEvent) => void;
    }

    let {
        variant = 'primary',
        loading = false,
        disabled = false,
        icon = null,
        loadingIcon = null,
        loadingText = null,
        size = 'md',
        fullWidth = false,
        children,
        onclick,
    }: Props = $props();

    // Map to Tailwind variant classes (using the established btn + variant system)
    const variantMap = {
        primary: 'variant-filled-primary',
        secondary: 'variant-filled-surface',
        danger: 'variant-filled-error',
        success: 'variant-filled-success',
        warning: 'variant-filled-warning',
    };

    const sizeMap = {
        sm: 'btn-sm',
        md: '',
        lg: 'btn-lg',
    };

    let buttonClass = $derived(
        `btn ${variantMap[variant]} ${sizeMap[size]} ${fullWidth ? 'w-full' : ''}`,
    );
</script>

<button type="button" class={buttonClass} disabled={disabled || loading} {onclick}>
    {#if loading}
        {#if loadingIcon}
            <Icon src={loadingIcon} class="w-3 h-3 animate-spin" />
        {:else}
            <span class="loading-spinner loading-spinner-sm"></span>
        {/if}
        {loadingText || 'Loading...'}
    {:else}
        {#if icon}
            <Icon src={icon} class="w-3 h-3" />
        {/if}
        {@render children?.()}
    {/if}
</button>
