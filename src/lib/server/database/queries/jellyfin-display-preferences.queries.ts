// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin DisplayPreferences Query Module
 *
 * Pure SQL queries backing the `/j/DisplayPreferences/*` compat routes.
 * `data` is stored and returned as an opaque JSON blob — the DTO shape
 * varies by client, so this module never inspects its fields.
 */

import type postgres from 'postgres';

/**
 * Look up a stored DisplayPreferences DTO.
 *
 * @returns The stored `data` JSONB, or null if the user has never saved to
 * this `(displayPrefsId, client)` pair.
 */
export async function getDisplayPreferences(
    sql: postgres.Sql,
    userId: string,
    displayPrefsId: string,
    client: string,
): Promise<Record<string, unknown> | null> {
    const rows = await sql<{ data: Record<string, unknown> }[]>`
        SELECT data
        FROM jellyfin_display_preferences
        WHERE user_id = ${userId}
          AND display_prefs_id = ${displayPrefsId}
          AND client = ${client}
    `;
    return rows[0]?.data ?? null;
}

/**
 * Insert or update a user's DisplayPreferences DTO for a given id/client.
 */
export async function upsertDisplayPreferences(
    sql: postgres.Sql,
    userId: string,
    displayPrefsId: string,
    client: string,
    data: Record<string, unknown>,
): Promise<void> {
    const jsonData = sql.json(data as Record<string, never>);
    await sql`
        INSERT INTO jellyfin_display_preferences (user_id, display_prefs_id, client, data)
        VALUES (${userId}, ${displayPrefsId}, ${client}, ${jsonData})
        ON CONFLICT (user_id, display_prefs_id, client) DO UPDATE SET
            data = ${jsonData},
            updated_at = NOW()
    `;
}

/**
 * True when a row already exists for this exact (user, displayPrefsId,
 * client) triple — i.e. the next upsert would be an UPDATE, not a new row.
 * Used to decide whether the per-user row cap (C6) applies: an update to an
 * existing (id, client) pair must never be refused for being "over quota".
 */
export async function displayPreferencesRowExists(
    sql: postgres.Sql,
    userId: string,
    displayPrefsId: string,
    client: string,
): Promise<boolean> {
    const rows = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
            SELECT 1 FROM jellyfin_display_preferences
            WHERE user_id = ${userId}
              AND display_prefs_id = ${displayPrefsId}
              AND client = ${client}
        ) AS exists
    `;
    return rows[0]?.exists ?? false;
}

/**
 * Count how many distinct (display_prefs_id, client) rows this user has
 * stored. Used to enforce the per-user row cap (C6) — every fresh
 * `(id, client)` pair is otherwise a brand new row with no cleanup task
 * touching the table, so an unauthenticated-cardinality client could grow it
 * without bound.
 */
export async function countDisplayPreferencesRowsForUser(
    sql: postgres.Sql,
    userId: string,
): Promise<number> {
    const rows = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM jellyfin_display_preferences
        WHERE user_id = ${userId}
    `;
    return rows[0]?.count ?? 0;
}
