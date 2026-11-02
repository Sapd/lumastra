// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integrity Violations Query Module
 *
 * The `integrity_violations` table is written by the W6 `integrity-scanner`
 * plugin and read by the admin integrity dashboard endpoints. Each row records
 * a finding tagged with a stable `rule` id (kebab-case) plus optional
 * `media_id` for row-scoped findings (NULL for global rules like
 * `quarantine-backlog-too-large`).
 *
 * Idempotency contract:
 *   - `recordViolation` upserts on `(rule, COALESCE(media_id::text, ''))` while
 *     `resolved_at IS NULL`. A re-running scanner sees the same finding and
 *     refreshes `details` + `detected_at` instead of inserting a duplicate.
 *   - `clearViolation` is a no-op when no open finding exists for the given
 *     (rule, mediaId). The scanner uses this to auto-resolve rows it didn't
 *     surface on the latest pass.
 *
 * The unique partial index on `(rule, COALESCE(media_id::text, ''))` makes the
 * upsert race-free — two concurrent scans cannot create two open rows for the
 * same finding.
 */

import type postgres from 'postgres';

const MAX_LIMIT = 1000;

export type IntegritySeverity = 'low' | 'medium' | 'high' | 'critical';

export interface IntegrityViolation {
    id: string;
    rule: string;
    severity: IntegritySeverity;
    mediaId: string | null;
    details: Record<string, unknown>;
    detectedAt: Date;
    resolvedAt: Date | null;
    resolution: string | null;
}

interface ViolationRow {
    id: string;
    rule: string;
    severity: string;
    media_id: string | null;
    details: Record<string, unknown>;
    detected_at: Date;
    resolved_at: Date | null;
    resolution: string | null;
}

function rowToViolation(row: ViolationRow): IntegrityViolation {
    return {
        id: row.id,
        rule: row.rule,
        severity: row.severity as IntegritySeverity,
        mediaId: row.media_id,
        details: row.details,
        detectedAt: row.detected_at,
        resolvedAt: row.resolved_at,
        resolution: row.resolution,
    };
}

export interface RecordViolationInput {
    rule: string;
    severity: IntegritySeverity;
    mediaId?: string | null;
    details?: Record<string, unknown>;
}

/**
 * Upsert an open integrity violation. Re-running the scanner with the same
 * (rule, mediaId) refreshes `details` and `detected_at` rather than inserting
 * a duplicate row — see the unique partial index in migration 12.67.0.
 *
 * Returns the row's UUID (existing or newly inserted).
 *
 * Note: when called with a `mediaId` for which a RESOLVED row already exists
 * (different `id`), this inserts a NEW open row — the index only enforces
 * uniqueness while `resolved_at IS NULL`. That's intentional: re-occurrences
 * after admin resolution should be visible as fresh findings.
 */
export async function recordViolation(
    sql: postgres.Sql,
    input: RecordViolationInput,
): Promise<string> {
    const details = input.details ?? {};
    const mediaId = input.mediaId ?? null;

    // Two-step upsert: probe for the open row first, then either UPDATE or
    // INSERT. We can't use ON CONFLICT against a partial unique index without
    // a WHERE clause, and Postgres doesn't accept the partial-index WHERE in
    // the conflict target. The probe-then-write pattern races a concurrent
    // writer of the same key, but the partial unique index will reject the
    // losing INSERT — at which point we fall back to UPDATE. In practice the
    // scanner is single-runner per cluster so the race is theoretical.
    const existing = await sql<{ id: string }[]>`
        SELECT id FROM integrity_violations
        WHERE rule = ${input.rule}
          AND (
              (media_id IS NULL AND ${mediaId}::uuid IS NULL)
              OR media_id = ${mediaId}::uuid
          )
          AND resolved_at IS NULL
        LIMIT 1
    `;

    if (existing[0]) {
        await sql`
            UPDATE integrity_violations
            SET details     = ${sql.json(details as Record<string, never>)},
                severity    = ${input.severity},
                detected_at = NOW()
            WHERE id = ${existing[0].id}
              AND resolved_at IS NULL
        `;
        return existing[0].id;
    }

    try {
        const rows = await sql<{ id: string }[]>`
            INSERT INTO integrity_violations (rule, severity, media_id, details)
            VALUES (
                ${input.rule},
                ${input.severity},
                ${mediaId},
                ${sql.json(details as Record<string, never>)}
            )
            RETURNING id
        `;
        if (!rows[0]) {
            throw new Error('recordViolation: INSERT returned no row');
        }
        return rows[0].id;
    } catch (err) {
        // Race lost — another writer beat us. Re-probe and UPDATE.
        //
        // Match by pg SQLSTATE 23505 (unique_violation) AND the exact index
        // name, not by message-string regex. Regex matching is brittle — the
        // message format varies by pg locale/version and can false-positive
        // against any error whose text happens to contain the index name.
        // Strict code + constraint_name matching (same pattern as
        // orchestrator.ts) avoids swallowing violations from unrelated
        // unique indexes.
        const errObj = (err ?? {}) as { code?: unknown; constraint_name?: unknown };
        if (
            errObj.code === '23505' &&
            errObj.constraint_name === 'idx_integrity_violations_unique_open'
        ) {
            const refetch = await sql<{ id: string }[]>`
                SELECT id FROM integrity_violations
                WHERE rule = ${input.rule}
                  AND (
                      (media_id IS NULL AND ${mediaId}::uuid IS NULL)
                      OR media_id = ${mediaId}::uuid
                  )
                  AND resolved_at IS NULL
                LIMIT 1
            `;
            if (refetch[0]) {
                await sql`
                    UPDATE integrity_violations
                    SET details     = ${sql.json(details as Record<string, never>)},
                        severity    = ${input.severity},
                        detected_at = NOW()
                    WHERE id = ${refetch[0].id}
                `;
                return refetch[0].id;
            }
        }
        throw err;
    }
}

