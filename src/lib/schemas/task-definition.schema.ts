// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { PageBlockSchema } from './pagination.js';

// ── Task definition summary ───────────────────────────────────────────────────
// Mirrors the shape returned by GET /api/v1/tasks and GET /api/v1/tasks/[taskId].

export const TaskScheduleSchema = z.object({
    every: z.string(),
    runOnStartup: z.boolean().optional(),
    envOverride: z.string().optional(),
});

export const TaskRetrySchema = z.object({
    attempts: z.number().int().nonnegative(),
    backoff: z.union([z.literal('exponential'), z.array(z.number())]),
});

export const TaskPipelineSchema = z.object({
    of: z.string(),
    after: z.array(z.string()).optional(),
    /**
     * True when the task has a `pipeline.when` predicate. The predicate itself
     * is a function — not JSON-serialisable — so the API surfaces only its
     * presence. Used by the admin pipeline visualiser to render a
     * "conditional stage" marker.
     */
    hasWhen: z.boolean(),
});

export const TaskSettingsFieldSchema = z.object({
    key: z.string(),
    label: z.string(),
    type: z.string(),
    description: z.string().optional(),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
    /**
     * Optional input validation hints declared by the plugin SDK's
     * `SettingField.validation`. Passed through from the API so the UI can
     * render min/max constraints on number inputs and pattern hints.
     */
    validation: z
        .object({
            min: z.number().optional(),
            max: z.number().optional(),
            pattern: z.string().optional(),
        })
        .optional(),
    /** Fine-tuning knob; the admin UI folds it under "Advanced". */
    advanced: z.boolean().optional(),
});

export const TaskSettingsSchema = z.object({
    canToggle: z.literal(false),
    fields: z.array(TaskSettingsFieldSchema),
});

export const StaleEdgeAlertSchema = z.object({
    upstreamId: z.string(),
    downstreamId: z.string(),
    upstreamCompletedAt: z.string(),
    downstreamCompletedAt: z.string().nullable(),
    staleByMs: z.number(),
});

export type StaleEdgeAlert = z.infer<typeof StaleEdgeAlertSchema>;

export const TaskLaneSchema = z.enum(['active', 'pending', 'failed', 'healthy']);
export const CircuitStateSchema = z.enum(['closed', 'open', 'half_open']);

/**
 * Admin-facing purpose group for the /admin/tasks catalog (admin IA
 * redesign spec §3.3). Mirrors the SDK's `TaskDefinition.purpose`.
 * `undefined` ⇒ the UI buckets the task under Maintenance.
 */
export const TaskPurposeSchema = z.enum([
    'library',
    'music-ai',
    'livetv',
    'watch-sync',
    'maintenance',
    'repair',
]);

export type TaskPurpose = z.infer<typeof TaskPurposeSchema>;

export type TaskLane = z.infer<typeof TaskLaneSchema>;
export type CircuitState = z.infer<typeof CircuitStateSchema>;

export const TaskLaneSummarySchema = z.object({
    activeCount: z.number().int().nonnegative(),
    pendingItems: z.number().int().nonnegative(),
    failedLast24h: z.number().int().nonnegative(),
});

export type TaskLaneSummary = z.infer<typeof TaskLaneSummarySchema>;

// ── Task triggers (spec 2026-09-27 Part 2) ─────────────────────────────────
//
// Jellyfin-style triggers an operator sets per task: every N minutes/hours,
// daily at HH:MM, weekly on a day at HH:MM, or when the server starts. No
// triggers stored ⇒ the task's declared schedule applies. Times are in the
// server's own time zone (the container's TZ), which the API reports.
//
// One FLAT object with a `kind` discriminator rather than a zod union: the
// OpenAPI spec feeds Swift codegen, which handles a plain object with
// optional fields but not `oneOf`.

export const TaskTriggerKindSchema = z.enum(['interval', 'daily', 'weekly', 'startup']);
export type TaskTriggerKind = z.infer<typeof TaskTriggerKindSchema>;

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

