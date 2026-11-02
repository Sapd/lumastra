// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * calendar.queries.ts — DB-backed calendar data.
 *
 * Two sources, UNIONed and ordered by premiere_date:
 *
 *   SOURCE 1 — catalog (media_items). Episodes (episode → season → series join)
 *   and movies whose premiere_date falls within [start, end]. These carry the
 *   internal UUID and are access-filtered at the source (library group + age
 *   rating). This is the original, unchanged behaviour: TMDB sync pre-creates
 *   episode stubs for tracked series and release-calendar-sync keeps their
 *   premiere_date fresh, so owned/tracked content is already present.
 *
 *   SOURCE 2 — projection gap-fill (upcoming_releases). Sonarr/Radarr
 *   calendar entries that have NO matching catalog row — i.e. monitored-but-not-
 *   owned titles that Source 1 structurally cannot show. These rows are
 *   STRUCTURALLY UNFILTERABLE: arr entries carry no library-group and no content
 *   rating, so neither access axis has anything to attach to. They are therefore
 *   included only when the caller asks for them AND the boundary is unrestricted
 *   on both axes — the second half of that conjunction is enforced *inside* this
 *   module (see `monitoredAllowed`), so a caller cannot leak monitored titles to
 *   a restricted user by getting its own gate wrong.
 *   These rows have a NULL internal id and `source = 'monitored'`; the frontend
 *   renders them "Not on server" and resolves artwork via the arr/tmdb image
 *   proxy using source_series_id / tmdb_id.
 *
 * Catalog de-dup: suppress an unbound, file-less flat-numbered stub only when
 * a provider-bound regular episode in another season has the same preserved
 * ordinal and air date. This covers catalog leftovers after renumbering.
 *
 * Source 2 drops an episode entry whose series is in the catalog (by
 * TMDB or TVDB id) and has an episode with the same numbers, or as many regular
 * episodes on that air date as Sonarr lists (Sonarr numbers by TVDB, the catalog
 * by TMDB), so nothing is listed twice.
 * When a title is later ingested, Source 1 starts matching it and the Source 2
 * row is naturally superseded — self-reconciling.
 */

import type postgres from 'postgres';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { deniesEverything, isUnrestricted } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';

export interface CalendarRow {
    /** Internal media_items UUID, or null for monitored-only (arr) entries. */
    id: string | null;
    title: string;
    /** 'episode' for TV episodes, 'movie' for movies. */
    media_type: string;
    /** Series title (episodes only). */
    series_name: string | null;
    /**
     * Series UUID (episodes only). Set on a monitored entry too when its series
     * is in the catalog (matched by TMDB or TVDB id); null otherwise.
     */
    series_id: string | null;
    season_number: number | null;
    episode_number: number | null;
    premiere_date: string | null;
    has_files: boolean;
    overview: string | null;
    year: number | null;
    /** 'catalog' = in the library/catalog; 'monitored' = arr-only gap-fill. */
    source: string;
    /** Sonarr numeric series id — artwork fallback for monitored episodes. */
    source_series_id: number | null;
    /** TMDB id — artwork fallback for monitored movies (and episode series). */
    tmdb_id: number | null;
}

/**
 * Fetch calendar items for the given date range.
 *
 * @param sql   - postgres.Sql instance
 * @param start - Range start (UTC day boundary)
 * @param end   - Range end (UTC day boundary)
 * @param access - REQUIRED media access boundary. Both axes must be stated;
 *   a caller that genuinely wants unrestricted rows passes
 *   `unrestrictedAccess()` so that decision is greppable. A `denyAll` boundary
 *   short-circuits to `[]` without touching the database.
 * @param includeMonitored - Caller's *request* for the monitored gap-fill
 *   (Source 2). It is honoured only when `access` is unrestricted on both axes
 *   — the access half of that gate is enforced here rather than trusted to the
 *   caller, because arr entries carry no library-group or content-rating to
 *   filter on and a dropped caller-side check would leak monitored titles to a
 *   restricted user. Required (no default): whether to gap-fill is a policy
 *   decision every caller must make explicitly.
 */
