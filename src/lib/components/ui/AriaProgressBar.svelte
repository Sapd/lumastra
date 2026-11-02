<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    interface Props {
        label: string;
        value: number; // 0-100
        class?: string;
        barClass?: string;
    }
    let { label, value, class: className = '', barClass = 'bg-primary-500' }: Props = $props();
    const clamped = $derived(Math.round(Math.min(100, Math.max(0, value))));
</script>

<div
    role="progressbar"
    aria-valuenow={clamped}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-label={label}
    class="relative h-2 bg-surface-700 rounded-full overflow-hidden {className}">
    <div class="h-full {barClass} transition-all" style="width: {clamped}%"></div>
</div>
