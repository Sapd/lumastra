<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    // Additional classes
    interface Props {
        // Progress value (0-100 by default)
        value?: number;
        // Maximum value
        max?: number;
        // Show percentage label
        showLabel?: boolean;
        // Label position
        labelPosition?: 'inside' | 'right' | 'above';
        // Color variant
        color?: 'primary' | 'success' | 'warning' | 'error' | 'info' | 'purple' | 'cyan';
        // Size
        size?: 'xs' | 'sm' | 'md' | 'lg';
        // Striped animation
        striped?: boolean;
        // Animated stripes
        animated?: boolean;
        // Indeterminate (loading) mode
        indeterminate?: boolean;
        class?: string;
        label?: import('svelte').Snippet;
    }

    let {
        value = 0,
        max = 100,
        showLabel = false,
        labelPosition = 'right',
        color = 'primary',
        size = 'md',
        striped = false,
        animated = false,
        indeterminate = false,
        class: className = '',
        label,
    }: Props = $props();

    // Calculate percentage
    let percentage = $derived(Math.min(100, Math.max(0, (value / max) * 100)));
    let percentageText = $derived(`${Math.round(percentage)}%`);

    // Size classes
    const sizeClasses: Record<typeof size, string> = {
        xs: 'h-1',
        sm: 'h-2',
        md: 'h-3',
        lg: 'h-4',
    };

    // Color classes for the bar
    const colorClasses: Record<typeof color, string> = {
        primary: 'bg-primary-500',
        success: 'bg-green-500',
        warning: 'bg-yellow-500',
        error: 'bg-red-500',
        info: 'bg-blue-500',
        purple: 'bg-purple-500',
        cyan: 'bg-cyan-500',
    };

    // Track color (always subtle)
    const trackClass = 'bg-surface-700';
</script>

<div class="progress-bar-wrapper {className}">
    {#if showLabel && labelPosition === 'above'}
        <div class="flex justify-between mb-1 text-sm">
            {@render label?.()}
            <span class="text-surface-400">{percentageText}</span>
        </div>
    {/if}

    <div class="flex items-center gap-2">
        <div
            class="progress-track relative flex-1 rounded-full overflow-hidden {trackClass} {sizeClasses[
                size
            ]}"
            role="progressbar"
            aria-valuenow={value}
            aria-valuemin={0}
            aria-valuemax={max}>
            <div
                class="progress-bar h-full rounded-full transition-all duration-300 ease-out {colorClasses[
                    color
                ]}"
                class:striped
                class:animated={animated && striped}
                class:indeterminate
                style={indeterminate ? '' : `width: ${percentage}%`}>
                {#if showLabel && labelPosition === 'inside' && size !== 'xs' && size !== 'sm'}
                    <span
                        class="absolute inset-0 flex items-center justify-center text-xs font-medium text-white">
                        {percentageText}
                    </span>
                {/if}
            </div>
        </div>

        {#if showLabel && labelPosition === 'right'}
            <span class="text-sm text-surface-400 min-w-[3ch] text-right">
                {percentageText}
            </span>
        {/if}
    </div>
</div>

<style>
    .striped {
        background-image: linear-gradient(
            45deg,
            rgba(255, 255, 255, 0.15) 25%,
            transparent 25%,
            transparent 50%,
            rgba(255, 255, 255, 0.15) 50%,
            rgba(255, 255, 255, 0.15) 75%,
            transparent 75%,
            transparent
        );
        background-size: 1rem 1rem;
    }

    .animated {
        animation: progress-bar-stripes 1s linear infinite;
    }

    @keyframes progress-bar-stripes {
        from {
            background-position: 1rem 0;
        }
        to {
            background-position: 0 0;
        }
    }

    .indeterminate {
        width: 30%;
        animation: indeterminate 1.5s infinite ease-in-out;
    }

    @keyframes indeterminate {
        0% {
            transform: translateX(-100%);
        }
        100% {
            transform: translateX(400%);
        }
    }
</style>
