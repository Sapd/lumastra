// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { safeStat } from '$lib/server/utils/safe-fs.js';
import { readContainedFile } from '$lib/server/utils/contained-fs.js';
import { lockArtworkOwners } from '$lib/server/database/queries/media-artwork.queries.js';
import {
    captureArtworkChoice,
    restoreArtworkChoice,
    previousArtworkAssets,
} from '$lib/server/database/queries/artwork-choice.queries.js';
import {
    recordMediaChange,
    getMediaChange,
    markMediaChangeUndone,
    sameMediaChangeState,
} from '$lib/server/database/queries/admin-media-change.queries.js';

export class ArtworkChoiceConflict extends Error {}

export async function lockArtworkChoice(sql: postgres.Sql, owner: string): Promise<void> {
    if (isUuid(owner)) await lockArtworkOwners(sql, [owner]);
    else await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'image-person:' + owner},0))`;
}

/** Use around the short publication transaction, after fetching/writing immutable new bytes. */
export async function withArtworkChoice<T>(
    sql: postgres.Sql,
    owner: string,
    actor: string,
    mutate: (tx: postgres.Sql) => Promise<T>,
): Promise<{ value: T; undoId?: string }> {
    return withTx(sql, async (tx) => {
        await lockArtworkChoice(tx, owner);
        const before = await captureArtworkChoice(tx, owner);
        const value = await mutate(tx);
        if (value === false) return { value };
        const after = await captureArtworkChoice(tx, owner);
        const undoId = await recordMediaChange(tx, owner, 'artwork', before, after, actor);
        return { value, undoId };
    });
}

/** Owner locking and the complete after-state guard exclude intervening elections or edits. */
export async function undoArtworkChoice(
    sql: postgres.Sql,
    owner: string,
    receiptId: string,
): Promise<void> {
    await lockArtworkChoice(sql, owner);
    const receipt = await getMediaChange(sql, owner, 'artwork', receiptId);
    if (!receipt) throw new ArtworkChoiceConflict('Artwork recovery is no longer available.');
    if (receipt.undone_at) return;
    if (
        !(await sameMediaChangeState(
            sql,
            await captureArtworkChoice(sql, owner),
            receipt.after_state,
        ))
    )
        throw new ArtworkChoiceConflict(
            'Artwork changed since this choice. Refresh before choosing another image.',
        );
    for (const asset of await previousArtworkAssets(sql, receipt.before_state)) {
        if (asset.file_path && !(await safeStat(asset.file_path, 5000).catch(() => null))?.isFile())
            throw new ArtworkChoiceConflict(
                'The previous image file is unavailable. Restore the file before undoing.',
            );
        if (asset.file_path && asset.local_content_hash) {
            const bytes = await readContainedFile(asset.file_path).catch(() => null);
            if (
                !bytes ||
                createHash('sha256').update(bytes).digest('hex') !== asset.local_content_hash
            )
                throw new ArtworkChoiceConflict(
                    'The previous image file changed. Restore its original bytes before undoing.',
                );
        }
    }
    await restoreArtworkChoice(sql, owner, receipt.before_state);
    await markMediaChangeUndone(sql, receipt.id);
}
