<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { NamespaceMetrics } from '$lib/types/cache-stats';

    interface Props {
        metrics: NamespaceMetrics;
    }

    let { metrics }: Props = $props();
</script>

<td class="py-4 text-right text-surface-400">{metrics.l1Stats.size}</td>
