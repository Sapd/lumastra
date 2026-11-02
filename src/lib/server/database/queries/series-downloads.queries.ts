// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Queries backing the `series-next-up` smart-download lane.
 *
 * Three rules from the design doc govern everything in this module:
 *
 * 1. EVERY NUMBER COMES FROM THE DATABASE. `defs/media/[id]/renditions.ts`
 *    resolves a source with a live `probeMediaFile()` (ffprobe) per call; a
 *    candidates query over hundreds of episodes cannot do that even once. So
 *    duration, source height and artifact size are all read from
 *    `user_media_state` / `media_items` / `media_files` / `media_streams` /
 *    `download_renditions` — never probed.
 *
 * 2. THE ANCHOR AND THE COMPLETION THRESHOLD ARE COPIED, NOT INVENTED. The
 *    anchor rule (`DISTINCT ON (series_id) ORDER BY engaged_at DESC, ord DESC`)
 *    is `getNextUpFromDb`'s, so a rewatch walks the pool backward with the user
 *    instead of stranding it at the finale. The completion threshold is
 *    Continue Watching's, so the two rails cannot disagree about where the user
 *    is. Neither has ever been exercised against `is_watched = false,
 *    resume_position_ms > 0` rows the way this query is, and preprod has zero
 *    such rows — the integration fixtures are the only coverage that exists.
 *
 * 3. NO BUDGET ARITHMETIC IN SQL. The ladder lives in
 *    `$lib/shared/download-rungs.ts`; duplicating it here is how music's
 *    `clampBitrate` bug would be reintroduced. SQL returns rows in the ordering
 *    below, bounded for cost; the byte estimate and the budget cut are pure
 *    TypeScript with their own unit tests.
 *
 * `frequencyMode` (see `SeriesFrequencyMode` below) layers a watch-FREQUENCY
 * signal on top of the distance-major ordering these three rules protect —
 * it changes WHICH rows sort first, never what counts as a candidate at all.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import type { AgeRatingFilterParams } from './builders/age-rating.builder.js';
import { EPISODE_ORDER_MULTIPLIER } from '$lib/server/utils/jellyfin-units.js';
import {
    buildAutoEpisodeOrderingJoinFragment,
    buildUnmappedEpisodeFilterFragment,
} from './episode-search.queries.js';

/** The lane name this module serves. One string, one source of truth. */
export const SERIES_LANE = 'series-next-up';

/**
 * Version stamp for the rescore ordering expression. Bump ONLY when the
 * ordering itself changes; a client that sees a different value treats its
 * stored ranks as stale and re-rescores.
 *
 * Bumped to 2 for `frequencyMode`: the literal ORDER BY expression each mode
 * compiles to (see `buildSeriesOrderingFragment`) is new SQL text, even for
 * 'off'. NOTE: ordering is now also a function of a REQUEST PARAMETER, not
 * only this stamp -- two responses sharing `scoreVersion: 2` are only
 * comparable if they also used the same `frequencyMode`. That per-call
 * identity is what `generation` on the rescore response already exists to
 * carry; `scoreVersion` alone no longer uniquely identifies an ordering.
 */
export const SERIES_SCORE_VERSION = 2;

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

export interface DownloadAccessLimits {
    deniedGroupIds: string[] | null;
    ageRating: AgeRatingFilterParams | null;
}

/**
 * Library-group predicate on the DEFAULT FILE we would encode.
 *
 * None of the three existing builders can do this. `buildLibraryAccessFilter`
 * hardcodes the `mi` alias and asks whether ANY of an item's files is
 * permitted; `buildLibraryGroupColumnFilter` reads `media_items.library_group_id`;
 * `buildEpisodeLibraryFilter` tests the SERIES' files. This one is deliberately
 * the strictest of the four: the bytes we would encode are THIS file's bytes,
 * so THIS file's group is what must be permitted.
 *
 * The repo's three existing call sites disagree about episode-vs-series
 * library filtering. This picks one for this query and documents it; fixing
 * the repo-wide inconsistency is explicitly out of scope (design doc §7.8).
 *
 * A NULL group cannot be named by a denied-group list, so it stays visible —
 * same semantics as every sibling builder.
 */
export function buildDefaultFileLibraryFilter(
    sql: postgres.Sql,
    deniedGroupIds: string[] | null | undefined,
    alias = 'mf',
): postgres.PendingQuery<postgres.Row[]> {
    if (!deniedGroupIds || deniedGroupIds.length === 0) return sql``;
    if (!SAFE_IDENTIFIER.test(alias)) {
        throw new Error(`buildDefaultFileLibraryFilter: invalid alias "${alias}"`);
    }
    return sql`
        AND (
            ${sql(alias)}.library_group_id IS NULL
            OR ${sql(alias)}.library_group_id != ALL(${deniedGroupIds}::uuid[])
        )
    `;
}

/**
 * Continue Watching's duration-tiered completion threshold, verbatim.
 *
 * Copied from `defs/recommendations/continue-watching-page.query.ts`. Sharing
 * the expression is a hard requirement, not tidiness: if the pool used a
 * different threshold, an episode would disappear from Continue Watching while
 * staying in the pool (or vice versa) and the user would see the two rails
 * disagree about where they are. Get it slightly LOW and the pool deletes an
 * episode the user is still watching.
 *
 * The `alias` must name a relation exposing `is_watched`, `resume_position_ms`
 * and `runtime_ms`. Both call sites arrange that with a `CROSS JOIN LATERAL`
 * rather than relying on unqualified names, because `runtime_ms` would
 * otherwise be ambiguous between `user_media_state` and the normalised value.
 *
 * COALESCEd to `false` because `false OR NULL` is NULL in SQL: an episode with
 * an unknown runtime would otherwise produce a NULL `anchor_consumed`, and a
 * NULL flips the forward window between `>` and `>=` unpredictably.
 */
