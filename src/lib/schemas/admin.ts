// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zod schemas for admin API routes
 *
 * Covers cache management, tasks, devices, plugins, and debug endpoints
 */

import { z } from 'zod';
import { LIBRARY_GROUP_NAME_MAX_LENGTH } from '$lib/shared/library-group-limits.js';
import {
    nonEmptyStringSchema,
    optionalStringSchema,
    mediaTypeSchema,
    LIBRARY_PATH_PROVIDERS,
    REMOTE_LIBRARY_PROVIDER_NAMES,
} from './common';

// ============================================================================
// Cache Management
// ============================================================================

/**
 * Query params for cache clear endpoint
 * Namespace is optional - if not provided, all caches are cleared
 */
export const clearCacheQuerySchema = z.object({
    namespace: optionalStringSchema,
});

export type ClearCacheQuery = z.infer<typeof clearCacheQuerySchema>;

/**
 * Body for cache warming endpoint
 */
export const cacheWarmingBodySchema = z.object({
    type: z.enum(['full', 'frequent', 'regular']).default('full'),
});

export type CacheWarmingBody = z.infer<typeof cacheWarmingBodySchema>;

// ============================================================================
// Task Management
// ============================================================================

/**
 * Valid task type — any non-empty string.
 * Authoritative validation happens via JOB_TO_QUEUE lookup at runtime,
 * so the schema only enforces presence, not an exhaustive enum.
 */
export const taskTypeSchema = nonEmptyStringSchema;

export type TaskType = z.infer<typeof taskTypeSchema>;

/**
 * Path params for task endpoints
 */
export const taskTypeParamsSchema = z.object({
    taskType: taskTypeSchema,
});

export type TaskTypeParams = z.infer<typeof taskTypeParamsSchema>;

// ============================================================================
// Debug Endpoints
// ============================================================================

/**
 * Path params for Jellyseerr debug endpoint
 */
export const jellyseerrDebugParamsSchema = z.object({
    // Jellyseerr API uses TMDB IDs natively — this param is intentionally TMDB-specific
    tmdbId: z.string(),
});

export type JellyseerrDebugParams = z.infer<typeof jellyseerrDebugParamsSchema>;

/**
 * Query params for Jellyseerr debug endpoint
 */
export const jellyseerrDebugQuerySchema = z.object({
    mediaType: mediaTypeSchema,
});

export type JellyseerrDebugQuery = z.infer<typeof jellyseerrDebugQuerySchema>;

/**
 * Query params for Radarr lookup endpoint
 */
export const radarrLookupQuerySchema = z.object({
    // Radarr API uses TMDB IDs natively — this param is intentionally TMDB-specific
    tmdbId: z.string(),
});

export type RadarrLookupQuery = z.infer<typeof radarrLookupQuerySchema>;

/**
 * Query params for Sonarr lookup endpoint
 */
export const sonarrLookupQuerySchema = z.object({
    tvdbId: z.coerce.number().int().positive(),
});

export type SonarrLookupQuery = z.infer<typeof sonarrLookupQuerySchema>;

// ============================================================================
// Device Management
// ============================================================================

/**
 * Query params for listing devices
 */
export const adminDeviceListQuerySchema = z.object({
    userId: z.string().uuid(),
});

export type AdminDeviceListQuery = z.infer<typeof adminDeviceListQuerySchema>;

/**
 * Query params for revoking a device
 */
export const adminDeviceRevokeQuerySchema = z.object({
    userId: z.string().uuid(),
    deviceSessionId: nonEmptyStringSchema,
});

export type AdminDeviceRevokeQuery = z.infer<typeof adminDeviceRevokeQuerySchema>;

// ============================================================================
// Personal Access Tokens (PATs)
// ============================================================================

/**
 * Valid PAT scopes.
 *
 * - 'read' / 'write' / 'admin': general API scopes (cumulative; admin implies all).
 * - 'jellyfin_compat': exclusive scope for /j/* clients with full read+write access.
 * - 'jellyfin_compat_read': exclusive scope for read-only third-party clients
 *   (jellyfin-rpc2, Tautulli, Discord RPC). Cannot mutate state — write methods
 *   on /j/* are rejected with 403.
 *
 * The two `jellyfin_compat*` scopes are mutually exclusive with everything else
 * (and with each other) — see patCreateBodySchema.superRefine.
 */
export const patScopeSchema = z
    .enum(['read', 'write', 'admin', 'jellyfin_compat', 'jellyfin_compat_read'])
    .describe(
        'PAT scope. read/write/admin are general; jellyfin_compat (read+write) and jellyfin_compat_read (read-only) gate /j/* access and are exclusive — cannot be combined with any other scope.',
    );

export type PatScope = z.infer<typeof patScopeSchema>;

/**
 * Query params for listing PATs
 */
export const patListQuerySchema = z.object({
    userId: z.string().uuid().optional(),
    scope: patScopeSchema.optional(),
});

export type PatListQuery = z.infer<typeof patListQuerySchema>;

/**
 * Body for creating a PAT
 */
export const patCreateBodySchema = z.object({
    userId: z.string().uuid(),
    name: nonEmptyStringSchema.pipe(z.string().max(255)),
    description: z.string().max(1000).optional(),
    scopes: z
        .array(z.string())
        .min(1)
        .default(['read'])
        .transform((arr) => arr.map((s) => s.trim().toLowerCase() as PatScope))
        .pipe(z.array(patScopeSchema))
        .superRefine((arr, ctx) => {
            if (arr.includes('jellyfin_compat') && arr.length !== 1) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: "'jellyfin_compat' is exclusive — must be the only scope",
                });
            }
            if (arr.includes('jellyfin_compat_read') && arr.length !== 1) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: "'jellyfin_compat_read' is exclusive — must be the only scope",
                });
            }
        }),
    expiresInDays: z.number().int().positive().nullish(),
});

