// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { buildAutoEpisodeOrderingJoinFragment } from './episode-search.queries.js';
import { watchlistExistsFragment } from './builders/watchlist-exists.builder.js';
import { lastPlayedAtExpression } from './builders/last-played.builder.js';

export interface ItemDetailRow {
    [key: string]: unknown;
    id: string;
    title: string;
    original_title: string | null;
    media_type: string;
    year: number | null;
    created_at: string | null;
    runtime_seconds: number | null;
    parent_id: string | null;
    season_number: number | null;
    episode_number: number | null;
    mi_overview: string | null;
    premiere_date: string | null;
    sort_order: number | null;
    pm_overview: string | null;
    poster_path: string | null;
    backdrop_path: string | null;
    logo_path: string | null;
    thumb_path: string | null;
    vote_average: number | null;
    content_rating: string | null;
    tagline: string | null;
    genre_names: string[] | null;
    resume_position_ms: number | null;
    played_percentage: number | null;
    is_watched: boolean;
    last_played_at: string | Date | null;
    is_favorite: boolean;
    series_id: string | null;
    series_name: string | null;
    season_id: string | null;
    season_name: string | null;
    child_count: number | null;
}

export interface ChapterRow {
    chapter_index: number;
    chapter_name: string | null;
    start_ticks: string;
}

export interface TrickplayRow {
    file_id: string;
    width: number;
    height: number;
    tile_width: number;
    tile_height: number;
    thumbnail_count: number;
    interval_ms: number;
    bandwidth: number;
}

export interface LibraryGroupRow {
    library_group_id: string;
    media_type: string;
    path: string;
    group_name: string | null;
}

export async function getItemDetail(
    sql: postgres.Sql,
    itemId: string,
    userId: UserId | undefined,
): Promise<ItemDetailRow | null> {
    const rows = await sql<ItemDetailRow[]>`
        SELECT
            mi.id,
            mi.title,
            mi.original_title,
            mi.sort_title,
            mi.media_type,
            mi.year,
            mi.created_at,
            COALESCE(
                -- A combined file (S02E24E25) holds several episodes and is streamed
                -- WHOLE to compat clients: they have no way to enter at an episode's
                -- window, so what they actually receive is the entire file. Report its
                -- duration, or the client draws an 11-minute scrubber over a 22-minute
                -- stream and every seek, progress report and end-of-playback lands in
                -- the wrong place. The window is only usable by the first-party player.
                (
                    SELECT round(mf.duration_seconds)::int
                    FROM media_file_items mfi
                    JOIN media_files mf ON mf.id = mfi.file_id
                    WHERE mfi.media_item_id = mi.id
                      AND mfi.is_default = true
                      AND mfi.start_offset_ms IS NOT NULL
                      AND mf.duration_seconds > 0
                    LIMIT 1
                ),
                mi.runtime_seconds,
                (pm.metadata->>'runtime')::int * 60
            ) as runtime_seconds,
            mi.parent_id,
            COALESCE(eo.order_season_number, mi.season_number) AS season_number,
            COALESCE(eo.order_episode_number, mi.episode_number) AS episode_number,
            mi.overview as mi_overview,
            mi.premiere_date,
            mi.sort_order,
            (pm.metadata->>'overview')::text as pm_overview,
            (pm.metadata->>'poster_path')::text as poster_path,
            (pm.metadata->>'backdrop_path')::text as backdrop_path,
            (pm.metadata->>'logo_path')::text as logo_path,
            (pm.metadata->>'thumb_path')::text as thumb_path,
            (pm.metadata->>'vote_average')::float as vote_average,
            (pm.metadata->>'content_rating')::text as content_rating,
            (pm.metadata->>'tagline')::text as tagline,
            CASE WHEN pm.metadata->'genres' IS NOT NULL AND jsonb_typeof(pm.metadata->'genres') = 'array'
                THEN ARRAY(SELECT (g->>'name')::text FROM jsonb_array_elements(pm.metadata->'genres') AS g WHERE g->>'name' IS NOT NULL)
                ELSE NULL
            END as genre_names,
            ws.resume_position_ms,
            CASE WHEN ws.runtime_ms > 0 AND ws.resume_position_ms > 0
                THEN (ws.resume_position_ms::float / ws.runtime_ms * 100)
                ELSE 0
            END as played_percentage,
            COALESCE(ws.is_watched, false) as is_watched,
            ${lastPlayedAtExpression(sql, 'ws')} as last_played_at,
            ${watchlistExistsFragment(sql, sql`mi.id`, sql`${userId ?? null}::uuid`)} as is_favorite,
            parent_series.id as series_id,
            parent_series.title as series_name,
            parent_season.id as season_id,
            parent_season.title as season_name,
            (SELECT COUNT(*)::int FROM media_items children
             WHERE children.parent_id = mi.id AND children.status = 'active'
            ) as child_count
        FROM media_items mi
        LEFT JOIN provider_metadata pm ON pm.media_id = mi.id AND pm.provider = 'tmdb' AND mi.media_type != 'episode'
        LEFT JOIN user_media_state ws ON ws.media_id = mi.id AND ws.user_id = ${userId ?? null}::uuid
        LEFT JOIN media_items parent_season ON parent_season.id = mi.parent_id AND mi.media_type = 'episode'
        LEFT JOIN media_items parent_series ON (
            (mi.media_type = 'episode' AND parent_series.id = parent_season.parent_id)
            OR (mi.media_type = 'season' AND parent_series.id = mi.parent_id)
        )
        ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi', 'parent_season.parent_id')}
        WHERE mi.id = ${itemId}::uuid
          AND mi.status = 'active'
    `;
    return rows[0] ?? null;
}

