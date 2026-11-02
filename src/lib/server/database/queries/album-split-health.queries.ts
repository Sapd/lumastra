// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

export interface SplitAlbumPair {
    album_a: string;
    album_b: string;
    title_a: string;
    title_b: string;
}

/**
 * Rotating keyset batches avoid rescanning the catalogue every 15 minutes.
 * Keep previously found pairs until either album is checked again; FK cascades
 * remove merged/deleted pairs immediately. Indexed folder probes find peers
 * outside the batch, so a split across batch boundaries is still discovered.
 * Based on album-split-candidates.sql: stricter here — folder AND tag AND credit.
 */
export async function refreshSplitAlbumHealth(sql: postgres.Sql): Promise<number> {
    const [cursor] = await sql<{ after_id: string | null }[]>`
        SELECT after_id FROM album_split_health_cursor WHERE singleton FOR UPDATE
    `;
    // System health maintenance spans the catalogue; no viewer listing is served.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    let seeds = await sql<{ id: string }[]>`
        SELECT id FROM media_items WHERE media_type='album' AND status='active'
        AND id > COALESCE(${cursor?.after_id ?? null}::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
        ORDER BY id LIMIT 100
    `;
    if (!seeds.length)
        // System health maintenance spans the catalogue; no viewer listing is served.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        seeds = await sql<{ id: string }[]>`
        SELECT id FROM media_items WHERE media_type='album' AND status='active' ORDER BY id LIMIT 100
    `;
    if (seeds.length) {
        const ids = seeds.map((s) => s.id);
        await sql`DELETE FROM album_split_health_pairs WHERE album_a=ANY(${ids}::uuid[]) OR album_b=ANY(${ids}::uuid[])`;
        // System health maintenance spans the catalogue; no viewer listing is served.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        await sql`
            WITH evidence AS MATERIALIZED (
                SELECT a.id AS album_id, e.* FROM media_items a
                JOIN LATERAL (
                    SELECT f.library_group_id,
                        regexp_replace(regexp_replace(f.file_path, '/[^/]+$', ''),
                            '/(cd|disc|disk|vol(ume)?[.]?|part)[[:space:]]*[0-9]+$', '', 'i') AS folder,
                        lower(regexp_replace(trim(t.custom_metadata->>'album'),'[[:space:]_]+',' ','g')) AS album_tag,
                        CASE WHEN jsonb_typeof(t.custom_metadata->'album_artists')='array'
                             AND jsonb_array_length(t.custom_metadata->'album_artists')>0
                            THEN (SELECT string_agg(lower(regexp_replace(trim(v),'[[:space:]_]+',' ','g')), E'\x1f' ORDER BY n)
                                  FROM jsonb_array_elements_text(t.custom_metadata->'album_artists') WITH ORDINALITY AS c(v,n))
                            ELSE lower(regexp_replace(trim(t.custom_metadata->>'album_artist'),'[[:space:]_]+',' ','g')) END AS credit
                    FROM media_items t JOIN media_file_items fi ON fi.media_item_id=t.id JOIN media_files f ON f.id=fi.file_id
                    WHERE t.parent_id=a.id AND t.media_type='track' AND t.status='active' AND f.is_missing IS NOT TRUE
                    LIMIT 1000
                ) e ON true
                WHERE a.id=ANY(${ids}::uuid[]) AND NOT a.is_dismissed
            ), folders AS MATERIALIZED (
                SELECT DISTINCT album_id,library_group_id,folder,album_tag,credit FROM evidence
                WHERE album_tag<>'' AND credit<>'' LIMIT 1000
            ), matches AS (
                SELECT e.album_id, p.album_id AS peer FROM folders e
                JOIN LATERAL (
                    -- Expression equals idx_media_files_album_folder; never a global regex scan.
                    SELECT t.parent_id AS album_id,
                        lower(regexp_replace(trim(t.custom_metadata->>'album'),'[[:space:]_]+',' ','g')) AS album_tag,
                        CASE WHEN jsonb_typeof(t.custom_metadata->'album_artists')='array'
                             AND jsonb_array_length(t.custom_metadata->'album_artists')>0
                            THEN (SELECT string_agg(lower(regexp_replace(trim(v),'[[:space:]_]+',' ','g')), E'\x1f' ORDER BY n)
                                  FROM jsonb_array_elements_text(t.custom_metadata->'album_artists') WITH ORDINALITY AS c(v,n))
                            ELSE lower(regexp_replace(trim(t.custom_metadata->>'album_artist'),'[[:space:]_]+',' ','g')) END AS credit
                    FROM media_files f JOIN media_file_items fi ON fi.file_id=f.id JOIN media_items t ON t.id=fi.media_item_id
                    JOIN media_items a ON a.id=t.parent_id AND a.media_type='album' AND a.status='active' AND NOT a.is_dismissed
                    WHERE regexp_replace(regexp_replace(f.file_path, '/[^/]+$', ''),
                        '/(cd|disc|disk|vol(ume)?[.]?|part)[[:space:]]*[0-9]+$', '', 'i')=e.folder
                    AND f.library_group_id IS NOT DISTINCT FROM e.library_group_id AND f.is_missing IS NOT TRUE
                    AND t.media_type='track' AND t.status='active' AND t.parent_id<>e.album_id
                    LIMIT 1000
                ) p ON p.album_tag=e.album_tag AND p.credit=e.credit
            )
            INSERT INTO album_split_health_pairs (album_a,album_b)
            SELECT DISTINCT LEAST(album_id,peer),GREATEST(album_id,peer) FROM matches
            ON CONFLICT (album_a,album_b) DO UPDATE SET checked_at=now()
        `;
        await sql`UPDATE album_split_health_cursor SET after_id=${ids.at(-1)!} WHERE singleton`;
    }
    const [count] = await sql<
        { n: number }[]
    >`SELECT count(*)::int AS n FROM album_split_health_pairs`;
    return count?.n ?? 0;
}

export async function listSplitAlbumHealth(sql: postgres.Sql): Promise<SplitAlbumPair[]> {
    // System health maintenance spans the catalogue; no viewer listing is served.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    return sql<SplitAlbumPair[]>`
        SELECT p.album_a,p.album_b,a.title AS title_a,b.title AS title_b
        FROM album_split_health_pairs p JOIN media_items a ON a.id=p.album_a JOIN media_items b ON b.id=p.album_b
        ORDER BY p.album_a,p.album_b LIMIT 50
    `;
}
