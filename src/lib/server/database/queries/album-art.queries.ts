// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Query functions for deferred album cover art fetching.
 */
import type postgres from 'postgres';

export interface AlbumFolderOccupantRow {
    file_path: string;
    album_id: string | null;
}

/**
 * Return every track whose media_file lives under `albumDir` (any depth),
 * along with its parent album id. Caller decides which tracks actually
 * resolve back to `albumDir` after disc-subfolder collapse.
 *
 * `dirPrefix` MUST include the trailing separator to avoid false matches
 * like `/music/Foo` also matching `/music/Foobar/...`. Wildcard characters
 * (`%`, `_`, `\`) in the prefix are escaped so a literal directory name
 * like `Various_Artists` doesn't act as a single-char wildcard.
 *
 * Capped at 512 rows — callers only need enough samples to establish that
 * at least two distinct albums occupy the directory, and the surrounding
 * scan path runs once per audio file so unbounded scans would be O(n²)
 * against a large VA folder.
 */
export async function findTracksUnderDir(
    sql: postgres.Sql,
    dirPrefix: string,
): Promise<AlbumFolderOccupantRow[]> {
    const escaped = dirPrefix.replace(/\\/g, '\\\\').replace(/[%_]/g, '\\$&');
    return sql<AlbumFolderOccupantRow[]>`
        SELECT DISTINCT mf.file_path, mi.parent_id AS album_id
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        JOIN media_items mi ON mi.id = mfi.media_item_id
        WHERE mi.media_type = 'track'
          AND mi.status = 'active' AND NOT mi.is_dismissed AND NOT mf.is_missing
          AND mf.file_path LIKE ${escaped + '%'} ESCAPE '\\'
        LIMIT 512
    `;
}

/** Find albums flagged for cover art fetch during scan. */
export async function findAlbumsNeedingCoverArt(
    sql: postgres.Sql,
): Promise<{ id: string; title: string }[]> {
    return sql<{ id: string; title: string }[]>`
        SELECT mi.id, mi.title FROM media_items mi
        WHERE mi.media_type = 'album'
          AND mi.status = 'active' AND NOT mi.is_dismissed AND mi.has_files = true
          AND (mi.custom_metadata->>'needs_cover_art_fetch')::boolean = true
          AND NOT EXISTS (
              SELECT 1 FROM image_candidates ma
              WHERE ma.media_item_id = mi.id
                AND ma.artwork_type = 'poster'
                AND ma.source = 'local'
          )
        ORDER BY mi.created_at DESC
    `;
}

/** Clear the cover art fetch flag after processing (success or failure). */
export async function clearCoverArtFetchFlag(sql: postgres.Sql, albumId: string): Promise<void> {
    await sql`
        UPDATE media_items
        SET custom_metadata = custom_metadata - 'needs_cover_art_fetch'
        WHERE id = ${albumId}
    `;
}

/** Find a track file path for a given album (for AcoustID fingerprinting). */
export async function findTrackFileForAlbum(
    sql: postgres.Sql,
    albumId: string,
): Promise<{
    filePath: string;
    trackId: string;
    title?: string;
    artist?: string;
    album?: string;
    duration?: number;
} | null> {
    const rows = await sql<
        {
            file_path: string;
            track_id: string;
            title: string | null;
            custom_metadata: Record<string, unknown> | null;
            runtime_seconds: number | null;
        }[]
    >`
        SELECT mf.file_path, mi.id AS track_id, mi.title,
               mi.custom_metadata, mi.runtime_seconds
        FROM media_items mi
        JOIN media_file_items mfi ON mfi.media_item_id = mi.id
        JOIN media_files mf ON mf.id = mfi.file_id
        WHERE mi.parent_id = ${albumId} AND mi.media_type = 'track'
          AND mi.status = 'active' AND NOT mi.is_dismissed AND NOT mf.is_missing
        LIMIT 1
    `;
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
        filePath: row.file_path,
        trackId: row.track_id,
        title: row.title ?? undefined,
        artist: (row.custom_metadata?.artist as string) ?? undefined,
        album: (row.custom_metadata?.album as string) ?? undefined,
        duration: row.runtime_seconds ?? undefined,
    };
}
