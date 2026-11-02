<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Link one file to an ordered list of episodes by hand, with a window each
  (manual-file-links.service.ts). For files whose name cannot describe what
  they hold: S09E20-21 that plays 9x20 then 9x19, S09E37 that also holds 9x41,
  S10E13 that holds 11x16 then 10x19.

  Reordering keeps the windows where they are and moves the episodes between
  them, which is exactly the fix for a reversed pair. Adding or removing an
  episode requires a new deliberate boundary choice.
-->

<script lang="ts">
    import { untrack } from 'svelte';
    import { apiGet } from '$lib/api/client.js';
    import { RunSchema } from '$lib/schemas/run.schema.js';
    import { resolve } from '$lib/paths';
    import { trapFocus } from '$lib/utils/focus-trap';
    import * as m from '$lib/paraglide/messages';
    import { Z } from '$lib/utils/z-index';
    import { toasts } from '$lib/stores/toast.store';
    import {
        getFileEpisodes,
        undoFileEpisodes,
        setFileEpisodes,
        clearFileEpisodes,
        searchFileEpisodeSeries,
        syncChapters,
    } from '$lib/api/admin';
    import type {
        FileEpisodesResponse,
        FileEpisodeCandidate,
    } from '$lib/schemas/admin-file-episodes.js';
    import {
        chapterBoundaries,
        evenBoundaries,
        formatOffset,
        parseOffset,
        validateManualWindows,
        windowsFromBoundaries,
        MANUAL_OFFSET_SOURCE,
    } from '$lib/shared/manual-file-segments';
    import EpisodeTrickplayPreview from './EpisodeTrickplayPreview.svelte';

    interface Props {
        /** The item whose Files tab is open. */
        mediaId?: string;
        selectSeries?: boolean;
        fileId: string;
        initialTargetSeries?: { id: string; title: string };
        onClose: () => void;
        /** Called after a save or reset, so the Files tab can reload. */
        onChanged?: () => void;
    }

    let {
        mediaId,
        fileId,
        selectSeries = false,
        initialTargetSeries,
        onClose,
        onChanged,
    }: Props = $props();
    let targetSeries = $state<{ id: string; title: string } | null>(null);
    let seriesQuery = $state('');
    let seriesResults = $state<{ id: string; title: string | null; year: number | null }[]>([]);
    let searchError = $state(false);
    let searching = $state(false);
    let loading = $state(false);
    let loadGeneration = 0;
    let searchGeneration = 0;
    const targetMediaId = $derived(targetSeries?.id ?? mediaId ?? '');
    let persistedMediaId = $state('');
    const unsavedTarget = $derived(targetMediaId !== persistedMediaId);

    let data = $state<FileEpisodesResponse | null>(null);
    let loadError = $state<string | null>(null);
    let order = $state<string[]>([]);
    let boundaries = $state<number[]>([]);
    let boundaryText = $state<string[]>([]);
    let pickId = $state('');
    let previewMs = $state<number | null>(null);
    let saving = $state(false);
    let savedResult = $state(false);
    let episodeQuery = $state('');
    let seasonFilter = $state('all');
    let candidatePage = $state(1);
    let boundarySources = $state<string[]>([]);
    let chapterRun = $state<{ id: string; itemId: string } | null>(null);
    let chapterBusy = $state(false);
    let chapterMessage = $state('');
    let resetRequested = $state(false);
    let reviewStale = $state(false);
    let reviewMessage = $state('');
    let acknowledgedRestorations = $state<string[]>([]);
    let rememberedLabels = $state<Record<string, string>>({});
    let savedDraftKey = $state('');
    const hasMappingDraft = $derived(mappingDraftKey() !== savedDraftKey);

    const durationMs = $derived(data?.file.durationMs ?? null);
    const byId = $derived(
        new Map<string, FileEpisodeCandidate>((data?.episodes ?? []).map((e) => [e.id, e])),
    );
    const dismissedSelections = $derived(order.filter((id) => byId.get(id)?.isDismissed));
    const missingRestorationConsent = $derived(
        dismissedSelections.some((id) => !acknowledgedRestorations.includes(id)),
    );
    const invalidDraftIds = $derived(order.filter((id) => !byId.has(id)));
    const windows = $derived(
        order.length >= 2 && durationMs !== null
            ? windowsFromBoundaries(durationMs, boundaries)
            : null,
    );
    // Only unreadable text is an error: a valid entry already updated
    // `boundaries`, and editable text retains its exact milliseconds.
    const textError = $derived(
        boundaryText.some((t) => parseOffset(t) === null) ? m.file_episodes_invalid_time() : null,
    );
    const problem = $derived(
        (invalidDraftIds.length > 0 ? m.file_episodes_review_invalid() : null) ??
            textError ??
            (order.length >= 2 && durationMs === null
                ? m.file_episodes_no_duration()
                : validateManualWindows(durationMs, order.length, windows)),
    );
    const available = $derived((data?.episodes ?? []).filter((e) => !order.includes(e.id)));
    const matching = $derived(
        available.filter(
            (episode) =>
                (seasonFilter === 'all' ||
                    String(episode.seasonNumber ?? 'unknown') === seasonFilter) &&
                `${episodeCode(episode)} ${episode.title ?? ''}`
                    .toLocaleLowerCase()
                    .includes(episodeQuery.trim().toLocaleLowerCase()),
        ),
    );
    const seasons = $derived(
        [...new Set((data?.episodes ?? []).map((episode) => episode.seasonNumber))].sort(
            (a, b) => (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER),
        ),
    );
    const candidatePages = $derived(Math.max(1, Math.ceil(matching.length / 50)));
    const visibleCandidates = $derived(
        matching.slice(
            (Math.min(candidatePage, candidatePages) - 1) * 50,
            Math.min(candidatePage, candidatePages) * 50,
        ),
    );
    const chapterItemId = $derived(data?.links[0]?.mediaItemId ?? null);
    const chapterStarts = $derived((data?.chapters ?? []).map((c) => c.startMs));
    const chapterSplit = $derived(
        durationMs !== null && order.length >= 2
            ? chapterBoundaries(durationMs, order.length, chapterStarts)
            : null,
    );
    /** Any episode on the file, for the trickplay manifest (it is per file). */
    const previewItemId = $derived(data?.links[0]?.mediaItemId ?? order[0] ?? null);

    function episodeCode(e: { seasonNumber: number | null; episodeNumber: number | null }): string {
        const s = e.seasonNumber === null ? '?' : String(e.seasonNumber).padStart(2, '0');
        const ep = e.episodeNumber === null ? '?' : String(e.episodeNumber).padStart(2, '0');
        return `S${s}E${ep}`;
    }

    function labelFor(id: string): string {
        const e = byId.get(id);
        if (!e) {
            const link = data?.links.find((l) => l.mediaItemId === id);
            return (
                rememberedLabels[id] ?? (link ? `${episodeCode(link)} — ${link.title ?? ''}` : id)
            );
        }
        return `${episodeCode(e)} — ${e.title ?? ''}`;
    }

    function setBoundaries(next: number[]): void {
        boundaries = next;
        boundaryText = next.map(formatOffset);
    }

    function clearDraftCuts(): void {
        savedResult = false;
        acknowledgedRestorations = [];
        const count = Math.max(0, order.length - 1);
        boundaries = Array.from({ length: count }, () => Number.NaN);
        boundaryText = Array.from({ length: count }, () => '');
        boundarySources = Array.from({ length: count }, () => 'unset');
    }
    function boundaryOrigin(
        source: string | undefined,
    ): 'manual' | 'chapter' | 'runtime-split' | 'even-split' | 'unknown' {
        if (source === 'draft-manual' || source === 'manual') return 'manual';
        if (source === 'draft-chapter' || source === 'chapter') return 'chapter';
        if (source === 'draft-even' || source === 'even-split') return 'even-split';
        return source === 'runtime-split' ? 'runtime-split' : 'unknown';
    }
    function evidence(source: string | undefined): string {
        switch (source) {
            case 'manual':
                return m.file_editor_ux_manual();
            case 'chapter':
                return m.file_editor_ux_chapter();
            case 'runtime-split':
                return m.file_editor_ux_runtime();
            case 'even-split':
                return m.file_editor_ux_even();
            case 'draft-manual':
                return m.file_editor_ux_draft_manual();
            case 'draft-chapter':
                return m.file_editor_ux_draft_chapter();
            case 'draft-even':
                return m.file_editor_ux_draft_even();
            case 'unset':
                return m.file_editor_ux_unset();
            default:
                return m.file_editor_ux_unknown();
        }
    }
    function resplitEvenly(): void {
        savedResult = false;
        boundarySources = Array.from({ length: Math.max(0, order.length - 1) }, () => 'draft-even');
        setBoundaries(
            durationMs !== null && order.length >= 2
                ? evenBoundaries(durationMs, order.length)
                : [],
        );
    }

    function rememberLabels(res: FileEpisodesResponse): void {
        rememberedLabels = {
            ...rememberedLabels,
            ...Object.fromEntries([
                ...res.links.map((link) => [
                    link.mediaItemId,
                    `${episodeCode(link)} — ${link.title ?? ''}`,
                ]),
                ...res.episodes.map((episode) => [
                    episode.id,
                    `${episodeCode(episode)} — ${episode.title ?? ''}`,
                ]),
            ]),
        };
    }

    function mappingDraftKey(): string {
        return JSON.stringify({
            order,
            boundaries,
            boundaryText,
            boundarySources,
            resetRequested,
            acknowledgedRestorations,
        });
    }

    function adopt(res: FileEpisodesResponse): void {
        rememberLabels(res);
        data = res;
        acknowledgedRestorations = [];
        reviewStale = false;
        reviewMessage = '';
        resetRequested = false;
        const linked = res.links.filter(
            (l) => l.isDefault || l.offsetSource === MANUAL_OFFSET_SOURCE,
        );
        order = linked.map((l) => l.mediaItemId);
        const starts = linked.map((l) => l.startMs);
        if (linked.length >= 2 && starts.every((s) => s !== null)) {
            setBoundaries((starts as number[]).slice(1));
            boundarySources = linked
                .slice(1)
                .map(
                    (link) =>
                        link.boundaryOrigin ??
                        (link.offsetSource === MANUAL_OFFSET_SOURCE
                            ? 'unknown'
                            : (link.offsetSource ?? 'unknown')),
                );
        } else {
            clearDraftCuts();
        }
        savedDraftKey = mappingDraftKey();
    }

    async function load(targetId = targetMediaId, resetSelection = false): Promise<void> {
        if (!targetId) return;
        const generation = ++loadGeneration;
        loadError = null;
        loading = true;
        saving = false;
        data = null;
        order = [];
        rememberedLabels = {};
        pickId = '';
        boundaries = [];
        boundaryText = [];
        previewMs = null;
        episodeQuery = '';
        seasonFilter = 'all';
        candidatePage = 1;
        savedResult = false;
        chapterRun = null;
        chapterMessage = '';
        chapterBusy = false;
        try {
            const res = await getFileEpisodes(targetId, fileId);
            if (generation !== loadGeneration) return;
            if (res.data) {
                adopt(res.data);
                if (resetSelection) {
                    // Existing links describe the source series, not a draft target.
                    order = [];
                    setBoundaries([]);
                }
            } else loadError = m.file_episodes_load_failed();
        } catch {
            if (generation === loadGeneration) loadError = m.file_episodes_load_failed();
        } finally {
            if (generation === loadGeneration) loading = false;
        }
    }

    $effect(() => {
        void mediaId;
        void fileId;
        void selectSeries;
        untrack(() => {
            persistedMediaId = mediaId ?? '';
            targetSeries = initialTargetSeries ?? null;
            const target = targetSeries?.id ?? (selectSeries ? null : mediaId);
            if (target) void load(target, !!targetSeries && targetSeries.id !== mediaId);
            else {
                data = null;
                loading = false;
                loadError = null;
                order = [];
            }
        });
        return () => {
            loadGeneration++;
            searchGeneration++;
        };
    });

    async function searchSeries(): Promise<void> {
        const generation = ++searchGeneration;
        const query = seriesQuery.trim();
        seriesResults = [];
        searchError = false;
        if (query.length < 2) {
            searching = false;
            return;
        }
        searching = true;
        try {
            const result = await searchFileEpisodeSeries(query);
            if (generation !== searchGeneration) return;
            if (result.data) seriesResults = result.data.results;
            else searchError = true;
        } catch {
            if (generation === searchGeneration) searchError = true;
        } finally {
            if (generation === searchGeneration) searching = false;
        }
    }

    function chooseSeries(series: { id: string; title: string | null }): void {
        if (series.id === targetMediaId) {
            seriesResults = [];
            return;
        }
        resetRequested = false;
        targetSeries = { id: series.id, title: series.title ?? series.id };
        searchGeneration++;
        seriesResults = [];
        searching = false;
        void load(series.id, series.id !== persistedMediaId);
    }

    function move(index: number, delta: number): void {
        const to = index + delta;
        if (to < 0 || to >= order.length) return;
        resetRequested = false;
        const next = [...order];
        [next[index], next[to]] = [next[to], next[index]];
        savedResult = false;
        // Windows stay put: the episodes swap places between them.
        order = next;
    }

    function remove(index: number): void {
        resetRequested = false;
        order = order.filter((_, i) => i !== index);
        clearDraftCuts();
    }

    function add(): void {
        if (!pickId || order.includes(pickId)) return;
        resetRequested = false;
        order = [...order, pickId];
        pickId = '';
        clearDraftCuts();
    }

    function onBoundaryInput(index: number, text: string): void {
        savedResult = false;
        boundarySources[index] = 'draft-manual';
        resetRequested = false;
        const next = [...boundaryText];
        next[index] = text;
        boundaryText = next;
        const ms = parseOffset(text);
        if (ms !== null) {
            const b = [...boundaries];
            b[index] = ms;
            boundaries = b;
            previewMs = ms;
        }
    }

    function snapToChapter(index: number, value: string): void {
        const ms = Number(value);
        if (!Number.isFinite(ms)) return;
        resetRequested = false;
        savedResult = false;
        boundarySources[index] = 'draft-chapter';
        const b = [...boundaries];
        b[index] = ms;
        setBoundaries(b);
        previewMs = ms;
    }

    async function save(): Promise<void> {
        if (
            loading ||
            saving ||
            chapterBusy ||
            reviewStale ||
            !data ||
            (resetRequested && unsavedTarget) ||
            (!resetRequested && (problem || !order.length || missingRestorationConsent))
        )
            return;
        saving = true;
        const token = loadGeneration;
        const requestedTarget = targetMediaId;
        const requestedFile = fileId;
        try {
            const res = resetRequested
                ? await clearFileEpisodes(targetMediaId, fileId, data.revision)
                : await setFileEpisodes(targetMediaId, fileId, {
                      revision: data.revision,
                      ...(dismissedSelections.length > 0
                          ? { restoreDismissedEpisodeIds: dismissedSelections }
                          : {}),
                      episodes: order.map((id, i) =>
                          windows
                              ? {
                                    mediaItemId: id,
                                    boundaryOrigin:
                                        i === 0
                                            ? 'unknown'
                                            : boundaryOrigin(boundarySources[i - 1]),
                                    startMs: windows[i].startMs,
                                    endMs: windows[i].endMs,
                                }
                              : { mediaItemId: id },
                      ),
                  });
            if (
                token !== loadGeneration ||
                requestedTarget !== targetMediaId ||
                requestedFile !== fileId
            )
                return;
            if (!res.data) {
                if (res.status === 409) {
                    reviewStale = true;
                    reviewMessage = m.file_episodes_review_stale();
                    return;
                }
                toasts.error(res.error || m.file_episodes_save_failed());
                return;
            }
            persistedMediaId = targetMediaId;
            adopt(res.data);
            savedResult = true;
            toasts.success(m.file_episodes_saved_scope({ count: res.data.links.length }));
            onChanged?.();
        } catch {
            if (token === loadGeneration) toasts.error(m.file_episodes_save_failed());
        } finally {
            if (token === loadGeneration) saving = false;
        }
    }

    async function refreshReviewEvidence(
        targetId = targetMediaId,
        requestedFile = fileId,
        token = loadGeneration,
    ): Promise<FileEpisodesResponse | null> {
        const res = await getFileEpisodes(targetId, requestedFile);
        if (
            token !== loadGeneration ||
            targetId !== targetMediaId ||
            requestedFile !== fileId ||
            !res.data ||
            res.data.file.id !== requestedFile
        )
            return null;
        if (data) rememberLabels(data);
        rememberLabels(res.data);
        data = res.data;
        acknowledgedRestorations = [];
        reviewStale = false;
        return res.data;
    }

    async function reloadReview(): Promise<void> {
        if (saving || loading) return;
        const token = loadGeneration;
        loading = true;
        try {
            const refreshed = await refreshReviewEvidence();
            if (token !== loadGeneration) return;
            reviewMessage = refreshed
                ? m.file_episodes_review_reloaded()
                : m.file_episodes_load_failed();
        } catch {
            if (token === loadGeneration) reviewMessage = m.file_episodes_load_failed();
        } finally {
            if (token === loadGeneration) loading = false;
        }
    }

    async function refreshChapters(): Promise<void> {
        if (!chapterItemId || chapterBusy || chapterRun || saving) return;
        const itemId = chapterItemId;
        const token = loadGeneration;
        chapterBusy = true;
        chapterMessage = '';
        try {
            const result = await syncChapters(itemId);
            if (token !== loadGeneration) return;
            if (!result.data?.started) {
                chapterMessage = m.file_editor_ux_chapter_failed();
                return;
            }
            chapterRun = { id: result.data.runId, itemId };
            chapterMessage = m.file_editor_ux_chapter_queued();
        } catch {
            if (token === loadGeneration) chapterMessage = m.file_editor_ux_chapter_unverified();
        } finally {
            if (token === loadGeneration) chapterBusy = false;
        }
    }
    async function checkChapters(): Promise<void> {
        if (!chapterRun || chapterBusy || saving) return;
        const run = chapterRun;
        const token = loadGeneration;
        const targetId = targetMediaId;
        const requestedFile = fileId;
        chapterBusy = true;
        try {
            const result = await apiGet(`/api/runs/${encodeURIComponent(run.id)}`, RunSchema);
            if (token !== loadGeneration) return;
            const current = result.data;
            const input = current?.input as { mediaItemId?: string } | undefined;
            if (
                !current ||
                current.id !== run.id ||
                current.taskId !== 'chapter-sync' ||
                input?.mediaItemId !== run.itemId
            ) {
                chapterMessage = m.file_editor_ux_chapter_unverified();
                return;
            }
            if (current.state === 'failed' || current.state === 'cancelled') {
                chapterRun = null;
                chapterMessage = m.file_editor_ux_chapter_failed();
                return;
            }
            if (current.state !== 'completed') {
                chapterMessage = m.file_editor_ux_chapter_running();
                return;
            }
            if (!(
                current.result &&
                typeof current.result === 'object' &&
                'success' in current.result &&
                typeof current.result.success === 'boolean'
            )) {
                chapterMessage = m.file_editor_ux_chapter_unverified();
                return;
            }
            if (!current.result.success) {
                chapterMessage = m.file_editor_ux_chapter_failed();
                return;
            }
            const refreshed = await refreshReviewEvidence(targetId, requestedFile, token);
            if (token !== loadGeneration) return;
            if (!refreshed) {
                chapterMessage = m.file_editor_ux_chapter_unverified();
                return;
            }
            chapterRun = null;
            chapterMessage = m.file_editor_ux_chapter_loaded({
                count: refreshed.chapters.length,
            });
        } catch {
            if (token === loadGeneration) chapterMessage = m.file_editor_ux_chapter_unverified();
        } finally {
            if (token === loadGeneration) chapterBusy = false;
        }
    }

    $effect(() => {
        const runId = chapterRun?.id;
        if (!runId) return;
        const timer = setInterval(() => void checkChapters(), 3000);
        return () => clearInterval(timer);
    });

    async function undoMapping(): Promise<void> {
        if (!data?.undoId || saving || loading || hasMappingDraft || unsavedTarget || reviewStale)
            return;
        const token = loadGeneration;
        saving = true;
        try {
            const result = await undoFileEpisodes(targetMediaId, fileId, data.undoId);
            if (token !== loadGeneration) return;
            if (!result.data) {
                toasts.error(result.error ?? m.media_p5_undo_conflict());
                return;
            }
            data = result.data;
            adopt(result.data);
            savedResult = true;
            onChanged?.();
        } catch {
            if (token === loadGeneration) toasts.error(m.media_p5_undo_conflict());
        } finally {
            if (token === loadGeneration) saving = false;
        }
    }

    function reset(): void {
        if (saving || loading || unsavedTarget) return;
        resetRequested = true;
        savedResult = false;
    }

    function handleBackdropClick(e: MouseEvent): void {
        if (e.target === e.currentTarget && !saving) onClose();
    }

    function handleKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape' && !saving) onClose();
    }
