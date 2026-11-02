<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  One service on a host card: web, worker, Live TV proxy or sonic sidecar.
  State pill, runtime, version, uptime, last heartbeat, process memory/CPU, and
  for Kubernetes pods the container's cgroup limits next to the host figures.
-->
<script lang="ts">
    import { toasts } from '$lib/stores/toast.store';
    import { clusterNodeName } from '$lib/utils/admin/cluster-node-name.js';
    import {
        formatBinaryBytes,
        formatCores,
        usageRatio,
        memoryLevel,
    } from '$lib/utils/admin/cluster-node-resources.js';
    import type { ClusterServiceEntry } from './cluster-hosts.js';
    import {
        serviceKindLabel,
        implementationLabel,
        stateLabel,
        stateClasses,
        reasonLabel,
        formatUptime,
    } from './cluster-labels.js';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        entry: ClusterServiceEntry;
        versionMismatch?: boolean;
    }

    let { entry, versionMismatch = false }: Props = $props();

    let node = $derived(entry.node);
    // A friendly name when INSTANCE_ID was pinned; otherwise a short `#suffix`
    // plus a hint to pin one (see cluster-node-name.ts).
    let friendlyName = $derived(node ? clusterNodeName(node.instanceId, node.hostname) : null);
    let res = $derived(node?.resources);
    let memRatio = $derived(usageRatio(res?.memoryUsedBytes, res?.memoryLimitBytes));
    let peakRatio = $derived(usageRatio(res?.memoryPeakBytes, res?.memoryLimitBytes));
    /** Same scale as the bar, so a 24 h peak at 90 % of the limit reads red next to a calm "now". */
    let peakLevel = $derived(memoryLevel(peakRatio));
    let memLevel = $derived(memoryLevel(memRatio));
    let state = $derived(stateClasses(entry.state));
    // Only TypeScript services share the app version; the Rust proxy and the
    // sidecar version separately.
    let showMismatch = $derived(versionMismatch && entry.implementation === 'node');

    const roleColors: Record<string, string> = {
        web: 'bg-blue-500/20 text-blue-300 border border-blue-500/30',
        worker: 'bg-purple-500/20 text-purple-300 border border-purple-500/30',
        proxy: 'bg-amber-500/20 text-amber-300 border border-amber-500/30',
        sonic: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30',
        general: 'bg-surface-500/20 text-surface-300 border border-surface-500/30',
    };
    const levelText: Record<string, string> = {
        ok: 'text-surface-200',
        warn: 'text-amber-300',
        critical: 'text-red-300',
    };

    async function copyInstanceId(): Promise<void> {
        if (!node) return;
        try {
            await navigator.clipboard.writeText(node.instanceId);
            toasts.success(m.admin_cluster_node_copied());
        } catch {
            // Clipboard denied: the id stays visible in the title tooltip.
        }
    }
</script>

