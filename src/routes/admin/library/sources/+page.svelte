<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Libraries overview: a compact list of libraries. Everything PER-LIBRARY
  (folders table, access editing, inline edition/provider-path editing,
  per-folder toggles, edit/delete) lives on the [id] page now — this page
  only lists, scans and reorders.
-->

<script lang="ts">
    import { onMount, tick } from 'svelte';
    import { goto } from '$app/navigation';
    import { dragHandleZone, dragHandle } from 'svelte-dnd-action';
    import { flip } from 'svelte/animate';
    import { SvelteMap } from 'svelte/reactivity';
    import {
        Icon,
        ArrowPath,
        FolderOpen,
        FolderPlus,
        Bars3,
        ChevronUp,
        ChevronDown,
        LockClosed,
        XMark,
    } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';
    import { invalidateWhenIdle } from '$lib/utils/invalidate-when-idle';
    import {
        UPLOADABLE_LIBRARY_TYPES,
        LIBRARY_UPLOAD_NAV_DEP,
    } from '$lib/shared/uploadable-library-types';
    import { AdminPageHeader } from '$lib/components/admin';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import { toasts } from '$lib/stores/toast.store';
    import { modals } from '$lib/stores/modal.store';
    import ConfirmModal from '$lib/components/ui/ConfirmModal.svelte';
    import { getErrorMessage } from '$lib/utils/error-handling';
    import {
        getLibraryGroups,
        getLibraryPaths,
        updateLibraryGroup,
        getLibraryGroupPermissions,
        getLibraryFileStats,
        triggerFileScanner,
        listUnmatchedFiles,
        getLatestScannerRunPerLibrary,
    } from '$lib/api/admin';
    import { apiGet } from '$lib/api/client.js';
    import { TaskListResponseSchema } from '$lib/schemas/task-definition.schema.js';
    import type { LibraryGroupData, LibraryPath } from '$lib/schemas/api-admin-library-responses';
    import type { ScannerRun } from '$lib/schemas/api-admin-responses.js';
    import SectionAttentionStrip from '$lib/components/admin/attention/SectionAttentionStrip.svelte';
    import LibraryGroupModal from '$lib/components/admin/LibraryGroupModal.svelte';
    import {
        mediaTypeLabel,
        providerLabel,
        isRemoteProvider,
    } from '$lib/components/admin/library/library-labels';
    import {
        LibraryScanController,
        type GroupScanState,
    } from '$lib/components/admin/library/library-scan-state.svelte';
    import LibrarySetupWizard from '$lib/components/admin/LibrarySetupWizard.svelte';
    import { formatFileSize } from '$lib/utils/metric-formatters';
    import { formatRelativeTime } from '$lib/utils/time-formatting';
    import { requireValue } from '$lib/utils/runtime-validation';
    import type { PageData } from './$types';
    import { formatEta } from '$lib/utils/eta-estimator';

    import * as m from '$lib/paraglide/messages.js';

    let { data }: { data: PageData } = $props();

    // -------------------------------------------------------------------------
    // Data loading
    // -------------------------------------------------------------------------

    let libraryGroups = $state<LibraryGroupData[]>([]);
    let paths = $state<LibraryPath[]>([]);
    // Start in the loading state: the first paint used to show the
    // "create your first library" call to action before any load began.
    let groupsLoading = $state(true);
    let pathsLoading = $state(true);
    /** The list could not be loaded — never rendered as "no libraries yet". */
    let groupsLoadFailed = $state(false);
    /** Set when the page is left; async work must not re-arm polling after that. */
    let destroyed = false;

    async function loadGroups(): Promise<void> {
        groupsLoading = true;
        try {
            const { data, error } = await getLibraryGroups();
            if (error) {
                toasts.error(error);
                groupsLoadFailed = libraryGroups.length === 0;
            } else if (data) {
                libraryGroups = data.items;
                groupsLoadFailed = false;
            }
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_library_err_load_groups()));
            groupsLoadFailed = libraryGroups.length === 0;
        } finally {
            groupsLoading = false;
        }
    }

    const loadPaths = async (): Promise<void> => {
        pathsLoading = true;
        try {
            const { data, error } = await getLibraryPaths();
            if (error) {
                toasts.error(m.admin_toast_failed_to_load_library_paths());
            } else if (data) {
                paths = data.items;
            }
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_toast_failed_to_load_library_paths()));
        } finally {
            pathsLoading = false;
        }
    };

    // The admin nav shows Library → Upload only while an enabled uploadable
    // library exists (admin layout `libraryUpload`). Every edit on the
    // per-library page goes through the API without a load re-run here, so
    // re-run the layout's gate whenever a fresh load flips that answer.
    let uploadApplies: boolean | undefined;
    $effect(() => {
        if (pathsLoading) return;
        const applies = paths.some((p) => p.enabled && UPLOADABLE_LIBRARY_TYPES.has(p.mediaType));
        if (uploadApplies !== undefined && applies !== uploadApplies) {
            invalidateWhenIdle(LIBRARY_UPLOAD_NAV_DEP);
        }
        uploadApplies = applies;
    });

    // -------------------------------------------------------------------------
    // Access (allowed Authentik groups) — read-only here, badge only
    // -------------------------------------------------------------------------

    let permissionsMap = new SvelteMap<string, string[]>();

    async function loadPermissions(): Promise<void> {
        try {
            const { data, error } = await getLibraryGroupPermissions();
            if (!error && data) {
                permissionsMap.clear();
                for (const p of data.permissions) {
                    permissionsMap.set(p.libraryGroupId, p.allowedGroups);
                }
            }
        } catch {
            /* expected: non-critical — the access badge just stays hidden */
        }
    }

    // -------------------------------------------------------------------------
    // Scanner runs — last scan + issues per library
    // -------------------------------------------------------------------------

    let scannerRuns = $state<ScannerRun[]>([]);

    async function loadScannerRuns(): Promise<void> {
        try {
            const { data, error } = await getLatestScannerRunPerLibrary();
            if (!error && data) scannerRuns = data.items;
        } catch {
            /* expected: non-critical — last-scan/issues columns just stay empty */
        }
    }

    // -------------------------------------------------------------------------
    // File stats — health line
    // -------------------------------------------------------------------------

    interface FileStats {
        totalFiles: number;
        withHash: number;
        probed: number;
        totalSizeBytes: number;
    }

    let fileStats = $state<FileStats | null>(null);

    async function loadFileStats(): Promise<void> {
        try {
            const { data } = await getLibraryFileStats();
            if (data) fileStats = data;
        } catch {
            /* expected: non-critical — file stats are display-only */
        }
    }

    const healthWarnings = $derived.by((): string[] => {
        if (!fileStats || fileStats.totalFiles === 0) return [];
        const parts: string[] = [];
        const hashMissing = fileStats.totalFiles - fileStats.withHash;
        const probeMissing = fileStats.totalFiles - fileStats.probed;
        if (hashMissing > 0) {
            parts.push(m.admin_library_overview_health_hash_missing({ count: hashMissing }));
        }
        if (probeMissing > 0) {
            parts.push(m.admin_library_overview_health_probe_missing({ count: probeMissing }));
        }
        return parts;
    });

    // -------------------------------------------------------------------------
    // Automatic-scan schedule line
    // -------------------------------------------------------------------------

    let scheduleEvery = $state<string | undefined>(undefined);
    let scheduleNextRunAt = $state<string | null | undefined>(undefined);

    async function loadSchedule(): Promise<void> {
        try {
            const { data, error } = await apiGet('/api/tasks', TaskListResponseSchema);
            if (error || !data) return;
            const task = data.items.find((t) => t.id === 'file-library-scan');
            scheduleEvery = task?.effectiveEvery;
            scheduleNextRunAt = task?.nextRunAt;
        } catch {
            /* expected: non-critical — the schedule line just stays hidden */
        }
    }

    function formatNextIn(nextRunAt: string | null | undefined): string | null {
        if (!nextRunAt) return null;
        const diffMs = new Date(nextRunAt).getTime() - Date.now();
        if (Number.isNaN(diffMs)) return null;
        const minutes = Math.round(diffMs / 60_000);
        if (minutes <= 0) return m.admin_library_overview_schedule_next_under_min();
        if (minutes < 60) return m.admin_library_overview_schedule_next_min({ minutes });
        return m.admin_library_overview_schedule_next_hours({
            hours: Math.floor(minutes / 60),
            minutes: minutes % 60,
        });
    }

    const scheduleLine = $derived.by((): string | null => {
        const nextIn = formatNextIn(scheduleNextRunAt);
        const everyLabel = scheduleEvery
            ? m.admin_library_overview_schedule_every({ every: scheduleEvery })
            : null;
        if (everyLabel && nextIn) return `${everyLabel} · ${nextIn}`;
        return everyLabel ?? nextIn;
    });

    onMount(() => {
        void loadGroups();
        void loadPaths();
        void loadPermissions();
        void loadScannerRuns();
        void loadFileStats();
        void loadSchedule();
        // Check if a scan is already running.
        void pollScannerStatus().then(() => {
            if (scan.scanning) startScanPolling();
        });
    });

    // -------------------------------------------------------------------------
    // Rows: one per library, sorted sort_order then name
    // -------------------------------------------------------------------------

    interface LibraryRow {
        group: LibraryGroupData;
        folders: LibraryPath[];
        mediaType?: LibraryPath['mediaType'];
        provider?: LibraryPath['provider'];
        disabledCount: number;
        latestRun: ScannerRun | null;
        issues: number;
        allowedGroups: string[];
    }

    /**
     * Live drag/keyboard order. A writable `$derived`: dragging or a
     * keyboard move assigns straight into it (see `handleDndConsider` /
     * `moveRow`), and that override holds until `libraryGroups` itself
     * changes (a fresh load, or `persistReorder` writing the saved order
     * back) — which recomputes the sort and clears the override.
     */
    let displayGroups = $derived(
        [...libraryGroups].sort(
            (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
        ),
    );

    const rows = $derived.by((): LibraryRow[] => {
        const pathToGroup = new SvelteMap(paths.map((p) => [p.id, p.libraryGroupId]));
        const byGroup = new SvelteMap<string, { latest: ScannerRun | null; issues: number }>();
        for (const r of scannerRuns) {
            const gid = r.libraryPathId ? pathToGroup.get(r.libraryPathId) : undefined;
            if (!gid) continue;
            const entry = byGroup.get(gid) ?? { latest: null, issues: 0 };
            if (r.status === 'completed' && r.errors > 0) entry.issues += r.errors;
            if (r.startedAt && (!entry.latest?.startedAt || r.startedAt > entry.latest.startedAt)) {
                entry.latest = r;
            }
            byGroup.set(gid, entry);
        }
        return displayGroups.map((group) => {
            const folders = paths.filter((p) => p.libraryGroupId === group.id);
            const runInfo = byGroup.get(group.id);
            return {
                group,
                folders,
                mediaType: folders[0]?.mediaType,
                provider: folders[0]?.provider,
                disabledCount: folders.filter((p) => !p.enabled).length,
                latestRun: runInfo?.latest ?? null,
                issues: runInfo?.issues ?? 0,
                allowedGroups: permissionsMap.get(group.id) ?? [],
            };
        });
    });

    const rowByGroupId = $derived(new SvelteMap(rows.map((r) => [r.group.id, r])));

    // `added`/`updated` are a single aggregate count across every media_type a
    // scan touched — for a music library that's albums, artists AND tracks
    // added together, so a bare "+245 new" reads as one made-up unit. There's
    // no per-type breakdown to draw on here, so music libraries get a wording
    // that names tracks (the dominant, most numerous row) rather than implying
    // a single homogenous "item".
    function lastScanLabel(r: ScannerRun, mediaType?: string): string {
        const when = r.startedAt ? formatRelativeTime(r.startedAt) : '—';
        if (r.status === 'abandoned' || r.status === 'running') return when;
        const changes =
            r.added > 0 || r.updated > 0
                ? mediaType === 'music'
                    ? m.admin_scanner_runs_changes_summary_music({
                          added: r.added,
                          updated: r.updated,
                      })
                    : m.admin_scanner_runs_changes_summary({ added: r.added, updated: r.updated })
                : m.admin_scanner_runs_no_changes();
        return `${when} · ${changes}`;
    }

    // -------------------------------------------------------------------------
    // Reorder — drag (svelte-dnd-action) + keyboard move up/down
    // -------------------------------------------------------------------------

    const flipDurationMs = 200;
    let reorderMode = $state(false);
    let reorderSaving = $state(false);
    let reorderAnnouncement = $state('');

    /** PATCHes sort_order for only the rows whose position actually changed. */
    async function persistReorder(ordered: LibraryGroupData[]): Promise<boolean> {
        if (reorderSaving) return false;
        const changed = ordered
            .map((g, index) => ({ g, index }))
            .filter(({ g, index }) => g.sortOrder !== index);
        if (changed.length === 0) return true;
        reorderSaving = true;
        libraryGroups = ordered.map((g, index) => ({ ...g, sortOrder: index }));
        try {
            const results = await Promise.all(
                changed.map(({ g, index }) => updateLibraryGroup(g.id, { sort_order: index })),
            );
            // The API client resolves with `{ error }` instead of throwing, so
            // a rejected reorder used to stay on screen as if it were saved.
            const failed = results.find((r) => r.error);
            if (failed) {
                toasts.error(failed.error ?? m.admin_library_reorder_failed());
                await loadGroups();
                return false;
            }
            return true;
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_library_reorder_failed()));
            await loadGroups();
            return false;
        } finally {
            reorderSaving = false;
        }
    }

    function handleDndConsider(e: CustomEvent<{ items: LibraryGroupData[] }>): void {
        if (!reorderMode || reorderSaving) return;
        displayGroups = e.detail.items;
    }

    function handleDndFinalize(e: CustomEvent<{ items: LibraryGroupData[] }>): void {
        if (!reorderMode || reorderSaving) return;
        displayGroups = e.detail.items;
        void persistReorder(e.detail.items);
    }

    async function moveRow(
        position: number,
        direction: -1 | 1,
        button: HTMLButtonElement,
    ): Promise<void> {
        if (!reorderMode || reorderSaving) return;
        const target = position + direction;
        if (position < 0 || position >= displayGroups.length) return;
        if (target < 0 || target >= displayGroups.length) return;
        const reordered = [...displayGroups];
        const [moved] = reordered.splice(position, 1);
        reordered.splice(target, 0, moved);
        const hadFocus = document.activeElement === button;
        displayGroups = reordered;
        const saved = await persistReorder(reordered);
        if (saved) {
            reorderAnnouncement = m.admin_library_overview_moved({
                name: moved.name,
                position: target + 1,
                total: reordered.length,
            });
        }
        await tick();
        if (
            hadFocus &&
            (document.activeElement === button || document.activeElement === document.body)
        ) {
            const focusTarget = button.disabled
                ? button.parentElement?.querySelector<HTMLButtonElement>('button:not(:disabled)')
                : button;
            focusTarget?.focus();
        }
    }

    // -------------------------------------------------------------------------
    // Create / navigate
    // -------------------------------------------------------------------------

    function openSetupWizard(): void {
        modals.open(LibrarySetupWizard, {
            onSaved: () => {
                void loadGroups();
                void loadPaths();
                // The wizard starts a scan of the new folders; show it.
                startScanPolling();
                void pollScannerStatus();
            },
            // The wizard is the one "new library" entry point; its escape hatch
            // (remote sources, folder-by-folder setup) is an empty library.
            onCreateEmpty: () =>
                modals.open(LibraryGroupModal, {
                    defaultSortOrder: libraryGroups.length,
                    onSaved: () => void loadGroups(),
                }),
        });
    }

    function goToLibrary(id: string): void {
        void goto(resolve(`/admin/library/sources/${id}`));
    }

    /** Ignore row-level navigation clicks that land on an already-interactive descendant. */
    function handleRowClick(e: MouseEvent, id: string): void {
        const target = e.target as HTMLElement;
        if (reorderMode || target.closest('a, button, input, select')) return;
        goToLibrary(id);
    }

    // -------------------------------------------------------------------------
    // File Scanner: trigger / abort (per library + all)
    // -------------------------------------------------------------------------

    const scan = new LibraryScanController();

    const scanGroups = $derived(
        rows.map((r) => ({
            id: r.group.id,
            name: r.group.name,
            paths: r.folders.map((p) => ({ id: p.id })),
        })),
    );

    const groupScanStates = $derived(scan.groupScanStates(scanGroups));
    const scanningAny = $derived(scan.scanning || groupScanStates.size > 0);

    function scanPct(st: GroupScanState): number | null {
        return scan.scanPct(st);
    }

    async function notifyIfUnmatchedFiles(): Promise<void> {
        try {
            const { data, error } = await listUnmatchedFiles({
                limit: 1,
                offset: 0,
                sort: 'title',
            });
            const total = !error ? (data?.page.total ?? 0) : 0;
            if (total > 0) {
                toasts.info(m.admin_toast_scan_unmatched_nudge({ count: total }), {
                    action: {
                        label: m.admin_fix_matches_tab_never(),
                        onClick: () => void goto(resolve('/admin/library/fix-matches')),
                    },
                });
            }
        } catch {
            /* expected: non-critical — the nudge is a convenience, not required */
        }
    }

    async function pollScannerStatus(): Promise<void> {
        const justFinished = await scan.poll(() => scanGroups);
        if (justFinished) {
            void loadPaths();
            void loadScannerRuns();
            void notifyIfUnmatchedFiles();
        }
    }

    function startScanPolling(): void {
        if (destroyed) return;
        scan.watch(() => void pollScannerStatus());
    }

    function stopScanPolling(): void {
        scan.stopPolling();
    }

    async function triggerFileScan(): Promise<void> {
        if (scan.scanning) return;
        scan.prepareForNewScan();
        try {
            const { data, error } = await triggerFileScanner({});
            if (error) {
                toasts.error(error ?? m.admin_library_file_scan_failed());
                scan.scanning = false;
            } else if (!data?.jobId) {
                toasts.error(m.admin_toast_scan_started_but_server_did_not_return_a_job_id());
                scan.scanning = false;
            } else {
                if (data.alreadyRunning) toasts.info(m.admin_library_already_scanning());
                else toasts.success(m.admin_toast_file_scan_started());
                startScanPolling();
                void pollScannerStatus();
            }
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_library_file_scan_failed()));
            scan.scanning = false;
        }
    }

    async function abortFileScan(): Promise<void> {
        await scan.abortAll();
    }

    async function toggleScanAll(): Promise<void> {
        if (scanningAny) {
            // "Stop all" cancels every running and queued scan, scheduled
            // ones included — confirm before one click throws that away.
            modals.open(ConfirmModal, {
                title: m.admin_library_stop_all_confirm_title(),
                body: m.admin_library_stop_all_confirm_body(),
                confirmText: m.admin_library_scan_stop_all(),
                confirmVariant: 'danger' as const,
                onConfirm: () => abortFileScan(),
            });
        } else await triggerFileScan();
    }

    async function triggerFileScanForRow(row: LibraryRow): Promise<void> {
        if (scan.pendingGroupIds.has(row.group.id) || groupScanStates.has(row.group.id)) return;
        const { started } = await scan.triggerForGroup({
            id: row.group.id,
            name: row.group.name,
            paths: row.folders.map((p) => ({ id: p.id })),
        });
        if (started) {
            startScanPolling();
            await pollScannerStatus();
        }
    }

    async function abortRowScan(row: LibraryRow): Promise<void> {
        await scan.abortForGroup({
            id: row.group.id,
            name: row.group.name,
            paths: row.folders.map((p) => ({ id: p.id })),
        });
        await pollScannerStatus();
    }

    $effect(() => {
        return () => {
            destroyed = true;
            stopScanPolling();
        };
    });
