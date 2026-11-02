<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  /admin/fix/slow — what is actually consuming this box, with the two levers
  that do something about it.

  ## The order answers the real question first

  "My server is slow" is usually one of three completely different situations,
  and the sections are ordered so the operator stops reading as soon as theirs is
  identified:

    1. Nothing is running at all      — that is "stuck", not "slow"
    2. First-run processing           — expected, finite, and about to end
    3. Playback / memory / disk       — genuinely someone else's fault

  ## "This is expected" is load-bearing copy

  A first-run library genuinely pins the CPU for hours, and the single most
  valuable thing this page can do is convert a bug report into patience — but
  only when it is TRUE. So the reassurance is gated on measured throughput: work
  remaining AND something completing in the last five minutes. Queued work that
  is not moving gets the opposite message, because that is a real problem
  wearing the same costume.

  ## What the actions honestly are

  Pausing a lane takes effect immediately. Lowering a concurrency limit does NOT
  — it is a restart-gated setting — so this page links there and says so rather
  than rendering a "use fewer workers" control that would silently do nothing.
-->
<script lang="ts">
    import { Icon, ArrowPath, ExclamationTriangle } from 'svelte-hero-icons';
    import { SvelteSet } from 'svelte/reactivity';
    import FixPageShell from '$lib/components/admin/fix/FixPageShell.svelte';
    import AsyncSection from '$lib/components/admin/AsyncSection.svelte';
    import { findSymptom } from '$lib/components/admin/fix/symptoms.js';
    import {
        HostPressureSchema,
        type HostPressure,
    } from '$lib/components/admin/fix/host-pressure.schema.js';
    import { apiGet, apiPost } from '$lib/api/client.js';
    import {
        getTaskSystemNow,
        getIngestStageActivity,
        getSystemMetrics,
        type IngestStageActivityResponse,
    } from '$lib/api/admin.js';
    import { queuePauseResponseSchema } from '$lib/schemas/admin.js';
    import { WorkerStatusSchema } from '$lib/components/admin/fix/worker-status.schema.js';
    import type { NowSnapshot } from '$lib/schemas/mission-control.schema.js';
    import { classifyError, type ClassifiedError } from '$lib/utils/admin/error-contract.js';
    import { resourceClassLabel } from '$lib/utils/operator-labels';
    import { formatFileSize } from '$lib/utils/metric-formatters.js';
    import { toasts } from '$lib/stores/toast.store';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';

    const symptom = findSymptom('slow');

    let now = $state<NowSnapshot | null>(null);
    let pressure = $state<HostPressure | null>(null);
    let stages = $state<IngestStageActivityResponse | null>(null);
    let workerAvailable = $state<boolean | null>(null);
    let workerSource = $state<string>('');
    let workerDetail = $state<string>('');
    let metricsCpu = $state<number | null>(null);
    /** Null when the sampler was not read: "no transcodes" needs a measurement. */
    let ffmpegJobs = $state<number | null>(null);
    let ffmpegCpu = $state<number>(0);
    /** Sections whose read failed on the last load, so their absence is explained. */
    let unreadable = $state<string[]>([]);

    let loading = $state(false);
    let loadError = $state<ClassifiedError | null>(null);

    const pending = new SvelteSet<string>();

    /** Only the newest load may write; a lane toggle and a refresh can overlap. */
    let loadSeq = 0;

    async function load(): Promise<void> {
        const seq = ++loadSeq;
        loading = true;
        loadError = null;

        // Independently degradable: this page's whole job is describing a
        // struggling instance, so one slow sub-request must not blank the rest.
        const [nowRes, pressureRes, stageRes, workerRes, metricsRes] = await Promise.all([
            getTaskSystemNow(),
            apiGet('/api/admin/fix/host-pressure', HostPressureSchema, { strict: true }),
            getIngestStageActivity(),
            apiGet('/api/admin/worker-status', WorkerStatusSchema, { strict: true }),
            getSystemMetrics(),
        ]);

        if (seq !== loadSeq) return;
        loading = false;

        // A failed read CLEARS its section rather than leaving the previous
        // answer up: after a refresh, an old "this is expected" or "no
        // transcodes" would read as current.
        now = nowRes.data ?? null;
        pressure = pressureRes.data ?? null;
        stages = stageRes.data ?? null;
        workerAvailable = workerRes.data ? workerRes.data.available : null;
        workerSource = workerRes.data?.source ?? '';
        workerDetail = workerRes.data?.detail ?? '';
        // `cpu.total` is ALREADY "percent in use" (the endpoint computes
        // (all - idle) / all). Deriving it again from `idle` would just add
        // a second rounding error to the same number.
        metricsCpu = metricsRes.data?.cpu.total ?? null;
        const agg = metricsRes.data?.ffmpegAggregate;
        ffmpegJobs = agg ? agg.totalJobs : null;
        ffmpegCpu = Math.round(agg?.totalCpuPercent ?? 0);
        unreadable = [
            nowRes.data ? null : m.admin_fix_slow_section_lanes(),
            stageRes.data ? null : m.admin_fix_slow_section_stages(),
            workerRes.data ? null : m.admin_fix_slow_worker_heading(),
            agg ? null : m.admin_fix_slow_playback_heading(),
            pressureRes.data ? null : m.admin_fix_slow_section_pressure(),
        ]
            .filter((x) => x !== null)
            .map(String);

        // Only a total failure is an error state — a partial answer is still an
        // answer, and on a wedged box it is often the only one available.
        if (nowRes.error && pressureRes.error && stageRes.error && metricsRes.error) {
            loadError = classifyError(new Error(nowRes.error), { status: nowRes.status });
        }
    }

    $effect(() => {
        void load();
    });

    async function toggleLane(resourceClass: string, pause: boolean): Promise<void> {
        if (pending.has(resourceClass)) return;
        pending.add(resourceClass);
        try {
            const { data, error } = await apiPost(
                `/api/queues/${encodeURIComponent(resourceClass)}/${pause ? 'pause' : 'resume'}`,
                queuePauseResponseSchema,
                pause ? {} : undefined,
            );
            if (error || !data) {
                toasts.error(error ?? m.admin_fix_slow_pause_failed());
                return;
            }
            // Localized, and honest about persistence: a pause outlives this
            // page and a restart. Resume is one click from the same toast —
            // other pause controls in the admin are one click too, so the
            // guard is an easy undo rather than a confirmation dialog.
            const lane = resourceClassLabel(resourceClass);
            if (pause) {
                toasts.success(m.admin_fix_slow_paused_toast({ lane }), {
                    timeout: 10_000,
                    action: {
                        label: m.admin_fix_slow_resume(),
                        onClick: () => void toggleLane(resourceClass, false),
                    },
                });
            } else {
                toasts.success(m.admin_fix_slow_resumed_toast({ lane }));
            }
            await load();
        } finally {
            pending.delete(resourceClass);
        }
    }

    // First-run progress, summed across the headline stages.
    let remaining = $derived((stages?.progress ?? []).reduce((sum, p) => sum + p.remaining, 0));
    let completedRecently = $derived(
        (stages?.progress ?? []).reduce((sum, p) => sum + p.completed_5m, 0),
    );
    let eligibleTotal = $derived(
        (stages?.progress ?? []).reduce((sum, p) => sum + p.eligibleTotal, 0),
    );
    // A non-empty queue is not the same as a first run: an already-processed
    // library always has a trickle of new or changed items in flight. Only call
    // it first-run processing while a real share of the library is still
    // waiting — otherwise the "this is expected, it will end" reassurance lies.
    const FIRST_RUN_REMAINING_SHARE = 0.1;
    let isFirstRun = $derived(
        eligibleTotal > 0 && remaining / eligibleTotal >= FIRST_RUN_REMAINING_SHARE,
    );

    let lanes = $derived(
        (now?.classes ?? []).filter((c) => c.active > 0 || c.waiting > 0 || c.paused),
    );
    let memory = $derived(pressure?.memory ?? null);