export type PatCreateBody = z.infer<typeof patCreateBodySchema>;

/**
 * Query params for revoking a PAT
 */
export const patRevokeQuerySchema = z.object({
    id: z.coerce.number().int().positive().max(2147483647),
});

export type PatRevokeQuery = z.infer<typeof patRevokeQuerySchema>;

// ============================================================================
// Playback Quality
// ============================================================================

/**
 * Shared clamped `days` window for ALL playback-quality routes (overview +
 * per-user/per-device drill-down sub-routes) (L8). Coerced from the query
 * string and clamped to 1–365 with a default of 7. Sub-routes MUST reuse this
 * instead of re-rolling the clamp so the window bounds stay consistent.
 */
export const playbackQualityDaysSchema = z.coerce.number().int().min(1).max(365).default(7);

/**
 * Query params for playback quality stats (overview + drill-down sub-routes).
 */
export const playbackQualityQuerySchema = z.object({
    days: playbackQualityDaysSchema,
});

export type PlaybackQualityQuery = z.infer<typeof playbackQualityQuerySchema>;

// ============================================================================
// Plugin Management
// ============================================================================

/**
 * Path params for plugin endpoints
 */
export const pluginIdParamsSchema = z.object({
    pluginId: nonEmptyStringSchema,
});

export type PluginIdParams = z.infer<typeof pluginIdParamsSchema>;

/**
 * Allowed task/plugin execution modes.
 * Single source of truth — start-modes.ts derives ALLOWED_MODES from
 * allowedModeSchema.options so there is only one declaration.
 */
export const allowedModeSchema = z.enum(['manual', 'force', 'catchup']);
export type AllowedMode = z.infer<typeof allowedModeSchema>;

/**
 * Allowed triggeredBy filter categories for task history.
 * Using an enum instead of a LIKE prefix match prevents pathological
 * backtracking index scans when an admin sends repeated wildcards.
 */
export const triggeredByFilterSchema = z.enum(['manual', 'scheduler', 'downstream']);
export type TriggeredByFilter = z.infer<typeof triggeredByFilterSchema>;

/**
 * Request body for POST /api/admin/plugins/[pluginId]
 */
export const pluginTriggerBodySchema = z
    .object({
        action: z.enum(['abort']).optional(),
        mode: allowedModeSchema.optional(),
        libraryPathId: z.string().guid().optional(),
        // scan-group-coordinator routing for file-scanner triggers.
        // `paths: []` is rejected — clients that want "scan everything" should
        // omit `paths` entirely. Reaching the helper with [] produces a
        // confusing 'no-enabled-paths' error that the client can't act on.
        paths: z.array(z.string().guid()).min(1).optional(),
        label: z.string().min(1).max(120).optional(),
        libraryGroupId: z.string().guid().optional(),
    })
    .strict();

export type PluginTriggerBody = z.infer<typeof pluginTriggerBodySchema>;

/**
 * Query params for task history endpoint
 */
export const taskHistoryQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    type: z.string().optional(),
    target: z.string().optional(),
    triggeredBy: triggeredByFilterSchema.optional(),
    parentJobId: z.string().optional(),
});

export type TaskHistoryQuery = z.infer<typeof taskHistoryQuerySchema>;

/**
 * Body for triggering a plugin
 */
export const triggerPluginBodySchema = z.object({
    pluginId: nonEmptyStringSchema,
});

export type TriggerPluginBody = z.infer<typeof triggerPluginBodySchema>;

/**
 * Body for updating plugin settings
 */
export const pluginSettingsBodySchema = z.object({
    enabled: z.boolean().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
});

export type PluginSettingsBody = z.infer<typeof pluginSettingsBodySchema>;

/**
 * Body for enabling/disabling external plugin
 */
export const externalPluginPatchBodySchema = z.object({
    enabled: z.boolean().optional(),
});

export type ExternalPluginPatchBody = z.infer<typeof externalPluginPatchBodySchema>;

// ============================================================================
// Provider Preference
// ============================================================================

/**
 * Body for setting provider preference on a media item
 * POST /api/media/:id/provider-preference
 */
export const providerPreferenceBodySchema = z.object({
    provider: nonEmptyStringSchema.pipe(z.string().transform((s) => s.toLowerCase())),
});

export type ProviderPreferenceBody = z.infer<typeof providerPreferenceBodySchema>;

// ============================================================================
// Series Episode Ordering
// ============================================================================

/**
 * Valid episode ordering types
 */
export const episodeOrderingTypeSchema = z.enum([
    'standard',
    'absolute',
    'dvd',
    'regional',
    'other',
]);

export type EpisodeOrderingTypeZod = z.infer<typeof episodeOrderingTypeSchema>;

/**
 * Body for syncing episode orderings from a provider
 * POST /api/series/[id]/ordering/sync
 */
export const orderingSyncBodySchema = z.object({
    orderingType: episodeOrderingTypeSchema.optional(),
    provider: nonEmptyStringSchema.optional(),
    groupId: nonEmptyStringSchema.optional(),
});

export type OrderingSyncBody = z.infer<typeof orderingSyncBodySchema>;

/**
 * Body for setting episode ordering preference
 * PUT /api/series/[id]/ordering
 */
