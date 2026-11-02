<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  "Never matched" view of the Fix-matches workbench (admin IA redesign, spec
  §3.2). Personal files — media_items rows with NO external_ids at all — that
  the scanner found but never linked to a provider. Auto-Identify is the
  PRIMARY (filled) action and per-item Identify is secondary (ghost).

  "Remove from library" (formerly an unlabeled ×) soft-dismisses the item and
  every descendant from the catalogue — it disappears from browsing for EVERY
  user, not just from this list. So it always confirms, says so in plain words,
  and the success toast carries an Undo (POST …/unmatched-files/[id]/restore).
-->
<script lang="ts">
    import { untrack } from 'svelte';
    import { SvelteMap, SvelteSet } from 'svelte/reactivity';
    import { Icon, ArrowPath, LockClosed, MagnifyingGlass, Tag, Trash } from 'svelte-hero-icons';
    import { IdentifyModal } from '$lib/components/admin';
    import { toasts } from '$lib/stores/toast.store';
    import { modals } from '$lib/stores/modal.store';
    import { getErrorMessage } from '$lib/utils/error-handling';
    import {
        startAutoIdentify as apiStartAutoIdentify,
        dismissUnmatchedFile,
        restoreUnmatchedFile,
        keepPersonalMedia,
        restoreKeptPersonalMedia,
        listUnmatchedFiles,
        getUnmatchedFileChildren,
    } from '$lib/api/admin';
    import ConfirmModal from '$lib/components/ui/ConfirmModal.svelte';
    import { formatFileSize } from '$lib/utils/metric-formatters';
    import { isNonEntertainment, isSeries as _isSeries } from '$lib/shared/media-types';
    import { resolve } from '$lib/paths';
    import { apiGet } from '$lib/api/client.js';
    import {
        AutoIdentifySummarySchema,
        type AutoIdentifySummary,
    } from '$lib/schemas/auto-identify.js';
    import { RunSchema } from '$lib/schemas/run.schema.js';
    import type {
        PersonalMediaItem,
        PersonalSeason,
    } from '$lib/schemas/api-admin-unmatched-responses';
    import FixMatchRow from './FixMatchRow.svelte';
    import { fileName, mediaTypeLabel } from './fix-matches-format.js';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        /**
         * The library the host page is scoped to (Fix matches `?library=`). A
         * page-level scope, not one of this panel's own filters: the host's
         * badge count is already scoped to it, so it does not count as
         * `filtered` below.
         */
        libraryGroupId?: string;
        /**
         * Notifies the host page so it can show a count on the view's tab.
         * `filtered` is true while search/type narrowing is active — the total
         * then describes the filtered list, not the whole view.
         */
        ontotalchange?: (total: number, filtered: boolean) => void;
    }

    let { libraryGroupId, ontotalchange }: Props = $props();

    const AUTO_IDENTIFY_TASK = 'auto-identify-personal-media';

    let personalItems = $state<PersonalMediaItem[]>([]);
    let personalTotal = $state(0);
    let showKept = $state(false);

    const pageSize = 25;
    let currentOffset = $state(0);
    let isLoadingPersonal = $state(false);
    let personalLoaded = $state(false);
    // Set on a failed load so the render branch below can distinguish "we
    // checked and there's genuinely nothing" from "the check never
    // completed" — without this a failed first fetch (toast only, no
    // lingering flag) rendered the false-positive "All caught up!" empty
    // state (edge case hunter finding 2026-07-10 #2).
    let personalLoadError = $state(false);
    // Monotonic request-sequencing token: rapid search/sort/filter changes
    // can have overlapping requests in flight, and without this the
    // last-to-RESOLVE response wins rather than the last-REQUESTED one,
    // silently showing stale results against the currently-displayed filter
    // controls (edge case hunter finding 2026-07-10 #3). Mirrors the
    // `loadSeq` pattern in src/routes/admin/tasks/+page.svelte.
    let personalLoadSeq = 0;
    let loadedQueryKey = $state('');
    let unresolvedCountRefreshError = $state(false);
    let unresolvedCountRequestSeq = 0;
    const pendingDispositionActions = new SvelteSet<string>();

    // Search, filter, sort
    let personalSearch = $state('');
    let personalSort = $state<'title' | 'episodes' | 'added'>('title');
    let personalMediaType = $state<'movie' | 'series' | undefined>(undefined);
    let personalSearchTimer: ReturnType<typeof setTimeout> | null = null;

    let isFiltered = $derived(!!personalSearch.trim() || !!personalMediaType);
    function currentQueryKey(offset = currentOffset): string {
        return JSON.stringify([
            libraryGroupId ?? '',
            showKept,
            personalSort,
            personalSearch.trim(),
            personalMediaType ?? '',
            offset,
        ]);
    }
    function currentUnresolvedCountScope(): {
        libraryGroupId?: string;
        q?: string;
        mediaType?: 'movie' | 'series';
        sort: 'title' | 'episodes' | 'added';
        filtered: boolean;
    } {
        return {
            libraryGroupId: libraryGroupId || undefined,
            q: personalSearch.trim() || undefined,
            mediaType: personalMediaType,
            sort: personalSort,
            filtered: !!personalSearch.trim() || !!personalMediaType,
        };
    }
    function unresolvedCountScopeKey(scope = currentUnresolvedCountScope()): string {
        return JSON.stringify(scope);
    }
    let rowsAreCurrent = $derived(personalLoaded && loadedQueryKey === currentQueryKey());

    $effect(() => {
        // Not before the first load: the initial 0 would wipe the server-loaded
        // tab badge while the list is still loading.
        if (rowsAreCurrent && !isLoadingPersonal && !showKept) {
            ontotalchange?.(personalTotal, isFiltered);
        }
    });

    // Expandable series
    let expandedSeries = new SvelteSet<string>();
    let seriesChildrenCache = new SvelteMap<string, PersonalSeason[]>();
    let loadingChildren = new SvelteSet<string>();

    // Bulk select
    const selectedItems = new SvelteSet<string>();
    let bulkRemoving = $state(false);

    // Identify modal state — owns the provider search + 409 "merge into
    // existing" recovery path.
    let identifyingItem = $state<PersonalMediaItem | null>(null);
    let personalHeadingEl = $state<HTMLHeadingElement | null>(null);

    // Auto-identify (whole list, or the selection)
    let isAutoIdentifying = $state(false);
    let matchingSummary = $state<AutoIdentifySummary | null>(null);
    let autoIdentifyProgress = $state<{ processed: number; total: number } | null>(null);
    let autoIdentifyTimer: ReturnType<typeof setInterval> | null = null;

    async function loadPersonalItems(offset = 0): Promise<void> {
        isLoadingPersonal = true;
        const seq = ++personalLoadSeq;
        const requestQueryKey = currentQueryKey(offset);
        try {
            const { data, error } = await listUnmatchedFiles({
                limit: pageSize,
                offset,
                sort: personalSort,
                q: personalSearch.trim() || undefined,
                mediaType: personalMediaType,
                libraryGroupId,
                disposition: showKept ? 'kept' : 'unresolved',
            });
            // Drop a stale response if a newer load() started after this one
            // — otherwise whichever request happens to RESOLVE last wins,
            // regardless of which one matches the filter/search controls
            // currently shown.
            if (seq !== personalLoadSeq || requestQueryKey !== currentQueryKey(offset)) return;
            if (error) {
                personalLoadError = true;
                toasts.error(m.admin_toast_failed_to_load_personal_media());
                return;
            }
            if (data) {
                if ((data.page.total ?? 0) > 0 && data.items.length === 0 && offset > 0) {
                    const lastOffset =
                        Math.floor(((data.page.total ?? 1) - 1) / pageSize) * pageSize;
                    await loadPersonalItems(lastOffset);
                    return;
                }
                personalItems = data.items;
                personalTotal = data.page.total ?? 0;
                currentOffset = offset;
                loadedQueryKey = requestQueryKey;
                personalLoaded = true;
                personalLoadError = false;
                const visibleIds = new Set(data.items.map((item) => item.id));
                for (const id of selectedItems) {
                    if (!visibleIds.has(id)) selectedItems.delete(id);
                }
            }
        } catch (e) {
            if (seq !== personalLoadSeq) return;
            personalLoadError = true;
            toasts.error(getErrorMessage(e, m.admin_toast_failed_to_load_personal_media()));
        } finally {
            if (seq === personalLoadSeq) isLoadingPersonal = false;
        }
    }

    async function refreshUnresolvedCount(): Promise<void> {
        const scope = currentUnresolvedCountScope();
        const scopeKey = unresolvedCountScopeKey(scope);
        const requestSeq = ++unresolvedCountRequestSeq;
        try {
            const { data, error } = await listUnmatchedFiles({
                limit: 1,
                offset: 0,
                sort: scope.sort,
                q: scope.q,
                mediaType: scope.mediaType,
                libraryGroupId: scope.libraryGroupId,
                disposition: 'unresolved',
            });
            if (error || !data) throw new Error(error ?? 'No count response');
            if (requestSeq !== unresolvedCountRequestSeq || scopeKey !== unresolvedCountScopeKey())
                return;
            unresolvedCountRefreshError = false;
            ontotalchange?.(data.page.total ?? 0, scope.filtered);
        } catch (error) {
            if (requestSeq !== unresolvedCountRequestSeq || scopeKey !== unresolvedCountScopeKey())
                return;
            unresolvedCountRefreshError = true;
            console.warn('[NeverMatchedPanel] Unresolved count refresh failed', error);
        }
    }

    /**
     * Remove item(s) from the current list in place and decrement the total —
     * no refetch. A same-offset refetch after a removal would slide the next
     * page's item into the vacated card slot, reshuffling everything below it
     * right under the operator's cursor (the fix/accept "reshuffle" bug).
     * `ids` are top-level personal-media rows; `topLevelRemoved` is how many
     * of those top-level rows to subtract from `personalTotal` (which counts
     * only top-level rows, not their descendant seasons/episodes).
     */
    function removeItemsLocally(ids: string[], topLevelRemoved = ids.length): void {
        const idSet = new Set(ids);
        personalItems = personalItems.filter((item) => !idSet.has(item.id));
        personalTotal = Math.max(0, personalTotal - topLevelRemoved);
        for (const id of ids) {
            expandedSeries.delete(id);
            seriesChildrenCache.delete(id);
            selectedItems.delete(id);
        }
    }

    async function reloadPageIfCurrentRowsEmpty(actionQueryKey: string): Promise<void> {
        if (
            currentQueryKey() !== actionQueryKey ||
            showKept ||
            personalItems.length > 0 ||
            personalTotal <= 0
        )
            return;
        const lastValidOffset = Math.floor((personalTotal - 1) / pageSize) * pageSize;
        await loadPersonalItems(Math.min(currentOffset, lastValidOffset));
    }

    function resetSelectionForQueryChange(): void {
        selectedItems.clear();
        currentOffset = 0;
    }

    function onPersonalSearchInput(): void {
        unresolvedCountRequestSeq++;
        if (personalSearchTimer) clearTimeout(personalSearchTimer);
        personalSearchTimer = setTimeout(() => {
            resetSelectionForQueryChange();
            void loadPersonalItems(0);
        }, 300);
    }

    function setPersonalSort(sort: 'title' | 'episodes' | 'added'): void {
        unresolvedCountRequestSeq++;
        personalSort = sort;
        resetSelectionForQueryChange();
        void loadPersonalItems(0);
    }

    function setPersonalMediaType(type: 'movie' | 'series' | undefined): void {
        unresolvedCountRequestSeq++;
        personalMediaType = type;
        resetSelectionForQueryChange();
        void loadPersonalItems(0);
    }

    function clearFilters(): void {
        unresolvedCountRequestSeq++;
        personalSearch = '';
        personalMediaType = undefined;
        resetSelectionForQueryChange();
        void loadPersonalItems(0);
    }

    function setKeptView(kept: boolean): void {
        if (showKept === kept) return;
        unresolvedCountRequestSeq++;
        showKept = kept;
        selectedItems.clear();
        currentOffset = 0;
        void loadPersonalItems(0);
    }

    function goToPersonalPage(offset: number): void {
        selectedItems.clear();
        void loadPersonalItems(offset);
    }

    async function toggleSeriesExpand(item: PersonalMediaItem): Promise<void> {
        if (expandedSeries.has(item.id)) {
            expandedSeries.delete(item.id);
            return;
        }
        expandedSeries.add(item.id);
        if (!seriesChildrenCache.has(item.id)) {
            loadingChildren.add(item.id);
            try {
                const { data, error } = await getUnmatchedFileChildren(item.id);
                if (data) {
                    seriesChildrenCache.set(item.id, data.seasons);
                } else {
                    // An expanded row with nothing under it read as "no
                    // episodes"; collapse it and say the load failed.
                    expandedSeries.delete(item.id);
                    toasts.error(error ?? m.admin_fix_matches_children_load_failed());
                }
            } catch (e) {
                expandedSeries.delete(item.id);
                toasts.error(getErrorMessage(e, m.admin_fix_matches_children_load_failed()));
            } finally {
                loadingChildren.delete(item.id);
            }
        }
    }

    function toggleSelected(id: string): void {
        if (!rowsAreCurrent || showKept) return;
        if (selectedItems.has(id)) selectedItems.delete(id);
        else selectedItems.add(id);
    }

    // ── Remove from library (+ Undo) ─────────────────────────────────────

    /** Put removed items back; reload so they reappear in their sorted place. */
    async function undoRemove(ids: string[]): Promise<void> {
        const results = await Promise.allSettled(ids.map((id) => restoreUnmatchedFile(id)));
        const restored = results.filter((r) => r.status === 'fulfilled' && !r.value.error).length;
        if (restored > 0) toasts.success(m.admin_fix_matches_restored({ count: restored }));
        if (restored < ids.length) toasts.error(m.admin_fix_matches_restore_failed());
        void loadPersonalItems(currentOffset);
    }

    function removedToast(message: string, ids: string[]): void {
        toasts.success(message, {
            timeout: 10_000,
            action: {
                label: m.admin_fix_matches_undo(),
                onClick: () => void undoRemove(ids),
            },
        });
    }

    function requestRemove(item: PersonalMediaItem): void {
        const isSeriesItem = (item.episode_count ?? 0) > 0;
        modals.open(ConfirmModal, {
            title: m.admin_fix_matches_remove_title({ title: item.title }),
            body: isSeriesItem
                ? m.admin_fix_matches_remove_body_series({
                      summary: `${m.admin_library_season_count({ count: item.season_count ?? 0 })}, ${m.admin_library_episode_count({ count: item.episode_count ?? 0 })}`,
                  })
                : m.admin_fix_matches_remove_body_movie(),
            confirmText: m.admin_fix_matches_remove(),
            confirmVariant: 'danger' as const,
            onConfirm: () => executeRemove(item),
        });
    }

    function requestKeep(item: PersonalMediaItem): void {
        if (!rowsAreCurrent || pendingDispositionActions.has(item.id)) return;
        modals.open(ConfirmModal, {
            title: m.admin_fix_matches_keep_title({ title: item.title }),
            body: m.admin_fix_matches_keep_body(),
            confirmText: m.admin_fix_matches_keep(),
            onConfirm: () => executeKeep(item),
        });
    }

    async function executeKeep(item: PersonalMediaItem): Promise<void> {
        if (!rowsAreCurrent || pendingDispositionActions.has(item.id)) return;
        const actionQueryKey = currentQueryKey();
        pendingDispositionActions.add(item.id);
        try {
            const { error } = await keepPersonalMedia(item.id);
            if (error) {
                toasts.error(m.admin_fix_matches_keep_failed({ title: item.title }));
                return;
            }
            personalLoadSeq++;
            // Invalidate any older list request. If the action stays in the
            // same scope, its result is applied locally, so clear the loading
            // state that the invalidated request would otherwise own.
            isLoadingPersonal = false;
            toasts.success(m.admin_fix_matches_kept({ title: item.title }));
            if (currentQueryKey() === actionQueryKey) {
                removeItemsLocally([item.id]);
                await reloadPageIfCurrentRowsEmpty(actionQueryKey);
            } else await loadPersonalItems(currentOffset);
        } catch (e) {
            toasts.error(
                getErrorMessage(e, m.admin_fix_matches_keep_failed({ title: item.title })),
            );
        } finally {
            pendingDispositionActions.delete(item.id);
        }
    }

    async function restoreKeep(item: PersonalMediaItem): Promise<void> {
        if (!rowsAreCurrent || pendingDispositionActions.has(item.id)) return;
        const actionQueryKey = currentQueryKey();
        pendingDispositionActions.add(item.id);
        try {
            const { error } = await restoreKeptPersonalMedia(item.id);
            if (error) {
                toasts.error(m.admin_fix_matches_restore_keep_failed({ title: item.title }));
                return;
            }
            personalLoadSeq++;
            toasts.success(m.admin_fix_matches_restore_keep_success({ title: item.title }));
            if (currentQueryKey() === actionQueryKey) removeItemsLocally([item.id]);
            await Promise.all([loadPersonalItems(currentOffset), refreshUnresolvedCount()]);
        } catch (e) {
            toasts.error(
                getErrorMessage(e, m.admin_fix_matches_restore_keep_failed({ title: item.title })),
            );
        } finally {
            pendingDispositionActions.delete(item.id);
        }
    }

    async function executeRemove(item: PersonalMediaItem): Promise<void> {
        if (!rowsAreCurrent || showKept) return;
        const actionQueryKey = currentQueryKey();
        try {
            const { error } = await dismissUnmatchedFile(item.id);
            if (error) {
                toasts.error(m.admin_fix_matches_remove_failed({ title: item.title }));
                return;
            }
            if (currentQueryKey() !== actionQueryKey || showKept) return;
            removeItemsLocally([item.id]);
            await reloadPageIfCurrentRowsEmpty(actionQueryKey);
            removedToast(m.admin_fix_matches_removed({ title: item.title }), [item.id]);
        } catch (e) {
            toasts.error(
                getErrorMessage(e, m.admin_fix_matches_remove_failed({ title: item.title })),
            );
        }
    }

    function requestBulkRemove(): void {
        if (!rowsAreCurrent || showKept || selectedItems.size === 0) return;
        const actionQueryKey = currentQueryKey();
        modals.open(ConfirmModal, {
            title: m.admin_fix_matches_remove_bulk_title({ count: selectedItems.size }),
            body: m.admin_fix_matches_remove_bulk_body(),
            confirmText: m.admin_fix_matches_remove(),
            confirmVariant: 'danger' as const,
            onConfirm: () => executeBulkRemove(actionQueryKey),
        });
    }

    async function executeBulkRemove(actionQueryKey = currentQueryKey()): Promise<void> {
        if (!rowsAreCurrent || showKept || currentQueryKey() !== actionQueryKey) return;
        bulkRemoving = true;
        const visibleIds = new Set(personalItems.map((item) => item.id));
        const ids = [...selectedItems].filter((id) => visibleIds.has(id));
        if (ids.length === 0) {
            bulkRemoving = false;
            return;
        }
        const succeededIds: string[] = [];
        let failed = 0;
        const CHUNK = 5; // bounded concurrency
        for (let i = 0; i < ids.length; i += CHUNK) {
            const chunk = ids.slice(i, i + CHUNK);
            const results = await Promise.allSettled(chunk.map((id) => dismissUnmatchedFile(id)));
            results.forEach((r, idx) => {
                if (r.status === 'fulfilled' && !r.value.error) succeededIds.push(chunk[idx]);
                else failed++;
            });
        }
        if (currentQueryKey() === actionQueryKey && !showKept) {
            selectedItems.clear();
            removeItemsLocally(succeededIds);
            await reloadPageIfCurrentRowsEmpty(actionQueryKey);
        }
        bulkRemoving = false;
        if (failed === 0) {
            removedToast(
                m.admin_fix_matches_removed_count({ count: succeededIds.length }),
                succeededIds,
            );
        } else {
            toasts.warning(
                m.admin_fix_matches_removed_with_failures({
                    removed: succeededIds.length,
                    failed,
                }),
                succeededIds.length > 0
                    ? {
                          action: {
                              label: m.admin_fix_matches_undo(),
                              onClick: () => void undoRemove(succeededIds),
                          },
                      }
                    : undefined,
            );
        }
    }

    // ── Selection ────────────────────────────────────────────────────────

    let allPageSelected = $derived(
        rowsAreCurrent &&
            !showKept &&
            personalItems.length > 0 &&
            personalItems.every((item) => selectedItems.has(item.id)),
    );

    function toggleSelectAll(): void {
        if (!rowsAreCurrent || showKept) return;
        if (allPageSelected) {
            for (const item of personalItems) selectedItems.delete(item.id);
        } else {
            for (const item of personalItems) selectedItems.add(item.id);
        }
    }

    function openIdentifyModal(item: PersonalMediaItem): void {
        identifyingItem = item;
    }

    function onIdentified(): void {
        const id = identifyingItem?.id;
        if (id) removeItemsLocally([id]);
        identifyingItem = null;
        personalHeadingEl?.focus();
    }

    // ── Auto-identify ────────────────────────────────────────────────────
    // Trigger the auto-identify-personal-media task (whole list, or only the
    // selected ids), then poll its run via the generic /api/runs/{id} endpoint
    // and surface its progress next to the button.

    function currentScope(): {
        libraryGroupId?: string;
        mediaType?: 'movie' | 'tv';
        search?: string;
    } {
        return {
            libraryGroupId: libraryGroupId || undefined,
            mediaType:
                personalMediaType === 'series'
                    ? 'tv'
                    : personalMediaType === 'movie'
                      ? 'movie'
                      : undefined,
            search: personalSearch.trim() || undefined,
        };
    }

    /** True when "Auto-identify" covers only a filtered subset, not every library. */
    let autoIdentifyScoped = $derived(!!libraryGroupId || isFiltered);

    async function startAutoIdentify(mediaItemIds?: string[]): Promise<void> {
        if (mediaItemIds && (!rowsAreCurrent || showKept)) return;
        isAutoIdentifying = true;
        autoIdentifyProgress = null;
        matchingSummary = null;
        try {
            // Without explicit ids, run over exactly what the list shows: the
            // page's library and filters. The run used to sweep every
            // unmatched item in every library whatever the list showed.
            const { data, error } = await apiStartAutoIdentify(
                mediaItemIds,
                mediaItemIds ? undefined : currentScope(),
            );
            if (!error && data?.jobId) {
                toasts.success(m.admin_library_auto_identify_started());
                if (mediaItemIds) selectedItems.clear();
                pollAutoIdentify(data.jobId);
            } else if (!error) {
                isAutoIdentifying = false;
                void loadPersonalItems(0);
            } else {
                toasts.error(error ?? m.admin_library_auto_identify_start_failed());
                isAutoIdentifying = false;
            }
        } catch (err) {
            toasts.error(getErrorMessage(err, m.admin_library_auto_identify_failed()));
            isAutoIdentifying = false;
        }
    }

    function stopPolling(): void {
        if (autoIdentifyTimer) clearInterval(autoIdentifyTimer);
        autoIdentifyTimer = null;
        isAutoIdentifying = false;
        autoIdentifyProgress = null;
    }

    /** Consecutive failed status polls; one blip must not drop a run that is still going. */
    let autoIdentifyPollFailures = 0;
    const AUTO_IDENTIFY_MAX_POLL_FAILURES = 5;

    function onAutoIdentifyPollFailure(): void {
        autoIdentifyPollFailures++;
        if (autoIdentifyPollFailures < AUTO_IDENTIFY_MAX_POLL_FAILURES) return;
        stopPolling();
        toasts.warning(m.admin_fix_matches_auto_identify_lost_track());
    }

    function pollAutoIdentify(jobId: string): void {
        if (autoIdentifyTimer) return;
        autoIdentifyPollFailures = 0;
        autoIdentifyTimer = setInterval(async () => {
            try {
                const { data: run, error } = await apiGet(
                    `/api/runs/${encodeURIComponent(jobId)}`,
                    RunSchema,
                );
                if (error || !run) {
                    onAutoIdentifyPollFailure();
                    return;
                }
                autoIdentifyPollFailures = 0;
                const stage = run.stages.find((s) => s.total != null && s.total > 0);
                autoIdentifyProgress = stage
                    ? { processed: stage.processed ?? 0, total: stage.total ?? 0 }
                    : null;
                if (
                    run.state === 'completed' ||
                    run.state === 'failed' ||
                    run.state === 'cancelled'
                ) {
                    stopPolling();
                    if (run.state === 'completed') {
                        const taskResult = run.result as { result?: unknown } | undefined;
                        const summary = AutoIdentifySummarySchema.safeParse(taskResult?.result);
                        if (summary.success) {
                            matchingSummary = summary.data;
                            toasts.success(
                                m.admin_library_auto_identify_complete({
                                    count: summary.data.matched,
                                }),
                            );
                        } else toasts.warning(m.music_identify_unknown_result());
                    } else if (run.state === 'failed') {
                        toasts.error(m.admin_toast_auto_identify_job_failed());
                    }
                    void loadPersonalItems(0);
                }
            } catch (e) {
                console.warn('[NeverMatchedPanel] Auto-identify polling failed', e);
                onAutoIdentifyPollFailure();
            }
        }, 3000);
    }

    // The host page's library scope changed (?library= switch): start over
    // from the first page. Only `libraryGroupId` is tracked — loadPersonalItems
    // reads the other filters synchronously and must not subscribe this effect.
    let loadedLibraryGroupId = untrack(() => libraryGroupId);
    let lastUnresolvedCountScopeKey = untrack(() => unresolvedCountScopeKey());
    $effect(() => {
        const nextScopeKey = unresolvedCountScopeKey();
        if (nextScopeKey === lastUnresolvedCountScopeKey) return;
        lastUnresolvedCountScopeKey = nextScopeKey;
        untrack(() => {
            unresolvedCountRequestSeq++;
            unresolvedCountRefreshError = false;
            if (showKept) void refreshUnresolvedCount();
        });
    });
    $effect(() => {
        const next = libraryGroupId;
        if (next === loadedLibraryGroupId) return;
        loadedLibraryGroupId = next;
        untrack(() => {
            resetSelectionForQueryChange();
            void loadPersonalItems(0);
        });
    });

    $effect(() => {
        if (!personalLoaded) void loadPersonalItems(0);
        return () => {
            if (personalSearchTimer) clearTimeout(personalSearchTimer);
            if (autoIdentifyTimer) {
                clearInterval(autoIdentifyTimer);
                autoIdentifyTimer = null;
            }
        };
    });

    const chipBase = 'px-3 py-1.5 text-xs font-medium rounded-full transition-colors shrink-0';
    const chipOff = 'bg-surface-700 text-surface-300 hover:bg-surface-600';
