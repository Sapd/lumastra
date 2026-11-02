// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Live TV Programs Query Module
 *
 * Pure SQL queries for live TV program data (EPG).
 * All functions take sql: postgres.Sql as first parameter, no side effects.
 *
 * @module queries/livetv-programs
 */

import type postgres from 'postgres';
import { DEGRADED_FEED_PATTERN } from './livetv-channels.queries.js';
import { collapseProgramRows } from '$lib/server/services/livetv/epg-schedule.js';

// =============================================================================
// Types
// =============================================================================

export interface ProgramRow {
    id: string;
    channel_id: string;
    title: string;
    description: string | null;
    start_time: Date;
    end_time: Date;
    /** XMLTV channel id this listing came from (feed provenance). */
    epg_id: string | null;
    genres: string[] | null;
    official_rating: string | null;
    /** livetv_sources.id that produced this listing. */
    source_id: string | null;
}

export interface CategoryRow {
    id: string;
    name: string;
    sort_order: number;
    is_visible: boolean;
    channel_count: number;
}

// =============================================================================
// Program Queries
// =============================================================================

/**
 * Look up a program by its UUID. Used by /j/Items/{programId} when a Jellyfin
 * client asks for program details (refreshSelectedProgram on Android TV).
 */
export async function getProgramById(
    sql: postgres.Sql,
    programId: string,
): Promise<ProgramRow | null> {
    const rows = await sql<ProgramRow[]>`
		SELECT lp.id, lp.channel_id, lp.title, lp.description, lp.start_time, lp.end_time,
		       lp.epg_id, lp.genres, lp.official_rating, lc.source_id
		FROM livetv_programs lp
		LEFT JOIN livetv_channels lc ON lc.id = lp.channel_id
		WHERE lp.id = ${programId}
		LIMIT 1
	`;
    return rows[0] ?? null;
}

/**
 * Get the currently airing program for a channel.
 *
 * Ingest collapses parallel schedules, so exactly one program should cover
 * NOW(). Legacy rows imported before that fix can still leave several
 * candidates, hence `start_time DESC`: the most recently started program is the
 * best "on now" answer. Ascending would have pinned the oldest still-open entry
 * and shown the previous show for minutes after the next one began.
 *
 * `id` breaks a remaining tie. Without it two legacy rows sharing a start time
 * are an unordered pick, so consecutive requests could disagree about what is
 * on now with nothing having changed. This is a stable choice, not necessarily
 * the same one the read-time collapse would make — re-import to reconcile.
 */
export async function getCurrentProgram(
    sql: postgres.Sql,
    channelId: string,
): Promise<ProgramRow | null> {
    const rows = await sql<ProgramRow[]>`
		SELECT lp.id, lp.channel_id, lp.title, lp.description, lp.start_time, lp.end_time,
		       lp.epg_id, lp.genres, lp.official_rating, lc.source_id
		FROM livetv_programs lp
		LEFT JOIN livetv_channels lc ON lc.id = lp.channel_id
		WHERE lp.channel_id = ${channelId}
		  AND lp.start_time <= NOW()
		  AND lp.end_time > NOW()
		ORDER BY lp.start_time DESC, lp.id DESC
		LIMIT 1
	`;
    return rows[0] ?? null;
}

/**
 * Get programs for a channel within a date range.
 */
export async function getProgramsByDateRange(
    sql: postgres.Sql,
    channelId: string,
    start: Date,
    end: Date,
): Promise<ProgramRow[]> {
    return sql<ProgramRow[]>`
		SELECT lp.id, lp.channel_id, lp.title, lp.description, lp.start_time, lp.end_time,
		       lp.epg_id, lp.genres, lp.official_rating, lc.source_id
		FROM livetv_programs lp
		LEFT JOIN livetv_channels lc ON lc.id = lp.channel_id
		WHERE lp.channel_id = ${channelId}
		  AND lp.end_time > ${start}
		  AND lp.start_time < ${end}
		ORDER BY lp.start_time ASC
	`;
}

/**
 * Get programs for ALL visible channels within a date range (bulk EPG guide query).
 * Joins livetv_channels to exclude programs on hidden channels and on channels
 * in a hidden category (the stream gate's rule).
 */
