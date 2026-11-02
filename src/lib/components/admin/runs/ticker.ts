// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure transforms for the Mission Control error/action ticker (Slice 4).
 *
 * The ticker is a client-side projection: REST-seeded history (from the Slice
 * 0/3 audit feed) merged with the live `bus.recentEvents` ring, rendered
 * newest-first and bounded. These helpers keep that merge/filter logic
 * testable without DOM/SSE plumbing (slice-4 spec §9 "ticker filter").
 */

import type { BusEvent, BusEventSeverity } from '$lib/schemas/mission-control.schema.js';
import type { AuditEventRow } from '$lib/schemas/task-system-observability.schema.js';

/** Max rows the ticker renders. */
export const TICKER_CAP = 50;

/**
 * `meta` subtypes that are pure liveness heartbeats — they prove the SSE stream
 * is alive (and drive the freshness badge) but are NOT "errors or notable
 * actions", so they must not crowd the ticker. On a busy multi-replica system
 * `scheduler-tick` fires every few seconds and would otherwise dominate both the
 * 50-row view and the 200-entry ring, pushing real failures out.
 */
const TICKER_SUPPRESSED_META: ReadonlySet<string> = new Set(['scheduler-tick']);

/** True if an event belongs in the "errors & actions" ticker. */
export function isTickerWorthy(ev: BusEvent): boolean {
    if (ev.kind === 'meta' && ev.metaType && TICKER_SUPPRESSED_META.has(ev.metaType)) {
        return false;
    }
    return true;
}

/**
 * Map a Slice 0/3 `audit_log` (source='subsystem') row into a ticker `BusEvent`. Audit rows
 * are coarse autonomous actions (per-sweep/per-transition) — the right source
 * for *history on first paint* (slice-4 spec §4.3 option B). `seq` is set
 * negative-of-id so seeded history always sorts before live bus events (which
 * use non-negative client sequence numbers) and stays stable.
 */
export function auditRowToBusEvent(row: AuditEventRow): BusEvent {
    const tsMs = Date.parse(row.ts);
    const detail = row.detail ?? {};
    const taskId = typeof detail.taskId === 'string' ? detail.taskId : undefined;
    const runId = typeof detail.runId === 'string' ? detail.runId : undefined;
    return {
        seq: -row.id,
        ts: Number.isFinite(tsMs) ? tsMs : 0,
        kind: 'meta',
        severity: row.severity as BusEventSeverity,
        summary: row.summary,
        taskId,
        runId,
        instanceId: row.instanceId,
    };
}

/**
 * Width of the time bucket used to fold a run-less `meta` event's identity
 * (see {@link eventIdentity}). Wide enough to absorb the latency between a
 * seed row's DB-write timestamp and the same occurrence's client-receipt
 * timestamp on the live SSE path (sub-second in practice), narrow enough
 * that two genuinely-separate repeats of the same message stay distinct —
 * the subsystems that emit these events (reconciler sweep, backpressure
 * rollup) are gated to fire at most once per 30s tick.
 */
const NO_RUN_ID_DEDUPE_BUCKET_MS = 10_000;

/**
 * A stable identity for an event, used to de-dupe the SAME real occurrence
 * across its two representations: the REST-seeded audit history (`seq =
 * -row.id`) and the live SSE ring (`seq` = a client-assigned counter). Those
 * two `seq` domains never intersect by construction, so keying purely on
 * `seq` (the previous approach) can never catch a seed/live duplicate of one
 * occurrence — nor a live/live duplicate from an SSE bootstrap replay, which
 * re-delivers recently-buffered run.failed/run.completed frames with a
 * *fresh* client-assigned `seq` on every new connection.
 *
 * `runId`-bearing events (run.failed, run.completed, and any `meta` event
 * that carries one, e.g. transition-conflict) are one-shot per run — a given
 * run reaches a given terminal state exactly once — so `kind:runId` alone is
 * a robust identity regardless of timestamp drift between the two paths.
 * Run-less `meta` events (leader-elected, scheduler-tick, backpressure-shed,
 * boot-recovery-complete, …) have no such natural key; they fall back to
 * kind + task + summary text, folded into a coarse time bucket.
 */
function eventIdentity(ev: BusEvent): string {
    if (ev.runId) return `${ev.kind}:${ev.runId}`;
    const bucket = Math.round(ev.ts / NO_RUN_ID_DEDUPE_BUCKET_MS);
    return `${ev.kind}:${ev.taskId ?? ''}:${ev.summary}:${bucket}`;
}

/**
 * Merge seeded history with the live bus ring, newest-first, bounded to
 * {@link TICKER_CAP}. De-dupes by {@link eventIdentity} rather than raw
 * `seq` so the SAME real occurrence delivered via both the seed and the live
 * path (or twice over the live path via SSE bootstrap replay) survives only
 * once — `seq` alone can't do this (see {@link eventIdentity}'s doc comment).
 */
export function mergeTickerEvents(
    seed: readonly BusEvent[],
    live: readonly BusEvent[],
    cap: number = TICKER_CAP,
): BusEvent[] {
    const byIdentity = new Map<string, BusEvent>();
    // Live is folded in AFTER seed so a live representation of the same
    // occurrence (fresher, non-negative seq) wins the identity slot —
    // preserves the previous tie-break intent ("live > seed at equal ts").
    for (const e of seed) if (isTickerWorthy(e)) byIdentity.set(eventIdentity(e), e);
    for (const e of live) if (isTickerWorthy(e)) byIdentity.set(eventIdentity(e), e);
    const merged = Array.from(byIdentity.values());
    // Newest-first: by timestamp desc, tie-broken by seq desc (live > seed).
    merged.sort((a, b) => (b.ts !== a.ts ? b.ts - a.ts : b.seq - a.seq));
    return merged.slice(0, cap);
}
