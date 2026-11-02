// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Quick Picks Query Module
 *
 * Queries for the Quick Picks section on /music.
 * Each function returns one "bucket" of tracks for the personalized mix.
 *
 * @module queries/music-quick-picks
 */

import type postgres from 'postgres';

/**
 * Candidate-quality gate for the METADATA-EMBEDDING Quick Picks buckets.
 *
 * Measured on prod (7 samples, 96 picks): 26.4% of Quick Picks carried an
 * unusable title — "12. Papa Roach", "Papa Roach - Infest (1999) - 00 - 03
 * Broken Home", "Lounge Top 100 - 00 - 15 Harry Bannink ..." — against a 2.1%
 * library base rate. A 12.6x over-representation, 3-4 per run, never zero.
 *
 * It is confined to the buckets that rank on `media_embeddings` (the metadata
 * vector): taste-similar 67%, unplayed-from-loved-albums 57%, new-discovery
 * 50%. The buckets ranking on `media_audio_embeddings` (MSCLAP) or on
 * popularity produced ZERO across all 96 picks.
 *
 * Why those buckets specifically: badly-ripped files have bad tags across the
 * board, not just a bad title. Of the 643 junk-titled tracks only 26% carry a
 * genre, versus 95% of the other 29,278. `createMusicEmbeddingText` weights
 * genre highest (it emits it twice, as `Genre:` and `Style:`) and deliberately
 * EXCLUDES the title, so a genre-less track's vector is assembled from almost
 * nothing and sits in a generic region close to many taste centroids — it
 * matches everything, so it surfaces constantly. The audio buckets are immune
 * because MSCLAP reads the waveform, which bad tags cannot corrupt.
 *
 * Two predicates, addressing the two halves:
 *   - title patterns  → the visible symptom (file-naming residue on display)
 *
 *     ONLY the two residue shapes, both verified against a prod export:
 *       leading track number  "01. Papa Roach"                        (114)
 *       embedded track index  "Lounge Top 100 - 00 - 01 Conny Stuart" (233)
 *
 *     A third pattern, a trailing "(YYYY)", was shipped briefly and REVERTED:
 *     it matched 105 tracks whose titles are perfectly good — "Dear Mama
 *     (1995)", "Planet Rock (1982)", "Coma Blue (2022)" — compilations that
 *     append the original release year. All 105 carry genre tags, so the gate
 *     was excluding good content and catching nothing the genre half missed.
 *     Do not re-add it; a year in parentheses is a legitimate title.
 *   - genre presence  → the cause (an embedding built from an empty text block
 *                       is not a meaningful similarity signal)
 *
 * co-album takes the TITLE half only. It selects by album membership, not by
 * any embedding, so the genre rationale does not apply — but the display
 * problem does: over 590 sampled picks it produced all 5 remaining residue
 * titles, every one a sibling of a played track on the same badly-tagged
 * Papa Roach folder. An earlier 96-pick sample showed it at 0/5, which was
 * simply too small to see a sub-1% rate.
 *
 * The full gate is applied ONLY to the metadata-embedding buckets. The sonic buckets keep their
 * full pool: an audio vector stays meaningful with no tags at all, and
 * narrowing them would cost recall for no benefit.
 *
 * Patterns use POSIX character classes, NOT backslash escapes. A JS template
 * literal eats `\.` and `\s`, so the first draft rendered as '^[0-9]+.s' —
 * a regex matching almost anything, which would have silently emptied these
 * buckets in production. Caught by the render test; keep it backslash-free.
 *
 * `alias` is the media_items alias in the caller's query.
 */
export function quickPickTitleFilter(
    sql: postgres.Sql,
    alias: 'track' | 'mi' = 'track',
): postgres.PendingQuery<postgres.Row[]> {
    if (alias === 'mi') {
        return sql`
              AND mi.title !~ '^[0-9]+[.][[:space:]]'
              AND mi.title !~ '[[:space:]]-[[:space:]][0-9]{2}[[:space:]]-[[:space:]]'`;
    }
    return sql`
              AND track.title !~ '^[0-9]+[.][[:space:]]'
              AND track.title !~ '[[:space:]]-[[:space:]][0-9]{2}[[:space:]]-[[:space:]]'`;
}

/**
 * The title filter PLUS the genre requirement — for the embedding-ranked
 * buckets only. See the notes above for why genre presence matters there and
 * nowhere else.
 */
export function quickPickQualityFilter(
    sql: postgres.Sql,
    alias: 'track' | 'mi' = 'track',
): postgres.PendingQuery<postgres.Row[]> {
    if (alias === 'mi') {
        return sql`
              ${quickPickTitleFilter(sql, 'mi')}
              AND jsonb_typeof(mi.custom_metadata->'genre') = 'array'
              AND jsonb_array_length(mi.custom_metadata->'genre') > 0`;
    }
    return sql`
              ${quickPickTitleFilter(sql, 'track')}
              AND jsonb_typeof(track.custom_metadata->'genre') = 'array'
              AND jsonb_array_length(track.custom_metadata->'genre') > 0`;
}

/**
 * Inner ANN stage for the metadata (`media_embeddings`, `source = 'music'`)
 * kNN buckets.
 *
 * MUST stay free of joins, and of any predicate not indexed on
 * `media_embeddings` itself. That is the entire point of the function. A
 * predicate belonging to a JOINed table cannot be pushed into an
 * index-ordered scan, and `quickPickQualityFilter`'s
 * `jsonb_typeof(track.custom_metadata->'genre')` in particular carries cost
 * and selectivity estimates that tip the planner off the HNSW index
 * altogether. It then brute-forces a 1536-dim cosine distance against EVERY
 * music embedding in the library and top-N heapsorts the result.
 *
 * Measured on prod (27.8k music tracks) before this split:
 *   no genre predicate      -> Index Scan using idx_me_music_hnsw       4 ms
 *   with it (the old shape) -> Bitmap Heap Scan 26,382 rows
 *                              + Sort Method: top-N heapsort          903 ms
 *   two-stage (this)        -> HNSW restored, identical 40 rows        3.6 ms
 *
 * The genre predicate removes only ~5% of rows (26,382 of 27,838 tracks), so
 * the old shape paid a ~250x planner penalty for almost no filtering.
 * Callers apply it -- and every other filter -- OUTSIDE this stage.
 *
 * The latency this caused was linear in library size at ~0.1ms per track,
 * confirmed independently against preprod: an 7.96x smaller library ran the
 * same call 8.0x faster above the fixed floor. Anything index-ordered would
 * be near-flat in library size, so that ratio is the regression test -- if
 * prod and preprod diverge again, something has gone back to scanning.
 *
 * `MATERIALIZED` is load-bearing. Without it Postgres inlines the CTE, the
 * planner flattens the two stages back into one, and the defect returns
 * silently -- the returned rows do not change, only the plan does.
 *
 * `annLimit` is the candidate pool the outer filters whittle down, so it must
 * move in lockstep with the caller's `hnsw.ef_search`: HNSW yields at most
 * ef_search candidates, and asking for more than that simply returns fewer
 * rows.
 */
