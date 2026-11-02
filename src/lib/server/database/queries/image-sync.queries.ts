// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Image Sync Queries
 *
 * Pure SQL queries for image sync operations — local artwork scanning
 * and video frame extraction. All functions take `sql: postgres.Sql` as first param.
 */
import type postgres from 'postgres';
import type { ArtworkType } from '../../utils/media-extras.js';
import { lockArtworkOwners } from './media-artwork.queries.js';

// ============================================================================
// Media item lookups
// ============================================================================

interface MediaItemForSync {
    id: string;
    media_type: string;
    parent_id: string | null;
    title: string;
}

/**
 * Get media item type + metadata for image sync scope inference.
 */
export async function getMediaItemForImageSync(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<MediaItemForSync | null> {
    const rows = await sql<MediaItemForSync[]>`
        SELECT id, media_type, parent_id, title
        FROM media_items
        WHERE id = ${mediaItemId}
    `;
    return rows[0] ?? null;
}

// ============================================================================
// Video path resolution
// ============================================================================

/**
 * Find video file path for a media item by traversing the hierarchy.
 *
 * Checks: direct file → parent (season) file → grandparent (series) file
 * in a single query using UNION ALL, replacing the old 4-query chain.
 *
 * Within each tier the `is_default` link wins. An item can link several
 * physical files — alternate versions, or a combined multi-episode file the
 * scanner range-linked (`S06E01E03.mkv` claiming episodes 1-3) — and only the
 * is_default row is "this item's file". The old query had neither an
 * is_default filter nor an ORDER BY, so `LIMIT 1` returned an arbitrary row.
 * That matters beyond picking a different copy of the same content: the
 * segment-distribution math in `buildEpisodeTimestampMap` resolves against
 * is_default, so disagreeing here extracted the frame from a DIFFERENT video
 * at a timestamp computed for this one — three Hafentage episodes ended up with
 * byte-identical thumbnails from a fourth episode's file.
 */
export async function findVideoFile(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<{ filePath: string; durationSeconds: number | null } | null> {
    const rows = await sql<{ file_path: string; duration_seconds: number | null }[]>`
        SELECT file_path, duration_seconds FROM (
            SELECT mf.file_path,
                   mf.duration_seconds,
                   0 AS tier,
                   CASE WHEN mfi.is_default THEN 0 ELSE 1 END AS pref
            FROM media_file_items mfi
            JOIN media_files mf ON mf.id = mfi.file_id AND mf.file_path IS NOT NULL
            WHERE mfi.media_item_id = ${mediaItemId}
            UNION ALL
            SELECT mf.file_path,
                   mf.duration_seconds,
                   1 AS tier,
                   CASE WHEN mfi.is_default THEN 0 ELSE 1 END AS pref
            FROM media_items mi
            JOIN media_file_items mfi ON mfi.media_item_id = mi.parent_id
            JOIN media_files mf ON mf.id = mfi.file_id AND mf.file_path IS NOT NULL
            WHERE mi.id = ${mediaItemId}
            UNION ALL
            SELECT mf.file_path,
                   mf.duration_seconds,
                   2 AS tier,
                   CASE WHEN mfi.is_default THEN 0 ELSE 1 END AS pref
            FROM media_items mi
            JOIN media_items season ON season.id = mi.parent_id
            JOIN media_file_items mfi ON mfi.media_item_id = season.parent_id
            JOIN media_files mf ON mf.id = mfi.file_id AND mf.file_path IS NOT NULL
            WHERE mi.id = ${mediaItemId}
        ) candidates
        ORDER BY tier, pref, file_path
        LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    // The stored duration lets a frame extraction skip its own ffprobe. Null
    // when the file was never probed; the caller then probes as before.
    return {
        filePath: row.file_path,
        durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    };
}

/** The path of the file {@link findVideoFile} picks. */
export async function findVideoPath(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<string | null> {
    return (await findVideoFile(sql, mediaItemId))?.filePath ?? null;
}

// ============================================================================
// Episode/season lookups for batch operations
// ============================================================================

/**
 * Get all episode IDs for a series (via seasons).
 */
export async function findEpisodesForSeries(
    sql: postgres.Sql,
    seriesId: string,
): Promise<{ id: string }[]> {
    return sql<{ id: string }[]>`
        SELECT id FROM media_items
        WHERE parent_id IN (
            SELECT id FROM media_items
            WHERE parent_id = ${seriesId}
              AND media_type = 'season'
        )
          AND media_type = 'episode'
    `;
}

/**
 * Find a video file path for a series item by looking at its descendant episodes.
 * Returns the first available file path, or null if none found.
 */
export async function findVideoPathForSeries(
    sql: postgres.Sql,
    seriesId: string,
): Promise<string | null> {
    const rows = await sql<{ file_path: string }[]>`
        SELECT mf.file_path
        FROM media_items episode
        JOIN media_file_items mfi ON mfi.media_item_id = episode.id
        JOIN media_files mf ON mf.id = mfi.file_id AND mf.file_path IS NOT NULL
        WHERE episode.parent_id IN (
            SELECT id FROM media_items
            WHERE parent_id = ${seriesId}
        )
        LIMIT 1
    `;
    return rows[0]?.file_path ?? null;
}

/**
 * Get all episode IDs for a season.
 */
export async function findEpisodesForSeason(
    sql: postgres.Sql,
    seasonId: string,
): Promise<{ id: string }[]> {
    return sql<{ id: string }[]>`
        SELECT id FROM media_items
        WHERE parent_id = ${seasonId}
          AND media_type = 'episode'
    `;
}

// ============================================================================
// Artwork existence checks
// ============================================================================

/**
 * Check if local artwork already exists for a media item and artwork type.
 */
export async function hasLocalArtwork(
    sql: postgres.Sql,
    mediaItemId: string,
    artworkType: string,
): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
        SELECT id FROM image_candidates
        WHERE media_item_id = ${mediaItemId}
          AND artwork_type = ${artworkType}
          AND source = 'local' AND NOT suppressed
        LIMIT 1
    `;
    return rows.length > 0;
}

/** One local artwork row, with everything the reaper needs to delete it safely. */
export interface LocalArtworkPathRow {
    /** image_candidates primary key — pass to deleteArtworkById. */
    id: string;
    /** Owning item; combined with artwork_type it identifies custom_<type>_url. */
    media_item_id: string;
    artwork_type: ArtworkType;
    file_path: string;
    version: string;
    provider: string;
    provider_ref: string;
    remote_url: string | null;
}

/**
 * Get all local artwork records (with file paths) for a set of media items.
 * Used to detect stale records whose files no longer exist on disk.
 *
 * Returns `media_item_id` + `artwork_type` as well as the row id: the reaper
 * deletes through `deleteArtworkById`, which clears the paired
 * `media_items.custom_<type>_url`, and that pairing cannot be derived from
 * `{ id, file_path }` alone.
 */
export async function getLocalArtworkPaths(
    sql: postgres.Sql,
    mediaItemIds: string[],
): Promise<LocalArtworkPathRow[]> {
    if (mediaItemIds.length === 0) return [];
    return sql<LocalArtworkPathRow[]>`
        SELECT id, media_item_id, artwork_type, file_path, updated_at::text AS version, provider, provider_ref, remote_url
        FROM image_candidates
        WHERE media_item_id = ANY(${sql.array(mediaItemIds)}::uuid[])
          AND source = 'local' AND NOT suppressed AND NOT locked AND chosen_by = 'auto'
          AND file_path IS NOT NULL
    `;
}

/**
 * Cursor page over the media items that own at least one local artwork file.
 *
 * Drives the artwork reaper's round-robin sweep: it must eventually visit
 * every local artwork row without ever loading the whole table, so it walks
 * media_item_id ascending and resumes from the last id it finished.
 *
 * Reads only `image_candidates` — no `media_items` join — so this is not a
 * user-facing catalogue read and needs no library/age scoping.
 */
export async function findMediaItemIdsWithLocalArtwork(
    sql: postgres.Sql,
    cursor: string | null,
    limit: number,
): Promise<string[]> {
    const rows = await sql<{ media_item_id: string }[]>`
        SELECT DISTINCT media_item_id
        FROM image_candidates
        WHERE source = 'local' AND NOT suppressed
          AND file_path IS NOT NULL
          AND (${cursor}::uuid IS NULL OR media_item_id > ${cursor}::uuid)
        ORDER BY media_item_id ASC
        LIMIT ${limit}
    `;
    return rows.map((r) => r.media_item_id);
}

/**
 * Columns on media_items that mirror a local artwork row's serve URL.
 * Mirrors `ARTWORK_URL_COLUMN` in media-artwork.queries.ts; `banner` has no
 * paired column and is intentionally absent.
 */
const ARTWORK_URL_COLUMN: Partial<Record<ArtworkType, string>> = {
    poster: 'custom_poster_url',
    backdrop: 'custom_backdrop_url',
    logo: 'custom_logo_url',
    thumb: 'custom_thumb_url',
};

/**
 * Delete artwork records by their IDs.
 * Used to clean up stale records after file existence checks.
 *
 * Maintains the same `custom_{type}_url` invariant as `deleteArtworkById`:
 * a local artwork row and its serve URL are one fact stored in two places, and
 * `upsertLocalArtwork` only ever claims a column that is NULL — so a pointer
 * left behind by a deleted row permanently blocks the replacement artwork from
 * publishing itself, and serves a miss until someone clears it by hand. Only
 * rows whose `source` is `local` can own a column, and the comparison is
 * against this item's own proxy URL, so provider URLs (TMDB/Jellyfin) and
 * admin uploads pointing elsewhere are never touched.
 */
export async function deleteArtworkByIds(sql: postgres.Sql, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        const owners = await tx<{ media_item_id: string }[]>`
            SELECT DISTINCT media_item_id FROM image_candidates WHERE id = ANY(${ids}::uuid[])
        `;
        await lockArtworkOwners(
            tx,
            owners.map((o) => o.media_item_id),
        );
        const deleted = await tx<
            { media_item_id: string; artwork_type: ArtworkType; source: string }[]
        >`
            DELETE FROM image_candidates WHERE id = ANY(${sql.array(ids)}::uuid[]) AND NOT locked AND NOT suppressed
            RETURNING media_item_id, artwork_type, source
        `;

        // Group the local deletions by artwork type: clearing per-type is what
        // keeps a poster deletion from also dropping a backdrop that still has
        // a live row behind it.
        const itemsByType = new Map<ArtworkType, string[]>();
        for (const row of deleted) {
            if (row.source !== 'local') continue;
            if (!ARTWORK_URL_COLUMN[row.artwork_type]) continue;
            const bucket = itemsByType.get(row.artwork_type);
            if (bucket) bucket.push(row.media_item_id);
            else itemsByType.set(row.artwork_type, [row.media_item_id]);
        }

        for (const [artworkType, mediaItemIds] of itemsByType) {
            const urlCol = ARTWORK_URL_COLUMN[artworkType] as string;
            await tx`
                UPDATE media_items
                SET ${tx(urlCol)} = NULL
                WHERE id = ANY(${tx.array(mediaItemIds)}::uuid[])
                  AND ${tx(urlCol)} = '/api/image/custom/' || id || '/' || ${artworkType}
                  AND NOT EXISTS (SELECT 1 FROM image_candidates c
                      WHERE c.media_item_id = media_items.id AND c.artwork_type = ${artworkType}
                        AND c.selected AND c.source = 'local' AND c.file_path IS NOT NULL)
            `;
        }

        return deleted.length;
    });
}

