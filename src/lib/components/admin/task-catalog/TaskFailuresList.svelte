<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount, onDestroy, untrack } from 'svelte';
    import { SvelteSet } from 'svelte/reactivity';
    import * as m from '$lib/paraglide/messages.js';
    import { resolve } from '$lib/paths';
    import { ADMIN_FILE_HEALTH_PATH } from '$lib/shared/admin-media-links.js';
    import { apiGet, apiPost } from '$lib/api/client.js';
    import { runSSEBus } from '$lib/stores/run-sse-bus.js';
    import { toasts } from '$lib/stores/toast.store.js';
    import { awaitFileHealthRecheck, cancelRun } from '$lib/api/admin.js';
    import {
        fileHealthIssueLabel,
        fileHealthRecheckMessage,
    } from '$lib/utils/file-health-issue.js';
    import { taskRetryResponseSchema } from '$lib/schemas/admin.js';
    import {
        FailuresResponseSchema,
        FailureTimelineResponseSchema,
    } from '$lib/schemas/task-definition.schema.js';
    import type {
        FailureItem,
        FailureTimelineResponse,
    } from '$lib/schemas/task-definition.schema.js';
    import { formatFailureTimelineForGithub } from '$lib/shared/failure-timeline-report.js';
    import { StageActionResponseSchema } from '$lib/schemas/api-attention-responses.js';
    import { humanizeErrorDurations } from '$lib/utils/admin/run-error-display.js';
    import { modals } from '$lib/stores/modal.store';
    import ConfirmModal from '$lib/components/ui/ConfirmModal.svelte';

    /**
     * A failure row's title, never a bare UUID.
     *
     * `getFailureItemTitles` resolves `item_id` to a real title, and its own
     * docstring notes that ids it cannot resolve — item deleted, unrecognized
     * shape — are absent, "callers fall back to the raw id". That fallback put
     * `3d7aa735-c0e5-4b93-88df-1650bd68e0cc` on screen where a film name goes,
     * which tells an operator nothing at all.
     *
     * Unresolvable-and-UUID-shaped means precisely one thing: the media row is
     * gone. Saying so is both honest and actionable — the failure refers to
     * something no longer in the library, so it can be dismissed. A non-UUID id
     * is a plugin's OWN key (a path, a composite) and may well be meaningful,
     * so that is still shown as-is. The full id stays in the row's `title`
     * attribute and its History link either way.
     */
    const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    function itemLabel(item: { title?: string | null; itemId: string }): string {
        if (item.title) return item.title;
        const lookup = item.itemId.includes('|') ? item.itemId.split('|', 1)[0] : item.itemId;
        return UUID_SHAPED.test(lookup) ? m.admin_failures_item_gone() : item.itemId;
    }
    import { failureReasonLabel } from '$lib/utils/operator-labels.js';

    interface Props {
        taskId: string;
        /** Whether the task definition declares per-item retry support */
        supportsRetry?: boolean;
        /**
         * Pipeline stages the task covers. A task without per-item retry can
         * still hand its failed items back through the stage-wide retry
         * (`failed_permanent` → `pending`); the attention finding that links
         * here promises exactly that, and this list used to offer no way to
         * do it.
         */
        coveredStageIds?: readonly string[];
    }

    let { taskId, supportsRetry = false, coveredStageIds = [] }: Props = $props();

    /** Readable reason: plain-language label, milliseconds as minutes. */
    function reasonText(reason: string): string {
        if (taskId === 'media-probe') {
            const type = reason.split(' ')[0];
            const label = fileHealthIssueLabel(type);
            if (label !== type) return label;
        }
        return humanizeErrorDurations(failureReasonLabel(reason));
    }

    /**
     * The loaded items grouped by reason, most common first. The Failure
     * patterns panel above groups RUN failures inside a time window; this
     * groups the unresolved ITEMS on screen, whatever their age — which is
     * what "54 items failed with 2 causes" needs.
     */
    let causes = $derived.by((): Array<{ reason: string; count: number }> => {
        // Rebuilt fresh on every recomputation, never held as state.
        // eslint-disable-next-line svelte/prefer-svelte-reactivity
        const counts = new Map<string, number>();
        for (const f of failures) {
            const key = f.reason ? reasonText(f.reason) : '—';
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return [...counts.entries()]
            .map(([reason, count]) => ({ reason, count }))
            .sort((a, b) => b.count - a.count);
    });

    let retryingAll = $state(false);

    async function doRetryAll(): Promise<void> {
        if (retryingAll) return;
        retryingAll = true;
        try {
            // Every stage is tried even if one fails: stopping at the first
            // error left the earlier resets unreported and the rest untried.
            let reset = 0;
            let firstError: string | null = null;
            for (const stageId of coveredStageIds) {
                const { data, error } = await apiPost(
                    '/api/admin/task-system/pipeline/retry-stage',
                    StageActionResponseSchema,
                    { stageId },
                );
                if (error || !data) {
                    firstError ??= error ?? '';
                    continue;
                }
                reset += data.count;
            }
            if (reset > 0) toasts.success(m.admin_task_failures_retry_all_done({ count: reset }));
            if (firstError !== null) {
                toasts.error(m.admin_task_failures_retry_all_error({ error: firstError }));
            } else if (reset === 0) {
                toasts.info(m.admin_task_failures_retry_all_none());
            }
            await load();
        } finally {
            retryingAll = false;
        }
    }

    function retryAll(): void {
        modals.open(ConfirmModal, {
            title: m.admin_task_failures_retry_all(),
            body: m.admin_task_failures_retry_all_body(),
            confirmText: m.admin_task_failures_retry_all(),
            confirmVariant: 'primary',
            onConfirm: () => doRetryAll(),
        });
    }

    const PAGE_SIZE = 50;

    let failures = $state<FailureItem[]>([]);
    let total = $state(0);
    let nextCursor = $state<string | undefined>(undefined);
    let loading = $state(true);
    let loadError = $state<string | null>(null);
    let loadingMore = $state(false);
    let retrying = new SvelteSet<string>();
    let recheckRuns = $state<Record<string, string>>({});
    let recheckResults = $state<Record<string, string>>({});
    let recheckLabels = $state<Record<string, string>>({});
    const retryControllers: Record<string, AbortController> = {};
    let taskEpoch = 0;

    async function cancelRecheck(itemId: string): Promise<void> {
        const runId = recheckRuns[itemId];
        const attempt = retryControllers[itemId];
        const epoch = taskEpoch;
        if (!runId || !attempt) return;
        const { data, error } = await cancelRun(runId);
        if (
            !destroyed &&
            epoch === taskEpoch &&
            retryControllers[itemId] === attempt &&
            (error || !data?.accepted)
        )
            recheckResults[itemId] = m.admin_health_recheck_cancel_error();
    }
    let expandedItemId = $state<string | null>(null);
    let historyLoading = $state(false);
    let historyError = $state<string | null>(null);
    let history = $state<FailureTimelineResponse | null>(null);
    let fetchToken = 0;
    let moreToken = 0;
    // A refresh or load-more that failed while rows are on screen: keep the
    // rows and say so, instead of replacing the list with an error box.
    let refreshError = $state<string | null>(null);
    let unsubSSE: (() => void) | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let destroyed = false;

    function formatDate(val: string | Date): string {
        const d = typeof val === 'string' ? new Date(val) : val;
        if (isNaN(d.getTime())) return '—';
        return d.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    async function load(cursor?: string): Promise<void> {
        // Separate tokens: a bus-triggered refresh (any run event, any task)
        // must not discard a "load more" the operator just clicked.
        const my = cursor ? ++moreToken : ++fetchToken;
        const initiatingTask = taskId;
        const epoch = taskEpoch;

        if (!cursor) {
            // Only the first load shows the placeholder; a background refresh
            // with rows on screen must not swap them out (and collapse the
            // open history) on every run event.
            loading = failures.length === 0;
        } else {
            loadingMore = true;
        }

        // A refresh re-reads as many rows as are loaded (server cap 200), so
        // pages added with "load more" survive it.
        const pageLimit = cursor ? PAGE_SIZE : Math.min(200, Math.max(PAGE_SIZE, failures.length));
        const params: Record<string, string> = { limit: String(pageLimit) };
        if (cursor) params.cursor = cursor;

        const { data, error } = await apiGet(
            `/api/tasks/${encodeURIComponent(initiatingTask)}/failures`,
            FailuresResponseSchema,
            { params },
        );

        if (
            epoch !== taskEpoch ||
            initiatingTask !== taskId ||
            my !== (cursor ? moreToken : fetchToken) ||
            destroyed
        )
            return;

        if (error || !data) {
            const message = error ?? 'Could not load failures';
            if (!cursor && failures.length === 0) loadError = message;
            else refreshError = message;
        } else {
            loadError = null;
            refreshError = null;
            if (cursor) {
                // Dedup on append: a cursor page can re-include a failure already loaded
                // if rows shifted between fetches, which would throw each_key_duplicate.
                const existingFailureIds = new Set(failures.map((f) => f.id));
                failures = [
                    ...failures,
                    ...data.items.filter((f) => !existingFailureIds.has(f.id)),
                ];
            } else {
                failures = data.items;
            }
            total = data.page.total;
            nextCursor = data.page.nextCursor;
        }

        if (cursor) loadingMore = false;
        else loading = false;
    }

    async function retry(item: FailureItem): Promise<void> {
        if (retrying.has(item.id)) return;
        retrying.add(item.id);
        const initiatingTask = taskId;
        const epoch = taskEpoch;
        delete recheckRuns[item.id];
        delete recheckResults[item.id];
        delete recheckLabels[item.id];
        const controller = new AbortController();
        retryControllers[item.id] = controller;
        const current = (): boolean =>
            !destroyed &&
            epoch === taskEpoch &&
            initiatingTask === taskId &&
            retryControllers[item.id] === controller;
        try {
            const { data, error } = await apiPost(
                `/api/tasks/${encodeURIComponent(initiatingTask)}/failures/${encodeURIComponent(item.itemId)}/retry`,
                taskRetryResponseSchema,
                {},
                initiatingTask === 'media-probe' ? { signal: controller.signal } : undefined,
            );
            if (!current()) return;
            if (initiatingTask === 'media-probe' && data?.runId && !error) {
                recheckRuns[item.id] = data.runId;
                recheckLabels[item.id] = itemLabel(item);
                recheckResults[item.id] = m.admin_health_rechecking();
                const result = await awaitFileHealthRecheck(
                    item.itemId,
                    data.runId,
                    controller.signal,
                );
                if (!current()) return;
                const message =
                    result.error ??
                    (result.data
                        ? fileHealthRecheckMessage(result.data)
                        : m.admin_health_recheck_error());
                recheckResults[item.id] = message;
                if (result.error || result.data?.outcome === 'error') toasts.error(message);
                else if (result.data?.outcome === 'healthy') toasts.success(message);
                else toasts.info(message);
                await load();
                return;
            }
            // The endpoint answers 200 with `retried: false` when the retry ran
            // and failed again, or another retry holds the item's lock. Only a
            // real retry removes the row.
            if (error || !data) {
                toasts.error(`Retry failed: ${error ?? m.admin_err_server()}`);
            } else if (!data.retried) {
                toasts.error(`Retry failed: ${data.itemReason ?? data.message}`);
            } else {
                toasts.success('Retry queued');
                failures = failures.filter((f) => f.id !== item.id);
                total = Math.max(0, total - 1);
            }
        } finally {
            if (current()) {
                delete retryControllers[item.id];
                retrying.delete(item.id);
            }
        }
    }

    async function toggleHistory(item: FailureItem): Promise<void> {
        if (expandedItemId === item.itemId) {
            expandedItemId = null;
            history = null;
            historyError = null;
            return;
        }

        const epoch = taskEpoch;
        expandedItemId = item.itemId;
        history = null;
        historyError = null;
        historyLoading = true;

        const { data, error } = await apiGet(
            `/api/tasks/${encodeURIComponent(taskId)}/failures/${encodeURIComponent(item.itemId)}/history`,
            FailureTimelineResponseSchema,
            {},
        );

        // The user may have collapsed/switched items while the request was in flight.
        if (epoch !== taskEpoch || expandedItemId !== item.itemId || destroyed) return;

        if (error || !data) {
            historyError = error ?? 'Could not load failure history';
        } else {
            history = data;
        }
        historyLoading = false;
    }

    async function copyHistory(): Promise<void> {
        if (!history) return;
        const text = formatFailureTimelineForGithub(
            history.pluginId,
            history.itemId,
            history.events,
            history.truncated,
        );
        await navigator.clipboard.writeText(text);
        toasts.success('Failure history copied for GitHub');
    }

    onMount(() => {
        unsubSSE = runSSEBus.onAnyChange(() => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (!destroyed) void load();
            }, 600);
        });
    });

    onDestroy(() => {
        destroyed = true;
        for (const controller of Object.values(retryControllers)) controller.abort();
        clearTimeout(debounceTimer);
        unsubSSE?.();
    });

    $effect(() => {
        // Reading taskId makes this effect re-run when the prop changes.
        // $effect fires once on mount, so no separate onMount load() needed.
        // Skip while taskId is missing.
        const selectedTask = taskId;
        // untrack: load() reads `failures` synchronously; tracked, this effect
        // would depend on the state it resets and loop.
        untrack(() => {
            taskEpoch++;
            for (const controller of Object.values(retryControllers)) controller.abort();
            for (const id of Object.keys(retryControllers)) delete retryControllers[id];
            retrying.clear();
            recheckRuns = {};
            recheckResults = {};
            recheckLabels = {};
            expandedItemId = null;
            history = null;
            historyError = null;
            loadError = null;
            refreshError = null;
            failures = [];
            total = 0;
            nextCursor = undefined;
            if (selectedTask) void load();
            else loading = false;
        });
    });