export const TaskTriggerSchema = z
    .object({
        kind: TaskTriggerKindSchema.describe('What fires the task.'),
        every: z
            .string()
            .optional()
            .describe("Interval triggers: a duration such as '30m', '6h' or '1d'."),
        at: z
            .string()
            .regex(TIME_OF_DAY)
            .optional()
            .describe("Daily and weekly triggers: time of day, 24-hour 'HH:MM', server time zone."),
        weekday: z
            .number()
            .int()
            .min(0)
            .max(6)
            .optional()
            .describe('Weekly triggers: day of the week, 0 = Sunday … 6 = Saturday.'),
    })
    .superRefine((t, ctx) => {
        const need = (field: 'every' | 'at' | 'weekday', ok: boolean): void => {
            if (!ok)
                ctx.addIssue({ code: 'custom', path: [field], message: `required for ${t.kind}` });
        };
        const forbid = (field: 'every' | 'at' | 'weekday'): void => {
            if (t[field] !== undefined) {
                ctx.addIssue({ code: 'custom', path: [field], message: `not used by ${t.kind}` });
            }
        };
        // Each kind carries exactly its own fields — a daily trigger with a
        // stray `every` is refused, not silently stored (the DB checks agree).
        if (t.kind === 'interval') need('every', typeof t.every === 'string');
        else forbid('every');
        if (t.kind === 'daily' || t.kind === 'weekly') need('at', typeof t.at === 'string');
        else forbid('at');
        if (t.kind === 'weekly') need('weekday', typeof t.weekday === 'number');
        else forbid('weekday');
    });
export type TaskTrigger = z.infer<typeof TaskTriggerSchema>;

/** GET /api/v1/tasks/{id}/triggers — the triggers in effect and what they mean. */
export const TaskTriggersResponseSchema = z.object({
    /** False for tasks without a schedule of their own — see `reason`. */
    schedulable: z.boolean(),
    reason: z.string().optional(),
    /** True when no operator triggers are stored and the declared schedule applies. */
    isDefault: z.boolean(),
    /** The triggers in effect — the declared schedule as one interval trigger when `isDefault`. */
    triggers: z.array(TaskTriggerSchema),
    /** The plugin's declared cadence (`schedule.every`). */
    declaredEvery: z.string().optional(),
    /** `schedule.envOverride` env var name, when declared. */
    envOverrideVar: z.string().optional(),
    /** Whether that env var currently holds a valid duration (it is ignored while triggers are set). */
    envOverrideActive: z.boolean().optional(),
    /** Shortest interval an interval trigger may use for this task. */
    minEvery: z.string().optional(),
    /** IANA time zone daily/weekly triggers are evaluated in (the server's TZ). */
    timeZone: z.string(),
    /** Next scheduled start, ISO-8601; null when paused or when only a startup trigger is set. */
    nextRunAt: z.string().nullable().optional(),
    paused: z.boolean(),
    updatedBy: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
});
export type TaskTriggersResponse = z.infer<typeof TaskTriggersResponseSchema>;

/** PUT /api/v1/tasks/{id}/triggers body — replaces every trigger of the task. */
export const TaskTriggersUpdateSchema = z.object({
    triggers: z.array(TaskTriggerSchema).min(1).max(8),
});
export type TaskTriggersUpdate = z.infer<typeof TaskTriggersUpdateSchema>;

