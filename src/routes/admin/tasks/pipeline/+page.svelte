<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onDestroy, untrack } from 'svelte';
    import { appPath } from '$lib/shared/api-urls';
    import {
        adminWorkspaceUrl,
        writeAdminWorkspaceUrl,
    } from '$lib/components/admin/admin-workspace-url';
    import { page } from '$app/stores';
    import { resolve } from '$lib/paths';
    import type { PageData } from './$types';
    import type { StageStatus } from '$lib/types/pipeline.js';
    import IngestMap from '$lib/components/admin/coverage/IngestMap.svelte';
    import CoverageGrid from '$lib/components/admin/coverage/CoverageGrid.svelte';
    import HelpPopover from '$lib/components/admin/HelpPopover.svelte';
    import TermTooltip from '$lib/components/admin/glossary/TermTooltip.svelte';
    import { AdminPageHeader } from '$lib/components/admin/index.js';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons.js';
    import * as m from '$lib/paraglide/messages.js';
    import { tabItemsOf } from '$lib/config/admin-search-meta';
    import { searchMeta } from './search-meta';

    interface Props {
        data: PageData;
    }

    const { data }: Props = $props();

    // Threaded down to IngestMap/CoverageGrid so raw stage ids only ever
    // surface for operators who opted into Developer tooling (admin IA
    // redesign, spec §3.3 "raw ids only in dev mode").
    let devMode = $derived($page.data.devToolsEnabled === true);

    type PipelineView = 'flow' | 'completion';

    // ── Completion-view response shapes ──────────────────────────────────────
    // No Zod schema exists for the coverage endpoint, so type it explicitly.
    // Shape mirrors GET /api/admin/library/coverage's `json({ items, summary,
    // limit, offset })` and the CoverageGridItem / CoverageGridSummary types
    // in coverage-grid.queries.ts.
    interface CoverageItem {
        id: string;
        title: string;
        media_type: string;
        library_group_id: string | null;
        stage_completion: Record<string, StageStatus>;
        added_at: string;
        series_title?: string | null;
        season_number?: number | null;
        episode_number?: number | null;
    }
    interface CoverageSummary {
        total: number;
        completed: number;
        in_progress: number;
        failed: number;
        pending: number;
        skipped: number;
        obsolete: number;
    }
    interface CoverageResponse {
        items: CoverageItem[];
        summary: CoverageSummary;
        page: { limit: number; offset?: number; hasMore: boolean; nextCursor?: string };
    }

    const COMPLETION_PAGE_SIZE = 50;

    function readInitialView(): PipelineView {
        return $page.url.searchParams.get('view') === 'completion' ? 'completion' : 'flow';
    }

    let view = $state<PipelineView>(readInitialView());

    // ── Completion filters (client-only — never re-run the server load) ───────
    let mediaTypeFilter = $state<string>($page.url.searchParams.get('mediaType') ?? '');
    let incompleteOnly = $state<boolean>($page.url.searchParams.get('incompleteOnly') === '1');
    // `missingStage` has no dropdown (it's an internal stage id), but the old
    // /admin/library/coverage drill-downs deep-link it (the redirect shim
    // forwards it), so we honour an incoming value and surface a clearable chip
    // rather than silently dropping the filter.
    let missingStageFilter = $state<string>($page.url.searchParams.get('missingStage') ?? '');
    let completionSearch = $state<string>($page.url.searchParams.get('search') ?? '');

    // ── Lazy Completion state ─────────────────────────────────────────────────
    // The coverage query can be slow/cold, so we never fetch it on the default
    // Flow view. The first switch to Completion (and any filter change) kicks
    // off a fetch; results are cached in `completionItems` until filters change.
    let completionItems = $state<CoverageItem[]>([]);
    let completionSummary = $state<CoverageSummary | null>(null);
    let completionLoading = $state<boolean>(false);
    let completionError = $state<string | null>(null);
    let completionLoaded = $state<boolean>(false);
    let completionHasMore = $state<boolean>(false);
    // Monotonic request id: filter changes fire overlapping fetches, so a stale
    // response must not clobber a newer one. Only the latest request commits.
    let completionReqSeq = 0;

    function buildCoverageUrl(offset: number): string {
        // Use a URL (not a bare URLSearchParams) so we stay clear of the
        // svelte/prefer-svelte-reactivity rule — this is a transient builder,
        // not reactive state, and mirrors how the sibling runs/system-health
        // pages assemble query strings.
        const url = new URL(appPath('/api/admin/library/coverage'), $page.url.origin);
        if (completionSearch.trim()) url.searchParams.set('search', completionSearch.trim());
        if (mediaTypeFilter) url.searchParams.set('mediaType', mediaTypeFilter);
        if (incompleteOnly) url.searchParams.set('incompleteOnly', '1');
        if (missingStageFilter) url.searchParams.set('missingStage', missingStageFilter);
        url.searchParams.set('limit', String(COMPLETION_PAGE_SIZE));
        url.searchParams.set('offset', String(offset));
        return url.pathname + url.search;
    }

    async function fetchCoverage(offset: number, append: boolean): Promise<void> {
        const reqId = ++completionReqSeq;
        completionLoading = true;
        completionError = null;
        try {
            const res = await fetch(buildCoverageUrl(offset));
            if (!res.ok) {
                throw new Error(m.admin_pipeline_coverage_failed({ status: res.status }));
            }
            const body = (await res.json()) as CoverageResponse;
            // A newer request superseded this one — discard the stale result.
            if (reqId !== completionReqSeq) return;
            completionSummary = body.summary;
            completionItems = append ? [...completionItems, ...body.items] : body.items;
            completionHasMore = body.page.hasMore;
            completionLoaded = true;
        } catch (err) {
            if (reqId !== completionReqSeq) return;
            completionError = err instanceof Error ? err.message : String(err);
        } finally {
            // Only the latest request owns the loading flag — a superseded
            // request finishing must not clear the spinner for the live one.
            if (reqId === completionReqSeq) completionLoading = false;
        }
    }

    function selectView(next: PipelineView): void {
        if (next === view) return;
        if (next === 'flow') clearTimeout(searchDebounce);
        view = next;
        const url = new URL(adminWorkspaceUrl($page.url, $page.state));
        if (next === 'flow') url.searchParams.delete('view');
        else url.searchParams.set('view', next);
        // Shallow URL update — no server load re-run, so the Flow payload and
        // its live SSE feed survive a toggle to Completion and back.
        writeAdminWorkspaceUrl(url, $page.state, true);
    }

    function applyCompletionFilters(): void {
        clearTimeout(searchDebounce);
        const url = new URL(adminWorkspaceUrl($page.url, $page.state));
        for (const [key, value] of Object.entries({
            mediaType: mediaTypeFilter,
            incompleteOnly: incompleteOnly ? '1' : '',
            missingStage: missingStageFilter,
            search: completionSearch.trim(),
        })) {
            if (value) url.searchParams.set(key, value);
            else url.searchParams.delete(key);
        }
        writeAdminWorkspaceUrl(url, $page.state, true);
    }

    function clearMissingStage(): void {
        missingStageFilter = '';
        applyCompletionFilters();
    }

    function loadMoreCompletion(): void {
        if (completionLoading) return;
        void fetchCoverage(completionItems.length, true);
    }

    let searchDebounce: ReturnType<typeof setTimeout> | undefined;

    function handleSearchInput(): void {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(applyCompletionFilters, 400);
    }

    let lastFilterKey: string | undefined;
    $effect(() => {
        const url = adminWorkspaceUrl($page.url, $page.state);
        const nextView = url.searchParams.get('view') === 'completion' ? 'completion' : 'flow';
        const nextMediaType = url.searchParams.get('mediaType') ?? '';
        const nextIncomplete = url.searchParams.get('incompleteOnly') === '1';
        const nextMissingStage = url.searchParams.get('missingStage') ?? '';
        const nextSearch = url.searchParams.get('search') ?? '';
        const key = JSON.stringify([nextMediaType, nextIncomplete, nextMissingStage, nextSearch]);
        untrack(() => {
            clearTimeout(searchDebounce);
            view = nextView;
            mediaTypeFilter = nextMediaType;
            incompleteOnly = nextIncomplete;
            missingStageFilter = nextMissingStage;
            completionSearch = nextSearch;
            if (key !== lastFilterKey) {
                lastFilterKey = key;
                completionReqSeq++;
                completionLoaded = false;
                completionLoading = false;
                completionItems = [];
                completionSummary = null;
                completionHasMore = false;
            }
            if (view === 'completion' && !completionLoaded && !completionLoading) {
                void fetchCoverage(0, false);
            }
        });
    });

    onDestroy(() => {
        clearTimeout(searchDebounce);
        completionReqSeq++;
    });
