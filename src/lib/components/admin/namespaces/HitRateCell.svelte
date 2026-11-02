<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { NamespaceMetrics } from '$lib/types/cache-stats';
    import { calculateHitRate, getHitRateColor } from '$lib/utils/cache-utils';

    interface Props {
        metrics: NamespaceMetrics;
    }

    let { metrics }: Props = $props();

    let hitRate = $derived(calculateHitRate(metrics.l1Stats.hits, metrics.l1Stats.misses));
</script>

<td class="py-4 text-right">
    <span class="font-semibold {getHitRateColor(hitRate)}">{hitRate.toFixed(1)}%</span>
</td>
