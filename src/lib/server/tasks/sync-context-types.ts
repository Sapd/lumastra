// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Task-system domain types for sync / drain execution.
 *
 * Consumed by `plugins/runtime/drain-backlog.ts` and the natives under
 * `tasks/builtin/native/` that construct sync-shaped contexts when calling
 * the drain helpers.
 */

import type postgres from 'postgres';
import type { PluginContext } from '../plugins/types/base-plugin.js';

/**
 * Backlog metadata declared in the manifest. When present, the admin UI
 * renders a PluginBacklogCard showing "X of Y analyzed" progress plus
 * primary/destructive actions.
 */
export interface PluginBacklogManifest {
    /** Plural noun for the unit being tracked (e.g. "seasons", "items") */
    unitLabel: string;
    /**
     * Whether the primary "Analyze remaining" action is supported.
     * When true the card calls the task-start endpoint with `mode: 'manual'`,
     * which the plugin interprets as "drain until empty".
     */
    primaryActionMode: 'manual';
    /**
     * What "remaining" means for this plugin:
     *   - `'missing'`: rows that have never been processed at the current
     *     processing version. The button reads "Analyze N new".
     *   - `'stale'`: rows that are missing OR older than a refresh window
     *     (e.g. popularity refreshes every 7 days). The button reads
     *     "Refresh N stale".
     * Defaults to `'missing'` when unset.
     */
    refreshMode?: 'missing' | 'stale';
    /**
     * Plugin-specific explanation for what the `ineligible` bucket contains.
     * Surfaced as a tooltip on the backlog card — e.g. "Seasons with fewer
     * than 2 episodes (chromaprint needs at least 2)". Forwarded verbatim
     * onto `TaskBacklogConfig.ineligibleDescription` so external admins get
     * context instead of a generic fallback.
     */
    ineligibleDescription?: string;
    /** Destructive "Re-analyze everything" action metadata */
    destructive?: {
        /** Confirmation prompt shown to the admin */
        confirmText: string;
        /** What the wipe removes (e.g. "all detected intro/outro segments") */
        wipeSummary: string;
    };
}

/**
 * Snapshot of a sync plugin's backlog state. Returned from
 * `getBacklogStatus(ctx)` and cached for ~5s by the status endpoint.
 */
export interface PluginBacklogStatus {
    /** Count of units that have been processed successfully */
    analyzed: number;
    /** Count of units that still need to be processed */
    remaining: number;
    /**
     * Count of units that can never be processed (e.g. seasons with < 2
     * episodes for chromaprint, tracks with no attached media file). Shown
     * as an informational chip so admins don't chase a phantom gap.
     *
     * Non-optional: plugins MUST populate this even when there are no
     * ineligible rows (just return 0). Making it mandatory prevents silent
     * gaps where items fall into a fourth bucket that isn't surfaced in
     * the admin UI — if ineligible is legitimately always 0 for a plugin
     * (e.g. a time-based refresher), that 0 is a deliberate statement.
     */
    ineligible: number;
    /**
     * Count of units whose processing threw at the current processing
     * version. Distinct from `remaining` (never tried) and `analyzed`
     * (succeeded). Surfaced separately so admins know something went wrong
     * without inflating the "done" count. Retry on the next version bump.
     *
     * Optional: time-based plugins (refresh-every-N-days) don't have a
     * notion of "failed rows" — the next tick retries everything.
     */
    failed?: number;
    /**
     * Estimated milliseconds until the remaining backlog is drained,
     * computed from the plugin's recent throughput. Undefined when the
     * plugin can't estimate confidently (cold start, no recent activity,
     * refresh-mode plugin). Card formats this as a human-readable
     * "~N hours remaining".
     */
    etaMs?: number;
}

/**
 * Resume-on-interrupt contract for sync plugins.
 *
 * When a worker crashes or restarts mid-job, the recovery layer (startup
 * cleanup + scheduler reclaim) needs to decide whether to auto-resume the
 * task and what options to pass. This contract makes that explicit per
 * plugin instead of inferring it from queue heuristics.
 *
 * The task_history.metadata column is the canonical source of options: the
 * audit listener mirrors `job.data.options` there at job-start, so the
 * resumed run gets the same mode/scope as the original even when BullMQ
 * has lost the job. `defaultMode` only kicks in when no metadata is
 * recoverable (e.g. a legacy row with null metadata).
 */
export interface SyncResumeManifest {
    /**
     * Whether interrupted runs should be auto-resumed. Defaults to true
     * for sync plugins that declare a backlog manifest; set false for
     * plugins whose work is non-resumable (one-shot reconciliations).
     */
    enabled?: boolean;
    /**
     * Mode passed to `execute()` when an interrupted run is reclaimed AND
     * the original task_history.metadata has no `mode` field. Most plugins
     * want `'catchup'` (the safest non-destructive default).
     */
    defaultMode?: string;
}

