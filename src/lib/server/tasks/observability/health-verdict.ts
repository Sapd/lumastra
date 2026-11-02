// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// health-verdict.ts — the real rollup health verdict (Slice 1).
//
// REPLACES the naive Slice-0 `deriveStatus`. PURE + synchronous + fully unit-
// testable: the endpoint gathers the inputs (heartbeats, leaders, schedules,
// invariants) and passes them here; this function does NO I/O.
//
// It COMBINES two orthogonal axes Slice 0 kept separate — worker liveness
// (heartbeats) and data invariants (health_check_findings) — plus per-class
// leaders and schedule-overdue, and rolls them into one worst-wins verdict.
// It does NOT re-implement either axis; it reads both. (slice-1 spec §2, §4.)

import type { ClassLeader, HeartbeatView } from '$lib/schemas/task-system-observability.schema.js';
import type {
    HealthReason,
    HealthTaxonomy,
    HealthVerdict,
    ScheduleOverdueView,
} from '$lib/schemas/task-system-health.schema.js';
import type { FindingStatus } from '$lib/server/database/queries/health-check-findings.queries.js';
import { taxonomyFromFinding } from '$lib/schemas/task-system-health.schema.js';
import { LEADER_TTL_WARN_MS } from './schedule-overdue.js';
import type { InvariantDetailLink } from '$lib/server/services/health-invariants/invariants.js';

/** One invariant finding projected to the minimum the verdict needs. */
export interface InvariantFinding {
    status: FindingStatus;
    id: string;
    label: string;
    /** Optional richer context — surfaced in the verdict reason detail so the
     *  UI shows what's wrong + what to do, not just `{invariantId, status}`. */
    description?: string;
    remediation?: string | null;
    value?: number | null;
    thresholdAmber?: number | null;
    thresholdRed?: number | null;
    /** Per-target deep-link breakdown — see `InvariantDetailLink`. */
    details?: InvariantDetailLink[];
}

/** Build a readable reason detail from a finding — only includes fields present. */
function invariantDetail(inv: InvariantFinding): Record<string, unknown> {
    const d: Record<string, unknown> = {
        invariantId: inv.id,
        status: inv.status,
    };
    if (inv.value !== undefined && inv.value !== null) d.value = inv.value;
    if (inv.thresholdAmber !== undefined && inv.thresholdAmber !== null)
        d.thresholdAmber = inv.thresholdAmber;
    if (inv.thresholdRed !== undefined && inv.thresholdRed !== null)
        d.thresholdRed = inv.thresholdRed;
    if (inv.description) d.description = inv.description;
    if (inv.remediation) d.remediation = inv.remediation;
    if (inv.details && inv.details.length > 0) d.details = inv.details;
    return d;
}

export interface HealthVerdictInputs {
    heartbeats: HeartbeatView[];
    leaders: ClassLeader[];
    schedules: ScheduleOverdueView[];
    invariants: InvariantFinding[];
    /** false for an axis ⇒ that axis is unreadable and contributes `unknown`. */
    inputsAvailable: { valkey: boolean; db: boolean };
    /** Injected for deterministic `generatedAt` in tests. */
    now?: number;
}

function severityRank(severity: HealthReason['severity']): number {
    return severity === 'error' ? 0 : 1;
}

/**
 * Compute the rollup verdict.
 *
 * Aggregation: `unknown` if any input axis is unreadable; else `unhealthy` if
 * any `error` reason; else `degraded` if any `warn` reason; else `healthy`.
 * Reasons are sorted error-first, then by subsystem.
 */
