// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Run schemas — re-exports from `@sapd/lumastra-plugin-sdk` so the wire shape
 * stays in lockstep with the SDK contract.
 *
 * Pre-consolidation: this file maintained a hand-copied parallel of the
 * SDK's `RunSchema` / `StageSchema` / `RunStateSchema` / trigger / actor
 * shapes. Any field added on one side without the other silently broke
 * runtime parsing — the kind of drift that hid the `timeout` →
 * `[object Object]ms` bug earlier today and that the audit flagged as
 * a maintenance hazard.
 *
 * Now the SDK is the single source of truth for the run-related shapes.
 * Dashboard-specific schemas (list response, cancel response, scheduler
 * state, log entries) stay defined here because they're transport-level
 * wrappers the SDK doesn't need.
 *
 * Consumers can keep importing `RunSchema`, `Run`, `RunState`,
 * `RunStage`, etc. from this module unchanged — the re-exports preserve
 * the dashboard's local names.
 */

import { z } from 'zod';
import {
    RunSchema as SdkRunSchema,
    StageSchema,
    RunStateSchema,
    type Run as SdkRun,
    type RunState,
    type Stage,
} from '@sapd/lumastra-plugin-sdk';

// HTTP responses deliberately exclude SDK-only error stacks.
export const RunSchema = SdkRunSchema.extend({
    error: SdkRunSchema.shape.error.unwrap().omit({ stack: true }).optional(),
});
export type Run = z.infer<typeof RunSchema>;

// ── SDK re-exports (single source of truth) ──────────────────────────
export { RunStateSchema };
export type { RunState };

// Local-name aliases for the SDK's StageSchema/Stage, preserving the
// dashboard's `RunStage*` naming that existing consumers import.
export const RunStageSchema = StageSchema;
export type RunStage = Stage;

/**
 * Admin-only display context resolved for a per-media run. It is deliberately
 * separate from the SDK Run contract: task input remains the authoritative,
 * generic payload while the runs API may attach a human-readable lookup.
 */
export const RunMediaItemSchema = z.object({
    id: z.string(),
    title: z.string(),
    fileName: z.string().optional(),
});
export type RunMediaItem = z.infer<typeof RunMediaItemSchema>;

export const RunWithMediaItemSchema = RunSchema.extend({
    mediaItem: RunMediaItemSchema.optional(),
});
// Display components also receive SDK runs from in-memory/SSR sources. Keep
// that richer local type while the HTTP schema above excludes error stacks.
export type RunWithMediaItem = SdkRun & { mediaItem?: RunMediaItem };

// ── Dashboard-only transport wrappers ────────────────────────────────

/**
 * GET /api/scheduler.
 *
 * The API client applies `toStrict()` to the TOP LEVEL, so every field the
 * endpoint actually returns has to be declared here — an undeclared one is a
 * reported mismatch, not a silent strip. `queuesPaused` and `queueStates` were
 * missing, which is why every load of /admin logged
 * `<root>: Unrecognized keys` (an `unrecognized_keys` issue carries an empty
 * path, which the client renders as `<root>`).
 */
export const SchedulerStateSchema = z.object({
    tasks: z
        .array(
            z.object({
                taskId: z.string(),
                // NULLISH, not optional: the server sends `null` (not a missing
                // key) for a task that has never fired, and `.optional()` accepts
                // only `undefined`. One never-fired task — `sample-task`, at index
                // 40 of 53 on prod — was enough to fail the whole response.
                lastFiredAt: z.string().datetime().nullish(),
                nextFireAt: z.string().datetime().nullish(),
                paused: z.boolean().optional(),
                pausedBy: z.string().nullish(),
                pausedAt: z.string().nullish(),
                schedule: z
                    .object({
                        every: z.string().optional(),
                        runOnStartup: z.boolean().optional(),
                    })
                    .optional(),
            }),
        )
        .optional(),
    queuesPaused: z.record(z.string(), z.boolean()).optional(),
    queueDepths: z
        .record(
            z.string(),
            z.object({
                waiting: z.number().optional(),
                active: z.number().optional(),
                delayed: z.number().optional(),
                paused: z.boolean().optional(),
            }),
        )
        .optional(),
    queueStates: z
        .record(
            z.string(),
            z.object({
                paused: z.boolean().optional(),
                reachable: z.boolean().optional(),
            }),
        )
        .optional(),
});

