<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  "Broken match" view of the Fix-matches workbench (admin IA redesign, spec
  §3.2): items that WERE matched once whose provider lookup now fails
  permanently (a non-retryable `failed_permanent` stage row). Never-matched
  items are excluded server-side — they live in the other view.

  Same row layout, toolbar and bulk bar as "Never matched", so the two views
  read as one tool. Each row says WHY it is broken (fix-matches-cause.ts) and
  leads with the action that fixes that cause: Retry for a provider timeout
  (stored as permanent by mistake), Fix match for a dead id or wrong type. A
  season/episode is fixed through its series. "Accept as unmatched" is undoable
  from its toast (POST /api/admin/media/[id]/pipeline/unignore).
-->
<script lang="ts">
    import { z } from 'zod';
    import { SvelteSet } from 'svelte/reactivity';
    import { goto } from '$app/navigation';
    import { page } from '$app/state';
    import { Icon, ArrowPath, CheckCircle, MagnifyingGlass, Wrench } from 'svelte-hero-icons';
    import { IdentifyModal } from '$lib/components/admin';
    import ConfirmModal from '$lib/components/ui/ConfirmModal.svelte';
    import { resolve } from '$lib/paths';
    import { apiPost } from '$lib/api/client.js';
    import { toasts } from '$lib/stores/toast.store';
    import { modals } from '$lib/stores/modal.store';
    import { StageActionResponseSchema } from '$lib/schemas/api-attention-responses';
    import { PipelineResetResponseSchema } from '$lib/schemas/pipeline-timeline.schema.js';
    import { pipelineStepName } from '$lib/config/pipeline-step-names.js';
    import * as m from '$lib/paraglide/messages.js';
    import FixMatchRow from './FixMatchRow.svelte';
    import { GENERIC_PERMANENT_FAILURE, type BrokenMatchCause } from './fix-matches-cause.js';
    import { fileName, mediaTypeLabel } from './fix-matches-format.js';
    import type { BrokenMatchData, BrokenMatchRowView } from './fix-matches-types.js';

    interface Props {
        data: BrokenMatchData;
        /** Notifies the host page so it can show a count on the view's tab. */
        ontotalchange?: (total: number) => void;
    }
    let { data, ontotalchange }: Props = $props();

    const UnignoreResponseSchema = z.object({ restored: z.number() });

    let items = $derived(data.items);
    // Overridable derived (Svelte 5.25+): tracks `data.total` across
    // pagination loads, but can be decremented in place on a successful
    // fix/accept so the tab badge and "Showing" line stay live instead of
    // freezing at the page-load count.
    let localTotal = $derived(data.total);
    let busyIds = new SvelteSet<string>();
    const selected = new SvelteSet<string>();
    let bulkBusy = $state(false);

    /** The item Identify runs against: the row itself, or its series. */
    let fixing = $state<{
        id: string;
        title: string;
        type: string;
        year?: number;
        filePath?: string;
        seasonCount?: number;
        episodeCount?: number;
    } | null>(null);

    // svelte-ignore state_referenced_locally
    let search = $state(data.search);
    let searchTimer: ReturnType<typeof setTimeout> | null = null;
    let filtered = $derived(!!data.search || !!data.mediaType);

    $effect(() => {
        ontotalchange?.(localTotal);
    });

    const rangeStart = $derived(localTotal === 0 ? 0 : data.offset + 1);
    const rangeEnd = $derived(Math.min(data.offset + data.pageSize, data.offset + items.length));
    const hasPrev = $derived(data.offset > 0);
    const hasNext = $derived(data.offset + data.pageSize < data.total);

    const CAUSE_LABEL: Record<BrokenMatchCause, () => string> = {
        temporary: m.admin_fix_matches_cause_temporary,
        'stale-id': m.admin_fix_matches_cause_stale_id,
        'wrong-type': m.admin_fix_matches_cause_wrong_type,
        unknown: m.admin_fix_matches_cause_unknown,
    };
    const CAUSE_HINT: Record<BrokenMatchCause, () => string> = {
        temporary: m.admin_fix_matches_cause_temporary_hint,
        'stale-id': m.admin_fix_matches_cause_stale_id_hint,
        'wrong-type': m.admin_fix_matches_cause_wrong_type_hint,
        unknown: m.admin_fix_matches_cause_unknown_hint,
    };
    const CAUSE_CLASS: Record<BrokenMatchCause, string> = {
        temporary: 'bg-sky-500/15 text-sky-300',
        'stale-id': 'bg-amber-500/15 text-amber-300',
        'wrong-type': 'bg-amber-500/15 text-amber-300',
        unknown: 'bg-surface-700 text-surface-300',
    };

    /** Retry leads for causes a retry can plausibly fix. */
    function retryLeads(item: BrokenMatchRowView): boolean {
        return item.cause === 'temporary' || item.cause === 'unknown';
    }

    function subtitle(item: BrokenMatchRowView): string | null {
        if (!item.seriesTitle) return null;
        const s = item.seasonNumber != null ? `S${item.seasonNumber}` : '';
        const e = item.episodeNumber != null ? `E${item.episodeNumber}` : '';
        const code = s || e ? ` · ${s}${e}` : '';
        return `${item.seriesTitle}${code}`;
    }

    function reason(item: BrokenMatchRowView): string {
        if (!item.errorMessage || item.errorMessage === GENERIC_PERMANENT_FAILURE) {
            return m.admin_fix_matches_reason_generic();
        }
        return item.errorMessage;
    }

    // ── URL-driven filters + pagination ──────────────────────────────────

    async function navigate(mutate: (params: URLSearchParams) => void): Promise<void> {
        const url = new URL(page.url);
        mutate(url.searchParams);
        selected.clear();
        await goto(url, { keepFocus: true, noScroll: true, replaceState: true });
    }

    function onSearchInput(): void {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            const q = search.trim();
            void navigate((p) => {
                if (q) p.set('q', q);
                else p.delete('q');
                p.delete('offset');
            });
        }, 300);
    }

    function setType(type: 'movie' | 'series' | undefined): void {
        void navigate((p) => {
            if (type) p.set('type', type);
            else p.delete('type');
            p.delete('offset');
        });
    }

    function clearFilters(): void {
        search = '';
        void navigate((p) => {
            p.delete('q');
            p.delete('type');
            p.delete('offset');
        });
    }

    function goOffset(offset: number): void {
        void navigate((p) => {
            if (offset <= 0) p.delete('offset');
            else p.set('offset', String(offset));
        });
    }

    // ── Row actions ──────────────────────────────────────────────────────

    function dropLocally(pred: (i: BrokenMatchRowView) => boolean): void {
        const before = items.length;
        items = items.filter((i) => !pred(i));
        localTotal = Math.max(0, localTotal - (before - items.length));
        for (const id of [...selected]) {
            if (!items.some((i) => i.mediaItemId === id)) selected.delete(id);
        }
    }

    async function postRetry(item: BrokenMatchRowView): Promise<boolean> {
        const { data: res, error } = await apiPost(
            `/api/admin/media/${item.mediaItemId}/pipeline`,
            PipelineResetResponseSchema,
            { stageId: item.stageId },
        );
        return !error && res != null;
    }

    async function retry(item: BrokenMatchRowView): Promise<void> {
        busyIds.add(item.mediaItemId);
        try {
            if (await postRetry(item)) {
                dropLocally((i) => i.mediaItemId === item.mediaItemId);
                toasts.success(m.admin_fix_matches_retry_queued({ title: item.title }));
            } else {
                toasts.error(m.admin_fix_matches_retry_failed({ title: item.title }));
            }
        } catch {
            toasts.error(m.admin_fix_matches_retry_failed({ title: item.title }));
        } finally {
            busyIds.delete(item.mediaItemId);
        }
    }

    async function postAccept(item: BrokenMatchRowView): Promise<number> {
        const { data: res, error } = await apiPost(
            '/api/admin/task-system/pipeline/accept-reidentify-item',
            StageActionResponseSchema,
            { mediaItemId: item.mediaItemId, stageId: item.stageId },
        );
        if (error) throw new Error(error);
        return res?.count ?? 0;
    }

    async function undoAccept(item: BrokenMatchRowView): Promise<void> {
        try {
            const { data: res, error } = await apiPost(
                `/api/admin/media/${item.mediaItemId}/pipeline/unignore`,
                UnignoreResponseSchema,
                { stageId: item.stageId },
            );
            if (error || !res?.restored) throw new Error(error ?? 'not restored');
            toasts.success(m.admin_fix_matches_accept_undone({ title: item.title }));
            // The row re-enters the pipeline as pending; reload so the list
            // reflects whatever state it is in now.
            await navigate(() => {});
        } catch {
            toasts.error(m.admin_fix_matches_restore_failed());
        }
    }

    /** "Accept as unmatched": marks the item as expected, no longer a dead-letter. */
    async function accept(item: BrokenMatchRowView): Promise<void> {
        busyIds.add(item.mediaItemId);
        try {
            const count = await postAccept(item);
            dropLocally((i) => i.mediaItemId === item.mediaItemId);
            if (count > 0) {
                toasts.success(m.admin_ops_reidentify_accepted({ title: item.title }), {
                    timeout: 10_000,
                    action: {
                        label: m.admin_fix_matches_undo(),
                        onClick: () => void undoAccept(item),
                    },
                });
            } else {
                toasts.success(m.admin_ops_reidentify_already({ title: item.title }));
            }
        } catch (e) {
            toasts.error(
                m.admin_ops_reidentify_accept_failed({
                    error: e instanceof Error ? e.message : String(e),
                }),
                { ariaLive: 'assertive' },
            );
        } finally {
            busyIds.delete(item.mediaItemId);
        }
    }

    function openFix(item: BrokenMatchRowView): void {
        // Identification happens at the series level: a season/episode row
        // (e.g. "season poster: TMDB has no series 216416") is fixed by
        // re-identifying its series, not the season itself.
        if (item.seriesId) {
            fixing = { id: item.seriesId, title: item.seriesTitle ?? item.title, type: 'series' };
            return;
        }
        fixing = {
            id: item.mediaItemId,
            title: item.title,
            type: item.type,
            year: item.year,
            filePath: item.filePath,
            seasonCount: item.seasonCount,
            episodeCount: item.episodeCount,
        };
    }

    function onIdentified(): void {
        const id = fixing?.id;
        // Drops the row itself, or every row of the series that was just fixed.
        if (id) dropLocally((i) => i.mediaItemId === id || i.seriesId === id);
        fixing = null;
        toasts.success(m.admin_ops_reidentify_fixed());
    }

    // ── Selection + bulk ─────────────────────────────────────────────────

    let allPageSelected = $derived(
        items.length > 0 && items.every((i) => selected.has(i.mediaItemId)),
    );

    function toggleSelectAll(): void {
        if (allPageSelected) for (const i of items) selected.delete(i.mediaItemId);
        else for (const i of items) selected.add(i.mediaItemId);
    }

    function toggleSelected(id: string): void {
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
    }

    async function runBulk(
        op: (item: BrokenMatchRowView) => Promise<boolean>,
        doneMessage: (count: number) => string,
    ): Promise<void> {
        bulkBusy = true;
        const targets = items.filter((i) => selected.has(i.mediaItemId));
        const done: string[] = [];
        let failed = 0;
        const CHUNK = 5; // bounded concurrency
        for (let i = 0; i < targets.length; i += CHUNK) {
            const chunk = targets.slice(i, i + CHUNK);
            const results = await Promise.allSettled(chunk.map(op));
            results.forEach((r, idx) => {
                if (r.status === 'fulfilled' && r.value) done.push(chunk[idx].mediaItemId);
                else failed++;
            });
        }
        const doneSet = new Set(done);
        dropLocally((i) => doneSet.has(i.mediaItemId));
        selected.clear();
        bulkBusy = false;
        if (failed === 0) toasts.success(doneMessage(done.length));
        else toasts.warning(m.admin_fix_matches_bulk_failures({ done: done.length, failed }));
    }

    function bulkRetry(): void {
        void runBulk(postRetry, (count) => m.admin_fix_matches_retried_count({ count }));
    }

    function bulkAccept(): void {
        modals.open(ConfirmModal, {
            title: m.admin_fix_matches_accept_bulk_title({ count: selected.size }),
            body: m.admin_fix_matches_accept_bulk_body(),
            confirmText: m.admin_ops_reidentify_accept(),
            onConfirm: () =>
                runBulk(
                    async (item) => (await postAccept(item)) >= 0,
                    (count) => m.admin_fix_matches_accepted_count({ count }),
                ),
        });
    }

    const chipBase = 'px-3 py-1.5 text-xs font-medium rounded-full transition-colors shrink-0';
    const chipOff = 'bg-surface-700 text-surface-300 hover:bg-surface-600';
