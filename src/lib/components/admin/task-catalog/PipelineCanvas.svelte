<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import TaskPipelineNode from './TaskPipelineNode.svelte';
    import { pointsToBezierPath, type LaidOutPipeline } from './pipeline-layout.js';

    interface Props {
        layout: LaidOutPipeline;
        /** Task id of the page being viewed; the matching node is highlighted. */
        currentTaskId?: string;
        /**
         * Maximum visible height in px. Layouts taller than this scroll
         * vertically inside the canvas. No zoom or pan controls — the user
         * explicitly declined them.
         */
        maxHeight?: number;
        /** Developer mode: show internal task ids (spec 2026-09-27 §1.5 — ids only in dev mode). */
        devMode?: boolean;
    }

    let { layout, currentTaskId, maxHeight = 640, devMode = false }: Props = $props();

    // Defensive lower bound on the SVG dimensions so a single-node pipeline
    // (or a degenerate empty layout) still renders something visible.
    let canvasWidth = $derived(Math.max(layout.width, 1));
    let canvasHeight = $derived(Math.max(layout.height, 1));

    // Wrap in overflow-auto when the layout exceeds the visible budget so
    // long pipelines don't blow up the page. Horizontal overflow is also
    // allowed because the dagre layout width is determined by the widest
    // rank — typically fits, but a fan-out of 5+ stages can exceed page
    // width on narrow viewports.
    let needsVerticalScroll = $derived(canvasHeight > maxHeight);
</script>

<div
    class="rounded border border-surface-700/40 bg-surface-950/40"
    style:max-height={needsVerticalScroll ? `${maxHeight}px` : 'none'}
    style:overflow={needsVerticalScroll ? 'auto' : 'visible'}
    role="figure"
    aria-label="Pipeline diagram with {layout.members.length} task{layout.members.length === 1
        ? ''
        : 's'}">
    <!--
        Inner positioning container sized to the laid-out canvas. SVG sits
        underneath the HTML nodes so anti-aliased bezier connectors render
        cleanly while the nodes remain native HTML (selectable text, full
        focus/hover/aria semantics, no SVG foreignObject quirks).
    -->
    <div class="relative" style:width="{canvasWidth}px" style:height="{canvasHeight}px">
        <!-- Edge layer -->
        <svg
            class="absolute inset-0 pointer-events-none"
            width={canvasWidth}
            height={canvasHeight}
            viewBox="0 0 {canvasWidth} {canvasHeight}"
            aria-hidden="true">
            <defs>
                <!--
                    Arrowhead marker. refX positions the tip so the arrow
                    lands on the node border rather than the node center.
                    The path is sized to match the stroke-width of the
                    edges (1.5).
                -->
                <marker
                    id="pipeline-arrow"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    markerUnits="userSpaceOnUse"
                    orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="rgb(107 114 128 / 0.9)" />
                </marker>
            </defs>

            {#each layout.edges as edge (`${edge.from}->${edge.to}`)}
                <path
                    d={pointsToBezierPath(edge.points)}
                    fill="none"
                    stroke="rgb(107 114 128 / 0.6)"
                    stroke-width="1.5"
                    marker-end="url(#pipeline-arrow)" />
            {/each}
        </svg>

        <!-- Node layer -->
        {#each layout.nodes as node (node.id)}
            <div
                class="absolute"
                style:left="{node.x}px"
                style:top="{node.y}px"
                style:width="{node.width}px"
                style:height="{node.height}px">
                {#if node.isGate}
                    <!--
                        Synthetic fan-in gate (mirrors the
                        `__gate__<taskId>` node from pipeline-builder.ts).
                        Tiny, low-visual-weight pill that signals
                        multi-parent convergence without competing with
                        real task nodes for attention.
                    -->
                    <div
                        class="h-full w-full flex items-center justify-center rounded-full border border-surface-700/60 bg-surface-800/50 text-[10px] font-medium text-surface-400 select-none"
                        title="Waits for several earlier steps to finish before the next step starts."
                        aria-label="Join point — waits for several earlier steps">
                        join
                    </div>
                {:else if node.task}
                    <TaskPipelineNode
                        task={node.task}
                        current={currentTaskId === node.task.id}
                        {devMode} />
                {/if}
            </div>
        {/each}
    </div>
</div>
