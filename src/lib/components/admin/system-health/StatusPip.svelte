<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    interface Props {
        status: 'green' | 'amber' | 'red' | 'unknown';
        size?: 'sm' | 'md';
    }

    const { status, size = 'md' }: Props = $props();

    const colorClass = $derived.by(() => {
        switch (status) {
            case 'green':
                return 'bg-green-400';
            case 'amber':
                return 'bg-amber-400';
            case 'red':
                return 'bg-red-400';
            default:
                return 'bg-surface-600';
        }
    });

    const sizeClass = $derived(size === 'sm' ? 'h-2 w-2' : 'h-3 w-3');
</script>

<span class="inline-block rounded-full shrink-0 {sizeClass} {colorClass}" aria-hidden="true"></span>
