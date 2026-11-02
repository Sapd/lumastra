// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Health Check Findings Query Module
 *
 * Pure SQL helpers for the health_check_findings table. Each function takes
 * `sql` as its first parameter, has no side effects beyond the declared DB
 * mutation, and performs no transactions internally.
 */

import type postgres from 'postgres';
import type {
    Invariant,
    InvariantDetailLink,
} from '$lib/server/services/health-invariants/invariants.js';

export type FindingStatus = 'green' | 'amber' | 'red' | 'unknown';

export interface FindingRow {
    invariant_id: string;
    status: FindingStatus;
    value: string | null;
    label: string;
    description: string;
    remediation: string | null;
    threshold_amber: string | null;
    threshold_red: string | null;
    last_run_at: Date;
    last_change_at: Date;
    last_value_at: Date;
    error: string | null;
    details: unknown | null;
}

/**
 * Upsert one finding row. Updates `last_change_at` only when the status
 * transitions from its previous value; always updates `last_run_at` and
 * `last_value_at`.
 */
// Cap error messages stored in the hot-read findings table. A misbehaving
// extension or query-plan dump can produce multi-MB error text; left
// unbounded it lands in a row the UI re-fetches every 30 s. 500 chars
// mirrors `recordEventFailure` in `event-outbox.queries.ts`.
const ERROR_MAX_LEN = 500;

export async function upsertFinding(
    sql: postgres.Sql,
    invariant: Invariant,
    value: number | null,
    status: FindingStatus,
    error?: string,
    details?: InvariantDetailLink[] | null,
): Promise<void> {
    const truncatedError =
        error == null ? null : error.length > ERROR_MAX_LEN ? error.slice(0, ERROR_MAX_LEN) : error;
    const detailsJson =
        details == null || details.length === 0
            ? null
            : sql.json(details as unknown as postgres.JSONValue);
    await sql`
        INSERT INTO health_check_findings (
            invariant_id,
            status,
            value,
            label,
            description,
            remediation,
            threshold_amber,
            threshold_red,
            last_run_at,
            last_change_at,
            last_value_at,
            error,
            details
        ) VALUES (
            ${invariant.id},
            ${status},
            ${value ?? null},
            ${invariant.label},
            ${invariant.description},
            ${invariant.remediation},
            ${invariant.thresholdAmber},
            ${invariant.thresholdRed},
            NOW(),
            NOW(),
            NOW(),
            ${truncatedError},
            ${detailsJson}
        )
        ON CONFLICT (invariant_id) DO UPDATE SET
            status          = EXCLUDED.status,
            value           = EXCLUDED.value,
            label           = EXCLUDED.label,
            description     = EXCLUDED.description,
            remediation     = EXCLUDED.remediation,
            threshold_amber = EXCLUDED.threshold_amber,
            threshold_red   = EXCLUDED.threshold_red,
            last_run_at     = EXCLUDED.last_run_at,
            last_change_at  = CASE
                                  WHEN health_check_findings.status <> EXCLUDED.status
                                  THEN EXCLUDED.last_change_at
                                  ELSE health_check_findings.last_change_at
                              END,
            last_value_at   = EXCLUDED.last_value_at,
            error           = EXCLUDED.error,
            details         = EXCLUDED.details
    `;
}

/**
 * Return all findings ordered by severity (red → amber → unknown → green),
 * then alphabetically by label within each group.
 */
export async function listFindings(sql: postgres.Sql): Promise<FindingRow[]> {
    return sql<FindingRow[]>`
        SELECT
            invariant_id,
            status,
            value,
            label,
            description,
            remediation,
            threshold_amber,
            threshold_red,
            last_run_at,
            last_change_at,
            last_value_at,
            error,
            details
          FROM health_check_findings
         ORDER BY
            CASE status
                WHEN 'red'     THEN 1
                WHEN 'amber'   THEN 2
                WHEN 'unknown' THEN 3
                WHEN 'green'   THEN 4
                ELSE                5
            END,
            label
    `;
}
