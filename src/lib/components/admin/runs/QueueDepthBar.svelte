<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { apiGet } from '$lib/api/client.js';
    import { SchedulerStateSchema } from '$lib/schemas/run.schema.js';
    import { resourceClassLabel } from '$lib/utils/operator-labels.js';

    interface QueueDepth {
        class: string;
        waiting: number;
        active: number;
        paused: boolean;
    }

    let depths: QueueDepth[] = $state([]);
    let staleError = $state(false);
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let disposed = false;

    async function fetchDepths(): Promise<void> {
        const { data, error } = await apiGet('/api/scheduler', SchedulerStateSchema);
        if (disposed) return;
        if (error || !data?.queueDepths) {
            staleError = true;
            return;
        }
        staleError = false;
        depths = Object.entries(data.queueDepths).map(([cls, info]) => ({
            class: cls,
            waiting: info.waiting ?? 0,
            active: info.active ?? 0,
            paused: info.paused ?? false,
        }));
    }

    onMount(() => {
        void fetchDepths();
        pollTimer = setInterval(() => void fetchDepths(), 15_000);
    });

    onDestroy(() => {
        disposed = true;
        if (pollTimer) clearInterval(pollTimer);
    });
</script>

{#if depths.length > 0}
    <div class="flex flex-wrap gap-3 items-center">
        {#each depths as q (q.class)}
            <div class="flex items-center gap-1.5 rounded-full px-3 py-1 text-sm bg-surface-700">
                <span class="font-medium text-surface-200">{resourceClassLabel(q.class)}</span>
                {#if q.paused}
                    <span class="text-amber-400">paused</span>
                {:else}
                    {#if q.active > 0}
                        <span class="text-green-400">{q.active} running</span>
                    {/if}
                    {#if q.waiting > 0}
                        <span class="text-blue-400">{q.waiting} waiting</span>
                    {/if}
                    {#if q.active === 0 && q.waiting === 0}
                        <span class="text-surface-400">idle</span>
                    {/if}
                {/if}
            </div>
        {/each}
        {#if staleError}
            <span class="text-xs text-amber-500">(may be out of date)</span>
        {/if}
    </div>
{/if}
