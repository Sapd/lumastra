// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * task-history-retention — bounds the hot `task_history` table.
 *
 * `task_history` is the source of truth for every reconciler sweep and every
 * admin runs/cost query. Its documented hot→archive retention tier existed only
 * as a manual admin-only trim (`trimTaskHistory`) plus a dead config value
 * (`LUMASTRA_TASK_HISTORY_HOT_DAYS`) — nothing scheduled ever called it, so the
 * hot table grew unbounded and every O(N) admin query degraded with it. This
 * task wires the tier: daily it rolls rows older than the hot window into
 * `task_history_archive`; `database-cleanup` (also daily) then prunes the
 * archive per its retention policy. The trim runs under a Postgres advisory
 * lock, so concurrent replicas collapse into a single pass.
 *
 * Shape mirrors the `cache-cleanup` maintenance exemplar.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import type { Logger } from '@sapd/lumastra-plugin-sdk';
import type postgres from 'postgres';
import { registry } from '../../registry.js';
import { trimTaskHistory } from '$lib/server/services/task-history-trim.service.js';
import { LUMASTRA_TASK_HISTORY_HOT_DAYS } from '$lib/server/config.js';

const inputSchema = z.object({}).passthrough();

/** The keyset-pagination index migration 16.126.0 creates (may have been skipped). */
const STARTED_ID_INDEX = 'idx_task_history_started_id';

/** Outcome of the self-heal ensure step (reported for observability, never fatal). */
export type IndexEnsureOutcome = 'valid' | 'created' | 'rebuilt' | 'error';

/**
 * Self-heal the `(started_at DESC, id DESC)` index that migration 16.126.0 SKIPS
 * building on a very large `task_history` (to avoid a long in-transaction write
 * lock) — after which the migration is marked applied, so the index could be
 * silently missing forever with nothing left to re-prompt the build. This closes
 * that loop: the daily retention task ENSURES the index after each trim (when the
 * table is smallest).
 *
 * Safety:
 *   - Built with CREATE INDEX CONCURRENTLY so it never blocks task_history writes.
 *     CONCURRENTLY cannot run inside a transaction block; `ctx.sql` autocommits
 *     each statement, and `.simple()` forces the simple query protocol (a bare
 *     postgres.js tagged template wraps the statement in an implicit transaction
 *     → "cannot run inside a transaction block"). NEVER wrap this in sql.begin().
 *   - An interrupted CONCURRENTLY build leaves an INVALID index that the planner
 *     never uses but that `IF NOT EXISTS` treats as present — so it would never be
 *     rebuilt. We detect `indisvalid = false` and DROP it (also CONCURRENTLY)
 *     before rebuilding.
 *   - Wrapped in try/catch and NON-FATAL: the trim is the primary job, so an
 *     ensure failure is logged and swallowed, never surfaced to the runner.
 *
 * Steady state (index present + valid) is a single cheap catalog SELECT that
 * short-circuits before any DDL — so the daily run is a genuine no-op once built.
 */
export async function ensureStartedIdIndex(
    sql: postgres.Sql,
    logger: Logger,
): Promise<IndexEnsureOutcome> {
    try {
        // indisvalid distinguishes a completed build from a leftover failed
        // CONCURRENTLY build. No row → the index is absent.
        const rows = (await sql`
            SELECT i.indisvalid
            FROM pg_class c
            JOIN pg_index i ON i.indexrelid = c.oid
            WHERE c.relname = ${STARTED_ID_INDEX}
              AND c.relnamespace = 'public'::regnamespace
        `) as unknown as Array<{ indisvalid: boolean }>;
        const existing = rows[0];

        // Common case: present and valid → nothing to do.
        if (existing && existing.indisvalid) return 'valid';

        if (existing && !existing.indisvalid) {
            logger.warn(
                'task_history index self-heal: found INVALID idx_task_history_started_id ' +
                    '(interrupted CONCURRENTLY build) — dropping before rebuild',
            );
            await sql
                .unsafe(`DROP INDEX CONCURRENTLY IF EXISTS public.${STARTED_ID_INDEX}`)
                .simple();
        }

        await sql
            .unsafe(
                `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${STARTED_ID_INDEX} ` +
                    `ON task_history (started_at DESC, id DESC)`,
            )
            .simple();

        return existing ? 'rebuilt' : 'created';
    } catch (err) {
        // NON-FATAL: the retention trim already succeeded; a missing index only
        // degrades admin-query performance and will be retried next daily run.
        logger.warn('task_history index self-heal failed (non-fatal — trim is the primary job)', {
            error: err instanceof Error ? err.message : String(err),
        });
        return 'error';
    }
}

export const taskHistoryRetentionTask = defineTask<
    z.infer<typeof inputSchema>,
    { archived: number; deleted: number; kind: string; indexEnsure: IndexEnsureOutcome }
>({
    id: 'task-history-retention',
    // Internal machinery: hidden from the admin task list unless it fails.
    visibility: 'system',
    purpose: 'maintenance',
    name: 'Task History Retention',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true },

    schedule: { every: '24h', runOnStartup: false },

    identityFor: () => 'global',
    scope: 'global',
    // Low-priority housekeeping — must not contend with user-facing IO.
    resourceClass: 'maintenance',
    inputSchema,
    timeout: { hard: '60m', soft: '55m' },

    async execute(ctx) {
        const result = await trimTaskHistory(ctx.sql, {
            olderThanDays: LUMASTRA_TASK_HISTORY_HOT_DAYS,
            signal: ctx.signal,
        });
        const archived = result.archived ?? 0;
        ctx.logger.info('task_history retention pass complete', {
            kind: result.kind,
            archived,
            deleted: result.deleted,
            olderThanDays: LUMASTRA_TASK_HISTORY_HOT_DAYS,
        });

        // Self-heal the keyset-pagination index that migration 16.126.0 may have
        // SKIPPED building on a large table. Runs AFTER the trim (table at its
        // smallest) and is NON-FATAL — the trim above is the primary job.
        const indexEnsure = await ensureStartedIdIndex(ctx.sql, ctx.logger);

        // 'complete' | 'partial' (aborted mid-pass) | 'already-running' are all
        // benign outcomes; a real DB failure throws and the runner marks failed.
        return {
            success: true,
            itemsProcessed: result.deleted,
            result: { archived, deleted: result.deleted, kind: result.kind, indexEnsure },
        };
    },
});

registry.registerTask(taskHistoryRetentionTask);
