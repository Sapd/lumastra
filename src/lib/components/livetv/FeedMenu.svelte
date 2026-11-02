<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  The feeds of a Live TV station (its backup group), for a viewer whose feed
  plays the provider's placeholder clip or stutters. Opened from a channel
  card's context menu (right-click / long-press) and from the player's Feed
  button. Fixed at (x, y), clamped to the viewport; Escape or a click outside
  closes it and returns focus.
-->
<script lang="ts">
    import { untrack } from 'svelte';
    import { Icon, Check } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import { getStationFeeds } from '$lib/api/livetv-playback.js';
    import type { LiveTvFeed } from '$lib/schemas/livetv.js';
    import { feedQualityLabel } from './feed-labels.js';

    interface Props {
        /** Any feed of the station; the menu lists all of them. */
        channelId: string;
        /** Station name for the heading. */
        name: string;
        /** The feed playing (player) or the one the card would play; checked. */
        currentId?: string;
        x: number;
        y: number;
        onpick: (feed: LiveTvFeed, stationId: string | undefined) => void;
        onclose: () => void;
    }

    let { channelId, name, currentId, x, y, onpick, onclose }: Props = $props();

    let feeds = $state<LiveTvFeed[] | null>(null);
    let stationId = $state<string | undefined>(undefined);
    let failed = $state(false);
    let menuEl = $state<HTMLDivElement | null>(null);
    let restoreFocusEl: HTMLElement | null = null;

    $effect(() => {
        const id = channelId;
        untrack(() => void load(id));
    });

    async function load(id: string): Promise<void> {
        feeds = null;
        failed = false;
        const result = await getStationFeeds(id);
        if (id !== channelId) return;
        if (result.error || !result.data) {
            failed = true;
            return;
        }
        stationId = result.data.stationId;
        feeds = result.data.feeds;
    }

    // A remembered feed that is no longer offered checks the default instead.
    let checkedId = $derived(
        feeds?.find((f) => f.id === currentId)?.id ?? feeds?.find((f) => f.isDefault)?.id,
    );

    // Clamp within the viewport; the list is at most a dozen rows.
    let pos = $derived.by(() => {
        const width = 288;
        const height = Math.min(440, 96 + (feeds?.length ?? 2) * 44);
        const vw = globalThis.innerWidth || 1280;
        const vh = globalThis.innerHeight || 800;
        return {
            left: Math.max(8, Math.min(x, vw - width - 8)),
            top: Math.max(8, Math.min(y, vh - height - 8)),
        };
    });

    function close(): void {
        onclose();
        restoreFocusEl?.focus?.();
    }

    function items(): HTMLButtonElement[] {
        if (!menuEl) return [];
        return [...menuEl.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    }

    function handleKeydown(e: KeyboardEvent): void {
        const list = items();
        const idx = list.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'Escape') {
            e.preventDefault();
            close();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            list[(idx + 1 + list.length) % list.length]?.focus();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            list[(idx - 1 + list.length) % list.length]?.focus();
        } else if (e.key === 'Home') {
            e.preventDefault();
            list[0]?.focus();
        } else if (e.key === 'End') {
            e.preventDefault();
            list[list.length - 1]?.focus();
        } else if (e.key === 'Tab') {
            // A menu is one tab stop; leaving it closes it.
            close();
        }
    }

    // Remember where focus came from, take it, and close on an outside press.
    $effect(() => {
        restoreFocusEl = document.activeElement as HTMLElement;
        menuEl?.focus();
        function onDocPointerDown(e: PointerEvent): void {
            if (menuEl && !menuEl.contains(e.target as Node)) close();
        }
        document.addEventListener('pointerdown', onDocPointerDown, true);
        return () => document.removeEventListener('pointerdown', onDocPointerDown, true);
    });

    // Focus the checked feed once the list arrives.
    $effect(() => {
        if (!feeds || !menuEl) return;
        const list = items();
        (list.find((el) => el.dataset.feedId === checkedId) ?? list[0])?.focus();
    });

    function pick(feed: LiveTvFeed): void {
        onpick(feed, stationId);
    }
</script>

<div
    bind:this={menuEl}
    class="fixed z-[110] w-72 max-h-[calc(100vh-16px)] overflow-y-auto rounded-lg border border-surface-700 bg-surface-800 py-1 text-sm shadow-2xl"
    style="left: {pos.left}px; top: {pos.top}px;"
    role="menu"
    tabindex="-1"
    aria-label={m.livetv_feed_menu_label({ name })}
    onkeydown={handleKeydown}>
    <div class="border-b border-surface-700 px-3 py-2">
        <div class="truncate font-medium text-surface-100">
            {m.livetv_feed_menu_label({ name })}
        </div>
        <div class="text-xs text-surface-400">{m.livetv_feed_menu_hint()}</div>
    </div>

    {#if failed}
        <p class="px-3 py-2 text-surface-300" role="status">{m.livetv_feed_error()}</p>
    {:else if feeds === null}
        <p class="px-3 py-2 text-surface-400" role="status">{m.livetv_feed_loading()}</p>
    {:else}
        {#each feeds as feed (feed.id)}
            {@const checked = feed.id === checkedId}
            <button
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                data-feed-id={feed.id}
                class="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-700 focus:bg-surface-700 focus:outline-none {checked
                    ? 'text-white'
                    : 'text-surface-200'}"
                onclick={() => pick(feed)}>
                <span class="flex h-4 w-4 shrink-0 items-center justify-center">
                    {#if checked}<Icon src={Check} class="h-4 w-4 text-primary-400" />{/if}
                </span>
                <span class="min-w-0 flex-1 truncate">{feed.name}</span>
                {#if feed.qualityTier}
                    <span
                        class="shrink-0 rounded bg-surface-700 px-1.5 py-0.5 text-[11px] font-semibold text-surface-200"
                        >{feedQualityLabel(feed.qualityTier)}</span>
                {/if}
                {#if feed.isDegraded}
                    <span class="shrink-0 text-[11px] text-amber-300"
                        >{m.livetv_feed_degraded()}</span>
                {/if}
                {#if feed.isDefault}
                    <span class="shrink-0 text-[11px] text-surface-400"
                        >{m.livetv_feed_default()}</span>
                {/if}
            </button>
        {/each}
        {#if feeds.length < 2}
            <p class="px-3 py-2 text-xs text-surface-400">{m.livetv_feed_single()}</p>
        {/if}
    {/if}
</div>
