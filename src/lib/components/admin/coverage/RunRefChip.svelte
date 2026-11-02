<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { RUN_STATE_BADGE } from '$lib/components/admin/tasks/run-state-badges.js';
    import type { TimelineRunRef } from '$lib/schemas/pipeline-timeline.schema.js';
    import { resolve } from '$lib/paths';

    interface Props {
        run: TimelineRunRef;
    }

    const { run }: Props = $props();

    // Map the run's live state onto a shared run-state badge preset.
    function badgeFor(state: TimelineRunRef['state']) {
        const key =
            state === 'active'
                ? 'running'
                : state === 'cancelling'
                  ? 'cancelling'
                  : state === 'cancelled'
                    ? 'cancelled'
                    : state === 'completed'
                      ? 'completed'
                      : state === 'failed'
                        ? 'failed'
                        : state === 'pending'
                          ? 'queued'
                          : state === 'expired'
                            ? 'idle'
                            : 'idle';
        return RUN_STATE_BADGE[key] ?? RUN_STATE_BADGE.idle;
    }

    const badge = $derived(badgeFor(run.state));
    const label = $derived(
        run.state === 'expired' ? m.media_redesign_expired_record() : badge.label,
    );

    const colorClass: Record<string, string> = {
        green: 'bg-emerald-900/30 text-emerald-200',
        blue: 'bg-sky-900/40 text-sky-200',
        yellow: 'bg-amber-900/40 text-amber-200',
        orange: 'bg-orange-900/40 text-orange-200',
        amber: 'bg-amber-900/30 text-amber-300',
        red: 'bg-red-900/40 text-red-200',
        purple: 'bg-purple-900/40 text-purple-200',
        gray: 'bg-zinc-800/60 text-zinc-300',
    };
</script>

<!--
    Deep-links to /admin/tasks/runs?run=<id> — the runs page reads ?run= on mount
    and opens the existing RunDetailPanel via the app-wide runDetailPanel store
    (admin-ia step:runs — param renamed from `runId` to `run`, the page's own
    URL-backing contract).
-->
<a
    href={resolve(`/admin/tasks/runs?run=${run.runId}`)}
    class="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium {colorClass[
        badge.color
    ] ?? colorClass.gray}"
    title="Open run {run.runId} in the runs panel">
    <span class="font-mono">{run.runId.slice(0, 8)}…</span>
    <span class="uppercase tracking-wide">{label}</span>
    {#if !run.alive && (run.state === 'active' || run.state === 'cancelling')}
        <span
            class="rounded bg-red-900/60 px-1 text-[10px] font-semibold text-red-100"
            title="The process running this job stopped responding. The system will recover it automatically.">
            stopped responding
        </span>
    {/if}
</a>
