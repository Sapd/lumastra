<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  The list the "N media files have health problems" badge lands on.

  Lists `media_files` rows, NOT `media_items`, and that is the entire reason this
  panel exists. The badge's count is `countFilesWithHealthIssues` — a COUNT over
  `media_files` — while the admin media browser lists items, so a link into the
  browser could never agree with the number that sent the operator there:

  - an `extra` (trailer/featurette) is excluded from `ALL_BROWSABLE_TYPES`, so no
    `?type=` value lists it. Observed on preprod: badge 2, list 0.
  - a file linked to no item at all is unlistable by anything over `media_items`.
  - a multi-episode file is one file but N item rows.

  This panel reads the same rows the count is taken from
  (`GET /api/admin/media/file-health`), so the two agree by construction. The
  `media_item_id` is nullable on purpose — an unlinked file is shown as such
  rather than dropped, since a `truncated_video` on a file the scanner never
  linked is exactly the failure an operator most needs to see.
-->
<script lang="ts">
    import RangeMappingDiagnosis from '../media/RangeMappingDiagnosis.svelte';
    import AudioTailDiagnosis from '../media/AudioTailDiagnosis.svelte';
    import FileHealthReviewModal from '../media/FileHealthReviewModal.svelte';
    import { onDestroy, untrack } from 'svelte';
    import { browser } from '$app/environment';
    import FileEpisodesEditor from '../media/FileEpisodesEditor.svelte';
    import { startVisibleRefresh } from '../media/visible-refresh.js';
    import { resolve } from '$lib/paths';
    import * as adminApi from '$lib/api/admin';
    import type { FileHealthRow } from '$lib/api/admin';
    import { getMediaTypeLabel } from '$lib/components/admin/media/media-type-badge';
    import {
        fileHealthIssueLabel,
        fileHealthIssueGuidance,
        fileHealthRecheckMessage,
        fileHealthIssueTextClass,
        fileHealthIssueReason,
        isSevereHealthIssue,
    } from '$lib/utils/file-health-issue';
    import * as m from '$lib/paraglide/messages.js';

    let {
        onrecheck,
        refreshKey,
    }: {
        onrecheck?: () => void | Promise<void>;
        refreshKey?: number | null;
    } = $props();
    let repairFile = $state<FileHealthRow | null>(null);
    let reviewFileId = $state<string | null>(null);
    let refreshedAt = $state<string | null>(null);
    let snapshotAt = $state<string | null>(null);
    let loadController: AbortController | undefined;
    interface ResultRow {
        fileId: string;
        name: string;
        message: string;
        runId?: string;
    }
    let results = $state<ResultRow[]>([]);
    let pending = $state<Record<string, { controller: AbortController; runId?: string }>>({});
    let destroyed = false;
    let loadToken = 0;
    let files = $state<FileHealthRow[]>([]);
    let total = $state(0);
    let recorded = $state(0);
    let actionable = $state(0);
    let informational = $state(0);
    let reviewed = $state(0);
    let matching = $state(0);
    let nextCursor = $state<string | null>(null);
    let currentCursor = $state<string | null>(null);
    let previousCursors = $state<Array<string | null>>([]);
    let scope = $state<'actionable' | 'informational' | 'reviewed' | 'all'>('actionable');
    let loading = $state(true);
    let loadError = $state<string | null>(null);

    let shownStart = $derived(previousCursors.length * 50 + (files.length ? 1 : 0));

    /** Just the filename; the library path prefix is noise in a flat list. */
    function baseName(path: string): string {
        const parts = path.split('/');
        return parts[parts.length - 1] || path;
    }

    /** The directory the file sits in, shown small under the filename. */
    function dirName(path: string): string {
        const idx = path.lastIndexOf('/');
        return idx > 0 ? path.slice(0, idx) : '';
    }

    function anySevere(file: FileHealthRow): boolean {
        return file.health_issues.some((i) => isSevereHealthIssue(i.type, i.basis));
    }

    async function load(): Promise<void> {
        const token = ++loadToken;
        loadController?.abort();
        const controller = new AbortController();
        loadController = controller;
        let data: Awaited<ReturnType<typeof adminApi.getFileHealth>>['data'] | undefined =
            undefined;
        let error: string | null | undefined;
        try {
            const response = await adminApi.getFileHealth(controller.signal, {
                scope,
                cursor: currentCursor ?? undefined,
            });
            data = response.data;
            error = response.error;
        } catch {
            error = m.admin_health_files_load_error();
        }
        if (destroyed || token !== loadToken) return;
        if (error || !data) {
            loadError = error ?? m.admin_health_files_load_error();
        } else {
            files = data.files;
            total = data.count;
            recorded = data.recorded ?? data.count;
            actionable = data.actionable ?? data.count;
            informational = data.informational ?? 0;
            reviewed = data.reviewed ?? 0;
            matching = data.matching ?? data.count;
            nextCursor = data.nextCursor ?? null;
            loadError = null;
            refreshedAt = new Date().toLocaleTimeString();
            snapshotAt = data.snapshotAt ?? null;
        }
        loading = false;
    }

    function changeScope(next: 'actionable' | 'informational' | 'reviewed' | 'all'): void {
        if (scope === next) return;
        scope = next;
        currentCursor = null;
        previousCursors = [];
        loading = true;
        void load();
    }

    function nextPage(): void {
        if (!nextCursor) return;
        previousCursors = [...previousCursors, currentCursor];
        currentCursor = nextCursor;
        loading = true;
        void load();
    }

    function previousPage(): void {
        if (!previousCursors.length) return;
        currentCursor = previousCursors.at(-1) ?? null;
        previousCursors = previousCursors.slice(0, -1);
        loading = true;
        void load();
    }

    async function recheck(file: FileHealthRow): Promise<void> {
        if (pending[file.file_id]) return;
        const controller = new AbortController();
        pending[file.file_id] = { controller };
        const row: ResultRow = {
            fileId: file.file_id,
            name: baseName(file.file_path),
            message: m.admin_health_rechecking(),
        };
        results = [row, ...results.filter((r) => r.fileId !== file.file_id)];
        try {
            const { data, error } = await adminApi.recheckFileHealth(
                file.file_id,
                controller.signal,
                (runId) => {
                    if (destroyed) return;
                    pending[file.file_id].runId = runId;
                    results = results.map((r) => (r.fileId === file.file_id ? { ...r, runId } : r));
                },
            );
            if (destroyed) return;
            results = results.map((r) =>
                r.fileId === file.file_id
                    ? {
                          ...r,
                          message:
                              error ??
                              (data
                                  ? fileHealthRecheckMessage(data)
                                  : m.admin_health_recheck_error()),
                      }
                    : r,
            );
        } catch {
            if (!destroyed)
                results = results.map((r) =>
                    r.fileId === file.file_id
                        ? { ...r, message: m.admin_health_recheck_error() }
                        : r,
                );
        } finally {
            if (!destroyed) {
                delete pending[file.file_id];
                currentCursor = null;
                previousCursors = [];
                await load();
                await onrecheck?.();
            }
        }
    }

    async function cancel(fileId: string): Promise<void> {
        const attempt = pending[fileId];
        const runId = attempt?.runId;
        if (!runId) return;
        const { data, error } = await adminApi.cancelRun(runId);
        if (!destroyed && pending[fileId] === attempt && (error || !data?.accepted)) {
            results = results.map((r) =>
                r.fileId === fileId ? { ...r, message: m.admin_health_recheck_cancel_error() } : r,
            );
        }
        // Acceptance is not cancellation completion. Keep polling until the
        // worker is terminal; cancellation rolls its changes back first.
    }

    $effect(() => {
        void refreshKey;
        untrack(() => void load());
    });
    $effect(() => {
        if (!browser) return;
        return startVisibleRefresh(load);
    });
    onDestroy(() => {
        destroyed = true;
        loadToken++;
        loadController?.abort();
        for (const request of Object.values(pending)) request.controller.abort();
    });