export function buildConsumedExpressionFragment(
    sql: postgres.Sql,
    alias = 'st',
): postgres.PendingQuery<postgres.Row[]> {
    if (!SAFE_IDENTIFIER.test(alias)) {
        throw new Error(`buildConsumedExpressionFragment: invalid alias "${alias}"`);
    }
    return sql`
        COALESCE(
            ${sql(alias)}.is_watched
            OR (
                ${sql(alias)}.runtime_ms > 0
                AND ${sql(alias)}.resume_position_ms::float / ${sql(alias)}.runtime_ms >= CASE
                    WHEN ${sql(alias)}.runtime_ms <  90 * 60 * 1000 THEN 0.90
                    WHEN ${sql(alias)}.runtime_ms < 150 * 60 * 1000 THEN 0.95
                    ELSE 0.96
                END
            ),
            false
        )
    `;
}

/** Query-cost ceiling on the raw row count. Not a product rule. */
export const MAX_CANDIDATE_ROWS = 2000;

/** Query-cost ceiling on how deep one series may be walked. Not a product rule. */
export const MAX_DISTANCE_PER_SERIES = 25;

/**
 * Controls how heavily a series' recent-watch FREQUENCY (distinct episodes
 * progressed in the trailing `FREQUENCY_WINDOW_DAYS`) influences which
 * candidates get admitted first, layered on top of the distance-major
 * ordering documented on `getSeriesNextUpCandidates` below.
 *
 *   - 'off': today's behaviour, byte-for-byte. `series_rank` (last-touch
 *     recency) is the only tiebreak within a distance band.
 *   - 'balanced': distance stays the MAJOR key via a banding CASE — every
 *     series' own distance-0 row sits alone in band 0, so the "one binged
 *     series eats the whole budget" failure this file exists to prevent
 *     (see `getSeriesNextUpCandidates`'s docstring) cannot happen. A series
 *     watched often earns a small, CAPPED `freq_allowance` that pulls its
 *     OWN distance-2/3 rows down into the same band as everyone else's
 *     distance-1, so it can accumulate a couple of extra episodes ahead of a
 *     barely-touched show's second — without ever reaching band 0.
 *   - 'frequency_first': frequency becomes the major key outright. A
 *     heavily-watched series can claim several episodes before a
 *     barely-touched one gets its first — the deliberate exception to
 *     distance-major ordering, for a user who wants their most-binged show
 *     favoured over everything else.
 */
export type SeriesFrequencyMode = 'off' | 'balanced' | 'frequency_first';

/**
 * Server default when a request names no mode — including every client that
 * predates this feature, so an un-upgraded app also gets frequency-aware
 * ordering rather than silently staying on 'off' forever.
 */
export const DEFAULT_SERIES_FREQUENCY_MODE: SeriesFrequencyMode = 'balanced';

/**
 * Trailing window the frequency count is computed over. A product knob, not
 * a cost bound — unlike `maxAgeDays` (admin-configurable, gates inclusion in
 * the pool at all), this is fixed and only ever shifts ranking emphasis.
 */
export const FREQUENCY_WINDOW_DAYS = 21;

/**
 * `freq_allowance = LEAST(MAX_FREQUENCY_ALLOWANCE, episode_count_21d / FREQUENCY_ALLOWANCE_DIVISOR)`.
 * Capping the allowance is what keeps 'balanced' from degrading into
 * 'frequency_first': an uncapped allowance would let one binge pull its
 * entire tail into band 1 and reproduce the exact failure distance-major
 * ordering exists to prevent.
 */
export const FREQUENCY_ALLOWANCE_DIVISOR = 3;
export const MAX_FREQUENCY_ALLOWANCE = 2;

/**
 * The final ORDER BY for both `getSeriesNextUpCandidates` and
 * `getSeriesNextUpRescore`, as a LITERAL fragment selected in TypeScript —
 * never a bound parameter inside the ORDER BY itself.
 * `series-downloads.sql-assembly.test.ts` asserts the rendered SQL carries a
 * literal, unparameterised ordering expression and that both queries emit
 * the SAME one for a given mode; splicing `${mode}` into a CASE would turn
 * the sort key into a bound value and silently break both guarantees.
 *
 * Every column referenced here (`distance`, `series_rank`, `frequency_rank`,
 * `freq_allowance`, `media_id`) must exist under those exact names on
 * whatever relation the caller's outer SELECT reads FROM — see `per_file` in
 * `getSeriesNextUpCandidates` and `still_ahead` in `getSeriesNextUpRescore`.
 */