export const orderingSetBodySchema = z.object({
    orderingType: episodeOrderingTypeSchema,
    provider: nonEmptyStringSchema.optional(),
    groupId: nonEmptyStringSchema.optional(),
});

export type OrderingSetBody = z.infer<typeof orderingSetBodySchema>;

// ============================================================================
// Service Tokens
// ============================================================================

/**
 * Allowed HTTP methods on a service token. Mirrors the verbs the public API
 * accepts; OPTIONS is intentionally excluded — /api/v1/* doesn't expose
 * CORS preflights and we don't want a method-restricted token to be probable
 * via OPTIONS.
 */
export const serviceTokenMethodSchema = z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

export type ServiceTokenMethod = z.infer<typeof serviceTokenMethodSchema>;

/**
 * Grants a service token may carry (`scopes` on the wire).
 *
 * Service tokens authenticate on /api/v1/* only — they never reach
 * /j/* routes — so the `jellyfin_compat` / `jellyfin_compat_read`
 * scopes are PAT-only and meaningless here. Fine-grained internal scopes
 * (`tokens:admin`, `library:admin`, ...) stay gate names and are not mintable.
 *
 * `integrations:read` is the integration credential: it must be the token's
 * only grant, works only under `/api/v1/integrations/`, and needs an owner
 * who is still an administrator.
 *
 * `diagnostics:read` is the debug-report credential (API package, spec
 * 2026-10-21-admin-debug-report-design §6): the token's only grant, minted by
 * an administrator with a required expiry of at most 90 days, GET/HEAD on the
 * debug report and its drill-downs only, and an owner who is still an
 * administrator.
 */
export const SERVICE_TOKEN_GRANTS = [
    'read',
    'write',
    'admin',
    'integrations:read',
    'diagnostics:read',
] as const;

export const serviceTokenScopeSchema = z
    .enum(SERVICE_TOKEN_GRANTS)
    .describe(
        'Service token grant. read = GET/HEAD only; write = read + mutations; admin = all + admin-gated routes (owner must still be an administrator); integrations:read = read-only access to /api/v1/integrations/* (watch-history, upcoming, homepage) and nothing else, must be the only grant, admin-minted, owner must still be an administrator. diagnostics:read = read-only access to the admin debug report (/api/v1/admin/debug-report and its drill-downs) and nothing else, must be the only grant, admin-minted, expiry required (max 90 days), owner must still be an administrator. jellyfin_compat / jellyfin_compat_read are PAT-only and never accepted on service tokens.',
    )
    .meta({ id: 'ServiceTokenGrant' });

export type ServiceTokenScope = z.infer<typeof serviceTokenScopeSchema>;

/**
 * Path-prefix entry for service tokens. Server-side hardening, ENFORCED at
 * mint time by `defs/service-tokens/index.ts`'s `CreateTokenBody` (fix-plan-5
 * Task 4, security review 5 §9 hardening item 3 — before this fix, this
 * schema had NO server consumer at all: the runtime validator used a
 * free-form `z.array(z.string())`, and the only schema that DID enforce
 * these rules, `serviceTokenCreateBodySchema`, was never imported by the
 * server because it also defaulted `scopes` to `['admin']`, the 2026-09-12
 * C3 defect — so it was deleted along with its dead client-only body):
 *   1. Length cap (255) — no unbounded prefix abuse.
 *   2. Must start with /api/v1/ — a prefix is matched against the raw
 *      request `pathname` (`$lib/server/auth/token-identity.ts`'s
 *      `tokenEnvelopeDenial()`, fix-plan-5 Task 3), literally, on EVERY
 *      surface a service token can reach — `/api/v1`, `/api/admin`, and the
 *      `{kind:'scope'}` fallback alike. A prefix-bound token is therefore
 *      denied on every `/api/admin` route: every STORED prefix is forced by
 *      this refine to start with `/api/v1/`, so no `/api/admin/...` REQUEST
 *      path ever matches any stored prefix (not "allowed everything"
 *      there — closing the C2 hole this comment used to describe). A prefix
 *      that doesn't start with
 *      `/api/v1/` (including a well-formed `/api/admin/...` one) is
 *      therefore dead config that could never match any request on any
 *      surface; rejecting it at create time (422 `validation_failed`, not
 *      400 — this codebase's problem+json taxonomy has no 400) surfaces the
 *      misconfiguration immediately instead of silently minting a token
 *      that can never authenticate anywhere.
 *   3. No `..` traversal — defense-in-depth against path normalization
 *      bugs in downstream comparisons.
 */
export const serviceTokenPathPrefixSchema = z
    .string()
    .min(1)
    .max(255)
    .refine((s) => s.startsWith('/api/v1/'), 'Path prefixes must start with /api/v1/')
    .refine((s) => !s.includes('..'), 'Path prefixes must not contain ".."');

/**
 * Query params for revoking a service token
 */
export const serviceTokenRevokeQuerySchema = z.object({
    id: z.coerce.number().int().positive().max(2147483647),
});

export type ServiceTokenRevokeQuery = z.infer<typeof serviceTokenRevokeQuerySchema>;

// ============================================================================
// Quick Connect
// ============================================================================

/**
 * Body for admin quick connect
 */
export const adminQuickConnectBodySchema = z.object({
    code: nonEmptyStringSchema,
    username: nonEmptyStringSchema,
});

export type AdminQuickConnectBody = z.infer<typeof adminQuickConnectBodySchema>;

// ============================================================================
// Privacy Settings
// ============================================================================

