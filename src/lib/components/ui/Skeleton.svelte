<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    interface Props {
        class?: string;
        rounded?: 'none' | 'sm' | 'md' | 'lg' | 'full';
        width?: string;
        height?: string;
        shimmer?: boolean;
    }

    let {
        class: className = '',
        rounded = 'md',
        width = 'w-full',
        height = 'h-4',
        shimmer = true,
    }: Props = $props();

    const roundedClass = $derived(
        {
            none: '',
            sm: 'rounded-sm',
            md: 'rounded',
            lg: 'rounded-lg',
            full: 'rounded-full',
        }[rounded],
    );
</script>

<div
    class="bg-surface-800 skeleton-bar relative overflow-hidden {roundedClass} {width} {height} {className}">
    {#if shimmer}
        <div aria-hidden="true" class="shimmer absolute inset-0"></div>
    {/if}
</div>

<style>
    .shimmer {
        /* 0.09 (was 0.05): at 5% the sweep is invisible on bg-surface-800 in
           practice, so loading shelves read as flat gray "broken" boxes
           instead of "loading". Keep it subtle, but perceptible. */
        background: linear-gradient(
            90deg,
            transparent 0%,
            rgba(255, 255, 255, 0.09) 50%,
            transparent 100%
        );
        animation: shimmer 1.4s ease-in-out infinite;
    }

    @keyframes shimmer {
        0% {
            transform: translateX(-100%);
        }
        100% {
            transform: translateX(100%);
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .shimmer {
            animation: none;
        }
    }
</style>