export function buildSeriesOrderingFragment(
    sql: postgres.Sql,
    mode: SeriesFrequencyMode,
): postgres.PendingQuery<postgres.Row[]> {
    switch (mode) {
        case 'off':
            return sql`distance ASC, series_rank ASC, media_id ASC`;
        case 'balanced':
            // distance stays major via the CASE band: every series' own
            // distance-0 row sits in band 0 ALONE, guaranteeing it is
            // offered before ANY series' distance-1. A row's freq_allowance
            // (capped above) only pulls ITS OWN distance>=1 rows down into
            // an earlier band — it can never reach into band 0.
            return sql`
                (CASE WHEN distance = 0 THEN 0 ELSE GREATEST(1, distance - freq_allowance) END) ASC,
                distance ASC,
                frequency_rank ASC,
                series_rank ASC,
                media_id ASC
            `;
        case 'frequency_first':
            return sql`frequency_rank ASC, distance ASC, series_rank ASC, media_id ASC`;
        default: {
            const exhaustive: never = mode;
            throw new Error(`buildSeriesOrderingFragment: unknown mode ${String(exhaustive)}`);
        }
    }
}

export interface SeriesCandidateRow {
    media_id: string;
    file_id: string;
    series_id: string;
    series_title: string;
    season_number: number;
    episode_number: number;
    /** BIGINT, read as text per this module's convention. `Number()` it in TS. */
    duration_ms: string | null;
    source_height: number | null;
    distance: number;
    series_rank: number;
    covers_media_ids: string[];
}

/**
 * Episodes at or ahead of the user's position in every series they are
 * currently watching, ordered `distance ASC, series_rank ASC, media_id ASC`.
 *
 * DISTANCE IS THE MAJOR KEY and series recency only the tie-break WITHIN a
 * distance band. Every tracked series' distance-0 episode is emitted before any
 * series' distance-1 episode, so a budget that fits four episodes yields the
 * next episode of four shows. That falls out of two window functions with no
 * tuning constant, and it is the failure mode the feature exists to avoid: a
 * binged series consuming the whole budget.
 *
 * `distance` is a positional `row_number`, NOT an ordinal gap (`ord -
 * anchor_ord`). A season with a missing episode row, or a jump across a season
 * boundary, would inflate an arithmetic gap and push a genuinely-next episode
 * into a later band.
 *
 * An episode qualifies only if it has a LOCAL DEFAULT FILE. This is a
 * deliberate divergence from Continue Watching and NextUp, which both accept
 * `has_files = true OR a jellyfin external_id`: an encode needs
 * `media_files.file_path` on disk, and a Jellyfin-only episode has nothing to
 * encode.
 *
 * Specials never auto-download (effective season must be > 0), matching
 * `getNextUpFromDb`'s explicit rule.
 *
 * One row per FILE, not per episode. A combined multi-episode file backs
 * several episode rows and one rendition satisfies all of them, so it is
 * emitted once carrying `covers_media_ids`. Without that the budget
 * double-charges and the client downloads the same artifact twice under two
 * ids.
 *
 * `opts.frequencyMode` (default `DEFAULT_SERIES_FREQUENCY_MODE`) selects
 * which literal ORDER BY `buildSeriesOrderingFragment` compiles to — see its
 * doc comment and `SeriesFrequencyMode` for what each mode does. The row SET
 * this query returns is IDENTICAL across all three modes; only their order
 * differs, which is what lets one `WHERE`/`WITH` pipeline serve all of them.
 */
