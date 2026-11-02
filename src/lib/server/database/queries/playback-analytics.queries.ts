// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playback Analytics Queries
 *
 * Centralized queries for admin playback quality metrics.
 * Consolidates inline SQL from:
 * - /api/admin/playback-quality/+server.ts
 *
 * @module queries/playback-analytics
 */

import type postgres from 'postgres';
import { FORM_FACTOR_PATTERNS } from '$lib/utils/user-agent.js';

// =============================================================================
// Session context: the real device and its form factor
// =============================================================================

/**
 * Device class a session played on. `unknown` is a real bucket, not an error:
 * probes and clients that report neither a UA nor a recognizable name land
 * there instead of being guessed into "desktop".
 */
export type PlaybackFormFactor = 'mobile' | 'tablet' | 'tv' | 'desktop' | 'unknown';

/**
 * Joins that give a quality row (alias `q`) its play session (`ps`) and the
 * owner's device record (`ud`). Every per-device and per-form-factor query
 * goes through these, for two reasons found on prod (2026-09-27):
 *
 * - `q.device_id` is copied from the server telemetry, where most web and
 *   native sessions carry the shared placeholder `lumastra-player` — 381
 *   sessions from 17 users and 31 real devices collapsed into one "device".
 *   `ps.device_id` is the id the client registered the session with.
 * - `q.is_mobile` / `q.user_agent` were never populated (the session-start
 *   metadata carries neither), so every session read as "desktop". The UA,
 *   client name and the device's reported name live on `ps` / `ud`.
 *
 * Both joins hit unique keys (`play_sessions.id`,
 * `user_devices (user_id, device_id)`), so they never fan a row out.
 */
