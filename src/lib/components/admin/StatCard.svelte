<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, QuestionMarkCircle, type IconSource } from 'svelte-hero-icons';
    import Card from '$lib/components/ui/Card.svelte';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import {
        getIconBgColor,
        getIconTextColor,
        getValueColor,
        type MetricColor,
    } from '$lib/utils/metric-styles';
    import type { Snippet } from 'svelte';

    interface ValueSnippetArg {
        valueColor: string;
    }

    type CardVariant = 'gradient' | 'glass' | 'none';

    interface Props {
        /** Icon component to display */
        icon: IconSource;
        /** Card title */
        title: string;
        /** Color scheme (MetricColor palette) */
        color?: MetricColor;
        /** Raw icon color class — overrides color-derived icon color */
        iconColor?: string;
        /** Simple string/number value — used when no value snippet provided */
        value?: string | number;
        /** Color class for the simple value text */
        valueColor?: string;
        /** Secondary label below the value */
        subtitle?: string;
        /** Tooltip text shown next to the title */
        tooltip?: string;
        /** Percentage shown as caption below the value */
        percentage?: number;
        /** Whether the metric is healthy (true=green, false=red, null=use color) */
        healthy?: boolean | null;
        /** Loading state — shows placeholder instead of value snippet */
        loading?: boolean;
        /** Card visual variant */
        variant?: CardVariant;
        /** Value snippet (receives { valueColor }) */
        value_snippet?: Snippet<[ValueSnippetArg]>;
        /** Progress bar snippet */
        progress?: Snippet;
        /** Details / extra content snippet */
        details?: Snippet;
        /** Generic children snippet (appended after value) */
        children?: Snippet;
    }

    let {
        icon,
        title,
        color,
        iconColor,
        value,
        valueColor,
        subtitle,
        tooltip,
        percentage,
        healthy = null,
        loading = false,
        variant = 'gradient',
        value_snippet,
        progress,
        details,
        children,
    }: Props = $props();

    // Resolve effective colors. healthy overrides color-derived colors.
    let effectiveIconColor = $derived.by(() => {
        if (iconColor) return iconColor;
        if (healthy !== null) return healthy ? 'text-green-400' : 'text-red-400';
        if (color) return getIconTextColor(color);
        return 'text-blue-400';
    });

    let effectiveValueColor = $derived.by(() => {
        if (valueColor) return valueColor;
        if (healthy !== null) return healthy ? 'text-green-400' : 'text-red-400';
        if (color) return getValueColor(color);
        return 'text-white';
    });

    let iconBgColor = $derived(color ? getIconBgColor(color) : '');
</script>

{#if variant === 'none'}
    <div class="bg-surface-800/50 border border-surface-700 rounded-xl p-4">
        <div class="text-muted mb-2">{title}</div>
        {#if loading}
            <p class="text-surface-500">Loading...</p>
        {:else if value_snippet}
            {@render value_snippet({ valueColor: effectiveValueColor })}
        {:else if value !== undefined}
            <div class="text-2xl font-bold {effectiveValueColor}">{value}</div>
        {/if}
        {#if percentage !== undefined}
            <div class="text-caption mt-1">{percentage.toFixed(1)}%</div>
        {/if}
        {#if subtitle}
            <div class="text-caption mt-1">{subtitle}</div>
        {/if}
        {@render children?.()}
        {@render details?.()}
    </div>
{:else}
    <Card variant={variant as 'gradient' | 'glass'} padding="lg" rounded="xl">
        <!-- Header: Icon + Title -->
        <div class="flex items-center gap-3 {color ? 'mb-3' : 'mb-2'}">
            {#if color}
                <div class="p-2 {iconBgColor} rounded-lg">
                    <Icon src={icon} class="w-5 h-5 {effectiveIconColor}" />
                </div>
            {:else}
                <Icon src={icon} class="w-6 h-6 {effectiveIconColor}" />
            {/if}
            <div>
                <h3
                    class={color
                        ? 'text-muted font-medium'
                        : variant === 'glass'
                          ? 'text-muted'
                          : 'text-lg font-semibold text-white'}>
                    {title}
                </h3>
            </div>
            {#if tooltip}
                <Tooltip text={tooltip} position="bottom">
                    <span class="cursor-help ml-auto">
                        <Icon
                            src={QuestionMarkCircle}
                            class="w-4 h-4 text-surface-500 hover:text-surface-300" />
                    </span>
                </Tooltip>
            {/if}
        </div>

        <!-- Value -->
        {#if loading}
            <p class="text-surface-500">Loading...</p>
        {:else if value_snippet}
            {@render value_snippet({ valueColor: effectiveValueColor })}
        {:else if value !== undefined}
            <p
                class="{color || variant === 'glass'
                    ? 'text-3xl'
                    : 'text-2xl'} font-bold {effectiveValueColor}">
                {value}
            </p>
        {/if}

        {#if percentage !== undefined}
            <div class="text-caption mt-1">{percentage.toFixed(1)}%</div>
        {/if}

        {#if subtitle}
            <div class="text-caption mt-1">{subtitle}</div>
        {/if}

        <!-- Progress bar snippet -->
        {@render progress?.()}

        <!-- Details snippet -->
        {@render details?.()}

        <!-- Children snippet -->
        {@render children?.()}
    </Card>
{/if}
