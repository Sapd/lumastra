<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  "Needs attention (N)" above the classic task list (spec 2026-09-27 §1.2).
  Rendered only when N > 0. One entry per problem with its action inline:
  the attention board's findings for the Tasks section (Retry / Release /
  Acknowledge … come from AttentionItemRow), page-owned infrastructure
  warnings, and failing tasks the board has no finding for yet — so the count
  here matches the amber rows below it. Replaces this page's header pill.
-->

<script lang="ts">
    import type { Snippet } from 'svelte';
    import * as m from '$lib/paraglide/messages.js';
    import { openDetail } from '$lib/components/admin/detail/detail-url.js';
    import { resolve } from '$lib/paths';
    import { adminStatus } from '$lib/stores/admin-status.store.svelte.js';
    import { sectionForItem } from '$lib/shared/attention-section-map.js';
    import {
        humanizeErrorDurations,
        stripTaskIdPrefix,
    } from '$lib/utils/admin/run-error-display.js';
    import AttentionList from '$lib/components/admin/attention/AttentionList.svelte';
    import type { TaskDefinitionSummary } from '$lib/schemas/task-definition.schema.js';
    import TaskRunButton from './TaskRunButton.svelte';

    interface Props {
        /** Failing tasks without an attention-board finding (`failuresWithoutFinding`). */
        failures: TaskDefinitionSummary[];
        /** Page-owned warnings (file watcher silent, …) and how many rows they render. */
        extra?: Snippet;
        extraCount?: number;
    }

    let { failures, extra, extraCount = 0 }: Props = $props();

    /** An item older than this with no movement reads as permanent decoration. */
    const STALE_MS = 7 * 24 * 60 * 60 * 1000;

    const openItems = $derived(
        (adminStatus.payload?.attention.items ?? []).filter(
            (i) => !i.acked && !i.snoozed && sectionForItem(i) === 'tasks',
        ),
    );
    const count = $derived(openItems.length + failures.length + extraCount);

    const staleHint = $derived(
        openItems.length > 0 &&
            openItems.every(
                (i) =>
                    Date.now() - Date.parse(i.firstSeen) > STALE_MS &&
                    (!i.trend || i.trend.direction === 'flat'),
            ),
    );

    function detailPath(task: TaskDefinitionSummary): string {
        return `/admin/tasks/${encodeURIComponent(task.id)}`;
    }
</script>

{#if count > 0}
    <section
        aria-labelledby="tasks-needs-attention"
        class="mb-6 rounded-xl border border-amber-700/40 bg-amber-950/10 p-4">
        <h2
            id="tasks-needs-attention"
            class="mb-3 flex items-center gap-2 text-base font-semibold text-amber-100">
            <span class="h-2 w-2 rounded-full bg-amber-400" aria-hidden="true"></span>
            {m.admin_tasks_needs_attention({ count })}
        </h2>
        {#if extra}
            <div class="mb-3 space-y-1 rounded border border-amber-500/30 px-2.5 py-2">
                {@render extra()}
            </div>
        {/if}
        {#if failures.length > 0}
            <ul class="mb-3 space-y-2">
                {#each failures as task (task.id)}
                    <li
                        class="flex items-start justify-between gap-3 rounded-lg border border-surface-700/60 bg-surface-900/40 px-3 py-2">
                        <div class="min-w-0">
                            <a
                                href={resolve(detailPath(task))}
                                class="text-sm font-medium text-surface-100 hover:underline"
                                onclick={(e) => {
                                    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey)
                                        return;
                                    e.preventDefault();
                                    openDetail(detailPath(task));
                                }}>{task.name}</a>
                            <p class="mt-0.5 line-clamp-2 text-xs text-amber-300/90">
                                {task.lastFailedError
                                    ? m.admin_tasks_row_failed({
                                          error: humanizeErrorDurations(
                                              stripTaskIdPrefix(task.lastFailedError, task.id),
                                          ),
                                      })
                                    : m.admin_tasks_row_failed_plain({
                                          count: task.recentFailCount ?? 1,
                                      })}
                            </p>
                        </div>
                        <TaskRunButton {task} />
                    </li>
                {/each}
            </ul>
        {/if}
        {#if staleHint}
            <p class="mb-2 text-[11px] text-surface-400">
                {m.admin_attention_section_stale_hint()}
            </p>
        {/if}
        {#if openItems.length > 0}
            <AttentionList section="tasks" showVerdict={false} showHeading={false} />
        {/if}
    </section>
{/if}
