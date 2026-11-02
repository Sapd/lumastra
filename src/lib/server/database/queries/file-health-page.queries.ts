// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type postgres from 'postgres';
import {
    FileHealthScopeSchema,
    FileHealthCursorSchema,
    type FileHealthScope,
} from '$lib/schemas/admin-file-health.js';
import { fullyReviewedHealthFileSql } from './file-health-review.queries.js';
import { informationalRangeFileSql } from './range-mapping-proof.queries.js';
import { getAdminRangeMappings } from './range-mapping-proof.queries.js';
import { getAdminTailAssessments } from './file-health-assessment.queries.js';
import { boundedAdminHealthIssuesSql } from './file-health-classification.queries.js';
import type { FileHealthRow } from './media-files.queries.js';
import type { AudioTailAssessment } from '$lib/schemas/audio-tail-assessment.js';
import type { AdminRangeMapping } from '$lib/schemas/range-mapping-proof.js';

export interface FileHealthPageOptions {
    scope: FileHealthScope;
    cursor?: string;
    limit?: number;
}
export interface ProjectedFileHealthIssue {
    type: string;
    detected_at: string;
    detail?: string;
    basis?: string;
    reviewed?: boolean;
    expected_duration?: number;
    actual_duration?: number;
}
export interface FileHealthPageRow extends Omit<FileHealthRow, 'health_issues'> {
    health_issues: ProjectedFileHealthIssue[];
    classification: 'actionable' | 'informational' | 'reviewed';
    updatedAt: string;
    is_missing: boolean;
    link_count: number;
    tailAssessment?: AudioTailAssessment;
    rangeMapping?: AdminRangeMapping;
}
export interface FileHealthPage {
    files: FileHealthPageRow[];
    /** Compatibility: recorded physical files, regardless of the selected scope. */
    count: number;
    recorded: number;
    actionable: number;
    informational: number;
    reviewed: number;
    matching: number;
    nextCursor: string | null;
    snapshotAt: string;
    scope: FileHealthScope;
}
interface CountRow {
    recorded: string;
    actionable: string;
    informational: string;
    reviewed: string;
    matching: string;
    snapshot_at: string;
}
interface DbPageRow extends Omit<FileHealthRow, 'health_issues'> {
    health_issues: ProjectedFileHealthIssue[];
    classification: 'actionable' | 'informational' | 'reviewed';
    updated_at_cursor: string;
    is_missing: boolean;
    link_count: number;
}
const PAGE_LIMIT = 50;

