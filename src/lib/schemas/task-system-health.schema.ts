// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Task-System Health — Zod schemas + taxonomy.
 *
 * SINGLE SOURCE OF TRUTH for:
 *   - the unified 4-state health taxonomy (`healthy / degraded / unhealthy / unknown`),
 *   - the rollup `HealthVerdict` ({ status, reasons[], generatedAt }) returned by
 *     `GET /api/admin/task-system/observability`,
 *   - the `ScheduleOverdueView` shape (schedule countdown / overdue detection).
 *
 * Types are inferred via `z.infer<>` — never hand-write a parallel interface.
 *
 * `ScheduleOverdueView` is the single schedule type shared across all admin endpoints.
 */

import { z } from 'zod';
import type { FindingStatus } from '$lib/server/database/queries/health-check-findings.queries.js';

// ── Unified 4-state taxonomy ────────────────────────────────────────────────

/**
 * The single source of truth for health states across `/admin/system-health`,
 * `/admin/cluster`, and `/admin/ingest`. Cluster/component/finding axes map onto
 * this enum via the helpers below rather than inventing their own strings.
 */
export const HealthTaxonomySchema = z
    .enum(['healthy', 'degraded', 'unhealthy', 'unknown'])
    .describe('Unified task-system health state');
export type HealthTaxonomy = z.infer<typeof HealthTaxonomySchema>;

// ── Rollup verdict ──────────────────────────────────────────────────────────

/** Stable machine reason codes. */
export const HealthReasonCodeSchema = z.enum([
    'inputs-unreadable',
    'subsystem-dead',
    'subsystem-degraded',
    'class-no-leader',
    'leader-expiring',
    'schedule-overdue',
    'invariant-red',
    'invariant-amber',
    'invariant-unknown',
]);
export type HealthReasonCode = z.infer<typeof HealthReasonCodeSchema>;

export const HealthReasonSchema = z.object({
    code: HealthReasonCodeSchema.describe('Stable machine reason code'),
    severity: z.enum(['warn', 'error']).describe('warn ⇒ degraded, error ⇒ unhealthy'),
    subsystem: z.string().describe('Affected subsystem / leader class / invariant id'),
    summary: z.string().describe('Human one-liner for the UI'),
    detail: z.record(z.string(), z.unknown()).optional().describe('Optional structured context'),
});
export type HealthReason = z.infer<typeof HealthReasonSchema>;

export const HealthVerdictSchema = z.object({
    status: HealthTaxonomySchema,
    reasons: z.array(HealthReasonSchema).describe('Empty iff healthy; ordered error-first'),
    generatedAt: z.string().describe('ISO server compute time'),
});
export type HealthVerdict = z.infer<typeof HealthVerdictSchema>;

// ── Schedule overdue / countdown view ───────────────────────────────────────

/**
 * One scheduled task's countdown + overdue view, derived from the already-
 * persisted `scheduler_state` row. No new write — this is pure projection.
 *
 * `resourceClass` is included so the `/now` endpoint can group schedules by
 * class without a separate type.
 */
export const ScheduleOverdueViewSchema = z.object({
    taskId: z.string(),
    resourceClass: z.string().nullable().describe('Resource class of the task, or null if unknown'),
    nextFireAt: z.string().describe('ISO next scheduled fire time'),
    lastFiredAt: z.string().nullable().describe('ISO last fire time, or null if never fired'),
    paused: z.boolean(),
    overdueByMs: z.number().describe('max(0, now - nextFireAt - grace); 0 ⇒ on time'),
    countdownMs: z.number().describe('max(0, nextFireAt - now); for the UI countdown'),
    overdue: z.boolean().describe('overdueByMs > 0 && !paused'),
});
export type ScheduleOverdueView = z.infer<typeof ScheduleOverdueViewSchema>;

// ── Taxonomy mapping helpers (shared, server + client safe) ─────────────────

/**
 * Map a `health_check_findings` status (`green/amber/red/unknown`) onto the
 * unified taxonomy.
 */
export function taxonomyFromFinding(status: FindingStatus): HealthTaxonomy {
    switch (status) {
        case 'green':
            return 'healthy';
        case 'amber':
            return 'degraded';
        case 'red':
            return 'unhealthy';
        case 'unknown':
        default:
            return 'unknown';
    }
}

/** Cluster status surface used to derive a taxonomy verdict. */
export interface ClusterTaxonomyInput {
    totalOnline: number;
    totalRegistered: number;
}

/**
 * Map cluster online/registered counts onto the unified taxonomy. `null` (the
 * status could not be read) → `unknown`. Replaces the inline `isHealthy` derived
 * in `cluster/+page.svelte`.
 */
export function taxonomyFromCluster(status: ClusterTaxonomyInput | null): HealthTaxonomy {
    if (status === null) return 'unknown';
    // No node has ever registered (fresh install) — nothing is known yet, not a
    // failure. Avoids painting a red UNHEALTHY pip on a brand-new deployment.
    if (status.totalRegistered === 0) return 'unknown';
    if (status.totalOnline === 0) return 'unhealthy';
    if (status.totalOnline < status.totalRegistered) return 'degraded';
    return 'healthy';
}

/**
 * Map a component-health `status` value (`pass|warn|fail|undefined`) onto the
 * unified taxonomy. `undefined` covers components that could not be read.
 */
export function taxonomyFromComponentStatus(
    status: 'pass' | 'warn' | 'fail' | undefined,
): HealthTaxonomy {
    if (status === 'pass') return 'healthy';
    if (status === 'fail') return 'unhealthy';
    if (status === 'warn') return 'degraded';
    return 'unknown';
}
