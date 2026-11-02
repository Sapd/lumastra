<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import { SvelteSet } from 'svelte/reactivity';
    import { apiGet } from '$lib/api/client.js';
    import * as m from '$lib/paraglide/messages.js';
    import { formatRepeats } from '$lib/utils/admin/formatters.js';
    import { aggregateAuditEvents, aggregatedWindowHours } from './audit-feed-aggregate.js';
    import {
        AuditFeedResponseSchema,
        type AuditFeedResponse,
    } from '$lib/schemas/task-system-failure-detection.schema.js';
    import type { AuditEventRow } from '$lib/schemas/task-system-observability.schema.js';

    const PAGE_LIMIT = 50;

    const CATEGORIES = [
        'reconciler',
        'backpressure',
        'circuit-breaker',
        'leader',
        'dispatcher',
        'stage-sweep',
        'boot-recovery',
    ] as const;

    // Plain-language labels for the internal category codes (the codes stay
    // as the API filter values; only the button text changes).
    function categoryLabel(cat: string): string {
        switch (cat) {
            case 'reconciler':
                return m.admin_health_activity_category_reconciler();
            case 'backpressure':
                return m.admin_health_activity_category_backpressure();
            case 'circuit-breaker':
                return m.admin_health_activity_category_circuit_breaker();
            case 'leader':
                return m.admin_health_activity_category_leader();
            case 'dispatcher':
                return m.admin_health_activity_category_dispatcher();
            case 'stage-sweep':
                return m.admin_health_activity_category_stage_sweep();
            case 'boot-recovery':
                return m.admin_health_activity_category_boot_recovery();
            default:
                return cat;
        }
    }

    const SEVERITIES = ['info', 'warn', 'error'] as const;
    type Severity = (typeof SEVERITIES)[number];

    function severityLabel(sev: Severity): string {
        switch (sev) {
            case 'info':
                return m.admin_health_activity_severity_info();
            case 'warn':
                return m.admin_health_activity_severity_warn();
            case 'error':
                return m.admin_health_activity_severity_error();
        }
    }

    let events = $state<AuditEventRow[]>([]);
    let nextCursor = $state<string | undefined>(undefined);
    let loading = $state(true);
    let loadingMore = $state(false);
    let loadError = $state<string | null>(null);

    const selectedCategories = new SvelteSet<string>();
    let selectedSeverity = $state<Severity | null>(null);
    const expanded = new SvelteSet<number>();
    // Aggregated (spec §5: identical repeated events collapse). Keyed by group
    // key, not id — a group's "show individual events" is a separate toggle
    // from any one occurrence's raw-detail expand.
    const expandedGroups = new SvelteSet<string>();

    // Identical repeats aggregate (spec §5) so a re-wedging condition doesn't
    // flood the feed with duplicate rows.
    let groups = $derived(aggregateAuditEvents(events));

    function buildParams(cursor?: string): string {
        const pairs: [string, string][] = [['limit', String(PAGE_LIMIT)]];
        for (const c of selectedCategories) pairs.push(['category', c]);
        if (selectedSeverity) pairs.push(['severity', selectedSeverity]);
        if (cursor !== undefined) pairs.push(['cursor', cursor]);
        return new URLSearchParams(pairs).toString();
    }

    // Bumped by every reload (a filter click): a slower response for the old
    // filters — or a load-more page fetched under them — must not land.
    let requestSeq = 0;
    // A failed "load more" keeps the rows already on screen; only a failed
    // first page replaces the list with the error box.
    let loadMoreError = $state<string | null>(null);

    async function fetchPage(
        cursor?: string,
    ): Promise<{ data: AuditFeedResponse | null; error: string | null }> {
        const { data, error } = await apiGet(
            `/api/admin/task-system/audit?${buildParams(cursor)}`,
            AuditFeedResponseSchema,
        );
        if (error || !data)
            return { data: null, error: error ?? m.admin_health_activity_load_error() };
        return { data, error: null };
    }

    async function reload(): Promise<void> {
        const seq = ++requestSeq;
        loading = true;
        loadingMore = false;
        loadMoreError = null;
        const page = await fetchPage();
        if (seq !== requestSeq) return;
        loadError = page.error;
        if (page.data) {
            events = page.data.items;
            nextCursor = page.data.page.nextCursor;
        }
        loading = false;
    }

    async function loadMore(): Promise<void> {
        if (nextCursor === undefined || loadingMore) return;
        const seq = requestSeq;
        loadingMore = true;
        loadMoreError = null;
        const page = await fetchPage(nextCursor);
        if (seq !== requestSeq) return;
        if (page.data) {
            events = [...events, ...page.data.items];
            nextCursor = page.data.page.nextCursor;
        } else {
            loadMoreError = page.error;
        }
        loadingMore = false;
    }

    function toggleCategory(cat: string): void {
        if (selectedCategories.has(cat)) selectedCategories.delete(cat);
        else selectedCategories.add(cat);
        void reload();
    }

    function setSeverity(sev: Severity | null): void {
        selectedSeverity = sev;
        void reload();
    }

    function toggleExpanded(id: number): void {
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
    }

    function toggleGroupExpanded(key: string): void {
        if (expandedGroups.has(key)) expandedGroups.delete(key);
        else expandedGroups.add(key);
    }

    function severityDotClass(sev: string): string {
        if (sev === 'error') return 'bg-red-400';
        if (sev === 'warn') return 'bg-amber-400';
        return 'bg-sky-400';
    }

    function formatTime(iso: string): string {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        return d.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    }

    function hasDetail(detail: Record<string, unknown>): boolean {
        return detail && Object.keys(detail).length > 0;
    }

    onMount(reload);