</script>

<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
    <div class="min-w-0">
        <h2 bind:this={personalHeadingEl} tabindex="-1" class="text-2xl font-semibold outline-none">
            {m.admin_fix_matches_tab_never()}
        </h2>
        <p class="text-muted text-sm mt-1 max-w-2xl">
            {m.route_admin_library_personal_media_desc()}
        </p>
    </div>
    <div class="flex shrink-0 flex-wrap items-center gap-2">
        <button
            class="btn btn-ghost"
            onclick={() => loadPersonalItems(currentOffset)}
            disabled={isLoadingPersonal}>
            <Icon src={ArrowPath} class="w-4 h-4 {isLoadingPersonal ? 'animate-spin' : ''}" />
            {m.btn_refresh()}
        </button>
        {#if !showKept && !isNonEntertainment(personalMediaType ?? '')}
            <button
                class="btn btn-primary whitespace-nowrap"
                onclick={() => startAutoIdentify()}
                disabled={isAutoIdentifying || personalTotal === 0}>
                <Icon src={Tag} class="w-4 h-4 {isAutoIdentifying ? 'animate-pulse' : ''}" />
                {#if isAutoIdentifying && autoIdentifyProgress}
                    {m.admin_fix_matches_identifying_progress(autoIdentifyProgress)}
                {:else if isAutoIdentifying}
                    {m.route_admin_library_identifying()}
                {:else if autoIdentifyScoped}
                    {m.admin_fix_matches_auto_identify_shown({ count: personalTotal })}
                {:else}
                    {m.route_admin_library_auto_identify()}
                {/if}
            </button>
        {/if}
        {#if isAutoIdentifying}
            <a
                href={resolve(`/admin/tasks/${AUTO_IDENTIFY_TASK}`)}
                class="text-xs text-sky-400 hover:text-sky-300">{m.admin_fix_matches_view_run()}</a>
        {/if}
    </div>
</div>

{#if matchingSummary && matchingSummary.conflicts > 0}
    <div role="status" class="my-3 rounded border border-surface-600 p-3 text-sm">
        <p>{m.music_identify_conflicts({ count: String(matchingSummary.conflicts) })}</p>
        <details class="mt-2">
            <summary class="cursor-pointer">{m.music_identify_conflict_entries()}</summary>
            <ul>
                {#each matchingSummary.conflictItems as item (item.id)}
                    <li>
                        <a
                            class="text-primary-300 underline"
                            href={resolve(`/admin/library/media/${item.id}`)}>{item.title}</a>
                    </li>
                {/each}
            </ul>
            {#if matchingSummary.conflicts > matchingSummary.conflictItems.length}<p>
                    {m.music_identify_more_conflicts()}
                </p>{/if}
        </details>
    </div>
{/if}

<!-- Search, filter, sort toolbar -->
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
                bind:value={personalSearch}
                oninput={onPersonalSearchInput} />
        </div>
        <div class="flex gap-1">
            <button
                class="{chipBase} {!showKept ? 'bg-blue-600 text-white' : chipOff}"
                aria-pressed={!showKept}
                onclick={() => setKeptView(false)}
                >{m.admin_fix_matches_unresolved_filter()}</button>
            <button
                class="{chipBase} {showKept ? 'bg-blue-600 text-white' : chipOff}"
                aria-pressed={showKept}
                onclick={() => setKeptView(true)}>{m.admin_fix_matches_kept_filter()}</button>
        </div>
        <div class="flex gap-1">
            <button
                class="{chipBase} {personalMediaType === undefined
                    ? 'bg-blue-600 text-white'
                    : chipOff}"
                aria-pressed={personalMediaType === undefined}
                onclick={() => setPersonalMediaType(undefined)}
                >{m.route_admin_library_filter_all()}</button>
            <button
                class="{chipBase} {personalMediaType === 'series'
                    ? 'bg-blue-600 text-white'
                    : chipOff}"
                aria-pressed={personalMediaType === 'series'}
                onclick={() => setPersonalMediaType('series')}
                >{m.route_admin_library_filter_series()}</button>
            <button
                class="{chipBase} {personalMediaType === 'movie'
                    ? 'bg-blue-600 text-white'
                    : chipOff}"
                aria-pressed={personalMediaType === 'movie'}
                onclick={() => setPersonalMediaType('movie')}
                >{m.route_admin_library_filter_movies()}</button>
        </div>
    </div>
    <div class="flex flex-wrap gap-x-3 gap-y-2 items-center justify-between">
        <div class="flex flex-wrap gap-1 items-center text-xs text-surface-400">
            <span>{m.admin_library_sort()}</span>
            <button
                class="px-2 py-1 rounded transition-colors {personalSort === 'title'
                    ? 'bg-surface-600 text-white'
                    : 'text-surface-400 hover:text-surface-200'}"
                aria-pressed={personalSort === 'title'}
                onclick={() => setPersonalSort('title')}>{m.route_admin_library_sort_az()}</button>
            <button
                class="px-2 py-1 rounded transition-colors {personalSort === 'episodes'
                    ? 'bg-surface-600 text-white'
                    : 'text-surface-400 hover:text-surface-200'}"
                aria-pressed={personalSort === 'episodes'}
                onclick={() => setPersonalSort('episodes')}
                >{m.route_admin_library_sort_episodes()}</button>
            <button
                class="px-2 py-1 rounded transition-colors {personalSort === 'added'
                    ? 'bg-surface-600 text-white'
                    : 'text-surface-400 hover:text-surface-200'}"
                aria-pressed={personalSort === 'added'}
                onclick={() => setPersonalSort('added')}
                >{m.route_admin_library_sort_newest()}</button>
        </div>
        <span class="text-xs text-surface-500">
            {m.admin_library_item_count({ count: personalTotal })}
        </span>
    </div>
    {#if showKept && unresolvedCountRefreshError}
        <div
            class="flex items-center gap-2 border-t border-surface-700 pt-2 text-xs text-amber-300">
            <span>{m.admin_toast_failed_to_load_personal_media()}</span>
            <button type="button" class="underline" onclick={() => void refreshUnresolvedCount()}>
                {m.common_retry()}
            </button>
        </div>
    {/if}
    {#if !showKept}
        <label
            class="flex items-center gap-2 pt-2 border-t border-surface-700 w-fit cursor-pointer">
            <input
                type="checkbox"
                checked={allPageSelected}
                disabled={!rowsAreCurrent || showKept || personalItems.length === 0}
                onchange={toggleSelectAll}
                class="rounded border-surface-600 bg-surface-800 text-blue-500" />
            <span class="text-xs text-surface-400">{m.route_admin_library_select_all_page()}</span>
        </label>
    {/if}
</div>

{#if !personalLoaded && !personalLoadError}
    <!-- Until the first response lands — including the frame before the
         fetch even starts — never fall through to "All clear". -->

    <p class="text-muted text-sm py-4">{m.common_loading()}</p>
{:else if personalLoadError && personalItems.length === 0}
    <div class="rounded border border-red-700/30 bg-red-900/20 p-4 text-sm text-red-300">
        {m.admin_toast_failed_to_load_personal_media()}
        <button
            type="button"
            class="ml-3 text-xs text-red-200 underline"
            onclick={() => void loadPersonalItems(currentOffset)}>{m.common_retry()}</button>
    </div>
{:else if personalItems.length === 0 && personalTotal === 0 && !isFiltered && !showKept}
    <div class="bg-surface-800 border border-surface-700 rounded-lg p-12 text-center">
        <div class="text-4xl mb-3">&#10003;</div>
        <p class="text-lg font-medium text-white">
            {m.route_admin_library_all_clear()}
        </p>
        <p class="text-muted text-sm mt-2 max-w-md mx-auto">
            {m.route_admin_library_all_clear_body()}
        </p>
    </div>
{:else if personalItems.length === 0 && showKept && !isFiltered}
    <div class="bg-surface-800 border border-surface-700 rounded-lg p-8 text-center">
        <p class="text-muted">{m.admin_fix_matches_kept_empty()}</p>
    </div>
{:else if personalItems.length === 0}
    <div class="bg-surface-800 border border-surface-700 rounded-lg p-8 text-center">
        <p class="text-muted">
            {m.route_admin_library_no_results()}
        </p>
        <button class="btn btn-ghost btn-sm mt-3" onclick={clearFilters}>
            {m.route_admin_library_clear_filters()}
        </button>
    </div>
{:else}
    <!-- Kept on screen (dimmed) while a search/filter/sort reload is in
         flight, so the list does not collapse to "Loading…" and jump. -->
    <div
        class="space-y-1 transition-opacity {isLoadingPersonal ? 'opacity-50' : ''}"
        aria-busy={isLoadingPersonal}>
        {#each personalItems as item (item.id)}
            {@const isSeries = _isSeries(item.media_type) && (item.episode_count ?? 0) > 0}
            <FixMatchRow
                posterId={item.id}
                title={item.title}
                selected={selectedItems.has(item.id)}
                selectable={!showKept && rowsAreCurrent}
                ontoggleselect={() => toggleSelected(item.id)}
                expanded={isSeries ? expandedSeries.has(item.id) : undefined}
                ontoggleexpand={isSeries ? () => void toggleSeriesExpand(item) : undefined}>
                {#snippet meta()}
                    <span class="rounded bg-surface-700 px-1.5 py-0.5 text-surface-300"
                        >{mediaTypeLabel(item.media_type)}</span>
                    {#if item.release_year}
                        · {item.release_year}
                    {/if}
                    {#if isSeries}
                        · {m.admin_library_season_count({ count: item.season_count ?? 0 })}
                        · {m.admin_library_episode_count({ count: item.episode_count ?? 0 })}
                    {/if}
                    {#if item.metadata_locked}
                        <Icon
                            src={LockClosed}
                            class="ml-1 inline h-3.5 w-3.5 text-yellow-400"
                            title={m.admin_title_metadata_locked()} />
                    {/if}
                {/snippet}
                {#snippet details()}
                    {#if item.file_path}
                        <p
                            class="mt-1 truncate font-mono text-[11px] text-surface-500"
                            title={item.file_path}>
                            {m.admin_fixmatch_context_file_label()}: {fileName(item.file_path)}
                        </p>
                    {/if}
                {/snippet}
                {#snippet actions()}
                    {#if !rowsAreCurrent}
                        <span class="text-xs text-surface-500" aria-hidden="true">…</span>
                    {:else if showKept}
                        <button
                            class="btn btn-ghost btn-sm flex items-center gap-1.5"
                            disabled={pendingDispositionActions.has(item.id)}
                            onclick={() => void restoreKeep(item)}>
                            {m.admin_fix_matches_restore_keep()}
                        </button>
                    {:else}
                        <!-- Secondary per-item action: Auto-Identify above is the
                             primary path. -->
                        <button
                            class="btn btn-ghost btn-sm flex items-center gap-1.5"
                            onclick={() => openIdentifyModal(item)}>
                            <Icon src={MagnifyingGlass} class="w-3.5 h-3.5" />
                            {m.route_admin_library_identify()}
                        </button>
                        <button
                            class="btn btn-ghost btn-sm flex items-center gap-1.5"
                            aria-label={m.admin_fix_matches_keep_aria({ title: item.title })}
                            disabled={pendingDispositionActions.has(item.id)}
                            onclick={() => requestKeep(item)}>
                            {m.admin_fix_matches_keep()}
                        </button>
                        <button
                            class="btn btn-ghost btn-sm flex items-center gap-1.5 text-surface-400 hover:text-red-300"
                            title={m.admin_fix_matches_remove()}
                            aria-label={m.admin_fix_matches_remove_aria({ title: item.title })}
                            onclick={() => requestRemove(item)}>
                            <Icon src={Trash} class="w-3.5 h-3.5" />
                            <span class="sm:hidden lg:inline">{m.admin_fix_matches_remove()}</span>
                        </button>
                    {/if}
                {/snippet}
                {#if loadingChildren.has(item.id)}
                    <p class="text-xs text-surface-500 py-2">{m.loading()}</p>
                {:else if seriesChildrenCache.has(item.id)}
                    {@const seasons = seriesChildrenCache.get(item.id) ?? []}
                    {#if seasons.length === 0}
                        <p class="text-xs text-surface-500 py-2">
                            {m.route_admin_library_no_episodes()}
                        </p>
                    {:else}
                        {#each seasons as season (season.id)}
                            <div class="mb-2 last:mb-0">
                                <p class="text-xs font-medium text-surface-300 mb-1">
                                    {season.title} ({m.admin_library_episode_count({
                                        count: season.episodes.length,
                                    })})
                                </p>
                                <div class="space-y-0.5 ml-3">
                                    {#each season.episodes.slice(0, 5) as ep (ep.id)}
                                        <div
                                            class="flex items-center gap-3 text-xs text-surface-400 py-0.5">
                                            <span class="text-surface-300 w-14 shrink-0"
                                                >S{String(season.season_number).padStart(
                                                    2,
                                                    '0',
                                                )}E{String(ep.episode_number).padStart(
                                                    2,
                                                    '0',
                                                )}</span>
                                            {#if ep.file_path}
                                                <span
                                                    class="truncate min-w-0 flex-1 text-surface-500"
                                                    title={ep.file_path}>{ep.file_path}</span>
                                            {/if}
                                            {#if ep.file_size_bytes}
                                                <span class="shrink-0 text-surface-500"
                                                    >{formatFileSize(ep.file_size_bytes)}</span>
                                            {/if}
                                        </div>
                                    {/each}
                                    {#if season.episodes.length > 5}
                                        <p class="text-xs text-surface-600 py-0.5">
                                            {m.admin_library_more_episodes({
                                                count: season.episodes.length - 5,
                                            })}
                                        </p>
                                    {/if}
                                </div>
                            </div>
                        {/each}
                    {/if}
                {:else}
                    <p class="text-xs text-surface-500 py-2">
                        {m.route_admin_library_load_retry()}
                    </p>
                {/if}
            </FixMatchRow>
        {/each}
    </div>
    {#if personalTotal > pageSize}
        <div class="flex gap-2 mt-4 items-center">
            <button
                class="btn btn-ghost"
                disabled={currentOffset === 0}
                onclick={() => goToPersonalPage(Math.max(0, currentOffset - pageSize))}>
                {m.previous()}
            </button>
            <span class="text-sm text-surface-400">
                {m.admin_library_pagination_range({
                    start: currentOffset + 1,
                    end: Math.min(currentOffset + pageSize, personalTotal),
                    total: personalTotal,
                })}
            </span>
            <button
                class="btn btn-ghost"
                disabled={currentOffset + pageSize >= personalTotal}
                onclick={() => goToPersonalPage(currentOffset + pageSize)}>
                {m.next()}
            </button>
        </div>
    {/if}
{/if}

<!-- Bulk action bar -->
{#if selectedItems.size > 0 && !showKept && rowsAreCurrent}
    <div
        class="fixed bottom-4 left-4 right-4 z-40 mx-auto flex max-w-2xl flex-wrap items-center justify-center gap-2 rounded-xl border border-surface-700 bg-surface-800 px-4 py-3 shadow-2xl sm:gap-4">
        <span class="text-sm text-surface-300"
            >{m.admin_library_n_selected({ count: selectedItems.size })}</span>
        <button
            class="btn btn-primary btn-sm"
            onclick={() => startAutoIdentify([...selectedItems])}
            disabled={isAutoIdentifying || bulkRemoving}>
            <Icon src={Tag} class="w-3.5 h-3.5" />
            {m.admin_fix_matches_auto_identify_selected()}
        </button>
        <button
            class="btn btn-sm bg-red-600 hover:bg-red-700 text-white"
            onclick={requestBulkRemove}
            disabled={bulkRemoving}>
            <Icon src={Trash} class="w-3.5 h-3.5" />
            {bulkRemoving ? m.admin_fix_matches_removing() : m.admin_fix_matches_remove()}
        </button>
        <button class="btn btn-ghost btn-sm" onclick={() => selectedItems.clear()}
            >{m.common_cancel()}</button>
    </div>
{/if}

{#if identifyingItem}
    <IdentifyModal
        item={{
            id: identifyingItem.id,
            title: identifyingItem.title,
            mediaType: identifyingItem.media_type,
            releaseYear: identifyingItem.release_year,
            filePath: identifyingItem.file_path,
            seasonCount: identifyingItem.season_count,
            episodeCount: identifyingItem.episode_count,
        }}
        onidentified={onIdentified}
        onclose={() => (identifyingItem = null)} />
{/if}
