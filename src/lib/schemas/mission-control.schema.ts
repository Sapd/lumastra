// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Mission Control — Zod schemas ("What's happening now?").
 *
 * SINGLE SOURCE OF TRUTH for the coalesced slow-changing snapshot returned by
 * `GET /api/admin/task-system/now` and for the client-side bus event ring that
 * feeds the live error/action ticker.
 *
 * Types are inferred via `z.infer<>` — never hand-write a parallel interface.
 */

import { z } from 'zod';
import { ScheduleOverdueViewSchema } from './task-system-health.schema.js';
import { HealthTaxonomySchema } from './task-system-health.schema.js';

// ── Per-class activity + saturation snapshot ────────────────────────────────

/**
 * One resource class's slow-changing context: queue depths, the configured
 * concurrency cap, the derived saturation ratio, and (optionally) the
 * per-class leader holder.
 *
 * `saturationPct` is `null` when `cap <= 0` (unknown/uncapped); otherwise the
 * UI badges amber when `active >= cap` (full).
 */
export const ClassSnapshotSchema = z.object({
    resourceClass: z.string().describe('Canonical RESOURCE_CLASSES entry'),
    waiting: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    delayed: z.number().int().nonnegative(),
    paused: z.boolean(),
    cap: z.number().int().nonnegative().describe('Configured concurrency cap (boot-time)'),
    saturationPct: z
        .number()
        .nullable()
        .describe('active/cap as a 0..1+ ratio; null when cap <= 0'),
    leaderInstanceId: z
        .string()
        .nullable()
        .optional()
        .describe('Per-class leader holder; omitted/null when absent'),
});
export type ClassSnapshot = z.infer<typeof ClassSnapshotSchema>;

// ── Cluster node identity snapshot ──────────────────────────────────────────

/**
 * Node identity only. The current-job-per-node join happens CLIENT-SIDE (live
 * runs whose `ownerInstanceId === instanceId`) so it stays real-time without
 * the server polling per-run state.
 */
export const NodeSnapshotSchema = z.object({
    instanceId: z.string(),
    isSelf: z.boolean(),
    online: z.boolean(),
    version: z.string().nullable(),
});
export type NodeSnapshot = z.infer<typeof NodeSnapshotSchema>;

// ── Coalesced snapshot envelope ─────────────────────────────────────────────

/**
 * Health summary lifted into the snapshot for the header chip. `status` is
 * `HealthVerdict.status` (taxonomy), or `'unknown'` when the observability
 * endpoint was unreadable.
 */
export const NowHealthSchema = z.object({
    status: HealthTaxonomySchema.describe(
        "health.status from HealthVerdict; 'unknown' when absent",
    ),
    available: z.boolean().describe('false when the observability endpoint was unreadable'),
});
export type NowHealth = z.infer<typeof NowHealthSchema>;

// ── Library embedding coverage (informational progress scalar) ──────────────

/**
 * How many file-backed, active items are eligible for a library embedding vs.
 * how many have one. Informational onboarding signal ("are my library items
 * embedded?") — NOT a health alarm; a fresh import legitimately shows a large
 * gap until the pipeline catches up. `coveragePct` is null when nothing is
 * eligible (avoids 0/0). Absent when the DB axis was unreadable.
 */
export const EmbeddingCoverageSchema = z.object({
    eligible: z.number().int().nonnegative().describe('Active, file-backed items'),
    embedded: z
        .number()
        .int()
        .nonnegative()
        .describe('Eligible items that have a library embedding'),
    missing: z.number().int().nonnegative().describe('eligible - embedded'),
    coveragePct: z
        .number()
        .nullable()
        .describe('embedded/eligible as a 0..1 ratio; null when eligible is 0'),
});
export type EmbeddingCoverage = z.infer<typeof EmbeddingCoverageSchema>;

export const NowSnapshotSchema = z.object({
    classes: z.array(ClassSnapshotSchema),
    nodes: z.array(NodeSnapshotSchema),
    schedules: z.array(ScheduleOverdueViewSchema).describe('ScheduleOverdueView[]'),
    health: NowHealthSchema,
    embeddingCoverage: EmbeddingCoverageSchema.nullable()
        .optional()
        .describe('Library embedding coverage; null/absent when the DB was unreadable'),
    generatedAt: z.string().describe('ISO server compute time'),
});
export type NowSnapshot = z.infer<typeof NowSnapshotSchema>;

// ── Live bus event (client-side ticker projection) ──────────────────────────

/**
 * Normalized event the run-SSE bus pushes into its bounded `recentEvents` ring
 * as CloudEvents flow. The error/action ticker is a pure projection of these —
 * no new server stream, no new hot-path write.
 *
 * `kind` distinguishes run terminal transitions from `meta` autonomous actions.
 * `severity` drives the ticker badge: run failures map from `error.kind`
 * (transient→warn, permanent/fatal→error); meta actions map by category.
 */
export const BusEventKindSchema = z.enum(['run.failed', 'run.completed', 'meta']);
export type BusEventKind = z.infer<typeof BusEventKindSchema>;

export const BusEventSeveritySchema = z.enum(['info', 'warn', 'error']);
export type BusEventSeverity = z.infer<typeof BusEventSeveritySchema>;

export const BusEventSchema = z.object({
    /** Monotonic client-assigned sequence — newest-largest, for stable keys. */
    seq: z.number(),
    /** Epoch ms when the bus observed the event. */
    ts: z.number(),
    kind: BusEventKindSchema,
    severity: BusEventSeveritySchema,
    summary: z.string(),
    taskId: z.string().optional(),
    runId: z.string().optional(),
    instanceId: z.string().optional(),
    /**
     * For `kind: 'meta'` events, the autonomous-action subtype (e.g.
     * `scheduler-tick`, `orphans-reclaimed`). Lets the ticker suppress
     * pure-heartbeat noise while keeping real actions. Absent for run events.
     */
    metaType: z.string().optional(),
});
export type BusEvent = z.infer<typeof BusEventSchema>;
