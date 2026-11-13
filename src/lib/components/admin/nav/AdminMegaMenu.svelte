<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Admin mega-menu renderer (admin IA redesign, spec §4 Renderer B). Refactor of
  the old Browse dropdown to consume the ONE nav manifest: the top bar shows the
  section names as quick tabs (replacing the old arbitrary Dashboard/Sessions/
  Media/Tasks subset); the Browse panel shows one column per section with status
  dots inline. Developer entries render muted/mono.
-->
<script lang="ts">
    import { browser } from '$app/environment';
    import { onDestroy, onMount } from 'svelte';
    import { page } from '$app/stores';
    import { resolve } from '$lib/paths';
    import { Icon, type IconSource } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import type { AdminNavSection } from '$lib/config/admin-nav.js';
    import { sectionDot } from './nav-status.js';
    import ModuleBadge from './ModuleBadge.svelte';
    import {
        resolveActiveNavPath,
        resolveSectionLandingPath,
        lastSectionPageStorageKey,
        isPinActive,
        type AdminNavPin,
    } from '../admin-nav.utils.js';

    interface Props {
        /** Already gate-filtered sections (from `visibleNav`). */
        sections: AdminNavSection[];
    }
    let { sections }: Props = $props();

    let currentPath = $derived($page.url.pathname);

    // Per-user "quick menu" pins (AdminPageHeader's pin button), loaded once
    // in the admin layout. Orphaned by the IA redesign — restored here.
    let navPins = $derived(($page.data?.navPins as AdminNavPin[] | undefined) ?? []);

    // Remembered last-visited page per section (feature: "remember last
    // sub-page"). Starts empty so SSR and the first client render both use
    // each section's default landing page — avoiding a hydration mismatch —
    // then swaps in the remembered path client-side once mounted.
    let lastPagePaths = $state<Record<string, string | null>>({});

    // Storage can throw (blocked site data, Safari private mode) — never let that
    // take the admin shell down.
    function readStorage(key: string): string | null {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    }
    function writeStorage(key: string, value: string): void {
        try {
            localStorage.setItem(key, value);
        } catch {
            // expected: storage blocked or full — the pin just isn't remembered
        }
    }
    $effect(() => {
        if (!browser) return;
        const map: Record<string, string | null> = {};
        for (const section of sections) {
            map[section.id] = readStorage(lastSectionPageStorageKey(section.id));
        }
        lastPagePaths = map;
    });
    function sectionLanding(section: AdminNavSection): string {
        return resolveSectionLandingPath(section, lastPagePaths[section.id] ?? null);
    }

    // Closed on the server and the first client render (no hydration mismatch);
    // a remembered pin opens the panel once mounted.
    let pinned = $state(false);
    let megaOpen = $state(false);
    let panelEl = $state<HTMLElement | null>(null);
    onMount(() => {
        pinned = readStorage('admin-nav-pinned') === 'true';
        megaOpen = pinned;
    });
    let hoverTimeout: ReturnType<typeof setTimeout> | null = null;
    let closeTimeout: ReturnType<typeof setTimeout> | null = null;

    function showMega(): void {
        if (pinned) return;
        if (closeTimeout) {
            clearTimeout(closeTimeout);
            closeTimeout = null;
        }
        hoverTimeout = setTimeout(() => {
            megaOpen = true;
        }, 80);
    }
    function hideMega(): void {
        if (pinned) return;
        if (hoverTimeout) {
            clearTimeout(hoverTimeout);
            hoverTimeout = null;
        }
        closeTimeout = setTimeout(() => {
            megaOpen = false;
        }, 200);
    }
    function closeMega(): void {
        if (pinned) return;
        megaOpen = false;
    }
    function togglePin(): void {
        pinned = !pinned;
        if (browser) writeStorage('admin-nav-pinned', String(pinned));
        megaOpen = pinned;
    }

    onDestroy(() => {
        if (hoverTimeout) clearTimeout(hoverTimeout);
        if (closeTimeout) clearTimeout(closeTimeout);
    });

    function handleKeydown(e: KeyboardEvent): void {
        if (e.key !== 'Escape' || e.defaultPrevented || !megaOpen) return;
        // A pinned panel is a saved preference: only un-pin when Esc is pressed
        // inside it, not when it closes the palette, a modal or another menu.
        if (pinned) {
            if (panelEl?.contains(document.activeElement)) togglePin();
            return;
        }
        closeMega();
    }

    function sectionActive(section: AdminNavSection): boolean {
        return section.pages.some((p) =>
            p.path === '/admin'
                ? currentPath === '/admin'
                : currentPath === p.path || currentPath.startsWith(p.path + '/'),
        );
    }
    // The ONE winning page path across every visible page in every section —
    // computed once so exactly one mega-item (the longest match) renders
    // active, instead of each item independently prefix-matching (which
    // double-lit parent + nested-sibling pages, e.g. Users + Active sessions).
    let winnerPath = $derived(
        resolveActiveNavPath(
            currentPath,
            sections.flatMap((s) => s.pages.map((p) => p.path)),
        ),
    );
    function pageActive(path: string): boolean {
        return path === winnerPath;
    }

    let anySectionActive = $derived(sections.some(sectionActive));
    let browseHighlight = $derived(!anySectionActive || megaOpen);

    // Type helper so `section.icon` reads cleanly as an IconSource in markup.
    const icon = (src: IconSource): IconSource => src;
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="admin-nav-root">
    <nav class="nav-bar">
        <!-- Primary: Browse button (mega-menu trigger) -->
        <button
            type="button"
            class="browse-btn"
            class:browse-btn-active={browseHighlight}
            aria-expanded={megaOpen}
            aria-controls="admin-mega-panel"
            onmouseenter={showMega}
            onmouseleave={hideMega}
            onclick={() => {
                if (pinned) togglePin();
                else megaOpen = !megaOpen;
            }}>
            <svg
                class="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="2">
                <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            </svg>
            {m.admin_nav_label()}
            <svg
                class="w-3 h-3 chevron"
                class:chevron-open={megaOpen}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
        </button>

        {#if navPins.length > 0}
            <!-- Restored per-user "quick menu" pins (orphaned by the IA
                 redesign) — a compact row of pill links before the sections. -->
            <div class="pinned-links" aria-label={m.admin_nav_pinned_heading()}>
                {#each navPins as pin (pin.href)}
                    {@const active = isPinActive(currentPath, pin)}
                    <a
                        href={resolve(pin.href)}
                        class="pinned-link"
                        class:pinned-link-active={active}
                        onclick={closeMega}>
                        {pin.label}
                    </a>
                {/each}
            </div>
        {/if}

        <!-- Secondary: the section names as quick tabs -->
        <div class="quick-links">
            {#each sections as section (section.id)}
                {@const active = sectionActive(section)}
                {@const dot = sectionDot(section.id)}
                <a
                    href={resolve(sectionLanding(section))}
                    class="quick-link"
                    class:quick-link-active={active}
                    class:quick-link-dev={section.devOnly}
                    onclick={closeMega}>
                    <Icon src={icon(section.icon)} class="w-3.5 h-3.5" />
                    {section.title()}
                    {#if dot.show}
                        <span class="dot {dot.colorClass}" title={dot.label} aria-label={dot.label}
                        ></span>
                    {/if}
                </a>
            {/each}
        </div>
    </nav>

    <div class="nav-border"></div>

    {#if megaOpen}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
            id="admin-mega-panel"
            bind:this={panelEl}
            class="mega-panel"
            class:mega-panel-pinned={pinned}
            onmouseenter={showMega}
            onmouseleave={hideMega}>
            <button
                type="button"
                class="pin-btn"
                class:pin-btn-active={pinned}
                onclick={togglePin}
                title={pinned ? m.admin_nav_unpin() : m.admin_nav_pin()}
                aria-label={pinned ? m.admin_nav_unpin() : m.admin_nav_pin()}>
                <svg
                    class="pin-icon"
                    class:pin-icon-pinned={pinned}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round">
                    <path d="M12 17v5" />
                    <path d="M9 2h6l-1 7h4l-1.5 4H7.5L6 9h4z" />
                </svg>
            </button>
            <div class="mega-grid">
                {#each sections as section (section.id)}
                    {@const dot = sectionDot(section.id)}
                    <div class="mega-column">
                        <h3 class="mega-group-title" class:mega-group-dev={section.devOnly}>
                            <Icon src={icon(section.icon)} class="w-3.5 h-3.5 opacity-50" />
                            {section.title()}
                            {#if dot.show}
                                <span
                                    class="dot {dot.colorClass}"
                                    title={dot.label}
                                    aria-label={dot.label}></span>
                            {/if}
                        </h3>
                        <ul class="mega-list">
                            {#each section.pages as item (item.path)}
                                <li>
                                    <a
                                        href={resolve(item.path)}
                                        onclick={closeMega}
                                        class="mega-item"
                                        class:mega-item-active={pageActive(item.path)}
                                        class:mega-item-dev={item.devOnly}>
                                        {#if item.icon}
                                            <Icon src={icon(item.icon)} class="mega-item-icon" />
                                        {/if}
                                        <div class="mega-item-text">
                                            <span class="mega-item-titlerow">
                                                <span class="mega-item-label">{item.title()}</span>
                                                {#if item.privateModule}
                                                    <ModuleBadge compact />
                                                {/if}
                                            </span>
                                            {#if item.description}
                                                <span class="mega-item-desc"
                                                    >{item.description()}</span>
                                            {/if}
                                        </div>
                                    </a>
                                </li>
                            {/each}
                        </ul>
                    </div>
                {/each}
            </div>
        </div>
    {/if}
</div>

<!-- svelte-ignore a11y_no_static_element_interactions -->
{#if megaOpen && !pinned}
    <div class="click-outside-overlay" onclick={closeMega} onkeydown={handleKeydown}></div>
{/if}

<style>
    .admin-nav-root {
        position: relative;
        z-index: 50;
        margin-bottom: 1.5rem;
    }
    .nav-bar {
        display: flex;
        align-items: center;
        gap: 0.25rem;
        flex-wrap: wrap;
    }
    .nav-border {
        height: 1px;
        background: rgb(55 65 81 / 0.6);
    }
    .browse-btn {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 0.875rem;
        margin-bottom: -1px;
        font-size: 0.8125rem;
        font-weight: 600;
        color: rgb(209 213 219);
        background: rgb(55 65 81 / 0.3);
        border: 1px solid rgb(55 65 81 / 0.5);
        border-bottom-color: transparent;
        border-radius: 0.5rem 0.5rem 0 0;
        cursor: pointer;
        transition: all 150ms ease;
        user-select: none;
    }
    .browse-btn:hover {
        color: white;
        background: rgb(55 65 81 / 0.5);
        border-color: rgb(75 85 99 / 0.6);
        border-bottom-color: transparent;
    }
    .browse-btn-active {
        color: rgb(250 204 21);
        background: rgb(31 41 55 / 0.98);
        border-color: rgb(55 65 81 / 0.8);
        border-bottom-color: rgb(31 41 55 / 0.98);
    }
    .chevron {
        transition: transform 200ms ease;
        opacity: 0.5;
    }
    .chevron-open {
        transform: rotate(180deg);
        opacity: 0.8;
    }
    /* Restored per-user "quick menu" pins — visually lighter than the
       section quick-links (smaller, dimmer, no icon/dot). */
    .pinned-links {
        display: flex;
        align-items: center;
        gap: 0.125rem;
        margin-left: 0.75rem;
        padding-right: 0.75rem;
        border-right: 1px solid rgb(55 65 81 / 0.5);
        flex-wrap: wrap;
    }
    .pinned-link {
        padding: 0.3125rem 0.5rem;
        font-size: 0.6875rem;
        font-weight: 400;
        color: rgb(107 114 128);
        border-radius: 0.375rem;
        text-decoration: none;
        transition: all 120ms ease;
    }
    .pinned-link:hover {
        color: rgb(209 213 219);
        background: rgb(55 65 81 / 0.25);
    }
    .pinned-link-active {
        color: rgb(250 204 21);
    }
    .quick-links {
        display: flex;
        align-items: center;
        gap: 0.125rem;
        margin-left: 0.75rem;
        flex-wrap: wrap;
    }
    .quick-link {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        padding: 0.375rem 0.625rem;
        font-size: 0.75rem;
        font-weight: 500;
        color: rgb(107 114 128);
        border-radius: 0.375rem;
        text-decoration: none;
        transition: all 120ms ease;
    }
    .quick-link:hover {
        color: rgb(209 213 219);
        background: rgb(55 65 81 / 0.25);
    }
    .quick-link-active {
        color: rgb(250 204 21);
    }
    .quick-link-active:hover {
        color: rgb(253 224 71);
    }
    .quick-link-dev {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        color: rgb(129 140 248);
    }
    .mega-panel {
        position: absolute;
        top: 100%;
        left: -1rem;
        right: -1rem;
        padding: 1.25rem 1.5rem 1.5rem;
        background: rgb(31 41 55 / 0.98);
        backdrop-filter: blur(12px);
        border: 1px solid rgb(55 65 81 / 0.8);
        border-top: none;
        border-radius: 0 0 0.75rem 0.75rem;
        box-shadow:
            0 20px 40px -8px rgb(0 0 0 / 0.5),
            0 8px 16px -4px rgb(0 0 0 / 0.3);
        animation: mega-enter 150ms ease-out forwards;
        z-index: 50;
    }
    .mega-panel-pinned {
        position: relative;
        top: auto;
        left: auto;
        right: auto;
        border-radius: 0 0 0.75rem 0.75rem;
        box-shadow: none;
        animation: none;
    }
    .pin-btn {
        position: absolute;
        top: 0.75rem;
        right: 1rem;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 1.75rem;
        height: 1.75rem;
        padding: 0;
        border: 1px solid rgb(55 65 81 / 0.5);
        border-radius: 0.375rem;
        background: rgb(55 65 81 / 0.3);
        color: rgb(156 163 175);
        cursor: pointer;
        transition: all 150ms ease;
        z-index: 1;
    }
    .pin-btn:hover {
        color: rgb(209 213 219);
        background: rgb(55 65 81 / 0.5);
        border-color: rgb(75 85 99 / 0.6);
    }
    .pin-btn-active {
        color: rgb(250 204 21);
        background: rgb(234 179 8 / 0.1);
        border-color: rgb(234 179 8 / 0.3);
    }
    .pin-icon {
        width: 0.875rem;
        height: 0.875rem;
        transition: transform 200ms ease;
        transform: rotate(45deg);
    }
    .pin-icon-pinned {
        transform: rotate(0deg);
    }
    .mega-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: 1.5rem;
    }
    .mega-column {
        min-width: 0;
    }
    .mega-group-title {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        font-size: 0.6875rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgb(156 163 175);
        padding-bottom: 0.5rem;
        margin-bottom: 0.375rem;
        border-bottom: 1px solid rgb(55 65 81 / 0.5);
    }
    .mega-group-dev {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        color: rgb(129 140 248);
    }
    .mega-list {
        display: flex;
        flex-direction: column;
        gap: 0.125rem;
    }
    .mega-item {
        display: flex;
        align-items: flex-start;
        gap: 0.625rem;
        padding: 0.5rem 0.625rem;
        border-radius: 0.375rem;
        transition: all 120ms ease;
        text-decoration: none;
    }
    .mega-item:hover {
        background: rgb(55 65 81 / 0.5);
    }
    .mega-item-active {
        background: rgb(234 179 8 / 0.08);
    }
    :global(.mega-item-icon) {
        width: 1rem;
        height: 1rem;
        flex-shrink: 0;
        margin-top: 0.0625rem;
        color: rgb(107 114 128);
        transition: color 120ms;
    }
    .mega-item:hover :global(.mega-item-icon) {
        color: rgb(156 163 175);
    }
    .mega-item-active :global(.mega-item-icon) {
        color: rgb(234 179 8 / 0.6);
    }
    .mega-item-text {
        min-width: 0;
    }
    .mega-item-titlerow {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        min-width: 0;
    }
    .mega-item-label {
        display: block;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 0.8125rem;
        font-weight: 500;
        color: rgb(229 231 235);
        transition: color 120ms;
    }
    .mega-item:hover .mega-item-label {
        color: white;
    }
    .mega-item-active .mega-item-label {
        color: rgb(250 204 21);
    }
    .mega-item-dev .mega-item-label {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        color: rgb(129 140 248);
    }
    .mega-item-desc {
        display: block;
        font-size: 0.6875rem;
        color: rgb(107 114 128);
        margin-top: 0.0625rem;
        line-height: 1.3;
    }
    .mega-item:hover .mega-item-desc {
        color: rgb(156 163 175);
    }
    .dot {
        width: 0.5rem;
        height: 0.5rem;
        border-radius: 9999px;
        flex-shrink: 0;
    }
    @keyframes mega-enter {
        from {
            opacity: 0;
            transform: translateY(-4px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }
    .click-outside-overlay {
        position: fixed;
        inset: 0;
        z-index: 40;
    }
    @media (max-width: 640px) {
        .click-outside-overlay {
            display: none;
        }
        .mega-panel {
            max-height: 70vh;
            overflow-y: auto;
        }
        .mega-grid {
            grid-template-columns: repeat(2, 1fr);
            gap: 1rem;
        }
        .quick-links {
            margin-left: 0.375rem;
        }
        .pin-btn {
            display: none;
        }
    }
</style>
