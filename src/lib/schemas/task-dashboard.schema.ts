// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Declarative, serializable data contract for the reusable <TaskDashboard>
 * admin component. Generalizes the friendly /admin/developer/sonic-embeddings pattern
 * (stat tiles + coverage bars + action cards + "how it works") so any task can
 * render a per-task operator dashboard from a single JSON-safe object.
 *
 * Everything here is pure data — no functions, no component references — so the
 * shape can be produced on the server (or in a pure mapper) and passed straight
 * into the component. Actions are described by an HTTP request the component
 * fires; confirmation is described by a plain object the component turns into an
 * <ActionModal>.
 */

import { z } from 'zod';

/** MetricColor palette used by StatCard (`$lib/utils/metric-styles`). */
export const StatTileColorSchema = z.enum([
    'blue',
    'purple',
    'green',
    'cyan',
    'orange',
    'red',
    'yellow',
]);
export type StatTileColor = z.infer<typeof StatTileColorSchema>;

/** Confirm-button colors accepted by ActionModal (`confirmColor` prop). */
export const ActionConfirmColorSchema = z.enum(['green', 'blue', 'purple', 'red']);
export type ActionConfirmColor = z.infer<typeof ActionConfirmColorSchema>;

/**
 * One coverage headline bar (e.g. "1,204 of 1,850 tracks embedded"). When
 * `percent` is omitted the component derives it from `done`/`total`.
 */
export const CoverageBarSchema = z.object({
    label: z.string(),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    /** Explicit percentage override (0–100). Omit to derive from done/total. */
    percent: z.number().min(0).max(100).optional(),
    /** Plural unit noun for the caption, e.g. "tracks", "files". */
    unitLabel: z.string().optional(),
});
export type CoverageBar = z.infer<typeof CoverageBarSchema>;

/** One stat tile rendered by StatCard in the grid. */
export const StatTileSchema = z.object({
    key: z.string(),
    title: z.string(),
    value: z.union([z.string(), z.number()]),
    color: StatTileColorSchema.optional(),
    subtitle: z.string().optional(),
    /** true → green, false → red, omitted → color-derived (StatCard semantics). */
    healthy: z.boolean().optional(),
    /** Opaque icon selector resolved by the component to a hero-icon. */
    iconKey: z.string().optional(),
});
export type StatTile = z.infer<typeof StatTileSchema>;

/** Optional confirm dialog surfaced before an action fires. */
export const ActionConfirmSchema = z.object({
    title: z.string(),
    body: z.string().optional(),
    confirmText: z.string(),
    confirmColor: ActionConfirmColorSchema,
});
export type ActionConfirm = z.infer<typeof ActionConfirmSchema>;

/** The HTTP request an action fires when confirmed/clicked. */
export const ActionRequestSchema = z.object({
    method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
    url: z.string(),
    body: z.unknown().optional(),
});
export type ActionRequest = z.infer<typeof ActionRequestSchema>;

/** A single primary/secondary action button. */
export const TaskActionSchema = z.object({
    id: z.string(),
    label: z.string(),
    style: z.enum(['primary', 'secondary', 'danger']),
    description: z.string().optional(),
    /**
     * Inline warning shown INSTEAD of `description` when the action's usual
     * behavior is compromised (e.g. "Run now" while the task's circuit
     * breaker is paused — the run would likely be denied). Rendered in
     * amber rather than the muted description color.
     */
    warning: z.string().optional(),
    confirm: ActionConfirmSchema.optional(),
    request: ActionRequestSchema,
    /**
     * When true, the component reads `runId` from the response and opens the
     * run log drawer for it (used by "Run now" → live logs).
     */
    openLogsOnRunId: z.boolean().optional(),
});
export type TaskAction = z.infer<typeof TaskActionSchema>;

/** Failures section configuration (delegates to <TaskFailuresList>). */
export const TaskDashboardFailuresSchema = z.object({
    show: z.boolean(),
    supportsRetry: z.boolean(),
});
export type TaskDashboardFailures = z.infer<typeof TaskDashboardFailuresSchema>;

/** Complete, serializable input for <TaskDashboard>. */
export const TaskDashboardDataSchema = z.object({
    taskId: z.string(),
    title: z.string(),
    description: z.string().optional(),
    /**
     * Curated "if this stops, you'd notice" consequence line (see
     * `taskImpact()` in `$lib/utils/admin/task-descriptions`). Rendered under
     * `description`; omitted (not every task has one — see that function).
     */
    impact: z.string().optional(),
    coverage: z.array(CoverageBarSchema),
    stats: z.array(StatTileSchema),
    primaryAction: TaskActionSchema.optional(),
    secondaryActions: z.array(TaskActionSchema),
    failures: TaskDashboardFailuresSchema.optional(),
    help: z.array(z.string()),
});
export type TaskDashboardData = z.infer<typeof TaskDashboardDataSchema>;
