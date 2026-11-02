<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import type { PipelineSummary } from './ingest-map.types.js';

    interface Props {
        summary: PipelineSummary | null;
    }

    const { summary }: Props = $props();

    /**
     * Format the oldest-pending age into a humane "stuck 3h" string.
     * Returns `null` for "no pending rows at all" so we can hide the
     * metric entirely in that case (zero pending is normal idle state,
     * not a positive signal).
     */
    function formatAge(sec: number | null): string | null {
        if (sec === null || !Number.isFinite(sec) || sec < 0) return null;
        if (sec < 60) return `${sec}s`;
        if (sec < 3600) return `${Math.round(sec / 60)}m`;
        if (sec < 86400) return `${Math.round(sec / 3600)}h`;
        return `${Math.round(sec / 86400)}d`;
    }

    /** Tone helper: pick card color based on the value vs warn/crit thresholds. */
    function tone(value: number, warn: number, crit: number): 'ok' | 'warn' | 'crit' {
        if (value >= crit) return 'crit';
        if (value >= warn) return 'warn';
        return 'ok';
    }

    const inFlight = $derived(summary?.inFlight ?? 0);
    const running = $derived(summary?.running ?? 0);
    const failedTone = $derived(tone(summary?.failedLastHour ?? 0, 5, 50));
    const dlqTone = $derived(tone(summary?.deadLetterItems ?? 0, 1, 50));
    const degradedTone = $derived(tone(summary?.degradedItems ?? 0, 1, 20));
    const oldestAge = $derived(formatAge(summary?.oldestPendingAgeSec ?? null));
    // "Longest wait" alone is often just benign backlog aging (a low-priority
    // item that's genuinely queued but not broken) — it shouldn't render as
    // alarming red on age alone. Only escalate the color when there's a
    // corroborating stuck-work signal (degradedItems — items that have
    // actually retried repeatedly), or when the age is extreme enough that
    // it's worth flagging regardless.
    const oldestTone = $derived.by(() => {
        const sec = summary?.oldestPendingAgeSec ?? 0;
        if (sec >= 30 * 86400) return 'crit'; // > 30d is worth a look regardless
        const hasStuckSignal = (summary?.degradedItems ?? 0) > 0;
        if (!hasStuckSignal) return 'ok';
        if (sec >= 86400) return 'crit'; // > 1d AND something is actually struggling
        if (sec >= 3600) return 'warn'; // > 1h AND something is actually struggling
        return 'ok';
    });
    // Only the identity-workbench SUBSET of dead-letter items (see the
    // server-side `IngestPipelineSummary.reidentifyItems` doc comment) —
    // deliberately NOT `summary.deadLetterItems`, which also counts
    // technically-retryable stages that just exhausted their retry budget
    // (not a Fix-matches concern). Hidden at 0 (spec §5: "badges only when
    // actionable and non-zero") since, unlike the ambient metric chips
    // above, this one is a cross-page attention link, not a glance metric.
    const reidentifyCount = $derived(summary?.reidentifyItems ?? 0);
    interface Metric {
        id: string;
        label: string;
        value: string;
        description: string;
        tone: 'ok' | 'warn' | 'crit' | 'active';
        href?: string;
    }

    const metrics = $derived.by((): Metric[] => {
        if (!summary) return [];
        const cards: Metric[] = [
            {
                id: 'in-progress',
                label: m.admin_pipeline_health_in_progress(),
                value: inFlight.toLocaleString(),
                description: m.admin_pipeline_health_in_progress_description(),
                tone: inFlight > 0 ? 'active' : 'ok',
            },
            {
                id: 'running',
                label: m.admin_pipeline_health_running(),
                value: running.toLocaleString(),
                description: m.admin_pipeline_health_running_description(),
                tone: running > 0 ? 'active' : 'ok',
            },
            {
                id: 'failed',
                label: m.admin_pipeline_health_failed(),
                value: (summary.failedLastHour ?? 0).toLocaleString(),
                description: m.admin_pipeline_health_failed_description(),
                tone: failedTone,
                href: '#error-groups',
            },
            {
                id: 'stopped',
                label: m.admin_pipeline_healthstrip_stopped_retrying(),
                value: (summary.deadLetterItems ?? 0).toLocaleString(),
                description: m.admin_pipeline_health_stopped_description(),
                tone: dlqTone,
                href: '#dead-letter',
            },
            {
                id: 'struggling',
                label: m.admin_pipeline_health_struggling(),
                value: (summary.degradedItems ?? 0).toLocaleString(),
                description: m.admin_pipeline_health_struggling_description(),
                tone: degradedTone,
                href: '#stuck-items',
            },
        ];
        if (oldestAge)
            cards.push({
                id: 'oldest',
                label: m.admin_pipeline_healthstrip_longest_wait(),
                value: oldestAge,
                description: m.admin_pipeline_health_wait_description(),
                tone: oldestTone,
                href: '#stuck-items',
            });
        if (reidentifyCount > 0)
            cards.push({
                id: 'reidentify',
                label: m.admin_pipeline_healthstrip_needs_reid(),
                value: reidentifyCount.toLocaleString(),
                description: m.admin_pipeline_health_reidentify_description(),
                tone: 'warn',
                href: `${resolve('/admin/library/fix-matches')}?view=broken`,
            });
        return cards;
    });

    const CARD_TONES: Record<Metric['tone'], string> = {
        ok: 'border-zinc-800 bg-zinc-900/60 text-zinc-100',
        active: 'border-sky-800/60 bg-sky-950/25 text-sky-200',
        warn: 'border-amber-700/60 bg-amber-950/30 text-amber-200',
        crit: 'border-red-700/60 bg-red-950/30 text-red-200',
    };
