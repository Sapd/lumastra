// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Collapses consecutive failed runs that show the SAME displayed failure
 * line into one entry, so a task failing the same way over and over (81
 * runs of "upstream outage — 0 enriched with 3 error(s)." observed on prod
 * for MAL Anime ID Enrichment) doesn't bury the one useful signal — it
 * keeps failing the same way, since when, how many times — under a wall of
 * visually-identical rows.
 *
 * Pure and DOM-free so the grouping logic is testable without mounting
 * `RunList`/`RunCard`. `runs` is assumed already ordered newest-first, as
 * returned by the runs API — the run kept visible for a collapsed streak is
 * simply the first (newest) run of the run of consecutive matches.
 */

import type { Run } from '$lib/schemas/run.schema.js';
import { explainRunError, stripTaskIdPrefix } from '$lib/utils/admin/run-error-display.js';

/** Streaks shorter than this render as plain rows — collapsing 1-2 identical
 * rows isn't worth the indirection of a toggle. */
const MIN_STREAK_LENGTH = 3;

/**
 * Minimal shape `collapseRunStreaks` needs. Decouples the helper from the
 * full SDK `Run` type so any run-shaped list (RunList's flat/grouped `Run`,
 * the task drawer's Recent Runs tab) can reuse the same grouping logic
 * without duplicating it, even if its local run type isn't a structural
 * match for the SDK's in every field.
 */
export interface StreakableRun {
    readonly id: string;
    readonly taskId?: string | null;
    readonly state: string;
    readonly startedAt: string;
    readonly error?: { readonly message: string } | null;
}

export interface RunStreakItem<R extends StreakableRun = Run> {
    kind: 'streak';
    /** Stable id for the streak — the newest run's id. */
    id: string;
    /** The newest run of the streak, rendered as a normal row above the toggle. */
    newest: R;
    /** The older runs of the streak, newest-first, revealed on toggle. */
    collapsed: R[];
    /** `startedAt` of the oldest run in the streak (last of `collapsed`). */
    oldestStartedAt: string;
}

export type RunListItem<R extends StreakableRun = Run> = { kind: 'run'; run: R } | RunStreakItem<R>;

/**
 * The failure line as it would render on a `RunCard` row for `run` — the
 * SAME text shown in the DOM, from `explainRunError`/`stripTaskIdPrefix`
 * (RunCard's own `errorDisplay.text` derivation). Returns `null` for any run
 * that isn't a displayed failure (wrong state, or no error), which never
 * matches another run's signature and so never joins a streak.
 */
function failureSignature<R extends StreakableRun>(run: R): string | null {
    if (run.state !== 'failed' || !run.error) return null;
    const explained = explainRunError(run.error.message);
    return explained ? explained.summary : stripTaskIdPrefix(run.error.message, run.taskId);
}

/**
 * Groups `runs` into render items: plain rows, and collapsed streaks of 3+
 * consecutive failed runs sharing the same displayed failure line.
 */
export function collapseRunStreaks<R extends StreakableRun>(runs: readonly R[]): RunListItem<R>[] {
    const items: RunListItem<R>[] = [];
    let i = 0;
    while (i < runs.length) {
        const signature = failureSignature(runs[i]);
        if (signature === null) {
            items.push({ kind: 'run', run: runs[i] });
            i++;
            continue;
        }

        let j = i + 1;
        while (j < runs.length && failureSignature(runs[j]) === signature) j++;

        const streak = runs.slice(i, j);
        if (streak.length < MIN_STREAK_LENGTH) {
            for (const run of streak) items.push({ kind: 'run', run });
        } else {
            const [newest, ...collapsed] = streak;
            items.push({ kind: 'run', run: newest });
            items.push({
                kind: 'streak',
                id: newest.id,
                newest,
                collapsed,
                oldestStartedAt: collapsed[collapsed.length - 1].startedAt,
            });
        }
        i = j;
    }
    return items;
}
