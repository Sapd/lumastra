<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { CoverageBar } from '$lib/schemas/task-dashboard.schema.js';

    let { bar }: { bar: CoverageBar } = $props();

    // Derive the percentage from done/total unless an explicit override is given.
    let percent = $derived.by(() => {
        if (bar.percent !== undefined) return Math.min(100, Math.round(bar.percent));
        if (bar.total > 0) return Math.min(100, Math.round((bar.done / bar.total) * 100));
        return 0;
    });

    // ≥80 green, ≥50 amber, else red — matching the sonic-embeddings thresholds.
    let barColor = $derived(
        percent >= 80 ? 'bg-green-500' : percent >= 50 ? 'bg-yellow-500' : 'bg-red-500',
    );
    let textColor = $derived(
        percent >= 80 ? 'text-green-400' : percent >= 50 ? 'text-yellow-400' : 'text-red-400',
    );

    let unit = $derived(bar.unitLabel ?? 'items');
</script>

<div class="card-base">
    <div class="mb-4">
        <h3 class="text-lg font-semibold text-surface-100 mb-1">{bar.label}</h3>
        <p class="text-sm text-surface-400">
            {bar.done.toLocaleString()} of {bar.total.toLocaleString()}
            {unit}
        </p>
    </div>

    <div class="w-full bg-surface-700 rounded-full h-3 overflow-hidden">
        <div
            class="{barColor} h-full transition-all duration-500"
            style={`width: ${percent}%`}
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={bar.label}>
        </div>
    </div>

    <div class="mt-3 text-right">
        <span class="text-lg font-bold {textColor}">{percent}%</span>
    </div>
</div>