/** One short repeatable-read snapshot: counts, page, and admin-only evidence. */
export async function getFileHealthPage(
    sql: postgres.Sql,
    options: FileHealthPageOptions,
): Promise<FileHealthPage> {
    const scope = FileHealthScopeSchema.parse(options.scope);
    const cursor = options.cursor ? FileHealthCursorSchema.parse(options.cursor) : undefined;
    const limit = Math.min(Math.max(options.limit ?? PAGE_LIMIT, 1), 100);
    const cursorTime = cursor?.slice(0, 27);
    const cursorId = cursor?.slice(28);
    return sql.begin('isolation level repeatable read read only', async (rawTx) => {
        const tx = rawTx as unknown as postgres.Sql;
        const [counts] = await tx<CountRow[]>`
            WITH classified AS MATERIALIZED (
                SELECT mf.id, ${informationalRangeFileSql(tx, tx`mf.id`)} AS informational, ${fullyReviewedHealthFileSql(tx, tx`mf.id`)} AS reviewed
                FROM media_files mf
                WHERE mf.health_issues IS NOT NULL AND mf.health_issues <> '[]'::jsonb
            )
            SELECT COUNT(*)::text AS recorded,
                   COUNT(*) FILTER (WHERE NOT informational AND NOT reviewed)::text AS actionable,
                   COUNT(*) FILTER (WHERE informational)::text AS informational,
                   COUNT(*) FILTER (WHERE reviewed)::text AS reviewed,
                   COUNT(*) FILTER (WHERE ${scope} = 'all' OR
                       (${scope} = 'informational' AND informational) OR
                       (${scope} = 'reviewed' AND reviewed) OR
                       (${scope} = 'actionable' AND NOT informational AND NOT reviewed))::text AS matching,
                   statement_timestamp()::text AS snapshot_at
            FROM classified`;
        // The endpoint is admin-only; the linked item is a representative label for that admin view.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        const rows = await tx<DbPageRow[]>`
            WITH classified AS MATERIALIZED (
                SELECT mf.id, mf.updated_at, ${informationalRangeFileSql(tx, tx`mf.id`)} AS informational, ${fullyReviewedHealthFileSql(tx, tx`mf.id`)} AS reviewed
                FROM media_files mf
                WHERE mf.health_issues IS NOT NULL AND mf.health_issues <> '[]'::jsonb
            ), page AS (
                SELECT * FROM classified c
                WHERE (${scope} = 'all' OR
                    (${scope} = 'informational' AND c.informational) OR
                    (${scope} = 'reviewed' AND c.reviewed) OR
                    (${scope} = 'actionable' AND NOT c.informational AND NOT c.reviewed))
                  AND (${cursorTime ?? null}::timestamptz IS NULL OR
                       (c.updated_at, c.id) < (${cursorTime ?? null}::timestamptz, ${cursorId ?? null}::uuid))
                ORDER BY c.updated_at DESC, c.id DESC
                LIMIT ${limit + 1}
            )
            SELECT p.id AS file_id, mf.file_path, mf.duration_seconds, mf.is_missing,
                   (SELECT COUNT(*)::int FROM media_file_items linked WHERE linked.file_id = p.id) AS link_count,
                   ${boundedAdminHealthIssuesSql(tx, tx`mf.health_issues`, tx`p.updated_at`, tx`mf.id`)} AS health_issues,
                   representative.id AS media_item_id, representative.title,
                   representative.media_type, representative.year,
                   CASE WHEN p.informational THEN 'informational' WHEN p.reviewed THEN 'reviewed' ELSE 'actionable' END AS classification,
                   to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_cursor
            FROM page p
            JOIN media_files mf ON mf.id = p.id
            LEFT JOIN LATERAL (
                SELECT mi.id, mi.title, mi.media_type, mi.year
                FROM media_file_items mfi JOIN media_items mi ON mi.id = mfi.media_item_id
                WHERE mfi.file_id = p.id
                ORDER BY mi.season_number NULLS FIRST, mi.episode_number NULLS FIRST, mi.id
                LIMIT 1
            ) representative ON true
            ORDER BY p.updated_at DESC, p.id DESC`;
        const hasMore = rows.length > limit;
        const visible = rows.slice(0, limit);
        const ids = visible.map((row) => row.file_id);
        const [assessments, mappings] = await Promise.all([
            getAdminTailAssessments(tx, ids),
            getAdminRangeMappings(tx, ids),
        ]);
        const files = visible.map((row): FileHealthPageRow => ({
            ...row,
            updatedAt: row.updated_at_cursor,
            tailAssessment: assessments.get(row.file_id),
            rangeMapping: row.health_issues.some((issue) => issue.type === 'range_superseded')
                ? (mappings.get(row.file_id) ?? { state: 'unproven' })
                : undefined,
        }));
        const last = files.at(-1);
        const recorded = Number(counts?.recorded ?? 0);
        return {
            files,
            count: recorded,
            recorded,
            actionable: Number(counts?.actionable ?? 0),
            informational: Number(counts?.informational ?? 0),
            reviewed: Number(counts?.reviewed ?? 0),
            matching: Number(counts?.matching ?? 0),
            nextCursor: hasMore && last ? `${last.updatedAt}_${last.file_id}` : null,
            snapshotAt: counts?.snapshot_at ?? '',
            scope,
        };
    });
}
