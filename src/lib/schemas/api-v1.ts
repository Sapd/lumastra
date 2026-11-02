// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { WEBHOOK_EVENT_TYPES } from '$lib/shared/webhook-events.js';
import { z } from 'zod';
import { TaskListResponseSchema } from './task-definition.schema.js';
import { RunListResponseSchema } from './run.schema.js';

export const RunRequestSchema = z.object({
    input: z.unknown().optional(),
    libraryGroupId: z.string().optional(),
    userId: z.string().optional(),
    priority: z.union([z.literal(1), z.literal(5), z.literal(7)]).optional(),
});

export const CancelRequestSchema = z.object({
    hard: z.boolean().optional(),
    reason: z.string().optional(),
});

/**
 * D5: canonical single-run cancel body — `force` replaces `hard`.
 * `hard` is kept as a fallback alias so existing clients still work during
 * the migration window; server merges them (force || hard).
 */
export const CancelRunRequestSchema = z.object({
    force: z.boolean().optional(),
    /** @deprecated use `force` — kept for migration compat */
    hard: z.boolean().optional(),
    // Capped at 255: `reason` is persisted verbatim to the Valkey run-state
    // hash + the audit_log JSONB, so an unbounded attacker-controlled blob is a
    // real cache/audit bloat surface. No legitimate caller sends more.
    reason: z.string().max(255).optional(),
});
export type CancelRunRequest = z.infer<typeof CancelRunRequestSchema>;

export const CancelByTaskRequestSchema = z.object({
    taskId: z.string().min(1),
});

/**
 * D5: `runs/cancel?byTask={id}` body — merges tasks/{id}/stop +
 * runs/cancel-by-task into one endpoint with `tasks:run` scope.
 * `force` triggers nuclearStop with hard-kill escalation path.
 * `reason` is recorded in the audit log.
 */
export const CancelByTaskBodySchema = z.object({
    force: z.boolean().optional(),
    reason: z.string().optional(),
});
export type CancelByTaskBody = z.infer<typeof CancelByTaskBodySchema>;

/**
 * D5: PUT tasks/{id}/state — unified task state control.
 *
 * The three independent switches (schedule pause, breaker, queue) are composed
 * into one idempotent PUT so a client can read the current aggregate, mutate
 * the fields they care about, and PUT back.
 *
 * Fields:
 *   schedule  — "paused" | "active"  (was POST pause/resume)
 *   breaker   — "enable" | "reset"   (was POST circuit-breaker/force-enable)
 *   force     — only meaningful when breaker="enable"; bypasses the cooldown
 *               TTL (was the sub-path /force-enable)
 */
export const TaskStateUpdateSchema = z.object({
    schedule: z.enum(['paused', 'active']).optional(),
    breaker: z.enum(['enable', 'reset']).optional(),
    force: z.boolean().optional(),
    reason: z.string().optional(),
});
export type TaskStateUpdate = z.infer<typeof TaskStateUpdateSchema>;

export const SettingsUpdateRequestSchema = z.object({
    values: z.record(z.string(), z.unknown()).optional(),
    secrets: z.record(z.string(), z.string()).optional(),
});

export const QueuePauseRequestSchema = z.object({
    reason: z.string().optional(),
});

export const HistoryTrimRequestSchema = z.object({
    olderThanDays: z.number().int().positive(),
});

export const HistoryTrimQuerySchema = z.object({
    olderThanDays: z.coerce.number().int().positive(),
});

export const WebhookCreateSchema = z.strictObject({
    url: z
        .string()
        .url()
        .refine(
            (s) => {
                try {
                    const u = new URL(s);
                    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
                    // Reject userinfo (https://user:pass@host) — credential
                    // leak risk at delivery time. assertPublicHttpUrl enforces
                    // the same gate at fetch time; surfacing it at schema parse
                    // means admins see the error at form submit instead of as
                    // a delivery failure later.
                    if (u.username || u.password) return false;
                    return true;
                } catch {
                    return false;
                }
            },
            {
                message: 'Webhook URL must use http(s) and may not embed user info',
            },
        ),
    secret: z.string().min(16),
    eventFilter: z
        .array(z.enum(WEBHOOK_EVENT_TYPES))
        .describe(
            'Event types from GET /webhooks/events. An empty array subscribes to all delivered types.',
        ),
    taskFilter: z.array(z.string()).optional(),
    libraryGroupIds: z.array(z.guid()).max(100).optional(),
    headers: z
        .record(
            z
                .string()
                .regex(
                    /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/,
                    'Header names must contain only RFC 7230 token characters',
                ),
            z.string().regex(/^[^\r\n]*$/, 'Header values cannot contain CRLF'),
        )
        .optional(),
    active: z.boolean().optional().default(true),
    includeProgress: z.boolean().optional().default(false),
    mediaTypeFilter: z.array(z.enum(['movie', 'series', 'episode', 'album'])).optional(),
    batchWindowSeconds: z.number().int().min(0).max(3600).optional(),
    maxBatchSize: z.number().int().min(1).max(100).optional(),
    /**
     * Display name users see when this hook receives their forwarded
     * notifications (`org.lumastra.user.notification`), e.g. "Telegram". Empty
     * string or null clears it; omitted on update keeps the stored one.
     */
    label: z.string().trim().max(80).nullable().optional(),
});

