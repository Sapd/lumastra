// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

export async function captureSegmentChoice(
    sql: postgres.Sql,
    ids: string[],
    type?: string,
): Promise<unknown> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- Admin-only recovery evidence for explicit locked subjects; these records are not a library browse response.
    const [row] = await sql<
        { state: unknown }[]
    >`SELECT jsonb_build_object('ids',${ids}::text[],'type',${type ?? null}::text,
        'segments',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM media_segments s
            WHERE media_id=ANY(${ids}::uuid[]) AND (${type ?? null}::text IS NULL OR s.type=${type ?? null})),'[]'),
        'candidates',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM media_segment_candidates c
            WHERE media_id=ANY(${ids}::uuid[]) AND (${type ?? null}::text IS NULL OR c.type=${type ?? null})),'[]'),
        'inputs',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'parent_id',m.parent_id,
            'status',m.status,'generation',m.media_segment_generation,
            'links',(SELECT COALESCE(jsonb_agg(jsonb_build_object('link',to_jsonb(l),'path',f.file_path,
                'size',f.file_size_bytes,'mtime',f.file_mtime,'hash',f.file_hash_head,'duration',f.duration_seconds,
                'missing',f.is_missing) ORDER BY l.file_id),'[]') FROM media_file_items l JOIN media_files f ON f.id=l.file_id
                WHERE l.media_item_id=m.id)) ORDER BY m.id) FROM media_items m WHERE m.id=ANY(${ids}::uuid[])),'[]')) AS state`;
    return row.state;
}

export async function segmentChoiceScope(
    sql: postgres.Sql,
    state: unknown,
): Promise<{ ids: string[]; type?: string }> {
    const value = sql.json(state as postgres.JSONValue);
    const rows = await sql<
        { id: string }[]
    >`SELECT jsonb_array_elements_text(${value}::jsonb->'ids') AS id`;
    const [row] = await sql<{ type: string | null }[]>`SELECT ${value}::jsonb->>'type' AS type`;
    return { ids: rows.map((r) => r.id), type: row.type ?? undefined };
}

export async function restoreSegmentChoice(
    sql: postgres.Sql,
    ids: string[],
    type: string | undefined,
    state: unknown,
): Promise<void> {
    const value = sql.json(state as postgres.JSONValue);
    await sql`DELETE FROM media_segments WHERE media_id=ANY(${ids}::uuid[]) AND (${type ?? null}::text IS NULL OR media_segments.type=${type ?? null})`;
    await sql`DELETE FROM media_segment_candidates WHERE media_id=ANY(${ids}::uuid[]) AND (${type ?? null}::text IS NULL OR media_segment_candidates.type=${type ?? null})`;
    await sql`INSERT INTO media_segment_candidates SELECT * FROM jsonb_populate_recordset(NULL::media_segment_candidates,${value}::jsonb->'candidates')`;
    await sql`INSERT INTO media_segments SELECT * FROM jsonb_populate_recordset(NULL::media_segments,${value}::jsonb->'segments')`;
}
