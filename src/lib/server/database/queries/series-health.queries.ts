// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Series Health Query Module
 *
 * Series-hierarchy helpers plus the episode-catalog measurement behind the
 * missing-episodes page and the per-series health status in the media browser.
 * Both are counted LIVE from `media_items` — see `getEpisodeGapsFromCatalog`.
 */

import type postgres from 'postgres';

export type HealthStatus = 'healthy' | 'notice' | 'warning' | 'mismatch' | 'unknown';

// =============================================================================
// Series Hierarchy Helpers
// =============================================================================

/**
 * Get all episode IDs for a series (properly joins through seasons).
 *
 * @example
 * const episodes = await getEpisodeIdsForSeries(sql, seriesId);
 */
export async function getEpisodeIdsForSeries(
    sql: postgres.Sql,
    seriesMediaId: string,
): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
        SELECT mi.id FROM media_items mi
        JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
        WHERE season.parent_id = ${seriesMediaId} AND mi.media_type = 'episode'
        ORDER BY mi.season_number, mi.episode_number
    `;
    return rows.map((r) => r.id);
}

/**
 * Count episodes for a series (properly joins through seasons).
 *
 * @example
 * const count = await countEpisodesForSeries(sql, seriesId);
 */
export async function countEpisodesForSeries(
    sql: postgres.Sql,
    seriesMediaId: string,
): Promise<number> {
    const [row] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count
        FROM media_items mi
        JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
        WHERE season.parent_id = ${seriesMediaId} AND mi.media_type = 'episode'
    `;
    return Number(row?.count ?? 0);
}

/**
 * Count episodes for a specific season.
 *
 * @example
 * const count = await countEpisodesForSeason(sql, seasonId);
 */
