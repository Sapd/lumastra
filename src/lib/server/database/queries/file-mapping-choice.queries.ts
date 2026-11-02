// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

/** All displaced defaults and hidden states are part of the recovery contract. */
export async function captureFileMappingChoice(
    sql: postgres.Sql,
    fileId: string,
    ids: string[],
): Promise<unknown> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- Admin-only recovery evidence for explicit locked subjects; these records are not a library browse response.
    const [row] = await sql<{ state: unknown }[]>`
        SELECT jsonb_build_object('ids',${ids}::text[],
            'links',COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY file_id,media_item_id)
                FROM media_file_items l WHERE media_item_id=ANY(${ids}::uuid[])),'[]'),
            'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'parent_id',parent_id,
                'status',status,'is_dismissed',is_dismissed,'dismissed_at',dismissed_at) ORDER BY id)
                FROM media_items WHERE id=ANY(${ids}::uuid[])),'[]'),
            'files',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'file_path',file_path,
                'file_mtime',file_mtime,'file_size_bytes',file_size_bytes,'file_hash_head',file_hash_head,
                'duration_seconds',duration_seconds,'is_missing',is_missing) ORDER BY id)
                FROM media_files WHERE id=${fileId} OR id IN
                    (SELECT file_id FROM media_file_items WHERE media_item_id=ANY(${ids}::uuid[]))
                    OR id IN (SELECT file_id FROM manual_file_link_sets s WHERE s.file_id=${fileId} OR EXISTS (
                        SELECT 1 FROM media_files target WHERE target.id=${fileId}
                        AND s.file_hash_head=target.file_hash_head AND s.file_size_bytes=target.file_size_bytes))),'[]'),
            'sets',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY file_hash_head,file_size_bytes)
                FROM manual_file_link_sets s WHERE s.file_id=${fileId} OR EXISTS (
                    SELECT 1 FROM media_files f WHERE f.id=${fileId}
                    AND s.file_hash_head=f.file_hash_head AND s.file_size_bytes=f.file_size_bytes)),'[]'),
            'issues',(SELECT health_issues FROM media_files WHERE id=${fileId})
        ) AS state`;
    return row.state;
}

export async function fileMappingChoiceIds(sql: postgres.Sql, state: unknown): Promise<string[]> {
    const rows = await sql<
        { id: string }[]
    >`SELECT jsonb_array_elements_text(${sql.json(state as postgres.JSONValue)}::jsonb->'ids') AS id`;
    return rows.map((row) => row.id);
}

/** The service has locked every participant and checked the full after-state. */
export async function restoreFileMappingChoice(
    sql: postgres.Sql,
    fileId: string,
    ids: string[],
    state: unknown,
): Promise<void> {
    const snapshot = sql.json(state as postgres.JSONValue);
    await sql`DELETE FROM media_file_items WHERE media_item_id=ANY(${ids}::uuid[])`;
    await sql`INSERT INTO media_file_items SELECT * FROM jsonb_populate_recordset(NULL::media_file_items,${snapshot}::jsonb->'links')`;
    await sql`UPDATE media_items m SET is_dismissed=p.is_dismissed,dismissed_at=p.dismissed_at
        FROM jsonb_to_recordset(${snapshot}::jsonb->'items') AS p(id uuid,is_dismissed boolean,dismissed_at timestamptz)
        WHERE m.id=p.id`;
    await sql`DELETE FROM manual_file_link_sets s WHERE s.file_id=${fileId} OR EXISTS (
        SELECT 1 FROM media_files f WHERE f.id=${fileId} AND s.file_hash_head=f.file_hash_head AND s.file_size_bytes=f.file_size_bytes)`;
    await sql`INSERT INTO manual_file_link_sets SELECT * FROM jsonb_populate_recordset(NULL::manual_file_link_sets,${snapshot}::jsonb->'sets')`;
    await sql`UPDATE media_files SET health_issues=NULLIF(${snapshot}::jsonb->'issues','null'::jsonb) WHERE id=${fileId}`;
}

/** A displaced content-keyed manual set may name a different physical file. Never restore it onto changed bytes. */
export async function canRestoreFileMappingChoice(
    sql: postgres.Sql,
    state: unknown,
): Promise<boolean> {
    const snapshot = sql.json(state as postgres.JSONValue);
    const [row] = await sql<
        { ok: boolean }[]
    >`SELECT COALESCE(bool_and(p.value=jsonb_build_object('id',f.id,'file_path',f.file_path,
        'file_mtime',f.file_mtime,'file_size_bytes',f.file_size_bytes,'file_hash_head',f.file_hash_head,
        'duration_seconds',f.duration_seconds,'is_missing',f.is_missing)),true) AS ok
        FROM jsonb_array_elements(${snapshot}::jsonb->'files') p(value)
        LEFT JOIN media_files f ON f.id=(p.value->>'id')::uuid`;
    return row.ok;
}
