<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { AdminPageHeader, StatCard } from '$lib/components/admin';
    import {
        Icon,
        PlayCircle,
        CheckCircle,
        ExclamationTriangle,
        ArrowPath,
        MagnifyingGlass,
        Trash,
    } from 'svelte-hero-icons';
    import { invalidate, invalidateAll } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages.js';
    import type { PageData } from './$types';
    import { z } from 'zod';
    import { apiPost } from '$lib/api/client.js';

    type RowKey = string;

    function provenanceUrl(userId: string): string {
        return resolve(`/admin/users/${encodeURIComponent(userId)}/watch-provenance`);
    }

    // Per-row repudiation state. The audit page's main use case is one-click
    // cascade cleanup, so a single in-flight key is enough — the button is
    // disabled while the request runs and re-enabled after invalidate.
    let repudiatingKey = $state<RowKey | null>(null);

    function rowKey(w: PageData['bulkMarkWindows'][number]): RowKey {
        return `${w.user_id}:${w.source}:${w.window_start}`;
    }

    async function repudiateWindow(w: PageData['bulkMarkWindows'][number]): Promise<void> {
        const key = rowKey(w);
        if (repudiatingKey !== null) return;

        const eventCount = w.event_count.toLocaleString();
        const confirmMsg =
            w.source === 'jellyfin-sync'
                ? m.audit_confirm_repudiate_jellyfin({
                      count: eventCount,
                      source: w.source,
                      user: w.user_id,
                  })
                : m.audit_confirm_repudiate_other({
                      count: eventCount,
                      source: w.source,
                      user: w.user_id,
                  });
        if (!confirm(confirmMsg)) return;

        repudiatingKey = key;
        try {
            const RepudiateResponseSchema = z.object({
                repudiated: z.number().optional(),
                jellyfinUnmark: z
                    .object({
                        succeeded: z.number(),
                        failed: z.number(),
                        skippedNoExternalId: z.number(),
                    })
                    .nullable()
                    .optional(),
            });
            const { data, error } = await apiPost(
                '/api/admin/watch-events/repudiate',
                RepudiateResponseSchema,
                {
                    userId: w.user_id,
                    source: w.source,
                    fromTs: w.window_start,
                    toTs: w.window_end,
                    alsoUnmarkOnSource: w.source === 'jellyfin-sync',
                },
            );
            if (error) {
                toasts.error(m.audit_toast_repudiate_failed({ error }));
                return;
            }
            const parts = [m.audit_toast_repudiated({ count: data?.repudiated ?? 0 })];
            if (data?.jellyfinUnmark) {
                const j = data.jellyfinUnmark;
                parts.push(
                    m.audit_toast_jellyfin_unmark({
                        succeeded: j.succeeded,
                        failed: j.failed,
                        skipped: j.skippedNoExternalId,
                    }),
                );
            }
            toasts.success(parts.join(' · '));
            await invalidateAll();
        } finally {
            repudiatingKey = null;
        }
    }

    function confidenceBadge(tier: 'high' | 'medium' | 'low'): {
        cls: string;
        label: string;
        title: string;
    } {
        if (tier === 'high') {
            return {
                cls: 'bg-red-500/25 text-red-200 border-red-500/40',
                label: m.audit_confidence_high(),
                title: m.audit_confidence_high_help(),
            };
        }
        if (tier === 'medium') {
            return {
                cls: 'bg-amber-500/25 text-amber-200 border-amber-500/40',
                label: m.audit_confidence_med(),
                title: m.audit_confidence_med_help(),
            };
        }
        return {
            cls: 'bg-surface-700/40 text-surface-300 border-surface-600/40',
            label: m.audit_confidence_low(),
            title: m.audit_confidence_low_help(),
        };
    }

    function formatSpan(ms: number): string {
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
        return `${(ms / 60_000).toFixed(1)}m`;
    }

    interface Props {
        data: PageData;
    }

    let { data }: Props = $props();
    let refreshing = $state(false);

    async function refresh(): Promise<void> {
        refreshing = true;
        try {
            await invalidateAll();
        } finally {
            refreshing = false;
        }
    }

    function formatDuration(ms: number | null): string {
        if (ms === null || ms <= 0) return '—';
        const totalSec = Math.floor(ms / 1000);
        const min = Math.floor(totalSec / 60);
        const sec = totalSec % 60;
        return `${min}:${String(sec).padStart(2, '0')}`;
    }

    function formatRatio(r: number | null): string {
        if (r === null) return '—';
        return `${(r * 100).toFixed(1)}%`;
    }

    function formatRelative(iso: string): string {
        const diff = Date.now() - Date.parse(iso);
        if (Number.isNaN(diff)) return iso;
        const sec = Math.floor(diff / 1000);
        if (sec < 60) return `${sec}s ago`;
        const min = Math.floor(sec / 60);
        if (min < 60) return `${min}m ago`;
        const hr = Math.floor(min / 60);
        if (hr < 24) return `${hr}h ago`;
        return `${Math.floor(hr / 24)}d ago`;
    }

    function invariantBadgeClass(id: string): string {
        // Red for hard correctness bugs; amber for softer drift signals.
        if (id === 'is-not-watched' || id === 'not-complete-by-ratio' || id === 'not-music-type') {
            return 'bg-red-500/20 text-red-300';
        }
        return 'bg-amber-500/20 text-amber-300';
    }

    // Maps the internal invariant ID (e.g. 'not-complete-by-ratio') to a
    // plain-language label + explanation for non-expert admins. The raw ID is
    // still surfaced in the tooltip so power operators can cross-reference it
    // with CW_INVARIANTS / logs.
    function invariantInfo(id: string): { label: string; title: string } {
        switch (id) {
            case 'is-not-watched':
                return {
                    label: m.audit_inv_already_finished(),
                    title: m.audit_inv_already_finished_help(),
                };
            case 'not-complete-by-ratio':
                return {
                    label: m.audit_inv_watched_to_end(),
                    title: m.audit_inv_watched_to_end_help(),
                };
            case 'has-min-progress':
                return {
                    label: m.audit_inv_barely_started(),
                    title: m.audit_inv_barely_started_help(),
                };
            case 'not-music-type':
                return { label: m.audit_inv_music_item(), title: m.audit_inv_music_item_help() };
            case 'not-stale-beyond-60d':
                return { label: m.audit_inv_abandoned(), title: m.audit_inv_abandoned_help() };
            case 'phantom-shadow':
                return {
                    label: m.audit_inv_stale_duplicate(),
                    title: m.audit_inv_stale_duplicate_help(),
                };
            default:
                // Unknown/new invariant: show the raw ID rather than hide it.
                return { label: id, title: id };
        }
    }

    const usersWithIssues = $derived(
        data.perUser.filter((u) => u.summary.violating > 0 || u.phantomShadowCount > 0),
    );
    // Avoid 'unused' lint on invalidate import when only invalidateAll is wired.
    void invalidate;

    function formatTs(iso: string): string {
        return formatRelative(iso);
    }
