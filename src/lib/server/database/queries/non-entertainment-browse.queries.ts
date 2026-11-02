// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Non-Entertainment Browse Queries
 *
 * ## Access boundary
 *
 * `listItemsByLibraryType`, `getDistinctMetadataValues` and `countItemsByGroup`
 * each take a REQUIRED `access: MediaAccessBoundary`. There is no permissive
 * default: a caller that genuinely wants unrestricted results must construct
 * `unrestrictedAccess()` so the decision is greppable.
 *
 * `deniesEverything(access)` short-circuits to an empty result before any SQL is
 * issued — cheaper than the `AND false` predicate and immune to the
 * empty-array-in-template hazard documented on `buildLibraryFilter`.
 *
 * NOT gated (deliberately, and unchanged by the boundary migration):
 * `getSeriesWithEpisodes`, `updateItemCustomMetadata` and
 * `bulkUpdateCustomMetadata` never took access arguments. Adding a gate here
 * would change which rows their callers see, which this migration must not do.
 * `getSeriesWithEpisodes` is guarded by its callers' `media_type` checks; the
 * two update functions are admin-scope writes.
 *
 * Also unchanged: the `episode_count`, `first_episode_id` and `completed_count`
 * LATERALs descend to episodes with no access predicate, so a restricted user
 * gets the correct SET of top-level rows but counts computed over episodes they
 * may not be entitled to. Pre-existing; out of scope for a mechanical reshape.
 *
 * @module queries/non-entertainment-browse
 */

import type postgres from 'postgres';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { LibraryScope, MediaAccessBoundary } from './builders/media-access-boundary.js';
import { NON_ENTERTAINMENT_LIBRARY_TYPES } from '$lib/server/utils/media-types.js';

export interface NonEntertainmentBrowseItem {
    id: string;
    title: string;
    media_type: string;
    has_files: boolean;
    release_year: number | null;
    overview: string | null;
    custom_metadata: Record<string, unknown>;
    custom_poster_url: string | null;
    custom_backdrop_url: string | null;
    episode_count: number;
    first_episode_id: string | null;
    created_at: string;
    /** Number of episodes the user has watched (0 when userId not provided). */
    completed_count: number;
}

export interface NonEntertainmentBrowseResult {
    items: NonEntertainmentBrowseItem[];
    total: number;
}

export interface GroupCount {
    group_value: string;
    count: number;
}

/**
 * Build the library-group access filter for non-entertainment top-level items.
 *
 * The returned `mi` rows are top-level (parent_id IS NULL). A row passes when:
 *   - it has at least one accessible file of its own (flat single-file item), OR
 *   - at least one descendant episode (under any season) has an accessible file.
 * Catalog-only rows with no accessible descendants are dropped (fail-closed).
 *
 * Callers pass the same {@link LibraryScope} to every query so the filter is
 * consistent across listItemsByLibraryType, getDistinctMetadataValues,
 * and countItemsByGroup.
 *
 * This is deliberately NOT `buildLibraryAccessFilter`. The shared builder admits
 * items with no files at all (`NOT EXISTS (... media_file_items ...)`); this one
 * requires an accessible file on self OR on a descendant episode, dropping
 * catalog-only rows. Swapping in the shared builder would change which rows a
 * restricted user sees.
 *
 * Scope behaviour:
 * - `all`        -> empty fragment
 * - `denyGroups` -> the existing predicate (identical SQL to the legacy path)
 * - `denyAll`    -> `AND false`
 *
 * `denyGroups` with an EMPTY id list also emits an empty fragment. That is not
 * just an optimisation: an empty `[]` interpolated into a postgres.js tagged
 * template becomes a bound parameter (`$N`) rather than being inlined, so
 * `!= ALL(${[]}::uuid[])` throws `syntax error at or near "$N"` at runtime — not
 * at compile time, not at lint time. The new scope type makes that shape
 * representable, so it must be handled here.
 */
