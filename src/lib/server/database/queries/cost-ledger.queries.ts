// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

export interface CostAggregation {
    taskId: string;
    costUnit: string;
    totalUnits: number;
    runCount: number;
}

export interface RecentCostlyRun {
    runId: string;
    taskId: string;
    completedAt: Date;
    costBreakdown: Record<string, number>;
}

/**
 * Aggregates cost_breakdown JSONB from task_history over the given window.
 * Expands each JSON key into a (task_id, cost_unit) row and sums the values.
 *
 * Runs inside a transaction with `jit` forced off (`set_config(..., true)` —
 * scoped to this transaction only, no effect on other queries on the
 * connection). Measured against a real Postgres 18 instance seeded with 1.5M
 * synthetic task_history rows (matching prod's documented scale — see
 * 16.131.0's migration comment) spanning the 90-day hot-retention window: the
 * planner's cost estimate for this aggregation (CROSS JOIN LATERAL expansion
 * + GROUP BY over a few hundred thousand rows) clears Postgres's
 * `jit_above_cost` threshold every time, so it pays JIT compilation
 * (~1.5-2s of inlining/optimization/emission) for a query whose own
 * execution is comparably short — the compiled code never runs long enough
 * to amortize the compile cost. With a warm cache, disabling JIT cut
 * execution from ~1.9s to ~0.45s at the default 7-day window and from ~4.0s
 * to ~2.5s at the max 90-day window. See also migration 16.137.0, which adds
 * a partial index matching this query's exact WHERE clause (completed_at
 * range + state + cost_breakdown IS NOT NULL) to cut the cold-cache heap-scan
 * cost on top of the JIT fix.
 */
export async function listCostAggregations(
    sql: postgres.Sql,
    { sinceDays }: { sinceDays: number },
): Promise<CostAggregation[]> {
    const rows = await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await tx`SELECT set_config('jit', 'off', true)`;

        return tx<
            Array<{
                task_id: string;
                cost_unit: string;
                total_units: string;
                run_count: string;
            }>
        >`
            SELECT
                th.task_id,
                e.key   AS cost_unit,
                SUM(CASE WHEN e.value ~ '^[+-]?(\\d+(\\.\\d+)?|\\.\\d+)([eE][+-]?\\d+)?$' THEN e.value::numeric ELSE 0 END) AS total_units,
                COUNT(DISTINCT th.id)::text    AS run_count
            FROM task_history th
            CROSS JOIN LATERAL jsonb_each_text(th.cost_breakdown) AS e(key, value)
            WHERE th.state IN ('completed', 'failed', 'cancelled')
              AND th.completed_at >= NOW() - (${sinceDays} || ' days')::interval
              AND th.cost_breakdown IS NOT NULL
            GROUP BY th.task_id, e.key
            ORDER BY total_units DESC
        `;
    });

    return rows.map((r) => {
        const totalUnits = parseFloat(r.total_units);
        return {
            taskId: r.task_id,
            costUnit: r.cost_unit,
            totalUnits: Number.isFinite(totalUnits) ? totalUnits : 0,
            runCount: parseInt(r.run_count, 10),
        };
    });
}

/**
 * Returns recent runs that recorded a cost_breakdown, optionally filtered to a
 * single cost unit, ordered by completion time (most recent first).
 */
export async function listRecentCostlyRuns(
    sql: postgres.Sql,
    { limit, costUnit }: { limit: number; costUnit?: string },
): Promise<RecentCostlyRun[]> {
    const rows = await sql<
        Array<{
            id: string;
            task_id: string;
            completed_at: Date;
            cost_breakdown: Record<string, number>;
        }>
    >`
        SELECT id, task_id, completed_at, cost_breakdown
        FROM task_history
        WHERE state IN ('completed', 'failed', 'cancelled')
          AND cost_breakdown IS NOT NULL
          AND ${costUnit ? sql`cost_breakdown ? ${costUnit}` : sql`TRUE`}
        ORDER BY completed_at DESC
        LIMIT ${limit}
    `;

    return rows.map((r) => ({
        runId: r.id,
        taskId: r.task_id,
        completedAt: r.completed_at,
        costBreakdown: r.cost_breakdown ?? {},
    }));
}

export interface AssistantUsageAggregate {
    /** Total assistant-response tokens (prompt + completion) over the window. */
    totalTokens: number;
    /** Total USD already priced at request time via estimateChatCostUsd. */
    totalCostUsd: number;
    /** Number of assistant responses (chat turns). */
    messageCount: number;
}

/**
 * Aggregate AI-assistant (RAG chat) token + cost usage over the window.
 *
 * The assistant is an HTTP route, not a task run, so its usage lives in
 * `assistant_messages` (tokens_used + cost_usd, priced at request time) rather
 * than `task_history.cost_breakdown`. We sum only `role = 'assistant'` rows —
 * the response carries the turn's cost; counting the paired user row too would
 * double-count.
 */
export async function getAssistantUsage(
    sql: postgres.Sql,
    { sinceDays }: { sinceDays: number },
): Promise<AssistantUsageAggregate> {
    const [row] = await sql<
        Array<{
            total_tokens: string | null;
            total_cost: string | null;
            msg_count: string;
        }>
    >`
        SELECT
            COALESCE(SUM(tokens_used), 0)::text AS total_tokens,
            COALESCE(SUM(cost_usd), 0)::text    AS total_cost,
            COUNT(*)::text                      AS msg_count
        FROM assistant_messages
        WHERE role = 'assistant'
          AND created_at >= NOW() - (${sinceDays} || ' days')::interval
    `;
    const toNum = (v: string | null | undefined): number => {
        const n = v != null ? Number(v) : 0;
        return Number.isFinite(n) ? n : 0;
    };
    return {
        totalTokens: toNum(row?.total_tokens),
        totalCostUsd: toNum(row?.total_cost),
        messageCount: toNum(row?.msg_count),
    };
}