/**
 * Body for updating privacy settings
 */
export const privacySettingsBodySchema = z.object({
    username: nonEmptyStringSchema,
    hideFromOthers: z.boolean(),
});

export type PrivacySettingsBody = z.infer<typeof privacySettingsBodySchema>;

// ============================================================================
// Library Paths
// ============================================================================

export const libraryPathCreateBodySchema = z.object({
    /**
     * Filesystem folder to scan. Required for filesystem providers; MUST be
     * omitted for remote ones, whose `path` is a synthetic
     * `<scheme>://<upstream-id>` sentinel derived server-side from
     * `remote_library_id`. See the refinement below.
     */
    path: z.string().min(1).optional(),
    /**
     * Upstream library id on a remote media server (see
     * `REMOTE_LIBRARY_PROVIDERS`). Required for remote providers.
     *
     * The caller sends the id and NEVER the path: the server derives both
     * `path` (the sentinel) and `provider_path` (the id the connector actually
     * resolves libraries from) so no caller can mistype the sentinel or leave
     * `provider_path` empty — a row with an empty `provider_path` looks
     * configured and ingests nothing.
     */
    remote_library_id: z.string().min(1).optional(),
    media_type: z.enum([
        'movie',
        'tv',
        'anime',
        'music',
        'audiobook',
        'home_video',
        'training',
        'educational',
        'personal',
    ]),
    // The provider supplies the default: ABS has no declared language until an
    // operator chooses one; filesystem libraries use the configured primary language.
    language: z
        .string()
        .optional()
        .describe(
            'Metadata language override. When omitted, filesystem libraries use the bare primary TMDB language (e.g. de-DE becomes de); remote libraries have no declared language.',
        ),
    /**
     * No `.default(...)` here (unlike most of this schema's other fields):
     * the handler needs to tell "omitted" apart from "explicitly tmdb" so it
     * can default an omitted provider from the group's OTHER folders when the
     * group is non-empty, and only fall back to 'tmdb' for a brand-new group.
     * A zod-level default would collapse that distinction before the handler
     * ever sees the body.
     */
    provider: z.enum(LIBRARY_PATH_PROVIDERS).optional(),
    fallback_providers: z.array(z.enum(['tmdb', 'anidb', 'jellyfin'])).optional(),
    provider_path: z.string().min(1).nullable().optional(),
    library_group_id: z
        .string()
        .guid()
        .optional()
        .describe('UUID of the library group this path belongs to'),
    edition_label: z.string().min(1).nullable().optional(),
    scan_chapters: z.boolean().default(false),
});

/**
 * Enforce the path/remote_library_id split by provider class.
 *
 * `path` became optional so remote providers need not invent one, which would
 * otherwise let a filesystem library be created with no path at all — the
 * schema is the only thing that used to guarantee it. Keyed off
 * `REMOTE_LIBRARY_PROVIDERS` rather than an `=== 'audiobookshelf'` literal so a
 * second remote provider inherits the rule.
 *
 * Deliberately rejects `path` on a remote provider instead of ignoring it: a
 * caller that sent one believed it mattered, and silently discarding it is how
 * "I set the path and it did nothing" bugs are born.
 */
export const libraryPathCreateBodyRefined = libraryPathCreateBodySchema.superRefine((body, ctx) => {
    const isRemote =
        body.provider !== undefined &&
        (REMOTE_LIBRARY_PROVIDER_NAMES as readonly string[]).includes(body.provider);
    if (isRemote) {
        if (!body.remote_library_id) {
            ctx.addIssue({
                code: 'custom',
                path: ['remote_library_id'],
                message: `remote_library_id is required for the ${body.provider} provider`,
            });
        }
        if (body.path) {
            ctx.addIssue({
                code: 'custom',
                path: ['path'],
                message: `path must be omitted for the ${body.provider} provider — it is derived from remote_library_id`,
            });
        }
        return;
    }
    if (!body.path) {
        ctx.addIssue({
            code: 'custom',
            path: ['path'],
            message: 'path is required',
        });
    }
    if (body.remote_library_id) {
        ctx.addIssue({
            code: 'custom',
            path: ['remote_library_id'],
            message: `remote_library_id is only valid for a remote provider, not ${body.provider}`,
        });
    }
});

export type LibraryPathCreateBody = z.infer<typeof libraryPathCreateBodySchema>;

export const libraryPathPatchBodySchema = z.object({
    path: z.string().min(1).optional(),
    media_type: z
        .enum([
            'movie',
            'tv',
            'anime',
            'music',
            'audiobook',
            'home_video',
            'training',
            'educational',
            'personal',
        ])
        .optional(),
    language: z.string().optional(),
    provider: z.enum(LIBRARY_PATH_PROVIDERS).optional(),
    fallback_providers: z.array(z.enum(['tmdb', 'anidb', 'jellyfin'])).optional(),
    enabled: z.boolean().optional(),
    provider_path: z.string().min(1).nullable().optional(),
    library_group_id: z
        .string()
        .guid()
        .optional()
        .describe('UUID of group to move this path into. Omit to keep current group.'),
    edition_label: z.string().min(1).nullable().optional(),
    scan_chapters: z.boolean().optional(),
    source_prefix: z.string().min(1).nullable().optional(),
});

export type LibraryPathPatchBody = z.infer<typeof libraryPathPatchBodySchema>;

// ============================================================================
// Task Retry
// ============================================================================

/**
 * Path params for task retry endpoint
 */
export const taskRetryParamsSchema = z.object({
    taskId: z.string().min(1),
});

