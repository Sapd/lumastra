<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, ArrowUp, ArrowDown, type IconSource } from 'svelte-hero-icons';

    // Additional classes
    interface Props {
        // Card title
        title: string;
        // Main value to display
        value: string | number;
        // Optional subtitle/description
        subtitle?: string;
        // Optional icon
        icon?: IconSource | null;
        // Icon styling
        iconBg?: string;
        iconColor?: string;
        // Optional trend indicator
        trend?: { value: number; direction: 'up' | 'down' } | null | undefined;
        // Card variant
        variant?: 'default' | 'gradient' | 'glass' | 'bordered';
        // Size
        size?: 'sm' | 'md' | 'lg';
        class?: string;
        footer?: import('svelte').Snippet;
    }

    let {
        title,
        value,
        subtitle = '',
        icon,
        iconBg = 'bg-primary-500/20',
        iconColor = 'text-primary-400',
        trend,
        variant = 'default',
        size = 'md',
        class: className = '',
        footer,
    }: Props = $props();

    // Variant classes
    const variantClasses: Record<typeof variant, string> = {
        default: 'bg-surface-800',
        gradient: 'bg-gradient-to-br from-surface-800 to-surface-900',
        glass: 'bg-surface-800/50 backdrop-blur-sm',
        bordered: 'bg-surface-800 border border-surface-700',
    };

    // Size classes
    const paddingClasses: Record<typeof size, string> = {
        sm: 'p-3',
        md: 'p-4',
        lg: 'p-6',
    };

    const valueSizeClasses: Record<typeof size, string> = {
        sm: 'text-xl',
        md: 'text-2xl',
        lg: 'text-3xl',
    };

    const iconSizeClasses: Record<typeof size, string> = {
        sm: 'w-4 h-4',
        md: 'w-5 h-5',
        lg: 'w-6 h-6',
    };

    const iconWrapperSizeClasses: Record<typeof size, string> = {
        sm: 'p-1.5',
        md: 'p-2',
        lg: 'p-3',
    };

    // Trend colors
    let trendColor = $derived(trend?.direction === 'up' ? 'text-green-400' : 'text-red-400');
    let TrendIcon = $derived(trend?.direction === 'up' ? ArrowUp : ArrowDown);

    let cardClasses = $derived(
        ['stat-card rounded-lg', variantClasses[variant], paddingClasses[size], className]
            .filter(Boolean)
            .join(' '),
    );
</script>

<div class={cardClasses}>
    <!-- Header with icon and title -->
    <div class="flex items-center gap-3 mb-3">
        {#if icon}
            <div class="{iconWrapperSizeClasses[size]} rounded-lg {iconBg}">
                <Icon src={icon} class="{iconSizeClasses[size]} {iconColor}" />
            </div>
        {/if}

        <span class="text-sm font-medium text-surface-400">{title}</span>
    </div>

    <!-- Value -->
    <div class="flex items-baseline gap-2">
        <span class="font-bold text-white {valueSizeClasses[size]}">
            {typeof value === 'number' ? value.toLocaleString() : value}
        </span>

        {#if trend}
            <span class="flex items-center gap-0.5 text-sm {trendColor}">
                <Icon src={TrendIcon} class="w-3 h-3" />
                <span>{Math.abs(trend.value)}%</span>
            </span>
        {/if}
    </div>

    <!-- Subtitle -->
    {#if subtitle}
        <p class="text-sm text-surface-500 mt-1">{subtitle}</p>
    {/if}

    <!-- Footer slot -->
    {#if footer}
        <div class="mt-3 pt-3 border-t border-surface-700">
            {@render footer?.()}
        </div>
    {/if}
</div>
