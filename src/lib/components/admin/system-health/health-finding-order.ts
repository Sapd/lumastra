// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sort rank for a health invariant's status — red first, green last.
 *
 * A module rather than a `const` in HealthInvariantsPanel.svelte because nothing
 * in this repo type-checks a lookup map written inside a component. This file is
 * the one that MEASURED it: renaming `amber` to `amberr` in the record that used
 * to live there produced 0 tsgo errors (tsgo does not read `.svelte`) and
 * `2025 FILES 0 ERRORS 0 WARNINGS` from svelte-check-native, on 2026-08-27.
 *
 * The panel sorts with `RANK[a.status] - RANK[b.status]`. An unranked status
 * makes that comparator return `NaN` for every pair it touches, and a `NaN`
 * comparator leaves `Array.prototype.sort` free to return any order at all — so
 * the loss is not one mis-placed row, it is the red-first guarantee for the
 * whole list, on the page an operator opens precisely to find the red one.
 */

import type { HealthFinding } from '$lib/schemas/health-invariants.schema.js';

/**
 * Low sorts first. Exhaustive over `FindingStatusSchema` — a missing case fails
 * the declared return type under tsgo, a stale case fails as not comparable. No
 * `default` arm: it would reintroduce the silent `NaN`.
 */
export function healthFindingRank(status: HealthFinding['status']): number {
    switch (status) {
        case 'red':
            return 0;
        case 'amber':
            return 1;
        case 'unknown':
            return 2;
        case 'green':
            return 3;
    }
}