</script>

{#if repairFile}
    <p class="mb-3 text-xs text-surface-400">{m.admin_health_auto_recheck()}</p>

    <FileEpisodesEditor
        fileId={repairFile.file_id}
        mediaId={repairFile.media_item_id ?? undefined}
        selectSeries={!repairFile.media_item_id}
        onClose={() => (repairFile = null)}
        onChanged={() => {
            repairFile = null;
            void load();
            void onrecheck?.();
        }} />
{/if}
{#if reviewFileId}
    <FileHealthReviewModal
        fileId={reviewFileId}
        onclose={() => (reviewFileId = null)}
        onchanged={async () => {
            currentCursor = null;
            previousCursors = [];
            await load();
            await onrecheck?.();
        }} />
{/if}
{#if refreshedAt}<p class="mb-2 text-xs text-surface-400">
        {m.media_source_refreshed({ time: refreshedAt })}
        {#if snapshotAt}
            · {m.admin_health_file_snapshot({
                time: new Date(snapshotAt).toLocaleTimeString(),
            })}{/if}
    </p>{/if}
{#if loadError && files.length > 0}<p class="mb-2 text-xs text-amber-300">
        {m.media_source_stale()}
    </p>{/if}
{#if results.length > 0}
    <div class="mb-3 space-y-2" role="status" aria-live="polite">
        {#each results as result (result.fileId)}
            <div class="rounded border border-surface-700/40 p-3 text-xs text-surface-300">
                <p class="font-mono break-all">{result.name}</p>
                <p>{result.message}</p>
                {#if result.runId}
                    <a
                        class="text-sky-400 underline"
                        href="{resolve('/admin/tasks/runs')}?run={encodeURIComponent(result.runId)}"
                        >{m.admin_health_recheck_run()}</a>
                {/if}
            </div>
        {/each}
    </div>
{/if}
<div
    class="mb-3 flex flex-wrap items-center gap-2 text-xs"
    aria-label={m.admin_health_file_view_label()}>
    <button
        type="button"
        class="btn btn-sm {scope === 'actionable'
            ? 'variant-filled-primary'
            : 'variant-ghost-surface'}"
        aria-pressed={scope === 'actionable'}
        onclick={() => changeScope('actionable')}>
        {m.admin_health_file_actionable({ count: actionable })}
    </button>
    <button
        type="button"
        class="btn btn-sm {scope === 'informational'
            ? 'variant-filled-primary'
            : 'variant-ghost-surface'}"
        aria-pressed={scope === 'informational'}
        onclick={() => changeScope('informational')}>
        {m.admin_health_file_informational({ count: informational })}
    </button>
    <button
        type="button"
        class="btn btn-sm {scope === 'reviewed'
            ? 'variant-filled-primary'
            : 'variant-ghost-surface'}"
        aria-pressed={scope === 'reviewed'}
        onclick={() => changeScope('reviewed')}>
        {m.admin_health_review_scope({ count: reviewed })}
    </button>
    <button
        type="button"
        class="btn btn-sm {scope === 'all' ? 'variant-filled-primary' : 'variant-ghost-surface'}"
        aria-pressed={scope === 'all'}
        onclick={() => changeScope('all')}>
        {m.admin_health_file_recorded({ count: recorded })}
    </button>
</div>
<p class="mb-2 text-xs text-surface-400">{m.admin_health_file_scope_note()}</p>
{#if loading}
    <p class="text-xs text-surface-500">{m.admin_health_files_loading()}</p>
{:else}
    {#if loadError}<p class="text-xs text-amber-300" role="status">{loadError}</p>{/if}
    {#if results.length > 0 && !loadError}<p class="mb-2 text-xs text-surface-400">
            {m.admin_health_recheck_count({ count: total })}
        </p>{/if}
    {#if files.length > 0}
        <div class="space-y-2">
            <div class="flex items-baseline justify-between gap-3">
                <h3 class="text-xs font-semibold uppercase tracking-wide text-surface-400">
                    {m.admin_health_files_list_heading()}
                </h3>
                <span class="text-xs text-surface-500">
                    {m.admin_health_file_page_range({
                        start: shownStart,
                        end: shownStart + files.length - 1,
                        total: matching,
                    })}
                </span>
            </div>

            {#each files as file (file.file_id)}
                <div
                    class="card-bordered p-3 border-l-2 {anySevere(file)
                        ? 'border-l-red-700/60'
                        : 'border-l-amber-700/60'}">
                    {#if file.media_type === 'episode' || file.health_issues.some( (issue) => ['episode_number_unparsed', 'series_identity_conflict', 'range_superseded'].includes(issue.type) )}
                        <button
                            class="btn btn-sm variant-ghost-primary mb-2"
                            onclick={() => (repairFile = file)}
                            >{m.media_source_repair_mapping()}</button>
                    {/if}
                    <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <div class="min-w-0">
                            <p class="font-mono text-xs text-surface-200 break-all">
                                {baseName(file.file_path)}
                            </p>
                            {#if dirName(file.file_path)}
                                <p class="font-mono text-[0.65rem] text-surface-500 break-all">
                                    {dirName(file.file_path)}
                                </p>
                            {/if}
                        </div>
                        {#if file.media_item_id}
                            <!-- Name the type as well as the title: an `extra` reads
                             "trailer", which is meaningless without "Extra" and
                             the film it hangs off. -->
                            <a
                                href={resolve(`/admin/library/media/${file.media_item_id}`)}
                                class="shrink-0 text-xs font-medium text-sky-400 hover:text-sky-300">
                                {#if file.media_type}<span class="text-surface-500"
                                        >{getMediaTypeLabel(file.media_type)} ·
                                    </span>{/if}{file.title ?? m.admin_health_files_open_item()}
                            </a>
                        {:else}
                            <!-- Counted by the badge, listable by nothing else in the
                             admin: the Ingest Map's scan-issues view only covers
                             the three tag-parse types. -->
                            <span class="shrink-0 text-xs text-surface-500"
                                >{m.admin_health_files_unlinked()}</span>
                        {/if}
                    </div>

                    {#if file.is_missing}
                        <p class="mt-2 text-xs text-amber-300">
                            {m.admin_health_file_recorded_missing()}
                        </p>
                    {/if}
                    {#if file.link_count > 1}
                        <p class="mt-2 text-xs text-surface-400">
                            {m.admin_health_file_shared({ count: file.link_count })}
                        </p>
                    {/if}
                    <div class="mt-2 flex items-center gap-2">
                        <button
                            type="button"
                            class="btn btn-sm variant-ghost-primary"
                            disabled={!!pending[file.file_id]}
                            aria-busy={!!pending[file.file_id]}
                            onclick={() => void recheck(file)}>
                            {pending[file.file_id]
                                ? m.admin_health_rechecking()
                                : m.admin_health_recheck()}
                        </button>
                        {#if file.health_issues.some( (issue) => ['duration_mismatch', 'video_ends_early', 'truncated_video'].includes(issue.type) )}
                            <button
                                type="button"
                                class="btn btn-sm variant-ghost-primary"
                                onclick={() => (reviewFileId = file.file_id)}>
                                {m.admin_health_review_button()}
                            </button>
                        {/if}
                        {#if pending[file.file_id]?.runId}
                            <button
                                type="button"
                                class="btn btn-sm variant-ghost-surface"
                                onclick={() => void cancel(file.file_id)}
                                >{m.common_cancel()}</button>
                        {/if}
                    </div>
                    <div class="mt-1 space-y-0.5">
                        {#each file.health_issues as issue, issueIdx (issue.type + '__' + issueIdx)}
                            {@const reason = fileHealthIssueReason(issue)}
                            {@const guidance = fileHealthIssueGuidance(issue)}
                            <div class="flex items-start gap-1.5 text-xs">
                                <span
                                    class="shrink-0 font-medium {file.classification ===
                                        'informational' || file.classification === 'reviewed'
                                        ? 'text-sky-300'
                                        : fileHealthIssueTextClass(issue.type, issue.basis)}"
                                    >{fileHealthIssueLabel(issue.type, issue.basis)}</span>
                                {#if issue.reviewed === true}<span class="text-sky-300"
                                        >{m.admin_health_review_classification()}</span
                                    >{/if}
                                {#if reason}
                                    <span class="min-w-0 text-surface-300">{reason}</span>
                                {/if}
                            </div>
                            {#if guidance}
                                <p class="ml-2 text-xs text-surface-400">{guidance}</p>
                            {/if}
                        {/each}
                        <AudioTailDiagnosis assessment={file.tailAssessment} />
                        <RangeMappingDiagnosis mapping={file.rangeMapping} />
                    </div>
                </div>
            {/each}
        </div>
    {:else if !loadError}
        <p class="text-xs text-surface-500">{m.admin_health_file_empty()}</p>
    {/if}
    <div class="mt-3 flex items-center gap-2 text-xs">
        {#if previousCursors.length > 0}<button
                type="button"
                class="btn btn-sm variant-ghost-surface"
                onclick={previousPage}>{m.admin_health_file_previous()}</button
            >{/if}
        {#if nextCursor}<button
                type="button"
                class="btn btn-sm variant-ghost-primary"
                onclick={nextPage}>{m.admin_health_file_next()}</button
            >{/if}
        {#if previousCursors.length > 0 || nextCursor}<span class="text-surface-500"
                >{m.admin_health_file_pages_change()}</span
            >{/if}
    </div>
{/if}
