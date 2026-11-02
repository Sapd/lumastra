<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, QuestionMarkCircle } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';
    import { resourceClassLabel } from '$lib/utils/operator-labels';
    import type { TaskDefinitionSummary } from '$lib/schemas/task-definition.schema.js';

    interface Props {
        task: TaskDefinitionSummary;
        /** Highlights this node — the task whose detail page the user is viewing. */
        current?: boolean;
        /** Developer mode: show internal task ids (spec 2026-09-27 §1.5 — ids only in dev mode). */
        devMode?: boolean;
    }

    let { task, current = false, devMode = false }: Props = $props();

    // Resource-class badge colours for the pipeline visualiser (the task
    // cards that used to share them were retired for the classic list).
    let resourceBadgeClass = $derived.by((): string => {
        switch (task.resourceClass) {
            case 'cpu':
                return 'bg-orange-900/40 text-orange-300 border border-orange-700/40';
            case 'io':
                return 'bg-blue-900/40 text-blue-300 border border-blue-700/40';
            case 'embedding':
                return 'bg-purple-900/40 text-purple-300 border border-purple-700/40';
            case 'maintenance':
                return 'bg-surface-700/60 text-surface-300 border border-surface-600/40';
            default:
                return 'bg-surface-700/60 text-surface-300 border border-surface-600/40';
        }
    });

    let hasCondition = $derived(task.pipeline?.hasWhen === true);
    let isRoot = $derived(!task.pipeline?.after || task.pipeline.after.length === 0);
</script>

<!--
    Click navigates to the task detail page. encodeURIComponent so ids
    containing legal-but-URL-special chars (none today, but defensive)
    route correctly. resolve() prefixes the configured base path.
-->
<a
    href={resolve(`/admin/tasks/${encodeURIComponent(task.id)}`)}
    class="block h-full w-full rounded border bg-surface-900/60 px-3 py-2 no-underline transition-colors hover:bg-surface-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 {current
        ? 'border-amber-500/60 ring-1 ring-amber-500/40 bg-surface-900/80'
        : 'border-surface-700/60 hover:border-surface-600/80'}"
    aria-label="{task.name} ({task.resourceClass
        ? resourceClassLabel(task.resourceClass)
        : 'unspecified'}{hasCondition ? ', only runs when needed' : ''}{current
        ? ', current page'
        : ''}) — open task"
    aria-current={current ? 'page' : undefined}>
    <!-- Header row: name + resource badge -->
    <div class="flex items-start gap-2">
        <span
            class="text-xs font-semibold text-surface-100 truncate min-w-0 flex-1"
            title={task.name}>
            {task.name}
        </span>
        {#if task.resourceClass}
            <span
                class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight {resourceBadgeClass}"
                title="Uses: {resourceClassLabel(task.resourceClass)}">
                {resourceClassLabel(task.resourceClass)}
            </span>
        {/if}
    </div>

    <!-- Meta row: id (developer mode only) + condition/root indicator -->
    <div class="mt-1 flex items-center gap-1.5 text-[10px] text-surface-500 font-mono min-w-0">
        <span class="truncate min-w-0 flex-1" title={devMode ? task.id : undefined}
            >{devMode ? task.id : ''}</span>
        {#if isRoot}
            <span
                class="shrink-0 rounded bg-surface-800 px-1 py-0.5 text-[9px] font-sans font-medium text-surface-400 border border-surface-700/40"
                title="First step — runs first">
                start
            </span>
        {/if}
        {#if hasCondition}
            <span
                class="shrink-0 inline-flex items-center text-amber-400"
                title="Only runs when needed — the system decides based on the result of the previous step"
                aria-label="Only runs when needed">
                <Icon src={QuestionMarkCircle} class="h-3.5 w-3.5" />
            </span>
        {/if}
    </div>
</a>
