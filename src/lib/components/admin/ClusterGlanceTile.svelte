<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Home's server/cluster tile separates service availability from resource
  warnings, then shows readable host/container figures and scoped GPU activity.
  Thresholds remain in utils/admin/cluster-glance.ts.
  The whole tile opens the cluster view. Everything comes from the status
  payload's `cluster` block, so Home still makes no fetch of its own. One
  machine reads "Server", several read "Cluster"; figures a setup does not
  report (no cgroup limit, no load average) are left out, not shown as zero.
-->
<script lang="ts">
    import { Icon, ServerStack, ArrowRight, ExclamationTriangle } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import { resolve } from '$lib/paths';
    import Card from '$lib/components/ui/Card.svelte';
    import { formatBinaryBytes } from '$lib/utils/admin/cluster-node-resources.js';
    import type { ClusterGlance, ClusterGlanceLevel } from '$lib/schemas/api-admin-status-payload';

    interface Props {
        glance?: ClusterGlance;
        href: string;
    }

    let { glance, href }: Props = $props();

    interface Row {
        key: string;
        label: string;
        value: string;
        level: ClusterGlanceLevel;
        hint: string;
        ratio?: number;
        warning?: string;
    }

    function levelText(level: ClusterGlanceLevel): string {
        if (level === 'critical') return 'text-red-300';
        if (level === 'warn') return 'text-amber-300';
        return 'text-surface-200';
    }

    function serviceLabel(role: string): string {
        switch (role) {
            case 'web':
                return m.admin_cluster_kind_web();
            case 'worker':
                return m.admin_cluster_kind_worker();
            case 'proxy':
                return m.admin_cluster_kind_proxy();
            default:
                return m.admin_cluster_kind_general();
        }
    }

    function pct(ratio: number): string {
        return `${Math.round(ratio * 100)} %`;
    }

    function onHost(text: string, host: string | undefined): string {
        return host ? `${text} · ${host}` : text;
    }

    let rows = $derived.by((): Row[] => {
        if (!glance) return [];
        const out: Row[] = [];
        const mem = glance.hostMemory;
        if (mem) {
            out.push({
                key: 'memory',
                label: m.admin_home_cluster_row_memory(),
                value: pct(mem.usedRatio),
                level: mem.level,
                ratio: mem.usedRatio,
                warning: mem.level !== 'ok' ? m.admin_health_memory_pressure() : undefined,
                hint: onHost(
                    m.admin_home_cluster_hint_memory({
                        available: formatBinaryBytes(mem.availableBytes),
                        total: formatBinaryBytes(mem.totalBytes),
                    }),
                    mem.host,
                ),
            });
        }
        const c = glance.container;
        if (c) {
            out.push({
                key: 'container',
                label: m.admin_home_cluster_row_container({ service: serviceLabel(c.role) }),
                // "62 % · peak 96 %": the peak is what comes before a memcg OOM.
                value:
                    c.peakRatio !== undefined &&
                    Math.round(c.peakRatio * 100) > Math.round(c.ratio * 100)
                        ? m.admin_home_cluster_value_peak({
                              now: pct(c.ratio),
                              peak: pct(c.peakRatio),
                          })
                        : pct(c.ratio),
                level: c.level,
                ratio: c.ratio,
                warning: c.level !== 'ok' ? m.admin_health_container_pressure() : undefined,
                hint: onHost(
                    c.peakBytes !== undefined &&
                        c.peakRatio !== undefined &&
                        Math.round(c.peakRatio * 100) > Math.round(c.ratio * 100)
                        ? m.admin_home_cluster_hint_container_peak({
                              used: formatBinaryBytes(c.usedBytes),
                              peak: formatBinaryBytes(c.peakBytes),
                              limit: formatBinaryBytes(c.limitBytes),
                          })
                        : m.admin_home_cluster_hint_container({
                              used: formatBinaryBytes(c.usedBytes),
                              limit: formatBinaryBytes(c.limitBytes),
                          }),
                    c.host,
                ),
            });
        }
        const cpu = glance.cpu;
        if (cpu) {
            out.push({
                key: 'cpu',
                label: m.admin_home_cluster_row_cpu(),
                value: `${cpu.load.toFixed(1)} / ${cpu.cores}`,
                level: cpu.level,
                ratio: cpu.ratio,
                warning: cpu.level !== 'ok' ? m.admin_health_cpu_pressure() : undefined,
                hint: onHost(
                    m.admin_home_cluster_hint_cpu({
                        load: cpu.load.toFixed(2),
                        cores: cpu.cores,
                    }),
                    cpu.host,
                ),
            });
        }
        const disk = glance.disk;
        if (disk) {
            out.push({
                key: 'disk',
                label: m.admin_home_cluster_row_disk(),
                value: pct(disk.freeRatio),
                level: disk.level,
                ratio: disk.freeRatio,
                warning: disk.level !== 'ok' ? m.admin_health_disk_pressure() : undefined,
                hint: onHost(
                    m.admin_home_cluster_hint_disk({
                        free: formatBinaryBytes(disk.freeBytes),
                        total: formatBinaryBytes(disk.totalBytes),
                    }),
                    disk.host,
                ),
            });
        }
        if (glance.uncleanExits24h > 0) {
            out.push({
                key: 'unclean',
                label: m.admin_home_cluster_row_unclean(),
                value: String(glance.uncleanExits24h),
                level: 'warn',
                hint: m.admin_home_cluster_hint_unclean(),
                warning: m.admin_home_cluster_row_unclean(),
            });
        }
        return out;
    });

    let warnings = $derived(rows.filter((row) => row.warning));
    const warningId = $props.id();
    const resourceId = `${warningId}-resources`;

    function boundedPercent(ratio: number): number {
        return Math.max(0, Math.min(100, ratio * 100));
    }

    let level = $derived<ClusterGlanceLevel>(glance?.level ?? 'ok');
    let title = $derived(
        (glance?.hostCount ?? 1) > 1 ? m.admin_home_stat_cluster() : m.admin_home_stat_server(),
    );
    let subtitle = $derived.by(() => {
        if (!glance) return m.admin_home_cluster_unavailable();
        const parts = [m.admin_home_cluster_services_up()];
        const down = glance.services.expected - glance.services.up - glance.services.late;
        if (down > 0) parts.push(m.admin_home_cluster_down({ count: down }));
        if (glance.services.late > 0) {
            parts.push(m.admin_home_cluster_late({ count: glance.services.late }));
        }
        if (glance.hostCount > 1) {
            parts.push(m.admin_home_cluster_machines({ count: glance.hostCount }));
        }
        return parts.join(' · ');
    });
    let value = $derived(glance ? `${glance.services.up}/${glance.services.expected}` : '—');
    /** Colour is not the only carrier of the state: screen readers get the words. */
    let levelWord = $derived(
        !glance
            ? ''
            : level === 'critical'
              ? m.admin_home_cluster_level_critical()
              : level === 'warn'
                ? m.admin_home_cluster_level_warn()
                : m.admin_home_cluster_level_ok(),
    );
