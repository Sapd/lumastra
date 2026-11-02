<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { displayName } from '$lib/utils/data-extraction';
    import { generateAvatarDataUri } from '$lib/utils/avatar-svg';
    import { getAvatarUrl } from '$lib/utils/image-utils';

    interface Props {
        /**
         * Avatar with circular progress ring
         * Shows user avatar with a progress indicator around it
         */
        userId: string;
        progress?: number; // 0-100
        size?: number;
        showTooltip?: boolean;
        watchedCount?: number;
        totalCount?: number;
    }

    let {
        userId,
        progress = 0,
        size = 40,
        showTooltip = true,
        watchedCount = 0,
        totalCount = 0,
    }: Props = $props();

    // SVG calculations
    const strokeWidth = 3;
    let radius = $derived(size / 2 - strokeWidth / 2);
    let circumference = $derived(2 * Math.PI * radius);
    let offset = $derived(circumference - (progress / 100) * circumference);

    let avatarUrl = $derived(getAvatarUrl(userId));

    // Progress color based on completion
    let progressColor = $derived(
        progress >= 100
            ? 'text-success-500'
            : progress >= 50
              ? 'text-primary-500'
              : 'text-warning-500',
    );

    // Deterministic SVG fallback
    let fallbackSrc = $derived(generateAvatarDataUri(userId));

    // Handle image load error — show SVG fallback instead
    let imageError = $state(false);
    function handleImageError() {
        imageError = true;
    }
</script>

<div class="relative group" style="width: {size}px; height: {size}px;">
    <!-- Progress ring SVG -->
    <svg class="absolute inset-0 -rotate-90 transition-transform" width={size} height={size}>
        <!-- Background ring -->
        <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            stroke-width={strokeWidth}
            class="text-surface-600/50" />
        <!-- Progress ring -->
        <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            stroke-width={strokeWidth}
            stroke-dasharray={circumference}
            stroke-dashoffset={offset}
            stroke-linecap="round"
            class="{progressColor} transition-all duration-700 ease-out" />
    </svg>

    <!-- Avatar -->
    <div
        class="absolute rounded-full overflow-hidden bg-surface-700"
        style="
            top: {strokeWidth + 1}px;
            left: {strokeWidth + 1}px;
            width: {size - (strokeWidth + 1) * 2}px;
            height: {size - (strokeWidth + 1) * 2}px;
        ">
        <!-- Avatar image or deterministic SVG fallback -->
        <img
            src={imageError ? fallbackSrc : avatarUrl}
            alt={userId}
            class="absolute inset-0 w-full h-full object-cover"
            onerror={handleImageError} />
    </div>

    <!-- Completion checkmark overlay -->
    {#if progress >= 100}
        <div
            class="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-success-500
                   center shadow-lg border-2 border-surface-900">
            <svg
                class="w-2.5 h-2.5 text-white"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="3">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
            </svg>
        </div>
    {/if}

    <!-- Tooltip -->
    {#if showTooltip}
        <div
            class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1.5
                   bg-surface-800 rounded-lg shadow-xl border border-surface-700
                   opacity-0 group-hover:opacity-100 transition-opacity duration-200
                   pointer-events-none z-50 whitespace-nowrap">
            <div class="text-xs font-medium text-surface-100">
                {displayName(userId)}
            </div>
            <div class="text-xs text-surface-400">
                {watchedCount}/{totalCount} ({progress}%)
            </div>
            <!-- Tooltip arrow -->
            <div
                class="absolute top-full left-1/2 -translate-x-1/2 -mt-px
                       border-4 border-transparent border-t-surface-800">
            </div>
        </div>
    {/if}
</div>