export async function getSeriesNextUpCandidates(
    sql: postgres.Sql,
    userId: UserId,
    access: DownloadAccessLimits,
    opts: {
        maxAgeDays?: number;
        maxRows?: number;
        maxDistancePerSeries?: number;
        frequencyMode?: SeriesFrequencyMode;
    } = {},
): Promise<SeriesCandidateRow[]> {
    const maxAgeDays = opts.maxAgeDays ?? 180;
    const maxRows = opts.maxRows ?? MAX_CANDIDATE_ROWS;
    const maxDistance = opts.maxDistancePerSeries ?? MAX_DISTANCE_PER_SERIES;
    const frequencyMode = opts.frequencyMode ?? DEFAULT_SERIES_FREQUENCY_MODE;

    return sql<SeriesCandidateRow[]>`
        WITH engagement AS (
            SELECT
                season.parent_id AS series_id,
                ums.media_id AS media_id,
                o.ord AS ord,
                ${buildConsumedExpressionFragment(sql, 'st')} AS consumed,
                GREATEST(
                    COALESCE(ums.last_event_at, 'epoch'::timestamptz),
                    COALESCE(ums.last_watched_at, 'epoch'::timestamptz)
                ) AS engaged_at
            FROM user_media_state ums
            JOIN media_items ep ON ep.id = ums.media_id AND ep.media_type = 'episode'
            JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
            ${buildAutoEpisodeOrderingJoinFragment(sql, 'ep', 'season.parent_id')}
            CROSS JOIN LATERAL (
                SELECT
                    (COALESCE(eo.order_season_number, ep.season_number) * ${EPISODE_ORDER_MULTIPLIER}
                   + COALESCE(eo.order_episode_number, ep.episode_number)) AS ord,
                    COALESCE(eo.order_season_number, ep.season_number) AS eff_season
            ) o
            CROSS JOIN LATERAL (
                SELECT
                    ums.is_watched AS is_watched,
                    ums.resume_position_ms AS resume_position_ms,
                    COALESCE(NULLIF(ums.runtime_ms, 0), ep.runtime_seconds * 1000) AS runtime_ms
            ) st
            WHERE ums.user_id = ${userId}
              AND (ums.is_watched = true OR ums.resume_position_ms > 0)
              AND o.eff_season > 0
              -- Deliberately NOT filtering out o.ord IS NULL here: an episode
              -- with no effective episode number is still real engagement --
              -- it must simply never WIN the anchor pick (see 'anchor'
              -- below). Dropping it from 'engagement' entirely would make a
              -- series whose only engagement is unpositionable
              -- indistinguishable from a series with zero engagement, which
              -- is precisely the "collapses into one branch" bug.
              ${buildUnmappedEpisodeFilterFragment(sql, 'ep')}
              -- maxAgeDays = 0 disables the cutoff, the same escape every
              -- other consumer of CONTINUE_WATCHING_MAX_AGE_DAYS carries.
              -- Without it, 0 collapses this to ">= NOW()", which no already
              -- committed row satisfies: 'engagement' empties for every user,
              -- 'tracked' empties with it, and rescore then classifies every
              -- downloaded episode as graduated — which this lane spells
              -- 'delete'. A setting whose own help text calls 0 the way to
              -- turn the cutoff off must not wipe the offline library.
              AND (
                  ${maxAgeDays} = 0
                  OR GREATEST(
                         COALESCE(ums.last_event_at, 'epoch'::timestamptz),
                         COALESCE(ums.last_watched_at, 'epoch'::timestamptz)
                     ) >= NOW() - (${maxAgeDays} * INTERVAL '1 day')
              )
        ),
        frequency AS (
            -- Distinct episodes progressed in the trailing FREQUENCY_WINDOW_DAYS,
            -- per series. Deliberately a SEPARATE window from maxAgeDays: this
            -- one is a fixed product knob that only shifts ranking emphasis,
            -- never gates pool membership the way maxAgeDays does.
            SELECT series_id, COUNT(DISTINCT media_id) AS episode_count_21d
            FROM engagement
            WHERE engaged_at >= NOW() - (${FREQUENCY_WINDOW_DAYS} * INTERVAL '1 day')
            GROUP BY series_id
        ),
        anchor AS (
            -- An unpositionable engagement row (NULL ord) must never become
            -- the anchor over a positionable one, no matter how recently it
            -- was engaged: it cannot say where "you are". '(ord IS NOT NULL)
            -- DESC' sorts every positionable row before every unpositionable
            -- one for a series; only a series whose engagement is
            -- unpositionable END TO END falls through to an unpositionable
            -- anchor (anchor_ord NULL) -- which is a DIFFERENT, non-
            -- destructive state from "series untracked" (no row here at
            -- all). 'forward' and 'classified' (in the sibling rescore
            -- query) both need to tell those two apart.
            SELECT DISTINCT ON (series_id)
                series_id,
                ord AS anchor_ord,
                engaged_at,
                consumed AS anchor_consumed
            FROM engagement
            ORDER BY series_id, (ord IS NOT NULL) DESC, engaged_at DESC, ord DESC
        ),
        tracked AS (
            SELECT
                a.*,
                dense_rank() OVER (ORDER BY a.engaged_at DESC, a.series_id) AS series_rank,
                -- LEFT JOIN, never INNER: a series untouched in the last
                -- FREQUENCY_WINDOW_DAYS (e.g. anchored 40 days ago, still
                -- inside the 180-day maxAgeDays cutoff) has NO row in
                -- 'frequency' at all. An INNER JOIN here would silently drop
                -- it out of 'tracked' -- indistinguishable from "series
                -- untracked" to every downstream consumer, and in
                -- getSeriesNextUpRescore that means 'cohort's LEFT JOIN
                -- tracked misses it, 'classified' calls it
                -- tracked_series_id IS NULL, and it graduates -- which this
                -- lane's graduationPolicy spells DELETE. COALESCE to 0, not
                -- NULL: every zero-frequency series must rank identically
                -- via this key so frequency_rank's own tiebreak (recency)
                -- decides between them, not an arbitrary NULL ordering.
                dense_rank() OVER (
                    ORDER BY COALESCE(fr.episode_count_21d, 0) DESC, a.engaged_at DESC, a.series_id
                ) AS frequency_rank,
                LEAST(
                    ${MAX_FREQUENCY_ALLOWANCE},
                    COALESCE(fr.episode_count_21d, 0) / ${FREQUENCY_ALLOWANCE_DIVISOR}
                ) AS freq_allowance
            FROM anchor a
            LEFT JOIN frequency fr ON fr.series_id = a.series_id
            WHERE NOT EXISTS (
                SELECT 1 FROM user_media_flags f
                WHERE f.user_id = ${userId}
                  AND f.flag_type = 'dismissed_cw'
                  AND f.target_id::uuid = a.series_id
            )
        ),
        forward AS (
            SELECT
                t.series_id,
                t.series_rank,
                t.frequency_rank,
                t.freq_allowance,
                ep.id AS media_id,
                mf.id AS file_id,
                series_mi.title AS series_title,
                o.eff_season AS season_number,
                o.eff_episode AS episode_number,
                COALESCE(
                    NULLIF(ums.runtime_ms, 0),
                    NULLIF(ep.runtime_seconds, 0) * 1000,
                    ROUND(mf.duration_seconds * 1000)::bigint
                ) AS duration_ms,
                vs.height AS source_height,
                row_number() OVER (
                    PARTITION BY t.series_id
                    ORDER BY o.eff_season, o.eff_episode, ep.id
                ) - 1 AS distance
            FROM tracked t
            JOIN media_items season
                ON season.parent_id = t.series_id AND season.media_type = 'season'
            JOIN media_items ep
                ON ep.parent_id = season.id AND ep.media_type = 'episode' AND ep.has_files = true
            JOIN media_items series_mi ON series_mi.id = t.series_id
            JOIN media_file_items mfi ON mfi.media_item_id = ep.id AND mfi.is_default = true
            JOIN media_files mf ON mf.id = mfi.file_id AND mf.is_missing = false
            LEFT JOIN LATERAL (
                SELECT height FROM media_streams
                WHERE file_id = mf.id AND stream_type = 'video'
                ORDER BY stream_index
                LIMIT 1
            ) vs ON TRUE
            LEFT JOIN user_media_state ums
                ON ums.user_id = ${userId} AND ums.media_id = ep.id
            ${buildAutoEpisodeOrderingJoinFragment(sql, 'ep', 'season.parent_id')}
            CROSS JOIN LATERAL (
                SELECT
                    (COALESCE(eo.order_season_number, ep.season_number) * ${EPISODE_ORDER_MULTIPLIER}
                   + COALESCE(eo.order_episode_number, ep.episode_number)) AS ord,
                    COALESCE(eo.order_season_number, ep.season_number) AS eff_season,
                    COALESCE(eo.order_episode_number, ep.episode_number) AS eff_episode
            ) o
            WHERE o.eff_season > 0
              -- The CANDIDATE episode itself must be positionable: an
              -- episode with no effective episode number cannot be ordered
              -- against the anchor, so it is never offered (a conservative,
              -- non-destructive exclusion -- it just isn't downloaded).
              AND o.ord IS NOT NULL
              AND (
                  -- t.anchor_ord IS NULL means the series' engagement is
                  -- unpositionable end to end (see 'anchor' above), NOT that
                  -- the series is untracked -- an untracked series never
                  -- reaches 'tracked' at all, so forward's INNER JOIN
                  -- already excludes it. We cannot tell what is "ahead" of
                  -- an unknown anchor, so fail toward preserving data: offer
                  -- every positionable episode of the series rather than
                  -- silently dropping the whole series from the pool.
                  t.anchor_ord IS NULL
                  OR CASE WHEN t.anchor_consumed
                       THEN o.ord >  t.anchor_ord
                       ELSE o.ord >= t.anchor_ord
                  END
              )
              ${buildUnmappedEpisodeFilterFragment(sql, 'ep')}
              ${buildAgeRatingFilter(sql, access.ageRating, 'series_mi')}
              ${buildDefaultFileLibraryFilter(sql, access.deniedGroupIds, 'mf')}
        ),
        bounded AS (
            -- distance is a window function, so it cannot be filtered in the
            -- SELECT that computes it.
            SELECT * FROM forward WHERE distance < ${maxDistance}
        ),
        covers AS (
            -- Aggregated from 'forward' (pre-truncation), NOT 'bounded':
            -- MAX_DISTANCE_PER_SERIES is a pure cost bound on how many ROWS
            -- this query returns, not a claim about how many episodes one
            -- artifact covers. A combined file whose covered episodes
            -- straddle that distance boundary must still report every
            -- covered id here -- the client charges the budget once per
            -- artifact and must wait for EVERY covered episode to graduate
            -- before deleting it; an incomplete list lets it delete the
            -- artifact while a covered episode is still unwatched.
            --
            -- Grouped ONCE over 'forward' here, joined against only the
            -- file_ids 'bounded' needs, rather than a correlated subquery
            -- re-scanning the whole (unindexed, materialised) 'forward' CTE
            -- once per 'bounded' row: that was an O(|bounded| x |forward|)
            -- CTE scan with nothing bounding 'forward' itself, which a
            -- pathological profile (many tracked series, each anchored deep
            -- into a long-running show) turns from a sub-second query into a
            -- multi-second one.
            SELECT g.file_id, array_agg(g.media_id ORDER BY g.distance, g.media_id) AS media_ids
            FROM forward g
            JOIN (SELECT DISTINCT file_id FROM bounded) fi ON fi.file_id = g.file_id
            GROUP BY g.file_id
        ),
        per_file AS (
            SELECT DISTINCT ON (f.file_id)
                f.*,
                c.media_ids AS covers_media_ids
            FROM bounded f
            LEFT JOIN covers c ON c.file_id = f.file_id
            ORDER BY f.file_id, f.distance, f.series_rank, f.media_id
        )
        SELECT
            media_id,
            file_id,
            series_id,
            series_title,
            season_number,
            episode_number,
            duration_ms::text AS duration_ms,
            source_height,
            distance,
            series_rank,
            covers_media_ids
        FROM per_file
        ORDER BY ${buildSeriesOrderingFragment(sql, frequencyMode)}
        LIMIT ${maxRows}
    `;
}

