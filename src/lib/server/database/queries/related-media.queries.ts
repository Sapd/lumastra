// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Related-media reads: an item's local extras (trailers, featurettes, …), the
 * library's local trailers as one list, and the seeds a "because you watched /
 * liked / starring …" recommendation row is built from.
 *
 * Extras are `media_items` rows with `media_type = 'extra'`, an `extra_type`
 * and `parent_id` = the movie/series (see media-extras.queries.ts). Their own
 * files may carry `library_group_id = NULL` (pre-16.159.0 ingest), so every
 * listing gates on the PARENT. It applies the same boundary to the extra as
 * well ({@link extraAccessFilter}), because playback (PlaybackInfo, streams)
 * gates the extra's own id: a list must not offer an extra the user then
 * cannot play (an age-limited user with unrated content hidden, as extras
 * carry no age_rating).
 */

import type postgres from 'postgres';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import {
    buildMediaScalarsLateralJoinFragment,
    buildMetadataLateralJoinFragment,
} from './builders/provider-metadata.builder.js';
import { buildLikePattern } from './builders/search-filter.builder.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { EMBEDDING_SOURCE } from '../../utils/embedding-source.js';

/** An extra with at least one present file, plus its parent's artwork. */
export interface ItemExtraRow {
    id: string;
    title: string;
    extra_type: string | null;
    runtime_seconds: number | null;
    created_at: string | null;
    parent_id: string;
    parent_title: string;
    parent_year: number | null;
    parent_poster_path: string | null;
    parent_backdrop_path: string | null;
}

/** Which extras a listing wants: local trailers, or everything else. */
export type ExtrasKind = 'trailers' | 'special_features';

function kindFilter(sql: postgres.Sql, kind: ExtrasKind): postgres.PendingQuery<postgres.Row[]> {
    return kind === 'trailers'
        ? sql`AND ex.extra_type = 'trailer'`
        : sql`AND ex.extra_type IS DISTINCT FROM 'trailer'`;
}

/** The boundary applied to the extra row itself (aliased `ex`), as playback applies it. */
function extraAccessFilter(
    sql: postgres.Sql,
    access: MediaAccessBoundary,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`${buildLibraryAccessFilter(sql, access.library, 'ex')} ${buildAgeRatingFilter(sql, access.age, 'ex')}`;
}

/** The extra (aliased `ex`) has at least one file that is not missing on disk. */
function presentFile(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`EXISTS (
        SELECT 1
        FROM media_file_items exmfi
        JOIN media_files exmf ON exmf.id = exmfi.file_id
        WHERE exmfi.media_item_id = ex.id
          AND exmf.is_missing = false
    )`;
}

/**
 * The extras of one item, ordered by type then title. Empty when the parent is
 * outside `access` (the caller still answers 404 for that via checkMediaAccess).
 */
export async function listItemExtras(
    sql: postgres.Sql,
    parentId: string,
    kind: ExtrasKind,
    access: MediaAccessBoundary,
): Promise<ItemExtraRow[]> {
    return sql<ItemExtraRow[]>`
        SELECT
            ex.id,
            ex.title,
            ex.extra_type,
            ex.runtime_seconds,
            ex.created_at,
            mi.id AS parent_id,
            mi.title AS parent_title,
            mi.year AS parent_year,
            (pm.metadata->>'poster_path')::text AS parent_poster_path,
            (pm.metadata->>'backdrop_path')::text AS parent_backdrop_path
        FROM media_items mi
        JOIN media_items ex ON ex.parent_id = mi.id AND ex.media_type = 'extra'
        ${buildMetadataLateralJoinFragment(sql)}
        WHERE mi.id = ${parentId}::uuid
          AND mi.status = 'active'
          ${kindFilter(sql, kind)}
          AND ${presentFile(sql)}
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildAgeRatingFilter(sql, access.age)}
          ${extraAccessFilter(sql, access)}
        ORDER BY ex.extra_type NULLS LAST, ex.title, ex.id
    `;
}

/** Per-parent counts of playable local trailers and special features. */
export interface ExtrasCounts {
    localTrailers: number;
    specialFeatures: number;
}

/**
 * Count extras for many parents in one query, the extras `access` lets the
 * user play. Callers pass ids of items the user can already see (the counts
 * reveal nothing beyond that item).
 */
export async function countItemExtras(
    sql: postgres.Sql,
    parentIds: string[],
    access: MediaAccessBoundary,
): Promise<Map<string, ExtrasCounts>> {
    const counts = new Map<string, ExtrasCounts>();
    if (parentIds.length === 0) return counts;
    // Counts only, keyed by parent ids the caller has already access-gated:
    // no extra title, id or artwork leaves this query.
    const rows = await sql<{ parent_id: string; trailers: number; others: number }[]>`
        SELECT
            ex.parent_id,
            COUNT(*) FILTER (WHERE ex.extra_type = 'trailer')::int AS trailers,
            COUNT(*) FILTER (WHERE ex.extra_type IS DISTINCT FROM 'trailer')::int AS others
        FROM media_items ex
        WHERE ex.parent_id = ANY(${parentIds}::uuid[])
          AND ex.media_type = 'extra'
          AND ${presentFile(sql)}
          ${extraAccessFilter(sql, access)}
        GROUP BY ex.parent_id
    `;
    for (const r of rows) {
        counts.set(r.parent_id, { localTrailers: r.trailers, specialFeatures: r.others });
    }
    return counts;
}