export const TaskDefinitionSummarySchema = z.object({
    id: z.string(),
    name: z.string(),
    /**
     * Optional admin-facing description from the plugin SDK's
     * `TaskDefinition.description`. Surfaced under the task name in
     * /admin/tasks so operators can read manifest-level notes (e.g.
     * processing-version bump warnings) without opening source.
     */
    description: z.string().optional(),
    /**
     * Optional longer-form operator notes from `TaskDefinition.notes`
     * (admin IA redesign spec §3.3/§8: "task-descriptions" step) — incident
     * context, caveats, one-shot-repair background. Rendered ONLY on the
     * task detail's Definition tab (Developer-only), never on the catalog
     * card or the `confirmBeforeRun` dialog.
     */
    notes: z.string().optional(),
    version: z.string(),
    processingVersion: z.number().int().nonnegative(),
    resourceClass: z.string(),
    /** Id of the external plugin that contributed this task; absent for built-in tasks. */
    pluginId: z.string().optional(),
    schedule: TaskScheduleSchema.optional(),
    capabilities: z.object({
        database: z.boolean().optional(),
        http: z.boolean().optional(),
        ffmpeg: z.boolean().optional(),
        cache: z.boolean().optional(),
        dataDir: z.boolean().optional(),
        allowedDomains: z.array(z.string()).optional(),
    }),
    scope: z.enum(['global', 'libraryGroup', 'user']).optional(),
    retry: TaskRetrySchema.optional(),
    backpressure: z
        .object({
            onQueueDepthOver: z.number(),
            action: z.enum(['drop', 'fail-fast', 'shed-oldest']),
        })
        .optional(),
    backlog: z.object({ unitLabel: z.string() }).optional(),
    quotas: z
        .object({
            maxRunsPerDay: z.number().optional(),
            maxRunsPerTenant: z.number().optional(),
            maxConcurrent: z.number().optional(),
            costBudgetMonthly: z.number().optional(),
        })
        .optional(),
    retention: z
        .object({
            policy: z.enum(['standard', 'audit', 'forensic', 'ephemeral']),
            days: z.number().optional(),
        })
        .optional(),
    /**
     * Duration strings from the SDK's `TaskTimeout` contract — e.g.
     * `{ hard: '60s', soft: '50s' }`. Stored as parseable strings rather
     * than millisecond numbers so the UI doesn't have to format ms.
     */
    timeout: z.object({ hard: z.string(), soft: z.string() }).optional(),
    /**
     * True when the task is an SDK tutorial exemplar. The API filters
     * demos out of the list response when NODE_ENV === 'production', so
     * end users don't see fake jobs alongside real ones in /admin/tasks.
     * Dev / CI / local builds still see them as runnable references.
     */
    demo: z.boolean().optional(),
    /** Admin-facing purpose group (spec §3.3) — see `TaskPurposeSchema`. */
    purpose: TaskPurposeSchema.optional(),
    /**
     * `'system'` = internal machinery, hidden from the admin task list behind
     * a toggle (still shown when it has a problem). Always sent by the task
     * list; absent from older servers, which the UI treats as `'user'`.
     */
    visibility: z.enum(['user', 'system']),
    /**
     * When true, the admin UI's "Run" button shows a confirmation dialog
     * (with the task's one-line description) before triggering a manual run.
     */
    confirmBeforeRun: z.boolean().optional(),
    /**
     * True for registry-only stub tasks (e.g. a watch-sync provider's
     * auto-synthesized push/pull entries) whose `execute()` always throws
     * because an engine drives the real work directly. The admin UI
     * disables the "Run" button rather than let an operator trigger a
     * guaranteed failure.
     */
    notManuallyRunnable: z.boolean().optional(),
    /**
     * True when the task honours `{ mode: 'manual' }` to drain its whole
     * backlog in one run rather than the single batch a scheduled `catchup`
     * cycle does. Drives the admin card's "Full run" action.
     */
    supportsFullRun: z.boolean().optional(),
    /**
     * True when the task honours `{ mode: 'force' }` to discard what it
     * previously produced and rebuild it, rather than only processing what it
     * has not reached yet. Requires an `onWipe` hook — without one the drain
     * degrades to a plain manual run. Drives the destructive option in the
     * admin card's run-scope dialog.
     */
    supportsForceRun: z.boolean().optional(),
    /**
     * True when the task implements the `failures.retry` hook, i.e.
     * `POST /tasks/{id}/failures/{itemId}/retry` will do something rather than
     * 400 with "does not support per-item retry". Drives the Retry action on
     * each row of the task dashboard's Failures tab.
     *
     * Derived from the contract, not declared by the task. The dashboard used
     * to gate the button on `capabilities['per-item-retry'] === true`, a key
     * that is not part of the `capabilities` shape and that therefore no task
     * could set — so the button rendered for nothing, and a task that DID
     * implement `failures.retry` had no reachable UI for it.
     */
    supportsPerItemRetry: z.boolean(),
    /**
     * True when a manual run of this task deletes existing data as part of
     * its normal operation (e.g. wiping AI embeddings before re-queueing
     * them). Drives the red/danger "Run" button variant + warning tooltip
     * on the catalog card and the task dashboard's "Run now" action.
     */
    destructive: z.boolean().optional(),
    /**
     * Cross-time concurrency mutex declared by the SDK
     * (`TaskDefinition.exclusiveWith`). NOT a list of conflicting task ids —
     * it is a single `{ scope, ttl }` descriptor. The API passes the SDK value
     * through verbatim, so this must mirror the SDK shape or the client's
     * response validation fails with `exclusiveWith: Invalid input`.
     */
    exclusiveWith: z
        .object({
            scope: z.enum(['global', 'libraryGroup', 'user']),
            ttl: z.string(),
        })
        .optional(),
    pipeline: TaskPipelineSchema.optional(),
    settings: TaskSettingsSchema.optional(),
    lane: TaskLaneSchema.optional(),
    staleUpstreams: z.array(StaleEdgeAlertSchema).optional(),
    activeCount: z.number().int().nonnegative().optional(),
    observedActiveCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
            'Live worker admissions observed among a bounded sample; zero is not proof that all recorded runs are waiting',
        ),
    lastStartedAt: z.string().nullable().optional(),
    lastCompletedAt: z.string().nullable().optional(),
    backlogRemaining: z.number().int().nonnegative().optional(),
    recentFailCount: z.number().int().nonnegative().optional(),
    circuitState: CircuitStateSchema.optional(),
    /**
     * True when `scheduler_state.paused` is set for this task — an operator
     * (or an attention action) has stopped it from firing on its own
     * schedule. Plumbed alongside `circuitState` because the two are
     * independent switches: the breaker trips itself after repeated
     * failures, this one is a deliberate human decision.
     *
     * NOTE ON SEMANTICS: this stops SCHEDULED runs only. `scheduler.ts` is
     * the sole reader of the flag; `POST /tasks/{id}/run` never consults it,
     * so a manual run still starts while paused. UI copy must not claim
     * otherwise.
     *
     * Absent (rather than `false`) when the task database is unreachable —
     * same convention as the lane fields, so the UI can tell "not paused"
     * apart from "unknown".
     */
    schedulePaused: z.boolean().optional(),
    /** User id that paused the task, from `scheduler_state.paused_by`. */
    schedulePausedBy: z.string().nullable().optional(),
    /** ISO timestamp of the pause, from `scheduler_state.paused_at`. */
    schedulePausedAt: z.string().nullable().optional(),
    /**
     * When the scheduler will next start this task, from
     * `scheduler_state.next_fire_at` (ISO). `null` while the schedule is
     * paused or the task has no scheduler row yet; absent when the task
     * database was unreachable — same "absent means unknown" convention as
     * `schedulePaused`. The admin catalog's "Next run" column reads it.
     */
    nextRunAt: z.string().nullable().optional(),
    /** Duration of the most recent terminal run in the last 7 days (ms); null when none. */
    lastDurationMs: z.number().nullable().optional(),
    /**
     * The operator-set cadence override (admin UI's per-task schedule
     * control, `PUT /api/v1/tasks/{taskId}/triggers` — see
     * `TaskTriggersResponseSchema` above), when one is set. Absent
     * when the task has never had an override, OR when the task database
     * was unreachable — same "absent means unknown" convention as
     * `schedulePaused`.
     */
    scheduleOverride: z
        .object({
            preset: z.string(),
            every: z.string(),
            updatedBy: z.string().nullable().optional(),
            updatedAt: z.string().nullable().optional(),
        })
        .optional(),
    /**
     * The interval ACTUALLY driving the scheduler right now — `scheduleOverride.every`
     * when set, else `schedule.envOverride`'s resolved value when active, else
     * `schedule.every`. Every render site that shows a task's cadence MUST
     * prefer this over `schedule.every`, which only ever reflects the
     * plugin's DECLARED default and silently disagrees with reality once an
     * override is set. Absent when the task has no `schedule` at all, or
     * when the task database was unreachable.
     */
    effectiveEvery: z.string().optional(),
    /**
     * Operator-set triggers (spec 2026-09-27 Part 2), when any are stored —
     * they replace the declared schedule. Absent means the declared schedule
     * (or its env override) applies, or the task database was unreachable.
     */
    triggers: z.array(TaskTriggerSchema).optional(),
    /**
     * Stage ids this task covers (from `TaskDefinition.coversStages[].id`).
     * Lets the UI sum `media_item_stage_state` pending counts across all
     * stages a task owns and show "+N in backlog" on lane cards.
     */
    coveredStageIds: z.array(z.string()).optional(),
    /**
     * Items processed per hour over the last 1h window, summed from
     * `task_history.result->>'itemsProcessed'` on completed runs.
     * `null` when the task hasn't completed a run in the window or
     * its runs don't report itemsProcessed. Lane cards combine this
     * with `coverageBacklog` to render a "~Nh to drain" ETA.
     */
    itemsPerHour: z.number().nullable().optional(),
    /**
     * Truncated `error.message` from the most recent failed run in
     * the last 24h. Same window + boot-recovery exclusion as
     * `recentFailCount`. Powers the "⚠ last: <message>" hint on
     * idle-but-failing lane cards.
     */
    lastFailedError: z.string().nullable().optional(),
    /**
     * From `TaskDefinition.taskPriority`. Default ranks at 5 (per
     * `priorityFromTrigger` in orchestrator). Values > 5 mean the task
     * is intentionally deprioritized — used by the lane card to
     * distinguish "starved by design (working as configured)" from
     * "starved by accident (should investigate)."
     */
    taskPriority: z
        .union([z.literal(1), z.literal(2), z.literal(3), z.literal(5), z.literal(7)])
        .optional(),
});

