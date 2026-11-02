<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Everything apps report — playback incidents (the former standalone page,
  now `?kind=playback_incident`), crashes, hangs, JS errors, API failures and
  log bundles — as one filterable/sortable flat list. Row click opens the
  detail drawer: `playback_incident` reuses the legacy detail endpoint and
  PlaybackIncidentDetail.svelte verbatim; every other kind gets the generic
  ClientDiagnosticDetail.svelte (rich per-kind views arrive in sub-project 6).

  UX pass (2026-09-27): table becomes stacked cards below `md` so a long
  device string can never widen the page; the Device column is parsed from a
  raw User-Agent into a short label (full UA kept as a tooltip); kind and
  resolved state render as colored pills; the user filter is a select built
  from users seen so far rather than a raw id box.
-->
<script lang="ts">
    import { SvelteURLSearchParams, SvelteMap } from 'svelte/reactivity';
    import { Icon, Trash } from 'svelte-hero-icons';
    import { page } from '$app/state';
    import { goto } from '$app/navigation';
    import { AdminPageHeader } from '$lib/components/admin/index.js';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons.js';
    import AsyncSection from '$lib/components/admin/AsyncSection.svelte';
    import DetailPanel from '$lib/components/admin/detail/DetailPanel.svelte';
    import PlaybackIncidentDetail from '$lib/components/admin/playback/PlaybackIncidentDetail.svelte';
    import ClientDiagnosticDetail from '$lib/components/admin/diagnostics/ClientDiagnosticDetail.svelte';
    import ConfirmModal from '$lib/components/ui/ConfirmModal.svelte';
    import { modals } from '$lib/stores/modal.store';
    import { toasts } from '$lib/stores/toast.store';
    import { apiGet, apiDelete } from '$lib/api/client.js';
    import {
        DIAGNOSTIC_KINDS,
        ClientDiagnosticListResponseSchema,
        ClientDiagnosticClearedResponseSchema,
        ClientDiagnosticDetailSchema,
        type DiagnosticKind,
        type ClientDiagnosticSummary,
        type ClientDiagnosticDetail as ClientDiagnosticDetailType,
    } from '$lib/schemas/client-diagnostics.js';
    import {
        PlaybackIncidentDetailResponseSchema,
        type PlaybackIncidentDetailResponse,
    } from '$lib/schemas/api-playback-incidents.js';
    import { classifyError, type ClassifiedError } from '$lib/utils/admin/error-contract.js';
    import {
        deviceLabel,
        isBrowserUserAgent,
    } from '$lib/components/admin/client-diagnostics/user-agent.js';
    import { kindBadgeColor } from '$lib/components/admin/client-diagnostics/kind-badge.js';
    import { relativeTime } from '$lib/utils/relative-time.js';
    import * as m from '$lib/paraglide/messages.js';
    import type { PageData } from './$types';

    let { data }: { data: PageData } = $props();

    const PAGE_SIZE = 50;
    const PLATFORMS = ['ios', 'tvos', 'web', 'other'] as const;

    function kindLabel(kind: DiagnosticKind): string {
        switch (kind) {
            case 'playback_incident':
                return m.admin_clientdiag_kind_playback_incident();
            case 'crash':
                return m.admin_clientdiag_kind_crash();
            case 'hang':
                return m.admin_clientdiag_kind_hang();
            case 'js_error':
                return m.admin_clientdiag_kind_js_error();
            case 'api_failures':
                return m.admin_clientdiag_kind_api_failures();
            case 'log_bundle':
                return m.admin_clientdiag_kind_log_bundle();
            case 'compat_incident':
                return m.admin_clientdiag_kind_compat_incident();
        }
    }

    // Playback-incident summaries fall back to the raw machine trigger token
    // (see summaryFor() in $lib/server/services/client-diagnostics/summary.ts)
    // when the client didn't send a human message — 'terminal' (the
    // page-hide beacon: the stall→nudge→rebuild sequence never resolved
    // before the tab was hidden/closed), 'retries-exhausted' (the reconnect
    // budget ran out) and 'reconnect' (the player recovered after a stall).
    // Known tokens get a friendly label; anything else falls back to a
    // sentence-cased version of the raw value rather than the raw token.
    function incidentSummaryLabel(raw: string): string {
        switch (raw) {
            case 'terminal':
                return m.admin_clientdiag_summary_terminal();
            case 'retries-exhausted':
                return m.admin_clientdiag_summary_retries_exhausted();
            case 'reconnect':
                return m.admin_clientdiag_summary_reconnect();
            default: {
                // A message with a space is already a human-written string
                // (e.g. "decode failed") — only reshape single-token machine
                // values like 'session-ended'.
                if (/\s/.test(raw)) return raw;
                const spaced = raw.replace(/[-_]+/g, ' ').trim();
                return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : raw;
            }
        }
    }

    function summaryLabel(row: ClientDiagnosticSummary): string {
        if (!row.summary) return '—';
        return row.kind === 'playback_incident' ? incidentSummaryLabel(row.summary) : row.summary;
    }

    function platformLabel(platform: string): string {
        switch (platform) {
            case 'ios':
                return m.admin_clientdiag_platform_ios();
            case 'tvos':
                return m.admin_clientdiag_platform_tvos();
            case 'web':
                return m.admin_clientdiag_platform_web();
            default:
                return m.admin_clientdiag_platform_other();
        }
    }

    /** `platform: "other"` from a browser session (item 4 on prod): the client sends
     *  its own platform, and a browser-like device string is the only display-side
     *  signal available here — derive "web" for display without touching ingestion. */
    function displayPlatform(row: ClientDiagnosticSummary): { code: string; derived: boolean } {
        if (row.platform !== 'other') return { code: row.platform, derived: false };
        const raw = row.deviceName ?? row.deviceId ?? '';
        if (raw && isBrowserUserAgent(raw)) return { code: 'web', derived: true };
        return { code: 'other', derived: false };
    }

    // URL-persisted filters — `$app/state`'s `page.url.searchParams` is
    // reactive, so these stay in sync with back/forward and shared links.
    let kindFilter = $derived(page.url.searchParams.get('kind') ?? '');
    let platformFilter = $derived(page.url.searchParams.get('platform') ?? '');
    let userIdFilter = $derived(page.url.searchParams.get('userId') ?? '');
    let deviceIdFilter = $derived(page.url.searchParams.get('deviceId') ?? '');
    let qFilter = $derived(page.url.searchParams.get('q') ?? '');

    function setUrlParam(key: string, value: string): void {
        const params = new SvelteURLSearchParams(page.url.searchParams);
        if (value) params.set(key, value);
        else params.delete(key);
        void goto(`?${params.toString()}`, { replaceState: true, keepFocus: true, noScroll: true });
    }

    let items = $state<ClientDiagnosticSummary[]>([]);
    let listLoading = $state(false);
    let listError = $state<ClassifiedError | null>(null);
    let hasMore = $state(false);
    let loadingMore = $state(false);

    // Users seen across every list response so far, for the User filter's
    // <select> (item 5) — grows as the operator loads more/changes filters
    // rather than requiring a dedicated "list users" endpoint.
    let knownUsers = new SvelteMap<string, string>();
    function recordUsers(rows: ClientDiagnosticSummary[]): void {
        for (const row of rows) {
            if (row.userId) knownUsers.set(row.userId, row.username ?? row.userId);
        }
    }

    // Bumped by every `loadList()` call; `loadList`/`loadMore` only commit their
    // result if this still matches the generation they started with. Without
    // it, a slow response for a filter the operator already changed away from
    // can land after a newer, faster one and either overwrite the fresher list
    // or append its rows to the wrong filter's result.
    let listGeneration = 0;

    function listParams(offset: number): URLSearchParams {
        const params = new SvelteURLSearchParams({
            limit: String(PAGE_SIZE),
            offset: String(offset),
        });
        if (kindFilter) params.set('kind', kindFilter);
        if (platformFilter) params.set('platform', platformFilter);
        if (userIdFilter) params.set('userId', userIdFilter);
        if (deviceIdFilter) params.set('deviceId', deviceIdFilter);
        if (qFilter) params.set('q', qFilter);
        return params;
    }

    async function fetchListPage(
        offset: number,
    ): Promise<{ rows: ClientDiagnosticSummary[]; more: boolean } | { error: ClassifiedError }> {
        const {
            data: result,
            error,
            status,
        } = await apiGet(
            `/api/admin/diagnostics?${listParams(offset).toString()}`,
            ClientDiagnosticListResponseSchema,
        );
        if (error || !result) {
            return { error: classifyError(new Error(error ?? undefined), { status }) };
        }
        return { rows: result.items, more: result.page.hasMore };
    }

    async function loadList(): Promise<void> {
        const generation = ++listGeneration;
        listLoading = true;
        listError = null;
        const outcome = await fetchListPage(0);
        if (generation !== listGeneration) return; // superseded by a newer filter
        listLoading = false;
        if ('error' in outcome) {
            listError = outcome.error;
            // Don't leave the previous filter's rows (and its Load more /
            // Clear all) next to the error.
            items = [];
            hasMore = false;
            return;
        }
        items = outcome.rows;
        hasMore = outcome.more;
        recordUsers(outcome.rows);
    }

    async function loadMore(): Promise<void> {
        const generation = listGeneration;
        loadingMore = true;
        const outcome = await fetchListPage(items.length);
        if (generation !== listGeneration) {
            // The filters changed while this page was in flight — appending
            // these rows now would mix two different result sets.
            loadingMore = false;
            return;
        }
        loadingMore = false;
        if ('error' in outcome) {
            toasts.error(m.error_loading({ error: outcome.error.message }));
            return;
        }
        // Offset paging shifts when rows arrive or are cleared in between;
        // drop ids already shown so the keyed each never sees a duplicate.
        const seen = new Set(items.map((i) => i.id));
        items = [...items, ...outcome.rows.filter((r) => !seen.has(r.id))];
        hasMore = outcome.more;
        recordUsers(outcome.rows);
    }

    // Re-fetch whenever the URL's query string changes (filters are
    // shareable/back-forward-able, so the fetch must key off the URL, not
    // off the local `$state` filter mirrors). A filter change can leave the
    // previously-open row out of the new result set, so close the detail
    // panel too rather than showing a detail for a row that's no longer listed.
    $effect(() => {
        void page.url.search;
        closeDetail();
        void loadList();
    });

    // --- Detail panel ---------------------------------------------------

    let selected = $state<{ id: number; kind: DiagnosticKind; shortId: string } | null>(null);
    let playbackDetail = $state<PlaybackIncidentDetailResponse | null>(null);
    let diagnosticDetail = $state<ClientDiagnosticDetailType | null>(null);
    let detailLoading = $state(false);
    let detailError = $state<ClassifiedError | null>(null);

    const detailTabs = [{ id: 'detail', label: m.admin_clientdiag_detail_tab() }] as const;

    // Bumped by every `openRow()` call and by `closeDetail()`. A response only
    // gets to write `playbackDetail`/`diagnosticDetail`/`detailError` if this
    // still matches the request's own id — otherwise clicking row A then row B
    // before A's (slower) response lands would let A overwrite B's panel.
    let detailRequestId = 0;

    async function openRow(row: ClientDiagnosticSummary): Promise<void> {
        const requestId = ++detailRequestId;
        selected = { id: row.id, kind: row.kind, shortId: row.shortId };
        detailLoading = true;
        detailError = null;
        playbackDetail = null;
        diagnosticDetail = null;

        if (row.kind === 'playback_incident') {
            const {
                data: result,
                error,
                status,
            } = await apiGet(
                `/api/admin/playback-incidents/${row.id}`,
                PlaybackIncidentDetailResponseSchema,
            );
            if (requestId !== detailRequestId) return; // superseded by a later click
            detailLoading = false;
            if (error || !result) {
                detailError = classifyError(new Error(error ?? undefined), { status });
                return;
            }
            playbackDetail = result;
            return;
        }

        const {
            data: result,
            error,
            status,
        } = await apiGet(`/api/admin/diagnostics/${row.id}`, ClientDiagnosticDetailSchema);
        if (requestId !== detailRequestId) return; // superseded by a later click
        detailLoading = false;
        if (error || !result) {
            detailError = classifyError(new Error(error ?? undefined), { status });
            return;
        }
        diagnosticDetail = result;
    }

    function closeDetail(): void {
        detailRequestId++; // invalidate any in-flight request for the closed row
        selected = null;
        playbackDetail = null;
        diagnosticDetail = null;
    }

    function formatTimestamp(iso: string): string {
        const parsed = new Date(iso);
        return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
    }

    function formatAgo(iso: string): string {
        const parsed = Date.parse(iso);
        if (!Number.isFinite(parsed)) return '';
        const ms = Date.now() - parsed;
        if (ms < 60_000) return m.admin_tasks_just_now();
        // relativeTime is locale-aware (Intl.RelativeTimeFormat) since the fix
        // for the mixed "letztes Element fertig 4m ago" bug — it no longer
        // needs a wrapper to translate an "ago" suffix that may not even be a
        // suffix in the viewer's language (German prefixes with "vor").
        return relativeTime(iso);
    }

    function rowLabel(row: ClientDiagnosticSummary): string {
        const who = row.username ?? row.userId ?? m.admin_clientdiag_unknown_user();
        return m.admin_clientdiag_row_label({ kind: kindLabel(row.kind), who });
    }

    // --- Clear -----------------------------------------------------------

    let clearing = $state(false);

    function confirmClearOne(row: ClientDiagnosticSummary): void {
        modals.open(ConfirmModal, {
            title: m.admin_clientdiag_confirm_clear_title(),
            body: m.admin_clientdiag_confirm_clear_body({ row: rowLabel(row) }),
            confirmText: m.admin_clientdiag_confirm_clear_button(),
            confirmVariant: 'danger' as const,
            onConfirm: async () => {
                clearing = true;
                const { error, status } = await apiDelete(
                    `/api/admin/diagnostics/${row.id}`,
                    ClientDiagnosticClearedResponseSchema,
                );
                clearing = false;
                // 404 = already gone (another admin, retention, an incident
                // clear): the row should leave the list either way.
                if (error && status !== 404) {
                    toasts.error(m.admin_clientdiag_toast_clear_error({ error }));
                    return;
                }
                items = items.filter((i) => i.id !== row.id);
                if (selected?.id === row.id) closeDetail();
                toasts.success(m.admin_clientdiag_toast_cleared());
            },
        });
    }

    // "Clear all" is disabled while a search term is active — the API
    // rejects a search-scoped clear (422), so there is nothing safe to send.
    let anyFilterActive = $derived(
        Boolean(kindFilter || platformFilter || userIdFilter || deviceIdFilter),
    );
    let clearAllDisabled = $derived(clearing || listLoading || Boolean(qFilter));

    function clearAllScopeText(): string {
        const parts: string[] = [];
        if (kindFilter) parts.push(m.admin_clientdiag_scope_kind({ kind: kindFilter }));
        if (platformFilter)
            parts.push(m.admin_clientdiag_scope_platform({ platform: platformFilter }));
        if (userIdFilter) parts.push(m.admin_clientdiag_scope_user({ user: userIdFilter }));
        if (deviceIdFilter) parts.push(m.admin_clientdiag_scope_device({ device: deviceIdFilter }));
        return parts.length > 0
            ? m.admin_clientdiag_scope_filtered({ parts: parts.join(', ') })
            : m.admin_clientdiag_scope_all();
    }

    function confirmClearAll(): void {
        // Snapshot the scope when the modal opens: the URL (and with it the
        // filters) can change while it is open, and the delete must match the
        // scope the admin confirmed, never widen to all=true.
        const params = new SvelteURLSearchParams();
        if (kindFilter) params.set('kind', kindFilter);
        if (platformFilter) params.set('platform', platformFilter);
        if (userIdFilter) params.set('userId', userIdFilter);
        if (deviceIdFilter) params.set('deviceId', deviceIdFilter);
        if (!anyFilterActive) params.set('all', 'true');
        const scopeQuery = params.toString();
        modals.open(ConfirmModal, {
            title: m.admin_clientdiag_confirm_clear_all_title(),
            body: m.admin_clientdiag_confirm_clear_all_body({ scope: clearAllScopeText() }),
            confirmText: m.admin_clientdiag_confirm_clear_all_button(),
            confirmVariant: 'danger' as const,
            onConfirm: async () => {
                clearing = true;
                const { data: result, error } = await apiDelete(
                    `/api/admin/diagnostics?${scopeQuery}`,
                    ClientDiagnosticClearedResponseSchema,
                );
                clearing = false;
                if (error || !result) {
                    toasts.error(m.admin_clientdiag_toast_clear_all_error({ error: error ?? '' }));
                    return;
                }
                toasts.success(
                    result.cleared === 1
                        ? m.admin_clientdiag_toast_cleared_all_one()
                        : m.admin_clientdiag_toast_cleared_all_many({ count: result.cleared }),
                );
                closeDetail();
                await loadList();
            },
        });
    }
