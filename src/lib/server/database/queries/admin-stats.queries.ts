// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin Statistics Query Module
 *
 * Aggregate watch statistics across all users, powered by the watch_history table.
 * Used by the /api/watch-stats endpoint for the admin stats dashboard.
 */
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import type postgres from 'postgres';
import { GenreService } from '../../services/genre.service.js';
import { toMovieOrSeries } from '$lib/shared/media-type-domain';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TopMediaRow {
    title: string;
    year: number | null;
    uniqueViewers: number;
    totalPlayTime: number; // minutes
    externalIds?: { tmdb?: string; imdb?: string; internal?: string };
}

export interface ActivityStats {
    dayOfWeek: Array<{
        day: string;
        count: number;
        minutes: number;
        percentage: number;
    }>;
    hourOfDay: Array<{
        hour: number;
        count: number;
        minutes: number;
        percentage: number;
    }>;
    totalSessions: number;
    totalMinutes: number;
    avgMinutesPerUser: number;
}

export interface TopUserRow {
    id: string;
    /**
     * Display label for the user. De-PII'd: resolved to the user's
     * display_name / username via a JOIN on `users`, falling back to the raw
     * forward-auth user_id only when no matching user row exists (brainstorm #3).
     */
    name: string;
    /** Avatar URL when the user has an uploaded avatar, else undefined. */
    images?: ImageSet;
    sessions: number;
    minutes: number;
    hours: number;
    avgSessionLength: number;
    totalPlayTime: string;
    lastActive: string;
}

export interface GenreBreakdownRow {
    name: string;
    count: number;
    totalMinutes: number;
    percentage: number;
}