function musicAnnCandidates(
    sql: postgres.Sql,
    centroidLiteral: string,
    annLimit: number,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`
            SELECT
                me.media_id AS media_id,
                me.embedding AS embedding,
                (me.embedding <=> ${centroidLiteral}::vector) AS ann_distance
            FROM media_embeddings me
            WHERE me.source = 'music'
            ORDER BY me.embedding <=> ${centroidLiteral}::vector ASC
            LIMIT ${annLimit}`;
}
import type { UserId } from '$lib/shared/user-id';
import type { RecentTrackRow } from './music.queries.js';
import { trackArtistIdSql, trackDisplayArtistSql } from './fragments/music-artist.fragments.js';
import { trackFilePathJoin } from './fragments/music-file-path.fragments.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter, type AgeRatingFilterParams } from './builders/age-rating.builder.js';
import { MSCLAP_MODEL_ID } from './sonic-constants.js';
import { sonicAnnCandidates } from './fragments/sonic-ann.fragments.js';

/** Tag identifying which bucket a track came from */
export type QuickPickBucket =
    | 'heavy-rotation'
    | 'recently-heard'
    | 'hot-this-week'
    | 'popular-hits'
    | 'taste-similar'
    | 'sonic-taste'
    | 'sonic-discovery'
    | 'highly-rated'
    | 'forgotten-favourites'
    | 'deep-cuts'
    | 'random'
    | 'unplayed-from-loved-albums'
    | 'co-album'
    | 'new-discovery';

// =============================================================================
// Category A: Heavy Rotation — all-time most played tracks
// =============================================================================

export async function getMostPlayedTracks(
    sql: postgres.Sql,
    userId: UserId,
    limit = 40,
    deniedGroupIds?: string[] | null,
    ageRating?: AgeRatingFilterParams | null,
): Promise<RecentTrackRow[]> {
    // Fix E: burn-out demotion — tracks with high skip_count are heard
    // enough that the user starts skipping. Subtract 0.5 × skip_count from
    // the popularity score so the ordering gently demotes them without
    // hard-excluding (hard exclusion is Fix A's job, and only for
    // skip-dominant tracks).
    return sql<RecentTrackRow[]>`
        SELECT
            mi.id,
            mi.title,
            mi.sort_order,
            mi.runtime_seconds,
            mi.custom_poster_url,
            COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
            album.id AS album_id,
            album.title AS album_title,
            album.custom_poster_url AS album_custom_poster_url,
            ${trackArtistIdSql(sql, 'mi')} AS artist_id,
            ${trackDisplayArtistSql(sql, 'mi')} AS artist_title,
            ums.last_played_at::text AS last_played_at,
            (EXTRACT(EPOCH FROM (NOW() - ums.last_played_at)) / 3600)::double precision AS hours_since_played,
            mf.file_path AS file_path
        FROM user_music_state ums
        JOIN media_items mi ON mi.id = ums.track_id AND mi.media_type = 'track' AND mi.has_files = true
        LEFT JOIN media_items album ON album.id = mi.parent_id AND album.media_type = 'album'
        LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
        ${trackFilePathJoin(sql, 'mi')}
        WHERE ums.user_id = ${userId}
          AND ums.play_count > 0
          ${buildLibraryAccessFilter(sql, deniedGroupIds)}
          ${buildAgeRatingFilter(sql, ageRating)}
        ORDER BY (ums.play_count - 0.5 * COALESCE(ums.skip_count, 0)) DESC
        LIMIT ${limit}
    `;
}

// =============================================================================
// Category C: Hot This Week — your faves you're currently returning to
// =============================================================================
//
// True per-week play counts come from `music_listen_events` (an append-only
// per-play event log: one row per listen attempt). We aggregate non-skipped
// events in the trailing N-day window and order tracks by their actual
// in-window play count — semantically distinct from:
//   - heavy-rotation   (high all-time count, any time)
//   - recently-heard   (any count, recent)
//   - THIS bucket      (most actual plays inside the window)
//
// Skipped events are excluded from the play count so a track the user keeps
// skipping doesn't masquerade as "hot". The skip-penalty term used in the
// ORDER BY is ALSO windowed to the same trailing N days (`week_skips` below,
// from the very same `music_listen_events` rows) rather than
// `user_music_state.skip_count`, which is a LIFETIME aggregate — mixing a
// windowed numerator with a lifetime penalty let old, long-resolved skip
// habits suppress tracks that are genuinely hot again right now (e.g. 5
// plays this week - 0.5 * 20 old skips = a negative score despite the track
// being on fire this week). `user_music_state` is still joined for the
// `last_played_at` / `hours_since_played` display fields only.

export async function getHotThisWeek(
    sql: postgres.Sql,
    userId: UserId,
    days = 7,
    limit = 40,
    deniedGroupIds?: string[] | null,
    ageRating?: AgeRatingFilterParams | null,
): Promise<RecentTrackRow[]> {
    return sql<RecentTrackRow[]>`
        WITH weekly_plays AS (
            SELECT
                mle.track_id,
                COUNT(*) FILTER (WHERE mle.was_skipped = false)::int AS week_plays,
                COUNT(*) FILTER (WHERE mle.was_skipped = true)::int AS week_skips
            FROM music_listen_events mle
            WHERE mle.user_id = ${userId}
              AND mle.duration_ms > 0 -- zero-heard rows are idempotency claims, not plays
              AND mle.created_at > NOW() - make_interval(days => ${days})
            GROUP BY mle.track_id
            HAVING COUNT(*) FILTER (WHERE mle.was_skipped = false) > 0
        )
        SELECT
            mi.id,
            mi.title,
            mi.sort_order,
            mi.runtime_seconds,
            mi.custom_poster_url,
            COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
            album.id AS album_id,
            album.title AS album_title,
            album.custom_poster_url AS album_custom_poster_url,
            ${trackArtistIdSql(sql, 'mi')} AS artist_id,
            ${trackDisplayArtistSql(sql, 'mi')} AS artist_title,
            ums.last_played_at::text AS last_played_at,
            (EXTRACT(EPOCH FROM (NOW() - ums.last_played_at)) / 3600)::double precision AS hours_since_played,
            mf.file_path AS file_path
        FROM weekly_plays wp
        JOIN media_items mi
          ON mi.id = wp.track_id AND mi.media_type = 'track' AND mi.has_files = true
        LEFT JOIN user_music_state ums
          ON ums.track_id = mi.id AND ums.user_id = ${userId}
        LEFT JOIN media_items album
          ON album.id = mi.parent_id AND album.media_type = 'album'
        LEFT JOIN media_items artist
          ON artist.id = album.parent_id AND artist.media_type = 'artist'
        ${trackFilePathJoin(sql, 'mi')}
        WHERE 1 = 1
          ${buildLibraryAccessFilter(sql, deniedGroupIds)}
          ${buildAgeRatingFilter(sql, ageRating)}
        ORDER BY (wp.week_plays - 0.5 * wp.week_skips) DESC,
                 ums.last_played_at DESC NULLS LAST
        LIMIT ${limit}
    `;
}

// =============================================================================
// Category J: Popular Hits — unplayed tracks that are broadly popular
//   (Last.fm-derived global popularity), surfaced as low-risk discovery.
// =============================================================================

