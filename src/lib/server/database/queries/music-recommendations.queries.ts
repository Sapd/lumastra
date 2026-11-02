// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music Recommendations Query Module
 *
 * Pure SQL queries for music-specific recommendation features:
 * - Because You Listened (track-to-track embedding similarity)
 * - Smart Mixes (genre-clustered recommendations from listening history)
 * - Mood Recommendations (pre-computed mood vectors from mood_vectors table)
 *
 * All functions take sql: postgres.Sql as first parameter, no side effects.
 *
 * @module queries/music-recommendations
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import {
    trackDisplayArtistSql,
    trackArtistIdSql,
    trackArtistsSql,
    trackRemixerArtistsSql,
    canonicalTrackArtistsJoinSql,
    trackCreditArtistsSql,
} from './fragments/music-artist.fragments.js';
import type { AgeRatingFilterParams } from './builders/age-rating.builder.js';
import { PG_TEXT_OID } from './builders/keyset-cursor.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { MSCLAP_MODEL_ID } from './sonic-constants.js';
import { getMoodVector } from './sonic-queue.queries.js';
import {
    FEAT_TAG_REGEX,
    FEAT_DASH_SUFFIX_REGEX,
    VERSION_ONLY_SQL_PATTERN,
    TRAILING_VARIANT_SEGMENT_SQL_PATTERN,
} from './music-title-normalize.js';

// =============================================================================
// Types
// =============================================================================

export interface BecauseYouListenedRow {
    id: string;
    title: string;
    artist_title: string;
    artist_id: string | null;
    track_artists?: Array<{ id: string | null; title: string }> | null;
    remixer_artists?: Array<{ id: string | null; title: string }> | null;
    album_id: string | null;
    album_title: string | null;
    runtime_seconds: number | null;
    custom_poster_url: string | null;
    similarity: number;
}

export interface SmartMixTrackRow {
    id: string;
    title: string;
    artist_title: string;
    artist_id: string | null;
    track_artists?: Array<{ id: string | null; title: string }> | null;
    remixer_artists?: Array<{ id: string | null; title: string }> | null;
    album_id: string | null;
    custom_poster_url: string | null;
}

export interface SmartMixRow {
    genre: string;
    tracks: SmartMixTrackRow[];
}

export interface MoodRecommendationRow {
    id: string;
    title: string;
    artist_title: string;
    artist_id: string | null;
    track_artists?: Array<{ id: string | null; title: string }> | null;
    remixer_artists?: Array<{ id: string | null; title: string }> | null;
    album_id: string | null;
    album_title: string | null;
    custom_poster_url: string | null;
    /** Track metadata JSON — carries the Essentia `ess.*` audio-analysis fields. */
    custom_metadata: Record<string, unknown>;
    similarity: number;
    /**
     * `distance::text` — the exact `float8` cosine-distance rendering used to
     * mint the next keyset cursor (round-trips losslessly; float8 IS the JS
     * number type, but bind it back via TEXT OID + `::float8` all the same).
     * Only consumed by the cursor def; keep it a bare string.
     */
    distance_cursor?: string;
}

/**
 * Decoded keyset cursor for {@link getMusicMoodRecommendations} — mirrors the
 * `(distance ASC, track.id ASC)` ordering. `distance` is the exact
 * `float8`-rendered cosine distance; `id` is the unique tiebreak. `distance` is
 * never NULL (inner join on `media_audio_embeddings`), so there is no
 * NULL-group carry (Gate D2b N/A for this feed).
 */
export interface MoodRecommendationsCursor {
    distance: string;
    id: string;
}

export interface NewForYouRow {
    id: string;
    title: string;
    artist_title: string;
    artist_id: string | null;
    track_artists?: Array<{ id: string | null; title: string }> | null;
    remixer_artists?: Array<{ id: string | null; title: string }> | null;
    album_id: string | null;
    album_title: string | null;
    runtime_seconds: number | null;
    custom_poster_url: string | null;
    created_at: string;
}

// =============================================================================
// Because You Listened
// =============================================================================

/**
 * Get music recommendations based on a specific track's embedding similarity.
 * "Because you listened to [track]"
 *
 * Uses pgvector cosine distance against the track's 'music' source embedding.
 * Excludes the source track and any caller-supplied IDs (e.g. recently skipped).
 * Only matches audio media_type tracks.
 *
 * Diversity is enforced in three ways:
 * 1. Near-duplicate filter: drops candidates with similarity > 0.99
 *    (catches greatest-hits/live/remaster duplicates of the same recording).
 * 2. Per-artist cap: at most MAX_TRACKS_PER_ARTIST tracks from any single
 *    artist. Without this, same-artist tracks dominate top-K because they
 *    share genre/era/artist tokens in the embedding text. "Various Artists"
 *    is exempted (each VA track partitions individually) so compilation
 *    albums aren't collapsed into a single 2-track quota.
 * 3. Per-album cap: at most MAX_TRACKS_PER_ALBUM tracks from any single
 *    album. Limits compilation/album dominance even after the artist
 *    exemption.
 */
