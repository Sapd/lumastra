// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { unlink, mkdir } from 'node:fs/promises';
import {
    readContainedFile,
    writeFileNoFollow,
    writeFileExclusiveNoFollow,
} from '$lib/server/utils/contained-fs.js';
import { dirname } from 'node:path';
import { withTx, isInOpenTransaction } from '$lib/server/database/with-tx.js';
import {
    canUploadChaptersForFile,
    upsertChaptersForFile,
} from '$lib/server/database/queries/episode-chapters.queries.js';
import {
    recordMediaChange,
    getMediaChange,
    sameMediaChangeState,
    markMediaChangeUndone,
} from '$lib/server/database/queries/admin-media-change.queries.js';

export class UploadedChaptersConflict extends Error {
    statusCode = 409;
}

/** Sidecars without a byte receipt are create-only. */
export async function publishSidecar<T>(
    path: string,
    bytes: Buffer,
    publish: () => Promise<T>,
): Promise<T> {
    const value = await publish();
    await mkdir(dirname(path), { recursive: true });
    try {
        await writeFileExclusiveNoFollow(path, bytes);
    } catch (error) {
        if ((error as { code?: string } | null)?.code === 'EEXIST')
            throw new UploadedChaptersConflict('A file with this name already exists.');
        throw error;
    }
    return value;
}
async function readSidecar(path: string): Promise<string | null> {
    try {
        return (await readContainedFile(path)).toString('base64');
    } catch (error) {
        if ((error as { code?: string } | null)?.code === 'ENOENT') return null;
        throw error;
    }
}
function replaceBytes(path: string, bytes: Buffer): Promise<void> {
    return writeFileNoFollow(path, bytes);
}
async function restoreBytes(path: string, bytes: string | null): Promise<void> {
    if (bytes === null)
        await unlink(path).catch((error) => {
            if ((error as { code?: string } | null)?.code !== 'ENOENT') throw error;
        });
    else await replaceBytes(path, Buffer.from(bytes, 'base64'));
}
async function chapterState(sql: postgres.Sql, fileId: string): Promise<unknown> {
    const [row] =
        await sql`SELECT jsonb_build_object('file',jsonb_build_object('id',f.id,'path',f.file_path,'mtime',f.file_mtime,'size',f.file_size_bytes,'hash',f.file_hash_head,'duration',f.duration_seconds,'missing',f.is_missing),
        'links',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.media_item_id) FROM media_file_items l WHERE l.file_id=f.id),
        'chapters',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.chapter_index) FROM episode_chapters c WHERE c.file_id=f.id),'[]'::jsonb)) AS state
        FROM media_files f WHERE f.id=${fileId}`;
    if (!row) throw new UploadedChaptersConflict('The linked file is unavailable.');
    return row.state;
}
interface ChapterMarker {
    title: string;
    startMs: number;
    endMs?: number;
}
interface ReceiptState {
    database: unknown;
    path: string;
    bytes: string | null;
    publicationPending?: boolean;
}

/** Explicit upload/empty-list clear, with exact row and byte recovery. */
export async function saveUploadedChapters(
    sql: postgres.Sql,
    owner: string,
    fileId: string,
    path: string,
    bytes: Buffer,
    markers: ChapterMarker[],
    actor: string,
): Promise<string> {
    await requireCommitBoundary(sql);
    // Commit recovery evidence BEFORE changing either rows or bytes. The initial
    // after-state describes a rolled-back publication (old rows, intended bytes).
    // If the process dies after rename but before COMMIT, Undo can still recover.
    const intent = await withTx(sql, async (tx) => {
        if (!(await canUploadChaptersForFile(tx, fileId)))
            throw new UploadedChaptersConflict('Manual chapter markers are protected.');
        await recoverInterruptedChapterPublications(tx, fileId);
        const before: ReceiptState = {
            database: await chapterState(tx, fileId),
            path,
            bytes: await readSidecar(path),
        };
        const after = { ...before, bytes: bytes.toString('base64'), publicationPending: true };
        const receipt = await recordMediaChange(
            tx,
            owner,
            `file-chapters:${fileId}`,
            before,
            after,
            actor,
        );
        return { before, receipt };
    });
    await withTx(sql, async (tx) => {
        await tx`SELECT id FROM media_files WHERE id=${fileId} FOR UPDATE`;
        const receipt = await getMediaChange(tx, owner, `file-chapters:${fileId}`, intent.receipt);
        if (
            !receipt ||
            receipt.undone_at ||
            !(await sameMediaChangeState(
                tx,
                await chapterState(tx, fileId),
                intent.before.database,
            )) ||
            (await readSidecar(path)) !== intent.before.bytes
        )
            throw new UploadedChaptersConflict(
                'The file or chapter list changed. Reload before continuing.',
            );
        await upsertChaptersForFile(
            tx,
            fileId,
            markers.map((marker, index) => ({
                chapterIndex: index,
                chapterName: marker.title,
                startTicks: String(BigInt(Math.round(marker.startMs)) * 10000n),
                endTicks:
                    marker.endMs === undefined
                        ? null
                        : String(BigInt(Math.round(marker.endMs)) * 10000n),
                source: 'upload',
            })),
            { allowUploadReplacement: true },
        );
        const after: ReceiptState = {
            database: await chapterState(tx, fileId),
            path,
            bytes: bytes.toString('base64'),
        };
        await tx`UPDATE admin_media_change_receipts SET after_state=${tx.json(after as unknown as postgres.JSONValue)} WHERE id=${intent.receipt}`;
        await mkdir(dirname(path), { recursive: true });
        await replaceBytes(path, bytes);
    });
    // Never restore/unlink on a rejected COMMIT acknowledgement: either the
    // intent or the completed receipt is durable, and both support safe Undo.
    return intent.receipt;
}

