// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music Admin Query Module
 *
 * Pure SQL queries for the music admin hierarchy view.
 * All functions take sql: postgres.Sql as first parameter, no side effects.
 *
 * Hierarchy:
 *   Artist  → media_type = 'artist'
 *   Album   → media_type = 'album'
 *   Track   → media_type = 'track'
 *
 * @module queries/music-admin
 */

import type postgres from 'postgres';
import { getAdminArtistTracks, getAdminTrackContainerType } from './admin-artist-tracks.queries.js';

// =============================================================================
// Interfaces
// =============================================================================

export interface MusicHierarchyArtist {
    id: string;
    title: string;
    custom_poster_url: string | null;
    album_count: number;
    track_count: number;
}

export interface MusicHierarchyAlbum {
    id: string;
    title: string;
    year: number | null;
    custom_poster_url: string | null;
    track_count: number;
    sort_order: number | null;
}

export interface MusicHierarchyTrack {
    id: string;
    title: string | null;
    sort_order: number | null;
    runtime_seconds: number | null;
    album_id: string;
}

export interface MusicHierarchyResult {
    artist: MusicHierarchyArtist;
    albums: Array<MusicHierarchyAlbum & { tracks: MusicHierarchyTrack[] }>;
}

export interface AdminAlbumRow {
    id: string;
    title: string;
    year: number | null;
    custom_poster_url: string | null;
    track_count: number;
    total_duration_seconds: number;
    album_type: string | null;
    sort_order: number | null;
}

export interface AdminTrackRow {
    id: string;
    title: string | null;
    sort_order: number | null;
    runtime_seconds: number | null;
    custom_metadata: Record<string, unknown> | null;
    has_lyrics: boolean;
    file_path: string | null;
}

export interface OrphanedMusicItem {
    id: string;
    title: string | null;
    media_type: string;
    parent_id: string | null;
    reason: string;
}

// =============================================================================
// Hierarchy queries
// =============================================================================

/**
 * Load artist + all albums + all tracks in one efficient query pattern.
 * Returns null if artistId does not resolve to an artist.
 */
export async function getMusicHierarchy(
    sql: postgres.Sql,
    artistId: string,
): Promise<MusicHierarchyResult | null> {
    const artistRows = await sql<MusicHierarchyArtist[]>`
        SELECT
            mi.id,
            mi.title,
            mi.custom_poster_url,
            (
                SELECT COUNT(*)::int
                FROM media_items albums
                WHERE albums.parent_id = mi.id
                  AND albums.media_type = 'album'
            ) AS album_count,
            (
                SELECT COUNT(*)::int
                FROM media_items albums
                JOIN media_items tracks ON tracks.parent_id = albums.id
                  AND tracks.media_type = 'track'
                WHERE albums.parent_id = mi.id
                  AND albums.media_type = 'album'
            ) AS track_count
        FROM media_items mi
        WHERE mi.id = ${artistId}
          AND mi.media_type = 'artist'
        LIMIT 1
    `;

    if (artistRows.length === 0) return null;

    const artist = artistRows[0];

    const albumRows = await sql<MusicHierarchyAlbum[]>`
        SELECT
            mi.id,
            mi.title,
            mi.year,
            mi.custom_poster_url,
            mi.sort_order,
            (
                SELECT COUNT(*)::int
                FROM media_items tracks
                WHERE tracks.parent_id = mi.id
                  AND tracks.media_type = 'track'
            ) AS track_count
        FROM media_items mi
        WHERE mi.parent_id = ${artistId}
          AND mi.media_type = 'album'
        ORDER BY COALESCE(mi.year, 0) ASC, mi.title ASC
    `;

    if (albumRows.length === 0) {
        return { artist, albums: [] };
    }

    const albumIds = albumRows.map((a) => a.id);

    const trackRows = await sql<MusicHierarchyTrack[]>`
        SELECT
            mi.id,
            mi.title,
            mi.sort_order,
            mi.runtime_seconds,
            mi.parent_id AS album_id
        FROM media_items mi
        WHERE mi.parent_id = ANY(${albumIds})
          AND mi.media_type = 'track'
        ORDER BY
            mi.parent_id,
            -- disc_number is GUARDED, not cast bare: custom_metadata is freeform
            -- jsonb and PUT /api/admin/media/bulk-metadata merges arbitrary
            -- admin-supplied keys into it verbatim, so a string ("1/2") can land
            -- here. In an ORDER BY a bare ::int fails the WHOLE statement, so one
            -- such row 500s the entire page. See getAlbumWithTracks in
            -- music.queries.ts for the full rationale.
            COALESCE(
                CASE WHEN jsonb_typeof(mi.custom_metadata #> '{disc_number}') = 'number'
                     THEN (mi.custom_metadata #>> '{disc_number}')::int
                END, 1) ASC,
            COALESCE(mi.sort_order, 9999) ASC,
            mi.title ASC
    `;

    const tracksByAlbum = new Map<string, MusicHierarchyTrack[]>();
    for (const track of trackRows) {
        const albumId = track.album_id;
        if (!tracksByAlbum.has(albumId)) tracksByAlbum.set(albumId, []);
        tracksByAlbum.get(albumId)!.push(track);
    }

    const albums = albumRows.map((album) => ({
        ...album,
        tracks: tracksByAlbum.get(album.id) ?? [],
    }));

    return { artist, albums };
}

