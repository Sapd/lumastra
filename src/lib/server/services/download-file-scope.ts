// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * File-level library scope for downloads.
 *
 * `checkMediaAccess` is an ITEM-level gate: an item with files in two libraries is visible
 * when at least one file is allowed. A download hands out one FILE, so the file itself has
 * to be in a library the caller may read: the default file must be the best ALLOWED one,
 * and an explicit `fileId` / Jellyfin `mediaSourceId` / play token naming a denied file is
 * a 404, exactly like an item the caller cannot see.
 *
 * A file's library is `media_files.library_group_id` (NULL = no library, open to all),
 * judged against the groups `getDeniedLibraryGroups` yields for the user. These helpers
 * throw on a database error: callers fail closed.
 */

import type postgres from 'postgres';
import {
    getDeniedLibraryGroups,
    toLibraryAccessUser,
} from '$lib/server/cache/library-group-permissions-cache.js';

type ScopeUser = Parameters<typeof toLibraryAccessUser>[0];

/** Library groups the user may not read, or null when nothing is denied (admin, no restrictions). */
export async function deniedLibraryGroupsFor(
    sql: postgres.Sql,
    user: ScopeUser,
): Promise<string[] | null> {
    return getDeniedLibraryGroups(sql, toLibraryAccessUser(user));
}

/** Of `fileIds`, the ones whose library the caller may read. `denied` null = all of them. */
export async function allowedFileIds(
    sql: postgres.Sql,
    fileIds: readonly string[],
    denied: readonly string[] | null,
): Promise<Set<string>> {
    if (!denied || denied.length === 0) return new Set(fileIds);
    if (fileIds.length === 0) return new Set();
    const rows = await sql<{ id: string }[]>`
        SELECT mf.id::text AS id FROM media_files mf
        WHERE mf.id = ANY(${[...fileIds]}::uuid[])
          AND (mf.library_group_id IS NULL OR mf.library_group_id != ALL(${[...denied]}::uuid[]))
    `;
    return new Set(rows.map((r) => r.id));
}

/** Whether the file at `filePath` is in a library the caller may read (a path no row names is allowed). */
export async function isFilePathInScope(
    sql: postgres.Sql,
    filePath: string,
    denied: readonly string[] | null,
): Promise<boolean> {
    if (!denied || denied.length === 0) return true;
    const rows = await sql<{ denied: boolean }[]>`
        SELECT bool_and(mf.library_group_id IS NOT NULL
                        AND mf.library_group_id = ANY(${[...denied]}::uuid[])) AS denied
        FROM media_files mf WHERE mf.file_path = ${filePath}
    `;
    return rows[0]?.denied !== true;
}

/**
 * Restrict a playback selection to the allowed files. An explicit selection (one file) that
 * is denied becomes empty; a default selection falls to the default-else-first allowed file.
 */
export function scopeSelection<F extends { id: string; is_default?: boolean | null }>(
    selection: { files: F[]; fileId: string | null },
    allowed: ReadonlySet<string>,
): { files: F[]; fileId: string | null } {
    const files = selection.files.filter((f) => allowed.has(f.id));
    if (files.length === 0) return { files: [], fileId: null };
    if (selection.fileId && allowed.has(selection.fileId))
        return { files, fileId: selection.fileId };
    return { files, fileId: (files.find((f) => f.is_default) ?? files[0]).id };
}