export async function getMusicBecauseYouListened(
    sql: postgres.Sql,
    trackId: string,
    excludeIds: string[],
    limit: number,
    access: {
        deniedGroupIds: string[] | null;
        ageRating: AgeRatingFilterParams | null;
    },
    dislikedTrackIds: string[] = [],
): Promise<BecauseYouListenedRow[]> {
    // Merge the caller's per-request excludes (e.g. recently-played) with the
    // user's hard-disliked tracks so disliked recordings never surface as a
    // "because you listened" recommendation. Both feed the same `!= ALL(...)`
    // clause against the candidate track id.
    const mergedExclude =
        dislikedTrackIds.length > 0 ? [...excludeIds, ...dislikedTrackIds] : excludeIds;
    const safeExclude = mergedExclude.length > 0 ? mergedExclude : [];
    const NEAR_DUPLICATE_DISTANCE_THRESHOLD = 0.01; // similarity > 0.99
    const MAX_TRACKS_PER_ARTIST = 2;
    const MAX_TRACKS_PER_ALBUM = 2;
    const MAX_TRACKS_PER_BASE_TITLE = 1;
    // Library filter against the candidate track (`track` alias inside the
    // CTE). Tracks are the file-bearing rows, so the standard file/group
    // check applies directly; over-age tracks are dropped via the age
    // filter against media_items.age_rating (track row).
    const libraryFilter =
        access.deniedGroupIds && access.deniedGroupIds.length > 0
            ? sql`AND EXISTS (
                SELECT 1 FROM media_file_items mfi
                JOIN media_files mf ON mf.id = mfi.file_id
                WHERE mfi.media_item_id = track.id
                  AND (mf.library_group_id IS NULL
                       OR mf.library_group_id != ALL(${access.deniedGroupIds}::uuid[]))
            )`
            : sql``;
    const ageFilter =
        access.ageRating && access.ageRating.maxAgeRating !== null
            ? sql`AND (
                (track.age_rating IS NULL AND ${access.ageRating.allowUnrated}::boolean)
                OR track.age_rating <= ${access.ageRating.maxAgeRating}
            )`
            : sql``;
    const CANDIDATE_POOL_MULTIPLIER = 16;
    const candidatePoolSize = limit * CANDIDATE_POOL_MULTIPLIER;

    return sql<BecauseYouListenedRow[]>`
        WITH current_embedding AS (
            SELECT me.embedding
            FROM media_embeddings me
            WHERE me.media_id = ${trackId}
              AND me.source = 'music'
            LIMIT 1
        ),
        candidates_base AS MATERIALIZED (
            -- Rank by distance and LIMIT *before* joining album/artist. The
            -- album/artist LEFT JOINs used to sit in the same FROM clause as
            -- this ORDER BY + LIMIT, which meant Postgres computed them for
            -- every track/embedding match and only threw away the losers afterward —
            -- the LIMIT never got pushed through the join. MATERIALIZED pins
            -- this CTE as an optimization fence so the enrichment join below
            -- runs over exactly candidatePoolSize rows.
            --
            -- EXPLAIN (ANALYZE, BUFFERS) confirmed that materializing reduced
            -- the nested-loop enrichment work. Result sets were byte-identical
            -- and retained the same order.
            SELECT
                track.id,
                track.title,
                track.custom_metadata,
                track.parent_id,
                track.runtime_seconds,
                track.custom_poster_url,
                me.embedding <=> ce.embedding AS distance
            FROM media_items track
            JOIN media_embeddings me ON me.media_id = track.id AND me.source = 'music'
            CROSS JOIN current_embedding ce
            WHERE track.media_type = 'track'
              AND track.has_files = true
              AND track.id != ${trackId}
              AND track.id != ALL(${safeExclude}::uuid[])
              ${libraryFilter}
              ${ageFilter}
            ORDER BY me.embedding <=> ce.embedding ASC
            LIMIT ${candidatePoolSize}
        ),
        candidates AS (
            -- The diversity caps below partition on the artist, so the credit
            -- is resolved here, once per pooled row. The list and remixer
            -- columns wait for the final LIMIT.
            SELECT
                track.id,
                track.title,
                COALESCE(${trackDisplayArtistSql(sql, 'track', trackCreditArtistsSql(sql))}, '') AS artist_title,
                ${trackArtistIdSql(sql, 'track', trackCreditArtistsSql(sql))} AS artist_id,
                track_credit.artists AS canonical_artists,
                track.custom_metadata,
                COALESCE(artist.is_various_artists, false) AS is_various_artists,
                album.id AS album_id,
                album.title AS album_title,
                track.runtime_seconds,
                COALESCE(track.custom_poster_url, album.custom_poster_url) AS custom_poster_url,
                track.distance
            FROM candidates_base AS track
            LEFT JOIN media_items album
                ON album.id = track.parent_id AND album.media_type = 'album'
            LEFT JOIN media_items artist
                ON artist.id = album.parent_id AND artist.media_type = 'artist'
            ${canonicalTrackArtistsJoinSql(sql)}
        ),
        ranked AS (
            SELECT
                c.*,
                ROW_NUMBER() OVER (
                    PARTITION BY CASE
                        WHEN c.is_various_artists
                            THEN 'va:' || c.id::text
                        ELSE COALESCE(
                            c.artist_id::text,
                            NULLIF(c.artist_title, ''),
                            'orphan:' || c.id::text
                        )
                    END
                    ORDER BY c.distance ASC, c.id ASC
                ) AS artist_rank,
                ROW_NUMBER() OVER (
                    PARTITION BY COALESCE(c.album_id::text, 'no-album:' || c.id::text)
                    ORDER BY c.distance ASC, c.id ASC
                ) AS album_rank,
                ROW_NUMBER() OVER (
                    PARTITION BY CASE
                        WHEN c.is_various_artists
                            THEN 'va:' || c.id::text
                        ELSE COALESCE(c.artist_id::text, NULLIF(c.artist_title, ''), 'orphan') || ':' ||
                            REGEXP_REPLACE(LOWER(TRIM(c.title)), ${TRAILING_VARIANT_SEGMENT_SQL_PATTERN}, '', 'g')
                    END
                    ORDER BY
                        -- Prefer the untagged (original) title as the survivor
                        -- of the per-title dedup — featuring credits are
                        -- stripped first so "(feat. X)" never counts as a
                        -- version tag. COALESCE guards NULL titles: a NULL ~*
                        -- pattern match is NULL (falsy in the CASE), which
                        -- would otherwise rank a NULL-titled row as "preferred original".
                        CASE
                            WHEN regexp_replace(
                                regexp_replace(COALESCE(c.title, ''), ${FEAT_TAG_REGEX}, '', 'gi'),
                                ${FEAT_DASH_SUFFIX_REGEX}, '', 'gi'
                            ) ~* ${VERSION_ONLY_SQL_PATTERN}
                                THEN 1
                            ELSE 0
                        END ASC,
                        c.distance ASC,
                        c.id ASC
                ) AS title_rank
            FROM candidates c
            WHERE c.distance > ${NEAR_DUPLICATE_DISTANCE_THRESHOLD}
        )
        SELECT
            track.id,
            track.title,
            track.artist_title,
            track.artist_id,
            ${trackArtistsSql(sql, 'track', sql`track.canonical_artists`)} AS track_artists,
            ${trackRemixerArtistsSql(sql)} AS remixer_artists,
            track.album_id,
            track.album_title,
            track.runtime_seconds,
            track.custom_poster_url,
            1 - track.distance AS similarity
        FROM (
            SELECT *
            FROM ranked
            WHERE artist_rank <= ${MAX_TRACKS_PER_ARTIST}
              AND album_rank <= ${MAX_TRACKS_PER_ALBUM}
              AND title_rank <= ${MAX_TRACKS_PER_BASE_TITLE}
            ORDER BY distance ASC, id ASC
            LIMIT ${limit}
        ) AS track
        ORDER BY track.distance ASC, track.id ASC
    `;
}

