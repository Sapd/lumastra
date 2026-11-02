<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { StageStatus } from '$lib/types/pipeline.js';
    import { taskStatusLabel } from '$lib/utils/operator-labels';

    interface Props {
        status: StageStatus;
        stageId?: string;
        /**
         * Friendly display name for `stageId` (admin IA redesign, spec §3.3
         * "friendly step names everywhere"). Callers that know the step's
         * name (e.g. via `pipelineStepName()`) should pass it — the label
         * falls back to the raw `stageId` only when this is omitted, for
         * backward compatibility with call sites that don't have one yet.
         */
        stepName?: string;
        attempt?: number;
        lastError?: { message: string; code?: string } | null;
        compact?: boolean;
        /**
         * Drop the native `title` (the aria-label stays). Set by callers that
         * wrap the cell in a real `<Tooltip>` — otherwise the browser's own
         * bubble fires on top of the styled one. The Completion grid keeps the
         * native title on purpose: it renders hundreds of cells per page and a
         * Tooltip instance each would mean hundreds of DOM observers.
         */
        suppressNativeTitle?: boolean;
        /**
         * Larger cell with a shape + symbol per state (✓ done, ▸ running,
         * ! will retry, ✕ gave up, – not needed, hollow ring = waiting …) so
         * the state does not rest on colour
         * alone. The Completion grid used 4 px colour-only dots across 23
         * columns, told apart by a nine-colour legend.
         */
        glyph?: boolean;
    }

    const {
        status,
        stageId,
        stepName,
        attempt,
        lastError,
        compact = false,
        suppressNativeTitle = false,
        glyph = false,
    }: Props = $props();

    const symbol = $derived(
        status === 'completed'
            ? '✓'
            : // Running gets a symbol too; pending is told apart by its
              // shape (a hollow ring below), not by colour.
              status === 'running'
              ? '▸'
              : status === 'failed_transient'
                ? '!'
                : status === 'failed_permanent'
                  ? '✕'
                  : status === 'skipped_permanent'
                    ? '–'
                    : status === 'skipped_transient'
                      ? '…'
                      : status === 'obsolete'
                        ? '↻'
                        : '',
    );

    const colorClass = $derived(
        status === 'completed'
            ? 'bg-emerald-500'
            : status === 'running'
              ? 'bg-sky-500 animate-pulse'
              : status === 'pending'
                ? 'bg-zinc-400'
                : status === 'failed_transient'
                  ? 'bg-amber-500'
                  : status === 'failed_permanent'
                    ? 'bg-red-600'
                    : status === 'skipped_permanent'
                      ? 'bg-zinc-300'
                      : status === 'skipped_transient'
                        ? 'bg-amber-300'
                        : 'bg-purple-500', // obsolete
    );

    const sizeClass = $derived(compact ? 'w-1 h-1' : 'w-2 h-2');

    const label = $derived(
        `${stepName ?? stageId ?? 'step'} · ${taskStatusLabel(status)}` +
            (attempt ? ` · attempt ${attempt}` : '') +
            (lastError ? ` · ${lastError.message}` : ''),
    );
</script>

{#if glyph}
    <span
        role="img"
        aria-label={label}
        title={suppressNativeTitle ? undefined : label}
        class="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-sm text-[10px] font-bold leading-none text-zinc-950 {status ===
        'pending'
            ? 'bg-transparent ring-1 ring-inset ring-zinc-400'
            : colorClass}">{symbol}</span>
{:else}
    <span
        role="img"
        aria-label={label}
        title={suppressNativeTitle ? undefined : label}
        class="inline-block rounded-sm {sizeClass} {colorClass} cursor-help"></span>
{/if}
