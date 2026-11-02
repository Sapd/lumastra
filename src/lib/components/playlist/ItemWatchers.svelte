<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { ItemWatcher } from '$lib/types/playlist';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import { displayName } from '$lib/utils/data-extraction';
    import { getAvatarUrl } from '$lib/utils/image-utils';

    interface Props {
        /**
         * Shows small stacked avatars of users who watched a playlist item
         * Appears on each item row to show social proof
         */
        watchers?: ItemWatcher[];
        currentUser?: string | null;
        maxDisplay?: number;
        size?: number;
    }

    let { watchers = [], currentUser = null, maxDisplay = 3, size = 20 }: Props = $props();

    // Filter out current user (they see their own checkbox)
    let otherWatchers = $derived(watchers.filter((w) => w.userId !== currentUser));
    let displayWatchers = $derived(otherWatchers.slice(0, maxDisplay));
    let remainingCount = $derived(otherWatchers.length - displayWatchers.length);

    // Tooltip text for overflow indicator
    let overflowTooltipText = $derived(
        `${otherWatchers
            .slice(maxDisplay)
            .map((w) => displayName(w.userId))
            .join(', ')} haben das geschaut`,
    );

    // Handle image load error
    function handleImageError(event: Event) {
        const img = event.target as HTMLImageElement;
        if (img) img.style.display = 'none';
    }
</script>

{#if otherWatchers.length > 0}
    <div class="flex -space-x-1.5">
        {#each displayWatchers as watcher, i (watcher.userId + '-' + i)}
            <div style="z-index: {displayWatchers.length - i};">
                <Tooltip text="{displayName(watcher.userId)} hat das geschaut" position="top" fixed>
                    <div
                        class="rounded-full overflow-hidden bg-surface-700 border border-surface-800
                               center transition-transform hover:scale-110 cursor-default"
                        style="width: {size}px; height: {size}px;">
                        <img
                            src={getAvatarUrl(watcher.userId, { width: size * 2 })}
                            alt={watcher.userId}
                            class="w-full h-full object-cover absolute inset-0"
                            onerror={handleImageError} />
                        <span
                            class="text-surface-400 font-medium"
                            style="font-size: {Math.max(8, size / 2.5)}px;">
                            {watcher.userId.slice(0, 1).toUpperCase()}
                        </span>
                    </div>
                </Tooltip>
            </div>
        {/each}

        {#if remainingCount > 0}
            <div style="z-index: 0;">
                <Tooltip text={overflowTooltipText} position="top" fixed>
                    <div
                        class="rounded-full bg-surface-600 border border-surface-800
                               center text-surface-300 hover:scale-110 transition-transform cursor-default"
                        style="width: {size}px; height: {size}px; font-size: {Math.max(
                            8,
                            size / 2.5,
                        )}px;">
                        +{remainingCount}
                    </div>
                </Tooltip>
            </div>
        {/if}
    </div>
{/if}