</script>

{#snippet metricContent(metric: Metric)}
    <dl>
        <dt class="text-sm font-medium">{metric.label}</dt>
        <dd class="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{metric.value}</dd>
        <dd class="mt-1 text-xs leading-relaxed text-zinc-300">{metric.description}</dd>
        {#if metric.href}<dd class="mt-2 text-xs font-medium underline underline-offset-4">
                {m.admin_pipeline_health_inspect()} <span aria-hidden="true">→</span>
            </dd>{/if}
    </dl>
{/snippet}

{#if summary}
    <section class="space-y-3" aria-label={m.admin_pipeline_health_heading()}>
        <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 class="text-base font-semibold text-zinc-100">
                {m.admin_pipeline_health_heading()}
            </h2>
            <p class="text-sm text-zinc-400">{m.admin_pipeline_health_scope()}</p>
        </div>
        <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
            {#each metrics.slice(0, 4) as metric (metric.id)}
                {#if metric.href}
                    <div class="min-w-0">
                        <a
                            href={metric.href}
                            class="block h-full rounded-xl border p-3 transition-colors hover:border-zinc-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-400 {CARD_TONES[
                                metric.tone
                            ]}">
                            {@render metricContent(metric)}
                        </a>
                    </div>
                {:else}
                    <div class="min-w-0 rounded-xl border p-3 {CARD_TONES[metric.tone]}">
                        {@render metricContent(metric)}
                    </div>
                {/if}
            {/each}
        </div>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {#each metrics.slice(4) as metric (metric.id)}
                <a
                    href={metric.href}
                    class="min-w-0 rounded-lg border px-3 py-2 transition-colors hover:border-zinc-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-400 {CARD_TONES[
                        metric.tone
                    ]}">
                    <dl class="grid grid-cols-[1fr_auto] items-baseline gap-x-2">
                        <dt class="text-sm font-medium">{metric.label}</dt>
                        <dd class="text-lg font-semibold tabular-nums">
                            {metric.value} <span aria-hidden="true">→</span>
                        </dd>
                        <dd class="col-span-2 mt-1 text-xs leading-relaxed text-zinc-300">
                            {metric.description}
                        </dd>
                    </dl>
                </a>
            {/each}
        </div>
    </section>
{/if}
