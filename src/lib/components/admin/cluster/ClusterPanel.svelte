<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { useAutoRefresh } from '$lib/utils/use-auto-refresh.svelte';
    import {
        Icon,
        ServerStack,
        CheckCircle,
        XCircle,
        ExclamationTriangle,
        InformationCircle,
    } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import { StatCard } from '$lib/components/admin';
    import ClusterHostCard from './ClusterHostCard.svelte';
    import ClusterServiceCard from './ClusterServiceCard.svelte';
    import { buildServiceEntries, groupServicesByHost } from './cluster-hosts.js';
    import * as adminApi from '$lib/api/admin';
    import { toasts } from '$lib/stores/toast.store';
    import { getErrorMessage } from '$lib/utils/error-handling';
    import { taxonomyFromCluster, taxonomyBadge } from '$lib/utils/health-taxonomy';
    import type { ClusterStatusResponse } from '$lib/schemas/api-admin-responses';

    let clusterStatus = $state<ClusterStatusResponse | null>(null);
    let loading = $state(true);
    let lastUpdated = $state<Date | null>(null);
    // Set on every poll attempt (success or failure), unlike lastUpdated which
    // only advances on success. Without this, a poll that fails on first load
    // and keeps failing never renders the freshness dot — the worst staleness
    // case would be invisible instead of showing red.
    let lastAttemptedAt = $state<Date | null>(null);

    /** Auto-refresh cadence. Freshness thresholds below scale off of this so
     *  a slower/faster poll doesn't misreport its own staleness. */
    const REFRESH_INTERVAL_MS = 10000;

    useAutoRefresh(loadClusterStatus, REFRESH_INTERVAL_MS);

    /** Wall-clock tick, updated every second, so the freshness dot degrades
     *  live even when no new data arrives — e.g. a backgrounded tab whose
     *  poll timer got throttled by the browser would otherwise stay green
     *  forever (the dot only ever reacted to loading vs idle, never to how
     *  long ago the last successful update actually was). */
    let nowTick = $state(Date.now());
    $effect(() => {
        const id = setInterval(() => {
            nowTick = Date.now();
        }, 1000);
        return () => clearInterval(id);
    });

    /**
     * Freshness of the last successful update, relative to the poll cadence:
     * - fresh: within 1.5x the interval — the normal steady-state case.
     * - aging: within 3x the interval — one or two polls have been missed.
     * - stale: beyond 3x the interval — the poll looks dead (e.g. a
     *   backgrounded tab whose timers are throttled).
     */
    let freshness = $derived.by((): 'fresh' | 'aging' | 'stale' => {
        if (!lastUpdated) return 'stale';
        const ageMs = nowTick - lastUpdated.getTime();
        if (ageMs <= REFRESH_INTERVAL_MS * 1.5) return 'fresh';
        if (ageMs <= REFRESH_INTERVAL_MS * 3) return 'aging';
        return 'stale';
    });

    // The last poll failed. With earlier data on screen that data is now stale
    // and says so; with none, the panel shows the error instead of nothing.
    let loadFailed = $state(false);

    async function loadClusterStatus(): Promise<void> {
        loading = true;
        lastAttemptedAt = new Date();
        try {
            const result = await adminApi.getClusterStatus();
            if (!result.error && result.data) {
                clusterStatus = result.data;
                lastUpdated = new Date();
                loadFailed = false;
            } else {
                // Toast once when polling starts failing, not every 10 s.
                if (!loadFailed) {
                    toasts.error(getErrorMessage(result.error, m.route_admin_cluster_load_error()));
                }
                loadFailed = true;
            }
        } finally {
            loading = false;
        }
    }

    // Unified 4-state taxonomy (Slice 1) — replaces the ad-hoc inline isHealthy
    // derivation so cluster speaks the identical enum/colours/wording as the
    // task-system rollup verdict.
    let clusterTaxonomy = $derived(
        taxonomyFromCluster(
            clusterStatus
                ? {
                      totalOnline: clusterStatus.totalOnline,
                      totalRegistered: clusterStatus.totalRegistered,
                  }
                : null,
        ),
    );
    let clusterBadge = $derived(taxonomyBadge(clusterTaxonomy));
    let isHealthy = $derived(clusterTaxonomy === 'healthy');

    // Single-node calm state: most OSS self-hosters run exactly one replica, so
    // clustering is not in use. Only the REGISTERED count decides: `nodes` holds
    // live nodes only, so a 3-node cluster down to one survivor (or none) is a
    // degraded cluster, not a single-node install.
    let isSingleNode = $derived.by(() => {
        const status = clusterStatus;
        if (!status) return false;
        return status.totalRegistered <= 1;
    });

    let missingCount = $derived.by(() => {
        const status = clusterStatus;
        return status ? status.totalRegistered - status.totalOnline : 0;
    });

    // Detect version mismatch across live web/worker nodes. The Live TV proxy runs on
    // its own pinned image by design (a restart drops every channel); whether it needs
    // an update is the server's proxyCompat decision below. The sonic sidecar carries
    // its own version number.
    let versions = $derived.by(() => {
        const status = clusterStatus;
        return status
            ? new Set(
                  status.nodes
                      .filter((n) => n.role !== 'proxy' && (n.implementation ?? 'node') === 'node')
                      .map((n) => n.version),
              )
            : new Set<string>();
    });

    // Live TV proxies that need an update (amber) or no longer work with this server
    // (red), one line per distinct message.
    let proxyNotices = $derived.by(() => {
        const notices: Array<{ text: string; critical: boolean }> = [];
        for (const n of clusterStatus?.nodes ?? []) {
            const compat = n.proxyCompat;
            if (!compat || compat.state === 'current' || compat.state === 'unchecked') continue;
            const args = { proxyVersion: n.version, version: compat.serverVersion };
            const text =
                compat.reason === 'protocol_too_old'
                    ? m.admin_attention_livetv_proxy_too_old_detail(args)
                    : compat.reason === 'protocol_too_new'
                      ? m.admin_attention_livetv_proxy_too_new_detail(args)
                      : compat.reason === 'build_unknown'
                        ? m.admin_cluster_proxy_update_unknown(args)
                        : m.admin_cluster_proxy_update_changed(args);
            const critical = compat.state === 'incompatible';
            const seen = notices.find((notice) => notice.text === text);
            if (seen) seen.critical ||= critical;
            else notices.push({ text, critical });
        }
        return notices;
    });

    // Every service (live nodes, the proxy, the sonic sidecar) grouped by machine.
    let byHost = $derived(
        clusterStatus
            ? groupServicesByHost(buildServiceEntries(clusterStatus))
            : { hosts: [], unplaced: [] },
    );
    let hasVersionMismatch = $derived(versions.size > 1);

    function formatRelativeTime(isoString: string): string {
        const diff = Date.now() - new Date(isoString).getTime();
        const seconds = Math.floor(diff / 1000);
        if (seconds < 60) return `${seconds}s ago`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        return `${Math.floor(hours / 24)}d ago`;
    }

    function formatAbsoluteTime(isoString: string): string {
        return new Date(isoString).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    }

    function formatLastUpdated(date: Date): string {
        return date.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    }