export interface SeriesEtagInputs {
    /** `resume_position_ms > 0` rows — covers the re-watch branch too (any is_watched value). */
    engagementMaxLastEvent: Date | null;
    engagementResumeCount: number;
    /** `is_watched = true` rows — covers a completion with no resume position left behind. */
    engagementMaxLastWatched: Date | null;
    engagementWatchedCount: number;
    /** `dismissed_cw` flags — dismissing a series removes it from the pool outright. */
    dismissedMaxCreated: Date | null;
    dismissedCount: number;
}

/**
 * Cheap, INDEXED aggregates over every input that can move the
 * `series-next-up` candidate list, for the `/candidates` ETag validator (see
 * candidates.ts) — the series analogue of music's `getRotationEtagInputs`.
 *
 * This is deliberately NOT the real candidate query (`getSeriesNextUpCandidates`
 * above) -- it must stay cheap enough to run un-rate-limited on every poll.
 * `getSeriesNextUpCandidates`'s `engagement` CTE anchors on
 * `user_media_state` rows where `is_watched = true OR resume_position_ms > 0`
 * (the ONLY table user progress lives in), and its `tracked` CTE excludes any
 * series carrying a `dismissed_cw` flag in `user_media_flags` -- those are
 * exactly the two mutable inputs a cheap aggregate can watch. Library/access
 * changes are NOT aggregated here (unlike engagement, there is no per-user
 * "last changed" timestamp to scan) -- the caller mixes the resolved access
 * context directly into the hash instead, and the coarse time bucket (see
 * `ETAG_TIME_BUCKET_MS` in candidates.ts) bounds everything else this
 * function's blind spot misses (e.g. a file going missing, a metadata-only
 * episode-ordering change).
 *
 * Each subquery is scoped to `user_id = $1` against an existing partial
 * index:
 *   - `idx_ums_cw_candidates (user_id, last_event_at DESC) WHERE resume_position_ms > 0`
 *     -- deliberately has NO `is_watched` predicate (see that index's own
 *     migration comment), so it already covers the re-watch branch the
 *     `engagement` CTE admits.
 *   - `idx_ums_last_watched_at (user_id, last_watched_at DESC) WHERE is_watched = true`
 *   - `idx_umf_dismissed_cw (user_id, target_id) WHERE flag_type = 'dismissed_cw'`
 * so every subquery is an index range scan bounded to one user's rows, never
 * a table scan.
 */