export interface LocalTrailersPageOptions {
    access: MediaAccessBoundary;
    startIndex: number;
    limit: number;
    /** 'SortName' (default), 'DateCreated', 'PremiereDate'/'ProductionYear', 'Random'. */
    sortBy: string;
    descending: boolean;
    searchTerm: string | null;
}

/**
 * Every local trailer whose parent the user can see, one page at a time
 * (GET /Trailers). Sorted by the parent's name/year, since a trailer's own
 * title is usually just "Trailer".
 */
export async function listAccessibleLocalTrailers(
    sql: postgres.Sql,
    opts: LocalTrailersPageOptions,
): Promise<{ rows: ItemExtraRow[]; totalCount: number }> {
    const dir = opts.descending ? sql`DESC` : sql`ASC`;
    const order =
        opts.sortBy === 'Random'
            ? sql`random()`
            : opts.sortBy === 'DateCreated'
              ? sql`ex.created_at ${dir} NULLS LAST, ex.id`
              : opts.sortBy === 'PremiereDate' || opts.sortBy === 'ProductionYear'
                ? sql`mi.year ${dir} NULLS LAST, mi.title, ex.id`
                : sql`mi.title ${dir}, ex.title, ex.id`;
    const pattern = opts.searchTerm ? buildLikePattern(opts.searchTerm) : null;
    const search = pattern
        ? sql`AND (mi.title ILIKE ${pattern} OR ex.title ILIKE ${pattern})`
        : sql``;
    const rows = await sql<(ItemExtraRow & { total_count: number })[]>`
        SELECT
            ex.id,
            ex.title,
            ex.extra_type,
            ex.runtime_seconds,
            ex.created_at,
            mi.id AS parent_id,
            mi.title AS parent_title,
            mi.year AS parent_year,
            (pm.metadata->>'poster_path')::text AS parent_poster_path,
            (pm.metadata->>'backdrop_path')::text AS parent_backdrop_path,
            COUNT(*) OVER()::int AS total_count
        FROM media_items ex
        JOIN media_items mi ON mi.id = ex.parent_id
        ${buildMetadataLateralJoinFragment(sql)}
        WHERE ex.media_type = 'extra'
          AND ex.extra_type = 'trailer'
          AND mi.status = 'active'
          AND ${presentFile(sql)}
          ${search}
          ${buildLibraryAccessFilter(sql, opts.access.library)}
          ${buildAgeRatingFilter(sql, opts.access.age)}
          ${extraAccessFilter(sql, opts.access)}
        ORDER BY ${order}
        LIMIT ${opts.limit} OFFSET ${opts.startIndex}
    `;
    let totalCount = rows[0]?.total_count ?? 0;
    if (rows.length === 0 && opts.startIndex > 0) {
        // Past the last page: COUNT(*) OVER() saw no rows, count separately.
        const [c] = await sql<{ n: number }[]>`
            SELECT COUNT(*)::int AS n
            FROM media_items ex
            JOIN media_items mi ON mi.id = ex.parent_id
            WHERE ex.media_type = 'extra'
              AND ex.extra_type = 'trailer'
              AND mi.status = 'active'
              AND ${presentFile(sql)}
              ${search}
              ${buildLibraryAccessFilter(sql, opts.access.library)}
              ${buildAgeRatingFilter(sql, opts.access.age)}
              ${extraAccessFilter(sql, opts.access)}
        `;
        totalCount = c?.n ?? 0;
    }
    return { rows: rows.map(({ total_count: _t, ...r }) => r), totalCount };
}

/** A movie a recommendation row is anchored on. */
export interface RecommendationSeedRow {
    id: string;
    title: string;
    /** pgvector text form; library embedding, else discovery. Null when neither exists. */
    embedding: string | null;
    actors: string[];
    directors: string[];
}

/**
 * The user's most recently watched (`'played'`) or favourite (`'liked'`)
 * movies the user can still see, newest first, with what the
 * recommendation rows need: an embedding, the top-billed actors, directors.
 */