export async function getGuidePrograms(
    sql: postgres.Sql,
    start: Date,
    end: Date,
): Promise<ProgramRow[]> {
    return sql<ProgramRow[]>`
        SELECT lp.id, lp.channel_id, lp.title, lp.description, lp.start_time, lp.end_time,
               lp.epg_id, lp.genres, lp.official_rating, lc.source_id
        FROM livetv_programs lp
        JOIN livetv_channels lc ON lc.id = lp.channel_id
        LEFT JOIN livetv_categories lcat ON lcat.id = lc.category_id
        WHERE lc.is_visible = true
          AND (lc.category_id IS NULL OR lcat.is_visible = true)
          AND lp.end_time > ${start}
          AND lp.start_time < ${end}
        ORDER BY lp.channel_id, lp.start_time ASC
    `;
}

/**
 * Latest end time of any listing on a visible channel, or null when the guide is
 * empty. /j/LiveTv/GuideInfo reports it as the end of the browsable guide.
 */
export async function getGuideEndDate(sql: postgres.Sql): Promise<Date | null> {
    const rows = await sql<{ end_date: Date | null }[]>`
        SELECT MAX(lp.end_time) AS end_date
        FROM livetv_programs lp
        JOIN livetv_channels lc ON lc.id = lp.channel_id
        LEFT JOIN livetv_categories lcat ON lcat.id = lc.category_id
        WHERE lc.is_visible = true
          AND (lc.category_id IS NULL OR lcat.is_visible = true)
    `;
    return rows[0]?.end_date ?? null;
}

/**
 * Full-text search programs by title using tsvector.
 */
export async function searchProgramsByText(
    sql: postgres.Sql,
    query: string,
    limit: number = 20,
): Promise<ProgramRow[]> {
    return sql<ProgramRow[]>`
		SELECT lp.id, lp.channel_id, lp.title, lp.description, lp.start_time, lp.end_time,
		       lp.epg_id, lp.genres, lp.official_rating, lc.source_id
		FROM livetv_programs lp
		LEFT JOIN livetv_channels lc ON lc.id = lp.channel_id
		WHERE lp.search_vector @@ plainto_tsquery('english', ${query})
		ORDER BY lp.start_time DESC
		LIMIT ${limit}
	`;
}

/**
 * Get the currently airing program for all channels (batch).
 * Uses DISTINCT ON to pick one program per channel.
 *
 * See getCurrentProgram() for why the tie-break is `start_time DESC`.
 */
export async function getCurrentProgramsForAllChannels(sql: postgres.Sql): Promise<ProgramRow[]> {
    return sql<ProgramRow[]>`
		SELECT DISTINCT ON (lp.channel_id)
		       lp.id, lp.channel_id, lp.title, lp.description, lp.start_time, lp.end_time,
		       lp.epg_id, lp.genres, lp.official_rating, lc.source_id
		FROM livetv_programs lp
		LEFT JOIN livetv_channels lc ON lc.id = lp.channel_id
		WHERE lp.start_time <= NOW()
		  AND lp.end_time > NOW()
		ORDER BY lp.channel_id, lp.start_time DESC, lp.id DESC
	`;
}

// =============================================================================
// Grouped Program Search Types
// =============================================================================

export interface GroupedProgramChannelRow {
    id: string;
    name: string;
    logo_url: string | null;
}

export interface GroupedProgramRow {
    title: string;
    description: string | null;
    temporal_status: 'live' | 'upcoming_today' | 'future' | 'ended';
    start_time: string;
    end_time: string;
    channels: GroupedProgramChannelRow[];
}

// =============================================================================
// Grouped Program Search Query
// =============================================================================

/**
 * Full-text search programs with temporal status computation, grouping by
 * (title, date, temporal_status), and channel aggregation.
 *
 * Results exclude programs on hidden channels (or in a hidden category) and programs that ended more
 * than 30 minutes ago. Ordered by temporal priority (live first), then
 * ts_rank relevance, then start_time.
 *
 * The limit applies to grouped results, not raw rows.
 */
