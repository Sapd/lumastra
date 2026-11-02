// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * watch-sync-status-projection.ts — maps an orchestrator `Run` (task_history
 * merged with live Valkey progress by `orchestrator.getRun`) onto the wire
 * `SyncStatus` contract consumed by the mal/trakt `sync/status` endpoints.
 *
 * `watch-sync-manual` (Task 7) reports progress via
 * `ctx.reportProgress(processed, total, currentItem)` against a single
 * default stage — so `run.stages` normally has exactly one entry. This
 * helper reads the LAST stage (most recently active), which is correct for
 * the single-stage case and degrades sensibly if a future multi-stage task
 * ever reuses it.
 *
 * `run.state` is `RunStateSchema` (`'pending'|'active'|'cancelling'|
 * 'completed'|'failed'|'cancelled'`) — an EXACT match for `SyncStatusSchema`'s
 * `state` enum, so it passes through with no translation.
 */

import type { Run } from '@sapd/lumastra-plugin-sdk';
import {
    SyncStatusSchema,
    type SyncActivityItem,
    type SyncStatus,
} from '$lib/schemas/api-integrations-responses.js';

/**
 * Idle status returned when the user has never triggered a manual
 * Import/Export for this provider (no `watch-sync-manual` run found, or a
 * found run id failed the defensive ownership re-check).
 */
export function idleSyncStatus(recentActivity: SyncActivityItem[]): SyncStatus {
    return SyncStatusSchema.parse({ state: null, processed: 0, recentActivity });
}

/** Project a `watch-sync-manual` Run + its recent activity feed onto the
 *  `SyncStatus` wire contract. */
export function projectRunToStatus(run: Run, recentActivity: SyncActivityItem[]): SyncStatus {
    const stage = run.stages.length > 0 ? run.stages[run.stages.length - 1] : undefined;

    return SyncStatusSchema.parse({
        state: run.state,
        runId: run.id,
        phase: stage?.label,
        total: stage?.total,
        processed: stage?.processed ?? 0,
        error: run.error?.message,
        startedAt: run.startedAt,
        finishedAt: run.completedAt,
        recentActivity,
    });
}
