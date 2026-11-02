// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Personal Statistics Service
 *
 * Provides personalized viewing statistics for users.
 * All data comes from the PostgreSQL database (not Jellyfin API) for performance.
 */
import { getDb } from '../database/connection.js';
import type postgres from 'postgres';
import { GenreService } from './genre.service.js';
import { NOISE_KEYWORDS } from '../utils/keyword-stems.js';
import { detectFormFactor, parseUserAgent, type FormFactor } from '$lib/utils/user-agent.js';
import type { UserId } from '$lib/shared/user-id.js';
import type {
    OverviewStats,
    WatchTimeStats,
    WatchTimePeriod,
    PeakHoursStats,
    PeakHourCell,
    CompletionStats,
    CompletionBucket,
    AbandonedContent,
    GenreStats,
    GenreStat,
    KeywordStats,
    KeywordStat,
    DeviceStats,
    DeviceStat,
    QualityStats,
    RatingStats,
    RatingDistribution,
    TasteProfileStats,
    FunRecords,
    TopTitlesStats,
    TopTitleItem,
    SessionRecord,
    RewatchRecord,
    StatsPeriod,
    PersonalStatsType,
} from '$lib/types/personal-stats.js';
import { MINIMUM_DATA_REQUIREMENTS } from '$lib/types/personal-stats.js';
import { buildVersionedCacheKey, type UnifiedCache } from '$lib/server/cache';
import { Logger } from '../utils/logger.js';
import type { AllStatsMap } from '$lib/schemas/api-stats-responses';
import {
    deniesEverything,
    isUnrestricted,
} from '../database/queries/builders/media-access-boundary.js';
import type { MediaAccessBoundary } from '../database/queries/builders/media-access-boundary.js';

const logger = Logger.for('PersonalStats');

/** Return type for getAllStats() */
export interface AllStatsResult {
    period: StatsPeriod;
    insufficientData?: boolean;
    sessionCount: number;
    stats: Partial<AllStatsMap>;
}

// Minimum session duration in seconds to count (filters out accidental clicks)
const MIN_SESSION_SECONDS = 60;

/**
 * A session that reached this far into a title counts as having finished it
 * (end credits usually start before 100 %).
 */
const FINISHED_PERCENT = 90;

/**
 * Watch time a session can plausibly account for: its recorded time, capped at
 * the title's runtime when known.
 *
 * `actual_watch_time_seconds` is the wall clock from start to stop, so pauses
 * and a player left open count in full — prod had a 55-minute episode recorded
 * as 5 h 38 m with the playhead never moving, and 22 of one user's 360
 * sessions ran past their title's runtime (128 h recorded vs 111 h capped).
 * New rows are capped at write time (watch-history.service); this cap keeps
 * the rows recorded before that consistent. `alias` is a code-side constant.
 */
function effectiveSeconds(sql: postgres.Sql, alias?: string): postgres.Fragment {
    const p = alias ? `${alias}.` : '';
    return sql.unsafe(
        `LEAST(${p}actual_watch_time_seconds, COALESCE(NULLIF(${p}total_runtime_seconds, 0), ${p}actual_watch_time_seconds))`,
    );
}

/** SQL predicate: this session reached the end of its title. `alias` is a code-side constant. */
function finishedSession(sql: postgres.Sql, alias?: string): postgres.Fragment {
    const p = alias ? `${alias}.` : '';
    return sql.unsafe(
        `(${p}status = 'completed' OR ${p}completion_percentage >= ${FINISHED_PERCENT})`,
    );
}

/**
 * App display timezone for hour/day-of-week bucketing.
 *
 * `session_start_time` is `timestamptz` and prod Postgres runs in UTC, but the
 * audience is Europe/Berlin. Without an explicit `AT TIME ZONE`, all
 * hour/day-of-week derivations (peak hours, night-owl window, weekend score)
 * are skewed by the UTC offset. We bucket in this single fixed zone so every
 * call site agrees. Overridable via the standard `TZ` env var.
 *
 * The value is validated against the runtime's IANA database at module load — an
 * unrecognized `TZ` (typo / non-IANA value the OS tolerates) would otherwise make
 * Postgres throw `time zone "…" not recognized` at query time and 500 every
 * timezone-bucketed stat. On an invalid value we fall back to Europe/Berlin.
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

/**
 * Night-owl window: sessions starting in [0, 5) local hours, i.e. midnight to
 * just before 05:00. Defined once so both call sites (peak-hours + fun-records)
 * stay consistent. `< 5` was chosen over the old inclusive `BETWEEN 0 AND 4`.
 */
const NIGHT_OWL_END_HOUR_EXCLUSIVE = 5;

/**
 * Format seconds into human-readable string
 */
function formatDuration(seconds: number): string {
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours > 24) {
        const days = Math.floor(hours / 24);
        const remainingHours = hours % 24;
        return `${days}d ${remainingHours}h ${minutes}m`;
    }
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}

/**
 * Get SQL interval for period.
 *
 * For `year:YYYY` we return a sentinel that callers switch on — the service
 * injects a literal calendar-year WHERE clause instead of a NOW()-relative
 * interval. For all other values an INTERVAL string is returned.
 */
function getPeriodInterval(period: StatsPeriod): string {
    switch (period) {
        case '7d':
            return '7 days';
        case '30d':
            return '30 days';
        case '90d':
            return '90 days';
        case 'all':
            return '100 years'; // Effectively all time
        default:
            if (typeof period === 'string' && period.startsWith('year:')) {
                // year:YYYY — handled by callers that use yearBounds(); fall back
                // to all-time so plain interval callers don't error.
                return '100 years';
            }
            return '100 years';
    }
}

/**
 * Return [startDate, endDate) for a `year:YYYY` period, or null for relative periods.
 * The end bound is exclusive (first moment of the following year UTC midnight).
 * Both are Date objects so they can be passed directly as postgres.js parameters.
 */
function yearBounds(period: StatsPeriod): [Date, Date] | null {
    if (typeof period !== 'string' || !period.startsWith('year:')) return null;
    const yyyy = parseInt(period.slice(5), 10);
    if (!Number.isFinite(yyyy) || yyyy < 2000 || yyyy > 2099) return null;
    return [new Date(`${yyyy}-01-01T00:00:00Z`), new Date(`${yyyy + 1}-01-01T00:00:00Z`)];
}

/**
 * Build the `session_start_time` date-filter fragment for a given period.
 *
 * For `year:YYYY` this is a half-open range `[start, end)` anchored to the
 * calendar year in UTC (the session timestamps are timestamptz). For all
 * other periods it is a NOW()-relative INTERVAL clause identical to the
 * existing query pattern.
 *
 * Pass an optional `alias` (e.g. `'vs'`) when the column must be qualified in a
 * query that uses a table alias — e.g. `${periodFilter(sql, period, 'vs')}`.
 *
 * The fragment is embedded directly into postgres.js tagged queries via `${periodFilter(sql, period)}`.
 */
function periodFilter(sql: postgres.Sql, period: StatsPeriod, alias?: string): postgres.Fragment {
    const col = alias
        ? sql.unsafe(`${alias}.session_start_time`)
        : sql.unsafe('session_start_time');
    const bounds = yearBounds(period);
    if (bounds) {
        const [start, end] = bounds;
        return sql`${col} >= ${start} AND ${col} < ${end}`;
    }
    const interval = getPeriodInterval(period);
    return sql`${col} >= NOW() - ${interval}::INTERVAL`;
}

/**
 * A client name without its version ("Infuse-Direct 8.4.4" → "Infuse-Direct"),
 * so one app does not split into a row per release. 'Unknown' when absent.
 */
function normalizeClientName(raw: string | null | undefined): string {
    const name = (raw ?? '').trim();
    if (!name || name === 'Unknown') return 'Unknown';
    return name.replace(/\s+v?\d+(?:\.\d+)+\s*$/, '').trim() || name;
}

/**
 * A readable device name: a browser UA becomes "Chrome on macOS" (version
 * dropped so upgrades merge), a "Name/1.0" agent loses its version, and a name
 * that only repeats the client ("Lumastra-tvOS/1.0" under "Lumastra tvOS")
 * collapses to 'Unknown' so the UI shows the client alone.
 */
function normalizeDeviceName(raw: string | null | undefined, clientName: string): string {
    const name = (raw ?? '').trim();
    if (!name || name === 'Unknown') return 'Unknown';
    let label = /Mozilla\/|AppleWebKit\/|Gecko\//.test(name)
        ? parseUserAgent(name).replace(/^(.+?) \d+ on /, '$1 on ')
        : name.replace(/\/[\d.]+$/, '').trim();
    const squash = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (squash(label) === squash(clientName)) label = 'Unknown';
    return label || 'Unknown';
}

/**
 * Hour the "viewing day" starts at for the typical-viewing-window percentiles:
 * late-night sessions (00:00–05:59) belong to the evening before.
 */
const VIEWING_DAY_START_HOUR = 6;

/** Hours after the viewing-day start → "HH:MM" on the wall clock. */
function viewingDayHoursToClock(hoursAfterStart: string | number): string {
    const clockMinutes =
        Math.round((Number(hoursAfterStart) + VIEWING_DAY_START_HOUR) * 60) % (24 * 60);
    const hh = String(Math.floor(clockMinutes / 60)).padStart(2, '0');
    const mm = String(clockMinutes % 60).padStart(2, '0');
    return `${hh}:${mm}`;
}

/**
 * Day of week number to name
 */
function getDayName(dayOfWeek: number): string {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return days[dayOfWeek] || 'Unknown';
}

/**
 * Deterministic cache-key fingerprint for an access boundary. Two callers with
 * different denied library groups or age policies must never share a cached
 * completion/records entry. Empty string for an explicitly unrestricted caller
 * (`{library: all, age: any}`), so unrestricted users share one entry per
 * type+period — byte-identical to what the legacy `{null, null}` boundary
 * produced, which keeps warm cache entries valid across this migration.
 *
 * The `|`/`:` separators are reserved. Under the required-by-shape boundary the
 * variant kind now contributes a token as well, so the tokens must stay
 * collision-free with the value tokens: `denyAll` emits `d-none` / `a-none`,
 * which can never collide with `d-<uuid,...>` (library-group UUIDs) or
 * `a-<number>-<u|r>` (numeric age caps).
 *
 * MUST stay in lockstep with {@link hasAccessRestrictions} — see that function.
 */
