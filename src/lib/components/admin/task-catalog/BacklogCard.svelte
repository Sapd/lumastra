<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount, onDestroy, untrack } from 'svelte';
    import { apiGet } from '$lib/api/client.js';
    import { runSSEBus } from '$lib/stores/run-sse-bus.js';
    import { BacklogResponseSchema } from '$lib/schemas/task-definition.schema.js';
    import type { BacklogResponse } from '$lib/schemas/task-definition.schema.js';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        taskId: string;
        unitLabel?: string;
        /**
         * Lane-level `backlogRemaining` (live `media_item_stage_state`
         * pending count — see `lane-data.ts`), passed down from TaskDetail.
         * Some tasks declare a `backlog.stages()` drill-down that tracks a
         * different signal than `coversStages` (e.g. mal-anime-id-enrichment's
         * drill-down counts `series_grouping_state` rows, while its lane
         * total counts pending `media_item_stage_state` rows) and can
         * legitimately report zero rows here while the lane total is
         * nonzero. Shown as a fallback instead of "doesn't track a backlog"
         * so this tab never contradicts the catalog card sitting next to it.
         */
        fallbackCount?: number;
    }

    let { taskId, unitLabel, fallbackCount }: Props = $props();

    let backlog = $state<BacklogResponse | null>(null);
    let loading = $state(true);
    let loadError = $state<string | null>(null);
    let fetchToken = 0;
    let unsubSSE: (() => void) | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let destroyed = false;

    let effectiveUnitLabel = $derived(
        (backlog?.unitLabel ?? unitLabel) === 'file links'
            ? m.admin_task_backlog_unit_file_links()
            : (backlog?.unitLabel ?? unitLabel ?? 'items'),
    );

    /**
     * Stages a task reports as `id: 'ineligible'` (the convention every
     * built-in backlog uses) are items it will NEVER process — seasons with
     * one episode, tracks with no audio. Summing them into "pending" made the
     * tab say "17 seasons pending" beside an Overview tile reading "Backlog 0",
     * and neither was wrong about its own number.
     */
    let waitingStages = $derived(
        backlog?.stages.filter(
            (s) =>
                s.id !== 'ineligible' && !(taskId === 'trickplay-params-sync' && s.id === 'failed'),
        ) ?? [],
    );
    let ineligibleStages = $derived(backlog?.stages.filter((s) => s.id === 'ineligible') ?? []);
    let failedFileLinks = $derived(
        taskId === 'trickplay-params-sync'
            ? (backlog?.stages.find((s) => s.id === 'failed')?.count ?? 0)
            : 0,
    );
    let totalQueued = $derived(waitingStages.reduce((sum, s) => sum + (s.count ?? 0), 0));
    let totalIneligible = $derived(ineligibleStages.reduce((sum, s) => sum + (s.count ?? 0), 0));

    async function load(): Promise<void> {
        const my = ++fetchToken;
        // A bus-triggered refresh keeps the card on screen; only the first
        // load shows the placeholder.
        loading = backlog === null;

        const { data, error } = await apiGet(
            `/api/tasks/${encodeURIComponent(taskId)}/backlog`,
            BacklogResponseSchema,
        );

        if (my !== fetchToken || destroyed) return;

        if (error || !data) {
            if (backlog === null) loadError = error ?? 'Could not load the backlog';
        } else {
            loadError = null;
            backlog = data;
        }
        loading = false;
    }

    onMount(() => {
        unsubSSE = runSSEBus.onAnyChange(() => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (!destroyed) void load();
            }, 1000);
        });
    });

    onDestroy(() => {
        destroyed = true;
        clearTimeout(debounceTimer);
        unsubSSE?.();
    });

    $effect(() => {
        // Reading taskId makes this effect re-run when the prop changes.
        // $effect fires once on mount, so no separate onMount load() needed.
        // Skip while taskId is missing so the initial render of a parent with
        // a pending prop doesn't request /api/tasks/undefined/backlog.
        if (!taskId) return;
        // untrack: load() reads `backlog` synchronously; tracked, this effect
        // would depend on the state it resets and loop.
        untrack(() => {
            backlog = null;
            void load();
        });
    });
</script>

{#if loading}
    <div class="py-4 text-center text-sm text-surface-500">Loading backlog…</div>
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
{:else if !backlog || backlog.stages.length === 0}
    {#if backlog?.message}
        <p class="text-sm text-surface-500 italic">{backlog.message}</p>
    {:else if fallbackCount !== undefined && fallbackCount > 0}
        <div class="rounded border border-surface-700/40 bg-surface-900/30 p-4 text-sm">
            <p class="text-surface-300">
                {m.admin_task_backlog_estimate_only({
                    count: fallbackCount.toLocaleString(),
                    unit: effectiveUnitLabel,
                })}
            </p>
        </div>
    {:else}
        <div
            class="rounded border border-surface-700/40 bg-surface-900/30 p-6 text-center text-sm text-surface-500">
            This task doesn't track a backlog.
        </div>
    {/if}
{:else}
    <div class="space-y-3">
        <div class="flex items-center justify-between">
            <span class="text-sm text-surface-400">
                {m.admin_task_backlog_waiting({
                    count: totalQueued.toLocaleString(),
                    unit: effectiveUnitLabel,
                })}
            </span>
            {#if backlog.remainingHint !== undefined && backlog.remainingHint !== totalQueued}
                <span class="text-xs text-surface-600">
                    ({backlog.remainingHint.toLocaleString()} total)
                </span>
            {/if}
        </div>

        {#if waitingStages.length > 0}
            <div class="divide-y divide-surface-700/40 rounded border border-surface-700/40">
                {#each waitingStages as stage (stage.id)}
                    <div class="flex items-center justify-between px-3 py-2 text-sm">
                        <span class="text-surface-400">{stage.label}</span>
                        <span class="tabular-nums text-surface-300">
                            {(stage.count ?? 0).toLocaleString()}
                        </span>
                    </div>
                {/each}
            </div>
        {/if}

        {#if totalIneligible > 0}
            <div class="rounded border border-surface-700/40 bg-surface-900/30 p-3 text-sm">
                <p class="text-surface-300">
                    {m.admin_task_backlog_not_processable({
                        count: totalIneligible.toLocaleString(),
                        unit: effectiveUnitLabel,
                    })}
                </p>
                {#each ineligibleStages as stage (stage.id)}
                    <p class="mt-1 text-xs text-surface-500">{stage.label}</p>
                {/each}
            </div>
        {/if}

        {#if failedFileLinks > 0}
            <p class="text-sm text-red-300">
                {m.admin_task_backlog_failed_file_links({
                    count: failedFileLinks.toLocaleString(),
                })}
            </p>
        {/if}

        {#if backlog.message}
            <p class="text-xs text-surface-500 italic">{backlog.message}</p>
        {/if}
    </div>
{/if}
