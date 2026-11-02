<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import { apiGet } from '$lib/api/client.js';
    import { toasts } from '$lib/stores/toast.store.js';
    import * as m from '$lib/paraglide/messages.js';
    import {
        FailurePatternsResponseSchema,
        type FailurePattern,
    } from '$lib/schemas/task-system-failure-detection.schema.js';

    interface Props {
        /** When set, scopes the patterns to a single task (detail panel). */
        taskId?: string;
        source?: 'run' | 'item' | 'all';
        /** Initial window in hours (1, 24 or 168). */
        defaultHours?: number;
    }

    let { taskId, source = 'all', defaultHours = 24 }: Props = $props();

    let patterns = $state<FailurePattern[]>([]);
    let loading = $state(true);
    let loadError = $state<string | null>(null);
    // Initial value only; the window buttons own it after mount.
    // svelte-ignore state_referenced_locally
    let sinceHours = $state(defaultHours);

    const windowOptions: { label: string; hours: number }[] = [
        { label: '1h', hours: 1 },
        { label: '24h', hours: 24 },
        { label: '7d', hours: 168 },
    ];

    // Window buttons can be clicked faster than the query answers; only the
    // newest request may set the rows (else 7d is highlighted over 1h data).
    let loadSeq = 0;

    async function load(): Promise<void> {
        const seq = ++loadSeq;
        loading = true;
        const params: Record<string, string> = {
            source,
            sinceHours: String(sinceHours),
        };
        if (taskId) params.taskId = taskId;
        const qs = new URLSearchParams(params).toString();
        const { data, error } = await apiGet(
            `/api/admin/task-system/failures/patterns?${qs}`,
            FailurePatternsResponseSchema,
        );
        if (seq !== loadSeq) return;
        if (error || !data) {
            loadError = error ?? 'Could not load failure patterns';
        } else {
            patterns = data.patterns;
            loadError = null;
        }
        loading = false;
    }

    async function changeWindow(hours: number): Promise<void> {
        sinceHours = hours;
        await load();
    }

    async function copySample(message: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(message);
            toasts.success('Sample copied');
        } catch {
            toasts.error('Copy failed');
        }
    }

    function formatTime(iso: string): string {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        return d.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    onMount(load);
</script>

<section class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
            <h2 class="text-sm font-semibold uppercase tracking-wide text-surface-300">
                Failure patterns
            </h2>
            <p class="mt-1 text-xs text-surface-500">
                Failures
                <span
                    class="cursor-help underline decoration-dotted"
                    title="Errors are grouped by their underlying message, ignoring details like ids, timestamps, file paths, and numbers — so the same problem that hit many items shows up as one row.">
                    grouped by their cause</span
                >, so "42 items failed with the same error" is one row, not 42.
            </p>
        </div>
        <div class="flex items-center gap-2">
            <span class="text-xs text-surface-400">Window:</span>
            {#each windowOptions as opt (opt.hours)}
                <button
                    type="button"
                    class="rounded px-2.5 py-1 text-xs transition-colors {sinceHours === opt.hours
                        ? 'bg-cyan-700 text-white'
                        : 'bg-surface-700 text-surface-400 hover:bg-surface-600'}"
                    onclick={() => changeWindow(opt.hours)}>
                    {opt.label}
                </button>
            {/each}
        </div>
    </div>

    {#if loading}
        <div class="py-6 text-center text-sm text-surface-400">Loading patterns…</div>
    {:else if loadError}
        <div class="rounded border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {loadError}
        </div>
    {:else if patterns.length === 0}
        <div
            class="rounded border border-surface-700/40 bg-surface-900/30 py-6 text-center text-sm text-surface-400">
            {#if taskId}
                {m.admin_failure_patterns_none_task({
                    window: windowOptions.find((o) => o.hours === sinceHours)?.label ?? '',
                })}
            {:else}
                No failures in this window. Nothing to group.
            {/if}
        </div>
    {:else}
        <ul class="space-y-2">
            {#each patterns as p (p.source + ':' + p.fingerprint)}
                <li class="rounded border border-surface-700/50 bg-surface-900/40 p-3">
                    <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                            <div class="flex flex-wrap items-center gap-2">
                                <span
                                    class="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide {p.source ===
                                    'run'
                                        ? 'bg-indigo-900/40 text-indigo-300'
                                        : 'bg-teal-900/40 text-teal-300'}"
                                    title={p.source === 'run'
                                        ? 'A whole job failed'
                                        : 'An individual item failed during a job'}>
                                    {p.source === 'run' ? 'whole job' : 'single item'}
                                </span>
                                {#if p.kinds && p.kinds.length > 0}
                                    {#each p.kinds as kind (kind)}
                                        <span
                                            class="rounded bg-surface-700 px-1.5 py-0.5 text-[10px] text-surface-300">
                                            {kind}
                                        </span>
                                    {/each}
                                {/if}
                                <code class="truncate font-mono text-sm text-surface-200">
                                    {p.normalizedMessage || '(empty message)'}
                                </code>
                            </div>
                            <p class="mt-1 truncate font-mono text-xs text-surface-500">
                                {p.sampleMessage}
                            </p>
                            <p class="mt-1 text-[11px] text-surface-500">
                                First {formatTime(p.firstSeen)} · last {formatTime(p.lastSeen)}
                                {#if !taskId && p.affectedTasks.length > 0}
                                    · tasks: {p.affectedTasks.join(', ')}{p.affectedTasksOverflow >
                                    0
                                        ? ` +${p.affectedTasksOverflow}`
                                        : ''}
                                {/if}
                            </p>
                        </div>
                        <div class="flex shrink-0 flex-col items-end gap-1">
                            <span
                                class="rounded bg-surface-700 px-2 py-0.5 text-sm font-semibold tabular-nums text-surface-100"
                                title="Occurrences in the window">
                                {p.count}
                            </span>
                            <button
                                type="button"
                                class="text-[11px] text-cyan-400 hover:text-cyan-300 hover:underline"
                                onclick={() => copySample(p.sampleMessage)}>
                                Copy sample
                            </button>
                        </div>
                    </div>
                </li>
            {/each}
        </ul>
    {/if}
</section>
