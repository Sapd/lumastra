// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Purpose grouping for the /admin/tasks catalog (admin IA redesign spec §3.3).
 *
 * Lives in a sibling module rather than in `+page.svelte` because nothing in
 * this repo type-checks a component-local lookup map: `npm run typecheck` runs
 * tsgo, which does not read `.svelte`, and `npm run check` (svelte-check-native)
 * was MEASURED on 2026-08-27 not to flag a broken key in a component-local
 * `Record<Union, …>` either. The page previously carried THREE hand-copies of
 * `TaskPurposeSchema`'s six members — a display order, a label record, and the
 * seed object `groupByPurpose` pushed into — and a seventh purpose added to the
 * schema would have made `groups[purpose].push(task)` throw on `undefined`,
 * blanking the entire task catalog rather than mislabelling one heading.
 *
 * So: the order is DERIVED from `TaskPurposeSchema.options` (total by
 * construction — a new purpose shows up on its own, and the group seed can no
 * longer miss a bucket), and the two things that genuinely need a per-purpose
 * decision are exhaustive `switch`es, which tsgo does check. A missing case
 * fails the declared return type; a case that no longer names a real purpose
 * fails as not comparable to `TaskPurpose`.
 *
 * Do not convert these back to `Record<TaskPurpose, …>` literals. Even in a
 * `.ts` file a record is the weaker guard, and in a `.svelte` file it is no
 * guard at all.
 */

import * as m from '$lib/paraglide/messages.js';
import { TaskPurposeSchema, type TaskPurpose } from '$lib/schemas/task-definition.schema.js';

/**
 * Display rank, low first. Repair renders last and visually separated —
 * one-shot fix-up tools, not routine work.
 *
 * A rank switch rather than a hand-written ordered array so that the ORDER is a
 * decision the compiler makes you take for a new purpose, while the SET of
 * purposes stays derived from the schema and can never disagree with it.
 */
function purposeRank(purpose: TaskPurpose): number {
    switch (purpose) {
        case 'library':
            return 0;
        case 'music-ai':
            return 1;
        case 'livetv':
            return 2;
        case 'watch-sync':
            return 3;
        case 'maintenance':
            return 4;
        case 'repair':
            return 5;
    }
}

/** Every purpose, in display order. Total over `TaskPurposeSchema` by construction. */
export const PURPOSE_ORDER: readonly TaskPurpose[] = [...TaskPurposeSchema.options].sort(
    (a, b) => purposeRank(a) - purposeRank(b),
);

/** The group heading an operator reads. */
export function taskPurposeLabel(purpose: TaskPurpose): string {
    switch (purpose) {
        case 'library':
            return m.admin_tasks_purpose_library();
        case 'music-ai':
            return m.admin_tasks_purpose_music_ai();
        case 'livetv':
            return m.admin_tasks_purpose_livetv();
        case 'watch-sync':
            return m.admin_tasks_purpose_watch_sync();
        case 'maintenance':
            return m.admin_tasks_purpose_maintenance();
        case 'repair':
            return m.admin_tasks_purpose_repair();
    }
}

/**
 * An empty bucket per purpose, seeded from `PURPOSE_ORDER`.
 *
 * The seed used to be a hand-written object literal, which is exactly where the
 * blank-page failure lived: a purpose present in the schema but absent from the
 * literal produced `undefined`, and the caller's `groups[purpose].push(task)`
 * threw. Seeding from the derived order makes that unrepresentable.
 */
export function emptyPurposeGroups<T>(): Record<TaskPurpose, T[]> {
    const groups = {} as Record<TaskPurpose, T[]>;
    for (const purpose of PURPOSE_ORDER) groups[purpose] = [];
    return groups;
}
