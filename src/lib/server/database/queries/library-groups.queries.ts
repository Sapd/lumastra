// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { libraryGroupMemberItems } from './builders/library-group.builder.js';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface LibraryGroupRow {
    id: string;
    name: string;
    display_name: string | null;
    description: string | null;
    icon: string | null;
    sort_order: number;
    max_age_rating: number | null;
    metadata_provider_chain: string[] | null;
    field_priority_overrides: Record<string, string[]> | null;
    created_at: Date;
    updated_at: Date;
}

export interface CreateLibraryGroupParams {
    name: string;
    /** Human-facing label. Defaults to `name` at insert time when omitted. */
    display_name?: string | null;
    description?: string | null;
    icon?: string | null;
    sort_order?: number;
    max_age_rating?: number | null;
    metadata_provider_chain?: string[] | null;
    field_priority_overrides?: Record<string, string[]> | null;
}

export interface UpdateLibraryGroupParams {
    name?: string;
    display_name?: string | null;
    description?: string | null;
    icon?: string | null;
    sort_order?: number;
    max_age_rating?: number | null;
    metadata_provider_chain?: string[] | null;
    field_priority_overrides?: Record<string, string[]> | null;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getAllLibraryGroups(sql: postgres.Sql): Promise<LibraryGroupRow[]> {
    return sql<LibraryGroupRow[]>`
        SELECT id, name, display_name, description, icon, sort_order, max_age_rating, metadata_provider_chain, field_priority_overrides, created_at, updated_at
        FROM library_groups
        ORDER BY sort_order ASC, name ASC
    `;
}

export async function getLibraryGroupById(
    sql: postgres.Sql,
    id: string,
): Promise<LibraryGroupRow | null> {
    const rows = await sql<LibraryGroupRow[]>`
        SELECT id, name, display_name, description, icon, sort_order, max_age_rating, metadata_provider_chain, field_priority_overrides, created_at, updated_at
        FROM library_groups
        WHERE id = ${id}
    `;
    return rows[0] ?? null;
}

/**
 * Names of the library group(s) a media item's file(s) belong to.
 * Includes direct groups (Audiobookshelf) and file-backed groups, including
 * the seasons/episodes of a series. Names are filtered after collecting IDs.
 * Returns [] for items with no library association (e.g. discovery-only). Read-only; the
 * caller is responsible for having resolved the item via an access-scoped
 * query first.
 */
export async function getMediaItemLibraryNames(
    sql: postgres.Sql,
    mediaId: string,
    deniedGroupIds?: string[] | null,
): Promise<string[]> {
    // A multi-file item can span an allowed group AND a denied one (the access
    // gate admits the item if ANY file is in an allowed group). Never disclose
    // the NAME of a group the caller cannot access — filter denied groups here.
    const deniedFilter =
        deniedGroupIds && deniedGroupIds.length > 0
            ? sql`AND lg.id != ALL(${deniedGroupIds}::uuid[])`
            : sql``;
    const rows = await sql<{ name: string }[]>`
        WITH RECURSIVE items AS (
            SELECT id, library_group_id, 0 AS depth FROM media_items WHERE id = ${mediaId}
            UNION ALL
            SELECT mi.id, mi.library_group_id, items.depth + 1
            FROM media_items mi JOIN items ON mi.parent_id = items.id
            WHERE items.depth < 2
        ), groups AS (
            SELECT library_group_id AS id FROM items
            UNION
            SELECT mf.library_group_id FROM items
            JOIN media_file_items mfi ON mfi.media_item_id = items.id
            JOIN media_files mf ON mf.id = mfi.file_id
        )
        SELECT DISTINCT COALESCE(NULLIF(BTRIM(lg.display_name), ''), lg.name) AS name
        FROM groups JOIN library_groups lg ON lg.id = groups.id
        WHERE TRUE
          ${deniedFilter}
        ORDER BY name
    `;
    return rows.map((r) => r.name);
}

export async function createLibraryGroup(
    sql: postgres.Sql,
    params: CreateLibraryGroupParams,
): Promise<LibraryGroupRow> {
    const rows = await sql<LibraryGroupRow[]>`
        INSERT INTO library_groups (name, display_name, description, icon, sort_order, max_age_rating, metadata_provider_chain, field_priority_overrides)
        VALUES (
            ${params.name},
            ${params.display_name ?? params.name},
            ${params.description ?? null},
            ${params.icon ?? null},
            ${params.sort_order ?? 0},
            ${params.max_age_rating ?? null},
            ${params.metadata_provider_chain ?? null},
            ${params.field_priority_overrides ? sql.json(params.field_priority_overrides) : null}
        )
        RETURNING id, name, display_name, description, icon, sort_order, max_age_rating, metadata_provider_chain, field_priority_overrides, created_at, updated_at
    `;
    if (!rows[0]) throw new Error('INSERT library_groups returned no row');
    return rows[0];
}

export async function updateLibraryGroup(
    sql: postgres.Sql,
    id: string,
    params: UpdateLibraryGroupParams,
): Promise<LibraryGroupRow | null> {
    const rows = await sql<LibraryGroupRow[]>`
        UPDATE library_groups
        SET
            name            = ${params.name === undefined ? sql`name` : params.name},
            display_name    = ${params.display_name === undefined ? sql`display_name` : params.display_name},
            description     = ${params.description === undefined ? sql`description` : params.description},
            icon            = ${params.icon === undefined ? sql`icon` : params.icon},
            sort_order      = ${params.sort_order === undefined ? sql`sort_order` : params.sort_order},
            max_age_rating  = ${params.max_age_rating === undefined ? sql`max_age_rating` : params.max_age_rating},
            metadata_provider_chain = ${params.metadata_provider_chain === undefined ? sql`metadata_provider_chain` : params.metadata_provider_chain},
            field_priority_overrides = ${params.field_priority_overrides === undefined ? sql`field_priority_overrides` : params.field_priority_overrides ? sql.json(params.field_priority_overrides) : null},
            updated_at      = now()
        WHERE id = ${id}
        RETURNING id, name, display_name, description, icon, sort_order, max_age_rating, metadata_provider_chain, field_priority_overrides, created_at, updated_at
    `;
    return rows[0] ?? null;
}

/**
 * Returns all library groups with their `is_public` flag (added in migration
 * 16.92.0). Intended for admin surfaces that need to display or toggle the
 * public-showcase status of each group.
 */
export async function listLibraryGroupsWithPublicStatus(
    sql: postgres.Sql,
): Promise<Array<LibraryGroupRow & { is_public: boolean }>> {
    return sql<Array<LibraryGroupRow & { is_public: boolean }>>`
        SELECT id, name, display_name, description, icon, sort_order, max_age_rating,
               metadata_provider_chain, field_priority_overrides,
               created_at, updated_at, is_public
        FROM library_groups
        ORDER BY sort_order ASC, name ASC
    `;
}

export async function deleteLibraryGroup(sql: postgres.Sql, id: string): Promise<boolean> {
    const result = await sql`
        DELETE FROM library_groups WHERE id = ${id}
    `;
    return result.count > 0;
}

export async function getLibraryGroupsWithCounts(
    sql: postgres.Sql,
    deniedGroupIds?: string[] | null,
    maxAgeRating?: number | null,
): Promise<
    Array<
        LibraryGroupRow & {
            item_count: number;
            browsable_item_count: number;
            media_types: string[];
        }
    >
> {
    const denyFilter =
        deniedGroupIds && deniedGroupIds.length > 0
            ? sql`AND lg.id != ALL(${deniedGroupIds}::uuid[])`
            : sql``;

    // Hide entire library groups that exceed the user's age rating
    const ageFilter =
        maxAgeRating !== undefined && maxAgeRating !== null
            ? sql`AND (lg.max_age_rating IS NULL OR lg.max_age_rating <= ${maxAgeRating})`
            : sql``;

    // Membership comes from a LATERAL union of the two ways an item can belong
    // to a group, because neither source alone sees every library.
    //
    //   1. Through files: media_files.library_group_id -> media_file_items.
    //      The primary source. Files attach to LEAVES (episodes, tracks), which
    //      is why `media_types` reports leaf types and the COALESCE chain below
    //      walks back up to roots.
    //   2. Directly: media_items.library_group_id, which holds ROOTS.
    //      Used ONLY for groups branch 1 cannot see at all (the NOT EXISTS).
    //
    // Branch 2 is a per-group FALLBACK, not a second join, and that is the whole
    // design. AudiobookShelf-backed items carry no media_files rows by design —
    // their bytes live upstream — so branch 1 yields nothing for those groups and
    // the HAVING below dropped them from the result entirely. Not "reported an
    // empty media_types": absent. The admin media browser's LIBRARY selector,
    // which filters groups by `media_types`, therefore had no audiobook group to
    // render and did not appear at all.
    //
    // Why a fallback rather than a plain UNION of both sources: branch 2 holds
    // the ROOT of every item, including roots whose leaves branch 1 already
    // covers. Unioning unconditionally would add 'tv' to a series group's
    // `media_types` and 'artist'/'album' to a music group's, and would pull in
    // discovery-only roots that have no files anywhere (on production: 4265
    // file-less artists in one music group alone). Gating on "this group has no
    // file-linked items whatsoever" keeps every file-backed group byte-identical
    // while giving the file-less ones their real numbers.
    //
    // The two branches are mutually exclusive per group, so UNION ALL is enough
    // and no item can be counted twice. LATERAL rather than a CTE so each branch
    // still gets `library_group_id` as an index-driven equality on lg.id; a
    // materialised CTE doubled the runtime on production data.
    //
    // Known limit, acceptable because a library group holds exactly ONE media
    // type: a MIXED group (some file-linked items AND some file-less ones) still
    // reports only its file-linked half.
    //
    // COALESCE chain: grandparent → parent → self gives the root at any depth
    // (episode→season→series, track→album→artist, or movie/audiobook directly).
    //
    // The membership body itself lives in `libraryGroupMemberItems` (builders/
    // library-group.builder.ts) so the Fix matches library filter applies the
    // SAME rule instead of a copy.
    return sql<
        Array<
            LibraryGroupRow & {
                item_count: number;
                browsable_item_count: number;
                media_types: string[];
            }
        >
    >`
        SELECT
            lg.id, lg.name, lg.display_name, lg.description, lg.icon, lg.sort_order, lg.max_age_rating,
            lg.metadata_provider_chain, lg.field_priority_overrides,
            lg.created_at, lg.updated_at,
            COUNT(DISTINCT COALESCE(gp.id, p.id, mi.id))
                FILTER (WHERE mi.id IS NOT NULL)::int as item_count,
            -- Count root items browsable in A-Z (movie/tv with files); used to exclude
            -- music/non-entertainment libraries that would return 0 results in A-Z browse.
            --
            -- gm.via_file is REQUIRED, not redundant. Every library-scoped browse
            -- query reaches groups through media_files.library_group_id, so a group
            -- with no file rows returns nothing in A-Z no matter what its items say.
            -- Counting a fallback item here would promise rows that browse cannot
            -- deliver. The has_files column does NOT stand in for this: ABS sets
            -- has_files = true on playable audiobooks that have no media_files row at
            -- all. Today the media_type gate would also exclude them, but that is a
            -- coincidence of audiobooks not being 'movie'/'tv' — via_file is the
            -- actual guarantee. Do NOT drop it, and do NOT widen the type list to
            -- "fix" a zero here.
            COUNT(DISTINCT CASE
                WHEN gm.via_file
                    AND COALESCE(gp.media_type, p.media_type, mi.media_type) IN ('movie', 'tv')
                    AND COALESCE(gp.has_files, p.has_files, mi.has_files) = true
                THEN COALESCE(gp.id, p.id, mi.id)
            END)::int as browsable_item_count,
            COALESCE(array_agg(DISTINCT mi.media_type) FILTER (WHERE mi.media_type IS NOT NULL), '{}') as media_types
        FROM library_groups lg
        LEFT JOIN LATERAL (
            ${libraryGroupMemberItems(sql, sql`lg.id`)}
        ) gm ON true
        LEFT JOIN media_items mi ON mi.id = gm.item_id
            AND mi.status = 'active'
        LEFT JOIN media_items p ON p.id = mi.parent_id
        LEFT JOIN media_items gp ON gp.id = p.parent_id
        WHERE 1=1
            ${denyFilter}
            ${ageFilter}
        GROUP BY lg.id
        HAVING COUNT(DISTINCT mi.id) > 0
        ORDER BY lg.sort_order ASC, lg.name ASC
    `;
}
