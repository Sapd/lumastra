// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Task-System Observability — Zod response schemas (Slice 0).
 *
 * SINGLE SOURCE OF TRUTH for the shapes returned by the
 * /api/admin/task-system/{observability,audit,metrics} endpoints.
 *
 * Types are inferred via `z.infer<>` — never hand-write a parallel interface.
 *
 * Convention:
 * - Prefer `.optional()` over `.nullable()` unless the value genuinely can be null.
 *   Heartbeat fields and leader holders ARE genuinely null (absent key / no
 *   leader), so `.nullable()` is correct for those.
 */

import { z } from 'zod';
import { HealthVerdictSchema, ScheduleOverdueViewSchema } from './task-system-health.schema.js';

// ── Subsystem heartbeats ────────────────────────────────────────────────────

/**
 * One subsystem's liveness view, derived from its Valkey heartbeat key.
 * `alive: false` with no other fields means the key was absent (dead / never
 * written / TTL-expired).
 */
export const HeartbeatViewSchema = z.object({
    name: z.string(),
    alive: z.boolean(),
    leaderGated: z.boolean().optional(),
    instanceId: z.string().optional(),
    lastTickAt: z.number().optional(),
    intervalMs: z.number().optional(),
    ageMs: z.number().optional(),
    status: z.enum(['ok', 'degraded']).optional(),
    detail: z.record(z.string(), z.unknown()).optional(),
});
export type HeartbeatView = z.infer<typeof HeartbeatViewSchema>;

// ── Resource-class leaders ──────────────────────────────────────────────────

export const ClassLeaderSchema = z.object({
    resourceClass: z.string(),
    holderInstanceId: z.string().nullable(),
    heldByThisReplica: z.boolean(),
    ttlMs: z.number().nullable(),
});
export type ClassLeader = z.infer<typeof ClassLeaderSchema>;

// ── Boot-recovery log ───────────────────────────────────────────────────────

export const BootRecoveryRowSchema = z.object({
    id: z.number(),
    instanceId: z.string(),
    startedAt: z.string(),
    finishedAt: z.string(),
    inspected: z.number(),
    reclaimed: z.number(),
    wedgedStageRowsReclaimed: z.number(),
    runIds: z.array(z.string()),
});
export type BootRecoveryRow = z.infer<typeof BootRecoveryRowSchema>;

// ── Audit-log events ────────────────────────────────────────────────────────

export const AuditEventRowSchema = z.object({
    id: z.number(),
    ts: z.string(),
    instanceId: z.string(),
    category: z.string(),
    action: z.string(),
    severity: z.enum(['info', 'warn', 'error']),
    summary: z.string(),
    detail: z.record(z.string(), z.unknown()),
});
export type AuditEventRow = z.infer<typeof AuditEventRowSchema>;

// NOTE: the audit-feed response shape lives in task-system-failure-detection
// (AuditFeedResponseSchema, Slice 3) which supersedes the earlier wrapper here.

// ── Composed observability endpoint ─────────────────────────────────────────

/**
 * Per-component health, keyed by component name (database, valkey, orchestrator,
 * webhookOutbox, pendingWriteDrain). `.catchall` keeps it tolerant of new
 * component fields without a schema bump.
 *
 * Status vocab: `pass | warn | fail` (application/health+json §4).
 * Legacy `ok`/`healthy` boolean fields are removed — read `status` instead.
 */
export const ComponentHealthSchema = z
    .object({
        status: z.enum(['pass', 'warn', 'fail']),
        reason: z.string().optional(),
        error: z.string().optional(),
        isLeaderForAnyClass: z.boolean().optional(),
        pending: z.number().optional(),
        dead: z.number().optional(),
        depth: z.number().optional(),
    })
    .catchall(z.unknown());
export type ComponentHealth = z.infer<typeof ComponentHealthSchema>;

/**
 * Slice 1 replaces the naive Slice-0 `derivedStatus` string with a structured
 * `health` verdict ({ status, reasons[], generatedAt }) and adds `schedules`
 * (the countdown / overdue projection that also feeds the verdict). The verdict
 * + schedule types live in `task-system-health.schema.ts` (single source).
 */
export const ObservabilityResponseSchema = z.object({
    timestamp: z.string(),
    health: HealthVerdictSchema,
    schedules: z.array(ScheduleOverdueViewSchema),
    subsystems: z.array(HeartbeatViewSchema),
    leaders: z.array(ClassLeaderSchema),
    bootRecovery: BootRecoveryRowSchema.nullable(),
    components: z.record(z.string(), ComponentHealthSchema),
});
export type ObservabilityResponse = z.infer<typeof ObservabilityResponseSchema>;

// ── Metrics bridge projection ───────────────────────────────────────────────

export const MetricsBridgeResponseSchema = z.object({
    timestamp: z.string(),
    queueDepth: z.array(
        z.object({
            queue: z.string(),
            resourceClass: z.string(),
            value: z.number(),
        }),
    ),
    runsByStatus: z.array(
        z.object({
            taskId: z.string(),
            status: z.string(),
            resourceClass: z.string(),
            value: z.number(),
        }),
    ),
    activeRuns: z.array(
        z.object({
            resourceClass: z.string(),
            instanceId: z.string(),
            value: z.number(),
        }),
    ),
    duration: z.object({
        buckets: z.array(z.object({ le: z.string(), value: z.number() })),
        sum: z.number(),
        count: z.number().int(),
    }),
    backpressureTotals: z.array(
        z.object({
            resourceClass: z.string(),
            action: z.string(),
            value: z.number(),
        }),
    ),
    stageBacklog: z.array(z.object({ stageId: z.string(), value: z.number() })),
    pendingWriteDropped: z.number(),
    pendingWritePoisoned: z.number(),
});
export type MetricsBridgeResponse = z.infer<typeof MetricsBridgeResponseSchema>;
