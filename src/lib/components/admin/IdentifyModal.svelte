<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import FileEpisodesEditor from './media/FileEpisodesEditor.svelte';
    import { Z } from '$lib/utils/z-index';
    import { tick, untrack } from 'svelte';
    import { toasts } from '$lib/stores/toast.store';
    import { getErrorMessage } from '$lib/utils/error-handling';
    import {
        searchProvider,
        matchUnmatchedFileDetailed,
        mergeMediaItems,
        getRepairMediaFiles,
    } from '$lib/api/admin';
    import type { ProviderSearchResult } from '$lib/schemas/api-admin-unmatched-responses';
    import { isMovie as _isMovie, isSeries as _isSeries } from '$lib/shared/media-types';
    import { trapFocus } from '$lib/utils/focus-trap';
    import * as m from '$lib/paraglide/messages.js';

    interface MediaItemInfo {
        id: string;
        title: string;
        mediaType: string;
        releaseYear?: number | null;
        /** Default (or first) file's path — shown truncated for disambiguation. */
        filePath?: string | null;
        seasonCount?: number;
        episodeCount?: number;
    }

    interface Props {
        item: MediaItemInfo;
        onidentified: (mediaId: string) => void;
        onclose: () => void;
    }

    let { item, onidentified, onclose }: Props = $props();

    // Seasons/episodes only mean something for a series — a movie showed
    // "0 seasons · 0 episodes" here.
    let hasChildCounts = $derived(
        !_isMovie(item.mediaType) && ((item.seasonCount ?? 0) > 0 || (item.episodeCount ?? 0) > 0),
    );

    // svelte-ignore state_referenced_locally
    let searchQuery = $state(item.title);
    // svelte-ignore state_referenced_locally
    let mediaType = $state<'any' | 'movie' | 'series'>(
        _isMovie(item.mediaType) ? 'movie' : _isSeries(item.mediaType) ? 'series' : 'any',
    );
    let results = $state<ProviderSearchResult[]>([]);
    let selectedResult = $state<ProviderSearchResult | null>(null);
    let focusedIndex = $state<number>(-1);
    let isSearching = $state(false);
    let isConfirming = $state(false);
    let searchTimer: ReturnType<typeof setTimeout> | null = null;

    // Populated when the chosen provider id is already owned by another row
    // (typically a file-less TMDB discovery duplicate). Offers a one-click merge
    // of this file into that row instead of dead-ending on the 409.
    let conflict = $state<{ conflictMediaId: string; fileMediaId: string } | null>(null);
    let isMerging = $state(false);
    let mergedIdentityError = $state<{ items: number; seasons: number; error: string } | null>(
        null,
    );
    let sourceFiles = $state<{ id: string; file_path: string }[]>([]);
    let targetFiles = $state<{ id: string; file_path: string }[]>([]);
    let filesLoading = $state(false);
    let filesError = $state(false);
    let editorFileId = $state<string | null>(null);
    let conflictTarget = $state<{ id: string; title: string } | null>(null);
    let filesGeneration = 0;
    let cancelButton: HTMLButtonElement;

    // Set when a too-narrow type filter returned zero results and was
    // auto-broadened to "Any" for this search — holds the ORIGINAL (narrowed)
    // type so the note can name what was widened.
    let broadenedFrom = $state<'movie' | 'series' | false>(false);

    /** Truncate the middle of a long path, keeping the start and end readable. */
    function truncateMiddle(value: string, maxLength = 64): string {
        if (value.length <= maxLength) return value;
        const half = Math.floor((maxLength - 1) / 2);
        return `${value.slice(0, half)}…${value.slice(value.length - half)}`;
    }

    // Auto-search on mount (untrack to avoid re-running on state changes).
    // Initial focus is handled by use:trapFocus on the inner card div, which
    // focuses the first tabbable element via queueMicrotask. Do NOT call
    // dialogEl?.focus() here — it runs in a setTimeout, fires after the
    // microtask, and moves focus back to the non-interactive backdrop, breaking
    // the focus trap.
    $effect(() => {
        untrack(() => void runSearch());
        // #22: clear pending debounce timer on unmount to prevent stale state updates
        return () => {
            if (searchTimer) clearTimeout(searchTimer);
        };
    });

    // #24: select a result and clear any stale conflict banner at the same time
    function selectResult(result: ProviderSearchResult): void {
        if (isConfirming || isMerging) return;
        selectedResult = result;
        conflict = null;
        filesGeneration++;
    }

    function onSearchInput(): void {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => void runSearch(), 300);
    }

    // #23: keyboard navigation handler for the search input
    function onSearchKeydown(e: KeyboardEvent): void {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (searchTimer) {
                clearTimeout(searchTimer);
                searchTimer = null;
            }
            void runSearch();
            return;
        }
        if (results.length === 0) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            focusedIndex = focusedIndex < results.length - 1 ? focusedIndex + 1 : 0;
            selectResult(results[focusedIndex]);
            focusResultButton(focusedIndex);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            focusedIndex = focusedIndex > 0 ? focusedIndex - 1 : results.length - 1;
            selectResult(results[focusedIndex]);
            focusResultButton(focusedIndex);
        }
    }

    // Keyboard navigation on the results list itself (when focus is inside the list)
    function onResultListKeydown(e: KeyboardEvent): void {
        if (results.length === 0) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            focusedIndex = Math.min(focusedIndex + 1, results.length - 1);
            selectResult(results[focusedIndex]);
            focusResultButton(focusedIndex);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            focusedIndex = Math.max(focusedIndex - 1, 0);
            selectResult(results[focusedIndex]);
            focusResultButton(focusedIndex);
        } else if (e.key === 'Enter' && focusedIndex >= 0) {
            e.preventDefault();
            selectResult(results[focusedIndex]);
            void confirmIdentify();
        }
    }

    function focusResultButton(index: number): void {
        const buttons = document.querySelectorAll<HTMLElement>('[data-identify-result]');
        buttons[index]?.focus();
    }

    let searchGen = 0;

    async function runSearch(): Promise<void> {
        if (isConfirming || isMerging) return;
        // A slower earlier search must not replace the current results and
        // pre-select its first hit.
        const gen = ++searchGen;
        if (searchQuery.trim().length < 2) {
            results = [];
            focusedIndex = -1;
            broadenedFrom = false;
            return;
        }
        isSearching = true;
        selectedResult = null;
        focusedIndex = -1;
        broadenedFrom = false;
        try {
            const { data, error } = await searchProvider({
                q: searchQuery,
                mediaType,
            });
            if (gen !== searchGen) return;
            if (error) {
                toasts.error(m.media_plain_search_failed());
                return;
            }
            let searchResults = data?.results ?? [];
            // A too-literal type filter (e.g. "Movie") can hide a result that's
            // actually filed under a different type. If the narrowed search came
            // back empty, retry once against "Any" rather than dead-ending.
            if (searchResults.length === 0 && mediaType !== 'any') {
                const narrowedType = mediaType;
                const { data: broadData, error: broadError } = await searchProvider({
                    q: searchQuery,
                    mediaType: 'any',
                });
                if (gen !== searchGen) return;
                if (!broadError && (broadData?.results.length ?? 0) > 0) {
                    mediaType = 'any';
                    searchResults = broadData!.results;
                    broadenedFrom = narrowedType;
                }
            }
            results = searchResults;
            if (results.length > 0) {
                focusedIndex = 0;
                selectResult(results[0]);
                setTimeout(() => focusResultButton(0), 0);
            }
        } catch (e) {
            if (gen === searchGen) toasts.error(getErrorMessage(e, 'Search failed'));
        } finally {
            if (gen === searchGen) isSearching = false;
        }
    }

    async function confirmIdentify(): Promise<void> {
        // Snapshot the pick: typing in the search box while the request runs
        // clears selectedResult. The guard also covers Enter in the result
        // list, which skips the disabled Confirm button.
        const picked = selectedResult;
        if (!picked || isConfirming || isMerging) return;
        isConfirming = true;
        conflict = null;
        let identified = false;
        try {
            const result = await matchUnmatchedFileDetailed(item.id, {
                provider: picked.provider,
                externalId: picked.externalId,
                type: picked.type,
            });
            if (!result.ok) {
                const fileMediaId = result.fileMediaId ?? item.id;
                if (
                    result.status === 409 &&
                    result.conflictMediaId &&
                    result.conflictMediaId !== fileMediaId
                ) {
                    // The chosen id is already owned by a DIFFERENT row — offer to
                    // merge this file into it rather than dead-ending.
                    conflict = {
                        conflictMediaId: result.conflictMediaId,
                        fileMediaId,
                    };
                    conflictTarget = { id: result.conflictMediaId, title: picked.title };
                    await refreshConflictFiles();
                } else {
                    const error = result.error ?? 'Identify failed';
                    if (mergedIdentityError)
                        mergedIdentityError = { ...mergedIdentityError, error };
                    toasts.error(error);
                }
                return;
            }
            identified = true;
            toasts.success(`Identified as "${picked.title}" — syncing metadata...`, 8000);
        } catch (e) {
            const error = getErrorMessage(e, 'Identify failed');
            if (mergedIdentityError) mergedIdentityError = { ...mergedIdentityError, error };
            toasts.error(error);
        } finally {
            isConfirming = false;
        }
        // After the bookkeeping: a throwing callback is not a failed identify.
        if (identified) onidentified(item.id);
    }

    async function refreshConflictFiles(): Promise<boolean> {
        const current = conflict;
        if (!current) return false;
        const generation = ++filesGeneration;
        filesLoading = true;
        filesError = false;
        try {
            const source = await getRepairMediaFiles(current.fileMediaId);
            const target = await getRepairMediaFiles(current.conflictMediaId);
            if (generation !== filesGeneration || conflict !== current) return false;
            if (!source.data || !target.data) {
                filesError = true;
                return false;
            }
            sourceFiles = [...new Map(source.data.files.map((f) => [f.id, f])).values()];
            targetFiles = [...new Map(target.data.files.map((f) => [f.id, f])).values()];
            return true;
        } catch {
            if (generation === filesGeneration) filesError = true;
            return false;
        } finally {
            if (generation === filesGeneration) filesLoading = false;
        }
    }

    async function mergeIntoExisting(): Promise<void> {
        if (!conflict || !selectedResult || isMerging || isConfirming) return;
        const picked = selectedResult;
        isMerging = true;
        try {
            // Always re-read: a saved link edit or another operator may have changed
            // ownership. The backend still enforces the file/scan concurrency guard.
            if (!(await refreshConflictFiles()) || !conflict) return;
            // Keep the selected series identity: the root merger intentionally retains
            // the keeper's provider values on collisions. Move its files first.
            if (
                (!sourceFiles.length && !targetFiles.length) ||
                (sourceFiles.length && (_isSeries(item.mediaType) || targetFiles.length))
            )
                return;
            const keepId = sourceFiles.length ? conflict.fileMediaId : conflict.conflictMediaId;
            const mergeId = sourceFiles.length ? conflict.conflictMediaId : conflict.fileMediaId;
            const { data, error } = await mergeMediaItems(keepId, mergeId);
            if (error || !data) {
                toasts.error(error ?? m.admin_fixmatch_merge_failed());
                return;
            }
            conflict = null;
            if (keepId === item.id) {
                // The file-bearing movie survives the guard. Its old provider ID
                // wins the merge, so explicitly apply the operator's selected ID.
                // A failed second step leaves Confirm available on this survivor.
                try {
                    const match = await matchUnmatchedFileDetailed(keepId, {
                        provider: picked.provider,
                        externalId: picked.externalId,
                        type: picked.type,
                    });
                    if (!match.ok) throw new Error(match.error ?? m.admin_fixmatch_merge_failed());
                } catch (e) {
                    selectedResult = picked;
                    mergedIdentityError = {
                        items: data.itemsDeleted,
                        seasons: data.seasonsReparented,
                        error: getErrorMessage(e, m.admin_fixmatch_merge_failed()),
                    };
                    toasts.error(m.admin_fixmatch_merged_identity_failed(mergedIdentityError));
                    return;
                }
            }
            toasts.success(
                m.admin_fixmatch_merged({
                    items: data.itemsDeleted,
                    seasons: data.seasonsReparented,
                }),
                8000,
            );
            conflict = null;
            onidentified(data.keepId);
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_fixmatch_merge_failed()));
        } finally {
            isMerging = false;
        }
    }