export async function getSeriesEtagInputs(
    sql: postgres.Sql,
    userId: UserId,
): Promise<SeriesEtagInputs> {
    const [row] = await sql<
        {
            engagement_max_last_event: Date | null;
            engagement_resume_count: string;
            engagement_max_last_watched: Date | null;
            engagement_watched_count: string;
            dismissed_max_created: Date | null;
            dismissed_count: string;
        }[]
    >`
        SELECT
            (SELECT max(last_event_at) FROM user_media_state WHERE user_id = ${userId} AND resume_position_ms > 0) AS engagement_max_last_event,
            (SELECT count(*) FROM user_media_state WHERE user_id = ${userId} AND resume_position_ms > 0) AS engagement_resume_count,
            (SELECT max(last_watched_at) FROM user_media_state WHERE user_id = ${userId} AND is_watched = true) AS engagement_max_last_watched,
            (SELECT count(*) FROM user_media_state WHERE user_id = ${userId} AND is_watched = true) AS engagement_watched_count,
            (SELECT max(created_at) FROM user_media_flags WHERE user_id = ${userId} AND flag_type = 'dismissed_cw') AS dismissed_max_created,
            (SELECT count(*) FROM user_media_flags WHERE user_id = ${userId} AND flag_type = 'dismissed_cw') AS dismissed_count
    `;

    return {
        engagementMaxLastEvent: row?.engagement_max_last_event ?? null,
        engagementResumeCount: Number(row?.engagement_resume_count ?? 0),
        engagementMaxLastWatched: row?.engagement_max_last_watched ?? null,
        engagementWatchedCount: Number(row?.engagement_watched_count ?? 0),
        dismissedMaxCreated: row?.dismissed_max_created ?? null,
        dismissedCount: Number(row?.dismissed_count ?? 0),
    };
}

/**
 * Cap on one rescore cohort. Lower than music's 5000 on purpose: 2000 episodes
 * at 720p is roughly 2.4 TB, so a larger cap describes no reachable pool.
 *
 * Also the lane membership cap. Rescore is NEVER chunked — a cohort split
 * across two calls is a cohort split across two orderings, which is precisely
 * the incomparability the ordinal model exists to prevent.
 */
export const MAX_RESCORE_IDS = 2000;

export interface SeriesRescoreRow {
    media_id: string;
    /** `ranked` or `graduated`. An id absent from the result is `gone`. */
    status: string;
    rank: number | null;
}

/**
 * Classify and rank a bounded cohort of pool members.
 *
 * `graduated` means the episode has fallen at or behind the series anchor —
 * the same `t.anchor_consumed`-tiered boundary `getSeriesNextUpCandidates`'
 * `forward` CTE uses to decide what to offer — or the series is no longer
 * tracked at all. For `series-next-up` it is TERMINAL: there is no hand-off
 * lane, so the caller emits `toLane: null`.
 *
 * Graduation is deliberately NOT a function of a row's own watched state
 * ("self-consumption") once it sits strictly ahead of the anchor: candidates
 * offers exactly such rows during a rewatch (an episode watched during a
 * PRIOR watchthrough, ahead of a rewound anchor, is still emitted by
 * `forward`), so grading it `graduated` on that stale flag would download it
 * and immediately mark it for deletion on the very next call — forever, until
 * the user actually replays it. Position relative to the anchor is the only
 * signal both endpoints agree on.
 *
 * An id absent from this result is NOT graduated: it is `gone` (deleted, no
 * default file, access revoked, no longer an episode). Confusing the two is a
 * real cost in both directions. Returning `gone` where `graduated` belongs
 * makes an ordinary "you watched it" indistinguishable from "the file
 * vanished", which suppresses the telemetry that would reveal real library
 * breakage; returning `ranked` where `graduated` belongs fills the device with
 * watched episodes.
 *
 * Distance is computed over the COHORT PARTITION, which is the self-consistent
 * choice: rank is explicitly a position within the submitted cohort and never a
 * global one, and an arithmetic `ord - anchor_ord` would be distorted by
 * missing episode rows and season boundaries exactly as it would in the
 * candidate query.
 *
 * The final ORDER BY is literally the same expression the candidate query
 * uses (both call `buildSeriesOrderingFragment` with the SAME `frequencyMode`
 * a caller must pass to both endpoints for one polling cycle), so the same id
 * set comes out of both endpoints in the same relative order. That
 * equivalence has an integration test.
 */