// =============================================================================
// Smart Mixes
// =============================================================================

/**
 * Get genre-clustered mixes for a user based on their listening history.
 * Returns top genres with representative tracks.
 *
 * Steps:
 * 1. Find the user's most-listened genres from `user_music_state`, unnesting
 *    the genre JSON array from each track's custom_metadata. Genre data lives
 *    on tracks, not albums.
 *
 *    Sourced from `user_music_state`, NOT `watch_history`. This read used to
 *    count watch_history rows, which is the VIDEO playback path — measured on
 *    production it holds 10,018 rows of which exactly 4 are music tracks,
 *    across every user. Smart Mixes therefore returned an empty section list
 *    for everyone, silently: the endpoint 200s with `{sections: []}`, so it
 *    looked like "this user has no mixes yet" rather than a broken query.
 *    `user_music_state` is where music playback is actually recorded (play,
 *    skip and complete counts, with three purpose-built indexes) and is the
 *    same source the genre-rail ranker uses, so the two agree on what a user
 *    listens to.
 * 2. Compute each genre centroid as the average embedding of all tracks
 *    that include that genre in their genre array.
 * 3. For each top genre, return up to 24 representative tracks ordered by
 *    embedding similarity to the genre centroid.
 *
 * Genre field stores JSON arrays: ["Electronic", "Hardstyle"]. A CASE on
 * jsonb_typeof handles legacy scalar strings gracefully.
 */