export async function getPopularHitTracks(
    sql: postgres.Sql,
    userId: UserId,
    excludeIds: string[],
    limit = 40,
    source = 'lastfm',
    deniedGroupIds?: string[] | null,
    ageRating?: AgeRatingFilterParams | null,
): Promise<RecentTrackRow[]> {
    const safeExclude =
        excludeIds.length > 0 ? excludeIds : ['00000000-0000-0000-0000-000000000000'];

    // Ordering comes from the precomputed `music_popularity_rank` projection
    // (migration 16.238.0) rather than being computed here.
    //
    // This used to ORDER BY `COALESCE(apop.normalized_score,0) *
    // tpop.normalized_score` -- a product of two columns from two DIFFERENT
    // media_popularity rows. No index can serve a computed cross-row
    // expression, so it walked 27,838 media_items, joined to ~13,244
    // candidates and top-N heapsorted them all to return 40: 128ms idle and
    // 768-873ms under concurrent ingest on prod, scaling with library size by
    // construction. It was the long pole of the whole quick-picks request
    // once the two kNN plan flips were fixed.
    //
    // The score is user-independent, so it is computed once per popularity
    // sync and read back in rank order here. Do NOT reintroduce an ORDER BY
    // over an expression: the index only helps while the ORDER BY matches its
    // columns and directions exactly.
    return sql<RecentTrackRow[]>`
        SELECT
            mi.id,
            mi.title,
            mi.sort_order,
            mi.runtime_seconds,
            mi.custom_poster_url,
            COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
            album.id AS album_id,
            album.title AS album_title,
            album.custom_poster_url AS album_custom_poster_url,
            ${trackArtistIdSql(sql, 'mi')} AS artist_id,
            ${trackDisplayArtistSql(sql, 'mi')} AS artist_title,
            mi.created_at::text AS last_played_at,
            NULL::double precision AS hours_since_played,
            mf.file_path AS file_path
        FROM music_popularity_rank mpr
        JOIN media_items mi ON mi.id = mpr.media_id
        LEFT JOIN media_items album ON album.id = mi.parent_id AND album.media_type = 'album'
        LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
        ${trackFilePathJoin(sql, 'mi')}
        WHERE mpr.source = ${source}
          AND mi.media_type = 'track'
          -- has_files is filtered here, not baked into the projection: it
          -- changes when a file lands, which has nothing to do with
          -- popularity, and a track gaining files would otherwise stay
          -- invisible until the next sync.
          AND mi.has_files = true
          -- NOT EXISTS, deliberately -- NOT the equivalent
          -- LEFT JOIN user_music_state ... WHERE play_count IS NULL OR = 0.
          --
          -- The two return identical rows (verified against the old query on
          -- prod, 40 of 40), but the LEFT JOIN form estimated 2 rows against
          -- 13,243 actual. On that estimate the planner drove the join from
          -- media_items, bitmap-scanned all 27,838 of them and top-N
          -- heapsorted -- i.e. it kept sorting the library despite the
          -- precomputed ordering, and still scaled with library size. On prod:
          --
          --   LEFT JOIN .. IS NULL   Bitmap Heap Scan + top-N heapsort   47ms
          --   NOT EXISTS             ordered index walk, stops at 70 rows  0.8ms
          --
          -- With NOT EXISTS the planner walks idx_music_popularity_rank_order
          -- in rank order and stops as soon as LIMIT is satisfied -- 70 rows
          -- visited for 40 returned, matching the measured pool depth. That
          -- early stop is the entire point of the projection; the row-identical
          -- LEFT JOIN spelling silently gives it up.
          AND NOT EXISTS (
              SELECT 1 FROM user_music_state ums
              WHERE ums.track_id = mi.id
                AND ums.user_id = ${userId}
                AND ums.play_count > 0
          )
          AND mi.id != ALL(${safeExclude})
          ${buildLibraryAccessFilter(sql, deniedGroupIds)}
          ${buildAgeRatingFilter(sql, ageRating)}
        ORDER BY mpr.effective_score DESC, mpr.raw_playcount DESC NULLS LAST
        LIMIT ${limit}
    `;
}

// =============================================================================
// Category K: Forgotten Favourites — high-play-count tracks not heard
//   recently. Skip-dominance guard excludes tracks the user has soured on.
// =============================================================================

export async function getForgottenFavouriteTracks(
    sql: postgres.Sql,
    userId: UserId,
    limit = 40,
): Promise<RecentTrackRow[]> {
    return sql<RecentTrackRow[]>`
        SELECT
            mi.id,
            mi.title,
            mi.sort_order,
            mi.runtime_seconds,
            mi.custom_poster_url,
            COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
            album.id AS album_id,
            album.title AS album_title,
            album.custom_poster_url AS album_custom_poster_url,
            ${trackArtistIdSql(sql, 'mi')} AS artist_id,
            ${trackDisplayArtistSql(sql, 'mi')} AS artist_title,
            ums.last_played_at::text AS last_played_at,
            (EXTRACT(EPOCH FROM (NOW() - ums.last_played_at)) / 3600)::double precision AS hours_since_played,
            mf.file_path AS file_path
        FROM user_music_state ums
        JOIN media_items mi ON mi.id = ums.track_id AND mi.media_type = 'track' AND mi.has_files = true
        LEFT JOIN media_items album ON album.id = mi.parent_id AND album.media_type = 'album'
        LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
        ${trackFilePathJoin(sql, 'mi')}
        WHERE ums.user_id = ${userId}
          AND ums.play_count >= 5
          AND ums.last_played_at < NOW() - INTERVAL '60 days'
          AND ums.play_count > 2 * COALESCE(ums.skip_count, 0)
        ORDER BY (ums.play_count - 0.5 * COALESCE(ums.skip_count, 0)) DESC
        LIMIT ${limit}
    `;
}

// =============================================================================
// Category E: Highly Rated — tracks rated >= 8
// =============================================================================

export async function getHighlyRatedTracks(
    sql: postgres.Sql,
    userId: UserId,
    minRating = 8,
    limit = 40,
): Promise<RecentTrackRow[]> {
    return sql<RecentTrackRow[]>`
        SELECT
            track.id,
            track.title,
            track.sort_order,
            track.runtime_seconds,
            track.custom_poster_url,
            COALESCE(track.custom_metadata, '{}'::jsonb) AS custom_metadata,
            album.id AS album_id,
            album.title AS album_title,
            album.custom_poster_url AS album_custom_poster_url,
            ${trackArtistIdSql(sql)} AS artist_id,
            ${trackDisplayArtistSql(sql)} AS artist_title,
            ur.created_at::text AS last_played_at,
            (EXTRACT(EPOCH FROM (NOW() - ums.last_played_at)) / 3600)::double precision AS hours_since_played,
            mf.file_path AS file_path
        FROM user_ratings ur
        JOIN media_items track ON track.id = ur.media_id AND track.media_type = 'track' AND track.has_files = true
        LEFT JOIN media_items album ON album.id = track.parent_id AND album.media_type = 'album'
        LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
        LEFT JOIN user_music_state ums ON ums.track_id = track.id AND ums.user_id = ${userId}
        ${trackFilePathJoin(sql)}
        WHERE ur.user_id = ${userId}
          AND ur.rating >= ${minRating}
          AND ur.skipped IS NOT TRUE
        ORDER BY ur.rating DESC, ur.created_at DESC
        LIMIT ${limit}
    `;
}

// =============================================================================
// Category F: Deep Cuts — oldest tracks in library (classics/discovery)
// =============================================================================

