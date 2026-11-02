// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// task-history.ts — single home for the `task_history` row INSERT.
//
// The 15-column INSERT was structurally duplicated across three call sites
// (startRun, the pipeline-member fan-out in the orchestrator, and the runner's
// downstream-child insert). Centralizing the column list + JSONB wrapping here
// means a schema change touches ONE place instead of three. Callers keep their
// own surrounding try/catch (idempotency-dedup re-fetch, pending-write-drain
// fallback) — only the INSERT statement itself is shared.

import type postgres from 'postgres';
import type { AuthorityToken } from '../../../task-runtime/authority/store.js';
import { withExistingTaskWrite } from '../../../task-runtime/authority/existing-write.js';

export interface TaskHistoryInsert {
    id: string;
    taskId: string;
    parentRunId: string | null;
    label: string;
    /** Insert-time run state — always 'pending' at the current call sites. */
    state: string;
    /** Serialized task input (JSONB). */
    input: unknown;
    /** Access scope; written as JSONB only when non-empty, else NULL. */
    scope: Record<string, unknown> | null;
    /** Trigger envelope (JSONB). */
    trigger: unknown;
    /** Actor envelope (JSONB). */
    actor: unknown;
    /** Used for BOTH started_at and the initial heartbeat_at. */
    startedAt: Date;
    processingVersion: number | string;
    ownerInstanceId: string;
    retentionPolicy: string;
    /** Stage snapshot array (JSONB). */
    stages: unknown[];
}

/**
 * Insert one `task_history` row. The caller owns error handling.
 */
export async function insertTaskHistoryRow(
    sql: postgres.Sql,
    row: TaskHistoryInsert,
    authority?: AuthorityToken,
): Promise<void> {
    await withExistingTaskWrite(sql, authority, async (sql) => {
        await sql`
        INSERT INTO task_history (
            id, task_id, parent_run_id, label, state,
            input, scope, trigger, actor,
            started_at, heartbeat_at,
            processing_version, owner_instance_id,
            retention_policy, stages
        ) VALUES (
            ${row.id}, ${row.taskId}, ${row.parentRunId}, ${row.label}, ${row.state},
            ${sql.json(row.input as Record<string, never>)},
            ${
                row.scope != null && Object.keys(row.scope).length > 0
                    ? sql.json(row.scope as Record<string, never>)
                    : null
            },
            ${sql.json(row.trigger as Record<string, never>)},
            ${sql.json(row.actor as Record<string, never>)},
            ${row.startedAt}, ${row.startedAt},
            ${String(row.processingVersion)},
            ${row.ownerInstanceId},
            ${row.retentionPolicy},
            ${sql.json(row.stages as never[])}
        )
    `;
    });
}