</script>

<svelte:window onkeydown={handleKeydown} />

<div
    role="presentation"
    class="fixed inset-0 flex items-center justify-center bg-black/70 backdrop-blur-sm"
    style="z-index: {Z.MODAL}"
    onclick={handleBackdropClick}>
    <div
        use:trapFocus
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-episodes-title"
        class="bg-surface-900 border border-surface-700 rounded-xl shadow-2xl w-[92vw] max-w-3xl max-h-[88vh] flex flex-col">
        <div
            class="flex shrink-0 items-start justify-between gap-4 px-5 py-3 border-b border-surface-700">
            <div class="min-w-0">
                <h2 id="file-episodes-title" class="text-base font-semibold text-white">
                    {m.file_episodes_title()}
                    {#if data?.file.manual}
                        <span
                            class="ml-2 align-middle text-xs font-medium px-1.5 py-0.5 rounded bg-primary-500/20 text-primary-300 whitespace-nowrap"
                            >{m.file_episodes_manual_badge()}</span>
                    {/if}
                </h2>
                {#if data}
                    <p class="text-xs text-surface-400 truncate mt-0.5" title={data.file.filePath}>
                        {data.file.filePath}
                        {#if durationMs !== null}· {formatOffset(durationMs)}{/if}
                    </p>
                {/if}
            </div>
            <button
                class="btn btn-sm variant-ghost-surface text-xs shrink-0"
                disabled={saving}
                onclick={onClose}>
                {m.close()}
            </button>
        </div>

        <div class="min-h-0 min-w-0 flex-1 overflow-auto">
            <fieldset disabled={saving} class="min-w-0 p-5 space-y-5">
                <p class="text-sm text-surface-400">{m.file_episodes_note()}</p>
                <fieldset disabled={saving} class="space-y-2">
                    <legend class="text-sm text-surface-300"
                        >{m.file_episodes_target_series()}</legend>
                    <p class="text-xs text-surface-400">
                        {targetSeries?.title ??
                            data?.series?.title ??
                            (selectSeries
                                ? m.media_source_select_series()
                                : m.file_episodes_current_series())}
                    </p>
                    <input
                        type="search"
                        class="input w-full"
                        aria-label={m.file_episodes_search_series()}
                        placeholder={m.file_episodes_search_series()}
                        bind:value={seriesQuery}
                        oninput={() => void searchSeries()} />
                    {#if searching}<p class="text-xs text-surface-400">
                            {m.file_episodes_searching()}
                        </p>{/if}
                    {#if searchError}
                        <p class="text-sm text-red-400">{m.file_episodes_load_failed()}</p>
                        <button class="btn btn-sm" onclick={searchSeries}
                            >{m.file_episodes_retry_load()}</button>
                    {/if}
                    {#each seriesResults as series (series.id)}
                        <button
                            class="btn btn-sm variant-soft-surface block"
                            onclick={() => chooseSeries(series)}>
                            {series.title ?? series.id}{series.year ? ` (${series.year})` : ''}
                        </button>
                    {/each}
                    {#if targetSeries}<p class="text-xs text-amber-300">
                            {m.file_episodes_reassign_scope()}
                        </p>{/if}
                </fieldset>

                {#if loadError}
                    <p class="text-sm text-red-400">{loadError}</p>
                    <button
                        class="btn btn-sm"
                        onclick={() => void load(targetMediaId, unsavedTarget)}
                        >{m.file_episodes_retry_load()}</button>
                {:else if !data}
                    <div class="h-12 flex items-center text-xs text-surface-500">…</div>
                {:else}
                    {#if reviewMessage}<p role="status" class="text-sm text-amber-300">
                            {reviewMessage}
                        </p>{/if}
                    {#if reviewStale}<button
                            class="btn btn-sm"
                            disabled={loading || saving}
                            onclick={reloadReview}>{m.file_episodes_reload()}</button
                        >{/if}
                    {#if data.episodes.length === 0}
                        <div role="status" class="space-y-2 text-sm text-amber-200">
                            <p>
                                {m.file_episodes_empty_help({
                                    children: m.media_sync_include_children(),
                                    sync: m.media_sync_sync_from_provider(),
                                })}
                            </p>
                            <a
                                class="btn btn-sm"
                                href={resolve(
                                    `/admin/library/media/${targetMediaId}?tab=maintenance&section=metadata`,
                                )}
                                target="_blank"
                                rel="noopener noreferrer">{m.file_episodes_open_sync()}</a>
                            <button
                                class="btn btn-sm"
                                onclick={() => void load(targetMediaId, unsavedTarget)}
                                >{m.file_episodes_reload()}</button>
                        </div>
                    {/if}
                    {#if savedResult}<p role="status" class="text-sm text-green-300">
                            {m.file_editor_ux_saved()}
                        </p>{/if}
                    <p class="text-xs text-surface-400">{m.file_editor_ux_order()}</p>
                    <!-- Episodes in play order -->
                    <ol class="space-y-1.5">
                        {#each order as id, i (id)}
                            <li
                                class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-surface-700/50 bg-surface-800/40 px-3 py-2">
                                <span class="w-5 text-xs text-surface-500 font-mono">{i + 1}</span>
                                <span class="flex-1 min-w-0 truncate text-sm text-surface-200"
                                    >{labelFor(id)}</span>
                                {#if invalidDraftIds.includes(id)}<span class="text-xs text-red-300"
                                        >{m.file_episodes_review_missing()}</span
                                    >{/if}
                                {#if byId.get(id)?.isDismissed}
                                    <label class="order-last w-full pl-7 text-xs text-amber-300">
                                        <input
                                            type="checkbox"
                                            value={id}
                                            bind:group={acknowledgedRestorations} />
                                        {m.file_episodes_restore_dismissed({
                                            episode: labelFor(id),
                                        })}
                                    </label>
                                {/if}
                                {#if windows}
                                    <span
                                        class="order-last w-full pl-7 text-xs font-mono text-surface-400 whitespace-nowrap sm:order-none sm:w-auto sm:pl-0">
                                        {formatOffset(windows[i].startMs)}–{formatOffset(
                                            windows[i].endMs,
                                        )}
                                    </span>
                                {:else if order.length === 1}
                                    <span class="text-xs text-surface-500"
                                        >{m.file_episodes_whole_file()}</span>
                                {/if}
                                <button
                                    class="btn btn-sm variant-soft-surface text-xs px-2"
                                    disabled={i === 0}
                                    aria-label={m.file_episodes_move_up()}
                                    title={m.file_episodes_move_up()}
                                    onclick={() => move(i, -1)}>↑</button>
                                <button
                                    class="btn btn-sm variant-soft-surface text-xs px-2"
                                    disabled={i === order.length - 1}
                                    aria-label={m.file_episodes_move_down()}
                                    title={m.file_episodes_move_down()}
                                    onclick={() => move(i, 1)}>↓</button>
                                <button
                                    class="btn btn-sm variant-soft-error text-xs px-2"
                                    aria-label={m.file_episodes_remove()}
                                    title={m.file_episodes_remove()}
                                    onclick={() => remove(i)}>✕</button>
                            </li>
                        {/each}
                    </ol>

                    <div class="flex flex-wrap items-end gap-3">
                        <label class="min-w-0 flex-1 text-xs text-surface-300"
                            >{m.file_editor_ux_find()}<input
                                type="search"
                                class="input mt-1 w-full"
                                aria-label={m.file_editor_ux_find()}
                                value={episodeQuery}
                                oninput={(event) => {
                                    episodeQuery = event.currentTarget.value;
                                    candidatePage = 1;
                                    pickId = '';
                                }} /></label>
                        <label class="text-xs text-surface-300"
                            >{m.file_editor_ux_season()}<select
                                class="select mt-1 block"
                                aria-label={m.file_editor_ux_season()}
                                value={seasonFilter}
                                onchange={(event) => {
                                    seasonFilter = event.currentTarget.value;
                                    candidatePage = 1;
                                    pickId = '';
                                }}
                                ><option value="all">{m.file_editor_ux_all_seasons()}</option
                                >{#each seasons as season (season)}<option
                                        value={season ?? 'unknown'}
                                        >{season === null
                                            ? m.media_redesign_unknown_season()
                                            : season === 0
                                              ? m.media_redesign_specials()
                                              : m.admin_mediaedit_season_n({
                                                    number: season,
                                                })}</option
                                    >{/each}</select
                            ></label>
                    </div>
                    <p class="text-xs text-surface-400">
                        {m.file_editor_ux_matches({
                            count: matching.length,
                            selected: order.length,
                        })}
                    </p>
                    {#if matching.length === 0}<p class="text-sm text-surface-400">
                            {m.file_editor_ux_no_matches()}
                        </p>{/if}
                    <div class="flex items-center gap-2">
                        <select
                            class="select text-sm flex-1"
                            value={pickId}
                            onchange={(e) => {
                                pickId = e.currentTarget.value;
                            }}
                            aria-label={m.file_episodes_pick()}>
                            <option value="">{m.file_episodes_pick()}</option>
                            {#each visibleCandidates as e (e.id)}
                                <option value={e.id}
                                    >{episodeCode(e)} — {e.title ?? ''}{e.isDismissed
                                        ? ` · ${m.file_episodes_dismissed()}`
                                        : ''}</option>
                            {/each}
                        </select>
                        <button
                            class="btn btn-sm variant-soft-primary text-sm"
                            disabled={!pickId}
                            onclick={add}>{m.file_episodes_add()}</button>
                    </div>

                    {#if candidatePages > 1}<div class="flex flex-wrap gap-3 text-xs">
                            <button
                                class="btn btn-sm"
                                disabled={candidatePage <= 1}
                                onclick={() => {
                                    candidatePage -= 1;
                                    pickId = '';
                                }}>{m.file_editor_ux_previous()}</button
                            ><button
                                class="btn btn-sm"
                                disabled={candidatePage >= candidatePages}
                                onclick={() => {
                                    candidatePage += 1;
                                    pickId = '';
                                }}>{m.file_editor_ux_next()}</button>
                        </div>{/if}
                    <section
                        class="rounded-lg border border-surface-700 p-3 space-y-2 text-xs text-surface-400">
                        {#if data.chapters.length === 0}<p>
                                {m.file_editor_ux_chapter_empty()}
                            </p>{/if}
                        {#if chapterItemId}<p>
                                {m.file_editor_ux_chapter_scope({ item: labelFor(chapterItemId) })}
                            </p>
                            <button
                                class="btn btn-sm"
                                disabled={chapterBusy || !!chapterRun || saving}
                                onclick={refreshChapters}
                                >{m.file_editor_ux_chapter_refresh()}</button
                            >{:else}<p>{m.file_editor_ux_chapter_unlinked()}</p>{/if}
                        {#if chapterRun}<a
                                class="text-primary-300 underline"
                                href={resolve(
                                    `/admin/tasks/runs?run=${encodeURIComponent(chapterRun.id)}`,
                                )}
                                target="_blank"
                                rel="noopener noreferrer">{m.file_editor_ux_run()}</a
                            >{/if}
                        {#if chapterMessage}<p role="status">{chapterMessage}</p>{/if}
                    </section>
                    {#if order.length >= 2 && durationMs !== null}
                        <!-- Boundaries -->
                        <div class="space-y-2">
                            <div class="flex flex-wrap gap-2">
                                <button
                                    class="btn btn-sm variant-soft-surface text-xs"
                                    onclick={() => {
                                        resetRequested = false;
                                        resplitEvenly();
                                    }}>{m.file_episodes_even_split()}</button>
                                <button
                                    class="btn btn-sm variant-soft-surface text-xs"
                                    disabled={!chapterSplit}
                                    onclick={() => {
                                        if (chapterSplit) {
                                            resetRequested = false;
                                            savedResult = false;
                                            boundarySources = chapterSplit.map(
                                                () => 'draft-chapter',
                                            );
                                            setBoundaries(chapterSplit);
                                        }
                                    }}>{m.file_episodes_from_chapters()}</button>
                            </div>
                            {#each boundaries as _, bi (bi)}
                                <p class="text-xs text-amber-200">
                                    {evidence(boundarySources[bi])}
                                </p>
                                <div class="flex flex-wrap items-center gap-2 text-sm">
                                    <label
                                        class="text-surface-400 w-44"
                                        for="file-episodes-boundary-{bi}"
                                        >{m.file_episodes_boundary({ n: bi + 2 })}</label>
                                    <input
                                        id="file-episodes-boundary-{bi}"
                                        class="input text-sm font-mono w-28"
                                        value={boundaryText[bi]}
                                        oninput={(e) =>
                                            onBoundaryInput(
                                                bi,
                                                (e.target as HTMLInputElement).value,
                                            )} />
                                    {#if data.chapters.length > 0}
                                        <select
                                            class="select text-xs w-48"
                                            aria-label={m.file_episodes_snap_chapter()}
                                            onchange={(e) => {
                                                snapToChapter(
                                                    bi,
                                                    (e.target as HTMLSelectElement).value,
                                                );
                                                (e.target as HTMLSelectElement).value = '';
                                            }}>
                                            <option value=""
                                                >{m.file_episodes_snap_chapter()}</option>
                                            {#each data.chapters as c, ci (ci)}
                                                <option value={c.startMs}
                                                    >{formatOffset(c.startMs)}
                                                    {c.name ?? ''}</option>
                                            {/each}
                                        </select>
                                    {/if}
                                    <button
                                        class="btn btn-sm variant-ghost-surface text-xs"
                                        disabled={!Number.isFinite(boundaries[bi])}
                                        onclick={() => (previewMs = boundaries[bi])}
                                        >{m.file_episodes_preview()}</button>
                                </div>
                            {/each}
                        </div>
                    {/if}

                    {#if windows && durationMs && !problem}
                        <!-- Where each window sits in the file -->
                        <div
                            class="flex h-7 w-full overflow-hidden rounded border border-surface-700/50 text-[11px]">
                            {#each windows as w, wi (wi)}
                                {@const ep = byId.get(order[wi])}
                                <div
                                    class="flex items-center justify-center truncate border-r border-surface-900 last:border-r-0 {wi %
                                        2 ===
                                    0
                                        ? 'bg-primary-500/30'
                                        : 'bg-secondary-500/30'}"
                                    style="width: {Math.max(
                                        0,
                                        ((w.endMs - w.startMs) / durationMs) * 100,
                                    )}%"
                                    title="{labelFor(order[wi])} · {formatOffset(
                                        w.startMs,
                                    )}–{formatOffset(w.endMs)}">
                                    {ep ? episodeCode(ep) : ''}
                                </div>
                            {/each}
                        </div>
                    {/if}

                    {#if previewMs !== null && previewItemId}
                        <EpisodeTrickplayPreview
                            mediaId={previewItemId}
                            {fileId}
                            seekMs={previewMs} />
                    {/if}

                    {#if problem && order.length > 0}
                        <p class="text-sm text-amber-400">{problem}</p>
                    {/if}
                {/if}
                {#if data?.file.manual && unsavedTarget}<p class="text-sm text-amber-300">
                        {m.file_episodes_reset_context()}
                    </p>{/if}
                {#if resetRequested}<p class="text-sm text-amber-300">
                        {m.file_episodes_reset_pending()}
                    </p>{/if}
            </fieldset>
        </div>

        <div
            class="flex shrink-0 items-center justify-between gap-2 px-5 py-3 border-t border-surface-700">
            {#if data?.undoId}
                <button
                    class="btn btn-sm variant-ghost-surface text-xs"
                    disabled={saving || loading || hasMappingDraft || unsavedTarget || reviewStale}
                    title={hasMappingDraft ? m.file_episodes_save() : undefined}
                    onclick={undoMapping}>{m.media_p5_undo_mapping()}</button>
            {/if}
            {#if data?.file.manual}
                <button
                    class="btn btn-sm variant-ghost-surface text-xs"
                    title={m.file_episodes_reset_hint()}
                    disabled={saving || loading || unsavedTarget || reviewStale}
                    onclick={reset}>{m.file_episodes_reset()}</button>
            {:else}
                <span></span>
            {/if}
            <button
                class="btn btn-sm variant-filled-primary text-sm"
                disabled={saving ||
                    chapterBusy ||
                    reviewStale ||
                    loading ||
                    !data ||
                    (!resetRequested &&
                        (!order.length || problem !== null || missingRestorationConsent))}
                onclick={save}>{m.file_episodes_save()}</button>
        </div>
    </div>
</div>