export async function getDeepCutTracks(
    sql: postgres.Sql,
    userId: UserId,
    limit = 40,
): Promise<RecentTrackRow[]> {
    return sql<RecentTrackRow[]>`
        SELECT
            track.id,
            track.title,
            track.sort_order,
            track.runtime_seconds,
            track.custom_poster_url,
            COALESCE(track.custom_metadata, '{}'::jsonb) AS custom_metadata,
            album.id AS album_id,
            album.title AS album_title,
            album.custom_poster_url AS album_custom_poster_url,
            ${trackArtistIdSql(sql)} AS artist_id,
            ${trackDisplayArtistSql(sql)} AS artist_title,
            track.created_at::text AS last_played_at,
            (EXTRACT(EPOCH FROM (NOW() - ums.last_played_at)) / 3600)::double precision AS hours_since_played,
            mf.file_path AS file_path
        FROM media_items track
        LEFT JOIN media_items album ON album.id = track.parent_id AND album.media_type = 'album'
        LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
        LEFT JOIN user_music_state ums ON ums.track_id = track.id AND ums.user_id = ${userId}
        ${trackFilePathJoin(sql)}
        WHERE track.media_type = 'track'
          AND track.has_files = true
        ORDER BY track.created_at ASC, RANDOM()
        LIMIT ${limit}
    `;
}

// =============================================================================
// Category G: Pure Random — random tracks from library
// =============================================================================

export async function getRandomTracks(
    sql: postgres.Sql,
    userId: UserId,
    limit = 40,
    deniedGroupIds?: string[] | null,
    ageRating?: AgeRatingFilterParams | null,
): Promise<RecentTrackRow[]> {
    return sql<RecentTrackRow[]>`
        SELECT
            mi.id,
            mi.title,
            mi.sort_order,
            mi.runtime_seconds,
            mi.custom_poster_url,
            COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
            album.id AS album_id,
            album.title AS album_title,
            album.custom_poster_url AS album_custom_poster_url,
            ${trackArtistIdSql(sql, 'mi')} AS artist_id,
            ${trackDisplayArtistSql(sql, 'mi')} AS artist_title,
            mi.created_at::text AS last_played_at,
            (EXTRACT(EPOCH FROM (NOW() - ums.last_played_at)) / 3600)::double precision AS hours_since_played,
            mf.file_path AS file_path
        FROM media_items mi TABLESAMPLE BERNOULLI(20)
        LEFT JOIN media_items album ON album.id = mi.parent_id AND album.media_type = 'album'
        LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
        LEFT JOIN user_music_state ums ON ums.track_id = mi.id AND ums.user_id = ${userId}
        ${trackFilePathJoin(sql, 'mi')}
        WHERE mi.media_type = 'track'
          AND mi.has_files = true
          ${buildLibraryAccessFilter(sql, deniedGroupIds)}
          ${buildAgeRatingFilter(sql, ageRating)}
        ORDER BY RANDOM()
        LIMIT ${limit}
    `;
}

// =============================================================================
// Category D: Taste-Similar — embedding kNN from user taste profile
// =============================================================================

export async function getTasteSimilarTracks(
    sql: postgres.Sql,
    userId: UserId,
    excludeIds: string[],
    limit = 40,
): Promise<RecentTrackRow[]> {
    const safeExclude =
        excludeIds.length > 0 ? excludeIds : ['00000000-0000-0000-0000-000000000000'];

    // HNSW recall guard: prod runs hnsw.ef_search=40, so the ANN stage below
    // only ever visits ~40 candidates before the `!= ALL(safeExclude)` filter
    // is applied. excludeIds routinely reaches into the hundreds for a real
    // session (recently-played + cross-bucket dedupe), which can starve
    // recall to 0 rows. Raise ef_search to cover limit + the exclude size.
    const efSearch = Math.min(1000, Math.max(64, limit + excludeIds.length));
    // ANN pool the outer filters whittle down — see {@link musicAnnCandidates}.
    const annLimit = efSearch;

    // Legacy single-centroid fallback (used when clustering is disabled
    // or the user has too few plays). Must apply the same explicit-skip
    // exclusion as getTopPlayedEmbeddings — otherwise tracks with
    // `ur.skipped = TRUE` that happen to have no explicit rating still
    // shape the taste centroid here, contradicting Fix A's blacklist.
    return await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await tx`SELECT set_config('hnsw.ef_search', ${String(efSearch)}, true)`;
        // Force the ANN stage onto the HNSW index.
        //
        // `media_embeddings` is small enough (~28k rows) that a full scan
        // keeps looking cheap to the planner, and pgvector's HNSW startup
        // cost estimate is not monotonic in ef_search — measured on prod with
        // the identical bound-parameter query:
        //
        //   ef_search=64   -> Seq Scan + top-N heapsort   119 ms
        //   ef_search=400  -> idx_me_music_hnsw            12 ms
        //   ef_search=64  + enable_seqscan=off -> hnsw      2.6 ms
        //
        // So the planner picks the 45x-slower plan at the SMALLER ef_search.
        // Leaving that to the cost model is what the two-stage split alone
        // could not fix: the split removes the filters that made the index
        // unusable, but the planner can still decline the index on price.
        // is_local=true scopes this to the surrounding transaction, exactly
        // like the ef_search setting above.
        await tx`SELECT set_config('enable_seqscan', 'off', true)`;

        // The centroid is resolved in its OWN round trip rather than as a CTE
        // the ranking query joins against. That is not a style choice: an
        // HNSW index can only order by a value the planner sees as a runtime
        // constant. A CTE column — whether CROSS JOINed or read back as
        // `(SELECT embedding FROM taste_emb)` — is not one, and the planner
        // silently falls back to a sequential scan over every music embedding
        // plus a top-N heapsort. Measured on prod: 233ms and `Seq Scan on
        // media_embeddings` for the CTE form, versus single-digit ms on
        // `idx_me_music_hnsw` once the vector arrives as a bound literal.
        //
        // Casting to ::text hands back pgvector's own text format, which is
        // exactly what musicAnnCandidates re-casts to ::vector.
        const [taste] = await tx<{ embedding: string | null }[]>`
            -- Weighted average so explicit loves (rating >= 9) pull the centroid
            -- harder than neutral plays. pgvector multiplication is element-wise
            -- (no scalar-multiply operator), so we up-weight by replicating each
            -- loved track embedding row weight-times via generate_series and
            -- letting AVG() do the weighting. Mirrors the k-means LIKE_WEIGHT
            -- up-weighting in the clustered path. Limit raised 30 -> 50 for a
            -- broader, more stable taste vector.
            SELECT AVG(me.embedding)::text AS embedding
            FROM (
                SELECT ums.track_id AS media_id,
                    LEAST(COALESCE(ums.play_count, 0), 20) + COALESCE(ur.rating, 0) AS score,
                    CASE WHEN COALESCE(ur.rating, 0) >= 9 THEN 3 ELSE 1 END AS weight
                FROM user_music_state ums
                LEFT JOIN user_ratings ur
                    ON ur.media_id = ums.track_id AND ur.user_id = ums.user_id
                WHERE ums.user_id = ${userId}
                  AND (ur.rating IS NULL OR ur.rating >= 4)
                  AND (ur.skipped IS NULL OR ur.skipped = FALSE)
                ORDER BY score DESC
                LIMIT 50
            ) top_tracks
            JOIN media_embeddings me
                ON me.media_id = top_tracks.media_id AND me.source = 'music'
            CROSS JOIN LATERAL generate_series(1, top_tracks.weight) AS w
        `;

        // AVG() over zero qualifying rows still returns one row holding NULL.
        // Bailing here is what the old query's `te.embedding IS NOT NULL`
        // predicate did — without it we would order by NULL and hand back an
        // arbitrary slice of the library to a user with no play history.
        const centroidLiteral = taste?.embedding ?? null;
        if (!centroidLiteral) return [] as RecentTrackRow[];

        return tx<RecentTrackRow[]>`
            WITH ann AS MATERIALIZED (
                ${musicAnnCandidates(sql, centroidLiteral, annLimit)}
            )
            SELECT
                track.id,
                track.title,
                track.sort_order,
                track.runtime_seconds,
                track.custom_poster_url,
                COALESCE(track.custom_metadata, '{}'::jsonb) AS custom_metadata,
                album.id AS album_id,
                album.title AS album_title,
                album.custom_poster_url AS album_custom_poster_url,
                ${trackArtistIdSql(sql)} AS artist_id,
                ${trackDisplayArtistSql(sql)} AS artist_title,
                track.created_at::text AS last_played_at,
                (EXTRACT(EPOCH FROM (NOW() - ums.last_played_at)) / 3600)::double precision AS hours_since_played,
                mf.file_path AS file_path
            FROM ann
            JOIN media_items track ON track.id = ann.media_id
            LEFT JOIN media_items album ON album.id = track.parent_id AND album.media_type = 'album'
            LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
            LEFT JOIN user_music_state ums ON ums.track_id = track.id AND ums.user_id = ${userId}
            ${trackFilePathJoin(sql)}
            WHERE track.media_type = 'track'
              AND track.has_files = true
              ${quickPickQualityFilter(sql)}
              AND track.id != ALL(${safeExclude})
            ORDER BY ann.ann_distance ASC
            LIMIT ${limit}
        `;
    });
}