function sessionContextJoins(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        LEFT JOIN play_sessions ps ON ps.id = q.play_session_id
        LEFT JOIN user_devices ud ON ud.user_id = ps.user_id AND ud.device_id = ps.device_id
    `;
}

/** The session's real device id (see `sessionContextJoins`). */
function deviceIdSql(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`COALESCE(ps.device_id, q.device_id)`;
}

/**
 * SQL twin of `detectFormFactor` ($lib/utils/user-agent): same haystack
 * (UA, client name, device reported name), same branch order, same pattern
 * sources — passed as parameters, so the two classifiers cannot drift.
 */
function formFactorSql(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    const hay = (): postgres.PendingQuery<postgres.Row[]> =>
        sql`concat_ws(' ', COALESCE(q.user_agent, ps.user_agent), ps.client_name, ud.reported_name)`;
    const p = FORM_FACTOR_PATTERNS;
    return sql`
        CASE
            WHEN ${hay()} ~* ${p.tv} THEN 'tv'
            WHEN ${hay()} ~* ${p.tablet} THEN 'tablet'
            WHEN ${hay()} ~* ${p.android} AND ${hay()} !~* ${p.mobileToken} THEN 'tablet'
            WHEN ${hay()} ~* ${p.mobile} THEN 'mobile'
            WHEN ${hay()} ~* ${p.desktop} THEN 'desktop'
            ELSE 'unknown'
        END
    `;
}

// =============================================================================
// Types
// =============================================================================

export interface OverallStatsRow {
    total_sessions: number;
    avg_health_score: number | null;
    min_health_score: number | null;
    /** Sessions scoring below 70 — the "Fair"/"Poor" bands of the health tooltip. */
    poor_sessions: number;
    avg_bandwidth_mbps: number | null;
    total_rebuffers: number;
    total_server_errors: number;
    sessions_with_issues: number;
    unique_users: number;
    unique_devices: number;
    mobile_sessions: number;
    desktop_sessions: number;
    live_sessions: number;
    vod_sessions: number;
}

export interface TranscodingStatsRow {
    play_method: string;
    session_count: number;
    avg_health_score: number | null;
    rebuffers: number;
    video_transcoding: number;
    audio_transcoding: number;
    avg_compression_ratio: number | null;
}

export interface DeviceTypeStatsRow {
    device_type: PlaybackFormFactor;
    session_count: number;
    avg_health_score: number | null;
    rebuffers: number;
    avg_bandwidth_mbps: number | null;
}

export interface StreamTypeStatsRow {
    stream_type: 'live' | 'vod';
    session_count: number;
    avg_health_score: number | null;
    rebuffers: number;
    avg_bandwidth_mbps: number | null;
}

export interface ClientTypeStatsRow {
    client_type: string;
    session_count: number;
    avg_health_score: number | null;
    rebuffers: number;
}

export interface DailyTrendRow {
    date: string;
    sessions: number;
    avg_health_score: number | null;
    rebuffers: number;
    avg_bandwidth_mbps: number | null;
}

export interface UserWithIssuesRow {
    user_id: string;
    username: string | null;
    total_sessions: number;
    avg_health_score: number | null;
    rebuffers: number;
    sessions_with_issues: number;
}

export interface DeviceWithIssuesRow {
    device_id: string;
    device_name: string | null;
    client_type: string | null;
    user_agent: string | null;
    is_mobile: boolean | null;
    form_factor: PlaybackFormFactor;
    total_sessions: number;
    avg_health_score: number | null;
    rebuffers: number;
    live_sessions: number;
    vod_sessions: number;
}

export interface CommonIssueRow {
    issue: string;
    count: number;
}

export interface DailyByDeviceTypeRow {
    date: string;
    device_type: PlaybackFormFactor;
    session_count: number;
    avg_health_score: number | null;
    rebuffers: number;
}

export interface TranscodeReasonRow {
    /**
     * Stable, language-agnostic reason bucket (see the CASE in
     * `getTranscodeReasons`). The client localizes it and maps it to an
     * operation category — remux / audio / video transcode.
     */
    reason_bucket: string;
    session_count: number;
    avg_health_score: number | null;
    rebuffers: number;
}

/**
 * Fleet-level segment-delivery latency percentiles, computed directly from raw
 * `playback_telemetry` rows via `percentile_cont` (NOT by averaging the
 * per-session delivery_p*_ms columns — percentile-of-percentiles is invalid).
 *
 * Percentile fields are `null` when there are no qualifying telemetry rows in
 * the window (expected until server-side per-segment telemetry is wired).
 */
export interface FleetPercentilesRow {
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
    sampleCount: number;
}

/**
 * Drill-down session-detail row, shaped to `PlaybackQualitySessionDetailSchema`.
 * `playback_session_quality` has no dedicated start column, so `startedAt` is
 * sourced from `computed_at`. There is no `root_cause` column in the table, so
 * `rootCause` is always omitted at the query layer (left undefined).
 */
export interface SessionDetailRow {
    sessionId: string;
    startedAt: string;
    healthScore: number | null;
    playMethod: string | undefined;
    deviceType: string;
    /** What was played: the item title, or "Series · S1E2 · Episode" for an episode. */
    mediaTitle: string | undefined;
    /** The device's display name (custom name, else what the client reported). */
    deviceName: string | undefined;
    issues: string[];
    rootCause: string | undefined;
    scoringModelVersion: number | undefined;
    /**
     * Client-reported delivery percentiles for the session (bits per second).
     * p10 vs p50 is the whole point: a link that is usually ample and
     * periodically collapses has a low p10 and a healthy p50, which no average
     * can show. Null on every session scored before the client reported
     * `delivery_window` events (migration 16.248.0 columns, nullable by design).
     */
    deliveryP10Bps: number | null;
    deliveryP50Bps: number | null;
    /** Number of delivery windows the client reported. */
    deliveryWindows: number | undefined;
    /** Sum of AVPlayer `downloadOverdue` deltas (native only; 0 on web). */
    deliveryOverdue: number | undefined;
}

/**
 * Raw shape as returned by postgres.js — `play_method` is a nullable column and
 * `root_cause` doesn't exist (queried as a `NULL::text` literal), so both come
 * back as JS `null`, never `undefined`. The same applies to the two delivery
 * COUNT columns, which are nullable on every pre-16.248.0 row.
 * `PlaybackQualitySessionDetailSchema` declares all four `.optional()` without
 * `.nullable()`, so `null` must be normalized to `undefined` before the response
 * schema parses these rows. (`deliveryP10Bps`/`deliveryP50Bps` are declared
 * `.nullable().optional()` there — a null percentile is meaningful data, "the
 * client reported no windows", not an absent field — so they pass through.)
 */
type RawSessionDetailRow = Omit<
    SessionDetailRow,
    'playMethod' | 'rootCause' | 'deliveryWindows' | 'deliveryOverdue' | 'mediaTitle' | 'deviceName'
> & {
    mediaTitle: string | null;
    deviceName: string | null;
    playMethod: string | null;
    rootCause: string | null;
    deliveryWindows: number | null;
    deliveryOverdue: number | null;
};

function toSessionDetailRow(row: RawSessionDetailRow): SessionDetailRow {
    return {
        ...row,
        playMethod: row.playMethod ?? undefined,
        mediaTitle: row.mediaTitle ?? undefined,
        deviceName: row.deviceName ?? undefined,
        rootCause: row.rootCause ?? undefined,
        deliveryWindows: row.deliveryWindows ?? undefined,
        deliveryOverdue: row.deliveryOverdue ?? undefined,
    };
}

export interface CrossTabAnalysisRow {
    device_type: PlaybackFormFactor;
    play_method: string;
    session_count: number;
    avg_health_score: number | null;
    rebuffers: number;
    avg_bandwidth_mbps: number | null;
}

// =============================================================================
// Overall Statistics
// =============================================================================

/**
 * Get overall playback quality statistics.
 */
export async function getOverallStats(
    sql: postgres.Sql,
    sessionCutoff: Date,
): Promise<OverallStatsRow | null> {
    const rows = await sql<OverallStatsRow[]>`
        SELECT
            COUNT(*)::INTEGER as total_sessions,
            ROUND(AVG(health_score)::NUMERIC, 1)::float8 as avg_health_score,
            MIN(health_score) as min_health_score,
            COUNT(CASE WHEN health_score < 70 THEN 1 END)::INTEGER as poor_sessions,
            ROUND((AVG(client_avg_bandwidth_bps) / 1000000)::NUMERIC, 2)::float8 as avg_bandwidth_mbps,
            COALESCE(SUM(client_rebuffer_count), 0)::INTEGER as total_rebuffers,
            COALESCE(SUM(server_error_count), 0)::INTEGER as total_server_errors,
            COUNT(CASE WHEN array_length(health_issues, 1) > 0 THEN 1 END)::INTEGER as sessions_with_issues,
            COUNT(DISTINCT user_id)::INTEGER as unique_users,
            COUNT(DISTINCT real_device_id)::INTEGER as unique_devices,
            -- "mobile" = handheld (phone + tablet); "desktop" = desktop only.
            -- TVs and unclassifiable clients count in neither.
            COUNT(CASE WHEN form_factor IN ('mobile', 'tablet') THEN 1 END)::INTEGER as mobile_sessions,
            COUNT(CASE WHEN form_factor = 'desktop' THEN 1 END)::INTEGER as desktop_sessions,
            COUNT(CASE WHEN is_live = TRUE THEN 1 END)::INTEGER as live_sessions,
            COUNT(CASE WHEN is_live = FALSE THEN 1 END)::INTEGER as vod_sessions
        FROM (
            SELECT q.*, ${deviceIdSql(sql)} AS real_device_id, ${formFactorSql(sql)} AS form_factor
            FROM playback_session_quality q
            ${sessionContextJoins(sql)}
            WHERE q.computed_at >= ${sessionCutoff}
        ) s
    `;
    return rows[0] || null;
}

// =============================================================================
// Transcoding Statistics
// =============================================================================

/**
 * Get transcoding breakdown statistics.
 */
export async function getTranscodingStats(
    sql: postgres.Sql,
    sessionCutoff: Date,
): Promise<TranscodingStatsRow[]> {
    return (await sql`
        SELECT
            COALESCE(play_method, 'unknown') as play_method,
            COUNT(*)::INTEGER as session_count,
            ROUND(AVG(health_score)::NUMERIC, 1)::float8 as avg_health_score,
            COALESCE(SUM(client_rebuffer_count), 0)::INTEGER as rebuffers,
            COUNT(CASE WHEN is_video_transcoding = TRUE THEN 1 END)::INTEGER as video_transcoding,
            COUNT(CASE WHEN is_audio_transcoding = TRUE THEN 1 END)::INTEGER as audio_transcoding,
            ROUND(AVG(compression_ratio)::NUMERIC, 2)::float8 as avg_compression_ratio
        FROM playback_session_quality
        WHERE computed_at >= ${sessionCutoff}
        GROUP BY play_method
        ORDER BY session_count DESC
    `) as unknown as TranscodingStatsRow[];
}

/**
 * Get transcoding reasons breakdown.
 */
export async function getTranscodeReasons(
    sql: postgres.Sql,
    sessionCutoff: Date,
    limit = 15,
): Promise<TranscodeReasonRow[]> {
    // Aggregate on the structured, language-agnostic `transcode_reason_codes`
    // (jsonb array of `{ code, params }`) instead of the legacy free-text
    // `transcode_reasons`. Those strings were rendered in each user's locale
    // with codec names interpolated in, so the same concern produced a German
    // AND an English row (and split further per codec) — the panel showed
    // mixed-language, duplicated rows. Codes dedupe across locales.
    //
    // The CASE folds the raw planner codes into display BUCKETS: near-identical
    // concerns (both video-profile codes, both bitrate codes) collapse to one
    // bucket so they never surface as visually-duplicated rows. The bucket
    // string is the ONLY place code→bucket lives; the client owns
    // bucket→label and bucket→category (remux / audio / video transcode) — keep
    // `transcodeReasonBucketCategory` / `formatTranscodeReasonBucket` in
    // playback-formatters.ts in lockstep with the buckets emitted here.
    //
    // DISTINCT per (play_session_id, bucket) keeps COUNT distinct-session
    // correct even when a session lists two codes that map to the same bucket.
    // Only rows with structured codes participate; legacy rows without codes
    // (pre-16.141.0) simply age out of the `sessionCutoff` window.
    return (await sql`
        SELECT
            reason_bucket,
            COUNT(DISTINCT play_session_id)::INTEGER as session_count,
            AVG(health_score)::float8 as avg_health_score,
            COALESCE(SUM(client_rebuffer_count), 0)::INTEGER as rebuffers
        FROM (
            SELECT DISTINCT
                play_session_id,
                CASE elem->>'code'
                    WHEN 'container_incompatible' THEN 'container'
                    WHEN 'multi_audio_needs_hls' THEN 'multi_audio'
                    WHEN 'audio_codec_incompatible' THEN 'audio_codec'
                    WHEN 'audio_channels_exceeded' THEN 'audio_channels'
                    WHEN 'video_codec_incompatible' THEN 'video_codec'
                    WHEN 'video_10bit_h264' THEN 'video_10bit'
                    WHEN 'hdr_tonemap_dolby_vision' THEN 'hdr'
                    WHEN 'video_level_exceeded' THEN 'video_level'
                    WHEN 'video_profile_exceeded' THEN 'video_profile'
                    WHEN 'video_profile_excluded' THEN 'video_profile'
                    WHEN 'resolution_exceeded' THEN 'resolution'
                    WHEN 'resolution_exceeded_user_cap' THEN 'resolution'
                    WHEN 'bitrate_exceeded' THEN 'video_bitrate'
                    WHEN 'bitrate_exceeded_user_cap' THEN 'video_bitrate'
                    WHEN 'preview_mode' THEN 'preview_mode'
                    ELSE elem->>'code'
                END AS reason_bucket,
                health_score,
                client_rebuffer_count
            FROM playback_session_quality,
                 jsonb_array_elements(transcode_reason_codes) AS elem
            WHERE computed_at >= ${sessionCutoff}
              AND transcode_reason_codes IS NOT NULL
              AND jsonb_typeof(transcode_reason_codes) = 'array'
              AND jsonb_array_length(transcode_reason_codes) > 0
        ) AS deduped
        GROUP BY reason_bucket
        ORDER BY session_count DESC
        LIMIT ${limit}
    `) as unknown as TranscodeReasonRow[];
}

/**
 * Remuxed or transcoded sessions that carry no structured reason code, so the
 * reasons panel can say how much of the work it cannot explain. On prod these
 * are sessions that started without a playback plan at all (no
 * `play_sessions.plan_reasons` either) — 43 of 148 transcodes, 2026-09-19..22.
 */
export async function getSessionsWithoutTranscodeReason(
    sql: postgres.Sql,
    sessionCutoff: Date,
): Promise<number> {
    const rows = await sql<{ count: number }[]>`
        SELECT COUNT(*)::INTEGER as count
        FROM playback_session_quality
        WHERE computed_at >= ${sessionCutoff}
          AND play_method IN ('DirectStream', 'Transcode')
          -- CASE, not OR: Postgres may evaluate jsonb_array_length on a
          -- non-array operand, which raises.
          AND CASE
                  WHEN jsonb_typeof(transcode_reason_codes) = 'array'
                  THEN jsonb_array_length(transcode_reason_codes)
                  ELSE 0
              END = 0
    `;
    return rows[0]?.count ?? 0;
}

// =============================================================================
// Device and Stream Type Statistics
// =============================================================================

/**
 * Get statistics by device class (phone / tablet / TV / desktop / unknown).
 */
export async function getDeviceTypeStats(
    sql: postgres.Sql,
    sessionCutoff: Date,
): Promise<DeviceTypeStatsRow[]> {
    return (await sql`
        SELECT
            ${formFactorSql(sql)} as device_type,
            COUNT(*)::INTEGER as session_count,
            ROUND(AVG(q.health_score)::NUMERIC, 1)::float8 as avg_health_score,
            COALESCE(SUM(q.client_rebuffer_count), 0)::INTEGER as rebuffers,
            ROUND((AVG(q.client_avg_bandwidth_bps) / 1000000)::NUMERIC, 2)::float8 as avg_bandwidth_mbps
        FROM playback_session_quality q
        ${sessionContextJoins(sql)}
        WHERE q.computed_at >= ${sessionCutoff}
        GROUP BY 1
        ORDER BY session_count DESC
    `) as unknown as DeviceTypeStatsRow[];
}

/**
 * Get statistics by stream type (live vs VOD).
 */
export async function getStreamTypeStats(
    sql: postgres.Sql,
    sessionCutoff: Date,
): Promise<StreamTypeStatsRow[]> {
    return (await sql`
        SELECT
            CASE WHEN is_live = TRUE THEN 'live' ELSE 'vod' END as stream_type,
            COUNT(*)::INTEGER as session_count,
            ROUND(AVG(health_score)::NUMERIC, 1)::float8 as avg_health_score,
            COALESCE(SUM(client_rebuffer_count), 0)::INTEGER as rebuffers,
            ROUND((AVG(client_avg_bandwidth_bps) / 1000000)::NUMERIC, 2)::float8 as avg_bandwidth_mbps
        FROM playback_session_quality
        WHERE computed_at >= ${sessionCutoff}
          AND is_live IS NOT NULL
        GROUP BY is_live
        ORDER BY session_count DESC
    `) as unknown as StreamTypeStatsRow[];
}

/**
 * Get statistics by client type.
 */
export async function getClientTypeStats(
    sql: postgres.Sql,
    sessionCutoff: Date,
): Promise<ClientTypeStatsRow[]> {
    return (await sql`
        SELECT
            COALESCE(client_type, 'unknown') as client_type,
            COUNT(*)::INTEGER as session_count,
            ROUND(AVG(health_score)::NUMERIC, 1)::float8 as avg_health_score,
            COALESCE(SUM(client_rebuffer_count), 0)::INTEGER as rebuffers
        FROM playback_session_quality
        WHERE computed_at >= ${sessionCutoff}
        GROUP BY client_type
        ORDER BY session_count DESC
    `) as unknown as ClientTypeStatsRow[];
}

// =============================================================================
// Trend and Time-Series Queries
// =============================================================================

/**
 * Get daily trends, bucketed by UTC day.
 *
 * Read from the per-session rows, the same set every other panel counts, so
 * "Sessions by Day" sums to the page's session total. It used to read the
 * `user_playback_quality` rollup, which lagged it (580 vs 581 on prod,
 * 2026-09-27). L2: rounding stays with the client.
 */
export async function getDailyTrends(
    sql: postgres.Sql,
    sessionCutoff: Date,
): Promise<DailyTrendRow[]> {
    return (await sql`
        SELECT
            (computed_at AT TIME ZONE 'UTC')::DATE::TEXT as date,
            COUNT(*)::INTEGER as sessions,
            AVG(health_score)::float8 as avg_health_score,
            COALESCE(SUM(client_rebuffer_count), 0)::INTEGER as rebuffers,
            (AVG(client_avg_bandwidth_bps) / 1000000)::float8 as avg_bandwidth_mbps
        FROM playback_session_quality
        WHERE computed_at >= ${sessionCutoff}
        GROUP BY 1
        ORDER BY date DESC
    `) as unknown as DailyTrendRow[];
}

/**
 * Get daily health by device type for time-series charts.
 */
export async function getDailyByDeviceType(
    sql: postgres.Sql,
    sessionCutoff: Date,
): Promise<DailyByDeviceTypeRow[]> {
    // M2: pin the date bucket to UTC so the labels line up with the rollup
    // tables' UTC `date` column (an unqualified ::DATE buckets in the server's
    // session TZ, which can shift rows across midnight relative to the rollups).
    return (await sql`
        SELECT
            (q.computed_at AT TIME ZONE 'UTC')::DATE::TEXT as date,
            ${formFactorSql(sql)} as device_type,
            COUNT(*)::INTEGER as session_count,
            ROUND(AVG(q.health_score)::NUMERIC, 1)::float8 as avg_health_score,
            COALESCE(SUM(q.client_rebuffer_count), 0)::INTEGER as rebuffers
        FROM playback_session_quality q
        ${sessionContextJoins(sql)}
        WHERE q.computed_at >= ${sessionCutoff}
        GROUP BY 1, 2
        ORDER BY date ASC, device_type
    `) as unknown as DailyByDeviceTypeRow[];
}

// =============================================================================
// Issue Detection Queries
// =============================================================================

/**
 * Get users with playback issues (sorted by lowest health score).
 *
 * Read from the per-session rows like every other panel, so a user's session
 * count here matches the page totals and the drill-down drawer (it used to
 * read the `user_playback_quality` rollup, which lags the per-session table).
 * `sessions_with_issues` uses the same definition as `getOverallStats`.
 */
export async function getUsersWithIssues(
    sql: postgres.Sql,
    sessionCutoff: Date,
    limit = 10,
): Promise<UserWithIssuesRow[]> {
    return (await sql`
        SELECT
            q.user_id,
            u.username,
            COUNT(*)::INTEGER as total_sessions,
            AVG(q.health_score)::float8 as avg_health_score,
            COALESCE(SUM(q.client_rebuffer_count), 0)::INTEGER as rebuffers,
            COUNT(CASE WHEN array_length(q.health_issues, 1) > 0 THEN 1 END)::INTEGER as sessions_with_issues
        FROM playback_session_quality q
        LEFT JOIN users u ON u.id = q.user_id
        WHERE q.computed_at >= ${sessionCutoff}
        GROUP BY q.user_id, u.username
        HAVING SUM(q.client_rebuffer_count) > 0 OR AVG(q.health_score) < 80
        ORDER BY AVG(q.health_score) ASC NULLS LAST, SUM(q.client_rebuffer_count) DESC
        LIMIT ${limit}
    `) as unknown as UserWithIssuesRow[];
}

/**
 * Get devices with playback issues (sorted by lowest health score).
 *
 * Grouped by the session's REAL device (see `sessionContextJoins`), not the
 * `device_playback_quality` rollup, which is keyed by the telemetry device id
 * and so merged every `lumastra-player` session into one row. `device_name` is
 * the device's display name and `user_agent` the browser string, which for web
 * clients is only known as the name the browser reported for itself.
 */
export async function getDevicesWithIssues(
    sql: postgres.Sql,
    sessionCutoff: Date,
    limit = 10,
): Promise<DeviceWithIssuesRow[]> {
    return (await sql`
        SELECT
            device_id,
            MAX(device_name) as device_name,
            MAX(client_type) as client_type,
            MAX(user_agent) as user_agent,
            BOOL_OR(form_factor IN ('mobile', 'tablet')) as is_mobile,
            MODE() WITHIN GROUP (ORDER BY form_factor) as form_factor,
            COUNT(*)::INTEGER as total_sessions,
            AVG(health_score)::float8 as avg_health_score,
            COALESCE(SUM(client_rebuffer_count), 0)::INTEGER as rebuffers,
            COUNT(CASE WHEN is_live = TRUE THEN 1 END)::INTEGER as live_sessions,
            COUNT(CASE WHEN is_live IS NOT TRUE THEN 1 END)::INTEGER as vod_sessions
        FROM (
            SELECT
                ${deviceIdSql(sql)} AS device_id,
                COALESCE(ud.custom_name, ud.reported_name, q.device_name) AS device_name,
                q.client_type,
                COALESCE(q.user_agent, ps.user_agent, ud.reported_name) AS user_agent,
                ${formFactorSql(sql)} AS form_factor,
                q.health_score,
                q.client_rebuffer_count,
                q.is_live
            FROM playback_session_quality q
            ${sessionContextJoins(sql)}
            WHERE q.computed_at >= ${sessionCutoff}
        ) s
        WHERE device_id IS NOT NULL
        GROUP BY device_id
        HAVING SUM(client_rebuffer_count) > 0 OR AVG(health_score) < 80
        ORDER BY AVG(health_score) ASC NULLS LAST, SUM(client_rebuffer_count) DESC
        LIMIT ${limit}
    `) as unknown as DeviceWithIssuesRow[];
}

/**
 * Get common health issues across all sessions.
 */
export async function getCommonIssues(
    sql: postgres.Sql,
    sessionCutoff: Date,
    limit = 10,
): Promise<CommonIssueRow[]> {
    return await sql<CommonIssueRow[]>`
        SELECT
            issue,
            COUNT(*)::INTEGER as count
        FROM playback_session_quality, UNNEST(health_issues) as issue
        WHERE computed_at >= ${sessionCutoff}
        GROUP BY issue
        ORDER BY count DESC
        LIMIT ${limit}
    `;
}

// =============================================================================
// Cross-Tab Analysis
// =============================================================================

/**
 * Get cross-tab analysis: device type x play method.
 */
export async function getCrossTabAnalysis(
    sql: postgres.Sql,
    sessionCutoff: Date,
): Promise<CrossTabAnalysisRow[]> {
    return (await sql`
        SELECT
            ${formFactorSql(sql)} as device_type,
            COALESCE(q.play_method, 'unknown') as play_method,
            COUNT(*)::INTEGER as session_count,
            ROUND(AVG(q.health_score)::NUMERIC, 1)::float8 as avg_health_score,
            COALESCE(SUM(q.client_rebuffer_count), 0)::INTEGER as rebuffers,
            ROUND((AVG(q.client_avg_bandwidth_bps) / 1000000)::NUMERIC, 2)::float8 as avg_bandwidth_mbps
        FROM playback_session_quality q
        ${sessionContextJoins(sql)}
        WHERE q.computed_at >= ${sessionCutoff}
        GROUP BY 1, 2
        ORDER BY session_count DESC
    `) as unknown as CrossTabAnalysisRow[];
}

// =============================================================================
// Fleet Latency Percentiles
// =============================================================================

/**
 * Compute fleet-level segment-delivery latency percentiles (p50/p95/p99)
 * directly from raw `playback_telemetry` rows.
 *
 * This deliberately does NOT average the per-session delivery_p*_ms columns —
 * percentile-of-percentiles is statistically invalid. `percentile_cont` over the
 * raw event values within the window is the exact computation.
 *
 * Returns nulls for the percentiles (and a 0 sampleCount) when there are no
 * `segment_delivery_ms` rows in the window — expected until server-side
 * per-segment telemetry is wired.
 */
export async function getFleetPercentiles(
    sql: postgres.Sql,
    sessionCutoff: Date,
): Promise<FleetPercentilesRow> {
    const rows = await sql<FleetPercentilesRow[]>`
        SELECT
            percentile_cont(0.5) WITHIN GROUP (ORDER BY value) as "p50Ms",
            percentile_cont(0.95) WITHIN GROUP (ORDER BY value) as "p95Ms",
            percentile_cont(0.99) WITHIN GROUP (ORDER BY value) as "p99Ms",
            COUNT(*)::INTEGER as "sampleCount"
        FROM playback_telemetry
        WHERE metric_type = 'segment_delivery_ms'
          AND recorded_at >= ${sessionCutoff}
    `;
    return rows[0] ?? { p50Ms: null, p95Ms: null, p99Ms: null, sampleCount: 0 };
}

/**
 * The same percentiles as `getFleetPercentiles`, over one user's or one
 * device's sessions only — what the drill-down drawer shows. The drawer used
 * to show the FLEET numbers under a user's name, which read as that user's.
 *
 * Server telemetry carries no `user_id` (NULL on every `segment_delivery_ms`
 * row on prod), so the scope goes through `play_session_id`, which is indexed.
 * The device scope matches the session's real device id (see
 * `sessionContextJoins`), the id the devices table hands the drawer.
 */
export async function getScopedDeliveryPercentiles(
    sql: postgres.Sql,
    sessionCutoff: Date,
    scope: { userId: string } | { deviceId: string },
): Promise<FleetPercentilesRow> {
    const sessionFilter =
        'userId' in scope
            ? sql`SELECT ps.id FROM play_sessions ps WHERE ps.user_id = ${scope.userId}::uuid AND ps.started_at >= ${sessionCutoff}`
            : sql`SELECT ps.id FROM play_sessions ps WHERE ps.device_id = ${scope.deviceId} AND ps.started_at >= ${sessionCutoff}`;
    const rows = await sql<FleetPercentilesRow[]>`
        SELECT
            percentile_cont(0.5) WITHIN GROUP (ORDER BY value) as "p50Ms",
            percentile_cont(0.95) WITHIN GROUP (ORDER BY value) as "p95Ms",
            percentile_cont(0.99) WITHIN GROUP (ORDER BY value) as "p99Ms",
            COUNT(*)::INTEGER as "sampleCount"
        FROM playback_telemetry
        WHERE metric_type = 'segment_delivery_ms'
          AND recorded_at >= ${sessionCutoff}
          AND play_session_id IN (${sessionFilter})
    `;
    return rows[0] ?? { p50Ms: null, p95Ms: null, p99Ms: null, sampleCount: 0 };
}

// =============================================================================
// Session Drill-Down Detail
// =============================================================================

/**
 * Get up to `limit` recent per-session quality rows for a single user, shaped
 * to PlaybackQualitySessionDetailSchema. `playback_session_quality` has no
 * dedicated start column, so startedAt is sourced from computed_at; there is no
 * root_cause column, so rootCause is left undefined.
 */
export async function getUserSessionDetails(
    sql: postgres.Sql,
    userId: string,
    sessionCutoff: Date,
    limit = 50,
): Promise<SessionDetailRow[]> {
    return getSessionDetails(sql, sql`q.user_id = ${userId}`, sessionCutoff, limit);
}

/**
 * Get up to `limit` recent per-session quality rows for a single device, shaped
 * to PlaybackQualitySessionDetailSchema. See getUserSessionDetails for the
 * startedAt / rootCause sourcing notes. `deviceId` is the session's real device
 * id (see `sessionContextJoins`) — the id the devices table links with.
 */
export async function getDeviceSessionDetails(
    sql: postgres.Sql,
    deviceId: string,
    sessionCutoff: Date,
    limit = 50,
): Promise<SessionDetailRow[]> {
    return getSessionDetails(sql, sql`${deviceIdSql(sql)} = ${deviceId}`, sessionCutoff, limit);
}

async function getSessionDetails(
    sql: postgres.Sql,
    scope: postgres.PendingQuery<postgres.Row[]>,
    sessionCutoff: Date,
    limit: number,
): Promise<SessionDetailRow[]> {
    // The title makes a row actionable ("0.0 · Transcode" alone says nothing
    // about WHAT stalled). An episode reads "Series · S1E2 · Episode"; the
    // parent chain is episode → season → series. Admin-only drill-down, so no
    // library/age scoping applies.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only drill-down (auth: admin); reads titles of sessions that already played, lists nothing
    const rows = (await sql`
        SELECT
            q.play_session_id::TEXT as "sessionId",
            q.computed_at::TEXT as "startedAt",
            q.health_score as "healthScore",
            q.play_method as "playMethod",
            ${formFactorSql(sql)} as "deviceType",
            CASE
                WHEN mi.media_type = 'episode' THEN concat_ws(' · ',
                    COALESCE(series.title, season.title),
                    CASE WHEN mi.season_number IS NOT NULL AND mi.episode_number IS NOT NULL
                         THEN 'S' || mi.season_number || 'E' || mi.episode_number END,
                    mi.title)
                ELSE mi.title
            END as "mediaTitle",
            COALESCE(ud.custom_name, ud.reported_name) as "deviceName",
            COALESCE(q.health_issues, ARRAY[]::text[]) as issues,
            NULL::text as "rootCause",
            q.scoring_model_version::INTEGER as "scoringModelVersion",
            q.client_delivery_p10_bps as "deliveryP10Bps",
            q.client_delivery_p50_bps as "deliveryP50Bps",
            q.client_delivery_window_count::INTEGER as "deliveryWindows",
            q.client_delivery_overdue_count::INTEGER as "deliveryOverdue"
        FROM playback_session_quality q
        ${sessionContextJoins(sql)}
        LEFT JOIN media_items mi ON mi.id = ps.media_id
        LEFT JOIN media_items season ON season.id = mi.parent_id
        LEFT JOIN media_items series ON series.id = season.parent_id
        WHERE ${scope}
          AND q.computed_at >= ${sessionCutoff}
          AND q.play_session_id IS NOT NULL
        ORDER BY q.computed_at DESC
        LIMIT ${limit}
    `) as unknown as RawSessionDetailRow[];
    return rows.map(toSessionDetailRow);
}

// =============================================================================
// Admin Operations
// =============================================================================

/**
 * Clear all playback telemetry data.
 * Does NOT affect watch_history - only telemetry tables.
 */
export async function clearAllTelemetryData(sql: postgres.Sql): Promise<void> {
    await sql`TRUNCATE TABLE device_playback_quality, user_playback_quality, playback_session_quality, playback_telemetry`;
}
