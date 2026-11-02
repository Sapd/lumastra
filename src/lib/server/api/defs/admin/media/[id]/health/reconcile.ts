// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/health/reconcile.ts
 *
 * GET  /api/admin/media/[id]/health/reconcile  — preview episode reconciliation
 * POST /api/admin/media/[id]/health/reconcile  — apply episode reconciliation
 *
 * Auth: admin.  Surface: internal-only.
 *
 * GET response:  reconciliation preview (shape from previewReconciliation)
 * POST response: reconciliation result (shape from applyReconciliation)
 * 503 dependency_unavailable when DB is down.
 */

import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import {
    RECONCILE_AUTO_APPLY_CONFIDENCE,
    RECONCILE_PREVIEW_CONFIDENCE,
} from '$lib/shared/reconcile-thresholds.js';
import { getDb } from '$lib/server/database/connection.js';
import { extractBody, isRecord } from '$lib/utils/data-extraction.js';
import {
    previewReconciliation,
    applyReconciliation,
} from '$lib/server/services/episode-reconciliation.service.js';

// ---------------------------------------------------------------------------
// Response schemas (typed from ReconcilePreview / ApplyReconcileResult)
// ---------------------------------------------------------------------------

export const ReconcileReasonSchema = z.enum([
    'matched',
    'no-usable-chapters',
    'chapter-count-mismatch',
    'below-threshold',
    'duplicate-match',
    'manually-locked',
    'identity-bound',
]);

const ReconcileProposalSchema = z.object({
    episodeId: z.string(),
    fileId: z.string(),
    seasonNumber: z.number().int().nullable(),
    episodeNumber: z.number().int().nullable(),
    currentTitle: z.string().nullable(),
    proposedTitle: z.string().nullable(),
    matchedTmdbEpisodeId: z.string().nullable(),
    confidence: z.number(),
    changed: z.boolean(),
    reason: ReconcileReasonSchema,
    source: z.enum(['chapters', 'filename']),
});

export const ReconcilePreviewResponseSchema = z.object({
    seriesMediaId: z.string(),
    catalogSize: z.number().int().nonnegative(),
    proposals: z.array(ReconcileProposalSchema),
    changedCount: z.number().int().nonnegative(),
    needsReviewCount: z.number().int().nonnegative(),
});

export const ApplyReconcileResponseSchema = z.object({
    appliedExternalIds: z.number().int().nonnegative(),
    updatedTitles: z.number().int().nonnegative(),
});

export type ReconcilePreviewResponse = z.infer<typeof ReconcilePreviewResponseSchema>;
export type ApplyReconcileResponse = z.infer<typeof ApplyReconcileResponseSchema>;

const AUTO_APPLY_CONFIDENCE = RECONCILE_AUTO_APPLY_CONFIDENCE;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            const preview = await previewReconciliation(sql, internalId, {
                threshold: RECONCILE_PREVIEW_CONFIDENCE,
            });
            return json(ReconcilePreviewResponseSchema.parse(preview));
        },

        POST: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            const body = await extractBody(event.request);
            const rawConfidence =
                isRecord(body) && typeof body.minConfidence === 'number'
                    ? body.minConfidence
                    : AUTO_APPLY_CONFIDENCE;
            const minConfidence = Math.min(1, Math.max(0.5, rawConfidence));
            const episodeIds =
                isRecord(body) && Array.isArray(body.episodeIds)
                    ? (body.episodeIds as unknown[]).filter(
                          (x): x is string => typeof x === 'string',
                      )
                    : undefined;

            const result = await applyReconciliation(sql, internalId, minConfidence, episodeIds);
            return json(ApplyReconcileResponseSchema.parse(result));
        },
    },
});