// =============================================================================
// Category H: Unplayed from Loved Albums — surfaces compilation/album tracks
//   the user hasn't heard yet from albums they've already engaged with.
// =============================================================================

export async function getUnplayedFromLovedAlbums(
    sql: postgres.Sql,
    userId: UserId,
    excludeIds: string[],
    limit = 40,
    minPlayedTracksPerAlbum = 3,
): Promise<RecentTrackRow[]> {
    const safeExclude =
        excludeIds.length > 0 ? excludeIds : ['00000000-0000-0000-0000-000000000000'];

    return sql<RecentTrackRow[]>`
        WITH loved_albums AS (
            SELECT track.parent_id AS album_id, COUNT(*) AS played_count
            FROM user_music_state ums
            JOIN media_items track
              ON track.id = ums.track_id AND track.media_type = 'track' AND track.has_files = true
            WHERE ums.user_id = ${userId}
              AND ums.play_count > 0
              AND track.parent_id IS NOT NULL
            GROUP BY track.parent_id
            HAVING COUNT(*) >= ${minPlayedTracksPerAlbum}
        )
        SELECT
            track.id,
            track.title,
            track.sort_order,
            track.runtime_seconds,
            track.custom_poster_url,
            COALESCE(track.custom_metadata, '{}'::jsonb) AS custom_metadata,
            album.id AS album_id,
            album.title AS album_title,
            album.custom_poster_url AS album_custom_poster_url,
            ${trackArtistIdSql(sql)} AS artist_id,
            ${trackDisplayArtistSql(sql)} AS artist_title,
            track.created_at::text AS last_played_at,
            NULL::double precision AS hours_since_played,
            mf.file_path AS file_path
        FROM media_items track
        JOIN loved_albums la ON la.album_id = track.parent_id
        JOIN media_items album ON album.id = track.parent_id AND album.media_type = 'album'
        LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
        LEFT JOIN user_music_state ums ON ums.track_id = track.id AND ums.user_id = ${userId}
        ${trackFilePathJoin(sql)}
        WHERE track.media_type = 'track'
          AND track.has_files = true
          ${quickPickQualityFilter(sql)}
          AND (ums.play_count IS NULL OR ums.play_count = 0)
          AND track.id != ALL(${safeExclude})
        ORDER BY la.played_count DESC, RANDOM()
        LIMIT ${limit}
    `;
}

// =============================================================================
// Category I: Co-Album — unplayed siblings of the user's currently hottest
//   tracks. Only returns tracks the user has NEVER played — already-played
//   tracks are assumed to be surfaced (or intentionally skipped) via the
//   heavy-rotation / recently-heard buckets.
// =============================================================================

export async function getCoAlbumTracks(
    sql: postgres.Sql,
    userId: UserId,
    seedTrackIds: string[],
    excludeIds: string[],
    limit = 40,
): Promise<RecentTrackRow[]> {
    if (seedTrackIds.length === 0) return [];
    const safeExclude =
        excludeIds.length > 0 ? excludeIds : ['00000000-0000-0000-0000-000000000000'];

    return sql<RecentTrackRow[]>`
        WITH seed_albums AS (
            SELECT DISTINCT parent_id AS album_id
            FROM media_items
            WHERE id = ANY(${seedTrackIds})
              AND media_type = 'track'
              AND parent_id IS NOT NULL
        )
        SELECT
            track.id,
            track.title,
            track.sort_order,
            track.runtime_seconds,
            track.custom_poster_url,
            COALESCE(track.custom_metadata, '{}'::jsonb) AS custom_metadata,
            album.id AS album_id,
            album.title AS album_title,
            album.custom_poster_url AS album_custom_poster_url,
            ${trackArtistIdSql(sql)} AS artist_id,
            ${trackDisplayArtistSql(sql)} AS artist_title,
            track.created_at::text AS last_played_at,
            NULL::double precision AS hours_since_played,
            mf.file_path AS file_path
        FROM media_items track
        JOIN seed_albums sa ON sa.album_id = track.parent_id
        JOIN media_items album ON album.id = track.parent_id AND album.media_type = 'album'
        LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
        LEFT JOIN user_music_state ums ON ums.track_id = track.id AND ums.user_id = ${userId}
        ${trackFilePathJoin(sql)}
        WHERE track.media_type = 'track'
          AND track.has_files = true
          ${quickPickTitleFilter(sql)}
          AND track.id != ALL(${safeExclude})
          AND (ums.play_count IS NULL OR ums.play_count = 0)
        ORDER BY RANDOM()
        LIMIT ${limit}
    `;
}

// =============================================================================
// Cluster Helpers — used by taste-clusters.service for k-means input and
//   per-cluster kNN sampling.
// =============================================================================

export interface TrackEmbeddingRow {
    track_id: string;
    embedding: number[] | string;
    /** True when this track is an explicit user like (rating >= 8). */
    is_liked?: boolean;
}

// =============================================================================
// Dislike / Feedback helpers (Fix A + C)
// =============================================================================

/**
 * IDs of tracks that should be blacklisted from every Quick Picks bucket.
 * Combines THREE sources:
 *   1. Explicit dislike       — user_ratings.rating <= 3
 *   2. Explicit dismiss       — user_ratings.skipped = TRUE
 *   3. Behavioral dislike     — skipped in >70% of attempts, ≥3 plays
 *                                (skip-dominant; distinct from burn-out)
 *
 * A track with high skip_count but low skip-ratio is burn-out (heard too
 * often, needs a break) NOT a dislike — those are demoted in ordering via
 * Fix E, not blacklisted here.
 */
