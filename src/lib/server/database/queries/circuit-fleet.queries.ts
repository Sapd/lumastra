// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Circuit-breaker fleet reader (Slice 3 §4.2).
 *
 * Read-only over `task_circuit_state` — one row per task that has a circuit
 * record. The force-enable TTL check is done in SQL (override_at + ttl >= NOW)
 * so an expired manual override reads back as `forceEnabled: false`, mirroring
 * the runtime check in `circuit-breaker.ts`. No Valkey, no new table.
 *
 * `task_circuit_state` is the source of truth (the breaker is DB-backed).
 */

import type postgres from 'postgres';
import type { CircuitFleetEntry } from '$lib/schemas/task-system-failure-detection.schema.js';

type CircuitFleetDbRow = {
    task_id: string;
    state: 'closed' | 'open' | 'half_open';
    consecutive_failures: number;
    opened_at: Date | null;
    opened_reason: string | null;
    next_probe_at: Date | null;
    force_enabled: boolean;
    last_error_message: string | null;
};

/**
 * List every task with a `task_circuit_state` row. `forceEnableTtlMs` is the
 * configured force-enable window (LUMASTRA_CIRCUIT_FORCE_ENABLE_TTL_MS); an
 * override older than that no longer counts as force-enabled.
 */
export async function listCircuitFleet(
    sql: postgres.Sql,
    { forceEnableTtlMs }: { forceEnableTtlMs: number },
): Promise<CircuitFleetEntry[]> {
    const ttlInterval = `${Math.max(0, Math.trunc(forceEnableTtlMs))} milliseconds`;
    const rows = await sql<CircuitFleetDbRow[]>`
        SELECT
            cs.task_id,
            cs.state,
            cs.consecutive_failures,
            cs.opened_at,
            cs.opened_reason,
            cs.next_probe_at,
            (
                cs.manual_override = 'force_enabled'
                AND cs.override_at IS NOT NULL
                AND cs.override_at + ${ttlInterval}::interval >= NOW()
            ) AS force_enabled,
            lf.error_message AS last_error_message
        FROM task_circuit_state cs
        LEFT JOIN LATERAL (
            SELECT th.error ->> 'message' AS error_message
            FROM task_history th
            WHERE th.task_id = cs.task_id AND th.state = 'failed'
            ORDER BY th.completed_at DESC
            LIMIT 1
        ) lf ON true
        ORDER BY
            CASE cs.state WHEN 'open' THEN 0 WHEN 'half_open' THEN 1 ELSE 2 END,
            cs.opened_at DESC NULLS LAST,
            cs.task_id
    `;
    return rows.map((r) => ({
        taskId: r.task_id,
        state: r.state,
        consecutiveFailures: Number(r.consecutive_failures),
        openedAt: r.opened_at ? new Date(r.opened_at).toISOString() : null,
        openedReason: r.opened_reason,
        nextProbeAt: r.next_probe_at ? new Date(r.next_probe_at).toISOString() : null,
        forceEnabled: Boolean(r.force_enabled),
        lastErrorMessage: r.last_error_message,
    }));
}
