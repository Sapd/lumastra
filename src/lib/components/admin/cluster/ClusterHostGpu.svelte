<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  GPU block of a host card. Device figures (awake %, clock, power, NVENC) are
  host-wide; the engine bars add up what every Lumastra service on the host runs on
  the GPU (their FFmpeg children), so they say which engine is busy: "video" is
  encode/decode, "render" the 3D engine. The sparkline keeps the video engine while
  the page is open (one point per poll); nothing is stored server-side.
-->
<script lang="ts">
    import { resolve } from '$lib/paths';
    import { untrack } from 'svelte';
    import { formatBinaryBytes } from '$lib/utils/admin/cluster-node-resources.js';
    import { GPU_ENGINE_ORDER, hostGpuEncodes, type ClusterHostGroup } from './cluster-hosts.js';
    import {
        gpuMeterPercent,
        gpuHistorySegments,
        appendGpuHistory,
        type GpuHistoryState,
    } from './gpu-history.js';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        group: ClusterHostGroup;
    }

    let { group }: Props = $props();

    /** Points kept for the sparkline: 40 polls at 10 s ≈ the last 7 minutes. */
    const HISTORY_POINTS = 40;

    let gpus = $derived(group.gpus ?? []);
    let engines = $derived(group.gpuEngines);
    let encodes = $derived(hostGpuEncodes(group));
    let shownEngines = $derived(
        engines
            ? GPU_ENGINE_ORDER.filter(
                  (cls) =>
                      engines[cls] !== undefined &&
                      // Copy/compute are noise at 0; render and video always show.
                      (cls === 'video' || cls === 'render' || (engines[cls] ?? 0) > 0),
              )
            : [],
    );

    /** Awake most of the time, yet no Lumastra FFmpeg on the GPU: something else wakes it. */
    let awakeWithoutLumastra = $derived(
        group.gpuClients === 0 && gpus.some((g) => (g.awakePercent ?? 0) >= 50),
    );

    let historyState = $state<GpuHistoryState>();
    let history = $derived(historyState?.values ?? []);
    let lastGroup: ClusterHostGroup | undefined;
    $effect(() => {
        const current = group;
        // Each successful poll advances time. Missing engine measurements leave
        // a gap, even if no FFmpeg clients were reported in the same heartbeat.
        if (current === lastGroup) return;
        lastGroup = current;
        const video = current.gpuEngines?.video ?? null;
        untrack(() => {
            historyState = appendGpuHistory(
                historyState,
                current.id,
                Date.now(),
                video,
                HISTORY_POINTS,
            );
        });
    });

    let segments = $derived(gpuHistorySegments(history, HISTORY_POINTS));
    function engineLabel(cls: (typeof GPU_ENGINE_ORDER)[number]): string {
        switch (cls) {
            case 'video':
                return m.admin_cluster_gpu_engine_video();
            case 'render':
                return m.admin_cluster_gpu_engine_render();
            case 'videoEnhance':
                return m.admin_cluster_gpu_engine_video_enhance();
            case 'compute':
                return m.admin_cluster_gpu_engine_compute();
            default:
                return m.admin_cluster_gpu_engine_copy();
        }
    }

    function barClass(percent: number): string {
        if (percent >= 90) return 'bg-amber-400';
        return 'bg-violet-400';
    }
</script>