export type TaskRetryParams = z.infer<typeof taskRetryParamsSchema>;

/**
 * Body for task retry endpoint.
 *
 * `force: true` opts the caller into re-running a task whose prior run
 * succeeded. Default retry semantics are intentionally narrow — only
 * `failed` or `aborted` rows qualify — so the admin UI's "retry" button
 * does not silently spawn a second run of work that already completed.
 */
export const taskRetryBodySchema = z.object({
    jobId: z.string().min(1).optional().describe('BullMQ job ID or task_history row ID to retry'),
    force: z
        .boolean()
        .optional()
        .describe('Re-run even when the original row is in a terminal-success state'),
    itemId: z
        .string()
        .min(1)
        .optional()
        .describe(
            'Plugin-specific failed-item ID; when set, retry only this item via plugin.retryItem',
        ),
});

export type TaskRetryBody = z.infer<typeof taskRetryBodySchema>;

/**
 * Response for task retry endpoint. `reason` disambiguates a plain retry
 * (failed → retry) from a force-rerun (succeeded → re-queued with fresh
 * options) so operators can audit which class of action ran.
 *
 * `defaultedMode`: set to true when the original job had no recorded mode
 * and the endpoint defaulted it to `catchup`. Allows audit log to surface
 * the implicit coercion rather than silently inheriting an unknown mode.
 *
 * `force-unknown-status`: used when `force=true` was passed for a non-active,
 * non-retryable status other than succeeded/completed (e.g. `stalled`).
 * Distinguishes genuine "rerun a succeeded job" from "force a stalled/unknown".
 */
export const taskRetryResponseSchema = z.object({
    /** Selected-file media-probe runs finish asynchronously; acceptance is not success. */
    runId: z
        .string()
        .optional()
        .describe(
            'Accepted asynchronous selected-file recheck; poll the run for its terminal result',
        ),
    deduped: z
        .boolean()
        .optional()
        .describe('True when an existing selected-file recheck was reused'),
    retried: z.boolean(),
    jobId: z.string().optional(),
    reason: z
        .enum([
            'retry',
            'rerun-succeeded',
            'already-active',
            'force-unknown-status',
            'item-retry',
            'item-retry-failed',
            'item-not-supported',
            'item-already-retrying',
        ])
        .optional(),
    defaultedMode: z.boolean().optional(),
    message: z.string(),
    /** Per-item retry echo — populated only when request body had `itemId`. */
    itemId: z.string().optional(),
    /** True when plugin.retryItem returned `{ success: true }`. */
    itemSuccess: z.boolean().optional(),
    /** Short failure reason when `itemSuccess=false`. */
    itemReason: z.string().optional(),
});

export type TaskRetryResponse = z.infer<typeof taskRetryResponseSchema>;

// ============================================================================
// Queue Pause / Resume
// ============================================================================

/**
 * Runtime queue classes used by the task-system rewrite. These are the bare
 * resource-class names accepted at `/api/v1/queues/[class]/pause` and
 * `/api/v1/queues/[class]/resume`. Legacy names (sync-tasks, heavy-compute,
 * embedding-tasks, maintenance-tasks) were retired in the task-system clean
 * rewrite — see `src/lib/server/tasks/queue-naming.ts`.
 */
export const queueNameEnumSchema = z.enum(['cpu', 'io', 'embedding', 'maintenance']);

/**
 * Path params for queue pause/resume endpoints
 */
export const queueNameParamsSchema = z.object({
    queueName: queueNameEnumSchema,
});

export type QueueNameParams = z.infer<typeof queueNameParamsSchema>;

/**
 * Response for queue pause/resume endpoints.
 *
 * `wasAlreadyResumed`: present on resume responses only. True when the queue
 * was not paused before the resume call — a no-op that the caller can detect
 * without treating as an error.
 */
export const queuePauseResponseSchema = z.object({
    queueName: z.string(),
    paused: z.boolean(),
    message: z.string(),
    wasAlreadyResumed: z.boolean().optional(),
});

export type QueuePauseResponse = z.infer<typeof queuePauseResponseSchema>;

// ============================================================================
// Task History Trim
// ============================================================================

/**
 * Query params for history trim endpoint
 */
export const historyTrimQuerySchema = z.object({
    olderThanDays: z.coerce.number().int().min(7).max(365).default(90),
    taskType: z.string().min(1).optional(),
});

export type HistoryTrimQuery = z.infer<typeof historyTrimQuerySchema>;

/**
 * Discriminated union for history trim responses.
 *
 * `complete`      — all eligible rows deleted in one pass.
 * `partial`       — stopped mid-batch (DB error or client abort).
 * `already-running` — concurrent trim advisory lock was held; no rows deleted.
 */
export const historyTrimResponseSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('complete'),
        deleted: z.number(),
        message: z.string().optional(),
    }),
    z.object({
        kind: z.literal('partial'),
        deleted: z.number(),
        message: z.string(),
        reason: z.string().optional(),
    }),
    z.object({
        kind: z.literal('already-running'),
        deleted: z.literal(0),
        message: z.string(),
    }),
]);

export type HistoryTrimResponse = z.infer<typeof historyTrimResponseSchema>;

// ============================================================================
// Scheduler Inspection
// ============================================================================

/**
 * Single scheduler entry in the response.
 *
 * `paused` is kept for backward compatibility but is redundant — it reflects
 * the queue-level paused state, not a per-scheduler flag. All schedulers in
 * the same queue carry the same value. Prefer `queueStates[queueName].paused`
 * for new consumers.
 */
