// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type postgres from 'postgres';
import {
    fullyReviewedHealthFileSql,
    currentHealthIssueReviewSql,
} from './file-health-review.queries.js';
import { informationalRangeFileSql } from './range-mapping-proof.queries.js';

/** A physical row with recorded evidence, including malformed or unsupported JSON. */
export function recordedFileHealthSql(
    sql: postgres.Sql,
    fileId: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`EXISTS (
        SELECT 1 FROM media_files health_record
        WHERE health_record.id = ${fileId}
          AND health_record.health_issues IS NOT NULL
          AND health_record.health_issues <> '[]'::jsonb
    )`;
}

/** Only a sole, positively current range-mapping observation is informational. */
export function actionableFileHealthSql(
    sql: postgres.Sql,
    fileId: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`CASE WHEN ${recordedFileHealthSql(sql, fileId)}
        THEN NOT ${informationalRangeFileSql(sql, fileId)} AND NOT ${fullyReviewedHealthFileSql(sql, fileId)} ELSE false END`;
}

/** Keep duration metadata finite in JavaScript; preserve small legacy numeric strings. */
export function boundedHealthDurationSql(
    sql: postgres.Sql,
    value: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`CASE
        WHEN jsonb_typeof(${value}) = 'number' THEN
            CASE WHEN abs((${value} #>> '{}')::numeric) <= 1e100::numeric THEN ${value} END
        WHEN jsonb_typeof(${value}) = 'string' THEN
            CASE WHEN length(${value} #>> '{}') <= 64 THEN
                CASE WHEN (${value} #>> '{}') ~ '^-?[0-9]+([.][0-9]+)?$' THEN
                    CASE WHEN abs((${value} #>> '{}')::numeric) <= 1e100::numeric
                        THEN to_jsonb((${value} #>> '{}')::numeric) END
                END
            END
        END`;
}

/** Index only the first 20 entries; a large array is never expanded by an SRF. */
export function boundedHealthIssueElementsSql(
    sql: postgres.Sql,
    raw: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`SELECT CASE WHEN jsonb_typeof(${raw}) = 'array'
            THEN ${raw}->issue_index
            ELSE jsonb_build_object('type', 'unknown_recorded_evidence') END AS elem,
        issue_index + 1 AS ordinal
        FROM generate_series(0, CASE WHEN jsonb_typeof(${raw}) = 'array'
            THEN LEAST(jsonb_array_length(${raw}), 20) - 1 ELSE 0 END) AS issue_index`;
}

/** Bounded admin-only warning projection; never put this unknown-type shape on v1. */
export function boundedAdminHealthIssuesSql(
    sql: postgres.Sql,
    raw: postgres.PendingQuery<postgres.Row[]>,
    updatedAt: postgres.PendingQuery<postgres.Row[]>,
    fileId?: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`CASE
        WHEN ${raw} IS NULL THEN NULL
        WHEN jsonb_typeof(${raw}) = 'array' THEN
            COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                'type', CASE WHEN jsonb_typeof(issue->'type') = 'string'
                         AND length(issue->>'type') BETWEEN 1 AND 80
                    THEN issue->>'type' ELSE 'unknown_recorded_evidence' END,
                'detected_at', COALESCE(left(issue->>'detected_at', 80), ${updatedAt}::text),
                'detail', left(issue->>'detail', 2048),
                'basis', left(issue->>'basis',80),
                'reviewed', ${fileId ? currentHealthIssueReviewSql(sql, fileId, sql`issue`) : sql`NULL::boolean`},
                'expected_duration', ${boundedHealthDurationSql(sql, sql`issue->'expected_duration'`)},
                'actual_duration', ${boundedHealthDurationSql(sql, sql`issue->'actual_duration'`)}
            )) ORDER BY ordinal)
            FROM (SELECT ${raw}->issue_index AS issue, issue_index + 1 AS ordinal
                FROM generate_series(0, LEAST(jsonb_array_length(${raw}), 20) - 1) AS issue_index
            ) bounded), '[]'::jsonb)
            || CASE WHEN jsonb_array_length(${raw}) > 20
                 THEN jsonb_build_array(jsonb_build_object('type', 'additional_recorded_evidence',
                      'detected_at', ${updatedAt}::text)) ELSE '[]'::jsonb END
        ELSE jsonb_build_array(jsonb_build_object('type', 'unknown_recorded_evidence',
             'detected_at', ${updatedAt}::text)) END`;
}
