// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Active user count (monthly active users, for the admin status payload).
 *
 * "Active" means a user who is not disabled, not soft-deleted, and whose
 * `last_seen_at` falls within the window (default 30 days). The partial index
 * `idx_users_active_seats ON users(last_seen_at) WHERE disabled_at IS NULL AND
 * deleted_at IS NULL` (migration 16.97.0; the name is historical) keeps this
 * fast on large installs.
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
export async function countActiveUsers(
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
