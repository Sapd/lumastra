<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Admin IA redesign, spec §6.2 "Info rails": collapsible content cards that
  live in the page grid alongside a DetailPanel or list — NOT a second
  navigation surface. Rails are mini-views, never second copies of a full
  page's data (e.g. Runs' Servers rail shows name + current load and links to
  System → Health → Cluster for the full roster; it never renders its own
  copy of that list). Stacks below the main content on narrow screens — the
  grid/stacking layout itself is the host page's job, this only owns the
  card chrome + collapse behavior.
-->
<script lang="ts">
    import type { Snippet } from 'svelte';
    import { browser } from '$app/environment';
    import { Icon, ChevronDown, ArrowRight } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';

    interface Props {
        /** Stable id for this rail — keys the collapsed-state persistence. */
        id: string;
        title: string;
        /** "→ full page" link target, when this rail is a mini-view of a bigger page. */
        linkHref?: string;
        linkLabel?: string;
        /** Start collapsed the first time this rail is ever shown (before any stored preference exists). */
        defaultCollapsed?: boolean;
        children: Snippet;
    }

    let { id, title, linkHref, linkLabel, defaultCollapsed = false, children }: Props = $props();

    // `id` is a per-instance identity prop (each mounted rail keeps its own
    // fixed id) — this key is intentionally computed once, not reactively.
    // svelte-ignore state_referenced_locally
    const storageKey = `admin-info-rail-collapsed:${id}`;

    function readInitialCollapsed(): boolean {
        if (!browser) return defaultCollapsed;
        const stored = localStorage.getItem(storageKey);
        if (stored === null) return defaultCollapsed;
        return stored === 'true';
    }

    let collapsed = $state(readInitialCollapsed());

    function toggle(): void {
        collapsed = !collapsed;
        if (browser) localStorage.setItem(storageKey, String(collapsed));
    }
</script>

<div class="rounded-lg border border-surface-700/50 bg-surface-900/40">
    <div class="flex items-center gap-2 border-b border-surface-700/40 px-3 py-2">
        <button
            type="button"
            class="flex flex-1 items-center gap-1.5 text-left text-xs font-semibold uppercase tracking-wide text-surface-300"
            aria-expanded={!collapsed}
            onclick={toggle}>
            <Icon
                src={ChevronDown}
                class="h-3.5 w-3.5 shrink-0 transition-transform {collapsed ? '-rotate-90' : ''}" />
            {title}
        </button>
        {#if linkHref}
            <a
                href={resolve(linkHref)}
                class="flex shrink-0 items-center gap-1 text-[11px] font-medium text-surface-400 hover:text-surface-200">
                {linkLabel}
                <Icon src={ArrowRight} class="h-3 w-3" />
            </a>
        {/if}
    </div>
    {#if !collapsed}
        <div class="p-3">
            {@render children()}
        </div>
    {/if}
</div>