export function computeHealthVerdict(inputs: HealthVerdictInputs): HealthVerdict {
    const generatedAt = new Date(inputs.now ?? Date.now()).toISOString();
    const { valkey, db } = inputs.inputsAvailable;

    // ── Unreadable inputs short-circuit to `unknown` ────────────────────────
    // We do NOT emit misleading "dead subsystem" reasons when the reason we
    // can't see them is that Valkey/DB itself is down — that's a clearer,
    // separate signal.
    if (!valkey || !db) {
        const which = !valkey && !db ? 'Valkey and database' : !valkey ? 'Valkey' : 'database';
        return {
            status: 'unknown',
            generatedAt,
            reasons: [
                {
                    code: 'inputs-unreadable',
                    severity: 'error',
                    subsystem: 'inputs',
                    summary: `Cannot read task-system state (${which} unreachable).`,
                    detail: { valkey, db },
                },
            ],
        };
    }

    const reasons: HealthReason[] = [];

    // ── Per-class leaders ───────────────────────────────────────────────────
    // Computed first so the no-leader set is available when processing heartbeats.
    let anyNoLeader = false;
    for (const leader of inputs.leaders) {
        if (leader.holderInstanceId === null) {
            anyNoLeader = true;
            reasons.push({
                code: 'class-no-leader',
                severity: 'error',
                subsystem: `leader:${leader.resourceClass}`,
                summary: `No worker is handling '${leader.resourceClass}' background jobs — check that a worker container is running.`,
                detail: { resourceClass: leader.resourceClass },
            });
        } else if (leader.ttlMs !== null && leader.ttlMs < LEADER_TTL_WARN_MS) {
            reasons.push({
                code: 'leader-expiring',
                severity: 'warn',
                subsystem: `leader:${leader.resourceClass}`,
                summary: `Worker ownership of '${leader.resourceClass}' jobs is unstable — renewing very late (${(
                    leader.ttlMs / 1000
                ).toFixed(1)}s left). If this repeats, check worker health and clock sync.`,
                detail: {
                    resourceClass: leader.resourceClass,
                    ttlMs: leader.ttlMs,
                },
            });
        }
    }

    // ── Worker liveness (heartbeats) ────────────────────────────────────────
    //
    // Fix 10 (OSS): when a no-leader condition is already present AND a dead
    // subsystem is leader-gated, the subsystem is expected to be silent (it
    // depends on a leader to run). Emitting a full CRITICAL `subsystem-dead` for
    // every such subsystem alongside the `class-no-leader` reason floods the
    // health panel with up to 10 redundant CRITICAL items — all caused by one root
    // cause. Suppress (or demote to warn) leader-gated subsystem-dead reasons when
    // `class-no-leader` is already the actionable root cause.
    for (const hb of inputs.heartbeats) {
        if (!hb.alive) {
            const leaderGated = hb.leaderGated === true;
            if (leaderGated && anyNoLeader) {
                // Demote: the subsystem is silent because there is no leader —
                // the class-no-leader reason is the single actionable root cause.
                reasons.push({
                    code: 'subsystem-dead',
                    severity: 'warn',
                    subsystem: hb.name,
                    summary: `The '${hb.name}' background service is idle because no worker has taken ownership yet.`,
                    detail: { ageMs: hb.ageMs, leaderGated, suppressedByNoLeader: true },
                });
            } else {
                reasons.push({
                    code: 'subsystem-dead',
                    severity: 'error',
                    subsystem: hb.name,
                    summary: hb.ageMs
                        ? `The '${hb.name}' background service hasn't reported in for ${formatAge(hb.ageMs)} and may be stopped — check the worker container.`
                        : `The '${hb.name}' background service isn't reporting in and may be stopped — check the worker container.`,
                    detail: { ageMs: hb.ageMs, leaderGated },
                });
            }
        } else if (hb.status === 'degraded') {
            reasons.push({
                code: 'subsystem-degraded',
                severity: 'warn',
                subsystem: hb.name,
                summary: `The '${hb.name}' background service is running but reporting problems.`,
                detail: { ...(hb.detail ?? {}) },
            });
        }
    }

    // ── Schedule overdue ────────────────────────────────────────────────────
    for (const sched of inputs.schedules) {
        if (sched.overdue) {
            reasons.push({
                code: 'schedule-overdue',
                severity: 'warn',
                subsystem: `schedule:${sched.taskId}`,
                summary: `Scheduled job '${sched.taskId}' is ${formatAge(sched.overdueByMs)} overdue (was due ${formatClock(
                    sched.nextFireAt,
                )}).`,
                detail: {
                    taskId: sched.taskId,
                    overdueByMs: sched.overdueByMs,
                    nextFireAt: sched.nextFireAt,
                },
            });
        }
    }

    // ── Data invariants ─────────────────────────────────────────────────────
    for (const inv of inputs.invariants) {
        const taxonomy = taxonomyFromFinding(inv.status);
        if (taxonomy === 'unhealthy') {
            reasons.push({
                code: 'invariant-red',
                severity: 'error',
                subsystem: inv.id,
                // The label is a sentence and the badge already says Critical;
                // appending ": failing — needs attention." restated the badge
                // and left "A library folder cannot be written to: failing —
                // needs attention." on screen.
                summary: inv.label,
                detail: invariantDetail(inv),
            });
        } else if (taxonomy === 'degraded') {
            reasons.push({
                code: 'invariant-amber',
                severity: 'warn',
                subsystem: inv.id,
                summary: inv.label,
                detail: invariantDetail(inv),
            });
        } else if (taxonomy === 'unknown') {
            reasons.push({
                code: 'invariant-unknown',
                severity: 'warn',
                subsystem: inv.id,
                summary: `Health check "${inv.label}" couldn't run — its result is unknown.`,
                detail: invariantDetail(inv),
            });
        }
    }

    // ── Worst-wins aggregation ──────────────────────────────────────────────
    let status: HealthTaxonomy = 'healthy';
    if (reasons.some((r) => r.severity === 'error')) status = 'unhealthy';
    else if (reasons.some((r) => r.severity === 'warn')) status = 'degraded';

    reasons.sort((a, b) => {
        const sr = severityRank(a.severity) - severityRank(b.severity);
        if (sr !== 0) return sr;
        return a.subsystem.localeCompare(b.subsystem);
    });

    return { status, reasons, generatedAt };
}

/** Compact "4m" / "12s" / "1h" age formatter for reason summaries. */
function formatAge(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.round(m / 60)}h`;
}

/**
 * ISO → "HH:MM UTC" wall-clock, defensively tolerant of an unparsable input.
 * UTC (not the server process TZ) so the absolute time in a reason summary is
 * unambiguous for OSS self-hosters whose container TZ differs from the operator.
 */
function formatClock(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm} UTC`;
}

/**
 * Derive whether the Valkey axis is READABLE from the already-computed
 * component-health block (whose `valkey.status` reflects a real PING round-trip).
 *
 * The Slice-0 readers (`readHeartbeats`/`readClassLeaders`) swallow Valkey
 * errors and return empty/"dead" views, so a failed read is indistinguishable
 * from a genuinely-idle system at their call site. The component PING is the
 * authoritative reachability signal — without this, a Valkey outage would
 * mis-report as `unhealthy` (every subsystem "dead") instead of `unknown`.
 */
export function deriveValkeyAvailable(
    // Accepts the `ComponentHealthReport` shape, whose index signature also
    // carries string members (e.g. `timestamp`) alongside the component
    // entries — hence the `| string` branch, narrowed away below.
    components: Record<string, { status?: string } | string | undefined>,
): boolean {
    const v = components.valkey;
    return typeof v === 'object' && v ? v.status === 'pass' : false;
}
