// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin (`/j`) filter-menu, genre and people-name queries.
 *
 * `GET /Items/Filters(2)`, `GET /Genres` and `GET /MusicGenres` all answer
 * "which names occur among the items this user can see in this scope". The
 * scope here is the same one `/Items` browsing applies for a ParentId (see
 * `browseMediaItems` in jellyfin-browse.queries.ts): direct children, rows
 * tagged with a Jellyfin library id, items with a file in the library group,
 * and series/artists whose descendants have one. A value is therefore offered
 * only when picking it can return rows.
 *
 * Every function takes a REQUIRED {@link MediaAccessBoundary}; `denyAll`
 * short-circuits to an empty answer. Library access and age filters are
 * spliced in against the `mi` alias (see the alias note in
 * jellyfin-browse.queries.ts).
 */

import type postgres from 'postgres';
import { buildMetadataLateralJoinFragment } from './builders/provider-metadata.builder';
import { buildLibraryAccessFilter } from './builders/library-access.builder';
import { buildAgeRatingFilter } from './builders/age-rating.builder';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { buildFileBackedVideoItemFilter } from './builders/file-backed-media.builder.js';
import {
    buildAutoEpisodeOrderingJoinFragment,
    buildUnmappedEpisodeFilterFragment,
} from './episode-search.queries.js';
import { UUID_RE_LOOSE } from '$lib/utils/id-patterns';

/** The DB media types `/j` serves as items. Everything else (extras, audiobooks…) is out of scope. */
export const JELLYFIN_ITEM_MEDIA_TYPES = [
    'movie',
    'tv',
    'season',
    'episode',
    'artist',
    'album',
    'track',
] as const;

const MUSIC_TYPES = ['artist', 'album', 'track'];

export interface JellyfinScope {
    /** Library group id, Jellyfin library id or a folder item id; null = everything. */
    parentId: string | null;
    /** DB media types (mapped `IncludeItemTypes`); empty = every `/j` item type. */
    mediaTypes: string[];
    /** DB media types to leave out (mapped `ExcludeItemTypes`). */
    excludeMediaTypes?: string[];
    /** Under an item parent, also match grandchildren (series → episodes, artist → tracks). */
    recursive?: boolean;
    /** Only these items (Jellyfin answers a non-folder ParentId with the item itself). */
    itemIds?: string[];
    access: MediaAccessBoundary;
}

function scopeTypes(scope: JellyfinScope): string[] {
    const wanted: string[] =
        scope.mediaTypes.length > 0
            ? scope.mediaTypes.filter((t) =>
                  (JELLYFIN_ITEM_MEDIA_TYPES as readonly string[]).includes(t),
              )
            : [...JELLYFIN_ITEM_MEDIA_TYPES];
    const excluded = new Set(scope.excludeMediaTypes ?? []);
    return wanted.filter((t) => !excluded.has(t));
}

/**
 * Joins the scope predicates read: `jf_pm` (Jellyfin-imported library ids)
 * under a parent, and the episode-ordering joins the recursive parent path
 * needs to leave out unmapped episodes, exactly as `browseMediaItems` does.
 */
