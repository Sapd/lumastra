<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import EpisodeLanguageSummary from './EpisodeLanguageSummary.svelte';
    import type { EpisodeLanguageSummary as EpisodeLanguages } from '$lib/schemas/admin-language-summary.js';
    import { page } from '$app/state';
    import HealthTab from './HealthTab.svelte';
    import OrderingTab from './OrderingTab.svelte';
    import CoverageSummary from './CoverageSummary.svelte';
    import * as m from '$lib/paraglide/messages';
    import { Icon, ChevronDown, ChevronRight, Film, Bars3, ArrowsUpDown } from 'svelte-hero-icons';
    import { dndzone, SHADOW_PLACEHOLDER_ITEM_ID } from 'svelte-dnd-action';
    import { flip } from 'svelte/animate';
    import { SvelteMap, SvelteSet } from 'svelte/reactivity';
    import { goto } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import { toasts } from '$lib/stores/toast.store';
    import { formatEpisodeNumber } from '$lib/utils/media-display';
    import { fetchOrderingLabel } from '$lib/utils/ordering-utils';
    import EpisodeTrickplayPreview from './EpisodeTrickplayPreview.svelte';
    import { updateMediaMetadata, getAdminEpisodes } from '$lib/api/admin';
    import { requireValue } from '$lib/utils/runtime-validation';

    interface Props {
        seriesId: string;
        initialSeason?: number | null;
        coverage?: {
            episodesHeld: number;
            episodesListed: number;
            missing: number;
            identified: number;
            conflicted: boolean;
        } | null;
    }

    let { seriesId, initialSeason = null, coverage = null }: Props = $props();

    let orderingLabel = $state<string | null>(null);

    async function loadOrdering(): Promise<void> {
        orderingLabel = await fetchOrderingLabel(seriesId);
    }

    interface ChapterInfo {
        index: number;
        name: string | null;
        startTicks: string;
    }

    interface EpisodeRow {
        id: string;
        title: string | null;
        season_number: number | null;
        episode_number: number | null;
        episode_number_end: number | null;
        overview: string | null;
        runtime_seconds: number | null;
        premiere_date: string | null;
        file_path: string | null;
        edition: string | null;
        jellyfin_id: string | null;
        chapters: ChapterInfo[];
        sort_order: number | null;
        language_summary?: EpisodeLanguages;
    }

    let episodes = $state<EpisodeRow[]>([]);
    let loading = $state(true);
    // A failed load is NOT an empty library. Without this flag the catch/error
    // path left `episodes` at [] and `loading` at false, so the template fell
    // through to the empty state and the operator saw "No episodes found"
    // asserted next to a "Failed to load episodes" toast — two contradictory
    // claims about the same series, one of them wrong.
    let loadError = $state(false);
    let activeSeason = $state<number | null>(null);
    let expandedEpisode = $state<string | null>(null);
    let filterQuery = $state('');

    // Inline edit state
    let editingEpisodeId = $state<string | null>(null);
    let editTitle = $state('');
    let editOverview = $state('');
    let editSaving = $state(false);

    const inputClass =
        'bg-surface-800/60 border border-surface-700/50 rounded-lg px-3 py-2 text-surface-100 text-sm focus:border-primary-500 focus:outline-none';

    function startEdit(ep: EpisodeRow, e: MouseEvent): void {
        e.stopPropagation();
        editingEpisodeId = ep.id;
        editTitle = ep.title ?? '';
        editOverview = ep.overview ?? '';
    }

    function cancelEdit(e: MouseEvent): void {
        e.stopPropagation();
        editingEpisodeId = null;
        editTitle = '';
        editOverview = '';
    }

    async function saveEdit(ep: EpisodeRow, e: MouseEvent): Promise<void> {
        e.stopPropagation();
        if (editSaving) return;
        // What is sent is what gets marked saved: the form may already show
        // another episode's draft by the time the request returns.
        const title = editTitle;
        const overview = editOverview;
        editSaving = true;
        try {
            const { data, error } = await updateMediaMetadata(ep.id, {
                title: title || undefined,
                overview: overview || null,
            });
            if (error || !data) {
                toasts.error(m.media_episodes_save_metadata_failed());
                return;
            }

            // Update local episode data
            const idx = episodes.findIndex((e) => e.id === ep.id);
            if (idx !== -1) {
                episodes[idx] = {
                    ...episodes[idx],
                    title: title || episodes[idx].title,
                    overview: overview || null,
                };
            }

            toasts.success(m.media_episodes_save_metadata_success());
            // Only close the form this save belongs to.
            if (editingEpisodeId === ep.id) editingEpisodeId = null;
        } catch {
            toasts.error(m.media_episodes_save_metadata_failed());
        } finally {
            editSaving = false;
        }
    }

    // Multi-select state
    const selectedEpisodes = new SvelteSet<string>();

    function toggleSelect(id: string): void {
        if (selectedEpisodes.has(id)) {
            selectedEpisodes.delete(id);
        } else {
            selectedEpisodes.add(id);
        }
    }

    function toggleSelectAll(): void {
        if (allFilteredSelected) {
            for (const ep of filteredEpisodes) {
                selectedEpisodes.delete(ep.id);
            }
        } else {
            for (const ep of filteredEpisodes) {
                selectedEpisodes.add(ep.id);
            }
        }
    }

    // Reorder mode state
    let reorderMode = $state(false);
    let reorderItems = $state<EpisodeRow[]>([]);
    let reorderDirty = $state(false);
    let saving = $state(false);
    const flipDurationMs = 200;

    /**
     * Reorder works on one whole season: saving numbers the list 1..N, so a
     * list spanning seasons (the All tab) or a filtered subset would renumber
     * episodes across seasons or onto the hidden ones.
     */
    function enterReorderMode(): void {
        if (activeSeason === null) return;
        const season = activeSeason;
        filterQuery = '';
        reorderItems = episodes
            .filter((ep) => (ep.season_number ?? 0) === season)
            .map((ep) => ({ ...ep }));
        reorderDirty = false;
        reorderMode = true;
    }

    function exitReorderMode(): void {
        reorderMode = false;
        reorderItems = [];
        reorderDirty = false;
    }

    function handleDndConsider(e: CustomEvent<{ items: EpisodeRow[] }>): void {
        reorderItems = e.detail.items;
    }

    function handleDndFinalize(e: CustomEvent<{ items: EpisodeRow[] }>): void {
        reorderItems = e.detail.items.filter((i) => i.id !== SHADOW_PLACEHOLDER_ITEM_ID);
        reorderDirty = true;
    }

    async function saveReorder(): Promise<void> {
        if (saving) return;
        saving = true;
        try {
            const items = reorderItems.map((ep, index) => ({
                id: ep.id,
                episodeNumber: index + 1,
            }));

            const res = await fetch(`/api/admin/media/${seriesId}/episodes/reorder`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items }),
            });

            if (!res.ok) {
                toasts.error(m.media_episodes_save_order_failed());
                return;
            }

            toasts.success(m.media_episodes_save_order_success());
            reorderMode = false;
            reorderDirty = false;
            await loadEpisodes();
        } catch {
            toasts.error(m.media_episodes_save_order_failed());
        } finally {
            saving = false;
        }
    }

    let seasons = $derived.by(() => {
        const seasonMap = new SvelteMap<number, EpisodeRow[]>();
        for (const ep of episodes) {
            const sn = ep.season_number ?? 0;
            if (!seasonMap.has(sn)) seasonMap.set(sn, []);
            requireValue(seasonMap.get(sn), 'season bucket must exist after set').push(ep);
        }
        return Array.from(seasonMap.entries()).sort(
            ([a], [b]) => (a === 0 ? Infinity : a) - (b === 0 ? Infinity : b),
        );
    });

    let filteredEpisodes = $derived.by(() => {
        let result =
            activeSeason === null
                ? episodes
                : episodes.filter((ep) => (ep.season_number ?? 0) === activeSeason);

        const q = filterQuery.trim().toLowerCase();
        if (!q) return result;

        return result.filter((ep) => {
            if (ep.title?.toLowerCase().includes(q)) return true;
            if (ep.overview?.toLowerCase().includes(q)) return true;
            const epLabel = `e${String(ep.episode_number ?? 0).padStart(2, '0')}`;
            if (epLabel.includes(q)) return true;
            const fullLabel = `s${String(ep.season_number ?? 0).padStart(2, '0')}${epLabel}`;
            if (fullLabel.includes(q)) return true;
            return false;
        });
    });

    let allFilteredSelected = $derived(
        filteredEpisodes.length > 0 && filteredEpisodes.every((ep) => selectedEpisodes.has(ep.id)),
    );

    let loadSeq = 0;

    async function loadEpisodes(): Promise<void> {
        const seq = ++loadSeq;
        loading = true;
        loadError = false;
        try {
            const { data, error } = await getAdminEpisodes(seriesId);
            // An older load (a retry, or the reload after a bulk sync) must not
            // overwrite a newer one.
            if (seq !== loadSeq) return;
            if (error || !data) {
                loadError = true;
                toasts.error(m.media_episodes_load_failed());
                return;
            }
            episodes = data.episodes;
            // Select initial or first season by default
            if (activeSeason === null && episodes.length > 0) {
                if (initialSeason !== null && initialSeason !== undefined) {
                    activeSeason = initialSeason;
                } else {
                    const seasonNumbers = [
                        ...new Set(episodes.map((ep: EpisodeRow) => ep.season_number ?? 0)),
                    ].sort((a, b) => (a === 0 ? Infinity : a) - (b === 0 ? Infinity : b));
                    activeSeason = seasonNumbers[0] ?? null;
                }
            }
        } catch {
            if (seq !== loadSeq) return;
            loadError = true;
            toasts.error(m.media_episodes_load_failed());
        } finally {
            if (seq === loadSeq) loading = false;
        }
    }

    function formatRuntime(seconds: number | null): string {
        if (!seconds) return '—';
        const m = Math.round(seconds / 60);
        return `${m}m`;
    }

    function getFileName(path: string | null): string {
        if (!path) return '';
        return path.split('/').pop() ?? path;
    }

    // Reload when seriesId changes (e.g. navigating between series)
    $effect(() => {
        const _id = seriesId;
        void loadEpisodes();
        void loadOrdering();
    });