export const schedulerEntrySchema = z.object({
    queueName: z.string(),
    schedulerId: z.string(),
    name: z.string(),
    pattern: z.string().optional(),
    every: z.number().optional(),
    next: z.number().optional(),
    nextIso: z.string().optional(),
    iterationCount: z.number().optional(),
    /** @deprecated Use queueStates[queueName].paused instead. Kept for backcompat. */
    paused: z.boolean().nullable().optional(),
});

export type SchedulerEntry = z.infer<typeof schedulerEntrySchema>;

/**
 * Per-queue state record included at the top level of the scheduler response.
 * Single authoritative source for pause/reachable state per queue name.
 */
export const queueStateSchema = z.object({
    paused: z.boolean(),
    reachable: z.boolean(),
});

export type QueueState = z.infer<typeof queueStateSchema>;

// ============================================================================
// Library Group Permissions
// ============================================================================

/**
 * Body for upserting a library group permission
 * PUT /api/admin/library-group-permissions
 */
export const libraryGroupPermissionBodySchema = z.object({
    library_group_id: z.string().guid().describe('Library group UUID'),
    allowed_groups: z
        .array(z.string())
        .describe('Authentik group names that can access this library'),
});

export type LibraryGroupPermissionBody = z.infer<typeof libraryGroupPermissionBodySchema>;

// ---------------------------------------------------------------------------
// Library Groups
// ---------------------------------------------------------------------------

export const libraryGroupCreateBodySchema = z.object({
    name: z
        .string()
        .min(1)
        .max(LIBRARY_GROUP_NAME_MAX_LENGTH)
        .describe('Display name for the library group'),
    description: z.string().max(500).nullable().optional().describe('Optional description'),
    icon: z.string().max(50).nullable().optional().describe('Icon name or emoji'),
    sort_order: z.number().int().min(0).default(0).describe('Sort order (lower = first)'),
    max_age_rating: z
        .number()
        .int()
        .min(0)
        .max(21)
        .nullable()
        .optional()
        .describe('Maximum age rating for this library (omit/null = unrestricted)'),
    metadata_provider_chain: z
        .array(z.string().min(1).max(50))
        .max(20)
        .nullable()
        .optional()
        .describe('Ordered metadata provider chain (omit/null = use global default)'),
    field_priority_overrides: z
        .record(z.string(), z.array(z.string().min(1).max(50)))
        .optional()
        .describe('Per-field provider priority overrides (omit = use global default)'),
});

export type LibraryGroupCreateBody = z.infer<typeof libraryGroupCreateBodySchema>;

export const libraryGroupPatchBodySchema = z.object({
    name: z.string().min(1).max(LIBRARY_GROUP_NAME_MAX_LENGTH).optional().describe('Display name'),
    description: z.string().max(500).nullable().optional().describe('Description (null to clear)'),
    icon: z.string().max(50).nullable().optional().describe('Icon (null to clear)'),
    sort_order: z.number().int().min(0).optional().describe('Sort order'),
    max_age_rating: z
        .number()
        .int()
        .min(0)
        .max(21)
        .nullable()
        .optional()
        .describe('Max age rating (null to unrestrict)'),
    metadata_provider_chain: z
        .array(z.string().min(1).max(50))
        .max(20)
        .nullable()
        .optional()
        .describe('Metadata provider chain (null = use global default)'),
    field_priority_overrides: z
        .record(z.string(), z.array(z.string().min(1).max(50)))
        .nullable()
        .optional()
        .describe('Field priority overrides (null = use global default)'),
});

export type LibraryGroupPatchBody = z.infer<typeof libraryGroupPatchBodySchema>;

// ----------------------------------------------------------------------------
// Composite library setup (create a group + its paths in one call)
// ----------------------------------------------------------------------------
// Powers the fresh-install "create your first library" wizard. A library group
// may not mix media types, so the whole library has ONE media_type that every
// path inherits — the caller doesn't set media_type per path.
export const librarySetupBodySchema = z.object({
    name: z.string().min(1).max(100).describe('Display name for the library'),
    media_type: z
        .enum([
            'movie',
            'tv',
            'anime',
            'music',
            'audiobook',
            'home_video',
            'training',
            'educational',
            'personal',
        ])
        .describe('Media type for the whole library (applied to every path)'),
    description: z.string().max(500).optional(),
    icon: z.string().max(50).optional(),
    sort_order: z.number().int().min(0).default(0),
    max_age_rating: z.number().int().min(0).max(21).optional(),
    metadata_provider_chain: z.array(z.string().min(1).max(50)).max(20).optional(),
    paths: z
        .array(
            z.object({
                path: z.string().min(1),
                language: z
                    .string()
                    .optional()
                    .describe(
                        'Metadata language override; defaults to the bare primary TMDB language when omitted.',
                    ),
                provider: z.enum(LIBRARY_PATH_PROVIDERS).default('tmdb'),
                fallback_providers: z.array(z.enum(['tmdb', 'anidb', 'jellyfin'])).default([]),
                provider_path: z.string().min(1).nullable().optional(),
                edition_label: z.string().min(1).nullable().optional(),
                scan_chapters: z.boolean().default(false),
            }),
        )
        .min(1, 'At least one folder path is required')
        .max(20)
        .describe('Filesystem folders that make up this library'),
});

export type LibrarySetupBody = z.infer<typeof librarySetupBodySchema>;

