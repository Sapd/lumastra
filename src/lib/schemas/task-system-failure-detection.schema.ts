// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Task-System Failure Detection — Zod response schemas.
 *
 * SINGLE SOURCE OF TRUTH for the shapes returned by the
 * /api/admin/task-system/{failures/patterns,circuits,systemic,trends} endpoints
 * and the extended /audit endpoint's keyset response.
 *
 * Types are inferred via `z.infer<>` — never hand-write a parallel interface.
 *
 * Reuses `AuditEventRowSchema` from task-system-observability for the audit
 * feed; extends only with the keyset cursor envelope.
 */

import { z } from 'zod';
import { AuditEventRowSchema } from './task-system-observability.schema.js';

// ── Error fingerprinting ─────────────────────────────────────────────────────

/** One aggregated failure pattern over a window — grouped by fingerprint. */
export const FailurePatternSchema = z.object({
    fingerprint: z.string(),
    normalizedMessage: z.string(),
    sampleMessage: z.string(),
    count: z.number().int(),
    firstSeen: z.string(),
    lastSeen: z.string(),
    affectedTasks: z.array(z.string()),
    /** When `affectedTasks` is capped, how many distinct tasks were dropped. */
    affectedTasksOverflow: z.number(),
    source: z.enum(['run', 'item']),
    kinds: z.array(z.string()).optional(),
});
export type FailurePattern = z.infer<typeof FailurePatternSchema>;

export const FailurePatternsResponseSchema = z.object({
    patterns: z.array(FailurePatternSchema),
    window: z.object({ sinceHours: z.number() }),
});
export type FailurePatternsResponse = z.infer<typeof FailurePatternsResponseSchema>;

// ── Circuit-breaker fleet ────────────────────────────────────────────────────

export const CircuitFleetEntrySchema = z.object({
    taskId: z.string(),
    state: z.enum(['closed', 'open', 'half_open']),
    consecutiveFailures: z.number(),
    openedAt: z.string().nullable(),
    openedReason: z.string().nullable(),
    nextProbeAt: z.string().nullable(),
    forceEnabled: z.boolean(),
    /** Message from the task's most recent failed run — the real cause, vs. `openedReason`'s generic trip-mechanism enum. */
    lastErrorMessage: z.string().nullable(),
});
export type CircuitFleetEntry = z.infer<typeof CircuitFleetEntrySchema>;

export const CircuitFleetSummarySchema = z.object({
    open: z.number(),
    halfOpen: z.number(),
    forceEnabled: z.number(),
    total: z.number().int(),
});
export type CircuitFleetSummary = z.infer<typeof CircuitFleetSummarySchema>;

export const CircuitFleetResponseSchema = z.object({
    summary: CircuitFleetSummarySchema,
    entries: z.array(CircuitFleetEntrySchema),
});
export type CircuitFleetResponse = z.infer<typeof CircuitFleetResponseSchema>;

// ── Systemic failures ────────────────────────────────────────────────────────

export const SystemicResponseSchema = z.object({
    stalledByClass: z.record(z.string(), z.number()),
    backpressureShed: z.number(),
    orphansReclaimed: z.number(),
    openCircuits: z.number(),
    window: z.object({ sinceHours: z.number() }),
});
export type SystemicResponse = z.infer<typeof SystemicResponseSchema>;

// ── Trend snapshots ──────────────────────────────────────────────────────────

export const TaskMetricsSnapshotSchema = z.object({
    id: z.number(),
    ts: z.string(),
    instanceId: z.string(),
    queueDepth: z.record(z.string(), z.number()),
    activeRuns: z.record(z.string(), z.number()),
    durationP50Ms: z.number().nullable(),
    durationP95Ms: z.number().nullable(),
    runsCompleted: z.number(),
    runsFailed: z.number(),
    openCircuits: z.number(),
});
export type TaskMetricsSnapshot = z.infer<typeof TaskMetricsSnapshotSchema>;

export const TrendsResponseSchema = z.object({
    points: z.array(TaskMetricsSnapshotSchema),
});
export type TrendsResponse = z.infer<typeof TrendsResponseSchema>;

// ── Extended audit feed (keyset) ────────────────────────────────────────────

/**
 * Extended `/audit` response with severity + keyset (since/before) filters
 * and a `nextCursor` for the feed UI's infinite scroll. The cursor is the
 * oldest returned row's `id` (rows are newest-first); pass it back as
 * `cursor=` to page older. `null` means no more rows.
 */
export const AuditFeedResponseSchema = z.object({
    items: z.array(AuditEventRowSchema),
    page: z.object({
        limit: z.number().int(),
        hasMore: z.boolean(),
        nextCursor: z.string().optional(),
    }),
});
export type AuditFeedResponse = z.infer<typeof AuditFeedResponseSchema>;
