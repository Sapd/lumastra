<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { untrack } from 'svelte';
    import * as m from '$lib/paraglide/messages.js';
    import { resolve } from '$lib/paths';
    import { apiGet, apiPatch } from '$lib/api/client.js';
    import { toasts } from '$lib/stores/toast.store.js';
    import { explainRunError } from '$lib/utils/admin/run-error-display.js';
    import { docsUrl, TASK_TROUBLESHOOTING } from '$lib/utils/docs-url';
    import TermTooltip from '$lib/components/admin/glossary/TermTooltip.svelte';
    import { V1TaskStateResponseSchema } from '$lib/schemas/api-v1.js';
    import {
        CircuitFleetResponseSchema,
        type CircuitFleetEntry,
    } from '$lib/schemas/task-system-failure-detection.schema.js';

    interface Props {
        taskId: string;
    }

    let { taskId }: Props = $props();

    let enabling = $state(false);
    let overrideUntil = $state<string | null>(null); // breakerNextProbeAt from state response

    // Slice 3: surface the CURRENT circuit state (the audit found this panel
    // showed no state at all — only a force-enable button). Read from the fleet
    // endpoint and pick out this task's entry.
    let current = $state<CircuitFleetEntry | null>(null);

    let isPaused = $derived(current?.state === 'open' || current?.state === 'half_open');

    // The lookup failed: "Running normally" would be a guess, and for a paused
    // task it would also hide the Resume button.
    let loadFailed = $state(false);
    let loadSeq = 0;

    async function loadState(): Promise<void> {
        const seq = ++loadSeq;
        const id = taskId;
        const { data } = await apiGet(
            '/api/admin/task-system/circuits',
            CircuitFleetResponseSchema,
        );
        if (seq !== loadSeq) return;
        loadFailed = !data;
        if (data) {
            current = data.entries.find((e) => e.taskId === id) ?? null;
        }
    }

    /**
     * Operator wording for the breaker state. `circuitStateLabel()` said
     * "Running" for a closed breaker, which next to "Auto-pause" read as "the
     * auto-pause is running" — the opposite of what it means — and was
     * English-only.
     */
    function stateLabel(state: 'closed' | 'open' | 'half_open'): string {
        if (state === 'open') return m.admin_task_stat_circuit_value_open();
        if (state === 'half_open') return m.admin_task_stat_circuit_value_half_open();
        return m.admin_task_stat_circuit_value_closed();
    }

    /**
     * The recorded reason, in words. Runner codes such as
     * `orphaned_at_recovery` reached the screen verbatim; `explainRunError`
     * already knows them.
     */
    let reasonText = $derived.by((): string | null => {
        const raw = current?.lastErrorMessage ?? current?.openedReason ?? null;
        if (!raw) return null;
        return explainRunError(raw)?.summary ?? raw.replace(/[_-]/g, ' ');
    });

    function stateBadgeClass(circuitState: 'closed' | 'open' | 'half_open'): string {
        if (circuitState === 'open') return 'bg-red-900/40 text-red-300';
        if (circuitState === 'half_open') return 'bg-amber-900/40 text-amber-300';
        return 'bg-emerald-900/30 text-emerald-300';
    }

    // Loads on mount and again when the panel is reused for another task.
    $effect(() => {
        if (!taskId) return;
        untrack(() => {
            current = null;
            void loadState();
        });
    });

    async function forceEnable(): Promise<void> {
        if (enabling) return;
        enabling = true;
        try {
            const { data, error } = await apiPatch(
                `/api/tasks/${encodeURIComponent(taskId)}/state`,
                V1TaskStateResponseSchema,
                { breaker: 'enable', force: true },
            );
            if (error || !data) {
                // `admin_circuit_resume_error` / `_success` already existed —
                // this call site just never used them, so the one action that
                // clears an auto-pause reported itself in English only.
                toasts.error(
                    m.admin_circuit_resume_error({ error: error ?? m.toast_unknown_error() }),
                );
            } else {
                overrideUntil = data.breakerNextProbeAt ?? null;
                toasts.success(m.admin_circuit_resume_success());
                void loadState();
            }
        } finally {
            enabling = false;
        }
    }

    /**
     * True once the breaker has recorded WHY it opened. When it has, resuming
     * without looking at that reason just runs the task straight back into the
     * same failure — so the failures view becomes the primary action and
     * Resume is demoted to secondary. With no known cause there is nothing to
     * investigate first, and Resume stays primary.
     */
    let hasKnownCause = $derived(Boolean(current?.lastErrorMessage || current?.openedReason));

    function formatUntil(iso: string): string {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        return d.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
        });
    }
</script>

