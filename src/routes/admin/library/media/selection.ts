// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin media-browser selection helpers.
 *
 * Lives in a sibling module rather than inline in `+page.svelte` for the same
 * reason `media-filters.ts` does: it makes the pure logic directly unit
 * testable, and keeps the identity/clearing rule in exactly one place instead
 * of re-derived at each call site.
 *
 * The selection used to be scoped to the current page: `+page.svelte` cleared
 * it on every `data.items` change, which fires on pagination too, so the
 * largest selection an operator could ever build was the 50 rows on screen.
 * `filterIdentity` / `shouldClearSelection` narrow that clearing trigger down
 * to a real filter change — paging and sorting must NOT clear a selection
 * that now spans pages.
 */

/**
 * URL search-param keys that identify a real "different result set" filter
 * change, exactly matching what `+page.server.ts`'s `load` reads to build
 * `queryOpts` (base filters + every advanced filter, including the
 * single-value `filter=file-issues` param). Deliberately excludes `page`,
 * `sort` and `order`: those change which slice or ordering of the SAME result
 * set is shown, not the result set itself.
 *
 * Keep this list in sync with `+page.server.ts`'s `load` — a filter added
 * there and forgotten here would silently keep a stale selection across a
 * view where it no longer applies.
 */
const FILTER_IDENTITY_PARAMS = [
    // A saved view (Missing artwork, Duplicates, ...) swaps the result set as
    // much as any filter does.
    'view',
    'domain',
    'type',
    'library',
    'q',
    'scope',
    'unavailable',
    'dismissed',
    'missing_tmdb',
    'missing_jf',
    'missing_poster',
    'missing_overview',
    'has_embedding',
    'locked',
    'local_only',
    'custom_poster',
    'added_since',
    'updated_since',
    'filter',
] as const;

/**
 * Hard ceiling on how many rows one selection may hold.
 *
 * The selection is always a CONCRETE ID LIST resolved on the client — never an
 * "everything matching the current filter" predicate handed to the server for
 * it to re-evaluate. Two reasons, and NEITHER of them is "the operator saw the
 * rows they selected": that is false for any large selection and nobody reads
 * a thousand rows before pressing Delete. Do not write it down as the reason.
 *
 *  1. Bounded blast radius. Whatever goes wrong goes wrong to at most this
 *     many items, and the exact ids are known before the first request leaves
 *     the browser — so a bad outcome can be enumerated afterwards instead of
 *     reconstructed from a filter.
 *  2. No filter drift between preview and execution. A predicate re-evaluated
 *     server-side can match a different set than the one the confirmation
 *     dialog counted: a scan finishing mid-flight, another admin's edit, or
 *     simply an `added_since` window that has moved on. Pinning the ids at
 *     select time makes the set the operator confirmed and the set the
 *     endpoints receive the same set by construction.
 *
 * It also keeps every batch inside two chunks of the 500-id cap that
 * `bulk-lock` / `bulk-sync` enforce, which is what makes the per-chunk
 * progress reporting bounded rather than open-ended.
 */
export const SELECTION_MAX = 1000;

/**
 * Largest id array `bulk-lock` / `bulk-sync` will accept — both defs declare
 * `.min(1).max(500)` and REJECT an over-long request rather than truncating
 * it, so a 1,000-item selection must be split before it is sent or nothing
 * happens at all.
 *
 * `SELECTION_MAX` is deliberately exactly two of these, which is what makes
 * "report progress per chunk" a bounded promise rather than an open-ended one.
 *
 * Lives here beside the cap it is a divisor of, rather than inline in
 * `+page.svelte`. Both numbers are one rule — how many ids may exist and how
 * many may travel in one request — and keeping them apart also put the split
 * out of reach of any test: a module-local const cannot be mocked down, so the
 * two-chunk path (the routine case for a full selection) could only ever be
 * exercised by rendering a thousand rows.
 */
export const BULK_CHUNK_SIZE = 500;

/** Split `ids` into consecutive, disjoint runs of at most `size`. */
export function chunkIds(ids: string[], size: number): string[][] {
    const out: string[][] = [];
    for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
    return out;
}

/** A selected row's snapshot, captured at the moment it was selected. */
export interface SelectedRow {
    id: string;
    mediaType: string;
    childCount: number;
    hasFiles: boolean;
}

/**
 * A stable string encoding of every filter param that determines the result
 * set — not the page or the sort order within it. Two URLs that differ only
 * in `page`/`sort`/`order` produce the same identity.
 */
export function filterIdentity(params: URLSearchParams): string {
    return FILTER_IDENTITY_PARAMS.map((key) => `${key}=${params.get(key) ?? ''}`).join('&');
}

/** Whether moving from `prev` to `next` filter identity should drop the selection. */
export function shouldClearSelection(prev: string, next: string): boolean {
    return prev !== next;
}

/** Aggregate counts over a selection, for confirmation/summary UI. */
export function summarise(rows: SelectedRow[]): {
    total: number;
    byType: Record<string, number>;
    withChildren: number;
} {
    const byType: Record<string, number> = {};
    let withChildren = 0;
    for (const row of rows) {
        byType[row.mediaType] = (byType[row.mediaType] ?? 0) + 1;
        if (row.childCount > 0) withChildren++;
    }
    return { total: rows.length, byType, withChildren };
}

/**
 * Refresh selection snapshots after a page reload (`invalidateAll()`), so a
 * still-selected row's `childCount`/`hasFiles`/etc. track the server instead
 * of the stale values captured at select time.
 *
 * `bulkSync`/`bulkImageSync`/bulk-identify all call `invalidateAll()` without
 * clearing the selection — cross-page selection surviving a bulk action is
 * the point of this module, so clearing it on every such call would trade
 * the feature away to dodge this bug instead of fixing it. Without a
 * refresh, `bulkDelete`'s `childCount > 0` skip guard reads the ORIGINAL
 * snapshot: e.g. `bulkSync(true)` ("sync with children") can grow a series'
 * real child count server-side, and a later Delete on the same still-selected
 * row would see `childCount: 0` and attempt a non-cascade delete against a
 * parent that now has children (the server independently 409s on that, but
 * the operator sees a confusing failure instead of a clean skip).
 *
 * Only refreshes an id ALREADY in `selected` — never adds a row that wasn't
 * selected. An id absent from `freshRows` (a selection spanning pages, most
 * of which aren't the page being reloaded) is left exactly as it was: this
 * function must never drop it, or cross-page selection breaks all over
 * again. That means an off-page snapshot can still go stale between
 * refreshes — the server's own guard is the backstop for that residual gap,
 * not this function.
 */
export function refreshSelection<T extends SelectedRow>(
    selected: ReadonlyMap<string, T>,
    freshRows: readonly T[],
): Map<string, T> {
    const next = new Map(selected);
    for (const row of freshRows) {
        if (next.has(row.id)) next.set(row.id, row);
    }
    return next;
}