</script>

{#snippet scanStatusChip(st: GroupScanState, eta?: number)}
    {@const pct = scanPct(st)}
    <span
        class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs {st.state === 'queued'
            ? 'bg-surface-700 text-surface-300'
            : 'bg-teal-900/40 text-teal-300'}">
        {#if st.state === 'queued'}
            {m.admin_library_scan_queued()}
        {:else if st.state === 'cancelling'}
            {m.route_admin_library_aborting()}
        {:else if st.discovering}
            {m.admin_library_discovering_files()}
        {:else}
            <Icon src={ArrowPath} class="w-3 h-3 animate-spin" />
            {m.admin_library_scan_scanning()}
            {#if pct !== null}<span class="tabular-nums">{pct}%</span>{/if}
            {#if pct !== null && eta !== undefined}
                <span class="text-teal-200/70">· {formatEta(eta)}</span>
            {/if}
        {/if}
        {#if st.automatic}
            <span class="text-surface-400">· {m.admin_library_scan_automatic()}</span>
        {/if}
    </span>
{/snippet}

<div class="space-y-6">
    <AdminPageHeader
        icon={adminPageIcons['/admin/library/sources']}
        title={m.route_admin_library_title()}
        description={m.route_admin_library_description()}>
        <SectionAttentionStrip section="library" />
        <button class="btn btn-ghost" onclick={() => void toggleScanAll()}>
            <Icon src={ArrowPath} class="w-4 h-4 {scanningAny ? 'animate-spin' : ''}" />
            {scanningAny ? m.admin_library_scan_stop_all() : m.admin_library_overview_scan_all()}
        </button>
        <button class="btn btn-blue" onclick={() => openSetupWizard()}>
            <Icon src={FolderPlus} class="w-4 h-4" />
            {m.admin_library_new_library()}
        </button>
    </AdminPageHeader>

    <!-- Render only available information: failed optional requests stay absent. -->
    {#if groupScanStates.size > 0 || scheduleLine || fileStats}
        <section
            aria-label={m.admin_library_overview_status()}
            class="bg-surface-800 border border-surface-700 rounded-xl p-4 sm:p-5 space-y-4">
            <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="space-y-1 min-w-0">
                    <h2 class="text-base font-semibold text-white">
                        {m.admin_library_overview_status()}
                    </h2>
                    {#if scheduleLine}<p class="text-sm text-surface-300">{scheduleLine}</p>{/if}
                </div>
                {#if fileStats}
                    <p class="text-sm font-medium text-surface-200 tabular-nums">
                        {m.admin_library_overview_files_total({
                            count: fileStats.totalFiles.toLocaleString(),
                            size: formatFileSize(fileStats.totalSizeBytes),
                        })}
                    </p>
                {/if}
            </div>
            {#if healthWarnings.length > 0}
                <p class="text-sm text-amber-300 border-t border-surface-700 pt-3">
                    {healthWarnings.join(' · ')}
                </p>
            {/if}
            {#if groupScanStates.size > 0}
                <h3 class="text-sm font-medium text-white mb-2">
                    {m.admin_library_overview_scanning()}
                </h3>
                <div class="space-y-2.5">
                    {#each rows.filter( (r) => groupScanStates.has(r.group.id) ) as row (row.group.id)}
                        {@const st = requireValue(
                            groupScanStates.get(row.group.id),
                            'filtered to rows with a scan state',
                        )}
                        {@const pct = scanPct(st) ?? 0}
                        <div class="space-y-1">
                            <div class="flex flex-wrap items-center justify-between gap-2 text-sm">
                                <span class="flex items-center gap-2 min-w-0">
                                    <span class="font-medium text-white break-words"
                                        >{row.group.name}</span>
                                    {@render scanStatusChip(st, scan.groupEtas.get(row.group.id))}
                                </span>
                                <button
                                    class="btn btn-sm btn-ghost text-red-300 disabled:opacity-50"
                                    disabled={scan.pendingGroupIds.has(row.group.id) ||
                                        st.state === 'cancelling'}
                                    aria-label={m.admin_library_overview_stop_button_aria({
                                        name: row.group.name,
                                    })}
                                    onclick={() => void abortRowScan(row)}>
                                    {m.admin_library_scan_stop()}
                                </button>
                            </div>
                            <div class="h-1.5 w-full rounded-full bg-surface-700 overflow-hidden">
                                <div
                                    class="h-full rounded-full transition-all duration-300 {st.state ===
                                    'queued'
                                        ? 'bg-surface-500'
                                        : 'bg-teal-500'}"
                                    class:animate-pulse={st.state !== 'running' || st.discovering}
                                    style="width: {st.state === 'running' && !st.discovering
                                        ? pct
                                        : 100}%">
                                </div>
                            </div>
                        </div>
                    {/each}
                </div>
            {/if}
        </section>
    {/if}

    <!-- Library list -->
    {#if groupsLoading || pathsLoading}
        <p class="text-muted">{m.loading()}</p>
    {:else if groupsLoadFailed}
        <div
            class="bg-surface-800 border border-surface-700 rounded-lg p-10 text-center space-y-3"
            role="alert">
            <p class="text-white font-medium">{m.admin_library_err_load_groups()}</p>
            <button class="btn btn-ghost" onclick={() => void loadGroups()}>{m.retry()}</button>
        </div>
    {:else if rows.length === 0}
        <div class="bg-surface-800 border border-surface-700 rounded-lg p-10 text-center">
            <div
                class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-blue-500/10 text-blue-400">
                <Icon src={FolderPlus} class="w-6 h-6" />
            </div>
            <h4 class="text-white font-medium">{m.route_admin_library_empty_title()}</h4>
            <p class="text-muted text-sm mt-1 max-w-md mx-auto">
                {m.route_admin_library_empty_body()}
            </p>
            <button class="btn btn-blue btn-sm mt-4" onclick={() => openSetupWizard()}>
                <Icon src={FolderPlus} class="w-4 h-4" />
                {m.route_admin_library_create_first()}
            </button>
        </div>
    {:else}
        <div class="flex flex-wrap items-center justify-between gap-3">
            <h2 class="text-lg font-semibold text-white">{m.route_admin_library_title()}</h2>
            <button
                type="button"
                class="btn btn-ghost"
                aria-pressed={reorderMode}
                aria-controls="library-source-list"
                disabled={reorderSaving}
                onclick={() => (reorderMode = !reorderMode)}>
                <Icon src={Bars3} class="w-4 h-4" />
                {reorderSaving
                    ? m.saving()
                    : reorderMode
                      ? m.catalog_done()
                      : m.admin_library_overview_reorder()}
            </button>
        </div>
        {#if reorderMode}<p class="text-sm text-surface-300">
                {m.admin_library_overview_reorder_help()}
            </p>{/if}
        <p class="sr-only" role="status" aria-live="polite">{reorderAnnouncement}</p>
        <ul
            id="library-source-list"
            class="space-y-3"
            use:dragHandleZone={{
                items: displayGroups,
                flipDurationMs,
                type: 'library-rows',
                dragDisabled: !reorderMode || reorderSaving,
                delayTouchStart: true,
                zoneTabIndex: reorderMode ? 0 : -1,
                zoneItemTabIndex: -1,
                dropTargetStyle: {
                    outline: '2px dashed rgba(6, 182, 212, 0.5)',
                    borderRadius: '8px',
                },
            }}
            onconsider={handleDndConsider}
            onfinalize={handleDndFinalize}>
            {#each displayGroups as group, position (group.id)}
                {@const row = rowByGroupId.get(group.id)}
                <li
                    animate:flip={{ duration: flipDurationMs }}
                    class="list-none"
                    aria-label={group.name}>
                    {#if row}
                        <!--
                          Not role="button": the row already contains a real
                          link (the name) plus real buttons (reorder, scan) —
                          keyboard and screen-reader users reach the library
                          page and every action through those. A role="button"
                          wrapper here would ALSO compute its accessible name
                          from the whole row's text content (name, type,
                          counts, "Stop" …), which collides with the row's own
                          Stop/Scan button on an accessible-name query. This
                          onclick is a mouse-only convenience: it defers to any
                          interactive descendant instead of double-firing.
                        -->
                        <!-- svelte-ignore a11y_click_events_have_key_events -->
                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                        <div
                            class="library-row {reorderMode
                                ? ''
                                : 'cursor-pointer'} bg-surface-800 border border-surface-700 rounded-xl p-4 sm:p-5 hover:border-surface-500 transition-colors"
                            onclick={(e) => handleRowClick(e, row.group.id)}>
                            {#if reorderMode}
                                <div class="reorder-controls flex items-center gap-2">
                                    <!-- Drag handle -->
                                    <span
                                        use:dragHandle
                                        class="flex h-9 w-9 items-center justify-center rounded-md text-surface-200 hover:bg-surface-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400"
                                        aria-label={m.admin_library_overview_drag_handle({
                                            name: row.group.name,
                                        })}>
                                        <Icon src={Bars3} class="w-4 h-4" />
                                    </span>
                                    <!-- Keyboard reorder -->
                                    <div class="flex flex-col shrink-0">
                                        <button
                                            type="button"
                                            class="h-9 w-9 flex items-center justify-center rounded-md text-surface-200 hover:bg-surface-700 focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-30"
                                            disabled={reorderSaving || position === 0}
                                            aria-label={m.admin_library_overview_move_up({
                                                name: row.group.name,
                                            })}
                                            onclick={(event) =>
                                                void moveRow(position, -1, event.currentTarget)}>
                                            <Icon src={ChevronUp} class="w-3.5 h-3.5" />
                                        </button>
                                        <button
                                            type="button"
                                            class="h-9 w-9 flex items-center justify-center rounded-md text-surface-200 hover:bg-surface-700 focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-30"
                                            disabled={reorderSaving ||
                                                position === displayGroups.length - 1}
                                            aria-label={m.admin_library_overview_move_down({
                                                name: row.group.name,
                                            })}
                                            onclick={(event) =>
                                                void moveRow(position, 1, event.currentTarget)}>
                                            <Icon src={ChevronDown} class="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                </div>
                            {/if}
                            <div class="library-identity flex items-start gap-3 min-w-0">
                                <!-- Icon -->
                                {#if row.group.icon}
                                    <span class="w-5 text-center shrink-0" aria-hidden="true">
                                        {row.group.icon}
                                    </span>
                                {:else}
                                    <Icon src={FolderOpen} class="w-5 h-5 text-blue-400 shrink-0" />
                                {/if}

                                <!-- Name + type/provider. A floor on its width so that on a
                                 phone the counts / last scan / Scan wrap onto a second
                                 line instead of squeezing this block until its badges
                                 overlap them. -->
                                <div class="min-w-0 flex-1 space-y-2">
                                    <a
                                        href={resolve(`/admin/library/sources/${row.group.id}`)}
                                        class="block text-base font-semibold text-white break-words [overflow-wrap:anywhere] hover:underline hover:text-blue-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400">
                                        {row.group.name}
                                    </a>
                                    <div class="flex flex-wrap items-center gap-2">
                                        {#if row.mediaType}
                                            <span
                                                class="rounded bg-surface-700 px-2 py-0.5 text-xs text-surface-300">
                                                {mediaTypeLabel(row.mediaType)}
                                            </span>
                                            <!-- The scan folder's `provider` column defaults to
                                         'tmdb' regardless of media type — meaningless for a
                                         music library (which doesn't use TMDB at all), so
                                         only show it for a genuinely music-relevant provider. -->
                                            {#if row.provider && !(row.mediaType === 'music' && row.provider === 'tmdb')}
                                                <span class="text-sm text-surface-300">
                                                    {providerLabel(row.provider)}
                                                </span>
                                            {/if}
                                        {:else}
                                            <span class="text-sm text-surface-300">
                                                {m.admin_library_detail_no_folders()}
                                            </span>
                                        {/if}
                                        {#if row.allowedGroups.length > 0}
                                            <span
                                                class="inline-flex items-center gap-1 rounded-full bg-blue-900/40 border border-blue-700/50 px-2 py-0.5 text-xs text-blue-300"
                                                title={row.allowedGroups.join(', ')}>
                                                <Icon src={LockClosed} class="w-3 h-3" />
                                                {m.admin_library_overview_restricted()}
                                            </span>
                                        {/if}
                                        {#if groupScanStates.has(row.group.id)}
                                            {@render scanStatusChip(
                                                requireValue(
                                                    groupScanStates.get(row.group.id),
                                                    'has() checked',
                                                ),
                                                scan.groupEtas.get(row.group.id),
                                            )}
                                        {/if}
                                    </div>
                                </div>
                            </div>
                            <!-- Item count / folder count -->
                            <div
                                class="library-counts flex flex-col gap-1 text-sm text-surface-300">
                                {#if row.group.itemCount != null}
                                    <span
                                        >{row.mediaType === 'music'
                                            ? m.admin_library_track_count({
                                                  count: row.group.itemCount,
                                              })
                                            : m.admin_library_item_count({
                                                  count: row.group.itemCount,
                                              })}</span>
                                {/if}
                                {#if row.disabledCount > 0}
                                    <span class="text-amber-400/80">
                                        {m.admin_library_overview_folders_off({
                                            off: row.disabledCount,
                                            total: row.folders.length,
                                        })}
                                    </span>
                                {:else if row.folders.length > 0}
                                    <span
                                        >{m.admin_library_detail_folder_count({
                                            count: row.folders.length,
                                        })}</span>
                                {/if}
                            </div>

                            <!-- Last scan -->
                            <div
                                class="library-last-scan min-w-0 text-sm text-surface-200 space-y-1">
                                <p class="text-xs font-medium text-surface-400">
                                    {row.provider && isRemoteProvider(row.provider)
                                        ? m.admin_library_remote_activity()
                                        : m.admin_scanner_runs_last_scan()}
                                </p>
                                {#if row.provider && isRemoteProvider(row.provider)}
                                    {m.admin_library_remote_activity_hint({
                                        source: providerLabel(row.provider),
                                    })}
                                    <a
                                        class="block underline"
                                        href={resolve(`/admin/tasks/${row.provider}-sync`)}
                                        >{m.admin_library_remote_sync_runs()}</a>
                                {:else if row.latestRun}
                                    {lastScanLabel(row.latestRun, row.mediaType)}
                                {:else}
                                    {m.admin_library_overview_never_scanned()}
                                {/if}
                            </div>

                            <!-- Issues -->
                            {#if row.issues > 0}
                                <div class="library-issues min-w-0">
                                    <a
                                        href={resolve(
                                            `/admin/library/sources/${row.group.id}#issues`,
                                        )}
                                        class="text-sm text-red-300 hover:text-red-200 hover:underline">
                                        {m.admin_library_overview_issues({ count: row.issues })}
                                    </a>
                                </div>
                            {/if}

                            <!-- Scan / Stop -->
                            <div class="library-actions">
                                {#if groupScanStates.has(row.group.id)}
                                    <button
                                        class="btn btn-sm btn-ghost text-red-400 hover:text-red-300 disabled:opacity-50"
                                        disabled={scan.pendingGroupIds.has(row.group.id) ||
                                            groupScanStates.get(row.group.id)?.state ===
                                                'cancelling'}
                                        aria-label={m.admin_library_overview_stop_button_aria({
                                            name: row.group.name,
                                        })}
                                        onclick={() => void abortRowScan(row)}>
                                        <Icon src={XMark} class="w-4 h-4" />
                                        {m.admin_library_scan_stop()}
                                    </button>
                                {:else}
                                    <button
                                        class="btn btn-sm btn-ghost text-surface-200 hover:text-green-400 disabled:opacity-50"
                                        aria-label={m.admin_library_overview_scan_button_aria({
                                            name: row.group.name,
                                        })}
                                        disabled={row.folders.length === 0 ||
                                            scan.pendingGroupIds.has(row.group.id)}
                                        onclick={() => void triggerFileScanForRow(row)}>
                                        <Icon src={ArrowPath} class="w-4 h-4" />
                                        {m.admin_library_scan_button()}
                                    </button>
                                {/if}
                            </div>
                        </div>
                    {/if}
                </li>
            {/each}
        </ul>
    {/if}
</div>

<style>
    .library-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 1rem;
        --identity-row: 1;
        --counts-row: 2;
        --scan-row: 3;
        --issues-row: 4;
    }
    .library-row:has(.reorder-controls) {
        --identity-row: 2;
        --counts-row: 3;
        --scan-row: 4;
        --issues-row: 5;
    }
    .library-identity {
        grid-column: 1 / -1;
        grid-row: var(--identity-row);
    }
    .library-counts {
        grid-column: 1;
        grid-row: var(--counts-row);
    }
    .library-last-scan {
        grid-column: 1 / -1;
        grid-row: var(--scan-row);
    }
    .library-issues {
        grid-column: 1 / -1;
        grid-row: var(--issues-row);
    }
    .library-actions {
        grid-column: 2;
        grid-row: var(--counts-row);
        justify-self: end;
    }
    .reorder-controls {
        grid-column: 1 / -1;
        grid-row: 1;
    }
    @media (min-width: 768px) {
        .library-row {
            grid-template-columns: minmax(0, 1.5fr) minmax(7rem, 0.6fr) minmax(0, 1fr) auto;
            align-items: center;
            --counts-row: 1;
            --scan-row: 1;
            --issues-row: 2;
        }
        .library-row:has(.reorder-controls) {
            --counts-row: 2;
            --scan-row: 2;
            --issues-row: 3;
        }
        .library-identity {
            grid-column: 1;
        }
        .library-counts {
            grid-column: 2;
        }
        .library-last-scan {
            grid-column: 3;
        }
        .library-actions {
            grid-column: 4;
        }
        .library-issues {
            grid-column: 3 / -1;
        }
    }
</style>