/**
 * Narrow execution context passed to `execute()` and `processItems()`.
 *
 * Deliberately omits capability bindings (`cache`, `http`, `ffmpeg`) — the
 * per-run code path is read-mostly and reaching for `ctx.cache` inside
 * `execute()` would crash with no type-system warning.
 *
 * Plugins that need capability bindings during execution capture the full
 * `PluginContext` in `initialize()` and merge it with the per-run fields
 * from here. Lifecycle hooks (`initialize`, `shutdown`, `getBacklogStatus`,
 * `wipeProcessedData`) still receive the full `PluginContext`; only
 * `execute()` and `processItems()` get this narrowed surface.
 */
export interface SyncExecutionContext {
    /** Database connection */
    sql: postgres.Sql;

    /** Scoped logger instance */
    logger: PluginContext['logger'];

    /** Abort signal — fires on hard timeout, admin cancel, or process shutdown */
    abortSignal: AbortSignal;

    /**
     * Execution mode passed from admin UI (e.g. 'catchup', 'smart', 'force').
     * The sync processor defaults to 'catchup' when no mode is supplied, so
     * plugins can rely on this field being populated at execute() entry.
     */
    mode: string;

    /** Raw job options passed from the task start endpoint */
    jobOptions?: Record<string, unknown>;

    /**
     * BullMQ job id string. Stable for the lifetime of this invocation.
     * Store on per-item failure markers so `listFailedItems` can join
     * `task_history.task_id = jobId` to surface the integer run id to
     * the admin UI's drilldown.
     */
    jobId: string;

    /**
     * BullMQ runGroupId from job.data.runGroupId. Optional — singular plugins
     * (not part of a coordinated scan group) won't have this populated.
     */
    runGroupId?: string;

    /**
     * Report progress during long-running syncs.
     * Used by the scheduler to track and display progress.
     */
    onProgress?: (
        processed: number,
        total: number,
        meta?: { currentItem?: string; phase?: string },
    ) => void;
}

// =============================================================================
// Sync Result
// =============================================================================

/**
 * Result returned from sync execution.
 */
export interface SyncTaskResult {
    /** Whether the sync completed successfully */
    success: boolean;
    /** When the sync completed */
    timestamp: Date;
    /** Human-readable result message */
    message?: string;
    /** Error message if failed */
    error?: string;
    /** Number of items processed */
    itemsProcessed?: number;
    /** Duration in milliseconds */
    duration?: number;
    /** Additional task-specific data */
    [key: string]: unknown;
}

/**
 * Serialized version for JSON API responses.
 */
export interface SyncTaskResultSerialized {
    success: boolean;
    timestamp: string;
    message?: string;
    error?: string;
    itemsProcessed?: number;
    duration?: number;
    [key: string]: unknown;
}

// =============================================================================
// Failed Items Drilldown
// =============================================================================

/**
 * Individual failed item returned from listFailedItems.
 * Plugin-generated stable ID, human-readable label, and reason for failure.
 */
export interface FailedItem {
    /** Plugin-generated stable id usable as React/Svelte key. */
    id: string;
    /** Human-readable identifier: file path, track name, media title, etc. */
    label: string;
    /** Short failure reason. Capped at ~200 chars. */
    reason: string;
    /** ISO timestamp when the failure was first detected (best-effort; null ok). */
    detectedAt: string | null;
    /** Optional secondary line — e.g. absolute file path under a short label. */
    subtitle?: string;
    /**
     * task_history.id (UUID) of the run that recorded this failure.
     * Populated by the plugin's listFailedItems via LEFT JOIN on
     * task_history.task_id = audit_run_job_id. Absent when the failure
     * marker pre-dates Phase D (no audit_run_job_id stored) or when the
     * matching task_history row no longer exists.
     */
    taskRunId?: string;
    /** Phase G: ISO timestamp of the FIRST recorded failure event within the 90-day window. */
    firstSeen?: string;
    /** Phase G: Total recorded failure events within the 90-day window. */
    failureCount?: number;
    /** Phase G: ISO timestamp of the most-recent recorded failure event. */
    lastSeen?: string;
}

/**
 * Options for paginating failed items.
 */
export interface ListFailedItemsOptions {
    /** Max items per page, clamped to [1, 100] */
    limit: number;
    /** 0-based pagination offset */
    offset: number;
}

/**
 * Result returned from listFailedItems pagination query.
 */
export interface ListFailedItemsResult {
    /** Array of failed items for the current page */
    items: FailedItem[];
    /** Total count of failed items across all pages */
    total: number;
}

/**
 * Result returned from `SyncPlugin.retryItem` — admin-initiated per-item retry.
 */
export interface RetryItemResult {
    /**
     * True when the item is no longer in its failed state (successfully
     * reprocessed, or transitioned to an acceptable terminal state like
     * 'no-match' or 'ineligible'). The UI optimistically removes the row
     * on true; on false it keeps the row and updates the reason.
     */
    success: boolean;
    /**
     * Short description (max ~200 chars). Populated on failed retries to
     * explain why the item is still in the failed bucket. Omitted on success.
     */
    reason?: string;
}