<div class="space-y-4">
    <!-- Current status (Slice 3) -->
    {#if loadFailed && !current}
        <div
            class="flex flex-wrap items-center gap-3 rounded border border-red-700/40 bg-red-900/20 p-3 text-sm text-red-300"
            role="alert">
            {m.admin_circuit_state_unavailable()}
            <button
                type="button"
                class="underline hover:text-red-200"
                onclick={() => void loadState()}>
                {m.common_retry()}
            </button>
        </div>
    {:else if current}
        <div
            class="flex flex-wrap items-center gap-3 rounded border border-surface-700/50 bg-surface-900/40 p-3 text-sm">
            <span class="rounded px-2 py-0.5 text-xs {stateBadgeClass(current.state)}">
                <TermTooltip term="circuit-breaker">{stateLabel(current.state)}</TermTooltip>
            </span>
            <span class="text-surface-400"
                >{m.admin_circuit_failures_in_row({ count: current.consecutiveFailures })}</span>
            {#if reasonText}
                <span class="text-surface-500"
                    >· {isPaused
                        ? m.admin_circuit_paused_because()
                        : m.admin_circuit_last_failure()}: {reasonText}</span>
            {/if}
            {#if current.forceEnabled}
                <span class="rounded bg-cyan-900/40 px-2 py-0.5 text-xs text-cyan-300"
                    >{m.admin_circuit_resumed_manually()}</span>
            {/if}
        </div>
    {:else}
        <div
            class="rounded border border-surface-700/50 bg-surface-900/40 p-3 text-sm text-surface-400">
            {m.admin_circuit_running_normally()}
        </div>
    {/if}

    <p class="text-sm text-surface-400">
        {#if isPaused}
            {m.admin_circuit_explain_paused()}
        {:else}
            {m.admin_circuit_explain_monitoring()}
        {/if}
    </p>

    {#if overrideUntil}
        <div class="rounded border border-green-700/40 bg-green-900/20 p-3 text-sm text-green-300">
            {m.admin_circuit_resumed_until({ until: formatUntil(overrideUntil) })}
        </div>
    {/if}

    <!-- Resume only exists while something is paused. It used to render for a
         healthy task too, next to "Running · 0 failures in a row" — a button
         that resumes nothing, under a heading asking why it was paused. -->
    {#if isPaused}
        <div class="flex flex-wrap items-center gap-3">
            {#if hasKnownCause}
                <a
                    href={resolve(`/admin/tasks/${encodeURIComponent(taskId)}?tab=failures`)}
                    class="rounded border border-amber-700/40 bg-amber-900/20 px-4 py-2 text-sm font-medium text-amber-300 transition-colors hover:bg-amber-900/40">
                    {m.admin_circuit_investigate_cause()}
                </a>
            {/if}
            <button
                type="button"
                class="rounded px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 {hasKnownCause &&
                isPaused
                    ? 'border border-surface-700/60 text-surface-300 hover:bg-surface-800/60'
                    : 'border border-amber-700/40 bg-amber-900/20 text-amber-300 hover:bg-amber-900/40'}"
                onclick={forceEnable}
                disabled={enabling}>
                {enabling ? m.admin_circuit_resuming() : m.admin_circuit_resume_now()}
            </button>
        </div>

        <!-- The consequence, next to the button that causes it. Resuming is a
         probe, not a fix: /admin/help/tasks says the same thing ("if the cause
         is still there, the task will just pause itself again"). This replaced
         a dimmer, hardcoded-English paragraph that said it twice as long. -->
        <p class="text-xs text-surface-500">
            {m.admin_circuit_resume_consequence()}
        </p>
    {/if}

    <details
        class="rounded border border-surface-700/50 bg-surface-900/20 p-3 text-sm text-surface-400">
        <summary class="cursor-pointer text-surface-300 hover:text-surface-100">
            {isPaused
                ? m.admin_circuit_learn_more_summary()
                : m.admin_circuit_learn_more_summary_idle()}
        </summary>
        <p class="mt-2">{m.admin_circuit_learn_more_body()}</p>
        <a
            href={resolve('/admin/help/tasks#circuit-breaker')}
            class="mt-2 inline-block text-xs font-medium text-sky-400 hover:text-sky-300">
            {m.admin_circuit_learn_more_link()}
        </a>
        <!-- Deepens the answer, never replaces it: everything an operator needs
             to act on an auto-paused task is already above (why it paused, what
             Resume does, when not to use it). A self-hosted box may have no
             internet at all, so this link is marked as leaving the app. -->
        <a
            href={docsUrl(TASK_TROUBLESHOOTING.queueNotDraining)}
            target="_blank"
            rel="noopener noreferrer"
            title={m.admin_docs_external_hint()}
            class="mt-2 ml-3 inline-block text-xs font-medium text-sky-400 hover:text-sky-300">
            {m.admin_docs_troubleshooting_guide()}
            <span aria-hidden="true">↗</span>
        </a>
    </details>
</div>
