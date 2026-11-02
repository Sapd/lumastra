<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    interface Props {
        label: string;
        value: number;
        total: number;
        description?: string;
        color?: string;
        thresholds?: { good?: number; warning?: number };
    }

    let {
        label,
        value,
        total,
        description = '',
        color = 'bg-blue-500',
        thresholds = {},
    }: Props = $props();

    let percentage = $derived(total > 0 ? Math.round((value / total) * 100) : 0);
    let textColor = $derived(
        thresholds.good
            ? percentage >= thresholds.good
                ? 'text-green-400'
                : thresholds.warning && percentage >= thresholds.warning
                  ? 'text-yellow-400'
                  : 'text-red-400'
            : 'text-surface-400',
    );
</script>

<div class="p-3 bg-surface-700/50 rounded-lg">
    <div class="flex justify-between items-center mb-2">
        <span class="text-subtitle">{label}</span>
        <span class="text-sm font-mono {textColor}">{percentage}%</span>
    </div>
    <div class="h-2 bg-surface-600 rounded-full overflow-hidden">
        <div class="h-full {color} rounded-full transition-all" style="width: {percentage}%"></div>
    </div>
    {#if description}
        <p class="text-caption mt-1">{description}</p>
    {/if}
</div>
