<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { apiGet } from '$lib/api/client.js';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import QueueDepthBar from './QueueDepthBar.svelte';
    import { runSSEBus } from '$lib/stores/run-sse-bus.js';
    import { ObservabilityResponseSchema } from '$lib/schemas/task-system-observability.schema.js';
    import { taxonomyBadge } from '$lib/utils/health-taxonomy.js';
    import type { HealthVerdict } from '$lib/schemas/task-system-health.schema.js';
    import { ClusterStatusResponseSchema } from '$lib/schemas/api-admin-responses.js';

    interface ClusterInfo {
        totalOnline: number;
        totalRegistered: number;
        selfInstanceId: string;
    }

    let cluster = $state<ClusterInfo | null>(null);
    let health = $state<HealthVerdict | null>(null);
    let sseConnected = $state(false);
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let sseStatusTimer: ReturnType<typeof setInterval> | undefined;
    let unsubSSE: (() => void) | undefined;
    let disposed = false;

    async function fetchCluster(): Promise<void> {
        const { data } = await apiGet('/api/admin/cluster', ClusterStatusResponseSchema);
        if (disposed) return;
        if (!data) {
            cluster = null;
            return;
        }
        cluster = {
            totalOnline: data.totalOnline,
            totalRegistered: data.totalRegistered,
            selfInstanceId: data.selfInstanceId,
        };
    }

    async function fetchHealth(): Promise<void> {
        const { data } = await apiGet(
            '/api/admin/task-system/observability',
            ObservabilityResponseSchema,
        );
        if (disposed) return;
        health = data ? data.health : null;
    }

    onMount(() => {
        void fetchCluster();
        void fetchHealth();
        pollTimer = setInterval(() => {
            void fetchCluster();
            void fetchHealth();
        }, 15_000);

        unsubSSE = runSSEBus.onAnyChange(() => {
            sseConnected = runSSEBus.connected;
        });
        sseConnected = runSSEBus.connected;

        // Poll the SSE connected flag independently so disconnects with no further
        // events (silence after drop) are reflected in the UI promptly.
        sseStatusTimer = setInterval(() => {
            sseConnected = runSSEBus.connected;
        }, 2_000);
    });

    onDestroy(() => {
        disposed = true;
        if (pollTimer) clearInterval(pollTimer);
        if (sseStatusTimer) clearInterval(sseStatusTimer);
        unsubSSE?.();
    });
</script>

<div
    class="mb-4 flex flex-wrap items-center gap-4 rounded-lg border border-surface-700/50 bg-surface-900/60 px-4 py-2">
    <QueueDepthBar />

    {#if health}
        {@const badge = taxonomyBadge(health.status)}
        <span class="h-4 w-px bg-surface-700"></span>
        <Tooltip
            text={health.reasons.length > 0 ? health.reasons[0].summary : 'Task system healthy'}
            position="bottom">
            <span class="flex items-center gap-2 text-xs">
                <span class="inline-block h-2 w-2 rounded-full {badge.dotClass}"></span>
                <span class="text-surface-300">Tasks:</span>
                <span class="font-medium {badge.textClass}">{badge.label}</span>
            </span>
        </Tooltip>
    {/if}

    {#if cluster}
        <span class="h-4 w-px bg-surface-700"></span>
        <Tooltip text={`This server: ${cluster.selfInstanceId}`} position="bottom">
            <span class="flex items-center gap-2 text-xs">
                <span
                    class="inline-block h-2 w-2 rounded-full {cluster.totalOnline > 0
                        ? 'bg-green-400'
                        : 'bg-red-400'}"></span>
                <span class="text-surface-300">Servers:</span>
                <span class="tabular-nums text-surface-200">
                    {cluster.totalOnline}/{cluster.totalRegistered}
                </span>
            </span>
        </Tooltip>
    {/if}

    <span class="h-4 w-px bg-surface-700"></span>

    <Tooltip
        text={sseConnected ? 'Live updates connected' : 'Live updates disconnected — reconnecting'}
        position="bottom">
        <span class="flex items-center gap-2 text-xs">
            <span
                class="inline-block h-2 w-2 rounded-full {sseConnected
                    ? 'bg-green-400'
                    : 'bg-amber-400 animate-pulse'}"></span>
            <span class="text-surface-300">{sseConnected ? 'Live' : 'Reconnecting'}</span>
        </span>
    </Tooltip>
</div>