// ============================================================================
// Episode/season matching by numbers (for filename pattern matching)
// ============================================================================

/**
 * Find an episode by season number + episode number within a series.
 */
export async function findEpisodeByNumbers(
    sql: postgres.Sql,
    seriesId: string,
    seasonNumber: number,
    episodeNumber: number,
): Promise<string | null> {
    const rows = await sql<{ id: string }[]>`
        SELECT mi.id FROM media_items mi
        JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
        WHERE season.parent_id = ${seriesId}
          AND mi.media_type = 'episode'
          AND mi.season_number = ${seasonNumber}
          AND mi.episode_number = ${episodeNumber}
        LIMIT 1
    `;
    return rows[0]?.id ?? null;
}

/**
 * The type and numbering of a targeted image scan's anchor item — what
 * `scanImages` needs to tell the item's own artwork from a sibling's in a
 * shared folder.
 */
export async function getImageScanTarget(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<{
    media_type: string;
    season_number: number | null;
    episode_number: number | null;
} | null> {
    const [row] = await sql<
        { media_type: string; season_number: number | null; episode_number: number | null }[]
    >`
        SELECT media_type, season_number, episode_number
        FROM media_items
        WHERE id = ${mediaItemId}
    `;
    return row ?? null;
}

/**
 * Find a season by number within a series.
 */
export async function findSeasonByNumber(
    sql: postgres.Sql,
    seriesId: string,
    seasonNumber: number,
): Promise<string | null> {
    const rows = await sql<{ id: string }[]>`
        SELECT id FROM media_items
        WHERE parent_id = ${seriesId}
          AND media_type = 'season'
          AND season_number = ${seasonNumber}
        LIMIT 1
    `;
    return rows[0]?.id ?? null;
}

// ============================================================================
// File path discovery (for directory scanning)
// ============================================================================

/**
 * Get file paths for a media item's direct files.
 */
export async function getMediaFilePaths(sql: postgres.Sql, mediaItemId: string): Promise<string[]> {
    const rows = await sql<{ file_path: string }[]>`
        SELECT mf.file_path FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        WHERE mfi.media_item_id = ${mediaItemId}
          AND mf.file_path IS NOT NULL
    `;
    return rows.map((r) => r.file_path);
}

/**
 * Get file paths for episodes in a season or series (via child items).
 * Used to discover directories for scanning.
 */
export async function getEpisodeFilePaths(sql: postgres.Sql, parentId: string): Promise<string[]> {
    const rows = await sql<{ file_path: string }[]>`
        SELECT mf.file_path FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        JOIN media_items mi ON mi.id = mfi.media_item_id
        WHERE mi.parent_id = ${parentId}
          AND mf.file_path IS NOT NULL
    `;
    return rows.map((r) => r.file_path);
}

/**
 * Get file paths for series content (direct on series or through season→episode hierarchy).
 * Returns the first available file path from the series or its descendants.
 */
export async function getSeriesFilePaths(
    sql: postgres.Sql,
    seriesId: string,
): Promise<{ direct: string | null; episode: string | null }> {
    const [directRow] = await sql<{ file_path: string }[]>`
        SELECT mf.file_path FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        WHERE mfi.media_item_id = ${seriesId}
          AND mf.file_path IS NOT NULL
        LIMIT 1
    `;

    const [episodeRow] = await sql<{ file_path: string }[]>`
        SELECT mf.file_path FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        JOIN media_items episode ON episode.id = mfi.media_item_id
        JOIN media_items season ON season.id = episode.parent_id
        WHERE season.parent_id = ${seriesId}
          AND mf.file_path IS NOT NULL
        LIMIT 1
    `;

    return {
        direct: directRow?.file_path ?? null,
        episode: episodeRow?.file_path ?? null,
    };
}