/**
 * REQUEST-side counterpart. Several fields on `paths[]` carry `.default(...)`
 * (`language`, `provider`, `fallback_providers`, `scan_chapters`), so `z.infer`
 * — the OUTPUT type — marks them required. Callers legitimately omit them and
 * let the server apply the defaults, which is what `z.input` models. The setup
 * wizard sends `{path, provider}` only and could not type-check against the
 * output type.
 */
export type LibrarySetupInput = z.input<typeof librarySetupBodySchema>;

// ----------------------------------------------------------------------------
// Library settings update (PATCH /api/admin/libraries/[id])
// ----------------------------------------------------------------------------
// The "Settings" section of the per-library page: name/icon/description/
// age limit live on `library_groups`; media_type/provider/fallback_providers
// are library-level facts that get fanned out to every `library_paths` row of
// the group in one transaction (see `updateLibrary` in
// `library-update.service.ts`). All fields optional — a partial save only
// touches what the form actually submitted.
export const libraryUpdateBodySchema = z.object({
    name: z.string().min(1).max(100).optional().describe('Display name for the library'),
    icon: z.string().max(50).nullable().optional().describe('Icon (null to clear)'),
    description: z.string().max(500).nullable().optional().describe('Description (null to clear)'),
    max_age_rating: z
        .number()
        .int()
        .min(0)
        .max(21)
        .nullable()
        .optional()
        .describe('Max age rating (null to unrestrict)'),
    media_type: z
        .enum([
            'movie',
            'tv',
            'anime',
            'music',
            'audiobook',
            'home_video',
            'training',
            'educational',
            'personal',
        ])
        .optional()
        .describe('Applied to every folder in the library'),
    provider: z
        .enum(LIBRARY_PATH_PROVIDERS)
        .optional()
        .describe('Metadata provider, applied to every folder in the library'),
    fallback_providers: z
        .array(z.enum(['tmdb', 'anidb', 'jellyfin']))
        .optional()
        .describe('Fallback provider chain, applied to every folder in the library'),
    allowed_groups: z
        .array(z.string())
        .optional()
        .describe(
            'User groups that may see this library; [] = everyone. Needs the access:admin scope.',
        ),
});

export type LibraryUpdateBody = z.infer<typeof libraryUpdateBodySchema>;

// ============================================================================
// Plugin Failed Items Drilldown
// ============================================================================

/**
 * Individual failed item schema for admin drilldown.
 * Returned from plugin.listFailedItems() and paginated via the API.
 */
export const FailedItemSchema = z.object({
    id: z.string().describe('Plugin-generated stable id for key/deduplication'),
    label: z.string().describe('Human-readable identifier (file path, track name, media title)'),
    reason: z.string().describe('Short failure reason (~200 chars)'),
    detectedAt: z
        .string()
        .nullable()
        .describe('ISO timestamp when the latest failure was detected (best-effort; null ok)'),
    subtitle: z.string().optional().describe('Optional secondary line (e.g. absolute path)'),
    taskRunId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('task_history.id of the run that recorded the latest failure'),
    /** Phase G aggregates from plugin_failure_events. */
    firstSeen: z
        .string()
        .optional()
        .describe(
            'ISO timestamp of the FIRST recorded failure for this item within the 90-day event-log window',
        ),
    failureCount: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
            'Total recorded failures within the 90-day event-log window (at least 1 when populated)',
        ),
    lastSeen: z
        .string()
        .optional()
        .describe(
            'ISO timestamp of the most-recent recorded failure — usually matches detectedAt but sourced from the event log',
        ),
});

export type FailedItem = z.infer<typeof FailedItemSchema>;

// ============================================================================
// Failure Timeline
// ============================================================================

/** Single failure-event row. */
export const FailureEventSchema = z.object({
    id: z.string().describe('UUID PK of the event row'),
    pluginId: z.string().describe('Plugin id that recorded the failure'),
    itemKey: z.string().describe('Plugin-scoped item identifier'),
    reason: z.string().nullable().describe('Short failure reason captured at write time'),
    taskRunJobId: z
        .string()
        .nullable()
        .describe(
            'task_history.task_id of the run that recorded the failure (the BullMQ job id string)',
        ),
    /**
     * Resolved task_history.id (numeric SERIAL) for the run that recorded
     * the failure — joined live+archive Phase-D-style. Optional because
     * the live row may have been archived AND deleted past the 365d
     * cutoff. The UI gates the per-event "Run logs →" link on this
     * being defined; logDrawer.open(taskRunId) opens directly with no
     * extra lookup.
     */
    taskRunId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
            'Resolved task_history.id (live or archive) for direct logDrawer.open(...) usage',
        ),
    createdAt: z.string().describe('ISO timestamp when the failure was recorded'),
});
export type FailureEvent = z.infer<typeof FailureEventSchema>;

/**
 * Authoritative aggregate stats for the (plugin_id, item_key) — sourced
 * from a separate GROUP BY so the drawer header stays correct even when
 * `events` is paginated/truncated. Recomputing from a bounded `events`
 * slice would undercount and misreport `firstSeen` once the timeline
 * has more than `limit` rows.
 */
export const FailureTimelineSummarySchema = z.object({
    failureCount: z
        .number()
        .int()
        .min(0)
        .describe(
            'Total failure events for this (pluginId, itemKey) within the 90-day retention window',
        ),
    firstSeen: z
        .string()
        .nullable()
        .describe(
            'ISO timestamp of the OLDEST event still in the retention window (null if no events)',
        ),
    lastSeen: z
        .string()
        .nullable()
        .describe('ISO timestamp of the most-recent event (null if no events)'),
});
export type FailureTimelineSummary = z.infer<typeof FailureTimelineSummarySchema>;