export type TaskDefinitionSummary = z.infer<typeof TaskDefinitionSummarySchema>;
export type TaskSettingsField = z.infer<typeof TaskSettingsFieldSchema>;

// ── Backlog response ──────────────────────────────────────────────────────────

export const BacklogStageSchema = z.object({
    id: z.string(),
    label: z.string(),
    count: z.number().int().optional(),
});

// ── Failures response ─────────────────────────────────────────────────────────

export const FailureItemSchema = z.object({
    id: z.string(),
    itemId: z.string(),
    runId: z.string().optional(),
    reason: z.string().optional(),
    meta: z.unknown().optional(),
    occurredAt: z.union([z.string(), z.date()]),
    /**
     * Human-readable title for `itemId`, resolved server-side from
     * `media_items` (directly, or via `media_files` for plugins that key
     * failures on a file id). Absent when the id could not be resolved
     * (item deleted, unrecognized id shape) — callers should fall back to
     * `itemId`.
     */
    title: z.string().optional(),
    /**
     * Number of unresolved failure events recorded for this item — this row
     * represents only the MOST RECENT one. `plugin_failure_events` is an
     * append-only log, so an item that fails on every periodic run
     * accumulates one row per attempt; the list groups those down to one row
     * per item and surfaces the rest as this count rather than dropping them.
     */
    failureCount: z.number().int().min(1).optional(),
});

