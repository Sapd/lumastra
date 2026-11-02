// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type postgres from 'postgres';
import { withTx } from '../with-tx.js';
import { lockArtworkOwners } from './media-artwork.queries.js';
import { setAlbumCoverArtUrlIfNull } from './album-enrichment.queries.js';
import type { MusicProvenance } from '$lib/shared/music-provenance.js';

/** Replace credit only for slots actually written; untouched slots keep their source. */
export async function mergeMusicProvenance(
    sql: postgres.Sql,
    id: string,
    namespace: string,
    writtenFields: string[],
    provenance: MusicProvenance,
): Promise<void> {
    await sql`
        UPDATE media_items
        SET custom_metadata = (CASE WHEN jsonb_typeof(custom_metadata) = 'object' THEN custom_metadata ELSE '{}'::jsonb END) || jsonb_build_object(
            ${namespace}::text,
            (CASE WHEN jsonb_typeof(custom_metadata -> ${namespace}::text) = 'object' THEN custom_metadata -> ${namespace}::text ELSE '{}'::jsonb END) || jsonb_build_object(
                'provenance', (CASE WHEN jsonb_typeof(custom_metadata -> ${namespace}::text -> 'provenance') = 'object' THEN custom_metadata -> ${namespace}::text -> 'provenance' ELSE '{}'::jsonb END - ${writtenFields}::text[]) || ${sql.json(Object.fromEntries(Object.entries(provenance).map(([field, source]) => [field, { ...source }])))}::jsonb
            )
        )
        WHERE id = ${id}
    `;
}

/** Historical source is unknown. Only absent or explicitly plugin-owned slots may change. */
export async function writableAlbumArtwork(
    sql: postgres.Sql,
    id: string,
): Promise<{ poster: boolean; backdrop: boolean }> {
    // Background task and admin-only retry ownership check; no catalogue data is returned to a user.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const [row] = await sql<{ poster: boolean; backdrop: boolean }[]>`
        SELECT
            (custom_poster_url IS NULL OR custom_poster_url = custom_metadata #>> '{album_enrichment,provenance,poster,value}')
            AND NOT EXISTS (SELECT 1 FROM image_candidates WHERE media_item_id = mi.id AND artwork_type = 'poster' AND (locked OR chosen_by <> 'auto' OR (source = 'local' AND remote_url IS DISTINCT FROM 'album-enrichment'))) AS poster,
            (custom_backdrop_url IS NULL OR custom_backdrop_url = custom_metadata #>> '{album_enrichment,provenance,backdrop,value}')
            AND NOT EXISTS (SELECT 1 FROM image_candidates WHERE media_item_id = mi.id AND artwork_type = 'backdrop' AND (locked OR chosen_by <> 'auto' OR (source = 'local' AND remote_url IS DISTINCT FROM 'album-enrichment'))) AS backdrop
        FROM media_items mi WHERE id = ${id}
    `;
    return { poster: row?.poster === true, backdrop: row?.backdrop === true };
}

/** An upload may reuse the same proxy URL; clear the old credit when its bytes change. */
export async function clearMusicArtworkProvenance(
    sql: postgres.Sql,
    id: string,
    field: string,
): Promise<void> {
    if (field !== 'poster' && field !== 'backdrop') return;
    await sql`
        UPDATE media_items SET custom_metadata = custom_metadata
            #- ARRAY['artist_enrichment', 'provenance', ${field}]::text[]
            #- ARRAY['album_enrichment', 'provenance', ${field}]::text[]
        WHERE id = ${id}
          AND (custom_metadata #> ARRAY['artist_enrichment', 'provenance', ${field}]::text[] IS NOT NULL
            OR custom_metadata #> ARRAY['album_enrichment', 'provenance', ${field}]::text[] IS NOT NULL)
    `;
}

export async function getAlbumEnrichmentArtworkPaths(
    sql: postgres.Sql,
    id: string,
): Promise<Array<{ artwork_type: string; file_path: string }>> {
    return sql<Array<{ artwork_type: string; file_path: string }>>`
        SELECT artwork_type, file_path FROM image_candidates
        WHERE media_item_id = ${id} AND source = 'local' AND remote_url = 'album-enrichment' AND file_path IS NOT NULL
    `;
}

/** Atomically acquire an absent poster and its ownership record, after concurrent writers settle. */
export async function persistAlbumCoverArtFallback(
    sql: postgres.Sql,
    id: string,
    value: string,
): Promise<boolean> {
    return withTx(sql, async (tx) => {
        await lockArtworkOwners(tx, [id]);
        if (!(await writableAlbumArtwork(tx, id)).poster) return false;
        const changed = await setAlbumCoverArtUrlIfNull(tx, id, value);
        if (changed)
            await mergeMusicProvenance(tx, id, 'album_enrichment', ['poster'], {
                poster: { provider: 'coverartarchive', value },
            });
        return changed;
    });
}