export async function getCalendarItemsFromDb(
    sql: postgres.Sql,
    start: Date,
    end: Date,
    access: MediaAccessBoundary,
    includeMonitored: boolean,
): Promise<CalendarRow[]> {
    // denyAll: skip the round trip entirely.
    //
    // This is defence in depth, not load-bearing today: the builders already emit
    // `AND false` on both catalog branches, and Source 2 is separately gated on
    // `isUnrestricted` below, which denyAll also fails. Removing this line leaves
    // every test green. It is kept because the guarantee it provides ("denyAll
    // returns nothing") should not depend on three separate downstream mechanisms
    // all continuing to hold, and because it saves a query that can only ever
    // return zero rows.
    if (deniesEverything(access)) return [];

    const startStr = start.toISOString().split('T')[0];
    const endStr = end.toISOString().split('T')[0];

    // Source 2 is structurally unfilterable (see file header), so it is gated on
    // a fully-unrestricted boundary in addition to the caller's own request.
    const monitoredAllowed = includeMonitored && isUnrestricted(access);

    // Source 2 (monitored gap-fill) — only when explicitly allowed. Anti-joined
    // against the catalog by TMDB id so nothing already shown by Source 1 repeats.
    //
    // The NOT EXISTS blocks below join media_items under the aliases
    // series/season/ep/mv. Those are de-dup EXISTENCE checks, not visibility
    // predicates, and must NOT acquire access filters: filtering them would make
    // a title the user cannot see re-appear as a 'monitored' row, which is an
    // existence leak. Do not "helpfully" add a boundary fragment to them.
    const monitoredPart = monitoredAllowed
        ? sql`
        UNION ALL

        -- Monitored episodes with no catalog stub.
        SELECT
            NULL::uuid              AS id,
            a.title,
            'episode'               AS media_type,
            a.series_title          AS series_name,
            -- The catalog series this arr entry belongs to, so the row opens it.
            cat.active_series_id    AS series_id,
            a.season_number,
            a.episode_number,
            a.air_date::text        AS premiere_date,
            a.has_file              AS has_files,
            a.overview,
            NULL::int               AS year,
            'monitored'             AS source,
            a.source_series_id,
            a.tmdb_id
        FROM upcoming_releases a
        -- The catalog series by TMDB id, else by TVDB id (Sonarr is TVDB-first,
        -- some entries carry no TMDB id). Composite key: (provider, external_id,
        -- media_type='tv'); TMDB ids are not unique across media types.
        LEFT JOIN LATERAL (
            SELECT
                series.id AS series_id,
                CASE WHEN series.status = 'active' THEN series.id END AS active_series_id
            FROM external_ids ei
            JOIN media_items series ON series.id = ei.media_id
                                   AND series.media_type = 'tv'
            WHERE ei.media_type = 'tv'
              AND (
                  (ei.provider = 'tmdb' AND ei.external_id = a.tmdb_id::text)
                  OR (ei.provider = 'tvdb' AND ei.external_id = a.tvdb_id::text)
              )
            ORDER BY (ei.provider = 'tmdb') DESC, series.id
            LIMIT 1
        ) cat ON true
        WHERE a.media_type = 'episode'
          AND a.air_date IS NOT NULL
          AND a.air_date >= ${startStr}::date
          AND a.air_date <= ${endStr}::date
          -- Already covered by Source 1 (catalog) → don't list twice.
          AND NOT EXISTS (
              SELECT 1
              FROM media_items season
              JOIN media_items ep ON ep.parent_id = season.id
                                 AND ep.media_type = 'episode'
              WHERE season.parent_id = cat.series_id
                AND season.media_type = 'season'
                AND season.season_number = a.season_number
                AND ep.episode_number = a.episode_number
          )
          -- Sonarr numbers by TVDB, the catalog by TMDB (a TVDB S2E3 can be TMDB
          -- S1E28), so a catalog episode on the same day also covers the entry —
          -- but only while the catalog has as many regular episodes that day as
          -- Sonarr lists for the series. On a batch-release day with one catalog
          -- stub, the other Sonarr entries must stay. Specials (season 0) never
          -- count: they are no TVDB/TMDB renumbering of a regular episode.
          AND NOT EXISTS (
              SELECT 1
              FROM (
                  SELECT count(*) AS n
                  FROM media_items season
                  JOIN media_items ep ON ep.parent_id = season.id
                                     AND ep.media_type = 'episode'
                  WHERE season.parent_id = cat.series_id
                    AND season.media_type = 'season'
                    AND season.season_number > 0
                    AND ep.premiere_date = a.air_date
              ) catalog_day,
              (
                  SELECT count(*) AS n
                  FROM upcoming_releases same_day
                  WHERE same_day.source = a.source
                    AND same_day.source_series_id IS NOT DISTINCT FROM a.source_series_id
                    AND same_day.media_type = 'episode'
                    AND same_day.air_date = a.air_date
                    AND COALESCE(same_day.season_number, 0) > 0
              ) arr_day
              WHERE COALESCE(a.season_number, 0) > 0
                AND catalog_day.n > 0
                AND catalog_day.n >= arr_day.n
          )

        UNION ALL

        -- Monitored movies with no catalog row.
        SELECT
            NULL::uuid              AS id,
            a.title,
            'movie'                 AS media_type,
            NULL::text              AS series_name,
            NULL::uuid              AS series_id,
            NULL::int               AS season_number,
            NULL::int               AS episode_number,
            a.air_date::text        AS premiere_date,
            a.has_file              AS has_files,
            a.overview,
            NULL::int               AS year,
            'monitored'             AS source,
            NULL::int               AS source_series_id,
            a.tmdb_id
        FROM upcoming_releases a
        WHERE a.media_type = 'movie'
          AND a.air_date IS NOT NULL
          AND a.air_date >= ${startStr}::date
          AND a.air_date <= ${endStr}::date
          AND NOT EXISTS (
              -- Composite key: (provider, external_id, media_type='movie').
              SELECT 1
              FROM external_ids ei
              JOIN media_items mv ON mv.id = ei.media_id
                                 AND mv.media_type = 'movie'
              WHERE ei.provider = 'tmdb'
                AND ei.media_type = 'movie'
                AND ei.external_id = a.tmdb_id::text
          )
    `
        : sql``;

    return sql<CalendarRow[]>`
        -- SOURCE 1: catalog episodes (episode mi → season → series).
        -- buildLibraryAccessFilter references mi.id, so the episode row is mi.
        SELECT
            mi.id,
            mi.title,
            mi.media_type,
            series.title   AS series_name,
            series.id      AS series_id,
            mi.season_number,
            mi.episode_number,
            mi.premiere_date::text AS premiere_date,
            mi.has_files,
            mi.overview,
            series.year,
            'catalog'      AS source,
            NULL::int      AS source_series_id,
            NULL::int      AS tmdb_id
        FROM media_items mi
        JOIN media_items season ON season.id = mi.parent_id
                                AND season.media_type = 'season'
        JOIN media_items series ON series.id = season.parent_id
                                AND series.media_type = 'tv'
        WHERE mi.media_type = 'episode'
          AND mi.premiere_date IS NOT NULL
          AND mi.premiere_date >= ${startStr}::date
          AND mi.premiere_date <= ${endStr}::date
          -- A renumbered episode can leave an unbound flat-numbered stub in
          -- another season (S1E53 alongside S3E5). Date alone is not identity:
          -- require the same preserved absolute ordinal AND a provider-bound
          -- replacement. Keep specials, independent batch episodes, locked
          -- metadata and anything with local file evidence or an external id.
          AND NOT (
              mi.has_files = false
              AND NOT mi.metadata_locked
              AND mi.season_number > 0
              AND mi.sort_order = mi.episode_number
              AND NOT EXISTS (
                  SELECT 1 FROM external_ids stub_id
                  WHERE stub_id.media_id = mi.id AND stub_id.source IS DISTINCT FROM 'watch-sync-file'
              )
              AND NOT EXISTS (
                  SELECT 1 FROM media_file_items stub_file
                  WHERE stub_file.media_item_id = mi.id
              )
              AND EXISTS (
                  SELECT 1
                  FROM media_items replacement_season
                  JOIN media_items replacement
                    ON replacement.parent_id = replacement_season.id
                   AND replacement.media_type = 'episode'
                  JOIN external_ids replacement_id
                    ON replacement_id.media_id = replacement.id
                   AND replacement_id.media_type = 'episode'
                  WHERE replacement_season.parent_id = series.id
                    AND replacement_season.media_type = 'season'
                    AND replacement_season.season_number > 0
                    AND replacement.season_number > 0
                    AND replacement.season_number <> mi.season_number
                    AND replacement.episode_number < mi.episode_number
                    AND replacement.sort_order = mi.sort_order
                    AND replacement.premiere_date = mi.premiere_date
                    AND replacement.status = 'active'
                    AND NOT replacement.is_dismissed
              )
          )
          -- ALIAS SPLIT (deliberate, load-bearing): the two axes are applied to
          -- DIFFERENT rows on this branch. buildLibraryAccessFilter hardcodes the
          -- mi alias, so the library axis lands on the EPISODE row (where the
          -- file rows hang), while the age axis is applied to the SERIES row via
          -- the explicit alias override (episode rows carry no age_rating).
          -- Collapsing these onto one alias silently changes age-filtering for
          -- restricted users.
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildAgeRatingFilter(sql, access.age, 'series')}

        UNION ALL

        -- SOURCE 1: catalog movies.
        SELECT
            mi.id,
            mi.title,
            mi.media_type,
            NULL::text  AS series_name,
            NULL::uuid  AS series_id,
            NULL::int   AS season_number,
            NULL::int   AS episode_number,
            mi.premiere_date::text AS premiere_date,
            mi.has_files,
            mi.overview,
            mi.year,
            'catalog'   AS source,
            NULL::int   AS source_series_id,
            NULL::int   AS tmdb_id
        FROM media_items mi
        WHERE mi.media_type = 'movie'
          AND mi.premiere_date IS NOT NULL
          AND mi.premiere_date >= ${startStr}::date
          AND mi.premiere_date <= ${endStr}::date
          -- Movie branch: both axes apply to the same row, so both use mi.
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildAgeRatingFilter(sql, access.age)}
        ${monitoredPart}

        ORDER BY premiere_date ASC NULLS LAST
    `;
}
