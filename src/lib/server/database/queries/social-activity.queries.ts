// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Social Activity Query Module
 *
 * Queries for the social watch activity feed — who has rated or watched
 * a specific piece of content. Privacy-aware: excludes users with
 * hide_streams enabled.
 *
 * All queries use internal UUIDs (media_id) — no external_ids JOIN needed.
 *
 * ## Two visibility regimes live in this file, deliberately
 *
 * `getRatedActivities` / `getWatchedActivities` are the ORIGINAL movie/TV
 * surfaces. Their gate is `hide_streams` and nothing else, and that is left
 * exactly as it was: they are read by every modal in the product and a tightening
 * here would silently blank existing rating and review sections.
 *
 * The audiobook LISTENING reads (`getAudiobookListeningActivities` and friends)
 * carry the shared trust-circle predicate from
 * `builders/social-visibility.builder.ts` instead. In-progress position and
 * chapter are a data class no surface has ever exposed — a book at 34% has
 * `is_watched = false` and does not appear in `getWatchedActivities` at all — so
 * it starts gated rather than being retrofitted later. With no configured circle
 * the predicate emits `AND false` and these reads return nothing: the feature is
 * dark, not broken (design doc `2026-07-28-audiobook-social-design.md` §6).
 *
 * ## Access gating is the CALLER's job here
 *
 * This module is in the pure-SQL data tier and has no user context to gate on.
 * `no-unscoped-media-items` exempts it on that basis, and the exemption is only
 * honest as long as the route gates: `buildWatchActivity`
 * (`defs/integrations/social-watch-activity.ts`) calls `checkMediaAccess` against
 * the row IT resolved, unconditionally, BEFORE any function in this file runs.
 * Without that, `getAudiobookChapterTable` alone would confirm the existence of
 * any book by UUID. Do not add a caller that skips it.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import { buildOverrideAwareMetadataLateralJoinFragment } from './builders/provider-metadata.builder.js';
import {
    buildSocialVisibilityFilter,
    type SocialSharingTier,
} from './builders/social-visibility.builder.js';
import { isRecord } from '$lib/utils/data-extraction.js';
import type { AbsChapterInput } from '$lib/utils/audiobook-timeline.js';

// =============================================================================
// Types
// =============================================================================

export interface MediaTypeRow {
    id: string;
    media_type: string;
    parent_id: string | null;
}

export interface ExternalIdMediaRow {
    media_id: string;
}

export interface RatedActivityRow {
    user_id: string;
    /** Human-readable handle (users.username), NOT the users.id UUID. */
    username: string;
    rating: number;
    created_at: Date;
    /** How the rating was entered — 'quick' | 'stars' | null (legacy rows / not provided). */
    rating_style: string | null;
}

export interface WatchedActivityRow {
    user_id: string;
    /** Human-readable handle (users.username), NOT the users.id UUID. */
    username: string;
    last_played_at: Date | null;
    play_count: number;
    episodes_watched: number | null;
    total_episodes: number | null;
}

/**
 * One person's position in one audiobook.
 *
 * **Carries no timestamp, by construction.** The design doc forbids clock times
 * at every tier ("the harm lives in recency and precision, not position"), and
 * the ordering timestamp is therefore used inside the SQL's `ORDER BY` and never
 * selected — a field that does not exist cannot be forwarded to the wire by a
 * later refactor. `last_activity_at` is deliberately absent; do not add it.
 *
 * The one recency field is {@link listened_on}: a calendar DATE, truncated
 * inside the SQL, and only for the reciprocal activity tier. That is the same
 * rule and the same granularity the activity rail (`occurredOn`) already
 * applies.
 */
export interface AudiobookListeningRow {
    user_id: string;
    /** Human-readable handle (users.username), NOT the users.id UUID. */
    username: string;
    /**
     * `user_media_state.resume_position_ms`. **A finished book reads 0** — that is
     * measured, not assumed (all 10 finished books in the reference library sit at
     * 0 with `is_watched = true`), so `position_ms === 0 && is_finished` means
     * "done", NOT "at the very beginning".
     */
    position_ms: number;
    /**
     * `user_media_state.runtime_ms` — per USER, written by whichever client last
     * reported. Null on a row that only ever came from a source that did not
     * report a runtime; the book's own duration is the fallback (see
     * {@link AudiobookChapterTable}).
     */
    duration_ms: number | null;
    /** `is_watched` — has finished it at least once. Can be true WITH a position. */
    is_finished: boolean;
    /** Whether the latest completion falls inside the 60-day timeline-marker window. */
    finished_recently: boolean;
    /** `watch_count` — times finished. Derived by the rebuilder, never written. */
    times_finished: number;
    /**
     * The calendar day (`YYYY-MM-DD`) of this person's latest activity on the
     * book, so a client can say "2 days ago" and not "at 03:12". A DATE, not a
     * time: it is truncated in SQL, so no clock time ever leaves the database.
     *
     * Null unless BOTH the person and the viewer have
     * `share_listening_activity` on, which is the design doc's reciprocal
     * activity tier. Recency is behavioural data, and nobody reads it without
     * exposing their own. Always null on the viewer's own row, which is only a
     * reference point for deltas.
     */
    listened_on: string | null;
}

