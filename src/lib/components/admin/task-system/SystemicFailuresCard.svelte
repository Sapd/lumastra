<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import { apiGet } from '$lib/api/client.js';
    import { resourceClassLabel } from '$lib/utils/operator-labels';
    import {
        SystemicResponseSchema,
        type SystemicResponse,
    } from '$lib/schemas/task-system-failure-detection.schema.js';
    import { resolve } from '$lib/paths';

    let systemic = $state<SystemicResponse | null>(null);
    let loading = $state(true);
    let loadError = $state<string | null>(null);

    async function load(): Promise<void> {
        const { data, error } = await apiGet(
            '/api/admin/task-system/systemic?sinceHours=24',
            SystemicResponseSchema,
        );
        if (error || !data) {
            loadError = error ?? 'Could not load the health summary';
        } else {
            systemic = data;
            loadError = null;
        }
        loading = false;
    }

    const stalledTotal = $derived.by(() =>
        systemic ? Object.values(systemic.stalledByClass).reduce((a, b) => a + b, 0) : 0,
    );
    const stalledByClass = $derived.by(() =>
        systemic
            ? Object.entries(systemic.stalledByClass)
                  .filter(([, n]) => n > 0)
                  .sort((a, b) => b[1] - a[1])
            : [],
    );

    onMount(load);
</script>

<section
    class="rounded-lg border border-surface-700 bg-surface-900/40 p-4"
    aria-label="System-wide problems">
    <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-surface-300">
        System-wide problems
        <span class="ml-1 font-normal normal-case text-surface-500">(last 24h)</span>
    </h2>

    {#if loading}
        <p class="text-sm text-surface-400">Loading…</p>
    {:else if loadError}
        <p class="text-sm text-red-300">{loadError}</p>
    {:else if systemic}
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <!-- Interrupted jobs -->
            <a
                class="rounded border p-3 transition-colors hover:bg-surface-800/40 {stalledTotal >
                0
                    ? 'border-amber-700/40 bg-amber-950/20'
                    : 'border-surface-700/50 bg-surface-900/30'}"
                href={resolve('/admin/system/health#activity')}
                title="Jobs that stopped partway through and were automatically restarted. A non-zero count can mean the app is restarting often or is overloaded.">
                <div
                    class="text-2xl font-semibold tabular-nums {stalledTotal > 0
                        ? 'text-amber-300'
                        : 'text-surface-200'}">
                    {stalledTotal}
                </div>
                <div class="text-[11px] text-surface-400">jobs interrupted &amp; restarted</div>
                {#if stalledByClass.length > 0}
                    <div class="mt-1 text-[10px] text-surface-500">
                        {stalledByClass
                            .map(([cls, n]) => `${resourceClassLabel(cls)}: ${n}`)
                            .join(' · ')}
                    </div>
                {/if}
            </a>

            <!-- Jobs skipped under load -->
            <div
                class="rounded border border-surface-700/50 bg-surface-900/30 p-3"
                title="Jobs the system skipped in the last 24h because that kind of work was already too busy to take on more.">
                <div class="text-2xl font-semibold tabular-nums text-surface-200">
                    {systemic.backpressureShed}
                </div>
                <div class="text-[11px] text-surface-400">skipped while busy</div>
            </div>

            <!-- Jobs recovered after a restart -->
            <div
                class="rounded border border-surface-700/50 bg-surface-900/30 p-3"
                title="Jobs that were left behind when the app stopped unexpectedly, then automatically picked back up in the last 24h.">
                <div class="text-2xl font-semibold tabular-nums text-surface-200">
                    {systemic.orphansReclaimed}
                </div>
                <div class="text-[11px] text-surface-400">recovered after a restart</div>
            </div>

            <!-- Paused tasks -->
            <a
                class="rounded border p-3 transition-colors hover:bg-surface-800/40 {systemic.openCircuits >
                0
                    ? 'border-red-700/40 bg-red-950/20'
                    : 'border-surface-700/50 bg-surface-900/30'}"
                href={resolve('/admin/tasks')}
                title="Tasks the system paused automatically after they failed repeatedly, so they stop retrying in a tight loop.">
                <div
                    class="text-2xl font-semibold tabular-nums {systemic.openCircuits > 0
                        ? 'text-red-300'
                        : 'text-surface-200'}">
                    {systemic.openCircuits}
                </div>
                <div class="text-[11px] text-surface-400">paused after failures</div>
            </a>
        </div>
    {/if}
</section>
