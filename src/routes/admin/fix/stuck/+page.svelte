<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  /admin/fix/stuck — is the pipeline wedged, or just working through a backlog?

  ## The verdict comes first, and everything else is its evidence

  This page was a signpost: it listed places to look and checked nothing. That is
  the worst thing this surface can be, because an operator reads a checklist,
  believes it was checked, and stops looking. It is now a diagnostic, and the
  promise that makes is that every number below was measured on THIS instance.

  ## Why the verdict is server-computed

  The endpoint decides. If this page re-derived the verdict from the same
  evidence it would eventually derive a different one, and the operator would get
  two answers from one instance — the same reason `library-scan-check` reports a
  `PathProbe.state` rather than a raw errno and lets the page render it.

  ## The reassurance is gated on measurement, and so is the alarm

  "Slow" and "stuck" look identical from outside. The only thing that separates
  them is whether anything is COMPLETING, so `moving` says so with the actual
  count rather than a generic "please wait". `stalled` is deliberately the last
  resort: it is only reported once no worker problem and no paused task explains
  the silence, so it never sends someone hunting for a bug that is really a
  switch they flipped last week.
-->
<script lang="ts">
    import {
        Icon,
        ArrowPath,
        ExclamationTriangle,
        CheckCircle,
        PauseCircle,
    } from 'svelte-hero-icons';
    import FixPageShell from '$lib/components/admin/fix/FixPageShell.svelte';
    import AsyncSection from '$lib/components/admin/AsyncSection.svelte';
    import { findSymptom } from '$lib/components/admin/fix/symptoms.js';
    import {
        StuckCheckSchema,
        type StuckCheck,
    } from '$lib/components/admin/fix/stuck-check.schema.js';
    import { apiGet } from '$lib/api/client.js';
    import { classifyError, type ClassifiedError } from '$lib/utils/admin/error-contract.js';
    import { resolve } from '$lib/paths';
    import { resourceClassLabel } from '$lib/utils/operator-labels';
    import * as m from '$lib/paraglide/messages.js';

    const symptom = findSymptom('stuck');

    let check = $state<StuckCheck | null>(null);
    let loading = $state(false);
    let loadError = $state<ClassifiedError | null>(null);

    async function load(): Promise<void> {
        loading = true;
        loadError = null;
        const res = await apiGet('/api/admin/fix/stuck-check', StuckCheckSchema, { strict: true });
        loading = false;
        if (res.data) {
            check = res.data;
        } else if (res.error) {
            loadError = classifyError(new Error(res.error), { status: res.status });
        }
    }

    $effect(() => {
        void load();
    });

    function checkLabel(c: StuckCheck['checksFailed'][number]): string {
        switch (c) {
            case 'pending':
                return m.admin_fix_stuck_check_pending();
            case 'scheduler':
                return m.admin_fix_stuck_check_scheduler();
            case 'worker':
                return m.admin_fix_stuck_check_worker();
            default:
                return m.admin_fix_stuck_check_queues();
        }
    }

    /** Seconds → the coarsest unit that is still honest. */
    function age(seconds: number | null): string {
        if (seconds === null) return m.admin_fix_stuck_none();
        if (seconds < 90) return `${Math.round(seconds)}s`;
        if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
        return `${Math.round(seconds / 3600)}h`;
    }

    const verdictTone = $derived.by(() => {
        switch (check?.verdict) {
            case 'idle':
            case 'moving':
                return {
                    icon: CheckCircle,
                    ring: 'border-success-700/60 bg-success-900/20',
                    tint: 'text-success-300',
                };
            case 'paused':
                return {
                    icon: PauseCircle,
                    ring: 'border-warning-700/60 bg-warning-900/20',
                    tint: 'text-warning-300',
                };
            default:
                return {
                    icon: ExclamationTriangle,
                    ring: 'border-error-700/60 bg-error-900/20',
                    tint: 'text-error-300',
                };
        }
    });

    const verdictTitle = $derived.by(() => {
        if (!check) return '';
        switch (check.verdict) {
            case 'idle':
                return m.admin_fix_stuck_verdict_idle_title();
            case 'moving':
                return m.admin_fix_stuck_verdict_moving_title();
            case 'no-worker':
                return m.admin_fix_stuck_verdict_no_worker_title();
            case 'paused':
                return m.admin_fix_stuck_verdict_paused_title();
            default:
                return m.admin_fix_stuck_verdict_stalled_title();
        }
    });

    const verdictBody = $derived.by(() => {
        if (!check) return '';
        const minutes = check.windowMinutes;
        switch (check.verdict) {
            case 'idle':
                return m.admin_fix_stuck_verdict_idle_body();
            case 'moving':
                return m.admin_fix_stuck_verdict_moving_body({
                    completed: check.completedInWindow,
                    minutes,
                });
            case 'no-worker':
                return m.admin_fix_stuck_verdict_no_worker_body();
            case 'paused':
                return m.admin_fix_stuck_verdict_paused_body({
                    minutes,
                    count: check.blockingPauses,
                });
            default:
                return m.admin_fix_stuck_verdict_stalled_body({ minutes });
        }
    });