</script>

<svelte:head>
    <title>{m.admin_clientdiag_page_title()}</title>
</svelte:head>

<div class="space-y-6">
    <AdminPageHeader
        title={m.admin_clientdiag_header_title()}
        description={m.admin_clientdiag_description()}
        icon={adminPageIcons['/admin/users/client-diagnostics']} />

    <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:gap-2">
        <label class="flex w-full flex-col gap-1 text-xs text-surface-400 sm:w-auto">
            {m.admin_clientdiag_filter_kind()}
            <select
                class="select select-sm w-full sm:w-auto"
                value={kindFilter}
                onchange={(e) => setUrlParam('kind', e.currentTarget.value)}>
                <option value="">{m.admin_clientdiag_filter_all()}</option>
                {#each DIAGNOSTIC_KINDS as kind (kind)}
                    <option value={kind}>{kindLabel(kind)}</option>
                {/each}
            </select>
        </label>
        <label class="flex w-full flex-col gap-1 text-xs text-surface-400 sm:w-auto">
            {m.admin_clientdiag_filter_platform()}
            <select
                class="select select-sm w-full sm:w-auto"
                value={platformFilter}
                onchange={(e) => setUrlParam('platform', e.currentTarget.value)}>
                <option value="">{m.admin_clientdiag_filter_all()}</option>
                {#each PLATFORMS as platform (platform)}
                    <option value={platform}>{platformLabel(platform)}</option>
                {/each}
            </select>
        </label>
        <label class="flex w-full flex-col gap-1 text-xs text-surface-400 sm:w-auto">
            {m.admin_clientdiag_filter_user()}
            <select
                class="select select-sm w-full sm:w-auto"
                value={userIdFilter}
                onchange={(e) => setUrlParam('userId', e.currentTarget.value)}>
                <option value="">{m.admin_clientdiag_filter_all()}</option>
                {#each [...knownUsers.entries()] as [id, username] (id)}
                    <option value={id}>{username}</option>
                {/each}
                {#if userIdFilter && !knownUsers.has(userIdFilter)}
                    <option value={userIdFilter}>{userIdFilter}</option>
                {/if}
            </select>
        </label>
        <label class="flex w-full flex-col gap-1 text-xs text-surface-400 sm:w-auto">
            {m.admin_clientdiag_filter_device()}
            <input
                class="input input-sm w-full sm:w-auto"
                type="text"
                placeholder={m.admin_clientdiag_device_placeholder()}
                value={deviceIdFilter}
                onchange={(e) => setUrlParam('deviceId', e.currentTarget.value)} />
        </label>
        <label class="flex w-full flex-col gap-1 text-xs text-surface-400 sm:w-auto">
            {m.admin_clientdiag_filter_search()}
            <input
                class="input input-sm w-full sm:w-auto"
                type="search"
                placeholder={m.admin_clientdiag_search_placeholder()}
                value={qFilter}
                onkeydown={(e) => {
                    if (e.key === 'Enter') setUrlParam('q', e.currentTarget.value);
                }}
                oninput={(e) => {
                    // Applied immediately only when the field becomes empty —
                    // clearing via the native "x" (or backspacing to nothing)
                    // must drop `q` from the URL right away, since otherwise
                    // "Clear all" stays disabled and the list stays filtered
                    // with no visible reason why. Non-empty edits still apply
                    // on Enter, not per keystroke.
                    // The native "x" clear fires `input` too, so no
                    // (non-standard, untyped) `onsearch` handler is needed.
                    if (e.currentTarget.value === '') setUrlParam('q', '');
                }} />
        </label>
        <button
            type="button"
            class="btn btn-sm variant-soft-error w-full sm:ml-auto sm:w-auto"
            disabled={clearAllDisabled}
            title={qFilter ? m.admin_clientdiag_clear_all_disabled_title() : undefined}
            onclick={confirmClearAll}>
            <Icon src={Trash} class="h-4 w-4" />
            <span>{m.admin_clientdiag_clear_all()}</span>
        </button>
    </div>

    <AsyncSection
        loading={listLoading}
        error={listError}
        empty={items.length === 0}
        emptyMessage={m.admin_clientdiag_empty()}
        onretry={() => void loadList()}>
        <!-- Table layout — md and up. Below md this becomes a stacked card
             list (item 1): a raw device string could otherwise widen the
             whole page instead of scrolling inside this table. -->
        <div class="hidden overflow-x-auto rounded border border-surface-700/50 md:block">
            <table class="w-full text-sm">
                <thead class="bg-surface-800/60 text-left text-xs uppercase text-surface-400">
                    <tr>
                        <th class="px-3 py-2">{m.admin_clientdiag_col_kind()}</th>
                        <th class="px-3 py-2">{m.admin_clientdiag_col_summary()}</th>
                        <th class="px-3 py-2">{m.admin_clientdiag_col_user()}</th>
                        <th class="px-3 py-2">{m.admin_clientdiag_col_device()}</th>
                        <th class="px-3 py-2">{m.admin_clientdiag_col_platform()}</th>
                        <th class="px-3 py-2">{m.admin_clientdiag_col_app_version()}</th>
                        <th class="px-3 py-2">{m.admin_clientdiag_col_occurred()}</th>
                        <th class="px-3 py-2">{m.admin_clientdiag_col_resolved()}</th>
                        <th class="px-3 py-2"
                            ><span class="sr-only">{m.admin_clientdiag_col_clear_sr()}</span></th>
                    </tr>
                </thead>
                <tbody>
                    {#each items as row (row.id)}
                        {@const device = deviceLabel(row.deviceName, row.deviceId)}
                        {@const platform = displayPlatform(row)}
                        <tr
                            class="cursor-pointer border-t border-surface-700/30 hover:bg-surface-800/40"
                            onclick={() => void openRow(row)}>
                            <td class="px-3 py-2">
                                <span
                                    class="badge-soft-{kindBadgeColor(row.kind)} whitespace-nowrap"
                                    >{kindLabel(row.kind)}</span>
                            </td>
                            <td class="px-3 py-2">{summaryLabel(row)}</td>
                            <td class="px-3 py-2">{row.username ?? row.userId ?? '—'}</td>
                            <td class="px-3 py-2" title={device.tooltip}>{device.label}</td>
                            <td
                                class="px-3 py-2"
                                title={platform.derived
                                    ? m.admin_clientdiag_platform_derived_title()
                                    : undefined}>
                                {platformLabel(platform.code)}
                            </td>
                            <td class="px-3 py-2">{row.appVersion ?? '—'}</td>
                            <td class="px-3 py-2" title={formatAgo(row.occurredAt)}>
                                {formatTimestamp(row.occurredAt)}
                            </td>
                            <td class="px-3 py-2">
                                {#if row.kind === 'playback_incident'}
                                    {#if row.resolvedAt}
                                        <span class="badge-soft-green"
                                            >{m.admin_clientdiag_resolved_yes()}</span>
                                    {:else}
                                        <span
                                            class="badge-status border border-surface-600/50 bg-surface-700/40 text-surface-400"
                                            >{m.admin_clientdiag_resolved_no()}</span>
                                    {/if}
                                {:else}
                                    —
                                {/if}
                            </td>
                            <td class="px-3 py-2 text-right">
                                <button
                                    type="button"
                                    class="rounded p-1 text-surface-500 hover:bg-surface-700/60 hover:text-error-400"
                                    title={m.admin_clientdiag_clear_row_title()}
                                    aria-label={m.admin_clientdiag_clear_row_aria({ id: row.id })}
                                    disabled={clearing}
                                    onclick={(event) => {
                                        event.stopPropagation();
                                        confirmClearOne(row);
                                    }}>
                                    <Icon src={Trash} class="h-4 w-4" />
                                </button>
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>

        <!-- Stacked cards — below md. -->
        <div class="flex flex-col gap-2 md:hidden">
            {#each items as row (row.id)}
                {@const device = deviceLabel(row.deviceName, row.deviceId)}
                {@const platform = displayPlatform(row)}
                <div
                    role="button"
                    tabindex="0"
                    class="flex cursor-pointer flex-col gap-1.5 rounded border border-surface-700/50 bg-surface-800/30 p-3 text-left text-sm"
                    onclick={() => void openRow(row)}
                    onkeydown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            void openRow(row);
                        }
                    }}>
                    <div class="flex items-start justify-between gap-2">
                        <span class="badge-soft-{kindBadgeColor(row.kind)} whitespace-nowrap"
                            >{kindLabel(row.kind)}</span>
                        <button
                            type="button"
                            class="rounded p-1 text-surface-500 hover:bg-surface-700/60 hover:text-error-400"
                            title={m.admin_clientdiag_clear_row_title()}
                            aria-label={m.admin_clientdiag_clear_row_aria({ id: row.id })}
                            disabled={clearing}
                            onclick={(event) => {
                                event.stopPropagation();
                                confirmClearOne(row);
                            }}>
                            <Icon src={Trash} class="h-4 w-4" />
                        </button>
                    </div>
                    <p class="text-surface-100">{summaryLabel(row)}</p>
                    <dl class="grid grid-cols-2 gap-x-2 gap-y-1 text-xs text-surface-400">
                        <dt>{m.admin_clientdiag_col_user()}</dt>
                        <dd class="text-surface-300">{row.username ?? row.userId ?? '—'}</dd>
                        <dt>{m.admin_clientdiag_col_device()}</dt>
                        <dd class="truncate text-surface-300" title={device.tooltip}>
                            {device.label}
                        </dd>
                        <dt>{m.admin_clientdiag_col_platform()}</dt>
                        <dd class="text-surface-300">{platformLabel(platform.code)}</dd>
                        <dt>{m.admin_clientdiag_col_app_version()}</dt>
                        <dd class="text-surface-300">{row.appVersion ?? '—'}</dd>
                        <dt>{m.admin_clientdiag_col_occurred()}</dt>
                        <dd class="text-surface-300" title={formatAgo(row.occurredAt)}>
                            {formatTimestamp(row.occurredAt)}
                        </dd>
                        {#if row.kind === 'playback_incident'}
                            <dt>{m.admin_clientdiag_col_resolved()}</dt>
                            <dd>
                                {#if row.resolvedAt}
                                    <span class="badge-soft-green"
                                        >{m.admin_clientdiag_resolved_yes()}</span>
                                {:else}
                                    <span
                                        class="badge-status border border-surface-600/50 bg-surface-700/40 text-surface-400"
                                        >{m.admin_clientdiag_resolved_no()}</span>
                                {/if}
                            </dd>
                        {/if}
                    </dl>
                </div>
            {/each}
        </div>

        {#if hasMore}
            <div class="mt-3 flex justify-center">
                <button
                    type="button"
                    class="btn btn-sm variant-soft"
                    disabled={loadingMore}
                    onclick={() => void loadMore()}>
                    {loadingMore ? m.admin_clientdiag_loading() : m.admin_clientdiag_load_more()}
                </button>
            </div>
        {/if}
    </AsyncSection>
</div>

{#if selected !== null}
    {@const current = selected}
    <DetailPanel
        titleText={`${kindLabel(current.kind)} · ${current.shortId}`}
        tabs={detailTabs}
        activeTab="detail"
        onTabChange={() => {}}
        mode="panel"
        onclose={closeDetail}>
        <AsyncSection
            loading={detailLoading}
            error={detailError}
            onretry={() => {
                const row = items.find((i) => i.id === current.id);
                if (row) void openRow(row);
            }}>
            {#if playbackDetail}
                <PlaybackIncidentDetail
                    incident={playbackDetail.incident}
                    correlatedTranscodeFailures={playbackDetail.correlatedTranscodeFailures}
                    deliveryWindows={playbackDetail.deliveryWindows}
                    speedTests={playbackDetail.speedTests}
                    roots={data.roots} />
            {:else if diagnosticDetail}
                <ClientDiagnosticDetail diagnostic={diagnosticDetail} />
            {/if}
        </AsyncSection>
    </DetailPanel>
{/if}