</script>

<div class="mb-4 flex flex-wrap gap-2" role="group" aria-label={m.media_tab_episodes()}>
    {#each ['list', 'issues', 'ordering'] as section (section)}
        <button
            type="button"
            class="rounded-lg border border-surface-700 px-3 py-2 text-sm"
            aria-pressed={(page.url.searchParams.get('section') ?? 'list') === section}
            onclick={() => {
                const target = new URL(page.url);
                target.searchParams.set('section', section);
                void goto(target.pathname + target.search, { replaceState: true, noScroll: true });
            }}>
            {section === 'issues'
                ? m.media_redesign_issues()
                : section === 'ordering'
                  ? m.media_tab_ordering()
                  : m.media_tab_episodes()}
        </button>
    {/each}
</div>
{#if page.url.searchParams.get('section') === 'issues'}
    <div class="space-y-6"><CoverageSummary {coverage} /><HealthTab {seriesId} /></div>
{:else if page.url.searchParams.get('section') === 'ordering'}
    <OrderingTab {seriesId} />
{:else}
    <div class="space-y-6">
        <div class="flex items-center justify-between">
            <div>
                <div class="flex items-center gap-2">
                    <h3 class="text-lg font-semibold text-white">{m.episodes()}</h3>
                    {#if orderingLabel}
                        <span
                            class="px-2 py-0.5 rounded bg-primary-500/15 text-primary-400 text-xs">
                            {orderingLabel}
                        </span>
                    {/if}
                </div>
                <p class="text-sm text-surface-400 mt-1">
                    {m.media_episodes_description()}
                </p>
            </div>
            {#if !loading && episodes.length > 0}
                {#if reorderMode}
                    <div class="flex gap-2">
                        <button
                            class="btn variant-ghost-surface text-sm px-4 py-2"
                            onclick={exitReorderMode}
                            disabled={saving}>
                            {m.cancel()}
                        </button>
                        <button
                            class="btn variant-filled-primary text-sm px-4 py-2"
                            onclick={saveReorder}
                            disabled={saving || !reorderDirty}>
                            {saving ? m.media_episodes_saving() : m.media_episodes_save_order()}
                        </button>
                    </div>
                {:else}
                    <button
                        class="btn variant-ghost-surface text-sm px-4 py-2 inline-flex items-center gap-2"
                        onclick={enterReorderMode}
                        disabled={activeSeason === null}
                        title={activeSeason === null
                            ? m.media_episodes_reorder_pick_season()
                            : undefined}>
                        <Icon src={ArrowsUpDown} class="w-4 h-4" />
                        {m.media_episodes_reorder()}
                    </button>
                {/if}
            {/if}
        </div>

        {#if loading}
            <div class="flex items-center gap-2 text-surface-400 py-8">
                <div
                    class="w-4 h-4 border-2 border-surface-400 border-t-transparent rounded-full animate-spin">
                </div>
                {m.modal_progress_loading()}
            </div>
        {:else if loadError}
            <div class="flex flex-col items-start gap-3 py-8" data-testid="episodes-load-error">
                <p class="text-warning-400">{m.media_episodes_load_failed()}</p>
                <button
                    class="btn variant-ghost-surface text-sm px-4 py-2"
                    onclick={() => void loadEpisodes()}>
                    {m.common_retry()}
                </button>
            </div>
        {:else if episodes.length === 0}
            <p class="text-surface-500 py-8">{m.media_episodes_none_found()}</p>
        {:else}
            <!-- Season tabs + filter -->
            <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div class="flex gap-1 overflow-x-auto pb-1">
                    <button
                        class="px-3 py-1.5 rounded text-sm font-medium transition-colors whitespace-nowrap
                        {activeSeason === null
                            ? 'bg-primary-500/15 text-primary-400'
                            : 'text-surface-400 hover:text-surface-200 hover:bg-surface-700/40'}"
                        onclick={() => {
                            activeSeason = null;
                            filterQuery = '';
                        }}>
                        {m.media_episodes_season_all({ count: episodes.length })}
                    </button>
                    {#each seasons as [seasonNum, eps] (seasonNum)}
                        <button
                            class="px-3 py-1.5 rounded text-sm font-medium transition-colors whitespace-nowrap
                            {activeSeason === seasonNum
                                ? 'bg-primary-500/15 text-primary-400'
                                : 'text-surface-400 hover:text-surface-200 hover:bg-surface-700/40'}"
                            onclick={() => {
                                activeSeason = seasonNum;
                                filterQuery = '';
                            }}>
                            S{String(seasonNum).padStart(2, '0')} ({eps.length})
                        </button>
                    {/each}
                </div>
                <div class="relative shrink-0">
                    <svg
                        class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-surface-500 pointer-events-none"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        stroke-width="2">
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
                    </svg>
                    <input
                        type="text"
                        placeholder={m.media_episodes_filter_placeholder()}
                        bind:value={filterQuery}
                        class="input pl-8 pr-3 py-1.5 text-sm bg-surface-800/60 border border-surface-700/50 rounded w-48 focus:w-64 transition-all placeholder-surface-500" />
                </div>
            </div>

            {#if reorderMode}
                <!-- Drag-and-drop reorder view -->
                <div class="space-y-1">
                    <p class="text-xs text-surface-400 mb-2">
                        {m.media_episodes_reorder_hint()}
                    </p>
                    <div
                        use:dndzone={{
                            items: reorderItems,
                            flipDurationMs,
                            dragDisabled: saving,
                            dropTargetStyle: {
                                outline: '2px dashed rgba(var(--color-primary-500-rgb) / 0.5)',
                                borderRadius: '8px',
                            },
                        }}
                        onconsider={handleDndConsider}
                        onfinalize={handleDndFinalize}
                        class="space-y-1">
                        {#each reorderItems as item, index (item.id)}
                            <div
                                animate:flip={{ duration: flipDurationMs }}
                                class="flex items-center gap-3 rounded-lg bg-surface-800/60 border border-surface-700/50 p-3 cursor-grab active:cursor-grabbing">
                                <!-- Drag handle -->
                                <Icon src={Bars3} class="w-4 h-4 text-surface-500 shrink-0" />

                                <!-- Position number -->
                                <span class="text-xs text-surface-500 font-mono w-8 shrink-0">
                                    {index + 1}
                                </span>

                                <!-- Episode info -->
                                <div class="flex-1 min-w-0">
                                    <div class="flex items-center gap-2">
                                        <span class="text-sm text-surface-200 truncate">
                                            {item.title ?? m.media_episodes_untitled()}
                                        </span>
                                        <span class="text-xs text-surface-500 font-mono shrink-0">
                                            S{String(item.season_number ?? 0).padStart(
                                                2,
                                                '0',
                                            )}{formatEpisodeNumber(
                                                item.episode_number ?? 0,
                                                item.episode_number_end,
                                                true,
                                            )}
                                        </span>
                                    </div>
                                    {#if item.file_path}
                                        <p class="text-xs text-surface-500 truncate mt-0.5">
                                            {item.file_path.split('/').pop()}
                                        </p>
                                    {/if}
                                </div>

                                <!-- Chapter hint -->
                                {#if item.chapters.length > 0}
                                    {@const meaningful = item.chapters.filter(
                                        (ch) => ch.name && !/^\d+$/.test(ch.name.trim()),
                                    )}
                                    {#if meaningful.length > 0}
                                        <span
                                            class="text-xs text-surface-500 shrink-0 hidden md:block max-w-[200px] truncate">
                                            {meaningful.map((c) => c.name).join(', ')}
                                        </span>
                                    {/if}
                                {/if}

                                <!-- File linked indicator -->
                                {#if item.file_path}
                                    <span class="text-green-400">
                                        <Icon src={Film} class="w-3.5 h-3.5" />
                                    </span>
                                {:else}
                                    <span class="text-surface-600">
                                        <Icon src={Film} class="w-3.5 h-3.5" />
                                    </span>
                                {/if}
                            </div>
                        {/each}
                    </div>
                </div>
            {:else if filteredEpisodes.length === 0}
                <p class="text-surface-500 py-4 text-sm">
                    {m.media_episodes_no_match({ query: filterQuery })}
                </p>
            {:else}
                <!-- Episode table -->
                <div class="rounded-lg border border-surface-700/50 overflow-hidden">
                    <table class="w-full text-sm">
                        <thead>
                            <tr
                                class="bg-surface-800/80 text-surface-400 text-xs uppercase tracking-wide">
                                <th class="px-3 py-2 w-8">
                                    <input
                                        type="checkbox"
                                        checked={allFilteredSelected}
                                        onchange={toggleSelectAll}
                                        class="rounded border-surface-600 bg-surface-800 text-primary-500" />
                                </th>
                                <th class="hidden sm:table-cell px-3 py-2 text-left w-16">#</th>
                                <th class="px-3 py-2 text-left">{m.media_episodes_col_title()}</th>
                                <th class="hidden sm:table-cell px-3 py-2 text-left w-20"
                                    >{m.runtime()}</th>
                                <th class="hidden sm:table-cell px-3 py-2 text-left w-32"
                                    >{m.media_episodes_col_file()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each filteredEpisodes as ep (ep.id)}
                                <tr
                                    class="border-t border-surface-700/30 hover:bg-surface-800/40 cursor-pointer transition-colors"
                                    onclick={(event) => {
                                        if (
                                            event.target instanceof Element &&
                                            event.target.closest('details,button,a,input')
                                        )
                                            return;
                                        expandedEpisode = expandedEpisode === ep.id ? null : ep.id;
                                    }}>
                                    <td class="px-3 py-2 w-8">
                                        <input
                                            type="checkbox"
                                            checked={selectedEpisodes.has(ep.id)}
                                            onchange={(e) => {
                                                e.stopPropagation();
                                                toggleSelect(ep.id);
                                            }}
                                            onclick={(e) => e.stopPropagation()}
                                            class="rounded border-surface-600 bg-surface-800 text-primary-500" />
                                    </td>
                                    <td
                                        class="hidden sm:table-cell px-3 py-2 text-surface-400 font-mono">
                                        S{String(ep.season_number ?? 0).padStart(
                                            2,
                                            '0',
                                        )}{formatEpisodeNumber(
                                            ep.episode_number ?? 0,
                                            ep.episode_number_end,
                                            true,
                                        )}
                                    </td>
                                    <td class="px-2 sm:px-3 py-2 text-surface-200">
                                        <div
                                            class="sm:hidden flex items-center gap-2 text-xs text-surface-400">
                                            <span class="font-mono"
                                                >S{String(ep.season_number ?? 0).padStart(
                                                    2,
                                                    '0',
                                                )}{formatEpisodeNumber(
                                                    ep.episode_number ?? 0,
                                                    ep.episode_number_end,
                                                    true,
                                                )}</span>
                                            <span
                                                >{ep.file_path
                                                    ? m.media_episodes_file_linked()
                                                    : m.media_episodes_file_none()}</span>
                                        </div>
                                        <div class="flex items-center gap-1.5">
                                            <Icon
                                                src={expandedEpisode === ep.id
                                                    ? ChevronDown
                                                    : ChevronRight}
                                                class="w-3.5 h-3.5 text-surface-500 shrink-0" />
                                            {ep.title ?? m.media_episodes_untitled()}
                                        </div>
                                        {#if ep.language_summary?.selectedFileId}<div class="mt-2">
                                                <EpisodeLanguageSummary
                                                    summary={ep.language_summary} />
                                            </div>{/if}
                                    </td>
                                    <td class="hidden sm:table-cell px-3 py-2 text-surface-400">
                                        {formatRuntime(ep.runtime_seconds)}
                                    </td>
                                    <td class="hidden sm:table-cell px-3 py-2">
                                        {#if ep.file_path}
                                            <span
                                                class="inline-flex items-center gap-1 text-green-400 text-xs">
                                                <Icon src={Film} class="w-3 h-3" />
                                                {m.media_episodes_file_linked()}
                                            </span>
                                        {:else}
                                            <span class="text-surface-600 text-xs"
                                                >{m.media_episodes_file_none()}</span>
                                        {/if}
                                    </td>
                                </tr>
                                {#if expandedEpisode === ep.id}
                                    <tr class="bg-surface-800/30">
                                        <td colspan="5" class="px-3 py-3">
                                            <div class="space-y-2 text-xs">
                                                {#if editingEpisodeId === ep.id}
                                                    <!-- Inline edit form -->
                                                    <div
                                                        class="space-y-3 pt-1"
                                                        role="button"
                                                        tabindex="0"
                                                        aria-label={m.media_episodes_edit_form_label()}
                                                        onclick={(e) => e.stopPropagation()}
                                                        onkeydown={(e) => {
                                                            if (
                                                                e.key === 'Enter' ||
                                                                e.key === ' '
                                                            ) {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                            } else if (e.key === 'Escape') {
                                                                e.preventDefault();
                                                                editingEpisodeId = null;
                                                                editTitle = '';
                                                                editOverview = '';
                                                            }
                                                        }}>
                                                        <div class="space-y-1">
                                                            <label
                                                                class="text-surface-500 block"
                                                                for="ep-title-{ep.id}">
                                                                {m.media_episodes_col_title()}
                                                            </label>
                                                            <input
                                                                id="ep-title-{ep.id}"
                                                                type="text"
                                                                class="w-full {inputClass}"
                                                                disabled={editSaving}
                                                                bind:value={editTitle} />
                                                        </div>
                                                        <div class="space-y-1">
                                                            <label
                                                                class="text-surface-500 block"
                                                                for="ep-overview-{ep.id}">
                                                                {m.overview()}
                                                            </label>
                                                            <textarea
                                                                id="ep-overview-{ep.id}"
                                                                class="w-full {inputClass}"
                                                                rows="3"
                                                                disabled={editSaving}
                                                                bind:value={editOverview}
                                                            ></textarea>
                                                        </div>
                                                        <div class="flex items-center gap-2 pt-1">
                                                            <button
                                                                class="btn variant-filled-primary text-xs px-3 py-1"
                                                                onclick={(e) => saveEdit(ep, e)}
                                                                disabled={editSaving}>
                                                                {editSaving
                                                                    ? m.media_episodes_saving()
                                                                    : m.media_episodes_save()}
                                                            </button>
                                                            <button
                                                                class="btn variant-ghost-surface text-xs px-3 py-1"
                                                                onclick={cancelEdit}
                                                                disabled={editSaving}>
                                                                {m.cancel()}
                                                            </button>
                                                        </div>
                                                    </div>
                                                {:else}
                                                    <!-- Read-only view -->
                                                    {#if ep.overview}
                                                        <p class="text-surface-300 max-w-prose">
                                                            {ep.overview}
                                                        </p>
                                                    {/if}
                                                    {#if ep.file_path}
                                                        <div class="flex items-start gap-2">
                                                            <span class="text-surface-500 shrink-0"
                                                                >{m.media_episodes_detail_file()}</span>
                                                            <span
                                                                class="text-surface-400 font-mono break-all">
                                                                {getFileName(ep.file_path)}
                                                            </span>
                                                        </div>
                                                    {/if}
                                                    {#if ep.edition}
                                                        <div class="flex items-center gap-2">
                                                            <span class="text-surface-500"
                                                                >{m.media_episodes_detail_edition()}</span>
                                                            <span class="text-surface-400"
                                                                >{ep.edition}</span>
                                                        </div>
                                                    {/if}
                                                    {#if ep.premiere_date}
                                                        <div class="flex items-center gap-2">
                                                            <span class="text-surface-500"
                                                                >{m.media_episodes_detail_air_date()}</span>
                                                            <span class="text-surface-400"
                                                                >{new Date(
                                                                    ep.premiere_date,
                                                                ).toLocaleDateString(undefined, {
                                                                    year: 'numeric',
                                                                    month: 'short',
                                                                    day: 'numeric',
                                                                })}</span>
                                                        </div>
                                                    {/if}
                                                    {#if ep.chapters.length > 0}
                                                        {@const meaningfulChapters =
                                                            ep.chapters.filter(
                                                                (ch) =>
                                                                    ch.name &&
                                                                    !/^\d+$/.test(ch.name.trim()),
                                                            )}
                                                        {#if meaningfulChapters.length > 0}
                                                            <div class="flex items-start gap-2">
                                                                <span
                                                                    class="text-surface-500 shrink-0"
                                                                    >{m.media_episodes_detail_chapters()}</span>
                                                                <div class="flex flex-wrap gap-1">
                                                                    {#each meaningfulChapters as ch (ch.index)}
                                                                        <span
                                                                            class="text-xs px-1.5 py-0.5 rounded bg-surface-700/50 text-surface-400">
                                                                            {ch.name}
                                                                        </span>
                                                                    {/each}
                                                                </div>
                                                            </div>
                                                        {/if}
                                                    {/if}
                                                    <EpisodeTrickplayPreview mediaId={ep.id} />
                                                    <div class="flex items-center gap-2">
                                                        <span class="text-surface-500"
                                                            >{m.media_episodes_detail_id()}</span>
                                                        <span class="text-surface-500 font-mono"
                                                            >{ep.id}</span>
                                                    </div>
                                                    <div class="flex items-center gap-2 pt-1">
                                                        <button
                                                            class="btn variant-ghost-primary text-xs px-3 py-1"
                                                            onclick={(e) => startEdit(ep, e)}>
                                                            {m.edit()}
                                                        </button>
                                                        <button
                                                            class="btn variant-ghost-surface text-xs px-3 py-1"
                                                            onclick={(e) => {
                                                                e.stopPropagation();
                                                                goto(
                                                                    resolve(
                                                                        `/admin/library/media/${ep.id}`,
                                                                    ),
                                                                );
                                                            }}>
                                                            {m.media_episodes_open_detail_page()}
                                                        </button>
                                                    </div>
                                                {/if}
                                            </div>
                                        </td>
                                    </tr>
                                {/if}
                            {/each}
                        </tbody>
                    </table>
                </div>
            {/if}
        {/if}
    </div>

    {#if selectedEpisodes.size > 0}
        <div
            class="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 bg-surface-800 border border-surface-700 rounded-xl shadow-2xl px-5 py-3 flex items-center gap-4">
            <span class="text-sm text-surface-300"
                >{m.media_episodes_selected_count({ count: selectedEpisodes.size })}</span>
            <span class="text-sm text-amber-200">{m.media_episodes_child_sync_scope()}</span>
            <a
                class="text-sm text-primary-300 underline"
                href={resolve(`/admin/library/media/${seriesId}?tab=maintenance&section=metadata`)}>
                {m.media_sync_inspect_parent()}
            </a>
            <button
                class="btn variant-ghost-surface text-sm px-3 py-1.5"
                onclick={() => selectedEpisodes.clear()}>
                {m.media_episodes_clear()}
            </button>
        </div>
    {/if}
{/if}
