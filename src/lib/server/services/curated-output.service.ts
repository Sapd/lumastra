// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    recordMediaChange,
    getMediaChange,
    sameMediaChangeState,
    markMediaChangeUndone,
} from '$lib/server/database/queries/admin-media-change.queries.js';

export class CuratedOutputConflict extends Error {}
export type CuratedOutputKey = 'chapters' | 'lyrics';

export async function captureCuratedOutput(
    sql: postgres.Sql,
    id: string,
    key: CuratedOutputKey,
): Promise<unknown> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- Called only by admin chapter/lyrics endpoints for one explicit subject and its source inputs.
    const [row] = await sql<
        { state: unknown }[]
    >`SELECT jsonb_build_object('present',COALESCE(custom_metadata,'{}') ? ${key},
        'value',custom_metadata->${key},'input',jsonb_build_object('runtime',runtime_seconds,
            'files',(SELECT jsonb_agg(jsonb_build_object('link',to_jsonb(l),'path',f.file_path,
                'mtime',f.file_mtime,'size',f.file_size_bytes,'hash',f.file_hash_head,'duration',f.duration_seconds,
                'missing',f.is_missing) ORDER BY l.file_id) FROM media_file_items l JOIN media_files f ON f.id=l.file_id
                WHERE l.media_item_id=${id}))) AS state FROM media_items WHERE id=${id}`;
    if (!row) throw new CuratedOutputConflict('Title no longer exists.');
    return row.state;
}

/** All nested timing, provenance and extra fields survive in the receipt verbatim. */
export async function saveCuratedOutput(
    sql: postgres.Sql,
    id: string,
    key: CuratedOutputKey,
    value: unknown,
    actor: string,
    expected?: unknown,
): Promise<string> {
    return withTx(sql, async (tx) => {
        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- Serialize this admin-only output mutation on its explicit subject.
        await tx`SELECT id FROM media_items WHERE id=${id} FOR UPDATE`;
        const before = await captureCuratedOutput(tx, id, key);
        if (expected !== undefined && !(await sameMediaChangeState(tx, before, expected)))
            throw new CuratedOutputConflict(
                'This content changed during the lookup. Reload before replacing it.',
            );
        await tx`UPDATE media_items SET updated_at=NOW(), custom_metadata=COALESCE(custom_metadata,'{}') ||
            jsonb_build_object(${key}::text,${tx.json(value as postgres.JSONValue)}::jsonb) WHERE id=${id}`;
        return recordMediaChange(
            tx,
            id,
            `output:${key}`,
            before,
            await captureCuratedOutput(tx, id, key),
            actor,
        );
    });
}

export async function undoCuratedOutput(
    sql: postgres.Sql,
    id: string,
    key: CuratedOutputKey,
    receiptId: string,
): Promise<void> {
    await withTx(sql, async (tx) => {
        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- Serialize this admin-only output mutation on its explicit subject.
        await tx`SELECT id FROM media_items WHERE id=${id} FOR UPDATE`;
        const receipt = await getMediaChange(tx, id, `output:${key}`, receiptId);
        if (!receipt) throw new CuratedOutputConflict('Recovery is no longer available.');
        if (receipt.undone_at) return;
        if (
            !(await sameMediaChangeState(
                tx,
                await captureCuratedOutput(tx, id, key),
                receipt.after_state,
            ))
        )
            throw new CuratedOutputConflict(
                'This content changed since the save. Reload before undoing.',
            );
        const before = tx.json(receipt.before_state as postgres.JSONValue);
        await tx`UPDATE media_items SET updated_at=NOW(), custom_metadata=CASE WHEN (${before}::jsonb->>'present')::boolean
            THEN jsonb_set(COALESCE(custom_metadata,'{}'),ARRAY[${key}],${before}::jsonb->'value')
            ELSE COALESCE(custom_metadata,'{}')-${key} END WHERE id=${id}`;
        await markMediaChangeUndone(tx, receiptId);
    });
}