export type SchedulerState = z.infer<typeof SchedulerStateSchema>;

export const RunLogEntrySchema = z.object({
    ts: z.number(),
    seq: z.number(),
    level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
    msg: z.string(),
    runId: z.string().optional(),
    truncated: z.boolean().optional(),
    extra: z.unknown().optional(),
});

export type RunLogEntry = z.infer<typeof RunLogEntrySchema>;

// ── Route response schemas ────────────────────────────────────────────────────
// Single source of truth for admin-UI consumers calling /api/v1/runs/* via
// apiGet/apiPost(...Schema). Route handler returns must match these shapes.

/** GET /api/v1/runs — list runs with optional cursor pagination. */
export const RunListResponseSchema = z.object({
    items: z.array(RunWithMediaItemSchema),
    page: z.object({
        limit: z.number(),
        hasMore: z.boolean(),
        nextCursor: z.string().optional(),
    }),
});
export type RunListResponse = z.infer<typeof RunListResponseSchema>;

/** POST /api/v1/runs/[runId]/cancel — orchestrator cancel decision. */
export const CancelResponseSchema = z.object({
    accepted: z.boolean(),
    deferred: z.enum(['hard-kill']).optional(),
});
export type CancelResponse = z.infer<typeof CancelResponseSchema>;

/**
 * GET /runs/{id}/diagnostics — ADMIN-ONLY companion to GET /runs/{id}.
 *
 * `GET /runs/{id}` is reachable by any logged-in user (its `runs:read` scope is
 * granted by the coarse `read` alias), so it must keep stripping `error.stack`.
 * The stack lives here instead, behind `auth: {kind:'admin'}`.
 *
 * `redaction` carries the server-side roots the client needs to run
 * `formatTaskRunReport(..., 'github')` — the component must never hardcode them.
 */
export const RunDiagnosticsSchema = z.object({
    runId: z.string(),
    error: z
        .object({
            message: z.string(),
            kind: z.enum(['transient', 'permanent', 'fatal']).optional(),
            stack: z.string().optional(),
        })
        .nullable(),
    redaction: z.object({
        libraryRoots: z.array(z.string()),
        transcodeRoot: z.string().optional(),
    }),
});
export type RunDiagnostics = z.infer<typeof RunDiagnosticsSchema>;

// ── Grouped runs response (GET /api/v1/runs/groups) ─────────────────────

const RunStateCountsSchema = z.object({
    pending: z.number(),
    active: z.number(),
    cancelling: z.number(),
    completed: z.number(),
    failed: z.number(),
    cancelled: z.number(),
});

const LatestRunRefSchema = z.object({
    id: z.string(),
    state: z.string(),
    startedAt: z.string().datetime(),
});

export const RunGroupSchema = z.object({
    taskId: z.string(),
    name: z.string(),
    count: z.number().int().nonnegative(),
    stateCounts: RunStateCountsSchema,
    latestRun: LatestRunRefSchema,
    oldestActiveAt: z.string().datetime().nullable(),
});
export type RunGroup = z.infer<typeof RunGroupSchema>;

/** GET /api/v1/runs/groups — one row per task across the full history. */
export const RunGroupedResponseSchema = z.object({
    items: z.array(RunGroupSchema),
    page: z.object({
        limit: z.number(),
        offset: z.number(),
        hasMore: z.boolean(),
    }),
});
export type RunGroupedResponse = z.infer<typeof RunGroupedResponseSchema>;
