// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { TaskRegistry } from '$lib/server/tasks/registry.js';
import {
    getObservedVersion,
    setObservedVersion,
} from '$lib/server/database/queries/stage-version-state.queries.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { stageProcessingVersion } from '$lib/server/tasks/stage-processing-version.js';
import { Logger } from '$lib/server/utils/logger.js';

const log = Logger.for('StageVersionDetector');

type RegisteredTask = ReturnType<TaskRegistry['getAllTasks']>[number];
type DeclaredStage = NonNullable<RegisteredTask['coversStages']>[number];

/**
 * Detect processingVersion bumps for every declared stage (called by the
 * orchestrator when this replica becomes coordinator, and on a standby's
 * takeover). For each stage whose declared processingVersion > observed, mark
 * all rows with status='completed' AND processing_version < declared as
 * 'obsolete'. skipped_permanent and failed_permanent rows are intentionally
 * untouched (per spec § Locked decisions).
 *
 * A failure on one stage is logged and does not stop the others; the call
 * rejects at the end so the caller still sees that the pass was incomplete.
 */
export async function detectVersionBumps(sql: postgres.Sql, registry: TaskRegistry): Promise<void> {
    const failed: string[] = [];
    for (const task of registry.getAllTasks()) {
        if (!task.coversStages) continue;
        for (const stage of task.coversStages) {
            try {
                await detectStageBump(sql, task, stage);
            } catch (err) {
                failed.push(stage.id);
                log.error('detectVersionBumps failed for stage', err as Error, {
                    stageId: stage.id,
                });
            }
        }
    }
    if (failed.length > 0) {
        throw new Error(`detectVersionBumps failed for stage(s): ${failed.join(', ')}`);
    }
}

async function detectStageBump(
    sql: postgres.Sql,
    task: RegisteredTask,
    stage: DeclaredStage,
): Promise<void> {
    const observedRow = await getObservedVersion(sql, stage.id);
    const declared = stageProcessingVersion(task, stage);

    // 🔴 First sighting is NOT "nothing to do". Stamping the ledger and
    // skipping the obsolete pass silently swallows any bump that
    // happened before the stage was declared — and a stage id can hold
    // rows long before it appears in `coversStages`. An install that
    // runs the analyzer split migration today gets `:visual` rows at
    // legacy versions 1-4; stamp-and-skip would leave every one of them
    // `completed` and stale forever. Treating an absent ledger as
    // version 0 makes the first sighting do the same work as any other
    // bump, which for a genuinely new stage is a no-op (it has no rows).
    const observed = observedRow ?? 0;
    if (declared <= observed) return;

    // Atomic: a completed row written between the UPDATE and the
    // observed-version bump would otherwise stay at the old version
    // (not marked obsolete) while observed advances — making future
    // runs skip it forever (a permanently-stale completed row).
    // One transaction closes that window.
    let affectedRows = 0;
    await withTx(sql, async (tx) => {
        const txSql = tx as postgres.Sql;
        const result = (await txSql`
            UPDATE media_item_stage_state
               SET status = 'obsolete',
                   updated_at = now()
             WHERE stage_id = ${stage.id}
               AND processing_version < ${declared}
               AND status = 'completed'
        `) as { count?: number };
        affectedRows = result.count ?? 0;
        await setObservedVersion(txSql, stage.id, declared);
    });
    log.info('processingVersion bumped — marked completed rows obsolete', {
        stageId: stage.id,
        // Distinguish a real bump from a stage the ledger has never
        // seen; the two mean very different things when a operator
        // is working out why rows went obsolete.
        from: observedRow === null ? 'unseen' : observed,
        to: declared,
        affectedRows,
    });
}
