// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin IA redesign, spec §3.3/§5: the Runs page's "error feed" info rail is
 * an AGGREGATED mini-view — identical repeated events collapse into one row
 * with a "×N in 24 h" suffix (spec §5 "identical repeated events aggregate")
 * instead of flooding the rail with duplicates. Pure transform, kept
 * separate from `RunErrorFeedRail.svelte` so the grouping logic is testable
 * without DOM/SSE plumbing (same rationale as `ticker.ts`).
 */

import type { BusEvent } from '$lib/schemas/mission-control.schema.js';
import { isTickerWorthy } from './ticker.js';

export interface AggregatedErrorRow {
    /** Grouping key — the event summary text, verbatim. */
    summary: string;
    /** Severity of the most recent occurrence (severities never mix within a group in practice). */
    severity: BusEvent['severity'];
    /** Total occurrences within the window. */
    count: number;
    /** Epoch ms of the most recent occurrence — drives sort order + "checked Xs ago". */
    latestTs: number;
    /** taskId/runId/instanceId of the most recent occurrence, for deep-links. */
    taskId?: string;
    runId?: string;
    instanceId?: string;
}

/**
 * Groups events by exact `summary` text, counting only occurrences within
 * `windowMs` of `nowMs` (spec's "×N in 24 h" — the count names its window).
 * Routine `meta` heartbeats (`isTickerWorthy` — reused from the ticker
 * transforms) and `info`-severity events (e.g. `run.completed`) are excluded:
 * this is an ERROR feed, not a general activity feed. Sorted newest-first.
 */
export function aggregateErrorEvents(
    events: readonly BusEvent[],
    nowMs: number,
    windowMs: number = 24 * 60 * 60 * 1000,
): AggregatedErrorRow[] {
    const cutoff = nowMs - windowMs;
    const bySummary = new Map<string, AggregatedErrorRow>();

    for (const ev of events) {
        if (ev.severity === 'info') continue;
        if (!isTickerWorthy(ev)) continue;
        if (ev.ts < cutoff) continue;

        const existing = bySummary.get(ev.summary);
        if (!existing) {
            bySummary.set(ev.summary, {
                summary: ev.summary,
                severity: ev.severity,
                count: 1,
                latestTs: ev.ts,
                taskId: ev.taskId,
                runId: ev.runId,
                instanceId: ev.instanceId,
            });
            continue;
        }
        existing.count += 1;
        if (ev.ts > existing.latestTs) {
            existing.latestTs = ev.ts;
            existing.severity = ev.severity;
            existing.taskId = ev.taskId;
            existing.runId = ev.runId;
            existing.instanceId = ev.instanceId;
        }
    }

    return Array.from(bySummary.values()).sort((a, b) => b.latestTs - a.latestTs);
}
