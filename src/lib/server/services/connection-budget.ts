// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Connection-budget sanity check.
 *
 * Lumastra splits one Postgres backend into three per-instance pools (web, task,
 * admin — see {@link DB_POOL_MAX} in `connection.ts`). The performance-tuning
 * guide's "connection-budget chain" warns that, across every replica, the sum of
 * all pools must stay under Postgres `max_connections` (minus the reserved
 * superuser slots and headroom for migrations / `psql`). Raise the pools or add
 * replicas without raising `max_connections` and the deployment silently runs
 * into connection exhaustion under load.
 *
 * This is one of the few items in that guide the app can detect reliably from
 * inside the container: it reads its own resolved pool caps, counts live replicas
 * from the cluster heartbeat, and queries Postgres for `max_connections` +
 * `superuser_reserved_connections`. It only ever *advises* — it can't change env
 * vars or compose settings, which need a restart.
 *
 * The verdict logic ({@link evaluateConnectionBudget}) is pure so it can be unit
 * tested without a database or cluster; {@link checkConnectionBudget} is the thin
 * async wrapper that gathers the live inputs.
 */

import { getAdminDb, DB_POOL_MAX, DB_POOL_TOTAL_PER_INSTANCE } from '$lib/server/database/index.js';
import { readClusterNodes } from '$lib/server/services/cluster-heartbeat.service.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('ConnectionBudget');

/**
 * Connections we want to keep free on top of the app's pools, for things that
 * open short-lived connections outside the pools: schema migrations on deploy, a
 * `psql` session for debugging, and external monitoring. Kept conservative — it
 * is the gap that turns "exactly fits" into a warning rather than a hard pass.
 */
export const CONNECTION_HEADROOM = 10;

export type ConnectionBudgetStatus = 'ok' | 'warning' | 'critical' | 'unknown';

export interface ConnectionBudgetInput {
    /** Postgres `max_connections`. */
    maxConnections: number;
    /** Postgres `superuser_reserved_connections` (slots non-superusers can't use). */
    reservedConnections: number;
    /** Per-instance pool caps (web + task + admin + heartbeat). */
    pools: { web: number; task: number; admin: number; heartbeat?: number };
    /** How many live replicas currently run (≥ 1). */
    replicaCount: number;
}

export interface ConnectionBudgetCheck extends ConnectionBudgetInput {
    status: ConnectionBudgetStatus;
    /** web + task + admin for a single instance. */
    perInstanceTotal: number;
    /** Worst-case demand across the cluster: perInstanceTotal × replicaCount. */
    worstCaseDemand: number;
    /** Connections usable by the app: maxConnections − reservedConnections. */
    usableConnections: number;
    /** usableConnections − worstCaseDemand (can be negative when over budget). */
    spareConnections: number;
    /** Operator-facing summary of the situation. */
    detail: string;
    /** Concrete next step when status is not 'ok' (else undefined). */
    recommendation?: string;
}

/**
 * Pure verdict: given the budget inputs, classify the connection headroom.
 *
 * - `critical` — worst-case demand meets or exceeds the usable connections, so a
 *   busy cluster can exhaust Postgres and new connections will be refused.
 * - `warning`  — demand fits, but inside the {@link CONNECTION_HEADROOM} reserved
 *   for migrations / `psql` / monitoring, so a deploy or a debug session can tip
 *   it over.
 * - `ok`       — demand fits with headroom to spare.
 */
