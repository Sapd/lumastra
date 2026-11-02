// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    captureSegmentChoice,
    segmentChoiceScope,
    restoreSegmentChoice,
} from '$lib/server/database/queries/segment-choice.queries.js';
import {
    acquireMediaSegmentResolutionLocks,
    bumpMediaSegmentAnalysisGeneration,
} from '$lib/server/tasks/builtin/native/intro-analyzer/resolution-lock.js';
import {
    recordMediaChange,
    getMediaChange,
    sameMediaChangeState,
    markMediaChangeUndone,
} from '$lib/server/database/queries/admin-media-change.queries.js';

export class SegmentChoiceConflict extends Error {}

export async function withSegmentChoice<T>(
    sql: postgres.Sql,
    owner: string,
    ids: string[],
    type: string | undefined,
    actor: string,
    mutate: (tx: postgres.Sql) => Promise<T>,
): Promise<{ value: T; undoId?: string }> {
    return withTx(sql, async (tx) => {
        await acquireMediaSegmentResolutionLocks(tx, ids);
        const before = await captureSegmentChoice(tx, ids, type);
        const value = await mutate(tx);
        if (value && typeof value === 'object' && 'ok' in value && value.ok === false)
            return { value };
        const undoId = await recordMediaChange(
            tx,
            owner,
            'segments',
            before,
            await captureSegmentChoice(tx, ids, type),
            actor,
        );
        return { value, undoId };
    });
}

export async function undoSegmentChoice(
    sql: postgres.Sql,
    owner: string,
    receiptId: string,
): Promise<void> {
    await withTx(sql, async (tx) => {
        const receipt = await getMediaChange(tx, owner, 'segments', receiptId);
        if (!receipt) throw new SegmentChoiceConflict('Recovery is no longer available.');
        const { ids, type } = await segmentChoiceScope(tx, receipt.after_state);
        await acquireMediaSegmentResolutionLocks(tx, ids);
        if (receipt.undone_at) return;
        if (
            !(await sameMediaChangeState(
                tx,
                await captureSegmentChoice(tx, ids, type),
                receipt.after_state,
            ))
        )
            throw new SegmentChoiceConflict('The files or markers changed. Reload before undoing.');
        await restoreSegmentChoice(tx, ids, type, receipt.before_state);
        // Fence jobs that captured the cleared/edited state. Never roll input generations backwards.
        await bumpMediaSegmentAnalysisGeneration(tx, ids);
        await markMediaChangeUndone(tx, receiptId);
    });
}
