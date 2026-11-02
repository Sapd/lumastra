<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { apiGet } from '$lib/api/client.js';
    import {
        TaskListResponseSchema,
        type TaskDefinitionSummary,
    } from '$lib/schemas/task-definition.schema.js';
    import PipelineCanvas from './PipelineCanvas.svelte';
    import {
        layoutPipeline,
        resolvePipelineRootId,
        type LaidOutPipeline,
    } from './pipeline-layout.js';

    interface Props {
        /**
         * The task whose detail page contains this section. The component
         * derives the pipeline root from this task (via `pipeline.of` if
         * present, otherwise the task itself is the root).
         */
        task: TaskDefinitionSummary;
        /** Developer mode: show internal task ids (spec 2026-09-27 §1.5 — ids only in dev mode). */
        devMode?: boolean;
    }

    let { task, devMode = false }: Props = $props();

    let allTasks = $state<TaskDefinitionSummary[] | null>(null);
    let loading = $state(true);
    let loadError = $state<string | null>(null);
    let fetchToken = 0;
    let destroyed = false;

    let rootId = $derived(resolvePipelineRootId(task));

    // Layout is purely a function of the loaded task list. We compute it
    // synchronously inside a $derived so it stays in lockstep with both
    // the task list and the current task — no manual cache invalidation.
    let layout = $derived<LaidOutPipeline | null>(
        allTasks ? layoutPipeline(rootId, allTasks) : null,
    );

    async function load(): Promise<void> {
        const my = ++fetchToken;
        loading = true;
        loadError = null;

        const { data, error } = await apiGet('/api/tasks', TaskListResponseSchema);

        if (my !== fetchToken || destroyed) return;

        if (error || !data) {
            loadError = error ?? 'Could not load the task list';
        } else {
            allTasks = data.items;
        }
        loading = false;
    }

    onMount(() => {
        void load();
    });

    onDestroy(() => {
        destroyed = true;
    });
</script>

<section>
    <h2 class="mb-3 text-sm font-semibold text-surface-300 uppercase tracking-wide">Pipeline</h2>

    {#if loading}
        <div
            class="rounded border border-surface-700/40 bg-surface-900/30 py-8 text-center text-sm text-surface-500">
            Loading pipeline…
        </div>
    {:else if loadError}
        <div
            class="rounded border border-red-700/30 bg-red-900/20 p-3 text-sm text-red-300 flex items-center gap-3">
            <span class="flex-1">{loadError}</span>
            <button
                type="button"
                class="btn btn-sm variant-ghost-surface"
                onclick={() => void load()}>
                Retry
            </button>
        </div>
    {:else if !layout}
        <div
            class="rounded border border-surface-700/40 bg-surface-900/30 p-4 text-sm text-surface-500">
            No registered tasks belong to pipeline
            <code class="font-mono text-surface-400">{rootId}</code>.
        </div>
    {:else}
        <div class="mb-2 flex items-baseline justify-between text-xs text-surface-500">
            <span>
                Pipeline
                <code class="font-mono text-surface-400">{rootId}</code>
                · {layout.members.length} stage{layout.members.length === 1 ? '' : 's'}
            </span>
        </div>
        <PipelineCanvas {layout} currentTaskId={task.id} {devMode} />
    {/if}
</section>