function scopeJoins(sql: postgres.Sql, scope: JellyfinScope) {
    if (!scope.parentId) return sql``;
    return sql`
        LEFT JOIN LATERAL (
            SELECT metadata
            FROM provider_metadata
            WHERE media_id = mi.id AND provider = 'jellyfin'
            LIMIT 1
        ) jf_pm ON true
        ${
            scope.recursive
                ? sql`LEFT JOIN media_items parent_season
                ON parent_season.id = mi.parent_id AND mi.media_type = 'episode'
            ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi', 'parent_season.parent_id')}`
                : sql``
        }
    `;
}

/**
 * The ParentId predicate of `browseMediaItems`, for a scope that always names
 * its media types (so episodes are not suppressed under a library parent).
 */
function parentPredicate(sql: postgres.Sql, parentId: string | null, recursive: boolean) {
    if (!parentId) return sql``;
    // Never cast a malformed id: it can only be a (text) Jellyfin library id.
    if (!UUID_RE_LOOSE.test(parentId)) {
        return sql`AND (jf_pm.metadata->>'jellyfin_library_id')::text = ${parentId}`;
    }
    return sql`AND (
        mi.parent_id = ${parentId}::uuid
        OR (jf_pm.metadata->>'jellyfin_library_id')::text = ${parentId}
        OR EXISTS (
            SELECT 1 FROM media_file_items _mfi
            JOIN media_files _mf ON _mf.id = _mfi.file_id
            WHERE _mfi.media_item_id = mi.id AND _mf.library_group_id = ${parentId}::uuid
        )
        OR EXISTS (
            SELECT 1 FROM media_items _ep
            JOIN media_items _season ON _season.id = _ep.parent_id
            JOIN media_file_items _mfi ON _mfi.media_item_id = _ep.id
            JOIN media_files _mf ON _mf.id = _mfi.file_id
            WHERE _season.parent_id = mi.id AND _mf.library_group_id = ${parentId}::uuid
        )
        OR EXISTS (
            SELECT 1 FROM media_items _child
            JOIN media_file_items _mfi ON _mfi.media_item_id = _child.id
            JOIN media_files _mf ON _mf.id = _mfi.file_id
            WHERE _child.parent_id = mi.id AND _mf.library_group_id = ${parentId}::uuid
        )
        ${
            recursive
                ? sql`OR mi.parent_id IN (
            SELECT _p.id FROM media_items _p WHERE _p.parent_id = ${parentId}::uuid
        )`
                : sql``
        }
    )`;
}

function scopePredicates(sql: postgres.Sql, scope: JellyfinScope, types: string[]) {
    const recursiveUnderParent = Boolean(scope.parentId && scope.recursive);
    return sql`
        AND mi.status = 'active'
        AND mi.media_type = ANY(${types}::text[])
        ${scope.itemIds ? sql`AND mi.id = ANY(${scope.itemIds}::uuid[])` : sql``}
        ${buildFileBackedVideoItemFilter(sql, true, types)}
        ${parentPredicate(sql, scope.parentId, scope.recursive ?? false)}
        ${recursiveUnderParent ? buildUnmappedEpisodeFilterFragment(sql, 'mi') : sql``}
        ${buildLibraryAccessFilter(sql, scope.access.library)}
        ${buildAgeRatingFilter(sql, scope.access.age)}
        ${types.includes('episode') ? episodeSeriesAgeFilter(sql, scope.access) : sql``}
    `;
}

/**
 * Episodes carry no age rating of their own (only movie/tv rows get one), so
 * an age-restricted user must be held to the series' rating: an episode
 * counts only when its series passes the age filter.
 */
export function episodeSeriesAgeFilter(sql: postgres.Sql, access: MediaAccessBoundary) {
    const seriesAge = buildAgeRatingFilter(sql, access.age, '_series');
    return sql`
        AND (
            mi.media_type <> 'episode'
            OR EXISTS (
                SELECT 1 FROM media_items _season
                JOIN media_items _series ON _series.id = _season.parent_id
                WHERE _season.id = mi.parent_id
                ${seriesAge}
            )
        )
    `;
}

/** Provider genre entry → name; the `/j` item serializer reads only `{name}` objects. */
function genreNameExpression(sql: postgres.Sql) {
    return sql`NULLIF(btrim(CASE WHEN jsonb_typeof(g) = 'object' THEN g->>'name' END), '')`;
}

function genreArray(sql: postgres.Sql) {
    return sql`CASE WHEN jsonb_typeof(pm.metadata->'genres') = 'array'
        THEN pm.metadata->'genres' ELSE '[]'::jsonb END`;
}

export interface JellyfinFilterValues {
    genres: string[];
    officialRatings: string[];
    years: number[];
    /** TMDB keywords, the `Tags` `/Items?Tags=` filters on. */
    tags: string[];
}

/**
 * Genre names, official ratings and production years over the items in scope
 * (Jellyfin `GetQueryFiltersLegacy`). Genres come from the same provider row
 * `/Items?Genres=` filters on, ratings from `content_rating` (the item's
 * `OfficialRating`), years from `media_items.year` (`ProductionYear`),
 * tags from the keywords `/Items?Tags=` matches.
 */
export async function getJellyfinFilterValues(
    sql: postgres.Sql,
    scope: JellyfinScope,
): Promise<JellyfinFilterValues> {
    const types = scopeTypes(scope);
    if (deniesEverything(scope.access) || types.length === 0) {
        return { genres: [], officialRatings: [], years: [], tags: [] };
    }
    const [row] = await sql<
        { genres: string[]; ratings: string[]; years: number[]; tags: string[] }[]
    >`
        WITH scoped AS MATERIALIZED (
            SELECT
                mi.year,
                ${genreArray(sql)} AS genres_json,
                NULLIF(btrim(pm.metadata->>'content_rating'), '') AS rating,
                CASE WHEN jsonb_typeof(pm.metadata->'keywords') = 'array'
                    THEN pm.metadata->'keywords' ELSE '[]'::jsonb END AS keywords_json
            FROM media_items mi
            ${buildMetadataLateralJoinFragment(sql)}
            ${scopeJoins(sql, scope)}
            WHERE true
              ${scopePredicates(sql, scope, types)}
        )
        SELECT
            ARRAY(
                SELECT DISTINCT n
                FROM scoped s
                CROSS JOIN LATERAL jsonb_array_elements(s.genres_json) AS g
                CROSS JOIN LATERAL (SELECT ${genreNameExpression(sql)} AS n) x
                WHERE n IS NOT NULL
                ORDER BY n
            ) AS genres,
            ARRAY(SELECT DISTINCT rating FROM scoped WHERE rating IS NOT NULL ORDER BY rating) AS ratings,
            ARRAY(SELECT DISTINCT year FROM scoped WHERE year IS NOT NULL ORDER BY year) AS years,
            ARRAY(
                SELECT DISTINCT btrim(k)
                FROM scoped s
                CROSS JOIN LATERAL jsonb_array_elements_text(s.keywords_json) AS k
                WHERE btrim(k) <> ''
                ORDER BY btrim(k)
            ) AS tags
    `;
    return {
        genres: dedupeCaseInsensitive(row?.genres ?? []),
        officialRatings: row?.ratings ?? [],
        years: (row?.years ?? []).map(Number),
        tags: dedupeCaseInsensitive(row?.tags ?? []),
    };
}

/** Item counts per DB media type for one genre. */
export type GenreTypeCounts = Partial<Record<string, number>>;

export interface ScopedGenre {
    name: string;
    counts: GenreTypeCounts;
    /** Distinct items in scope carrying the genre. */
    total: number;
}

/**
 * Genres over the items in scope with per-type item counts (Jellyfin
 * `GetGenres` + `ItemCounts`). Names differing only in case are one genre,
 * shown with the first spelling in name order. Sorted by name.
 */
export async function getJellyfinGenres(
    sql: postgres.Sql,
    scope: JellyfinScope,
): Promise<ScopedGenre[]> {
    const types = scopeTypes(scope);
    if (deniesEverything(scope.access) || types.length === 0) return [];
    const rows = await sql<{ name: string; media_type: string; n: number }[]>`
        SELECT x.n AS name, mi.media_type, COUNT(DISTINCT mi.id)::int AS n
        FROM media_items mi
        ${buildMetadataLateralJoinFragment(sql)}
        ${scopeJoins(sql, scope)}
        CROSS JOIN LATERAL jsonb_array_elements(${genreArray(sql)}) AS g
        CROSS JOIN LATERAL (SELECT ${genreNameExpression(sql)} AS n) x
        WHERE x.n IS NOT NULL
          ${scopePredicates(sql, scope, types)}
        GROUP BY x.n, mi.media_type
        ORDER BY x.n, mi.media_type
    `;
    const byKey = new Map<string, ScopedGenre>();
    for (const r of rows) {
        const key = r.name.toLowerCase();
        let genre = byKey.get(key);
        if (!genre) {
            genre = { name: r.name, counts: {}, total: 0 };
            byKey.set(key, genre);
        }
        genre.counts[r.media_type] = (genre.counts[r.media_type] ?? 0) + r.n;
        // Spellings of one genre on one item count once per spelling; rare
        // enough (provider casing drift) that the sum is accepted as the total.
        genre.total += r.n;
    }
    return [...byKey.values()];
}

export interface ScopedMusicGenre {
    genre: string;
    track_count: number;
    album_count: number;
}

/**
 * Music genres (track genre tags, the vocabulary `/MusicGenres` serves) of
 * the tracks under a parent: a library group, an album, or an artist (its
 * albums' tracks). The unscoped list is `getDistinctMusicGenres`.
 */
export async function getJellyfinMusicGenresUnder(
    sql: postgres.Sql,
    parentId: string,
    access: MediaAccessBoundary,
): Promise<ScopedMusicGenre[]> {
    if (deniesEverything(access)) return [];
    return sql<ScopedMusicGenre[]>`
        WITH track_genre AS MATERIALIZED (
            SELECT mi.id, mi.parent_id, mi.custom_metadata -> 'genre' AS genre_json
            FROM media_items mi
            WHERE mi.media_type = 'track'
              AND mi.status = 'active'
              AND (
                  mi.parent_id = ${parentId}::uuid
                  OR mi.parent_id IN (
                      SELECT _a.id FROM media_items _a WHERE _a.parent_id = ${parentId}::uuid
                  )
                  OR EXISTS (
                      SELECT 1 FROM media_file_items _mfi
                      JOIN media_files _mf ON _mf.id = _mfi.file_id
                      WHERE _mfi.media_item_id = mi.id AND _mf.library_group_id = ${parentId}::uuid
                  )
              )
              ${buildLibraryAccessFilter(sql, access.library)}
              ${buildAgeRatingFilter(sql, access.age)}
        ),
        genre_expanded AS (
            SELECT tg.id, tg.parent_id, btrim(elem) AS genre
            FROM track_genre tg,
                jsonb_array_elements_text(
                    CASE jsonb_typeof(tg.genre_json)
                        WHEN 'array' THEN tg.genre_json
                        ELSE jsonb_build_array(tg.genre_json #>> '{}')
                    END
                ) AS elem
            WHERE (tg.genre_json #>> '{}') IS NOT NULL
        )
        SELECT genre,
               COUNT(DISTINCT id)::int AS track_count,
               COUNT(DISTINCT parent_id)::int AS album_count
        FROM genre_expanded
        WHERE genre <> ''
        GROUP BY genre
        ORDER BY genre
    `;
}

/** True when a library group holds a music library path (Jellyfin `CollectionType=music`). */
export async function isMusicLibraryGroup(sql: postgres.Sql, id: string): Promise<boolean> {
    if (!UUID_RE_LOOSE.test(id)) return false;
    const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM library_paths
        WHERE library_group_id = ${id}::uuid AND media_type = 'music'
        LIMIT 1
    `;
    return rows.length > 0;
}

/** The media type of a `media_items` row, or null when there is none (library ids, junk). */
export async function getItemMediaType(sql: postgres.Sql, id: string): Promise<string | null> {
    if (!UUID_RE_LOOSE.test(id)) return null;
    const rows = await sql<{ media_type: string }[]>`
        SELECT media_type FROM media_items WHERE id = ${id}::uuid
    `;
    return rows[0]?.media_type ?? null;
}

function dedupeCaseInsensitive(names: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const name of names) {
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(name);
    }
    return out;
}

