<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { StageDiagnosis } from '$lib/schemas/pipeline-timeline.schema.js';
    import { stuckReasonStyle } from './stage-diagnosis-display.js';

    interface Props {
        diagnosis: StageDiagnosis;
    }

    const { diagnosis }: Props = $props();

    // Styling lives in `stage-diagnosis-display.ts` as an exhaustive switch.
    // It was a record keyed on the reason enum here, and nothing checked it:
    // tsgo does not read `.svelte`, and svelte-check-native does not flag a
    // broken key in a component-local record either. The record had gone stale —
    // the schema's `'schedule-paused'` had no entry, so the `?? none` fallback
    // labelled an admin-paused step "Waiting", beside the row's own amber "Off"
    // pill. There is no fallback now, and no way to need one.

    const style = $derived(stuckReasonStyle(diagnosis.reason));

    // Render the structured detail as compact key=value pairs inline.
    const detailEntries = $derived(
        Object.entries(diagnosis.detail).filter(([, v]) => v !== null && v !== undefined),
    );
</script>

<div class="flex flex-col gap-1">
    <span
        class="inline-flex w-fit items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide {style.cls}"
        title={diagnosis.summary}>
        {style.label}
    </span>
    <span class="text-xs text-zinc-400">{diagnosis.summary}</span>
    {#if detailEntries.length > 0}
        <div class="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-zinc-500">
            {#each detailEntries as [key, value] (key)}
                <span
                    ><span class="text-zinc-600">{key}:</span>
                    {String(value)}</span>
            {/each}
        </div>
    {/if}
</div>
