// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch State Query Module (UUID-based)
 *
 * Centralized queries for the unified user_media_state table.
 * This is the provider-agnostic watch state system that uses internal UUIDs.
 *
 * Key differences from watch-status.queries.ts:
 * - Uses media_id (UUID) instead of jellyfin_id
 * - Single table (user_media_state) for all media types
 * - Supports multiple sync sources (jellyfin, plex, emby, etc.)
 * - Tracks watch count and watch timestamps
 */

import { isAvailableExpr } from './availability.queries.js';
import { defineQuery } from '../typed-query.js';
import type { UserId } from '$lib/shared/user-id';
import type postgres from 'postgres';
import { EPISODE_ORDER_MULTIPLIER } from '$lib/server/utils/jellyfin-units.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import { buildAutoEpisodeOrderingJoinFragment } from './episode-search.queries.js';
import { buildOverrideAwareMetadataLateralJoinFragment } from './builders/provider-metadata.builder.js';
import {
    buildCompletionActivityAt,
    buildNextUpCompletionFilter,
    buildNextUpCandidateCtes,
} from './builders/next-up-candidates.builder.js';
import {
    buildMovedOnGateCtes,
    buildMovedOnKeepPredicate,
} from './builders/moved-on-gate.builder.js';
import type { AgeRatingFilterParams } from './builders/age-rating.builder.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildContinueWatchingCompletionFilter } from './builders/continue-watching.builder.js';
import { pgTextTimestamp } from './builders/keyset-cursor.builder.js';

// =============================================================================
// Types
// =============================================================================

export interface WatchStateRow {
    id: string;
    user_id: string;
    media_id: string;
    is_watched: boolean;
    resume_position_ms: number;
    runtime_ms: number | null;
    watch_count: number;
    last_watched_at: string | null;
    first_watched_at: string | null;
    last_event_at: string | null;
    /** D1: is_favorite column added by migration 16.103.0 — NULL treated as false. */
    is_favorite?: boolean | null;
}

// =============================================================================
// Read Queries
// =============================================================================

/**
 * Get watch state for a single media item
 */
export const getUserWatchState = defineQuery<{ userId: UserId; mediaId: string }, WatchStateRow>(
    'getUserWatchState',
    (sql, { userId, mediaId }) => sql`
        SELECT * FROM user_media_state
        WHERE user_id = ${userId} AND media_id = ${mediaId}
    `,
);

/**
 * Batch get watch states for multiple media items
 */
export const batchGetUserWatchStates = defineQuery<
    { userId: UserId; mediaIds: string[] },
    WatchStateRow
>(
    'batchGetUserWatchStates',
    (sql, { userId, mediaIds }) => sql`
        SELECT * FROM user_media_state
        WHERE user_id = ${userId} AND media_id = ANY(${mediaIds})
    `,
);

/** Watched state for one media id, with series episode progress when applicable. */
export interface BatchWatchedState {
    mediaId: string;
    /**
     * Movie: the `user_media_state.is_watched` flag.
     *
     * Series: the series' OWN `is_watched` flag, OR every active episode
     * watched. Both halves are needed and neither alone is right:
     *  - Episodes alone would regress an explicit "mark series watched" — prod
     *    has series rows flagged watched while the episode rollup reads 24/50
     *    (specials/unaired inflate the denominator, and Jellyfin sync sets the
     *    series flag directly). The detail modal already honours that flag, so
     *    ignoring it here would make the same series read watched in one screen
     *    and unwatched in another.
     *  - The flag alone would miss a series completed episode-by-episode, which
     *    never writes a series-level row.
     * A series with no episodes ingested and no flag is never "watched" — 0/0
     * would otherwise report as complete.
     */
    watched: boolean;
    /** Series only (null for movies). Active episodes across all active seasons. */
    totalEpisodes: number | null;
    /** Series only (null for movies). */
    watchedEpisodes: number | null;
}

/**
 * Batch watched state for an arbitrary list of media UUIDs — movies AND series
 * in ONE round trip.
 *
 * Distinct from {@link batchGetUserWatchStates}, which returns raw
 * `user_media_state` rows: a SERIES has no `user_media_state` row of its own
 * (only its episodes do), so that helper reports every series as unwatched.
 * This one rolls the episodes up.
 *
 * Distinct from {@link computeAllSeriesProgress}, which enumerates from the
 * watch-state side (only series the user has already touched) and so cannot
 * answer "what is the progress for THESE ids" — a never-started series must
 * still come back as 0/N, not as a missing row.
 *
 * ACCESS CONTROL: pure hydration for UUIDs the CALLER has already
 * access-filtered. Never call with ids taken straight from user input.
 *
 * @returns Map keyed by media id. Ids with no matching active media_item are absent.
 */
export async function batchGetWatchedState(
    sql: postgres.Sql,
    userId: UserId,
    mediaIds: string[],
): Promise<Map<string, BatchWatchedState>> {
    if (mediaIds.length === 0) return new Map();

    const rows = await sql<
        {
            media_id: string;
            media_type: string;
            is_watched: boolean;
            total_episodes: number;
            watched_episodes: number;
        }[]
    >`
        SELECT
            mi.id::text                          AS media_id,
            mi.media_type,
            COALESCE(ums.is_watched, false)      AS is_watched,
            COALESCE(ep.total_episodes, 0)       AS total_episodes,
            COALESCE(ep.watched_episodes, 0)     AS watched_episodes
        FROM media_items mi
        LEFT JOIN user_media_state ums
               ON ums.media_id = mi.id AND ums.user_id = ${userId}
        LEFT JOIN LATERAL (
            -- Episodes hang off SEASONS, not off the series directly:
            -- episode.parent_id -> season.id, season.parent_id -> series.id.
            SELECT COUNT(*)::int                                        AS total_episodes,
                   COUNT(*) FILTER (WHERE ep_ums.is_watched)::int       AS watched_episodes
            FROM media_items season
            JOIN media_items episode
              ON episode.parent_id = season.id
             AND episode.media_type = 'episode'
             AND episode.status = 'active'
            LEFT JOIN user_media_state ep_ums
              ON ep_ums.media_id = episode.id AND ep_ums.user_id = ${userId}
            WHERE season.parent_id = mi.id
              AND season.media_type = 'season'
              AND season.status = 'active'
              -- Skips the rollup entirely for movies.
              AND mi.media_type IN ('tv', 'series')
        ) ep ON true
        WHERE mi.id = ANY(${mediaIds}::uuid[])
          AND mi.status = 'active'
    `;

    const out = new Map<string, BatchWatchedState>();
    for (const row of rows) {
        const isSeries = row.media_type === 'tv' || row.media_type === 'series';
        out.set(row.media_id, {
            mediaId: row.media_id,
            watched: isSeries
                ? row.is_watched ||
                  (row.total_episodes > 0 && row.watched_episodes >= row.total_episodes)
                : row.is_watched,
            totalEpisodes: isSeries ? row.total_episodes : null,
            watchedEpisodes: isSeries ? row.watched_episodes : null,
        });
    }
    return out;
}

/**
 * Get items with resume positions (for continue watching)
 */
export const getResumePositions = defineQuery<{ userId: UserId }, WatchStateRow>(
    'getResumePositions',
    (sql, { userId }) => sql`
        SELECT * FROM user_media_state
        WHERE user_id = ${userId} AND resume_position_ms > 0
        ORDER BY last_event_at DESC
        LIMIT 2000
    `,
);

/**
 * Row shape returned by getWatchStateForProfile — compatible with
 * the watchHistory array that createEnhancedUserProfile expects.
 */
export interface WatchStateProfileRow {
    primary_id: string;
    media_type: string;
    title: string;
    play_count: number;
    resume_position_ms: number;
    runtime_ms: number | null;
}

/**
 * Get watched items with TMDB IDs for AI profile generation.
 * Reads from user_media_state + external_ids + media_items so that
 * the recommendation pipeline no longer depends on Jellyfin being available.
 */
export const getWatchStateForProfile = defineQuery<{ userId: UserId }, WatchStateProfileRow>(
    'getWatchStateForProfile',
    (sql, { userId }) => sql`
        SELECT
            ei.external_id AS primary_id,
            mi.media_type,
            mi.title,
            uws.watch_count AS play_count,
            uws.resume_position_ms,
            uws.runtime_ms
        FROM user_media_state uws
        JOIN media_items mi ON mi.id = uws.media_id
        JOIN external_ids ei ON ei.media_id = uws.media_id
            AND ei.provider = ${getPrimaryExternalIdProvider()}
        WHERE uws.user_id = ${userId}
            AND uws.is_watched = true
            AND mi.media_type IN ('movie', 'tv')
        ORDER BY uws.last_watched_at DESC NULLS LAST
        LIMIT 700
    `,
);

/**
 * Count watched movie/tv items for a user that ACTUALLY have an embedding.
 *
 * Used as a cheap gate to decide whether a watch-based profile can be built
 * without fetching all embeddings up front. The `EXISTS media_embeddings` check
 * is essential: counting watched items that have no embedding would pass the
 * gate but then yield a null profile (those items contribute nothing to the
 * centroid), leaving the user with broken recommendations.
 */
