<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Admin sidebar renderer (admin IA redesign, spec §4 Renderer A). A flat ~220px
  panel, visually distinct from the global app dock, listing the admin sections
  as rows with status dots. The active section lists its pages under its row;
  other sections open theirs with a chevron (remembered per user). Settings'
  16 grouped pages open as a flyout instead, so they don't double its in-page
  area nav. Pin-collapsible to a slim rail, where every section's pages open as
  a flyout on hover/focus and the tab row (AdminSectionTabs) returns.
-->
<script lang="ts">
    import { tick } from 'svelte';
    import { browser } from '$app/environment';
    import { page } from '$app/stores';
    import { Icon, ChevronDoubleLeft, ChevronDoubleRight, ChevronRight } from 'svelte-hero-icons';
    import type { IconSource } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import type { AdminNavSection } from '$lib/config/admin-nav.js';
    import { adminNavPrefs } from '$lib/stores/admin-nav-prefs.store.svelte.js';
    import { sectionDot, sectionAttentionCount, pageAttentionDots } from './nav-status.js';
    import AdminNavFlyout from './AdminNavFlyout.svelte';
    import { adminNavHover } from '$lib/stores/admin-nav-hover.svelte.js';
    import EnterpriseBadge from './EnterpriseBadge.svelte';
    import {
        resolveSectionLandingPath,
        resolveActiveNavPath,
        lastSectionPageStorageKey,
        isPinActive,
        type AdminNavPin,
    } from '../admin-nav.utils.js';

    const HOVER_OPEN_DELAY_MS = 120;
    const HOVER_CLOSE_DELAY_MS = 200;

    interface Props {
        sections: AdminNavSection[];
    }
    let { sections }: Props = $props();

    let pathname = $derived($page.url.pathname);
    let collapsed = $derived(adminNavPrefs.collapsed);
    let groups = $derived([
        {
            id: 'operations',
            label: m.admin_redesign_nav_operate(),
            sections: sections.filter((s) => ['home', 'tasks', 'system'].includes(s.id)),
        },
        {
            id: 'management',
            label: m.admin_redesign_nav_manage(),
            sections: sections.filter((s) => ['library', 'users'].includes(s.id)),
        },
        {
            id: 'configuration',
            label: m.admin_redesign_nav_configure(),
            sections: sections.filter(
                (s) => !['home', 'tasks', 'system', 'library', 'users'].includes(s.id),
            ),
        },
    ]);

    // Per-user "quick menu" pins (AdminPageHeader's pin button), loaded once
    // in the admin layout. Orphaned by the IA redesign — restored here.
    let navPins = $derived(($page.data?.navPins as AdminNavPin[] | undefined) ?? []);

    function sectionActive(section: AdminNavSection): boolean {
        return section.pages.some((p) =>
            p.path === '/admin'
                ? pathname === '/admin'
                : pathname === p.path || pathname.startsWith(p.path + '/'),
        );
    }

    // Remembered last-visited page per section (feature: "remember last
    // sub-page"). Starts empty so SSR and the first client render both use
    // each section's default landing page — avoiding a hydration mismatch —
    // then swaps in the remembered path client-side once mounted.
    let lastPagePaths = $state<Record<string, string | null>>({});
    $effect(() => {
        if (!browser) return;
        const map: Record<string, string | null> = {};
        for (const section of sections) {
            map[section.id] = localStorage.getItem(lastSectionPageStorageKey(section.id));
        }
        lastPagePaths = map;
    });
    function sectionLanding(section: AdminNavSection): string {
        return resolveSectionLandingPath(section, lastPagePaths[section.id] ?? null);
    }

    // ONE active page across the whole nav (longest match), as in the tab row.
    let winnerPath = $derived(
        resolveActiveNavPath(
            pathname,
            sections.flatMap((s) => s.pages.map((p) => p.path)),
        ),
    );

    /** Pages open beside the row: every section on the rail, Settings always. */
    function usesFlyout(section: AdminNavSection): boolean {
        return section.pages.length > 1 && (collapsed || section.id === 'settings');
    }
    /** Pages listed under the row (full sidebar, everything but Settings). */
    function listsPages(section: AdminNavSection): boolean {
        return !collapsed && section.id !== 'settings' && section.pages.length > 1;
    }

    // At most one flyout at a time. A mouse hover opens it after a short
    // intent delay (sweeping past Settings must not throw a wide panel over the
    // page); leaving closes it after a grace period so the pointer can cross
    // the gap into the panel. A chevron click or keyboard open PINS it: the
    // pointer leaving no longer closes it (Esc, a second click, focus moving
    // elsewhere or a click outside the row do).
    let flyoutId = $state<string | null>(null);
    let flyoutPinned = false;
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    // Focus moved back to a section link by Esc must not reopen its flyout.
    let suppressFocusOpen = false;
    // A click focuses the rail link too; only KEYBOARD focus opens the panel.
    let pointerPressAt = 0;
    const rows: Record<string, HTMLLIElement | undefined> = $state({});

    function clearTimers(): void {
        clearTimeout(openTimer);
        clearTimeout(closeTimer);
    }
    function openFlyout(id: string, pin = false): void {
        clearTimers();
        if (flyoutId !== id) flyoutPinned = false;
        flyoutPinned ||= pin;
        flyoutId = id;
    }
    function closeFlyout(): void {
        clearTimers();
        flyoutPinned = false;
        flyoutId = null;
        // A link hidden under the pointer never gets its pointerleave.
        adminNavHover.clear();
    }
    function toggleFlyoutPin(id: string): void {
        if (flyoutId === id && flyoutPinned) closeFlyout();
        else openFlyout(id, true);
    }
    /** Keyboard focus sits inside the open panel (not just on its row link). */
    function focusInsidePanel(): boolean {
        const panel = flyoutId ? document.getElementById(`admin-nav-flyout-${flyoutId}`) : null;
        return !!panel?.contains(document.activeElement);
    }
    function handleRowPointerEnter(event: PointerEvent, id: string): void {
        if (event.pointerType !== 'mouse') return;
        clearTimeout(closeTimer);
        // Never swap away a panel the keyboard is working in.
        if (flyoutId === id || focusInsidePanel()) return;
        clearTimeout(openTimer);
        openTimer = setTimeout(() => openFlyout(id), HOVER_OPEN_DELAY_MS);
    }
    function handleRowPointerLeave(event: PointerEvent, id: string): void {
        if (event.pointerType !== 'mouse') return;
        clearTimeout(openTimer);
        if (flyoutPinned || flyoutId !== id) return;
        clearTimeout(closeTimer);
        closeTimer = setTimeout(() => {
            if (flyoutId === id && !flyoutPinned && !focusInsidePanel()) closeFlyout();
        }, HOVER_CLOSE_DELAY_MS);
    }
    function sectionLink(id: string): HTMLAnchorElement | null {
        return rows[id]?.querySelector<HTMLAnchorElement>('a.section-row') ?? null;
    }
    function focusSectionLink(id: string): void {
        suppressFocusOpen = true;
        sectionLink(id)?.focus();
        suppressFocusOpen = false;
    }
    function handleSectionFocus(section: AdminNavSection): void {
        if (suppressFocusOpen || !collapsed || !usesFlyout(section)) return;
        if (Date.now() - pointerPressAt < 500) return;
        openFlyout(section.id);
    }
    function handleRowFocusOut(event: FocusEvent, id: string): void {
        const next = event.relatedTarget as Node | null;
        // null = focus went nowhere focusable (panel padding, window blur):
        // keep the panel; a click outside closes it (effect below).
        if (!next || flyoutId !== id) return;
        if (!rows[id]?.contains(next)) closeFlyout();
    }
    async function handleRowKeydown(event: KeyboardEvent, section: AdminNavSection): Promise<void> {
        if (!usesFlyout(section)) return;
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const id = section.id;
        const target = event.target as HTMLElement;
        const links = [
            ...(rows[id]?.querySelectorAll<HTMLAnchorElement>('[data-flyout-link]') ?? []),
        ];
        const index = links.indexOf(target as HTMLAnchorElement);
        // Arrows open the panel from the rail link or the chevron only; on the
        // full sidebar a focused section link keeps normal page scrolling.
        const isOpener =
            target.classList.contains('chevron-btn') ||
            (collapsed && target.classList.contains('section-row'));
        if (event.key === 'Escape' && flyoutId === id) {
            event.preventDefault();
            event.stopPropagation();
            closeFlyout();
            // From inside the panel, return to its opener: the chevron on the
            // full sidebar (Settings), the section link on the rail.
            if (index >= 0) {
                const chevron = rows[id]?.querySelector<HTMLElement>('.chevron-btn');
                if (chevron) chevron.focus();
                else focusSectionLink(id);
            }
        } else if (isOpener && (event.key === 'ArrowDown' || event.key === 'ArrowRight')) {
            event.preventDefault();
            openFlyout(id, true);
            await tick();
            links[0]?.focus();
        } else if (index >= 0) {
            let next: HTMLElement | undefined;
            if (event.key === 'ArrowDown') next = links[Math.min(index + 1, links.length - 1)];
            else if (event.key === 'ArrowUp')
                next = index === 0 ? (sectionLink(id) ?? undefined) : links[index - 1];
            else if (event.key === 'Home') next = links[0];
            else if (event.key === 'End') next = links[links.length - 1];
            else if (event.key === 'ArrowLeft' && section.id !== 'settings') {
                // Single-column (rail) panels only: in Settings' three columns
                // Left must not throw the whole panel away.
                event.preventDefault();
                closeFlyout();
                focusSectionLink(id);
                return;
            }
            if (!next) return;
            event.preventDefault();
            if (next === sectionLink(id)) focusSectionLink(id);
            else next.focus();
        }
    }

    // A pointer press outside the open flyout's row closes it, and Esc closes
    // it from anywhere (a hover-opened panel while focus is elsewhere).
    $effect(() => {
        const id = flyoutId;
        if (!id) return;
        const onPointerDown = (event: PointerEvent): void => {
            if (!rows[id]?.contains(event.target as Node)) closeFlyout();
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            if (rows[id]?.contains(document.activeElement)) return; // the row handles it
            closeFlyout();
        };
        // Keyboard focus landing anywhere outside the row (a relatedTarget-less
        // focusout leaves the panel open until this).
        const onFocusIn = (event: FocusEvent): void => {
            if (!rows[id]?.contains(event.target as Node)) closeFlyout();
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('focusin', onFocusIn);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('focusin', onFocusIn);
        };
    });

    // Navigating (or switching rail/full) closes any flyout.
    $effect(() => {
        void pathname;
        void collapsed;
        closeFlyout();
    });
    $effect(() => clearTimers);

    // Keep the current page visible inside a long sidebar: scroll only the
    // sidebar's own list, never the window.
    let groupsEl = $state<HTMLElement>();
    $effect(() => {
        void winnerPath;
        void collapsed;
        void tick().then(() => {
            const list = groupsEl;
            const link = list?.querySelector<HTMLElement>('.page-link[aria-current="page"]');
            if (!list || !link) return;
            const top = link.offsetTop - list.offsetTop;
            if (top < list.scrollTop) list.scrollTop = top;
            else if (top + link.offsetHeight > list.scrollTop + list.clientHeight) {
                list.scrollTop = top + link.offsetHeight - list.clientHeight;
            }
        });
    });