export async function getDislikedTrackIds(sql: postgres.Sql, userId: UserId): Promise<string[]> {
    // Order by recency DESC so callers that cap the list (e.g. autoplay's
    // MAX_DISLIKES slice) keep the newest dislikes — UNION without ORDER BY
    // returns rows in arbitrary order in postgres, which would let recent
    // hard-excludes silently fall out of the cap window.
    //
    // - Explicit dislikes: ur.created_at (rating row creation, the only
    //   timestamp on user_ratings).
    // - Behavioral dislikes: ums.last_played_at (the last skip; updates
    //   on every play-start including skips via recordPlayStart).
    // The outer DISTINCT ON keeps the most recent timestamp per track when
    // the same track shows up in both legs.
    const rows = await sql<{ track_id: string }[]>`
        SELECT track_id FROM (
            SELECT DISTINCT ON (track_id) track_id, ts FROM (
                SELECT ur.media_id AS track_id, ur.created_at AS ts
                FROM user_ratings ur
                JOIN media_items m ON m.id = ur.media_id AND m.media_type = 'track'
                WHERE ur.user_id = ${userId}
                  AND (ur.rating <= 3 OR ur.skipped = TRUE)

                UNION ALL

                -- Behavioral dislike: skip-dominant. play_count already
                -- increments on every attempt (including skips) via
                -- recordPlayStart, so the correct denominator is play_count
                -- alone -- NOT play_count + skip_count, which would double-
                -- count skips and cap the ratio at 0.5.
                SELECT ums.track_id, ums.last_played_at AS ts
                FROM user_music_state ums
                WHERE ums.user_id = ${userId}
                  AND ums.play_count >= 3
                  AND ums.skip_count::float /
                      GREATEST(ums.play_count, 1) > 0.7
            ) combined
            ORDER BY track_id, ts DESC NULLS LAST
        ) deduped
        ORDER BY ts DESC NULLS LAST
        LIMIT 500
    `;
    return rows.map((r) => r.track_id);
}

/**
 * Embeddings of explicitly-disliked tracks — fed to Rocchio-style
 * negative-centroid subtraction (Fix C). Behavioral skips are NOT included
 * here since those might be burn-out rather than taste signals.
 */
export async function getDislikedEmbeddings(
    sql: postgres.Sql,
    userId: UserId,
    limit = 200,
): Promise<TrackEmbeddingRow[]> {
    return sql<TrackEmbeddingRow[]>`
        SELECT DISTINCT me.media_id AS track_id, me.embedding
        FROM user_ratings ur
        JOIN media_items m ON m.id = ur.media_id AND m.media_type = 'track'
        JOIN media_embeddings me
          ON me.media_id = ur.media_id AND me.source = 'music'
        WHERE ur.user_id = ${userId}
          AND (ur.rating <= 3 OR ur.skipped = TRUE)
        LIMIT ${limit}
    `;
}

/** RecentTrackRow extended with embedding + similarity for cluster sampling. */
export interface CentroidNeighborRow extends RecentTrackRow {
    embedding: number[] | string;
    similarity: number;
}

/**
 * Top-N played tracks (by play count) and their music embeddings.
 * Used as the input vector set for k-means clustering of user taste.
 *
 * Returns `is_liked = true` for tracks with rating >= 8 so callers can
 * up-weight them in the clustering input (Fix D — likes pull harder than
 * neutral plays).
 *
 * Excludes tracks with rating <= 3 or ur.skipped = TRUE — explicit dislikes
 * must never shape the positive centroid. Behavioral skips remain in the
 * set (they might be burn-out, not dislike — handled via Rocchio only for
 * explicit signals).
 */
export async function getTopPlayedEmbeddings(
    sql: postgres.Sql,
    userId: UserId,
    limit = 50,
): Promise<TrackEmbeddingRow[]> {
    return sql<TrackEmbeddingRow[]>`
        SELECT ums.track_id,
               me.embedding,
               COALESCE(ur.rating, 0) >= 8 AS is_liked
        FROM user_music_state ums
        JOIN media_items track
          ON track.id = ums.track_id AND track.media_type = 'track' AND track.has_files = true
        JOIN media_embeddings me
          ON me.media_id = ums.track_id AND me.source = 'music'
        LEFT JOIN user_ratings ur
          ON ur.media_id = ums.track_id AND ur.user_id = ums.user_id
        WHERE ums.user_id = ${userId}
          AND ums.play_count > 0
          AND (ur.rating IS NULL OR ur.rating >= 4)
          AND (ur.skipped IS NULL OR ur.skipped = FALSE)
        ORDER BY ums.play_count DESC, ums.last_played_at DESC NULLS LAST
        LIMIT ${limit}
    `;
}

/**
 * pgvector kNN against a caller-supplied centroid (as plain number[]).
 * Used by Quick Picks to sample around each k-means cluster centroid.
 *
 * The centroid is serialized to the pgvector text format `[1,2,3]` and cast
 * with `::vector` server-side, matching the column's type.
 */
/**
 * Like getTracksNearCentroid, but ONLY returns tracks the user has never
 * played (`user_music_state.play_count` is null or zero). Used by the
 * `new-discovery` bucket to guarantee genuinely fresh content — closes the
 * Spotify Discover Weekly gap where the algorithm currently over-indexes on
 * already-familiar tracks.
 */
export async function getNeverPlayedTracksNearCentroid(
    sql: postgres.Sql,
    userId: UserId,
    centroid: number[],
    excludeIds: string[],
    limit = 40,
): Promise<CentroidNeighborRow[]> {
    if (centroid.length === 0) return [];
    if (!centroid.every(Number.isFinite)) return [];

    const safeExclude =
        excludeIds.length > 0 ? excludeIds : ['00000000-0000-0000-0000-000000000000'];

    const centroidLiteral = `[${centroid.map((n) => n.toFixed(8)).join(',')}]`;

    // HNSW recall guard: prod runs hnsw.ef_search=40, so the ANN stage below
    // only visits ~40 candidates before the never-played + exclude filters
    // are applied. Never-played tracks are NOT evenly distributed near the
    // centroid (played tracks cluster there too), so give this one generous
    // slack beyond the raw exclude-list size — 2x limit — on top of the usual
    // limit+excludeCount sizing.
    const excludeCount = excludeIds.length + 2 * limit;

    // This bucket needs a MUCH deeper ANN pool than the played variant, and
    // the reason is structural rather than a tuning preference.
    //
    // The centroid is the average of the user's own most-played tracks, so
    // the region around it is densely packed with tracks they have already
    // played — precisely the rows this query then throws away. Measured on
    // prod for a user with 579 played tracks, roughly 100 played tracks sit
    // nearer to the centroid than the FIRST never-played one. A pool sized
    // like the played variant's (limit + excludeCount ~= 105) is therefore
    // exhausted before it reaches a single good candidate:
    //
    //   annLimit=105 -> 1 of 15 rows matched the exact-scan result
    //   annLimit=400 -> 15 of 15 matched
    //
    // 400 is the measured floor for that user, not a round number. Heavier
    // listeners crowd the centroid harder, so the pool scales with the
    // exclude list and is allowed to run to the 1000 cap; past that, recall
    // degrades gracefully (slightly more distant recommendations) rather
    // than breaking.
    //
    // The cost is real — ~150-300ms rather than the ~4ms the played variant
    // achieves — but this bucket is pinned for 24h per user, so it runs at
    // most once per user per day. Trading a once-daily 200ms for correct
    // discovery results is the right side of that bargain, and it is still
    // ~10x faster than the 1.75s full-table scan it replaces.
    const annLimit = Math.min(1000, Math.max(400, limit + excludeCount));
    // ef_search must cover the pool — HNSW returns at most ef_search
    // candidates, so a pool larger than ef_search would silently return
    // fewer rows.
    const efSearch = annLimit;

    return await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await tx`SELECT set_config('hnsw.ef_search', ${String(efSearch)}, true)`;
        // Force the ANN stage onto the HNSW index.
        //
        // `media_embeddings` is small enough (~28k rows) that a full scan
        // keeps looking cheap to the planner, and pgvector's HNSW startup
        // cost estimate is not monotonic in ef_search — measured on prod with
        // the identical bound-parameter query:
        //
        //   ef_search=64   -> Seq Scan + top-N heapsort   119 ms
        //   ef_search=400  -> idx_me_music_hnsw            12 ms
        //   ef_search=64  + enable_seqscan=off -> hnsw      2.6 ms
        //
        // So the planner picks the 45x-slower plan at the SMALLER ef_search.
        // Leaving that to the cost model is what the two-stage split alone
        // could not fix: the split removes the filters that made the index
        // unusable, but the planner can still decline the index on price.
        // is_local=true scopes this to the surrounding transaction, exactly
        // like the ef_search setting above.
        await tx`SELECT set_config('enable_seqscan', 'off', true)`;

        // Two-stage: pure ANN inside `ann`, every filter outside it. See
        // {@link musicAnnCandidates} for why they must not be merged.
        return tx<CentroidNeighborRow[]>`
            WITH ann AS MATERIALIZED (
                ${musicAnnCandidates(sql, centroidLiteral, annLimit)}
            )
            SELECT
                track.id,
                track.title,
                track.sort_order,
                track.runtime_seconds,
                track.custom_poster_url,
                COALESCE(track.custom_metadata, '{}'::jsonb) AS custom_metadata,
                album.id AS album_id,
                album.title AS album_title,
                album.custom_poster_url AS album_custom_poster_url,
                ${trackArtistIdSql(sql)} AS artist_id,
                ${trackDisplayArtistSql(sql)} AS artist_title,
                track.created_at::text AS last_played_at,
                NULL::double precision AS hours_since_played,
                ann.embedding AS embedding,
                (1 - ann.ann_distance)::double precision AS similarity,
                mf.file_path AS file_path
            FROM ann
            JOIN media_items track ON track.id = ann.media_id
            LEFT JOIN media_items album ON album.id = track.parent_id AND album.media_type = 'album'
            LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
            LEFT JOIN user_music_state ums ON ums.track_id = track.id AND ums.user_id = ${userId}
            ${trackFilePathJoin(sql)}
            WHERE track.media_type = 'track'
              AND track.has_files = true
              ${quickPickQualityFilter(sql)}
              AND (ums.play_count IS NULL OR ums.play_count = 0)
              AND track.id != ALL(${safeExclude})
            ORDER BY ann.ann_distance ASC
            LIMIT ${limit}
        `;
    });
}

