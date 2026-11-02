<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { apiPost } from '$lib/api/client.js';
    import * as m from '$lib/paraglide/messages.js';
    import { toasts } from '$lib/stores/toast.store';
    import { resolve } from '$lib/paths';
    import { CancelResponseSchema } from '$lib/schemas/run.schema';
    import AriaProgressBar from '$lib/components/ui/AriaProgressBar.svelte';
    import type { Run } from '$lib/schemas/run.schema';

    interface Props {
        run: Run;
        completedState?: 'completed' | 'failed';
    }
    let { run, completedState }: Props = $props();
    let busy = $state(false);

    const activeStage = $derived(run.stages.find((s) => s.state === 'active') ?? null);
    const total = $derived(activeStage?.total ?? 0);
    const processed = $derived(activeStage?.processed ?? 0);
    const hasDeterminate = $derived(!completedState && activeStage !== null && total > 0);
    const stageProgress = $derived(hasDeterminate ? Math.min(100, (processed / total) * 100) : 0);

    const etaMs = $derived.by((): number | null => {
        if (completedState) return null;
        const serverEta = activeStage?.etaMs;
        if (serverEta !== undefined && Number.isFinite(serverEta) && serverEta >= 0)
            return serverEta;
        if (hasDeterminate && processed > 0) {
            const started = Date.parse(run.startedAt);
            if (Number.isFinite(started)) {
                const elapsed = Date.now() - started;
                const remaining = (elapsed / processed) * (total - processed);
                if (Number.isFinite(remaining) && remaining >= 0) return remaining;
            }
        }
        return null;
    });

    function fmtEta(ms: number): string {
        const s = Math.round(ms / 1000);
        if (s < 60) return `~${s}s`;
        if (s < 3600) return `~${Math.round(s / 60)}m`;
        return `~${Math.round(s / 3600)}h`;
    }

    const statusLabel = $derived(
        activeStage?.label ??
            (run.state === 'pending'
                ? 'Queued…'
                : run.state === 'cancelling'
                  ? 'Cancelling…'
                  : 'Starting…'),
    );

    const who = $derived(run.trigger?.by ?? run.actor?.id ?? '');
    const mediaId = $derived(
        run.trigger?.sourceRoute?.match(/admin\/media\/([0-9a-f-]+)/i)?.[1] ?? null,
    );

    async function cancel(): Promise<void> {
        busy = true;
        const { error, status } = await apiPost(
            `/api/runs/${encodeURIComponent(run.id)}/cancel`,
            CancelResponseSchema,
            { hard: false },
        );
        busy = false;
        // 409 = the run finished before the cancel landed.
        if (status === 409) toasts.info(m.admin_run_cancel_already_finished());
        else if (error) toasts.error(`${m.admin_ops_cancel()} failed`);
        else toasts.success(`${m.admin_ops_cancel()} ✓`);
    }
</script>

<div class="rounded border border-surface-700/50 px-3 py-2 text-xs">
    <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
            <div class="truncate">
                {#if completedState}<span
                        class={completedState === 'completed' ? 'text-green-400' : 'text-red-400'}
                        >{completedState === 'completed' ? '✓' : '✗'}</span>
                {/if}
                {#if mediaId}<a
                        class="hover:underline"
                        href={resolve(`/admin/library/media/${mediaId}?tab=sync`)}>{run.label}</a
                    >{:else}{run.label}{/if}
            </div>
            <div class="flex items-center gap-2 text-surface-400">
                {#if who}<span class="truncate">{m.admin_ops_by()} {who}</span>{/if}
                {#if !completedState}
                    {#if hasDeterminate}
                        <span class="tabular-nums text-green-400"
                            >{processed.toLocaleString()}/{total.toLocaleString()}</span>
                    {:else}
                        <span class="text-blue-300"
                            >{statusLabel}{#if processed > 0}
                                · {processed.toLocaleString()} processed{/if}</span>
                    {/if}
                    {#if etaMs !== null}<span class="tabular-nums text-surface-300"
                            >{fmtEta(etaMs)}</span
                        >{/if}
                {/if}
            </div>
        </div>
        {#if !completedState}
            <button
                class="shrink-0 rounded border border-amber-500/50 px-2 py-1 text-amber-300 hover:bg-amber-500/10 disabled:opacity-40"
                disabled={busy}
                onclick={cancel}>{m.admin_ops_cancel()}</button>
        {/if}
    </div>
    {#if !completedState}
        <div class="mt-1">
            {#if hasDeterminate && activeStage}
                <AriaProgressBar label={activeStage.label} value={stageProgress} />
            {:else}
                <!-- indeterminate: run is active but no measurable total yet -->
                <div
                    class="h-1 w-full overflow-hidden rounded bg-surface-700"
                    role="progressbar"
                    aria-label={statusLabel}>
                    <div class="h-full w-1/3 animate-pulse rounded bg-blue-400/70"></div>
                </div>
            {/if}
        </div>
    {/if}
</div>
