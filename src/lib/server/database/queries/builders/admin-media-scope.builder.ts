// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The admin media browser's BASE POPULATION — the set of `media_items` rows the
 * browser considers to exist at all, before any search text, library scope or
 * advanced filter narrows it.
 *
 * Extracted out of `admin-media.queries.ts` so that a module computing a COUNT
 * for a browser deep link can be over the same population as the LIST that link
 * opens, structurally rather than by two hand-written WHERE clauses agreeing
 * today. That divergence is not hypothetical here: this browser has twice
 * shipped a badge whose number disagreed with its own list — once counting
 * `media_files` against a list of `media_items`, once counting files against
 * items — and both read to an operator as a broken page rather than as a
 * mis-scoped query.
 *
 * Every clause below is a real exclusion, not decoration:
 *
 * - `status = 'active'` — merged and deleted rows are tombstones.
 * - `has_files` — the browser's default is "things that exist on disk".
 *   Propagated UP the ancestor chain by `propagateHasFiles`
 *   (`media-files.queries.ts`), so an artist or album row inherits it from its
 *   tracks; an artist row whose only linkage is
 *   `custom_metadata.additional_artist_ids` has no descendant file and is
 *   therefore invisible here. That is a property of the browser, not of this
 *   builder, and counts taken through it inherit it too — which is the point.
 * - the orphan-stub and unmatched-stub exclusions, which hide scanner debris
 *   the browser has always hidden. The orphan-stub rule covers `artist` rows,
 *   so it is load-bearing for music counts and NOT safely omitted from one.
 */

import type postgres from 'postgres';

export interface AdminBrowserScopeOpts {
    /** `media_type` values in scope. Empty is only meaningful with `unidentified`. */
    types: string[];
    /** Include rows with no files (`has_files = false`). */
    showUnavailable?: boolean;
    /** Include dismissed rows alongside the rest (does NOT show only those). */
    showDismissed?: boolean;
    /** Restrict to rows carrying no metadata identity (file-based sync links do not count). */
    unidentified?: boolean;
}

/**
 * Exclude orphan stubs: parent-level items (tv, artist) with no children, no
 * external IDs and no files.
 */
function buildOrphanStubFilter(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`AND NOT (
        mi.media_type IN ('tv', 'artist')
        AND mi.parent_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM media_items c WHERE c.parent_id = mi.id)
        AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND ei.source IS DISTINCT FROM 'watch-sync-file')
        AND NOT EXISTS (SELECT 1 FROM media_file_items mfi WHERE mfi.media_item_id = mi.id)
    )`;
}

/**
 * Exclude unmatched scanner stubs: TV items with no external IDs and no year.
 * Redundant when has_files=true is active but required for showUnavailable=true.
 */
function buildUnmatchedStubFilter(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`AND NOT (
        mi.media_type = 'tv'
        AND mi.parent_id IS NULL
        AND mi.year IS NULL
        AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND ei.source IS DISTINCT FROM 'watch-sync-file')
    )`;
}

/**
 * Hide dismissed rows unless the caller opted in.
 *
 * Deliberately NOT gated on `unidentified`: the AudiobookShelf ingest sweep
 * dismisses books that vanish upstream, so dismissed rows accumulate in
 * ordinary browse domains and an operator must be able to list and purge them.
 */
function buildDismissedFilter(
    sql: postgres.Sql,
    showDismissed: boolean | undefined,
): postgres.PendingQuery<postgres.Row[]> {
    return showDismissed ? sql`` : sql`AND NOT mi.is_dismissed`;
}

/** Restrict to the requested `media_type` set. */
function buildTypeScopeFilter(
    sql: postgres.Sql,
    types: string[],
    unidentified: boolean | undefined,
): postgres.PendingQuery<postgres.Row[]> {
    // The unidentified domain tolerates an empty type set (it means "any type
    // that has no external id"); every other caller always supplies one.
    if (unidentified && types.length === 0) return sql``;
    if (types.length === 1) return sql`AND mi.media_type = ${types[0]}`;
    return sql`AND mi.media_type = ANY(${types})`;
}

/**
 * The full base-population predicate, starting at `mi.status = 'active'` so the
 * caller writes `WHERE ${buildAdminBrowserBaseScope(...)}` and appends its own
 * `AND …` fragments after it.
 *
 * The table must be aliased `mi`.
 */
export function buildAdminBrowserBaseScope(
    sql: postgres.Sql,
    opts: AdminBrowserScopeOpts,
): postgres.PendingQuery<postgres.Row[]> {
    const availability = opts.showUnavailable ? sql`` : sql`AND mi.has_files = true`;
    const typeScope = buildTypeScopeFilter(sql, opts.types, opts.unidentified);
    const unidentified = opts.unidentified
        ? sql`AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND ei.source IS DISTINCT FROM 'watch-sync-file')`
        : sql``;
    const dismissed = buildDismissedFilter(sql, opts.showDismissed);
    const orphanStub = buildOrphanStubFilter(sql);
    // Skipped in the unidentified domain, which exists precisely to surface the
    // rows this excludes.
    const unmatchedStub = opts.unidentified ? sql`` : buildUnmatchedStubFilter(sql);

    return sql`mi.status = 'active'
        ${availability}
        ${typeScope}
        ${unidentified}
        ${dismissed}
        ${orphanStub}
        ${unmatchedStub}`;
}