export interface ClearViolationInput {
    rule: string;
    mediaId?: string | null;
    resolution?: string;
}

/**
 * Mark an open violation resolved. No-op (returns 0) when no matching open
 * row exists — useful for the scanner's "auto-resolve findings the latest
 * pass didn't surface" flow.
 *
 * Returns the number of rows resolved (0 or 1).
 */
export async function clearViolation(
    sql: postgres.Sql,
    input: ClearViolationInput,
): Promise<number> {
    const mediaId = input.mediaId ?? null;
    const resolution = input.resolution ?? 'auto-resolved by scanner';

    const rows = await sql<{ id: string }[]>`
        UPDATE integrity_violations
        SET resolved_at = NOW(),
            resolution  = ${resolution}
        WHERE rule = ${input.rule}
          AND (
              (media_id IS NULL AND ${mediaId}::uuid IS NULL)
              OR media_id = ${mediaId}::uuid
          )
          AND resolved_at IS NULL
        RETURNING id
    `;
    return rows.length;
}

/**
 * Mark a specific violation row resolved by its UUID. Used by the admin
 * resolve endpoint where the user clicks a row to dismiss it. Throws when
 * the row is missing or already resolved so the caller surfaces the stale
 * state to the admin.
 *
 * @throws {Error} when the row is missing or already resolved
 */
export async function resolveViolationById(
    sql: postgres.Sql,
    id: string,
    resolution: string,
): Promise<void> {
    const rows = await sql<{ id: string }[]>`
        UPDATE integrity_violations
        SET resolved_at = NOW(),
            resolution  = ${resolution}
        WHERE id = ${id}
          AND resolved_at IS NULL
        RETURNING id
    `;
    if (rows.length === 0) {
        throw new Error('Integrity violation already resolved or not found');
    }
}

export interface ListOpenViolationsOptions {
    rule?: string;
    severity?: IntegritySeverity;
    limit?: number;
}

/**
 * List unresolved violations, newest first. Filters: `rule` (exact match),
 * `severity` (exact match). `limit` is clamped to [1, MAX_LIMIT] so a
 * malformed admin call cannot serialize the whole table.
 */
