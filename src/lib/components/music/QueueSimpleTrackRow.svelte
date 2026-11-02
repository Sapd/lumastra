<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onDestroy } from 'svelte';
    import type { MusicTrack } from '$lib/schemas/music';
    import {
        Icon,
        ChevronDoubleRight,
        Plus,
        Check,
    } from 'svelte-hero-icons';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        track: MusicTrack;
        /** Return false to suppress the transient ✓ (e.g. store dedupe no-op). */
        onactivate: () => boolean | void;
        /** Return false to suppress the transient ✓ (e.g. store dedupe no-op). */
        onadd?: () => boolean | void;
        onplaynext?: () => void;
        /** Accessible label for the row's own activate action. */
        activateLabel?: string;
        /**
         * When the row click itself enqueues (rather than playing), flash the
         * same transient check as the + button so the tap visibly did
         * something.
         */
        feedbackOnActivate?: boolean;
    }

    let {
        track,
        onactivate,
        onadd,
        onplaynext,
        activateLabel,
        feedbackOnActivate = false,
    }: Props = $props();

    // Transient confirmation shown on the + icon right after `onadd` fires.
    let justAdded = $state(false);
    let addedTimeout: ReturnType<typeof setTimeout> | undefined;

    onDestroy(() => {
        clearTimeout(addedTimeout);
    });

    function flashAdded(): void {
        justAdded = true;
        clearTimeout(addedTimeout);
        addedTimeout = setTimeout(() => {
            justAdded = false;
        }, 1500);
    }

    function handleActivate(): void {
        const added = onactivate();
        if (feedbackOnActivate && added !== false) flashAdded();
    }

    function handleAdd(e: MouseEvent): void {
        e.stopPropagation();
        const added = onadd?.();
        if (added !== false) flashAdded();
    }

    function handlePlayNext(e: MouseEvent): void {
        e.stopPropagation();
        onplaynext?.();
    }
</script>

<div
    class="flex min-h-[44px] w-full items-center gap-3 rounded-lg px-1 text-left transition-colors hover:bg-surface-800"
    role="button"
    tabindex="0"
    onclick={handleActivate}
    onkeydown={(e) => {
        // Only act on keys targeting the row itself — Enter/Space on the
        // nested +/play-next buttons must activate those, not the row.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleActivate();
        }
    }}
    aria-label={activateLabel}>
    {#if track.images?.primary?.variants?.thumb}
        <img
            src={track.images.primary?.variants?.thumb}
            alt=""
            class="h-10 w-10 shrink-0 rounded md:h-12 md:w-12" />
    {:else}
        <div
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-surface-700 md:h-12 md:w-12">
            <span class="text-lg text-surface-500">♪</span>
        </div>
    {/if}
    <div class="min-w-0 flex-1">
        <p class="truncate text-sm text-white">{track.title}</p>
        <p class="truncate text-xs text-surface-400">{track.artists.map((a) => a.title).join(', ')}</p>
    </div>

    <div class="flex shrink-0 items-center gap-1">
        {#if onplaynext}
            <Tooltip text={m.music_queue_play_next()} position="left">
                <button
                    type="button"
                    class="min-h-[44px] min-w-[44px] rounded p-2 text-surface-400 transition-colors hover:bg-surface-700 hover:text-white"
                    onclick={handlePlayNext}
                    aria-label={m.music_queue_play_next()}>
                    <Icon src={ChevronDoubleRight} class="h-4 w-4" />
                </button>
            </Tooltip>
        {/if}
        {#if onadd}
            <Tooltip text={m.card_music_add_to_queue()} position="left">
                <button
                    type="button"
                    class="min-h-[44px] min-w-[44px] rounded p-2 transition-colors {justAdded
                        ? 'text-primary-400'
                        : 'text-surface-400 hover:bg-surface-700 hover:text-white'}"
                    onclick={handleAdd}
                    aria-label={m.card_music_add_to_queue()}>
                    {#if justAdded}
                        <Icon src={Check} class="h-4 w-4" />
                    {:else}
                        <Icon src={Plus} class="h-4 w-4" />
                    {/if}
                </button>
            </Tooltip>
        {/if}
    </div>
</div>