export async function getChaptersForItem(sql: postgres.Sql, itemId: string): Promise<ChapterRow[]> {
    return sql<ChapterRow[]>`
        SELECT ec.chapter_index, ec.chapter_name, ec.start_ticks
        FROM episode_chapters ec
        JOIN media_file_items mfi ON mfi.file_id = ec.file_id
        WHERE mfi.media_item_id = ${itemId}::uuid
        ORDER BY ec.chapter_index
    `;
}

export async function getTrickplayForItem(
    sql: postgres.Sql,
    itemId: string,
): Promise<TrickplayRow[]> {
    return sql<TrickplayRow[]>`
        SELECT file_id, width, height, tile_width, tile_height, thumbnail_count,
               interval_ms, COALESCE(bandwidth, 0) as bandwidth
        FROM trickplay_params
        WHERE media_item_id = ${itemId}::uuid
    `;
}

/**
 * {@link getChaptersForItem} for many items at once (list routes asked for
 * `Fields=Chapters`): one query, rows tagged with their item.
 */
export async function getChaptersForItems(
    sql: postgres.Sql,
    itemIds: readonly string[],
): Promise<(ChapterRow & { media_item_id: string })[]> {
    if (itemIds.length === 0) return [];
    return sql<(ChapterRow & { media_item_id: string })[]>`
        SELECT mfi.media_item_id::text AS media_item_id,
               ec.chapter_index, ec.chapter_name, ec.start_ticks
        FROM episode_chapters ec
        JOIN media_file_items mfi ON mfi.file_id = ec.file_id
        WHERE mfi.media_item_id = ANY(${itemIds as string[]}::uuid[])
        ORDER BY mfi.media_item_id, ec.chapter_index
    `;
}

/** {@link getTrickplayForItem} for many items at once (`Fields=Trickplay` on lists). */
export async function getTrickplayForItems(
    sql: postgres.Sql,
    itemIds: readonly string[],
): Promise<(TrickplayRow & { media_item_id: string })[]> {
    if (itemIds.length === 0) return [];
    return sql<(TrickplayRow & { media_item_id: string })[]>`
        SELECT media_item_id::text AS media_item_id, file_id, width, height, tile_width,
               tile_height, thumbnail_count, interval_ms, COALESCE(bandwidth, 0) as bandwidth
        FROM trickplay_params
        WHERE media_item_id = ANY(${itemIds as string[]}::uuid[])
    `;
}

export interface AncestorItemRow {
    id: string;
    media_type: string;
}

/**
 * Parent chain of a media item, nearest ancestor first (episode → season →
 * series, track → album → artist). Follows only active rows and stops at the
 * first inactive ancestor. Bounded depth as a cycle guard.
 */
export async function getAncestorItemIds(
    sql: postgres.Sql,
    itemId: string,
): Promise<AncestorItemRow[]> {
    return sql<AncestorItemRow[]>`
        WITH RECURSIVE chain AS (
            SELECT mi.id, mi.parent_id, mi.media_type, 0 AS depth
            FROM media_items mi
            WHERE mi.id = ${itemId}::uuid AND mi.status = 'active'
            UNION ALL
            SELECT p.id, p.parent_id, p.media_type, c.depth + 1
            FROM media_items p
            JOIN chain c ON p.id = c.parent_id
            WHERE p.status = 'active' AND c.depth < 8
        )
        SELECT id, media_type FROM chain
        WHERE depth > 0
        ORDER BY depth ASC
    `;
}

