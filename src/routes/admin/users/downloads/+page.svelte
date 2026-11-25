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
    // First page as it was when "Load more" was first used: the auto-refresh must not
    // replace it, or rows pushed off it by new downloads would fall between the pages.
    let frozenFirst = $state<Row[] | null>(null);
    let nextBefore = $state<string | undefined>(undefined);
    // One "Load more" request at a time; the generation drops an answer that a filter
    // change made obsolete.
    let loadingMore = $state(false);
    let moreGen = 0;
    let userFilter = $state('');
    let kindFilter = $state<'all' | 'video' | 'music'>('all');
    let filterTimer: ReturnType<typeof setTimeout> | undefined;
    // Grouped rows the admin opened, by group id: the single downloads, and the group size
    // they were loaded for (a sync still running grows, and its members are loaded again).
    let groupMembers = $state<Record<string, { count: number; rows: Row[] } | undefined>>({});
    const GROUP_MEMBER_LIMIT = 1000;

    const kindParam = (): 'video' | 'music' | undefined =>
        kindFilter === 'all' ? undefined : kindFilter;

    // Each request takes a number; a response only counts while it is still the newest,
    // so a slow answer for an old filter cannot overwrite a newer one.
    let loadSeq = 0;

    async function load(): Promise<void> {
        const user = userFilter.trim() || undefined;
        const seq = ++loadSeq;
        const { data: res, error } = await getAdminDownloads({
            user,
            kind: kindParam(),
            limit: PAGE_SIZE,
        });
        if (seq !== loadSeq) return;
        if (error || !res) {
            toasts.error(m.admin_downloads_load_failed());
            return;
        }
        data = res;
        // A refresh replaces the first page only. Once the first page is frozen (Load more
        // was used, even if its answer is still on the way) the cursor belongs to the
        // frozen page and a refresh must not move it.
        if (frozenFirst === null) nextBefore = res.nextBefore;
        // An open group that gained downloads since: load its members again.
        for (const r of res.events) {
            const open = groupMembers[r.id];
            if (open && open.count !== r.count) void loadMembers(r.id, r.count);
        }
    }

    // The newest members request per group: an older answer (a re-open, or a refresh while
    // one was loading) must not land over a newer one.
    const membersSeq: Record<string, number> = {};

    async function loadMembers(id: string, count: number): Promise<void> {
        const seq = (membersSeq[id] = (membersSeq[id] ?? 0) + 1);
        const { data: res, error } = await getAdminDownloads({ group: id });
        // Closed (or filter changed) while loading, or a newer request was sent: drop it.
        if (!(id in groupMembers) || seq !== membersSeq[id]) return;
        if (error || !res) {
            // Close it again, so the row does not stay open and empty; a click retries.
            delete groupMembers[id];
            toasts.error(m.admin_downloads_load_failed());
            return;
        }
        groupMembers[id] = { count, rows: res.events };
    }

    function toggleGroup(r: Row): void {
        if (r.id in groupMembers) {
            delete groupMembers[r.id];
            return;
        }
        groupMembers[r.id] = undefined;
        void loadMembers(r.id, r.count);
    }

    async function loadMore(): Promise<void> {
        if (!nextBefore || loadingMore) return;
        const user = userFilter.trim() || undefined;
        const cursor = nextBefore;
        const gen = moreGen;
        // Freeze the first page BEFORE awaiting: a refresh that lands while this request
        // is in flight must neither replace the page nor move the cursor under it.
        if (!frozenFirst) frozenFirst = (data?.events ?? []).filter((e) => e.outcome);
        loadingMore = true;
        try {
            const { data: res, error } = await getAdminDownloads({
                user,
                kind: kindParam(),
                before: cursor,
                limit: PAGE_SIZE,
            });
            // The filter changed while this page was loading: it belongs to the old filter.
            if (gen !== moreGen || user !== (userFilter.trim() || undefined)) return;
            if (error || !res) {
                toasts.error(m.admin_downloads_load_failed());
                return;
            }
            older = [...older, ...res.events];
            nextBefore = res.nextBefore;
        } finally {
            if (gen === moreGen) loadingMore = false;
        }
    }

    function reloadFiltered(): void {
        moreGen++;
        loadingMore = false;
        older = [];
        frozenFirst = null;
        groupMembers = {};
        void load();
    }

    function onFilterInput(): void {
        clearTimeout(filterTimer);
        filterTimer = setTimeout(reloadFiltered, 300);
    }

    function setKind(k: 'all' | 'video' | 'music'): void {
        if (k === kindFilter) return;
        kindFilter = k;
        clearTimeout(filterTimer);
        reloadFiltered();
    }

    const kindOptions = [
        { value: 'all', label: () => m.admin_downloads_kind_all() },
        { value: 'video', label: () => m.admin_downloads_kind_video() },
        { value: 'music', label: () => m.admin_downloads_kind_music() },
    ] as const;

    onMount(() => {
        void load();
        const timer = setInterval(() => void load(), REFRESH_MS);
        return () => {
            clearInterval(timer);
            clearTimeout(filterTimer);
        };
    });

    // Rows still running are shown in "Running now", not repeated in the history.
    const history = $derived([
        ...(frozenFirst ?? (data?.events ?? []).filter((e) => e.outcome)),
        ...older,
    ]);

    function speed(bytesPerSec: number): string {
        if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
        if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
        return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
    }

    function countLabel(count: number, mediaType: string | undefined): string {
        const n = String(count);
        if (mediaType === 'track') return m.admin_downloads_group_tracks({ count: n });
        if (mediaType === 'episode') return m.admin_downloads_group_episodes({ count: n });
        if (mediaType === 'movie') return m.admin_downloads_group_movies({ count: n });
        return m.admin_downloads_group_items({ count: n });
    }

    /** A grouped row: what its downloads share (album, series and season), and how many. */
    function groupTitleOf(r: Row): string {
        const seasonLabel = (s: number) =>
            m.admin_downloads_season({ season: String(s).padStart(2, '0') });
        const what = r.album
            ? [r.artist, r.album].filter(Boolean).join(' · ')
            : r.seriesTitle
              ? r.season != null
                  ? `${r.seriesTitle} - ${seasonLabel(r.season)}`
                  : r.seriesTitle
              : '';
        const label = countLabel(r.count, r.mediaType);
        return what ? `${what} (${label})` : label;
    }

    function titleOf(r: {
        title?: string;
        seriesTitle?: string;
        season?: number;
        episode?: number;
        archive?: boolean;
        artist?: string;
        album?: string;
    }): string {
        if (!r.title) return '—';
        if (r.artist || r.album) return [r.artist, r.album, r.title].filter(Boolean).join(' · ');
        if (r.archive) {
            // A ZIP of a series (title = the series) or of one season (series + "Season NN").
            const what = !r.seriesTitle
                ? r.title
                : r.season != null
                  ? `${r.seriesTitle} - ${m.admin_downloads_season({ season: String(r.season).padStart(2, '0') })}`
                  : `${r.seriesTitle} · ${r.title}`;
            return `${what} (${m.admin_downloads_zip()})`;
        }
        if (!r.seriesTitle) return r.title;
        const ep =
            r.season != null && r.episode != null
                ? ` ${m.admin_downloads_episode({ season: r.season, episode: r.episode })}`
                : '';
        return `${r.seriesTitle}${ep} · ${r.title}`;
    }

    /** A download inside an open group: only what the group row does not already say. */
    function memberTitleOf(e: Row, group: Row): string {
        if (!e.title) return '—';
        if (group.album && e.album === group.album) return e.title;
        if (group.seriesTitle && e.seriesTitle === group.seriesTitle) {
            return e.season != null && e.episode != null
                ? `${m.admin_downloads_episode({ season: e.season, episode: e.episode })} · ${e.title}`
                : e.title;
        }
        return titleOf(e);
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
        <div class="flex flex-wrap items-end gap-4">
            <label class="flex flex-col gap-1 text-sm text-surface-400">
                {m.admin_downloads_filter_user()}
                <input
                    type="search"
                    class="rounded-lg border border-surface-600 bg-surface-800 px-3 py-2 text-surface-200"
                    placeholder={m.admin_downloads_filter_placeholder()}
                    bind:value={userFilter}
                    oninput={onFilterInput} />
            </label>
            <div class="flex flex-col gap-1 text-sm text-surface-400">
                <span id="dl-kind-label">{m.admin_downloads_filter_kind()}</span>
                <div
                    role="group"
                    aria-labelledby="dl-kind-label"
                    class="flex rounded-lg border border-surface-600 bg-surface-800 p-0.5">
                    {#each kindOptions as o (o.value)}
                        <button
                            type="button"
                            aria-pressed={kindFilter === o.value}
                            class="rounded-md px-3 py-1.5 {kindFilter === o.value
                                ? 'bg-surface-600 text-white'
                                : 'text-surface-300 hover:text-white'}"
                            onclick={() => setKind(o.value)}>{o.label()}</button>
                    {/each}
                </div>
            </div>
        </div>
        {#if data}
            <div class="text-sm text-surface-300">
                <span class="text-surface-400">{m.admin_downloads_total_speed()}:</span>
                <span class="font-medium text-white">{totalLabel}</span>
            </div>
        {/if}
    </div>

    {#if data?.degraded}
        <p role="status" class="rounded-lg bg-warning-500/10 px-4 py-2 text-sm text-warning-300">
            {m.admin_downloads_degraded()}
        </p>
    {/if}

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
                                <td class="whitespace-nowrap px-4 py-2 text-surface-400"
                                    >{sizeOf(row)}</td>
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
                            {@const isOpen = r.id in groupMembers}
                            {@const members = groupMembers[r.id]}
                            <tr class="border-t border-surface-700/60">
                                <td class="whitespace-nowrap px-4 py-2 text-surface-400"
                                    >{formatDateTime(r.startedAt, getLocale())}</td>
                                <td class="px-4 py-2 text-surface-200">{r.username ?? r.userId}</td>
                                <td class="px-4 py-2 text-surface-200">
                                    {#if r.count > 1}
                                        <button
                                            type="button"
                                            class="flex items-start gap-2 text-left hover:text-white"
                                            aria-expanded={isOpen}
                                            onclick={() => toggleGroup(r)}>
                                            <span
                                                aria-hidden="true"
                                                class="inline-block w-3 text-surface-400 transition-transform {isOpen
                                                    ? 'rotate-90'
                                                    : ''}">▸</span>
                                            <span>{groupTitleOf(r)}</span>
                                        </button>
                                    {:else}
                                        {titleOf(r)}
                                    {/if}
                                </td>
                                <td class="px-4 py-2 text-surface-400">{clientOf(r)}</td>
                                <td class="whitespace-nowrap px-4 py-2 text-surface-400"
                                    >{sizeOf(r)}</td>
                                <td class="px-4 py-2 text-surface-200"
                                    >{outcomeLabel(r.outcome)}</td>
                            </tr>
                            {#if isOpen && members}
                                {#each members.rows as e (e.id)}
                                    <tr class="bg-surface-800/40 text-xs">
                                        <td
                                            class="whitespace-nowrap px-4 py-1.5 pl-8 text-surface-500"
                                            >{formatDateTime(e.startedAt, getLocale())}</td>
                                        <td class="px-4 py-1.5"></td>
                                        <td class="px-4 py-1.5 pl-9 text-surface-300"
                                            >{memberTitleOf(e, r)}</td>
                                        <td class="px-4 py-1.5"></td>
                                        <td class="whitespace-nowrap px-4 py-1.5 text-surface-400"
                                            >{sizeOf(e)}</td>
                                        <td class="px-4 py-1.5 text-surface-400"
                                            >{outcomeLabel(e.outcome)}</td>
                                    </tr>
                                {/each}
                                {#if members.rows.length >= GROUP_MEMBER_LIMIT}
                                    <tr class="bg-surface-800/40 text-xs">
                                        <td colspan="6" class="px-4 py-1.5 pl-9 text-surface-400"
                                            >{m.admin_downloads_group_capped({
                                                count: String(GROUP_MEMBER_LIMIT),
                                            })}</td>
                                    </tr>
                                {/if}
                            {/if}
                        {/each}
                    </tbody>
                </table>
            </div>
            {#if nextBefore}
                <button
                    class="text-sm text-primary-300 underline underline-offset-4 disabled:opacity-50"
                    disabled={loadingMore}
                    onclick={() => void loadMore()}>{m.admin_downloads_load_more()}</button>
            {/if}
        {:else if data}
            <p class="text-sm text-surface-400">{m.admin_downloads_none_logged()}</p>
        {/if}
    </section>
</div>