<div
    class="rounded-lg border bg-surface-900/40 p-3 {state.border}"
    data-testid="cluster-service"
    data-kind={entry.kind}
    data-state={entry.state}>
    <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-2">
            <span class="inline-block h-2 w-2 shrink-0 rounded-full {state.dot}" aria-hidden="true"
            ></span>
            <span class="text-xs rounded-full px-2 py-0.5 font-medium {roleColors[entry.kind]}">
                {serviceKindLabel(entry.kind)}
            </span>
            {#if entry.implementation}
                <span
                    class="text-[11px] rounded px-1.5 py-0.5 bg-surface-700/60 text-surface-300"
                    title={m.admin_cluster_runtime()}>
                    {implementationLabel(entry.implementation)}
                </span>
            {/if}
            {#if entry.isSelf}
                <span
                    class="text-[11px] rounded-full px-2 py-0.5 font-medium bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                    {m.admin_cluster_node_self()}
                </span>
            {/if}
        </div>
        <span class="text-xs rounded-full px-2 py-0.5 font-medium {state.pill}">
            {stateLabel(entry.state)}
        </span>
    </div>

    {#if entry.reasons.length > 0}
        <ul class="mt-2 space-y-0.5 text-xs {state.text}">
            {#each entry.reasons as reason (reason)}
                <li>{reasonLabel(reason, entry)}</li>
            {/each}
        </ul>
    {/if}

    {#if entry.state === 'notConfigured'}
        <p class="mt-2 text-xs text-muted">
            {entry.kind === 'sonic'
                ? m.admin_cluster_not_configured_sonic()
                : m.admin_cluster_not_configured_proxy()}
        </p>
    {:else}
        <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {#if node && friendlyName}
                <dt class="text-muted">{m.route_admin_cluster_col_instance()}</dt>
                <dd class="min-w-0 text-right">
                    <button
                        class="max-w-full truncate font-mono text-surface-300 hover:text-white"
                        title={m.admin_cluster_node_copy_title({ id: node.instanceId })}
                        onclick={copyInstanceId}>
                        {friendlyName.label}
                    </button>
                </dd>
            {/if}
            {#if entry.hostname}
                <dt class="text-muted">{m.admin_cluster_node_hostname()}</dt>
                <dd class="truncate text-right font-mono text-surface-200" title={entry.hostname}>
                    {entry.hostname}
                </dd>
            {/if}
            <dt class="text-muted">{m.admin_cluster_node_version()}</dt>
            <dd
                class="truncate text-right {showMismatch ? 'text-amber-400' : 'text-surface-200'}"
                title={showMismatch ? m.admin_cluster_node_version_mismatch() : entry.version}>
                {entry.version ?? '—'}
            </dd>
            {#if entry.uptimeSeconds !== undefined}
                <dt class="text-muted">{m.admin_cluster_node_uptime()}</dt>
                <dd class="text-right text-green-400">{formatUptime(entry.uptimeSeconds)}</dd>
            {/if}
            <dt class="text-muted">{m.admin_cluster_last_seen()}</dt>
            <dd class="text-right {state.text}" data-testid="cluster-service-last-seen">
                {entry.lastSeenAgoMs !== undefined
                    ? m.admin_cluster_seconds_ago({
                          seconds: Math.round(entry.lastSeenAgoMs / 1000),
                      })
                    : entry.node
                      ? m.admin_cluster_within_ttl()
                      : m.admin_cluster_never()}
            </dd>
            {#if node?.restarts24h !== undefined && !friendlyName?.isAutoGenerated}
                <!-- An auto-generated INSTANCE_ID is new on every start, so its restart
                     count is always 0 and would read as falsely reassuring. -->
                <dt class="text-muted" title={m.admin_cluster_node_restarts_title()}>
                    {m.admin_cluster_node_restarts()}
                </dt>
                <dd
                    class="text-right {(node.uncleanExits24h ?? 0) > 0
                        ? 'text-red-300'
                        : node.restarts24h > 0
                          ? 'text-amber-300'
                          : 'text-surface-200'}">
                    {node.restarts24h}
                    {#if (node.uncleanExits24h ?? 0) > 0}
                        ({m.admin_cluster_node_unclean({ count: node.uncleanExits24h ?? 0 })})
                    {/if}
                </dd>
            {/if}
            {#if node?.placement?.nodeName}
                <dt class="text-muted">{m.admin_cluster_node_k8s_node()}</dt>
                <dd class="truncate text-right font-mono text-surface-200">
                    {node.placement.nodeName}{#if node.placement.namespace}<span class="text-muted">
                            · {node.placement.namespace}</span
                        >{/if}
                </dd>
            {/if}
            {#if node?.runtime?.consumers}
                <dt class="text-muted">{m.admin_cluster_worker_consumers()}</dt>
                <dd class="text-right text-surface-200">
                    {m.admin_cluster_worker_consumers_value({
                        running: node.runtime.consumers.running,
                        paused: node.runtime.consumers.paused,
                    })}
                </dd>
            {/if}
            {#if node?.runtime?.watcher}
                <dt class="text-muted">{m.admin_cluster_worker_watcher()}</dt>
                <dd class="text-right text-surface-200">{node.runtime.watcher.state}</dd>
            {/if}
            {#if entry.process}
                <dt class="text-muted">{m.admin_cluster_process_memory()}</dt>
                <dd class="text-right text-surface-200">
                    {formatBinaryBytes(entry.process.rssBytes)}
                    {#if entry.process.childRssBytes !== undefined && entry.process.childCount}
                        <span class="block text-[11px] text-muted"
                            >{m.admin_cluster_process_children({
                                size: formatBinaryBytes(entry.process.childRssBytes),
                                count: entry.process.childCount,
                            })}</span>
                    {/if}
                </dd>
                {#if entry.process.childRssPeakBytes !== undefined && entry.process.childRssPeakBytes > 0}
                    <dt class="text-muted">{m.admin_cluster_children_peak()}</dt>
                    <dd class="text-right text-surface-200">
                        {formatBinaryBytes(entry.process.childRssPeakBytes)}
                    </dd>
                {/if}
                {#if entry.process.cpuPercent !== undefined}
                    <dt class="text-muted">{m.admin_cluster_process_cpu()}</dt>
                    <dd class="text-right text-surface-200">
                        {m.admin_cluster_percent({ value: entry.process.cpuPercent.toFixed(1) })}
                    </dd>
                {/if}
            {/if}
            {#if res}
                <dt class="text-muted" title={m.admin_cluster_node_memory_title()}>
                    {m.admin_cluster_container_memory()}
                </dt>
                <dd class="text-right {levelText[memLevel]}">
                    {formatBinaryBytes(res.memoryUsedBytes)} /
                    {res.memoryLimitBytes !== undefined
                        ? formatBinaryBytes(res.memoryLimitBytes)
                        : m.admin_cluster_node_no_limit()}
                    {#if res.memoryPeakBytes !== undefined}
                        <span
                            class="block text-[11px] {peakLevel === 'ok'
                                ? 'text-muted'
                                : levelText[peakLevel]}"
                            title={m.admin_cluster_node_peak_title()}
                            >{m.admin_cluster_node_peak({
                                value: formatBinaryBytes(res.memoryPeakBytes),
                            })}</span>
                    {/if}
                    {#if (res.memoryOomKills ?? 0) > 0}
                        <span class="block text-[11px] text-amber-300"
                            >{m.admin_cluster_node_oom_kills({
                                count: res.memoryOomKills ?? 0,
                            })}</span>
                    {/if}
                    {#if res.memoryRequestBytes !== undefined}
                        <span class="block text-[11px] text-muted"
                            >{m.admin_cluster_node_request({
                                value: formatBinaryBytes(res.memoryRequestBytes),
                            })}</span>
                    {/if}
                </dd>
                {#if res.cpuUsedCores !== undefined || res.cpuLimitCores !== undefined}
                    <dt class="text-muted">{m.admin_cluster_container_cpu()}</dt>
                    <dd class="text-right text-surface-200">
                        {res.cpuUsedCores !== undefined
                            ? m.admin_cluster_node_cores({ value: formatCores(res.cpuUsedCores) })
                            : '—'}
                        /
                        {res.cpuLimitCores !== undefined
                            ? formatCores(res.cpuLimitCores)
                            : m.admin_cluster_node_no_limit()}
                    </dd>
                {/if}
            {/if}
            {#if entry.sidecar?.memoryLimitBytes !== undefined}
                <dt class="text-muted">{m.admin_cluster_sidecar_budget()}</dt>
                <dd class="text-right text-surface-200">
                    {formatBinaryBytes(entry.sidecar.memoryLimitBytes)}
                </dd>
            {/if}
        </dl>
        {#if friendlyName?.isAutoGenerated}
            <p class="mt-2 text-[11px] text-amber-300/80">{m.admin_cluster_node_auto_hint()}</p>
        {/if}
    {/if}
</div>
