// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin Audit Log Query Module.
 *
 * Pure SQL for `audit_log` (source = 'admin'). Each function takes
 * `sql: postgres.Sql` as its first param and has no side effects beyond the
 * query. snake_case rows → camelCase results.
 *
 * Since migration 16.107.0 the old `admin_audit_log` table no longer exists;
 * all writes/reads go to `audit_log WHERE source = 'admin'`. The DB-layer
 * return type (events+nextCursor) is internal; the API response shape is
 * `{ items, page }` (contract envelope) built by the def in admin-audit/index.
 *
 * Write path: called from `src/lib/server/utils/audit-log.ts` (best-effort).
 * Read path: called from `GET /api/admin/admin-audit`.
 * Prune path: called from `src/lib/server/tasks/observability/audit-log.ts`.
 */

import type postgres from 'postgres';
import { escapeLikePattern } from './builders/search-filter.builder.js';
import type { AdminAuditEventRow } from '$lib/schemas/admin-audit.schema.js';

// ── Internal DB row type ─────────────────────────────────────────────────────

type AdminAuditDbRow = {
    id: number | bigint;
    ts: Date;
    instance_id: string;
    actor: string;
    action: string;
    target: string;
    outcome: 'ok' | 'error' | 'denied';
    detail: Record<string, unknown>;
    /** Which credential path produced the actor identity (nullable — pre-R5 rows, or legacy string-actor calls). */
    principal_kind: string | null;
    /** The specific credential's own id (PAT id, service-token id, session id, …). Nullable, same reasons as above. */
    credential_id: string | null;
};

function mapAdminAuditRow(r: AdminAuditDbRow): AdminAuditEventRow {
    return {
        id: Number(r.id),
        ts: new Date(r.ts).toISOString(),
        instanceId: r.instance_id,
        actor: r.actor,
        action: r.action,
        target: r.target,
        outcome: r.outcome,
        detail: r.detail ?? {},
        principalKind: r.principal_kind ?? null,
        credentialId: r.credential_id ?? null,
    };
}

// ── Insert ───────────────────────────────────────────────────────────────────

export interface AdminAuditEventInsert {
    instanceId: string;
    actor: string; // 'system' when adminUsername is null
    /** Which credential path produced the actor identity (R5 attribution). */
    principalKind?: string | null;
    /** The specific credential's own id (PAT id, service-token id, …). */
    credentialId?: string | null;
    action: string;
    target: string;
    outcome: 'ok' | 'error' | 'denied';
    detail?: Record<string, unknown>;
}

/** Append one admin-audit-log row to audit_log (source='admin'). */
export async function insertAdminAuditEvent(
    sql: postgres.Sql,
    event: AdminAuditEventInsert,
): Promise<void> {
    await sql`
        INSERT INTO audit_log (
            instance_id, source, actor, principal_kind, credential_id, action, target, outcome, detail
        ) VALUES (
            ${event.instanceId},
            'admin',
            ${event.actor},
            ${event.principalKind ?? null},
            ${event.credentialId ?? null},
            ${event.action},
            ${event.target},
            ${event.outcome},
            ${sql.json((event.detail ?? {}) as Record<string, never>)}
        )
    `;
}

// ── Read (feed with keyset pagination) ───────────────────────────────────────

/**
 * List admin audit events newest-first with optional filters.
 *
 * `actors` / `actions` are MULTI-SELECT; absent/empty means "all".
 * `actions` supports prefix-match with trailing `*` (e.g. `user.*` → LIKE `user.%`).
 * `since` is an ISO lower bound on `ts`.
 * `until` is an ISO upper bound on `ts` (inclusive).
 * `before` is a keyset cursor (id); returns rows with id < before.
 * `limit` must be pre-clamped by the caller (route clamps 1..200).
 *
 * Uses LIMIT limit+1 to probe for a next page without a separate COUNT query.
 * If the DB returns limit+1 rows there is a next page; the extra row is sliced
 * off before mapping. If the DB returns ≤ limit rows, nextCursor is null.
 */
