<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { browser } from '$app/environment';
    import { onMount } from 'svelte';
    import { Icon, ChevronRight, ChevronDown } from 'svelte-hero-icons';
    import { RadioTower } from '$lib/components/admin/navigation/lumastra-custom-icons';
    import RadioStationCard from '$lib/components/music/RadioStationCard.svelte';
    import type { RadioStationApiItem } from '$lib/schemas/radio';
    import ContextMenu from '$lib/components/ui/ContextMenu.svelte';
    import type { ContextMenuItem } from '$lib/components/ui/context-menu-types';
    import { radioSectionPreferences } from '$lib/stores/radioSectionPreferences';
    import type {
        RadioSectionPosition,
        RadioSectionCollapsed,
    } from '$lib/stores/radioSectionPreferences';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages';
    import { resolve } from '$lib/paths';

    /** The shelf forwards these straight to RadioStationCard, which is typed to
     *  the API item — keep the two in lockstep rather than re-declaring a subset. */
    type RadioStation = RadioStationApiItem;

    interface Props {
        stations: RadioStation[];
        count: number;
    }

    let { stations, count }: Props = $props();

    // Track whether we're on a mobile viewport (< 768px).
    // Initialized to false (SSR-safe); updated on mount and on resize.
    let isMobile = $state(false);

    onMount(() => {
        const mq = window.matchMedia('(max-width: 767px)');
        isMobile = mq.matches;
        const handler = (e: MediaQueryListEvent): void => {
            isMobile = e.matches;
        };
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    });

    // Resolved collapsed state: 'auto' defers to the breakpoint default.
    let isCollapsed = $derived.by((): boolean => {
        const pref = $radioSectionPreferences.collapsed;
        if (pref === 'collapsed') return true;
        if (pref === 'expanded') return false;
        // 'auto' — mobile defaults to collapsed, desktop to expanded
        return isMobile;
    });

    function toggleCollapsed(): void {
        // Flip to the explicit opposite of the current resolved state.
        const next: RadioSectionCollapsed = isCollapsed ? 'expanded' : 'collapsed';
        radioSectionPreferences.setCollapsed(next);
    }

    // -------------------------------------------------------------------------
    // Context menu
    // -------------------------------------------------------------------------

    interface MenuPos {
        x: number;
        y: number;
    }

    let menuPos = $state<MenuPos | null>(null);
    let useMobileSheet = $state(false);

    // Long-press support for mobile
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let longPressActive = $state(false);

    function openMenu(x: number, y: number, mobile: boolean): void {
        useMobileSheet = mobile;
        menuPos = { x, y };
    }

    function handleContextMenu(e: MouseEvent): void {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, false);
    }

    function handleTouchStart(e: TouchEvent): void {
        const touch = e.touches[0];
        longPressActive = false;
        longPressTimer = setTimeout(() => {
            longPressActive = true;
            openMenu(touch.clientX, touch.clientY, true);
        }, 500);
    }

    function handleTouchEnd(): void {
        if (longPressTimer !== null) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
        if (longPressActive) {
            longPressActive = false;
        }
    }

    function handleTouchMove(): void {
        if (longPressTimer !== null) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
    }

    function handleMoreClick(e: MouseEvent): void {
        e.stopPropagation();
        openMenu(e.clientX, e.clientY, isMobile);
    }

    function positionLabel(pos: RadioSectionPosition): string {
        switch (pos) {
            case 'top':
                return 'Pin to top';
            case 'auto':
                return 'After Quick Picks (default)';
            case 'bottom':
                return 'Pin to bottom';
            case 'hidden':
                return 'Hide entirely';
        }
    }

    function applyPosition(pos: RadioSectionPosition): void {
        const previous = $radioSectionPreferences.position;
        radioSectionPreferences.setPosition(pos);
        // Hiding removes the only on-page handle for changing the pref
        // back. Surface an inline Undo toast so the action is reversible
        // without having to know about /music/radio. The settings menu
        // there is the persistent fallback if the toast is missed.
        if (pos === 'hidden') {
            toasts.info('Internet Radio hidden — restore from /music/radio', {
                timeout: 8000,
                action: {
                    label: 'Undo',
                    onClick: () => radioSectionPreferences.setPosition(previous),
                },
            });
        }
    }

    let contextItems = $derived.by((): ContextMenuItem[] => {
        const currentPos = $radioSectionPreferences.position;
        const positions: RadioSectionPosition[] = ['top', 'auto', 'bottom', 'hidden'];
        return positions.map((pos) => ({
            label: (currentPos === pos ? '✓ ' : '   ') + positionLabel(pos),
            onSelect: () => applyPosition(pos),
        }));
    });

    // Suppress browser context menu on the header when we show our own
    function preventNativeContextMenu(e: MouseEvent): void {
        e.preventDefault();
    }
