<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import { AdminPageHeader } from '$lib/components/admin';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import { getAdminDownloads } from '$lib/api/admin';
    import type { AdminDownloadsResponse } from '$lib/schemas/api-admin-responses';
    import { formatFileSize } from '$lib/utils/metric-formatters';
    import { formatDateTime } from '$lib/utils/time-formatting';
    import { getLocale } from '$lib/paraglide/runtime';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages.js';

    type Row = AdminDownloadsResponse['events'][number];

    const PAGE_SIZE = 50;
    const REFRESH_MS = 5_000;

    let data = $state<AdminDownloadsResponse | null>(null);
    let older = $state<Row[]>([]);
    let nextBefore = $state<string | undefined>(undefined);
    let userFilter = $state('');
    let filterTimer: ReturnType<typeof setTimeout> | undefined;

    async function load(): Promise<void> {
        const user = userFilter.trim() || undefined;
        const { data: res, error } = await getAdminDownloads({ user, limit: PAGE_SIZE });
        if (error || !res) {
            toasts.error(m.admin_downloads_load_failed());
            return;
        }
        data = res;
        // A refresh replaces the first page only; "Load more" pages stay below it.
        if (older.length === 0) nextBefore = res.nextBefore;
    }

    async function loadMore(): Promise<void> {
        if (!nextBefore) return;
        const user = userFilter.trim() || undefined;
        const { data: res, error } = await getAdminDownloads({
            user,
            before: nextBefore,
            limit: PAGE_SIZE,
        });
        if (error || !res) {
            toasts.error(m.admin_downloads_load_failed());
            return;
        }
        older = [...older, ...res.events];
        nextBefore = res.nextBefore;
    }

    function onFilterInput(): void {
        clearTimeout(filterTimer);
        filterTimer = setTimeout(() => {
            older = [];
            void load();
        }, 300);
    }

    onMount(() => {
        void load();
        const timer = setInterval(() => void load(), REFRESH_MS);
        return () => {
            clearInterval(timer);
            clearTimeout(filterTimer);
        };
    });

    // Rows still running are shown in "Running now", not repeated in the history.
    const history = $derived([...(data?.events ?? []).filter((e) => e.outcome), ...older]);

    function speed(bytesPerSec: number): string {
        if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
        if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
        return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
    }

    function titleOf(r: {
        title?: string;
        seriesTitle?: string;
        season?: number;
        episode?: number;
    }): string {
        if (!r.title) return '—';
        if (!r.seriesTitle) return r.title;
        const ep =
            r.season != null && r.episode != null
                ? ` ${m.admin_downloads_episode({ season: r.season, episode: r.episode })}`
                : '';
        return `${r.seriesTitle}${ep} · ${r.title}`;
    }

    function surfaceLabel(s: string | undefined): string {
        if (s === 'jellyfin') return m.admin_downloads_surface_jellyfin();
        if (s === 'api') return m.admin_downloads_surface_api();
        if (s === 'web') return m.admin_downloads_surface_web();
        return '';
    }

    function clientOf(r: { clientName?: string; surface?: string }): string {
        return [r.clientName, surfaceLabel(r.surface)].filter(Boolean).join(' · ');
    }

    function outcomeLabel(o: Row['outcome']): string {
        switch (o) {
            case 'completed':
                return m.admin_downloads_outcome_completed();
            case 'aborted':
                return m.admin_downloads_outcome_aborted();
            case 'denied':
                return m.admin_downloads_outcome_denied();
            case 'rate_limited':
                return m.admin_downloads_outcome_rate_limited();
            case 'error':
                return m.admin_downloads_outcome_error();
            default:
                return '';
        }
    }

    function sizeOf(r: { bytesSent: number; bytesTotal?: number }): string {
        const sent = formatFileSize(r.bytesSent);
        return r.bytesTotal ? `${sent} / ${formatFileSize(r.bytesTotal)}` : sent;
    }

    const totalLabel = $derived(
        data
            ? data.totalCapBytesPerSec > 0
                ? m.admin_downloads_total_of_cap({
                      speed: speed(data.totalBytesPerSec),
                      cap: speed(data.totalCapBytesPerSec),
                  })
                : `${speed(data.totalBytesPerSec)} (${m.admin_downloads_unlimited()})`
            : '',
    );
</script>

<svelte:head>
    <title>{m.admin_nav_page_users_downloads()} - Admin</title>