export async function getMusicSmartMixes(
    sql: postgres.Sql,
    userId: UserId,
    limit: number,
    access: {
        deniedGroupIds: string[] | null;
        ageRating: AgeRatingFilterParams | null;
    },
    dislikedTrackIds: string[] = [],
): Promise<SmartMixRow[]> {
    const tracksPerMix = 24;
    // Diversity caps mirror Because-You-Listened: without them a genre mix
    // collapses to back-to-back tracks from the same artist/album (they share
    // genre/era tokens and sit equidistant from the centroid). "Various
    // Artists" is exempt from the artist cap so compilation albums aren't
    // squeezed into a single 2-track quota.
    const MAX_TRACKS_PER_ARTIST = 2;
    const MAX_TRACKS_PER_ALBUM = 2;
    // Over-fetch per genre before applying the caps + per-request rank so each
    // mix still has `tracksPerMix` survivors after diversity trimming. Bumped
    // from 8x to 10x to give the added title_rank dedup (below) enough
    // headroom to still leave `tracksPerMix` survivors per genre.
    const CANDIDATE_POOL_PER_MIX = tracksPerMix * 10;
    // Cap the centroid input so a popular genre with thousands of tracks
    // doesn't average the entire library on every request. A bounded,
    // deterministic per-genre sample keeps the centroid stable for the
    // exact distance ranking in genre_candidates.
    const CENTROID_SAMPLE_SIZE = 400;
    const safeDisliked = dislikedTrackIds.length > 0 ? dislikedTrackIds : [];
    const libraryFilter =
        access.deniedGroupIds && access.deniedGroupIds.length > 0
            ? sql`AND EXISTS (
                SELECT 1 FROM media_file_items mfi
                JOIN media_files mf ON mf.id = mfi.file_id
                WHERE mfi.media_item_id = track.id
                  AND (mf.library_group_id IS NULL
                       OR mf.library_group_id != ALL(${access.deniedGroupIds}::uuid[]))
            )`
            : sql``;
    const ageFilter =
        access.ageRating && access.ageRating.maxAgeRating !== null
            ? sql`AND (
                (track.age_rating IS NULL AND ${access.ageRating.allowUnrated}::boolean)
                OR track.age_rating <= ${access.ageRating.maxAgeRating}
            )`
            : sql``;

    const rows = await sql<
        Array<{
            genre: string;
            id: string;
            title: string;
            artist_title: string;
            artist_id: string | null;
            track_artists?: Array<{ id: string | null; title: string }> | null;
            remixer_artists?: Array<{ id: string | null; title: string }> | null;
            album_id: string | null;
            custom_poster_url: string | null;
        }>
    >`
        WITH genre_metadata AS MATERIALIZED (
            -- Reuse the decoded genre value across the two full-library passes.
            -- Apply the same access boundary before sharing any track genres.
            SELECT track.id, track.custom_metadata->'genre' AS genre_json
            FROM media_items track
            WHERE track.media_type = 'track' AND track.has_files = true
              ${libraryFilter}
              ${ageFilter}
        ),
        track_genres AS MATERIALIZED (
            SELECT metadata.id, LOWER(TRIM(genre_elem)) AS genre
            FROM genre_metadata metadata
            CROSS JOIN LATERAL jsonb_array_elements_text(
                CASE jsonb_typeof(metadata.genre_json)
                    WHEN 'array' THEN metadata.genre_json
                    ELSE jsonb_build_array(COALESCE(metadata.genre_json #>> '{}', ''))
                END
            ) AS genre_elem
        ),
        user_genre_counts AS (
            SELECT
                LOWER(TRIM(genre_elem)) AS genre,
                SUM(GREATEST(ums.play_count, 1))::int AS play_count
            FROM user_music_state ums
            JOIN media_items track ON track.id = ums.track_id AND track.media_type = 'track' AND track.has_files = true
            CROSS JOIN LATERAL jsonb_array_elements_text(
                CASE jsonb_typeof(track.custom_metadata->'genre')
                    WHEN 'array' THEN track.custom_metadata->'genre'
                    ELSE jsonb_build_array(COALESCE(track.custom_metadata->>'genre', ''))
                END
            ) AS genre_elem
            WHERE ums.user_id = ${userId}
              AND COALESCE(track.custom_metadata->>'genre', '') != ''
              AND TRIM(genre_elem) != ''
              ${libraryFilter}
              ${ageFilter}
            GROUP BY LOWER(TRIM(genre_elem))
            ORDER BY play_count DESC
            LIMIT ${limit}
        ),
        genre_centroid_sample AS (
            -- Bounded, deterministic per-genre sample of embeddings used to
            -- compute the centroid. Ordering by track.id keeps the sample (and
            -- therefore the centroid) stable across the 3-min cache window.
            SELECT
                ugc.genre,
                me.embedding,
                ROW_NUMBER() OVER (
                    PARTITION BY ugc.genre
                    ORDER BY tg.id ASC
                ) AS sample_rank
            FROM user_genre_counts ugc
            JOIN track_genres tg ON tg.genre = ugc.genre
            JOIN media_embeddings me ON me.media_id = tg.id AND me.source = 'music'
        ),
        genre_centroids AS (
            SELECT
                gcs.genre,
                AVG(gcs.embedding) AS centroid
            FROM genre_centroid_sample gcs
            WHERE gcs.sample_rank <= ${CENTROID_SAMPLE_SIZE}
            GROUP BY gcs.genre
            HAVING vector_norm(AVG(gcs.embedding)::vector) > 0.01
        ),
        genre_candidates AS (
            -- Nearest tracks to each genre centroid, capped to a bounded pool
            -- per genre. Capping here (rather than ranking every genre track)
            -- keeps the subsequent diversity pass cheap.
            --
            -- No artist credit here: this CTE covers every track of the genre,
            -- and the credit lookup is a per-row subquery. genre_pool resolves
            -- it for the pooled rows only.
            SELECT
                gc.genre,
                track.id,
                track.title,
                track.custom_metadata,
                track.parent_id,
                track.custom_poster_url,
                me.embedding <=> gc.centroid AS distance,
                ROW_NUMBER() OVER (
                    PARTITION BY gc.genre
                    ORDER BY me.embedding <=> gc.centroid ASC, track.id ASC
                ) AS pool_rank
            FROM genre_centroids gc
            JOIN track_genres tg ON tg.genre = gc.genre
            JOIN media_items track ON track.id = tg.id
            JOIN media_embeddings me ON me.media_id = track.id AND me.source = 'music'
            WHERE gc.centroid IS NOT NULL
              AND track.id != ALL(${safeDisliked}::uuid[])
        ),
        genre_pool AS MATERIALIZED (
            -- Enrich only the capped pool, once. Before this boundary, prod
            -- joined albums/artists for 33k tracks rather than 1.2k pooled rows.
            -- Materialization also prevents the diversity ranks from expanding
            -- the same artist-credit expressions repeatedly.
            SELECT
                track.genre,
                track.id,
                track.title,
                COALESCE(${trackDisplayArtistSql(sql, 'track', trackCreditArtistsSql(sql))}, '') AS artist_title,
                ${trackArtistIdSql(sql, 'track', trackCreditArtistsSql(sql))} AS artist_id,
                track_credit.artists AS canonical_artists,
                track.custom_metadata,
                COALESCE(artist.is_various_artists, false) AS is_various_artists,
                album.id AS album_id,
                COALESCE(track.custom_poster_url, album.custom_poster_url) AS custom_poster_url,
                track.distance
            FROM genre_candidates track
            LEFT JOIN media_items album ON album.id = track.parent_id AND album.media_type = 'album'
            LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
            ${canonicalTrackArtistsJoinSql(sql)}
            WHERE track.pool_rank <= ${CANDIDATE_POOL_PER_MIX}
        ),
        diversity_ranked AS (
            SELECT
                gco.genre,
                gco.id,
                gco.title,
                gco.artist_title,
                gco.artist_id,
                gco.canonical_artists,
                gco.custom_metadata,
                gco.is_various_artists,
                gco.album_id,
                gco.custom_poster_url,
                gco.distance,
                -- Per-artist / per-album diversity ranks (mirrors BYL). VA is
                -- exempt from the artist cap so compilations aren't collapsed.
                ROW_NUMBER() OVER (
                    PARTITION BY gco.genre, CASE
                        WHEN gco.is_various_artists
                            THEN 'va:' || gco.id::text
                        ELSE COALESCE(
                            gco.artist_id::text,
                            NULLIF(gco.artist_title, ''),
                            'orphan:' || gco.id::text
                        )
                    END
                    ORDER BY gco.distance ASC, gco.id ASC
                ) AS artist_rank,
                ROW_NUMBER() OVER (
                    PARTITION BY gco.genre,
                        COALESCE(gco.album_id::text, 'no-album:' || gco.id::text)
                    ORDER BY gco.distance ASC, gco.id ASC
                ) AS album_rank,
                -- Title dedup, same partition-key + original-preference idiom
                -- as BYL's title_rank, scoped per-genre: collapse remix/edit/
                -- live variants of the same song by the same artist down to
                -- one survivor, preferring the untagged (original) title.
                -- COALESCE guards NULL titles (see BYL comment).
                ROW_NUMBER() OVER (
                    PARTITION BY gco.genre, CASE
                        WHEN gco.is_various_artists
                            THEN 'va:' || gco.id::text
                        ELSE COALESCE(
                            gco.artist_id::text,
                            NULLIF(gco.artist_title, ''),
                            'orphan'
                        ) || ':' ||
                        REGEXP_REPLACE(LOWER(TRIM(COALESCE(gco.title, ''))), ${TRAILING_VARIANT_SEGMENT_SQL_PATTERN}, '', 'g')
                    END
                    ORDER BY
                        CASE
                            WHEN regexp_replace(
                                regexp_replace(COALESCE(gco.title, ''), ${FEAT_TAG_REGEX}, '', 'gi'),
                                ${FEAT_DASH_SUFFIX_REGEX}, '', 'gi'
                            ) ~* ${VERSION_ONLY_SQL_PATTERN}
                                THEN 1
                            ELSE 0
                        END ASC,
                        gco.distance ASC,
                        gco.id ASC
                ) AS title_rank
            FROM genre_pool gco
        ),
        ranked_tracks AS (
            -- Re-rank AFTER the artist/album/title caps so each genre keeps
            -- exactly its top tracksPerMix diverse survivors by centroid distance.
            SELECT
                dr.genre,
                dr.id,
                dr.title,
                dr.artist_title,
                dr.artist_id,
                dr.canonical_artists,
                dr.custom_metadata,
                dr.album_id,
                dr.custom_poster_url,
                ROW_NUMBER() OVER (
                    PARTITION BY dr.genre
                    ORDER BY dr.distance ASC, dr.id ASC
                ) AS rn
            FROM diversity_ranked dr
            WHERE dr.artist_rank <= ${MAX_TRACKS_PER_ARTIST}
              AND dr.album_rank <= ${MAX_TRACKS_PER_ALBUM}
              AND dr.title_rank = 1
        )
        SELECT
            track.genre,
            track.id,
            track.title,
            track.artist_title,
            track.artist_id,
            ${trackArtistsSql(sql, 'track', sql`track.canonical_artists`)} AS track_artists,
            ${trackRemixerArtistsSql(sql)} AS remixer_artists,
            track.album_id,
            track.custom_poster_url
        FROM ranked_tracks track
        WHERE track.rn <= ${tracksPerMix}
        ORDER BY track.genre, track.rn
    `;

    if (rows.length === 0) return [];

    const mixMap = new Map<string, SmartMixRow>();
    for (const row of rows) {
        let mix = mixMap.get(row.genre);
        if (!mix) {
            mix = { genre: row.genre, tracks: [] };
            mixMap.set(row.genre, mix);
        }
        mix.tracks.push({
            id: row.id,
            title: row.title,
            artist_title: row.artist_title,
            artist_id: row.artist_id,
            track_artists: row.track_artists,
            remixer_artists: row.remixer_artists,
            album_id: row.album_id,
            custom_poster_url: row.custom_poster_url,
        });
    }

    return Array.from(mixMap.values());
}

