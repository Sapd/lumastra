<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Mobile admin nav drawer (admin IA redesign, spec §4/§6) — the manifest-driven
  drawer that replaces the header chrome on narrow screens. Sections with their
  pages; status dots on sections; closes on backdrop, ESC or navigation.
-->
<script lang="ts">
    import { page } from '$app/stores';
    import { Icon, XMark } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import type { AdminNavSection } from '$lib/config/admin-nav.js';
    import { sectionDot } from './nav-status.js';
    import EnterpriseBadge from './EnterpriseBadge.svelte';
    import { resolveActiveNavPath, isPinActive, type AdminNavPin } from '../admin-nav.utils.js';

    interface Props {
        sections: AdminNavSection[];
        open: boolean;
        onclose: () => void;
    }
    let { sections, open, onclose }: Props = $props();

    let pathname = $derived($page.url.pathname);

    // Per-user "quick menu" pins (AdminPageHeader's pin button), loaded once
    // in the admin layout. Orphaned by the IA redesign — restored here.
    let navPins = $derived(($page.data?.navPins as AdminNavPin[] | undefined) ?? []);

    // The ONE winning page path across every visible page in every section —
    // computed once so exactly one link (the longest match) renders active,
    // instead of each link independently prefix-matching (which double-lit
    // parent + nested-sibling pages, e.g. Users + Active sessions).
    let winnerPath = $derived(
        resolveActiveNavPath(
            pathname,
            sections.flatMap((s) => s.pages.map((p) => p.path)),
        ),
    );
    function pageActive(path: string): boolean {
        return path === winnerPath;
    }

    function handleKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape') onclose();
    }
</script>

<svelte:window onkeydown={open ? handleKeydown : undefined} />

{#if open}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="drawer-backdrop" onclick={onclose} onkeydown={handleKeydown}></div>
    <nav class="drawer" aria-label={m.admin_nav_label()}>
        <div class="drawer-head">
            <span class="drawer-title">{m.admin_title()}</span>
            <button
                type="button"
                class="drawer-close"
                onclick={onclose}
                aria-label={m.admin_nav_close()}>
                <Icon src={XMark} class="w-5 h-5" />
            </button>
        </div>
        <div class="drawer-body">
            {#if navPins.length > 0}
                <div class="drawer-section drawer-pinned-section">
                    <h3 class="drawer-section-title drawer-pinned-title">
                        <span>{m.admin_nav_pinned_heading()}</span>
                    </h3>
                    <ul>
                        {#each navPins as pin (pin.href)}
                            <li>
                                <a
                                    href={resolve(pin.href)}
                                    class="drawer-link"
                                    class:drawer-link-active={isPinActive(pathname, pin)}
                                    onclick={onclose}>
                                    {pin.label}
                                </a>
                            </li>
                        {/each}
                    </ul>
                </div>
            {/if}
            {#each sections as section (section.id)}
                {@const dot = sectionDot(section.id)}
                <div class="drawer-section" class:drawer-section-dev={section.devOnly}>
                    <h3 class="drawer-section-title">
                        <Icon src={section.icon} class="w-4 h-4 opacity-60" />
                        <span>{section.title()}</span>
                        {#if dot.show}
                            <span
                                class="dot {dot.colorClass}"
                                title={dot.label}
                                aria-label={dot.label}></span>
                        {/if}
                    </h3>
                    <ul>
                        {#each section.pages as p (p.path)}
                            <li>
                                <a
                                    href={resolve(p.path)}
                                    class="drawer-link"
                                    class:drawer-link-active={pageActive(p.path)}
                                    onclick={onclose}>
                                    <span class="drawer-link-label">{p.title()}</span>
                                    {#if p.enterpriseOnly}
                                        <EnterpriseBadge compact />
                                    {/if}
                                </a>
                            </li>
                        {/each}
                    </ul>
                </div>
            {/each}
        </div>
    </nav>
{/if}

<style>
    .drawer-backdrop {
        position: fixed;
        inset: 0;
        z-index: 60;
        background: rgb(0 0 0 / 0.5);
    }
    .drawer {
        position: fixed;
        top: 0;
        left: 0;
        bottom: 0;
        z-index: 61;
        width: min(85vw, 320px);
        display: flex;
        flex-direction: column;
        background: rgb(17 24 39); /* surface-900 */
        border-right: 1px solid rgb(55 65 81 / 0.6);
        box-shadow: 0 12px 40px rgb(0 0 0 / 0.5);
        animation: drawer-in 160ms ease-out;
    }
    @keyframes drawer-in {
        from {
            transform: translateX(-100%);
        }
        to {
            transform: translateX(0);
        }
    }
    .drawer-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 1rem;
        border-bottom: 1px solid rgb(55 65 81 / 0.6);
    }
    .drawer-title {
        font-size: 1rem;
        font-weight: 700;
        color: white;
    }
    .drawer-close {
        display: flex;
        padding: 0.375rem;
        border: none;
        background: transparent;
        color: rgb(156 163 175);
        cursor: pointer;
        border-radius: 0.375rem;
    }
    .drawer-close:hover {
        color: white;
        background: rgb(55 65 81 / 0.5);
    }
    .drawer-body {
        flex: 1;
        overflow-y: auto;
        padding: 0.5rem 0.75rem 1.5rem;
    }
    .drawer-section {
        margin-top: 1rem;
    }
    .drawer-section-title {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.375rem 0.5rem;
        font-size: 0.6875rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: rgb(156 163 175);
    }
    .drawer-section-dev .drawer-section-title span {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        color: rgb(129 140 248);
    }
    /* Restored per-user "quick menu" pins — visually lighter than the
       section headings below it, and sits flush at the top. */
    .drawer-pinned-section {
        margin-top: 0.25rem;
        padding-bottom: 0.5rem;
        border-bottom: 1px solid rgb(55 65 81 / 0.4);
    }
    .drawer-pinned-title {
        font-weight: 500;
        color: rgb(107 114 128); /* surface-500, dimmer than section headings */
    }
    .drawer-link {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 0.75rem 0.5rem 1.75rem;
        font-size: 0.875rem;
        color: rgb(209 213 219);
        text-decoration: none;
        border-radius: 0.375rem;
    }
    .drawer-link-label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .drawer-link:hover {
        background: rgb(55 65 81 / 0.5);
        color: white;
    }
    .drawer-link-active {
        color: rgb(250 204 21);
        background: rgb(234 179 8 / 0.08);
    }
    .dot {
        width: 0.5rem;
        height: 0.5rem;
        border-radius: 9999px;
        flex-shrink: 0;
    }
</style>
