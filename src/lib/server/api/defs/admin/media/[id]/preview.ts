// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/preview.ts
 *
 * GET /api/admin/media/[id]/preview
 *
 * Lightweight preview data for inline row expansion in the admin media browser.
 * Uses the canonical media-item shape for media-preview usage (canonical type,
 * no raw posterUrl/imageUrl).
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: MediaPreviewData (bare object — see getMediaPreview shape)
 * 503 dependency_unavailable when DB is down.
 */

import { AudioTailAssessmentSchema } from '$lib/schemas/audio-tail-assessment.js';
import { getAdminTailAssessmentsForMedia } from '$lib/server/database/queries/file-health-assessment.queries.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { getDb } from '$lib/server/database/connection.js';
import { getMediaPreview } from '$lib/server/database/queries/admin-media.queries.js';
import { toPublicMediaType } from '$lib/shared/media-type-domain';

// ---------------------------------------------------------------------------
// Response schema (mirrors MediaPreviewData with canonical media type)
// ---------------------------------------------------------------------------

export const AdminPreviewResponseSchema = z.object({
    id: z.string(),
    title: z.string().nullable(),
    overview: z.string().nullable(),
    year: z.number().nullable(),
    media_type: z.string(), // canonical: 'series' for TV, etc.
    runtime_seconds: z.number().nullable(),
    premiere_date: z.string().nullable(),
    externalIds: z.object({
        tmdb: z.string().optional(),
        imdb: z.string().optional(),
        jellyfin: z.string().optional(),
        tvdb: z.string().optional(),
    }),
    fileCount: z.number().int().nonnegative(),
    totalFileSize: z.number().nullable(),
    filePaths: z.array(z.string()),
    seasons: z
        .array(
            z.object({
                seasonNumber: z.number().int(),
                episodeCount: z.number().int(),
                linkedCount: z.number().int(),
            }),
        )
        .optional(),
    audioFeatures: z
        .object({
            bpm: z.number().nullable(),
            key: z.string().nullable(),
            energy: z.number().nullable(),
        })
        .optional(),
    parentTitle: z.string().optional(),
    grandparentTitle: z.string().optional(),
    // Inspector-panel additions (spec: admin media browser inspector panel).
    // All `.optional()`, never bare `.nullable()` — this schema's `.parse()`
    // runs server-side and Zod `.nullable()` rejects `undefined`, which is
    // exactly what happens for a field that legitimately doesn't apply to a
    // given item (e.g. no lock, no health issues, no video stream).
    metadataLocked: z.boolean().optional(),
    lockedBy: z.string().optional(),
    lockedAt: z.string().optional(),
    isLocalOnly: z.boolean().optional(),
    filesLostAt: z.string().optional(),
    lastProbedAt: z.string().optional(),
    lastUpdatedAt: z.string().optional(),
    healthStatus: z.string().optional(),
    tailAssessments: z
        .array(z.object({ fileId: z.string(), assessment: AudioTailAssessmentSchema }))
        .optional(),
    healthIssuesOmitted: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Number of additional actionable findings beyond the 20-row preview limit'),
    healthIssues: z
        .array(
            z.object({
                type: z.string(),
                detail: z.string().optional(),
                filePath: z.string().optional(),
                expectedDuration: z.number().optional(),
                basis: z.enum(['duration_comparison', 'premature_eof']).optional(),
                actualDuration: z.number().optional(),
            }),
        )
        .optional(),
    videoCodec: z.string().optional(),
    videoWidth: z.number().optional(),
    videoHeight: z.number().optional(),
    videoRange: z.string().optional(),
    audioCodec: z.string().optional(),
    audioChannels: z.number().optional(),
});

export type AdminPreviewResponse = z.infer<typeof AdminPreviewResponseSchema>;

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

            const preview = await getMediaPreview(sql, internalId);
            if (!preview) return ApiProblem.notFound('Media item not found');

            const assessments = await getAdminTailAssessmentsForMedia(sql, internalId);
            // Remap media_type to canonical public value
            return json(
                AdminPreviewResponseSchema.parse({
                    ...preview,
                    tailAssessments: Array.from(assessments, ([fileId, assessment]) => ({
                        fileId,
                        assessment,
                    })),
                    media_type: toPublicMediaType(preview.media_type) ?? preview.media_type,
                }),
            );
        },
    },
});