</script>

<a
    href={resolve(href)}
    class="col-span-full min-w-0 block rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary-400 hover:opacity-90 {level ===
    'critical'
        ? 'ring-1 ring-red-500/60'
        : level === 'warn'
          ? 'ring-1 ring-amber-500/60'
          : ''}"
    aria-label={[title, value, subtitle, levelWord, m.admin_home_cluster_open()]
        .filter(Boolean)
        .join(', ')}
    aria-describedby={[
        warnings.length > 0 || glance?.gpu?.level === 'warn' ? warningId : '',
        rows.length > 0 || glance?.gpu ? resourceId : '',
    ]
        .filter(Boolean)
        .join(' ') || undefined}
    data-level={glance ? level : 'unknown'}>
    <Card variant="gradient" padding="lg" rounded="xl">
        <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="flex min-w-0 items-start gap-3">
                <div class="rounded-lg bg-blue-500/10 p-2.5">
                    <Icon src={ServerStack} class="h-6 w-6 text-blue-400" />
                </div>
                <div>
                    <h3 class="text-base font-semibold text-white">{title}</h3>
                    <p class="mt-1 text-sm text-surface-300">{subtitle}</p>
                </div>
            </div>
            <p
                class="text-3xl font-bold tabular-nums {glance &&
                glance.services.up === glance.services.expected
                    ? 'text-green-300'
                    : 'text-surface-200'}"
                data-testid="cluster-glance-availability">
                {value}
            </p>
        </div>
        {#if warnings.length > 0 || glance?.gpu?.level === 'warn'}
            <div
                class="mt-4 flex items-start gap-2 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-200"
                id={warningId}>
                <Icon src={ExclamationTriangle} class="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                    {warnings
                        .map((row) => `${row.label}: ${row.warning}`)
                        .concat(
                            glance?.gpu?.level === 'warn' ? [m.admin_health_gpu_capacity()] : [],
                        )
                        .join(' · ')}
                </p>
            </div>
        {/if}
        <div id={resourceId}>
            {#if rows.length > 0}
                <dl class="mt-5 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    {#each rows as row (row.key)}
                        <div class="min-w-0 rounded-lg bg-surface-900/40 p-3">
                            <dt class="text-sm text-surface-300">{row.label}</dt>
                            <dd
                                class="mt-1 break-words text-xl font-semibold tabular-nums {levelText(
                                    row.level,
                                )}">
                                {row.value}
                            </dd>
                            {#if row.ratio !== undefined}
                                <div
                                    class="mt-2 h-2 overflow-hidden rounded-full bg-surface-700"
                                    role="meter"
                                    aria-label={row.label}
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={Math.round(boundedPercent(row.ratio))}
                                    aria-valuetext={row.value}>
                                    <div
                                        class="h-full {row.level === 'critical'
                                            ? 'bg-red-400'
                                            : row.level === 'warn'
                                              ? 'bg-amber-400'
                                              : 'bg-cyan-400'}"
                                        style="width: {boundedPercent(row.ratio)}%">
                                    </div>
                                </div>
                            {/if}
                            <p class="mt-2 break-words text-xs leading-relaxed text-muted">
                                {row.hint}
                            </p>
                        </div>
                    {/each}
                </dl>
            {/if}
            {#if glance?.gpu}
                {@const gpu = glance.gpu}
                <div
                    class="mt-4 rounded-lg border border-violet-400/20 bg-violet-500/5 p-4"
                    data-testid="cluster-glance-gpu">
                    <div class="flex flex-wrap items-baseline justify-between gap-2">
                        <h4 class="font-semibold text-violet-200">
                            {m.admin_cluster_gpu_heading()}{gpu.host ? ` · ${gpu.host}` : ''}
                        </h4>
                        <p class="text-sm tabular-nums text-surface-200">
                            {gpu.max !== undefined
                                ? m.admin_cluster_gpu_sessions_of({ used: gpu.inUse, max: gpu.max })
                                : m.admin_cluster_gpu_ffmpeg({ count: gpu.inUse })}
                        </p>
                    </div>
                    <div
                        class="mt-3 grid gap-4"
                        class:sm:grid-cols-2={gpu.utilizationPercent !== undefined}>
                        {@render gpuActivity(
                            gpu.videoScope === 'host'
                                ? m.admin_health_gpu_host_encoder()
                                : gpu.videoScope === 'lumastra'
                                  ? m.admin_health_gpu_lumastra_video()
                                  : m.admin_cluster_gpu_engine_video(),
                            gpu.videoPercent,
                        )}
                        {#if gpu.utilizationPercent !== undefined}
                            {@render gpuActivity(
                                m.admin_health_gpu_host_utilization(),
                                gpu.utilizationPercent,
                            )}
                        {/if}
                    </div>
                </div>
            {/if}
        </div>
        <p class="mt-4 flex items-center justify-end gap-2 text-sm font-medium text-primary-300">
            {m.admin_home_cluster_open()}
            <Icon src={ArrowRight} class="h-4 w-4" />
        </p>
    </Card>
</a>

{#snippet gpuActivity(label: string, percent: number | undefined)}
    <div>
        <div class="flex flex-wrap justify-between gap-2 text-sm">
            <span class="text-surface-300">{label}</span><span
                class="font-semibold tabular-nums text-violet-200"
                >{percent !== undefined
                    ? `${Math.round(boundedPercent(percent / 100))} %`
                    : m.admin_health_telemetry_unavailable()}</span>
        </div>
        {#if percent !== undefined}
            <div
                class="mt-2 h-2 overflow-hidden rounded-full bg-surface-700"
                role="meter"
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(boundedPercent(percent / 100))}>
                <div class="h-full bg-violet-400" style="width: {boundedPercent(percent / 100)}%">
                </div>
            </div>
        {/if}
    </div>
{/snippet}