export async function getTracksNearCentroid(
    sql: postgres.Sql,
    userId: UserId,
    centroid: number[],
    excludeIds: string[],
    limit = 40,
): Promise<CentroidNeighborRow[]> {
    if (centroid.length === 0) return [];
    // Guard against NaN / Infinity in the centroid — pgvector will reject or
    // silently produce garbage on those, and we must never interpolate
    // non-finite values into the SQL text.
    if (!centroid.every(Number.isFinite)) return [];

    const safeExclude =
        excludeIds.length > 0 ? excludeIds : ['00000000-0000-0000-0000-000000000000'];

    // Serialize as pgvector's text format. The value is passed as a
    // parameterized string (postgres.js escapes it) and cast to `::vector`
    // server-side — never interpolated as raw SQL.
    //
    // `toFixed(8)` forces decimal notation: JS's default `Number.toString`
    // emits scientific notation for magnitudes < 1e-6 (e.g. `1e-10`), and
    // older pgvector parser versions reject that. Eight decimal places is
    // ample precision for unit-norm embeddings.
    const centroidLiteral = `[${centroid.map((n) => n.toFixed(8)).join(',')}]`;

    // HNSW recall guard: prod runs hnsw.ef_search=40, so the ANN stage below
    // only visits ~40 candidates before the outer filters are applied — a
    // real session's exclude list (recently-played + cross-bucket dedupe) can
    // reach into the hundreds and starve recall to 0 rows.
    const efSearch = Math.min(1000, Math.max(64, limit + excludeIds.length));
    // The ANN pool the outer filters get to whittle down. Tied to efSearch
    // because HNSW returns at most ef_search candidates — see
    // {@link musicAnnCandidates}. The two must always move together.
    const annLimit = efSearch;

    return await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await tx`SELECT set_config('hnsw.ef_search', ${String(efSearch)}, true)`;
        // Force the ANN stage onto the HNSW index.
        //
        // `media_embeddings` is small enough (~28k rows) that a full scan
        // keeps looking cheap to the planner, and pgvector's HNSW startup
        // cost estimate is not monotonic in ef_search — measured on prod with
        // the identical bound-parameter query:
        //
        //   ef_search=64   -> Seq Scan + top-N heapsort   119 ms
        //   ef_search=400  -> idx_me_music_hnsw            12 ms
        //   ef_search=64  + enable_seqscan=off -> hnsw      2.6 ms
        //
        // So the planner picks the 45x-slower plan at the SMALLER ef_search.
        // Leaving that to the cost model is what the two-stage split alone
        // could not fix: the split removes the filters that made the index
        // unusable, but the planner can still decline the index on price.
        // is_local=true scopes this to the surrounding transaction, exactly
        // like the ef_search setting above.
        await tx`SELECT set_config('enable_seqscan', 'off', true)`;

        // Two-stage: pure ANN inside `ann`, every filter outside it. Folding
        // the filters back into the ANN stage costs a ~250x planner
        // regression — see {@link musicAnnCandidates}.
        return tx<CentroidNeighborRow[]>`
            WITH ann AS MATERIALIZED (
                ${musicAnnCandidates(sql, centroidLiteral, annLimit)}
            )
            SELECT
                track.id,
                track.title,
                track.sort_order,
                track.runtime_seconds,
                track.custom_poster_url,
                COALESCE(track.custom_metadata, '{}'::jsonb) AS custom_metadata,
                album.id AS album_id,
                album.title AS album_title,
                album.custom_poster_url AS album_custom_poster_url,
                ${trackArtistIdSql(sql)} AS artist_id,
                ${trackDisplayArtistSql(sql)} AS artist_title,
                track.created_at::text AS last_played_at,
                (EXTRACT(EPOCH FROM (NOW() - ums.last_played_at)) / 3600)::double precision AS hours_since_played,
                ann.embedding AS embedding,
                (1 - ann.ann_distance)::double precision AS similarity,
                mf.file_path AS file_path
            FROM ann
            JOIN media_items track ON track.id = ann.media_id
            LEFT JOIN media_items album ON album.id = track.parent_id AND album.media_type = 'album'
            LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
            LEFT JOIN user_music_state ums ON ums.track_id = track.id AND ums.user_id = ${userId}
            ${trackFilePathJoin(sql)}
            WHERE track.media_type = 'track'
              AND track.has_files = true
              ${quickPickQualityFilter(sql)}
              AND track.id != ALL(${safeExclude})
            ORDER BY ann.ann_distance ASC
            LIMIT ${limit}
        `;
    });
}

/**
 * Sonic-space kNN variant of {@link getTracksNearCentroid}.
 *
 * Queries `media_audio_embeddings` (MSCLAP, 1024-dim) instead of the
 * metadata `media_embeddings` (1536-dim). The centroid must therefore be a
 * 1024-dim vector — callers must NOT mix centroids from the two spaces.
 *
 * The result shape (`CentroidNeighborRow`) is identical so callers can branch
 * on the feature flag and pass the result to the shared MMR re-ranker without
 * any further adaptation.
 *
 * Centroid serialization and guard logic are identical to
 * {@link getTracksNearCentroid} — see its inline comments for rationale.
 *
 * @param sql        - postgres.Sql instance.
 * @param userId     - User ID for recently-played hours calculation.
 * @param centroid   - 1024-dim MSCLAP centroid vector.
 * @param excludeIds - Track UUIDs to exclude (recently played).
 * @param limit      - Max tracks to return (default 40).
 */
