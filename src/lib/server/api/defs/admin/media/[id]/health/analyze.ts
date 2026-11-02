// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/health/analyze.ts
 *
 * POST /api/admin/media/[id]/health/analyze
 *
 * Triggers fresh identity-based health analysis for a series (local DB only,
 * no external API calls). Returns the computed report or null if no
 * non-standard ordering is active.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { report: HealthReport | null, message?: string }
 * 503 dependency_unavailable when DB is down.
 */

import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { checkOrderingHealth } from '$lib/server/services/series-health.service.js';

// ---------------------------------------------------------------------------
// Response schema (typed from IdentityHealthReport)
// ---------------------------------------------------------------------------

const UnlinkedEpisodeSchema = z.object({
    orderSeasonNumber: z.number().int().nullable(),
    orderEpisodeNumber: z.number().int(),
    episodeTitle: z.string().nullable(),
});

const IdentityHealthReportSchema = z.object({
    status: z.enum(['healthy', 'warning', 'mismatch', 'unknown']),
    orderingType: z.string(),
    orderingGroupId: z.string().nullable(),
    total: z.number().int().nonnegative(),
    linked: z.number().int().nonnegative(),
    unlinked: z.number().int().nonnegative(),
    linkRatio: z.number(),
    unlinkedEpisodes: z.array(UnlinkedEpisodeSchema),
});

export const HealthAnalyzeResponseSchema = z.object({
    report: IdentityHealthReportSchema.nullable(),
    message: z.string().optional(),
});

export type HealthAnalyzeResponse = z.infer<typeof HealthAnalyzeResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        POST: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            const report = await checkOrderingHealth(sql, internalId);
            if (!report) {
                return json(
                    HealthAnalyzeResponseSchema.parse({
                        report: null,
                        message: 'No non-standard ordering active for this series',
                    }),
                );
            }
            return json(HealthAnalyzeResponseSchema.parse({ report }));
        },
    },
});
