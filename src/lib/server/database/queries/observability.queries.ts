// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Task-System Observability Query Module (Slice 0).
 *
 * Pure SQL for `boot_recovery_log` and `audit_log` (source='subsystem').
 * Each function takes `sql: postgres.Sql` as its first param and has no side
 * effects beyond the query. snake_case rows → camelCase results.
 *
 * Since migration 16.107.0 the old `system_audit_log` table no longer exists;
 * all subsystem writes/reads go to `audit_log WHERE source = 'subsystem'`.
 * Callers and external shapes (AuditEventRow, AuditFeedResponse) are unchanged.
 *
 * Subsystem WRITES route their `sql` from `getTaskDb()`; admin READS pass
 * `getDb()` — see the route handlers and the audit-log module.
 */

import type postgres from 'postgres';
import type {
    AuditEventRow,
    BootRecoveryRow,
} from '$lib/schemas/task-system-observability.schema.js';

// ── boot_recovery_log ───────────────────────────────────────────────────────

export interface BootRecoveryInsert {
    instanceId: string;
    startedAt: Date;
    inspected: number;
    reclaimed: number;
    wedgedStageRowsReclaimed: number;
    runIds: string[];
}

type BootRecoveryDbRow = {
    id: number;
    instance_id: string;
    started_at: Date;
    finished_at: Date;
    inspected: number;
    reclaimed: number;
    wedged_stage_rows_reclaimed: number;
    run_ids: string[];
};

function mapBootRecoveryRow(r: BootRecoveryDbRow): BootRecoveryRow {
    return {
        id: Number(r.id),
        instanceId: r.instance_id,
        startedAt: new Date(r.started_at).toISOString(),
        finishedAt: new Date(r.finished_at).toISOString(),
        inspected: Number(r.inspected),
        reclaimed: Number(r.reclaimed),
        wedgedStageRowsReclaimed: Number(r.wedged_stage_rows_reclaimed),
        runIds: Array.isArray(r.run_ids) ? r.run_ids.map(String) : [],
    };
}

/** Insert one boot-recovery summary row (one per container start). */
export async function insertBootRecoveryLog(
    sql: postgres.Sql,
    entry: BootRecoveryInsert,
): Promise<void> {
    await sql`
        INSERT INTO boot_recovery_log (
            instance_id, started_at, inspected, reclaimed,
            wedged_stage_rows_reclaimed, run_ids
        ) VALUES (
            ${entry.instanceId},
            ${entry.startedAt},
            ${entry.inspected},
            ${entry.reclaimed},
            ${entry.wedgedStageRowsReclaimed},
            ${sql.json(entry.runIds)}
        )
    `;
}

/** Most-recent boot-recovery row, or null if the table is empty. */
export async function getLatestBootRecovery(sql: postgres.Sql): Promise<BootRecoveryRow | null> {
    const rows = await sql<BootRecoveryDbRow[]>`
        SELECT id, instance_id, started_at, finished_at, inspected, reclaimed,
               wedged_stage_rows_reclaimed, run_ids
        FROM boot_recovery_log
        ORDER BY finished_at DESC
        LIMIT 1
    `;
    return rows.length > 0 ? mapBootRecoveryRow(rows[0]) : null;
}

/** Prune boot-recovery rows older than 30 days. Returns rows deleted. */
export async function pruneBootRecoveryLog(sql: postgres.Sql): Promise<number> {
    const deleted = await sql<{ id: number }[]>`
        DELETE FROM boot_recovery_log
        WHERE finished_at < NOW() - INTERVAL '30 days'
        RETURNING id
    `;
    return deleted.length;
}

// ── audit_log (source='subsystem') ──────────────────────────────────────────

export type AuditSeverity = 'info' | 'warn' | 'error';

export interface AuditEventInsert {
    instanceId: string;
    category: string;
    action: string;
    severity: AuditSeverity;
    summary: string;
    detail?: Record<string, unknown>;
}

type AuditDbRow = {
    id: number;
    ts: Date;
    instance_id: string;
    category: string;
    action: string;
    severity: AuditSeverity;
    summary: string;
    detail: Record<string, unknown>;
};

function mapAuditRow(r: AuditDbRow): AuditEventRow {
    return {
        id: Number(r.id),
        ts: new Date(r.ts).toISOString(),
        instanceId: r.instance_id,
        category: r.category,
        action: r.action,
        severity: r.severity,
        summary: r.summary,
        detail: r.detail ?? {},
    };
}