/** A retry repairs a crashed publication before it captures its own old bytes. */
async function recoverInterruptedChapterPublications(
    tx: postgres.Sql,
    fileId: string,
): Promise<void> {
    const pending = await tx<
        { id: string; before_state: ReceiptState; after_state: ReceiptState }[]
    >`
        SELECT id,before_state,after_state FROM admin_media_change_receipts
        WHERE kind=${`file-chapters:${fileId}`} AND undone_at IS NULL
            AND after_state->>'publicationPending'='true'
            AND media_item_id IN (SELECT media_item_id FROM media_file_items WHERE file_id=${fileId})
        ORDER BY created_at DESC,id DESC FOR UPDATE`;
    for (const receipt of pending) {
        const before = receipt.before_state,
            after = receipt.after_state;
        if (!(await sameMediaChangeState(tx, await chapterState(tx, fileId), after.database)))
            continue;
        const bytes = await readSidecar(after.path);
        if (bytes !== before.bytes && bytes !== after.bytes) continue;
        // This old receipt is already durable. A crash during repair is itself
        // repeatable; changed source rows or unknown file bytes are left alone.
        if (bytes !== before.bytes) await restoreBytes(before.path, before.bytes);
        await markMediaChangeUndone(tx, receipt.id);
    }
}

async function requireCommitBoundary(sql: postgres.Sql): Promise<void> {
    if (await isInOpenTransaction(sql))
        throw new UploadedChaptersConflict(
            'Chapter files require an independent committed recovery receipt.',
        );
}

export async function undoUploadedChapters(
    sql: postgres.Sql,
    owner: string,
    fileId: string,
    receiptId: string,
): Promise<string> {
    await requireCommitBoundary(sql);
    return withTx(sql, async (tx) => {
        await tx`SELECT id FROM media_files WHERE id=${fileId} FOR UPDATE`;
        const receipt = await getMediaChange(tx, owner, `file-chapters:${fileId}`, receiptId);
        if (!receipt)
            throw new UploadedChaptersConflict('Chapter recovery is no longer available.');
        const before = receipt.before_state as ReceiptState;
        const after = receipt.after_state as ReceiptState;
        if (receipt.undone_at) return before.path;
        const currentBytes = await readSidecar(after.path);
        if (
            !(await sameMediaChangeState(tx, await chapterState(tx, fileId), after.database)) ||
            (currentBytes !== after.bytes && currentBytes !== before.bytes)
        )
            throw new UploadedChaptersConflict(
                'The file or chapter list changed. Reload before undoing.',
            );
        await tx`DELETE FROM episode_chapters WHERE file_id=${fileId}`;
        await tx`INSERT INTO episode_chapters SELECT * FROM jsonb_populate_recordset(NULL::episode_chapters,${tx.json(before.database as postgres.JSONValue)}::jsonb->'chapters')`;
        await mkdir(dirname(before.path), { recursive: true });
        await restoreBytes(before.path, before.bytes);
        // Mark only after restoring bytes. A crash before this COMMIT leaves the
        // existing receipt resumable, including when the old bytes are restored.
        await markMediaChangeUndone(tx, receiptId);
        return before.path;
    });
}
