// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which library currently owns an item's local artwork row.
 *
 * `image_candidates` holds ONE local row per (item, artwork type) — the upsert's
 * conflict key has no file path in it. When the same item has sidecars in two
 * library folders (a movie in both `/data/movies` and `/data/4kmovies`), each
 * folder's scan re-pointed that row at its own file, so both scans reported the
 * row "updated" on every cycle, forever, with nothing on disk changing. The
 * scanner asks this before writing and leaves a row that another enabled
 * library legitimately owns.
 */
import type postgres from 'postgres';
import type { ArtworkType } from '../../utils/media-extras.js';

/**
 * The file the item's local `artworkType` row points at, when that file lies
 * OUTSIDE `libraryRoot` but inside another ENABLED library path. Null when the
 * row does not exist, already belongs to `libraryRoot`, or points at a file no
 * enabled library covers (a removed/disabled library does not keep its claim).
 */
export async function findLocalArtworkOwnedByOtherLibrary(
    sql: postgres.Sql,
    mediaItemId: string,
    artworkType: ArtworkType,
    libraryRoot: string,
): Promise<string | null> {
    const root = libraryRoot.endsWith('/') ? libraryRoot : `${libraryRoot}/`;
    const [row] = await sql<[{ file_path: string }?]>`
        SELECT ma.file_path
        FROM image_candidates ma
        WHERE ma.media_item_id = ${mediaItemId}
          AND ma.artwork_type = ${artworkType}
          AND ma.source = 'local' AND NOT ma.suppressed
          AND COALESCE(ma.language, '') = ''
          AND ma.file_path IS NOT NULL
          AND NOT starts_with(ma.file_path, ${root})
          AND EXISTS (
              SELECT 1
              FROM library_paths lp
              WHERE lp.enabled
                AND starts_with(ma.file_path, rtrim(lp.path, '/') || '/')
          )
        LIMIT 1
    `;
    return row?.file_path ?? null;
}