</script>

<!-- Quiet shelf header — sits just above the row of station cards.
     Tier-2 visual weight so it doesn't compete with personalized
     recommendation sections like Quick Picks.
     `py-3` adds explicit top + bottom breathing room; sibling
     sections rely on their fat h2 headers to create that gap, but
     this shelf's tiny header doesn't take up enough vertical space
     to feel separated otherwise. -->
<section class="space-y-3 py-3">
    <div
        class="flex items-center justify-between gap-2 select-none cursor-pointer min-h-[28px] text-surface-400 hover:text-surface-200 transition-colors"
        onclick={toggleCollapsed}
        oncontextmenu={handleContextMenu}
        ontouchstart={handleTouchStart}
        ontouchend={handleTouchEnd}
        ontouchmove={handleTouchMove}
        role="button"
        tabindex="0"
        onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleCollapsed();
            }
        }}>
        <div class="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider">
            <Icon src={RadioTower} class="h-3.5 w-3.5" />
            <span>Live Radio</span>
            <span class="text-surface-600">·</span>
            <span class="text-surface-500 normal-case font-normal tracking-normal"
                >{count} {count === 1 ? 'station' : 'stations'}</span>
        </div>
        <div class="flex items-center gap-2">
            {#if !isCollapsed}
                <a
                    href={resolve('/music/radio')}
                    class="inline-flex items-center gap-1 text-[11px] uppercase tracking-wider hover:text-white"
                    onclick={(e) => e.stopPropagation()}>
                    <span>See all</span>
                    <Icon src={ChevronRight} class="h-3 w-3" />
                </a>
            {/if}
            <button
                type="button"
                class="rounded p-1 text-surface-500 hover:text-white transition-colors"
                title={m.music_more_options_title()}
                onclick={handleMoreClick}
                oncontextmenu={preventNativeContextMenu}>
                &#x22EF;
            </button>
            <span
                class="transition-transform duration-200 {isCollapsed ? 'rotate-0' : 'rotate-180'}">
                <Icon src={ChevronDown} class="h-3.5 w-3.5" />
            </span>
        </div>
    </div>

    {#if !isCollapsed}
        <!-- Fixed-width cards regardless of station count. A grid stretched
             to fill column width meant a single station bloated to ~190px
             and read as visually larger than the surrounding carousel
             posters; a fixed `w-36` (144px) keeps it in line with the
             Recently Played / Quick Picks card sizing.
             Mobile uses a horizontal swipe carousel; desktop wraps. -->
        {#if browser && isMobile}
            <div class="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4">
                {#each stations as station (station.id)}
                    <div class="shrink-0 w-32">
                        <RadioStationCard {station} />
                    </div>
                {/each}
            </div>
        {:else}
            <div class="flex flex-wrap gap-3">
                {#each stations as station (station.id)}
                    <div class="w-36">
                        <RadioStationCard {station} />
                    </div>
                {/each}
            </div>
        {/if}
    {/if}
</section>

{#if menuPos}
    <ContextMenu
        x={menuPos.x}
        y={menuPos.y}
        title={m.music_internet_radio_title()}
        items={contextItems}
        mobileSheet={useMobileSheet}
        onClose={() => (menuPos = null)} />
{/if}
