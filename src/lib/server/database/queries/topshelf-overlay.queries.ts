// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type postgres from 'postgres';

export interface MediaItemOverlayFields {
    mediaType: string;
    title: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
    customLogoUrl: string | null;
    updatedAt: string;
}

/** Cheap single-row read of the fields the Top Shelf overlay resolver needs. */
export async function getMediaItemOverlayFields(
    sql: postgres.Sql,
    mediaId: string,
): Promise<MediaItemOverlayFields | null> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- access decision lives upstream: the Top Shelf preview endpoint is parent-gated (signed-URL, per-user auth) before this internal resolver ever runs.
    const rows = await sql<
        {
            media_type: string;
            title: string | null;
            season_number: number | null;
            episode_number: number | null;
            custom_logo_url: string | null;
            updated_at: Date | string;
        }[]
    >`
        SELECT mi.media_type, mi.title, mi.season_number, mi.episode_number,
               mi.custom_logo_url, mi.updated_at
        FROM media_items mi
        WHERE mi.id = ${mediaId}
        LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
        mediaType: row.media_type,
        title: row.title,
        seasonNumber: row.season_number,
        episodeNumber: row.episode_number,
        customLogoUrl: row.custom_logo_url,
        updatedAt:
            row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
}
