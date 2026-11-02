<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  A section's pages as a small panel beside an admin sidebar row: every section
  on the slim rail, and Settings (16 pages in three groups) on the full sidebar.
  The parent owns open/close (hover, focus, chevron, Esc); this only renders and
  positions. `position: fixed` so the sidebar's scrolling list cannot clip it.
  Not a dialog: it never traps focus, Tab simply moves on.
-->
<script lang="ts">
    import { resolve } from '$lib/paths';
    import type { AdminNavSection } from '$lib/config/admin-nav.js';
    import type { NavStatusDot } from './nav-status.js';
    import { sectionPageGroups } from '../admin-nav.utils.js';
    import EnterpriseBadge from './EnterpriseBadge.svelte';
    import { adminNavHover } from '$lib/stores/admin-nav-hover.svelte.js';

    interface Props {
        id: string;
        section: AdminNavSection;
        open: boolean;
        /** The one active page path across the whole nav (or null). */
        activePath: string | null;
        /** Per-page attention dots, keyed by path. */
        dots: Record<string, NavStatusDot>;
        /** The sidebar row the panel sits beside. */
        anchor: HTMLElement | undefined;
    }
    let { id, section, open, activePath, dots, anchor }: Props = $props();

    let panel = $state<HTMLDivElement>();
    let groups = $derived(sectionPageGroups(section));
    let grouped = $derived(groups.length > 1);

    // Beside the row, nudged up so a tall panel never runs off the bottom.
    function place(): void {
        if (!panel || !anchor) return;
        const row = anchor.getBoundingClientRect();
        const sidebar = anchor.closest('nav')?.getBoundingClientRect() ?? row;
        const margin = 8;
        const top = Math.max(
            margin,
            Math.min(row.top - 6, window.innerHeight - panel.offsetHeight - margin),
        );
        const left = Math.min(
            sidebar.right + margin,
            Math.max(margin, window.innerWidth - panel.offsetWidth - margin),
        );
        panel.style.top = `${top}px`;
        panel.style.left = `${left}px`;
    }

    $effect(() => {
        if (!open) return;
        place();
        // Content can change size while open (a dot arrives, labels reflow).
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
        if (panel) observer?.observe(panel);
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => {
            observer?.disconnect();
            window.removeEventListener('resize', place);
            window.removeEventListener('scroll', place, true);
        };
    });
</script>

<div
    {id}
    bind:this={panel}
    class="nav-flyout"
    class:grouped
    role="group"
    aria-labelledby="{id}-title"
    hidden={!open}>
    <div class="flyout-title" id="{id}-title">{section.title()}</div>
    <div class="flyout-groups">
        {#each groups as group (group.id)}
            <div
                class="flyout-group"
                role={group.label ? 'group' : undefined}
                aria-labelledby={group.label ? `${id}-${group.id}` : undefined}>
                {#if group.label}
                    <div class="flyout-group-label" id="{id}-{group.id}">{group.label}</div>
                {/if}
                <ul>
                    {#each group.pages as p (p.path)}
                        {@const dot = dots[p.path]}
                        <li>
                            <a
                                href={resolve(p.path)}
                                class="flyout-link"
                                class:flyout-link-active={p.path === activePath}
                                class:flyout-link-dev={p.devOnly}
                                class:linked-hover={adminNavHover.path === p.path}
                                title={p.title()}
                                onpointerenter={() => adminNavHover.enter(p.path)}
                                onpointerleave={() => adminNavHover.leave(p.path)}
                                data-flyout-link
                                aria-current={p.path === activePath ? 'page' : undefined}>
                                <span class="flyout-label">{p.title()}</span>
                                {#if p.enterpriseOnly}
                                    <EnterpriseBadge compact />
                                {/if}
                                {#if dot?.show}
                                    <span class="page-dot {dot.colorClass}" aria-hidden="true"
                                    ></span>
                                    <span class="sr-only">, {dot.label}</span>
                                {/if}
                            </a>
                        </li>
                    {/each}
                </ul>
            </div>
        {/each}
    </div>
</div>

<style>
    .nav-flyout {
        position: fixed;
        z-index: 50;
        width: 15rem;
        max-height: calc(100vh - 1rem);
        overflow-y: auto;
        padding: 0.375rem;
        background: rgb(31 41 55); /* surface-800 */
        border: 1px solid rgb(75 85 99);
        border-radius: 0.625rem;
        box-shadow: 0 10px 30px rgb(0 0 0 / 0.5);
    }
    .nav-flyout[hidden] {
        display: none;
    }
    .nav-flyout.grouped {
        width: min(40rem, calc(100vw - 6rem));
    }
    .grouped .flyout-groups {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
        gap: 0.25rem 0.625rem;
    }
    .flyout-title,
    .flyout-group-label {
        padding: 0.25rem 0.5rem 0.375rem;
        font-size: 0.6875rem;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: rgb(156 163 175);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .flyout-group-label {
        color: rgb(107 114 128);
        font-size: 0.625rem;
    }
    .flyout-link {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.375rem 0.5rem;
        border-radius: 0.375rem;
        font-size: 0.8125rem;
        color: rgb(209 213 219);
        text-decoration: none;
    }
    .flyout-link:hover,
    .flyout-link.linked-hover {
        background: rgb(55 65 81 / 0.6);
        color: white;
    }
    .flyout-link:focus-visible {
        outline: 2px solid rgb(129 140 248);
        outline-offset: -2px;
    }
    .flyout-link-active {
        background: rgb(99 102 241 / 0.18);
        color: rgb(224 231 255);
        font-weight: 500;
    }
    .flyout-link-dev .flyout-label {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.75rem;
        color: rgb(129 140 248);
    }
    .flyout-label {
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
</style>
