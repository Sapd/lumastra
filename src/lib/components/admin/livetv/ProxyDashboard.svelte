<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onDestroy } from 'svelte';
    import {
        Icon,
        Signal,
        Users,
        Tv,
        Clock,
        ArrowPath,
        XMark,
        ExclamationTriangle,
    } from 'svelte-hero-icons';
    import { getProxyStatus, killProxyConnection, reconnectProxy } from '$lib/api/livetv.js';
    import type { ProxyStatusResponse } from '$lib/schemas/livetv.js';
    import { toasts } from '$lib/stores/toast.store';
    import StatCard from '$lib/components/admin/StatCard.svelte';
    import Card from '$lib/components/ui/Card.svelte';
    import { getSeverityBadgeClasses } from '$lib/utils/severity-styles';

    interface Props {
        initialStatus: ProxyStatusResponse | null;
        initialError: string | null;
    }

    let { initialStatus, initialError }: Props = $props();

    // svelte-ignore state_referenced_locally
    let status = $state<ProxyStatusResponse | null>(initialStatus);
    // svelte-ignore state_referenced_locally
    let error = $state<string | null>(initialError);
    let loading = $state(false);
    let actionLoading = $state<string | null>(null);

    // Color coding for connection limits
    function getLimitColor(active: number, max: number): 'green' | 'yellow' | 'red' {
        if (max <= 0) return 'green';
        const ratio = active / max;
        if (ratio >= 1) return 'red';
        if (ratio >= 0.5) return 'yellow';
        return 'green';
    }

    // FFmpeg health badge styling
    function getHealthBadgeClass(health?: 'healthy' | 'degraded' | 'error'): string {
        switch (health) {
            case 'healthy':
                return getSeverityBadgeClasses('success');
            case 'degraded':
                return getSeverityBadgeClasses('warning');
            case 'error':
                return getSeverityBadgeClasses('error');
            default:
                return getSeverityBadgeClasses('neutral');
        }
    }

    function formatUptime(seconds: number): string {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        if (hours > 0) return `${hours}h ${minutes}m`;
        return `${minutes}m`;
    }

    function formatBytes(bytes: number | undefined): string {
        if (!bytes || bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
    }

    function formatChannelUptime(startedAt: string): string {
        const start = new Date(startedAt).getTime();
        const now = Date.now();
        const seconds = Math.floor((now - start) / 1000);
        return formatUptime(seconds);
    }

    // Total connection limits
    let totalActiveStreams = $derived(
        status?.perSourceLimits.reduce((sum, s) => sum + s.activeStreams, 0) ?? 0,
    );
    let totalMaxStreams = $derived(
        status?.perSourceLimits.reduce((sum, s) => sum + s.maxStreams, 0) ?? 0,
    );
    let connectionColor = $derived(getLimitColor(totalActiveStreams, totalMaxStreams));

    // Auto-refresh every 5 seconds
    async function refresh(): Promise<void> {
        loading = true;
        const { data: result, error: fetchError } = await getProxyStatus();
        if (fetchError) {
            error = fetchError;
            status = null;
        } else if (result) {
            status = result;
            error = null;
        }
        loading = false;
    }

    const interval = setInterval(refresh, 5000);
    onDestroy(() => clearInterval(interval));

    // Kill action
    async function killConnection(channelId: string, viewerId?: string): Promise<void> {
        const key = viewerId ? `kill-${channelId}-${viewerId}` : `kill-${channelId}`;
        if (actionLoading) return;

        const confirmed = confirm(
            viewerId
                ? `Kick viewer ${viewerId} from this channel?`
                : 'Kill all connections on this channel? Viewers will be disconnected.',
        );
        if (!confirmed) return;

        actionLoading = key;
        const { error: killError } = await killProxyConnection(channelId, viewerId);
        if (killError) {
            toasts.error(`Kill failed: ${killError}`);
        } else {
            toasts.success('Connection killed');
            await refresh();
        }
        actionLoading = null;
    }

    // Reconnect action
    async function reconnectChannel(channelId: string): Promise<void> {
        if (actionLoading) return;

        const confirmed = confirm(
            'Force reconnect this channel? Viewers will be briefly disconnected while upstream reconnects.',
        );
        if (!confirmed) return;

        actionLoading = `reconnect-${channelId}`;
        const { error: reconnectError } = await reconnectProxy(channelId);
        if (reconnectError) {
            toasts.error(`Reconnect failed: ${reconnectError}`);
        } else {
            toasts.success('Reconnect triggered — viewers will rejoin automatically');
            await refresh();
        }
        actionLoading = null;
    }
</script>

<div class="space-y-6">
    <!-- Error banner -->
    {#if error}
        <div class="bg-red-900/30 border border-red-700 rounded-lg p-4 flex items-center gap-3">
            <Icon src={ExclamationTriangle} class="w-6 h-6 text-red-400 flex-shrink-0" />
            <div class="flex-1">
                <p class="text-red-300 font-medium">Stream proxy unreachable</p>
                <p class="text-red-400 text-sm">{error}</p>
            </div>
            <button class="btn btn-sm variant-ghost-error" onclick={refresh} disabled={loading}>
                {#if loading}
                    <span class="animate-spin">↻</span>
                {:else}
                    Retry
                {/if}
            </button>
        </div>
    {/if}

    <!-- Stats cards -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
            icon={Signal}
            title="Upstream Connections"
            value={status ? `${totalActiveStreams} / ${totalMaxStreams}` : '—'}
            color={connectionColor} />
        <StatCard
            icon={Users}
            title="Total Viewers"
            value={status?.totalViewers ?? '—'}
            color="blue" />
        <StatCard
            icon={Tv}
            title="Active Channels"
            value={status?.activeChannels ?? '—'}
            color="purple" />
        <StatCard
            icon={Clock}
            title="Proxy Uptime"
            value={status ? formatUptime(status.uptime) : '—'}
            healthy={status?.healthy ?? null} />
    </div>

    <!-- Per-source connection limits -->
    {#if status && status.perSourceLimits.length > 0}
        <Card>
            <h3 class="font-medium text-sm text-surface-400 mb-3">Per-Source Connection Limits</h3>
            <div class="space-y-2">
                {#each status.perSourceLimits as source (source.sourceId)}
                    {@const ratio =
                        source.maxStreams > 0 ? source.activeStreams / source.maxStreams : 0}
                    {@const barColor = getLimitColor(source.activeStreams, source.maxStreams)}
                    <div class="flex items-center gap-3">
                        <span
                            class="text-sm text-surface-300 w-32 truncate"
                            title={source.sourceId}>
                            {source.sourceId}
                        </span>
                        <div class="flex-1 bg-surface-700 rounded-full h-2">
                            <div
                                class="h-2 rounded-full transition-all {barColor === 'red'
                                    ? 'bg-red-500'
                                    : barColor === 'yellow'
                                      ? 'bg-yellow-500'
                                      : 'bg-green-500'}"
                                style="width: {Math.min(ratio * 100, 100)}%">
                            </div>
                        </div>
                        <span class="text-sm text-surface-400 w-16 text-right">
                            {source.activeStreams} / {source.maxStreams}
                        </span>
                    </div>
                {/each}
            </div>
        </Card>
    {/if}

    <!-- Per-channel table -->
    <Card padding="none">
        <div class="p-4 border-b border-surface-700">
            <h3 class="font-medium">Active Channels</h3>
        </div>

        {#if !status || status.channels.length === 0}
            <div class="p-8 text-center text-surface-400">No active streams.</div>
        {:else}
            <div class="overflow-x-auto">
                <table class="w-full text-sm">
                    <thead>
                        <tr class="border-b border-surface-700 text-left text-surface-400">
                            <th class="px-4 py-3 font-medium">Channel</th>
                            <th class="px-4 py-3 font-medium">Viewers</th>
                            <th class="px-4 py-3 font-medium">FFmpeg Health</th>
                            <th class="px-4 py-3 font-medium">Format</th>
                            <th class="px-4 py-3 font-medium">Segments</th>
                            <th class="px-4 py-3 font-medium">Memory</th>
                            <th class="px-4 py-3 font-medium">Init</th>
                            <th class="px-4 py-3 font-medium">Uptime</th>
                            <th class="px-4 py-3 font-medium">Failover</th>
                            <th class="px-4 py-3 font-medium">Source</th>
                            <th class="px-4 py-3 font-medium text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each status.channels as channel (channel.channelId)}
                            <tr class="border-b border-surface-700/50 hover:bg-surface-700/30">
                                <td class="px-4 py-3">
                                    <span class="text-white font-medium"
                                        >{channel.channelName}</span>
                                </td>
                                <td class="px-4 py-3">{channel.viewers}</td>
                                <td class="px-4 py-3">
                                    <span
                                        class="px-2 py-0.5 text-xs rounded-full {getHealthBadgeClass(
                                            channel.ffmpegHealth,
                                        )}"
                                        title={channel.ffmpegError ?? ''}>
                                        {channel.ffmpegHealth ??
                                            (channel.ffmpegHealthy ? 'healthy' : 'error')}
                                    </span>
                                </td>
                                <td class="px-4 py-3">
                                    <span
                                        class="px-2 py-0.5 text-xs rounded-full {channel.containerFormat ===
                                        'fmp4'
                                            ? 'bg-green-500/20 text-green-400'
                                            : 'bg-surface-500/20 text-surface-400'}">
                                        {channel.containerFormat === 'fmp4' ? 'fMP4' : 'MPEG-TS'}
                                    </span>
                                </td>
                                <td class="px-4 py-3 text-surface-400">
                                    {channel.segmentCount ?? 0}
                                </td>
                                <td class="px-4 py-3 text-surface-400">
                                    {formatBytes(channel.memoryBytes)}
                                </td>
                                <td class="px-4 py-3">
                                    <span
                                        class="inline-block w-2 h-2 rounded-full {channel.initSegmentReady
                                            ? 'bg-green-500'
                                            : 'bg-surface-500'}"></span>
                                </td>
                                <td class="px-4 py-3 text-surface-400">
                                    {formatChannelUptime(channel.startedAt)}
                                </td>
                                <td class="px-4 py-3">
                                    {#if channel.failoverExhausted}
                                        <span
                                            class="px-2 py-0.5 text-xs rounded-full bg-red-500/20 text-red-400">
                                            Exhausted
                                        </span>
                                    {:else if channel.failoverCount && channel.failoverCount > 0}
                                        <span class="text-yellow-400 text-xs">
                                            {channel.failoverCount} switch{channel.failoverCount !==
                                            1
                                                ? 'es'
                                                : ''}
                                        </span>
                                    {:else}
                                        <span class="text-surface-500 text-xs">—</span>
                                    {/if}
                                </td>
                                <td
                                    class="px-4 py-3 text-surface-400 text-xs truncate max-w-[120px]"
                                    title={channel.sourceId}>
                                    {channel.sourceId}
                                </td>
                                <td class="px-4 py-3 text-right">
                                    <div class="flex items-center justify-end gap-1">
                                        <button
                                            class="btn btn-sm variant-ghost-warning p-1"
                                            title="Force reconnect"
                                            onclick={() => reconnectChannel(channel.channelId)}
                                            disabled={actionLoading !== null}>
                                            <Icon src={ArrowPath} class="w-4 h-4" />
                                        </button>
                                        <button
                                            class="btn btn-sm variant-ghost-error p-1"
                                            title="Kill connection"
                                            onclick={() => killConnection(channel.channelId)}
                                            disabled={actionLoading !== null}>
                                            <Icon src={XMark} class="w-4 h-4" />
                                        </button>
                                    </div>
                                </td>
                            </tr>
                            {#if channel.ffmpegError}
                                <tr class="bg-red-900/10">
                                    <td colspan="11" class="px-4 py-2">
                                        <pre
                                            class="text-xs text-red-300/80 whitespace-pre-wrap font-mono max-h-32 overflow-y-auto">{channel.ffmpegError.trim()}</pre>
                                    </td>
                                </tr>
                            {/if}
                        {/each}
                    </tbody>
                </table>
            </div>
        {/if}
    </Card>
</div>
