<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { AdminPageHeader, StatCard, ActionModal } from '$lib/components/admin';
    import PendingJellyfinUnmarks from '$lib/components/admin/PendingJellyfinUnmarks.svelte';
    import {
        Icon,
        ServerStack,
        ExclamationTriangle,
        CheckCircle,
        ArrowPath,
    } from 'svelte-hero-icons';
    import { invalidateAll } from '$app/navigation';
    import { toasts } from '$lib/stores/toast.store';
    import type { PageData } from './$types';
    import * as m from '$lib/paraglide/messages.js';
    import { z } from 'zod';
    import { apiPost } from '$lib/api/client.js';

    interface Props {
        data: PageData;
    }

    let { data }: Props = $props();

    // ---- sorting state (hour-bucketed exploration table) ----
    let sortKey = $state<'bucket_start' | 'event_count' | 'distinct_media_count'>('event_count');
    let sortDir = $state<'asc' | 'desc'>('desc');

    const sortedGroups = $derived(
        [...data.groups].sort((a, b) => {
            const av = a[sortKey];
            const bv = b[sortKey];
            const cmp =
                typeof av === 'number' && typeof bv === 'number'
                    ? av - bv
                    : String(av) < String(bv)
                      ? -1
                      : String(av) > String(bv)
                        ? 1
                        : 0;
            return sortDir === 'asc' ? cmp : -cmp;
        }),
    );

    function toggleSort(key: typeof sortKey): void {
        if (sortKey === key) {
            sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
            sortKey = key;
            sortDir = 'desc';
        }
    }

    // ---- repudiate modal ----
    //
    // Repudiation always uses the **detected bulk-mark window** bounds so
    // an hour of legitimate same-source activity never gets nuked
    // alongside a 10-second cascade. The hour-bucketed provenance table
    // above stays read-only on purpose.
    interface PendingRepudiate {
        /** Captured when the modal opens: back/forward reuses this component for another user. */
        userId: string;
        source: string;
        fromTs: string;
        toTs: string;
        eventCount: number;
        durationMs: number;
    }
    let pendingRepudiate = $state<PendingRepudiate | null>(null);

    // A modal opened for one user must not survive navigation to another.
    $effect(() => {
        if (pendingRepudiate && pendingRepudiate.userId !== data.userId) pendingRepudiate = null;
    });

    function openRepudiateWindow(
        source: string,
        windowStart: string,
        windowEnd: string,
        eventCount: number,
    ): void {
        const durationMs = Math.max(0, Date.parse(windowEnd) - Date.parse(windowStart));
        pendingRepudiate = {
            userId: data.userId,
            source,
            fromTs: windowStart,
            toTs: windowEnd,
            eventCount,
            durationMs,
        };
    }

    function closeRepudiate(): void {
        pendingRepudiate = null;
    }

    let repudiating = $state(false);

    async function confirmRepudiate(): Promise<void> {
        if (!pendingRepudiate || repudiating) return;
        repudiating = true;
        try {
            const RepudiateResponseSchema = z.object({
                repudiated: z.number().optional(),
                rebuildCount: z.number().optional(),
                jellyfinUnmark: z
                    .object({ attempted: z.number(), failed: z.number() })
                    .nullable()
                    .optional(),
            });
            const { data: body, error } = await apiPost(
                '/api/admin/watch-events/repudiate',
                RepudiateResponseSchema,
                {
                    userId: pendingRepudiate.userId,
                    source: pendingRepudiate.source,
                    fromTs: pendingRepudiate.fromTs,
                    toTs: pendingRepudiate.toTs,
                },
            );
            if (error) {
                toasts.show(m.admin_provenance_toast_repudiation_failed({ error }), 'error');
                return;
            }
            toasts.show(
                m.admin_provenance_toast_repudiated({ count: body?.repudiated ?? 0 }),
                'success',
            );
            const unmark = body?.jellyfinUnmark;
            if (unmark && unmark.failed > 0) {
                toasts.show(
                    m.admin_provenance_toast_jellyfin_unmark_failed({
                        failed: unmark.failed,
                        attempted: unmark.attempted,
                    }),
                    'warning',
                );
            }
            closeRepudiate();
            await invalidateAll();
        } finally {
            repudiating = false;
        }
    }

    // ---- helpers ----
    function formatRelative(iso: string): string {
        const diff = Date.now() - Date.parse(iso);
        if (Number.isNaN(diff)) return iso;
        const sec = Math.floor(diff / 1000);
        if (sec < 60) return m.admin_provenance_seconds_ago({ count: sec });
        const min = Math.floor(sec / 60);
        if (min < 60) return m.time_minutes_ago_short({ count: min });
        const hr = Math.floor(min / 60);
        if (hr < 24) return m.time_hours_ago_short({ count: hr });
        return m.time_days_ago_short({ count: Math.floor(hr / 24) });
    }

    function formatDurationMs(ms: number): string {
        if (ms < 1000) return `${ms}ms`;
        const sec = ms / 1000;
        if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
        const min = Math.floor(sec / 60);
        const remSec = Math.round(sec - min * 60);
        return `${min}m ${remSec}s`;
    }

    function sortIndicator(key: typeof sortKey): string {
        if (sortKey !== key) return '';
        return sortDir === 'asc' ? ' ↑' : ' ↓';
    }

    let refreshing = $state(false);

    async function refresh(): Promise<void> {
        refreshing = true;
        try {
            await invalidateAll();
        } finally {
            refreshing = false;
        }
    }