export async function countWatchedEmbeddableItems(
    sql: postgres.Sql,
    userId: UserId,
): Promise<number> {
    const [row] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text AS count
        FROM user_media_state uws
        JOIN media_items mi ON mi.id = uws.media_id
        WHERE uws.user_id = ${userId}
          AND uws.is_watched = true
          AND mi.media_type IN ('movie', 'tv')
          AND EXISTS (
              SELECT 1 FROM media_embeddings me WHERE me.media_id = mi.id
          )
    `;
    return Number.parseInt(row?.count ?? '0', 10);
}

// =============================================================================
// Write Queries
// =============================================================================

// =============================================================================
// UUID-Centric Read Queries (for local-first watch state)
// =============================================================================

/**
 * Audit row shape — a wider view of rows that could or do appear in
 * Continue Watching. Used by the admin audit page to run row invariants.
 */
export interface CWAuditRow {
    user_id: string;
    media_id: string;
    media_type: string;
    title: string;
    is_watched: boolean;
    resume_position_ms: number;
    runtime_ms: number | null;
    last_event_at: string;
    series_id: string | null;
    season_number: number | null;
    episode_number: number | null;
}

/**
 * Audit query: every in-progress row across all users that is a candidate
 * for Continue Watching (has any resume position + not explicitly watched).
 * Wider than the production CW filter so we can detect drift that the
 * production filter would silently hide.
 */
export const getCwAuditRows = defineQuery<{ limit: number }, CWAuditRow>(
    'getCwAuditRows',
    (sql, { limit }) => sql`
        SELECT
            uws.user_id,
            uws.media_id,
            mi.media_type,
            mi.title,
            uws.is_watched,
            LEAST(uws.resume_position_ms, 2147483647)::integer AS resume_position_ms,
            CASE
                WHEN uws.runtime_ms IS NULL THEN NULL
                ELSE LEAST(uws.runtime_ms, 2147483647)::integer
            END AS runtime_ms,
            uws.last_event_at,
            grandparent_mi.id AS series_id,
            mi.season_number,
            mi.episode_number
        FROM user_media_state uws
        JOIN media_items mi ON mi.id = uws.media_id
        LEFT JOIN media_items parent_mi ON parent_mi.id = mi.parent_id
        LEFT JOIN media_items grandparent_mi ON grandparent_mi.id = parent_mi.parent_id
        WHERE uws.resume_position_ms > 0
          AND uws.is_watched = false
        ORDER BY uws.last_event_at DESC
        LIMIT ${limit}
    `,
);

/**
 * Row shape for continue watching items (movies + episodes with resume position)
 */
export interface ContinueWatchingRow {
    media_id: string;
    media_type: string;
    has_files: boolean;
    title: string;
    // Synopsis of the watched item (episode overview for episodes, movie
    // overview for movies). Mirrors NextUpRow.overview so the hero section
    // shows a description when a mid-watched series surfaces as a CW row
    // (CW wins the hero dedup over its next-up counterpart).
    overview: string | null;
    /** Connector-owned metadata, including AudiobookShelf authors/narrators. */
    custom_metadata?: Record<string, unknown> | null;
    resume_position_ms: number;
    runtime_ms: number | null;
    last_event_at: string;
    // Source of the latest event behind this state row. Null when the row
    // pre-dates the event log (e.g. legacy backfill). Used by the suspicion
    // UI so a legitimate lumastra-player progress event inside a bulk-mark
    // time window does not get falsely flagged as bulk-synced.
    last_event_source: string | null;
    // Episode context
    parent_id: string | null;
    // Series UUID (grandparent of episodes). Null for movies.
    // Used as the per-series dedup/anchor key in buildMergedWatchingSection.
    series_id: string | null;
    series_name: string | null;
    season_number: number | null;
    episode_number: number | null;
    // External IDs (supplementary, for images)
    tmdb_id: string | null;
    imdb_id: string | null;
    /**
     * Pre-computed effective sort date — `GREATEST(last_event_at,
     * premiere_date, MAX(last_watched_at) within the parent season)` —
     * folded in from `getSmartSortDatesFromDb` so callers don't make a
     * second roundtrip. Always populated (epoch fallback when nothing else
     * is set). Stable across reruns.
     */
    sort_date: string;
}

/**
 * Get continue watching items from local DB.
 * Returns movies and episodes with resume positions, ordered by last updated.
 */
export const getContinueWatchingFromDb = defineQuery<
    {
        userId: UserId;
        limit: number;
        minMs: number;
        minPercent: number;
        /**
         * Drop CW rows whose last_event_at is older than this many days.
         * 0 disables the cutoff. Only meaningful once external sync writes
         * occurred_at = real LastPlayedDate (otherwise pulls keep last_event_at
         * fresh on stale rows and the cutoff would catch nothing).
         */
        maxAgeDays: number;
        /**
         * Collapse to one row per series before the LIMIT.
         *
         * True for normal callers: `limit` then means "N distinct shows" and a
         * single noisy series cannot starve the rail.
         *
         * FALSE when the caller applies an access boundary (denied library
         * groups / age cap) AFTER this query. That filter runs per media_id in
         * TS, so if the collapse had already reduced a series to a single
         * representative and that representative is the denied one, the whole
         * series would vanish from Continue Watching instead of falling back to
         * an accessible sibling episode. Returning the uncollapsed set lets the
         * downstream TS fold pick a representative from what survives the
         * boundary. Such callers should over-fetch to offset the lost collapse.
         */
        collapsePerSeries: boolean;
        /**
         * Restrict to episodes of one series (the series UUID). Season-0
         * specials are dropped under this filter: a special must never be a
         * series watch marker, while the unfiltered rail still shows them. An
         * episode without a season number counts as main line.
         * Null/omitted leaves the rail behaviour unchanged.
         */
        seriesId?: string | null;
    },
    ContinueWatchingRow
>(
    'getContinueWatchingFromDb',
    (sql, { userId, limit, minMs, minPercent, maxAgeDays, collapsePerSeries, seriesId }) => sql`
        WITH
        -- ── Stage 1: candidates ───────────────────────────────────────────
        -- Every filter here is row-local or a single indexed point-probe, so
        -- this stage stays cheap no matter how many in-progress rows the user
        -- has accumulated. The two expensive things the old single-CTE shape
        -- did per row — the stale-resume correlated subplan and the
        -- season_lwa aggregate over the user's ENTIRE watched history — now
        -- run in stages 2 and 4 against a bounded row set.
        --
        -- Perf history: this query used to do all of it in one base CTE
        -- evaluated before any LIMIT, costing ~12-16ms per in-progress row.
        -- A user with 465 such rows spent ~5.8s to emit 10 cards. Keep the
        -- staging: any filter added here must be row-local or index-backed,
        -- and anything needing a correlated scan belongs in stage 2 or later.
        candidates AS (
            SELECT
                uws.media_id,
                uws.user_id,
                uws.is_watched,
                mi.media_type,
                mi.title,
                mi.has_files,
                mi.overview,
                mi.custom_metadata,
                mi.premiere_date,
                uws.resume_position_ms,
                uws.runtime_ms,
                uws.last_event_at,
                uws.last_event_source,
                uws.highest_session_elapsed_ms,
                mi.parent_id,
                parent_mi.title AS parent_title,
                grandparent_mi.id AS grandparent_id,
                grandparent_mi.title AS grandparent_title,
                parent_mi.id AS parent_mi_id,
                COALESCE(eo.order_season_number, mi.season_number) AS season_number,
                COALESCE(eo.order_episode_number, mi.episode_number) AS episode_number,
                -- Raw stored numbers, carried ALONGSIDE the effective ones on
                -- purpose. The stale-resume gate (stage 2) guards on
                -- mi.season_number IS NOT NULL / mi.episode_number IS NOT
                -- NULL — the RAW values — while comparing positions using the
                -- effective ones. Collapsing the two would change which rows
                -- are exempt from suppression whenever an ordering supplies a
                -- number the stored row lacks (and would silently un-exempt
                -- movies, which have neither).
                mi.season_number AS raw_season_number,
                mi.episode_number AS raw_episode_number,
                -- Coalesce stored runtime with the longest probed file duration
                -- (fallback for legacy rows where runtime wasn't recorded at session start).
                COALESCE(
                    NULLIF(uws.runtime_ms, 0),
                    mi.runtime_seconds * 1000,
                    (
                        SELECT ROUND(mf.duration_seconds * 1000)::bigint
                        FROM media_files mf
                        JOIN media_file_items mfi ON mfi.file_id = mf.id
                        WHERE mfi.media_item_id = mi.id
                          AND mf.duration_seconds IS NOT NULL
                          AND mf.duration_seconds > 0
                        ORDER BY mf.duration_seconds DESC
                        LIMIT 1
                    )
                )::bigint AS effective_runtime_ms
            FROM user_media_state uws
            JOIN media_items mi ON mi.id = uws.media_id
            LEFT JOIN media_items parent_mi ON parent_mi.id = mi.parent_id
            LEFT JOIN media_items grandparent_mi ON grandparent_mi.id = parent_mi.parent_id
            ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi', 'parent_mi.parent_id')}
            WHERE uws.user_id = ${userId}
              AND (
                  ${seriesId ?? null}::uuid IS NULL
                  OR (
                      grandparent_mi.id = ${seriesId ?? null}::uuid
                      AND COALESCE(eo.order_season_number, mi.season_number, 1) <> 0
                  )
              )
              AND uws.resume_position_ms > 0
              AND ${buildContinueWatchingCompletionFilter(sql)}
              AND mi.media_type NOT IN (
                  'music', 'audio', 'podcast', 'track', 'album', 'artist',
                  -- Live channels and live TV streams have currentTime
                  -- mapped to wall-clock; resume_position_ms is meaningless
                  -- on them. Drop from CW so a live session doesn't
                  -- surface as a resumable row.
                  'channel', 'livetv', 'live',
                  -- Extras (trailers/featurettes) are playable items but must
                  -- never surface as Continue Watching cards.
                  'extra'
              )
              -- Only rows with the canonical file signal can be played. A
              -- retained provider ID does not prove a playable file exists.
              AND mi.has_files = true
              -- Exclude items the user has dismissed from Continue Watching.
              -- For episodes: target_id is the series UUID (grandparent_mi.id).
              -- For movies: target_id is the movie's own UUID (mi.id).
              -- target_id is TEXT (migration 16.108.0) but 'dismissed_cw' rows
              -- always hold a UUID, so the cast is safe; the flag_type guard
              -- keeps composite-key ('request_dismissed') rows out of the cast.
              AND NOT EXISTS (
                  SELECT 1 FROM user_media_flags f
                  WHERE f.user_id = ${userId}
                    AND f.flag_type = 'dismissed_cw'
                    AND f.target_id::uuid = COALESCE(grandparent_mi.id, mi.id)
              )
              -- Hard age cutoff: drop rows whose most recent event predates
              -- the configured max-age window. Guards against multi-month-old
              -- "in progress" items the user has clearly abandoned (e.g. a
              -- one-time scrub on Jellyfin from 2024 that the pull has
              -- faithfully kept reporting). 0 disables the cutoff entirely.
              -- maxAgeDays is only effective once watch-sync writes
              -- occurred_at = real LastPlayedDate; otherwise every pull keeps
              -- last_event_at fresh.
              AND (
                  ${maxAgeDays} = 0
                  OR uws.last_event_at IS NULL
                  OR uws.last_event_at >= NOW() - (${maxAgeDays} || ' days')::interval
              )
        ),
        -- ── Stage 1b: thresholds + score ──────────────────────────────────
        -- Split out of candidates only because SQL cannot reference a
        -- SELECT-list alias (effective_runtime_ms) from the same level's
        -- WHERE. Semantically this is still the cheap stage — every predicate
        -- is row-local arithmetic. Applying it BEFORE the stale-resume gate
        -- shrinks the gate's input; applying it before the LIMIT is required
        -- for correctness (these are filters, not enrichment).
        ranked AS (
            SELECT
                candidates.*,
                (
                    -- Depth × recency score. Floats stale shallow rows (abandoned after
                    -- one episode) below deep recent ones without a hard cliff.
                    --
                    -- depth_ratio: how far through the episode the user got (0.0–1.0).
                    -- Unknown depth gets 0.1 so legacy rows still sort ahead of true
                    -- zero-engagement entries.
                    --
                    -- days_elapsed: sqrt-decay so a show paused for 10 days doesn't
                    -- fall off a cliff — real users come back after a week or two.
                    -- Floor at 0.1 avoids division-by-zero for events in the last
                    -- ~2.4 hours (0.1 day).
                    CASE
                        WHEN candidates.effective_runtime_ms > 0
                             AND candidates.highest_session_elapsed_ms IS NOT NULL
                        THEN LEAST(
                            candidates.highest_session_elapsed_ms::float / candidates.effective_runtime_ms,
                            1.0
                        )
                        ELSE 0.1
                    END
                    /
                    GREATEST(
                        SQRT(
                            EXTRACT(EPOCH FROM (NOW() - candidates.last_event_at)) / 86400.0
                        ),
                        0.1
                    )
                ) AS sort_score,
                -- Collapse key, computed once as a column on purpose. Inlining
                -- this CASE into both the DISTINCT ON and the ORDER BY makes
                -- postgres.js bind the parameter TWICE, so Postgres sees two
                -- textually-distinct expressions and rejects the query with
                -- "SELECT DISTINCT ON expressions must match initial ORDER BY
                -- expressions". One column, referenced twice, keeps them equal.
                CASE
                    WHEN ${collapsePerSeries}
                        THEN COALESCE(candidates.grandparent_id, candidates.media_id)
                    ELSE candidates.media_id
                END AS collapse_key
            FROM candidates
            WHERE
                -- Upper bound: hide items past the runtime-aware completion
                -- threshold (safety net for sync paths that skipped
                -- applyAutoCompleteFromProgress). Tiers MUST stay in sync with
                -- completionThresholdFor() in watch-constants.ts AND the
                -- hand-mirrored copy in jellyfin-browse.queries.ts (the /j
                -- Resume surface). That is TWO other places, not the three this
                -- comment used to claim: migration 12.42.0's copy was a one-shot
                -- backfill and the <=16.228 squash absorbed it, and /j filters
                -- media_type IN (movie, episode) so the audiobook branch
                -- below is deliberately not mirrored there. Items with unknown
                -- runtime fall through; the lower-bound branches below clamp
                -- them with a 5-minute floor.
                (
                    candidates.effective_runtime_ms IS NULL
                    OR candidates.effective_runtime_ms <= 0
                    OR candidates.resume_position_ms::float / candidates.effective_runtime_ms < CASE
                        -- Audiobooks: an ABSOLUTE 2-minute window, not a
                        -- percentage. The ladder below tops out at 150 minutes;
                        -- applied to a 20h57m book its 0.96 tier evicted one
                        -- with 44m38s left to listen. Mirrors
                        -- AUDIOBOOK_FINISH_REMAINING_MS. The runtime guard keeps
                        -- a garbage-short runtime from producing a <=0 threshold
                        -- that would hide a book at position 0.
                        WHEN LOWER(candidates.media_type) = 'audiobook'
                             AND candidates.effective_runtime_ms > 120000
                            THEN (candidates.effective_runtime_ms - 120000)::float
                                 / candidates.effective_runtime_ms
                        WHEN candidates.effective_runtime_ms < 90 * 60 * 1000  THEN 0.90
                        WHEN candidates.effective_runtime_ms < 150 * 60 * 1000 THEN 0.95
                        ELSE 0.96
                      END
                )
                -- Lower bound: both the configured time and percentage are
                -- required when runtime is known. Engagement confirms that a
                -- player session was real, but is intentionally not an
                -- alternative eligibility path: a minute of a feature-length
                -- movie rounds to 0% in the UI and is a peek, not a resume.
                AND (
                    -- Position + percent (when runtime is known).
                    (
                        candidates.resume_position_ms > ${minMs}
                        AND candidates.effective_runtime_ms IS NOT NULL
                        AND candidates.effective_runtime_ms > 0
                        AND candidates.resume_position_ms::float / candidates.effective_runtime_ms > ${minPercent / 100.0}
                    )
                    OR
                    -- Legacy: 5-minute floor when runtime is unknown.
                    (
                        (candidates.effective_runtime_ms IS NULL OR candidates.effective_runtime_ms <= 0)
                        AND candidates.resume_position_ms > 300000
                    )
                    OR
                    -- Audiobooks: the percentage gate above assumes a
                    -- feature-length runtime. A 10-20h audiobook needs 1-2h of
                    -- real listening to clear 10%, so a book a user just
                    -- started never appears. Book apps treat "has a resume
                    -- position past the noise floor" as started; use the same
                    -- flat time floor as the unknown-runtime branch instead of
                    -- scaling with runtime.
                    (
                        LOWER(candidates.media_type) = 'audiobook'
                        AND candidates.resume_position_ms > ${minMs}
                    )
                )
        ),
        -- ── Stage 2: moved-on suppression (set-based) ─────────────────────
        -- Drop an episode the user has moved on from: a later episode was
        -- since completed, or any other episode was since played to its end
        -- (moved-on-gate.builder.ts, shared with /j Resume). The later-episode
        -- half is the original stale-resume gate. Without this gate, an ancient pause at
        -- S3E2 keeps surfacing in CW even after the user finished S5E1, while
        -- Next Up correctly advances to S5E2 — two competing rows for the same
        -- show. The is_watched=false filter in stage 1 already hides S5E1 (the
        -- completed one), so its existence has to be probed separately.
        --
        -- This was a correlated NOT EXISTS evaluated once per in-progress row,
        -- and it was THE bottleneck: a 5-table subplan (user_media_state ×
        -- media_items × media_items × series_episode_ordering ×
        -- episode_orderings) per row. It is now one restricted scan over the
        -- watched episodes of the candidate series only, joined set-wise. The
        -- predicate is logically identical — see the position/timestamp
        -- comparison below, which is the same comparison, hoisted.
        --
        -- Exactness note: this is NOT a top-N approximation. Every candidate
        -- is still gated, so no row can be wrongly dropped or wrongly kept by
        -- ranking. Do not "optimise" this into a LIMIT-then-gate shape — the
        -- LIMIT belongs after the gate (stage 3), not before it.
        cand_series AS (
            SELECT grandparent_id AS series_id, MIN(last_event_at) AS min_clock
            FROM ranked
            WHERE grandparent_id IS NOT NULL
            GROUP BY grandparent_id
        ),
        ${buildMovedOnGateCtes(sql, userId)},
        -- ── Stage 3: gate + rank + LIMIT ──────────────────────────────────
        -- The LIMIT lands HERE, so everything downstream (season_lwa, the
        -- external_ids LATERAL) runs against at most limit rows instead of
        -- the user's entire in-progress set.
        gated AS (
            -- Per-series collapse happens HERE, before the LIMIT, so the limit
            -- means "N distinct shows" rather than "N episode rows".
            --
            -- This fold also exists downstream in TS (section-builder's
            -- cwBySeries / the overlay's pickFreshestDurable), but that runs
            -- AFTER this LIMIT — so one show with many in-progress episodes
            -- could take every slot and starve every other show off the rail
            -- entirely. Observed in prod: 10 rows collapsing to 3 cards, with a
            -- single series holding 8 of them. That is the "I get no suggestion
            -- at all" report — a starved rail, not a missing anchor.
            --
            -- The TS folds stay (they still have to merge the live overlay);
            -- they are simply idempotent now.
            --
            -- Representative = most recent activity, which is exactly the
            -- tiebreak the TS fold applies (updatedAt desc), so the episode
            -- shown for a series is unchanged — only the starvation is fixed.
            SELECT per_series.*
            FROM (
                SELECT DISTINCT ON (ranked.collapse_key)
                    ranked.*
                FROM ranked
                WHERE
                -- Moved-on gate (shared with the /j Resume feed, see
                -- moved-on-gate.builder.ts). Re-watch exemption for the
                -- later-episode half: a row reaching here with is_watched=true
                -- passed the re-watch surface check in stage 1
                -- (last_event_at > last_watched_at), so it IS the user's
                -- current engagement, and an unrelated mark-watched on a later
                -- episode (the finale marked mid-rewatch) must not drop it. The
                -- finished-by-playback half still applies: only a real viewing
                -- of another episode to its end counts there.
                --
                -- Movies and rows with no stored numbering are never
                -- suppressible by the later-episode half; the original gate
                -- expressed this via mi.season_number IS NOT NULL AND
                -- mi.episode_number IS NOT NULL inside the NOT EXISTS.
                ${buildMovedOnKeepPredicate(sql, {
                    seriesId: sql`ranked.grandparent_id`,
                    mediaId: sql`ranked.media_id`,
                    clock: sql`ranked.last_event_at`,
                    effSeason: sql`ranked.season_number`,
                    effEpisode: sql`ranked.episode_number`,
                    laterGateApplies: sql`(
                        ranked.is_watched = false
                        AND ranked.raw_season_number IS NOT NULL
                        AND ranked.raw_episode_number IS NOT NULL
                    )`,
                })}
                -- Tiebreak mirrors compareDurableForAnchor in
                -- live-watching-overlay.ts (the TS fold this replaces):
                -- last_event_at desc, then season-aware episode order desc
                -- (S2E2 beats S1E10 — usually the later engagement), then
                -- media_id asc for absolute determinism.
                --
                -- Ties are not hypothetical: sync writes stamp several rows of
                -- one series with an IDENTICAL last_event_at, and unknown-runtime
                -- rows all share the default depth ratio, so sort_score ties too.
                -- Postgres guarantees no ordering past what ORDER BY
                -- disambiguates, so without the full chain the representative
                -- episode could both flap between identical requests AND differ
                -- from what the TS fold used to pick.
                ORDER BY
                    ranked.collapse_key,
                    ranked.last_event_at DESC NULLS LAST,
                    ranked.season_number DESC NULLS LAST,
                    ranked.episode_number DESC NULLS LAST,
                    ranked.media_id
            ) per_series
            -- Same reasoning one level up: a tie here decides which SERIES
            -- makes the rail at all when the tie straddles the LIMIT boundary.
            ORDER BY
                per_series.sort_score DESC,
                per_series.last_event_at DESC NULLS LAST,
                per_series.media_id
            LIMIT ${limit}
        ),
        -- ── Stage 4: enrichment (survivors only) ──────────────────────────
        -- Aggregate the most recent completion per season for the smart-sort
        -- fold below. Mirrors the season-level aggregation that lived in the
        -- old getSmartSortDatesFromDb (column was misnamed series_id but
        -- the GROUP BY was on mi.parent_id == season). Limiting to is_watched
        -- episodes matches the original "previousWatchedDate" semantics.
        --
        -- GROUP BY is on the SEASON (mi.parent_id), not the series — the
        -- historical misname is preserved deliberately; "fixing" it to
        -- series-level changes strip ordering.
        --
        -- Restricted to the seasons that actually survived the gate. It used
        -- to aggregate the user's ENTIRE watched history (10k+ rows for a
        -- heavy user) to produce a sort_date for a handful of cards.
        --
        -- Legacy fallback: rows backfilled before migration 12.44.0 may have
        -- last_watched_at NULL even with is_watched=true. COALESCE keeps such
        -- seasons from sorting at strip-bottom by falling through to the row's
        -- first_watched_at (always populated post-12.44.0) and finally to
        -- last_event_at — the post-12.44.0 stand-in for the legacy
        -- user_watch_state.updated_at heartbeat. Same chain the migration
        -- uses to seed last_watched_at.
        season_lwa AS (
            SELECT mi.parent_id AS season_id,
                   MAX(COALESCE(
                       uws.last_watched_at,
                       uws.first_watched_at,
                       uws.last_event_at
                   )) AS max_lwa
            FROM user_media_state uws
            JOIN media_items mi ON mi.id = uws.media_id
            WHERE uws.user_id = ${userId}
              AND uws.is_watched = true
              AND mi.media_type = 'episode'
              AND mi.parent_id IS NOT NULL
              AND mi.parent_id IN (SELECT parent_id FROM gated WHERE parent_id IS NOT NULL)
            GROUP BY mi.parent_id
        )
        SELECT
            gated.media_id,
            gated.media_type,
            gated.has_files,
            gated.title,
            gated.overview,
            gated.custom_metadata,
            -- Clamp at PG INTEGER max (~596h in ms) to defend against
            -- corrupted or replay-attack heartbeat rows that wrote oversized
            -- bigint values into uws.resume_position_ms / uws.runtime_ms.
            -- Without the clamp the cast raises and the whole query fails
            -- per-user, leaving an empty continue-watching list.
            LEAST(gated.resume_position_ms, 2147483647)::integer AS resume_position_ms,
            LEAST(gated.effective_runtime_ms, 2147483647)::integer AS runtime_ms,
            gated.last_event_at,
            gated.last_event_source,
            gated.parent_id,
            gated.grandparent_id AS series_id,
            -- For episodes: parent_mi = season, grandparent_mi = series (tv show)
            -- Use grandparent title (series name) when available, fall back to parent title
            COALESCE(gated.grandparent_title, gated.parent_title) AS series_name,
            gated.season_number,
            gated.episode_number,
            ext.tmdb_id,
            ext.imdb_id,
            -- Smart-sort fold: previously a second roundtrip via
            -- getSmartSortDatesFromDb + TS-side GREATEST. Now inline so the
            -- caller doesn't need to enrich after fetch. PG GREATEST skips
            -- NULL operands; final COALESCE pins a stable epoch fallback so
            -- callers can sort without a null guard.
            --
            -- premiere_date is a DATE; AT TIME ZONE 'UTC' anchors it at UTC
            -- midnight regardless of session TimeZone. Without this cast,
            -- a non-UTC deployment (e.g. TZ=Europe/Berlin) would interpret
            -- the date in local time and shift sort positions by hours
            -- relative to the timestamptz signals.
            COALESCE(
                GREATEST(
                    gated.last_event_at,
                    (gated.premiere_date::timestamp AT TIME ZONE 'UTC'),
                    season_lwa.max_lwa
                ),
                'epoch'::timestamptz
            ) AS sort_date
        FROM gated
        LEFT JOIN season_lwa ON season_lwa.season_id = gated.parent_id
        -- Single LATERAL probe per row pulls the (media_id, provider) external_ids
        -- for the episode + series anchor in one bitmap scan, replacing four
        -- correlated point-lookups. tmdb_id/imdb_id fall back to the episode's
        -- own media_id for movies (no parent).
        LEFT JOIN LATERAL (
            SELECT
                MAX(ei.external_id) FILTER (
                    WHERE ei.media_id = COALESCE(gated.grandparent_id, gated.parent_mi_id, gated.media_id)
                      AND ei.provider = ${getPrimaryExternalIdProvider()}
                ) AS tmdb_id,
                MAX(ei.external_id) FILTER (
                    WHERE ei.media_id = COALESCE(gated.grandparent_id, gated.parent_mi_id, gated.media_id)
                      AND ei.provider = 'imdb'
                ) AS imdb_id
            FROM external_ids ei
            WHERE ei.media_id = COALESCE(gated.grandparent_id, gated.parent_mi_id, gated.media_id)
              AND ei.provider IN (${getPrimaryExternalIdProvider()}, 'imdb')
        ) ext ON TRUE
        -- Tiebreak here too, not just inside the gated CTE. That one makes rail
        -- MEMBERSHIP deterministic; this one makes the returned ORDER
        -- deterministic. Without it, rows tied on sort_score can come back in
        -- a different order for identical requests, and pickHeroLead rotates
        -- over this array by seed — so an SSR/client tie-flap could change the
        -- hero slide mid-hydration.
        ORDER BY
            gated.sort_score DESC,
            gated.last_event_at DESC NULLS LAST,
            gated.media_id
    `,
);

/**
 * Row shape for next up items (next unwatched episode per series)
 */
export interface NextUpRow {
    media_id: string;
    has_files: boolean;
    title: string;
    season_number: number;
    episode_number: number;
    runtime_seconds: number | null;
    premiere_date: string | null;
    overview: string | null;
    parent_id: string; // season UUID (episode.parent_id)
    series_id: string | null; // series UUID (season.parent_id)
    series_name: string | null;
    series_tmdb_id: string | null;
    series_imdb_id: string | null;
    last_watched_at: string | null;
    // Source of the previous episode's completion. Null when the row
    // pre-dates the event log. Used by the suspicion UI so a legitimate
    // lumastra-player completion inside a bulk-mark window doesn't get
    // falsely flagged as bulk-synced.
    last_event_source: string | null;
    /**
     * Pre-computed effective sort date — `GREATEST(anchor.last_watched_at,
     * mi.premiere_date)` — folded in from `getSmartSortDatesFromDb`. Always
     * populated (epoch fallback when nothing else is set).
     */
    sort_date: string;
    /** Backdrop blurhash of the episode's series/backdrop row, for hero LQIP. Null when not yet computed. */
    backdrop_blurhash: string | null;
    /**
     * Trailer URL resolved from the SERIES row's provider_metadata
     * (`metadata->>'trailer_url'`). The hero shows the series backdrop for an
     * episode, so the series trailer is the correct one to play. Null when the
     * series has no stored trailer.
     */
    trailer_url: string | null;
}

/**
 * Get next up episodes from local DB.
 * For each series the user has watched episodes of, find the next unwatched episode.
 */
export const getNextUpFromDb = defineQuery<
    { userId: UserId; limit: number; maxAgeDays: number },
    NextUpRow
>(
    'getNextUpFromDb',
    (sql, { userId, limit, maxAgeDays }) => sql`
        ${buildNextUpCandidateCtes(sql, { userId, maxAgeDays })}
        SELECT
            ne.media_id,
            mi.has_files,
            mi.title,
            ne.season_number,
            ne.episode_number,
            mi.runtime_seconds,
            mi.premiere_date,
            mi.overview,
            mi.parent_id,
            ne.series_id,
            ne.last_watched_at,
            ne.last_event_source,
            series_mi.title AS series_name,
            ext.series_tmdb_id,
            ext.series_imdb_id,
            -- Smart-sort fold: anchor's last_watched_at is the
            -- "previousWatchedDate" signal; premiere_date covers
            -- newly-aired episodes (where the user finished the prior
            -- episode long ago but the series should still rise on a
            -- fresh release). PG GREATEST skips NULLs; epoch fallback
            -- mirrors the CW query so callers can sort without a guard.
            -- premiere_date AT TIME ZONE 'UTC' anchors deterministically
            -- regardless of session TimeZone (matches CW query).
            COALESCE(
                GREATEST(
                    ne.last_watched_at,
                    (mi.premiere_date::timestamp AT TIME ZONE 'UTC')
                ),
                'epoch'::timestamptz
            ) AS sort_date,
            COALESCE(series_mi.backdrop_blurhash, mi.backdrop_blurhash) AS backdrop_blurhash,
            -- Trailer belongs to the SERIES (hero shows the series backdrop for
            -- an episode), resolved from the series row's provider_metadata via
            -- the override-aware lateral join keyed on series_mi.id.
            (pm.metadata->>'trailer_url')::text AS trailer_url
        FROM next_up_candidates ne
        JOIN media_items mi ON mi.id = ne.media_id
        LEFT JOIN media_items series_mi ON series_mi.id = ne.series_id
        ${buildOverrideAwareMetadataLateralJoinFragment(sql, undefined, 'series_mi.id', 'series_mi.preferred_provider')}
        -- Single LATERAL probe per result row pulls external IDs for the episode
        -- and its series in one index scan, replacing four correlated subqueries.
        LEFT JOIN LATERAL (
            SELECT
                MAX(ei.external_id) FILTER (
                    WHERE ei.media_id = ne.series_id AND ei.provider = ${getPrimaryExternalIdProvider()}
                ) AS series_tmdb_id,
                MAX(ei.external_id) FILTER (
                    WHERE ei.media_id = ne.series_id AND ei.provider = 'imdb'
                ) AS series_imdb_id
            FROM external_ids ei
            WHERE ei.media_id = ne.series_id
              AND ei.provider IN (${getPrimaryExternalIdProvider()}, 'imdb')
        ) ext ON TRUE
        ORDER BY ne.last_watched_at DESC NULLS LAST
        LIMIT ${limit}
    `,
);

/**
 * Get next up for a single series (by series UUID).
 * Returns the first unwatched episode after the user's last watched episode.
 */
export const getNextUpForSeriesFromDb = defineQuery<
    { seriesMediaId: string; userId: UserId },
    {
        media_id: string;
        title: string;
        season_number: number;
        episode_number: number;
        overview: string | null;
        runtime_seconds: number | null;
        premiere_date: string | null;
        has_files: boolean;
    }
>(
    'getNextUpForSeriesFromDb',
    (sql, { seriesMediaId, userId }) => sql`
        WITH recent_watched AS (
            -- Same anchor model as getNextUpFromDb: most-recently-watched
            -- main-line episode (specials excluded). Ties on
            -- last_watched_at (e.g. bulk mark, single-instant migration
            -- backfill) break by order DESC so the finale wins — for
            -- a fully-watched series that produces no next, dropping
            -- the series from Next Up entirely. Migration rows are
            -- trusted as anchor candidates: their last_watched_at is
            -- COALESCE(legacy.last_watched_at, first_watched_at,
            -- updated_at), so non-uniform per-row timestamps reflect
            -- the user's real Jellyfin watch dates and uniform
            -- timestamps fall back to the order-DESC tiebreak.
            SELECT
                (COALESCE(eo.order_season_number, mi.season_number) * ${EPISODE_ORDER_MULTIPLIER}
                 + COALESCE(eo.order_episode_number, mi.episode_number)) AS recent_order,
                ${buildCompletionActivityAt(sql, userId, sql`uws.media_id`, sql`uws.last_watched_at`)} AS completed_activity_at
            FROM user_media_state uws
            JOIN media_items mi ON mi.id = uws.media_id
            JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
            ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi')}
            WHERE uws.user_id = ${userId}
              AND uws.is_watched = true
              AND season.parent_id = ${seriesMediaId}
              AND mi.media_type = 'episode'
              AND (seo.media_id IS NULL OR eo.episode_media_id IS NOT NULL)
              AND COALESCE(eo.order_season_number, mi.season_number) > 0
            ORDER BY
                -- Same bulk-migration deprioritization as the home strip
                -- query: a 3+ row cluster sharing one last_watched_at is
                -- a bulk-import wall-clock signature; let real timestamps
                -- (whether non-migration or per-row migration) anchor
                -- first. Falls through to bulk when no other candidate
                -- exists in window.
                CASE
                    WHEN COALESCE(uws.last_event_source, '') = 'migration'
                         AND COUNT(*) OVER (
                             PARTITION BY uws.last_watched_at
                         ) >= 3
                    THEN 1 ELSE 0
                END ASC,
                uws.last_watched_at DESC NULLS LAST,
                (COALESCE(eo.order_season_number, mi.season_number) * ${EPISODE_ORDER_MULTIPLIER}
                 + COALESCE(eo.order_episode_number, mi.episode_number)) DESC
            LIMIT 1
        )
        SELECT
            mi.id AS media_id,
            mi.title,
            COALESCE(eo.order_season_number, mi.season_number) AS season_number,
            COALESCE(eo.order_episode_number, mi.episode_number) AS episode_number,
            mi.overview,
            mi.runtime_seconds,
            mi.premiere_date,
            mi.has_files
        FROM media_items mi
        JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
        ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi')}
        LEFT JOIN recent_watched rw ON true
        WHERE season.parent_id = ${seriesMediaId}
          AND mi.media_type = 'episode'
          AND COALESCE(eo.order_season_number, mi.season_number) > 0
          -- Older completions remain eligible during a re-watch. The
          -- completion-activity filter below skips newly received watched
          -- marks even when their provider watch date predates the anchor.
          AND (rw.recent_order IS NULL OR (COALESCE(eo.order_season_number, mi.season_number) * ${EPISODE_ORDER_MULTIPLIER} + COALESCE(eo.order_episode_number, mi.sort_order, mi.episode_number)) > rw.recent_order)
          -- Exclude ordering segments (unmapped episodes when ordering is active)
          AND (seo.media_id IS NULL OR eo.episode_media_id IS NOT NULL)
          -- Skip episodes the user can't actually play yet: pre-aired
          -- metadata stubs and orphans without the canonical file signal.
          -- Mirrors the home-strip query so
          -- /watch/[seriesId], the per-series next-episode API, and the
          -- modal context route never propose a phantom that won't play.
          AND mi.has_files = true
          AND (rw.recent_order IS NULL OR ${buildNextUpCompletionFilter(sql, userId, sql`rw.completed_activity_at`)})
          -- Respect CW dismissals: mirrors the filter already applied by
          -- the home-strip and Next Up list queries.
          AND NOT EXISTS (
              SELECT 1 FROM user_media_flags f
              WHERE f.user_id = ${userId}
                AND f.flag_type = 'dismissed_cw'
                AND f.target_id = ${seriesMediaId}
          )
        ORDER BY COALESCE(eo.order_season_number, mi.season_number), COALESCE(eo.order_episode_number, mi.sort_order, mi.episode_number)
        LIMIT 1
    `,
);

/**
 * Get the first episode of a series (for unstarted series).
 */
export const getFirstEpisodeForSeries = defineQuery<
    { seriesMediaId: string },
    {
        media_id: string;
        title: string;
        season_number: number;
        episode_number: number;
        overview: string | null;
        runtime_seconds: number | null;
        premiere_date: string | null;
    }
>(
    'getFirstEpisodeForSeries',
    (sql, { seriesMediaId }) => sql`
        SELECT
            mi.id AS media_id,
            mi.title,
            COALESCE(eo.order_season_number, mi.season_number) AS season_number,
            COALESCE(eo.order_episode_number, mi.episode_number) AS episode_number,
            mi.overview,
            mi.runtime_seconds,
            mi.premiere_date
        FROM media_items mi
        JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
        ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi')}
        WHERE season.parent_id = ${seriesMediaId}
          AND mi.media_type = 'episode'
          AND COALESCE(eo.order_season_number, mi.season_number) > 0
          -- Exclude ordering segments (unmapped episodes when ordering is active)
          AND (seo.media_id IS NULL OR eo.episode_media_id IS NOT NULL)
        ORDER BY COALESCE(eo.order_season_number, mi.season_number), COALESCE(eo.order_episode_number, mi.sort_order, mi.episode_number)
        LIMIT 1
    `,
);

/**
 * Get next up for a single season (by season UUID).
 * Returns the first unwatched episode in this season after the user's last watched episode.
 */
export const getNextUpForSeasonFromDb = defineQuery<
    { seasonMediaId: string; userId: UserId },
    {
        media_id: string;
        title: string;
        season_number: number;
        episode_number: number;
        overview: string | null;
        runtime_seconds: number | null;
        premiere_date: string | null;
    }
>(
    'getNextUpForSeasonFromDb',
    (sql, { seasonMediaId, userId }) => sql`
        WITH max_watched AS (
            SELECT MAX(COALESCE(eo.order_episode_number, mi.episode_number)) AS max_order
            FROM user_media_state uws
            JOIN media_items mi ON mi.id = uws.media_id
            JOIN media_items season ON season.id = mi.parent_id
            ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi')}
            WHERE uws.user_id = ${userId}
              AND uws.is_watched = true
              AND mi.parent_id = ${seasonMediaId}
              AND mi.media_type = 'episode'
              AND (seo.media_id IS NULL OR eo.episode_media_id IS NOT NULL)
        )
        SELECT
            mi.id AS media_id,
            mi.title,
            COALESCE(eo.order_season_number, mi.season_number) AS season_number,
            COALESCE(eo.order_episode_number, mi.episode_number) AS episode_number,
            mi.overview,
            mi.runtime_seconds,
            mi.premiere_date
        FROM media_items mi
        JOIN media_items season ON season.id = mi.parent_id
        ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi')}
        CROSS JOIN max_watched mw
        LEFT JOIN user_media_state uws
            ON uws.media_id = mi.id
            AND uws.user_id = ${userId}
            AND uws.is_watched = true
        WHERE mi.parent_id = ${seasonMediaId}
          AND mi.media_type = 'episode'
          AND uws.media_id IS NULL
          AND (mw.max_order IS NULL OR COALESCE(eo.order_episode_number, mi.sort_order, mi.episode_number) > mw.max_order)
          AND (seo.media_id IS NULL OR eo.episode_media_id IS NOT NULL)
        ORDER BY COALESCE(eo.order_episode_number, mi.sort_order, mi.episode_number)
        LIMIT 1
    `,
);

/**
 * Get the first episode of a season (for unstarted seasons).
 */
export const getFirstEpisodeForSeason = defineQuery<
    { seasonMediaId: string },
    {
        media_id: string;
        title: string;
        season_number: number;
        episode_number: number;
        overview: string | null;
        runtime_seconds: number | null;
        premiere_date: string | null;
    }
>(
    'getFirstEpisodeForSeason',
    (sql, { seasonMediaId }) => sql`
        SELECT
            mi.id AS media_id,
            mi.title,
            COALESCE(eo.order_season_number, mi.season_number) AS season_number,
            COALESCE(eo.order_episode_number, mi.episode_number) AS episode_number,
            mi.overview,
            mi.runtime_seconds,
            mi.premiere_date
        FROM media_items mi
        JOIN media_items season ON season.id = mi.parent_id
        ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi')}
        WHERE mi.parent_id = ${seasonMediaId}
          AND mi.media_type = 'episode'
          AND (seo.media_id IS NULL OR eo.episode_media_id IS NOT NULL)
        ORDER BY COALESCE(eo.order_episode_number, mi.sort_order, mi.episode_number)
        LIMIT 1
    `,
);

/**
 * Get watched episode keys for filtering (used by upcoming/new-episodes routes).
 * Returns series_name + season/episode so routes can match against Sonarr calendar data.
 */
export const getWatchedEpisodeKeys = defineQuery<
    { userId: UserId },
    { series_name: string; season_number: number; episode_number: number }
>(
    'getWatchedEpisodeKeys',
    (sql, { userId }) => sql`
        SELECT
            LOWER(series_mi.title) AS series_name,
            COALESCE(eo.order_season_number, mi.season_number) AS season_number,
            COALESCE(eo.order_episode_number, mi.episode_number) AS episode_number
        FROM user_media_state uws
        JOIN media_items mi ON mi.id = uws.media_id
        JOIN media_items season_mi ON season_mi.id = mi.parent_id AND season_mi.media_type = 'season'
        JOIN media_items series_mi ON series_mi.id = season_mi.parent_id
        ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi', 'season_mi.parent_id')}
        WHERE uws.user_id = ${userId}
          AND uws.is_watched = true
          AND mi.media_type = 'episode'
          AND series_mi.title IS NOT NULL
    `,
);

/**
 * Get watched series names from user_media_state (for filtering upcoming/new-episodes).
 *
 * Access filters drop series the user can no longer access (e.g. policy
 * changed after the rows were written). Without this, the upcoming /
 * new-episodes routes would still surface Sonarr calendar entries for
 * restricted-library series the user once watched. `series_mi` is the
 * series row, and it is the row this query RETURNS, so the library axis uses
 * the container-aware rule from `buildLibraryAccessFilter` — judge a `tv` row
 * by its season -> episode descendants' files plus its own
 * `library_group_id`. The predicate used to be inlined here as
 * `NOT EXISTS (files owned by series_mi.id) OR ...`; no `tv` row owns
 * `media_file_items` (0 of 6,570 on production, 2026-09-15), so that first arm
 * was ALWAYS true and the library axis did nothing. The age filter still
 * applies to the series' own age_rating.
 */
export const getWatchedSeriesFromDb = defineQuery<
    {
        userId: UserId;
        deniedGroupIds: string[] | null;
        ageRating: AgeRatingFilterParams | null;
    },
    { series_name: string; parent_id: string }
>(
    'getWatchedSeriesFromDb',
    (sql, { userId, deniedGroupIds, ageRating }) => sql`
        SELECT DISTINCT
            LOWER(series_mi.title) AS series_name,
            season_mi.parent_id
        FROM user_media_state uws
        JOIN media_items mi ON mi.id = uws.media_id
        JOIN media_items season_mi ON season_mi.id = mi.parent_id AND season_mi.media_type = 'season'
        JOIN media_items series_mi ON series_mi.id = season_mi.parent_id
        WHERE uws.user_id = ${userId}
          AND uws.is_watched = true
          AND mi.media_type = 'episode'
          AND series_mi.title IS NOT NULL
          ${buildLibraryAccessFilter(sql, deniedGroupIds, 'series_mi')}
          ${
              ageRating && ageRating.maxAgeRating !== null
                  ? sql`AND (
                (series_mi.age_rating IS NULL AND ${ageRating.allowUnrated}::boolean)
                OR series_mi.age_rating <= ${ageRating.maxAgeRating}
            )`
                  : sql``
          }
    `,
);

/**
 * Series the user explicitly follows (`series_episode_notifications` flag),
 * shaped like {@link getWatchedSeriesFromDb} and behind the same library / age
 * boundary — a follow on a series the user can no longer open lists nothing.
 */
export const getFollowedSeriesFromDb = defineQuery<
    {
        userId: UserId;
        deniedGroupIds: string[] | null;
        ageRating: AgeRatingFilterParams | null;
    },
    { series_name: string }
>(
    'getFollowedSeriesFromDb',
    (sql, { userId, deniedGroupIds, ageRating }) => sql`
        SELECT DISTINCT LOWER(series_mi.title) AS series_name
        FROM user_media_flags f
        -- CASE keeps the cast from ever seeing a non-UUID target_id (other flag
        -- types store composite keys), while still letting the join use the PK.
        JOIN media_items series_mi
          ON series_mi.id = CASE
                 WHEN f.target_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 THEN f.target_id::uuid
             END
         AND series_mi.media_type = 'tv'
        WHERE f.user_id = ${userId}
          AND f.flag_type = 'series_episode_notifications'
          AND (f.expires_at IS NULL OR f.expires_at > NOW())
          AND series_mi.title IS NOT NULL
          ${buildLibraryAccessFilter(sql, deniedGroupIds, 'series_mi')}
          ${
              ageRating && ageRating.maxAgeRating !== null
                  ? sql`AND (
                (series_mi.age_rating IS NULL AND ${ageRating.allowUnrated}::boolean)
                OR series_mi.age_rating <= ${ageRating.maxAgeRating}
            )`
                  : sql``
          }
    `,
);

/**
 * Get watched status batch by TMDB composite keys.
 * Resolves TMDB IDs → UUIDs, then checks user_media_state.
 */
export async function getWatchedStatusBatchFromDb(
    sql: postgres.Sql,
    userId: UserId,
    items: Array<{ tmdbId: number; mediaType: string }>,
): Promise<Map<string, boolean>> {
    if (items.length === 0) {
        return new Map();
    }

    // Build a lookup for composite keys
    const tmdbIds = items.map((i) => String(i.tmdbId));
    const mediaTypes = [...new Set(items.map((i) => i.mediaType))];

    // Resolve TMDB IDs to UUIDs and check watch state in one query
    const rows = await sql<{ tmdb_id: string; media_type: string }[]>`
        SELECT ei.external_id AS tmdb_id, ei.media_type
        FROM user_media_state uws
        JOIN external_ids ei ON ei.media_id = uws.media_id AND ei.provider = ${getPrimaryExternalIdProvider()}
        WHERE uws.user_id = ${userId}
          AND uws.is_watched = true
          AND ei.external_id = ANY(${tmdbIds})
          AND ei.media_type = ANY(${mediaTypes})
    `;

    const result = new Map<string, boolean>();
    for (const row of rows) {
        result.set(`${row.tmdb_id}:${row.media_type}`, true);
    }
    return result;
}

/**
 * Get all watched TMDB IDs for a user (for filtering recommendations).
 * Returns watched movies by their own TMDB ID, and watched series by the series TMDB ID.
 * An episode being watched counts towards its parent series.
 */
export async function getWatchedTmdbIdsFromDb(
    sql: postgres.Sql,
    userId: UserId,
): Promise<Array<{ tmdb_id: number; media_type: string }>> {
    const rows = await sql<{ tmdb_id: string; media_type: string }[]>`
        -- Watched movies (media_type = 'movie')
        SELECT DISTINCT ei.external_id AS tmdb_id, mi.media_type
        FROM user_media_state uws
        JOIN media_items mi ON mi.id = uws.media_id
        JOIN external_ids ei ON ei.media_id = uws.media_id AND ei.provider = ${getPrimaryExternalIdProvider()}
        WHERE uws.user_id = ${userId}
          AND uws.is_watched = true
          AND mi.media_type = 'movie'

        UNION

        -- Watched series (via episodes → season → series TMDB ID, reported as 'tv')
        SELECT DISTINCT ei.external_id AS tmdb_id, 'tv' AS media_type
        FROM user_media_state uws
        JOIN media_items mi ON mi.id = uws.media_id AND mi.media_type = 'episode'
        JOIN media_items season_mi ON season_mi.id = mi.parent_id AND season_mi.media_type = 'season'
        JOIN external_ids ei ON ei.media_id = season_mi.parent_id AND ei.provider = ${getPrimaryExternalIdProvider()}
        WHERE uws.user_id = ${userId}
          AND uws.is_watched = true
          AND season_mi.parent_id IS NOT NULL
    `;

    return rows
        .filter((r) => /^\d+$/.test(r.tmdb_id))
        .map((r) => ({
            tmdb_id: Number.parseInt(r.tmdb_id),
            media_type: r.media_type,
        }));
}

/**
 * Get all watched media UUIDs for a user (for filtering recommendations).
 * Uses media_id directly — no external_ids join needed, works for any provider.
 * Returns watched movies and TV series UUIDs (episodes roll up to their parent series).
 */
export async function getWatchedMediaUuidsFromDb(
    sql: postgres.Sql,
    userId: UserId,
): Promise<string[]> {
    const rows = await sql<{ media_id: string }[]>`
        -- Directly watched movies and series
        SELECT DISTINCT media_id
        FROM user_media_state
        WHERE user_id = ${userId}
          AND is_watched = true

        UNION

        -- Series that have watched episodes (episode → season → series rollup)
        SELECT DISTINCT series_mi.id AS media_id
        FROM user_media_state uws
        JOIN media_items mi ON mi.id = uws.media_id AND mi.media_type = 'episode'
        JOIN media_items season_mi ON season_mi.id = mi.parent_id AND season_mi.media_type = 'season'
        JOIN media_items series_mi ON series_mi.id = season_mi.parent_id AND series_mi.media_type = 'tv'
        WHERE uws.user_id = ${userId}
          AND uws.is_watched = true
    `;
    return rows.map((r) => r.media_id);
}

// =============================================================================
// Computed Series Progress (replaces user_series_progress table)
// =============================================================================

/**
 * Compute series progress from user_media_state at read time.
 * Replaces the old user_series_progress denormalized table.
 */
export async function computeSeriesProgress(
    sql: postgres.Sql,
    userId: UserId,
    seriesMediaId: string,
): Promise<{
    series_media_id: string;
    watched_episodes: number;
    total_episodes: number;
    completion_status: 'not_started' | 'in_progress' | 'completed';
    current_season: number | null;
    current_episode: number | null;
    current_episode_media_id: string | null;
    last_watched_at: string | null;
    first_watched_at: string | null;
} | null> {
    const rows = await sql<
        {
            series_media_id: string;
            watched_episodes: number;
            total_episodes: number;
            completion_status: 'not_started' | 'in_progress' | 'completed';
            last_watched_at: string | null;
            first_watched_at: string | null;
            current_episode_media_id: string | null;
            current_episode_number: number | null;
            current_season_number: number | null;
        }[]
    >`
        WITH episode_stats AS (
            SELECT
                ep.id AS episode_id,
                ep.episode_number,
                season.season_number,
                uws.is_watched,
                uws.last_watched_at,
                uws.first_watched_at
            FROM media_items ep
            JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
            LEFT JOIN user_media_state uws ON uws.media_id = ep.id AND uws.user_id = ${userId}::uuid
            WHERE season.parent_id = ${seriesMediaId}::uuid
              AND ep.media_type = 'episode'
              AND ep.status = 'active'
        ),
        aggregate AS (
            SELECT
                COALESCE(COUNT(*) FILTER (WHERE is_watched = true), 0)::int AS watched_episodes,
                COUNT(episode_id)::int AS total_episodes,
                MAX(last_watched_at) FILTER (WHERE is_watched = true) AS last_watched_at,
                MIN(first_watched_at) FILTER (WHERE is_watched = true) AS first_watched_at
            FROM episode_stats
        ),
        last_watched_episode AS (
            SELECT DISTINCT ON (1)
                1 AS grp,
                episode_id,
                episode_number,
                season_number
            FROM episode_stats
            WHERE is_watched = true
            ORDER BY 1, last_watched_at DESC NULLS LAST
        )
        SELECT
            ${seriesMediaId}::text AS series_media_id,
            a.watched_episodes,
            a.total_episodes,
            CASE
                WHEN a.watched_episodes = 0 THEN 'not_started'
                WHEN a.watched_episodes >= a.total_episodes THEN 'completed'
                ELSE 'in_progress'
            END AS completion_status,
            a.last_watched_at,
            a.first_watched_at,
            lwe.episode_id AS current_episode_media_id,
            lwe.episode_number AS current_episode_number,
            lwe.season_number AS current_season_number
        FROM aggregate a
        LEFT JOIN last_watched_episode lwe ON true
    `;

    if (!rows.length || rows[0].total_episodes === 0) return null;

    const row = rows[0];

    return {
        series_media_id: seriesMediaId,
        watched_episodes: row.watched_episodes,
        total_episodes: row.total_episodes,
        completion_status: row.completion_status,
        current_season: row.current_season_number ?? null,
        current_episode: row.current_episode_number ?? null,
        current_episode_media_id: row.current_episode_media_id ?? null,
        last_watched_at: row.last_watched_at,
        first_watched_at: row.first_watched_at,
    };
}

/**
 * Decoded keyset cursor for `computeAllSeriesProgress` — mirrors the
 * `(last_watched_at DESC NULLS LAST, series_media_id DESC)` ordering.
 *
 * `lastWatchedAt` is the raw `last_watched_at::text` rendering (micro precision
 * preserved) OR `null` for a row in the NULL group (Gate D2b carries — never
 * excludes — series a user has started but not finished, which key NULL on the
 * `MAX(...) FILTER (is_watched=true)` aggregate). `seriesMediaId` is the unique
 * tiebreak within an equal (or NULL) `last_watched_at` group.
 */
export interface SeriesProgressCursor {
    lastWatchedAt: string | null;
    seriesMediaId: string;
}

/**
 * Paging mode for `computeAllSeriesProgress`. A discriminated union so a caller
 * cannot ambiguously pass both an offset and a cursor — offset and keyset paging
 * are mutually exclusive per request. Cursor mode is only used for the default
 * `sort='last_watched'` (Gate B1); the def rejects a cursor under other sorts.
 */
export type SeriesProgressPage =
    { mode: 'offset'; offset: number } | { mode: 'cursor'; cursor: SeriesProgressCursor };

/**
 * Compute series progress for all series a user has watched episodes of.
 * Used by GET /api/user/series endpoint.
 */
export async function computeAllSeriesProgress(
    sql: postgres.Sql,
    userId: UserId,
    options?: {
        availableOnly?: boolean;
        status?: 'not_started' | 'in_progress' | 'completed';
        limit?: number;
        sort?: 'last_watched' | 'progress' | 'name';
        page?: SeriesProgressPage;
    },
): Promise<
    Array<{
        series_media_id: string;
        series_name: string;
        total_seasons: number | null;
        watched_episodes: number;
        total_episodes: number;
        progress_pct: number;
        completion_status: string;
        current_season: number | null;
        current_episode: number | null;
        last_watched_at: string | null;
        first_watched_at: string | null;
        /**
         * `last_watched_at::text` — the raw Postgres rendering (micro precision),
         * never the parsed `Date`, so a keyset cursor minted from it does not
         * truncate to milliseconds and skip a row watched within the same
         * millisecond as the boundary. Only consumed by the cursor def; kept a
         * bare string.
         */
        last_watched_at_cursor?: string;
    }>
> {
    const limit = options?.limit ?? 50;
    const page: SeriesProgressPage = options?.page ?? { mode: 'offset', offset: 0 };

    // Gate D2b keyset predicate. Ordering is `last_watched_at DESC NULLS LAST,
    // series_media_id DESC`, so "rows strictly after the cursor" splits on which
    // group the cursor sits in:
    //  - cursor in the non-NULL group → all non-NULL rows tuple-less-than the
    //    cursor, PLUS the entire NULL group (NULLS LAST puts it after every
    //    non-NULL row). pgTextTimestamp() pins the bind OID to TEXT so the
    //    micro-precision string is parsed server-side, not truncated through a
    //    JS Date (see keyset-cursor.builder.ts).
    //  - cursor in the NULL group → NULL rows with a smaller series_media_id
    //    (the NULL group is ordered by series_media_id DESC); non-NULL rows never
    //    follow a NULL cursor.
    const cursorPredicate =
        page.mode === 'cursor'
            ? page.cursor.lastWatchedAt === null
                ? sql`sws.last_watched_at IS NULL AND sws.series_media_id < ${page.cursor.seriesMediaId}::uuid`
                : sql`(
                      (sws.last_watched_at IS NOT NULL
                       AND (sws.last_watched_at, sws.series_media_id)
                           < (${pgTextTimestamp(sql, page.cursor.lastWatchedAt)}::timestamptz, ${page.cursor.seriesMediaId}::uuid))
                      OR sws.last_watched_at IS NULL
                  )`
            : null;

    const rows = await sql<
        {
            series_media_id: string;
            series_name: string;
            total_seasons: number | null;
            watched_episodes: number;
            total_episodes: number;
            progress_pct: number;
            completion_status: string;
            current_season: number | null;
            current_episode: number | null;
            last_watched_at: string | null;
            first_watched_at: string | null;
            last_watched_at_cursor?: string;
        }[]
    >`
        WITH series_stats AS (
            SELECT
                series.id as series_media_id,
                series.title as series_name,
                COALESCE(COUNT(*) FILTER (WHERE uws.is_watched = true), 0)::int as watched_episodes,
                COUNT(DISTINCT ep.id)::int as total_episodes,
                MAX(uws.last_watched_at) FILTER (WHERE uws.is_watched = true) as last_watched_at,
                MIN(uws.first_watched_at) FILTER (WHERE uws.is_watched = true) as first_watched_at
            FROM media_items series
            JOIN media_items season ON season.parent_id = series.id AND season.media_type = 'season'
            JOIN media_items ep ON ep.parent_id = season.id AND ep.media_type = 'episode' AND ep.status = 'active'
            LEFT JOIN user_media_state uws ON uws.media_id = ep.id AND uws.user_id = ${userId}::uuid
            WHERE series.media_type IN ('tv', 'series')
              AND series.status = 'active'
              ${options?.availableOnly ? sql`AND ${isAvailableExpr(sql, sql`series.id`)} AND series.is_dismissed = false AND ${isAvailableExpr(sql, sql`ep.id`)} AND ep.is_dismissed = false` : sql``}
              AND EXISTS (
                  SELECT 1 FROM user_media_state uws2
                  JOIN media_items ep2 ON ep2.id = uws2.media_id AND ep2.media_type = 'episode'
                  JOIN media_items s2 ON s2.id = ep2.parent_id
                  WHERE s2.parent_id = series.id AND uws2.user_id = ${userId}::uuid
              )
            GROUP BY series.id, series.title
        ),
        series_with_stats AS (
            SELECT
                ss.*,
                (SELECT COUNT(DISTINCT season.season_number)::int FROM media_items season WHERE season.parent_id = ss.series_media_id AND season.media_type = 'season') as total_seasons,
                CASE WHEN ss.total_episodes > 0 THEN ROUND(ss.watched_episodes::numeric / ss.total_episodes * 100) ELSE 0 END as progress_pct,
                CASE
                    WHEN ss.watched_episodes = 0 THEN 'not_started'
                    WHEN ss.watched_episodes >= ss.total_episodes THEN 'completed'
                    ELSE 'in_progress'
                END as completion_status
            FROM series_stats ss
        ),
        series_current_episode AS (
            SELECT DISTINCT ON (s2.parent_id)
                s2.parent_id as series_media_id,
                ep2.season_number as current_season,
                ep2.episode_number as current_episode
            FROM user_media_state uws2
            JOIN media_items ep2 ON ep2.id = uws2.media_id AND ep2.media_type = 'episode'
            JOIN media_items s2 ON s2.id = ep2.parent_id AND s2.media_type = 'season'
            WHERE uws2.user_id = ${userId}::uuid
              AND uws2.is_watched = true
            ORDER BY s2.parent_id, uws2.last_watched_at DESC NULLS LAST
        )
        SELECT
            sws.series_media_id::text,
            sws.series_name,
            sws.total_seasons,
            sws.watched_episodes,
            sws.total_episodes,
            sws.progress_pct,
            sws.completion_status,
            sce.current_season,
            sce.current_episode,
            sws.last_watched_at,
            sws.last_watched_at::text AS last_watched_at_cursor,
            sws.first_watched_at
        FROM series_with_stats sws
        LEFT JOIN series_current_episode sce ON sce.series_media_id = sws.series_media_id
        ${
            options?.status && cursorPredicate
                ? sql`WHERE sws.completion_status = ${options.status} AND ${cursorPredicate}`
                : options?.status
                  ? sql`WHERE sws.completion_status = ${options.status}`
                  : cursorPredicate
                    ? sql`WHERE ${cursorPredicate}`
                    : sql``
        }
        ORDER BY ${
            page.mode === 'cursor'
                ? // Cursor mode is last_watched only (Gate B1); add the unique
                  // series_media_id tiebreak. This tiebreak is CURSOR-BRANCH-ONLY —
                  // the offset ORDER BY below is left byte-identical to today.
                  sql`sws.last_watched_at DESC NULLS LAST, sws.series_media_id DESC`
                : options?.sort === 'name'
                  ? sql`sws.series_name ASC`
                  : options?.sort === 'progress'
                    ? sql`sws.progress_pct DESC`
                    : sql`sws.last_watched_at DESC NULLS LAST`
        }
        ${
            page.mode === 'cursor'
                ? sql`LIMIT ${limit + 1}`
                : sql`LIMIT ${limit} OFFSET ${page.offset}`
        }
    `;

    return rows;
}

// =============================================================================
// D1 Favorite queries (migration 16.103.0)
// =============================================================================

/**
 * Read the `is_favorite` flag from `user_media_state` for a single media item.
 * Returns `false` when there is no row or the column is NULL.
 *
 * Used by GET /api/v1/watch-state/{id}.
 */
export async function getUserMediaFavorite(
    sql: postgres.Sql,
    userId: UserId,
    mediaId: string,
): Promise<boolean> {
    const rows = await sql<{ is_favorite: boolean | null }[]>`
        SELECT is_favorite
        FROM user_media_state
        WHERE user_id = ${userId}
          AND media_id = ${mediaId}::uuid
        LIMIT 1
    `;
    return rows[0]?.is_favorite ?? false;
}

/**
 * Upsert the `is_favorite` flag in `user_media_state`.
 *
 * Creates a minimal row if none exists (is_watched=false, resume=0, count=0).
 * On conflict only updates `is_favorite` and `last_event_at` — never overwrites
 * `is_watched`, `resume_position_ms`, or `watch_count`.
 *
 * Used by PUT /api/v1/watch-state/{id} when `favorite` is provided.
 */
export async function setUserMediaFavorite(
    sql: postgres.Sql,
    userId: UserId,
    mediaId: string,
    isFavorite: boolean,
): Promise<void> {
    await sql`
        INSERT INTO user_media_state (
            user_id, media_id,
            is_watched, is_favorite,
            resume_position_ms, watch_count,
            last_event_at
        )
        VALUES (
            ${userId}, ${mediaId}::uuid,
            false, ${isFavorite},
            0, 0,
            NOW()
        )
        ON CONFLICT (user_id, media_id) DO UPDATE SET
            is_favorite   = EXCLUDED.is_favorite,
            last_event_at = EXCLUDED.last_event_at
    `;
}

// =============================================================================
// Series watch marker helpers
// =============================================================================

/** Ordering-aware identity of an episode, as the series watch marker compares it. */
export interface EpisodeOrderKeyRow {
    id: string;
    title: string;
    /** Effective season number (episode ordering first, stored number otherwise). */
    season_number: number;
    /** Effective episode number (episode ordering first, stored number otherwise). */
    episode_number: number;
    /**
     * Same key next-up orders by:
     * `season * EPISODE_ORDER_MULTIPLIER + COALESCE(order_episode, sort_order, episode)`.
     */
    order_key: number;
    series_id: string;
}

/**
 * Order key, effective numbering and series of each given episode id. Ids that
 * are not episodes under a season are absent from the result. A missing
 * season number reads as season 1 (main line, never a special) and a missing
 * episode number as 0, so the key is never NULL.
 */
export const getEpisodeOrderKeys = defineQuery<{ ids: string[] }, EpisodeOrderKeyRow>(
    'getEpisodeOrderKeys',
    (sql, { ids }) => sql`
        SELECT
            mi.id,
            mi.title,
            COALESCE(eo.order_season_number, mi.season_number, 1)::int AS season_number,
            COALESCE(eo.order_episode_number, mi.episode_number, 0)::int AS episode_number,
            (
                COALESCE(eo.order_season_number, mi.season_number, 1) * ${EPISODE_ORDER_MULTIPLIER}
                + COALESCE(eo.order_episode_number, mi.sort_order, mi.episode_number, 0)
            )::float8 AS order_key,
            season.parent_id AS series_id
        FROM media_items mi
        JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
        ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi')}
        WHERE mi.id = ANY(${ids}::uuid[])
          AND mi.media_type = 'episode'
    `,
);

/**
 * True when two DIFFERENT media items are backed by at least one common media
 * file (a combined multi-episode file): moving between them is a seek, not a
 * navigation.
 */
export async function episodesShareFile(
    sql: postgres.Sql,
    fromMediaId: string,
    otherMediaId: string,
): Promise<boolean> {
    if (fromMediaId === otherMediaId) return false;
    const rows = await sql<Array<{ shared: boolean }>>`
        SELECT EXISTS (
            SELECT 1
            FROM media_file_items a
            JOIN media_file_items b ON a.file_id = b.file_id
            WHERE a.media_item_id = ${fromMediaId}::uuid
              AND b.media_item_id = ${otherMediaId}::uuid
        ) AS shared
    `;
    return rows[0]?.shared === true;
}

/** Watch summary over a series' playable main-line episodes. */
export interface SeriesMainlineWatchSummary {
    total_episodes: number;
    watched_episodes: number;
    /**
     * Furthest watched main-line episode in episode order (not the most
     * recent watch, which a rewatch of an early episode would move back), or
     * null when none is watched.
     */
    last_watched_episode_id: string | null;
    /** Most recent watch time across the watched main-line episodes. */
    last_watched_at: Date | string | null;
}

/**
 * Main-line (effective season > 0) playable episodes of a series and how many
 * the user has watched. Unlike `computeSeriesProgress` this ignores specials
 * and unplayable stubs (no file and no Jellyfin link), so a series whose
 * available main line is fully watched reads as finished even while specials
 * or not-yet-available episodes remain.
 */
export const getSeriesMainlineWatchSummary = defineQuery<
    { userId: UserId; seriesId: string },
    SeriesMainlineWatchSummary
>(
    'getSeriesMainlineWatchSummary',
    (sql, { userId, seriesId }) => sql`
        WITH eps AS (
            SELECT
                mi.id,
                COALESCE(uws.is_watched, false) AS is_watched,
                uws.last_watched_at,
                (
                    COALESCE(eo.order_season_number, mi.season_number, 1) * ${EPISODE_ORDER_MULTIPLIER}
                    + COALESCE(eo.order_episode_number, mi.sort_order, mi.episode_number, 0)
                ) AS order_key
            FROM media_items mi
            JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
            ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi')}
            LEFT JOIN user_media_state uws
                ON uws.media_id = mi.id AND uws.user_id = ${userId}
            WHERE season.parent_id = ${seriesId}::uuid
              AND mi.media_type = 'episode'
              AND mi.status = 'active'
              AND COALESCE(eo.order_season_number, mi.season_number, 1) > 0
              AND (seo.media_id IS NULL OR eo.episode_media_id IS NOT NULL)
              AND mi.has_files = true
        ),
        furthest_watched AS (
            SELECT id
            FROM eps
            WHERE is_watched
            ORDER BY order_key DESC
            LIMIT 1
        )
        SELECT
            (SELECT COUNT(*) FROM eps)::int AS total_episodes,
            (SELECT COUNT(*) FROM eps WHERE is_watched)::int AS watched_episodes,
            (SELECT id FROM furthest_watched) AS last_watched_episode_id,
            (SELECT MAX(last_watched_at) FROM eps WHERE is_watched) AS last_watched_at
    `,
);
