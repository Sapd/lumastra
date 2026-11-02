// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

/** Online-match Undo owns assignments, ancestry and source windows. Provider refreshes and watch state remain independent. */
export async function captureEpisodeExchangeChoice(
    sql: postgres.Sql,
    first: string,
    second: string,
): Promise<unknown> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- Admin-only recovery evidence for explicit locked subjects; these records are not a library browse response.
    const [row] = await sql<{ state: unknown }[]>`SELECT jsonb_build_object(
        'owners',(SELECT jsonb_agg(jsonb_build_array(e.id,e.parent_id,e.status,e.canonical_id,e.metadata_locked,e.title_binding,
            s.id,s.parent_id,s.status,p.id,p.status) ORDER BY e.id)
            FROM media_items e LEFT JOIN media_items s ON s.id=e.parent_id LEFT JOIN media_items p ON p.id=s.parent_id
            WHERE e.id IN (${first},${second})),
        'rows',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM external_ids i
            WHERE media_id IN (${first},${second}) AND provider='tmdb' AND media_type='episode'),
        'links',(SELECT jsonb_agg(jsonb_build_object('link',to_jsonb(l),'path',f.file_path,'size',f.file_size_bytes,
            'mtime',f.file_mtime,'hash',f.file_hash_head,'duration',f.duration_seconds,'missing',f.is_missing)
            ORDER BY l.media_item_id,l.file_id) FROM media_file_items l JOIN media_files f ON f.id=l.file_id
            WHERE l.media_item_id IN (${first},${second}))
    ) AS state`;
    return row.state;
}