export async function getSeriesNextUpRescore(
    sql: postgres.Sql,
    userId: UserId,
    mediaIds: string[],
    access: DownloadAccessLimits,
    opts: { maxAgeDays?: number; frequencyMode?: SeriesFrequencyMode } = {},
): Promise<SeriesRescoreRow[]> {
    if (mediaIds.length === 0) return [];
    const maxAgeDays = opts.maxAgeDays ?? 180;
    const frequencyMode = opts.frequencyMode ?? DEFAULT_SERIES_FREQUENCY_MODE;

    return sql<SeriesRescoreRow[]>`
        WITH engagement AS (
            SELECT
                season.parent_id AS series_id,
                ums.media_id AS media_id,
                o.ord AS ord,
                ${buildConsumedExpressionFragment(sql, 'st')} AS consumed,
                GREATEST(
                    COALESCE(ums.last_event_at, 'epoch'::timestamptz),
                    COALESCE(ums.last_watched_at, 'epoch'::timestamptz)
                ) AS engaged_at
            FROM user_media_state ums
            JOIN media_items ep ON ep.id = ums.media_id AND ep.media_type = 'episode'
            JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
            ${buildAutoEpisodeOrderingJoinFragment(sql, 'ep', 'season.parent_id')}
            CROSS JOIN LATERAL (
                SELECT
                    (COALESCE(eo.order_season_number, ep.season_number) * ${EPISODE_ORDER_MULTIPLIER}
                   + COALESCE(eo.order_episode_number, ep.episode_number)) AS ord,
                    COALESCE(eo.order_season_number, ep.season_number) AS eff_season
            ) o
            CROSS JOIN LATERAL (
                SELECT
                    ums.is_watched AS is_watched,
                    ums.resume_position_ms AS resume_position_ms,
                    COALESCE(NULLIF(ums.runtime_ms, 0), ep.runtime_seconds * 1000) AS runtime_ms
            ) st
            WHERE ums.user_id = ${userId}
              AND (ums.is_watched = true OR ums.resume_position_ms > 0)
              AND o.eff_season > 0
              -- See the sibling comment in getSeriesNextUpCandidates: an
              -- unpositionable engagement row still counts as engagement, it
              -- just must never WIN the anchor pick (see 'anchor' below).
              ${buildUnmappedEpisodeFilterFragment(sql, 'ep')}
              -- maxAgeDays = 0 disables the cutoff, the same escape every
              -- other consumer of CONTINUE_WATCHING_MAX_AGE_DAYS carries.
              -- Without it, 0 collapses this to ">= NOW()", which no already
              -- committed row satisfies: 'engagement' empties for every user,
              -- 'tracked' empties with it, and rescore then classifies every
              -- downloaded episode as graduated — which this lane spells
              -- 'delete'. A setting whose own help text calls 0 the way to
              -- turn the cutoff off must not wipe the offline library.
              AND (
                  ${maxAgeDays} = 0
                  OR GREATEST(
                         COALESCE(ums.last_event_at, 'epoch'::timestamptz),
                         COALESCE(ums.last_watched_at, 'epoch'::timestamptz)
                     ) >= NOW() - (${maxAgeDays} * INTERVAL '1 day')
              )
        ),
        frequency AS (
            -- See the sibling comment in getSeriesNextUpCandidates: a fixed,
            -- separate window from maxAgeDays, only shifting ranking
            -- emphasis, never gating pool membership.
            SELECT series_id, COUNT(DISTINCT media_id) AS episode_count_21d
            FROM engagement
            WHERE engaged_at >= NOW() - (${FREQUENCY_WINDOW_DAYS} * INTERVAL '1 day')
            GROUP BY series_id
        ),
        anchor AS (
            -- See the sibling comment in getSeriesNextUpCandidates: a
            -- positionable engagement row always outranks an unpositionable
            -- one for the anchor pick, regardless of recency.
            SELECT DISTINCT ON (series_id)
                series_id, ord AS anchor_ord, engaged_at, consumed AS anchor_consumed
            FROM engagement
            ORDER BY series_id, (ord IS NOT NULL) DESC, engaged_at DESC, ord DESC
        ),
        tracked AS (
            SELECT
                a.*,
                dense_rank() OVER (ORDER BY a.engaged_at DESC, a.series_id) AS series_rank,
                -- See the sibling comment in getSeriesNextUpCandidates: MUST
                -- be a LEFT JOIN. An INNER JOIN would drop a series with no
                -- engagement in the last FREQUENCY_WINDOW_DAYS out of
                -- 'tracked' entirely, which 'cohort's LEFT JOIN below reads
                -- as "genuinely untracked" -- graduating (deleting) a series
                -- the user is still actively watching, just not recently
                -- enough to register here.
                dense_rank() OVER (
                    ORDER BY COALESCE(fr.episode_count_21d, 0) DESC, a.engaged_at DESC, a.series_id
                ) AS frequency_rank,
                LEAST(
                    ${MAX_FREQUENCY_ALLOWANCE},
                    COALESCE(fr.episode_count_21d, 0) / ${FREQUENCY_ALLOWANCE_DIVISOR}
                ) AS freq_allowance
            FROM anchor a
            LEFT JOIN frequency fr ON fr.series_id = a.series_id
            WHERE NOT EXISTS (
                SELECT 1 FROM user_media_flags f
                WHERE f.user_id = ${userId}
                  AND f.flag_type = 'dismissed_cw'
                  AND f.target_id::uuid = a.series_id
            )
        ),
        cohort AS (
            SELECT
                ep.id AS media_id,
                season.parent_id AS series_id,
                -- NULL only when the LEFT JOIN below found no 'tracked' row
                -- at all -- i.e. the series is genuinely untracked
                -- (no/aged-out engagement, or dismissed). Distinct from
                -- 'anchor_ord IS NULL', which means a 'tracked' row exists
                -- but its anchor is unpositionable. 'classified' below must
                -- not conflate the two.
                t.series_id AS tracked_series_id,
                t.series_rank,
                t.frequency_rank,
                t.freq_allowance,
                o.ord AS ord,
                t.anchor_ord,
                t.anchor_consumed
            FROM media_items ep
            JOIN media_items season
                ON season.id = ep.parent_id AND season.media_type = 'season'
            JOIN media_items series_mi ON series_mi.id = season.parent_id
            JOIN media_file_items mfi ON mfi.media_item_id = ep.id AND mfi.is_default = true
            JOIN media_files mf ON mf.id = mfi.file_id AND mf.is_missing = false
            LEFT JOIN tracked t ON t.series_id = season.parent_id
            ${buildAutoEpisodeOrderingJoinFragment(sql, 'ep', 'season.parent_id')}
            CROSS JOIN LATERAL (
                SELECT
                    (COALESCE(eo.order_season_number, ep.season_number) * ${EPISODE_ORDER_MULTIPLIER}
                   + COALESCE(eo.order_episode_number, ep.episode_number)) AS ord,
                    COALESCE(eo.order_season_number, ep.season_number) AS eff_season
            ) o
            WHERE ep.id = ANY(${mediaIds}::uuid[])
              AND ep.media_type = 'episode'
              AND ep.has_files = true
              AND o.eff_season > 0
              ${buildUnmappedEpisodeFilterFragment(sql, 'ep')}
              ${buildAgeRatingFilter(sql, access.ageRating, 'series_mi')}
              ${buildDefaultFileLibraryFilter(sql, access.deniedGroupIds, 'mf')}
        ),
        classified AS (
            -- Graduation is PURELY a function of position relative to the
            -- anchor -- the exact logical complement of candidates' forward
            -- WHERE clause (o.ord > / >= t.anchor_ord). This used to also
            -- graduate on a row's OWN watched state (self_consumed), which
            -- reintroduced a download-then-delete loop on every rewatch: an
            -- episode ahead of a rewound anchor that was watched during a
            -- PRIOR watchthrough is exactly what candidates offers (candidates
            -- never filters on self-consumption -- see forward above, and
            -- the design's "graduation is not permanent" note), so it would be
            -- downloaded and then graduated on the very next rescore call,
            -- forever, until the user actually re-watches it. Position-only
            -- graduation keeps such an episode ranked until the anchor
            -- itself reaches it.
            --
            -- Three branches guard against destroying a watched series over
            -- a NULL episode_number, in priority order:
            --   1. tracked_series_id IS NULL: the series is GENUINELY
            --      untracked (no/aged-out engagement, or dismissed) --
            --      'graduated', exactly as before.
            --   2. anchor_ord IS NULL: a 'tracked' row exists but its anchor
            --      is unpositionable end to end (see 'anchor' above) -- the
            --      series is very much still tracked, we just cannot say
            --      what is "ahead" of it. NEVER graduate on this: an
            --      episode this server cannot position must never be
            --      classified in a way that gets it deleted.
            --   3. ord IS NULL: this COHORT MEMBER itself has no effective
            --      episode number, independent of the anchor. Same rule --
            --      it cannot be compared to the anchor, so it is retained
            --      (never graduated); still_ahead's 'ORDER BY ord' sorts
            --      it last within its series (NULLS LAST), which is fine.
            SELECT
                media_id, series_id, series_rank, frequency_rank, freq_allowance, ord,
                CASE
                    WHEN tracked_series_id IS NULL             THEN true   -- series genuinely not tracked
                    WHEN anchor_ord IS NULL                    THEN false  -- anchor unpositionable: retain, never graduate
                    WHEN ord IS NULL                           THEN false  -- this member unpositionable: retain, never graduate
                    WHEN anchor_consumed THEN ord <= anchor_ord
                    ELSE                       ord <  anchor_ord
                END AS graduated
            FROM cohort
        ),
        still_ahead AS (
            SELECT
                media_id, series_id, series_rank, frequency_rank, freq_allowance,
                row_number() OVER (PARTITION BY series_id ORDER BY ord, media_id) - 1 AS distance
            FROM classified
            WHERE graduated = false
        )
        SELECT
            media_id,
            'ranked'::text AS status,
            (row_number() OVER (ORDER BY ${buildSeriesOrderingFragment(sql, frequencyMode)}) - 1)::int AS rank
        FROM still_ahead
        UNION ALL
        SELECT media_id, 'graduated'::text AS status, NULL::int AS rank
        FROM classified
        WHERE graduated = true
        ORDER BY status, rank
    `;
}
