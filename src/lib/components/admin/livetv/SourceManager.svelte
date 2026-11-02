<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { redactLiveTvUrlsInText } from '$lib/shared/livetv-url-redaction.js';
    import * as m from '$lib/paraglide/messages.js';
    import {
        getLiveTvSources,
        deleteLiveTvSource,
        triggerLiveTvImport,
        triggerRefresh,
        updateLiveTvSource,
        importLiveTvLayout,
    } from '$lib/api/livetv';
    import type { LiveTvSourceWithCount, ChannelLayout } from '$lib/schemas/livetv';
    import { toasts } from '$lib/stores/toast.store';
    import { runSSEBus, type Run, type RunState } from '$lib/stores/run-sse-bus';
    import {
        Icon,
        Plus,
        ArrowPath,
        Tv,
        PencilSquare,
        Trash,
        ArrowDownTray,
        ArrowUpTray,
        Cog6Tooth,
    } from 'svelte-hero-icons';
    import SourceForm from './SourceForm.svelte';
    import ImportGuidedSetup from './ImportGuidedSetup.svelte';

    let sources = $state<LiveTvSourceWithCount[]>([]);
    let loading = $state(true);
    let showForm = $state(false);
    let editingSource = $state<LiveTvSourceWithCount | undefined>(undefined);
    let importingSourceId = $state<string | null>(null);
    let refreshingSourceId = $state<string | null>(null);
    let deletingSourceId = $state<string | null>(null);
    let layoutImporting = $state(false);
    let showSetup = $state(false);
    let setupIsReconfigure = $state(false);
    let setupSourceId = $state<string | null>(null);

    // Live import progress (new source, or the Import button). `importTracking`
    // holds the source + the import-m3u runId; `importProgress` mirrors the
    // latest stage from the SSE bus. The M3U run starts the EPG import as a
    // child run once the channels exist, and the bar follows that run too, so a
    // long guide match on a large source shows progress instead of looking stuck.
    let importTracking = $state<{
        sourceId: string;
        runId: string;
        openSetupWhenDone: boolean;
    } | null>(null);
    let importProgress = $state<{
        processed?: number;
        total?: number;
        message?: string;
        state: RunState;
    } | null>(null);

    const REFRESH_CRON_OPTIONS = [
        { label: () => m.livetv_admin_refresh_never(), value: null },
        {
            label: () => m.livetv_admin_refresh_every_6h(),
            value: '0 */6 * * *',
        },
        {
            label: () => m.livetv_admin_refresh_every_12h(),
            value: '0 */12 * * *',
        },
        { label: () => m.livetv_admin_refresh_daily(), value: '0 3 * * *' },
        { label: () => m.livetv_admin_refresh_weekly(), value: '0 3 * * 0' },
    ] as const;

    const isEmpty = $derived(sources.length === 0 && !loading);

    async function loadSources(opts?: { silent?: boolean }): Promise<void> {
        // `silent` skips the loading skeleton — used by the import-progress poller
        // so the list doesn't flash on every background refresh.
        if (!opts?.silent) loading = true;
        try {
            const result = await getLiveTvSources();
            if (result.data) {
                sources = result.data.sources;
            } else if (result.error) {
                showError(m.livetv_admin_load_failed());
            }
        } catch {
            showError(m.livetv_admin_load_failed());
        } finally {
            if (!opts?.silent) loading = false;
        }
    }

    async function handleDelete(sourceId: string, sourceName: string): Promise<void> {
        if (!confirm(m.livetv_admin_delete_confirm({ name: sourceName }))) return;
        // Deleting a source cascade-removes all its channels + programs, which can take
        // a few seconds for a large source. Show a spinner so the action visibly reacts.
        deletingSourceId = sourceId;
        try {
            const result = await deleteLiveTvSource(sourceId);
            if (result.data) {
                toasts.success(m.livetv_admin_delete_success());
                // Optimistically drop the row so it disappears immediately, then reconcile.
                sources = sources.filter((s) => s.id !== sourceId);
                await loadSources({ silent: true });
            } else {
                showError(result.error ?? m.livetv_admin_delete_failed());
            }
        } catch {
            showError(m.livetv_admin_delete_failed());
        } finally {
            deletingSourceId = null;
        }
    }

    async function handleImport(sourceId: string): Promise<void> {
        importingSourceId = sourceId;
        try {
            const result = await triggerLiveTvImport(sourceId);
            if (result.data) {
                toasts.success(m.livetv_admin_import_started());
                const runId = result.data.taskIds?.m3u;
                if (runId) {
                    importProgress = { state: 'pending' };
                    importTracking = { sourceId, runId, openSetupWhenDone: false };
                }
            } else {
                showError(result.error ?? m.livetv_admin_import_failed());
            }
        } catch {
            showError(m.livetv_admin_import_failed());
        } finally {
            importingSourceId = null;
        }
    }

    function showError(message: string): void {
        toasts.error(redactLiveTvUrlsInText(message));
    }

    function handleExportLayout(): void {
        // The endpoint returns the JSON with Content-Disposition: attachment, so the
        // browser downloads it (session cookie is sent automatically).
        window.location.href = '/api/admin/livetv/layout/export';
    }

    async function handleImportLayoutFile(e: Event): Promise<void> {
        const input = e.currentTarget as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;
        layoutImporting = true;
        try {
            let layout: ChannelLayout;
            try {
                layout = JSON.parse(await file.text()) as ChannelLayout;
            } catch {
                showError('Invalid layout file — not valid JSON.');
                return;
            }
            const result = await importLiveTvLayout(layout);
            if (result.data) {
                const s = result.data;
                toasts.success(
                    `Layout imported: ${s.matched} matched, ${s.appended} new appended, ${s.notFound} from the file not found.`,
                );
                await loadSources({ silent: true });
            } else {
                showError(result.error ?? 'Layout import failed.');
            }
        } finally {
            layoutImporting = false;
            input.value = ''; // allow re-selecting the same file
        }
    }

    function handleAddSource(): void {
        editingSource = undefined;
        showForm = true;
    }

    function handleEditSource(source: LiveTvSourceWithCount): void {
        editingSource = source;
        showForm = true;
    }

    function handleFormSaved(importInfo?: { sourceId: string; runId: string }): void {
        const wasEditing = editingSource !== undefined;
        showForm = false;
        editingSource = undefined;
        void loadSources();
        // Track create and edit imports; only new sources need the setup wizard.
        if (importInfo) {
            importProgress = { state: 'pending' };
            importTracking = { ...importInfo, openSetupWhenDone: !wasEditing };
        }
    }

    // Mirror the tracked import into `importProgress`: first the import-m3u run,
    // then the import-epg run it starts as its child. SSE drives the bar; the
    // 3 s poll asks the runs API whenever SSE has not shown a terminal state
    // (the bus only learns about finished runs from live frames, so a fast
    // import, or a dropped stream, would otherwise leave the bar hanging).
    // Finishing refreshes the source list (channel count, last refresh). The
    // timeout sits well above import-m3u + import-epg's limits (10 + 20
    // minutes) plus queue wait.
    $effect(() => {
        const tracking = importTracking;
        if (!tracking) return;

        runSSEBus.connect();

        let finished = false;
        // Run currently shown: the M3U run, then the EPG child run.
        let currentRunId = tracking.runId;
        let m3uDoneAt: number | null = null;
        const isTerminal = (run: Run): boolean =>
            run.state === 'completed' || run.state === 'failed' || run.state === 'cancelled';

        const finish = (failure?: { title: string; detail: string }): void => {
            if (finished) return;
            finished = true;
            const sourceId = tracking.sourceId;
            importTracking = null;
            importProgress = null;
            if (failure) {
                showError(failure.detail ? `${failure.title}: ${failure.detail}` : failure.title);
            }
            void loadSources({ silent: true }).then(() => {
                if (!tracking.openSetupWhenDone) return;
                // An import that produced no channels has nothing to arrange;
                // the wizard used to open on "0 channels, 0 categories".
                const src = sources.find((s) => s.id === sourceId);
                if (!src || src.channelCount === 0) return;
                // A freshly-added source just finished importing — open the guided
                // "configure channel list" setup so the user can arrange it. This is the
                // initial run (not a reconfigure), so no discard warning is shown.
                setupIsReconfigure = false;
                setupSourceId = sourceId;
                showSetup = true;
            });
        };

        const waitingForEpg = (): boolean => currentRunId === tracking.runId && m3uDoneAt !== null;

        const findEpgChildOnBus = (): string | undefined => {
            for (const run of runSSEBus.runs.values()) {
                if (run.taskId === 'import-epg' && run.parentRunId === tracking.runId) {
                    return run.id;
                }
            }
            return undefined;
        };

        const adoptEpgChild = (child: string | undefined): void => {
            // A poll response can land after the bar finished or unmounted.
            if (finished) return;
            if (child) {
                currentRunId = child;
                importProgress = { state: 'pending', message: m.livetv_admin_importing() };
                // A small guide can already be done; no later bus event would
                // hand it to handle().
                handle(runSSEBus.runs.get(child));
            } else if (m3uDoneAt !== null && Date.now() - m3uDoneAt > 15_000) {
                // No EPG URL (or the child never showed up): the M3U run was all.
                finish();
            }
        };

        const handle = (run: Run | undefined): void => {
            if (finished || !run || run.id !== currentRunId) return;
            const stage = run.stages.at(-1);
            importProgress = {
                processed: stage?.processed,
                total: stage?.total,
                message: stage?.currentItem,
                state: run.state,
            };
            if (!isTerminal(run)) return;
            if (
                run.taskId === 'import-m3u' &&
                currentRunId === tracking.runId &&
                run.state === 'completed'
            ) {
                // Channels are in; the guide import starts next.
                m3uDoneAt = Date.now();
                importProgress = { state: 'pending', message: m.livetv_admin_importing() };
                void loadSources({ silent: true });
                adoptEpgChild(findEpgChildOnBus());
                return;
            }
            // The channel import failing is the admin's problem to see; a cancel
            // is their own action and needs no toast.
            if (run.state === 'failed') {
                finish({
                    title:
                        run.taskId === 'import-m3u' || run.taskId === 'refresh-m3u'
                            ? m.livetv_admin_channel_import_failed()
                            : m.livetv_admin_guide_import_failed(),
                    detail: run.error?.message ?? '',
                });
                return;
            }
            finish();
        };

        const apply = (): void => {
            if (finished) return;
            if (waitingForEpg()) adoptEpgChild(findEpgChildOnBus());
            else handle(runSSEBus.runs.get(currentRunId));
        };

        const fetchRun = async (id: string): Promise<Run | undefined> => {
            try {
                const res = await fetch(`/api/runs/${encodeURIComponent(id)}`, {
                    credentials: 'same-origin',
                });
                return res.ok ? ((await res.json()) as Run) : undefined;
            } catch {
                return undefined;
            }
        };

        const listRuns = async (query: string): Promise<Run[]> => {
            try {
                const res = await fetch(`/api/runs?${query}`, { credentials: 'same-origin' });
                if (!res.ok) return [];
                const body = (await res.json()) as { items?: Run[] };
                return Array.isArray(body.items) ? body.items : [];
            } catch {
                return [];
            }
        };

        const fetchEpgChild = async (): Promise<string | undefined> => {
            const children = await listRuns(
                `parentRunId=${encodeURIComponent(tracking.runId)}&limit=10`,
            );
            const child = children.find((r) => r.taskId === 'import-epg')?.id;
            if (child || m3uDoneAt === null || Date.now() - m3uDoneAt < 10_000) return child;
            // No child yet: the M3U task's start may have been deduped onto an
            // earlier import-epg that is still running (same idempotency key).
            // Follow that one rather than ending the bar while the guide imports.
            const active = await listRuns('taskId=import-epg&state=pending,active&limit=5');
            return active[0]?.id;
        };

        // Consecutive polls where neither the bus nor the API knows the run.
        let unknownPolls = 0;
        const pollOnce = async (): Promise<void> => {
            if (finished) return;
            if (waitingForEpg()) {
                adoptEpgChild(findEpgChildOnBus() ?? (await fetchEpgChild()));
            } else {
                const live = runSSEBus.runs.get(currentRunId);
                if (live && isTerminal(live)) {
                    handle(live);
                } else {
                    const polledId = currentRunId;
                    const fetched = await fetchRun(polledId);
                    if (finished || polledId !== currentRunId) return;
                    // Only a body that is this run: handle() reads run.stages.
                    const rest =
                        fetched?.id === polledId && Array.isArray(fetched.stages)
                            ? fetched
                            : undefined;
                    if (rest) {
                        unknownPolls = 0;
                        if (isTerminal(rest) || !live) handle(rest);
                    } else if (!live && ++unknownPolls >= 20) {
                        // A minute with no trace of the run: stop showing a bar
                        // that can never complete.
                        finish();
                    }
                }
            }
            if (!finished) void loadSources({ silent: true });
        };

        apply(); // pick up any state already buffered before we subscribed
        const off = runSSEBus.onAnyChange(apply);
        const poll = setInterval(() => void pollOnce(), 3000);
        const timeout = setTimeout(finish, 45 * 60_000);

        return () => {
            finished = true;
            off();
            clearInterval(poll);
            clearTimeout(timeout);
            runSSEBus.disconnect(); // balance the connect() above (refcounted)
        };
    });

    function handleFormCancel(): void {
        showForm = false;
        editingSource = undefined;
    }

    async function handleRefresh(sourceId: string): Promise<void> {
        refreshingSourceId = sourceId;
        try {
            const result = await triggerRefresh(sourceId);
            if (result.data) {
                toasts.success(m.livetv_admin_refresh_success());
            } else {
                showError(result.error ?? m.livetv_admin_refresh_failed());
            }
        } catch {
            showError(m.livetv_admin_refresh_failed());
        } finally {
            refreshingSourceId = null;
        }
    }

    async function handleRefreshCronChange(
        sourceId: string,
        select: HTMLSelectElement,
        saved: string | null,
    ): Promise<void> {
        let ok = false;
        try {
            const result = await updateLiveTvSource(sourceId, {
                refreshCron: select.value || null,
            });
            ok = Boolean(result.data);
            if (!ok) showError(result.error ?? m.livetv_admin_refresh_failed());
        } catch {
            showError(m.livetv_admin_refresh_failed());
        }
        if (ok) {
            await loadSources();
        } else {
            // The select keeps showing what was picked: put the saved schedule
            // back, or a schedule that was NOT saved looked saved.
            select.value = saved ?? '';
        }
    }

    function handleShowSetup(sourceId: string): void {
        // Manual "Configure list" on an existing source — this re-applies and
        // discards the current arrangement, so show the warning.
        setupIsReconfigure = true;
        setupSourceId = sourceId;
        showSetup = true;
    }

    function handleSetupComplete(): void {
        showSetup = false;
        setupSourceId = null;
        void loadSources();
    }

    function formatDate(dateStr: string | undefined): string {
        if (!dateStr) return m.livetv_admin_never();
        return new Date(dateStr).toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
        });
    }

    function getTypeBadgeClass(sourceType: 'm3u' | 'xtream' | 'hdhomerun'): string {
        if (sourceType === 'xtream') return 'bg-purple-900/50 text-purple-300';
        if (sourceType === 'hdhomerun') return 'bg-green-900/50 text-green-300';
        return 'bg-blue-900/50 text-blue-300';
    }

    function getStatusBadgeClass(status: string | undefined): string {
        if (!status) return 'bg-surface-700 text-surface-400';
        if (status === 'success') return 'bg-green-900/50 text-green-300';
        if (status === 'failed' || status === 'error') return 'bg-red-900/50 text-red-300';
        return 'bg-yellow-900/50 text-yellow-300';
    }

    $effect(() => {
        void loadSources();
    });
