// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

export interface LibraryTypeSetting {
    media_type: string;
    display_name: string | null;
    sidebar_visible: boolean;
    icon: string | null;
    sort_order: number;
    updated_at: Date;
}

/**
 * Get all library type settings.
 */
export async function getAllLibraryTypeSettings(sql: postgres.Sql): Promise<LibraryTypeSetting[]> {
    return await sql<LibraryTypeSetting[]>`
        SELECT media_type, display_name, sidebar_visible, icon, sort_order, updated_at
        FROM library_type_settings
        ORDER BY sort_order ASC, media_type ASC
    `;
}

/**
 * Get settings for a specific library type.
 */
export async function getLibraryTypeSetting(
    sql: postgres.Sql,
    mediaType: string,
): Promise<LibraryTypeSetting | undefined> {
    const rows = await sql<LibraryTypeSetting[]>`
        SELECT media_type, display_name, sidebar_visible, icon, sort_order, updated_at
        FROM library_type_settings
        WHERE media_type = ${mediaType}
    `;
    return rows[0];
}

/**
 * Upsert a library type setting (insert or update).
 */
export async function upsertLibraryTypeSetting(
    sql: postgres.Sql,
    setting: {
        mediaType: string;
        displayName: string | null;
        sidebarVisible: boolean;
        icon: string | null;
        sortOrder: number;
    },
): Promise<LibraryTypeSetting> {
    const rows = await sql<LibraryTypeSetting[]>`
        INSERT INTO library_type_settings (media_type, display_name, sidebar_visible, icon, sort_order, updated_at)
        VALUES (
            ${setting.mediaType},
            ${setting.displayName},
            ${setting.sidebarVisible},
            ${setting.icon},
            ${setting.sortOrder},
            now()
        )
        ON CONFLICT (media_type) DO UPDATE SET
            display_name = ${setting.displayName},
            sidebar_visible = ${setting.sidebarVisible},
            icon = ${setting.icon},
            sort_order = ${setting.sortOrder},
            updated_at = now()
        RETURNING media_type, display_name, sidebar_visible, icon, sort_order, updated_at
    `;
    return rows[0];
}

/**
 * Make sure a library type has a settings row, without touching the admin's
 * name, icon or order on an existing one. `reveal` also shows an existing row
 * in the sidebar (a use case that newly asks for the type); otherwise an
 * existing row — including one the admin hid — is left exactly as it is.
 * Returns whether a row was created or changed.
 */
export async function ensureLibraryTypeSetting(
    sql: postgres.Sql,
    setting: { mediaType: string; sortOrder: number; reveal: boolean },
): Promise<boolean> {
    const rows = setting.reveal
        ? await sql<{ media_type: string }[]>`
              INSERT INTO library_type_settings (media_type, display_name, sidebar_visible, icon, sort_order, updated_at)
              VALUES (${setting.mediaType}, NULL, true, NULL, ${setting.sortOrder}, now())
              ON CONFLICT (media_type) DO UPDATE SET sidebar_visible = true, updated_at = now()
                  WHERE library_type_settings.sidebar_visible IS DISTINCT FROM true
              RETURNING media_type
          `
        : await sql<{ media_type: string }[]>`
              INSERT INTO library_type_settings (media_type, display_name, sidebar_visible, icon, sort_order, updated_at)
              VALUES (${setting.mediaType}, NULL, true, NULL, ${setting.sortOrder}, now())
              ON CONFLICT (media_type) DO NOTHING
              RETURNING media_type
          `;
    return rows.length > 0;
}

/**
 * Delete a library type setting (revert to defaults).
 */
export async function deleteLibraryTypeSetting(
    sql: postgres.Sql,
    mediaType: string,
): Promise<boolean> {
    const result = await sql`
        DELETE FROM library_type_settings
        WHERE media_type = ${mediaType}
    `;
    return result.count > 0;
}
