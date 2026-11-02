<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, ChartPie } from 'svelte-hero-icons';
    import type { NamespaceMetrics } from '$lib/types/cache-stats';
    import { getNamespaceColumns } from './namespaces/column-registry';

    interface Props {
        /**
         * Cache namespace performance table
         */
        namespaces: Record<string, NamespaceMetrics>;
        onClear: (namespace: string) => void;
    }

    let { namespaces, onClear }: Props = $props();

    // Column Registry Pattern - eliminates column-based branching
    let columns = $derived(getNamespaceColumns());
</script>

<div class="card-gradient-lg">
    <h3 class="text-xl font-bold text-white mb-6 flex items-center gap-2">
        <Icon src={ChartPie} class="w-6 h-6 text-blue-400" />
        Cache Namespaces Performance
    </h3>
    <div class="overflow-x-auto">
        <table class="w-full">
            <!-- Column Registry Pattern - eliminates column-based branching -->
            <thead>
                <tr class="text-left text-surface-400 text-sm border-b border-surface-700">
                    {#each columns as column (column.id)}
                        <th
                            class="pb-3 font-semibold {column.align === 'right'
                                ? 'text-right'
                                : column.align === 'center'
                                  ? 'text-center'
                                  : ''}">
                            {column.header}
                        </th>
                    {/each}
                </tr>
            </thead>
            <tbody class="text-sm">
                {#each Object.entries(namespaces) as [namespace, metrics] (namespace)}
                    <tr class="border-b border-surface-800 hover:bg-surface-800/50">
                        {#each columns as column (column.id)}
                            {@const CellComponent = column.cell}
                            <CellComponent {namespace} {metrics} {onClear} />
                        {/each}
                    </tr>
                {/each}
            </tbody>
        </table>
    </div>
</div>