/**
 * Sonic-space never-played kNN — the `sonic-discovery` bucket analog of
 * {@link getNeverPlayedTracksNearCentroid}.
 *
 * Queries `media_audio_embeddings` (MSCLAP, 1024-dim) instead of the
 * metadata `media_embeddings` (1536-dim). The centroid must be a 1024-dim
 * MSCLAP vector — DO NOT mix centroids from the two embedding spaces.
 *
 * Only returns tracks the user has never played (`play_count IS NULL OR 0`).
 * Adds `AND track.status = 'active'` consistent with the other sonic queries.
 *
 * @param sql       - postgres.Sql instance (parameterized).
 * @param userId    - User ID for the never-played filter.
 * @param centroid  - 1024-dim MSCLAP centroid vector.
 * @param excludeIds - Track UUIDs to exclude (recently played + personalised).
 * @param limit     - Max tracks to return (default 40).
 */
export async function getNeverPlayedSonicTracksNearCentroid(
    sql: postgres.Sql,
    userId: UserId,
    centroid: number[],
    excludeIds: string[],
    limit = 40,
): Promise<CentroidNeighborRow[]> {
    if (centroid.length === 0) return [];
    if (!centroid.every(Number.isFinite)) return [];

    const safeExclude =
        excludeIds.length > 0 ? excludeIds : ['00000000-0000-0000-0000-000000000000'];

    const centroidLiteral = `[${centroid.map((n) => n.toFixed(8)).join(',')}]`;

    // This bucket needs a far deeper ANN pool than the played variant, for the
    // structural reason spelled out on {@link getNeverPlayedTracksNearCentroid}:
    // the centroid is derived from what the user already listens to, so
    // already-played tracks crowd exactly the region this query searches and
    // are then discarded. Sizing this pool like the played variant's returned
    // 1 of 15 correct rows in the metadata equivalent — faster and materially
    // worse, invisible to every timing signal. 400 is the measured floor.
    const excludeCount = excludeIds.length + 2 * limit;
    const annLimit = Math.min(1000, Math.max(400, limit + excludeCount));
    // ef_search must cover the pool, or HNSW silently returns fewer rows.
    const efSearch = annLimit;

    return await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await tx`SELECT set_config('hnsw.ef_search', ${String(efSearch)}, true)`;
        // Force the ANN stage onto the HNSW index — see {@link sonicAnnCandidates}.
        // Without this the planner prices a full scan of the ~30k-row
        // embedding table below the index and top-N heapsorts it (667ms on
        // prod). is_local=true scopes the setting to this transaction.
        await tx`SELECT set_config('enable_seqscan', 'off', true)`;

        return tx<CentroidNeighborRow[]>`
            WITH ann AS MATERIALIZED (
                ${sonicAnnCandidates(sql, centroidLiteral, MSCLAP_MODEL_ID, annLimit)}
            )
            SELECT
                track.id,
                track.title,
                track.sort_order,
                track.runtime_seconds,
                track.custom_poster_url,
                COALESCE(track.custom_metadata, '{}'::jsonb) AS custom_metadata,
                album.id AS album_id,
                album.title AS album_title,
                album.custom_poster_url AS album_custom_poster_url,
                ${trackArtistIdSql(sql)} AS artist_id,
                ${trackDisplayArtistSql(sql)} AS artist_title,
                track.created_at::text AS last_played_at,
                NULL::double precision AS hours_since_played,
                ann.embedding AS embedding,
                (1 - ann.ann_distance)::double precision AS similarity,
                mf.file_path AS file_path
            FROM ann
            JOIN media_items track ON track.id = ann.media_id
            LEFT JOIN media_items album ON album.id = track.parent_id AND album.media_type = 'album'
            LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
            LEFT JOIN user_music_state ums ON ums.track_id = track.id AND ums.user_id = ${userId}
            ${trackFilePathJoin(sql)}
            WHERE track.media_type = 'track'
              AND track.has_files = true
              AND track.status = 'active'
              AND (ums.play_count IS NULL OR ums.play_count = 0)
              AND track.id != ALL(${safeExclude})
            ORDER BY ann.ann_distance ASC
            LIMIT ${limit}
        `;
    });
}

export async function getSonicTracksNearCentroid(
    sql: postgres.Sql,
    userId: UserId,
    centroid: number[],
    excludeIds: string[],
    limit = 40,
): Promise<CentroidNeighborRow[]> {
    if (centroid.length === 0) return [];
    if (!centroid.every(Number.isFinite)) return [];

    const safeExclude =
        excludeIds.length > 0 ? excludeIds : ['00000000-0000-0000-0000-000000000000'];

    const centroidLiteral = `[${centroid.map((n) => n.toFixed(8)).join(',')}]`;

    // HNSW recall guard: the ANN stage below only visits ~ef_search candidates
    // before the outer filters are applied — a real session's exclude list can
    // reach into the hundreds and starve recall to 0 rows.
    const efSearch = Math.min(1000, Math.max(64, limit + excludeIds.length));
    // ANN pool the outer filters whittle down — see {@link sonicAnnCandidates}.
    // Tied to efSearch: HNSW returns at most ef_search candidates.
    const annLimit = efSearch;

    return await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await tx`SELECT set_config('hnsw.ef_search', ${String(efSearch)}, true)`;
        // Force the ANN stage onto the HNSW index — see {@link sonicAnnCandidates}.
        // Without this the planner prices a full scan of the ~30k-row
        // embedding table below the index and top-N heapsorts it (667ms on
        // prod). is_local=true scopes the setting to this transaction.
        await tx`SELECT set_config('enable_seqscan', 'off', true)`;

        return tx<CentroidNeighborRow[]>`
            WITH ann AS MATERIALIZED (
                ${sonicAnnCandidates(sql, centroidLiteral, MSCLAP_MODEL_ID, annLimit)}
            )
            SELECT
                track.id,
                track.title,
                track.sort_order,
                track.runtime_seconds,
                track.custom_poster_url,
                COALESCE(track.custom_metadata, '{}'::jsonb) AS custom_metadata,
                album.id AS album_id,
                album.title AS album_title,
                album.custom_poster_url AS album_custom_poster_url,
                ${trackArtistIdSql(sql)} AS artist_id,
                ${trackDisplayArtistSql(sql)} AS artist_title,
                track.created_at::text AS last_played_at,
                (EXTRACT(EPOCH FROM (NOW() - ums.last_played_at)) / 3600)::double precision AS hours_since_played,
                ann.embedding AS embedding,
                (1 - ann.ann_distance)::double precision AS similarity,
                mf.file_path AS file_path
            FROM ann
            JOIN media_items track ON track.id = ann.media_id
            LEFT JOIN media_items album ON album.id = track.parent_id AND album.media_type = 'album'
            LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
            LEFT JOIN user_music_state ums ON ums.track_id = track.id AND ums.user_id = ${userId}
            ${trackFilePathJoin(sql)}
            WHERE track.media_type = 'track'
              AND track.has_files = true
              AND track.status = 'active'
              AND track.id != ALL(${safeExclude})
            ORDER BY ann.ann_distance ASC
            LIMIT ${limit}
        `;
    });
}
