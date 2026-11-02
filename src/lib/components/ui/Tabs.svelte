<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script module lang="ts">
    import type { IconSource } from 'svelte-hero-icons';

    /**
     * Declared in `<script module>` because a type exported from the INSTANCE
     * script is not part of the component module's public surface — four admin
     * pages do `import Tabs, { type TabItem }` and failed to resolve it.
     */
    export type TabItem = {
        id: string;
        label: string;
        icon?: IconSource;
        disabled?: boolean;
        badge?: string | number;
    };
</script>

<script lang="ts">
    import { Icon } from 'svelte-hero-icons';
    import { page } from '$app/stores';
    import { replaceState } from '$app/navigation';
    import { browser } from '$app/environment';
    import { dragScroll } from '$lib/utils/drag-scroll';
    import { Z } from '$lib/utils/z-index';
    import * as m from '$lib/paraglide/messages.js';

    // Additional classes
    interface Props {
        // Props
        items?: TabItem[];
        active?: string;
        // Visual variant
        variant?: 'default' | 'pills' | 'underline';
        // Size
        size?: 'sm' | 'md' | 'lg';
        // Full width tabs
        fullWidth?: boolean;
        syncToUrl?: boolean;
        /**
         * Query param name used when `syncToUrl` is set (admin IA redesign,
         * spec §4/§8: "make ?tab= deep-link params match tab ids
         * consistently"). Defaults to `'tab'`. Callers that already own a
         * different param (e.g. Pipeline's `?view=flow|completion`) pass it
         * here instead of hand-rolling their own URL sync.
         */
        urlParam?: string;
        /**
         * Persist the active tab to `localStorage` (keyed by pathname) and
         * restore it on next visit when `syncToUrl` is on. Precedence on init:
         * `?<urlParam>=` in the URL wins, then the remembered tab (if it still
         * matches a current item id), then the existing `items[0]` default.
         * Defaults to `true` — opt out per-instance with `remember={false}`.
         */
        remember?: boolean;
        /**
         * Wrap onto more lines instead of scrolling sideways. For short tab
         * sets (detail panels): on a phone the scrolled strip hid the ACTIVE
         * tab behind "More", so nothing on screen said which tab was showing.
         */
        wrap?: boolean;
        class?: string;
        children?: import('svelte').Snippet<[{ active: string }]>;
        onchange?: (detail: { id: string; item: TabItem }) => void;
    }

    let {
        items = [],
        active = $bindable(items[0]?.id || ''),
        variant = 'default',
        size = 'md',
        fullWidth = false,
        syncToUrl = false,
        urlParam = 'tab',
        remember = true,
        wrap = false,
        class: className = '',
        children,
        onchange,
    }: Props = $props();

    /**
     * The URL the user actually sees. During SvelteKit SHALLOW ROUTING (the
     * admin DetailPanel opens `/admin/tasks/<id>` via `pushState` while the
     * list route stays mounted underneath) `$page.url` keeps pointing at the
     * UNDERLYING route — reading/writing the tab param there targeted the
     * wrong URL, and the old `goto()` write performed a REAL navigation to
     * that wrong URL, wiping `page.state` and closing the panel (owner bug:
     * "clicking a tab in the panel closes the panel"). Params are read from
     * and written to the visible URL instead.
     */
    function visibleUrl(): URL {
        return browser ? new URL(window.location.href) : new URL($page.url);
    }

    function lastTabStorageKey(): string {
        return `admin:last-tab:${visibleUrl().pathname}`;
    }

    /** localStorage may be unavailable (privacy modes, bare test DOMs) — degrade to no memory. */
    function readStoredTab(): string | null {
        try {
            return localStorage.getItem(lastTabStorageKey());
        } catch {
            return null;
        }
    }
    function storeTab(id: string): void {
        try {
            localStorage.setItem(lastTabStorageKey(), id);
        } catch {
            // Persistence is best-effort only.
        }
    }

    /**
     * Shallow-write the tab param onto the visible URL. `replaceState` (the
     * shallow-routing API, NOT a navigation) passes the CURRENT `page.state`
     * through, so a DetailPanel's `detailPanel` state survives, no history
     * entry is created, and no `load()` re-runs. Returns false when the
     * router isn't initialized yet (dev-only guard on the first
     * pre-hydration frames) so callers can retry.
     */
    function writeTabParam(id: string): boolean {
        const url = visibleUrl();
        if (url.searchParams.get(urlParam) === id) return true;
        url.searchParams.set(urlParam, id);
        try {
            replaceState(url, $page.state);
            return true;
        } catch {
            return false;
        }
    }

    // Set (init-only) when the active tab was restored from localStorage
    // rather than the URL; the $effect below reflects it into the URL and
    // notifies the parent, then clears it (never loops, never lets the
    // "no ?tab= → reset to default" branch stomp the restored value).
    let pendingRestoreTab: string | null = null;

    // URL sync: read initial tab from URL on creation (intentionally init-only)
    // svelte-ignore state_referenced_locally
    if (syncToUrl) {
        const urlTab = visibleUrl().searchParams.get(urlParam);
        if (urlTab && items.some((i) => i.id === urlTab)) {
            active = urlTab;
        } else if (remember && browser) {
            const stored = readStoredTab();
            if (stored && items.some((i) => i.id === stored)) {
                active = stored;
                pendingRestoreTab = stored;
            }
        }
    }

    /**
     * Reflect a localStorage-restored tab into the URL and notify the parent
     * — controlled callers (DetailPanel drives its content off its OWN
     * `activeTab` state) only follow the restore through `onchange`. Left
     * pending when the router isn't ready yet so the $effect retries on the
     * next page-store emission. Re-asserts `active`: a controlled parent's
     * mount-time reset effect (TaskDetail resets its tab state whenever the
     * panel is reused) may have pulled the prop back to the default between
     * init and this reflection.
     */
    function reflectRestoredTab(): void {
        if (!pendingRestoreTab) return;
        const id = pendingRestoreTab;
        if (!writeTabParam(id)) return;
        pendingRestoreTab = null;
        active = id;
        notifyChange(id);
    }

    // The restore reflection is deferred one macrotask past mount: the
    // initial effect cascade includes controlled parents' own mount effects
    // (TaskDetail's reset-to-default), and an in-cascade notify gets
    // stomped by whichever effect happens to run last. After the cascade,
    // nothing re-runs those mount effects, so the deferred notify wins
    // deterministically.
    let restoreTimer: ReturnType<typeof setTimeout> | null = null;
    $effect(() => {
        return () => {
            if (restoreTimer) clearTimeout(restoreTimer);
        };
    });

    // URL sync: watch for browser back/forward (and reflect a pending
    // localStorage restore into the URL on mount). The page store is the
    // reactivity source — it re-emits on real navigations AND on shallow
    // pushState/replaceState — but the param is READ from the visible URL
    // (see `visibleUrl`).
    $effect(() => {
        if (!syncToUrl) return;
        void $page.url;
        void $page.state;
        if (pendingRestoreTab) {
            // A run with a pending restore only schedules the reflection —
            // it must not fall through to the "no ?tab= → reset to default"
            // branch and stomp the restored value before the URL write is
            // observable.
            if (!restoreTimer) {
                restoreTimer = setTimeout(() => {
                    restoreTimer = null;
                    reflectRestoredTab();
                }, 0);
            }
            return;
        }
        const urlTab = visibleUrl().searchParams.get(urlParam);
        if (urlTab && urlTab !== active && items.some((i) => i.id === urlTab)) {
            active = urlTab;
            notifyChange(urlTab);
        } else if (!urlTab) {
            // Back navigation removed ?<urlParam>= — reset to first tab
            const defaultTab = items[0]?.id;
            if (defaultTab && active !== defaultTab) {
                active = defaultTab;
                notifyChange(defaultTab);
            }
        }
    });

    /**
     * Tell the parent about a URL-driven tab change (back/forward, restore).
     * Bound callers (`bind:active`) already follow via the binding and pass
     * no `onchange`; CONTROLLED callers (DetailPanel passes `active` +
     * `onchange` and drives the tab CONTENT off its own state) would
     * otherwise only follow clicks — leaving highlight and content out of
     * sync whenever the URL (not a click) changed the tab.
     */
    function notifyChange(id: string): void {
        const item = items.find((i) => i.id === id);
        if (item) onchange?.({ id, item });
    }

    /**
     * Whether a tab's badge should render at all (admin IA redesign, spec §8:
     * "fix the broken empty-badge sliver rendered after the last tab
     * everywhere"). A badge of `undefined`, `''`, or the number `0` renders
     * an empty/meaningless pill — callers routinely pass a possibly-zero
     * count straight through (e.g. `badge: someCount ?? undefined`, which
     * still lets `0` slip past `!== undefined`). Non-empty strings and any
     * non-zero number are shown.
     */
    function hasBadge(item: TabItem): boolean {
        if (item.badge === undefined) return false;
        if (typeof item.badge === 'number') return item.badge > 0;
        return item.badge !== '';
    }

    // Size classes
    const sizeClasses: Record<typeof size, string> = {
        sm: 'text-sm px-3 py-1.5 gap-1.5',
        md: 'px-4 py-2 gap-2',
        lg: 'text-lg px-5 py-2.5 gap-2',
    };

    const iconSizes: Record<typeof size, string> = {
        sm: 'w-3.5 h-3.5',
        md: 'w-4 h-4',
        lg: 'w-5 h-5',
    };

    // Variant-specific classes
    const variantContainerClasses: Record<typeof variant, string> = {
        default: 'bg-surface-800/50 p-1 rounded-lg gap-1',
        pills: 'gap-2',
        underline: 'border-b border-surface-700 gap-0',
    };

    function getTabClasses(item: TabItem): string {
        const isActive = active === item.id;
        const isDisabled = item.disabled;

        // whitespace-nowrap + shrink-0: a tab label must never wrap to two
        // lines when the strip is squeezed (e.g. the DetailPanel's slide-in
        // first paint) — a wrapped label changes the strip's height mid-
        // animation and collides with the content below. Overflow goes to
        // the container's horizontal scroll (with edge fades) instead.
        const base = `inline-flex items-center whitespace-nowrap shrink-0 transition-colors ${sizeClasses[size]}`;
        const disabled = isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer';

        if (variant === 'default') {
            return `${base} ${disabled} rounded-md ${
                isActive
                    ? 'bg-surface-700 text-white shadow-sm'
                    : 'text-surface-400 hover:text-white hover:bg-surface-700/50'
            }`;
        }

        if (variant === 'pills') {
            return `${base} ${disabled} rounded-full ${
                isActive
                    ? 'bg-primary-600 text-white'
                    : 'text-surface-400 hover:text-white hover:bg-surface-700'
            }`;
        }

        if (variant === 'underline') {
            return `${base} ${disabled} border-b-2 -mb-px ${
                isActive
                    ? 'border-primary-500 text-white'
                    : 'border-transparent text-surface-400 hover:text-white hover:border-surface-600'
            }`;
        }

        return base;
    }

    function handleTabClick(item: TabItem) {
        if (item.disabled) return;
        if (active === item.id) return;

        active = item.id;
        if (syncToUrl) {
            if (remember && browser) {
                storeTab(item.id);
            }
            writeTabParam(item.id);
        }
        onchange?.({ id: item.id, item });
    }

    function handleKeydown(event: KeyboardEvent, item: TabItem, index: number) {
        if (item.disabled) return;

        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleTabClick(item);
        } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            focusTab(index + 1);
        } else if (event.key === 'ArrowLeft') {
            event.preventDefault();
            focusTab(index - 1);
        }
    }

    function focusTab(index: number) {
        const enabledItems = items.filter((i) => !i.disabled);
        const wrappedIndex =
            ((index % enabledItems.length) + enabledItems.length) % enabledItems.length;
        const targetItem = enabledItems[wrappedIndex];
        const button = document.querySelector(`[data-tab-id="${targetItem.id}"]`) as HTMLElement;
        button?.focus();
    }

    // Scroll overflow tracking for edge fade affordances
    let scrollContainer = $state<HTMLDivElement | undefined>(undefined);
    let showLeftFade = $state(false);
    let showRightFade = $state(false);

    /**
     * Items whose tab button is not fully within the container's visible
     * (scrolled) viewport right now. Drives the `More` menu below — the fade
     * can only say "there is more", this says *which* tabs are over there.
     * Recomputed alongside the fade on every `onscroll` and on container
     * resize (see the `ResizeObserver` effect further down).
     */
    let hiddenItems = $state<TabItem[]>([]);

    function updateHiddenItems(el: HTMLDivElement) {
        const containerLeft = el.scrollLeft;
        const containerRight = el.scrollLeft + el.clientWidth;
        const hidden: TabItem[] = [];
        for (const item of items) {
            const button = el.querySelector(`[data-tab-id="${item.id}"]`) as HTMLElement | null;
            if (!button) continue;
            const buttonLeft = button.offsetLeft;
            const buttonRight = buttonLeft + button.offsetWidth;
            // A 1px slack absorbs sub-pixel rounding at the exact edge.
            if (buttonLeft < containerLeft - 1 || buttonRight > containerRight + 1) {
                hidden.push(item);
            }
        }
        hiddenItems = hidden;
    }

    function updateFadeVisibility() {
        const el = scrollContainer;
        if (!el) return;
        showLeftFade = el.scrollLeft > 0;
        showRightFade = el.scrollLeft + el.clientWidth < el.scrollWidth;
        updateHiddenItems(el);
    }

    $effect(() => {
        // Re-evaluate fade + overflow visibility when items change (may affect scrollWidth)
        items.length;
        updateFadeVisibility();
    });

    // Container resize (e.g. a sidebar collapsing, or a responsive layout
    // change) can shrink or grow how much of the strip fits without the
    // strip itself ever scrolling — `onscroll` alone would miss that.
    $effect(() => {
        const el = scrollContainer;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(() => updateFadeVisibility());
        observer.observe(el);
        return () => observer.disconnect();
    });

    // Overflow ("More") menu state
    let moreMenuOpen = $state(false);
    let moreTriggerEl = $state<HTMLButtonElement | undefined>(undefined);
    let moreMenuEl = $state<HTMLDivElement | undefined>(undefined);

    function closeMoreMenu() {
        moreMenuOpen = false;
    }

    function toggleMoreMenu() {
        moreMenuOpen = !moreMenuOpen;
    }

    function handleMoreMenuKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeMoreMenu();
            moreTriggerEl?.focus();
        }
    }

    // Dismiss the menu on an outside click — otherwise it has no way to
    // close besides Escape or picking an item, which is not enough for a
    // popup menu pattern.
    function handleWindowClick(event: MouseEvent) {
        if (!moreMenuOpen) return;
        const target = event.target as Node | null;
        if (moreMenuEl?.contains(target) || moreTriggerEl?.contains(target)) return;
        closeMoreMenu();
    }

    function selectFromMoreMenu(item: TabItem) {
        handleTabClick(item);
        closeMoreMenu();
        const button = scrollContainer?.querySelector(
            `[data-tab-id="${item.id}"]`,
        ) as HTMLElement | null;
        button?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
</script>

<!--
  `<svelte:window>` must be a direct top-level child of the component --
  Svelte rejects it inside any element or block (`svelte_meta_invalid_placement`),
  so it cannot be conditionally mounted inside the
  `{#if hiddenItems.length > 0}` block below. The `addEventListener` call it
  compiles to runs once at mount and stays registered for the component's
  whole lifetime, on every Tabs instance, overflow or not -- the ternary
  below is evaluated inside the listener on each click, not around whether
  the listener exists.
  What it does buy: a non-overflow instance now does a cheap ternary-and-
  return per click instead of invoking `handleWindowClick` (which itself
  early-returns). That's a per-click-work saving, not a listener-count one.
  Actually skipping the bind on instances with no overflow would need an
  imperative `$effect` managing `addEventListener`/`removeEventListener`
  directly -- considered and judged not worth the added lifecycle complexity
  for a listener this cheap, given `Tabs` is rendered by 12 different files.
-->
<svelte:window onclick={hiddenItems.length > 0 ? handleWindowClick : undefined} />

{#snippet tabBadge(item: TabItem)}
    {#if hasBadge(item)}
        <span
            class="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 text-xs font-medium rounded-full bg-surface-600 text-surface-200">
            {item.badge}
        </span>
    {/if}
{/snippet}

<div
    class="tabs-wrapper relative {fullWidth ? 'w-full' : 'w-fit max-w-full'} {hiddenItems.length > 0
        ? 'flex items-center gap-1'
        : ''}">
    <div
        bind:this={scrollContainer}
        class="tabs-container flex {wrap ? 'flex-wrap' : 'overflow-x-auto'} {fullWidth
            ? 'w-full'
            : 'w-fit max-w-full'} {hiddenItems.length > 0
            ? 'min-w-0'
            : ''} {variantContainerClasses[variant]} {className}"
        class:show-left-fade={showLeftFade}
        class:show-right-fade={showRightFade}
        role="tablist"
        onscroll={updateFadeVisibility}
        use:dragScroll={{ scrollSpeed: 1 }}>
        {#each items as item, index (item.id)}
            <button
                type="button"
                role="tab"
                data-tab-id={item.id}
                data-drag-scroll-allow
                aria-selected={active === item.id}
                aria-disabled={item.disabled}
                tabindex={active === item.id ? 0 : -1}
                class="{getTabClasses(item)} {fullWidth ? 'flex-1 justify-center' : ''}"
                onclick={() => handleTabClick(item)}
                onkeydown={(e) => handleKeydown(e, item, index)}>
                {#if item.icon}
                    <Icon src={item.icon} class={iconSizes[size]} />
                {/if}

                <span>{item.label}</span>

                {@render tabBadge(item)}
            </button>
        {/each}
    </div>

    {#if hiddenItems.length > 0}
        <div class="relative shrink-0 self-center ml-1">
            <button
                type="button"
                bind:this={moreTriggerEl}
                aria-haspopup="menu"
                aria-expanded={moreMenuOpen}
                class="inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-1.5 text-sm text-surface-400 transition-colors hover:bg-surface-700/50 hover:text-white"
                onclick={toggleMoreMenu}
                onkeydown={handleMoreMenuKeydown}>
                {m.ui_tabs_more()}
            </button>

            {#if moreMenuOpen}
                <div
                    bind:this={moreMenuEl}
                    role="menu"
                    tabindex="-1"
                    style="z-index: {Z.NAV_POPUP}"
                    class="absolute right-0 top-full mt-1 min-w-[10rem] max-h-80 overflow-y-auto rounded-md border border-surface-700 bg-surface-800 py-1 shadow-lg"
                    onkeydown={handleMoreMenuKeydown}>
                    {#each hiddenItems as item (item.id)}
                        <button
                            type="button"
                            role="menuitem"
                            aria-disabled={item.disabled}
                            class="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm transition-colors {item.disabled
                                ? 'cursor-not-allowed text-surface-500'
                                : 'text-surface-200 hover:bg-surface-700 hover:text-white'}"
                            onclick={() => selectFromMoreMenu(item)}>
                            {#if item.icon}
                                <Icon src={item.icon} class="w-4 h-4" />
                            {/if}
                            <span class="flex-1">{item.label}</span>
                            {@render tabBadge(item)}
                        </button>
                    {/each}
                </div>
            {/if}
        </div>
    {/if}
</div>

{#if children}
    <div class="tab-panels mt-4" role="tabpanel">
        {@render children?.({ active })}
    </div>
{/if}

<style>
    /*
     * No native scrollbars on the strip — the edge fades below are the ONE
     * overflow affordance. Without this, `overflow-x-auto` also computes
     * `overflow-y: auto` (per spec), and the underline variant's
     * `border-b-2 -mb-px` buttons make scrollHeight exceed clientHeight by
     * 1px — browsers with classic (non-overlay) scrollbars then render a
     * ~15px vertical scrollbar at the strip's right edge: the owner-reported
     * "white pill-box after the last tab" seen in multiple tab strips.
     * Scrolling still works via wheel/touch/drag; keyboard users move with
     * the roving-tabindex arrow keys, which focus (and thus scroll to) tabs.
     */
    .tabs-container {
        scrollbar-width: none; /* Firefox */
        -ms-overflow-style: none; /* legacy Edge */
    }
    .tabs-container::-webkit-scrollbar {
        display: none; /* Chromium / WebKit */
    }

    /*
     * Background-independent overflow affordance: fade the scroll container's
     * own pixels to transparent via mask-image rather than painting a coloured
     * gradient overlay. A coloured overlay (e.g. from-surface-900) would render
     * a visible band when Tabs sits on any other background; a mask works on
     * every caller surface. Webkit-prefixed for Safari, mirroring MediaCarousel.
     */
    .tabs-container.show-left-fade {
        -webkit-mask-image: linear-gradient(to right, transparent, black 16px);
        mask-image: linear-gradient(to right, transparent, black 16px);
    }

    .tabs-container.show-right-fade {
        -webkit-mask-image: linear-gradient(to right, black calc(100% - 16px), transparent);
        mask-image: linear-gradient(to right, black calc(100% - 16px), transparent);
    }

    .tabs-container.show-left-fade.show-right-fade {
        -webkit-mask-image: linear-gradient(
            to right,
            transparent,
            black 16px,
            black calc(100% - 16px),
            transparent
        );
        mask-image: linear-gradient(
            to right,
            transparent,
            black 16px,
            black calc(100% - 16px),
            transparent
        );
    }
</style>