export async function listAdminAuditFeed(
    sql: postgres.Sql,
    opts: {
        actors?: string[];
        actions?: string[];
        since?: Date;
        until?: Date;
        before?: number;
        limit: number;
    },
): Promise<{ events: AdminAuditEventRow[]; nextCursor: number | null }> {
    const actors = opts.actors && opts.actors.length > 0 ? opts.actors : null;
    // Expand prefix wildcards: 'user.*' → LIKE 'user.%'
    const exactActions: string[] = [];
    const prefixActions: string[] = [];
    for (const a of opts.actions ?? []) {
        if (a.endsWith('*')) {
            // Escape _ % \ in the prefix so only the trailing * is a wildcard.
            prefixActions.push(escapeLikePattern(a.slice(0, -1)) + '%');
        } else {
            exactActions.push(a);
        }
    }
    const hasActionFilter = exactActions.length > 0 || prefixActions.length > 0;

    const rows = await sql<AdminAuditDbRow[]>`
        SELECT id, ts, instance_id, actor, principal_kind, credential_id, action, target, outcome, detail
        FROM audit_log
        WHERE source = 'admin'
          AND ${actors ? sql`actor = ANY(${actors})` : sql`TRUE`}
          AND ${
              hasActionFilter
                  ? sql`(
                      ${exactActions.length > 0 ? sql`action = ANY(${exactActions})` : sql`FALSE`}
                      OR ${prefixActions.length > 0 ? sql`${prefixActions.map((p) => sql`action LIKE ${p}`).reduce((a, b) => sql`${a} OR ${b}`)}` : sql`FALSE`}
                  )`
                  : sql`TRUE`
          }
          AND ${opts.since ? sql`ts >= ${opts.since}` : sql`TRUE`}
          AND ${opts.until ? sql`ts <= ${opts.until}` : sql`TRUE`}
          AND ${opts.before !== undefined ? sql`id < ${opts.before}` : sql`TRUE`}
        ORDER BY id DESC
        LIMIT ${opts.limit + 1}
    `;

    const hasMore = rows.length > opts.limit;
    const pageRows = hasMore ? rows.slice(0, opts.limit) : rows;
    const events = pageRows.map(mapAdminAuditRow);
    const nextCursor = hasMore ? events[events.length - 1].id : null;
    return { events, nextCursor };
}

// ── Export (CSV) ──────────────────────────────────────────────────────────────

/** Fetch rows for CSV export. Cap is enforced by the caller (route: 10_000). */
export async function streamAdminAuditExport(
    sql: postgres.Sql,
    opts: {
        actors?: string[];
        actions?: string[];
        since?: Date;
        until?: Date;
        /** Keyset cursor: only rows with id < before (continue a truncated export). */
        before?: number;
        limit: number;
    },
): Promise<AdminAuditEventRow[]> {
    const actors = opts.actors && opts.actors.length > 0 ? opts.actors : null;
    const exactActions: string[] = [];
    const prefixActions: string[] = [];
    for (const a of opts.actions ?? []) {
        if (a.endsWith('*')) {
            // Escape _ % \ in the prefix so only the trailing * is a wildcard.
            prefixActions.push(escapeLikePattern(a.slice(0, -1)) + '%');
        } else {
            exactActions.push(a);
        }
    }
    const hasActionFilter = exactActions.length > 0 || prefixActions.length > 0;

    const rows = await sql<AdminAuditDbRow[]>`
        SELECT id, ts, instance_id, actor, principal_kind, credential_id, action, target, outcome, detail
        FROM audit_log
        WHERE source = 'admin'
          AND ${actors ? sql`actor = ANY(${actors})` : sql`TRUE`}
          AND ${
              hasActionFilter
                  ? sql`(
                      ${exactActions.length > 0 ? sql`action = ANY(${exactActions})` : sql`FALSE`}
                      OR ${prefixActions.length > 0 ? sql`${prefixActions.map((p) => sql`action LIKE ${p}`).reduce((a, b) => sql`${a} OR ${b}`)}` : sql`FALSE`}
                  )`
                  : sql`TRUE`
          }
          AND ${opts.since ? sql`ts >= ${opts.since}` : sql`TRUE`}
          AND ${opts.until ? sql`ts <= ${opts.until}` : sql`TRUE`}
          AND ${opts.before !== undefined ? sql`id < ${opts.before}` : sql`TRUE`}
        ORDER BY id DESC
        LIMIT ${opts.limit}
    `;

    return rows.map(mapAdminAuditRow);
}

// ── Distinct actors (for filter chip bar) ────────────────────────────────────

/**
 * Return the distinct actor usernames seen in admin audit rows, ordered
 * alphabetically. Used to populate the actor filter chip bar on initial load
 * so that rarely-active admins appear in the list immediately (not just when
 * their events happen to be in the current page window).
 *
 * Capped at 200 distinct actors to guard against degenerate tables.
 */
export async function listDistinctAdminActors(sql: postgres.Sql): Promise<string[]> {
    const rows = await sql<{ actor: string }[]>`
        SELECT DISTINCT actor
        FROM audit_log
        WHERE source = 'admin'
          AND actor IS NOT NULL
        ORDER BY actor
        LIMIT 200
    `;
    return rows.map((r) => r.actor);
}

// ── Prune ─────────────────────────────────────────────────────────────────────

/**
 * Delete audit_log rows with source='admin' older than `retentionDays` days.
 * Returns the count of deleted rows.
 */
export async function pruneAdminAuditEvents(
    sql: postgres.Sql,
    retentionDays: number = 90,
): Promise<number> {
    const deleted = await sql<{ id: number }[]>`
        DELETE FROM audit_log
        WHERE source = 'admin'
          AND ts < NOW() - (${retentionDays} || ' days')::interval
        RETURNING id
    `;
    return deleted.length;
}