</script>

<div
    class="fixed inset-0 flex items-center justify-center bg-black/60"
    style="z-index: {Z.MODAL}"
    role="dialog"
    aria-modal={!editorFileId}
    aria-hidden={editorFileId ? 'true' : undefined}
    inert={!!editorFileId}
    class:hidden={!!editorFileId}
    aria-label="Identify media"
    tabindex="-1"
    onclick={(e) => {
        if (e.target === e.currentTarget && !editorFileId && !isMerging && !isConfirming) onclose();
    }}
    onkeydown={(e) => {
        if (e.key === 'Escape' && !editorFileId && !isMerging && !isConfirming) onclose();
    }}>
    <div
        use:trapFocus
        class="bg-surface-900 border border-surface-700 rounded-lg w-full max-w-lg p-6 m-4 shadow-xl max-h-[90vh] overflow-y-auto overscroll-contain">
        <div class="mb-4">
            <h3 class="text-lg font-semibold text-white">
                Identify: {item.title}
            </h3>
            <p class="text-sm text-surface-400 mt-0.5">
                Search across metadata providers to match this item.
            </p>
            <p class="mt-2 text-sm text-surface-300">{m.music_identify_local_help()}</p>
            <p class="mt-2 break-words text-xs text-surface-400">
                {m.music_identify_current_type({
                    type: item.mediaType,
                    seasons: item.seasonCount ?? 0,
                    episodes: item.episodeCount ?? 0,
                })}
            </p>
            <p class="text-xs text-surface-500 mt-1 font-mono truncate" title={item.title}>
                {item.title}{item.releaseYear ? ` (${item.releaseYear})` : ''}
                <span class="not-italic text-surface-600 ml-1 font-sans capitalize"
                    >{item.mediaType}</span>
            </p>
            <!-- Disambiguation context (BUG: modal lacked enough info to tell
                 two same-year candidates apart without leaving it). -->
            {#if item.filePath || hasChildCounts}
                <div
                    class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-surface-500">
                    {#if item.filePath}
                        <span class="font-mono truncate max-w-full" title={item.filePath}>
                            <span class="text-surface-600"
                                >{m.admin_fixmatch_context_file_label()}:</span>
                            {truncateMiddle(item.filePath)}
                        </span>
                    {/if}
                    {#if hasChildCounts}
                        <span>
                            {m.admin_library_season_count({ count: item.seasonCount ?? 0 })} ·
                            {m.admin_library_episode_count({ count: item.episodeCount ?? 0 })}
                        </span>
                    {/if}
                </div>
            {/if}
        </div>

        <!-- Search bar + type filter -->
        <div class="flex gap-2 mb-3">
            <input
                type="search"
                disabled={isConfirming || isMerging}
                class="input flex-1"
                placeholder={m.admin_fixmatch_search_placeholder()}
                aria-label={m.admin_fixmatch_search_placeholder()}
                bind:value={searchQuery}
                oninput={onSearchInput}
                onkeydown={onSearchKeydown} />
            <select
                class="input w-28"
                disabled={isConfirming || isMerging}
                bind:value={mediaType}
                onchange={() => void runSearch()}>
                <option value="any">Any</option>
                <option value="movie">Movie</option>
                <option value="series">Series</option>
            </select>
        </div>

        <!-- Results -->
        {#if isSearching}
            <p class="text-sm text-surface-400 py-4 text-center">Searching providers...</p>
        {:else if results.length === 0 && searchQuery.trim().length >= 2}
            <div class="py-4 text-center">
                <p class="text-sm text-surface-400">No results found.</p>
                <p class="text-xs text-surface-500 mt-1">{m.admin_fixmatch_search_hint_title()}</p>
                <p class="text-xs text-surface-500 mt-1">{m.admin_fixmatch_search_hint_id()}</p>
            </div>
        {:else if results.length > 0}
            {#if broadenedFrom}
                <p class="text-xs text-amber-300/80 mb-2">
                    {m.admin_fixmatch_search_broadened_note({
                        type:
                            broadenedFrom === 'movie'
                                ? m.route_admin_library_filter_movies()
                                : m.route_admin_library_filter_series(),
                    })}
                </p>
            {/if}
            <ul class="space-y-1 max-h-96 overflow-y-auto mb-4">
                {#each results as result, i (`${result.provider}:${result.externalId}:${result.type}`)}
                    <li>
                        <button
                            disabled={isConfirming || isMerging}
                            data-identify-result
                            class="w-full text-left px-3 py-2 rounded text-sm transition-colors
                                {selectedResult?.provider === result.provider &&
                            selectedResult?.externalId === result.externalId &&
                            selectedResult?.type === result.type
                                ? 'bg-blue-600 text-white'
                                : focusedIndex === i
                                  ? 'bg-surface-600 text-white'
                                  : 'text-surface-300 hover:bg-surface-700'}"
                            onclick={() => {
                                focusedIndex = i;
                                selectResult(result);
                            }}
                            onkeydown={(e) => {
                                focusedIndex = i;
                                onResultListKeydown(e);
                            }}>
                            <div class="flex gap-3">
                                {#if result.images?.poster}
                                    <img
                                        src={result.images.poster}
                                        alt=""
                                        class="w-10 h-[60px] object-cover rounded shrink-0"
                                        loading="lazy" />
                                {:else}
                                    <div
                                        class="w-10 h-[60px] bg-surface-700 rounded shrink-0 flex items-center justify-center text-surface-500 text-xs">
                                        ?
                                    </div>
                                {/if}
                                <div class="flex-1 min-w-0">
                                    <div class="flex items-baseline gap-2">
                                        <span class="font-medium truncate">{result.title}</span>
                                        {#if result.year}
                                            <span class="text-xs opacity-70 shrink-0"
                                                >({result.year})</span>
                                        {/if}
                                        <span class="ml-auto text-xs opacity-60 uppercase shrink-0">
                                            {result.provider} · {result.type}
                                        </span>
                                    </div>
                                    {#if result.overview}
                                        <p class="text-xs opacity-60 mt-0.5 line-clamp-2">
                                            {result.overview}
                                        </p>
                                    {/if}
                                </div>
                            </div>
                        </button>
                    </li>
                {/each}
            </ul>
        {/if}

        {#if conflict}
            <div
                class="mt-4 rounded-lg border border-amber-700/50 bg-amber-950/30 p-3 text-sm text-amber-100">
                <p class="font-medium">Already linked to another entry</p>
                <p class="mt-1 text-xs text-amber-200/80">{m.admin_fixmatch_merge_scope()}</p>
                {#if filesLoading}
                    <p>{m.file_episodes_searching()}</p>
                {:else if filesError}
                    <p>{m.file_episodes_load_failed()}</p>
                    <button class="btn btn-sm" onclick={refreshConflictFiles}
                        >{m.file_episodes_retry_load()}</button>
                {:else}
                    <p class="mt-2">
                        {m.admin_fixmatch_file_counts({
                            source: sourceFiles.length,
                            target: targetFiles.length,
                        })}
                    </p>
                    {#if !sourceFiles.length && !targetFiles.length}
                        <p class="mt-2">{m.admin_fixmatch_no_files()}</p>
                    {:else if sourceFiles.length && _isSeries(item.mediaType)}
                        <p class="mt-2">{m.admin_fixmatch_move_source_first()}</p>
                    {:else if sourceFiles.length && targetFiles.length}
                        <p class="mt-2">{m.admin_fixmatch_review_files()}</p>
                    {/if}
                    {#if _isSeries(item.mediaType)}
                        {#each sourceFiles as file (file.id)}
                            <div class="mt-2">
                                <p class="text-xs break-all">{file.file_path}</p>
                                <button
                                    class="btn btn-sm"
                                    onclick={() => {
                                        editorFileId = file.id;
                                    }}>{m.admin_fixmatch_repair_file()}</button>
                            </div>
                        {/each}
                    {/if}
                {/if}
                <div class="mt-2 flex justify-end">
                    <button
                        class="btn btn-amber"
                        disabled={isMerging ||
                            isConfirming ||
                            (!sourceFiles.length && !targetFiles.length) ||
                            filesLoading ||
                            filesError ||
                            !!(
                                sourceFiles.length &&
                                (_isSeries(item.mediaType) || targetFiles.length)
                            )}
                        onclick={mergeIntoExisting}>
                        {isMerging ? m.admin_fixmatch_merging() : m.admin_fixmatch_merge()}
                    </button>
                </div>
            </div>
        {/if}

        {#if mergedIdentityError}
            <p
                role="alert"
                class="mt-4 rounded-lg border border-amber-700/50 bg-amber-950/30 p-3 text-sm text-amber-100">
                {m.admin_fixmatch_merged_identity_failed(mergedIdentityError)}
            </p>
        {/if}
        <div class="flex gap-2 justify-end mt-4">
            <button
                class="btn btn-ghost"
                bind:this={cancelButton}
                disabled={isMerging || isConfirming}
                onclick={onclose}>Cancel</button>
            <button
                class="btn btn-blue"
                disabled={!selectedResult || isConfirming || isMerging}
                onclick={confirmIdentify}>
                {isConfirming ? 'Identifying...' : 'Confirm'}
            </button>
        </div>
    </div>
</div>

{#if editorFileId && conflict && conflictTarget}
    <FileEpisodesEditor
        mediaId={conflict.fileMediaId}
        fileId={editorFileId}
        initialTargetSeries={conflictTarget}
        onClose={async () => {
            editorFileId = null;
            void refreshConflictFiles();
            await tick();
            // Saving may remove the repair trigger; Cancel always survives.
            cancelButton?.focus();
        }}
        onChanged={() => void refreshConflictFiles()} />
{/if}
