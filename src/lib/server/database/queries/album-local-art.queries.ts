// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type postgres from 'postgres';

export interface AlbumReleaseIdentifiers {
    barcode?: string;
    catalogueNumber?: string;
    year?: number;
}
export interface LocalAlbumTrack {
    track_id: string;
    track_order: number | null;
    file_path: string | null;
    poster_path: string | null;
}

/** Recover local art for available albums, including permanent upstream misses. */
export async function findLocalAlbumArtCandidates(
    sql: postgres.Sql,
    limit: number,
): Promise<{ id: string }[]> {
    return sql<{ id: string }[]>`SELECT mi.id FROM media_items mi
        WHERE media_type = 'album' AND status = 'active'
          AND has_files = true AND NOT is_dismissed
          AND NOT EXISTS (SELECT 1 FROM image_candidates ma WHERE ma.media_item_id = mi.id AND ma.artwork_type = 'poster')
          AND (album_local_art_checked_at IS NULL OR album_local_art_checked_at < now() - interval '1 day')
        ORDER BY album_local_art_checked_at NULLS FIRST, id LIMIT ${limit}`;
}
export async function markLocalAlbumArtChecked(sql: postgres.Sql, albumId: string): Promise<void> {
    await sql`UPDATE media_items mi SET album_local_art_checked_at = now() WHERE id = ${albumId}
        AND NOT EXISTS (SELECT 1 FROM image_candidates ma WHERE ma.media_item_id = mi.id AND ma.artwork_type = 'poster')`;
}
export async function getLocalAlbumTracks(
    sql: postgres.Sql,
    albumId: string,
): Promise<LocalAlbumTrack[]> {
    return sql<
        LocalAlbumTrack[]
    >`SELECT DISTINCT mi.id AS track_id, mi.sort_order AS track_order, mf.file_path, ma.file_path AS poster_path
        FROM media_items mi
        JOIN media_file_items mfi ON mfi.media_item_id = mi.id
        JOIN media_files mf ON mf.id = mfi.file_id AND NOT mf.is_missing
        LEFT JOIN image_candidates ma ON ma.media_item_id = mi.id AND ma.artwork_type = 'poster' AND ma.source = 'local' AND ma.selected
        WHERE mi.parent_id = ${albumId} AND mi.media_type = 'track' AND mi.status = 'active'
          AND NOT mi.is_dismissed
        ORDER BY track_order NULLS LAST, mi.id, mf.file_path`;
}
export async function persistAlbumReleaseIdentifiers(
    sql: postgres.Sql,
    albumId: string,
    ids: AlbumReleaseIdentifiers,
): Promise<void> {
    if (!ids.barcode && !ids.catalogueNumber) return;
    await sql`UPDATE media_items
        SET album_release_barcode = COALESCE(album_release_barcode, ${ids.barcode ?? null}),
            album_release_catalogue_number = COALESCE(album_release_catalogue_number, ${ids.catalogueNumber ?? null})
        WHERE id = ${albumId} AND media_type = 'album' AND NOT metadata_locked`;
}
export async function getAlbumReleaseIdentifiers(
    sql: postgres.Sql,
    albumId: string,
): Promise<AlbumReleaseIdentifiers> {
    const [row] = await sql<
        {
            album_release_barcode: string | null;
            album_release_catalogue_number: string | null;
            year: number | null;
        }[]
    >`
        SELECT album_release_barcode, album_release_catalogue_number, year FROM media_items WHERE id = ${albumId}`;
    return {
        barcode: row?.album_release_barcode ?? undefined,
        catalogueNumber: row?.album_release_catalogue_number ?? undefined,
        year: row?.year ?? undefined,
    };
}
