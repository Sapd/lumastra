<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, type IconSource } from 'svelte-hero-icons';

    // Additional classes
    interface Props {
        // Title text
        title: string;
        // Optional subtitle
        subtitle?: string;
        // Optional icon
        icon?: IconSource | null;
        // Icon background color
        iconBg?: string;
        iconColor?: string;
        // Heading level (1-6)
        level?: 1 | 2 | 3 | 4 | 5 | 6;
        // Size variant
        size?: 'sm' | 'md' | 'lg';
        // Show bottom border
        bordered?: boolean;
        class?: string;
        actions?: import('svelte').Snippet;
    }

    let {
        title,
        subtitle = '',
        icon,
        iconBg = 'bg-primary-500/20',
        iconColor = 'text-primary-400',
        level = 2,
        size = 'md',
        bordered = false,
        class: className = '',
        actions,
    }: Props = $props();

    // Size classes
    const titleSizeClasses: Record<typeof size, string> = {
        sm: 'text-lg',
        md: 'text-xl',
        lg: 'text-2xl',
    };

    const iconSizeClasses: Record<typeof size, string> = {
        sm: 'w-4 h-4',
        md: 'w-5 h-5',
        lg: 'w-6 h-6',
    };

    const iconWrapperSizeClasses: Record<typeof size, string> = {
        sm: 'p-1.5',
        md: 'p-2',
        lg: 'p-2.5',
    };

    let wrapperClasses = $derived(
        [
            'section-header flex items-center justify-between gap-4',
            bordered ? 'pb-4 border-b border-surface-700' : '',
            className,
        ]
            .filter(Boolean)
            .join(' '),
    );
</script>

<div class={wrapperClasses}>
    <div class="flex items-center gap-3">
        {#if icon}
            <div class="{iconWrapperSizeClasses[size]} rounded-lg {iconBg}">
                <Icon src={icon} class="{iconSizeClasses[size]} {iconColor}" />
            </div>
        {/if}

        <div>
            <svelte:element
                this={`h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'}
                class="tracking-tight font-semibold text-white {titleSizeClasses[size]}">
                {title}
            </svelte:element>

            {#if subtitle}
                <p class="text-sm text-surface-400 mt-0.5">{subtitle}</p>
            {/if}
        </div>
    </div>

    {#if actions}
        <div class="flex items-center gap-2">
            {@render actions?.()}
        </div>
    {/if}
</div>
