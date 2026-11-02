// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { MusicAlbumFolderTrack } from './music-album-folder.queries.js';

export interface MusicNfoSource {
    fileId: string;
    trackId: string;
    filePath: string;
    /** Known placement on the new-ingest path; reject a move before NFO work. */
    albumId?: string;
    artistId?: string;
}
export interface MusicNfoOwner {
    id: string;
    title: string;
    year: number | null;
    metadata_locked: boolean;
    custom_metadata: Record<string, unknown> | null;
}
export interface MusicNfoSnapshot {
    album: MusicNfoOwner;
    library_group_id: string | null;
    artist: MusicNfoOwner | null;
    track_metadata: Record<string, unknown> | null;
    identities: Array<{ media_id: string; provider: string; external_id: string }>;
    token: unknown;
}

/** Scanner-only read, bound to the physical file and its whole-track association. */
export async function readMusicNfoSnapshot(
    sql: postgres.Sql,
    source: MusicNfoSource,
): Promise<MusicNfoSnapshot | undefined> {
    // Internal library maintenance; no user-facing catalogue read.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const [row] = await sql<MusicNfoSnapshot[]>`
        SELECT f.library_group_id, to_jsonb(a) AS album, to_jsonb(ar) AS artist, t.custom_metadata AS track_metadata,
            ids.identities,
            jsonb_build_array(to_jsonb(f), f.xmin::text, to_jsonb(fi), fi.xmin::text,
                to_jsonb(t), t.xmin::text, to_jsonb(a), a.xmin::text,
                to_jsonb(ar), ar.xmin::text, ids.identities) AS token
        FROM media_files f
        JOIN media_file_items fi ON fi.file_id=f.id
        JOIN media_items t ON t.id=fi.media_item_id AND t.media_type='track' AND t.status='active' AND t.is_dismissed IS NOT TRUE
        JOIN media_items a ON a.id=t.parent_id AND a.media_type='album' AND a.status='active' AND a.is_dismissed IS NOT TRUE
        LEFT JOIN media_items ar ON ar.id=a.parent_id AND ar.media_type='artist' AND ar.status='active' AND ar.is_dismissed IS NOT TRUE
        CROSS JOIN LATERAL (
            SELECT COALESCE(jsonb_agg(jsonb_build_object('media_id', e.media_id,
                'provider', e.provider, 'external_id', e.external_id) ORDER BY e.media_id, e.provider, e.external_id), '[]'::jsonb) AS identities
            FROM external_ids e WHERE e.media_id IN (t.id, a.id, ar.id)
                AND e.provider IN ('musicbrainz_release', 'musicbrainz_releasegroup', 'musicbrainz')
        ) ids
        WHERE f.id=${source.fileId} AND f.file_path=${source.filePath}
          AND f.is_missing IS NOT TRUE AND t.id=${source.trackId}
          AND fi.start_offset_ms IS NULL AND fi.end_offset_ms IS NULL
          AND ${source.albumId ? sql`a.id=${source.albumId}` : sql`true`}
          AND ${source.artistId ? sql`ar.id=${source.artistId}` : sql`true`}
    `;
    return row;
}

export interface MusicNfoFolderEvidence extends MusicAlbumFolderTrack {
    file_id: string;
    track_id: string;
    artist_id: string | null;
    token: unknown;
}

/**
 * Live physical occupants across ALL groups. Filter direct/disc occupants
 * before the bound; arbitrary nested albums cannot consume this NFO's cap.
 * The disc pattern comes from the same resolver used by scanner placement.
 */
export async function readMusicNfoFolderEvidence(
    sql: postgres.Sql,
    albumDir: string,
    discFolderPattern: string,
): Promise<MusicNfoFolderEvidence[]> {
    const prefix = albumDir + '/';
    const escaped = prefix.replace(/\\/g, '\\\\').replace(/[%_]/g, '\\$&');
    const discTrackPattern = '^' + discFolderPattern.slice(1, -1) + '/[^/]+$';
    // Scanner maintenance evidence, scoped to one physical album directory.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    return sql<MusicNfoFolderEvidence[]>`
        SELECT f.id AS file_id, f.file_path, t.id AS track_id, a.id AS album_id,
            ar.id AS artist_id, a.title AS album_title, a.metadata_locked AS album_locked,
            COALESCE(a.custom_metadata, '{}'::jsonb) AS album_metadata,
            COALESCE(t.custom_metadata, '{}'::jsonb) AS track_metadata,
            ARRAY(SELECT e.external_id FROM external_ids e WHERE e.media_id=a.id AND e.provider='musicbrainz_release' ORDER BY e.external_id) AS release_ids,
            ARRAY(SELECT e.external_id FROM external_ids e WHERE e.media_id=a.id AND e.provider='musicbrainz_releasegroup' ORDER BY e.external_id) AS release_group_ids,
            jsonb_build_array(to_jsonb(f), f.xmin::text, to_jsonb(fi), fi.xmin::text,
                to_jsonb(t), t.xmin::text, to_jsonb(a), a.xmin::text, to_jsonb(ar), ar.xmin::text,
                (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM external_ids e
                 WHERE e.media_id IN (t.id, a.id, ar.id) AND e.provider IN ('musicbrainz_release', 'musicbrainz_releasegroup', 'musicbrainz'))) AS token
        FROM media_files f
        JOIN media_file_items fi ON fi.file_id=f.id
        JOIN media_items t ON t.id=fi.media_item_id AND t.media_type='track' AND t.status='active' AND t.is_dismissed IS NOT TRUE
        JOIN media_items a ON a.id=t.parent_id AND a.media_type='album' AND a.status='active' AND a.is_dismissed IS NOT TRUE
        LEFT JOIN media_items ar ON ar.id=a.parent_id AND ar.media_type='artist' AND ar.status='active' AND ar.is_dismissed IS NOT TRUE
        CROSS JOIN LATERAL (SELECT substring(f.file_path FROM length(${prefix}::text)+1) AS relative) p
        WHERE f.file_path LIKE ${escaped + '%'} ESCAPE '\\'
          AND f.is_missing IS NOT TRUE
          AND (position('/' IN p.relative)=0 OR p.relative ~* ${discTrackPattern})
        ORDER BY f.id, t.id, fi.start_offset_ms NULLS FIRST, fi.end_offset_ms NULLS FIRST
        LIMIT 1001
    `;
}

/**
 * Acquire the entire reviewed bounded population: all files in UUID order,
 * then all media owners in UUID order, then their dependent links/identities.
 * NOWAIT is mandatory on the write attempt: no lock wait may age the already
 * finished filesystem evidence. A separate DB-only settling transaction may
 * wait, release every lock, and let the coordinator repeat filesystem I/O.
 */
export async function lockMusicNfoSnapshot(
    tx: postgres.Sql,
    source: MusicNfoSource,
    snapshot: MusicNfoSnapshot,
    evidence: MusicNfoFolderEvidence[] = [],
    wait = true,
): Promise<void> {
    const fileIds = [...new Set([source.fileId, ...evidence.map((row) => row.file_id)])];
    const ids = [
        ...new Set([
            source.trackId,
            snapshot.album.id,
            ...(snapshot.artist ? [snapshot.artist.id] : []),
            ...evidence.flatMap((row) => [
                row.track_id,
                row.album_id,
                ...(row.artist_id ? [row.artist_id] : []),
            ]),
        ]),
    ];
    const mode = wait ? tx`` : tx`NOWAIT`;
    await tx`SELECT id FROM media_files WHERE id=ANY(${fileIds}::uuid[]) ORDER BY id FOR UPDATE ${mode}`;
    // Internal scanner mutation owners, not a user-facing catalogue query.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    await tx`SELECT id FROM media_items WHERE id=ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE ${mode}`;
    await tx`SELECT file_id FROM media_file_items WHERE file_id=ANY(${fileIds}::uuid[]) AND media_item_id=ANY(${ids}::uuid[]) ORDER BY file_id, media_item_id, start_offset_ms NULLS FIRST, end_offset_ms NULLS FIRST FOR SHARE ${mode}`;
    await tx`SELECT id FROM external_ids WHERE media_id=ANY(${ids}::uuid[]) AND provider IN ('musicbrainz_release', 'musicbrainz_releasegroup', 'musicbrainz') ORDER BY id FOR SHARE ${mode}`;
}

/** The caller owns the snapshot locks and has revalidated on the current rows. */
export async function writeMusicNfoBackfill(
    sql: postgres.Sql,
    owner: MusicNfoOwner,
    metadata: Record<string, unknown>,
    year: number | null = owner.year,
): Promise<boolean> {
    const rows = await sql`
        UPDATE media_items SET custom_metadata=${sql.json(metadata as never)}, year=${year}
        WHERE id=${owner.id} AND NOT metadata_locked
          AND custom_metadata IS NOT DISTINCT FROM ${owner.custom_metadata === null ? null : sql.json(owner.custom_metadata as never)}::jsonb
          AND year IS NOT DISTINCT FROM ${owner.year}::int
        RETURNING id
    `;
    return rows.count > 0;
}
