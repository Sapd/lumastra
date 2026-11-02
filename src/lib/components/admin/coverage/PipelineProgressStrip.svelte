<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { StageStateRow } from '$lib/types/pipeline.js';
    import StageCell from './StageCell.svelte';
    import Tooltip, { type TooltipLine } from '$lib/components/ui/Tooltip.svelte';
    import { pipelineStepName } from '$lib/config/pipeline-step-names.js';
    import { pipelineStepDescription } from '$lib/config/pipeline-step-descriptions.js';
    import { taskStatusLabel } from '$lib/utils/operator-labels';

    interface Props {
        rows: StageStateRow[];
        compact?: boolean;
        onStageClick?: (stageId: string) => void;
        /**
         * Show the raw stage id in the hover bubble (admin IA redesign, spec
         * §3.3: "raw ids only in dev mode"). Threaded down from
         * `$page.data.devToolsEnabled`.
         */
        devMode?: boolean;
    }

    const { rows, compact = false, onStageClick, devMode = false }: Props = $props();

    const sortedRows = $derived([...rows].sort((a, b) => a.stage_id.localeCompare(b.stage_id)));

    /**
     * Hover content for one dot: friendly name, where the step stands, what it
     * does, and — dev mode only — the raw id. `class` values here are all
     * literal, never built from row data (Tooltip renders lines via
     * `textContent`, so the text itself is safe, but the class must stay
     * trusted).
     */
    function tooltipLines(row: StageStateRow): TooltipLine[] {
        const lines: TooltipLine[] = [
            { text: pipelineStepName(row.stage_id), class: 'font-semibold text-white' },
            {
                text:
                    taskStatusLabel(row.status) + (row.attempt ? ` · attempt ${row.attempt}` : ''),
                class: 'text-zinc-300',
            },
        ];

        const description = pipelineStepDescription(row.stage_id);
        if (description) lines.push({ text: description, class: 'mt-1 text-zinc-400' });

        if (row.last_error?.message) {
            lines.push({ text: row.last_error.message, class: 'mt-1 text-red-300' });
        }
        if (devMode) {
            lines.push({ text: row.stage_id, class: 'mt-1 font-mono text-[10px] text-zinc-500' });
        }
        return lines;
    }
</script>

{#if sortedRows.length === 0}
    <div
        class="h-2 w-24 border-b border-dashed border-zinc-300"
        aria-label="No stage coverage data">
    </div>
{:else}
    <div class="flex items-center gap-0.5">
        {#each sortedRows as row (row.stage_id)}
            <Tooltip lines={tooltipLines(row)} position="bottom" fixed wrap delay={80}>
                {#if onStageClick}
                    <button
                        type="button"
                        onclick={() => onStageClick(row.stage_id)}
                        class="rounded-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
                        <StageCell
                            status={row.status}
                            stageId={row.stage_id}
                            stepName={pipelineStepName(row.stage_id)}
                            attempt={row.attempt}
                            lastError={row.last_error}
                            {compact}
                            suppressNativeTitle />
                    </button>
                {:else}
                    <StageCell
                        status={row.status}
                        stageId={row.stage_id}
                        stepName={pipelineStepName(row.stage_id)}
                        attempt={row.attempt}
                        lastError={row.last_error}
                        {compact}
                        suppressNativeTitle />
                {/if}
            </Tooltip>
        {/each}
    </div>
{/if}
