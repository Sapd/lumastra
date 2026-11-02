// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type postgres from 'postgres';
import type { ArtistTracksResponse } from '$lib/schemas/music-credit-review.js';
export interface ArtistTracksFilter {
    q: string;
    issue: 'all' | 'missing-file' | 'missing-lyrics';
    sort: 'album' | 'title';
    page: number;
}
/** Admin inventory includes unavailable tracks. Membership uses the same indexed
 * additional_artist_ids projection as public music reads, plus canonical credits
 * for older records whose projection has not yet been reconciled. */
export async function getAdminArtistTracks(
    sql: postgres.Sql,
    id: string,
    filter: ArtistTracksFilter,
): Promise<ArtistTracksResponse> {
    // Internal tracks endpoint enforces auth.kind=admin before querying inventory.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-gated catalog inventory includes unavailable tracks
    const [result] = await sql<{ result: ArtistTracksResponse }[]>`
        WITH candidates AS (
            SELECT t.id FROM media_items t JOIN media_items a ON a.id=t.parent_id
            WHERE t.media_type='track' AND a.media_type='album' AND a.parent_id=${id}
            UNION
            SELECT t.id FROM media_items t WHERE t.media_type='track' AND t.custom_metadata->'additional_artist_ids' @> ${sql.json([id])}
            UNION
            SELECT t.id FROM media_items t WHERE t.media_type='track' AND
                (t.custom_metadata->'track_artist_credits' @> ${sql.json([{ id }])}
                OR t.custom_metadata->'track_remixer_credits' @> ${sql.json([{ id }])}
                OR t.custom_metadata->'remixer_artist_ids' @> ${sql.json([id])})
        ), catalog AS (
            SELECT t.id,t.title,t.sort_order,t.runtime_seconds,t.custom_metadata,
                a.id AS album_id,a.title AS album_title,a.year AS album_year,
                EXISTS(SELECT 1 FROM media_items l WHERE l.parent_id=t.id AND l.media_type='lyrics') OR (t.custom_metadata ? 'lyrics') AS has_lyrics,
                f.file_path,
                COALESCE(CASE WHEN jsonb_typeof(t.custom_metadata->'disc_number')='number' THEN (t.custom_metadata->>'disc_number')::numeric END,1) AS disc
            FROM candidates c JOIN media_items t ON t.id=c.id
            LEFT JOIN media_items a ON a.id=t.parent_id AND a.media_type='album'
            LEFT JOIN LATERAL (SELECT f.file_path FROM media_file_items l JOIN media_files f ON f.id=l.file_id
                WHERE l.media_item_id=t.id AND NOT f.is_missing ORDER BY l.is_default DESC,l.sort_order,f.id LIMIT 1) f ON true
            WHERE (a.id IS NULL OR (a.status='active' AND NOT a.is_dismissed AND a.canonical_id IS NULL)) AND t.status='active' AND NOT t.is_dismissed AND t.canonical_id IS NULL
        ), filtered AS (
            SELECT * FROM catalog WHERE (${filter.q}='' OR POSITION(LOWER(${filter.q}) IN LOWER(COALESCE(title,'')))>0)
                AND (${filter.issue}!='missing-file' OR file_path IS NULL)
                AND (${filter.issue}!='missing-lyrics' OR NOT has_lyrics)
        ), page AS (
            SELECT * FROM filtered ORDER BY
                CASE WHEN ${filter.sort}='title' THEN title END NULLS LAST,
                album_year NULLS LAST,album_title NULLS LAST,album_id,disc,sort_order NULLS LAST,title,id
            LIMIT 50 OFFSET ${(filter.page - 1) * 50}
        ) SELECT jsonb_build_object('tracks',COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM page p),'[]'::jsonb),
            'total',(SELECT COUNT(*) FROM filtered),'catalogTotal',(SELECT COUNT(*) FROM catalog),
            'durationSeconds',(SELECT COALESCE(SUM(runtime_seconds),0) FROM catalog),'page',${filter.page}::int,'pageSize',50) AS result`;
    return result.result;
}

export async function getAdminTrackContainerType(
    sql: postgres.Sql,
    id: string,
): Promise<string | null> {
    // Called by the same admin-only tracks endpoint before container dispatch.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- upstream endpoint owns the admin access decision
    const [row] = await sql<
        { media_type: string }[]
    >`SELECT media_type FROM media_items WHERE id=${id}`;
    return row?.media_type ?? null;
}
