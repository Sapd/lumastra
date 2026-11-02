<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
    ContextMenu.svelte

    Floating context menu anchored to a viewport coordinate. Used for:
    - Desktop right-click menus on media cards
    - Mobile long-press menus on media cards
    - Any other "menu at point" interaction

    Positioning uses @floating-ui/dom with flip + shift to stay in viewport.

    Closes on: outside click, Escape key, or after any menu item is selected.

    Usage:
        {#if menuPos}
            <ContextMenu
                x={menuPos.x}
                y={menuPos.y}
                title="Track name"
                items={[
                    { label: 'Play', icon: PlayCircle, onSelect: () => play() },
                    { label: 'Add to queue', icon: ListBullet, onSelect: () => add() }
                ]}
                onClose={() => (menuPos = null)} />
        {/if}
-->

<script lang="ts">
    import {
        isActionRow,
        isSubmenu,
        type ContextMenuEntry,
        type ContextMenuItem,
        type ContextMenuRowAction,
        type ContextMenuSubmenu,
    } from './context-menu-types';
    import { Icon, ChevronRight, ChevronLeft } from 'svelte-hero-icons';
    import { computePosition, flip, shift, offset } from '@floating-ui/dom';
    import { tick } from 'svelte';
    import { Z } from '$lib/utils/z-index';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        /** Optional identifier for the menu panel and its controlling button. */
        id?: string;
        /** Viewport X coordinate to anchor the menu near */
        x: number;
        /** Viewport Y coordinate to anchor the menu near */
        y: number;
        /** Menu items in display order */
        items: ContextMenuEntry[];
        /** Optional title shown above items (e.g. the media title) */
        title?: string;
        /** Optional smaller line below the title (e.g. Quick Picks bucket label) */
        subtitle?: string;
        /** Render as a bottom action sheet for touch/mobile surfaces */
        mobileSheet?: boolean;
        /** Called when the menu should close (outside click, Escape, item picked) */
        onClose: () => void;
    }

    let { id, x, y, items, title, subtitle, mobileSheet = false, onClose }: Props = $props();

    let menuEl = $state<HTMLDivElement | null>(null);
    // Start at the requested point immediately; Floating UI refines it on the
    // next tick. This prevents a failed async positioning pass from leaving the
    // menu off-screen.
    let pos = $state<{ x: number; y: number }>({ x: 0, y: 0 });
    // Guards against selecting a menu item from the same gesture that opened
    // the menu.
    const openedAt = Date.now();
    const OPEN_GUARD_MS = 250;

    // Moves the wrapper node to document.body so that position:fixed inside it
    // is always relative to the viewport, even when the card lives inside a
    // carousel that has mask-image applied (mask-image creates a new containing
    // block in Chrome/Safari, breaking fixed positioning for children).
    //
    // On destroy we remove the node directly from body. We do NOT restore it
    // to its original position first because Svelte 5's {#if} cleanup may
    // already have walked and cleared its anchor range by the time action
    // destroy() runs — restoring the node there would leave it orphaned with
    // nothing to finish the removal.
    function bodyPortal(node: HTMLElement) {
        const anchor = document.createComment('');
        node.before(anchor);
        document.body.appendChild(node);
        return {
            destroy() {
                node.remove();
                anchor.remove();
            },
        };
    }

    $effect(() => {
        if (mobileSheet) return;
        // Capture reactive props synchronously so the effect re-runs when they
        // change (the async closure below would otherwise miss the dep track).
        const cx = x;
        const cy = y;
        pos = { x: cx, y: cy };
        let cancelled = false;
        (async () => {
            await tick();
            if (cancelled || !menuEl) return;
            const virtualEl = {
                getBoundingClientRect() {
                    return {
                        width: 0,
                        height: 0,
                        x: cx,
                        y: cy,
                        top: cy,
                        left: cx,
                        right: cx,
                        bottom: cy,
                    };
                },
            };
            const result = await computePosition(virtualEl, menuEl, {
                placement: 'bottom-start',
                middleware: [
                    offset(4),
                    flip({
                        fallbackPlacements: ['top-start', 'bottom-end', 'top-end'],
                    }),
                    shift({ padding: 8 }),
                ],
            });
            if (!cancelled) pos = { x: result.x, y: result.y };
        })();
        return () => {
            cancelled = true;
        };
    });

    // ── Submenu (Apple-Music-style flyout) ───────────────────────────────
    // Desktop: a second panel floats to the side of the hovered row.
    // Mobile sheet: the sheet body is replaced by the submenu, with a back
    // arrow — a side flyout has nowhere to go on a phone-width screen.
    // $state.raw, not $state: a plain-object entry would be wrapped in a
    // reactive proxy, and `openSub === sub` against the caller's original
    // object would then always be false — the open row would never highlight.
    let openSub = $state.raw<ContextMenuSubmenu | null>(null);
    let subAnchorEl = $state.raw<HTMLElement | null>(null);
    let subEl = $state<HTMLDivElement | null>(null);
    let subPos = $state<{ x: number; y: number }>({ x: 0, y: 0 });
    // Grace period so the pointer can travel across the gap between the row
    // and the flyout without the flyout vanishing mid-journey.
    let subCloseTimer: ReturnType<typeof setTimeout> | null = null;
    const SUB_CLOSE_DELAY_MS = 180;

    function cancelSubClose(): void {
        if (subCloseTimer !== null) {
            clearTimeout(subCloseTimer);
            subCloseTimer = null;
        }
    }

    function openSubmenu(entry: ContextMenuSubmenu, anchor: HTMLElement | null): void {
        cancelSubClose();
        openSub = entry;
        subAnchorEl = anchor;
    }

    function closeSubmenu(): void {
        cancelSubClose();
        openSub = null;
        subAnchorEl = null;
    }

    function scheduleSubClose(): void {
        if (mobileSheet) return;
        cancelSubClose();
        subCloseTimer = setTimeout(() => {
            subCloseTimer = null;
            openSub = null;
            subAnchorEl = null;
        }, SUB_CLOSE_DELAY_MS);
    }

    $effect(() => {
        // Position the desktop flyout beside its row. Mobile drills in
        // instead, so there is nothing to place.
        if (mobileSheet) return;
        const anchor = subAnchorEl;
        if (!openSub || !anchor) return;
        let cancelled = false;
        (async () => {
            await tick();
            if (cancelled || !subEl) return;
            const result = await computePosition(anchor, subEl, {
                placement: 'right-start',
                middleware: [
                    offset(2),
                    flip({ fallbackPlacements: ['left-start', 'right-end', 'left-end'] }),
                    shift({ padding: 8 }),
                ],
            });
            if (!cancelled) subPos = { x: result.x, y: result.y };
        })();
        return () => {
            cancelled = true;
        };
    });

    $effect(() => () => cancelSubClose());

    function handleSelect(item: ContextMenuItem): void {
        if (Date.now() - openedAt < OPEN_GUARD_MS) return;
        item.onSelect();
        onClose();
    }

    function handleRowAction(action: ContextMenuRowAction): void {
        if (Date.now() - openedAt < OPEN_GUARD_MS) return;
        action.onSelect();
        onClose();
    }

    function rowAccentClass(action: ContextMenuRowAction, isMobile: boolean): string {
        const sizing = isMobile ? 'h-12 w-12' : 'h-9 w-9';
        const base = `inline-flex ${sizing} items-center justify-center rounded-full transition-colors`;
        const accent = action.accent ?? 'neutral';
        const stateBase = action.active
            ? accent === 'negative'
                ? 'bg-error-500/20 text-error-300 hover:bg-error-500/30'
                : accent === 'love'
                  ? 'bg-pink-500/20 text-pink-300 hover:bg-pink-500/30'
                  : accent === 'positive'
                    ? 'bg-primary-500/20 text-primary-300 hover:bg-primary-500/30'
                    : 'bg-surface-700 text-surface-100 hover:bg-surface-600'
            : 'text-surface-300 hover:bg-surface-700 hover:text-surface-100';
        return `${base} ${stateBase}`;
    }

    function handleWindowPointerDown(e: PointerEvent | TouchEvent): void {
        if (Date.now() - openedAt < OPEN_GUARD_MS) return;
        const target = e.target as Node;
        // The flyout is portaled to body as a sibling of the main panel, so
        // menuEl.contains() alone reads a click inside it as "outside".
        if (subEl?.contains(target)) return;
        if (menuEl && !menuEl.contains(target)) {
            onClose();
        }
    }

    function handleKeydown(e: KeyboardEvent): void {
        if (
            e.key === 'Tab' &&
            (menuEl?.contains(document.activeElement) || subEl?.contains(document.activeElement))
        ) {
            // Let the owner restore its trigger before normal Tab movement,
            // including from the separately portaled desktop submenu.
            onClose();
            return;
        }
        if (e.key !== 'Escape') return;
        // Escape pops one level: flyout first, then the menu itself.
        if (openSub) {
            closeSubmenu();
            return;
        }
        onClose();
    }

    function handleMenuKeydown(e: KeyboardEvent): void {
        if (!menuEl) return;
        const items = menuEl.querySelectorAll<HTMLElement>('[role="menuitem"]');
        if (!items.length) return;

        const focused = document.activeElement as HTMLElement | null;
        let index = Array.from(items).indexOf(focused as HTMLElement);
        if (index < 0) index = 0;

        let nextIndex = index;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            nextIndex = (index + 1) % items.length;
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            nextIndex = (index - 1 + items.length) % items.length;
        } else if (e.key === 'Home') {
            e.preventDefault();
            nextIndex = 0;
        } else if (e.key === 'End') {
            e.preventDefault();
            nextIndex = items.length - 1;
        } else {
            return;
        }

        items.forEach((item, i) => {
            item.setAttribute('tabindex', i === nextIndex ? '0' : '-1');
        });
        items[nextIndex].focus();
    }

    $effect(() => {
        // Initialize roving tabindex when menu opens
        if (!menuEl) return;
        const items = menuEl.querySelectorAll<HTMLElement>('[role="menuitem"]');
        items.forEach((item, i) => {
            item.setAttribute('tabindex', i === 0 ? '0' : '-1');
        });
    });

    /** When the menu is rendered as a mobile bottom sheet, drop entries
     * marked hideOnMobile. Keeps the long-press menu focused on the
     * actions that actually matter on a small touch surface — admin
     * shortcuts, legacy-client deeplinks, etc. live on desktop only. */
    let visibleItems = $derived(mobileSheet ? items.filter((entry) => !entry.hideOnMobile) : items);

    let panelClass = $derived(
        mobileSheet
            ? 'fixed right-0 bottom-0 left-0 max-h-[80vh] overflow-y-auto rounded-t-lg border-t border-surface-600 bg-surface-900 py-2 shadow-2xl'
            : 'fixed bg-surface-800 rounded-lg shadow-xl border border-surface-600 py-1 min-w-48',
    );
    let panelStyle = $derived(
        mobileSheet
            ? `z-index: ${Z.CTX_MENU};`
            : `left: ${pos.x}px; top: ${pos.y}px; z-index: ${Z.CTX_MENU};`,
    );
