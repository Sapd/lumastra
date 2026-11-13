<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Sub-page navigation for the active admin section. Links wrap on desktop;
  a native page selector keeps every destination reachable on narrow screens.
  Takes the already-gated section list. With the sidebar style expanded on
  desktop the sidebar lists the section's pages itself, so the row hides from
  1280px up — the width below which the layout forces the rail anyway, so SSR
  and first paint at 1024–1279px already show the row instead of popping it in. Settings keeps its own
  area nav either way: the sidebar only offers it as a flyout.
-->
<script lang="ts">
    import { page } from '$app/stores';
    import { goto } from '$app/navigation';
    import { Icon } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';
    import type { AdminNavSection } from '$lib/config/admin-nav.js';
    import { resolveActiveNavPath } from '../admin-nav.utils.js';
    import AdminSettingsNavigation from './AdminSettingsNavigation.svelte';
    import ModuleBadge from './ModuleBadge.svelte';
    import { adminNavHover } from '$lib/stores/admin-nav-hover.svelte.js';

    interface Props {
        /** Already gate-filtered sections (from `visibleNav`). */
        sections: AdminNavSection[];
        /** Sidebar style, not collapsed to the rail: hide the row on desktop. */
        sidebarExpanded?: boolean;
    }
    let { sections, sidebarExpanded = false }: Props = $props();

    let pathname = $derived($page.url.pathname);

    // The ONE winning page path across every visible page in every section —
    // computed once so exactly one tab (the longest match) renders active,
    // instead of each tab independently prefix-matching (which double-lit
    // parent + nested-sibling pages, e.g. Users + Active sessions).
    let winnerPath = $derived(
        resolveActiveNavPath(
            pathname,
            sections.flatMap((s) => s.pages.map((p) => p.path)),
        ),
    );

    // The active section = the one owning the longest-prefix page match.
    let active = $derived.by(() => {
        let best: { section: AdminNavSection; len: number } | null = null;
        for (const section of sections) {
            for (const p of section.pages) {
                const matches =
                    p.path === '/admin'
                        ? pathname === '/admin'
                        : pathname === p.path || pathname.startsWith(p.path + '/');
                if (matches && p.path.length > (best?.len ?? -1)) {
                    best = { section, len: p.path.length };
                }
            }
        }
        return best?.section ?? null;
    });

    // Only show tabs when the active section has more than one page (Home has one).
    let show = $derived((active?.pages.length ?? 0) > 1);
</script>

{#if active && show}
    {#if active.id === 'settings'}
        <AdminSettingsNavigation pages={active.pages} activePath={winnerPath} />
    {:else}
        <nav
            class="section-tabs"
            class:sidebar-expanded={sidebarExpanded}
            aria-label={active.title()}>
            <select
                class="page-selector"
                aria-label={active.title()}
                value={winnerPath ?? active.pages[0]?.path}
                onchange={(event) => void goto(resolve(event.currentTarget.value))}>
                {#each active.pages as p (p.path)}
                    <option value={p.path}>{p.title()}</option>
                {/each}
            </select>
            {#each active.pages as p (p.path)}
                {@const isActive = p.path === winnerPath}
                <a
                    href={resolve(p.path)}
                    class="tab"
                    class:tab-active={isActive}
                    class:tab-dev={p.devOnly}
                    class:linked-hover={adminNavHover.path === p.path}
                    onpointerenter={() => adminNavHover.enter(p.path)}
                    onpointerleave={() => adminNavHover.leave(p.path)}
                    aria-current={isActive ? 'page' : undefined}>
                    {#if p.icon}
                        <Icon src={p.icon} class="tab-icon" />
                    {/if}
                    <span>{p.title()}</span>
                    {#if p.privateModule}
                        <ModuleBadge compact />
                    {/if}
                </a>
            {/each}
        </nav>
    {/if}
{/if}

<style>
    .section-tabs {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.375rem;
        padding-bottom: 0.5rem;
        margin-bottom: 1rem;
        border-bottom: 1px solid rgb(55 65 81 / 0.6);
    }
    .tab {
        display: inline-flex;
        flex-shrink: 0;
        min-height: 2.5rem;
        align-items: center;
        gap: 0.375rem;
        padding: 0.375rem 0.625rem;
        font-size: 0.8125rem;
        font-weight: 500;
        color: rgb(156 163 175); /* surface-400 */
        border-radius: 0.375rem;
        text-decoration: none;
        transition: all 120ms ease;
    }
    .page-selector {
        display: none;
        width: 100%;
        min-width: 0;
        min-height: 2.75rem;
        padding: 0.625rem;
        border: 1px solid rgb(75 85 99);
        border-radius: 0.5rem;
        color: rgb(229 231 235);
        background: rgb(31 41 55);
    }
    .tab:focus-visible,
    .page-selector:focus-visible {
        outline: 2px solid rgb(129 140 248);
        outline-offset: 2px;
    }
    @media (min-width: 1280px) {
        .section-tabs.sidebar-expanded {
            display: none;
        }
    }
    @media (max-width: 639px) {
        .tab {
            display: none;
        }
        .page-selector {
            display: block;
        }
    }
    .tab:hover,
    .tab.linked-hover {
        color: rgb(229 231 235); /* surface-200 */
        background: rgb(55 65 81 / 0.35);
    }
    .tab-active {
        color: rgb(199 210 254);
        background: rgb(99 102 241 / 0.15);
    }
    /* Developer entries render muted/mono (spec §3.7). */
    .tab-dev {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        color: rgb(129 140 248); /* indigo-400 */
    }
    .tab-dev.tab-active {
        color: rgb(165 180 252); /* indigo-300 */
        background: rgb(99 102 241 / 0.1);
    }
    :global(.tab-icon) {
        width: 0.875rem;
        height: 0.875rem;
        flex-shrink: 0;
    }
</style>