export function evaluateConnectionBudget(input: ConnectionBudgetInput): ConnectionBudgetCheck {
    const { maxConnections, reservedConnections, pools, replicaCount } = input;

    const perInstanceTotal = pools.web + pools.task + pools.admin + (pools.heartbeat ?? 0);
    const worstCaseDemand = perInstanceTotal * replicaCount;
    const usableConnections = Math.max(0, maxConnections - reservedConnections);
    const spareConnections = usableConnections - worstCaseDemand;

    const replicaSuffix =
        replicaCount > 1 ? ` across ${replicaCount} replicas (${perInstanceTotal} each)` : '';

    let status: ConnectionBudgetStatus;
    let detail: string;
    let recommendation: string | undefined;

    if (spareConnections < 0) {
        status = 'critical';
        detail =
            `The connection pools can demand up to ${worstCaseDemand} connections${replicaSuffix}, ` +
            `but Postgres only offers ${usableConnections} usable ` +
            `(max_connections=${maxConnections} − ${reservedConnections} reserved). ` +
            `Under load this will exhaust Postgres and new connections will be refused.`;
        recommendation =
            `Raise Postgres max_connections to at least ` +
            `${worstCaseDemand + reservedConnections + CONNECTION_HEADROOM}, ` +
            `or lower the pool caps (LUMASTRA_DB_POOL_TASK_MAX / _WEB_MAX / _ADMIN_MAX).`;
    } else if (spareConnections < CONNECTION_HEADROOM) {
        status = 'warning';
        detail =
            `The connection pools can demand up to ${worstCaseDemand} connections${replicaSuffix}, ` +
            `leaving only ${spareConnections} of ${usableConnections} usable connections free — ` +
            `below the ${CONNECTION_HEADROOM} kept for migrations, psql and monitoring. ` +
            `A deploy or a debug session could tip this over.`;
        recommendation =
            `Raise Postgres max_connections to at least ` +
            `${worstCaseDemand + reservedConnections + CONNECTION_HEADROOM} for comfortable headroom.`;
    } else {
        status = 'ok';
        detail =
            `Connection budget is healthy: worst-case demand ${worstCaseDemand}${replicaSuffix} ` +
            `vs ${usableConnections} usable connections (${spareConnections} free).`;
    }

    return {
        ...input,
        status,
        perInstanceTotal,
        worstCaseDemand,
        usableConnections,
        spareConnections,
        detail,
        recommendation,
    };
}

/**
 * Gather the live inputs and run the connection-budget check.
 *
 * Returns a `status: 'unknown'` result (never throws) when Postgres can't be
 * reached — callers should treat that as "couldn't check", not as a problem.
 *
 * Worst-case model: each replica is assumed able to open its full per-instance
 * pool total. That's intentionally pessimistic — a web replica leaves the task
 * pool idle and vice-versa — but it matches the guide's "sum across all replicas"
 * rule and is the safe side to err on for a sanity check.
 */
export async function checkConnectionBudget(): Promise<ConnectionBudgetCheck> {
    const pools = {
        web: DB_POOL_MAX.web,
        task: DB_POOL_MAX.task,
        admin: DB_POOL_MAX.admin,
        heartbeat: DB_POOL_MAX.heartbeat,
    };

    const unknown = (detail: string): ConnectionBudgetCheck => ({
        status: 'unknown',
        maxConnections: 0,
        reservedConnections: 0,
        pools,
        replicaCount: 1,
        perInstanceTotal: DB_POOL_TOTAL_PER_INSTANCE,
        worstCaseDemand: DB_POOL_TOTAL_PER_INSTANCE,
        usableConnections: 0,
        spareConnections: 0,
        detail,
    });

    const sql = getAdminDb();
    if (!sql) {
        return unknown('Database not connected — connection budget could not be checked.');
    }

    let maxConnections: number;
    let reservedConnections: number;
    try {
        const rows = await sql<{ max_connections: number; reserved: number }[]>`
            SELECT current_setting('max_connections')::int AS max_connections,
                   current_setting('superuser_reserved_connections')::int AS reserved
        `;
        maxConnections = rows[0]?.max_connections ?? 0;
        reservedConnections = rows[0]?.reserved ?? 0;
    } catch (err) {
        logger.warn('Failed to read Postgres connection settings', { error: String(err) });
        return unknown('Could not read Postgres connection settings.');
    }

    // Count live replicas from the cluster heartbeat. A Valkey failure surfaces as
    // an empty array; fall back to 1 (this instance is by definition live) so we
    // never under- or over-count to zero.
    let replicaCount = 1;
    try {
        const nodes = await readClusterNodes();
        replicaCount = Math.max(1, nodes.length);
    } catch (err) {
        logger.warn('Failed to read cluster nodes; assuming single replica', {
            error: String(err),
        });
    }

    return evaluateConnectionBudget({
        maxConnections,
        reservedConnections,
        pools,
        replicaCount,
    });
}