// =============================================================================
// Mood Recommendations
// =============================================================================

/**
 * Get mood-based music recommendations using pre-computed mood vectors.
 *
 * Fetches the CLAP audio-space mood vector (`mood_vectors` row with
 * `model_id = MSCLAP_MODEL_ID`) via {@link getMoodVector}, then finds the
 * nearest tracks via pgvector cosine distance against `media_audio_embeddings`
 * (same MSCLAP model space). Matching happens entirely in audio space now —
 * a track's metadata/lyrics no longer factor into mood matching.
 *
 * Returns an empty array when no MSCLAP mood vector exists for `moodKey`
 * (e.g. the mood-vector-generation task hasn't produced an audio-space
 * vector for it yet). This is by design: there is no text-space fallback.
 */
export async function getMusicMoodRecommendations(
    sql: postgres.Sql,
    moodKey: string,
    limit: number,
    access: {
        deniedGroupIds: string[] | null;
        ageRating: AgeRatingFilterParams | null;
    },
    opts?: { cursor?: MoodRecommendationsCursor },
): Promise<MoodRecommendationRow[]> {
    const moodVector = await getMoodVector(sql, moodKey);
    if (!moodVector) return [];
    // Same vector-literal formatting as sonic-queue.queries.ts (getMoodVector's
    // sibling query paths) — passing the vector as a bound parameter (rather
    // than a CTE cross join) lets the HNSW index on media_audio_embeddings
    // drive the ORDER BY ... LIMIT.
    const vectorLiteral = `[${moodVector.map((n) => n.toFixed(8)).join(',')}]`;

    const libraryFilter =
        access.deniedGroupIds && access.deniedGroupIds.length > 0
            ? sql`AND EXISTS (
                SELECT 1 FROM media_file_items mfi
                JOIN media_files mf ON mf.id = mfi.file_id
                WHERE mfi.media_item_id = track.id
                  AND (mf.library_group_id IS NULL
                       OR mf.library_group_id != ALL(${access.deniedGroupIds}::uuid[]))
            )`
            : sql``;
    const ageFilter =
        access.ageRating && access.ageRating.maxAgeRating !== null
            ? sql`AND (
                (track.age_rating IS NULL AND ${access.ageRating.allowUnrated}::boolean)
                OR track.age_rating <= ${access.ageRating.maxAgeRating}
            )`
            : sql``;
    // Overfetch candidates before the per-title dedup so a mood dominated by
    // remixes still has room for the title_rank window to prefer originals.
    const CANDIDATE_POOL_MULTIPLIER = 3;
    const candidatePoolSize = limit * CANDIDATE_POOL_MULTIPLIER;

    // Opt-in keyset predicate over (distance ASC, track.id ASC). Injected into
    // the candidate pool BEFORE its LIMIT so the pool starts strictly after the
    // cursor. distance is float8 — bind the cursor as exact text pinned to OID
    // 25 (TEXT) and cast ::float8 so postgres.js does not reparse it (matches
    // the /browse/genre numeric-cursor idiom; see keyset-cursor.builder.ts).
    //
    // Caveat (documented, not a bug): the per-title variant dedup and the
    // bounded candidate pool are best-effort ACROSS pages — a song's original
    // on an earlier page and its remix on a later one can both surface, and a
    // heavily-deduped window can end pagination one page early. Both are
    // inherent to this bounded top-K rail (offset paging would behave
    // identically) and NEITHER dupes nor skips an individual track row: the
    // (distance, id) order over the raw candidate rows is a stable, reproducible
    // total order, so each track id is emitted at most once.
    const cursorPredicate = opts?.cursor
        ? sql`AND ((mae.embedding <=> ${vectorLiteral}::vector), track.id) > (${sql.typed(opts.cursor.distance, PG_TEXT_OID)}::float8, ${opts.cursor.id}::uuid)`
        : sql``;

    return sql<MoodRecommendationRow[]>`
        WITH candidates AS (
            SELECT
                track.id,
                track.title,
                artist.id AS album_artist_id,
                COALESCE(artist.is_various_artists, false) AS is_various_artists,
                album.id AS album_id,
                album.title AS album_title,
                COALESCE(track.custom_poster_url, album.custom_poster_url) AS custom_poster_url,
                COALESCE(track.custom_metadata, '{}'::jsonb) AS custom_metadata,
                mae.embedding <=> ${vectorLiteral}::vector AS distance
            FROM media_items track
            JOIN media_audio_embeddings mae ON mae.media_id = track.id AND mae.model_id = ${MSCLAP_MODEL_ID}
            LEFT JOIN media_items album ON album.id = track.parent_id
            LEFT JOIN media_items artist ON artist.id = album.parent_id
            WHERE track.media_type = 'track'
              AND track.has_files = true
              ${libraryFilter}
              ${ageFilter}
              ${cursorPredicate}
            ORDER BY mae.embedding <=> ${vectorLiteral}::vector ASC, track.id ASC
            LIMIT ${candidatePoolSize}
        ),
        credited AS (
            -- Credit resolved once per pooled row, after the pool LIMIT; the
            -- title dedup partitions on it.
            SELECT
                track.*,
                COALESCE(${trackDisplayArtistSql(sql, 'track', trackCreditArtistsSql(sql))}, '') AS artist_title,
                ${trackArtistIdSql(sql, 'track', trackCreditArtistsSql(sql))} AS artist_id,
                track_credit.artists AS canonical_artists
            FROM candidates track
            LEFT JOIN media_items artist ON artist.id = track.album_artist_id
            ${canonicalTrackArtistsJoinSql(sql)}
        ),
        ranked AS (
            SELECT
                c.*,
                ROW_NUMBER() OVER (
                    PARTITION BY CASE
                        WHEN c.is_various_artists
                            THEN 'va:' || c.id::text
                        ELSE COALESCE(c.artist_id::text, NULLIF(c.artist_title, ''), 'orphan') || ':' ||
                            REGEXP_REPLACE(LOWER(TRIM(c.title)), ${TRAILING_VARIANT_SEGMENT_SQL_PATTERN}, '', 'g')
                    END
                    ORDER BY
                        -- Prefer the untagged (original) title, same as BYL.
                        -- COALESCE guards NULL titles (see BYL comment above).
                        CASE
                            WHEN regexp_replace(
                                regexp_replace(COALESCE(c.title, ''), ${FEAT_TAG_REGEX}, '', 'gi'),
                                ${FEAT_DASH_SUFFIX_REGEX}, '', 'gi'
                            ) ~* ${VERSION_ONLY_SQL_PATTERN}
                                THEN 1
                            ELSE 0
                        END ASC,
                        c.distance ASC,
                        c.id ASC
                ) AS title_rank
            FROM credited c
        )
        SELECT
            track.id,
            track.title,
            track.artist_title,
            track.artist_id,
            ${trackArtistsSql(sql, 'track', sql`track.canonical_artists`)} AS track_artists,
            ${trackRemixerArtistsSql(sql)} AS remixer_artists,
            track.album_id,
            track.album_title,
            track.custom_poster_url,
            1 - track.distance AS similarity,
            track.distance::text AS distance_cursor
        FROM (
            SELECT *
            FROM ranked
            WHERE title_rank = 1
            ORDER BY distance ASC, id ASC
            LIMIT ${limit}
        ) AS track
        ORDER BY track.distance ASC, track.id ASC
    `;
}

