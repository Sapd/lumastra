<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    interface Props {
        /**
         * ProgressRadial - Indeterminate circular loading spinner
         * Replacement for Skeleton's ProgressRadial component
         */
        width?: string; // Tailwind width class (w-4, w-8, w-12, etc.)
        stroke?: string; // Tailwind stroke color
        trackStroke?: string; // Background track color
        strokeWidth?: number; // SVG stroke width
    }

    let {
        width = 'w-8',
        stroke = 'stroke-primary-500',
        trackStroke = 'stroke-surface-500/30',
        strokeWidth = 4,
    }: Props = $props();
</script>

<div
    class="progress-radial inline-flex items-center justify-center {width}"
    role="status"
    aria-label={m.loading_default()}>
    <svg class="animate-spin {width}" viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg">
        <!-- Background track (optional) -->
        <circle class={trackStroke} cx="25" cy="25" r="20" fill="none" stroke-width={strokeWidth} />

        <!-- Spinning arc -->
        <circle
            class={stroke}
            cx="25"
            cy="25"
            r="20"
            fill="none"
            stroke-width={strokeWidth}
            stroke-linecap="round"
            stroke-dasharray="80, 200"
            stroke-dashoffset="0">
            <animate
                attributeName="stroke-dashoffset"
                values="0;-150"
                dur="1.5s"
                repeatCount="indefinite" />
            <animate
                attributeName="stroke-dasharray"
                values="1, 200;80, 200;1, 200"
                dur="1.5s"
                repeatCount="indefinite" />
        </circle>
    </svg>
</div>

<style>
    .progress-radial {
        /* Ensure square aspect ratio */
        aspect-ratio: 1;
    }

    svg {
        /* Height matches width via Tailwind */
        height: 100%;
    }

    /* Material Design inspired spinner animation */
    @keyframes rotate {
        100% {
            transform: rotate(360deg);
        }
    }
</style>