export async function getMovieRecommendationSeeds(
    sql: postgres.Sql,
    params: {
        userId: string;
        kind: 'played' | 'liked';
        limit: number;
        access: MediaAccessBoundary;
    },
): Promise<RecommendationSeedRow[]> {
    const which =
        params.kind === 'played'
            ? sql`AND ums.is_watched = true ORDER BY ums.last_watched_at DESC NULLS LAST`
            : sql`AND ums.is_favorite = true ORDER BY ums.last_event_at DESC NULLS LAST`;
    // A seed only names the row ("Because you watched X"); its items are the
    // playable ones. A watched movie whose files were since lost is still a seed.
    // eslint-disable-next-line callback-safety/require-has-files-with-active-status -- seeds are the user's own watch/favourite history, not cards; the recommended items are filtered on has_files
    return sql<RecommendationSeedRow[]>`
            SELECT
                mi.id,
                mi.title,
                COALESCE(lib_emb.embedding, disc_emb.embedding)::text AS embedding,
                CASE WHEN jsonb_typeof(pm.metadata->'actors') = 'array'
                    THEN ARRAY(SELECT a FROM jsonb_array_elements_text(pm.metadata->'actors') WITH ORDINALITY AS t(a, n) ORDER BY n LIMIT 3)
                    ELSE ARRAY[]::text[]
                END AS actors,
                CASE WHEN jsonb_typeof(pm.metadata->'directors') = 'array'
                    THEN ARRAY(SELECT d FROM jsonb_array_elements_text(pm.metadata->'directors') WITH ORDINALITY AS t(d, n) ORDER BY n LIMIT 2)
                    ELSE ARRAY[]::text[]
                END AS directors
            FROM user_media_state ums
            JOIN media_items mi ON mi.id = ums.media_id
            ${buildMetadataLateralJoinFragment(sql)}
            LEFT JOIN media_embeddings lib_emb ON lib_emb.media_id = mi.id AND lib_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
            LEFT JOIN media_embeddings disc_emb ON disc_emb.media_id = mi.id AND disc_emb.source = ${EMBEDDING_SOURCE.DISCOVERY}
            WHERE ums.user_id = ${params.userId}::uuid
              AND mi.media_type = 'movie'
              AND mi.status = 'active'
              ${buildLibraryAccessFilter(sql, params.access.library)}
              ${buildAgeRatingFilter(sql, params.access.age)}
              ${which}
            LIMIT ${params.limit}
    `;
}

/**
 * Playable movies the user can see and has not watched whose cast (`'actor'`)
 * or directors (`'director'`) include `person`, best rated first.
 */
export async function findUnwatchedMoviesWithPerson(
    sql: postgres.Sql,
    params: {
        userId: string;
        person: string;
        role: 'actor' | 'director';
        excludeIds: string[];
        limit: number;
        access: MediaAccessBoundary;
    },
): Promise<string[]> {
    const key = params.role === 'actor' ? 'actors' : 'directors';
    const rows = await sql<{ id: string }[]>`
        SELECT mi.id
        FROM media_items mi
        ${buildMetadataLateralJoinFragment(sql)}
        WHERE mi.media_type = 'movie'
          AND mi.status = 'active'
          AND mi.has_files = true
          AND jsonb_typeof(pm.metadata->${key}) = 'array'
          AND pm.metadata->${key} ? ${params.person}
          AND mi.id != ALL(${params.excludeIds}::uuid[])
          AND NOT EXISTS (
              SELECT 1 FROM user_media_state ums
              WHERE ums.user_id = ${params.userId}::uuid
                AND ums.media_id = mi.id
                AND ums.is_watched = true
          )
          ${buildLibraryAccessFilter(sql, params.access.library)}
          ${buildAgeRatingFilter(sql, params.access.age)}
        ORDER BY (pm.metadata->>'vote_average')::float DESC NULLS LAST, mi.id
        LIMIT ${params.limit}
    `;
    return rows.map((r) => r.id);
}

/**
 * The item's media type when it exists, is active and lies inside `access`;
 * null otherwise (the route answers 404 either way).
 */
export async function getVisibleItemType(
    sql: postgres.Sql,
    itemId: string,
    access: MediaAccessBoundary,
): Promise<string | null> {
    const rows = await sql<{ media_type: string }[]>`
        SELECT mi.media_type
        FROM media_items mi
        WHERE mi.id = ${itemId}::uuid
          AND mi.status = 'active'
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildAgeRatingFilter(sql, access.age)}
    `;
    return rows[0]?.media_type ?? null;
}

/**
 * The stored remote (YouTube) trailer URL per item, for items the caller has
 * already access-gated. Items without one are absent from the map.
 */
export async function getRemoteTrailerUrls(
    sql: postgres.Sql,
    itemIds: string[],
): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    if (itemIds.length === 0) return urls;
    const rows = await sql<{ id: string; trailer_url: string }[]>`
        SELECT mi.id, ms.trailer_url
        FROM media_items mi
        ${buildMediaScalarsLateralJoinFragment(sql)}
        WHERE mi.id = ANY(${itemIds}::uuid[])
          AND ms.trailer_url IS NOT NULL
    `;
    for (const r of rows) urls.set(r.id, r.trailer_url);
    return urls;
}