// =============================================================================
// New For You
// =============================================================================

/**
 * Get recently-added, never-played tracks for the "New For You" carousel.
 *
 * Candidates are library tracks added within `sinceDays` days that the user
 * has never played (no `user_music_state` row, or `play_count` 0/NULL).
 * When a sonic taste vector is supplied, candidates are ranked by MSCLAP
 * cosine distance to that vector (falls back to `created_at DESC` for ties
 * or when no taste vector is available). Enforces a per-album cap so a
 * single bulk-imported album can't dominate the shelf.
 */
export async function getNewForYouTracks(
    sql: postgres.Sql,
    userId: UserId,
    excludeIds: string[],
    limit: number,
    opts: {
        /** REQUIRED access boundary. Use `unrestrictedAccess()` for a deliberately unfiltered read. */
        access: MediaAccessBoundary;
        tasteVector?: number[] | null;
        sinceDays: number;
    },
): Promise<NewForYouRow[]> {
    if (deniesEverything(opts.access)) return [];
    // Derive the legacy predicate inputs from the boundary; SQL is unchanged.
    const deniedGroupIds: string[] | null =
        opts.access.library.kind === 'denyGroups' ? opts.access.library.ids : null;
    const ageRating: AgeRatingFilterParams | null =
        opts.access.age.kind === 'limit'
            ? {
                  maxAgeRating: opts.access.age.maxAgeRating,
                  allowUnrated: opts.access.age.allowUnrated,
              }
            : null;
    const safeExclude = excludeIds.length > 0 ? excludeIds : [];
    const MAX_TRACKS_PER_ALBUM = 2;
    const libraryFilter =
        deniedGroupIds && deniedGroupIds.length > 0
            ? sql`AND EXISTS (
                SELECT 1 FROM media_file_items mfi
                JOIN media_files mf ON mf.id = mfi.file_id
                WHERE mfi.media_item_id = track.id
                  AND (mf.library_group_id IS NULL
                       OR mf.library_group_id != ALL(${deniedGroupIds}::uuid[]))
            )`
            : sql``;
    const ageFilter =
        ageRating && ageRating.maxAgeRating !== null
            ? sql`AND (
                (track.age_rating IS NULL AND ${ageRating.allowUnrated}::boolean)
                OR track.age_rating <= ${ageRating.maxAgeRating}
            )`
            : sql``;

    const vectorLiteral = opts.tasteVector
        ? `[${opts.tasteVector.map((n) => n.toFixed(8)).join(',')}]`
        : null;

    return sql<NewForYouRow[]>`
        WITH candidates AS (
            -- Every unplayed recent track, so no artist credit here: the
            -- ranking never reads it, and the final SELECT resolves it for
            -- the page only.
            SELECT
                track.id,
                track.title,
                track.custom_metadata,
                artist.id AS album_artist_id,
                album.id AS album_id,
                album.title AS album_title,
                track.runtime_seconds,
                COALESCE(track.custom_poster_url, album.custom_poster_url) AS custom_poster_url,
                track.created_at::text AS created_at,
                ${
                    vectorLiteral
                        ? sql`me.embedding <=> ${vectorLiteral}::vector`
                        : sql`NULL::double precision`
                } AS distance
            FROM media_items track
            LEFT JOIN user_music_state ums
                ON ums.track_id = track.id AND ums.user_id = ${userId}
            LEFT JOIN media_items album
                ON album.id = track.parent_id AND album.media_type = 'album'
            LEFT JOIN media_items artist
                ON artist.id = album.parent_id AND artist.media_type = 'artist'
            ${
                vectorLiteral
                    ? sql`LEFT JOIN media_audio_embeddings me
                        ON me.media_id = track.id AND me.model_id = ${MSCLAP_MODEL_ID}`
                    : sql``
            }
            WHERE track.media_type = 'track'
              AND track.has_files = true
              AND track.created_at > NOW() - make_interval(days => ${opts.sinceDays})
              AND (ums.play_count IS NULL OR ums.play_count = 0)
              AND track.id != ALL(${safeExclude}::uuid[])
              ${libraryFilter}
              ${ageFilter}
        ),
        ranked AS (
            SELECT
                c.*,
                ROW_NUMBER() OVER (
                    PARTITION BY COALESCE(c.album_id::text, 'no-album:' || c.id::text)
                    ORDER BY c.distance ASC NULLS LAST, c.created_at DESC, c.id ASC
                ) AS album_rank
            FROM candidates c
        )
        SELECT
            track.id,
            track.title,
            COALESCE(${trackDisplayArtistSql(sql, 'track', trackCreditArtistsSql(sql))}, '') AS artist_title,
            ${trackArtistIdSql(sql, 'track', trackCreditArtistsSql(sql))} AS artist_id,
            ${trackArtistsSql(sql, 'track', trackCreditArtistsSql(sql))} AS track_artists,
            ${trackRemixerArtistsSql(sql)} AS remixer_artists,
            track.album_id,
            track.album_title,
            track.runtime_seconds,
            track.custom_poster_url,
            track.created_at
        FROM (
            SELECT *
            FROM ranked
            WHERE album_rank <= ${MAX_TRACKS_PER_ALBUM}
            ORDER BY distance ASC NULLS LAST, created_at DESC, id ASC
            LIMIT ${limit}
        ) AS track
        LEFT JOIN media_items artist ON artist.id = track.album_artist_id
        ${canonicalTrackArtistsJoinSql(sql)}
        ORDER BY track.distance ASC NULLS LAST, track.created_at DESC, track.id ASC
    `;
}

