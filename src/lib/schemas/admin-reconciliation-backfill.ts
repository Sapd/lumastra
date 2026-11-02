// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zod schemas for the reconciliation-backfill admin trigger
 * (POST /api/admin/reconciliation-backfill). Single source of truth — the task
 * input shape and the route validation derive from here.
 */

import { z } from 'zod';

export const ReconciliationBackfillRequestSchema = z.object({
    /** Re-run only this series. Omit for a library-wide drain. */
    seriesMediaId: z.string().guid().optional(),
    /** Max series per drain page (clamped server-side). */
    batchSize: z.number().int().positive().max(1000).optional(),
    /** Auto-apply confidence floor, clamped server-side to [0.5, 1]. */
    minConfidence: z.number().min(0).max(1).optional(),
    /** Minimum candidate score to quarantine (below = skipped as noise). */
    quarantineFloor: z.number().min(0).max(1).optional(),
    /**
     * When true, re-sweep every eligible series regardless of its
     * `reconcile_backfill_at` watermark. Default false (stale-only drain).
     */
    force: z.boolean().optional(),
});

export type ReconciliationBackfillRequest = z.infer<typeof ReconciliationBackfillRequestSchema>;

export const ReconciliationBackfillResponseSchema = z.object({
    /** The task run id this trigger started (for tracking in /admin/runs). */
    runId: z.string(),
    message: z.string(),
});

export type ReconciliationBackfillResponse = z.infer<typeof ReconciliationBackfillResponseSchema>;
