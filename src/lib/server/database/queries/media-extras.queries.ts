// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media Extras Query Module
 *
 * Resolves a parent media item's local trailer child, and looks up an
 * item's media_type + parent_id. Used by the trailer playback feature:
 * the scanner ingests trailer files as `media_items` rows with
 * `media_type='extra'`, `extra_type='trailer'`, `parent_id` set to the
 * movie/series, and file linkage via `media_files`/`media_file_items`.
 */

import type postgres from 'postgres';

/**
 * Resolve the local trailer child of a media item (movie or series).
 * Returns the trailer's media_items UUID, or null when none exists.
 * Requires a present (non-missing) file so a deleted trailer disappears
 * from payloads/probes immediately after rescan.
 *
 * Access note: callers gate access on the PARENT item — extras' files may
 * carry library_group_id = NULL (pre-16.159.0 ingest), which
 * isMediaAccessible would treat as world-readable.
 */
export async function findLocalTrailerForItem(
    sql: postgres.Sql,
    parentMediaItemId: string,
): Promise<string | null> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- pure data tier: the query is structurally confined to `parent_id = ${parentMediaItemId}`, and every caller clears that parent id first, by one of two mechanisms. Direct gate: defs/playback/preview-session.ts (isMediaAccessible) and defs/playback/previews/index.ts (checkMediaAccess, via createPreview in preview-session.service.ts) and topshelf-render.service.ts (checkMediaAccess). Signed-URL gate: topshelf-preview/file/[variant].ts authorizes with verifySignedUrl instead — mint/serve split, same shape as audiobook-stream-auth. Gating the extra ITSELF would be WRONG — extras' files may carry library_group_id = NULL (pre-16.159.0 ingest), which isMediaAccessible would treat as world-readable.
    const rows = await sql<{ id: string }[]>`
        SELECT mi.id
        FROM media_items mi
        WHERE mi.parent_id = ${parentMediaItemId}
          AND mi.media_type = 'extra'
          AND mi.extra_type = 'trailer'
          AND EXISTS (
              SELECT 1
              FROM media_file_items mfi
              JOIN media_files mf ON mf.id = mfi.file_id
              WHERE mfi.media_item_id = mi.id
                AND mf.is_missing = false
          )
        ORDER BY mi.id
        LIMIT 1
    `;
    return rows[0]?.id ?? null;
}

/**
 * Resolve a non-null `library_group_id` for an item, walking its descendant
 * tree when the item itself has no files with a group set. Handles two
 * cases with one query:
 *   1. Direct: the item's OWN files carry a non-null group (movies,
 *      episodes — the common case).
 *   2. Descendant: the item is a PARENT with no files of its own (a series
 *      or season row has no `media_files` — only its episodes do), so walk
 *      down `parent_id` to find the first descendant file that has one.
 *
 * Used both by the extras scanner (`processExtra`) to inherit a group for a
 * trailer/featurette whose direct parent may be a series, and by the
 * 16.159.0 backfill migration for the same reason. Depth-limited (6 levels
 * — comfortably covers series → season → episode or artist → album → track)
 * to bound the recursive walk. Deterministic ordering (shallowest depth,
 * then file id) so re-running the query against unchanged data is stable.
 */
export async function findLibraryGroupForItemTree(
    sql: postgres.Sql,
    rootItemId: string,
): Promise<string | null> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- ingest-side, not a user-facing read: callers are the extras scanner (ancillary-processors.ts) and the 16.159.0 backfill migration, both of which run without a user context and exist precisely to COMPUTE the library_group_id that the access gate later reads. Scoping this by library access would be circular.
    const rows = await sql<{ library_group_id: string }[]>`
        WITH RECURSIVE item_tree AS (
            SELECT ${rootItemId}::uuid AS id, 0 AS depth
            UNION ALL
            SELECT mi.id, t.depth + 1
            FROM media_items mi
            JOIN item_tree t ON mi.parent_id = t.id
            WHERE t.depth < 6
        )
        SELECT mf.library_group_id
        FROM item_tree t
        JOIN media_file_items mfi ON mfi.media_item_id = t.id
        JOIN media_files mf ON mf.id = mfi.file_id
        WHERE mf.library_group_id IS NOT NULL
        ORDER BY t.depth ASC, mf.id ASC
        LIMIT 1
    `;
    return rows[0]?.library_group_id ?? null;
}

/**
 * Media type + parent of an item. Used by the preview endpoint to redirect
 * access checks on extras to their parent.
 */
export async function getMediaTypeAndParent(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<{ media_type: string; parent_id: string | null } | null> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- this IS the input to the access decision, not a bypass of it: it returns only media_type + parent_id so the caller can redirect an extra's access check onto its parent. Returns no title, artwork, or overview, so an unauthorized caller learns nothing beyond a parent UUID it must still pass a gate to use.
    const rows = await sql<{ media_type: string; parent_id: string | null }[]>`
        SELECT media_type, parent_id
        FROM media_items
        WHERE id = ${mediaItemId}
    `;
    return rows[0] ?? null;
}