// =============================================================================
// Mood Shelf (rotating mood carousels with energy band + taste blend)
// =============================================================================

/**
 * Get mood-based tracks for a rotating "mood shelf" carousel — an extension
 * of {@link getMusicMoodRecommendations} (same CLAP audio-space matching:
 * the `mood_vectors` row for `moodKey` must have `model_id = MSCLAP_MODEL_ID`,
 * matched against `media_audio_embeddings` — no text-space fallback) with
 * two additions:
 *   1. An optional Essentia energy band (e.g. high-energy moods require
 *      `energy >= energyMin`; calm moods require `energy <= energyMax`).
 *   2. A light taste blend: tracks by artists the user has actually played
 *      get a small distance bonus so the shelf leans toward known taste
 *      without abandoning mood-space discovery.
 *
 * Keeps the same per-title original-over-remix preference window as
 * {@link getMusicMoodRecommendations}, plus a per-artist cap for variety.
 *
 * Returns an empty array when no MSCLAP mood vector exists for `moodKey` —
 * the mood-shelf endpoint's MIN_TRACKS gate then hides the shelf entirely,
 * which is the intended behavior: mood shelves only show with real
 * (audio-space) mood data.
 */
export async function getMoodShelfTracks(
    sql: postgres.Sql,
    userId: UserId,
    moodKey: string,
    limit: number,
    access: {
        deniedGroupIds: string[] | null;
        ageRating: AgeRatingFilterParams | null;
    },
    energyBand?: { energyMin?: number | null; energyMax?: number | null } | null,
): Promise<MoodRecommendationRow[]> {
    const moodVector = await getMoodVector(sql, moodKey);
    if (!moodVector) return [];
    // Same vector-literal formatting as getMusicMoodRecommendations / sonic-queue.queries.ts.
    const vectorLiteral = `[${moodVector.map((n) => n.toFixed(8)).join(',')}]`;

    const libraryFilter =
        access.deniedGroupIds && access.deniedGroupIds.length > 0
            ? sql`AND EXISTS (
                SELECT 1 FROM media_file_items mfi
                JOIN media_files mf ON mf.id = mfi.file_id
                WHERE mfi.media_item_id = track.id
                  AND (mf.library_group_id IS NULL
                       OR mf.library_group_id != ALL(${access.deniedGroupIds}::uuid[]))
            )`
            : sql``;
    const ageFilter =
        access.ageRating && access.ageRating.maxAgeRating !== null
            ? sql`AND (
                (track.age_rating IS NULL AND ${access.ageRating.allowUnrated}::boolean)
                OR track.age_rating <= ${access.ageRating.maxAgeRating}
            )`
            : sql``;
    // Numeric-format guard wrapped in CASE (AND order isn't guaranteed in
    // Postgres) — a single malformed essentia value in custom_metadata must
    // skip that track, not 500 the whole shelf query.
    const ENERGY_NUMERIC_RE = '^-?[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?$';
    const energyMinFilter =
        energyBand?.energyMin != null
            ? sql`AND (CASE WHEN (track.custom_metadata->'essentia'->>'energy') ~ ${ENERGY_NUMERIC_RE}
                        THEN (track.custom_metadata->'essentia'->>'energy')::double precision
                   END) >= ${energyBand.energyMin}`
            : sql``;
    const energyMaxFilter =
        energyBand?.energyMax != null
            ? sql`AND (CASE WHEN (track.custom_metadata->'essentia'->>'energy') ~ ${ENERGY_NUMERIC_RE}
                        THEN (track.custom_metadata->'essentia'->>'energy')::double precision
                   END) <= ${energyBand.energyMax}`
            : sql``;

    const MAX_TRACKS_PER_ARTIST = 2;
    // Small distance bonus for artists the user has actually played — keeps
    // the taste blend "light" (never overrides mood-space ordering outright).
    const TASTE_BOOST = 0.04;
    // Overfetch candidates before the per-title/per-artist dedup passes, same
    // rationale (and same 16x factor) as getMusicMoodRecommendations. The
    // shelf originally used 4x, which starved on prod: embedding-space nearest
    // neighbours cluster by artist (an artist's tracks sit close together), so
    // an 80-track pool spanned only a handful of artists and the
    // title_rank/artist_rank caps collapsed it under the endpoint's MIN_TRACKS
    // — shelves rendered as null despite 23k eligible tracks.
    const CANDIDATE_POOL_MULTIPLIER = 16;
    const candidatePoolSize = limit * CANDIDATE_POOL_MULTIPLIER;

    return sql<MoodRecommendationRow[]>`
        WITH played_artists AS (
            SELECT DISTINCT a.id
            FROM user_music_state ums
            JOIN media_items t ON t.id = ums.track_id
            JOIN media_items al ON al.id = t.parent_id
            JOIN media_items a ON a.id = al.parent_id
            WHERE ums.user_id = ${userId}
              AND ums.play_count > 0
        ),
        candidates AS (
            SELECT
                track.id,
                track.title,
                track.custom_metadata,
                artist.id AS album_artist_id,
                COALESCE(artist.is_various_artists, false) AS is_various_artists,
                album.id AS album_id,
                album.title AS album_title,
                COALESCE(track.custom_poster_url, album.custom_poster_url) AS custom_poster_url,
                mae.embedding <=> ${vectorLiteral}::vector AS raw_distance,
                (mae.embedding <=> ${vectorLiteral}::vector) - (
                    CASE
                        WHEN artist.id IN (SELECT id FROM played_artists)
                            THEN ${TASTE_BOOST}::double precision
                        ELSE 0
                    END
                ) AS distance
            FROM media_items track
            JOIN media_audio_embeddings mae ON mae.media_id = track.id AND mae.model_id = ${MSCLAP_MODEL_ID}
            LEFT JOIN media_items album ON album.id = track.parent_id
            LEFT JOIN media_items artist ON artist.id = album.parent_id
            WHERE track.media_type = 'track'
              AND track.has_files = true
              ${libraryFilter}
              ${ageFilter}
              ${energyMinFilter}
              ${energyMaxFilter}
            ORDER BY distance ASC
            LIMIT ${candidatePoolSize}
        ),
        credited AS (
            -- Credit resolved once per pooled row, after the pool LIMIT; the
            -- artist cap and title dedup partition on it.
            SELECT
                track.*,
                COALESCE(${trackDisplayArtistSql(sql, 'track', trackCreditArtistsSql(sql))}, '') AS artist_title,
                ${trackArtistIdSql(sql, 'track', trackCreditArtistsSql(sql))} AS artist_id,
                track_credit.artists AS canonical_artists
            FROM candidates track
            LEFT JOIN media_items artist ON artist.id = track.album_artist_id
            ${canonicalTrackArtistsJoinSql(sql)}
        ),
        ranked AS (
            SELECT
                c.*,
                ROW_NUMBER() OVER (
                    PARTITION BY CASE
                        WHEN c.is_various_artists
                            THEN 'va:' || c.id::text
                        ELSE COALESCE(c.artist_id::text, NULLIF(c.artist_title, ''), 'orphan:' || c.id::text)
                    END
                    ORDER BY c.distance ASC, c.id ASC
                ) AS artist_rank,
                ROW_NUMBER() OVER (
                    PARTITION BY CASE
                        WHEN c.is_various_artists
                            THEN 'va:' || c.id::text
                        ELSE COALESCE(c.artist_id::text, NULLIF(c.artist_title, ''), 'orphan') || ':' ||
                            REGEXP_REPLACE(LOWER(TRIM(c.title)), ${TRAILING_VARIANT_SEGMENT_SQL_PATTERN}, '', 'g')
                    END
                    ORDER BY
                        -- Prefer the untagged (original) title, same as
                        -- getMusicMoodRecommendations. COALESCE guards NULL
                        -- titles (see BYL comment above).
                        CASE
                            WHEN regexp_replace(
                                regexp_replace(COALESCE(c.title, ''), ${FEAT_TAG_REGEX}, '', 'gi'),
                                ${FEAT_DASH_SUFFIX_REGEX}, '', 'gi'
                            ) ~* ${VERSION_ONLY_SQL_PATTERN}
                                THEN 1
                            ELSE 0
                        END ASC,
                        c.distance ASC,
                        c.id ASC
                ) AS title_rank
            FROM credited c
        )
        SELECT
            track.id,
            track.title,
            track.artist_title,
            track.artist_id,
            ${trackArtistsSql(sql, 'track', sql`track.canonical_artists`)} AS track_artists,
            ${trackRemixerArtistsSql(sql)} AS remixer_artists,
            track.album_id,
            track.album_title,
            track.custom_poster_url,
            1 - track.raw_distance AS similarity
        FROM (
            SELECT *
            FROM ranked
            WHERE title_rank = 1
              AND artist_rank <= ${MAX_TRACKS_PER_ARTIST}
            ORDER BY distance ASC
            LIMIT ${limit}
        ) AS track
        ORDER BY track.distance ASC
    `;
}