export function accessFingerprint(access: MediaAccessBoundary): string {
    const parts: string[] = [];
    switch (access.library.kind) {
        case 'all':
            break;
        case 'denyGroups':
            parts.push(`d-${[...access.library.ids].sort().join(',')}`);
            break;
        case 'denyAll':
            parts.push('d-none');
            break;
    }
    switch (access.age.kind) {
        case 'any':
            break;
        case 'limit':
            parts.push(`a-${access.age.maxAgeRating}-${access.age.allowUnrated ? 'u' : 'r'}`);
            break;
        case 'denyAll':
            parts.push('a-none');
            break;
    }
    return parts.join('|');
}

/**
 * Whether an access boundary actually restricts anything. MUST stay in lockstep
 * with {@link accessFingerprint}: the title/series access filters run iff this is
 * true, and the fingerprint is non-empty iff this is true. If the two diverge, an
 * access-filtered result could be cached under the un-fingerprinted key (shared
 * across users for a type+period) — a cross-user leak. Both completion and
 * records gate on this identical condition.
 *
 * `denyAll` on EITHER axis must land on the `true` branch: were it to fall
 * through to "unrestricted", the filters would be skipped AND the result cached
 * under the empty fingerprint, so a deny-everything caller would be served the
 * unrestricted entry. `isUnrestricted` matches ONLY `{all, any}`, which is
 * exactly the required behaviour.
 */
function hasAccessRestrictions(access: MediaAccessBoundary): boolean {
    return !isUnrestricted(access);
}

class PersonalStatsService {
    private get sql() {
        return getDb();
    }

    private isAvailable(): boolean {
        return this.sql !== null;
    }

    /**
     * Get overview statistics for a user
     */
    async getOverviewStats(userId: UserId, period: StatsPeriod = 'all'): Promise<OverviewStats> {
        if (!this.isAvailable()) {
            throw new Error('Database not available');
        }

        // Titles, not sessions: a film resumed across three sittings is ONE
        // finished title. Counting sessions reported "219 abandoned" for a user
        // whose watch state marked most of those titles watched. A title counts
        // as finished when a session reached the end (FINISHED_PERCENT), the
        // recorder marked it completed, or user_media_state (the watch-state
        // source of truth) says watched — e.g. finished on another client.
        const result = await this.sql!`
			WITH scoped AS (
				SELECT id, media_id, media_type, status, completion_percentage, session_start_time,
					${effectiveSeconds(this.sql!)} AS watch_seconds
				FROM watch_history
				WHERE user_id = ${userId}
					AND actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
					AND ${periodFilter(this.sql!, period)}
			),
			per_title AS (
				SELECT media_id,
					MAX(media_type) AS media_type,
					MAX(COALESCE(completion_percentage, 0)) AS max_completion,
					BOOL_OR(${finishedSession(this.sql!)}) AS finished_in_session
				FROM scoped
				WHERE media_type != 'tvchannel' AND media_id IS NOT NULL
				GROUP BY media_id
			),
			titles AS (
				SELECT pt.media_type,
					pt.finished_in_session OR COALESCE(ums.is_watched, false) AS finished,
					pt.max_completion
				FROM per_title pt
				LEFT JOIN user_media_state ums ON ums.user_id = ${userId} AND ums.media_id = pt.media_id
			)
			SELECT
				(SELECT COUNT(*) FROM scoped) AS total_sessions,
				(SELECT COUNT(DISTINCT media_id) FROM scoped) AS unique_content,
				(SELECT COALESCE(SUM(watch_seconds), 0) FROM scoped)::BIGINT AS total_watch_seconds,
				(SELECT ROUND(COALESCE(AVG(CASE WHEN finished THEN 100 ELSE LEAST(max_completion, 100) END), 0)::NUMERIC, 1) FROM titles) AS avg_completion,
				(SELECT COUNT(*) FILTER (WHERE finished) FROM titles) AS completed_count,
				(SELECT COUNT(*) FILTER (WHERE NOT finished) FROM titles) AS abandoned_count,
				(SELECT COUNT(*) FILTER (WHERE media_type = 'movie') FROM titles) AS movies_watched,
				(SELECT COUNT(*) FILTER (WHERE media_type = 'episode') FROM titles) AS episodes_watched,
				(SELECT MIN(session_start_time) FROM scoped) AS first_watch,
				(SELECT MAX(session_start_time) FROM scoped) AS last_watch
		`;

        const row = result[0] || {};

        return {
            totalWatchTimeSeconds: Number(row.total_watch_seconds) || 0,
            totalWatchTimeFormatted: formatDuration(Number(row.total_watch_seconds) || 0),
            totalSessions: Number(row.total_sessions) || 0,
            uniqueContent: Number(row.unique_content) || 0,
            completedCount: Number(row.completed_count) || 0,
            abandonedCount: Number(row.abandoned_count) || 0,
            avgCompletionPercentage: Number(row.avg_completion) || 0,
            moviesWatched: Number(row.movies_watched) || 0,
            episodesWatched: Number(row.episodes_watched) || 0,
            firstWatchDate: row.first_watch ? new Date(row.first_watch).toISOString() : undefined,
            lastWatchDate: row.last_watch ? new Date(row.last_watch).toISOString() : undefined,
        };
    }

    /**
     * Get watch time trends by period
     */
    async getWatchTimeStats(userId: UserId, period: StatsPeriod = 'all'): Promise<WatchTimeStats> {
        if (!this.isAvailable()) {
            throw new Error('Database not available');
        }

        const bucketUnit: 'day' | 'week' = period === '7d' ? 'day' : 'week';
        // date_trunc takes the unit as a string LITERAL, so it is inlined — quoted:
        // an unquoted `week` is read as a column name ("column \"week\" does not
        // exist"), which failed this whole stat on every period and hid the
        // watch-time chart. Only 'day' or 'week' can ever be produced here.
        const truncUnit = this.sql!.unsafe(`'${bucketUnit}'`);

        // Bucket day/week boundaries in APP_TIMEZONE so a late-night session lands
        // in the local calendar bucket the user perceives, consistent with the
        // hour/DOW and streak/binge bucketing (B11).
        const result = await this.sql!`
			SELECT
				date_trunc(${truncUnit}, session_start_time AT TIME ZONE ${APP_TIMEZONE}) as period,
				COALESCE(SUM(${effectiveSeconds(this.sql!)}), 0)::INTEGER as watch_seconds,
				COUNT(*) as session_count
			FROM watch_history
			WHERE user_id = ${userId}
				AND actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
				AND ${periodFilter(this.sql!, period)}
			GROUP BY 1
			ORDER BY 1 DESC
			LIMIT 52
		`;

        // Non-empty buckets, newest-first.
        const nonEmpty = result.map((row) => ({
            startMs: new Date(row.period).getTime(),
            watchTimeSeconds: Number(row.watch_seconds) || 0,
            sessionCount: Number(row.session_count) || 0,
        }));

        // For `all` the bucketed SUM is capped at 52 buckets, so it under-reports
        // the true lifetime total. Compute that separately, unbounded (C4). For the
        // finite periods the 52-bucket cap can never truncate, so the bucket sum is
        // already complete.
        let totalWatchTimeSeconds = nonEmpty.reduce((sum, p) => sum + p.watchTimeSeconds, 0);
        if (period === 'all') {
            const totalRows = await this.sql!`
				SELECT COALESCE(SUM(${effectiveSeconds(this.sql!)}), 0)::BIGINT as total_seconds
				FROM watch_history
				WHERE user_id = ${userId}
					AND actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
			`;
            totalWatchTimeSeconds = Number(totalRows[0]?.total_seconds) || totalWatchTimeSeconds;
        }

        // Fill a contiguous CALENDAR series so empty buckets count toward the
        // average and the trend compares ADJACENT buckets (B7). Without this the
        // average divided by active-buckets-only and the trend compared the two
        // most-recent non-empty buckets (possibly weeks apart).
        const bucketMs = bucketUnit === 'day' ? 86_400_000 : 7 * 86_400_000;
        const byStart = new Map(nonEmpty.map((p) => [p.startMs, p]));
        const filled: WatchTimePeriod[] = [];
        if (nonEmpty.length > 0) {
            const newest = Math.max(...nonEmpty.map((p) => p.startMs));
            const oldest = Math.min(...nonEmpty.map((p) => p.startMs));
            // Walk every calendar bucket from newest down to oldest, padding gaps
            // with zero-activity buckets. Capped at 52 to match the query window.
            for (let i = 0; i < 52; i++) {
                const startMs = newest - i * bucketMs;
                if (startMs < oldest) break;
                const hit = byStart.get(startMs);
                filled.push({
                    period: new Date(startMs).toISOString(),
                    watchTimeSeconds: hit?.watchTimeSeconds ?? 0,
                    watchTimeFormatted: formatDuration(hit?.watchTimeSeconds ?? 0),
                    sessionCount: hit?.sessionCount ?? 0,
                });
            }
        }

        const avgPerPeriod =
            filled.length > 0
                ? Math.round(filled.reduce((s, p) => s + p.watchTimeSeconds, 0) / filled.length)
                : 0;

        // Trend: most-recent calendar bucket vs the one immediately before it.
        // `filled` is newest-first, so [0] is current and [1] is the adjacent prior bucket.
        let trend: 'up' | 'down' | 'stable' = 'stable';
        let trendPercentage = 0;
        if (filled.length >= 2) {
            const current = filled[0].watchTimeSeconds;
            const previous = filled[1].watchTimeSeconds;
            if (previous > 0) {
                trendPercentage = Math.round(((current - previous) / previous) * 100);
                // Clamp the displayed magnitude so a resume-from-zero can't emit
                // an unbounded +5900% that overflows the trend pill.
                trendPercentage = Math.max(-999, Math.min(999, trendPercentage));
                trend = trendPercentage > 5 ? 'up' : trendPercentage < -5 ? 'down' : 'stable';
            } else if (current > 0) {
                // Prior bucket was empty (a gap), now active again: that's an
                // up-trend, not "stable". % is undefined from a zero base, so 0.
                trend = 'up';
                trendPercentage = 0;
            }
        }

        return {
            periods: filled.reverse(), // Chronological order
            totalWatchTimeSeconds,
            avgPerPeriod,
            trend,
            trendPercentage,
        };
    }