</script>

{#snippet servicesByHost(versionMismatch: boolean)}
    <div class="space-y-4" data-testid="cluster-services-by-host">
        <h3 class="text-lg font-semibold">{m.admin_cluster_services_by_host()}</h3>
        {#each byHost.hosts as group (group.id)}
            <ClusterHostCard {group} {versionMismatch} />
        {/each}
        {#if byHost.unplaced.length > 0}
            <div data-testid="cluster-unplaced">
                <h4 class="text-sm font-semibold text-surface-300">
                    {m.admin_cluster_unplaced()}
                </h4>
                <p class="mb-2 text-xs text-muted">{m.admin_cluster_unplaced_hint()}</p>
                <div class="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                    {#each byHost.unplaced as entry (entry.key)}
                        <ClusterServiceCard {entry} {versionMismatch} />
                    {/each}
                </div>
            </div>
        {/if}
    </div>
{/snippet}

<div class="space-y-6">
    {#if lastAttemptedAt}
        <div class="flex items-center justify-end gap-2 text-xs text-muted">
            {#if loading}
                <span
                    class="w-2 h-2 rounded-full bg-cyan-400 animate-pulse"
                    title="Refreshing cluster status…"
                    aria-label="Refreshing cluster status"></span>
            {:else if freshness === 'stale'}
                <span
                    class="w-2 h-2 rounded-full bg-red-400"
                    title="Cluster status is stale — the last successful refresh was more than {Math.round(
                        (REFRESH_INTERVAL_MS * 3) / 1000,
                    )}s ago"
                    aria-label="Cluster status is stale"></span>
            {:else if freshness === 'aging'}
                <span
                    class="w-2 h-2 rounded-full bg-amber-400"
                    title="Cluster status refresh is running behind schedule"
                    aria-label="Cluster status refresh is delayed"></span>
            {:else}
                <span
                    class="w-2 h-2 rounded-full bg-green-400"
                    title="Cluster status is up to date"
                    aria-label="Cluster status is up to date"></span>
            {/if}
            <span>{m.common_updated()} {lastUpdated ? formatLastUpdated(lastUpdated) : '—'}</span>
        </div>
    {/if}

    {#if loadFailed && clusterStatus}
        <div
            class="flex items-center gap-3 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200"
            role="status">
            {m.route_admin_cluster_load_error()}
            {m.common_updated()}
            {lastUpdated ? formatLastUpdated(lastUpdated) : '—'}
        </div>
    {/if}

    {#if loading && !clusterStatus}
        <div class="text-muted text-center py-8">
            {m.route_admin_cluster_loading()}
        </div>
    {:else if loadFailed && !clusterStatus}
        <div
            class="px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300"
            role="alert">
            {m.route_admin_cluster_load_error()}
        </div>
    {:else if clusterStatus}
        <!-- Live TV proxy update / incompatibility -->
        {#each proxyNotices as notice (notice.text)}
            <div
                data-testid="cluster-proxy-notice"
                class="flex items-center gap-3 px-4 py-3 rounded-xl {notice.critical
                    ? 'bg-red-500/10 border border-red-500/30 text-red-300'
                    : 'bg-amber-500/10 border border-amber-500/30 text-amber-300'}">
                <Icon src={ExclamationTriangle} class="w-5 h-5 shrink-0" />
                <span>{notice.text}</span>
            </div>
        {/each}

        {#if isSingleNode}
            <!-- Single-node calm state: clustering is not in use. No alarming
                 "degraded" styling — a lone replica is a perfectly healthy
                 deployment. We still surface the one node card below. -->
            <div
                class="flex items-start gap-3 px-4 py-3 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-200">
                <Icon src={InformationCircle} class="w-5 h-5 shrink-0 mt-0.5" />
                <div class="space-y-1">
                    <p class="font-medium">Single node — clustering is not in use.</p>
                    <p class="text-sm text-cyan-200/80">
                        This page is only meaningful when you run multiple replicas. Membership,
                        version-drift and failover details appear here once a second node registers.
                    </p>
                </div>
            </div>

            {@render servicesByHost(false)}
        {:else}
            <!-- Degraded warning banner -->
            {#if !isHealthy && clusterStatus.totalOnline > 0}
                <div
                    class="flex items-center gap-3 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300">
                    <Icon src={ExclamationTriangle} class="w-5 h-5 shrink-0" />
                    <span>
                        {m.route_admin_cluster_not_responding({ count: missingCount })}
                        {clusterStatus.totalOnline} of {clusterStatus.totalRegistered}
                        expected nodes online.
                    </span>
                </div>
            {/if}

            <!-- Version mismatch warning -->
            {#if hasVersionMismatch}
                <div
                    class="flex items-center gap-3 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300">
                    <Icon src={ExclamationTriangle} class="w-5 h-5 shrink-0" />
                    <span>
                        Version mismatch: nodes are running {versions.size} different versions ({[
                            ...versions,
                        ].join(', ')}).
                    </span>
                </div>
            {/if}

            <!-- Summary Stats -->
            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <StatCard
                    icon={ServerStack}
                    title={m.route_admin_cluster_online_nodes()}
                    value="{clusterStatus.totalOnline} / {clusterStatus.totalRegistered}"
                    color="cyan" />

                <StatCard
                    icon={ServerStack}
                    title={m.route_admin_cluster_expected()}
                    value={clusterStatus.totalRegistered}
                    color="blue" />

                <StatCard
                    icon={isHealthy ? CheckCircle : XCircle}
                    title={m.route_admin_cluster_health()}
                    value={clusterBadge.label}
                    healthy={isHealthy} />
            </div>

            <!-- Services grouped by host -->
            {#if clusterStatus.nodes.length > 0}
                {@render servicesByHost(hasVersionMismatch)}
            {:else}
                <div
                    class="text-muted text-center py-6 bg-surface-800/30 rounded-xl border border-surface-700">
                    {#if clusterStatus.totalRegistered > 0}
                        {m.route_admin_cluster_all_offline({
                            count: clusterStatus.totalRegistered,
                        })}
                    {:else}
                        {m.route_admin_cluster_no_nodes()}
                    {/if}
                </div>
            {/if}
        {/if}

        <!-- Recent Events Table.
             Dedupes by instanceId — rolling container restarts otherwise
             flood the table with ~10 offline rows per generation. We
             keep the most recent event per instance AND count how many
             additional transitions were collapsed for it so a flapping
             node ("↻ 6 transitions" suffix) still surfaces the
             instability. The dedup banner shows N of M so the
             reduction is explicit. -->
        {@const transitionCounts = (() => {
            const counts = new Map<string, number>();
            for (const e of clusterStatus.events) {
                counts.set(e.instanceId, (counts.get(e.instanceId) ?? 0) + 1);
            }
            return counts;
        })()}
        {@const dedupedEvents = (() => {
            const seen = new Set<string>();
            const out: typeof clusterStatus.events = [];
            for (const e of clusterStatus.events) {
                if (seen.has(e.instanceId)) continue;
                seen.add(e.instanceId);
                out.push(e);
                if (out.length >= 50) break;
            }
            return out;
        })()}
        {#if dedupedEvents.length > 0}
            <div>
                <div class="mb-3 flex items-baseline justify-between">
                    <h3 class="text-lg font-semibold">
                        {m.route_admin_cluster_recent_events()}
                    </h3>
                    <span
                        class="text-xs text-muted"
                        title="Earlier transitions for the same instance are hidden — open the database for full history.">
                        Showing latest transition per instance · {dedupedEvents.length}
                        of {clusterStatus.events.length}
                    </span>
                </div>
                <div class="overflow-x-auto rounded-xl border border-surface-700">
                    <table class="w-full text-sm">
                        <thead class="bg-surface-800/60 text-muted">
                            <tr>
                                <th class="px-4 py-3 text-left"
                                    >{m.route_admin_cluster_col_time()}</th>
                                <th class="px-4 py-3 text-left"
                                    >{m.route_admin_cluster_col_instance()}</th>
                                <th class="px-4 py-3 text-left"
                                    >{m.route_admin_cluster_col_event()}</th>
                                <th class="px-4 py-3 text-left"
                                    >{m.route_admin_cluster_col_role()}</th>
                                <th class="px-4 py-3 text-left"
                                    >{m.route_admin_cluster_col_hostname()}</th>
                                <th class="px-4 py-3 text-left"
                                    >{m.route_admin_cluster_col_version()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each dedupedEvents as event (event.id)}
                                <tr class="border-t border-surface-700/50 hover:bg-surface-800/30">
                                    <td class="px-4 py-2.5 whitespace-nowrap">
                                        <span class="text-muted"
                                            >{formatRelativeTime(event.createdAt)}</span>
                                        <span class="text-surface-500 text-xs ml-1.5"
                                            >{formatAbsoluteTime(event.createdAt)}</span>
                                    </td>
                                    <td
                                        class="px-4 py-2.5 font-mono text-xs text-surface-300 max-w-[260px]"
                                        title={event.instanceId}>
                                        <span
                                            class="truncate inline-block max-w-[200px] align-middle"
                                            >{event.instanceId}</span>
                                        {#if (transitionCounts.get(event.instanceId) ?? 0) > 1}
                                            <span
                                                class="ml-1.5 inline-block rounded bg-amber-900/40 px-1.5 py-0.5 align-middle text-[10px] font-medium text-amber-200"
                                                title="{transitionCounts.get(
                                                    event.instanceId,
                                                )} transitions total — earlier transitions for this instance are hidden by the dedup. Possible flap.">
                                                ↻ {transitionCounts.get(event.instanceId)} transitions
                                            </span>
                                        {/if}
                                    </td>
                                    <td class="px-4 py-2.5">
                                        <span
                                            class="px-2 py-0.5 rounded-full text-xs font-medium {event.eventType ===
                                            'online'
                                                ? 'bg-green-500/20 text-green-300'
                                                : 'bg-red-500/20 text-red-300'}">
                                            {event.eventType}
                                        </span>
                                    </td>
                                    <td class="px-4 py-2.5 text-surface-400"
                                        >{event.role ?? '—'}</td>
                                    <td class="px-4 py-2.5 text-surface-400 font-mono text-xs"
                                        >{event.hostname ?? '—'}</td>
                                    <td class="px-4 py-2.5 text-surface-400"
                                        >{event.version ?? '—'}</td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>
            </div>
        {:else}
            <div class="text-muted text-center py-4">
                {m.route_admin_cluster_no_events()}
            </div>
        {/if}
    {:else}
        <div class="text-muted text-center py-8">
            {m.route_admin_cluster_load_error()}
        </div>
    {/if}
</div>