</script>

<section
    class="rounded-lg border border-surface-700 bg-surface-900/40 p-4"
    aria-label={m.admin_health_activity_aria()}>
    <div class="mb-3">
        <h2 class="text-sm font-semibold uppercase tracking-wide text-surface-300">
            {m.admin_health_section_activity()}
        </h2>
        <p class="mt-1 text-xs text-surface-500">
            {m.admin_health_activity_description()}
        </p>
    </div>

    <!-- Filters -->
    <div class="mb-3 space-y-2">
        <div class="flex flex-wrap items-center gap-1.5">
            <span class="text-[11px] text-surface-400">{m.admin_health_activity_category()}:</span>
            {#each CATEGORIES as cat (cat)}
                <button
                    type="button"
                    class="rounded px-2 py-0.5 text-[11px] transition-colors {selectedCategories.has(
                        cat,
                    )
                        ? 'bg-cyan-700 text-white'
                        : 'bg-surface-700 text-surface-400 hover:bg-surface-600'}"
                    onclick={() => toggleCategory(cat)}>
                    {categoryLabel(cat)}
                </button>
            {/each}
        </div>
        <div class="flex flex-wrap items-center gap-1.5">
            <span class="text-[11px] text-surface-400">{m.admin_health_activity_severity()}:</span>
            <button
                type="button"
                class="rounded px-2 py-0.5 text-[11px] transition-colors {selectedSeverity === null
                    ? 'bg-cyan-700 text-white'
                    : 'bg-surface-700 text-surface-400 hover:bg-surface-600'}"
                onclick={() => setSeverity(null)}>
                {m.admin_health_activity_severity_all()}
            </button>
            {#each SEVERITIES as sev (sev)}
                <button
                    type="button"
                    class="rounded px-2 py-0.5 text-[11px] transition-colors {selectedSeverity ===
                    sev
                        ? 'bg-cyan-700 text-white'
                        : 'bg-surface-700 text-surface-400 hover:bg-surface-600'}"
                    onclick={() => setSeverity(sev)}>
                    {severityLabel(sev)}
                </button>
            {/each}
        </div>
    </div>

    {#if loading}
        <p class="py-6 text-center text-sm text-surface-400">{m.admin_health_activity_loading()}</p>
    {:else if loadError}
        <div class="rounded border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {loadError}
        </div>
    {:else if groups.length === 0}
        <div
            class="rounded border border-surface-700/40 bg-surface-900/30 py-6 text-center text-sm text-surface-400">
            {m.admin_health_activity_empty()}
        </div>
    {:else}
        <ul class="divide-y divide-surface-800">
            {#each groups as group (group.key)}
                {@const latest = group.events[0]}
                <li class="py-2">
                    <div class="flex items-start gap-2">
                        <span
                            class="mt-1.5 h-2 w-2 shrink-0 rounded-full {severityDotClass(
                                latest.severity,
                            )}"
                            title={severityLabel(latest.severity as Severity)}></span>
                        <div class="min-w-0 flex-1">
                            <div class="flex flex-wrap items-center gap-2">
                                <span class="text-[11px] tabular-nums text-surface-500">
                                    {formatTime(latest.ts)}
                                </span>
                                <span
                                    class="rounded bg-surface-700 px-1.5 py-0.5 text-[10px] text-surface-300">
                                    {categoryLabel(group.category)}
                                </span>
                                <span class="text-sm text-surface-200">{group.summary}</span>
                                {#if group.events.length > 1}
                                    <span class="text-[11px] text-surface-500">
                                        {formatRepeats(group.events.length, {
                                            hours: aggregatedWindowHours(group),
                                        })}
                                    </span>
                                {/if}
                            </div>
                            <div class="mt-1 flex flex-wrap items-center gap-3">
                                {#if hasDetail(latest.detail)}
                                    <button
                                        type="button"
                                        class="text-[11px] text-cyan-400 hover:text-cyan-300"
                                        onclick={() => toggleExpanded(latest.id)}>
                                        {expanded.has(latest.id)
                                            ? m.admin_health_activity_hide_detail()
                                            : m.admin_health_activity_show_detail()}
                                    </button>
                                {/if}
                                {#if group.events.length > 1}
                                    <button
                                        type="button"
                                        class="text-[11px] text-cyan-400 hover:text-cyan-300"
                                        onclick={() => toggleGroupExpanded(group.key)}>
                                        {expandedGroups.has(group.key)
                                            ? m.admin_health_activity_hide_occurrences()
                                            : m.admin_health_activity_show_occurrences({
                                                  count: group.events.length,
                                              })}
                                    </button>
                                {/if}
                            </div>
                            {#if expanded.has(latest.id)}
                                <pre
                                    class="mt-1 max-h-64 overflow-auto rounded bg-surface-950/60 p-2 text-[11px] text-surface-300">{JSON.stringify(
                                        latest.detail,
                                        null,
                                        2,
                                    )}</pre>
                            {/if}
                            {#if expandedGroups.has(group.key)}
                                <ul class="mt-1 space-y-0.5 border-l border-surface-700 pl-2">
                                    {#each group.events as occurrence (occurrence.id)}
                                        <li class="text-[11px] tabular-nums text-surface-500">
                                            {formatTime(occurrence.ts)}
                                        </li>
                                    {/each}
                                </ul>
                            {/if}
                        </div>
                    </div>
                </li>
            {/each}
        </ul>

        {#if loadMoreError}
            <p class="mt-3 text-center text-xs text-red-300">{loadMoreError}</p>
        {/if}
        {#if nextCursor !== undefined}
            <div class="mt-3 text-center">
                <button
                    type="button"
                    class="rounded border border-surface-600 bg-surface-800 px-4 py-1.5 text-xs text-surface-300 transition-colors hover:bg-surface-700 disabled:opacity-50"
                    onclick={loadMore}
                    disabled={loadingMore}>
                    {loadingMore
                        ? m.admin_health_activity_loading()
                        : m.admin_health_activity_load_more()}
                </button>
            </div>
        {/if}
    {/if}
</section>