function buildLibraryFilter(
    sql: postgres.Sql,
    scope: LibraryScope,
): postgres.PendingQuery<postgres.Row[]> {
    if (scope.kind === 'denyAll') {
        return sql`AND false`;
    }
    if (scope.kind === 'all' || scope.ids.length === 0) {
        return sql``;
    }
    const deniedGroupIds = scope.ids;
    return sql`AND (
        EXISTS (
            SELECT 1 FROM media_file_items mfi
            JOIN media_files mf ON mf.id = mfi.file_id
            WHERE mfi.media_item_id = mi.id
              AND (mf.library_group_id IS NULL
                   OR mf.library_group_id != ALL(${deniedGroupIds}::uuid[]))
        )
        OR EXISTS (
            SELECT 1
            FROM media_items ep
            JOIN media_items season ON season.id = ep.parent_id
            JOIN media_file_items mfi ON mfi.media_item_id = ep.id
            JOIN media_files mf ON mf.id = mfi.file_id
            WHERE season.parent_id = mi.id
              AND ep.media_type = 'episode'
              AND (mf.library_group_id IS NULL
                   OR mf.library_group_id != ALL(${deniedGroupIds}::uuid[]))
        )
    )`;
}

/**
 * List top-level media items of a given non-entertainment type.
 * Supports optional full-text search and JSONB metadata filters.
 *
 * The access boundary is REQUIRED — an unrestricted caller must say so with
 * `unrestrictedAccess()`. Both the count and the items query apply the same
 * boundary so pagination remains consistent with the returned set.
 */