/**
 * Album count for an artist, for a caller that only needs the count — not the
 * full hierarchy `getMusicHierarchy` loads, or the per-album track counts and
 * durations `getAlbumsForArtist` loads. Used by the admin media detail page to
 * decide whether the hierarchy sidebar has enough to show without paying for
 * either heavier query.
 */
export async function getArtistAlbumCount(sql: postgres.Sql, artistId: string): Promise<number> {
    const [row] = await sql<[{ album_count: number }]>`
        SELECT COUNT(*)::int AS album_count
        FROM media_items
        WHERE parent_id = ${artistId}
          AND media_type = 'album'
    `;
    return row?.album_count ?? 0;
}

// =============================================================================
// Albums for artist
// =============================================================================

/**
 * Load all albums for an artist with track count, total duration, and album_type.
 */
export async function getAlbumsForArtist(
    sql: postgres.Sql,
    artistId: string,
): Promise<AdminAlbumRow[]> {
    return sql<AdminAlbumRow[]>`
        SELECT
            mi.id,
            mi.title,
            mi.year,
            mi.custom_poster_url,
            mi.sort_order,
            COALESCE(mi.custom_metadata->>'album_type', null) AS album_type,
            (
                SELECT COUNT(*)::int
                FROM media_items tracks
                WHERE tracks.parent_id = mi.id
                  AND tracks.media_type = 'track'
            ) AS track_count,
            (
                SELECT COALESCE(SUM(tracks.runtime_seconds), 0)::int
                FROM media_items tracks
                WHERE tracks.parent_id = mi.id
                  AND tracks.media_type = 'track'
                  AND tracks.runtime_seconds IS NOT NULL
            ) AS total_duration_seconds
        FROM media_items mi
        WHERE mi.parent_id = ${artistId}
          AND mi.media_type = 'album'
        ORDER BY COALESCE(mi.year, 0) ASC, mi.title ASC
    `;
}

// =============================================================================
// Tracks for album
// =============================================================================

/**
 * Load all tracks for an album with custom_metadata, lyrics indicator, and file path.
 */
