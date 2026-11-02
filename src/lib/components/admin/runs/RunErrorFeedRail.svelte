<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Admin IA redesign, spec §3.3/§5: the Runs page's "error feed" info rail.
  Identical repeated events aggregate ("×N in 24 h" via `formatRepeats`) so a
  re-wedging failure doesn't flood the rail with duplicate rows (spec §5).
  Seeded once from the audit-feed REST history (so the rail isn't empty on
  first paint) and merged with the live SSE ring thereafter — same pattern
  the old Mission Control ticker used (`ticker.ts`, kept).
-->
<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { apiGet } from '$lib/api/client.js';
    import { runSSEBus } from '$lib/stores/run-sse-bus.js';
    import { AuditFeedResponseSchema } from '$lib/schemas/task-system-failure-detection.schema.js';
    import type { BusEvent } from '$lib/schemas/mission-control.schema.js';
    import { auditRowToBusEvent, mergeTickerEvents } from './ticker.js';
    import { aggregateErrorEvents } from './error-feed.js';
    import {
        explainRunError,
        stripTaskIdPrefix,
        classifyRunErrorSeverity,
    } from '$lib/utils/admin/run-error-display.js';
    import { formatRepeats, formatAgo } from '$lib/utils/admin/formatters.js';
    import InfoRailCard from '$lib/components/admin/InfoRailCard.svelte';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import { RunListResponseSchema } from '$lib/schemas/run.schema.js';
    import { sinceParamFor } from '$lib/utils/admin/run-window.js';

    const WINDOW_HOURS = 24;
    const MAX_ROWS = 12;

    let tickerSeed = $state<BusEvent[]>([]);
    let seeded = $state(false);
    let seedFailed = $state(false);
    let sseVersion = $state(0);
    let now = $state(Date.now());
    let unsubSSE: (() => void) | undefined;
    let nowTimer: ReturnType<typeof setInterval> | undefined;
    let disposed = false;

    let mergedEvents = $derived.by((): BusEvent[] => {
        void sseVersion;
        return mergeTickerEvents(tickerSeed, runSSEBus.recentEvents);
    });

    let rows = $derived(
        aggregateErrorEvents(mergedEvents, now, WINDOW_HOURS * 60 * 60 * 1000).slice(0, MAX_ROWS),
    );

    function toneClass(sev: BusEvent['severity']): string {
        return sev === 'error' ? 'text-red-300' : 'text-amber-300';
    }

    // Self-healing failures (rate limits, quotas — resume automatically) wear
    // amber regardless of the bus event's own severity — they're not a real
    // outage even though `run.failed` events default to `error` severity.
    function isExpectedRow(row: { summary: string }): boolean {
        return classifyRunErrorSeverity(row.summary) === 'expected';
    }

    // Same humanization as RunList rows (spec: "humanize internal run
    // errors") — a recognized internal phrasing renders as its plain-
    // language explanation, otherwise the id-stripped raw text. The raw
    // summary always stays available via the row's title attribute.
    function displayText(row: { summary: string; taskId?: string }): string {
        const explained = explainRunError(row.summary);
        return explained ? explained.summary : stripTaskIdPrefix(row.summary, row.taskId);
    }

    onMount(() => {
        void (async () => {
            const { data } = await apiGet(
                '/api/admin/task-system/audit?limit=30',
                AuditFeedResponseSchema,
            );
            // Failed runs of the window, too. The audit log only records
            // automatic actions, and live failures arrive only while the page
            // is open — so a run that failed at 06:00 was missing here, and
            // the rail said "No recent errors" beside three failing tasks.
            // Same summary shape as the live `run.failed` bus event, so a
            // failure that also arrives live folds into one row.
            const since = sinceParamFor('24h');
            const failed = await apiGet(
                `/api/runs?state=failed&limit=30${since ? `&since=${encodeURIComponent(since)}` : ''}`,
                RunListResponseSchema,
            );
            if (disposed) return;
            const seed: BusEvent[] = data ? data.items.map(auditRowToBusEvent) : [];
            for (const [i, run] of (failed.data?.items ?? []).entries()) {
                const ts = Date.parse(run.completedAt ?? run.startedAt);
                seed.push({
                    seq: -1_000_000 - i,
                    ts: Number.isFinite(ts) ? ts : 0,
                    kind: 'run.failed',
                    severity: 'error',
                    summary: run.error?.message
                        ? `${run.label}: ${run.error.message}`
                        : `${run.label} failed`,
                    taskId: run.taskId,
                    runId: run.id,
                    instanceId: run.ownerInstanceId,
                });
            }
            tickerSeed = seed;
            // Either seed source failing means "No recent errors" would be a
            // guess: the empty state must not read as healthy.
            seedFailed = !data || !failed.data;
            seeded = true;
        })();
        unsubSSE = runSSEBus.onAnyChange(() => {
            sseVersion += 1;
        });
        nowTimer = setInterval(() => {
            now = Date.now();
        }, 30_000);
    });

    onDestroy(() => {
        disposed = true;
        unsubSSE?.();
        if (nowTimer) clearInterval(nowTimer);
    });
</script>

<InfoRailCard id="runs-error-feed" title={m.admin_runs_rail_errors_title()}>
    {#if !seeded}
        <p class="text-xs text-surface-500">{m.loading_default()}</p>
    {:else if rows.length === 0 && seedFailed}
        <p class="text-xs text-red-300">{m.admin_runs_rail_errors_load_failed()}</p>
    {:else if rows.length === 0}
        <p class="text-xs italic text-surface-500">{m.admin_runs_rail_errors_empty()}</p>
    {:else}
        {#if seedFailed}
            <p class="mb-1.5 text-[11px] text-amber-300">
                {m.admin_runs_rail_errors_load_failed()}
            </p>
        {/if}
        <ul class="space-y-1.5">
            {#each rows as row (row.summary)}
                {@const expected = isExpectedRow(row)}
                <li class="text-xs">
                    <div class="flex items-start gap-2">
                        <span
                            class="mt-0.5 flex-1 {expected
                                ? 'text-amber-300'
                                : toneClass(row.severity)}"
                            title={row.summary}>
                            {displayText(row)}
                            {#if expected}
                                <span
                                    class="text-amber-400/80"
                                    title={m.admin_run_error_expected_badge_tooltip()}>
                                    · {m.admin_run_error_expected_suffix()}
                                </span>
                            {/if}
                        </span>
                        {#if row.runId}
                            <a
                                href="{resolve('/admin/tasks/runs')}?run={row.runId}"
                                class="shrink-0 text-blue-400 hover:text-blue-300 hover:underline">
                                {m.admin_runs_rail_errors_view_run()}
                            </a>
                        {/if}
                    </div>
                    <p class="mt-0.5 text-surface-500">
                        {row.count > 1
                            ? formatRepeats(row.count, { hours: WINDOW_HOURS })
                            : formatAgo(now - row.latestTs)}
                    </p>
                </li>
            {/each}
        </ul>
    {/if}
</InfoRailCard>
