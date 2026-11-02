<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  One machine and the services on it. Host figures (memory, CPUs, load, disks,
  GPUs) are host-wide and shown once, from the freshest heartbeat on the host;
  "Lumastra uses" sums the services' own resident memory.
-->
<script lang="ts">
    import Card from '$lib/components/ui/Card.svelte';
    import { formatBinaryBytes } from '$lib/utils/admin/cluster-node-resources.js';
    import { hostMemoryLevel, diskLevel } from '$lib/utils/admin/cluster-glance.js';
    import ClusterServiceCard from './ClusterServiceCard.svelte';
    import { gpuMeterPercent } from './gpu-history.js';
    import ClusterHostGpu from './ClusterHostGpu.svelte';
    import { hostLabel, worstState, type ClusterHostGroup } from './cluster-hosts.js';
    import { stateClasses, stateLabel } from './cluster-labels.js';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        group: ClusterHostGroup;
        versionMismatch?: boolean;
    }

    let { group, versionMismatch = false }: Props = $props();

    let host = $derived(group.host);
    let memUsed = $derived(
        host?.memTotalBytes !== undefined && host.memAvailableBytes !== undefined
            ? host.memTotalBytes - host.memAvailableBytes
            : undefined,
    );
    let memRatio = $derived(
        memUsed !== undefined && host?.memTotalBytes ? memUsed / host.memTotalBytes : null,
    );
    let memoryPressure = $derived(
        host?.memAvailableBytes !== undefined && host.memTotalBytes !== undefined
            ? hostMemoryLevel(host.memAvailableBytes, host.memTotalBytes)
            : 'ok',
    );
    let hostState = $derived(worstState(group.services));
    let hostStateClasses = $derived(stateClasses(hostState));

    function diskRole(role: 'cache' | 'transcode' | 'data'): string {
        if (role === 'cache') return m.admin_cluster_disk_cache();
        if (role === 'transcode') return m.admin_cluster_disk_transcode();
        return m.admin_cluster_disk_data();
    }

    // Two services can measure the same volume (web and worker both see the cache);
    // show each role + path once.
    let disks = $derived.by(() => {
        const out: NonNullable<NonNullable<typeof host>['disks']> = [];
        for (const s of group.services) {
            for (const d of s.host?.disks ?? []) {
                if (!out.some((o) => o.role === d.role && o.path === d.path)) out.push(d);
            }
        }
        return out;
    });
</script>