    /**
     * Get peak hours heatmap data
     */
    async getPeakHoursStats(userId: UserId, period: StatsPeriod = 'all'): Promise<PeakHoursStats> {
        if (!this.isAvailable()) {
            throw new Error('Database not available');
        }

        // Single pass: heatmap cells + night owl + weekend warrior aggregations.
        // All hour/DOW derivations bucket in APP_TIMEZONE (B11) — session_start_time
        // is timestamptz stored in UTC; without AT TIME ZONE the buckets skew by the
        // local UTC offset.
        const result = await this.sql!`
			SELECT
				EXTRACT(DOW FROM session_start_time AT TIME ZONE ${APP_TIMEZONE})::INTEGER as day_of_week,
				EXTRACT(HOUR FROM session_start_time AT TIME ZONE ${APP_TIMEZONE})::INTEGER as hour,
				COUNT(*) as session_count,
				COALESCE(SUM(${effectiveSeconds(this.sql!)}), 0)::INTEGER as total_seconds,
				COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM session_start_time AT TIME ZONE ${APP_TIMEZONE}) < ${NIGHT_OWL_END_HOUR_EXCLUSIVE}) as night_sessions,
				COUNT(*) FILTER (WHERE EXTRACT(DOW FROM session_start_time AT TIME ZONE ${APP_TIMEZONE}) IN (0, 6)) as weekend_sessions
			FROM watch_history
			WHERE user_id = ${userId}
				AND actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
				AND ${periodFilter(this.sql!, period)}
			GROUP BY 1, 2
		`;

        // Derive totals from the grouped result set — one scan, no extra queries.
        let totalSessions = 0;
        let totalNightSessions = 0;
        let totalWeekendSessions = 0;
        for (const row of result) {
            totalSessions += Number(row.session_count);
            totalNightSessions += Number(row.night_sessions);
            totalWeekendSessions += Number(row.weekend_sessions);
        }

        // Find max for normalization
        const maxSessions = Math.max(...result.map((r) => Number(r.session_count)), 1);

        const cells: PeakHourCell[] = result.map((row) => ({
            dayOfWeek: Number(row.day_of_week),
            hour: Number(row.hour),
            sessionCount: Number(row.session_count) || 0,
            totalSeconds: Number(row.total_seconds) || 0,
            intensity: Number(row.session_count) / maxSessions,
        }));

        // Find peak day and hour
        let peakDay = 0;
        let peakHour = 0;
        let maxCount = 0;

        for (const cell of cells) {
            if (cell.sessionCount > maxCount) {
                maxCount = cell.sessionCount;
                peakDay = cell.dayOfWeek;
                peakHour = cell.hour;
            }
        }

        const nightOwlScore =
            totalSessions > 0 ? Math.round((totalNightSessions / totalSessions) * 100) : 0;

        const weekendWarriorScore =
            totalSessions > 0 ? Math.round((totalWeekendSessions / totalSessions) * 100) : 0;

        return {
            cells,
            peakDay: getDayName(peakDay),
            peakHour,
            nightOwlScore,
            weekendWarriorScore,
        };
    }

    /**
     * Get completion behavior stats
     */
    async getCompletionStats(
        userId: UserId,
        period: StatsPeriod,
        access: MediaAccessBoundary,
    ): Promise<CompletionStats> {
        if (!this.isAvailable()) {
            throw new Error('Database not available');
        }

        type CompletionBucketRow = {
            bucket: string;
            count: string | number;
        };

        type CompletionRateRow = {
            movie_rate: string | number | null;
            episode_rate: string | number | null;
            overall_rate: string | number | null;
            avg_drop_off: string | number | null;
        };

        type AbandonedRow = {
            media_id: string;
            title: string;
            series_name: string | null;
            media_type: string;
            season_number: number | null;
            episode_number: number | null;
            max_completion: string | number | null;
            times_started: string | number;
            times_completed: string | number;
            times_abandoned: string | number;
            abandon_rate: string | number;
            last_watched: Date | string | null;
        };

        // Buckets + rates share an identical WHERE and scan the same rows, so
        // compute them together in one CTE pass (P4). Abandoned content has a
        // different shape (per-media aggregation) and runs concurrently below.
        type CombinedRow = {
            bucket: string | null;
            bucket_count: string | number | null;
            movie_rate: string | number | null;
            episode_rate: string | number | null;
            overall_rate: string | number | null;
            avg_drop_off: string | number | null;
        };

        // Everything here is per TITLE, each title at the furthest point any
        // session reached — 100 when it was finished (see getOverviewStats). Per
        // session, a film watched in three sittings read as two abandonments at
        // 30 % and 60 %, and the "frequently abandoned" list was mostly titles
        // the watch state marks watched.
        const titlesCte = this.sql!`
			per_title AS (
				-- Title from the catalog: watch_history keeps whatever language
				-- the session recorded ("Identität" beside "Identity").
				SELECT wh.media_id,
					MAX(wh.media_type) AS media_type,
					COALESCE(MAX(mi.title), MAX(wh.title)) AS title,
					MAX(wh.series_name) AS series_name,
					MAX(wh.season_number) FILTER (WHERE wh.media_type = 'episode') AS season_number,
					MAX(wh.episode_number) FILTER (WHERE wh.media_type = 'episode') AS episode_number,
					MAX(COALESCE(wh.completion_percentage, 0)) AS max_completion,
					BOOL_OR(${finishedSession(this.sql!, 'wh')}) AS finished_in_session,
					COUNT(*) AS times_started,
					COUNT(*) FILTER (WHERE ${finishedSession(this.sql!, 'wh')}) AS times_completed,
					COUNT(*) FILTER (WHERE wh.status = 'abandoned') AS times_abandoned,
					MAX(wh.session_start_time) AS last_watched
				FROM watch_history wh
				LEFT JOIN media_items mi ON mi.id = wh.media_id
				WHERE wh.user_id = ${userId}
					AND wh.actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
					AND ${periodFilter(this.sql!, period, 'wh')}
					AND wh.media_type != 'tvchannel'
					AND wh.media_id IS NOT NULL
				GROUP BY wh.media_id
			),
			titles AS (
				SELECT pt.*,
					pt.finished_in_session OR COALESCE(ums.is_watched, false) AS finished,
					CASE WHEN pt.finished_in_session OR COALESCE(ums.is_watched, false)
						THEN 100 ELSE LEAST(pt.max_completion, 100) END AS progress
				FROM per_title pt
				LEFT JOIN user_media_state ums ON ums.user_id = ${userId} AND ums.media_id = pt.media_id
			)
		`;
        const [combinedResult, abandonedResult] = await Promise.all([
            this.sql!<CombinedRow[]>`
				WITH ${titlesCte},
				buckets AS (
					SELECT
						CASE
							WHEN progress < 10 THEN '0-10%'
							WHEN progress < 25 THEN '10-25%'
							WHEN progress < 50 THEN '25-50%'
							WHEN progress < 75 THEN '50-75%'
							WHEN progress < 90 THEN '75-90%'
							ELSE '90-100%'
						END as bucket,
						COUNT(*) as bucket_count
					FROM titles
					GROUP BY 1
				),
				rates AS (
					SELECT
						ROUND(AVG(progress) FILTER (WHERE media_type = 'movie')::NUMERIC, 1) as movie_rate,
						ROUND(AVG(progress) FILTER (WHERE media_type = 'episode')::NUMERIC, 1) as episode_rate,
						ROUND(AVG(progress)::NUMERIC, 1) as overall_rate,
						ROUND(AVG(progress) FILTER (WHERE NOT finished)::NUMERIC, 1) as avg_drop_off
					FROM titles
				)
				SELECT b.bucket, b.bucket_count,
					r.movie_rate, r.episode_rate, r.overall_rate, r.avg_drop_off
				FROM rates r
				LEFT JOIN buckets b ON TRUE
			`,
            // Frequently abandoned: started at least twice, never finished — not
            // in any session and not per the watch state.
            this.sql!<AbandonedRow[]>`
				WITH ${titlesCte}
				SELECT
					media_id,
					title,
					series_name,
					season_number,
					episode_number,
					media_type,
					max_completion,
					times_started,
					times_completed,
					times_abandoned,
					ROUND((times_abandoned::NUMERIC / NULLIF(times_started, 0)) * 100, 1) as abandon_rate,
					last_watched
				FROM titles
				WHERE times_started >= 2
					AND NOT finished
				ORDER BY times_started DESC, last_watched DESC
				LIMIT 10
			`,
        ]);

        // Rates appear on every joined row (LEFT JOIN buckets ON TRUE); read once.
        const ratesRow: CompletionRateRow = combinedResult[0]
            ? {
                  movie_rate: combinedResult[0].movie_rate,
                  episode_rate: combinedResult[0].episode_rate,
                  overall_rate: combinedResult[0].overall_rate,
                  avg_drop_off: combinedResult[0].avg_drop_off,
              }
            : {
                  movie_rate: null,
                  episode_rate: null,
                  overall_rate: null,
                  avg_drop_off: null,
              };

        const bucketRows: CompletionBucketRow[] = combinedResult
            .filter((r) => r.bucket !== null)
            .map((r) => ({ bucket: r.bucket as string, count: Number(r.bucket_count) || 0 }));

        const totalBucketCount = bucketRows.reduce((sum, r) => sum + Number(r.count), 0);
        // The joined rows come back in no particular order; list low → high.
        const BUCKET_ORDER = ['0-10%', '10-25%', '25-50%', '50-75%', '75-90%', '90-100%'];
        bucketRows.sort((a, b) => BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket));
        const buckets: CompletionBucket[] = bucketRows.map((row) => ({
            bucket: row.bucket,
            count: Number(row.count) || 0,
            percentage:
                totalBucketCount > 0 ? Math.round((Number(row.count) / totalBucketCount) * 100) : 0,
        }));

        // Filter abandoned content by current access policy if provided.
        // Watch history stores titles at recording time; access may have been
        // reduced since then (library removal, parental controls).
        let filteredAbandoned: AbandonedRow[] = abandonedResult;
        if (this.sql && hasAccessRestrictions(access)) {
            const { filterAccessibleMediaIds } = await import('../utils/media-access-batch.js');
            const allowedIds = await filterAccessibleMediaIds(
                this.sql,
                abandonedResult.map((r) => r.media_id),
                access,
            );
            filteredAbandoned = abandonedResult.filter((r) => allowedIds.has(r.media_id));
        }

