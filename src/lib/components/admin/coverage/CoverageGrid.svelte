<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import StageCell from './StageCell.svelte';
    import TermTooltip from '$lib/components/admin/glossary/TermTooltip.svelte';
    import { STATION_INFO, formatTrainHeadline } from './ingest-map.constants.js';
    import { pipelineStepName } from '$lib/config/pipeline-step-names.js';
    import type { StageStatus } from '$lib/types/pipeline.js';
    import { isSeries } from '$lib/shared/media-types.js';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';

    interface CoverageItem {
        id: string;
        title: string;
        media_type: string;
        library_group_id: string | null;
        stage_completion: Record<string, StageStatus>;
        added_at: string | Date;
        /** Episodes only — parent series title resolved via parent_id chain. */
        series_title?: string | null;
        season_number?: number | null;
        episode_number?: number | null;
    }

    interface Props {
        items: CoverageItem[];
        /**
         * Show raw stage ids in column-header tooltips (admin IA redesign,
         * spec §3.3: "raw ids only in dev mode"). Threaded from
         * `$page.data.devToolsEnabled`.
         */
        devMode?: boolean;
    }

    const { items, devMode = false }: Props = $props();

    const allStageIds = $derived(
        Array.from(new Set(items.flatMap((i) => Object.keys(i.stage_completion)))).sort(),
    );

    /**
     * Full friendly column header (spec §3.3 "Completion grid shows ...
     * full column names" — replaces the previous `tp-gen`-style truncated
     * abbreviation, which was exactly the anti-pattern the spec calls out).
     */
    function headerLabel(stageId: string): string {
        return pipelineStepName(stageId);
    }

    /**
     * Hover detail: the friendly name again (so it's readable even if the
     * header text itself got clipped by a narrow column) plus the
     * technical description. The raw stage id is a developer detail —
     * only included when dev mode is on.
     */
    function headerTitle(stageId: string): string {
        const info = STATION_INFO[stageId];
        const name = pipelineStepName(stageId);
        const idLine = devMode ? `\n${stageId}` : '';
        return info ? `${name}${idLine}\n\n${info.description}` : `${name}${idLine}`;
    }
</script>

<!-- Legend for the dot colors — rendered above the grid (not below) so it's
     visible without scrolling past a long/paginated item list. Each chip
     matches the bg color in StageCell.svelte. -->
<div class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-400">
    <span class="font-semibold uppercase tracking-wider text-zinc-500">
        <TermTooltip term="stage">{m.admin_glossary_stage_term()}</TermTooltip>
        {m.admin_coverage_legend_suffix()}
    </span>
    <span class="inline-flex items-center gap-1.5">
        <span aria-hidden="true" class="inline-flex"
            ><StageCell status="completed" glyph suppressNativeTitle /></span>
        {m.admin_coverage_legend_completed()}
    </span>
    <span class="inline-flex items-center gap-1.5">
        <span aria-hidden="true" class="inline-flex"
            ><StageCell status="running" glyph suppressNativeTitle /></span>
        {m.admin_coverage_legend_running()}
    </span>
    <span class="inline-flex items-center gap-1.5">
        <span aria-hidden="true" class="inline-flex"
            ><StageCell status="pending" glyph suppressNativeTitle /></span>
        {m.admin_coverage_legend_waiting()}
    </span>
    <span class="inline-flex items-center gap-1.5">
        <span aria-hidden="true" class="inline-flex"
            ><StageCell status="failed_transient" glyph suppressNativeTitle /></span>
        {m.admin_coverage_legend_failed_retry()}
    </span>
    <span class="inline-flex items-center gap-1.5">
        <span aria-hidden="true" class="inline-flex"
            ><StageCell status="failed_permanent" glyph suppressNativeTitle /></span>
        {m.admin_coverage_legend_failed_permanent()}
    </span>
    <span class="inline-flex items-center gap-1.5">
        <span aria-hidden="true" class="inline-flex"
            ><StageCell status="skipped_transient" glyph suppressNativeTitle /></span>
        {m.admin_coverage_legend_skipped_transient()}
    </span>
    <span class="inline-flex items-center gap-1.5">
        <span aria-hidden="true" class="inline-flex"
            ><StageCell status="skipped_permanent" glyph suppressNativeTitle /></span>
        {m.admin_coverage_legend_not_applicable()}
    </span>
    <span class="inline-flex items-center gap-1.5">
        <span aria-hidden="true" class="inline-flex"
            ><StageCell status="obsolete" glyph suppressNativeTitle /></span>
        {m.admin_coverage_legend_obsolete()}
    </span>
    <span class="inline-flex items-center gap-1.5">
        <span class="inline-block h-1 w-1 rounded-sm bg-zinc-700" aria-hidden="true"></span>
        {m.admin_coverage_legend_no_stage()}
    </span>
</div>

<div class="overflow-x-auto rounded border border-zinc-800">
    <table class="w-full text-sm">
        <thead>
            <tr class="border-b border-zinc-800 bg-zinc-900/60">
                <th
                    scope="col"
                    class="sticky left-0 z-10 bg-zinc-900 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-zinc-400">
                    Item
                </th>
                <th
                    scope="col"
                    class="px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide text-zinc-400">
                    Type
                </th>
                {#each allStageIds as stageId (stageId)}
                    <th
                        scope="col"
                        class="whitespace-nowrap px-2 py-2 text-left text-xs font-normal text-zinc-500"
                        title={headerTitle(stageId)}>
                        {headerLabel(stageId)}
                    </th>
                {/each}
            </tr>
        </thead>
        <tbody>
            {#if items.length === 0}
                <tr>
                    <td
                        colspan={2 + allStageIds.length}
                        class="px-3 py-8 text-center text-sm text-zinc-500">
                        No items match the current filters.
                    </td>
                </tr>
            {/if}
            {#each items as item (item.id)}
                <tr class="border-t border-zinc-800 hover:bg-zinc-800/30">
                    <td class="sticky left-0 z-10 bg-zinc-900 px-3 py-1.5">
                        <a
                            href={resolve(`/admin/library/media/${item.id}?tab=pipeline`)}
                            class="text-sky-400 hover:text-sky-300 hover:underline"
                            title={formatTrainHeadline(item)}>
                            {formatTrainHeadline(item)}
                        </a>
                    </td>
                    <td class="px-2 py-1.5">
                        <span class="rounded bg-zinc-700/50 px-1.5 py-0.5 text-xs text-zinc-400">
                            {isSeries(item.media_type) ? 'series' : item.media_type}
                        </span>
                    </td>
                    {#each allStageIds as stageId (stageId)}
                        <td class="px-1 py-1.5">
                            {#if item.stage_completion[stageId]}
                                <StageCell
                                    status={item.stage_completion[stageId]}
                                    {stageId}
                                    stepName={pipelineStepName(stageId)}
                                    glyph />
                            {:else}
                                <span
                                    class="inline-block h-1 w-1 rounded-sm bg-zinc-700"
                                    aria-label={m.admin_coverage_legend_no_stage()}
                                    title={m.admin_coverage_legend_no_stage()}></span>
                            {/if}
                        </td>
                    {/each}
                </tr>
            {/each}
        </tbody>
    </table>
</div>
