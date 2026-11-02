// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SQL for the admin debug report (spec 2026-10-21-admin-debug-report-design §4)
 * that has no other home. Every query returns counts or ids, never titles,
 * paths or user data. Redaction happens in `debug-report/build.ts`.
 */

import type postgres from 'postgres';

/** Media files with a health issue, counted by issue type. */
export async function countMediaHealthIssuesByType(
    sql: postgres.Sql,
): Promise<Array<{ type: string | null; count: number }>> {
    // The array guard sits in a CASE, not in WHERE: jsonb_array_elements raises on a
    // scalar before WHERE filters the row, so the function must only see an array.
    return sql<Array<{ type: string | null; count: number }>>`
        SELECT e->>'type' AS type, count(*)::int AS count
        FROM media_files
        CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(health_issues) = 'array' THEN health_issues ELSE '[]'::jsonb END
        ) AS e
        GROUP BY 1
        ORDER BY count DESC, type
    `;
}

/**
 * The most recent failed runs of each task, `perTask` per task, for the sample
 * links of the report. `listRunFailureRows` counts the same population but does
 * not carry the run id.
 */
export async function listSampleFailedRuns(
    sql: postgres.Sql,
    { sinceHours, perTask }: { sinceHours: number; perTask: number },
): Promise<Array<{ runId: string; taskId: string; completedAt: Date }>> {
    return sql<Array<{ runId: string; taskId: string; completedAt: Date }>>`
        SELECT "runId", "taskId", "completedAt"
        FROM (
            SELECT th.id AS "runId",
                   th.task_id AS "taskId",
                   th.completed_at AS "completedAt",
                   row_number() OVER (PARTITION BY th.task_id ORDER BY th.completed_at DESC) AS rn
            FROM task_history th
            WHERE th.state IN ('failed', 'cancelled')
              AND th.error IS NOT NULL
              AND th.completed_at >= NOW() - (${sinceHours} || ' hours')::interval
        ) ranked
        WHERE rn <= ${perTask}
        ORDER BY "completedAt" DESC
    `;
}

/** PostgreSQL and pgvector versions. pgvector may not be installed; then null. */
export async function getDatabaseVersions(sql: postgres.Sql): Promise<{
    postgresVersion: string | null;
    pgvectorVersion: string | null;
}> {
    const [versionRow] = await sql<{ version: string }[]>`SELECT version()`;
    const fullVersion = versionRow?.version ?? '';
    // Trimmed to "PostgreSQL X.Y": the full string also carries the compiler triple.
    const postgresVersion =
        fullVersion.match(/^PostgreSQL [\d.]+/)?.[0] ?? (fullVersion ? fullVersion.split(' on ')[0] : null);
    let pgvectorVersion: string | null = null;
    try {
        const [ext] = await sql<{ extversion: string }[]>`
            SELECT extversion FROM pg_extension WHERE extname = 'vector'
        `;
        pgvectorVersion = ext?.extversion ?? null;
    } catch {
        // Leave null: the extension lookup must never cost the version line.
    }
    return { postgresVersion: postgresVersion ?? null, pgvectorVersion };
}