/**
 * The book-level chapter table, shared by every listener.
 *
 * Chapters are NOT stored per user and no chapter index is persisted: the design
 * doc derives chapter from position against the book's own list, so this is read
 * once per request and applied to every row.
 */
export interface AudiobookChapterTable {
    /** ABS chapter entries in ABS's own units (SECONDS). Empty is normal. */
    chapters: AbsChapterInput[];
    /**
     * `custom_metadata.audiobookshelf.duration` in ms, or null when ABS never
     * reported one. Null happens: `media.duration` is absent from some ABS
     * payload shapes, which is how every book once ended up with a null runtime.
     */
    duration_ms: number | null;
}

// =============================================================================
// Queries
// =============================================================================

/**
 * Look up a media item's type and parent by UUID.
 * Used to detect episodes/seasons and walk up to the parent series.
 */
export async function getMediaTypeAndParent(
    sql: postgres.Sql,
    uuid: string,
): Promise<MediaTypeRow | null> {
    const rows = await sql<MediaTypeRow[]>`
        SELECT id, media_type, parent_id FROM media_items
        WHERE id = ${uuid} AND status = 'active'
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/**
 * Resolve an external provider ID to an internal media UUID.
 * Used when the social activity endpoint receives a composite key.
 */
export async function resolveExternalIdToMediaId(
    sql: postgres.Sql,
    externalId: string,
    mediaType: string,
): Promise<string | null> {
    const rows = await sql<ExternalIdMediaRow[]>`
        SELECT media_id FROM external_ids
        WHERE provider = ${getPrimaryExternalIdProvider()}
            AND external_id = ${externalId}
            AND media_type = ${mediaType}
        LIMIT 1
    `;
    return rows[0]?.media_id ?? null;
}

/**
 * Get all users who rated a media item, excluding the current user
 * and users with stream privacy enabled.
 */
export async function getRatedActivities(
    sql: postgres.Sql,
    mediaId: string,
    currentUser: UserId,
    limit: number = 10,
): Promise<RatedActivityRow[]> {
    return sql<RatedActivityRow[]>`
        SELECT DISTINCT ON (urv.user_id)
            urv.user_id,
            u_priv.username,
            urv.rating,
            urv.created_at,
            urv.rating_style
        FROM user_ratings urv
        JOIN users u_priv ON u_priv.id = urv.user_id
        WHERE urv.media_id = ${mediaId}
        AND urv.skipped IS NOT TRUE
        AND urv.user_id != ${currentUser}::uuid
        AND (u_priv.hide_streams IS NULL OR u_priv.hide_streams = false)
        ORDER BY urv.user_id, urv.created_at DESC
        LIMIT ${limit}
    `;
}

/**
 * Get all users who watched a media item, excluding the current user
 * and users with stream privacy enabled. Includes TV episode progress
 * from provider metadata for series.
 *
 * `mediaType` selects the progress columns, not the row filter — only `'tv'`
 * reads `episodes_watched`/`total_episodes`. Pass `'episode'` when `mediaId`
 * is a single episode: those counters live on the SERIES row, so reading them
 * against an episode would either return null or, worse, attribute the
 * series' progress to one episode.
 */
export async function getWatchedActivities(
    sql: postgres.Sql,
    mediaId: string,
    mediaType: 'movie' | 'tv' | 'episode',
    currentUser: UserId,
    limit: number = 10,
): Promise<WatchedActivityRow[]> {
    return sql<WatchedActivityRow[]>`
        SELECT DISTINCT ON (uwh.user_id)
            uwh.user_id,
            u_priv.username,
            uwh.last_watched_at as last_played_at,
            1 as play_count,
            CASE
                WHEN ${mediaType} = 'tv' THEN
                    (pm.metadata->>'episodes_watched')::integer
                ELSE NULL
            END as episodes_watched,
            CASE
                WHEN ${mediaType} = 'tv' THEN
                    (pm.metadata->>'total_episodes')::integer
                ELSE NULL
            END as total_episodes
        FROM user_media_state uwh
        JOIN media_items mi ON mi.id = uwh.media_id
        ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
        JOIN users u_priv ON u_priv.id = uwh.user_id
        WHERE uwh.media_id = ${mediaId}
        AND uwh.is_watched = true
        AND uwh.user_id != ${currentUser}::uuid
        AND (u_priv.hide_streams IS NULL OR u_priv.hide_streams = false)
        ORDER BY uwh.user_id, uwh.last_watched_at DESC NULLS LAST
        LIMIT ${limit}
    `;
}

// =============================================================================
// Audiobook listening activity (design doc §4.1 / §4.2)
// =============================================================================

/** Row shape as it comes off the wire, before the bigint/text reads are parsed. */
interface AudiobookListeningSqlRow {
    user_id: string;
    username: string;
    position_ms: number;
    duration_ms: number | null;
    is_finished: boolean;
    finished_recently: boolean;
    times_finished: number;
    listened_on: string | null;
}

/** Keep completed-listener timeline markers useful without making them permanent. */
const COMPLETED_MARKER_WINDOW_DAYS = 60;

export interface AudiobookListeningOptions {
    limit?: number;
    /** `'ambient'` or the reciprocal coarse `'activity'` tier. */
    tier?: SocialSharingTier;
    /** Designated circle override — tests and pre-resolved callers only. */
    trustGroups?: readonly string[];
    /** Audience mode override — tests and pre-resolved callers only. */
    audienceMode?: string;
}

/**
 * Everyone in the viewer's trust circle who has this book open or has finished it.
 *
 * This is the "mirror" of {@link getWatchedActivities} the design doc asks for,
 * and mirroring rather than relaxing is the whole point: `getWatchedActivities`
 * filters `is_watched = true`, and dropping that filter there would surface
 * "Anna is 20 minutes into this film" on every movie modal in the product.
 *
 * The row filter here is `resume_position_ms > 0 OR is_watched` — a row that
 * exists at position 0 and unfinished carries no information (a rating or a
 * dismissal can create it) and would render as a phantom "Anna is at 0%".
 *
 * Ordering is by recency of activity, which is read but NEVER selected: see
 * {@link AudiobookListeningRow}.
 */
export async function getAudiobookListeningActivities(
    sql: postgres.Sql,
    mediaId: string,
    viewerId: UserId,
    options: AudiobookListeningOptions = {},
): Promise<AudiobookListeningRow[]> {
    const visibility = buildSocialVisibilityFilter(sql, {
        viewerId,
        media: mediaId,
        subjectAlias: 'u_priv',
        tier: options.tier,
        trustGroups: options.trustGroups,
        audienceMode: options.audienceMode,
        audiobook: true,
    });

    const rows = await sql<AudiobookListeningSqlRow[]>`
        SELECT
            ums.user_id,
            u_priv.username,
            ums.resume_position_ms AS position_ms,
            ums.runtime_ms AS duration_ms,
            ums.is_watched AS is_finished,
            (
                ums.is_watched = true
                AND ums.last_watched_at >= NOW() - (${COMPLETED_MARKER_WINDOW_DAYS} * INTERVAL '1 day')
            ) AS finished_recently,
            ums.watch_count AS times_finished,
            -- Date-only, and only for the reciprocal activity tier. See
            -- AudiobookListeningRow.listened_on.
            CASE
                WHEN u_priv.share_listening_activity = true
                 AND EXISTS (
                     SELECT 1 FROM users vu_recency
                     WHERE vu_recency.id = ${viewerId}::uuid
                       AND vu_recency.share_listening_activity = true
                 )
                 AND GREATEST(ums.last_event_at, ums.last_watched_at) IS NOT NULL
                THEN GREATEST(ums.last_event_at, ums.last_watched_at)::date::text
            END AS listened_on
        FROM user_media_state ums
        JOIN users u_priv ON u_priv.id = ums.user_id
        WHERE ums.media_id = ${mediaId}::uuid
        AND (ums.resume_position_ms > 0 OR ums.is_watched = true)
        ${visibility}
        ORDER BY
            GREATEST(
                COALESCE(ums.last_event_at, 'epoch'::timestamptz),
                COALESCE(ums.last_watched_at, 'epoch'::timestamptz)
            ) DESC,
            u_priv.username ASC
        LIMIT ${options.limit ?? 10}
    `;
    return rows.map(normalizeListeningRow);
}

/**
 * The VIEWER's own position in the same book — the other half of shared-listen
 * detection (§4.2, *"du und Anna hört ihr gerade — sie ist 2 Kapitel weiter"*).
 *
 * Read separately and deliberately NOT through the predicate above: the predicate
 * excludes self (`subject.id <> viewer.id`), which is correct for the rows being
 * rendered and wrong for the reference point they are compared against. Folding
 * the viewer into the same result set would mean punching a hole in the shared
 * predicate for one caller — the exact shape that turns one guard into two.
 *
 * Nothing here is returned to the client on its own: it exists to compute a
 * relative delta. `username` comes back for symmetry with the row type only.
 */
export async function getOwnAudiobookListening(
    sql: postgres.Sql,
    mediaId: string,
    viewerId: UserId,
): Promise<AudiobookListeningRow | null> {
    const rows = await sql<AudiobookListeningSqlRow[]>`
        SELECT
            ums.user_id,
            u.username,
            ums.resume_position_ms AS position_ms,
            ums.runtime_ms AS duration_ms,
            ums.is_watched AS is_finished,
            (
                ums.is_watched = true
                AND ums.last_watched_at >= NOW() - (${COMPLETED_MARKER_WINDOW_DAYS} * INTERVAL '1 day')
            ) AS finished_recently,
            ums.watch_count AS times_finished,
            NULL::text AS listened_on
        FROM user_media_state ums
        JOIN users u ON u.id = ums.user_id
        WHERE ums.media_id = ${mediaId}::uuid
        AND ums.user_id = ${viewerId}::uuid
        LIMIT 1
    `;
    return rows[0] ? normalizeListeningRow(rows[0]) : null;
}

/**
 * The book's chapter list and total duration.
 *
 * Guarded on `media_type` so a misrouted caller reads nothing rather than
 * probing arbitrary `custom_metadata`. Access to the book itself is the route's
 * responsibility — see the module header.
 *
 * `duration` is read as TEXT behind a `jsonb_typeof` guard rather than cast in
 * SQL: a `::float` cast raises 22P02 for the whole statement if one row ever
 * holds `"12:34"`, and the parse belongs where a bad value can degrade to null.
 */
export async function getAudiobookChapterTable(
    sql: postgres.Sql,
    mediaId: string,
): Promise<AudiobookChapterTable | null> {
    const rows = await sql<{ chapters: unknown; duration_seconds: string | null }[]>`
        SELECT
            COALESCE(mi.custom_metadata #> '{audiobookshelf,chapters}', '[]'::jsonb) AS chapters,
            CASE
                WHEN jsonb_typeof(mi.custom_metadata #> '{audiobookshelf,duration}') = 'number'
                THEN mi.custom_metadata #>> '{audiobookshelf,duration}'
                ELSE NULL
            END AS duration_seconds
        FROM media_items mi
        WHERE mi.id = ${mediaId}::uuid
          AND lower(mi.media_type) = 'audiobook'
        LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;

    const seconds = row.duration_seconds === null ? Number.NaN : Number(row.duration_seconds);
    return {
        chapters: parseStoredChapters(row.chapters),
        duration_ms: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
    };
}

/**
 * Narrow untrusted jsonb to the two fields the chapter derivation reads.
 *
 * `custom_metadata` is operator- and connector-writable jsonb: it can legally be
 * an object, a string, or an array of anything. Entries without a numeric `start`
 * are dropped here for the same reason `projectAbsChapters` drops them — only
 * `start` is trusted downstream, and a run of defaulted zeros collapses every
 * later chapter behind the backward scan.
 */
function parseStoredChapters(value: unknown): AbsChapterInput[] {
    if (!Array.isArray(value)) return [];
    const out: AbsChapterInput[] = [];
    for (const entry of value) {
        if (!isRecord(entry)) continue;
        const start = entry.start;
        if (typeof start !== 'number' || !Number.isFinite(start)) continue;
        out.push({
            id: typeof entry.id === 'number' ? entry.id : null,
            title: typeof entry.title === 'string' ? entry.title : null,
            start,
            end: typeof entry.end === 'number' && Number.isFinite(entry.end) ? entry.end : null,
        });
    }
    return out;
}

/**
 * Coerce the numeric columns.
 *
 * `resume_position_ms` and `runtime_ms` are `bigint`, and postgres.js hands
 * bigints back as STRINGS unless a type parser is installed. One IS installed
 * (`connection.ts` and the integration harness both pass
 * `types: { bigint: bigintAsNumber }`), so these already arrive as numbers — but
 * the arithmetic downstream (`position - viewerPosition`) turns a string into
 * silent concatenation, and this integration's whole failure history is
 * correctly-typed reads of shapes that did not carry what the type claimed.
 * Coercing here costs nothing and makes the guarantee local.
 */
function normalizeListeningRow(row: AudiobookListeningSqlRow): AudiobookListeningRow {
    return {
        user_id: row.user_id,
        username: row.username,
        position_ms: toFiniteInt(row.position_ms, 0),
        duration_ms: row.duration_ms === null ? null : toFiniteInt(row.duration_ms, 0) || null,
        is_finished: row.is_finished === true,
        finished_recently: row.finished_recently === true,
        times_finished: toFiniteInt(row.times_finished, 0),
        listened_on: typeof row.listened_on === 'string' ? row.listened_on : null,
    };
}

function toFiniteInt(value: unknown, fallback: number): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}