export type FailureItem = z.infer<typeof FailureItemSchema>;

/** One event in a single item's failure history — see `FailureTimelineResponseSchema`. */
export const FailureTimelineEventSchema = z.object({
    processingVersion: z
        .number()
        .int()
        .optional()
        .describe(
            'Detector processing version of this invocation; absent on historical unverified evidence.',
        ),
    fileId: z.string().optional().describe('Selected physical file when the failure was recorded.'),
    inputIdentity: z
        .string()
        .optional()
        .describe('Content and logical window of the failing input; legacy rows have no identity.'),
    inputScope: z
        .enum(['current', 'earlier', 'unverified'])
        .optional()
        .describe('Relationship of retained evidence to the currently selected input.'),
    id: z.string(),
    reason: z.string().optional(),
    occurredAt: z.union([z.string(), z.date()]),
    runId: z.string().optional(),
});
export type FailureTimelineEvent = z.infer<typeof FailureTimelineEventSchema>;

// ── Route response schemas ────────────────────────────────────────────────────
// Single source of truth for admin-UI consumers calling /api/v1/tasks/* via
// apiGet/apiPost(...Schema). Route handlers return shapes that must match
// these — see CI conformance check (planned) for enforcement.

/** Generic "operation succeeded" response — used by PUT/POST endpoints with no payload. */
export const OkResponseSchema = z.object({
    ok: z.literal(true),
});
export type OkResponse = z.infer<typeof OkResponseSchema>;

/**
 * Summary aggregate used by GET /api/v1/tasks. Shape matches
 * `TaskLaneSummary` produced by `summarizeLanes()` in
 * `src/lib/server/tasks/lane-data.ts`.
 */
export const TaskLaneSummarySchemaResponse = z.object({
    activeCount: z.number().int().nonnegative(),
    pendingItems: z.number().int().nonnegative(),
    failedLast24h: z.number().int().nonnegative(),
});

/**
 * One captured failure during loadBuiltins(). Surfaced via /api/v1/tasks
 * so the admin UI shows a banner — silent disappearance of a task
 * because its module threw at boot is otherwise only visible in
 * container logs.
 */
export const BuiltinRegistrationErrorSchema = z.object({
    name: z.string(),
    message: z.string(),
    kind: z.enum([
        'task',
        'provider',
        'trickplay-provider',
        'media-source',
        'external-service',
        'feature',
        'integration',
        'watch-sync',
    ]),
    timestamp: z.string(),
});
export type BuiltinRegistrationError = z.infer<typeof BuiltinRegistrationErrorSchema>;