export async function listItemsByLibraryType(
    sql: postgres.Sql,
    opts: {
        mediaType: string;
        search?: string;
        filters?: Record<string, string>;
        sort?: 'chronological' | 'alphabetical' | 'added' | 'department' | 'oldest';
        limit?: number;
        offset?: number;
        /** REQUIRED media access boundary. `denyAll` short-circuits to an empty page. */
        access: MediaAccessBoundary;
        /** When provided, includes per-series completed_count for this user. */
        userId?: string;
    },
): Promise<NonEntertainmentBrowseResult> {
    if (deniesEverything(opts.access)) return { items: [], total: 0 };

    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;

    // Build ORDER BY as a safe SQL fragment (no sql.unsafe)
    const orderFragment =
        opts.sort === 'chronological'
            ? sql`COALESCE(mi.custom_metadata->>'date_filmed', mi.created_at::text) DESC`
            : opts.sort === 'oldest'
              ? sql`COALESCE(mi.custom_metadata->>'date_filmed', mi.created_at::text) ASC`
              : opts.sort === 'alphabetical'
                ? sql`mi.title ASC`
                : opts.sort === 'department'
                  ? sql`mi.custom_metadata->>'department' ASC NULLS LAST, mi.title ASC`
                  : sql`mi.created_at DESC`;

    const libraryFilter = buildLibraryFilter(sql, opts.access.library);
    const ageFilter = buildAgeRatingFilter(sql, opts.access.age);

    // Build per-key metadata filter as a single fragment (safe: keys are not interpolated via sql.unsafe).
    // Must be a single fragment (sql`` or sql`AND ...`) — NOT an array. An empty array []
    // embedded in a postgres.js tagged template is treated as a bound parameter ($N), not
    // inlined, which produces "syntax error at or near '$N'" at runtime.
    const metadataFilter: postgres.PendingQuery<postgres.Row[]> =
        opts.filters && Object.keys(opts.filters).length > 0
            ? Object.entries(opts.filters).reduce(
                  (acc, [key, val]) => sql`${acc} AND mi.custom_metadata->>${key} = ${val}`,
                  sql``,
              )
            : sql``;

    // Count total
    const [countRow] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text AS count
        FROM media_items mi
        WHERE mi.media_type = ${opts.mediaType}
          AND mi.parent_id IS NULL
          ${opts.search ? sql`AND mi.search_vector @@ plainto_tsquery('simple', immutable_unaccent(${opts.search}))` : sql``}
          ${libraryFilter}
          ${ageFilter}
          ${metadataFilter}
    `;
    const total = parseInt(countRow?.count ?? '0', 10);

    // Optional completed_count LATERAL — only when a userId is provided.
    // Uses (user_id, media_id) index on user_media_state for efficient lookups.
    // IMPORTANT: The SELECT clause must also be conditional — referencing cc.completed_count
    // when the cc LATERAL is absent causes a PostgreSQL "missing FROM-clause entry for table cc"
    // error. Use a literal 0 when userId is absent.
    const completedCountLateral = opts.userId
        ? sql`
        LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS completed_count
            FROM media_items ep
            JOIN media_items season ON season.id = ep.parent_id
            JOIN user_media_state uws ON uws.media_id = ep.id AND uws.user_id = ${opts.userId}::uuid
            WHERE season.parent_id = mi.id
              AND ep.media_type = 'episode'
              AND uws.is_watched = true
        ) cc ON true`
        : sql``;

    // The completed_count SELECT expression must match the presence of the cc LATERAL.
    // When userId is absent, emit a literal 0; when present, use the LATERAL column.
    const completedCountSelect = opts.userId
        ? sql`COALESCE(cc.completed_count, 0) AS completed_count`
        : sql`0 AS completed_count`;

    // Lesson-number ordering for educational media type in first_episode LATERAL.
    // Use jsonb_typeof guard to avoid casting non-numeric strings (e.g. "lesson-1")
    // which would cause PostgreSQL to throw "invalid input syntax for type numeric".
    const feOrderBy =
        opts.mediaType === 'educational'
            ? sql`ORDER BY CASE WHEN jsonb_typeof(ep.custom_metadata->'lesson_number') = 'number' THEN (ep.custom_metadata->>'lesson_number')::numeric END NULLS LAST, season.sort_order NULLS LAST, ep.episode_number NULLS LAST`
            : sql`ORDER BY season.sort_order NULLS LAST, ep.episode_number NULLS LAST`;

    // Fetch items with episode counts via LATERAL joins (avoids per-row correlated subqueries)
    const items = await sql<NonEntertainmentBrowseItem[]>`
        SELECT
            mi.id,
            mi.title,
            mi.media_type,
            mi.has_files,
            mi.year AS release_year,
            mi.overview,
            COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
            mi.custom_poster_url,
            mi.custom_backdrop_url,
            ec.episode_count,
            fe.first_episode_id,
            mi.created_at::text AS created_at,
            ${completedCountSelect}
        FROM media_items mi
        LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS episode_count
            FROM media_items ep
            JOIN media_items season ON season.id = ep.parent_id
            WHERE season.parent_id = mi.id
              AND ep.media_type = 'episode'
        ) ec ON true
        LEFT JOIN LATERAL (
            SELECT ep.id AS first_episode_id
            FROM media_items ep
            JOIN media_items season ON season.id = ep.parent_id
            WHERE season.parent_id = mi.id
              AND ep.media_type = 'episode'
            ${feOrderBy}
            LIMIT 1
        ) fe ON true
        ${completedCountLateral}
        WHERE mi.media_type = ${opts.mediaType}
          AND mi.parent_id IS NULL
          ${opts.search ? sql`AND mi.search_vector @@ plainto_tsquery('simple', immutable_unaccent(${opts.search}))` : sql``}
          ${libraryFilter}
          ${ageFilter}
          ${metadataFilter}
        ORDER BY ${orderFragment}
        LIMIT ${limit}
        OFFSET ${offset}
    `;

    return { items, total };
}

/**
 * Get distinct values for a custom_metadata key across items of a given type.
 * Useful for building filter dropdowns (e.g., all departments, all events).
 *
 * Applies the same access boundary as listItemsByLibraryType so the filter
 * dropdowns never expose category values that only exist on restricted
 * items.
 */
export async function getDistinctMetadataValues(
    sql: postgres.Sql,
    mediaType: string,
    metadataKey: string,
    options: {
        /** REQUIRED media access boundary. `denyAll` short-circuits to `[]`. */
        access: MediaAccessBoundary;
    },
): Promise<string[]> {
    if (deniesEverything(options.access)) return [];

    const libraryFilter = buildLibraryFilter(sql, options.access.library);
    const ageFilter = buildAgeRatingFilter(sql, options.access.age);

    const rows = await sql<Array<{ value: string }>>`
        SELECT DISTINCT mi.custom_metadata->>${metadataKey} AS value
        FROM media_items mi
        WHERE mi.media_type = ${mediaType}
          AND mi.parent_id IS NULL
          AND mi.custom_metadata ? ${metadataKey}
          AND mi.custom_metadata->>${metadataKey} IS NOT NULL
          AND mi.custom_metadata->>${metadataKey} != ''
          ${libraryFilter}
          ${ageFilter}
        ORDER BY value
    `;
    return rows.map((r) => r.value);
}

/**
 * Return per-group item counts for the given groupKey, scoped by the same
 * access boundary as listItemsByLibraryType. Used by the browse page to show
 * accurate group totals independent of pagination.
 *
 * NOTE both fragments are emitted INSIDE the inner `FROM media_items mi`
 * subquery. The outer SELECT has no `mi` in scope — hoisting them outward would
 * fail as a Postgres error at request time, not a type error.
 */
export async function countItemsByGroup(
    sql: postgres.Sql,
    opts: {
        mediaType: string;
        groupKey: string;
        search?: string;
        filters?: Record<string, string>;
        /** REQUIRED media access boundary. `denyAll` short-circuits to `[]`. */
        access: MediaAccessBoundary;
    },
): Promise<GroupCount[]> {
    if (deniesEverything(opts.access)) return [];

    const libraryFilter = buildLibraryFilter(sql, opts.access.library);
    const ageFilter = buildAgeRatingFilter(sql, opts.access.age);

    // Must be a single fragment (see metadataFilter comment in listItemsByLibraryType —
    // empty array [] in a postgres.js template literal causes "syntax error at $N").
    const metadataFilter: postgres.PendingQuery<postgres.Row[]> =
        opts.filters && Object.keys(opts.filters).length > 0
            ? Object.entries(opts.filters).reduce(
                  (acc, [key, val]) => sql`${acc} AND mi.custom_metadata->>${key} = ${val}`,
                  sql``,
              )
            : sql``;

    // Wrap in a subquery so the ORDER BY CASE WHEN can reference the `group_value`
    // alias rather than repeating the COALESCE expression. PostgreSQL does not allow
    // column aliases to appear inside ORDER BY expressions (only as bare column
    // references), but outer-query columns of a subquery are fully resolved.
    //
    // When the JSONB value for groupKey is an array (e.g. `tags` on personal libraries),
    // `->>` yields the raw JSON array text like `["travel","family"]` which never matches
    // the JS `String(["travel","family"])` → `"travel,family"` produced by the component.
    // Route array-typed values (and null/missing) to the same 'Uncategorized' bucket that
    // the JS side uses, so every item finds its bucket and none are silently dropped.
    const rows = await sql<GroupCount[]>`
        SELECT group_value, count
        FROM (
            SELECT
                CASE
                    WHEN jsonb_typeof(mi.custom_metadata->${opts.groupKey}) = 'array'
                      OR mi.custom_metadata->>${opts.groupKey} IS NULL
                    THEN 'Uncategorized'
                    ELSE mi.custom_metadata->>${opts.groupKey}
                END AS group_value,
                COUNT(*)::int AS count
            FROM media_items mi
            WHERE mi.media_type = ${opts.mediaType}
              AND mi.parent_id IS NULL
              ${opts.search ? sql`AND mi.search_vector @@ plainto_tsquery('simple', immutable_unaccent(${opts.search}))` : sql``}
              ${libraryFilter}
              ${ageFilter}
              ${metadataFilter}
            GROUP BY 1
        ) grouped
        ORDER BY CASE WHEN group_value = 'Uncategorized' THEN 1 ELSE 0 END, group_value
    `;

    return rows;
}

export interface NonEntertainmentEpisode {
    id: string;
    title: string;
    episode_number: number | null;
    sort_order: number | null;
    runtime_seconds: number | null;
    overview: string | null;
    /**
     * Basename of the episode's file, for a readable title when the item is
     * only named `SxxEyy`. Never the full path: this row is sent to the browser.
     */
    file_name: string | null;
}

/**
 * Load a single series and all its episodes (for the series detail page).
 * Episodes are ordered by season sort_order then episode_number.
 * When opts.mediaType === 'educational', episodes are additionally ordered by
 * custom_metadata->>'lesson_number' (numeric, NULLS LAST) as the primary key.
 */
export async function getSeriesWithEpisodes(
    sql: postgres.Sql,
    seriesId: string,
    opts?: { mediaType?: string },
): Promise<{
    series: NonEntertainmentBrowseItem | null;
    episodes: NonEntertainmentEpisode[];
}> {
    const isEducational = opts?.mediaType === 'educational';

    // ORDER BY fragment for the first-episode LATERAL (header row).
    // Use jsonb_typeof guard to avoid "invalid input syntax for type numeric" when
    // lesson_number is stored as a non-numeric string (e.g. "lesson-1" or "").
    const feOrderBy = isEducational
        ? sql`ORDER BY CASE WHEN jsonb_typeof(ep.custom_metadata->'lesson_number') = 'number' THEN (ep.custom_metadata->>'lesson_number')::numeric END NULLS LAST, season.sort_order NULLS LAST, ep.episode_number NULLS LAST`
        : sql`ORDER BY season.sort_order NULLS LAST, ep.episode_number NULLS LAST`;

    const [seriesRow] = await sql<NonEntertainmentBrowseItem[]>`
        SELECT
            mi.id,
            mi.title,
            mi.media_type,
            mi.has_files,
            mi.year AS release_year,
            mi.overview,
            COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
            mi.custom_poster_url,
            mi.custom_backdrop_url,
            ec.episode_count,
            fe.first_episode_id,
            mi.created_at::text AS created_at,
            0 AS completed_count
        FROM media_items mi
        LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS episode_count
            FROM media_items ep
            JOIN media_items season ON season.id = ep.parent_id
            WHERE season.parent_id = mi.id
              AND ep.media_type = 'episode'
        ) ec ON true
        LEFT JOIN LATERAL (
            SELECT ep.id AS first_episode_id
            FROM media_items ep
            JOIN media_items season ON season.id = ep.parent_id
            WHERE season.parent_id = mi.id
              AND ep.media_type = 'episode'
            ${feOrderBy}
            LIMIT 1
        ) fe ON true
        WHERE mi.id = ${seriesId}
          AND mi.parent_id IS NULL
        LIMIT 1
    `;

    if (!seriesRow) return { series: null, episodes: [] };

    // Main episode ORDER BY — lesson_number first for educational.
    // Use jsonb_typeof guard to avoid "invalid input syntax for type numeric" when
    // lesson_number is stored as a non-numeric string (e.g. "lesson-1" or "").
    const episodeOrderBy = isEducational
        ? sql`ORDER BY CASE WHEN jsonb_typeof(ep.custom_metadata->'lesson_number') = 'number' THEN (ep.custom_metadata->>'lesson_number')::numeric END NULLS LAST, season.sort_order NULLS LAST, ep.episode_number NULLS LAST, ep.created_at`
        : sql`ORDER BY season.sort_order NULLS LAST, ep.episode_number NULLS LAST, ep.created_at`;

    const episodes = await sql<NonEntertainmentEpisode[]>`
        SELECT
            ep.id,
            ep.title,
            ep.episode_number,
            season.sort_order,
            ep.runtime_seconds,
            ep.overview,
            regexp_replace(mf.file_path, '^.*[/\\\\]', '') AS file_name
        FROM media_items ep
        JOIN media_items season ON season.id = ep.parent_id
        LEFT JOIN media_file_items mfi ON mfi.media_item_id = ep.id
        LEFT JOIN media_files mf ON mf.id = mfi.file_id
        WHERE season.parent_id = ${seriesId}
          AND ep.media_type = 'episode'
        ${episodeOrderBy}
    `;

    return { series: seriesRow, episodes };
}

/**
 * Update custom_metadata for a media item (merge with existing).
 */
export async function updateItemCustomMetadata(
    sql: postgres.Sql,
    mediaItemId: string,
    metadata: Record<string, unknown>,
): Promise<boolean> {
    const result = await sql`
        UPDATE media_items
        SET custom_metadata = COALESCE(custom_metadata, '{}'::jsonb) || ${sql.json(metadata as Record<string, never>)},
            updated_at = now()
        WHERE id = ${mediaItemId}
    `;
    return result.count > 0;
}

/**
 * Bulk-update custom_metadata for a list of media items (merge with existing).
 * Does NOT lock the items — bulk edits from content managers should not prevent sync.
 *
 * @returns Number of rows actually updated.
 */
export async function bulkUpdateCustomMetadata(
    sql: postgres.Sql,
    ids: string[],
    metadata: Record<string, unknown>,
): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await sql`
        UPDATE media_items
        SET custom_metadata = COALESCE(custom_metadata, '{}'::jsonb) || ${sql.json(metadata as Record<string, never>)},
            updated_at = now()
        WHERE id = ANY(${ids}::uuid[])
          AND media_type = ANY(${NON_ENTERTAINMENT_LIBRARY_TYPES}::text[])
    `;
    return result.count;
}