</script>

{#if symptom}
    <FixPageShell title={symptom.title()} icon={symptom.icon}>
        <div class="flex justify-end">
            <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded border border-surface-700 px-2.5 py-1 text-xs text-surface-300 hover:bg-surface-800 disabled:opacity-50"
                disabled={loading}
                onclick={() => void load()}>
                <Icon src={ArrowPath} class="h-3.5 w-3.5 {loading ? 'animate-spin' : ''}" />
                {m.admin_fix_stuck_refresh()}
            </button>
        </div>

        <AsyncSection {loading} error={loadError} onretry={() => void load()}>
            {#if check}
                <div class="space-y-6">
                    <div class="rounded-lg border p-4 {verdictTone.ring}">
                        <div class="flex items-start gap-3">
                            <Icon
                                src={verdictTone.icon}
                                class="mt-0.5 h-5 w-5 shrink-0 {verdictTone.tint}" />
                            <div class="space-y-1">
                                <p class="text-sm font-medium text-surface-100">{verdictTitle}</p>
                                <p class="text-sm leading-relaxed text-surface-300">
                                    {verdictBody}
                                </p>
                            </div>
                        </div>
                    </div>

                    {#if check.checksFailed.length > 0}
                        <p
                            role="alert"
                            class="flex items-start gap-2 rounded border border-warning-700/60 bg-warning-900/20 p-3 text-sm text-warning-200">
                            <Icon src={ExclamationTriangle} class="mt-px h-4 w-4 shrink-0" />
                            <span>
                                {m.admin_fix_stuck_checks_failed({
                                    checks: check.checksFailed.map(checkLabel).join(', '),
                                })}
                            </span>
                        </p>
                    {/if}

                    <section class="space-y-2">
                        <h2 class="text-sm font-medium text-surface-200">
                            {m.admin_fix_stuck_measured_heading()}
                        </h2>
                        <dl class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                            <div>
                                <dt class="text-xs text-surface-400">
                                    {m.admin_fix_stuck_completed_label({
                                        minutes: check.windowMinutes,
                                    })}
                                </dt>
                                <dd class="tabular-nums text-surface-100">
                                    {check.completedInWindow}
                                </dd>
                            </div>
                            <div>
                                <dt class="text-xs text-surface-400">
                                    {m.admin_fix_stuck_inflight_label()}
                                </dt>
                                <dd class="tabular-nums text-surface-100">{check.inFlight}</dd>
                            </div>
                            <div>
                                <dt class="text-xs text-surface-400">
                                    {m.admin_fix_stuck_running_label()}
                                </dt>
                                <dd class="tabular-nums text-surface-100">{check.running}</dd>
                            </div>
                            <div>
                                <dt class="text-xs text-surface-400">
                                    {m.admin_fix_stuck_oldest_label()}
                                </dt>
                                <dd class="tabular-nums text-surface-100">
                                    {age(check.oldestPendingAgeSec)}
                                </dd>
                            </div>
                            <div>
                                <dt class="text-xs text-surface-400">
                                    {m.admin_fix_stuck_deadletter_label()}
                                </dt>
                                <dd class="tabular-nums text-surface-100">
                                    {check.deadLetterItems}
                                </dd>
                            </div>
                            <div>
                                <dt class="text-xs text-surface-400">
                                    {m.admin_fix_stuck_degraded_label()}
                                </dt>
                                <dd class="tabular-nums text-surface-100">{check.degradedItems}</dd>
                            </div>
                            <div class="col-span-2 sm:col-span-3">
                                <dt class="text-xs text-surface-400">
                                    {m.admin_fix_stuck_worker_label()}
                                </dt>
                                <dd
                                    class="text-surface-100 {check.workerAvailable
                                        ? ''
                                        : 'text-error-300'}">
                                    {check.workerSource === 'probe-failed'
                                        ? m.admin_fix_stuck_worker_unknown()
                                        : check.workerAvailable
                                          ? m.admin_fix_stuck_worker_yes({
                                                source: check.workerSource,
                                            })
                                          : m.admin_fix_stuck_worker_no({
                                                source: check.workerSource,
                                            })}
                                </dd>
                            </div>
                        </dl>
                    </section>

                    {#if check.pausedTasks.length > 0 || check.pausedQueues.length > 0}
                        <section class="space-y-2">
                            <h2 class="text-sm font-medium text-surface-200">
                                {m.admin_fix_stuck_paused_heading()}
                            </h2>
                            <p class="text-xs text-surface-400">
                                {m.admin_fix_stuck_paused_note()}
                            </p>
                            <ul class="flex flex-wrap gap-1.5">
                                {#each check.pausedTasks as taskId (taskId)}
                                    <li>
                                        <!--
                                          `resolve()` takes a bare path, so the
                                          dynamic segment is appended after it —
                                          the same split `signposts.ts` makes for
                                          its query strings, and for the same
                                          reason: hand-spelling the base path has
                                          already caused a production bug here.
                                        -->
                                        <a
                                            href={`${resolve('/admin/tasks')}/${encodeURIComponent(taskId)}`}
                                            class="inline-block rounded bg-surface-800 px-2 py-0.5 font-mono text-xs text-surface-200 hover:bg-surface-700">
                                            {taskId}
                                        </a>
                                    </li>
                                {/each}
                                {#each check.pausedQueues as lane (lane)}
                                    <li>
                                        <span
                                            class="inline-block rounded bg-surface-800 px-2 py-0.5 text-xs text-surface-200">
                                            {m.admin_fix_stuck_paused_lane({
                                                lane: resourceClassLabel(lane),
                                            })}
                                        </span>
                                    </li>
                                {/each}
                            </ul>
                        </section>
                    {/if}

                    {#if check.stages.length > 0}
                        <section class="space-y-2">
                            <h2 class="text-sm font-medium text-surface-200">
                                {m.admin_fix_stuck_stages_heading()}
                            </h2>
                            <ul class="divide-y divide-surface-800 text-sm">
                                {#each check.stages as stage (stage.stageId)}
                                    <li class="flex flex-wrap items-baseline gap-x-3 py-1.5">
                                        <span class="font-mono text-xs text-surface-200">
                                            {stage.stageId}
                                        </span>
                                        {#if stage.pending > 0}
                                            <span class="text-xs text-surface-300">
                                                {m.admin_fix_stuck_stage_pending({
                                                    count: stage.pending,
                                                    age: age(stage.oldestPendingAgeSec),
                                                })}
                                            </span>
                                        {/if}
                                        <span class="text-xs text-surface-400">
                                            {m.admin_fix_stuck_stage_running({
                                                count: stage.running,
                                            })}
                                        </span>
                                        <span class="text-xs text-surface-400">
                                            {m.admin_fix_stuck_stage_completed({
                                                count: stage.completed5m,
                                                minutes: check.windowMinutes,
                                            })}
                                        </span>
                                        {#if stage.failed1h > 0}
                                            <span class="text-xs text-error-300">
                                                {m.admin_fix_stuck_stage_failed({
                                                    count: stage.failed1h,
                                                })}
                                            </span>
                                        {/if}
                                        {#if stage.lastCompletedAt === null}
                                            <span class="text-xs text-surface-500">
                                                {m.admin_fix_stuck_stage_never()}
                                            </span>
                                        {/if}
                                    </li>
                                {/each}
                            </ul>
                        </section>
                    {/if}
                </div>
            {/if}
        </AsyncSection>
    </FixPageShell>
{/if}