export const WebhookUpdateSchema = WebhookCreateSchema.partial({
    secret: true,
});

export const WebhookRowSchema = z.object({
    id: z.string(),
    url: z.string(),
    eventFilter: z.array(z.string()),
    taskFilter: z.array(z.string()).optional(),
    libraryGroupIds: z.array(z.guid()).max(100).optional(),
    headers: z
        .record(
            z
                .string()
                .regex(
                    /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/,
                    'Header names must contain only RFC 7230 token characters',
                ),
            z.string().regex(/^[^\r\n]*$/, 'Header values cannot contain CRLF'),
        )
        .optional(),
    active: z.boolean(),
    lastStatus: z
        .number()
        .int()
        .optional()
        .describe('HTTP status of the most recent completed attempt retained in the outbox'),
    lastError: z
        .string()
        .optional()
        .describe(
            'Redacted delivery failure reason; never contains upstream response bodies or credentials',
        ),
    lastDeliveredAt: z
        .string()
        .datetime()
        .optional()
        .describe('Most recent successful delivery retained in the outbox'),
    deadCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
            'Number of permanently failed deliveries since the most recent successful delivery, retained in the outbox',
        ),
    includeProgress: z.boolean(),
    mediaTypeFilter: z.array(z.string()).optional(),
    batchWindowSeconds: z.number().int(),
    maxBatchSize: z.number().int(),
    label: z.string().optional(),
    hasSecret: z.boolean(),
    createdBy: z.string(),
    createdAt: z.string().datetime(),
});

export const RotateSecretsSchema = z.object({
    /**
     * The master key currently used to encrypt rows. Must match the value
     * previously held in `LUMASTRA_MASTER_KEY`. Required so the rotation
     * works even when the env var has already been swapped to the new key.
     */
    oldMasterKey: z.string().min(32),
    newMasterKey: z.string().min(32),
    confirmation: z.literal('I_UNDERSTAND_THIS_RE_ENCRYPTS_ALL_SECRETS'),
});

// ── v1 GET response schemas ───────────────────────────────────────────────────
// Used with typedJson() for runtime response validation in dev mode.

/** GET /api/v1/tasks — task catalog with optional lane metrics. */
export const V1TasksResponseSchema = TaskListResponseSchema;
export type V1TasksResponse = z.infer<typeof V1TasksResponseSchema>;

/**
 * GET /api/v1/runs — paginated run list.
 *
 * `runs` was `z.array(z.unknown())`, which left the most-used runs endpoint
 * with no published item model at all: the generated spec described the array
 * as untyped, so a Swift client got AnyCodable where the sibling
 * GET /runs/{id} hands it a full Run. It also meant mount()'s response gate
 * could not see drift here — a fixture missing a required field sailed through
 * the list test and only failed on the detail endpoint.
 *
 * `RunWithMediaItemSchema` is exactly what the handler returns: orchestrator
 * runs (error.stack redacted) with the optional resolved `mediaItem` grafted
 * on. Verified against 379 stratified production rows — every (task_id, state)
 * pair plus every row carrying an error, costBreakdown, or stages — all of
 * which parse cleanly. This applies the same contract GET /runs/{id} has
 * always enforced on the same objects, including the live Valkey stage merge,
 * so it is not a new class of runtime risk.
 */
export const V1RunsResponseSchema = RunListResponseSchema;
export type V1RunsResponse = z.infer<typeof V1RunsResponseSchema>;

/**
 * GET|PUT /api/v1/tasks/{taskId}/state — unified three-switch state aggregate.
 * PATCH body shape is TaskStateUpdateSchema (see above).
 */
export const V1TaskStateResponseSchema = z.object({
    schedule: z
        .enum(['paused', 'active'])
        .describe('Schedule switch: whether the cron schedule is paused'),
    schedulePausedBy: z.string().optional().describe('User who paused the schedule'),
    schedulePausedAt: z.string().optional().describe('ISO timestamp when schedule was paused'),
    breaker: z.enum(['closed', 'open', 'half_open']).describe('Circuit-breaker state'),
    breakerAllowed: z.boolean().describe('Whether the breaker currently allows runs'),
    breakerNextProbeAt: z
        .string()
        .optional()
        .describe('ISO timestamp for next allowed probe (half_open/force-enable)'),
    breakerReason: z.string().optional().describe('Reason the breaker is open'),
    effective: z
        .enum(['paused', 'open', 'half_open', 'active'])
        .describe('Worst-of the two switches'),
    blocked: z.boolean().describe('True when either switch is blocking task execution'),
});
export type V1TaskStateResponse = z.infer<typeof V1TaskStateResponseSchema>;