</script>

<svelte:head>
    <title>{m.admin_audit_head_title()}</title>
</svelte:head>

<div class="space-y-6">
    <AdminPageHeader
        icon={PlayCircle}
        title={m.admin_title_continue_watching_audit()}
        description={m.audit_page_description()}>
        <button
            class="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-800 hover:bg-surface-700 text-sm text-surface-200 disabled:opacity-50"
            onclick={refresh}
            disabled={refreshing}>
            <Icon src={ArrowPath} class="w-4 h-4 {refreshing ? 'animate-spin' : ''}" />
            {m.audit_button_refresh()}
        </button>
    </AdminPageHeader>

    <div class="text-xs text-muted">
        {m.audit_sample_info({
            size: data.sampleSize.toLocaleString(),
            generated: formatRelative(data.generatedAt),
        })}
    </div>

    <!-- Plain-language explainer. This is an advanced/diagnostic screen and is
         not linked from the main operator nav; most admins will never need it,
         and an empty result is the normal, healthy case. -->
    <details class="rounded-xl border border-surface-700 bg-surface-800/30 text-sm">
        <summary
            class="cursor-pointer px-4 py-3 font-medium text-surface-200 hover:bg-surface-800/60">
            {m.audit_help_summary()}
        </summary>
        <div class="px-4 pb-4 pt-1 text-surface-400 space-y-2">
            <p>{m.audit_help_what()}</p>
            <p>{m.audit_help_when()}</p>
            <p>{m.audit_help_safe()}</p>
        </div>
    </details>

    {#if data.truncated}
        <div
            class="flex items-center gap-3 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm">
            <Icon src={ExclamationTriangle} class="w-5 h-5 shrink-0" />
            <span>
                {m.audit_truncated_warning({
                    limit: data.rowLimit.toLocaleString(),
                })}
            </span>
        </div>
    {/if}

    <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard
            icon={PlayCircle}
            title={m.admin_title_total_in_progress_rows()}
            value={data.overallSummary.total.toLocaleString()}
            color="blue" />

        <StatCard
            icon={CheckCircle}
            title={m.admin_title_healthy()}
            value={data.overallSummary.healthy.toLocaleString()}
            healthy={true} />

        <StatCard
            icon={ExclamationTriangle}
            title={m.audit_stat_invariant_violations()}
            value={data.overallSummary.violating.toLocaleString()}
            healthy={data.overallSummary.violating === 0} />

        <StatCard
            icon={ExclamationTriangle}
            title={m.audit_stat_phantom_shadows()}
            value={data.totalPhantomShadows.toLocaleString()}
            healthy={data.totalPhantomShadows === 0} />
    </div>

    <!-- Invariant breakdown -->
    {#if Object.keys(data.overallSummary.byInvariant).length > 0}
        <div class="rounded-xl border border-surface-700 bg-surface-800/30 p-4">
            <h3 class="text-sm font-semibold mb-3 text-surface-200">
                {m.audit_heading_violations_by_invariant()}
            </h3>
            <div class="flex flex-wrap gap-2">
                {#each Object.entries(data.overallSummary.byInvariant) as [id, count] (id)}
                    {@const info = invariantInfo(id)}
                    <span
                        class="px-2.5 py-1 rounded-md text-xs {invariantBadgeClass(id)}"
                        title={info.title}>
                        {info.label}: {count}
                    </span>
                {/each}
            </div>
        </div>
    {/if}

    {#if data.bulkMarkWindows.length > 0}
        <div class="rounded-xl border border-red-500/30 bg-red-500/5 overflow-hidden">
            <div class="px-4 py-3 border-b border-red-500/20">
                <h3 class="text-sm font-semibold text-red-300">
                    {m.audit_heading_suspicious_bulk_mark()}
                    <span class="ml-2 px-2 py-0.5 rounded-full text-xs bg-red-500/20">
                        {data.bulkMarkWindows.length}
                    </span>
                </h3>
                <p class="text-xs text-muted mt-1">
                    {m.audit_bulk_mark_help()}
                </p>
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-xs">
                    <thead class="bg-surface-800/60 text-muted">
                        <tr>
                            <th class="px-3 py-2 text-left">{m.audit_col_confidence()}</th>
                            <th class="px-3 py-2 text-left">{m.audit_col_user()}</th>
                            <th class="px-3 py-2 text-left">{m.audit_col_source()}</th>
                            <th class="px-3 py-2 text-left">{m.audit_col_window_start()}</th>
                            <th class="px-3 py-2 text-right">{m.audit_col_span()}</th>
                            <th class="px-3 py-2 text-right">{m.audit_col_events()}</th>
                            <th class="px-3 py-2 text-right">{m.audit_col_distinct_media()}</th>
                            <th class="px-3 py-2 text-right">{m.audit_col_action()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each data.bulkMarkWindows as w (w.user_id + w.source + w.window_start)}
                            {@const badge = confidenceBadge(w.confidence_tier)}
                            {@const isRepudiating = repudiatingKey === rowKey(w)}
                            <tr class="border-t border-surface-700/50 hover:bg-surface-800/30">
                                <td class="px-3 py-2">
                                    <span
                                        class="px-1.5 py-0.5 rounded font-mono text-[10px] border {badge.cls}"
                                        title={badge.title}>
                                        {badge.label}
                                    </span>
                                </td>
                                <td class="px-3 py-2 font-mono text-surface-200">{w.user_id}</td>
                                <td class="px-3 py-2 text-surface-400">{w.source}</td>
                                <td class="px-3 py-2 text-muted" title={w.window_start}>
                                    {formatTs(w.window_start)}
                                </td>
                                <td class="px-3 py-2 text-right font-mono text-surface-400">
                                    {formatSpan(w.span_ms)}
                                </td>
                                <td
                                    class="px-3 py-2 text-right font-mono text-red-300 font-semibold">
                                    {w.event_count.toLocaleString()}
                                </td>
                                <td class="px-3 py-2 text-right font-mono text-surface-400">
                                    {w.distinct_media_count.toLocaleString()}
                                </td>
                                <td class="px-3 py-2 text-right">
                                    <div class="inline-flex items-center gap-1 justify-end">
                                        <a
                                            href={provenanceUrl(w.user_id)}
                                            class="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-surface-800 hover:bg-surface-700 text-surface-200"
                                            title={m.admin_title_open_this_users_per_source_provenance_explorer()}>
                                            <Icon src={MagnifyingGlass} class="w-3 h-3" />
                                            {m.audit_button_provenance()}
                                        </a>
                                        <button
                                            class="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-red-500/20 hover:bg-red-500/40 text-red-200 disabled:opacity-50 disabled:cursor-not-allowed"
                                            disabled={repudiatingKey !== null}
                                            onclick={() => repudiateWindow(w)}
                                            title={w.source === 'jellyfin-sync'
                                                ? m.audit_title_repudiate_jellyfin()
                                                : m.audit_title_repudiate_lumastra()}>
                                            <Icon
                                                src={Trash}
                                                class="w-3 h-3 {isRepudiating
                                                    ? 'animate-pulse'
                                                    : ''}" />
                                            {isRepudiating
                                                ? m.audit_button_working()
                                                : m.audit_button_repudiate()}
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
        </div>
    {/if}

    {#if usersWithIssues.length === 0}
        <div
            class="rounded-xl border border-green-500/20 bg-green-500/5 p-6 text-green-300 text-center">
            <Icon src={CheckCircle} class="w-8 h-8 mx-auto mb-2" />
            {m.audit_status_all_healthy()}
        </div>
    {:else}
        <div>
            <h3 class="text-lg font-semibold mb-3">
                {m.audit_heading_users_with_issues()}
            </h3>
            <div class="space-y-3">
                {#each usersWithIssues as user (user.userId)}
                    <details
                        class="rounded-xl border border-surface-700 bg-surface-800/30 overflow-hidden group">
                        <summary
                            class="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-surface-800/60">
                            <div class="flex items-center gap-3">
                                <span class="font-mono text-sm text-surface-200"
                                    >{user.userId}</span>
                                <span class="text-xs text-muted">
                                    {user.summary.total}
                                    {m.audit_label_in_progress()} / {user.summary.healthy}
                                    {m.audit_label_healthy()}
                                </span>
                            </div>
                            <div class="flex items-center gap-2">
                                {#if user.summary.violating > 0}
                                    <span
                                        class="px-2 py-0.5 rounded-full text-xs bg-red-500/20 text-red-300">
                                        {user.summary.violating}
                                        {m.audit_label_violating()}
                                    </span>
                                {/if}
                                {#if user.phantomShadowCount > 0}
                                    <span
                                        class="px-2 py-0.5 rounded-full text-xs bg-amber-500/20 text-amber-300">
                                        {user.phantomShadowCount}
                                        {m.audit_label_phantom()}
                                    </span>
                                {/if}
                                <a
                                    href={provenanceUrl(user.userId)}
                                    onclick={(e) => e.stopPropagation()}
                                    class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-surface-800 hover:bg-surface-700 text-surface-200">
                                    <Icon src={MagnifyingGlass} class="w-3 h-3" />
                                    {m.audit_button_provenance()}
                                </a>
                            </div>
                        </summary>
                        <div class="overflow-x-auto border-t border-surface-700">
                            <table class="w-full text-xs">
                                <thead class="bg-surface-800/60 text-muted">
                                    <tr>
                                        <th class="px-3 py-2 text-left">{m.audit_col_title()}</th>
                                        <th class="px-3 py-2 text-left">{m.audit_col_type()}</th>
                                        <th class="px-3 py-2 text-right"
                                            >{m.audit_col_progress()}</th>
                                        <th class="px-3 py-2 text-right">{m.audit_col_ratio()}</th>
                                        <th class="px-3 py-2 text-right"
                                            >{m.audit_col_runtime()}</th>
                                        <th class="px-3 py-2 text-left">{m.audit_col_updated()}</th>
                                        <th class="px-3 py-2 text-left">{m.audit_col_issues()}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {#each user.violating as row (row.mediaId)}
                                        <tr
                                            class="border-t border-surface-700/50 hover:bg-surface-800/30">
                                            <td
                                                class="px-3 py-2 text-surface-200 max-w-[280px] truncate"
                                                title={row.title}>
                                                {row.title}
                                            </td>
                                            <td class="px-3 py-2 text-surface-400"
                                                >{row.mediaType}</td>
                                            <td
                                                class="px-3 py-2 text-right font-mono text-surface-300">
                                                {formatDuration(row.resumePositionMs)}
                                            </td>
                                            <td
                                                class="px-3 py-2 text-right font-mono text-surface-300">
                                                {formatRatio(row.ratio)}
                                            </td>
                                            <td
                                                class="px-3 py-2 text-right font-mono text-surface-400">
                                                {formatDuration(row.runtimeMs)}
                                            </td>
                                            <td class="px-3 py-2 text-muted">
                                                {formatRelative(row.updatedAt)}
                                            </td>
                                            <td class="px-3 py-2">
                                                <div class="flex flex-wrap gap-1">
                                                    {#each row.violations as v (v)}
                                                        {@const info = invariantInfo(v)}
                                                        <span
                                                            class="px-1.5 py-0.5 rounded text-[10px] {invariantBadgeClass(
                                                                v,
                                                            )}"
                                                            title={info.title}>
                                                            {info.label}
                                                        </span>
                                                    {/each}
                                                    {#if row.isPhantomShadow}
                                                        {@const info =
                                                            invariantInfo('phantom-shadow')}
                                                        <span
                                                            class="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-300"
                                                            title={info.title}>
                                                            {info.label}
                                                        </span>
                                                    {/if}
                                                </div>
                                            </td>
                                        </tr>
                                    {/each}
                                </tbody>
                            </table>
                        </div>
                    </details>
                {/each}
            </div>
        </div>
    {/if}
</div>