</script>

<nav class="admin-sidebar" class:collapsed aria-label={m.admin_nav_label()}>
    {#if navPins.length > 0}
        <div class="pinned-group">
            {#if !collapsed}
                <div class="pinned-heading">{m.admin_nav_pinned_heading()}</div>
            {/if}
            <ul class="pinned-list">
                {#each navPins as pin (pin.href)}
                    {@const active = isPinActive(pathname, pin)}
                    <!-- The page's own icon: in the collapsed rail, identical pin
                         glyphs left several pins indistinguishable without hovering. -->
                    {@const pageIcon = (adminPageIcons as Record<string, IconSource | undefined>)[
                        pin.href.split('?')[0].replace(/\/$/, '')
                    ]}
                    <li>
                        <a
                            href={resolve(pin.href)}
                            class="section-row pin-row"
                            class:section-active={active}
                            title={collapsed ? pin.label : undefined}
                            aria-label={pin.label}
                            aria-current={active ? 'page' : undefined}>
                            <span class="row-icon">
                                {#if pageIcon}
                                    <Icon src={pageIcon} class="w-4 h-4 pin-icon" />
                                {:else}
                                    <svg
                                        class="w-4 h-4 pin-icon"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="2"
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        aria-hidden="true">
                                        <path d="M12 17v5" />
                                        <path d="M9 2h6l-1 7h4l-1.5 4H7.5L6 9h4z" />
                                    </svg>
                                {/if}
                            </span>
                            {#if !collapsed}
                                <span class="row-label pin-label">{pin.label}</span>
                            {/if}
                        </a>
                    </li>
                {/each}
            </ul>
        </div>
    {/if}
    <div class="section-groups" bind:this={groupsEl}>
        {#each groups.filter((group) => group.sections.length > 0) as group (group.id)}
            <div class="nav-group">
                {#if !collapsed}<h2 class="group-heading">{group.label}</h2>{/if}
                <ul class="section-list">
                    {#each group.sections as section (section.id)}
                        {@const active = sectionActive(section)}
                        {@const dot = sectionDot(section.id)}
                        {@const landing = sectionLanding(section)}
                        {@const attentionCount = dot.show ? sectionAttentionCount(section.id) : 0}
                        {@const dotTooltip = dot.show
                            ? m.admin_attention_section_nav_tooltip({ count: attentionCount })
                            : dot.label}
                        {@const pageDots = dot.show ? pageAttentionDots(section) : {}}
                        {@const flyout = usesFlyout(section)}
                        {@const listed = listsPages(section)}
                        {@const pagesOpen =
                            listed && (active || adminNavPrefs.isExpanded(section.id))}
                        {@const listId = `admin-nav-pages-${section.id}`}
                        {@const flyoutDomId = `admin-nav-flyout-${section.id}`}
                        <!-- The row hosts hover and arrow/Esc handling for its links
                             and flyout; every target inside is a real link or button. -->
                        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                        <li
                            bind:this={rows[section.id]}
                            onpointerenter={flyout
                                ? (event) => handleRowPointerEnter(event, section.id)
                                : undefined}
                            onpointerleave={flyout
                                ? (event) => handleRowPointerLeave(event, section.id)
                                : undefined}
                            onfocusout={flyout
                                ? (event) => handleRowFocusOut(event, section.id)
                                : undefined}
                            onpointerdown={flyout ? () => (pointerPressAt = Date.now()) : undefined}
                            onkeydown={flyout
                                ? (event) => void handleRowKeydown(event, section)
                                : undefined}>
                            <div class="row-wrap" class:section-active={active}>
                                <a
                                    href={resolve(landing)}
                                    class="section-row"
                                    class:section-dev={section.devOnly}
                                    title={collapsed
                                        ? `${section.title()}${dot.show ? ` — ${dotTooltip}` : ''}`
                                        : section.title()}
                                    aria-label={collapsed ? section.title() : undefined}
                                    aria-expanded={collapsed && flyout
                                        ? flyoutId === section.id
                                        : undefined}
                                    aria-controls={collapsed && flyout ? flyoutDomId : undefined}
                                    aria-current={active
                                        ? section.pages.length > 1
                                            ? 'true'
                                            : 'page'
                                        : undefined}
                                    onfocus={() => handleSectionFocus(section)}>
                                    <span class="row-icon">
                                        <Icon src={section.icon} class="w-5 h-5" />
                                        {#if dot.show}
                                            <span
                                                class="dot dot-rail {dot.colorClass}"
                                                aria-hidden="true"></span>
                                        {/if}
                                    </span>
                                    {#if !collapsed}
                                        <span class="row-label">{section.title()}</span>
                                        {#if dot.show}
                                            <span
                                                class="status-count {dot.colorClass}"
                                                title={dotTooltip}
                                                aria-label={dotTooltip}
                                                >{attentionCount > 99
                                                    ? '99+'
                                                    : attentionCount}</span>
                                        {/if}
                                    {/if}
                                </a>
                                {#if !collapsed}
                                    {#if listed && !active}
                                        <button
                                            type="button"
                                            class="chevron-btn"
                                            class:chevron-open={pagesOpen}
                                            aria-expanded={pagesOpen}
                                            aria-controls={listId}
                                            aria-label={pagesOpen
                                                ? m.admin_nav_hide_pages({
                                                      section: section.title(),
                                                  })
                                                : m.admin_nav_show_pages({
                                                      section: section.title(),
                                                  })}
                                            title={pagesOpen
                                                ? m.admin_nav_hide_pages({
                                                      section: section.title(),
                                                  })
                                                : m.admin_nav_show_pages({
                                                      section: section.title(),
                                                  })}
                                            onclick={() =>
                                                adminNavPrefs.toggleExpanded(section.id)}>
                                            <Icon src={ChevronRight} class="w-3.5 h-3.5" />
                                        </button>
                                    {:else if flyout}
                                        <button
                                            type="button"
                                            class="chevron-btn"
                                            aria-expanded={flyoutId === section.id}
                                            aria-controls={flyoutDomId}
                                            aria-label={flyoutId === section.id
                                                ? m.admin_nav_hide_pages({
                                                      section: section.title(),
                                                  })
                                                : m.admin_nav_show_pages({
                                                      section: section.title(),
                                                  })}
                                            title={flyoutId === section.id
                                                ? m.admin_nav_hide_pages({
                                                      section: section.title(),
                                                  })
                                                : m.admin_nav_show_pages({
                                                      section: section.title(),
                                                  })}
                                            onclick={() => toggleFlyoutPin(section.id)}>
                                            <Icon src={ChevronRight} class="w-3.5 h-3.5" />
                                        </button>
                                    {:else}
                                        <span class="chevron-spacer" aria-hidden="true"></span>
                                    {/if}
                                {/if}
                            </div>
                            {#if listed}
                                <ul id={listId} class="page-list" hidden={!pagesOpen}>
                                    {#each section.pages as p (p.path)}
                                        {@const isCurrent = p.path === winnerPath}
                                        {@const pageDot = pageDots[p.path]}
                                        <li>
                                            <a
                                                href={resolve(p.path)}
                                                class="page-link"
                                                class:page-active={isCurrent}
                                                class:page-dev={p.devOnly}
                                                class:linked-hover={adminNavHover.path === p.path}
                                                title={p.title()}
                                                onpointerenter={() => adminNavHover.enter(p.path)}
                                                onpointerleave={() => adminNavHover.leave(p.path)}
                                                aria-current={isCurrent ? 'page' : undefined}>
                                                <span class="page-label">{p.title()}</span>
                                                {#if p.enterpriseOnly}
                                                    <EnterpriseBadge compact />
                                                {/if}
                                                {#if pageDot?.show}
                                                    <span
                                                        class="page-dot {pageDot.colorClass}"
                                                        aria-hidden="true"></span>
                                                    <span class="sr-only">, {pageDot.label}</span>
                                                {/if}
                                            </a>
                                        </li>
                                    {/each}
                                </ul>
                            {/if}
                            {#if flyout}
                                <AdminNavFlyout
                                    id={flyoutDomId}
                                    {section}
                                    open={flyoutId === section.id}
                                    activePath={winnerPath}
                                    dots={pageDots}
                                    anchor={rows[section.id]} />
                            {/if}
                        </li>
                    {/each}
                </ul>
            </div>
        {/each}
    </div>

    <button
        type="button"
        class="collapse-btn"
        onclick={() => adminNavPrefs.toggleCollapsed()}
        aria-label={collapsed ? m.admin_nav_expand() : m.admin_nav_collapse()}
        title={collapsed ? m.admin_nav_expand() : m.admin_nav_collapse()}>
        <Icon src={collapsed ? ChevronDoubleRight : ChevronDoubleLeft} class="w-4 h-4" />
        {#if !collapsed}
            <span class="collapse-label">{m.admin_nav_collapse()}</span>
        {/if}
    </button>
</nav>

<style>
    .admin-sidebar {
        display: flex;
        flex-direction: column;
        width: 236px;
        flex-shrink: 0;
        align-self: flex-start;
        position: sticky;
        /* No global navbar to clear: the admin shell hides it (app.html). */
        top: 1rem;
        max-height: calc(100vh - 2rem);
        padding: 0.5rem;
        /* Visually distinct surface tone from the global dock. */
        background: rgb(24 31 44 / 0.85);
        border: 1px solid rgb(55 65 81 / 0.5);
        border-radius: 0.75rem;
        transition: width 150ms ease;
        /* Sticky makes the sidebar its own stacking context, so the flyouts'
           z-index only counts inside it: lift the whole sidebar above page
           content (positioned setting inputs, cards), below header menus (60+). */
        z-index: 30;
    }
    .admin-sidebar.collapsed {
        width: 60px;
    }
    /* Safety net for the width transition: hide label text via CSS the
       instant `.collapsed` is applied, rather than relying solely on the
       {#if !collapsed} block to remove it — otherwise a label can still be
       mounted for a frame while the rail is already narrower, truncating
       ("OPERA", "Collapse navi…") instead of disappearing. */
    .admin-sidebar.collapsed .row-label,
    .admin-sidebar.collapsed .pin-label,
    .admin-sidebar.collapsed .group-heading,
    .admin-sidebar.collapsed .pinned-heading,
    .admin-sidebar.collapsed .collapse-label,
    .admin-sidebar.collapsed .status-count {
        display: none;
    }

    .section-list {
        display: flex;
        flex-direction: column;
        gap: 0.125rem;
    }

    .section-groups {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
    }
    .nav-group + .nav-group {
        margin-top: 0.75rem;
        padding-top: 0.75rem;
        border-top: 1px solid rgb(55 65 81 / 0.4);
    }
    .group-heading {
        margin: 0;
        padding: 0.4rem 0.625rem;
        font-size: 0.625rem;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: rgb(156 163 175);
    }
    .section-row:focus-visible,
    .chevron-btn:focus-visible,
    .page-link:focus-visible {
        outline: 2px solid rgb(129 140 248);
        outline-offset: -2px;
    }

    /* Restored per-user "quick menu" pins — visually lighter than sections. */
    .pinned-group {
        flex-shrink: 0;
        padding-bottom: 0.375rem;
        margin-bottom: 0.375rem;
        border-bottom: 1px solid rgb(55 65 81 / 0.4);
    }
    .pinned-heading {
        padding: 0.25rem 0.625rem 0.125rem;
        font-size: 0.625rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: rgb(107 114 128); /* surface-500, dimmer than section headings */
    }
    .pinned-list {
        display: flex;
        flex-direction: column;
        gap: 0.125rem;
    }
    .pin-row {
        padding: 0.375rem 0.625rem;
    }
    .pin-label {
        font-size: 0.75rem;
        font-weight: 400;
        color: rgb(156 163 175); /* surface-400, lighter weight than section rows */
    }
    :global(.pin-icon) {
        opacity: 0.7;
    }

    .row-wrap {
        display: flex;
        align-items: center;
        border-radius: 0.5rem;
    }
    .section-row {
        display: flex;
        flex: 1;
        min-width: 0;
        align-items: center;
        gap: 0.625rem;
        padding: 0.5rem 0.625rem;
        border-radius: 0.5rem;
        text-decoration: none;
        color: rgb(209 213 219); /* surface-300 */
        transition: all 120ms ease;
    }
    .section-row:hover {
        background: rgb(55 65 81 / 0.5);
        color: white;
    }
    /* Pin rows carry the active class on the link itself; sections on the wrap. */
    .section-active {
        background: rgb(99 102 241 / 0.15);
        box-shadow: inset 2px 0 rgb(129 140 248);
    }
    .section-active,
    .section-active .section-row {
        color: rgb(199 210 254);
    }
    .chevron-btn,
    .chevron-spacer {
        display: flex;
        flex-shrink: 0;
        width: 1.625rem;
        height: 1.625rem;
        align-items: center;
        justify-content: center;
    }
    .chevron-btn {
        border: none;
        border-radius: 0.375rem;
        background: transparent;
        color: rgb(107 114 128); /* surface-500 */
        cursor: pointer;
    }
    .chevron-btn:hover,
    .chevron-btn[aria-expanded='true'] {
        background: rgb(55 65 81 / 0.5);
        color: rgb(229 231 235);
    }
    .chevron-open :global(svg) {
        transform: rotate(90deg);
    }

    /* A section's pages, indented under its row. */
    .page-list {
        display: flex;
        flex-direction: column;
        gap: 0.0625rem;
        margin: 0.125rem 0 0.375rem 1.25rem;
        padding-left: 0.625rem;
        border-left: 1px solid rgb(75 85 99 / 0.6);
    }
    .page-list[hidden] {
        display: none;
    }
    .page-link {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.3125rem 0.625rem;
        border-radius: 0.375rem;
        font-size: 0.78125rem;
        color: rgb(156 163 175); /* surface-400 */
        text-decoration: none;
    }
    .page-link:hover,
    .page-link.linked-hover {
        background: rgb(55 65 81 / 0.4);
        color: rgb(229 231 235);
    }
    .page-active {
        background: rgb(99 102 241 / 0.18);
        color: rgb(224 231 255);
        font-weight: 500;
    }
    .page-dev .page-label {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.75rem;
        color: rgb(129 140 248); /* indigo-400 */
    }
    .page-label {
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .page-dot {
        width: 0.4375rem;
        height: 0.4375rem;
        border-radius: 9999px;
        flex-shrink: 0;
    }
    @media (prefers-reduced-motion: no-preference) {
        .page-list:not([hidden]) {
            animation: page-list-in 140ms ease-out;
        }
        .chevron-btn :global(svg) {
            transition: transform 140ms ease;
        }
    }
    @keyframes page-list-in {
        from {
            opacity: 0;
            transform: translateY(-0.25rem);
        }
    }
    /* Developer section renders muted/mono (spec §3.7). */
    .section-dev .row-label {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.75rem;
        color: rgb(129 140 248); /* indigo-400 */
    }
    .section-active .section-dev .row-label {
        color: rgb(165 180 252); /* indigo-300 */
    }

    .row-icon {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
    }
    .row-label {
        flex: 1;
        min-width: 0;
        font-size: 0.8125rem;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .dot {
        width: 0.5rem;
        height: 0.5rem;
        border-radius: 9999px;
        flex-shrink: 0;
    }
    .status-count {
        display: inline-flex;
        min-width: 1.125rem;
        height: 1.125rem;
        align-items: center;
        justify-content: center;
        padding: 0 0.25rem;
        border-radius: 9999px;
        color: rgb(17 24 39);
        font-size: 0.625rem;
        font-weight: 700;
        line-height: 1;
    }
    /* When collapsed the dot rides the icon corner. */
    .dot-rail {
        position: absolute;
        top: -2px;
        right: -2px;
        width: 0.5rem;
        height: 0.5rem;
        border: 1px solid rgb(24 31 44);
    }

    .collapse-btn {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-top: 0.5rem;
        padding: 0.5rem 0.625rem;
        border: none;
        border-top: 1px solid rgb(55 65 81 / 0.5);
        border-radius: 0;
        background: transparent;
        color: rgb(107 114 128); /* surface-500 */
        font-size: 0.75rem;
        cursor: pointer;
        transition: color 120ms ease;
    }
    .collapse-btn:hover {
        color: rgb(209 213 219);
    }
    .collapse-label {
        white-space: nowrap;
    }
</style>