export interface ContentFreshnessStats {
    recentContent: { items: number; totalHours: number; percentage: number };
    olderContent: { items: number; totalHours: number; percentage: number };
    /**
     * B5: items whose (series-resolved) year is unknown/NULL. Previously these
     * were silently dropped from both buckets AND the denominator — and episode
     * rows commonly lack a year — so episode watching mostly vanished. Now they
     * are reported explicitly. The `percentage` fields across all three buckets
     * share a denominator of recent + older + unknown items.
     */
    unknownContent: { items: number; totalHours: number; percentage: number };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_SESSION_SECONDS = 60;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * App display timezone for hour/day-of-week bucketing (B2).
 *
 * `watch_history.session_start_time` is `timestamptz` and prod Postgres runs in
 * UTC, but the audience is Europe/Berlin. Without an explicit `AT TIME ZONE`,
 * all hour/day-of-week derivations (the "when do people watch" charts) skew by
 * the UTC offset (1-2h, and near-midnight sessions land on the wrong day).
 *
 * This MUST resolve to the SAME zone the personal-stats path uses so the admin
 * and personal "peak hours" surfaces agree. The canonical definition is
 * `resolveAppTimezone()` / `APP_TIMEZONE` in
 * `src/lib/server/services/personal-stats.service.ts` (module-local there). The
 * logic is duplicated here intentionally — that constant is not exported and the
 * editable surface for this change is the query module — but the resolution
 * (TZ env var, validated against the IANA database, default Europe/Berlin) is
 * kept byte-identical so the two surfaces stay in lockstep.
 */
function resolveAppTimezone(): string {
    const candidate = process.env.TZ && process.env.TZ.trim() !== '' ? process.env.TZ.trim() : null;
    if (!candidate) return 'Europe/Berlin';
    try {
        // Throws RangeError for an unknown IANA zone name.
        new Intl.DateTimeFormat('en-US', { timeZone: candidate });
        return candidate;
    } catch {
        return 'Europe/Berlin';
    }
}
const APP_TIMEZONE = resolveAppTimezone();

// ---------------------------------------------------------------------------
// Timeframe helpers
// ---------------------------------------------------------------------------

export type Timeframe = 'AllTime' | 'LastWeek' | 'LastMonth';

function getInterval(timeframe: Timeframe): string {
    switch (timeframe) {
        case 'LastWeek':
            return '7 days';
        case 'LastMonth':
            return '30 days';
        case 'AllTime':
        default:
            return '100 years';
    }
}

// ---------------------------------------------------------------------------
// Row types for SQL results
// ---------------------------------------------------------------------------

type MediaRow = {
    title: string;
    year: number | null;
    unique_viewers: string;
    total_play_time: string;
    internal_id: string;
    tmdb_id: string | null;
    imdb_id: string | null;
};

type ActivityRow = {
    day_of_week: string;
    hour: string;
    session_count: string;
    total_minutes: string;
    // P3: unique user count via window function — identical on every row, so the
    // second COUNT(DISTINCT user_id) round-trip is no longer needed.
    unique_users: string;
};

type UserRow = {
    user_id: string;
    display_name: string | null;
    username: string | null;
    sessions: string;
    total_minutes: string;
    avg_session_minutes: string;
    last_active: string;
};

type GenreRow = {
    genre_id: string;
    total_seconds: string;
    content_count: string;
};

type FreshnessRow = {
    category: string;
    items: string;
    total_hours: string;
};

export type SummaryRow = {
    total_minutes: string;
    total_sessions: string;
    unique_items: string;
    unique_users: string;
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getTopMovies(
    sql: postgres.Sql,
    timeframe: Timeframe = 'AllTime',
    limit = 10,
): Promise<TopMediaRow[]> {
    const interval = getInterval(timeframe);
    // P4: external IDs resolved via a single LEFT JOIN LATERAL pivoting both
    // providers (MAX(...) FILTER), replacing two correlated subqueries per row.
    const rows = await sql<MediaRow[]>`
		WITH movie_stats AS (
			SELECT
				mi.id,
				mi.title,
				mi.year,
				COUNT(DISTINCT wh.user_id) AS unique_viewers,
				ROUND(COALESCE(SUM(wh.actual_watch_time_seconds), 0) / 60.0)::INTEGER AS total_play_time
			FROM watch_history wh
			JOIN media_items mi ON mi.id = wh.media_id
			WHERE wh.media_type = 'movie'
				AND wh.actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
				AND wh.session_start_time >= NOW() - ${interval}::INTERVAL
			GROUP BY mi.id, mi.title, mi.year
			ORDER BY unique_viewers DESC, total_play_time DESC
			LIMIT ${limit}
		)
		SELECT
			ms.title,
			ms.year,
			ms.unique_viewers,
			ms.total_play_time,
			ms.id AS internal_id,
			ext.tmdb_id,
			ext.imdb_id
		FROM movie_stats ms
		LEFT JOIN LATERAL (
			SELECT
				MAX(external_id) FILTER (WHERE provider = 'tmdb') AS tmdb_id,
				MAX(external_id) FILTER (WHERE provider = 'imdb') AS imdb_id
			FROM external_ids
			WHERE media_id = ms.id
		) ext ON true
		ORDER BY ms.unique_viewers DESC, ms.total_play_time DESC
	`;

    return rows.map((r) => ({
        title: r.title,
        year: r.year != null ? Number(r.year) : null,
        uniqueViewers: Number(r.unique_viewers),
        totalPlayTime: Number(r.total_play_time),
        externalIds: {
            internal: r.internal_id,
            tmdb: r.tmdb_id ?? undefined,
            imdb: r.imdb_id ?? undefined,
        },
    }));
}

export async function getTopTVShows(
    sql: postgres.Sql,
    timeframe: Timeframe = 'AllTime',
    limit = 10,
): Promise<TopMediaRow[]> {
    const interval = getInterval(timeframe);
    // Episodes have series_name denormalized on watch_history. Resolve each top
    // series back to its 'tv' media_item so the client can render a real poster +
    // year (a miss leaves externalIds empty → popcorn placeholder + "N viewers").
    //
    // Perf: rank the series FIRST and take the top ${limit}, then resolve the
    // series media_item + its external IDs for only those few titles. The naive
    // form materialised every `tv` row (5k+) and ran two correlated external_ids
    // subqueries per row (~690ms on preprod) even though only the top N survive.
    // B4: group on a normalized key (LOWER(TRIM(series_name))) so casing /
    // whitespace variants of the same show collapse into ONE leaderboard row
    // instead of two halved rows; carry a stable (localized) display title via MAX().
    //
    // Resolution is ROBUST via a 3-tier fallback (each tier exact — never fuzzy,
    // so a show can never be mis-attributed):
    //   1. ID-based (PRIMARY): map the watched episode's media_id UP to the owning
    //      'tv' row through the episode → season → series parent_id chain. This is
    //      what fixes localized/alternate series_name values (e.g. "Harborfolk
    //      Schwammkopf") whose denormalized name never equals the canonical title.
    //      Only the top N series' distinct media_ids are chain-walked (a handful of
    //      PK / parent_id index lookups), and the covering index
    //      idx_watch_history_admin_stats makes the initial episode scan index-only.
    //   2. exact normalized canonical-title match (the previous behaviour) — for
    //      legacy rows where media_id is NULL so the chain can't resolve.
    //   3. exact normalized match against original_title / english_title — for a
    //      NULL media_id whose localized name only equals an alternate-title column.
    // P4: external IDs resolved via a single LEFT JOIN LATERAL pivoting both
    // providers, replacing the two correlated subqueries per row.
    const rows = await sql<MediaRow[]>`
		WITH episode_watch AS (
			SELECT
				LOWER(TRIM(wh.series_name)) AS series_key,
				wh.series_name,
				wh.user_id,
				wh.media_id,
				wh.actual_watch_time_seconds
			FROM watch_history wh
			WHERE wh.media_type = 'episode'
				AND wh.series_name IS NOT NULL
				AND TRIM(wh.series_name) <> ''
				AND wh.actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
				AND wh.session_start_time >= NOW() - ${interval}::INTERVAL
		),
		series_stats AS (
			SELECT
				series_key,
				MAX(series_name) AS display_title,
				COUNT(DISTINCT user_id) AS unique_viewers,
				ROUND(COALESCE(SUM(actual_watch_time_seconds), 0) / 60.0)::INTEGER AS total_play_time
			FROM episode_watch
			GROUP BY series_key
		),
		top_series AS (
			SELECT series_key, display_title, unique_viewers, total_play_time
			FROM series_stats
			ORDER BY unique_viewers DESC, total_play_time DESC
			LIMIT ${limit}
		),
		-- Tier 1 (PRIMARY): resolve the series 'tv' id from the watched episode's
		-- media_id via the parent chain, for ONLY the top N series' distinct
		-- media_ids. MODE() picks the dominant resolved id and ignores NULLs (broken
		-- chains / non-library rows), so one odd episode can't derail the group.
		top_media_ids AS (
			SELECT DISTINCT ew.series_key, ew.media_id
			FROM episode_watch ew
			JOIN top_series ts ON ts.series_key = ew.series_key
			WHERE ew.media_id IS NOT NULL
		),
		id_resolved AS (
			SELECT
				tmi.series_key,
				MODE() WITHIN GROUP (ORDER BY
					CASE
						WHEN ep.media_type = 'episode' THEN COALESCE(gp.id, pa.id)
						WHEN ep.media_type = 'season' THEN pa.id
						WHEN ep.media_type = 'tv' THEN ep.id
					END
				) AS series_id
			FROM top_media_ids tmi
			JOIN media_items ep ON ep.id = tmi.media_id
			LEFT JOIN media_items pa ON pa.id = ep.parent_id
			LEFT JOIN media_items gp ON gp.id = pa.parent_id
			GROUP BY tmi.series_key
		),
		-- Tier 2: exact normalized canonical-title match (previous behaviour),
		-- preferring real library rows (has_files DESC) over discovery ghosts.
		title_items AS (
			SELECT DISTINCT ON (LOWER(TRIM(mi.title)))
				LOWER(TRIM(mi.title)) AS title_key, mi.id
			FROM media_items mi
			JOIN top_series ts ON LOWER(TRIM(mi.title)) = ts.series_key
			WHERE mi.media_type = 'tv'
			ORDER BY LOWER(TRIM(mi.title)), mi.has_files DESC, mi.updated_at DESC, mi.id
		),
		-- Tier 3: exact normalized match against original_title / english_title.
		alt_items AS (
			SELECT DISTINCT ON (alt_key) alt_key, id
			FROM (
				SELECT LOWER(TRIM(mi.original_title)) AS alt_key, mi.id, mi.has_files, mi.updated_at
				FROM media_items mi
				WHERE mi.media_type = 'tv'
					AND mi.original_title IS NOT NULL AND TRIM(mi.original_title) <> ''
				UNION ALL
				SELECT LOWER(TRIM(mi.english_title)) AS alt_key, mi.id, mi.has_files, mi.updated_at
				FROM media_items mi
				WHERE mi.media_type = 'tv'
					AND mi.english_title IS NOT NULL AND TRIM(mi.english_title) <> ''
			) alt
			JOIN top_series ts ON ts.series_key = alt.alt_key
			ORDER BY alt_key, alt.has_files DESC, alt.updated_at DESC, alt.id
		)
		SELECT
			ts.display_title AS title,
			mi.year,
			ts.unique_viewers,
			ts.total_play_time,
			COALESCE(idr.series_id, ti.id, ai.id) AS internal_id,
			ext.tmdb_id,
			ext.imdb_id
		FROM top_series ts
		LEFT JOIN id_resolved idr ON idr.series_key = ts.series_key
		LEFT JOIN title_items ti ON ti.title_key = ts.series_key
		LEFT JOIN alt_items ai ON ai.alt_key = ts.series_key
		LEFT JOIN media_items mi ON mi.id = COALESCE(idr.series_id, ti.id, ai.id)
		LEFT JOIN LATERAL (
			SELECT
				MAX(external_id) FILTER (WHERE provider = 'tmdb') AS tmdb_id,
				MAX(external_id) FILTER (WHERE provider = 'imdb') AS imdb_id
			FROM external_ids
			WHERE media_id = COALESCE(idr.series_id, ti.id, ai.id)
		) ext ON true
		ORDER BY ts.unique_viewers DESC, ts.total_play_time DESC
	`;

    return rows.map((r) => ({
        title: r.title,
        year: r.year != null ? Number(r.year) : null,
        uniqueViewers: Number(r.unique_viewers),
        totalPlayTime: Number(r.total_play_time),
        externalIds: {
            internal: r.internal_id ?? undefined,
            tmdb: r.tmdb_id ?? undefined,
            imdb: r.imdb_id ?? undefined,
        },
    }));
}

export async function getActivityStats(
    sql: postgres.Sql,
    timeframe: Timeframe = 'AllTime',
): Promise<ActivityStats> {
    const interval = getInterval(timeframe);

    // B2: bucket DOW/HOUR in APP_TIMEZONE (session_start_time is timestamptz in
    // UTC) so the "when do people watch" chart matches the audience's local time
    // and agrees with the personal-stats path.
    // P3: the unique-user count comes from a scalar subquery over the SAME
    // predicate (one extra index-only count, no second round-trip). NOTE: a
    // window COUNT(DISTINCT …) OVER () is NOT valid PostgreSQL ("DISTINCT is not
    // implemented for window functions"), so a correlated-free scalar subquery is
    // used instead. It is identical on every row.
    const rows = await sql<ActivityRow[]>`
		SELECT
			EXTRACT(DOW FROM session_start_time AT TIME ZONE ${APP_TIMEZONE})::INTEGER AS day_of_week,
			EXTRACT(HOUR FROM session_start_time AT TIME ZONE ${APP_TIMEZONE})::INTEGER AS hour,
			COUNT(*) AS session_count,
			ROUND(COALESCE(SUM(actual_watch_time_seconds), 0) / 60.0)::INTEGER AS total_minutes,
			(
				SELECT COUNT(DISTINCT user_id)
				FROM watch_history
				WHERE actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
					AND session_start_time >= NOW() - ${interval}::INTERVAL
			) AS unique_users
		FROM watch_history
		WHERE actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
			AND session_start_time >= NOW() - ${interval}::INTERVAL
		GROUP BY 1, 2
	`;

    // Aggregate by day of week
    const dayMap = new Map<number, { count: number; minutes: number }>();
    const hourMap = new Map<number, { count: number; minutes: number }>();
    let totalSessions = 0;
    let totalMinutes = 0;

    for (const row of rows) {
        const dow = Number(row.day_of_week);
        const hour = Number(row.hour);
        const count = Number(row.session_count);
        const minutes = Number(row.total_minutes);

        totalSessions += count;
        totalMinutes += minutes;

        const dayEntry = dayMap.get(dow) ?? { count: 0, minutes: 0 };
        dayEntry.count += count;
        dayEntry.minutes += minutes;
        dayMap.set(dow, dayEntry);

        const hourEntry = hourMap.get(hour) ?? { count: 0, minutes: 0 };
        hourEntry.count += count;
        hourEntry.minutes += minutes;
        hourMap.set(hour, hourEntry);
    }

    const dayOfWeek = DAY_NAMES.map((day, i) => {
        const entry = dayMap.get(i) ?? { count: 0, minutes: 0 };
        return {
            day,
            count: entry.count,
            minutes: entry.minutes,
            percentage: totalSessions > 0 ? Math.round((entry.count / totalSessions) * 100) : 0,
        };
    });

    const hourOfDay = Array.from({ length: 24 }, (_, i) => {
        const entry = hourMap.get(i) ?? { count: 0, minutes: 0 };
        return {
            hour: i,
            count: entry.count,
            minutes: entry.minutes,
            percentage: totalSessions > 0 ? Math.round((entry.count / totalSessions) * 100) : 0,
        };
    });

    // P3: unique-user count comes from the window function on the main query
    // (identical on every row). Falls back to 1 when there are no rows so the
    // avgMinutesPerUser divisor is never zero.
    const uniqueUsers = Number(rows[0]?.unique_users) || 1;

    return {
        dayOfWeek,
        hourOfDay,
        totalSessions,
        totalMinutes,
        avgMinutesPerUser: Math.round(totalMinutes / uniqueUsers),
    };
}

/**
 * Map a de-PII'd UserRow → TopUserRow. Prefers display_name, then username,
 * falling back to the raw user_id only when no users row matched the join.
 * Always builds an avatar URL keyed on USERNAME (never UUID) whenever a username
 * exists: the /api/image/user/{username}/avatar endpoint (getUserAvatar) resolves
 * the full chain — custom DB avatar → Jellyfin → Gravatar — so we cannot know
 * server-side whether an image exists without a per-user fetch. When none does the
 * endpoint 404s and the client <img onerror> falls back to the initial. (Gating on
 * a custom-avatar-only flag hid every Jellyfin/Gravatar avatar.)
 */
function mapTopUserRow(r: UserRow): TopUserRow {
    const minutes = Number(r.total_minutes);
    const hours = Math.round(minutes / 60);
    const name = r.display_name ?? r.username ?? r.user_id;
    return {
        id: r.user_id,
        name,
        sessions: Number(r.sessions),
        minutes,
        hours,
        avgSessionLength: Number(r.avg_session_minutes),
        totalPlayTime: hours >= 1 ? `${hours}h` : `${minutes}m`,
        lastActive: r.last_active ? new Date(r.last_active).toISOString() : '',
    };
}

export async function getTopUsers(
    sql: postgres.Sql,
    timeframe: Timeframe = 'AllTime',
    limit = 10,
): Promise<TopUserRow[]> {
    const interval = getInterval(timeframe);

    // brainstorm #3 / de-PII: resolve raw forward-auth user_id → display_name /
    // username + avatar presence via a LEFT JOIN on users. watch_history.user_id
    // is VARCHAR holding the users.id UUID, so the join key is u.id::text.
    // LEFT JOIN (not INNER) so a top-watcher whose users row is missing still
    // appears, falling back to the raw id in mapTopUserRow().
    const rows = await sql<UserRow[]>`
		WITH user_stats AS (
			SELECT
				user_id,
				COUNT(*) AS sessions,
				ROUND(COALESCE(SUM(actual_watch_time_seconds), 0) / 60.0)::INTEGER AS total_minutes,
				ROUND(COALESCE(AVG(actual_watch_time_seconds), 0) / 60.0)::INTEGER AS avg_session_minutes,
				MAX(session_start_time) AS last_active
			FROM watch_history
			WHERE actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
				AND session_start_time >= NOW() - ${interval}::INTERVAL
			GROUP BY user_id
			ORDER BY total_minutes DESC
			LIMIT ${limit}
		)
		SELECT
			us.user_id,
			u.display_name,
			u.username,
			us.sessions,
			us.total_minutes,
			us.avg_session_minutes,
			us.last_active
		FROM user_stats us
		LEFT JOIN users u ON u.id = us.user_id
		ORDER BY us.total_minutes DESC
	`;

    return rows.map(mapTopUserRow);
}

export async function getActiveUsers(sql: postgres.Sql, limit = 10): Promise<TopUserRow[]> {
    // de-PII: same users JOIN as getTopUsers (brainstorm #3).
    const rows = await sql<UserRow[]>`
		WITH user_stats AS (
			SELECT
				user_id,
				COUNT(*) AS sessions,
				ROUND(COALESCE(SUM(actual_watch_time_seconds), 0) / 60.0)::INTEGER AS total_minutes,
				ROUND(COALESCE(AVG(actual_watch_time_seconds), 0) / 60.0)::INTEGER AS avg_session_minutes,
				MAX(session_start_time) AS last_active
			FROM watch_history
			WHERE actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
				AND session_start_time >= NOW() - INTERVAL '30 days'
			GROUP BY user_id
			ORDER BY last_active DESC
			LIMIT ${limit}
		)
		SELECT
			us.user_id,
			u.display_name,
			u.username,
			us.sessions,
			us.total_minutes,
			us.avg_session_minutes,
			us.last_active
		FROM user_stats us
		LEFT JOIN users u ON u.id = us.user_id
		ORDER BY us.last_active DESC
	`;

    return rows.map(mapTopUserRow);
}

export async function getGenreBreakdown(
    sql: postgres.Sql,
    timeframe: Timeframe = 'AllTime',
    limit = 10,
): Promise<GenreBreakdownRow[]> {
    const interval = getInterval(timeframe);

    // B1: episodes/seasons carry NO genres (genres live on the series 'tv' row),
    //     so we resolve each watched media_id to its GENRE-BEARING id (grandparent
    //     for an episode, parent for a season, self for movie/tv) via the
    //     parent_id chain and aggregate the watch seconds onto that series. This
    //     stops the chart from dropping all TV/episode watch time.
    // B3: a media_id can have genres in >=2 provider_metadata rows (e.g. tmdb AND
    //     aggregated) — DISTINCT ON (media_id) collapses to ONE row so SUM does
    //     not multi-count the same seconds.
    // P5: media_genres is bounded to the resolved watched set instead of scanning
    //     all of provider_metadata.
    const rows = await sql<GenreRow[]>`
		WITH watched_raw AS (
			SELECT
				wh.media_id,
				SUM(wh.actual_watch_time_seconds) AS watch_seconds
			FROM watch_history wh
			WHERE wh.actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
				AND wh.session_start_time >= NOW() - ${interval}::INTERVAL
				AND wh.media_id IS NOT NULL
			GROUP BY wh.media_id
		),
		watched_media AS (
			-- Resolve episode/season → series so genres (held on the series) apply.
			SELECT
				CASE
					WHEN mi.media_type = 'episode' THEN COALESCE(grandparent.id, parent.id, mi.id)
					WHEN mi.media_type = 'season' THEN COALESCE(parent.id, mi.id)
					ELSE mi.id
				END AS genre_media_id,
				SUM(wr.watch_seconds) AS watch_seconds
			FROM watched_raw wr
			JOIN media_items mi ON mi.id = wr.media_id
			LEFT JOIN media_items parent ON parent.id = mi.parent_id
			LEFT JOIN media_items grandparent ON grandparent.id = parent.parent_id
			GROUP BY 1
		),
		media_genres AS (
			-- Distinct (media_id, genre) across ALL provider rows: collapses the
			-- cross-provider duplication that would multi-count watch seconds (B3)
			-- WITHOUT dropping a genre that exists only under one provider (a single
			-- DISTINCT ON picking one provider's array would lose the others' genres).
			SELECT DISTINCT
				pm.media_id,
				(elem->>'id')::integer AS genre_id
			FROM provider_metadata pm
			CROSS JOIN LATERAL jsonb_array_elements(pm.metadata->'genres') AS elem
			WHERE pm.media_id IN (SELECT genre_media_id FROM watched_media)
				AND pm.metadata->'genres' IS NOT NULL
				AND jsonb_typeof(pm.metadata->'genres') = 'array'
				AND jsonb_array_length(pm.metadata->'genres') > 0
				AND elem->>'id' ~ '^[0-9]+$'
		),
		genre_stats AS (
			SELECT
				mg.genre_id,
				SUM(wm.watch_seconds) AS total_seconds,
				COUNT(DISTINCT wm.genre_media_id) AS content_count
			FROM watched_media wm
			JOIN media_genres mg ON mg.media_id = wm.genre_media_id
			GROUP BY 1
		)
		SELECT genre_id, total_seconds, content_count
		FROM genre_stats
		ORDER BY total_seconds DESC
		LIMIT ${limit}
	`;

    const totalSeconds = rows.reduce((sum, r) => sum + Number(r.total_seconds), 0);

    return rows.map((r) => {
        const genreId = Number(r.genre_id);
        const seconds = Number(r.total_seconds);
        return {
            name: GenreService.getGenreName(genreId) || `Genre ${genreId}`,
            count: Number(r.content_count) || 0,
            totalMinutes: Math.round(seconds / 60),
            percentage: totalSeconds > 0 ? Math.round((seconds / totalSeconds) * 100) : 0,
        };
    });
}

export async function getContentFreshness(
    sql: postgres.Sql,
    timeframe: Timeframe = 'AllTime',
): Promise<ContentFreshnessStats> {
    const interval = getInterval(timeframe);
    const twoYearsAgo = new Date().getFullYear() - 2;

    // B5: resolve episode/season → series so freshness buckets by the SERIES year
    //     (not the episode air-year) and a binged show counts as ONE item rather
    //     than once per episode. NULL-year items go to an explicit 'unknown'
    //     bucket instead of being silently dropped (which mostly erased episode
    //     watching, since episode rows rarely carry media_items.year).
    const rows = await sql<FreshnessRow[]>`
		WITH watched_raw AS (
			SELECT
				wh.media_id,
				SUM(wh.actual_watch_time_seconds) AS watch_seconds
			FROM watch_history wh
			WHERE wh.actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
				AND wh.session_start_time >= NOW() - ${interval}::INTERVAL
				AND wh.media_id IS NOT NULL
			GROUP BY wh.media_id
		),
		resolved AS (
			SELECT
				CASE
					WHEN mi.media_type = 'episode' THEN COALESCE(grandparent.id, parent.id, mi.id)
					WHEN mi.media_type = 'season' THEN COALESCE(parent.id, mi.id)
					ELSE mi.id
				END AS series_id,
				CASE
					WHEN mi.media_type = 'episode' THEN COALESCE(grandparent.year, parent.year)
					WHEN mi.media_type = 'season' THEN parent.year
					ELSE mi.year
				END AS series_year,
				wr.watch_seconds
			FROM watched_raw wr
			JOIN media_items mi ON mi.id = wr.media_id
			LEFT JOIN media_items parent ON parent.id = mi.parent_id
			LEFT JOIN media_items grandparent ON grandparent.id = parent.parent_id
		),
		per_series AS (
			-- Collapse to one row per resolved series/movie so binged shows count once.
			SELECT
				series_id,
				MAX(series_year) AS series_year,
				SUM(watch_seconds) AS watch_seconds
			FROM resolved
			GROUP BY series_id
		)
		SELECT
			CASE
				WHEN series_year IS NULL THEN 'unknown'
				WHEN series_year >= ${twoYearsAgo} THEN 'recent'
				ELSE 'older'
			END AS category,
			COUNT(DISTINCT series_id) AS items,
			ROUND(COALESCE(SUM(watch_seconds), 0) / 3600.0, 1) AS total_hours
		FROM per_series
		GROUP BY 1
	`;

    const recent = rows.find((r) => r.category === 'recent');
    const older = rows.find((r) => r.category === 'older');
    const unknown = rows.find((r) => r.category === 'unknown');

    const recentItems = Number(recent?.items ?? 0);
    const olderItems = Number(older?.items ?? 0);
    const unknownItems = Number(unknown?.items ?? 0);
    const totalItems = recentItems + olderItems + unknownItems || 1;

    return {
        recentContent: {
            items: recentItems,
            totalHours: Number(recent?.total_hours ?? 0),
            percentage: Math.round((recentItems / totalItems) * 100),
        },
        olderContent: {
            items: olderItems,
            totalHours: Number(older?.total_hours ?? 0),
            percentage: Math.round((olderItems / totalItems) * 100),
        },
        unknownContent: {
            items: unknownItems,
            totalHours: Number(unknown?.total_hours ?? 0),
            percentage: Math.round((unknownItems / totalItems) * 100),
        },
    };
}

export interface DayHourRow {
    hour: number;
    count: number;
    minutes: number;
    percentage: number;
}

type DayHourDbRow = {
    hour: string;
    session_count: string;
    total_minutes: string;
};

export async function getDayHours(
    sql: postgres.Sql,
    dayName: string,
    timeframe: Timeframe = 'AllTime',
): Promise<DayHourRow[]> {
    const interval = getInterval(timeframe);
    // Case/whitespace-insensitive day resolution so a localized or differently
    // cased label ("monday", " Monday ") still maps to the right day instead of
    // silently returning an empty drilldown.
    const normalizedDay = dayName.trim().toLowerCase();
    const dayIndex = DAY_NAMES.findIndex((d) => d.toLowerCase() === normalizedDay);
    if (dayIndex === -1) return [];

    // B2: bucket the HOUR and the DOW filter predicate in APP_TIMEZONE so the
    // drilldown agrees with the day-of-week chart (both timezone-corrected) and
    // does not filter by UTC day.
    const rows = await sql<DayHourDbRow[]>`
		SELECT
			EXTRACT(HOUR FROM session_start_time AT TIME ZONE ${APP_TIMEZONE})::INTEGER AS hour,
			COUNT(*) AS session_count,
			ROUND(COALESCE(SUM(actual_watch_time_seconds), 0) / 60.0)::INTEGER AS total_minutes
		FROM watch_history
		WHERE actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
			AND session_start_time >= NOW() - ${interval}::INTERVAL
			AND EXTRACT(DOW FROM session_start_time AT TIME ZONE ${APP_TIMEZONE})::INTEGER = ${dayIndex}
		GROUP BY 1
		ORDER BY 1
	`;

    const totalSessions = rows.reduce((sum, r) => sum + Number(r.session_count), 0);

    // Fill all 24 hours
    const hourMap = new Map(rows.map((r) => [Number(r.hour), r]));

    return Array.from({ length: 24 }, (_, i) => {
        const r = hourMap.get(i);
        const count = Number(r?.session_count ?? 0);
        return {
            hour: i,
            count,
            minutes: Number(r?.total_minutes ?? 0),
            percentage: totalSessions > 0 ? Math.round((count / totalSessions) * 100) : 0,
        };
    });
}

export interface WatchSummary {
    totalWatchTime: number;
    totalWatchTimeFormatted: string;
    totalSessions: number;
    uniqueItems: number;
    /** C6: distinct users with >=60s sessions — a useful KPI, previously computed then dropped. */
    uniqueUsers: number;
    user: string;
}

// ---------------------------------------------------------------------------
// Operator-insight stats (brainstorm: cold-content, completion-leaderboard,
// dormant-users, device-mix)
// ---------------------------------------------------------------------------

export interface ColdContentRow {
    title: string;
    mediaType: 'movie' | 'series';
    year: number | null;
    internalId: string;
    posterUrl: string;
    /** ISO timestamp the file was added to the library (library_added_at → created_at). */
    addedAt: string;
    /** Whole days since the title was added. */
    ageDays: number;
    /** Total file size in bytes across the title's media files (series = sum over episodes). */
    sizeBytes: number;
    /**
     * Qualifying watch sessions for the title WITHIN the selected timeframe
     * (episode sessions roll up to the series). 0 = never watched in the window;
     * the list is ordered by this ascending so the least-watched surface first.
     */
    watchCount: number;
    /**
     * `skyline` sort only: true when the title is on the Pareto frontier of
     * (minimize watchCount, maximize sizeBytes) — i.e. no other title is both
     * watched no-more-often AND at least as large. These are the optimal
     * "reclaim the most space for the least-watched content" prune picks. Always
     * false in the default `cold` sort.
     */
    isSkyline: boolean;
}

type ColdContentDbRow = {
    title: string;
    media_type: 'movie' | 'tv';
    year: number | null;
    internal_id: string;
    added_at: string;
    age_days: string;
    size_bytes: string | null;
    watch_count: string;
    is_skyline?: boolean | null;
};

/**
 * Cold-content ordering strategy.
 *  - `cold`    : least-watched first, then oldest-added (the original behaviour).
 *  - `skyline` : biggest space-wasters first — the Pareto frontier of
 *                (minimize watch_count, maximize size_bytes), skyline members
 *                ordered by size DESC, then the rest by size DESC as fill.
 */
export type ColdContentSort = 'cold' | 'skyline';

/**
 * `cold-content` — LEAST-watched content (never + rarely watched).
 *
 * Lists catalog titles (movies + series) that own library files (has_files,
 * active), ordered by qualifying watch sessions ASCENDING within the selected
 * timeframe, then oldest `library_added_at`/`created_at` first. So the top of
 * the list is the best prune candidates: count 0 (never watched in the window)
 * first, then 1, 2, … (rarely watched). The timeframe makes it dual-purpose:
 * AllTime = least-watched ever; LastWeek/LastMonth = content gone cold lately
 * (no/few plays in that window even if watched long ago).
 *
 * TV is resolved at the SERIES level: episode (and season) sessions roll UP to
 * the series via the episode→season→series parent_id chain, so the count is
 * series-wide and episodes/seasons are never listed as their own rows.
 *
 * size_bytes sums media_files.file_size_bytes over the title's files; for a
 * series that means every episode's file under the series subtree.
 */
export async function getColdContent(
    sql: postgres.Sql,
    timeframe: Timeframe = 'AllTime',
    limit = 10,
    sort: ColdContentSort = 'cold',
): Promise<ColdContentRow[]> {
    const interval = getInterval(timeframe);

    if (sort === 'skyline') {
        return getColdContentSkyline(sql, interval, limit);
    }

    const rows = await sql<ColdContentDbRow[]>`
			WITH candidates AS (
				SELECT
					mi.id,
					mi.title,
					mi.media_type,
					mi.year,
					COALESCE(mi.library_added_at, mi.created_at) AS added_at
				FROM media_items mi
				WHERE mi.media_type IN ('movie', 'tv')
					AND mi.has_files = true
					AND mi.status = 'active'
			),
			-- Qualifying watch sessions in the window, mapped UP to the owning
			-- movie/series id and COUNTED so an episode watch increments its series.
			title_session_counts AS (
				SELECT
					CASE
						WHEN mi.media_type = 'episode' THEN COALESCE(grandparent.id, parent.id, mi.id)
						WHEN mi.media_type = 'season' THEN COALESCE(parent.id, mi.id)
						ELSE mi.id
					END AS title_id,
					COUNT(*) AS watch_count
				FROM watch_history wh
				JOIN media_items mi ON mi.id = wh.media_id
				LEFT JOIN media_items parent ON parent.id = mi.parent_id
				LEFT JOIN media_items grandparent ON grandparent.id = parent.parent_id
				WHERE wh.actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
					AND wh.session_start_time >= NOW() - ${interval}::INTERVAL
					AND wh.media_id IS NOT NULL
				GROUP BY 1
			),
			-- Rank the candidates by watch_count FIRST and take only the limit. Size is
			-- display-only (never an ORDER BY key), so we resolve file sizes for just the
			-- final N titles in a LATERAL below instead of aggregating every file in the
			-- library. The previous version size-joined all candidates via an
			-- (OR ... OR subquery) predicate the planner couldn't index — O(candidates ×
			-- media_items), which timed out on real libraries (~1.3s -> ~65ms here).
			ranked AS (
				SELECT
					c.id,
					c.title,
					c.media_type,
					c.year,
					c.added_at,
					COALESCE(tsc.watch_count, 0) AS watch_count
				FROM candidates c
				LEFT JOIN title_session_counts tsc ON tsc.title_id = c.id
				ORDER BY COALESCE(tsc.watch_count, 0) ASC, c.added_at ASC NULLS FIRST, c.title ASC, c.id ASC
				LIMIT ${limit}
			)
			SELECT
				r.title,
				r.media_type,
				r.year,
				r.id AS internal_id,
				r.added_at,
				FLOOR(EXTRACT(EPOCH FROM (NOW() - r.added_at)) / 86400)::INTEGER AS age_days,
				COALESCE(sz.size_bytes, 0) AS size_bytes,
				r.watch_count
			FROM ranked r
			-- Size for the owning title: the movie/series row itself, its seasons, and its
			-- episodes (one index-driven UNION ALL branch each). Only runs for the final N.
			LEFT JOIN LATERAL (
				SELECT SUM(mf.file_size_bytes) AS size_bytes
				FROM media_file_items mfi
				JOIN media_files mf ON mf.id = mfi.file_id
				WHERE mfi.media_item_id IN (
					SELECT r.id
					UNION ALL
					SELECT s.id FROM media_items s
						WHERE r.media_type = 'tv' AND s.parent_id = r.id AND s.media_type = 'season'
					UNION ALL
					SELECT e.id FROM media_items e
						JOIN media_items s2 ON e.parent_id = s2.id
						WHERE r.media_type = 'tv' AND s2.parent_id = r.id AND e.media_type = 'episode'
				)
			) sz ON true
			ORDER BY r.watch_count ASC, r.added_at ASC NULLS FIRST, r.title ASC, r.id ASC
		`;

    return rows.map((r) => ({
        title: r.title,
        // `candidates` (above) filters `mi.media_type IN ('movie', 'tv')` —
        // this row can never be anything else.
        // eslint-disable-next-line callback-safety/no-inline-media-type-default -- admin stats queries are movie/TV-only.
        mediaType: toMovieOrSeries(r.media_type) ?? 'movie',
        year: r.year != null ? Number(r.year) : null,
        internalId: r.internal_id,
        posterUrl: `/api/image/catalog/${r.internal_id}/poster`,
        addedAt: r.added_at ? new Date(r.added_at).toISOString() : '',
        ageDays: Number(r.age_days) || 0,
        sizeBytes: Number(r.size_bytes ?? 0),
        watchCount: Number(r.watch_count) || 0,
        isSkyline: false,
    }));
}

/**
 * `cold-content` with `sort=skyline` — biggest space-wasters first.
 *
 * Reframes the least-watched list as "where do I reclaim the most disk for the
 * least-watched content". Unlike the default `cold` path (where size is a
 * display-only LATERAL over the final N), skyline RANKS by size, so size is
 * computed set-based for EVERY candidate via one grouped aggregation over
 * media_file_items mapped up to the owning movie/series.
 *
 * is_skyline marks titles on the Pareto frontier of (minimize watch_count,
 * maximize size_bytes): a title is on the frontier when no other title is both
 * watched no-more-often AND at least as large. Those are the unbeatable prune
 * picks.
 *
 * The frontier is computed EXACTLY in O(n log n) via a prefix-min window — not a
 * bounded self-join. Reduce each distinct size level to its least-watched member
 * (any title watched more than a same-size peer is dominated by that peer). A
 * size level is on the frontier iff its least watch_count is STRICTLY below the
 * least watch_count of every strictly-larger size level (else a bigger title
 * with no-more watches dominates it). The prefix-min over sizes DESC delivers
 * that, so — unlike a capped self-join — no frontier member can ever be dropped.
 *
 * Titles with zero on-disk bytes are excluded (nothing to reclaim). The final
 * list leads with skyline members (largest first), then the remaining titles by
 * size DESC as fill so "load more" keeps surfacing the next-biggest cold items.
 */
async function getColdContentSkyline(
    sql: postgres.Sql,
    interval: string,
    limit: number,
): Promise<ColdContentRow[]> {
    const rows = await sql<ColdContentDbRow[]>`
				WITH candidates AS (
					SELECT
						mi.id,
						mi.title,
						mi.media_type,
						mi.year,
						COALESCE(mi.library_added_at, mi.created_at) AS added_at
					FROM media_items mi
					WHERE mi.media_type IN ('movie', 'tv')
						AND mi.has_files = true
						AND mi.status = 'active'
				),
				title_session_counts AS (
					SELECT
						CASE
							WHEN mi.media_type = 'episode' THEN COALESCE(grandparent.id, parent.id, mi.id)
							WHEN mi.media_type = 'season' THEN COALESCE(parent.id, mi.id)
							ELSE mi.id
						END AS title_id,
						COUNT(*) AS watch_count
					FROM watch_history wh
					JOIN media_items mi ON mi.id = wh.media_id
					LEFT JOIN media_items parent ON parent.id = mi.parent_id
					LEFT JOIN media_items grandparent ON grandparent.id = parent.parent_id
					WHERE wh.actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
						AND wh.session_start_time >= NOW() - ${interval}::INTERVAL
						AND wh.media_id IS NOT NULL
					GROUP BY 1
				),
				-- Set-based size for every title that owns files: map each file's media_item
				-- UP to its owning movie/series and sum. Skyline ranks by size, so unlike the
				-- default path's per-row LATERAL we need a size for every candidate; one
				-- grouped aggregation is the cheapest way to get them all. (Sums per file-link
				-- like the default path, so a file shared across episodes is counted the same
				-- way in both modes — consistent with the size shown in 'cold' mode.)
				title_sizes AS (
					SELECT
						CASE
							WHEN mi.media_type = 'episode' THEN COALESCE(grandparent.id, parent.id, mi.id)
							WHEN mi.media_type = 'season' THEN COALESCE(parent.id, mi.id)
							ELSE mi.id
						END AS title_id,
						SUM(mf.file_size_bytes) AS size_bytes
					FROM media_file_items mfi
					JOIN media_files mf ON mf.id = mfi.file_id
					JOIN media_items mi ON mi.id = mfi.media_item_id
					LEFT JOIN media_items parent ON parent.id = mi.parent_id
					LEFT JOIN media_items grandparent ON grandparent.id = parent.parent_id
					GROUP BY 1
				),
				scored AS (
					SELECT
						c.id,
						c.title,
						c.media_type,
						c.year,
						c.added_at,
						COALESCE(tsc.watch_count, 0) AS watch_count,
						COALESCE(ts.size_bytes, 0) AS size_bytes
					FROM candidates c
					LEFT JOIN title_session_counts tsc ON tsc.title_id = c.id
					LEFT JOIN title_sizes ts ON ts.title_id = c.id
					-- Only titles that actually occupy disk: a 0-byte title reclaims nothing.
					WHERE COALESCE(ts.size_bytes, 0) > 0
				),
				-- Reduce each distinct size level to its least-watched member.
				size_groups AS (
					SELECT size_bytes, MIN(watch_count) AS grp_min_watch
					FROM scored
					GROUP BY size_bytes
				),
				-- A size level is on the frontier iff its least watch_count is strictly
				-- below the least watch_count of EVERY strictly-larger size level. The
				-- prefix-min over sizes DESC (frame excludes the current row) is that
				-- minimum; the largest size has an empty frame (NULL) and always qualifies.
				skyline_sizes AS (
					SELECT
						size_bytes,
						grp_min_watch,
						grp_min_watch < COALESCE(
							MIN(grp_min_watch) OVER (
								ORDER BY size_bytes DESC
								ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
							),
							grp_min_watch + 1
						) AS size_on_skyline
					FROM size_groups
				)
				SELECT
					s.title,
					s.media_type,
					s.year,
					s.id AS internal_id,
					s.added_at,
					FLOOR(EXTRACT(EPOCH FROM (NOW() - s.added_at)) / 86400)::INTEGER AS age_days,
					s.size_bytes,
					s.watch_count,
					-- On the frontier when this title's size level qualifies AND it is (one
					-- of) the least-watched title(s) at that exact size.
					(ss.size_on_skyline AND s.watch_count = ss.grp_min_watch) AS is_skyline
				FROM scored s
				JOIN skyline_sizes ss ON ss.size_bytes = s.size_bytes
				ORDER BY is_skyline DESC, s.size_bytes DESC, s.watch_count ASC,
					s.added_at ASC NULLS FIRST, s.title ASC, s.id ASC
				LIMIT ${limit}
			`;

    return rows.map((r) => ({
        title: r.title,
        // `candidates` (above) filters `mi.media_type IN ('movie', 'tv')` —
        // this row can never be anything else.
        // eslint-disable-next-line callback-safety/no-inline-media-type-default -- admin stats queries are movie/TV-only.
        mediaType: toMovieOrSeries(r.media_type) ?? 'movie',
        year: r.year != null ? Number(r.year) : null,
        internalId: r.internal_id,
        posterUrl: `/api/image/catalog/${r.internal_id}/poster`,
        addedAt: r.added_at ? new Date(r.added_at).toISOString() : '',
        ageDays: Number(r.age_days) || 0,
        sizeBytes: Number(r.size_bytes ?? 0),
        watchCount: Number(r.watch_count) || 0,
        isSkyline: r.is_skyline ?? false,
    }));
}

export interface CompletionLeaderboardRow {
    title: string;
    mediaType: 'movie' | 'series';
    year: number | null;
    internalId?: string;
    posterUrl?: string;
    /** Average completion_percentage across qualifying sessions (0–100). */
    avgCompletion: number;
    /** Number of qualifying sessions for the title. */
    sessions: number;
    /** Fraction (0–100) of sessions stopped under 20% completion. */
    abandonRate: number;
}

type CompletionDbRow = {
    title: string;
    media_type: 'movie' | 'tv';
    year: number | null;
    internal_id: string | null;
    avg_completion: string | null;
    sessions: string;
    abandon_rate: string | null;
};

/** Minimum qualifying sessions for a title to appear on the completion board. */
const COMPLETION_MIN_SESSIONS = 5;

/**
 * Minimum actual watch time (seconds) for a session to count toward the completion
 * board. Much higher than MIN_SESSION_SECONDS (60s): a quick peek into a title —
 * opening it to see what it is, then closing — is browsing, not an abandonment.
 * Requiring 10 minutes means a session only counts once the viewer genuinely
 * committed to the title. Measured on real data: movie sessions under ~10 min
 * average <4% completion (peeks), jumping to ~37% past that, so 10 min is the
 * natural cut.
 */
const COMPLETION_MIN_WATCH_SECONDS = 600;

/**
 * `completion-leaderboard` — surfaces the collected-but-unsurfaced
 * `watch_history.completion_percentage`.
 *
 * Per TITLE (movies direct; episodes resolved to their series via series_name,
 * matching getTopTVShows), over the timeframe. A session only counts toward the
 * board if it cleared COMPLETION_MIN_WATCH_SECONDS (10 min — excludes quick peeks)
 * AND has completion_percentage > 0 (excludes the "position never reported" 0%
 * sentinel). For qualifying sessions:
 *   - AVG(completion_percentage)
 *   - session count
 *   - abandon rate = % of sessions stopped under 20% completion
 *
 * The WORST average completion surfaces FIRST (flags bad encodes / wrong-runtime
 * metadata / disliked content). A title must have >= COMPLETION_MIN_SESSIONS
 * qualifying sessions so a single rage-quit cannot dominate the board.
 *
 * Movies resolve internalId via media_id; series resolve the 'tv' media_item by
 * normalized title (has_files DESC preferring real library rows) the same way
 * getTopTVShows does.
 */
export async function getCompletionLeaderboard(
    sql: postgres.Sql,
    timeframe: Timeframe = 'AllTime',
    limit = 10,
): Promise<CompletionLeaderboardRow[]> {
    const interval = getInterval(timeframe);

    const rows = await sql<CompletionDbRow[]>`
		WITH sessions AS (
			SELECT
				CASE
					WHEN wh.media_type = 'episode' THEN 'tv'
					ELSE 'movie'
				END AS group_type,
				CASE
					WHEN wh.media_type = 'episode' THEN LOWER(TRIM(wh.series_name))
					ELSE wh.media_id::text
				END AS group_key,
				wh.completion_percentage,
				wh.series_name,
				wh.media_id
			FROM watch_history wh
			WHERE wh.media_type IN ('movie', 'episode')
				-- 10-min floor: a quick peek is browsing, not an abandonment.
				AND wh.actual_watch_time_seconds >= ${COMPLETION_MIN_WATCH_SECONDS}
				AND wh.session_start_time >= NOW() - ${interval}::INTERVAL
				-- completion_percentage = 0 with real watch time is a "position never
				-- reported" sentinel (some clients/transcode paths), NOT a true 0%
				-- watch. On real data these 0.00 rows (one title had 210 sessions at
				-- 0% with up to 19h watched) flooded the board. Require > 0 so only
				-- sessions with genuine progress data count.
				AND wh.completion_percentage IS NOT NULL
				AND wh.completion_percentage > 0
				AND (
					wh.media_type = 'movie'
					OR (wh.series_name IS NOT NULL AND TRIM(wh.series_name) <> '')
				)
		),
		grouped AS (
			SELECT
				group_type,
				group_key,
				MAX(NULLIF(TRIM(series_name), '')) AS series_title,
				(ARRAY_AGG(media_id) FILTER (WHERE media_id IS NOT NULL))[1] AS sample_media_id,
				ROUND(AVG(completion_percentage), 1) AS avg_completion,
				COUNT(*) AS sessions,
				ROUND(
					100.0 * COUNT(*) FILTER (WHERE completion_percentage < 20) / COUNT(*),
					1
				) AS abandon_rate
			FROM sessions
			GROUP BY group_type, group_key
			HAVING COUNT(*) >= ${COMPLETION_MIN_SESSIONS}
		),
		movie_items AS (
			SELECT g.group_key, mi.id AS internal_id, mi.title, mi.year
			FROM grouped g
			JOIN media_items mi ON mi.id = g.sample_media_id
			WHERE g.group_type = 'movie'
		),
		series_items AS (
			SELECT DISTINCT ON (LOWER(TRIM(mi.title)))
				LOWER(TRIM(mi.title)) AS title_key, mi.id, mi.title, mi.year
			FROM media_items mi
			JOIN grouped g ON g.group_type = 'tv' AND LOWER(TRIM(mi.title)) = g.group_key
			WHERE mi.media_type = 'tv'
			ORDER BY LOWER(TRIM(mi.title)), mi.has_files DESC, mi.updated_at DESC, mi.id
		)
		SELECT
			COALESCE(
				CASE WHEN g.group_type = 'tv' THEN g.series_title ELSE mvi.title END,
				si.title,
				g.series_title,
				'Unknown'
			) AS title,
			g.group_type AS media_type,
			CASE WHEN g.group_type = 'tv' THEN si.year ELSE mvi.year END AS year,
			CASE WHEN g.group_type = 'tv' THEN si.id::text ELSE mvi.internal_id::text END AS internal_id,
			g.avg_completion,
			g.sessions,
			g.abandon_rate
		FROM grouped g
		LEFT JOIN movie_items mvi ON g.group_type = 'movie' AND mvi.group_key = g.group_key
		LEFT JOIN series_items si ON g.group_type = 'tv' AND si.title_key = g.group_key
		ORDER BY g.avg_completion ASC, g.sessions DESC
		LIMIT ${limit}
	`;

    return rows.map((r) => ({
        title: r.title,
        // `group_type` is constructed by a CASE expression restricted to the
        // literals 'tv'/'movie' (see the `sessions` CTE above) — this can
        // never be anything else.
        // eslint-disable-next-line callback-safety/no-inline-media-type-default -- admin stats queries are movie/TV-only.
        mediaType: toMovieOrSeries(r.media_type) ?? 'movie',
        year: r.year != null ? Number(r.year) : null,
        internalId: r.internal_id ?? undefined,
        posterUrl: r.internal_id ? `/api/image/catalog/${r.internal_id}/poster` : undefined,
        avgCompletion: r.avg_completion != null ? Number(r.avg_completion) : 0,
        sessions: Number(r.sessions),
        abandonRate: r.abandon_rate != null ? Number(r.abandon_rate) : 0,
    }));
}

export interface DormantUserRow {
    id: string;
    name: string;
    images?: ImageSet;
    /** ISO timestamp of the user's most recent qualifying session. */
    lastActive: string;
    /** Whole days since that session. */
    daysSinceActive: number;
    /** Lifetime qualifying-session count (all-time, not threshold-limited). */
    lifetimeSessions: number;
}

type DormantUserDbRow = {
    user_id: string;
    display_name: string | null;
    username: string | null;
    last_active: string;
    days_since_active: string;
    lifetime_sessions: string;
};

/** Days of inactivity before a user is considered dormant / at-risk. */
const DORMANT_THRESHOLD_DAYS = 30;

/**
 * `dormant-users` — churn / at-risk list (inverse of getActiveUsers).
 *
 * Lists users whose most-recent qualifying session is older than
 * DORMANT_THRESHOLD_DAYS (fixed 30d), oldest-first. De-PII'd via the same
 * LEFT JOIN users pattern as getTopUsers/mapTopUserRow; soft-deleted accounts
 * (users.deleted_at IS NOT NULL) are excluded. The avatar URL resolves by
 * USERNAME (the avatar endpoint keys on username, not UUID) — same as
 * mapTopUserRow.
 *
 * lifetimeSessions counts ALL qualifying sessions ever (no timeframe window) so
 * the operator sees how engaged the user was before going quiet.
 */
export async function getDormantUsers(sql: postgres.Sql, limit = 10): Promise<DormantUserRow[]> {
    // Parameterized interval (e.g. '30 days') — no sql.unsafe; the numeric
    // constant is interpolated into a fixed-format string, never user input.
    const threshold = `${DORMANT_THRESHOLD_DAYS} days`;
    const rows = await sql<DormantUserDbRow[]>`
		WITH user_stats AS (
			SELECT
				user_id,
				MAX(session_start_time) AS last_active,
				COUNT(*) AS lifetime_sessions
			FROM watch_history
			WHERE actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
			GROUP BY user_id
			HAVING MAX(session_start_time) < NOW() - ${threshold}::INTERVAL
		)
		SELECT
			us.user_id,
			u.display_name,
			u.username,
			us.last_active,
			FLOOR(EXTRACT(EPOCH FROM (NOW() - us.last_active)) / 86400)::INTEGER AS days_since_active,
			us.lifetime_sessions
		FROM user_stats us
		LEFT JOIN users u ON u.id = us.user_id
		WHERE u.deleted_at IS NULL
		ORDER BY us.last_active ASC
		LIMIT ${limit}
	`;

    return rows.map((r) => {
        const name = r.display_name ?? r.username ?? r.user_id;
        return {
            id: r.user_id,
            name,
            lastActive: r.last_active ? new Date(r.last_active).toISOString() : '',
            daysSinceActive: Number(r.days_since_active) || 0,
            lifetimeSessions: Number(r.lifetime_sessions),
        };
    });
}

export interface DeviceMixSegment {
    label: string;
    sessions: number;
    /** Summed actual watch time (seconds) for this segment — the time-weighted metric. */
    watchSeconds: number;
    /** Share of this dimension's total SESSION count (0–100). UI recomputes for hours. */
    percentage: number;
}

export interface DeviceMixStats {
    byClient: DeviceMixSegment[];
    byDevice: DeviceMixSegment[];
    byResolution: DeviceMixSegment[];
    byCodec: DeviceMixSegment[];
    totalSessions: number;
    /** Total qualifying watch time (seconds) in the window — denominator for hours mode. */
    totalWatchSeconds: number;
}

type DeviceMixDbRow = {
    dimension: 'client' | 'device' | 'resolution' | 'codec';
    label: string;
    sessions: string;
    seconds: string;
};

/**
 * `device-mix` — GROUP BY over watch_history's already-captured client / device /
 * resolution / codec columns, over the timeframe + MIN_SESSION_SECONDS floor.
 *
 * Returns four independent breakdowns the UI can chart, each a list of
 * {label, sessions, percentage}:
 *   - byClient     (client_name; NULL → 'Unknown')
 *   - byDevice     (device_name; NULL → 'Unknown')
 *   - byResolution (resolution_width bucketed SD/720p/1080p/4K; NULL → 'Unknown')
 *   - byCodec      (video_codec; NULL → 'Unknown')
 *
 * Percentages are computed per-dimension against that dimension's total sessions.
 */
export async function getDeviceMix(
    sql: postgres.Sql,
    timeframe: Timeframe = 'AllTime',
): Promise<DeviceMixStats> {
    const interval = getInterval(timeframe);

    const rows = await sql<DeviceMixDbRow[]>`
		WITH base AS (
			SELECT
				COALESCE(NULLIF(TRIM(client_name), ''), 'Unknown') AS client_label,
				COALESCE(NULLIF(TRIM(device_name), ''), 'Unknown') AS device_label,
				CASE
					WHEN resolution_width IS NULL THEN 'Unknown'
					WHEN resolution_width >= 3000 THEN '4K'
					WHEN resolution_width >= 1700 THEN '1080p'
					WHEN resolution_width >= 1100 THEN '720p'
					ELSE 'SD'
				END AS resolution_label,
				COALESCE(NULLIF(TRIM(video_codec), ''), 'Unknown') AS codec_label,
				COALESCE(actual_watch_time_seconds, 0) AS secs
			FROM watch_history
			WHERE actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
				AND session_start_time >= NOW() - ${interval}::INTERVAL
		)
		SELECT 'client' AS dimension, client_label AS label, COUNT(*) AS sessions, SUM(secs) AS seconds FROM base GROUP BY client_label
		UNION ALL
		SELECT 'device' AS dimension, device_label AS label, COUNT(*) AS sessions, SUM(secs) AS seconds FROM base GROUP BY device_label
		UNION ALL
		SELECT 'resolution' AS dimension, resolution_label AS label, COUNT(*) AS sessions, SUM(secs) AS seconds FROM base GROUP BY resolution_label
		UNION ALL
		SELECT 'codec' AS dimension, codec_label AS label, COUNT(*) AS sessions, SUM(secs) AS seconds FROM base GROUP BY codec_label
	`;

    type Seg = { label: string; sessions: number; watchSeconds: number };
    const byClient: Seg[] = [];
    const byDevice: Seg[] = [];
    const byResolution: Seg[] = [];
    const byCodec: Seg[] = [];

    for (const row of rows) {
        const entry: Seg = {
            label: row.label,
            sessions: Number(row.sessions),
            watchSeconds: Number(row.seconds) || 0,
        };
        switch (row.dimension) {
            case 'client':
                byClient.push(entry);
                break;
            case 'device':
                byDevice.push(entry);
                break;
            case 'resolution':
                byResolution.push(entry);
                break;
            case 'codec':
                byCodec.push(entry);
                break;
        }
    }

    const withPercentage = (segments: Seg[]): DeviceMixSegment[] => {
        const total = segments.reduce((sum, s) => sum + s.sessions, 0);
        return segments
            .map((s) => ({
                label: s.label,
                sessions: s.sessions,
                watchSeconds: s.watchSeconds,
                // Session-based share. The UI recomputes a time-based share from
                // watchSeconds when the Sessions⇄Hours toggle is set to Hours.
                percentage: total > 0 ? Math.round((s.sessions / total) * 100) : 0,
            }))
            .sort((a, b) => b.sessions - a.sessions);
    };

    // Each dimension sees the same row set, so any dimension's total equals the
    // overall qualifying-session count (and watch-seconds total).
    const totalSessions = byClient.reduce((sum, s) => sum + s.sessions, 0);
    const totalWatchSeconds = byClient.reduce((sum, s) => sum + s.watchSeconds, 0);

    return {
        byClient: withPercentage(byClient),
        byDevice: withPercentage(byDevice),
        byResolution: withPercentage(byResolution),
        byCodec: withPercentage(byCodec),
        totalSessions,
        totalWatchSeconds,
    };
}

export async function getSummary(sql: postgres.Sql): Promise<WatchSummary> {
    const rows = await sql<SummaryRow[]>`
		SELECT
			ROUND(COALESCE(SUM(actual_watch_time_seconds), 0) / 60.0)::INTEGER AS total_minutes,
			COUNT(*) AS total_sessions,
			COUNT(DISTINCT media_id) AS unique_items,
			COUNT(DISTINCT user_id) AS unique_users
		FROM watch_history
		WHERE actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
	`;
    const row = rows[0];
    const totalMinutes = Number(row?.total_minutes ?? 0);
    const hours = Math.floor(totalMinutes / 60);
    return {
        totalWatchTime: totalMinutes,
        totalWatchTimeFormatted:
            hours >= 1 ? `${hours} hours ${totalMinutes % 60} minutes` : `${totalMinutes} minutes`,
        totalSessions: Number(row?.total_sessions ?? 0),
        uniqueItems: Number(row?.unique_items ?? 0),
        // C6: expose the distinct-user count that was already computed but dropped.
        uniqueUsers: Number(row?.unique_users ?? 0),
        user: 'All Users',
    };
}

// ─── Surface mix ──────────────────────────────────────────────────────────────

/** One access surface's share of recent playback. */
export interface SurfaceMixSegment {
    /** Raw `play_sessions.surface` value; NULL rows collapse to 'unknown'. */
    surface: string;
    sessions: number;
    /** Share of `totalSessions` (0–100). */
    percentage: number;
}

export interface SurfaceMixStats {
    segments: SurfaceMixSegment[];
    /** Sessions against a `tvchannel` item, across all surfaces. */
    liveTvSessions: number;
    totalSessions: number;
    /** Sessions carrying a real surface — i.e. excluding 'unknown'. */
    attributedSessions: number;
    /** The trailing window, echoed so the UI can caption it truthfully. */
    windowDays: number;
}

/**
 * `surface-mix` — how playback reached this server, over a trailing window.
 *
 * ============================================================================
 * WHY THIS READS play_sessions AND NOT watch_history
 * ============================================================================
 * Every other card on the insights page reads `watch_history`, which would be
 * the obvious home for a fifth Device-Mix dimension. It cannot work here:
 * `watch_history` has exactly two writers (the lifecycle stop and the offline
 * flush), and Subsonic and Jellyfin-mirror sessions terminate through
 * `stopExternalSession`, which writes none. Sourcing this from `watch_history`
 * would render the `subsonic` and `jellyfin_mirror` buckets empty — asserting
 * the exact opposite of the truth about the surfaces this card exists to
 * measure.
 *
 * The cost of reading `play_sessions` instead is the window: terminal rows are
 * purged at PLAY_SESSION_RETENTION_DAYS, so this cannot answer "all time" and
 * the UI must say so. Pruning cannot skew the window itself — the prune
 * requires `stopped_at` older than the cutoff, which implies `started_at` is
 * older too, so it can never remove a row this query would have counted.
 *
 * ============================================================================
 * SESSIONS ONLY — NO WATCH-TIME METRIC
 * ============================================================================
 * Deliberately returns no seconds, unlike `getDeviceMix`. `play_sessions` has
 * no pause-aware accumulator: `position_ms` is the final position (wrong after
 * any resume or seek) and `stopped_at - started_at` is wall clock including
 * pause time — a tab left paused overnight would book ~10 phantom hours to
 * whichever surface owned it. There is no honest hours figure to return here,
 * so none is offered rather than one that would quietly contradict the Device
 * Mix card directly below it.
 */
export async function getSurfaceMix(
    sql: postgres.Sql,
    windowDays: number,
): Promise<SurfaceMixStats> {
    const rows = await sql<{ surface: string; sessions: string; live_tv: string }[]>`
        SELECT
            COALESCE(NULLIF(TRIM(surface), ''), 'unknown') AS surface,
            COUNT(*) AS sessions,
            COUNT(*) FILTER (
                WHERE EXISTS (
                    SELECT 1 FROM media_items mi
                    WHERE mi.id = ps.media_id
                      AND mi.media_type = 'tvchannel'
                )
            ) AS live_tv
        FROM play_sessions ps
        WHERE started_at >= NOW() - (${windowDays}::text || ' days')::interval
        GROUP BY 1
    `;

    const segments = rows.map((r) => ({
        surface: r.surface,
        sessions: Number(r.sessions),
    }));
    const totalSessions = segments.reduce((sum, s) => sum + s.sessions, 0);
    const liveTvSessions = rows.reduce((sum, r) => sum + Number(r.live_tv), 0);
    const attributedSessions = segments
        .filter((s) => s.surface !== 'unknown')
        .reduce((sum, s) => sum + s.sessions, 0);

    return {
        // Percentages are shares of ALL sessions in the window, 'unknown'
        // included. Excluding it would make the listed surfaces sum to 100%
        // and read as complete coverage, which is exactly the impression the
        // coverage caption exists to prevent while the column is still filling.
        segments: segments
            .map((s) => ({
                ...s,
                percentage: totalSessions > 0 ? (s.sessions / totalSessions) * 100 : 0,
            }))
            .sort((a, b) => b.sessions - a.sessions),
        liveTvSessions,
        totalSessions,
        attributedSessions,
        windowDays,
    };
}
