// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type postgres from 'postgres';
import { analyzerFileGenerationSql } from './media-segment-input.queries.js';
import { healthStreamSignatureSql } from './file-health-assessment.queries.js';
import { fullyReviewedHealthFileSql } from './file-health-review.queries.js';

/** Bump when packet/audio eligibility or duration assessment rules change. */
export const FILE_HEALTH_RULE_VERSION = 1;
export const FILE_HEALTH_RECHECK_BATCH = 20;

export interface FileHealthRecheckCandidate {
    fileId: string;
    inputKey: string;
}

function inputKeySql(
    sql: postgres.Sql,
    ruleVersion: number,
): postgres.PendingQuery<postgres.Row[]> {
    // Findings/assessment dates and measurements are outputs, never a fresh retry budget.
    return sql`md5(jsonb_build_array(${ruleVersion}::integer,
        ${analyzerFileGenerationSql(sql)}, ${healthStreamSignatureSql(sql)})::text)`;
}

function candidatesSql(
    sql: postgres.Sql,
    ruleVersion: number,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`SELECT mf.id AS "fileId", ${inputKeySql(sql, ruleVersion)} AS "inputKey"
        FROM media_files mf
        WHERE NOT mf.is_missing
          AND CASE WHEN jsonb_typeof(mf.health_issues) = 'array'
            THEN jsonb_array_length(mf.health_issues) BETWEEN 1 AND 20 ELSE false END
          AND octet_length(mf.health_issues::text) <= 65536
          AND (mf.health_issues @> '[{"type":"truncated_video"}]'::jsonb
            OR mf.health_issues @> '[{"type":"video_ends_early"}]'::jsonb
            OR mf.health_issues @> '[{"type":"duration_mismatch"}]'::jsonb)
          AND (mf.health_tail_assessment->>'ruleVersion' IS DISTINCT FROM ${String(ruleVersion)}
            OR NOT ${fullyReviewedHealthFileSql(sql, sql`mf.id`)})`;
}

export async function listDueFileHealthRechecks(
    sql: postgres.Sql,
    ruleVersion = FILE_HEALTH_RULE_VERSION,
): Promise<FileHealthRecheckCandidate[]> {
    return sql<FileHealthRecheckCandidate[]>`
        WITH candidates AS (${candidatesSql(sql, ruleVersion)})
        SELECT c.* FROM candidates c
        LEFT JOIN media_file_health_rechecks r ON r.file_id = c."fileId" AND r.input_key = c."inputKey"
        WHERE r.file_id IS NULL OR (NOT r.settled AND r.attempts < 3 AND r.next_attempt_at <= now())
        ORDER BY r.next_attempt_at NULLS FIRST, c."fileId"
        LIMIT ${FILE_HEALTH_RECHECK_BATCH}`;
}

/** Atomic across replicas; revalidates the selected generation before consuming an attempt. */
export async function claimFileHealthRecheck(
    sql: postgres.Sql,
    candidate: FileHealthRecheckCandidate,
    ruleVersion = FILE_HEALTH_RULE_VERSION,
): Promise<boolean> {
    const rows = await sql`
        INSERT INTO media_file_health_rechecks AS r
            (file_id, input_key, rule_version, attempts, next_attempt_at, observations)
        SELECT mf.id, c."inputKey", ${ruleVersion}, 1, now() + interval '1 hour',
            jsonb_build_array(jsonb_build_object('at', now(), 'issues', mf.health_issues,
                'assessment', CASE WHEN octet_length(mf.health_tail_assessment::text) <= 32768
                    THEN mf.health_tail_assessment END))
        FROM (${candidatesSql(sql, ruleVersion)}) c JOIN media_files mf ON mf.id = c."fileId"
        WHERE c."fileId" = ${candidate.fileId}::uuid AND c."inputKey" = ${candidate.inputKey}
        ON CONFLICT (file_id, input_key) DO UPDATE SET
            attempts = r.attempts + 1,
            next_attempt_at = now() + interval '24 hours',
            observations = r.observations || EXCLUDED.observations
        WHERE NOT r.settled AND r.attempts < 3 AND r.next_attempt_at <= now()
        RETURNING file_id`;
    return rows.length > 0;
}

export async function settleFileHealthRecheck(
    sql: postgres.Sql,
    candidate: FileHealthRecheckCandidate,
): Promise<void> {
    await sql`UPDATE media_file_health_rechecks SET settled = true
        WHERE file_id = ${candidate.fileId}::uuid AND input_key = ${candidate.inputKey}`;
}