</script>

{#if symptom}
    <FixPageShell
        title={symptom.title()}
        description={m.admin_fix_slow_description()}
        icon={symptom.icon}>
        <div class="space-y-6">
            <button
                type="button"
                class="btn btn-sm variant-soft inline-flex items-center gap-1"
                disabled={loading}
                onclick={() => void load()}>
                <Icon src={ArrowPath} class="h-4 w-4" />
                <span>{m.admin_fix_slow_refresh()}</span>
            </button>

            <AsyncSection
                {loading}
                error={loadError}
                empty={now === null &&
                    pressure === null &&
                    stages === null &&
                    workerAvailable === null &&
                    metricsCpu === null &&
                    !loading &&
                    loadError === null}
                onretry={() => void load()}>
                <div class="space-y-6">
                    {#if unreadable.length > 0}
                        <p role="alert" class="text-sm text-warning-300">
                            {m.admin_fix_slow_unreadable({ sections: unreadable.join(', ') })}
                        </p>
                    {/if}
                    <!-- 1. Stuck, or slow? -->
                    {#if workerAvailable !== null}
                        <section class="space-y-2">
                            <h3 class="text-sm font-semibold text-surface-100">
                                {m.admin_fix_slow_worker_heading()}
                            </h3>
                            {#if workerSource === 'probe-failed'}
                                <p class="text-sm text-warning-200">
                                    {m.admin_fix_slow_worker_unknown()}
                                </p>
                            {:else if workerAvailable}
                                <p class="text-sm text-surface-200">
                                    {m.admin_fix_slow_worker_ok({ source: workerSource })}
                                </p>
                            {:else}
                                <p
                                    class="flex items-start gap-2 rounded border border-error-500/40 bg-error-500/10 p-3 text-sm text-error-200">
                                    <Icon
                                        src={ExclamationTriangle}
                                        class="mt-px h-4 w-4 shrink-0" />
                                    <span>
                                        {m.admin_fix_slow_worker_none()}
                                        {#if workerSource === 'cluster-unavailable' && workerDetail}
                                            <span class="mt-1 block text-xs">{workerDetail}</span>
                                        {/if}
                                    </span>
                                </p>
                            {/if}
                        </section>
                    {/if}

                    <!-- 2. Expected, or not. -->
                    <!-- An empty progress list sums to remaining 0, which is not
                         "first-run processing has finished". -->
                    {#if stages !== null && (stages.progress ?? []).length > 0}
                        <section class="space-y-2">
                            <h3 class="text-sm font-semibold text-surface-100">
                                {m.admin_fix_slow_expected_heading()}
                            </h3>
                            {#if remaining === 0}
                                <p class="text-sm text-surface-300">
                                    {m.admin_fix_slow_expected_done()}
                                </p>
                            {:else if completedRecently > 0 && !isFirstRun}
                                <p class="text-sm leading-relaxed text-surface-300">
                                    {m.admin_fix_slow_expected_incremental({
                                        remaining,
                                        done: completedRecently,
                                    })}
                                </p>
                            {:else if completedRecently > 0}
                                <p
                                    class="rounded border border-success-500/40 bg-success-500/10 p-3 text-sm leading-relaxed text-success-100">
                                    {m.admin_fix_slow_expected_yes({
                                        remaining,
                                        done: completedRecently,
                                    })}
                                </p>
                            {:else}
                                <p
                                    class="rounded border border-warning-500/40 bg-warning-500/10 p-3 text-sm leading-relaxed text-warning-100">
                                    {m.admin_fix_slow_expected_stalled({ remaining })}
                                </p>
                            {/if}
                        </section>
                    {/if}

                    <!-- 3. Per-lane, with the one lever that acts immediately. -->
                    {#if now !== null}
                        <section class="space-y-2">
                            <h3 class="text-sm font-semibold text-surface-100">
                                {m.admin_fix_slow_lanes_heading()}
                            </h3>
                            {#if lanes.length === 0}
                                <p class="text-sm text-surface-300">
                                    {m.admin_fix_slow_lane_idle()}
                                </p>
                            {:else}
                                <ul class="space-y-2">
                                    {#each lanes as lane (lane.resourceClass)}
                                        <li
                                            class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-surface-700/50 bg-surface-800/40 p-3">
                                            <span class="text-sm text-surface-100"
                                                >{resourceClassLabel(lane.resourceClass)}</span>
                                            <span class="text-xs text-surface-300">
                                                {lane.active}
                                                {m.admin_fix_slow_lane_running()} · {lane.waiting}
                                                {m.admin_fix_slow_lane_waiting()} · {m.admin_fix_slow_lane_cap(
                                                    { cap: lane.cap },
                                                )}
                                            </span>
                                            {#if lane.paused}
                                                <span
                                                    class="rounded-full bg-warning-500/15 px-2 py-0.5 text-[11px] text-warning-200">
                                                    {m.admin_fix_slow_lane_paused()}
                                                </span>
                                            {/if}
                                            <button
                                                type="button"
                                                class="btn btn-sm variant-soft ml-auto"
                                                disabled={pending.has(lane.resourceClass)}
                                                onclick={() =>
                                                    void toggleLane(
                                                        lane.resourceClass,
                                                        !lane.paused,
                                                    )}>
                                                {lane.paused
                                                    ? m.admin_fix_slow_resume()
                                                    : m.admin_fix_slow_pause()}
                                            </button>
                                        </li>
                                    {/each}
                                </ul>
                            {/if}
                            <p class="text-xs leading-relaxed text-surface-400">
                                {m.admin_fix_slow_pause_hint()}
                            </p>
                        </section>

                        <section class="space-y-1">
                            <h3 class="text-sm font-semibold text-surface-100">
                                {m.admin_fix_slow_fewer_heading()}
                            </h3>
                            <p class="text-xs leading-relaxed text-surface-300">
                                {m.admin_fix_slow_fewer_body()}
                            </p>
                            <a
                                href={resolve('/admin/settings/tasks')}
                                class="inline-block text-xs text-primary-400 hover:underline">
                                {m.admin_fix_slow_fewer_link()}
                            </a>
                        </section>
                    {/if}

                    <!-- 4. Playback. -->
                    <section class="space-y-1">
                        <h3 class="text-sm font-semibold text-surface-100">
                            {m.admin_fix_slow_playback_heading()}
                        </h3>
                        {#if metricsCpu !== null}
                            <p class="text-sm text-surface-200">
                                {m.admin_fix_slow_cpu_overall({ percent: metricsCpu })}
                            </p>
                        {/if}
                        {#if ffmpegJobs === null}
                            <p class="text-sm text-surface-400">
                                {m.admin_fix_slow_playback_unknown()}
                            </p>
                        {:else if ffmpegJobs === 0}
                            <p class="text-sm text-surface-300">
                                {m.admin_fix_slow_playback_none()}
                            </p>
                        {:else}
                            <p class="text-sm text-surface-200">
                                {m.admin_fix_slow_playback_jobs({
                                    jobs: ffmpegJobs,
                                    cpu: ffmpegCpu,
                                })}
                            </p>
                            <p class="text-xs leading-relaxed text-surface-400">
                                {m.admin_fix_slow_playback_hint()}
                            </p>
                        {/if}
                    </section>

                    <!-- 5. Memory and disk — measured container-side, because
                         the host figures elsewhere are the wrong numbers here. -->
                    {#if memory !== null && pressure !== null}
                        <section class="space-y-1">
                            <h3 class="text-sm font-semibold text-surface-100">
                                {m.admin_fix_slow_memory_heading()}
                            </h3>
                            {#if memory.limitBytes !== null && memory.usageBytes !== null}
                                <p class="text-sm text-surface-200">
                                    {m.admin_fix_slow_memory_limited({
                                        limit: formatFileSize(memory.limitBytes),
                                        used: formatFileSize(memory.usageBytes),
                                    })}
                                </p>
                            {:else if memory.limitBytes !== null}
                                <p class="text-sm text-surface-200">
                                    {m.admin_fix_slow_memory_limit_only({
                                        limit: formatFileSize(memory.limitBytes),
                                    })}
                                </p>
                            {:else if memory.source === 'host' && pressure.containerized}
                                <!-- In a container whose cgroup files could not be
                                     read, "no limit" would be a guess. -->
                                <p class="text-sm text-surface-300">
                                    {m.admin_fix_slow_memory_unknown({
                                        host: formatFileSize(memory.hostTotalBytes),
                                    })}
                                </p>
                            {:else}
                                <p class="text-sm text-surface-200">
                                    {m.admin_fix_slow_memory_uncapped({
                                        host: formatFileSize(memory.hostTotalBytes),
                                    })}
                                </p>
                            {/if}
                            {#if pressure.containerized}
                                <p class="text-xs leading-relaxed text-surface-400">
                                    {m.admin_fix_slow_memory_note()}
                                </p>
                            {/if}
                            <p class="text-xs text-surface-400">
                                {m.admin_fix_slow_cpu_budget({
                                    effective: pressure.cpu.effectiveCores,
                                    host: pressure.cpu.hostCores,
                                })}
                            </p>
                        </section>

                        <!-- Anchor target for the disk-pressure attention alert. -->
                        <section id="disk" class="scroll-mt-24 space-y-2">
                            <h3 class="text-sm font-semibold text-surface-100">
                                {m.admin_fix_slow_disk_heading()}
                            </h3>
                            {#if pressure.unmeasured.length > 0}
                                <ul class="space-y-1">
                                    {#each pressure.unmeasured as vol (vol.path)}
                                        <li
                                            class="rounded border border-error-500/40 bg-error-500/10 p-2 text-xs text-error-200">
                                            {m.admin_fix_slow_disk_unmeasured({
                                                volume: vol.label,
                                                reason: vol.reason,
                                            })}
                                        </li>
                                    {/each}
                                </ul>
                            {/if}
                            {#if pressure.pathsLookupFailed}
                                <p class="text-xs text-warning-300">
                                    {m.admin_fix_slow_disk_paths_failed()}
                                </p>
                            {/if}
                            {#if pressure.volumes.length === 0}
                                <p class="text-sm text-surface-300">
                                    {m.admin_fix_slow_disk_none()}
                                </p>
                            {:else}
                                <ul class="space-y-2">
                                    {#each pressure.volumes as volume (volume.path)}
                                        <li
                                            class="space-y-1 rounded border p-3 {volume.usedPercent >=
                                            90
                                                ? 'border-warning-500/40 bg-warning-500/5'
                                                : 'border-surface-700/50 bg-surface-800/40'}">
                                            <div
                                                class="flex flex-wrap items-baseline justify-between gap-2">
                                                <span
                                                    class="break-all font-mono text-xs text-surface-200"
                                                    >{volume.label}</span>
                                                <span class="text-xs text-surface-300">
                                                    {m.admin_fix_slow_disk_row({
                                                        free: formatFileSize(volume.freeBytes),
                                                        total: formatFileSize(volume.totalBytes),
                                                    })}
                                                </span>
                                            </div>
                                            <div
                                                class="h-1.5 w-full overflow-hidden rounded bg-surface-700/60">
                                                <div
                                                    class="h-full {volume.usedPercent >= 90
                                                        ? 'bg-warning-500'
                                                        : 'bg-primary-500'}"
                                                    style="width: {Math.min(
                                                        100,
                                                        volume.usedPercent,
                                                    )}%">
                                                </div>
                                            </div>
                                        </li>
                                    {/each}
                                </ul>
                                <p class="text-xs leading-relaxed text-surface-400">
                                    {m.admin_fix_slow_disk_hint()}
                                </p>
                            {/if}
                        </section>
                    {/if}
                </div>
            </AsyncSection>
        </div>
    </FixPageShell>
{/if}
