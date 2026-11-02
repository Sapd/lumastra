// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin IA redesign, spec §3.4/§5: the Health page's "#activity" section
 * (aggregated activity log). Identical repeated events collapse into one row
 * with a "×N in Xh" suffix (`formatRepeats`) instead of flooding the feed
 * with duplicates — the same rule `error-feed.ts` applies to the Runs rail,
 * adapted for the paginated `AuditEventRow` shape (category+action+summary
 * identity, not a `BusEvent`). Pure transform, kept separate from
 * `AuditFeed.svelte` so the grouping logic is testable without DOM/fetch
 * plumbing (same rationale as `error-feed.ts`).
 */

import type { AuditEventRow } from '$lib/schemas/task-system-observability.schema.js';

export interface AggregatedAuditRow {
    /** Grouping key — `category:action:summary`. */
    key: string;
    category: string;
    action: string;
    summary: string;
    /** Severity of the most recent occurrence (severities never mix within a group in practice). */
    severity: AuditEventRow['severity'];
    /** All raw occurrences in this group, newest first — length is the count. */
    events: AuditEventRow[];
}

/**
 * Groups events by exact `(category, action, summary)` identity, preserving
 * every raw occurrence (for the "show individual events" expand). Sorted
 * newest-first by each group's most recent occurrence. `events` arrives
 * already sorted newest-first (server cursor order); grouping preserves that
 * relative order within each group.
 */
export function aggregateAuditEvents(events: readonly AuditEventRow[]): AggregatedAuditRow[] {
    const byKey = new Map<string, AggregatedAuditRow>();
    for (const ev of events) {
        const key = `${ev.category}:${ev.action}:${ev.summary}`;
        const existing = byKey.get(key);
        if (existing) {
            existing.events.push(ev);
            continue;
        }
        byKey.set(key, {
            key,
            category: ev.category,
            action: ev.action,
            summary: ev.summary,
            severity: ev.severity,
            events: [ev],
        });
    }
    return Array.from(byKey.values()).sort((a, b) => {
        const aLatest = Date.parse(a.events[0].ts);
        const bLatest = Date.parse(b.events[0].ts);
        return bLatest - aLatest;
    });
}

/**
 * Whole-hours span between a group's oldest and newest occurrence, for the
 * "×N in Xh" wording (`formatRepeats`) — the REAL observed window, not a
 * made-up constant, so the count never overclaims (spec §5 counter honesty).
 * Always at least 1h so a single-minute burst doesn't render "in 0h".
 */
export function aggregatedWindowHours(row: AggregatedAuditRow): number {
    if (row.events.length < 2) return 1;
    const newest = Date.parse(row.events[0].ts);
    const oldest = Date.parse(row.events[row.events.length - 1].ts);
    return Math.max(1, Math.round((newest - oldest) / (60 * 60 * 1000)));
}