</script>

<svelte:head>
    <title>{m.admin_provenance_page_title({ userId: data.userId })}</title>
</svelte:head>

<div class="space-y-6">
    <AdminPageHeader
        icon={ServerStack}
        title={m.admin_provenance_header_title({ userId: data.userId })}
        description={m.admin_provenance_header_description({
            bucketMinutes: data.bucketMinutes,
        })}>
        <button
            class="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-800 hover:bg-surface-700 text-sm text-surface-200 disabled:opacity-50"
            onclick={refresh}
            disabled={refreshing}>
            <Icon
                src={ArrowPath}
                class="w-4 h-4 {refreshing ? 'animate-spin' : ''}" />{m.common_refresh()}</button>
    </AdminPageHeader>

    <!-- Summary stat cards -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="flex flex-col gap-1">
            <StatCard
                icon={ServerStack}
                title={m.admin_title_total_events_sample()}
                value={data.totalEvents.toLocaleString()}
                color="blue" />
            {#if data.totalEventsIsCapped}
                <p class="text-xs text-amber-400 px-1">
                    Showing first 200 buckets — totals may be understated.
                </p>
            {/if}
        </div>

        <StatCard
            icon={CheckCircle}
            title={m.admin_provenance_sources()}
            value={data.bySource.length.toLocaleString()}
            healthy={true} />

        <StatCard
            icon={ExclamationTriangle}
            title={m.admin_title_date_range()}
            value={data.earliestEvent
                ? `${formatRelative(data.earliestEvent)} – ${data.latestEvent ? formatRelative(data.latestEvent) : '?'}`
                : m.admin_provenance_no_events()}
            color="blue" />
    </div>

    <!-- Per-source breakdown -->
    {#if data.bySource.length > 0}
        <div class="rounded-xl border border-surface-700 bg-surface-800/30 p-4">
            <h3 class="text-sm font-semibold mb-3 text-surface-200">
                {m.admin_provenance_events_by_source()}
            </h3>
            <div class="flex flex-wrap gap-2">
                {#each data.bySource as s (s.source)}
                    <span
                        class="px-2.5 py-1 rounded-md text-xs font-mono bg-blue-500/10 text-blue-300">
                        {s.source}: {s.event_count.toLocaleString()}
                    </span>
                {/each}
            </div>
        </div>
    {/if}

    <!--
        Suspicious windows (bulk-mark detector output).
        Only these rows expose a "Repudiate" action — the bounds are the
        detector's own window_start/window_end, i.e. the narrow burst,
        NOT an hour bucket.
    -->
    <div class="rounded-xl border border-amber-500/20 bg-amber-500/5 overflow-hidden">
        <div class="px-4 py-3 border-b border-amber-500/20 flex items-center gap-2">
            <Icon src={ExclamationTriangle} class="w-5 h-5 text-amber-400" />
            <h3 class="text-sm font-semibold text-amber-100">
                {m.admin_provenance_suspicious_windows()}
            </h3>
            <span class="text-xs text-amber-300/70 ml-auto">
                {m.admin_provenance_detected({ count: data.bulkMarkWindows.length })}
            </span>
        </div>

        {#if data.bulkMarkWindows.length === 0}
            <div class="p-6 text-center text-amber-200/70 text-sm">
                <Icon src={CheckCircle} class="w-6 h-6 mx-auto mb-2" />
                {m.admin_provenance_no_suspicious_windows()}
            </div>
        {:else}
            <div class="overflow-x-auto">
                <table class="w-full text-xs">
                    <thead class="bg-amber-500/10 text-amber-200/80">
                        <tr>
                            <th class="px-3 py-2 text-left">{m.audit_col_window_start()}</th>
                            <th class="px-3 py-2 text-left">{m.audit_col_source()}</th>
                            <th class="px-3 py-2 text-right">{m.audit_col_events()}</th>
                            <th class="px-3 py-2 text-right">{m.audit_col_distinct_media()}</th>
                            <th class="px-3 py-2 text-right">{m.admin_provenance_duration()}</th>
                            <th class="px-3 py-2 text-right">{m.common_actions()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each data.bulkMarkWindows as win (win.source + win.window_start)}
                            {@const durationMs = Math.max(
                                0,
                                Date.parse(win.window_end) - Date.parse(win.window_start),
                            )}
                            <tr class="border-t border-amber-500/10 hover:bg-amber-500/5">
                                <td class="px-3 py-2 text-amber-100" title={win.window_start}>
                                    {formatRelative(win.window_start)}
                                </td>
                                <td class="px-3 py-2 font-mono text-amber-200">{win.source}</td>
                                <td
                                    class="px-3 py-2 text-right font-mono text-red-300 font-semibold">
                                    {win.event_count.toLocaleString()}
                                </td>
                                <td class="px-3 py-2 text-right font-mono text-amber-200/80">
                                    {win.distinct_media_count.toLocaleString()}
                                </td>
                                <td class="px-3 py-2 text-right font-mono text-amber-200/80">
                                    {formatDurationMs(durationMs)}
                                </td>
                                <td class="px-3 py-2 text-right">
                                    <button
                                        class="px-2 py-1 rounded text-[10px] font-medium bg-red-500/30 text-red-200 hover:bg-red-500/50"
                                        onclick={() =>
                                            openRepudiateWindow(
                                                win.source,
                                                win.window_start,
                                                win.window_end,
                                                win.event_count,
                                            )}>{m.audit_button_repudiate()}</button>
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
        {/if}
    </div>

    <!-- Repudiated windows whose Jellyfin unmark may not have taken: retry. -->
    <PendingJellyfinUnmarks
        userId={data.userId}
        windows={data.pendingJellyfinUnmarks}
        onretried={invalidateAll}
        {formatRelative}
        {formatDurationMs} />

    <!--
        Hour-bucketed provenance groups — read-only exploration. The
        Repudiate action was removed because an hour bucket is far too
        wide to use as a repudiation range.
    -->
    {#if sortedGroups.length === 0}
        <div
            class="rounded-xl border border-green-500/20 bg-green-500/5 p-6 text-green-300 text-center">
            <Icon src={CheckCircle} class="w-8 h-8 mx-auto mb-2" />
            {m.admin_provenance_no_events_for_user()}
        </div>
    {:else}
        <div class="rounded-xl border border-surface-700 bg-surface-800/30 overflow-hidden">
            <div class="px-4 py-3 border-b border-surface-700 flex items-center gap-2">
                <Icon src={ServerStack} class="w-5 h-5 text-surface-400" />
                <h3 class="text-sm font-semibold text-surface-200">
                    {m.admin_provenance_events_grouped_by_bucket({
                        bucketMinutes: data.bucketMinutes,
                    })}
                </h3>
                <span class="text-xs text-surface-400 ml-auto"
                    >{m.admin_provenance_read_only()}</span>
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-xs">
                    <thead class="bg-surface-800/60 text-muted">
                        <tr>
                            <th
                                class="px-3 py-2 text-left cursor-pointer hover:text-surface-200 select-none"
                                onclick={() => toggleSort('bucket_start')}>
                                {m.admin_provenance_bucket_start()}{sortIndicator('bucket_start')}
                            </th>
                            <th class="px-3 py-2 text-left">{m.audit_col_source()}</th>
                            <th
                                class="px-3 py-2 text-right cursor-pointer hover:text-surface-200 select-none"
                                onclick={() => toggleSort('event_count')}>
                                {m.audit_col_events()}{sortIndicator('event_count')}
                            </th>
                            <th
                                class="px-3 py-2 text-right cursor-pointer hover:text-surface-200 select-none"
                                onclick={() => toggleSort('distinct_media_count')}>
                                {m.audit_col_distinct_media()}{sortIndicator(
                                    'distinct_media_count',
                                )}
                            </th>
                            <th class="px-3 py-2 text-left"
                                >{m.admin_provenance_type_breakdown()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each sortedGroups as group (group.source + group.bucket_start)}
                            <tr class="border-t border-surface-700/50 hover:bg-surface-800/30">
                                <td class="px-3 py-2 text-muted" title={group.bucket_start}>
                                    {formatRelative(group.bucket_start)}
                                </td>
                                <td class="px-3 py-2 font-mono text-surface-300">{group.source}</td>
                                <td
                                    class="px-3 py-2 text-right font-mono {group.event_count >= 50
                                        ? 'text-red-300 font-semibold'
                                        : 'text-surface-300'}">
                                    {group.event_count.toLocaleString()}
                                </td>
                                <td class="px-3 py-2 text-right font-mono text-surface-400">
                                    {group.distinct_media_count.toLocaleString()}
                                </td>
                                <td class="px-3 py-2">
                                    <div class="flex flex-wrap gap-1">
                                        {#each Object.entries(group.type_counts) as [type, count] (type)}
                                            <span
                                                class="px-1.5 py-0.5 rounded font-mono text-[10px] bg-surface-700/60 text-surface-300">
                                                {type}: {count.toLocaleString()}
                                            </span>
                                        {/each}
                                    </div>
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
        </div>
    {/if}
</div>

{#if pendingRepudiate}
    <ActionModal
        title={m.admin_title_repudiate_events()}
        confirmText={m.audit_button_repudiate()}
        confirmColor="red"
        onclose={closeRepudiate}
        onconfirm={confirmRepudiate}>
        <p class="text-sm text-surface-300">
            {m.admin_provenance_repudiate_prefix()}
            <span class="font-semibold text-red-300"
                >{pendingRepudiate.eventCount.toLocaleString()}</span>
            {m.admin_provenance_events_from_source()}
            <span class="font-mono text-surface-200">{pendingRepudiate.source}</span>
            {m.admin_provenance_between()}
        </p>
        <p class="text-xs font-mono text-surface-400 mt-1">
            {pendingRepudiate.fromTs} → {pendingRepudiate.toTs}
            <span class="text-surface-500">
                {m.admin_provenance_duration_paren({
                    duration: formatDurationMs(pendingRepudiate.durationMs),
                })}
            </span>
        </p>
        <p class="text-sm text-amber-300 mt-3">
            {m.admin_provenance_repudiate_warning()}
        </p>
    </ActionModal>
{/if}
