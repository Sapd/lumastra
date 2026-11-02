// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Caps for list-valued request filters (ExcludeItemIds, Tags, …). */

/** Most entries a list filter (ExcludeItemIds, Tags, …) may carry; the rest is ignored. */
export const MAX_FILTER_LIST = 100;

/** Distinct values (case-insensitively when `fold`), at most `max` (default {@link MAX_FILTER_LIST}). */
export function capDistinct(
    values: readonly string[],
    fold = false,
    max = MAX_FILTER_LIST,
): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of values) {
        const key = fold ? v.toLowerCase() : v;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(v);
        if (out.length >= max) break;
    }
    return out;
}
