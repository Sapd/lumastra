// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Library Group Permissions Query Module
 *
 * Manages the library_group_permissions table which controls
 * per-library-group access restrictions using Authentik groups.
 */

import type postgres from 'postgres';

export interface LibraryGroupPermissionRow {
    library_group_id: string;
    allowed_groups: string[];
    updated_at: Date;
}

export interface UpsertLibraryGroupPermissionParams {
    libraryGroupId: string;
    allowedGroups: string[];
}

/**
 * Get all library group permission rows.
 * An empty result means no restrictions exist (all libraries are public).
 */
export async function getAllLibraryGroupPermissions(
    sql: postgres.Sql,
): Promise<LibraryGroupPermissionRow[]> {
    return sql<LibraryGroupPermissionRow[]>`
        SELECT library_group_id, allowed_groups, updated_at
        FROM library_group_permissions
    `;
}

/**
 * Upsert a library group permission.
 * Setting allowed_groups to [] effectively makes the library unrestricted
 * (but the row still exists — use deleteLibraryGroupPermission to fully remove).
 */
export async function upsertLibraryGroupPermission(
    sql: postgres.Sql,
    params: UpsertLibraryGroupPermissionParams,
): Promise<void> {
    await sql`
        INSERT INTO library_group_permissions (library_group_id, allowed_groups, updated_at)
        VALUES (${params.libraryGroupId}, ${params.allowedGroups}, NOW())
        ON CONFLICT (library_group_id) DO UPDATE
            SET allowed_groups = EXCLUDED.allowed_groups,
                updated_at     = NOW()
    `;
}

/**
 * Delete a library group permission, reverting it to unrestricted access.
 */
export async function deleteLibraryGroupPermission(
    sql: postgres.Sql,
    libraryGroupId: string,
): Promise<void> {
    await sql`
        DELETE FROM library_group_permissions
        WHERE library_group_id = ${libraryGroupId}
    `;
}
