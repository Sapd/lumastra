// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { fullyReviewedHealthFileSql } from '$lib/server/database/queries/file-health-review.queries.js';

/**
 * defs/admin/media/[id]/files.ts
 *
 * GET /api/admin/media/[id]/files[?children=true]
 *
 * Returns media_files records linked to a media item.
 * With ?children=true: includes files linked to descendant seasons/episodes.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { files: FileRow[] | FileRowWithChildren[] }
 * 503 dependency_unavailable when DB is down.
 */

import { getFileAssociationCounts } from '$lib/server/database/queries/admin-file-associations.queries.js';
import { getFileLanguageSummaries } from '$lib/server/database/queries/admin-language-summary.queries.js';
import { AudioTailAssessmentSchema } from '$lib/schemas/audio-tail-assessment.js';
import { AdminFileHealthIssueSchema } from '$lib/schemas/admin-file-health.js';
import {
    boundedAdminHealthIssuesSql,
    recordedFileHealthSql,
    actionableFileHealthSql,
} from '$lib/server/database/queries/file-health-classification.queries.js';
import { getAdminTailAssessments } from '$lib/server/database/queries/file-health-assessment.queries.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { getDb } from '$lib/server/database/connection.js';
import { MediaFilesResponseSchema } from '$lib/schemas/api-media-responses.js';

// ---------------------------------------------------------------------------
// Response schema — single source in $lib/schemas/api-media-responses.
// Models the base file row plus the child-context fields added when
// ?children=true. Also referenced by the v1 _openapi.ts at
// routes/api/v1/media/[id]/files.
// ---------------------------------------------------------------------------

const adminHealthFields = {
    health_issues: z.array(AdminFileHealthIssueSchema).nullable(),
    health_classification: z.enum(['none', 'actionable', 'informational', 'reviewed']),
};
export const FilesResponseSchema = MediaFilesResponseSchema.extend({
    files: z.array(
        z.union([
            MediaFilesResponseSchema.shape.files.element.options[0].extend({
                ...adminHealthFields,
                tailAssessment: AudioTailAssessmentSchema.optional(),
                linked_media_count: z
                    .number()
                    .int()
                    .min(0)
                    .describe('Global media associations for this physical file'),
            }),
            MediaFilesResponseSchema.shape.files.element.options[1].extend({
                ...adminHealthFields,
                tailAssessment: AudioTailAssessmentSchema.optional(),
                linked_media_count: z
                    .number()
                    .int()
                    .min(0)
                    .describe('Global media associations for this physical file'),
            }),
        ]),
    ),
});