/** Append one subsystem audit-log row (source='subsystem'). */
export async function insertAuditEvent(sql: postgres.Sql, event: AuditEventInsert): Promise<void> {
    await sql`
        INSERT INTO audit_log (
            instance_id, source, category, action, severity, summary, detail
        ) VALUES (
            ${event.instanceId},
            'subsystem',
            ${event.category},
            ${event.action},
            ${event.severity},
            ${event.summary},
            ${sql.json((event.detail ?? {}) as Record<string, never>)}
        )
    `;
}

/**
 * List subsystem audit events newest-first, optionally filtered by category.
 * `limit` must be pre-clamped by the caller (route clamps 1..200).
 */
export async function listAuditEvents(
    sql: postgres.Sql,
    opts: { category?: string; limit: number },
): Promise<AuditEventRow[]> {
    const rows = opts.category
        ? await sql<AuditDbRow[]>`
            SELECT id, ts, instance_id, category, action, severity, summary, detail
            FROM audit_log
            WHERE source = 'subsystem'
              AND category = ${opts.category}
            ORDER BY ts DESC, id DESC
            LIMIT ${opts.limit}
        `
        : await sql<AuditDbRow[]>`
            SELECT id, ts, instance_id, category, action, severity, summary, detail
            FROM audit_log
            WHERE source = 'subsystem'
            ORDER BY ts DESC, id DESC
            LIMIT ${opts.limit}
        `;
    return rows.map(mapAuditRow);
}

/**
 * List subsystem audit events for the Slice 3 feed UI with severity + keyset filters.
 *
 * Newest-first, paged via a keyset cursor on `id` (stable under inserts). The
 * caller passes `before` (the previous page's `nextCursor`) to fetch older
 * rows. `category` is an OPTIONAL multi-select; an empty/absent list means all
 * categories. `severity` is an optional single value. `limit` must be
 * pre-clamped (route clamps 1..200).
 *
 * Returns one extra-row probe internally to compute `nextCursor`: the cursor is
 * the oldest returned row's `id`, or null when fewer than `limit` rows remain.
 */
export async function listAuditFeed(
    sql: postgres.Sql,
    opts: {
        categories?: string[];
        severity?: AuditSeverity;
        since?: Date;
        before?: number;
        limit: number;
    },
): Promise<{ events: AuditEventRow[]; nextCursor: number | null }> {
    const categories = opts.categories && opts.categories.length > 0 ? opts.categories : null;
    const rows = await sql<AuditDbRow[]>`
        SELECT id, ts, instance_id, category, action, severity, summary, detail
        FROM audit_log
        WHERE source = 'subsystem'
          AND ${categories ? sql`category = ANY(${categories})` : sql`TRUE`}
          AND ${opts.severity ? sql`severity = ${opts.severity}` : sql`TRUE`}
          AND ${opts.since ? sql`ts >= ${opts.since}` : sql`TRUE`}
          AND ${opts.before !== undefined ? sql`id < ${opts.before}` : sql`TRUE`}
        ORDER BY id DESC
        LIMIT ${opts.limit}
    `;
    const events = rows.map(mapAuditRow);
    // A full page implies more rows may exist; cursor = oldest id in the page.
    const nextCursor = events.length === opts.limit ? events[events.length - 1].id : null;
    return { events, nextCursor };
}

/**
 * Sum a numeric `detail` field across subsystem audit rows of one
 * category/action over the last `sinceHours`. Used by the systemic-failures
 * panel to roll up "backpressure shed (window)" / "orphans reclaimed (window)"
 * from the coarse audit rows the reconciler already writes.
 *
 * `field` is read from the row's JSONB `detail` (top-level key); rows where it
 * is absent or non-numeric contribute 0.
 */
export async function sumAuditDetailField(
    sql: postgres.Sql,
    opts: {
        category: string;
        action: string;
        field: string;
        sinceHours: number;
    },
): Promise<number> {
    const rows = await sql<{ total: string | null }[]>`
        SELECT COALESCE(SUM((detail->>${opts.field})::numeric), 0)::text AS total
        FROM audit_log
        WHERE source = 'subsystem'
          AND category = ${opts.category}
          AND action = ${opts.action}
          AND ts >= NOW() - (${opts.sinceHours} || ' hours')::interval
          AND detail ? ${opts.field}
          AND jsonb_typeof(detail->${opts.field}) = 'number'
    `;
    const total = rows.length > 0 ? Number(rows[0].total) : 0;
    return Number.isFinite(total) ? total : 0;
}

/** Prune subsystem audit rows older than 30 days. Returns rows deleted. */
export async function pruneAuditEvents(sql: postgres.Sql): Promise<number> {
    const deleted = await sql<{ id: number }[]>`
        DELETE FROM audit_log
        WHERE source = 'subsystem'
          AND ts < NOW() - INTERVAL '30 days'
        RETURNING id
    `;
    return deleted.length;
}