export async function listOpenViolations(
    sql: postgres.Sql,
    opts: ListOpenViolationsOptions = {},
): Promise<IntegrityViolation[]> {
    const safeLimit = Math.max(1, Math.min(MAX_LIMIT, opts.limit ?? 100));

    // Build the predicate inline rather than concatenating — keeps things
    // parameterized. The `${sql} fragment composition pattern is documented
    // in the existing query modules but verbose; a 2-axis filter switch is
    // cleaner here.
    if (opts.rule && opts.severity) {
        const rows = await sql<ViolationRow[]>`
            SELECT id, rule, severity, media_id, details,
                   detected_at, resolved_at, resolution
            FROM integrity_violations
            WHERE resolved_at IS NULL
              AND rule = ${opts.rule}
              AND severity = ${opts.severity}
            ORDER BY detected_at DESC
            LIMIT ${safeLimit}
        `;
        return rows.map(rowToViolation);
    }
    if (opts.rule) {
        const rows = await sql<ViolationRow[]>`
            SELECT id, rule, severity, media_id, details,
                   detected_at, resolved_at, resolution
            FROM integrity_violations
            WHERE resolved_at IS NULL
              AND rule = ${opts.rule}
            ORDER BY detected_at DESC
            LIMIT ${safeLimit}
        `;
        return rows.map(rowToViolation);
    }
    if (opts.severity) {
        const rows = await sql<ViolationRow[]>`
            SELECT id, rule, severity, media_id, details,
                   detected_at, resolved_at, resolution
            FROM integrity_violations
            WHERE resolved_at IS NULL
              AND severity = ${opts.severity}
            ORDER BY detected_at DESC
            LIMIT ${safeLimit}
        `;
        return rows.map(rowToViolation);
    }
    const rows = await sql<ViolationRow[]>`
        SELECT id, rule, severity, media_id, details,
               detected_at, resolved_at, resolution
        FROM integrity_violations
        WHERE resolved_at IS NULL
        ORDER BY detected_at DESC
        LIMIT ${safeLimit}
    `;
    return rows.map(rowToViolation);
}

/**
 * Count open violations grouped by rule. Cheap badge query for admin nav and
 * the integrity dashboard summary card.
 */
export async function countOpenViolationsByRule(
    sql: postgres.Sql,
): Promise<Record<string, number>> {
    const rows = await sql<Array<{ rule: string; count: string }>>`
        SELECT rule, COUNT(*)::text AS count
        FROM integrity_violations
        WHERE resolved_at IS NULL
        GROUP BY rule
    `;
    const result: Record<string, number> = {};
    for (const row of rows) {
        result[row.rule] = parseInt(row.count, 10);
    }
    return result;
}

export interface IntegrityRuleSummary {
    counts: Record<string, number>;
    severities: Record<string, IntegritySeverity>;
}

/** Attention needs both the count and the highest open severity for each rule. */
export async function summarizeOpenViolationsByRule(
    sql: postgres.Sql,
): Promise<IntegrityRuleSummary> {
    const rows = await sql<Array<{ rule: string; count: string; severity_rank: number }>>`
        SELECT rule, COUNT(*)::text AS count,
               MAX(CASE severity WHEN 'critical' THEN 3 WHEN 'high' THEN 2
                   WHEN 'medium' THEN 1 ELSE 0 END) AS severity_rank
        FROM integrity_violations
        WHERE resolved_at IS NULL
        GROUP BY rule
    `;
    const summary: IntegrityRuleSummary = { counts: {}, severities: {} };
    const severityLevels: IntegritySeverity[] = ['low', 'medium', 'high', 'critical'];
    for (const row of rows) {
        summary.counts[row.rule] = parseInt(row.count, 10);
        summary.severities[row.rule] = severityLevels[row.severity_rank];
    }
    return summary;
}

/**
 * Bulk auto-resolve open findings for a given rule that are NOT in the
 * "still open" set computed by the latest scan pass. Used by the scanner to
 * close stale findings without needing N round-trips of clearViolation calls.
 *
 * `keepMediaIds` is the array of media_ids the rule still surfaces. Anything
 * else for this rule with `resolved_at IS NULL` gets stamped resolved.
 *
 * Pass an empty array when no findings remain — that resolves *all* open
 * findings for the rule (matches the "rule cleared" case).
 *
 * For global rules (`media_id IS NULL`), pass `keepGlobal=true` to keep the
 * NULL-mediaId row open, or `false` to resolve it. We need this distinction
 * because UUIDs in `keepMediaIds` cannot represent the NULL row.
 *
 * Returns count of rows auto-resolved.
 */
export async function reconcileViolationsForRule(
    sql: postgres.Sql,
    rule: string,
    keepMediaIds: string[],
    keepGlobal: boolean,
): Promise<number> {
    const rows = await sql<{ id: string }[]>`
        UPDATE integrity_violations
        SET resolved_at = NOW(),
            resolution  = 'auto-resolved by scanner (no longer surfaced)'
        WHERE rule = ${rule}
          AND resolved_at IS NULL
          AND CASE
                WHEN media_id IS NULL THEN ${!keepGlobal}::boolean
                ELSE NOT (media_id::text = ANY(${keepMediaIds}::text[]))
              END
        RETURNING id
    `;
    return rows.length;
}