<Card variant="gradient" padding="lg" rounded="xl">
    <section
        aria-label={m.admin_cluster_host_aria({ name: hostLabel(group) })}
        data-testid="cluster-host">
        <div class="flex flex-wrap items-start justify-between gap-2">
            <div class="min-w-0">
                <p class="text-xs uppercase tracking-wide text-muted">{m.admin_cluster_host()}</p>
                <h4
                    class="break-all font-mono text-lg font-semibold text-white"
                    title={m.admin_cluster_host_id_title({ id: group.id })}
                    data-testid="cluster-host-name">
                    {hostLabel(group)}
                </h4>
            </div>
            <span class="text-xs rounded-full px-2 py-0.5 font-medium {hostStateClasses.pill}">
                {stateLabel(hostState)}
            </span>
        </div>

        {#if host}
            <dl class="mt-5 grid min-w-0 grid-cols-1 gap-4 text-sm sm:grid-cols-2">
                {#if memUsed !== undefined && host.memTotalBytes !== undefined}
                    <div class="min-w-0 rounded-lg bg-surface-900/40 p-4">
                        <div class="flex flex-wrap items-baseline justify-between gap-2">
                            <dt class="text-muted">{m.admin_cluster_host_memory()}</dt>
                            <dd
                                class="text-right text-lg font-semibold tabular-nums {memoryPressure !==
                                'ok'
                                    ? 'text-amber-300'
                                    : 'text-surface-200'}"
                                data-testid="cluster-host-memory">
                                {m.admin_cluster_used_of({
                                    used: formatBinaryBytes(memUsed),
                                    total: formatBinaryBytes(host.memTotalBytes),
                                })}
                            </dd>
                        </div>
                        {#if memRatio !== null}
                            <div
                                class="mt-2 h-2.5 overflow-hidden rounded-full bg-surface-700"
                                role="meter"
                                aria-label={m.admin_cluster_host_memory()}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={Math.round(gpuMeterPercent(memRatio * 100))}>
                                <div
                                    class="h-full {memoryPressure !== 'ok'
                                        ? 'bg-amber-400'
                                        : 'bg-cyan-400'}"
                                    style="width: {gpuMeterPercent(memRatio * 100)}%">
                                </div>
                            </div>
                        {/if}
                        {#if memoryPressure !== 'ok'}<p class="mt-2 text-sm text-amber-200">
                                {m.admin_health_memory_pressure()}
                            </p>{/if}
                        <p
                            class="mt-2 text-xs leading-relaxed text-muted"
                            data-testid="cluster-host-services-rss">
                            {m.admin_cluster_lumastra_uses({
                                size: formatBinaryBytes(group.serviceRssBytes),
                                count: group.services.filter((s) => s.process).length,
                            })}
                        </p>
                    </div>
                {/if}
                {#if group.cpuPercent !== undefined}
                    <div
                        class="min-w-0 rounded-lg bg-surface-900/40 p-4"
                        data-testid="cluster-host-cpu">
                        <div class="flex flex-wrap items-baseline justify-between gap-2">
                            <dt class="text-muted">{m.admin_cluster_host_cpu()}</dt>
                            <dd
                                class="text-right text-lg font-semibold tabular-nums text-surface-200">
                                {host.cpuCount !== undefined
                                    ? m.admin_cluster_host_cpu_value({
                                          percent: Math.round(gpuMeterPercent(group.cpuPercent)),
                                          count: host.cpuCount,
                                      })
                                    : `${Math.round(gpuMeterPercent(group.cpuPercent))} %`}
                            </dd>
                        </div>
                        <div
                            class="mt-2 h-2.5 overflow-hidden rounded-full bg-surface-700"
                            role="meter"
                            aria-label={m.admin_cluster_host_cpu()}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.round(gpuMeterPercent(group.cpuPercent))}>
                            <div
                                class="h-full {group.cpuPercent >= 90
                                    ? 'bg-amber-400'
                                    : 'bg-cyan-400'}"
                                style="width: {gpuMeterPercent(group.cpuPercent)}%">
                            </div>
                        </div>
                    </div>
                {:else if host.cpuCount !== undefined}
                    <div class="flex flex-wrap items-baseline justify-between gap-2">
                        <dt class="text-muted">{m.admin_cluster_host_cpus()}</dt>
                        <dd class="text-surface-200">{host.cpuCount}</dd>
                    </div>
                {/if}
                {#if host.load1 !== undefined}
                    <div
                        class="flex flex-wrap items-baseline justify-between gap-2"
                        title={m.admin_cluster_host_load_title()}>
                        <dt class="text-muted">{m.admin_cluster_host_load()}</dt>
                        <dd class="text-surface-200 tabular-nums">
                            {host.load1.toFixed(2)} · {host.load5?.toFixed(2) ?? '—'} · {host.load15?.toFixed(
                                2,
                            ) ?? '—'}
                        </dd>
                    </div>
                {/if}
                {#each disks as disk (`${disk.role}:${disk.path}`)}
                    {@const diskPressure = diskLevel(disk.freeBytes, disk.totalBytes)}
                    <div class="min-w-0 rounded-lg bg-surface-900/40 p-4">
                        <dt class="text-muted">
                            {m.admin_cluster_disk({ role: diskRole(disk.role) })}
                        </dt>
                        <dd
                            class="mt-1 text-lg font-semibold tabular-nums {diskPressure !== 'ok'
                                ? 'text-amber-300'
                                : 'text-surface-200'}">
                            {m.admin_cluster_free_of({
                                free: formatBinaryBytes(disk.freeBytes),
                                total: formatBinaryBytes(disk.totalBytes),
                            })}
                        </dd>
                        <p class="mt-2 break-all text-xs text-muted">{disk.path}</p>
                        {#if diskPressure !== 'ok'}<p class="mt-2 text-sm text-amber-200">
                                {m.admin_health_disk_pressure()}
                            </p>{/if}
                    </div>
                {/each}
            </dl>
        {/if}

        <ClusterHostGpu {group} />

        {#if group.services.length > 1}
            <p class="mt-3 text-[11px] text-muted">
                {m.admin_cluster_host_shared({ count: group.services.length })}
            </p>
        {/if}

        <h5 class="mt-6 text-base font-semibold text-white">{m.admin_health_host_services()}</h5>
        <div class="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {#each group.services as entry (entry.key)}
                <ClusterServiceCard {entry} {versionMismatch} />
            {/each}
        </div>
    </section>
</Card>
