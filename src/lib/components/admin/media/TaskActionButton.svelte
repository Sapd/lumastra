<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  One button for every task-starting control on the admin media page.

  Everything it renders comes from the subject-scoped tracker, i.e. from server
  state: a run started in another tab, by another admin, or before this page
  loaded disables the button just the same. The bespoke pollers it replaces
  inferred "finished" from a run falling out of a listing window, which reported
  success for failed runs; here the terminal state is read from the run itself.
-->

<script lang="ts">
    import { untrack } from 'svelte';
    import * as m from '$lib/paraglide/messages.js';
    import { runSSEBus } from '$lib/stores/run-sse-bus.js';
    import { cancelRun } from '$lib/api/admin.js';
    import { toasts } from '$lib/stores/toast.store';
    import type { SubjectRunsTracker } from '$lib/stores/subject-runs.js';

    interface Props {
        /** Task this control starts, e.g. `trickplay-generation`. */
        taskId: string;
        /** Idle label of the primary button. */
        label: string;
        tracker: SubjectRunsTracker;
        /**
         * Starts the work. A `{ deduped: true }` result means the orchestrator
         * folded the click into a run that was already going — we say so
         * instead of claiming new work was queued.
         */
        onstart: () => Promise<{ deduped?: boolean; runId?: string } | null | void> | void;
        /** Extra classes for the primary button. */
        class?: string;
        disabled?: boolean;
    }

    let {
        taskId,
        label,
        tracker,
        onstart,
        class: extraClass = '',
        disabled = false,
    }: Props = $props();

    const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

    // The bus is callback-driven, not rune-backed, so re-read the tracker on
    // every bus change instead of hoping a plain method call is reactive.
    let version = $state(0);
    let starting = $state(false);
    let cancelBusy = $state(false);
    let deduped = $state(false);
    let generation = 0;
    $effect(() => {
        void tracker;
        untrack(() => {
            starting = false;
            cancelBusy = false;
            deduped = false;
        });
        return () => {
            generation++;
        };
    });

    $effect(() => runSSEBus.onAnyChange(() => (version += 1)));

    const inFlight = $derived.by(() => {
        version;
        return tracker.runsFor(taskId).filter((r) => !TERMINAL.has(r.state));
    });
    const progress = $derived.by(() => {
        version;
        return tracker.progressFor(taskId);
    });

    const isCancelling = $derived(inFlight.some((r) => r.state === 'cancelling'));
    const isRunning = $derived(inFlight.some((r) => r.state === 'active'));
    const busy = $derived(starting || inFlight.length > 0);

    const statusText = $derived(
        isCancelling
            ? m.task_action_cancelling()
            : isRunning
              ? m.task_action_running()
              : inFlight.length > 0 || starting
                ? m.task_action_queued()
                : deduped
                  ? m.task_action_already_running()
                  : '',
    );

    async function start(): Promise<void> {
        if (busy || disabled) return;
        const token = generation;
        const owner = tracker;
        starting = true;
        deduped = false;
        try {
            const result = await onstart();
            if (token !== generation || owner !== tracker) return;
            deduped = result?.deduped === true;
            if (result?.runId) owner.observeRun?.(result.runId);
            // Surface the collapse as a one-shot toast, not only as status
            // text. The text branch is shadowed by 'Running'/'Queued' whenever
            // inFlight is non-empty — which is precisely when a dedup happens —
            // so on its own it would essentially never be seen. This is the
            // visible half of the "Regenerate outros silently does nothing"
            // fix: the click collapsed into an already-running analysis.
            if (deduped) toasts.info(m.task_action_already_running());
        } catch {
            // A rejected start (network error) otherwise only re-enabled the
            // button, with no sign the click did nothing.
            if (token === generation) toasts.error(m.task_action_start_failed());
        } finally {
            if (token === generation) starting = false;
            // The started run reaches the tracker through the bus; bump anyway
            // so an immediately-deduped click re-renders without waiting.
            version += 1;
        }
    }

    async function cancel(): Promise<void> {
        cancelBusy = true;
        try {
            for (const run of inFlight) {
                const { error, status } = await cancelRun(run.id);
                // 409 = it finished on its own meanwhile; nothing left to stop.
                if (error && status !== 409) {
                    toasts.error(m.task_action_cancel_failed());
                    return;
                }
            }
        } finally {
            cancelBusy = false;
            version += 1;
        }
    }
</script>

<div class="inline-flex flex-wrap items-center gap-2">
    <button
        onclick={start}
        disabled={busy || disabled}
        class="btn btn-sm variant-filled-primary {extraClass}">{label}</button>

    {#if statusText}
        <span class="text-xs text-surface-300">{statusText}</span>
    {/if}

    {#if progress}
        <span class="text-xs tabular-nums text-green-400"
            >{progress.total > 0
                ? `${progress.processed} / ${progress.total}`
                : progress.processed}</span>
    {/if}

    {#if inFlight.length > 1}
        <span class="text-xs text-surface-400"
            >{m.task_action_concurrent({ count: inFlight.length })}</span>
    {/if}

    {#if inFlight.length > 0}
        <button onclick={cancel} disabled={cancelBusy} class="btn btn-sm variant-ghost-error"
            >{m.task_action_cancel()}</button>
    {/if}
</div>
