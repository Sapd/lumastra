// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TaskHistoryTrimService — wraps the advisory-locked archive+delete CTE for
 * trimming task_history into task_history_archive.
 *
 * Extracted from the API route so the logic is testable and reusable from
 * the scheduled task-history-cleanup task without duplicating the SQL.
 */

import type postgres from 'postgres';
import { withAdvisoryLock } from '$lib/server/database/with-advisory-lock.js';
import { Logger } from '$lib/server/utils/logger.js';

const log = Logger.for('TaskHistoryTrimService');

// ── Result types ──────────────────────────────────────────────────────────────

export type TrimKind = 'complete' | 'partial' | 'already-running';

export interface TrimResult {
    kind: TrimKind;
    deleted: number;
    archived?: number;
    message: string;
    reason?: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

interface RowCounts {
    archived: string;
    deleted: string;
}

/**
 * Archive rows older than `olderThanDays` days (optionally filtered by
 * `taskType`) from `task_history` into `task_history_archive`, then delete
 * them from the source table. The whole operation runs under a Postgres
 * advisory lock so concurrent admin clicks collapse into a single trim.
 *
 * @param signal - Optional AbortSignal; when aborted the result kind is 'partial'.
 */
export async function trimTaskHistory(
    sql: postgres.Sql,
    params: {
        olderThanDays: number;
        taskType?: string;
        signal?: AbortSignal;
    },
): Promise<TrimResult> {
    const { olderThanDays, taskType, signal } = params;
    const started = Date.now();

    interface TrimDone {
        archived: number;
        deleted: number;
    }

    try {
        const lockResult = await withAdvisoryLock<TrimDone>(sql, 'trim:history', async (tx) => {
            // Lazy-create the archive table — idempotent if already created.
            await tx`
                    CREATE TABLE IF NOT EXISTS task_history_archive
                    (LIKE task_history INCLUDING ALL)
                `;

            const taskTypeParam: string | null = taskType ?? null;

            // One DELETE ... RETURNING feeds the archive INSERT. The old shape
            // (SELECT into a CTE, INSERT from it, DELETE WHERE id IN the CTE)
            // scanned task_history twice; the nightly run took 125 s on prod.
            // Same predicate, same rows archived and deleted.
            const result = await tx<RowCounts[]>`
                    WITH deleted AS (
                        DELETE FROM task_history
                        WHERE completed_at < NOW() - INTERVAL '1 day' * ${olderThanDays}
                          AND state IN ('completed', 'failed', 'cancelled')
                          AND (${taskTypeParam}::text IS NULL OR task_id = ${taskTypeParam}::text)
                        RETURNING
                            id, task_id, parent_run_id, label, state,
                            input, scope, trigger, actor, tenant_id,
                            started_at, completed_at, heartbeat_at,
                            cost_units, cost_kind, cost_breakdown,
                            processing_version, owner_instance_id, audit_chain_hash,
                            retention_policy, retain_until,
                            stages, result, error, events_during_run,
                            idempotency_key
                    ),
                    moved AS (
                        INSERT INTO task_history_archive (
                            id, task_id, parent_run_id, label, state,
                            input, scope, trigger, actor, tenant_id,
                            started_at, completed_at, heartbeat_at,
                            cost_units, cost_kind, cost_breakdown,
                            processing_version, owner_instance_id, audit_chain_hash,
                            retention_policy, retain_until,
                            stages, result, error, events_during_run,
                            idempotency_key
                        )
                        SELECT
                            id, task_id, parent_run_id, label, state,
                            input, scope, trigger, actor, tenant_id,
                            started_at, completed_at, heartbeat_at,
                            cost_units, cost_kind, cost_breakdown,
                            processing_version, owner_instance_id, audit_chain_hash,
                            retention_policy, retain_until,
                            stages, result, error, events_during_run,
                            idempotency_key
                        FROM deleted
                        ON CONFLICT (id) DO NOTHING
                        RETURNING id
                    )
                    SELECT
                        (SELECT COUNT(*) FROM moved)::text   AS archived,
                        (SELECT COUNT(*) FROM deleted)::text AS deleted
                `;

            const archived = parseInt(result[0]?.archived ?? '0', 10);
            const deleted = parseInt(result[0]?.deleted ?? '0', 10);
            return { archived, deleted };
        });

        if (!lockResult.acquired) {
            return {
                kind: 'already-running',
                deleted: 0,
                message: 'Another history trim is already running',
            };
        }

        const { archived, deleted } = lockResult.value;
        const elapsed = Date.now() - started;

        if (signal?.aborted) {
            return {
                kind: 'partial',
                deleted,
                archived,
                message: `Trim aborted by client after ${elapsed}ms; archived ${archived}, deleted ${deleted}`,
                reason: 'client-abort',
            };
        }

        return {
            kind: 'complete',
            deleted,
            archived,
            message: `Archived ${archived}, deleted ${deleted}`,
        };
    } catch (err) {
        const elapsed = Date.now() - started;
        log.error(
            'history trim failed mid-batch',
            err instanceof Error ? err : new Error(String(err)),
            { elapsedMs: elapsed },
        );
        return {
            kind: 'partial',
            deleted: 0,
            message: `Trim failed after ${elapsed}ms: ${
                err instanceof Error ? err.message : String(err)
            }`,
            reason: 'db-error',
        };
    }
}