export async function searchProgramsByTextGrouped(
    sql: postgres.Sql,
    query: string,
    limit: number = 20,
): Promise<GroupedProgramRow[]> {
    return sql<GroupedProgramRow[]>`
		WITH matched AS (
			SELECT
				lp.title,
				lp.description,
				lp.start_time,
				lp.end_time,
				lc.id AS channel_id,
				COALESCE(lc.admin_display_name, mi.title) AS channel_name,
				mi.custom_poster_url AS logo_url,
				lc.sort_order,
				ts_rank(lp.search_vector, plainto_tsquery('english', ${query})) AS rank,
				CASE
					WHEN NOW() >= lp.start_time AND NOW() < lp.end_time THEN 'live'
					WHEN lp.start_time > NOW() AND DATE(lp.start_time) = CURRENT_DATE THEN 'upcoming_today'
					WHEN lp.start_time > NOW() THEN 'future'
					ELSE 'ended'
				END AS temporal_status
			FROM livetv_programs lp
			JOIN livetv_channels lc ON lc.id = lp.channel_id
			JOIN media_items mi ON mi.id = lc.id
			LEFT JOIN livetv_categories lcat ON lcat.id = lc.category_id
			WHERE lp.search_vector @@ plainto_tsquery('english', ${query})
			  AND lc.is_visible = true
			  AND (lc.category_id IS NULL OR lcat.is_visible = true)
			  AND lp.end_time > NOW() - INTERVAL '30 minutes'
		),
		grouped AS (
			SELECT
				title,
				(array_remove(array_agg(description ORDER BY start_time), NULL))[1] AS description,
				temporal_status,
				MIN(start_time)::text AS start_time,
				MAX(end_time)::text AS end_time,
				json_agg(
					json_build_object(
						'id', channel_id,
						'name', channel_name,
						'logo_url', logo_url
					) ORDER BY sort_order ASC
				) AS channels_raw,
				CASE temporal_status
					WHEN 'live' THEN 1
					WHEN 'upcoming_today' THEN 2
					WHEN 'future' THEN 3
					WHEN 'ended' THEN 4
				END AS temporal_priority,
				MAX(rank) AS best_rank
			FROM matched
			GROUP BY title, DATE(start_time), temporal_status
		)
		SELECT
			title,
			description,
			temporal_status,
			start_time,
			end_time,
			channels_raw AS channels
		FROM grouped
		ORDER BY temporal_priority ASC, best_rank DESC, start_time ASC
		LIMIT ${limit}
	`;
}

// =============================================================================
// Category Queries
// =============================================================================

/**
 * Get all visible categories with channel counts.
 */
export async function getVisibleCategories(sql: postgres.Sql): Promise<CategoryRow[]> {
    return sql<CategoryRow[]>`
		SELECT c.id, c.name, c.sort_order, c.is_visible,
		       COALESCE(COUNT(lc.id), 0)::int AS channel_count
		FROM livetv_categories c
		LEFT JOIN livetv_channels lc ON lc.category_id = c.id AND lc.is_visible = true
		WHERE c.is_visible = true
		GROUP BY c.id
		ORDER BY c.sort_order ASC, c.name ASC
	`;
}

export interface StationAiringRow extends ProgramRow {
    station_id: string;
}

/**
 * Owner feed per station: one visible, present feed that has airings in the window.
 * `stationIds` null means every station. Shared by guide reads and EPG search so both
 * see the same schedule for a station.
 */
function ownerFeeds(
    sql: postgres.Sql,
    stationIds: string[] | null,
    from: Date,
    to: Date,
    matchingStationsOnly = false,
) {
    const stationFilter =
        stationIds === null
            ? sql`true`
            : sql`COALESCE(lc.backup_group_id, lc.id) = ANY(${stationIds}::uuid[])`;
    return sql`
        SELECT DISTINCT ON (COALESCE(lc.backup_group_id, lc.id))
               COALESCE(lc.backup_group_id, lc.id) AS station_id, lc.id, lc.source_id
          FROM livetv_channels lc
          JOIN media_items mi ON mi.id = lc.id
          LEFT JOIN livetv_backup_groups bg ON bg.id = lc.backup_group_id
          LEFT JOIN livetv_categories cat ON cat.id = lc.category_id
         WHERE ${stationFilter}
           AND ${
               matchingStationsOnly
                   ? sql`COALESCE(lc.backup_group_id, lc.id) IN (SELECT station_id FROM matched_stations)`
                   : sql`true`
           }
           AND lc.is_visible = true
           AND (lc.category_id IS NULL OR cat.is_visible = true)
           AND lc.consecutive_absences < 3
           AND EXISTS (
               SELECT 1 FROM livetv_programs p WHERE p.channel_id = lc.id
                 AND p.end_time > ${from} AND p.start_time < ${to}
           )
         ORDER BY COALESCE(lc.backup_group_id, lc.id),
                  (lc.id = bg.primary_channel_id) DESC NULLS LAST,
                  (mi.title ~* ${DEGRADED_FEED_PATTERN}) ASC,
                  CASE lc.quality_tier WHEN 'uhd' THEN 0 WHEN 'fhd' THEN 1 WHEN 'hd' THEN 2 WHEN 'sd' THEN 3 ELSE 4 END,
                  lc.sort_order, lc.id
    `;
}

