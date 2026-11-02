// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin IA redesign, spec §3.3: "items-processed on the row" — shared
 * between `RunCard` (list row) and `RunDetailPanel` (Summary tab) so both
 * surfaces agree on the same number for the same run (spec §2 "one source
 * of truth", spec §5 "surfaces never compute their own copies").
 *
 * Prefers the task's own authoritative `result.itemsProcessed` (set once,
 * on terminal completion); falls back to summing per-stage `processed`
 * counts so an in-flight run still shows a meaningful figure before it has
 * a `result`. Returns `null` (never `0`) when neither source has anything
 * to report — a housekeeping task with no item concept renders no count at
 * all, not a misleading "0 items" (spec §5 "badges only when actionable").
 */

import type { Run } from '$lib/schemas/run.schema.js';
import type { CountUnit } from '$lib/utils/admin/formatters.js';

export interface RunCountDisplay {
    count: number;
    unit: CountUnit;
    continuation?: NonNullable<Run['countSummary']>['continuation'];
}

export function runItemsProcessed(
    run: Pick<Run, 'result' | 'stages' | 'taskId' | 'countSummary'>,
): RunCountDisplay | null {
    const summary = run.countSummary;
    if (summary) {
        return {
            count: summary.count,
            unit: summary.unit,
            ...(summary.continuation ? { continuation: summary.continuation } : {}),
        };
    }
    // Stage counters for trickplay-generation track visited source specs, not
    // decoded frames or generated tiles. If a result cannot prove its unit,
    // suppress the count instead of mislabelling source progress as items.
    if (run.taskId === 'trickplay-generation') return null;

    const result = run.result;
    if (typeof result === 'object' && result !== null) {
        const n = (result as Record<string, unknown>).itemsProcessed;
        if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000) {
            return { count: n, unit: 'items' };
        }
    }
    const stageSum = run.stages.reduce((sum, s) => sum + (s.processed ?? 0), 0);
    return Number.isSafeInteger(stageSum) && stageSum > 0
        ? { count: stageSum, unit: 'items' }
        : null;
}
