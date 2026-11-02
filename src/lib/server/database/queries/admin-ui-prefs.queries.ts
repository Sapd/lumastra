// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin UI Preferences Query Module (admin IA redesign, spec §4).
 *
 * Per-admin-user preferences for the admin area. Currently just the nav style
 * (sidebar | mega). Keyed by the internal users.id UUID.
 */

import type postgres from 'postgres';

/** The stored nav style; DB column is free text but only these are valid. */
export type StoredNavStyle = 'sidebar' | 'mega';

export interface AdminUiPrefsRow {
    user_id: string;
    nav_style: string;
    updated_at: Date;
}

/**
 * Read one user's admin UI prefs. Returns null when the user has never set any.
 */
export async function getAdminUiPrefs(
    sql: postgres.Sql,
    userId: string,
): Promise<AdminUiPrefsRow | null> {
    const rows = await sql<AdminUiPrefsRow[]>`
        SELECT user_id, nav_style, updated_at
        FROM admin_user_ui_prefs
        WHERE user_id = ${userId}
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/**
 * Upsert one user's admin nav style. Returns the stored row.
 */
export async function upsertAdminNavStyle(
    sql: postgres.Sql,
    userId: string,
    navStyle: StoredNavStyle,
): Promise<AdminUiPrefsRow> {
    const rows = await sql<AdminUiPrefsRow[]>`
        INSERT INTO admin_user_ui_prefs (user_id, nav_style, updated_at)
        VALUES (${userId}, ${navStyle}, now())
        ON CONFLICT (user_id) DO UPDATE SET
            nav_style = EXCLUDED.nav_style,
            updated_at = now()
        RETURNING user_id, nav_style, updated_at
    `;
    return rows[0];
}