/** Select exactly one visible, present owner feed per station before collapsing its schedule. */
export async function getStationAirings(
    sql: postgres.Sql,
    stationIds: string[],
    from: Date,
    to: Date,
): Promise<StationAiringRow[]> {
    if (stationIds.length === 0) return [];
    const rows = await sql<StationAiringRow[]>`
        WITH owners AS (${ownerFeeds(sql, stationIds, from, to)})
        SELECT p.id, p.channel_id, p.title, p.description, p.start_time, p.end_time,
               p.epg_id, p.genres, p.official_rating, o.source_id, o.station_id
          FROM owners o JOIN livetv_programs p ON p.channel_id = o.id
         WHERE p.end_time > ${from} AND p.start_time < ${to}
         ORDER BY o.station_id, p.start_time, p.end_time, p.id
    `;
    return collapseProgramRows(rows);
}

export interface ProgramSearchAiringRow {
    id: string;
    station_id: string;
    title: string;
    description: string | null;
    start_time: Date;
    end_time: Date;
    temporal_status: 'live' | 'upcoming_today' | 'future' | 'ended';
}

/** EPG search reaches this far ahead when picking each station's owner feed. */
const SEARCH_HORIZON_MS = 30 * 24 * 60 * 60_000;

/**
 * Full-text search over owner-feed airings: one row per airing, a show appears once per
 * station. Excludes airings that ended more than 30 minutes ago. Ordered live first, then
 * relevance, then start time; `offset` pages through that order.
 */
export async function searchProgramAirings(
    sql: postgres.Sql,
    query: string,
    limit: number,
    offset = 0,
): Promise<ProgramSearchAiringRow[]> {
    const from = new Date(Date.now() - 30 * 60_000);
    const to = new Date(from.getTime() + SEARCH_HORIZON_MS);
    return sql<ProgramSearchAiringRow[]>`
        WITH matched_stations AS MATERIALIZED (
            SELECT DISTINCT COALESCE(c.backup_group_id, c.id) AS station_id
              FROM livetv_programs match
              JOIN livetv_channels c ON c.id = match.channel_id
             WHERE match.search_vector @@ plainto_tsquery('english', ${query})
               AND match.end_time > ${from}
        ),
        -- Prune stations, never feeds: a matching backup must not displace a
        -- non-matching primary. Owner priority remains shared with the guide.
        owners AS (${ownerFeeds(sql, null, from, to, true)})
        SELECT p.id, o.station_id, p.title, p.description, p.start_time, p.end_time,
               CASE
                   WHEN NOW() >= p.start_time AND NOW() < p.end_time THEN 'live'
                   WHEN p.start_time > NOW() AND DATE(p.start_time) = CURRENT_DATE THEN 'upcoming_today'
                   WHEN p.start_time > NOW() THEN 'future'
                   ELSE 'ended'
               END AS temporal_status
          FROM owners o
          JOIN livetv_programs p ON p.channel_id = o.id
         WHERE p.search_vector @@ plainto_tsquery('english', ${query})
           AND p.end_time > ${from}
         ORDER BY CASE
                      WHEN NOW() >= p.start_time AND NOW() < p.end_time THEN 1
                      WHEN p.start_time > NOW() AND DATE(p.start_time) = CURRENT_DATE THEN 2
                      WHEN p.start_time > NOW() THEN 3
                      ELSE 4
                  END,
                  ts_rank(p.search_vector, plainto_tsquery('english', ${query})) DESC,
                  p.start_time, p.id
         LIMIT ${limit} OFFSET ${offset}
    `;
}
