// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type postgres from 'postgres';
import { analyzerFileGenerationSql } from './media-segment-input.queries.js';
import { healthStreamSignatureSql } from './file-health-assessment.queries.js';

export interface FileHealthReviewSourceRow {
    id: string;
    file_path: string;
    file_size_bytes: string | null;
    file_mtime: Date | null;
    file_hash_head: string | null;
    duration_seconds: number | null;
    is_missing: boolean;
    health_issues: unknown;
    health_tail_assessment: unknown;
    generation: string;
    streams: string;
    assessment_signature: string | null;
    review_version: string;
}
export interface FileHealthReviewRecord {
    id: string;
    file_id: string;
    issue_type: 'duration_mismatch' | 'video_ends_early' | 'truncated_video';
    issue_key: string;
    source_generation: string;
    stream_signature: string;
    assessment_signature: string;
    source_snapshot: Record<string, unknown>;
    raw_issue: Record<string, unknown>;
    assessment_snapshot: Record<string, unknown>;
    reason: string;
    evidence: string;
    decided_by: string;
    decided_at: Date;
    revoked_at: Date | null;
    current: boolean;
}

/** Observation/retry dates are bookkeeping, not a new duration finding. */
export function healthFindingKeySql(
    sql: postgres.Sql,
    issue: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`encode(sha256(convert_to((${issue} - 'detected_at' - 'attempt_count' - 'next_retry_at')::text, 'UTF8')), 'hex')`;
}
export function healthAssessmentKeySql(
    sql: postgres.Sql,
    assessment: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`encode(sha256(convert_to((${assessment} - 'measuredAt' - 'reviewedIssues' - 'ruleVersion')::text, 'UTF8')), 'hex')`;
}
function reviewElementsSql(
    sql: postgres.Sql,
    raw: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`SELECT ${raw}->issue_index AS elem FROM generate_series(0,
        CASE WHEN jsonb_typeof(${raw})='array' THEN LEAST(jsonb_array_length(${raw}),20)-1 ELSE -1 END) issue_index`;
}
export function hardFileHealthFailureSql(
    sql: postgres.Sql,
    raw: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`EXISTS (SELECT 1 FROM (${reviewElementsSql(sql, raw)}) hard_issue
        WHERE hard_issue.elem->>'basis'='premature_eof'
           OR hard_issue.elem->>'type' IN ('container_unreadable','no_keyframes','video_decode_gaps'))`;
}
function reviewMatchesSql(
    sql: postgres.Sql,
    reviewAlias: string,
    fileAlias: string,
    issue: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    const r = sql(reviewAlias),
        f = sql(fileAlias);
    return sql`${r}.revoked_at IS NULL AND ${r}.file_id=${f}.id AND ${f}.is_missing IS NOT TRUE
        AND ${r}.issue_type=${issue}->>'type' AND (${issue}->>'basis' IS NULL OR ${issue}->>'basis'='duration_comparison')
        AND ${r}.issue_key=${healthFindingKeySql(sql, issue)}
        AND ${r}.source_generation=${analyzerFileGenerationSql(sql, fileAlias)}
        AND ${r}.stream_signature=${healthStreamSignatureSql(sql, fileAlias)}
        AND ${r}.assessment_signature=${healthAssessmentKeySql(sql, sql`${f}.health_tail_assessment`)}
        AND NOT ${hardFileHealthFailureSql(sql, sql`${f}.health_issues`)}`;
}

/** Expensive source/inventory comparison runs only for an actual review candidate. */
export function currentHealthIssueReviewSql(
    sql: postgres.Sql,
    fileId: postgres.PendingQuery<postgres.Row[]>,
    issue: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`CASE WHEN ${issue}->>'type' IN ('duration_mismatch','video_ends_early','truncated_video')
        AND EXISTS (SELECT 1 FROM media_file_health_reviews candidate
            WHERE candidate.file_id=${fileId} AND candidate.issue_type=${issue}->>'type' AND candidate.revoked_at IS NULL)
        THEN EXISTS (SELECT 1 FROM media_file_health_reviews hr JOIN media_files reviewed_file ON reviewed_file.id=hr.file_id
            WHERE hr.file_id=${fileId} AND ${reviewMatchesSql(sql, 'hr', 'reviewed_file', issue)})
        ELSE false END`;
}

/** Unknown, oversized, mixed or genuinely failed evidence can never be fully reviewed. */
export function fullyReviewedHealthFileSql(
    sql: postgres.Sql,
    fileId: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`CASE WHEN EXISTS (SELECT 1 FROM media_file_health_reviews candidate WHERE candidate.file_id=${fileId} AND candidate.revoked_at IS NULL)
        THEN EXISTS (SELECT 1 FROM media_files review_file WHERE review_file.id=${fileId}
            AND CASE WHEN jsonb_typeof(review_file.health_issues)='array'
                THEN jsonb_array_length(review_file.health_issues) BETWEEN 1 AND 20 ELSE false END
            AND NOT EXISTS (SELECT 1 FROM (${reviewElementsSql(sql, sql`review_file.health_issues`)}) raw_issue
                WHERE NOT ${currentHealthIssueReviewSql(sql, sql`review_file.id`, sql`raw_issue.elem`)}))
        ELSE false END`;
}

