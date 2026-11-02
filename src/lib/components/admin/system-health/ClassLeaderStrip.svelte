<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { ClassLeader } from '$lib/schemas/task-system-observability.schema.js';
    import { resourceClassLabel } from '$lib/utils/operator-labels';

    interface Props {
        leaders: ClassLeader[];
    }

    const { leaders }: Props = $props();

    // Below this remaining lock TTL we flag a possible flap (mirrors
    // LEADER_TTL_WARN_MS in schedule-overdue.ts: 5s TTL, 2s renew).
    const LEADER_TTL_WARN_MS = 2_000;

    function badgeClass(l: ClassLeader): string {
        if (l.holderInstanceId === null) return 'bg-red-900/50 text-red-300';
        if (l.ttlMs !== null && l.ttlMs < LEADER_TTL_WARN_MS)
            return 'bg-amber-900/50 text-amber-300';
        return 'bg-green-900/50 text-green-300';
    }
</script>

<section class="card-bordered p-4 space-y-2">
    <h3 class="text-sm font-semibold text-surface-200">Who's running each work type</h3>
    <div class="flex flex-wrap gap-2">
        {#each leaders as l (l.resourceClass)}
            <span
                class="rounded px-2 py-1 text-xs {badgeClass(l)}"
                title={l.holderInstanceId
                    ? `Running on ${l.holderInstanceId}${l.heldByThisReplica ? ' (this server)' : ''}`
                    : 'No server is handling this yet'}>
                {resourceClassLabel(l.resourceClass)}:
                {l.holderInstanceId ?? 'unassigned'}
            </span>
        {/each}
    </div>
</section>