</script>

<div class="min-w-0">
    <h2 class="text-2xl font-semibold">{m.admin_fix_matches_tab_broken()}</h2>
    <p class="text-muted text-sm mt-1 max-w-2xl">
        {m.route_admin_reidentify_description()}
    </p>
</div>

{#if data.dbError}
    <div class="rounded border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
        {data.dbError}
    </div>
{:else if items.length === 0 && data.offset === 0 && !filtered}
    <div class="bg-surface-800 border border-surface-700 rounded-lg p-12 text-center">
        <div class="text-4xl mb-3">&#10003;</div>
        <p class="text-lg font-medium text-white">{m.route_admin_library_all_clear()}</p>
        <p class="text-muted text-sm mt-2 max-w-md mx-auto">{m.admin_ops_reidentify_empty()}</p>
    </div>
{:else}
    <!-- Search, filter toolbar — same shape as the Never-matched view. -->
    <div class="bg-surface-800 border border-surface-700 rounded-lg p-3 space-y-2">
        <div class="flex flex-wrap gap-2 items-center">
            <div class="relative flex-1 min-w-[12rem]">
                <Icon
                    src={MagnifyingGlass}
                    class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
                <input
                    type="search"
                    class="input pl-9 w-full"
                    placeholder={m.route_admin_library_search_placeholder()}
                    aria-label={m.route_admin_library_search_placeholder()}
                    bind:value={search}
                    oninput={onSearchInput} />
            </div>
            <div class="flex gap-1">
                <button
                    class="{chipBase} {!data.mediaType ? 'bg-blue-600 text-white' : chipOff}"
                    aria-pressed={!data.mediaType}
                    onclick={() => setType(undefined)}>{m.route_admin_library_filter_all()}</button>
                <button
                    class="{chipBase} {data.mediaType === 'series'
                        ? 'bg-blue-600 text-white'
                        : chipOff}"
                    aria-pressed={data.mediaType === 'series'}
                    onclick={() => setType('series')}
                    >{m.route_admin_library_filter_series()}</button>
                <button
                    class="{chipBase} {data.mediaType === 'movie'
                        ? 'bg-blue-600 text-white'
                        : chipOff}"
                    aria-pressed={data.mediaType === 'movie'}
                    onclick={() => setType('movie')}
                    >{m.route_admin_library_filter_movies()}</button>
            </div>
        </div>
        <div
            class="flex flex-wrap items-center justify-between gap-2 border-t border-surface-700 pt-2">
            <label class="flex items-center gap-2 cursor-pointer">
                <input
                    type="checkbox"
                    checked={allPageSelected}
                    disabled={items.length === 0}
                    onchange={toggleSelectAll}
                    class="rounded border-surface-600 bg-surface-800 text-blue-500" />
                <span class="text-xs text-surface-400"
                    >{m.route_admin_library_select_all_page()}</span>
            </label>
            <span class="text-xs text-surface-500">
                {m.admin_ops_reidentify_showing({
                    start: rangeStart,
                    end: rangeEnd,
                    total: localTotal.toLocaleString(),
                })}
            </span>
        </div>
    </div>

    {#if items.length === 0}
        <div class="bg-surface-800 border border-surface-700 rounded-lg p-8 text-center">
            <p class="text-muted">{m.route_admin_library_no_results()}</p>
            <button class="btn btn-ghost btn-sm mt-3" onclick={clearFilters}>
                {m.route_admin_library_clear_filters()}
            </button>
        </div>
    {:else}
        <div class="space-y-1">
            {#each items as item (item.mediaItemId)}
                {@const busy = busyIds.has(item.mediaItemId) || bulkBusy}
                {@const sub = subtitle(item)}
                <FixMatchRow
                    posterId={item.seriesId ?? item.mediaItemId}
                    title={item.title}
                    selected={selected.has(item.mediaItemId)}
                    ontoggleselect={() => toggleSelected(item.mediaItemId)}>
                    {#snippet meta()}
                        <span class="rounded bg-surface-700 px-1.5 py-0.5 text-surface-300"
                            >{mediaTypeLabel(item.type)}</span>
                        {#if sub}
                            · {sub}
                        {:else if item.year}
                            · {item.year}
                        {/if}
                        <span
                            class="ml-1 inline-block rounded px-1.5 py-0.5 {CAUSE_CLASS[
                                item.cause
                            ]}"
                            title={CAUSE_HINT[item.cause]()}>{CAUSE_LABEL[item.cause]()}</span>
                    {/snippet}
                    {#snippet details()}
                        <p class="mt-1 text-xs text-surface-400">{CAUSE_HINT[item.cause]()}</p>
                        <details class="mt-1 text-[11px] text-surface-500">
                            <summary class="cursor-pointer select-none hover:text-surface-300"
                                >{m.admin_fix_matches_error_details()}</summary>
                            <p class="mt-1 break-words text-amber-300/80">{reason(item)}</p>
                            <p class="mt-0.5">
                                {m.admin_fix_matches_failed_step({
                                    step: pipelineStepName(item.stageId),
                                })}
                            </p>
                            {#if item.filePath}
                                <p class="mt-0.5 truncate font-mono" title={item.filePath}>
                                    {m.admin_fixmatch_context_file_label()}: {fileName(
                                        item.filePath,
                                    )}
                                </p>
                            {/if}
                        </details>
                    {/snippet}
                    {#snippet actions()}
                        {#if retryLeads(item)}
                            <button
                                type="button"
                                class="btn btn-primary btn-sm"
                                disabled={busy}
                                onclick={() => retry(item)}>
                                <Icon src={ArrowPath} class="w-3.5 h-3.5" />
                                {m.admin_fix_matches_retry()}
                            </button>
                        {/if}
                        <button
                            type="button"
                            class="btn btn-sm {retryLeads(item) ? 'btn-ghost' : 'btn-primary'}"
                            disabled={busy}
                            title={item.seriesId
                                ? m.admin_fix_matches_fix_series_hint({
                                      series: item.seriesTitle ?? '',
                                  })
                                : undefined}
                            onclick={() => openFix(item)}>
                            <Icon src={Wrench} class="w-3.5 h-3.5" />
                            {item.seriesId
                                ? m.admin_fix_matches_fix_series()
                                : m.admin_ops_reidentify_fix()}
                        </button>
                        <a
                            href={resolve(`/admin/library/media/${item.mediaItemId}`)}
                            class="btn btn-ghost btn-sm">
                            {m.admin_ops_reidentify_open_detail()}
                        </a>
                        <button
                            type="button"
                            class="btn btn-ghost btn-sm text-surface-400 hover:text-amber-300"
                            disabled={busy}
                            title={m.admin_fix_matches_accept_hint()}
                            onclick={() => accept(item)}>
                            <Icon src={CheckCircle} class="w-3.5 h-3.5" />
                            {m.admin_ops_reidentify_accept()}
                        </button>
                    {/snippet}
                </FixMatchRow>
            {/each}
        </div>
    {/if}

    {#if hasPrev || hasNext}
        <div class="flex items-center justify-center gap-2 pt-2">
            <button
                type="button"
                class="btn btn-ghost"
                disabled={!hasPrev}
                onclick={() => goOffset(Math.max(0, data.offset - data.pageSize))}>
                {m.admin_ops_prev()}
            </button>
            <button
                type="button"
                class="btn btn-ghost"
                disabled={!hasNext}
                onclick={() => goOffset(data.offset + data.pageSize)}>
                {m.admin_ops_next()}
            </button>
        </div>
    {/if}
{/if}

<!-- Bulk action bar — same place and shape as the Never-matched view's. -->
{#if selected.size > 0}
    <div
        class="fixed bottom-4 left-4 right-4 z-40 mx-auto flex max-w-2xl flex-wrap items-center justify-center gap-2 rounded-xl border border-surface-700 bg-surface-800 px-4 py-3 shadow-2xl sm:gap-4">
        <span class="text-sm text-surface-300"
            >{m.admin_library_n_selected({ count: selected.size })}</span>
        <button class="btn btn-primary btn-sm" onclick={bulkRetry} disabled={bulkBusy}>
            <Icon src={ArrowPath} class="w-3.5 h-3.5" />
            {m.admin_fix_matches_retry_selected()}
        </button>
        <button class="btn btn-ghost btn-sm" onclick={bulkAccept} disabled={bulkBusy}>
            <Icon src={CheckCircle} class="w-3.5 h-3.5" />
            {m.admin_fix_matches_accept_selected()}
        </button>
        <button class="btn btn-ghost btn-sm" onclick={() => selected.clear()}
            >{m.common_cancel()}</button>
    </div>
{/if}

{#if fixing}
    <IdentifyModal
        item={{
            id: fixing.id,
            title: fixing.title,
            mediaType: fixing.type,
            releaseYear: fixing.year,
            filePath: fixing.filePath,
            seasonCount: fixing.seasonCount,
            episodeCount: fixing.episodeCount,
        }}
        onidentified={onIdentified}
        onclose={() => (fixing = null)} />
{/if}
