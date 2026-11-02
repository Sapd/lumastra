// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Library Group Filter Builder
 *
 * Produces a SQL fragment that filters media items to a specific library group
 * by checking if any file in the item's tree (self, children, grandchildren)
 * belongs to the group. Series have files on episodes, not on themselves,
 * so we walk UP from files to their root ancestor.
 */

import type postgres from 'postgres';

/**
 * Build a WHERE clause fragment that filters media items to a specific library group.
 * Walks UP from files through the 3-level hierarchy (item → parent → grandparent)
 * to find items whose descendants have files in the target group.
 *
 * Implementation: collect the set of candidate ancestor ids reachable from the
 * group's files (the file-linked item, its parent, and its grandparent) and
 * match `mi.id` against that precomputed set with `IN (...)`. This is
 * semantically identical to the previous correlated `EXISTS` whose
 * `(_linked.id = mi.id OR _p.id = mi.id OR _gp.id = mi.id)` join filter could
 * not be indexed — Postgres was forced into a per-`mi` nested-loop semi join,
 * evaluating the 3-way OR across the entire materialized file→ancestor set for
 * every candidate row (tens of millions of filter evaluations on large groups).
 * The `IN` form lets the planner build the ancestor-id set once and hash-probe
 * `mi.id` against it, turning a multi-second scan into well under a second.
 * `unnest(ARRAY[...])` expands the three ancestor levels in a single scan of the
 * group's files; NULL ancestor ids are harmless (they never match `mi.id`).
 *
 * @param sql - postgres.Sql instance for parameterized queries
 * @param groupId - library_group_id to filter by, or undefined for no filter
 * @returns SQL fragment to append after existing WHERE conditions (includes leading AND)
 */
export function buildLibraryGroupFilter(
    sql: postgres.Sql,
    groupId: string | undefined,
): postgres.PendingQuery<postgres.Row[]> {
    if (!groupId) return sql``;

    return sql`AND mi.id IN (
        SELECT unnest(ARRAY[_linked.id, _linked.parent_id, _p.parent_id])
        FROM media_files _mf
        JOIN media_file_items _mfi ON _mfi.file_id = _mf.id
        JOIN media_items _linked ON _linked.id = _mfi.media_item_id
        LEFT JOIN media_items _p ON _p.id = _linked.parent_id
        WHERE _mf.library_group_id = ${groupId}::uuid
    )`;
}

/**
 * The items a library group holds — THE membership rule, as a subquery body
 * yielding `(item_id, via_file)`. `getLibraryGroupsWithCounts` runs it as a
 * LEFT JOIN LATERAL with `groupId = lg.id`; the filters below run it once for a
 * single bound group id. Keep both on this one definition.
 *
 *   1. Through files: media_files.library_group_id -> media_file_items. The
 *      primary source. Files attach to LEAVES (episodes, tracks, movies), so
 *      callers walk `item_id` UP to its root (grandparent -> parent -> self).
 *   2. Directly: media_items.library_group_id, which holds ROOTS. A per-group
 *      FALLBACK used ONLY when branch 1 sees nothing for the group at all
 *      (AudiobookShelf-backed libraries carry no media_files rows by design).
 *      Applied unconditionally it would pull every discovery-only root and add
 *      series/artist roots to file-backed groups — see the long comment on
 *      `getLibraryGroupsWithCounts` for the production numbers.
 *
 * The branches are mutually exclusive per group, so UNION ALL never counts an
 * item twice. Both branches reach their rows through an equality on
 * `library_group_id`, so pass a bare column or a bound parameter — not a
 * CTE — or the index-driven lookups go (a materialised CTE doubled the
 * runtime of the counts query on production data).
 *
 * Aliases `_gm_*` are reserved for this fragment.
 */
export function libraryGroupMemberItems(
    sql: postgres.Sql,
    groupId: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        SELECT _gm_mfi.media_item_id AS item_id, true AS via_file
        FROM media_files _gm_mf
        JOIN media_file_items _gm_mfi ON _gm_mfi.file_id = _gm_mf.id
        WHERE _gm_mf.library_group_id = ${groupId}
        UNION ALL
        SELECT _gm_direct.id AS item_id, false AS via_file
        FROM media_items _gm_direct
        WHERE _gm_direct.library_group_id = ${groupId}
          AND NOT EXISTS (
              SELECT 1
              FROM media_files _gm_mf2
              JOIN media_file_items _gm_mfi2 ON _gm_mfi2.file_id = _gm_mf2.id
              WHERE _gm_mf2.library_group_id = ${groupId}
          )
    `;
}

/**
 * `AND <rootIdExpr> IN (roots of the group's members)` — narrows rows whose
 * ROOT item (series, artist, movie, audiobook) belongs to the group under
 * {@link libraryGroupMemberItems}. The caller supplies the root id of its own
 * row; for a top-level row that is simply its id.
 *
 * Uncorrelated on purpose: with the group id bound, the planner builds the root
 * set ONCE (index-driven on library_group_id; the fallback's NOT EXISTS becomes
 * a one-time filter) and hash-probes each candidate row against it — the same
 * shape as {@link buildLibraryGroupFilter}. A correlated per-row EXISTS walking
 * down to files cannot use an index on the root.
 *
 * Returns an empty fragment when `groupId` is undefined (no filter).
 */
export function buildLibraryGroupRootFilter(
    sql: postgres.Sql,
    groupId: string | undefined,
    rootIdExpr: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    if (!groupId) return sql``;
    return sql`AND ${rootIdExpr} IN (
        SELECT COALESCE(_gr_p.parent_id, _gr_leaf.parent_id, _gr_leaf.id)
        FROM (${libraryGroupMemberItems(sql, sql`${groupId}::uuid`)}) _gr_m
        JOIN media_items _gr_leaf ON _gr_leaf.id = _gr_m.item_id
        LEFT JOIN media_items _gr_p ON _gr_p.id = _gr_leaf.parent_id
    )`;
}
