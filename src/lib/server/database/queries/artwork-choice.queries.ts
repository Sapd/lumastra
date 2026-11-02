// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { isUuid } from '$lib/server/utils/media-key-parser.js';

/** Exact curation state, including asset identity so stale Undo cannot select different bytes. */
export async function captureArtworkChoice(sql: postgres.Sql, owner: string): Promise<unknown> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- Admin-only recovery evidence for explicit locked subjects; these records are not a library browse response.
    const [row] = await sql<{ state: unknown }[]>`
        SELECT jsonb_build_object(
            'urls',(SELECT jsonb_build_object('poster',custom_poster_url,'thumb',custom_thumb_url,
                'backdrop',custom_backdrop_url,'logo',custom_logo_url) FROM media_items
                WHERE id=${isUuid(owner) ? owner : null}::uuid),
            'candidates', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'id',id,'selected',selected,'locked',locked,'chosen_by',chosen_by,
                'selection_order',selection_order,'sort_order',sort_order,'suppressed',suppressed,
                'file_path',file_path,'remote_url',remote_url,'provider',provider,
                'provider_ref',provider_ref,'local_content_hash',local_content_hash,
                'source',source,'width',width,'height',height,'language',language
            ) ORDER BY id) FROM image_candidates WHERE
                media_item_id=${isUuid(owner) ? owner : null}::uuid OR person_ref=${isUuid(owner) ? null : owner}), '[]'),
            'legacy',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM media_artwork a
                WHERE media_item_id=${isUuid(owner) ? owner : null}::uuid),'[]'),
            'providers',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY provider,role)
                FROM image_provider_suppressions p WHERE p.owner=${owner}), '[]'),
            'paths',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY artwork_type,file_path)
                FROM media_artwork_suppressions p WHERE media_item_id=${isUuid(owner) ? owner : null}::uuid), '[]')
        ) AS state`;
    return row.state;
}

/** Caller holds the artwork owner lock and has verified the receipt's complete after-state. */
export async function restoreArtworkChoice(
    sql: postgres.Sql,
    owner: string,
    state: unknown,
): Promise<void> {
    const snapshot = sql.json(state as postgres.JSONValue);
    const [settings] = await sql<{ election: string | null; mirror: string | null }[]>`
        SELECT current_setting('lumastra.image_storage_normalization',true) AS election,
            current_setting('lumastra.image_provenance_backfill',true) AS mirror`;
    await sql`SELECT set_config('lumastra.image_storage_normalization','on',true),
        set_config('lumastra.image_provenance_backfill','on',true)`;
    await sql`DELETE FROM image_provider_suppressions WHERE image_provider_suppressions.owner=${owner}`;
    await sql`INSERT INTO image_provider_suppressions (owner,provider,role)
        SELECT owner,provider,role FROM jsonb_to_recordset(${snapshot}::jsonb->'providers')
        AS p(owner text,provider text,role text)`;
    if (isUuid(owner)) {
        await sql`UPDATE media_items SET custom_poster_url=${snapshot}::jsonb#>>'{urls,poster}',
            custom_thumb_url=${snapshot}::jsonb#>>'{urls,thumb}',
            custom_backdrop_url=${snapshot}::jsonb#>>'{urls,backdrop}',
            custom_logo_url=${snapshot}::jsonb#>>'{urls,logo}' WHERE id=${owner}`;
        await sql`DELETE FROM media_artwork_suppressions WHERE media_item_id=${owner}`;
        await sql`INSERT INTO media_artwork_suppressions (media_item_id,artwork_type,file_path,created_at)
            SELECT media_item_id,artwork_type,file_path,created_at
            FROM jsonb_to_recordset(${snapshot}::jsonb->'paths')
            AS p(media_item_id uuid,artwork_type text,file_path text,created_at timestamptz)`;
    }
    // Retain new upload/extraction candidates as history. Never delete their files.
    await sql`UPDATE image_candidates SET selected=false,locked=false,chosen_by='auto',suppressed=true
        WHERE media_item_id=${isUuid(owner) ? owner : null}::uuid OR person_ref=${isUuid(owner) ? null : owner}`;
    await sql`UPDATE image_candidates c SET selected=p.selected,locked=p.locked,chosen_by=p.chosen_by,
        selection_order=p.selection_order,sort_order=p.sort_order,suppressed=p.suppressed,updated_at=now(),
        source=p.source,file_path=p.file_path,remote_url=p.remote_url,local_content_hash=p.local_content_hash,
        provider=p.provider,provider_ref=p.provider_ref,width=p.width,height=p.height,language=p.language
        FROM jsonb_to_recordset(${snapshot}::jsonb->'candidates') AS p(id uuid,selected boolean,
            locked boolean,chosen_by text,selection_order integer,sort_order integer,suppressed boolean,
            source text,file_path text,remote_url text,local_content_hash text,provider text,provider_ref text,width integer,height integer,language text)
        WHERE c.id=p.id AND (c.media_item_id=${isUuid(owner) ? owner : null}::uuid OR c.person_ref=${isUuid(owner) ? null : owner})`;
    if (isUuid(owner)) {
        // Reusing a URL can replace the bytes on the same candidate ID. Restore
        // its exact prior legacy mirror too, including the absence of a local mirror.
        await sql`DELETE FROM media_artwork WHERE media_item_id=${owner}`;
        await sql`INSERT INTO media_artwork SELECT * FROM jsonb_populate_recordset(NULL::media_artwork,${snapshot}::jsonb->'legacy')`;
    }
    await sql`SELECT set_config('lumastra.image_storage_normalization',${settings.election ?? ''},true),
        set_config('lumastra.image_provenance_backfill',${settings.mirror ?? ''},true)`;
}

export async function previousArtworkAssets(
    sql: postgres.Sql,
    state: unknown,
): Promise<{ file_path: string | null; local_content_hash: string | null }[]> {
    return sql<{ file_path: string | null; local_content_hash: string | null }[]>`
        SELECT file_path,local_content_hash FROM jsonb_to_recordset(${sql.json(state as postgres.JSONValue)}::jsonb->'candidates')
        AS p(file_path text,selected boolean,local_content_hash text) WHERE selected`;
}