</script>

{#each Object.entries(recheckResults) as [id, message] (id)}
    <div role="status" class="mb-2 text-xs text-surface-300">
        <span class="font-medium">{recheckLabels[id]}</span>
        {message}
        {#if recheckRuns[id]}<a
                class="text-sky-400 underline"
                href="{resolve('/admin/tasks/runs')}?run={encodeURIComponent(recheckRuns[id])}"
                >{m.admin_health_recheck_run()}</a
            >{/if}
    </div>
{/each}
{#if refreshError && !loading}
    <p class="mb-2 text-xs text-amber-300" role="status">{refreshError}</p>
{/if}
{#if loading}
    <div class="py-6 text-center text-sm text-surface-500">Loading failures…</div>
{:else if loadError}
    <div class="rounded border border-red-700/30 bg-red-900/20 p-3 text-sm text-red-300">
        {loadError}
        <button
            type="button"
            class="ml-3 text-xs text-red-200 underline"
            onclick={() => void load()}>
            Retry
        </button>
    </div>
{:else if failures.length === 0}
    <div
        class="rounded border border-surface-700/40 bg-surface-900/30 p-6 text-center text-sm text-surface-500">
        {m.admin_task_failed_items_empty()}
    </div>
{:else}
    <div class="mb-3 space-y-2 text-xs text-surface-500">
        <div class="flex flex-wrap items-center gap-2">
            <span class="flex-1"
                >{#if taskId === 'media-probe'}{m.admin_probe_history_count({
                        shown: failures.length,
                        total,
                    })}{:else}Showing {failures.length} of {total} unresolved items{/if}</span>
            {#if !supportsRetry && coveredStageIds.length > 0}
                <button
                    type="button"
                    class="rounded border border-amber-700/40 bg-amber-900/30 px-2 py-1 font-medium text-amber-300 hover:bg-amber-900/50 disabled:opacity-50"
                    disabled={retryingAll}
                    onclick={retryAll}>
                    {retryingAll
                        ? m.admin_task_failures_retrying()
                        : m.admin_task_failures_retry_all()}
                </button>
            {/if}
        </div>
        {#if taskId === 'media-probe'}
            <p>
                {m.admin_probe_history_note()}
                <a
                    href={resolve(ADMIN_FILE_HEALTH_PATH)}
                    class="text-sky-400 underline underline-offset-2"
                    >{m.admin_probe_history_current()}</a>
            </p>
        {/if}
        {#if !supportsRetry && coveredStageIds.length === 0}
            <p>{m.admin_task_failures_no_retry()}</p>
        {/if}
        {#if causes.length > 1 || (causes.length === 1 && failures.length > 1)}
            <div>
                <span class="font-medium text-surface-400"
                    >{m.admin_task_failures_by_cause({ shown: failures.length })}</span>
                <ul class="mt-1 space-y-0.5">
                    {#each causes.slice(0, 5) as cause (cause.reason)}
                        <li class="text-surface-300">
                            <span class="font-medium text-surface-200">{cause.count}×</span>
                            {cause.reason}
                        </li>
                    {/each}
                </ul>
            </div>
        {/if}
    </div>

    <div class="divide-y divide-surface-700/40 rounded border border-surface-700/40">
        {#each failures as item (item.id)}
            <div class="px-4 py-3 text-sm">
                <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0 flex-1 space-y-0.5">
                        <p class="truncate font-medium text-surface-200" title={item.itemId}>
                            {itemLabel(item)}
                        </p>
                        {#if item.reason}
                            <p class="text-xs text-red-400 line-clamp-2">
                                {reasonText(item.reason)}
                            </p>
                        {/if}
                        <p class="text-xs text-surface-500">
                            {#if taskId === 'media-probe'}{m.admin_probe_history_recorded({
                                    date: formatDate(item.occurredAt),
                                })}{:else}{formatDate(item.occurredAt)}{/if}
                            {#if item.failureCount && item.failureCount > 1}
                                · {#if taskId === 'media-probe'}{m.admin_probe_history_repeated({
                                        count: item.failureCount,
                                    })}{:else}failed {item.failureCount}×{/if}
                            {/if}
                            {#if item.runId}
                                · from run
                                <a
                                    href="{resolve('/admin/tasks/runs')}?run={item.runId}"
                                    class="text-surface-400 underline underline-offset-2 hover:text-surface-200 transition-colors"
                                    >{item.runId.slice(0, 8)}</a>
                            {/if}
                        </p>
                    </div>

                    <div class="flex shrink-0 items-center gap-2">
                        <button
                            type="button"
                            class="rounded bg-surface-700/40 px-2 py-1 text-xs font-medium text-surface-300 transition-colors hover:bg-surface-700/60 border border-surface-600/40"
                            onclick={() => void toggleHistory(item)}>
                            {expandedItemId === item.itemId
                                ? m.admin_task_failures_hide_history()
                                : m.admin_task_failures_history()}
                        </button>
                        {#if supportsRetry}
                            {#if retrying.has(item.id) && recheckRuns[item.id]}
                                <button
                                    type="button"
                                    class="text-xs text-surface-300"
                                    onclick={() => void cancelRecheck(item.id)}
                                    >{m.common_cancel()}</button>
                            {/if}
                            <button
                                type="button"
                                class="rounded bg-amber-900/30 px-2 py-1 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-900/50 disabled:cursor-not-allowed disabled:opacity-50 border border-amber-700/30"
                                onclick={() => retry(item)}
                                disabled={retrying.has(item.id)}
                                aria-busy={retrying.has(item.id)}>
                                {retrying.has(item.id)
                                    ? m.admin_task_failures_retrying()
                                    : m.admin_task_failures_retry()}
                            </button>
                        {/if}
                    </div>
                </div>

                {#if expandedItemId === item.itemId}
                    <div class="mt-3 rounded border border-surface-700/40 bg-surface-900/40 p-3">
                        {#if historyLoading}
                            <div class="text-xs text-surface-500">Loading history…</div>
                        {:else if historyError}
                            <div class="text-xs text-red-400">{historyError}</div>
                        {:else if history}
                            <div class="mb-2 flex items-center justify-between gap-3">
                                <span class="text-xs text-surface-500">
                                    {history.events.length}
                                    {history.events.length === 1 ? 'event' : 'events'} recorded
                                    {#if history.truncated}
                                        · older events not shown
                                    {/if}
                                </span>
                                <button
                                    type="button"
                                    class="rounded bg-surface-700/40 px-2 py-1 text-xs font-medium text-surface-300 transition-colors hover:bg-surface-700/60 border border-surface-600/40 disabled:cursor-not-allowed disabled:opacity-50"
                                    disabled={history.events.length === 0}
                                    onclick={() => void copyHistory()}>
                                    Copy for GitHub
                                </button>
                            </div>
                            {#if history.events.length === 0}
                                <div class="text-xs text-surface-500">No recorded failures.</div>
                            {:else}
                                <ol class="space-y-2">
                                    {#each history.events as event (event.id)}
                                        <li class="text-xs">
                                            <span class="text-surface-500"
                                                >{formatDate(event.occurredAt)}</span>
                                            {#if event.inputScope}<span
                                                    class="text-xs text-surface-400"
                                                    >{event.inputScope === 'current'
                                                        ? m.media_source_failure_current()
                                                        : event.inputScope === 'earlier'
                                                          ? m.media_source_failure_earlier()
                                                          : m.media_source_failure_unverified()}</span
                                                >{/if}
                                            {#if event.runId}<a
                                                    class="ml-2 text-sky-400 underline"
                                                    href={resolve(
                                                        `/admin/tasks/runs?run=${encodeURIComponent(event.runId)}`,
                                                    )}>{m.media_sync_analysis_view_run()}</a
                                                >{/if}
                                            {#if event.reason}
                                                <span class="text-red-400">
                                                    — {reasonText(event.reason)}</span>
                                            {/if}
                                        </li>
                                    {/each}
                                </ol>
                            {/if}
                        {/if}
                    </div>
                {/if}
            </div>
        {/each}
    </div>

    {#if nextCursor}
        <div class="mt-3 text-center">
            <button
                type="button"
                class="btn btn-sm variant-ghost-surface"
                disabled={loadingMore}
                onclick={() => {
                    const cursor = nextCursor;
                    if (cursor) void load(cursor);
                }}>
                {loadingMore ? m.common_loading_ellipsis() : m.section_load_more()}
            </button>
        </div>
    {/if}
{/if}