// ============================================================================
// Dead Letter Queue (DLQ)
// ============================================================================

/** Admin-visible status of a DLQ row. */
export const deadLetterStatusSchema = z.enum(['pending', 'permanently_failed', 'archived']);
export type DeadLetterStatusValue = z.infer<typeof deadLetterStatusSchema>;

/** Audit-event kinds the DLQ can carry. Mirrors AuditEventKind in the query module. */
export const deadLetterKindSchema = z.enum(['started', 'completed', 'failed', 'stalled']);

/** Single DLQ row exposed to the admin UI. */
export const DeadLetterEntrySchema = z.object({
    id: z.number().int().positive().describe('DLQ row id'),
    kind: deadLetterKindSchema.describe('Audit event kind the row would have written'),
    jobId: z.string().describe('BullMQ job id from the original event'),
    jobName: z.string().describe('Task type name (the plugin id)'),
    attempts: z.number().int().min(0).describe('Repair-pass attempt counter'),
    lastError: z.string().nullable().describe('Error message from the most recent failed attempt'),
    enqueuedAt: z.string().describe('ISO timestamp when the row first entered the DLQ'),
    lastRetryAt: z
        .string()
        .nullable()
        .describe('ISO timestamp of the most recent repair-pass attempt'),
    permanentlyFailedAt: z
        .string()
        .nullable()
        .describe('ISO timestamp when the row was declared permanently failed'),
    archivedAt: z
        .string()
        .nullable()
        .describe('ISO timestamp the row was moved to archive (null on live rows)'),
    /**
     * Payload JSON — the audit event the listener was trying to write.
     * Exposed as-is for debugging; admins see this in the detail drawer.
     * Shape varies by kind (see audit-listener's enqueueDeadLetter call sites).
     */
    payload: z.unknown().describe('The original audit event payload as JSON'),
});
export type DeadLetterEntry = z.infer<typeof DeadLetterEntrySchema>;

// ============================================================================
// Task Settings (PUT /api/v1/tasks/[taskId]/settings)
// ============================================================================

/**
 * Body for PUT /api/v1/tasks/[taskId]/settings.
 *
 * The shape is intentionally generic — the task's `settings.fields` definition
 * is the authoritative per-field schema and is enforced by the handler at
 * runtime (declared-key gate + per-value byte caps). This Zod schema only
 * guarantees the outer shape: two optional top-level objects, with secrets
 * constrained to string values so the AES-GCM store doesn't have to defend
 * against non-strings.
 *
 * `.strict()` rejects unknown top-level keys so a typo'd `value` / `secret`
 * surfaces as a 400 instead of being silently dropped.
 */
export const taskSettingsPutBodySchema = z
    .object({
        values: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
                'Non-secret settings keyed by field key. Keys must be declared in task.settings.fields with type != secret. Validated against the per-field schema and byte caps inside the handler.',
            ),
        secrets: z
            .record(z.string(), z.string())
            .optional()
            .describe(
                'Secret values keyed by field key. Keys must be declared in task.settings.fields with type=secret. Values must be strings (the secret store is opaque-string only). Byte caps enforced by the handler.',
            ),
    })
    .strict();

export type TaskSettingsPutBody = z.infer<typeof taskSettingsPutBodySchema>;

// ============================================================================
// Auto-Identify Personal Media (POST /api/admin/auto-identify)
// ============================================================================

/**
 * Body for POST /api/admin/auto-identify.
 *
 * The auto-identify task's own `inputSchema` is `z.object({}).passthrough()`,
 * so the actual options bag is unconstrained at the task layer. This boundary
 * schema accepts an optional `options` object of arbitrary key/value pairs but
 * rejects extra top-level keys, ensuring the request shape is `{ options?: {} }`
 * and nothing else. Per-key validation is left to the task itself if it ever
 * grows a real input schema.
 */
export const autoIdentifyPostBodySchema = z
    .object({
        options: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
                'Optional pass-through options forwarded to the auto-identify-personal-media task as its input. `mediaItemIds` (uuid[], max 500) restricts the run to those unmatched top-level items.',
            ),
    })
    .strict();

export type AutoIdentifyPostBody = z.infer<typeof autoIdentifyPostBodySchema>;

// ============================================================================
// Sync Quarantine Resolve (POST /api/admin/quarantine/[id]/resolve)
// ============================================================================

/**
 * Valid resolution verbs for a sync_quarantine row.
 * Single source of truth — the QuarantineResolution union in
 * sync-quarantine.queries.ts reflects this enum.
 */
export const quarantineResolutionSchema = z
    .enum(['reattached', 'dismissed', 'recreated'])
    .describe(
        'Resolution verb for a sync_quarantine row. reattached = matched to a new jellyfin item; dismissed = ignore; recreated = re-imported as fresh media.',
    );

export type QuarantineResolutionEnum = z.infer<typeof quarantineResolutionSchema>;

/**
 * Body for POST /api/admin/quarantine/[id]/resolve.
 *
 * Only the resolution verb is accepted from the client. `resolvedBy` is
 * intentionally NOT part of the schema — the route handler ALWAYS pulls
 * that from `locals.user.username` so an admin can't forge audit-trail
 * attribution by sending it in the body.
 */
export const quarantineResolveBodySchema = z
    .object({
        resolution: quarantineResolutionSchema,
        fingerprint: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional()
            .describe('Opaque inspected revision required by the individual inspection UI'),
    })
    .strict();

export type QuarantineResolveBody = z.infer<typeof quarantineResolveBodySchema>;