/** GET /api/v1/tasks — task catalog with lane summary. */
export const TaskListResponseSchema = z.object({
    items: z.array(TaskDefinitionSummarySchema),
    page: PageBlockSchema,
    summary: TaskLaneSummarySchemaResponse.optional(),
    registrationErrors: z.array(BuiltinRegistrationErrorSchema).optional(),
});
export type TaskListResponse = z.infer<typeof TaskListResponseSchema>;

/**
 * POST /api/v1/tasks/[taskId]/run — manual trigger response. Shape matches
 * `StartRunResult` returned by `orchestrator.startRun()`. `deduped: true`
 * with `existingRunId` set indicates the request collapsed into a run that
 * was already active under the same identity SETNX key.
 */
export const RunTriggerResponseSchema = z.object({
    runId: z.string(),
    deduped: z.boolean().optional(),
    existingRunId: z.string().optional(),
});
export type RunTriggerResponse = z.infer<typeof RunTriggerResponseSchema>;

/**
 * GET /api/v1/tasks/[taskId]/backlog — drain stage counts + admin metadata.
 * `unitLabel` is the plugin-declared item name (e.g. "files", "episodes").
 * `message` carries human-readable status when stages are empty
 * (e.g. "database unavailable", "backlog completed").
 */
export const BacklogResponseSchema = z.object({
    unitLabel: z.string().optional(),
    stages: z.array(BacklogStageSchema),
    remainingHint: z.number().int().nonnegative().optional(),
    message: z.string().optional(),
});
export type BacklogResponse = z.infer<typeof BacklogResponseSchema>;

/** GET /api/v1/tasks/[taskId]/failures — paginated failures list. */
export const FailuresResponseSchema = z.object({
    items: z.array(FailureItemSchema),
    page: PageBlockSchema.extend({ total: z.number().int().nonnegative() }),
});
export type FailuresResponse = z.infer<typeof FailuresResponseSchema>;

/**
 * GET /api/v1/tasks/[taskId]/failures/[itemId]/history — chronological
 * failure history for one item, oldest first, capped at 200 events.
 * `reason` in each event is already redacted server-side (secrets +
 * absolute media paths) — the response deliberately does NOT carry the
 * configured library roots, since this endpoint is only `tasks:read`-gated
 * (any self-service PAT), not `library:admin`-gated. `truncated: true`
 * means older events beyond the 200 returned were dropped.
 */
export const FailureTimelineResponseSchema = z.object({
    pluginId: z.string(),
    itemId: z.string(),
    events: z.array(FailureTimelineEventSchema),
    truncated: z.boolean(),
});
export type FailureTimelineResponse = z.infer<typeof FailureTimelineResponseSchema>;

/**
 * POST /api/v1/tasks/[taskId]/circuit-breaker/force-enable — override-until
 * ISO timestamp. `null` indicates the override was cleared (rare; usually
 * the response always carries a fresh date string).
 */
export const CircuitForceEnableResponseSchema = z.object({
    overrideUntil: z.string().nullable(),
});
export type CircuitForceEnableResponse = z.infer<typeof CircuitForceEnableResponseSchema>;

/**
 * GET /api/v1/tasks/[taskId]/settings — current values + list of secret-keyed
 * fields (values themselves are never returned). `secrets` is an array of
 * field keys that have an encrypted value in `plugin_secrets`.
 */
export const TaskSettingsResponseSchema = z.object({
    fields: z.array(TaskSettingsFieldSchema),
    values: z.record(z.string(), z.unknown()),
    secrets: z.array(z.string()),
});
export type TaskSettingsResponse = z.infer<typeof TaskSettingsResponseSchema>;

// ── Schedule preset read projection ───────────────────────────────────────────
//
// Fixed interval names describe the catalog's scheduleOverride projection.
// Cadence writes use triggers; pausing uses state and preserves the triggers.
/** Duration strings used to label fixed-interval cadence projections. */
export const TASK_SCHEDULE_PRESET_DURATIONS: Record<
    'hourly' | 'every6h' | 'daily' | 'weekly',
    string
> = {
    hourly: '1h',
    every6h: '6h',
    daily: '24h',
    weekly: '7d',
};