</script>

<svelte:head>
    <title>{m.admin_pipeline_page_title()}</title>
</svelte:head>

<section class="space-y-4">
    <AdminPageHeader
        icon={adminPageIcons['/admin/tasks/pipeline'] ?? adminPageIcons['/admin/tasks']}
        title={m.admin_pipeline_heading()}
        description={m.admin_pipeline_subtitle()}>
        <!-- Three paragraphs max (HelpPopover's budget). One per tab plus how
             live the map is; the "Completed last hour" ticker line went — that
             strip is labelled on screen. -->
        <HelpPopover learnMoreHref={resolve('/admin/help/tasks#pipeline')}>
            <p>
                <strong>{m.admin_pipeline_tab_flow()}</strong>
                {m.admin_pipeline_help_flow()}
            </p>
            <p>{m.admin_pipeline_help_realtime()}</p>
            <p>
                <strong>{m.admin_pipeline_tab_completion()}</strong>
                {m.admin_pipeline_help_completion()}
            </p>
        </HelpPopover>
    </AdminPageHeader>

    <div
        class="inline-flex rounded-lg border border-zinc-700 bg-zinc-900 p-0.5"
        role="tablist"
        aria-label={m.admin_pipeline_view_label()}>
        {#each tabItemsOf(searchMeta) as tab (tab.id)}
            <button
                type="button"
                role="tab"
                aria-selected={view === tab.id}
                class="rounded-md px-3 py-1 text-sm transition-colors {view === tab.id
                    ? 'bg-zinc-700 text-white'
                    : 'text-zinc-400 hover:text-zinc-100'}"
                onclick={() => selectView(tab.id as PipelineView)}>
                {tab.label}
            </button>
        {/each}
    </div>

    {#if view === 'flow'}
        <IngestMap initial={data.initial} {devMode} />
    {:else}
        <div class="space-y-4">
            <div class="flex flex-wrap items-center gap-3">
                <input
                    type="search"
                    placeholder={m.admin_pipeline_search_titles()}
                    bind:value={completionSearch}
                    class="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200 min-w-48"
                    oninput={(event) => {
                        completionSearch = event.currentTarget.value;
                        handleSearchInput();
                    }} />
                <label class="flex items-center gap-2 text-sm text-zinc-400">
                    {m.route_admin_library_col_type()}
                    <select
                        class="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
                        bind:value={mediaTypeFilter}
                        onchange={(event) => {
                            mediaTypeFilter = event.currentTarget.value;
                            applyCompletionFilters();
                        }}>
                        <option value="">{m.tab_all()}</option>
                        <option value="movie">{m.movies()}</option>
                        <option value="series">{m.media_series()}</option>
                        <option value="episode">{m.episodes()}</option>
                        <option value="track">{m.media_music()}</option>
                    </select>
                </label>
                <label class="flex items-center gap-2 text-sm text-zinc-400">
                    <input
                        type="checkbox"
                        class="rounded border-zinc-700 bg-zinc-900"
                        bind:checked={incompleteOnly}
                        onchange={(event) => {
                            incompleteOnly = event.currentTarget.checked;
                            applyCompletionFilters();
                        }} />
                    {m.admin_pipeline_incomplete_only()}
                </label>

                {#if missingStageFilter}
                    <span
                        class="inline-flex items-center gap-1.5 rounded-full border border-amber-700/60 bg-amber-950/40 px-2.5 py-1 text-xs text-amber-200"
                        title={m.admin_pipeline_missing_step_tooltip()}>
                        {m.admin_pipeline_missing_step()}
                        <code class="font-mono">{missingStageFilter}</code>
                        <button
                            type="button"
                            class="rounded-full px-1 leading-none text-amber-300/80 hover:bg-amber-800/40 hover:text-amber-100"
                            aria-label={m.admin_pipeline_clear_missing_step()}
                            onclick={clearMissingStage}>
                            ×
                        </button>
                    </span>
                {/if}

                {#if completionSummary}
                    {@const notNeeded = Math.max(
                        0,
                        completionSummary.total -
                            completionSummary.completed -
                            completionSummary.in_progress -
                            completionSummary.failed -
                            completionSummary.pending,
                    )}
                    <!-- Full-width row so it wraps instead of running off the
                         card edge ("38 pending" was cut off). -->
                    <div class="flex w-full flex-wrap justify-end gap-x-4 gap-y-1 text-sm">
                        <span class="text-zinc-400">
                            <TermTooltip term="step"
                                >{m.admin_pipeline_summary_steps({
                                    count: completionSummary.total.toLocaleString(),
                                })}</TermTooltip>
                        </span>
                        <span class="text-emerald-400"
                            >{m.admin_pipeline_summary_complete({
                                count: completionSummary.completed.toLocaleString(),
                            })}</span>
                        <span class="text-sky-400"
                            >{m.admin_pipeline_summary_running({
                                count: completionSummary.in_progress.toLocaleString(),
                            })}</span>
                        <span class="text-red-400"
                            >{m.admin_pipeline_summary_failed({
                                count: completionSummary.failed.toLocaleString(),
                            })}</span>
                        <span class="text-zinc-500">
                            <TermTooltip term="backlog"
                                >{m.admin_pipeline_summary_pending({
                                    count: completionSummary.pending.toLocaleString(),
                                })}</TermTooltip>
                        </span>
                        <!-- The remainder the other numbers leave out — without it
                             "1,489,907 steps · 782,625 complete" looked like half
                             the library was unprocessed. -->
                        <span
                            class="text-zinc-500"
                            title={m.admin_pipeline_summary_not_needed_title()}
                            >{m.admin_pipeline_summary_not_needed({
                                count: notNeeded.toLocaleString(),
                            })}</span>
                    </div>
                {/if}
            </div>

            {#if completionError}
                <p
                    class="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-300">
                    {m.admin_pipeline_load_failed()}
                    {completionError}
                    <button
                        type="button"
                        class="ml-2 underline"
                        disabled={completionLoading}
                        onclick={() => void fetchCoverage(0, false)}>{m.common_retry()}</button>
                </p>
            {/if}

            {#if completionLoading && !completionLoaded}
                <p class="px-3 py-8 text-center text-sm text-zinc-500">
                    {m.admin_pipeline_loading_grid()}
                </p>
            {:else if completionLoaded}
                <CoverageGrid items={completionItems} {devMode} />
                {#if completionHasMore}
                    <button
                        type="button"
                        class="rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-50"
                        disabled={completionLoading}
                        onclick={loadMoreCompletion}>
                        {completionLoading ? m.card_file_info_loading() : m.section_load_more()}
                    </button>
                {/if}
            {/if}
        </div>
    {/if}
</section>