export async function getTracksForAlbum(
    sql: postgres.Sql,
    albumId: string,
): Promise<AdminTrackRow[]> {
    return sql<AdminTrackRow[]>`
        SELECT
            mi.id,
            mi.title,
            mi.sort_order,
            mi.runtime_seconds,
            COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
            EXISTS(
                SELECT 1
                FROM media_items lyrics_item
                WHERE lyrics_item.parent_id = mi.id
                  AND lyrics_item.media_type = 'lyrics'
            ) OR (mi.custom_metadata ? 'lyrics') AS has_lyrics,
            mf.file_path AS file_path
        FROM media_items mi
        LEFT JOIN LATERAL (
            SELECT f.file_path FROM media_file_items link
            JOIN media_files f ON f.id=link.file_id
            WHERE link.media_item_id=mi.id AND NOT f.is_missing
            ORDER BY link.is_default DESC, link.sort_order, f.id
            LIMIT 1
        ) mf ON true
        WHERE mi.parent_id = ${albumId}
          AND mi.media_type = 'track'
        ORDER BY
            -- disc_number is GUARDED, not cast bare: custom_metadata is freeform
            -- jsonb and PUT /api/admin/media/bulk-metadata merges arbitrary
            -- admin-supplied keys into it verbatim, so a string ("1/2") can land
            -- here. In an ORDER BY a bare ::int fails the WHOLE statement, so one
            -- such row 500s the entire page. See getAlbumWithTracks in
            -- music.queries.ts for the full rationale.
            COALESCE(
                CASE WHEN jsonb_typeof(mi.custom_metadata #> '{disc_number}') = 'number'
                     THEN (mi.custom_metadata #>> '{disc_number}')::numeric
                END, 1) ASC,
            COALESCE(mi.sort_order, 9999) ASC,
            mi.title ASC
    `;
}

// =============================================================================
// Orphaned items
// =============================================================================

/**
 * Find music items with broken parent chains:
 * - Tracks without a valid album parent
 * - Albums without a valid artist parent
 */
export async function getOrphanedMusicItems(sql: postgres.Sql): Promise<OrphanedMusicItem[]> {
    return sql<OrphanedMusicItem[]>`
        -- Tracks whose parent is not an album
        SELECT
            mi.id,
            mi.title,
            mi.media_type,
            mi.parent_id,
            'track without album parent' AS reason
        FROM media_items mi
        WHERE mi.media_type = 'track'
          AND (
              mi.parent_id IS NULL
              OR NOT EXISTS (
                  SELECT 1 FROM media_items parent
                  WHERE parent.id = mi.parent_id
                    AND parent.media_type = 'album'
              )
          )

        UNION ALL

        -- Albums whose parent is not an artist
        SELECT
            mi.id,
            mi.title,
            mi.media_type,
            mi.parent_id,
            'album without artist parent' AS reason
        FROM media_items mi
        WHERE mi.media_type = 'album'
          AND (
              mi.parent_id IS NULL
              OR NOT EXISTS (
                  SELECT 1 FROM media_items parent
                  WHERE parent.id = mi.parent_id
                    AND parent.media_type = 'artist'
              )
          )

        ORDER BY reason, title
    `;
}

export interface MusicContainerSummary {
    albumCount: number;
    trackCount: number;
    totalSeconds: number;
}
/** Admin-scoped aggregate: containers have descendant audio, not missing direct files. */
export async function getMusicContainerSummary(
    sql: postgres.Sql,
    mediaId: string,
): Promise<MusicContainerSummary> {
    const [row] = await sql<Array<{ albums: number; tracks: number; seconds: number }>>`
        WITH children AS (
            SELECT id, media_type, runtime_seconds FROM media_items WHERE parent_id=${mediaId} AND status='active'
            UNION ALL
            SELECT child.id, child.media_type, child.runtime_seconds FROM media_items child
            JOIN media_items parent ON parent.id=child.parent_id
            WHERE parent.parent_id=${mediaId} AND child.status='active'
        )
        SELECT COUNT(*) FILTER (WHERE media_type='album')::int AS albums,
            COUNT(*) FILTER (WHERE media_type='track')::int AS tracks,
            COALESCE(SUM(runtime_seconds) FILTER (WHERE media_type='track'),0)::float8 AS seconds
        FROM children
    `;
    const artistCatalog =
        (await getAdminTrackContainerType(sql, mediaId)) === 'artist'
            ? await getAdminArtistTracks(sql, mediaId, {
                  q: '',
                  issue: 'all',
                  sort: 'album',
                  page: 1,
              })
            : null;
    return {
        albumCount: row?.albums ?? 0,
        trackCount: artistCatalog?.catalogTotal ?? row?.tracks ?? 0,
        totalSeconds: artistCatalog?.durationSeconds ?? row?.seconds ?? 0,
    };
}