/** GET /api/v1/scheduler — scheduler state with queue depths. */
export const V1SchedulerResponseSchema = z.object({
    tasks: z.array(z.unknown()),
    queuesPaused: z.record(z.string(), z.unknown()),
    queueDepths: z.record(z.string(), z.unknown()),
    queueStates: z.record(z.string(), z.unknown()).optional(),
});
export type V1SchedulerResponse = z.infer<typeof V1SchedulerResponseSchema>;

/** POST /api/v1/admin/secrets/rotate — rotation result. */
export const V1RotateSecretsResponseSchema = z.object({
    rotated: z.number(),
    skipped: z.number(),
    newVersion: z.number(),
    failedRows: z.array(z.object({ pluginId: z.string(), key: z.string() })),
    /**
     * Stores that could NOT be re-sealed under the new master key, with the
     * reason (security review 2026-09-12, C9). An operator must treat a
     * non-empty list as "do not swap LUMASTRA_MASTER_KEY yet": whatever is
     * listed here still opens only with the old key.
     *
     * Optional so a client written against the pre-C9 response keeps parsing.
     */
    notRotated: z
        .array(z.object({ store: z.string(), reason: z.string() }))
        .optional()
        .describe('Stores that could not be re-sealed under the new master key, with reasons'),
    /**
     * Per store, how many values this run upgraded from the old unbound
     * `enc:v1:` envelope to the row-bound `enc:v2:` one (security review
     * 2026-09-13, C19). Absent stores upgraded nothing.
     *
     * The operator needs to see this: the upgrade binds each value to whatever
     * row it was sitting in, so a value that had been transplanted into the
     * wrong row becomes permanently valid there. A non-zero count means the
     * security self-check should have been clean BEFORE this ran.
     *
     * Optional so a client written against the pre-C19 response keeps parsing.
     */
    legacyUpgraded: z
        .record(z.string(), z.number())
        .optional()
        .describe(
            'Per store, values upgraded from the unbound enc:v1 envelope to the row-bound enc:v2 one',
        ),
    warning: z.string().optional(),
});
export type V1RotateSecretsResponse = z.infer<typeof V1RotateSecretsResponseSchema>;

// ── Webhook route response schemas ────────────────────────────────────────────
// Single source of truth for admin-UI consumers calling /api/v1/webhooks/*.

/** GET /api/v1/webhooks — paginated webhook list. */
export const WebhooksListResponseSchema = z.object({
    items: z.array(WebhookRowSchema),
    page: z.object({
        limit: z.number().int(),
        offset: z.number().int().optional(),
        hasMore: z.boolean(),
        total: z.number().int().optional(),
    }),
});
export type WebhooksListResponse = z.infer<typeof WebhooksListResponseSchema>;

/** POST /api/v1/webhooks or PUT /api/v1/webhooks/[id] — just returns the id. */
export const WebhookIdResponseSchema = z.object({
    id: z.string(),
});
export type WebhookIdResponse = z.infer<typeof WebhookIdResponseSchema>;

/** DELETE /api/v1/webhooks/[id] — returns the deleted id. */
export const WebhookDeleteResponseSchema = z.object({
    deleted: z.string(),
});
export type WebhookDeleteResponse = z.infer<typeof WebhookDeleteResponseSchema>;

export const LibraryScanRequestSchema = z.object({
    libraryPathId: z
        .string()
        .guid()
        .optional()
        .describe('Scope the scan to one library path; omit to scan all enabled paths'),
});

const ChangeEntrySchema = z
    .object({
        path: z
            .string()
            .min(1)
            .optional()
            .describe('Path relative to the library root (requires top-level libraryPathId)'),
        sourceUri: z
            .string()
            .min(1)
            .optional()
            .describe('Full object-store URI; resolved via the library path source_prefix'),
        op: z.enum(['upsert', 'remove']).describe('upsert = added/modified; remove = deleted'),
    })
    .refine((e) => (e.path ? !e.sourceUri : !!e.sourceUri), {
        message: 'each change needs exactly one of path | sourceUri',
    });

export const LibraryIngestRequestSchema = z
    .object({
        libraryPathId: z
            .string()
            .guid()
            .optional()
            .describe('Required when entries use path; omitted when entries use sourceUri'),
        changes: z
            .array(ChangeEntrySchema)
            .min(1)
            .max(5000)
            .describe(
                "The delta. Max 5000 entries — chunk larger deltas, keeping a rename's upsert+remove together",
            ),
    })
    .describe('Push a known set of file changes for ingest without walking the library');