export type FilesResponse = z.infer<typeof FilesResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        query: z.object({
            children: z.enum(['true', 'false']).optional(),
        }),
    },
    handlers: {
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            const includeChildren = ctx.input?.query?.children === 'true';

            if (includeChildren) {
                const files = await sql`
                    SELECT mf.id, mf.file_path, mf.edition, mf.part_number,
                           mf.library_group_id, mf.created_at,
                           -- ::text, not raw. file_size_bytes is bigint, and the pool
                           -- in connection.ts parses bigint (OID 20) to a JS number —
                           -- but MediaFilesResponseSchema (which documents this body,
                           -- and from which the v1 twin's OpenAPI + Swift decoder are
                           -- generated) declares it z.string().nullable(). Left raw
                           -- the wire disagreed with the published contract on every
                           -- row: mount()'s response audit logs the drift in prod, and
                           -- MediaFileInfoModal already carried a
                           -- typeof === 'number' ? String(x) workaround for it.
                           mf.file_size_bytes::text AS file_size_bytes,
                           mf.duration_seconds,
                           mf.container_format, mf.file_mtime,
                           mf.file_hash_head, mf.probed_at,
                           ${boundedAdminHealthIssuesSql(sql, sql`mf.health_issues`, sql`mf.updated_at`, sql`mf.id`)} AS health_issues,
                           CASE WHEN NOT ${recordedFileHealthSql(sql, sql`mf.id`)} THEN 'none'
                                WHEN ${actionableFileHealthSql(sql, sql`mf.id`)} THEN 'actionable'
                                WHEN ${fullyReviewedHealthFileSql(sql, sql`mf.id`)} THEN 'reviewed'
                                ELSE 'informational' END AS health_classification,
                           mfi.media_item_id,
                           mfi.is_default,
                           mfi.sort_order AS file_sort_order,
                           mfi.label AS file_label,
                           mi.title AS media_title, mi.media_type,
                           mi.season_number, mi.episode_number
                    FROM media_files mf
                    JOIN media_file_items mfi ON mfi.file_id = mf.id
                    JOIN media_items mi ON mi.id = mfi.media_item_id
                    WHERE mfi.media_item_id IN (
                        SELECT id FROM media_items WHERE id = ${internalId}
                        UNION ALL
                        SELECT id FROM media_items WHERE parent_id = ${internalId}
                        UNION ALL
                        SELECT ep.id FROM media_items ep
                        JOIN media_items s ON s.id = ep.parent_id
                        WHERE s.parent_id = ${internalId}
                    )
                    ORDER BY mi.season_number NULLS LAST,
                             mi.episode_number NULLS LAST,
                             mf.file_path
                `;
                const languages = await getFileLanguageSummaries(
                    sql,
                    files.map((file) => String(file.id)),
                );
                const assessments = await getAdminTailAssessments(
                    sql,
                    files.map((file) => String(file.id)),
                );
                const counts = await getFileAssociationCounts(
                    sql,
                    files.map((file) => String(file.id)),
                );
                return json({
                    files: files.map((file) => ({
                        linked_media_count: counts.get(String(file.id)) ?? 0,
                        tailAssessment: assessments.get(String(file.id)),
                        ...file,
                        language_summary: languages.get(String(file.id)),
                    })),
                });
            } else {
                const files = await sql`
                    SELECT mf.id, mf.file_path, mf.edition, mf.part_number,
                           mf.library_group_id, mf.created_at,
                           -- ::text, not raw. file_size_bytes is bigint, and the pool
                           -- in connection.ts parses bigint (OID 20) to a JS number —
                           -- but MediaFilesResponseSchema (which documents this body,
                           -- and from which the v1 twin's OpenAPI + Swift decoder are
                           -- generated) declares it z.string().nullable(). Left raw
                           -- the wire disagreed with the published contract on every
                           -- row: mount()'s response audit logs the drift in prod, and
                           -- MediaFileInfoModal already carried a
                           -- typeof === 'number' ? String(x) workaround for it.
                           mf.file_size_bytes::text AS file_size_bytes,
                           mf.duration_seconds,
                           mf.container_format, mf.file_mtime,
                           mf.file_hash_head, mf.probed_at,
                           ${boundedAdminHealthIssuesSql(sql, sql`mf.health_issues`, sql`mf.updated_at`, sql`mf.id`)} AS health_issues,
                           CASE WHEN NOT ${recordedFileHealthSql(sql, sql`mf.id`)} THEN 'none'
                                WHEN ${actionableFileHealthSql(sql, sql`mf.id`)} THEN 'actionable'
                                WHEN ${fullyReviewedHealthFileSql(sql, sql`mf.id`)} THEN 'reviewed'
                                ELSE 'informational' END AS health_classification,
                           mfi.media_item_id,
                           mfi.is_default,
                           mfi.sort_order AS file_sort_order,
                           mfi.label AS file_label
                    FROM media_file_items mfi
                    JOIN media_files mf ON mf.id = mfi.file_id
                    WHERE mfi.media_item_id = ${internalId}
                    ORDER BY mf.file_path
                `;
                const languages = await getFileLanguageSummaries(
                    sql,
                    files.map((file) => String(file.id)),
                );
                const assessments = await getAdminTailAssessments(
                    sql,
                    files.map((file) => String(file.id)),
                );
                const counts = await getFileAssociationCounts(
                    sql,
                    files.map((file) => String(file.id)),
                );
                return json({
                    files: files.map((file) => ({
                        linked_media_count: counts.get(String(file.id)) ?? 0,
                        tailAssessment: assessments.get(String(file.id)),
                        ...file,
                        language_summary: languages.get(String(file.id)),
                    })),
                });
            }
        },
    },
});