export { MUSIC_TYPES as JELLYFIN_MUSIC_MEDIA_TYPES };

/**
 * The ids among `episodeIds` whose series the user may not see by age rating
 * (see {@link episodeSeriesAgeFilter}). Empty when the boundary has no age
 * limit. `/Search/Hints` drops these before paging.
 */
export async function getEpisodesOfAgeHiddenSeries(
    sql: postgres.Sql,
    episodeIds: string[],
    access: MediaAccessBoundary,
): Promise<string[]> {
    if (episodeIds.length === 0 || access.age.kind === 'any') return [];
    const seriesAge = buildAgeRatingFilter(sql, access.age, '_series');
    // Mirror episodeSeriesAgeFilter: an episode is visible only when a season
    // AND series exist and the series passes the age filter. Anything else
    // (orphan episode, missing series row) is hidden.
    const rows = await sql<{ id: string }[]>`
        SELECT ep.id
        FROM media_items ep
        WHERE ep.id = ANY(${episodeIds}::uuid[])
          AND ep.media_type = 'episode'
          AND NOT EXISTS (
              SELECT 1 FROM media_items _season
              JOIN media_items _series ON _series.id = _season.parent_id
              WHERE _season.id = ep.parent_id
              ${seriesAge}
          )
    `;
    return rows.map((r) => r.id);
}