</script>

<svelte:window
    onpointerdown={handleWindowPointerDown}
    ontouchstart={handleWindowPointerDown}
    onkeydown={handleKeydown} />

{#snippet menuItems()}
    {#if title}
        <div class="px-3 py-2 border-b border-surface-600 {mobileSheet ? '' : 'max-w-64'}">
            <div class="text-sm text-surface-300 truncate">{title}</div>
            {#if subtitle}
                <div class="mt-0.5 text-xs text-surface-400 truncate">
                    {subtitle}
                </div>
            {/if}
        </div>
    {/if}
    {#each visibleItems as entry, i (i)}
        {#if isActionRow(entry)}
            <div
                role="group"
                class="flex items-center justify-around gap-1 border-b border-surface-700/60 px-3 {mobileSheet
                    ? 'py-3'
                    : 'py-2'}">
                {#each entry.actions as action, j (j)}
                    <button
                        type="button"
                        role="menuitem"
                        aria-label={action.label}
                        title={action.label}
                        class={rowAccentClass(action, mobileSheet)}
                        onclick={() => handleRowAction(action)}>
                        <Icon src={action.icon} class={mobileSheet ? 'w-6 h-6' : 'w-5 h-5'} />
                    </button>
                {/each}
            </div>
        {:else if isSubmenu(entry)}
            {@const sub = entry}
            <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={openSub === sub}
                class="w-full px-3 text-left flex items-center gap-2 text-surface-100 {mobileSheet
                    ? 'py-3 text-base'
                    : 'py-2 text-sm'} {openSub === sub ? 'bg-surface-700' : 'hover:bg-surface-700'}"
                onmouseenter={(e) => {
                    if (mobileSheet) return;
                    openSubmenu(sub, e.currentTarget);
                }}
                onmouseleave={scheduleSubClose}
                onfocus={(e) => {
                    if (mobileSheet) return;
                    openSubmenu(sub, e.currentTarget);
                }}
                onclick={(e) => {
                    // Same guard the five other handlers use: the gesture that
                    // OPENS this menu can leave a trailing click behind, and
                    // without it that click lands on whichever row is under the
                    // pointer and flies its submenu out unasked. Regular items
                    // were guarded; the submenu row was the one that was not.
                    if (Date.now() - openedAt < OPEN_GUARD_MS) return;
                    openSubmenu(sub, e.currentTarget);
                }}>
                {#if sub.icon}
                    <Icon src={sub.icon} class="w-4 h-4 shrink-0" />
                {/if}
                <span class="truncate flex-1">{sub.label}</span>
                <Icon src={ChevronRight} class="w-4 h-4 shrink-0 text-surface-400" />
            </button>
        {:else}
            {@const item = entry}
            <button
                type="button"
                role="menuitem"
                class="w-full px-3 text-left hover:bg-surface-700 flex items-center gap-2 {mobileSheet
                    ? 'py-3 text-base'
                    : 'py-2 text-sm'} {item.destructive
                    ? 'text-error-400 hover:text-error-300'
                    : 'text-surface-100'}"
                onmouseenter={scheduleSubClose}
                onclick={() => handleSelect(item)}>
                {#if item.icon}
                    <Icon src={item.icon} class="w-4 h-4 shrink-0" />
                {/if}
                <span class="truncate">{item.label}</span>
            </button>
        {/if}
    {/each}
    {#if mobileSheet}
        <button
            type="button"
            role="menuitem"
            class="mt-1 flex w-full items-center justify-center border-t border-surface-700 px-3 py-3 text-base text-surface-300"
            onclick={onClose}>
            Cancel
        </button>
    {/if}
{/snippet}

{#snippet submenuBody(sub: ContextMenuSubmenu)}
    {@const Body = sub.component}
    <Body {...sub.props ?? {}} onDone={onClose} />
{/snippet}

{#snippet mobileSubmenu(sub: ContextMenuSubmenu)}
    <div class="flex items-center gap-2 border-b border-surface-600 px-2 py-2">
        <button
            type="button"
            class="btn-icon btn-icon-sm variant-ghost-surface shrink-0"
            aria-label={m.back()}
            onclick={closeSubmenu}>
            <Icon src={ChevronLeft} class="h-5 w-5" />
        </button>
        <span class="truncate text-sm font-medium text-surface-100">{sub.label}</span>
    </div>
    {@render submenuBody(sub)}
{/snippet}

{#if mobileSheet}
    <!-- Backdrop and panel are portaled to body in SEPARATE wrappers so there
         is no shared parent div that could create a stacking context and
         interfere with z-index hit-testing (iOS Safari is especially sensitive
         to this). The backdrop is a <div>, not a <button>, because iOS
         full-screen <button> elements can intercept touches even when a
         higher-z-index sibling sits on top. -->
    <div use:bodyPortal>
        <div
            role="presentation"
            class="fixed inset-0 bg-black/40"
            style="z-index: {Z.CTX_MENU_BACKDROP}; cursor: default;"
            onclick={() => {
                if (Date.now() - openedAt < OPEN_GUARD_MS) return;
                onClose();
            }}
            ontouchend={(e) => {
                e.preventDefault();
                if (Date.now() - openedAt < OPEN_GUARD_MS) return;
                onClose();
            }}>
        </div>
    </div>
    <div use:bodyPortal>
        <div
            bind:this={menuEl}
            {id}
            class={panelClass}
            style={panelStyle}
            role="menu"
            tabindex="-1"
            onkeydown={handleMenuKeydown}>
            {#if openSub}
                {@render mobileSubmenu(openSub)}
            {:else}
                {@render menuItems()}
            {/if}
        </div>
    </div>
{:else}
    <!-- Desktop right-click panel is portaled to body too so position:
         fixed coordinates always resolve against the viewport. Without
         this, any transformed/will-change/filtered ancestor (e.g. the
         hover popup's fade-in animation or a carousel's transform)
         becomes the containing block and the menu lands far from the
         click point. -->
    <div use:bodyPortal>
        <div
            bind:this={menuEl}
            {id}
            class={panelClass}
            style={panelStyle}
            role="menu"
            tabindex="-1"
            onkeydown={handleMenuKeydown}>
            {@render menuItems()}
        </div>
    </div>
    {#if openSub}
        <!-- Sibling wrapper, not a child of the main panel: the panel clips
             its own overflow, and nesting would make the flyout inherit the
             parent's width constraints. -->
        <div use:bodyPortal>
            <div
                bind:this={subEl}
                id={id ? `${id}-submenu` : undefined}
                class="fixed min-w-56 rounded-lg border border-surface-600 bg-surface-800 py-1 shadow-xl"
                style="left: {subPos.x}px; top: {subPos.y}px; z-index: {Z.CTX_MENU};"
                role="menu"
                tabindex="-1"
                onmouseenter={cancelSubClose}
                onmouseleave={scheduleSubClose}>
                {@render submenuBody(openSub)}
            </div>
        </div>
    {/if}
{/if}
