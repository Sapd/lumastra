// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Health Invariants — scheduled database health check task.
 *
 * Runs every 15 minutes (and on startup) to evaluate a set of SQL invariants
 * against the database. Results are persisted to health_check_findings so the
 * admin UI can surface drift before it becomes a crisis.
 *
 * Each invariant is evaluated sequentially to avoid saturating the shared DB
 * connection pool. Failures in individual invariant queries are recorded as
 * `unknown` status with the error text stored — they do not abort the run.
 */

import type postgres from 'postgres';
import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { INVARIANTS } from '$lib/server/services/health-invariants/invariants.js';
import type { InvariantDetailLink } from '$lib/server/services/health-invariants/invariants.js';
import { upsertFinding } from '$lib/server/database/queries/health-check-findings.queries.js';
import type { FindingStatus } from '$lib/server/database/queries/health-check-findings.queries.js';
import { cleanupResolvedAlerts } from '$lib/server/database/queries/attention.queries.js';

interface HealthInvariantsResult {
    red: number;
    amber: number;
    green: number;
    errored: number;
    /** Resolved admin_attention_alerts rows pruned this run (§5.5 retention). */
    alertsDeleted: number;
}

const inputSchema = z.object({}).passthrough();

// Exported for tests. It was private, so `invariants.test.ts` MIRRORED it
// locally — and a mirror cannot fail when the real function changes. The
// operatorActionable cap in particular had no test that it did anything.
export function classifyStatus(
    value: number,
    thresholdAmber: number,
    thresholdRed: number,
    operatorActionable = true,
): FindingStatus {
    if (value > thresholdRed) {
        // A finding the operator cannot act on never goes red. It would sit at
        // the top of their dashboard permanently, unclearable, and a board that
        // reads nonzero forever stops being read at all.
        return operatorActionable ? 'red' : 'amber';
    }
    if (value > thresholdAmber) return 'amber';
    return 'green';
}

export const healthInvariantsTask = defineTask<Record<string, unknown>, HealthInvariantsResult>({
    id: 'health-invariants',
    // Internal machinery: hidden from the admin task list unless it fails.
    visibility: 'system',
    purpose: 'maintenance',
    name: 'Database Health Invariants',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true },

    schedule: {
        every: '15m',
        runOnStartup: true,
    },

    identityFor: (input) =>
        `global-${typeof (input as Record<string, unknown>).mode === 'string' ? ((input as Record<string, unknown>).mode as string) : 'catchup'}`,
    scope: 'global',
    resourceClass: 'maintenance',

    inputSchema,

    timeout: { hard: '5m', soft: '4m' },

    coversStages: [],

    async execute(ctx: TaskContext<Record<string, unknown>>) {
        const { sql } = ctx;

        const counts: HealthInvariantsResult = {
            red: 0,
            amber: 0,
            green: 0,
            errored: 0,
            alertsDeleted: 0,
        };
        const total = INVARIANTS.length;

        for (const invariant of INVARIANTS) {
            let value: number | null = null;
            let status: FindingStatus;
            let error: string | undefined;

            try {
                // Per-invariant statement timeout: 8 serial invariants share
                // a single 5-minute hard task timeout. Without this, the
                // jsonb-as-string scan or any full-table-scan invariant on
                // a multi-million-row catalog could eat the entire budget
                // and starve every check after it. SET LOCAL only persists
                // inside this single short transaction so we don't pollute
                // the connection pool's session state.
                value = await sql.begin(async (tx) => {
                    const txSql = tx as unknown as postgres.Sql;
                    await txSql`SET LOCAL statement_timeout = '60s'`;
                    return await invariant.query(txSql);
                });
                status = classifyStatus(
                    value,
                    invariant.thresholdAmber,
                    invariant.thresholdRed,
                    invariant.operatorActionable,
                );
            } catch (err) {
                error = err instanceof Error ? err.message : String(err);
                status = 'unknown';
            }

            // Per-finding breakdown — only worth computing (and only safe to
            // trust) once the finding is actually amber/red; a green finding
            // has nothing to point at, and an 'unknown' one already failed its
            // own query. A details() failure must NOT fail the finding itself
            // — log and store null so the finding still records its status.
            let details: InvariantDetailLink[] | null = null;
            if ((status === 'amber' || status === 'red') && invariant.details) {
                try {
                    details = await sql.begin(async (tx) => {
                        const txSql = tx as unknown as postgres.Sql;
                        await txSql`SET LOCAL statement_timeout = '60s'`;
                        return await invariant.details!(txSql);
                    });
                } catch (detailsErr) {
                    ctx.logger.warn('health-invariants: failed to compute finding details', {
                        invariantId: invariant.id,
                        error:
                            detailsErr instanceof Error ? detailsErr.message : String(detailsErr),
                    });
                    details = null;
                }
            }

            try {
                await upsertFinding(sql, invariant, value, status, error, details);
            } catch (upsertErr) {
                ctx.logger.warn('health-invariants: failed to upsert finding', {
                    invariantId: invariant.id,
                    error: upsertErr instanceof Error ? upsertErr.message : String(upsertErr),
                });
            }

            if (status === 'red') counts.red++;
            else if (status === 'amber') counts.amber++;
            else if (status === 'green') counts.green++;
            else counts.errored++;
        }

        // Retention pass (Problems-as-Architecture §5.5, Slice 0): this task
        // already runs on a schedule and already owns this family of DB
        // housekeeping, so the admin_attention_alerts sweep rides its cadence
        // rather than getting a task of its own. Non-fatal — a cleanup failure
        // must not mark the invariant run itself failed.
        try {
            const { deletedByAge, deletedByCap } = await cleanupResolvedAlerts(sql, ctx.signal);
            counts.alertsDeleted = deletedByAge + deletedByCap;
            if (counts.alertsDeleted > 0) {
                ctx.logger.info('health-invariants: pruned resolved admin_attention_alerts', {
                    deletedByAge,
                    deletedByCap,
                    wasAborted: ctx.signal.aborted,
                });
            }
        } catch (cleanupErr) {
            ctx.logger.warn('health-invariants: failed to prune resolved admin_attention_alerts', {
                error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
            });
        }

        return {
            success: true,
            itemsProcessed: total,
            result: counts,
        };
    },
});

registry.registerTask(healthInvariantsTask);