{#snippet meter(label: string, value: number, scope: string = '')}
    <div class="mt-3">
        <div class="flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <span class="text-surface-300">{label}</span>
            <span class="text-xl font-semibold tabular-nums text-surface-100"
                >{Math.round(gpuMeterPercent(value))} %</span>
        </div>
        <div
            class="mt-2 h-2.5 overflow-hidden rounded-full bg-surface-700"
            role="meter"
            aria-label={scope ? `${scope}: ${label}` : label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(gpuMeterPercent(value))}>
            <div class="h-full {barClass(value)}" style="width: {gpuMeterPercent(value)}%"></div>
        </div>
    </div>
{/snippet}

{#if gpus.length > 0 || group.gpuClients > 0 || group.gpuAccess.length > 0}
    <section
        class="mt-6 min-w-0 rounded-xl border border-violet-400/20 bg-violet-500/5 p-4 sm:p-5"
        aria-label={m.admin_cluster_gpu_heading()}
        data-testid="cluster-host-gpu">
        <div class="flex flex-wrap items-baseline justify-between gap-3">
            <h5 class="text-lg font-semibold text-violet-200">{m.admin_cluster_gpu_heading()}</h5>
            {#if encodes}
                <p
                    class="text-base font-medium tabular-nums text-surface-100"
                    data-testid="cluster-host-gpu-encodes">
                    {encodes.max !== undefined
                        ? m.admin_cluster_gpu_sessions_of({ used: encodes.inUse, max: encodes.max })
                        : m.admin_cluster_gpu_ffmpeg({ count: encodes.inUse })}
                </p>
            {/if}
        </div>
        <div class="mt-3 flex flex-wrap gap-4 text-sm">
            <a
                class="text-primary-300 underline"
                href={resolve('/admin/settings/playback?category=ffmpeg-hardware')}
                >{m.admin_hardware_configure()}</a>
            <a
                class="text-primary-300 underline"
                href={resolve('/admin/system/health?tab=cluster#hardware-encoder-check')}
                >{m.admin_hardware_diagnostics()}</a>
        </div>
        {#each group.gpuAccess as access (`${access.configured}:${access.accessible}`)}
            <p
                class="mt-2 break-words text-sm {access.accessible
                    ? 'text-green-300'
                    : 'text-red-300'}"
                data-testid="cluster-host-gpu-access">
                {access.accessible
                    ? m.admin_cluster_gpu_access_ok({ accel: access.configured.toUpperCase() })
                    : m.admin_cluster_gpu_access_failed({ accel: access.configured.toUpperCase() })}
                {#if access.accessible && access.capabilities?.length}<span class="text-muted"
                        >· {access.capabilities.join(', ')}</span
                    >{/if}
                {#if !access.accessible && access.error}<span class="block text-xs text-muted"
                        >{access.error}</span
                    >{/if}
            </p>
        {/each}
        <div class="mt-4 grid min-w-0 gap-5 {gpus.length > 0 ? 'xl:grid-cols-2' : ''}">
            {#if gpus.length > 0}<div class="min-w-0 space-y-3">
                    {#each gpus as gpu (gpu.device)}
                        <div
                            class="min-w-0 rounded-lg bg-surface-900/50 p-4"
                            data-testid="cluster-host-gpu-device">
                            <p class="break-words text-base font-semibold text-white">
                                {gpu.name ?? gpu.device}
                            </p>
                            <p class="mt-1 break-all font-mono text-xs text-muted">
                                {gpu.device}{gpu.driver ? ` · ${gpu.driver}` : ''}
                            </p>
                            <p
                                class="mt-3 text-xs font-medium uppercase tracking-wide text-violet-200">
                                {m.admin_health_gpu_host_scope()}
                            </p>
                            {#if gpu.busyPercent !== undefined}
                                {@render meter(
                                    m.admin_cluster_gpu_utilization(),
                                    gpu.busyPercent,
                                    gpu.device,
                                )}
                            {:else}
                                <p class="mt-2 text-sm text-muted">
                                    {m.admin_health_gpu_host_unavailable()}
                                </p>
                            {/if}
                            {#if gpu.encoderPercent !== undefined}{@render meter(
                                    m.admin_cluster_gpu_encoder(),
                                    gpu.encoderPercent,
                                    gpu.device,
                                )}{/if}
                            {#if gpu.decoderPercent !== undefined}{@render meter(
                                    m.admin_cluster_gpu_decoder(),
                                    gpu.decoderPercent,
                                    gpu.device,
                                )}{/if}
                            {#if gpu.encodeSessions !== undefined}
                                <p class="mt-3 text-sm tabular-nums text-surface-200">
                                    {gpu.maxEncodeSessions !== undefined &&
                                    gpu.maxEncodeSessions > 0
                                        ? m.admin_cluster_gpu_sessions_of({
                                              used: gpu.encodeSessions,
                                              max: gpu.maxEncodeSessions,
                                          })
                                        : m.admin_health_gpu_sessions({
                                              count: gpu.encodeSessions,
                                          })}
                                </p>
                                {#if gpu.maxEncodeSessions !== undefined && gpu.maxEncodeSessions > 0 && gpu.encodeSessions >= gpu.maxEncodeSessions}
                                    <p class="mt-1 text-sm text-amber-200">
                                        {m.admin_health_gpu_capacity()}
                                    </p>
                                {/if}
                            {/if}
                            <dl class="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                                {#if gpu.freqMhz !== undefined}
                                    <div>
                                        <dt class="text-xs text-muted">
                                            {m.admin_cluster_gpu_clock()}
                                        </dt>
                                        <dd class="mt-1 tabular-nums text-surface-200">
                                            {gpu.freqMaxMhz
                                                ? `${gpu.freqMhz} / ${gpu.freqMaxMhz} MHz`
                                                : `${gpu.freqMhz} MHz`}
                                        </dd>
                                    </div>
                                {/if}
                                {#if gpu.powerWatts !== undefined}<div>
                                        <dt class="text-xs text-muted">
                                            {m.admin_cluster_gpu_power()}
                                        </dt>
                                        <dd class="mt-1 tabular-nums text-surface-200">
                                            {gpu.powerWatts.toFixed(1)} W
                                        </dd>
                                    </div>{/if}
                                {#if gpu.temperatureC !== undefined}<div>
                                        <dt class="text-xs text-muted">
                                            {m.admin_cluster_gpu_temperature()}
                                        </dt>
                                        <dd class="mt-1 tabular-nums text-surface-200">
                                            {gpu.temperatureC} °C
                                        </dd>
                                    </div>{/if}
                                {#if gpu.memUsedBytes !== undefined && gpu.memTotalBytes !== undefined}
                                    <div>
                                        <dt class="text-xs text-muted">
                                            {m.admin_cluster_gpu_memory()}
                                        </dt>
                                        <dd class="mt-1 tabular-nums text-surface-200">
                                            {m.admin_cluster_used_of({
                                                used: formatBinaryBytes(gpu.memUsedBytes),
                                                total: formatBinaryBytes(gpu.memTotalBytes),
                                            })}
                                        </dd>
                                    </div>
                                {/if}
                                {#if gpu.awakePercent !== undefined}
                                    <div data-testid="cluster-host-gpu-awake">
                                        <dt class="text-xs text-muted">
                                            {m.admin_cluster_gpu_awake()}
                                        </dt>
                                        <dd class="mt-1 tabular-nums text-muted">
                                            {Math.round(gpu.awakePercent)} %
                                        </dd>
                                    </div>
                                {/if}
                            </dl>
                            {#if gpu.awakePercent !== undefined}<p
                                    class="mt-3 text-xs leading-relaxed text-muted">
                                    {m.admin_health_gpu_awake_explanation()}
                                </p>{/if}
                        </div>
                    {/each}
                </div>{/if}
            <div class="min-w-0 rounded-lg bg-surface-900/50 p-4">
                <h6 class="text-base font-semibold text-white">
                    {m.admin_health_gpu_lumastra_scope()}
                </h6>
                <p class="mt-1 text-xs leading-relaxed text-muted">
                    {m.admin_cluster_gpu_engines_title()}
                </p>
                {#if engines && shownEngines.length > 0}
                    {#each shownEngines as cls (cls)}
                        {@const value = engines[cls]}
                        {#if value !== undefined}<div data-testid="cluster-host-gpu-engine-{cls}">
                                {@render meter(
                                    engineLabel(cls),
                                    value,
                                    m.admin_health_gpu_lumastra_scope(),
                                )}
                            </div>{/if}
                    {/each}
                {/if}
                {#if engines?.video === undefined}<p
                        class="mt-3 text-sm text-muted"
                        data-testid="cluster-host-gpu-video-unavailable">
                        {m.admin_health_gpu_video_unavailable()}
                    </p>{/if}
                {#if awakeWithoutLumastra}<p
                        class="mt-3 text-xs leading-relaxed text-muted"
                        data-testid="cluster-host-gpu-awake-other">
                        {m.admin_cluster_gpu_awake_other()}
                    </p>{/if}
                <figure class="mt-5 border-t border-surface-700/60 pt-4">
                    <figcaption class="text-sm font-medium text-surface-200">
                        {m.admin_cluster_gpu_history()}
                    </figcaption>
                    <div class="mt-3 flex gap-2">
                        <div
                            class="flex h-32 flex-col justify-between text-[11px] tabular-nums text-muted"
                            aria-hidden="true">
                            <span>100 %</span><span>50 %</span><span>0 %</span>
                        </div>
                        <svg
                            class="h-32 min-w-0 flex-1 overflow-visible text-violet-400"
                            viewBox="0 0 100 100"
                            preserveAspectRatio="none"
                            role="img"
                            aria-label={m.admin_health_gpu_chart_description()}
                            data-testid="cluster-host-gpu-sparkline">
                            <path
                                d="M0 0H100 M0 50H100 M0 100H100"
                                fill="none"
                                stroke="currentColor"
                                stroke-opacity="0.15"
                                vector-effect="non-scaling-stroke" />
                            {#each segments as segment (segment.firstX)}
                                {#if segment.count > 1}<polyline
                                        points={segment.points}
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="2"
                                        vector-effect="non-scaling-stroke" />
                                {:else}<path
                                        d="M{segment.firstX} {segment.firstY}h0.01"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="4"
                                        stroke-linecap="round"
                                        vector-effect="non-scaling-stroke" />{/if}
                            {/each}
                        </svg>
                    </div>
                    <div class="mt-2 flex justify-between text-xs text-muted">
                        <span>{m.admin_health_gpu_chart_older()}</span><span
                            >{m.admin_health_gpu_chart_now()}</span>
                    </div>
                    <p class="mt-2 text-xs leading-relaxed text-muted">
                        {m.admin_health_gpu_chart_description()}
                    </p>
                    <ol
                        class="sr-only"
                        aria-label={m.admin_cluster_gpu_history()}
                        data-testid="cluster-host-gpu-history-values">
                        {#each history as value, index (index)}
                            <li>
                                {value === null
                                    ? m.admin_health_telemetry_unavailable()
                                    : `${Math.round(gpuMeterPercent(value))} %`}
                            </li>
                        {/each}
                    </ol>
                </figure>
            </div>
        </div>
    </section>
{/if}