/**
 * Library group an item belongs to, resolved through its own files or —
 * for folder items (series/season/album/artist) — the files of its
 * descendants. Returns null for catalog-only items with no files anywhere.
 *
 * `media_files.library_group_id` is itself denormalized and can be missing on
 * a real, playable file (backfill gap tracked separately). When no file in
 * the tree carries it directly, fall back to matching the file's own path
 * against `library_paths` — the same `LIKE 'prefix/%'` pattern the scanner
 * uses for `file_path`, with `%`/`_`/`\` escaped (matching the convention in
 * `media-files.queries.ts`) since `library_paths.path` is arbitrary
 * operator-configured text, not a trusted literal. A trailing slash on
 * `library_paths.path` is trimmed before the `/%` suffix is appended so it
 * still matches, and ties are broken deterministically by `lp.id`.
 */
export async function getLibraryGroupForItem(
    sql: postgres.Sql,
    itemId: string,
): Promise<string | null> {
    const rows = await sql<{ library_group_id: string }[]>`
        WITH RECURSIVE tree AS (
            SELECT mi.id, 0 AS depth
            FROM media_items mi
            WHERE mi.id = ${itemId}::uuid
            UNION ALL
            SELECT child.id, t.depth + 1
            FROM media_items child
            JOIN tree t ON child.parent_id = t.id
            WHERE t.depth < 3
        ),
        candidate_files AS (
            SELECT mf.library_group_id, mf.file_path, t.depth
            FROM tree t
            JOIN media_file_items mfi ON mfi.media_item_id = t.id
            JOIN media_files mf ON mf.id = mfi.file_id
        )
        SELECT COALESCE(
            (
                SELECT library_group_id
                FROM candidate_files
                WHERE library_group_id IS NOT NULL
                ORDER BY depth ASC
                LIMIT 1
            ),
            (
                SELECT lp.library_group_id
                FROM candidate_files cf
                JOIN library_paths lp
                    ON cf.file_path LIKE
                        rtrim(
                            replace(replace(replace(lp.path, '\\', '\\\\'), '%', '\\%'), '_', '\\_'),
                            '/'
                        ) || '/%' ESCAPE '\\'
                ORDER BY cf.depth ASC, length(lp.path) DESC, lp.id ASC
                LIMIT 1
            )
        ) AS library_group_id
    `;
    return rows[0]?.library_group_id ?? null;
}

/**
 * A `library_paths.enabled = false` row still has playable, visible items
 * behind it (pausing a library only hides it from the top-level nav list —
 * see `buildLibraryViews` — item-level browsing never gates on this flag).
 * So this lookup doesn't filter on `enabled` either: an item whose access has
 * already been established shouldn't lose its ancestor CollectionFolder just
 * because the library was paused.
 */
/**
 * Look up a library group's display info by id.
 *
 * `deniedGroupIds` is the caller's denied-group set (computed by the caller
 * via `getDeniedLibraryGroups`, not fetched here — this module stays pure
 * SQL with no side effects) — REQUIRED (pass `null` explicitly to skip the
 * check, e.g. when the caller already established access to `groupId` via a
 * different item's `checkMediaAccess` call) so omitting it is a compile
 * error rather than a silent fail-open default.
 *
 * When `groupId` is in that set, this returns `null` exactly as it would for
 * a group that doesn't exist at all, so a denied caller and a caller with a
 * bogus id are indistinguishable to the route above. The denial check runs
 * INSIDE the same `::uuid`-cast `WHERE` clause as the existence lookup, not
 * as a JS `.includes(groupId)` against the raw input string — `groupId` may
 * be dashless/uppercase (Jellyfin's native client form), and Postgres treats
 * every UUID spelling as equal under `::uuid` while `getDeniedLibraryGroups`
 * returns canonical lowercase-dashed strings, so a JS-side comparison would
 * silently miss and fail OPEN for a denied group requested in its dashless
 * form.
 */
export async function getLibraryGroupInfo(
    sql: postgres.Sql,
    groupId: string,
    deniedGroupIds: readonly string[] | null,
): Promise<LibraryGroupRow | null> {
    const rows = await sql<LibraryGroupRow[]>`
        SELECT lp.library_group_id, lp.media_type, lp.path,
            COALESCE(lg.display_name, lg.name) as group_name
        FROM library_paths lp
        LEFT JOIN library_groups lg ON lg.id = lp.library_group_id
        WHERE lp.library_group_id = ${groupId}::uuid
        ${deniedGroupIds && deniedGroupIds.length > 0 ? sql`AND lp.library_group_id != ALL(${deniedGroupIds}::uuid[])` : sql``}
        ORDER BY lp.created_at ASC
        LIMIT 1
    `;
    return rows[0] ?? null;
}