</svelte:head>

<div class="space-y-6">
    <AdminPageHeader
        icon={adminPageIcons['/admin/users/downloads']}
        title={m.admin_nav_page_users_downloads()}
        description={m.admin_nav_desc_users_downloads()} />

    <div class="flex flex-wrap items-end justify-between gap-4">
        <label class="flex flex-col gap-1 text-sm text-surface-400">
            {m.admin_downloads_filter_user()}
            <input
                type="search"
                class="rounded-lg border border-surface-600 bg-surface-800 px-3 py-2 text-surface-200"
                placeholder={m.admin_downloads_filter_placeholder()}
                bind:value={userFilter}
                oninput={onFilterInput} />
        </label>
        {#if data}
            <div class="text-sm text-surface-300">
                <span class="text-surface-400">{m.admin_downloads_total_speed()}:</span>
                <span class="font-medium text-white">{totalLabel}</span>
            </div>
        {/if}
    </div>

    <section aria-labelledby="dl-running" class="space-y-2">
        <h2 id="dl-running" class="font-medium text-white">{m.admin_downloads_running()}</h2>
        {#if data && data.active.length > 0}
            <div class="overflow-x-auto rounded-xl border border-surface-700/60">
                <table class="w-full text-left text-sm">
                    <thead class="text-xs text-surface-400">
                        <tr>
                            <th class="px-4 py-2">{m.admin_downloads_col_user()}</th>
                            <th class="px-4 py-2">{m.admin_downloads_col_title()}</th>
                            <th class="px-4 py-2">{m.admin_downloads_col_client()}</th>
                            <th class="px-4 py-2">{m.admin_downloads_col_size()}</th>
                            <th class="px-4 py-2">{m.admin_downloads_col_speed()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each data.active as a (a.userId + a.fileId + a.startedAt)}
                            {@const row = a}
                            <tr class="border-t border-surface-700/60">
                                <td class="px-4 py-2 text-surface-200"
                                    >{row.username ?? row.userId}</td>
                                <td class="px-4 py-2 text-surface-200">{titleOf(row)}</td>
                                <td class="px-4 py-2 text-surface-400">{clientOf(row)}</td>
                                <td class="px-4 py-2 text-surface-400">{sizeOf(row)}</td>
                                <td class="px-4 py-2 text-surface-200">{speed(row.bytesPerSec)}</td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
        {:else if data}
            <p class="text-sm text-surface-400">{m.admin_downloads_none_running()}</p>
        {/if}
    </section>

    <section aria-labelledby="dl-history" class="space-y-2">
        <h2 id="dl-history" class="font-medium text-white">{m.admin_downloads_history()}</h2>
        {#if history.length > 0}
            <div class="overflow-x-auto rounded-xl border border-surface-700/60">
                <table class="w-full text-left text-sm">
                    <thead class="text-xs text-surface-400">
                        <tr>
                            <th class="px-4 py-2">{m.admin_downloads_col_started()}</th>
                            <th class="px-4 py-2">{m.admin_downloads_col_user()}</th>
                            <th class="px-4 py-2">{m.admin_downloads_col_title()}</th>
                            <th class="px-4 py-2">{m.admin_downloads_col_client()}</th>
                            <th class="px-4 py-2">{m.admin_downloads_col_size()}</th>
                            <th class="px-4 py-2">{m.admin_downloads_col_result()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each history as r (r.id)}
                            <tr class="border-t border-surface-700/60">
                                <td class="whitespace-nowrap px-4 py-2 text-surface-400"
                                    >{formatDateTime(r.startedAt, getLocale())}</td>
                                <td class="px-4 py-2 text-surface-200">{r.username ?? r.userId}</td>
                                <td class="px-4 py-2 text-surface-200">{titleOf(r)}</td>
                                <td class="px-4 py-2 text-surface-400">{clientOf(r)}</td>
                                <td class="px-4 py-2 text-surface-400">{sizeOf(r)}</td>
                                <td class="px-4 py-2 text-surface-200"
                                    >{outcomeLabel(r.outcome)}</td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
            {#if nextBefore}
                <button
                    class="text-sm text-primary-300 underline underline-offset-4"
                    onclick={() => void loadMore()}>{m.admin_downloads_load_more()}</button>
            {/if}
        {:else if data}
            <p class="text-sm text-surface-400">{m.admin_downloads_none_logged()}</p>
        {/if}
    </section>
</div>
