<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  "Safe to restart?" — one line near the top of the health page answering the
  question every self-hoster has before `docker compose up -d`: is anything
  in progress, and would restarting delay it or actually lose it.

  Reads GET /api/admin/system/restart-safety, which derives the verdict from
  real signals (task_history active/pending/cancelling runs, whether the
  active task's progress is durable per-item via TaskDefinition.coversStages,
  and the pending-write-drain queue depth). See that endpoint's def for the
  full reasoning — this component only renders the verdict it returns.
-->
<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { apiGet } from '$lib/api/client.js';
    import { formatDurationMs } from '$lib/utils/admin/formatters.js';
    import * as m from '$lib/paraglide/messages.js';
    import {
        RestartSafetyResponseSchema,
        type RestartSafetyResponse,
        type RestartSafetyItem,
    } from '$lib/schemas/admin-restart-safety.schema.js';

    let data = $state<RestartSafetyResponse | null>(null);
    let loadError = $state<string | null>(null);
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let destroyed = false;

    async function load(): Promise<void> {
        const { data: res, error } = await apiGet(
            '/api/admin/system/restart-safety',
            RestartSafetyResponseSchema,
        );
        if (destroyed) return;
        if (error || !res) {
            loadError = error ?? m.admin_restart_load_failed();
        } else {
            data = res;
            loadError = null;
        }
    }

    onMount(() => {
        void load();
        // Same cadence as the rest of the health page's polling.
        pollTimer = setInterval(() => void load(), 15_000);
    });

    onDestroy(() => {
        destroyed = true;
        if (pollTimer) clearInterval(pollTimer);
    });

    // Items arrive longest-running-first from the server. The worst case in
    // each tier is therefore simply the first match.
    const worstLossy = $derived.by<RestartSafetyItem | null>(() => {
        if (!data) return null;
        return data.items.find((i) => !i.resumable) ?? null;
    });
    const worstWait = $derived.by<RestartSafetyItem | null>(() => {
        if (!data) return null;
        return data.items.find((i) => i.resumable) ?? null;
    });
    const otherCount = $derived.by<number>(() => {
        if (!data) return 0;
        return Math.max(0, data.items.length - 1);
    });
    const hasOtherResumableWork = $derived.by<boolean>(() => {
        if (!data || !worstLossy) return false;
        return data.items.some((i) => i.resumable) || data.pendingWrites > 0;
    });

    const headline = $derived.by<string | null>(() => {
        if (!data) return null;
        if (data.status === 'unknown') return m.admin_restart_unknown();
        if (data.status === 'safe') return m.admin_restart_safe();
        if (data.status === 'lossy' && worstLossy) {
            return m.admin_restart_lossy({
                duration: formatDurationMs(worstLossy.elapsedMs),
                taskName: worstLossy.taskName,
            });
        }
        // status === 'wait'
        if (worstWait && worstWait.backlogRemaining && worstWait.unitLabel && worstWait.etaMs) {
            return m.admin_restart_wait_eta({
                duration: formatDurationMs(worstWait.etaMs),
                taskName: worstWait.taskName,
                count: worstWait.backlogRemaining,
                unit: worstWait.unitLabel,
            });
        }
        if (worstWait) {
            return m.admin_restart_wait_generic({ taskName: worstWait.taskName });
        }
        return m.admin_restart_wait_pending({ count: data.pendingWrites });
    });

    function badgeClass(status: RestartSafetyResponse['status'] | undefined): string {
        if (status === 'safe') return 'border-green-800/60 bg-green-950/40 text-green-200';
        if (status === 'lossy') return 'border-red-800/60 bg-red-950/40 text-red-200';
        if (status === 'wait') return 'border-amber-800/60 bg-amber-950/40 text-amber-200';
        return 'border-surface-700 bg-surface-900/40 text-surface-300';
    }

    function dotClass(status: RestartSafetyResponse['status'] | undefined): string {
        if (status === 'safe') return 'bg-green-400';
        if (status === 'lossy') return 'bg-red-400';
        if (status === 'wait') return 'bg-amber-400';
        return 'bg-surface-500';
    }
</script>

{#if loadError}
    <div
        class="rounded border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300"
        aria-label={m.admin_restart_aria_label()}>
        {loadError}
    </div>
{:else if data && headline}
    <div
        class="rounded border px-4 py-3 text-sm flex items-center gap-3 {badgeClass(data.status)}"
        aria-label={m.admin_restart_aria_label()}>
        <span class="inline-block h-2.5 w-2.5 shrink-0 rounded-full {dotClass(data.status)}"></span>
        <span class="flex-1">
            {headline}
            {#if data.status === 'lossy' && hasOtherResumableWork}
                <span class="opacity-80"> {m.admin_restart_resumable_note()}</span>
            {/if}
            {#if otherCount > 0}
                <span class="opacity-80"> {m.admin_restart_more({ count: otherCount })}</span>
            {/if}
        </span>
    </div>
{/if}
