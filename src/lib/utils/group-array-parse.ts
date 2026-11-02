// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Value <-> chip-list conversion for {@link GroupArrayInput}.
 *
 * Lives outside the component because component tests are excluded from this
 * repo's default vitest run, and these two functions carry the edge cases that
 * actually break things:
 *
 * - de-duplication, without which a stored `"admin,admin"` produces duplicate
 *   keys in a keyed `{#each}` — a hard Svelte runtime error that takes the whole
 *   settings page down rather than degrading;
 * - comma splitting on add, without which a PASTED "a, b" is stored as one group
 *   literally named "a, b" and silently becomes two on the next parse.
 *
 * Case is folded for COMPARISON only and never for storage: the SQL side folds
 * with Postgres `lower()`, and the admin surface reports the configured circle
 * in the operator's own spelling.
 *
 * @module utils/group-array-parse
 */

/** Comparison key — trimmed and lowercased, matching the Postgres-side fold. */
export function foldGroupName(name: string): string {
    return name.trim().toLowerCase();
}

/**
 * Parse a stored setting value into the chip list: split on commas, trim, drop
 * empties, and de-duplicate case-insensitively keeping the first spelling.
 *
 * Accepts the array shape too — config hands one over on first render before the
 * component has written a comma-separated string back.
 */
export function parseGroupList(value: unknown): string[] {
    const raw = Array.isArray(value) ? value.join(',') : String(value ?? '');
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of raw.split(',')) {
        const trimmed = part.trim();
        if (trimmed === '') continue;
        const key = foldGroupName(trimmed);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
    }
    return out;
}

/**
 * Add one or more names (a typed entry, or a pasted comma-separated string) to an
 * existing list, skipping anything already present under case-insensitive
 * comparison. Returns a new array; the input is not mutated.
 */
export function mergeGroupNames(current: readonly string[], input: string): string[] {
    const next = [...current];
    const seen = new Set(next.map(foldGroupName));
    for (const part of input.split(',')) {
        const trimmed = part.trim();
        if (trimmed === '') continue;
        const key = foldGroupName(trimmed);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(trimmed);
    }
    return next;
}