        const abandonedContent: AbandonedContent[] = filteredAbandoned.map((row) => ({
            title: row.title,
            seriesName: row.series_name ?? undefined,
            seasonNumber: row.season_number ?? undefined,
            episodeNumber: row.episode_number ?? undefined,
            maxCompletion: row.max_completion != null ? Number(row.max_completion) : undefined,
            mediaType: row.media_type,
            timesStarted: Number(row.times_started) || 0,
            timesCompleted: Number(row.times_completed) || 0,
            timesAbandoned: Number(row.times_abandoned) || 0,
            abandonRate: Number(row.abandon_rate) || 0,
            // Omit (undefined) rather than emit an empty-string non-date (C2).
            lastWatched: row.last_watched ? new Date(row.last_watched).toISOString() : undefined,
        }));

        return {
            overallCompletionRate: Number(ratesRow.overall_rate) || 0,
            buckets,
            movieCompletionRate: Number(ratesRow.movie_rate) || 0,
            episodeCompletionRate: Number(ratesRow.episode_rate) || 0,
            abandonedContent,
            avgDropOffPoint: Number(ratesRow.avg_drop_off) || 0,
        };
    }

    /**
     * Get top genres by watch time
     */
    async getGenreStats(userId: UserId, period: StatsPeriod = 'all'): Promise<GenreStats> {
        if (!this.isAvailable()) {
            throw new Error('Database not available');
        }

        // Genres per watched title, weighted by watch time. Three things this
        // used to get wrong (prod: "Unknown 98 %", diversity 1 %):
        //  - provider_metadata stores genres either as bare TMDB ids ([18, 80])
        //    or as {id, name} objects; only the object form was read, so every
        //    bare id became genre 0 ("Unknown").
        //  - a title has one metadata row PER provider (tmdb + aggregated), so
        //    its time was counted once per provider — genre time exceeded total
        //    watch time. One row per title now (aggregated, else tmdb, else any).
        //  - episodes carry no genres of their own; they now take their series'.
        // A title's time is split evenly across its genres, so the shares add up
        // to 100 % instead of multi-genre titles counting several times over.
        const result = await this.sql!`
			WITH watched AS (
				SELECT vs.media_id, SUM(${effectiveSeconds(this.sql!, 'vs')}) AS watch_seconds
				FROM watch_history vs
				WHERE vs.user_id = ${userId}
					AND vs.actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
					AND ${periodFilter(this.sql!, period, 'vs')}
					AND vs.media_id IS NOT NULL
				GROUP BY vs.media_id
			),
			genre_source AS (
				SELECT w.media_id, w.watch_seconds,
					CASE
						WHEN mi.media_type = 'episode' THEN COALESCE(
							CASE WHEN gp.media_type = 'tv' THEN gp.id END,
							CASE WHEN p.media_type = 'tv' THEN p.id END,
							mi.id)
						ELSE mi.id
					END AS genre_media_id
				FROM watched w
				JOIN media_items mi ON mi.id = w.media_id
				LEFT JOIN media_items p ON p.id = mi.parent_id
				LEFT JOIN media_items gp ON gp.id = p.parent_id
			),
			meta AS (
				SELECT DISTINCT ON (pm.media_id) pm.media_id, pm.metadata->'genres' AS genres
				FROM provider_metadata pm
				WHERE pm.media_id IN (SELECT genre_media_id FROM genre_source)
					AND jsonb_typeof(pm.metadata->'genres') = 'array'
					AND jsonb_array_length(pm.metadata->'genres') > 0
				ORDER BY pm.media_id, (pm.provider = 'aggregated') DESC, (pm.provider = 'tmdb') DESC, pm.provider
			),
			item_genres AS (
				SELECT gs.media_id, gs.watch_seconds,
					CASE
						WHEN jsonb_typeof(g) = 'number' THEN (g #>> '{}')::INTEGER
						WHEN jsonb_typeof(g) = 'object' AND (g->>'id') ~ '^[0-9]+$' THEN (g->>'id')::INTEGER
					END AS genre_id
				FROM genre_source gs
				JOIN meta ON meta.media_id = gs.genre_media_id
				CROSS JOIN jsonb_array_elements(meta.genres) AS g
			),
			weighted AS (
				SELECT genre_id, media_id,
					watch_seconds::FLOAT / COUNT(*) OVER (PARTITION BY media_id) AS share_seconds
				FROM item_genres
				WHERE genre_id IS NOT NULL
			)
			SELECT genre_id,
				SUM(share_seconds) AS total_seconds,
				COUNT(DISTINCT media_id) AS content_count
			FROM weighted
			GROUP BY genre_id
			ORDER BY total_seconds DESC
		`;

        const totalSeconds = result.reduce((sum, r) => sum + Number(r.total_seconds), 0);

        const genres: GenreStat[] = result.slice(0, 15).map((row) => {
            const genreId = Number(row.genre_id);
            const seconds = Math.round(Number(row.total_seconds) || 0);
            return {
                genreId,
                genreName: GenreService.getGenreName(genreId),
                totalSeconds: seconds,
                totalFormatted: formatDuration(seconds),
                percentage: totalSeconds > 0 ? Math.round((seconds / totalSeconds) * 100) : 0,
                contentCount: Number(row.content_count) || 0,
            };
        });

        // Diversity = evenness of the watch-time split across genres (Pielou's J:
        // Shannon entropy / its maximum), 0 when everything is one genre, 100
        // when time is spread evenly over every genre watched.
        const shares = result
            .map((r) => Number(r.total_seconds) / (totalSeconds || 1))
            .filter((p) => p > 0);
        const entropy = shares.reduce((h, p) => h - p * Math.log(p), 0);
        const diversityScore =
            shares.length > 1 ? Math.round((entropy / Math.log(shares.length)) * 100) : 0;

        return {
            genres,
            topGenre: genres[0]?.genreName || 'Unknown',
            diversityScore: Math.min(100, diversityScore),
        };
    }

    /**
     * Get top MDB keywords from watched content
     */
    async getKeywordStats(userId: UserId, period: StatsPeriod = 'all'): Promise<KeywordStats> {
        if (!this.isAvailable()) {
            throw new Error('Database not available');
        }

        type KeywordRow = {
            keyword: string;
            count: string | number;
        };

        const result = await this.sql!<KeywordRow[]>`
			WITH watched_media AS (
				SELECT DISTINCT vs.media_id
				FROM watch_history vs
				WHERE vs.user_id = ${userId}
					AND vs.actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
					AND ${periodFilter(this.sql!, period, 'vs')}
					AND vs.media_id IS NOT NULL
			),
			media_keywords AS (
				SELECT wm.media_id, pm.metadata->'mdblist_keywords' as keywords
				FROM watched_media wm
				JOIN provider_metadata pm ON pm.media_id = wm.media_id
				WHERE pm.metadata->'mdblist_keywords' IS NOT NULL
					AND jsonb_array_length(pm.metadata->'mdblist_keywords') > 0
			)
			SELECT
				keyword::text,
				COUNT(*) as count
			FROM media_keywords mk
			CROSS JOIN jsonb_array_elements_text(mk.keywords) as keyword
			-- Release-format and catalogue tags (has-trailer, dvd, 4k-blu-ray,
			-- belongs-to-collection, …) sit on nearly every title and say nothing
			-- about taste; they filled the top of this list.
			WHERE NOT (lower(keyword) = ANY(${[...NOISE_KEYWORDS]}::text[]))
			GROUP BY keyword
			ORDER BY count DESC
			LIMIT 30
		`;

        const totalCount = result.reduce((sum, r) => sum + Number(r.count), 0);

        const keywords: KeywordStat[] = result.map((row) => ({
            keyword: row.keyword,
            count: Number(row.count) || 0,
            percentage: totalCount > 0 ? Math.round((Number(row.count) / totalCount) * 100) : 0,
        }));

        return {
            keywords,
            totalKeywordsTracked: keywords.length,
        };
    }

    /**
     * Get device breakdown stats
     */
    async getDeviceStats(userId: UserId, period: StatsPeriod = 'all'): Promise<DeviceStats> {
        if (!this.isAvailable()) {
            throw new Error('Database not available');
        }

        type DeviceRow = {
            client_name: string;
            device_name: string;
            session_count: string | number;
            total_seconds: string | number;
        };

        const result = await this.sql!<DeviceRow[]>`
			SELECT
				COALESCE(client_name, 'Unknown') as client_name,
				COALESCE(device_name, 'Unknown') as device_name,
				COUNT(*) as session_count,
				COALESCE(SUM(${effectiveSeconds(this.sql!)}), 0)::INTEGER as total_seconds
			FROM watch_history
			WHERE user_id = ${userId}
				AND actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
				AND ${periodFilter(this.sql!, period)}
			GROUP BY 1, 2
			ORDER BY total_seconds DESC
		`;

        // Merge rows that are the same device in practice. Raw names split one
        // browser into a row per version ("…Chrome/150.0." vs "…Chrome/149.0."),
        // one app into a row per release ("Infuse-Direct 8.4.4"), and showed
        // the full UA as the device name.
        const merged = new Map<
            string,
            {
                clientName: string;
                deviceName: string;
                formFactor: FormFactor;
                sessionCount: number;
                totalSeconds: number;
            }
        >();
        for (const row of result) {
            const clientName = normalizeClientName(row.client_name);
            const deviceName = normalizeDeviceName(row.device_name, clientName);
            const key = `${clientName}\u0000${deviceName}`;
            const entry = merged.get(key) ?? {
                clientName,
                deviceName,
                formFactor: detectFormFactor(row.device_name, row.client_name),
                sessionCount: 0,
                totalSeconds: 0,
            };
            entry.sessionCount += Number(row.session_count) || 0;
            entry.totalSeconds += Number(row.total_seconds) || 0;
            merged.set(key, entry);
        }
        const rows = [...merged.values()].sort((a, b) => b.totalSeconds - a.totalSeconds);
        const totalSeconds = rows.reduce((sum, r) => sum + r.totalSeconds, 0);

        const devices: DeviceStat[] = rows.map((row) => ({
            clientName: row.clientName,
            deviceName: row.deviceName,
            formFactor: row.formFactor,
            sessionCount: row.sessionCount,
            totalSeconds: row.totalSeconds,
            totalFormatted: formatDuration(row.totalSeconds),
            percentage: totalSeconds > 0 ? Math.round((row.totalSeconds / totalSeconds) * 100) : 0,
        }));

        return {
            devices,
            primaryDevice: devices[0]
                ? `${devices[0].clientName} (${devices[0].deviceName})`
                : 'Unknown',
            deviceCount: devices.length,
        };
    }

    /**
     * Get quality/transcoding stats
     */
    async getQualityStats(userId: UserId, period: StatsPeriod = 'all'): Promise<QualityStats> {
        if (!this.isAvailable()) {
            throw new Error('Database not available');
        }

        const result = await this.sql!`
			SELECT
				COUNT(*) as total_sessions,

				-- Resolution breakdown (resolution_height was dropped; width only)
				COUNT(*) FILTER (WHERE resolution_width >= 3840) as uhd_4k,
				COUNT(*) FILTER (WHERE resolution_width >= 1920 AND resolution_width < 3840) as hd_1080,
				COUNT(*) FILTER (WHERE resolution_width >= 1280 AND resolution_width < 1920) as hd_720,
				COUNT(*) FILTER (WHERE resolution_width < 1280) as sd,
				-- No recorded width (external players, older rows) is NOT SD; it
				-- used to be counted as SD (105 of one user's 142 "SD" sessions).
				COUNT(*) FILTER (WHERE resolution_width IS NULL) as unknown_res,

				-- Average bitrate
				ROUND(AVG(bitrate_bps / 1000.0)::NUMERIC, 0) as avg_bitrate_kbps
			FROM watch_history
			WHERE user_id = ${userId}
				AND actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
				AND ${periodFilter(this.sql!, period)}
		`;

        const row = result[0] || {};
        const totalSessions = Number(row.total_sessions) || 0;

        // play_method / transcode / video_range columns were dropped from
        // watch_history (migration 11.85.0), so transcode/direct-play/HDR figures
        // have NO backing data. Rather than fabricate "100% direct play / 0%
        // transcoded / 0 HDR" as if it were fact, omit those fields entirely so
        // the UI can hide the corresponding tiles. Only resolution + bitrate are
        // genuinely derivable.
        return {
            totalSessions,
            resolution: {
                uhd4k: Number(row.uhd_4k) || 0,
                hd1080: Number(row.hd_1080) || 0,
                hd720: Number(row.hd_720) || 0,
                sd: Number(row.sd) || 0,
                unknown: Number(row.unknown_res) || 0,
            },
            avgBitrateKbps: row.avg_bitrate_kbps ? Number(row.avg_bitrate_kbps) : undefined,
        };
    }

    /**
     * Get rating behavior stats
     */
    async getRatingStats(userId: UserId): Promise<RatingStats> {
        if (!this.isAvailable()) {
            throw new Error('Database not available');
        }

        // Distribution and overall stats are independent reads over the same
        // user_ratings rows — run them concurrently (P5). Movies and shows only:
        // this is a viewing page, and music-track ratings (prod: 195 of one
        // user's 391 ratings were tracks at 6–7) skewed every figure.
        const [distResult, statsResult] = await Promise.all([
            // Rating distribution (UUID-based table joined to media_items for authoritative media_type)
            this.sql!`
				SELECT
					ur.rating,
					COUNT(*) as count,
					COUNT(*) FILTER (WHERE mi.media_type = 'movie') as movie_count,
					COUNT(*) FILTER (WHERE mi.media_type = 'tv') as tv_count
				FROM user_ratings ur
				JOIN media_items mi ON mi.id = ur.media_id
				WHERE ur.user_id = ${userId}
					AND ur.skipped IS NOT TRUE
					AND mi.media_type IN ('movie', 'tv')
				GROUP BY ur.rating
				ORDER BY ur.rating
			`,
            // Overall stats (UUID-based table)
            this.sql!`
				SELECT
					COUNT(*) as total_ratings,
					ROUND(AVG(ur.rating)::NUMERIC, 2) as avg_rating,
					PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ur.rating) as median_rating,
					MIN(ur.created_at) as first_rating,
					MAX(ur.created_at) as last_rating
				FROM user_ratings ur
				JOIN media_items mi ON mi.id = ur.media_id
				WHERE ur.user_id = ${userId}
					AND ur.skipped IS NOT TRUE
					AND mi.media_type IN ('movie', 'tv')
			`,
        ]);

        const distribution: RatingDistribution[] = distResult.map((row) => ({
            rating: Number(row.rating),
            count: Number(row.count) || 0,
            movieCount: Number(row.movie_count) || 0,
            tvCount: Number(row.tv_count) || 0,
        }));

        const row = statsResult[0] || {};
        const totalRatings = Number(row.total_ratings) || 0;

        // Calculate rating frequency (ratings per month) using a 30.44-day month
        // (365.25/12) instead of a flat 30 days. When the rating span is shorter
        // than ~one month, the per-month figure would be a meaningless
        // extrapolation (e.g. 50 ratings in a day → "50/month"), so suppress it to
        // 0 rather than clamp the denominator to one month (B12).
        const DAYS_PER_MONTH = 30.44;
        let ratingFrequency = 0;
        if (row.first_rating && row.last_rating && totalRatings > 0) {
            const firstDate = new Date(row.first_rating);
            const lastDate = new Date(row.last_rating);
            const spanDays = (lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24);
            if (spanDays >= DAYS_PER_MONTH) {
                const monthsDiff = spanDays / DAYS_PER_MONTH;
                ratingFrequency = Math.round((totalRatings / monthsDiff) * 10) / 10;
            }
        }

        return {
            totalRatings,
            avgRating: Number(row.avg_rating) || 0,
            medianRating: Number(row.median_rating) || 0,
            distribution,
            firstRatingDate: row.first_rating
                ? new Date(row.first_rating).toISOString()
                : undefined,
            lastRatingDate: row.last_rating ? new Date(row.last_rating).toISOString() : undefined,
            ratingFrequency,
        };
    }

    /**
     * Get AI taste profile stats
     */
    async getTasteProfileStats(userId: UserId): Promise<TasteProfileStats> {
        if (!this.isAvailable()) {
            throw new Error('Database not available');
        }

        const result = await this.sql!`
			SELECT
				total_ratings,
				availability_preference,
				quality_weight,
				popularity_weight,
				recency_weight,
				last_activity,
				created_at
			FROM user_profiles
			WHERE user_id = ${userId}
		`;

        if (result.length === 0) {
            return {
                hasProfile: false,
                totalRatings: 0,
                availabilityPreference: 0.5,
                qualityWeight: 0.2,
                popularityWeight: 0.1,
                recencyWeight: 0.1,
                lastActivity: undefined,
                profileAge: 0,
                insights: ['Rate more content to build your taste profile'],
            };
        }

        const row = result[0];
        const createdAt = row.created_at ? new Date(row.created_at) : new Date();
        const profileAge = Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24));

        // Generate insights based on preferences
        const insights: string[] = [];
        const availPref = Number(row.availability_preference) || 0.5;
        const qualityWeight = Number(row.quality_weight) || 0.2;
        const popularityWeight = Number(row.popularity_weight) || 0.1;
        const recencyWeight = Number(row.recency_weight) || 0.1;

        if (availPref > 0.7) {
            insights.push('You prefer content already in the library');
        } else if (availPref < 0.3) {
            insights.push('You enjoy discovering new content to request');
        }

        if (qualityWeight > 0.3) {
            insights.push('Critic ratings influence your preferences');
        }

        if (popularityWeight > 0.2) {
            insights.push('You tend to follow popular trends');
        }

        if (recencyWeight > 0.2) {
            insights.push('You prefer newer releases');
        }

        if (insights.length === 0) {
            insights.push('Your taste is well-balanced across different factors');
        }

        return {
            hasProfile: true,
            totalRatings: Number(row.total_ratings) || 0,
            availabilityPreference: availPref,
            qualityWeight,
            popularityWeight,
            recencyWeight,
            lastActivity: row.last_activity ? new Date(row.last_activity).toISOString() : undefined,
            profileAge,
            insights,
        };
    }

    /**
     * Get fun records.
     *
     * Surfaced titles/series are filtered to what `access` says the caller may
     * currently see (B2). Watch history stores titles at record time; access may
     * have been reduced since (library removal, parental controls), so a record
     * could otherwise leak a now-restricted title by name. Movie rows carry
     * `media_id` and go through `filterAccessibleMediaIds`; series-name-only rows
     * (rewatch-series, binge) have no media_id and are checked at the series level
     * by matching title to catalog rows.
     *
     * The filters only run for a restricted boundary ({@link hasAccessRestrictions});
     * an explicitly unrestricted caller keeps the previous zero-cost path, and in
     * particular never reaches the fail-closed {@link filterAccessibleSeriesNames}.
     */
    async getFunRecords(
        userId: UserId,
        period: StatsPeriod,
        access: MediaAccessBoundary,
    ): Promise<FunRecords> {
        if (!this.isAvailable()) {
            throw new Error('Database not available');
        }

        type LongestSessionRow = {
            media_id: string | null;
            title: string;
            series_name: string | null;
            media_type: string;
            actual_watch_time_seconds: string | number;
            session_start_time: string | Date;
            client_name: string | null;
            device_name: string | null;
        };

        type RewatchRow = {
            media_id: string | null;
            title: string;
            series_name: string | null;
            times_started: string | number;
            times_completed: string | number;
            total_watch_time_seconds: string | number;
        };

        type BingeViewingRow = {
            binge_days: string | number;
            total_days: string | number;
        };
        type NightOwlRow = {
            night_sessions: string | number;
            total_sessions: string | number;
        };
        type ViewingWindowRow = {
            window_start: string | number | null;
            window_median: string | number | null;
            window_end: string | number | null;
        };
        type StreakRow = {
            longest_streak: string | number | null;
            current_streak: string | number | null;
        };

        // Independent reads — run concurrently (P2). Fallback rewatch queries
        // (only fired when a primary returns nothing) are issued after the batch.
        const [
            longestResult,
            rewatchMoviesPrimary,
            rewatchSeriesPrimary,
            nightOwlResult,
            bingeViewingResult,
            viewingWindowResult,
            streakResult,
        ] = await Promise.all([
            // Longest single session (project media_id for access filtering)
            this.sql!<LongestSessionRow[]>`
				SELECT
					wh.media_id,
					COALESCE(mi.title, wh.title) AS title,
					wh.series_name,
					wh.media_type,
					${effectiveSeconds(this.sql!, 'wh')} AS actual_watch_time_seconds,
					wh.session_start_time,
					wh.client_name,
					wh.device_name
				FROM watch_history wh
				LEFT JOIN media_items mi ON mi.id = wh.media_id
				WHERE wh.user_id = ${userId}
					AND wh.actual_watch_time_seconds > 0
					-- A session that never moved the playhead is a player left
					-- open, not a sitting (prod: a 55-min episode "watched" for
					-- 5 h 38 m at 0 %).
					AND wh.completion_percentage >= 10
					AND ${periodFilter(this.sql!, period, 'wh')}
				ORDER BY ${effectiveSeconds(this.sql!, 'wh')} DESC
				LIMIT 1
			`,
            // Most rewatched movies — finished (a session reached the end) at
            // least twice. ">= 50 %" used to count as finished, so one film
            // watched in two halves read as a rewatch. The title comes from the
            // catalog: watch_history keeps the title in whatever language the
            // session recorded ("Milo Farrow und der Gefangene von Starhaven"
            // beside "…Keeper of Starhaven" in Top Titles).
            this.sql!<RewatchRow[]>`
				SELECT
					wh.media_id,
					COALESCE(MAX(mi.title), MAX(wh.title)) as title,
					NULL as series_name,
					COUNT(*) as times_started,
					COUNT(*) FILTER (WHERE ${finishedSession(this.sql!, 'wh')}) as times_completed,
					SUM(${effectiveSeconds(this.sql!, 'wh')}) as total_watch_time_seconds
				FROM watch_history wh
				LEFT JOIN media_items mi ON mi.id = wh.media_id
				WHERE wh.user_id = ${userId}
					AND wh.media_type = 'movie'
					AND wh.actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
					AND ${periodFilter(this.sql!, period, 'wh')}
				GROUP BY wh.media_id
				HAVING COUNT(*) FILTER (WHERE ${finishedSession(this.sql!, 'wh')}) >= 2
				ORDER BY COUNT(*) FILTER (WHERE ${finishedSession(this.sql!, 'wh')}) DESC
				LIMIT 5
			`,
            // Most rewatched series — episodes finished more than once. This used
            // to count every finished episode, which made it a second "most
            // watched shows" list (Drifting Clouds "60 episodes"), not rewatches.
            // times_started = distinct episodes watched, times_completed =
            // episodes finished at least twice.
            this.sql!<RewatchRow[]>`
				WITH per_episode AS (
					SELECT series_name, media_id,
						COUNT(*) FILTER (WHERE ${finishedSession(this.sql!)}) AS finishes,
						SUM(${effectiveSeconds(this.sql!)}) AS seconds
					FROM watch_history
					WHERE user_id = ${userId}
						AND media_type = 'episode'
						AND series_name IS NOT NULL
						AND actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
						AND ${periodFilter(this.sql!, period)}
					GROUP BY series_name, media_id
				)
				SELECT
					NULL as media_id,
					series_name,
					series_name as title,
					COUNT(*) as times_started,
					COUNT(*) FILTER (WHERE finishes >= 2) as times_completed,
					SUM(seconds) as total_watch_time_seconds
				FROM per_episode
				GROUP BY series_name
				HAVING COUNT(*) FILTER (WHERE finishes >= 2) >= 1
				ORDER BY COUNT(*) FILTER (WHERE finishes >= 2) DESC, SUM(seconds) DESC
				LIMIT 5
			`,
            // Night-owl score: sessions in [0,5) local hours (B11 — TZ + window).
            this.sql!<NightOwlRow[]>`
				SELECT
					COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM session_start_time AT TIME ZONE ${APP_TIMEZONE}) < ${NIGHT_OWL_END_HOUR_EXCLUSIVE}) as night_sessions,
					COUNT(*) as total_sessions
				FROM watch_history
				WHERE user_id = ${userId}
					AND actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
					AND ${periodFilter(this.sql!, period)}
			`,
            // Binge days + total viewing days in ONE pass over the same filtered
            // rows so the score's numerator and denominator share a row set (B9).
            // daily_series now applies the MIN_SESSION_SECONDS floor too.
            this.sql!<BingeViewingRow[]>`
				WITH scoped AS (
					SELECT
						date_trunc('day', session_start_time AT TIME ZONE ${APP_TIMEZONE}) as day,
						series_name,
						${effectiveSeconds(this.sql!)} as watch_seconds
					FROM watch_history
					WHERE user_id = ${userId}
						AND actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
						AND ${periodFilter(this.sql!, period)}
				),
				daily_series AS (
					SELECT day, series_name, SUM(watch_seconds) as daily_seconds
					FROM scoped
					WHERE series_name IS NOT NULL
					GROUP BY 1, 2
					HAVING SUM(watch_seconds) >= 10800
				)
				SELECT
					(SELECT COUNT(*) FROM daily_series) as binge_days,
					(SELECT COUNT(DISTINCT day) FROM scoped) as total_days
			`,
            // Typical viewing window — p10/median/p90 of the start time of day.
            // The day is measured from VIEWING_DAY_START_HOUR, not midnight: a
            // clock day splits a night's viewing in two, so sessions at 00:30
            // sorted as the earliest of the day and dragged p10 to "02:43" for a
            // user who watches in the evening (window "02:43 – 22:51"). The
            // percentiles come back as hours after the viewing-day start.
            this.sql!<ViewingWindowRow[]>`
					WITH hods AS (
						SELECT MOD(
							EXTRACT(HOUR FROM session_start_time AT TIME ZONE ${APP_TIMEZONE})
								+ EXTRACT(MINUTE FROM session_start_time AT TIME ZONE ${APP_TIMEZONE}) / 60.0
								+ ${24 - VIEWING_DAY_START_HOUR},
							24) AS hod
						FROM watch_history
						WHERE user_id = ${userId}
							AND actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
							AND ${periodFilter(this.sql!, period)}
					)
					SELECT
						percentile_cont(0.1) WITHIN GROUP (ORDER BY hod) AS window_start,
						percentile_cont(0.5) WITHIN GROUP (ORDER BY hod) AS window_median,
						percentile_cont(0.9) WITHIN GROUP (ORDER BY hod) AS window_end
					FROM hods
				`,
            // Watching streak (all-time by design — a streak spans the full history)
            this.sql!<StreakRow[]>`
				WITH watch_days AS (
					SELECT DISTINCT date_trunc('day', session_start_time AT TIME ZONE ${APP_TIMEZONE})::DATE as watch_date
					FROM watch_history
					WHERE user_id = ${userId}
						AND actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
					ORDER BY watch_date DESC
				),
				streak_groups AS (
					SELECT
						watch_date,
						watch_date - (ROW_NUMBER() OVER (ORDER BY watch_date))::INTEGER as streak_group
					FROM watch_days
				),
				streaks AS (
					SELECT COUNT(*) as streak_length, MAX(watch_date) as streak_end
					FROM streak_groups
					GROUP BY streak_group
				)
				SELECT
					MAX(streak_length) as longest_streak,
					(SELECT streak_length FROM streaks WHERE streak_end = (SELECT MAX(watch_date) FROM watch_days)) as current_streak
				FROM streaks
			`,
        ]);

        // No "started twice" fallback: a film opened twice is not a rewatch, and
        // the section simply stays empty until something really was rewatched.
        const rewatchMoviesResult = rewatchMoviesPrimary;
        const rewatchSeriesResult = rewatchSeriesPrimary;

        // --- Access filtering (B2) -------------------------------------------
        // Movie rows + longest-session carry media_id → batch access filter.
        // Series rows carry only a title → series-level title match.
        //
        // `denyAll` needs an extra gate. The per-row checks below deliberately
        // ALLOW a row whose media_id / series_name is null (nothing to resolve
        // against the catalog, so nothing to restrict) — correct for a
        // denyGroups/age-limited caller, but it would let a deny-everything
        // caller keep an id-less record. Nothing today maps to denyAll, so this
        // changes no existing caller's rows; it just makes the state reachable
        // without a hole.
        const denyEverything = deniesEverything(access);
        let allowedMovieIds: Set<string> | null = null;
        let allowedSeriesNames: Set<string> | null = null;
        if (this.sql && hasAccessRestrictions(access)) {
            const { filterAccessibleMediaIds } = await import('../utils/media-access-batch.js');

            const movieIds = rewatchMoviesResult
                .map((r) => r.media_id)
                .filter((id): id is string => !!id);
            const longestId = longestResult[0]?.media_id ?? null;
            const allIds = [...movieIds, ...(longestId ? [longestId] : [])];
            allowedMovieIds =
                allIds.length > 0
                    ? await filterAccessibleMediaIds(this.sql, allIds, access)
                    : new Set<string>();

            // Series-level check: keep a series only if it is NOT a catalog-tracked
            // restricted item — i.e. either it has no matching catalog row at all
            // (nothing to restrict), or at least one matching row is accessible.
            const seriesNames = rewatchSeriesResult
                .map((r) => r.series_name)
                .filter((n): n is string => !!n);
            if (seriesNames.length > 0) {
                allowedSeriesNames = await this.filterAccessibleSeriesNames(seriesNames, access);
            } else {
                allowedSeriesNames = new Set<string>();
            }
        }

        const longestRow = longestResult[0];
        const longestAllowed =
            !denyEverything &&
            (!allowedMovieIds || !longestRow?.media_id || allowedMovieIds.has(longestRow.media_id));
        const longestSession: SessionRecord | undefined =
            longestRow && longestAllowed
                ? {
                      title: longestRow.title,
                      seriesName: longestRow.series_name ?? undefined,
                      mediaType: longestRow.media_type,
                      durationSeconds: Number(longestRow.actual_watch_time_seconds) || 0,
                      durationFormatted: formatDuration(
                          Number(longestRow.actual_watch_time_seconds) || 0,
                      ),
                      date: new Date(longestRow.session_start_time).toISOString(),
                      clientName: longestRow.client_name ?? undefined,
                      deviceName: longestRow.device_name ?? undefined,
                  }
                : undefined;

        const mostRewatchedMovies: RewatchRecord[] = rewatchMoviesResult
            .filter(
                (row) =>
                    !denyEverything &&
                    (!allowedMovieIds || !row.media_id || allowedMovieIds.has(row.media_id)),
            )
            .map((row) => ({
                title: row.title,
                seriesName: row.series_name ?? undefined,
                timesStarted: Number(row.times_started) || 0,
                timesCompleted: Number(row.times_completed) || 0,
                totalWatchTimeFormatted: formatDuration(Number(row.total_watch_time_seconds) || 0),
                // watch_history.media_id IS media_items.id for movies → poster directly.
                internalId: row.media_id ?? undefined,
                posterUrl: row.media_id ? `/api/image/catalog/${row.media_id}/poster` : undefined,
            }));

        // Series rows carry only a name (media_id is NULL), so resolve each surviving
        // series name to its tv/series catalog UUID for the poster (preferring real
        // library rows). Done once, after the access filter, over the names we'll keep.
        const survivingSeriesNames = rewatchSeriesResult
            .filter(
                (row) =>
                    !denyEverything &&
                    (!allowedSeriesNames ||
                        !row.series_name ||
                        allowedSeriesNames.has(row.series_name)),
            )
            .map((r) => r.series_name)
            .filter((n): n is string => !!n);
        const seriesPosterIds = await this.resolveSeriesPosterIds(survivingSeriesNames);

        const mostRewatchedSeries: RewatchRecord[] = rewatchSeriesResult
            .filter(
                (row) =>
                    !denyEverything &&
                    (!allowedSeriesNames ||
                        !row.series_name ||
                        allowedSeriesNames.has(row.series_name)),
            )
            .map((row) => {
                const internalId = row.series_name
                    ? seriesPosterIds.get(row.series_name)
                    : undefined;
                return {
                    // title carries the series name; keep seriesName undefined to avoid
                    // the redundant title === seriesName duplication (C8).
                    title: row.title,
                    seriesName: undefined,
                    timesStarted: Number(row.times_started) || 0,
                    timesCompleted: Number(row.times_completed) || 0,
                    totalWatchTimeFormatted: formatDuration(
                        Number(row.total_watch_time_seconds) || 0,
                    ),
                    internalId,
                    posterUrl: internalId ? `/api/image/catalog/${internalId}/poster` : undefined,
                };
            });

        const nightOwlScore =
            Number(nightOwlResult[0]?.total_sessions) > 0
                ? Math.round(
                      (Number(nightOwlResult[0].night_sessions) /
                          Number(nightOwlResult[0].total_sessions)) *
                          100,
                  )
                : 0;

        const totalBingeDays = Number(bingeViewingResult[0]?.binge_days) || 0;
        const totalViewingDays = Number(bingeViewingResult[0]?.total_days) || 1;
        // Clamp to [0,100]; numerator/denominator now share a row set so this is a
        // belt-and-braces guard against a degenerate denominator (B9).
        const bingeScore = Math.min(100, Math.round((totalBingeDays / totalViewingDays) * 100));

        return {
            longestSession,
            mostRewatchedMovies,
            mostRewatchedSeries,
            nightOwlScore,
            bingeScore,
            totalBingeDays,
            typicalViewingWindow:
                viewingWindowResult[0]?.window_start != null &&
                viewingWindowResult[0]?.window_end != null
                    ? {
                          start: viewingDayHoursToClock(viewingWindowResult[0].window_start),
                          end: viewingDayHoursToClock(viewingWindowResult[0].window_end),
                          median: viewingDayHoursToClock(
                              viewingWindowResult[0].window_median ??
                                  viewingWindowResult[0].window_start,
                          ),
                      }
                    : undefined,
            longestStreak: Number(streakResult[0]?.longest_streak) || 0,
            currentStreak: Number(streakResult[0]?.current_streak) || 0,
        };
    }

    /**
     * Top Titles — the user's most-watched movies and shows, with poster art.
     *
     * Movies join watch_history.media_id -> media_items directly. Shows aggregate
     * episode sessions by series_name (the established admin pattern) and resolve
     * the series media_items row by title. Both surface concrete titles, so they
     * are access-filtered: resolved media_ids through filterAccessibleMediaIds,
     * and series names with no resolvable id through filterAccessibleSeriesNames —
     * both only when the caller is actually restricted ({@link hasAccessRestrictions}).
     */
    async getTopTitles(
        userId: UserId,
        period: StatsPeriod,
        access: MediaAccessBoundary,
    ): Promise<TopTitlesStats> {
        if (!this.isAvailable()) {
            throw new Error('Database not available');
        }
        type MovieRow = {
            internal_id: string;
            title: string;
            year: number | null;
            watch_count: string | number;
            finished_count: string | number;
            total_seconds: string | number;
        };
        type ShowRow = {
            title: string;
            internal_id: string;
            year: number | null;
            watch_count: string | number;
            episodes_watched: string | number;
            total_seconds: string | number;
            episode_count: string | number;
        };

        const [movieRows, showRows] = await Promise.all([
            this.sql!<MovieRow[]>`
				WITH user_movie_stats AS (
					SELECT wh.media_id,
						COUNT(*) AS watch_count,
						COUNT(*) FILTER (WHERE ${finishedSession(this.sql!, 'wh')}) AS finished_count,
						SUM(${effectiveSeconds(this.sql!, 'wh')}) AS total_seconds
					FROM watch_history wh
					WHERE wh.user_id = ${userId}
						AND wh.media_type = 'movie'
						AND wh.actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
						AND ${periodFilter(this.sql!, period, 'wh')}
					GROUP BY wh.media_id
				)
				-- Ranked by time spent: session count rewarded a film opened and
				-- resumed many times over one watched straight through.
				SELECT mi.id::text AS internal_id, mi.title, mi.year,
					ums.watch_count, ums.finished_count, ums.total_seconds
				FROM user_movie_stats ums
				JOIN media_items mi ON mi.id = ums.media_id
				ORDER BY ums.total_seconds DESC, ums.watch_count DESC
				LIMIT 10
			`,
            // Resolve the real series via the media hierarchy (episode -> season
            // -> series) rather than the denormalized series_name string, so this
            // always gets the true series title + UUID (for the poster) and never
            // surfaces a season title, independent of series_name backfills.
            this.sql!<ShowRow[]>`
				WITH watched AS (
					SELECT series.id AS series_id, series.title, series.year,
						COUNT(*) AS watch_count,
						COUNT(DISTINCT wh.media_id) AS episodes_watched,
						SUM(${effectiveSeconds(this.sql!, 'wh')}) AS total_seconds
					FROM watch_history wh
					JOIN media_items ep ON ep.id = wh.media_id AND ep.media_type = 'episode'
					JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
					JOIN media_items series ON series.id = season.parent_id AND series.media_type = 'tv'
					WHERE wh.user_id = ${userId}
						AND wh.media_type = 'episode'
						AND wh.actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
						AND ${periodFilter(this.sql!, period, 'wh')}
					GROUP BY series.id, series.title, series.year
				),
				episode_totals AS (
					SELECT season.parent_id AS series_id, COUNT(*) AS episode_count
					FROM media_items ep
					JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
					WHERE ep.media_type = 'episode'
						AND ep.has_files = true
						AND season.parent_id IN (SELECT series_id FROM watched)
					GROUP BY season.parent_id
				)
				-- Ranked by time spent. The old sessions-per-library-episode ratio
				-- ranked a 2-episode sample of a big show below a short one and
				-- surfaced as a baffling "1.6× watched".
				SELECT w.series_id::text AS internal_id, w.title, w.year,
					w.watch_count, w.episodes_watched, w.total_seconds,
					COALESCE(et.episode_count, 0) AS episode_count
				FROM watched w
				LEFT JOIN episode_totals et ON et.series_id = w.series_id
				ORDER BY w.total_seconds DESC
				LIMIT 10
			`,
        ]);

        // Access-filter surfaced titles (only when the caller is restricted).
        // Both movies and shows resolve to a concrete media_items UUID, so a
        // single filterAccessibleMediaIds pass covers both — no series-name
        // fallback needed (the hierarchy join already gave real series ids).
        let allowedMovieIds: Set<string> | null = null;
        let allowedShowIds: Set<string> | null = null;
        // Every row here carries a concrete media_items UUID, so a denyAll
        // boundary needs no extra gate: filterAccessibleMediaIds returns the
        // empty set and both filters below drop everything.
        if (this.sql && hasAccessRestrictions(access)) {
            const { filterAccessibleMediaIds } = await import('../utils/media-access-batch.js');
            const [mIds, sIds] = await Promise.all([
                filterAccessibleMediaIds(
                    this.sql,
                    movieRows.map((r) => r.internal_id),
                    access,
                ),
                filterAccessibleMediaIds(
                    this.sql,
                    showRows.map((r) => r.internal_id),
                    access,
                ),
            ]);
            allowedMovieIds = mIds;
            allowedShowIds = sIds;
        }

        const toMovie = (r: MovieRow): TopTitleItem => ({
            title: r.title,
            mediaType: 'movie',
            year: r.year ?? undefined,
            internalId: r.internal_id,
            posterUrl: `/api/image/catalog/${r.internal_id}/poster`,
            watchCount: Number(r.watch_count) || 0,
            finishedCount: Number(r.finished_count) || 0,
            totalWatchSeconds: Number(r.total_seconds) || 0,
        });
        const toShow = (r: ShowRow): TopTitleItem => ({
            title: r.title,
            mediaType: 'series',
            year: r.year ?? undefined,
            internalId: r.internal_id,
            posterUrl: `/api/image/catalog/${r.internal_id}/poster`,
            watchCount: Number(r.watch_count) || 0,
            totalWatchSeconds: Number(r.total_seconds) || 0,
            episodeCount: Number(r.episode_count) || 0,
            episodesWatched: Number(r.episodes_watched) || 0,
        });

        const movies = movieRows
            .filter((r) => !allowedMovieIds || allowedMovieIds.has(r.internal_id))
            .map(toMovie);
        const shows = showRows
            .filter((r) => !allowedShowIds || allowedShowIds.has(r.internal_id))
            .map(toShow);

        return { movies, shows };
    }

    /**
     * Resolve each series name surfaced in the rewatch records to a tv/series
     * catalog UUID for poster art. Matches the stored series_name exactly (the same
     * basis as the access check) and, when a name maps to several rows, prefers a
     * real library row (has_files) then the most recently updated. Names with no
     * catalog match are simply absent from the map (no poster — the card still
     * renders). This is poster decoration only; access filtering happens separately.
     */
    private async resolveSeriesPosterIds(seriesNames: string[]): Promise<Map<string, string>> {
        const map = new Map<string, string>();
        if (!this.sql || seriesNames.length === 0) return map;
        const rows = await this.sql<{ title: string; id: string }[]>`
				SELECT DISTINCT ON (title) title, id::text AS id
				FROM media_items
				WHERE media_type IN ('tv', 'series')
					AND title = ANY(${seriesNames}::text[])
				ORDER BY title, has_files DESC, updated_at DESC, id
			`;
        for (const r of rows) map.set(r.title, r.id);
        return map;
    }

    /**
     * Series-level access check for rewatch records that carry only a series name
     * (no media_id). This only runs for a restricted caller (see
     * {@link hasAccessRestrictions}), so it FAILS CLOSED: a series name is allowed
     * only when at least one matching tv/series catalog row is currently
     * accessible. A name that resolves to no catalog row (deleted/removed from the
     * library, or a drifted title) is DROPPED — this is the case access filtering
     * exists to suppress, and mirrors the media_id path, which also drops
     * unresolvable ids. The cost is hiding a legitimately-accessible series whose
     * watch-history title no longer matches any catalog row; acceptable for a
     * restricted user, and unrestricted users never reach this method.
     */
    private async filterAccessibleSeriesNames(
        seriesNames: string[],
        access: MediaAccessBoundary,
    ): Promise<Set<string>> {
        // No DB → can't verify access → fail closed (drop all) for a restricted caller.
        if (!this.sql) return new Set();
        const { filterAccessibleMediaIds } = await import('../utils/media-access-batch.js');
        // Map each surfaced series name to its catalog rows (tv/series).
        const rows = await this.sql<{ id: string; title: string }[]>`
			SELECT id::text, title
			FROM media_items
			WHERE media_type IN ('tv', 'series')
				AND title = ANY(${seriesNames}::text[])
		`;
        if (rows.length === 0) {
            // None resolve to a catalog row → can't confirm access → drop all.
            return new Set();
        }
        const accessibleIds = await filterAccessibleMediaIds(
            this.sql,
            rows.map((r) => r.id),
            access,
        );
        // Group catalog rows by title.
        const titleToIds = new Map<string, string[]>();
        for (const r of rows) {
            const list = titleToIds.get(r.title) ?? [];
            list.push(r.id);
            titleToIds.set(r.title, list);
        }
        const allowed = new Set<string>();
        for (const name of seriesNames) {
            const ids = titleToIds.get(name);
            // Allow only if the name resolves to at least one accessible catalog row.
            if (ids && ids.some((id) => accessibleIds.has(id))) {
                allowed.add(name);
            }
        }
        return allowed;
    }

    /**
     * Get all stats in parallel, with per-type caching and minimum data checks.
     * Returns partial results — individual stat types that fail or have insufficient data are omitted.
     */
    async getAllStats(
        userId: UserId,
        period: StatsPeriod,
        cacheKeyPrefix: 'personalStats' | 'adminStats',
        statsCache: UnifiedCache,
        access: MediaAccessBoundary,
    ): Promise<AllStatsResult> {
        // Session count is needed before the fan-out. Cache it (short-lived) so a
        // fully cache-warm /all incurs zero uncached round-trips (P3), and degrade
        // gracefully on failure rather than 500ing the whole composite (B8).
        let sessionCount = 0;
        try {
            sessionCount = await this.getCachedSessionCount(userId, statsCache, cacheKeyPrefix);
        } catch {
            sessionCount = 0;
        }

        const statTypes = [
            {
                key: 'overview' as const,
                type: 'overview' as const,
                min: MINIMUM_DATA_REQUIREMENTS['overview'],
            },
            {
                key: 'watchTime' as const,
                type: 'watch-time' as const,
                min: MINIMUM_DATA_REQUIREMENTS['watch-time'],
            },
            {
                key: 'peakHours' as const,
                type: 'peak-hours' as const,
                min: MINIMUM_DATA_REQUIREMENTS['peak-hours'],
            },
            {
                key: 'completion' as const,
                type: 'completion' as const,
                min: MINIMUM_DATA_REQUIREMENTS['completion'],
            },
            {
                key: 'genres' as const,
                type: 'genres' as const,
                min: MINIMUM_DATA_REQUIREMENTS['genres'],
            },
            {
                key: 'keywords' as const,
                type: 'keywords' as const,
                min: MINIMUM_DATA_REQUIREMENTS['keywords'],
            },
            {
                key: 'devices' as const,
                type: 'devices' as const,
                min: MINIMUM_DATA_REQUIREMENTS['devices'],
            },
            {
                key: 'quality' as const,
                type: 'quality' as const,
                min: MINIMUM_DATA_REQUIREMENTS['quality'],
            },
            {
                key: 'ratings' as const,
                type: 'ratings' as const,
                min: MINIMUM_DATA_REQUIREMENTS['ratings'],
            },
            {
                key: 'tasteProfile' as const,
                type: 'taste-profile' as const,
                min: MINIMUM_DATA_REQUIREMENTS['taste-profile'],
            },
            {
                key: 'records' as const,
                type: 'records' as const,
                min: MINIMUM_DATA_REQUIREMENTS['records'],
            },
            {
                key: 'topTitles' as const,
                type: 'top-titles' as const,
                min: MINIMUM_DATA_REQUIREMENTS['top-titles'],
            },
        ];

        const results = await Promise.allSettled(
            statTypes.map(async ({ key, type, min }) => {
                if (sessionCount < min) {
                    return { key, value: undefined };
                }

                // Per-type cache key. completion + records surface access-filtered
                // titles, so their key must partition by the access dimension —
                // otherwise an unfiltered (or differently-scoped) result poisons a
                // filtered read for the 2h TTL (B3). Other types are not
                // access-sensitive and keep the plain key.
                //
                // The `&& access` conjunct is gone with the optional parameter.
                // It was the poison vector: a caller that omitted `access`
                // computed UNFILTERED completion/records/top-titles and wrote
                // them to the same un-fingerprinted key a restricted caller
                // reads. `accessFingerprint` still returns '' for an explicitly
                // unrestricted boundary, so unrestricted callers keep the plain
                // key and their existing warm entries.
                const fingerprint =
                    type === 'completion' || type === 'records' || type === 'top-titles'
                        ? accessFingerprint(access)
                        : '';
                const cacheKey = fingerprint
                    ? buildVersionedCacheKey(cacheKeyPrefix, type, period, fingerprint)
                    : buildVersionedCacheKey(cacheKeyPrefix, type, period);
                const cached = await statsCache.get<{ stats: unknown }>(cacheKey, userId);
                if (cached) {
                    return { key, value: cached.stats };
                }

                // Compute and cache
                const stats = await this.computeStat(type, userId, period, access);
                const cacheEntry = { type, period, stats };
                await statsCache.set(cacheKey, cacheEntry, undefined, userId);
                return { key, value: stats };
            }),
        );

        const stats: Partial<AllStatsMap> = {};
        results.forEach((result, i) => {
            if (result.status === 'fulfilled') {
                if (result.value.value !== undefined) {
                    (stats as Record<string, unknown>)[result.value.key] = result.value.value;
                }
                return;
            }
            // A failed stat is omitted so the rest of the page still renders —
            // but say so. The watch-time stat failed on every request for this
            // reason and nothing ever reported it.
            logger.error(
                `Personal stat "${statTypes[i].type}" failed; omitted from the response`,
                result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
                { statType: statTypes[i].type, period },
            );
        });

        const hasInsufficientData = sessionCount < MINIMUM_DATA_REQUIREMENTS['overview'];

        return {
            period,
            ...(hasInsufficientData ? { insufficientData: true } : {}),
            sessionCount,
            stats,
        };
    }

    /**
     * Dispatch a single stat type computation to the appropriate method
     */
    private async computeStat(
        type: PersonalStatsType,
        userId: UserId,
        period: StatsPeriod,
        access: MediaAccessBoundary,
    ): Promise<unknown> {
        switch (type) {
            case 'overview':
                return this.getOverviewStats(userId, period);
            case 'watch-time':
                return this.getWatchTimeStats(userId, period);
            case 'peak-hours':
                return this.getPeakHoursStats(userId, period);
            case 'completion':
                return this.getCompletionStats(userId, period, access);
            case 'genres':
                return this.getGenreStats(userId, period);
            case 'keywords':
                return this.getKeywordStats(userId, period);
            case 'devices':
                return this.getDeviceStats(userId, period);
            case 'quality':
                return this.getQualityStats(userId, period);
            case 'ratings':
                return this.getRatingStats(userId);
            case 'taste-profile':
                return this.getTasteProfileStats(userId);
            case 'records':
                return this.getFunRecords(userId, period, access);
            case 'top-titles':
                return this.getTopTitles(userId, period, access);
            default: {
                const _exhaustive: never = type;
                throw new Error(`Unknown stat type: ${_exhaustive}`);
            }
        }
    }

    /**
     * Get session count for a user (used for minimum data requirements)
     */
    async getSessionCount(userId: UserId): Promise<number> {
        if (!this.isAvailable()) {
            return 0;
        }

        const result = await this.sql!`
			SELECT COUNT(*) as count
			FROM watch_history
			WHERE user_id = ${userId}
				AND actual_watch_time_seconds >= ${MIN_SESSION_SECONDS}
		`;

        return Number(result[0]?.count) || 0;
    }

    /**
     * Session count for the /all fan-out, cached with a short TTL so a fully
     * cache-warm composite request makes zero uncached DB round-trips (P3). The
     * count gates min-data thresholds; a 60s staleness window is acceptable.
     */
    private async getCachedSessionCount(
        userId: UserId,
        statsCache: UnifiedCache,
        cacheKeyPrefix: 'personalStats' | 'adminStats',
    ): Promise<number> {
        const key = buildVersionedCacheKey(cacheKeyPrefix, 'session-count');
        const cached = await statsCache.get<{ count: number }>(key, userId);
        if (cached && typeof cached.count === 'number') {
            return cached.count;
        }
        const count = await this.getSessionCount(userId);
        // 60s TTL — short enough that newly-crossed thresholds unlock quickly.
        await statsCache.set(key, { count }, 60_000, userId);
        return count;
    }
}

export const personalStatsService = new PersonalStatsService();