/** Legacy duration events remain history; only the current file's proven reviewed state suppresses their current actionability. */
export function reviewedDurationFailureSql(
    sql: postgres.Sql,
    itemId: postgres.PendingQuery<postgres.Row[]>,
    reason: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`CASE WHEN ${reason} IN ('duration_mismatch','video_ends_early','truncated_video')
        THEN ${fullyReviewedHealthFileSql(sql, sql`CASE WHEN ${itemId}::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN ${itemId}::uuid END`)}
        ELSE false END`;
}

export async function getHealthReviewSource(
    sql: postgres.Sql,
    fileId: string,
): Promise<FileHealthReviewSourceRow | undefined> {
    const [row] = await sql<FileHealthReviewSourceRow[]>`
        SELECT mf.id,mf.file_path,mf.file_size_bytes::text,mf.file_mtime,mf.file_hash_head,mf.duration_seconds,mf.is_missing,
            CASE WHEN octet_length(mf.health_issues::text)<=65536 THEN mf.health_issues END AS health_issues,
            CASE WHEN octet_length(mf.health_tail_assessment::text)<=32768 THEN mf.health_tail_assessment END AS health_tail_assessment,
            ${analyzerFileGenerationSql(sql)} AS generation,${healthStreamSignatureSql(sql)} AS streams,
            ${healthAssessmentKeySql(sql, sql`mf.health_tail_assessment`)} AS assessment_signature,
            md5(COALESCE((SELECT string_agg(hr.id::text || ':' || COALESCE(hr.revoked_at::text,''), ',' ORDER BY hr.id)
                FROM media_file_health_reviews hr WHERE hr.file_id=mf.id),'')) AS review_version
        FROM media_files mf WHERE mf.id=${fileId}::uuid`;
    return row;
}
export async function getReviewFindingKeys(
    sql: postgres.Sql,
    fileId: string,
): Promise<Array<{ issue_key: string; raw_issue: Record<string, unknown> }>> {
    return sql<{ issue_key: string; raw_issue: Record<string, unknown> }[]>`
        SELECT ${healthFindingKeySql(sql, sql`raw_issue.elem`)} AS issue_key,raw_issue.elem AS raw_issue
        FROM media_files mf CROSS JOIN LATERAL (${reviewElementsSql(sql, sql`mf.health_issues`)}) raw_issue
        WHERE mf.id=${fileId}::uuid AND octet_length(mf.health_issues::text)<=65536
          AND jsonb_typeof(raw_issue.elem)='object'`;
}
export async function listHealthReviewHistory(
    sql: postgres.Sql,
    fileId: string,
): Promise<FileHealthReviewRecord[]> {
    return sql<FileHealthReviewRecord[]>`
        SELECT hr.*,COALESCE(EXISTS (SELECT 1 FROM (${reviewElementsSql(sql, sql`mf.health_issues`)}) raw_issue
            WHERE ${reviewMatchesSql(sql, 'hr', 'mf', sql`raw_issue.elem`)}),false) AS current
        FROM media_file_health_reviews hr LEFT JOIN media_files mf ON mf.id=hr.file_id
        WHERE hr.file_id=${fileId}::uuid ORDER BY current DESC,hr.decided_at DESC,hr.id DESC LIMIT 50`;
}
export async function insertHealthReview(
    sql: postgres.Sql,
    input: {
        fileId: string;
        issueType: string;
        issueKey: string;
        generation: string;
        streams: string;
        assessmentSignature: string;
        sourceSnapshot: Record<string, unknown>;
        rawIssue: Record<string, unknown>;
        assessment: Record<string, unknown>;
        reason: string;
        evidence: string;
        actor: string;
    },
): Promise<string | undefined> {
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO media_file_health_reviews (file_id,issue_type,issue_key,source_generation,stream_signature,assessment_signature,
            source_snapshot,raw_issue,assessment_snapshot,reason,evidence,decided_by)
        VALUES (${input.fileId}::uuid,${input.issueType},${input.issueKey},${input.generation},${input.streams},${input.assessmentSignature},
            ${sql.json(input.sourceSnapshot as postgres.JSONValue)},${sql.json(input.rawIssue as postgres.JSONValue)},${sql.json(input.assessment as postgres.JSONValue)},
            ${input.reason},${input.evidence},${input.actor})
        ON CONFLICT DO NOTHING RETURNING id`;
    return row?.id;
}
export async function revokeHealthReview(
    sql: postgres.Sql,
    fileId: string,
    reviewId: string,
    actor: string,
    identity?: { userId?: string; kind?: string; credentialId?: string },
): Promise<boolean> {
    const rows =
        await sql`UPDATE media_file_health_reviews SET revoked_at=now(),revoked_by=${actor},
        revoked_principal_id=${identity?.userId ?? null},revoked_principal_kind=${identity?.kind ?? null},revoked_credential_id=${identity?.credentialId ?? null}
        WHERE id=${reviewId}::uuid AND file_id=${fileId}::uuid AND revoked_at IS NULL RETURNING id`;
    return rows.count > 0;
}