</script>

<div class="space-y-6">
    <div class="flex justify-end gap-2">
        <!-- Export / import channel layout (curation portable across providers) -->
        <button
            type="button"
            class="btn btn-sm btn-ghost flex items-center gap-1.5"
            onclick={handleExportLayout}
            title="Download the current channel ordering, categories, visibility, and renames as a JSON file.">
            <Icon src={ArrowDownTray} class="w-4 h-4" />
            Export layout
        </button>
        <label
            class="btn btn-sm btn-ghost flex items-center gap-1.5 cursor-pointer"
            class:opacity-50={layoutImporting}
            title="Re-apply a previously exported layout to the current channels (matched by name).">
            {#if layoutImporting}
                <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
            {:else}
                <Icon src={ArrowUpTray} class="w-4 h-4" />
            {/if}
            Import layout
            <input
                type="file"
                accept="application/json,.json"
                class="hidden"
                disabled={layoutImporting}
                onchange={(e) => void handleImportLayoutFile(e)} />
        </label>
        <button
            type="button"
            class="btn btn-sm bg-yellow-500 hover:bg-yellow-400 text-surface-900 font-medium flex items-center gap-2"
            onclick={handleAddSource}>
            <Icon src={Plus} class="w-4 h-4" />
            {m.livetv_admin_add_source()}
        </button>
    </div>

    <!-- Form (inline) -->
    {#if showForm}
        <div class="bg-surface-800 border border-surface-700 rounded-lg p-6">
            <h3 class="text-lg font-medium text-white mb-4">
                {editingSource ? m.livetv_admin_edit_source() : m.livetv_admin_add_source()}
            </h3>
            <SourceForm
                source={editingSource}
                onSaved={handleFormSaved}
                onCancel={handleFormCancel} />
        </div>
    {/if}

    <!-- Loading -->
    {#if loading}
        <div class="p-8 text-center text-surface-400">
            <Icon src={ArrowPath} class="w-8 h-8 mx-auto animate-spin mb-2" />
            {m.livetv_admin_loading()}
        </div>

        <!-- Empty state (not under an open Add form: it repeats the same call to action) -->
    {:else if isEmpty && !showForm}
        <div
            class="bg-surface-800 border border-dashed border-surface-600 rounded-lg p-12 text-center">
            <Icon src={Tv} class="w-16 h-16 mx-auto text-surface-600 mb-4" />
            <h3 class="text-lg font-medium text-white mb-2">
                {m.livetv_admin_empty_title()}
            </h3>
            <p class="text-surface-400 mb-6 max-w-sm mx-auto">
                {m.livetv_admin_empty_description()}
            </p>
            <button
                type="button"
                class="btn bg-yellow-500 hover:bg-yellow-400 text-surface-900 font-medium flex items-center gap-2 mx-auto"
                onclick={handleAddSource}>
                <Icon src={Plus} class="w-5 h-5" />
                {m.livetv_admin_add_first()}
            </button>
        </div>

        <!-- Source list -->
    {:else}
        <div class="space-y-3">
            {#each sources as source (source.id)}
                <div class="bg-surface-800 border border-surface-700 rounded-lg p-5 space-y-3">
                    <!-- Bare playlist: no groups, ids or logos came with it -->
                    {#if source.playlistMetadataMissing}
                        <div
                            class="flex flex-col gap-2 text-xs text-yellow-300 bg-yellow-900/20 border border-yellow-700/40 rounded p-2.5 sm:flex-row sm:items-center">
                            <p class="flex-1">{m.livetv_admin_bare_playlist_hint()}</p>
                            <button
                                type="button"
                                class="btn btn-sm shrink-0 self-start bg-yellow-500 font-medium text-surface-900 hover:bg-yellow-400 flex items-center gap-1.5 sm:self-center"
                                onclick={() => handleEditSource(source)}>
                                <Icon src={PencilSquare} class="w-4 h-4" />
                                {m.livetv_admin_edit_source()}
                            </button>
                        </div>
                    {/if}

                    <!-- Warnings banner (above everything) -->
                    {#if source.lastImportWarnings && source.lastImportWarnings.length > 0}
                        <details>
                            <summary
                                class="text-xs text-yellow-400 cursor-pointer hover:text-yellow-300">
                                {source.lastImportWarnings.length} import warning{source
                                    .lastImportWarnings.length === 1
                                    ? ''
                                    : 's'}
                            </summary>
                            <div
                                class="mt-1 max-h-32 overflow-y-auto bg-yellow-900/20 rounded p-2 space-y-0.5">
                                {#each source.lastImportWarnings as warning, i (i)}
                                    <p class="text-xs text-yellow-200/70">
                                        {warning}
                                    </p>
                                {/each}
                            </div>
                        </details>
                    {/if}

                    <!-- Live import progress (channels, then the TV guide) -->
                    {#if importTracking?.sourceId === source.id && importProgress}
                        <div
                            class="bg-yellow-900/20 border border-yellow-700/40 rounded p-2.5 space-y-1.5">
                            <div class="flex items-center gap-2 text-xs text-yellow-300">
                                <Icon src={ArrowPath} class="w-3.5 h-3.5 animate-spin shrink-0" />
                                <span class="truncate">
                                    {importProgress.message ?? m.livetv_admin_importing()}
                                </span>
                                {#if importProgress.total}
                                    <span class="ml-auto tabular-nums shrink-0">
                                        {importProgress.processed ?? 0} / {importProgress.total}
                                    </span>
                                {/if}
                            </div>
                            <div class="h-1.5 bg-surface-700 rounded overflow-hidden">
                                <div
                                    class="h-full bg-yellow-500 transition-all duration-300"
                                    class:animate-pulse={!importProgress.total}
                                    style="width: {importProgress.total
                                        ? Math.min(
                                              100,
                                              Math.round(
                                                  ((importProgress.processed ?? 0) /
                                                      importProgress.total) *
                                                      100,
                                              ),
                                          )
                                        : 100}%">
                                </div>
                            </div>
                        </div>
                    {/if}

                    <!-- Header: name + badges + actions -->
                    <div class="flex flex-col sm:flex-row sm:items-center gap-2">
                        <div class="flex flex-wrap items-center gap-2 flex-1 min-w-0">
                            <h3 class="text-base font-medium text-white truncate">
                                {source.name}
                            </h3>
                            <span
                                class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium uppercase {getTypeBadgeClass(
                                    source.sourceType,
                                )}">
                                {source.sourceType}
                            </span>
                            {#if source.lastRefreshStatus || source.lastRefreshError}
                                <span
                                    class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium {getStatusBadgeClass(
                                        source.lastRefreshError
                                            ? 'failed'
                                            : (source.lastRefreshStatus ?? ''),
                                    )}">
                                    {source.lastRefreshStatus === 'failed' ||
                                    source.lastRefreshError
                                        ? m.livetv_admin_source_failed()
                                        : source.lastRefreshStatus}
                                </span>
                            {/if}
                        </div>

                        <!-- Actions -->
                        <div class="flex items-center gap-2 shrink-0">
                            {#if source.channelCount > 0}
                                <button
                                    type="button"
                                    class="btn btn-sm btn-ghost flex items-center gap-1.5 text-yellow-400 hover:text-yellow-300"
                                    onclick={() => handleShowSetup(source.id)}
                                    title={m.livetv_admin_setup_configure()}>
                                    <Icon src={Cog6Tooth} class="w-4 h-4" />
                                    {m.livetv_admin_setup_configure()}
                                </button>
                            {/if}
                            <button
                                type="button"
                                class="btn btn-sm btn-ghost flex items-center gap-1.5"
                                disabled={refreshingSourceId === source.id}
                                onclick={() => void handleRefresh(source.id)}
                                title={m.livetv_admin_refresh_now()}>
                                {#if refreshingSourceId === source.id}
                                    <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
                                {:else}
                                    <Icon src={ArrowPath} class="w-4 h-4" />
                                {/if}
                                {m.livetv_admin_refresh_now()}
                            </button>
                            <button
                                type="button"
                                class="btn btn-sm btn-ghost flex items-center gap-1.5"
                                disabled={importingSourceId === source.id}
                                onclick={() => void handleImport(source.id)}
                                title={m.livetv_admin_import()}>
                                {#if importingSourceId === source.id}
                                    <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
                                    {m.livetv_admin_importing()}
                                {:else}
                                    <Icon src={ArrowDownTray} class="w-4 h-4" />
                                    {m.livetv_admin_import()}
                                {/if}
                            </button>
                            <button
                                type="button"
                                class="btn btn-sm btn-ghost flex items-center gap-1.5"
                                onclick={() => handleEditSource(source)}
                                title={m.livetv_admin_edit_source()}>
                                <Icon src={PencilSquare} class="w-4 h-4" />
                                {m.livetv_admin_edit_source()}
                            </button>
                            <button
                                type="button"
                                class="btn btn-sm btn-ghost text-red-400 hover:text-red-300 flex items-center gap-1.5"
                                disabled={deletingSourceId === source.id}
                                onclick={() => void handleDelete(source.id, source.name)}
                                title="Delete">
                                {#if deletingSourceId === source.id}
                                    <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
                                {:else}
                                    <Icon src={Trash} class="w-4 h-4" />
                                {/if}
                            </button>
                        </div>
                    </div>

                    {#if source.lastRefreshError}
                        <p class="text-sm text-red-300" role="alert">
                            {redactLiveTvUrlsInText(source.lastRefreshError)}
                        </p>
                    {/if}

                    <!-- Stats row -->
                    <div class="flex flex-wrap gap-x-6 gap-y-1 text-sm text-surface-400">
                        <span>
                            <span class="text-surface-300 font-medium">{source.channelCount}</span>
                            {source.channelCount === 1
                                ? m.livetv_admin_channel_singular()
                                : 'channels'}
                        </span>
                        <span>
                            {m.livetv_admin_source_max_streams()}:
                            <span class="text-surface-300 font-medium">{source.maxStreams}</span>
                        </span>
                        <span>
                            {m.livetv_admin_last_refresh()}
                            <span class="text-surface-300">{formatDate(source.lastRefreshAt)}</span>
                        </span>
                        <span class="flex items-center gap-1.5">
                            {m.livetv_admin_refresh_schedule()}:
                            <select
                                class="bg-surface-700 text-surface-200 text-xs rounded px-1.5 py-0.5 border border-surface-600"
                                value={source.refreshCron ?? ''}
                                onchange={(e) =>
                                    void handleRefreshCronChange(
                                        source.id,
                                        e.currentTarget,
                                        source.refreshCron ?? null,
                                    )}>
                                {#each REFRESH_CRON_OPTIONS as option (option.value)}
                                    <option value={option.value ?? ''}>{option.label()}</option>
                                {/each}
                            </select>
                        </span>
                    </div>
                </div>
            {/each}
        </div>
    {/if}

    <!-- Guided Setup Wizard (inline) -->
    {#if showSetup && setupSourceId}
        <ImportGuidedSetup
            sourceId={setupSourceId}
            isReconfigure={setupIsReconfigure}
            onComplete={handleSetupComplete} />
    {/if}
</div>
