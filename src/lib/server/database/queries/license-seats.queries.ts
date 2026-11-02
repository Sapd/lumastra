// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * License Seat Count Query Module (AGPL core).
 *
 * Pure SQL — no side effects, no imports from proprietary modules. The
 * proprietary license service calls this to populate `seatsInUse` for the
 * admin page and seat-overflow checks. The AGPL core never calls this for
 * enforcement — it only surfaces the count as an informational metric.
 *
 * "Active seat" definition:
 *   A user who is not disabled, not soft-deleted, and whose `last_seen_at`
 *   falls within the configured activity window (default 30 days). This mirrors
 *   the industry-standard "monthly active user" definition used in per-seat
 *   licensing agreements.
 *
 * The partial index `idx_users_active_seats ON users(last_seen_at)
 * WHERE disabled_at IS NULL AND deleted_at IS NULL` (migration 16.97.0) keeps
 * this query fast on large installs.
 */

import type postgres from 'postgres';

/**
 * Count the number of distinct active users within the given activity window.
 *
 * @param sql   - A `postgres.Sql` connection (or transaction).
 * @param windowDays - Activity window in days. Defaults to 30 (monthly active).
 *                    Must be a positive integer; clamped to [1, 365].
 * @returns     The count of active (non-disabled, non-deleted) users who were
 *              last seen within `windowDays` days. Returns 0 on an empty table
 *              or when no users have a recent `last_seen_at`.
 */
export async function countActiveSeats(
    sql: postgres.Sql,
    windowDays: number = 30,
): Promise<number> {
    // Clamp to a safe positive integer so this is always a valid INTERVAL.
    const days = Math.max(1, Math.min(365, Math.floor(windowDays)));

    const rows = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text AS count
        FROM users
        WHERE disabled_at IS NULL
          AND deleted_at  IS NULL
          AND last_seen_at > now() - (${days} || ' days')::interval
    `;
    return parseInt(rows[0]?.count ?? '0', 10);
}
