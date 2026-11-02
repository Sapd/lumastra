<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import AriaProgressBar from '$lib/components/ui/AriaProgressBar.svelte';
    import type { SyncStatus } from '$lib/schemas/api-integrations-responses';

    interface Props {
        status: SyncStatus | null;
        onCancel: () => void;
    }
    let { status, onCancel }: Props = $props();

    const NON_TERMINAL_STATES = new Set(['pending', 'active', 'cancelling']);

    const isNonTerminal = $derived(!!status?.state && NON_TERMINAL_STATES.has(status.state));
    const total = $derived(status?.total);
    // Guard against a malformed/NaN or negative processed/total pair (the
    // wire schema only requires z.number(), not finite/non-negative) —
    // otherwise the "determinate" branch below can compute
    // aria-valuenow=NaN and render a broken bar instead of falling back to
    // the indeterminate spinner.
    const isDeterminate = $derived(
        typeof total === 'number' &&
            Number.isFinite(total) &&
            total > 0 &&
            !!status &&
            Number.isFinite(status.processed) &&
            status.processed >= 0,
    );
    const percent = $derived(
        isDeterminate && status
            ? Math.min(100, Math.max(0, (status.processed / (total as number)) * 100))
            : 0,
    );

    const phaseLabel = $derived.by((): string => {
        if (!status?.state) return '';
        if (status.phase) return status.phase;
        if (status.state === 'pending') return m.settings_connections_sync_phase_pending();
        if (status.state === 'active') return m.settings_connections_sync_phase_active();
        if (status.state === 'cancelling') return m.settings_connections_sync_cancelling();
        return '';
    });
</script>

{#if status?.state}
    <div class="px-4 py-3 text-xs">
        {#if isNonTerminal}
            <div class="flex items-center gap-3">
                <div class="flex-1">
                    {#if isDeterminate}
                        <AriaProgressBar label={phaseLabel} value={percent} />
                    {:else}
                        <div
                            role="progressbar"
                            aria-label={phaseLabel}
                            aria-valuetext={phaseLabel}
                            class="relative h-2 bg-surface-700 rounded-full overflow-hidden">
                            <div class="indeterminate-bar h-full w-1/3 bg-primary-500 rounded-full">
                            </div>
                        </div>
                    {/if}
                </div>
                <button
                    class="btn btn-sm variant-ghost-error"
                    onclick={onCancel}
                    disabled={status.state === 'cancelling'}>
                    {status.state === 'cancelling'
                        ? m.settings_connections_sync_cancelling()
                        : m.settings_connections_sync_cancel()}
                </button>
            </div>
            <p class="text-surface-400 mt-1">
                {phaseLabel}
                {#if isDeterminate}
                    ·
                    {m.settings_connections_sync_progress_of({
                        processed: status.processed,
                        total: total as number,
                    })}
                {:else if status.processed > 0}
                    ·
                    {m.settings_connections_sync_progress_count({ processed: status.processed })}
                {/if}
            </p>
        {:else}
            <p class="text-surface-400">
                {#if status.state === 'completed' && status.processed === 0}
                    {m.settings_connections_sync_completed_none()}
                {:else if status.state === 'completed'}
                    {m.settings_connections_sync_completed({ processed: status.processed })}
                {:else if status.state === 'failed'}
                    {status.error ?? m.settings_connections_sync_failed()}
                {:else if status.state === 'cancelled'}
                    {m.settings_connections_sync_cancelled()}
                {/if}
            </p>
        {/if}
    </div>
{/if}

<style>
    .indeterminate-bar {
        animation: indeterminate-slide 1.2s ease-in-out infinite;
    }

    @keyframes indeterminate-slide {
        0% {
            transform: translateX(-100%);
        }
        50% {
            transform: translateX(100%);
        }
        100% {
            transform: translateX(200%);
        }
    }
</style>
