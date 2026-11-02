<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    interface Props {
        lastUsedAt?: string | null;
        usageCount?: number;
        formatRelativeDate: (dateStr: string | null) => string;
    }

    let { lastUsedAt, usageCount, formatRelativeDate }: Props = $props();
</script>

<td class="px-4 py-3 text-muted">
    {formatRelativeDate(lastUsedAt ?? null)}
    {#if usageCount && usageCount > 0}
        <span class="text-surface-500">({usageCount}x)</span>
    {/if}
</td>