export async function countEpisodesForSeason(
    sql: postgres.Sql,
    seasonMediaId: string,
): Promise<number> {
    const [row] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count
        FROM media_items mi
        WHERE mi.parent_id = ${seasonMediaId} AND mi.media_type = 'episode'
    `;
    return Number(row?.count ?? 0);
}

/**
 * The `ep` and `seasons` CTEs every episode-catalog count shares, so the
 * whole-library summary and the one-series reading apply the same rules.
 * `seriesId` narrows the scan to one series (index on parent_id).
 */
function episodeCatalogCtes(sql: postgres.Sql, provider: string, seriesId?: string) {
    return sql`
        ep AS (
            SELECT season.parent_id AS series_id,
                   COALESCE(e.season_number, season.season_number) AS season_number,
                   e.has_files,
                   (COALESCE(e.season_number, season.season_number) > 0 AND e.premiere_date <= CURRENT_DATE) AS aired,
                   EXISTS (
                       SELECT 1 FROM external_ids x
                        WHERE x.media_id = e.id AND x.provider = ${provider}
                   ) AS identified
              FROM media_items e
              JOIN media_items season ON season.id = e.parent_id AND season.media_type = 'season'
             WHERE e.media_type = 'episode'
               ${seriesId ? sql`AND season.parent_id = ${seriesId}` : sql``}
               AND e.status = 'active'
               AND e.is_dismissed = false
        ), seasons AS (
            SELECT series_id,
                   season_number,
                   COUNT(*) FILTER (WHERE has_files AND aired)::int                    AS held,
                   COUNT(*) FILTER (WHERE has_files)::int                              AS any_held,
                   COUNT(*) FILTER (WHERE has_files AND NOT identified)::int           AS held_unmatched,
                   COUNT(*) FILTER (WHERE NOT has_files AND aired AND identified)::int AS missing,
                   COUNT(*) FILTER (WHERE identified)::int                             AS identified,
                   COUNT(*) FILTER (WHERE aired AND identified)::int                   AS listed
              FROM ep
             GROUP BY series_id, season_number
        )
    `;
}

export interface EpisodeGapRow {
    series_id: string;
    title: string;
    /** Aired, non-special episodes with a file. */
    held: number;
    /** Aired, non-special, provider-identified episodes with no file. */
    missing: number;
    /** Seasons contributing at least one missing episode. */
    seasons_affected: number;
}

export interface EpisodeGapSummary {
    /** Active series with at least one episode on disk — the denominator. */
    seriesWithFiles: number;
    /** Of those, series whose catalog holds no provider-identified episode at all. */
    unmeasuredSeries: number;
    /** Series holding a file the primary provider never matched — gap untrustworthy. */
    conflictedSeries: number;
    seriesWithGaps: number;
    missingTotal: number;
    /** Biggest gaps first, capped at `limit`. */
    gaps: EpisodeGapRow[];
}

/**
 * Missing episodes, measured LIVE from the episode catalog.
 *
 * series-sync writes every episode the provider lists as a `media_items` row;
 * the scanner flips `has_files` on the ones that have a file. So "the provider
 * lists 24, you have 19" is a plain count over rows that are current as of the
 * last series-sync — no snapshot table needed. (`series_health_reports` was the
 * old source: its only writer lost its only caller in March, so it is empty on
 * every instance and the page reported "0 of N analysed" forever.)
 *
 * What counts as missing — each exclusion is a false positive seen on prod:
 *   - specials (season 0) and unaired / undated episodes: not a shortfall;
 *   - catalog rows with no id from the primary provider: those come from a
 *     secondary provider's numbering, not from the list the operator compares to;
 *   - any series holding a file whose episode row has NO primary-provider id.
 *     That file never merged into the provider's row, so the same episode is in
 *     the catalog twice under two layouts — within a season (Sky Harbor: files
 *     S08E01-35, TMDB rows S08E229-263) or across seasons (Bleach: TMDB lists
 *     one 366-episode season, the files sit in DVD seasons 3-17). Either way the
 *     "missing" rows are on disk. The whole series is a matching problem, counted
 *     in `conflictedSeries` and never reported as missing.
 *
 * Aggregated in one pass (~200 ms over 92k episodes on prod) — never
 * a per-series correlated EXISTS, which took 55 s for a similar roll-up.
 */
export async function getEpisodeGapsFromCatalog(
    sql: postgres.Sql,
    provider: string,
    limit: number,
): Promise<EpisodeGapSummary> {
    const rows = await sql<
        (EpisodeGapRow & {
            total_series_with_files: number;
            total_unmeasured: number;
            total_conflicted: number;
            total_with_gaps: number;
            total_missing: number;
        })[]
    >`
        WITH ${episodeCatalogCtes(sql, provider)},
        per_series AS (
            SELECT series_id,
                   SUM(held)::int                                AS held,
                   SUM(any_held)::int                            AS any_held,
                   SUM(held_unmatched)::int                      AS held_unmatched,
                   SUM(identified)::int                          AS identified,
                   SUM(missing)::int                             AS raw_missing,
                   COUNT(*) FILTER (WHERE missing > 0)::int      AS seasons_affected
              FROM seasons
             GROUP BY series_id
        ), scoped AS (
            SELECT p.series_id, s.title, p.held, p.identified, p.seasons_affected,
                   (p.held_unmatched > 0) AS conflicted,
                   CASE WHEN p.held_unmatched > 0 THEN 0 ELSE p.raw_missing END AS missing
              FROM per_series p
              JOIN media_items s ON s.id = p.series_id
             WHERE s.media_type = 'tv'
               AND s.status = 'active'
               AND s.is_dismissed = false
               AND p.any_held > 0
        ), totals AS (
            SELECT COUNT(*)::int                                 AS total_series_with_files,
                   COUNT(*) FILTER (WHERE identified = 0)::int   AS total_unmeasured,
                   COUNT(*) FILTER (WHERE conflicted)::int       AS total_conflicted,
                   COUNT(*) FILTER (WHERE missing > 0)::int      AS total_with_gaps,
                   COALESCE(SUM(missing), 0)::int                AS total_missing
              FROM scoped
        )
        -- totals ride on every row; the RIGHT JOIN keeps them when no series has a gap.
        SELECT g.series_id, g.title, g.held, g.missing, g.seasons_affected, t.*
          FROM (
                SELECT * FROM scoped WHERE missing > 0
                 ORDER BY missing DESC, title
                 LIMIT ${limit}
               ) g
         RIGHT JOIN totals t ON true
         ORDER BY g.missing DESC NULLS LAST, g.title
    `;
    const first = rows[0];
    return {
        seriesWithFiles: first?.total_series_with_files ?? 0,
        unmeasuredSeries: first?.total_unmeasured ?? 0,
        conflictedSeries: first?.total_conflicted ?? 0,
        seriesWithGaps: first?.total_with_gaps ?? 0,
        missingTotal: first?.total_missing ?? 0,
        gaps: rows
            .filter((r) => r.series_id !== null)
            .map((r) => ({
                series_id: r.series_id,
                title: r.title,
                held: r.held,
                missing: r.missing,
                seasons_affected: r.seasons_affected,
            })),
    };
}

/** One series' episode catalog, counted by the rules of `getEpisodeGapsFromCatalog`. */
export interface SeriesEpisodeCoverage {
    /** Aired, non-special episodes with a file. */
    episodesHeld: number;
    /** Aired, non-special, provider-identified episodes — the provider's list. */
    episodesListed: number;
    /** Listed episodes with no file. Zero when `conflicted`. */
    missing: number;
    /** Non-special seasons holding an aired episode with a file. */
    seasonsHeld: number;
    /** Non-special seasons the provider lists an aired episode in. */
    seasonsListed: number;
    /** Provider-identified episodes of any kind — zero means unmeasured. */
    identified: number;
    /** A file sits on an episode row the primary provider never matched. */
    conflicted: boolean;
}

/**
 * The live coverage reading for one series (what `series_health_reports` used
 * to snapshot, and stopped snapshotting in March). Null when the series has no
 * episode rows at all.
 */
export async function getSeriesEpisodeCoverage(
    sql: postgres.Sql,
    provider: string,
    seriesId: string,
): Promise<SeriesEpisodeCoverage | null> {
    const [row] = await sql<
        {
            held: number;
            listed: number;
            raw_missing: number;
            seasons_held: number;
            seasons_listed: number;
            identified: number;
            held_unmatched: number;
        }[]
    >`
        WITH ${episodeCatalogCtes(sql, provider, seriesId)}
        SELECT SUM(held)::int                                                      AS held,
               SUM(listed)::int                                                    AS listed,
               SUM(missing)::int                                                   AS raw_missing,
               COUNT(*) FILTER (WHERE season_number > 0 AND held > 0)::int         AS seasons_held,
               COUNT(*) FILTER (WHERE season_number > 0 AND listed > 0)::int       AS seasons_listed,
               SUM(identified)::int                                                AS identified,
               SUM(held_unmatched)::int                                            AS held_unmatched
          FROM seasons
        HAVING COUNT(*) > 0
    `;
    if (!row) return null;
    const conflicted = row.held_unmatched > 0;
    return {
        episodesHeld: row.held,
        episodesListed: row.listed,
        missing: conflicted ? 0 : row.raw_missing,
        seasonsHeld: row.seasons_held,
        seasonsListed: row.seasons_listed,
        identified: row.identified,
        conflicted,
    };
}

/**
 * A coverage reading as a health status. Mirrors the old snapshot's scale:
 * off by at most two episodes is a `notice` (the provider-comparison note
 * already warns that small differences are normal), a numbering conflict is a
 * `mismatch`, and a series with no provider episode list cannot be judged.
 */
export function coverageHealthStatus(c: SeriesEpisodeCoverage): HealthStatus {
    if (c.identified === 0) return 'unknown';
    if (c.conflicted) return 'mismatch';
    if (c.missing === 0) return 'healthy';
    return c.missing <= 2 ? 'notice' : 'warning';
}

export interface SeasonCoverage {
    seriesId: string;
    seasonNumber: number | null;
    identified: number;
    held: number;
    listed: number;
    catalog: number;
    missing: number | null;
    otherIssues: number;
    conflicted: boolean;
}

/** One bounded batch for the visible series; same aired/identity rules as coverage above. */
export async function getSeasonCoverageBatch(
    sql: postgres.Sql,
    provider: string,
    seriesIds: string[],
): Promise<SeasonCoverage[]> {
    if (seriesIds.length === 0) return [];
    const rows = await sql<
        Array<{
            series_id: string;
            season_number: number | null;
            identified: number;
            held: number;
            listed: number;
            catalog: number;
            missing: number;
            unmatched: number;
            other_issues: number;
        }>
    >`
        WITH episodes AS (
            SELECT e.*, season.parent_id AS series_id,
                COALESCE(e.season_number, season.season_number) AS coverage_season
            FROM media_items e JOIN media_items season ON season.id=e.parent_id AND season.media_type='season'
            WHERE season.parent_id = ANY(${seriesIds}) AND e.media_type='episode'
                AND e.status='active' AND NOT e.is_dismissed
        )
        SELECT e.series_id, e.coverage_season AS season_number,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM external_ids x WHERE x.media_id=e.id AND x.provider=${provider}))::int AS identified,
            COUNT(*) FILTER (WHERE e.has_files AND (e.coverage_season IS NULL OR e.coverage_season = 0 OR (e.coverage_season > 0 AND e.premiere_date <= CURRENT_DATE)))::int AS held,
            COUNT(*) FILTER (WHERE (e.coverage_season IS NULL OR e.coverage_season = 0 OR (e.coverage_season > 0 AND e.premiere_date <= CURRENT_DATE))
                AND EXISTS (SELECT 1 FROM external_ids x WHERE x.media_id=e.id AND x.provider=${provider}))::int AS listed,
            COUNT(*)::int AS catalog,
            COUNT(*) FILTER (WHERE NOT e.has_files AND e.coverage_season > 0 AND e.premiere_date <= CURRENT_DATE
                AND EXISTS (SELECT 1 FROM external_ids x WHERE x.media_id=e.id AND x.provider=${provider}))::int AS missing,
            COUNT(*) FILTER (WHERE e.has_files AND NOT EXISTS
                (SELECT 1 FROM external_ids x WHERE x.media_id=e.id AND x.provider=${provider}))::int AS unmatched,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM integrity_violations v
                WHERE v.media_id=e.id AND v.resolved_at IS NULL)
                OR EXISTS (SELECT 1 FROM media_file_items l JOIN media_files f ON f.id=l.file_id
                    WHERE l.media_item_id=e.id AND jsonb_typeof(f.health_issues)='array'
                    AND f.health_issues <> '[]'::jsonb))::int AS other_issues
        FROM episodes e
        GROUP BY e.series_id, e.coverage_season
        ORDER BY (e.coverage_season=0), e.coverage_season NULLS LAST
    `;
    const conflicted = new Set(rows.filter((row) => row.unmatched > 0).map((row) => row.series_id));
    return rows.map((row) => ({
        seriesId: row.series_id,
        seasonNumber: row.season_number,
        identified: row.identified,
        held: row.held,
        listed: row.listed,
        catalog: row.catalog,
        missing:
            conflicted.has(row.series_id) || row.identified === 0 || row.season_number === null
                ? null
                : row.missing,
        otherIssues: row.other_issues,
        conflicted: conflicted.has(row.series_id),
    }));
}
