// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

export interface MusicAlbumFolderTrack {
    file_path: string;
    album_id: string;
    album_title: string;
    album_locked: boolean;
    album_created_at: Date;
    album_metadata: Record<string, unknown>;
    track_metadata: Record<string, unknown>;
    release_ids: string[];
    release_group_ids: string[];
}

/** Bounded folder evidence; the scanner rejects a result that reaches the cap. */
export async function findMusicAlbumFolderTracks(
    sql: postgres.Sql,
    dirPrefix: string,
    libraryGroupId: string | null,
): Promise<MusicAlbumFolderTrack[]> {
    const escaped = dirPrefix.replace(/\\/g, '\\\\').replace(/[%_]/g, '\\$&');
    // Internal scanner identity lookup, scoped to its library path/group; no viewer is involved.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    return sql<MusicAlbumFolderTrack[]>`
        SELECT f.file_path, a.id AS album_id, a.title AS album_title, a.metadata_locked AS album_locked,
               a.created_at AS album_created_at,
               COALESCE(a.custom_metadata, '{}'::jsonb) AS album_metadata,
               COALESCE(t.custom_metadata, '{}'::jsonb) || jsonb_build_object('title', t.title) AS track_metadata,
               ARRAY(SELECT e.external_id FROM external_ids e
                     WHERE e.media_id=a.id AND e.provider='musicbrainz_release') AS release_ids,
               ARRAY(SELECT e.external_id FROM external_ids e
                     WHERE e.media_id=a.id AND e.provider='musicbrainz_releasegroup') AS release_group_ids
          FROM media_files f
          JOIN media_file_items fi ON fi.file_id=f.id
          JOIN media_items t ON t.id=fi.media_item_id
          JOIN media_items a ON a.id=t.parent_id
         WHERE f.file_path LIKE ${escaped + '%'} ESCAPE '\\'
           AND f.library_group_id IS NOT DISTINCT FROM ${libraryGroupId}
           AND f.is_missing IS NOT TRUE
           AND t.media_type='track' AND t.status='active'
           AND a.media_type='album' AND a.status='active'
         LIMIT 1001
    `;
}

export interface AlbumArtistEvidenceRow {
    id: string;
    title: string;
    parent_id: string | null;
    artist_title: string | null;
    metadata_locked: boolean;
    track_metadata: Record<string, unknown>[];
    release_mbid: string | null;
    release_group_mbid: string | null;
    file_path: string | null;
    library_root: string | null;
}

/** The same live file-backed track population used by scanner placement. */
export async function findAlbumArtistEvidence(
    sql: postgres.Sql,
    albumId: string,
): Promise<AlbumArtistEvidenceRow | undefined> {
    // Maintenance reads every track of its candidate album; viewer filtering would corrupt the decision.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const [row] = await sql<AlbumArtistEvidenceRow[]>`
        SELECT a.id, a.title, a.parent_id, p.title AS artist_title, a.metadata_locked,
               COALESCE(a.custom_metadata->>'musicbrainz_album_id',
                   (SELECT e.external_id FROM external_ids e WHERE e.media_id=a.id AND e.provider='musicbrainz_release' LIMIT 1)) AS release_mbid,
               COALESCE(a.custom_metadata->>'musicbrainz_releasegroup_id',
                   (SELECT e.external_id FROM external_ids e WHERE e.media_id=a.id AND e.provider='musicbrainz_releasegroup' LIMIT 1)) AS release_group_mbid,
               ARRAY(SELECT COALESCE(t.custom_metadata, '{}'::jsonb) || jsonb_build_object('title', t.title)
                     FROM media_items t WHERE t.parent_id=a.id
                     AND t.media_type='track' AND t.status='active'
                     AND EXISTS (SELECT 1 FROM media_file_items fi JOIN media_files f ON f.id=fi.file_id
                                 WHERE fi.media_item_id=t.id AND f.is_missing IS NOT TRUE)
                     ORDER BY t.id) AS track_metadata,
               live.file_path,
               (SELECT lp.path FROM library_paths lp
                WHERE live.file_path = lp.path OR starts_with(live.file_path, rtrim(lp.path, '/') || '/')
                ORDER BY length(lp.path) DESC LIMIT 1) AS library_root
          FROM media_items a LEFT JOIN media_items p ON p.id=a.parent_id
          LEFT JOIN LATERAL (
              SELECT f.file_path FROM media_items t
              JOIN media_file_items fi ON fi.media_item_id=t.id
              JOIN media_files f ON f.id=fi.file_id
              WHERE t.parent_id=a.id AND t.media_type='track' AND t.status='active'
                AND f.is_missing IS NOT TRUE
              ORDER BY f.file_path, t.id LIMIT 1
          ) live ON true
         WHERE a.id=${albumId} AND a.media_type='album'
         FOR UPDATE OF a
    `;
    return row;
}
