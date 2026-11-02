// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sonic Similarity Query Module
 *
 * Pure SQL queries for MSCLAP-based audio kNN similarity over
 * `media_audio_embeddings`. All functions take `sql: postgres.Sql` as first
 * parameter and have no side effects.
 *
 * The HNSW index on `media_audio_embeddings` uses `vector_cosine_ops`, so
 * kNN queries MUST use the `<=>` (cosine distance) operator — never `<->` (L2)
 * or `<#>` (inner product), or the index will be bypassed.
 *
 * @module queries/sonic-similarity
 */

import type postgres from 'postgres';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { MSCLAP_MODEL_ID } from './sonic-constants.js';
import {
    trackDisplayArtistSql,
    trackArtistsSql,
    trackRemixerArtistsSql,
    canonicalTrackArtistsJoinSql,
    trackCreditArtistsSql,
} from './fragments/music-artist.fragments.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hardcoded model identifier — matches every INSERT/WHERE in the pipeline. */
const MODEL_ID = MSCLAP_MODEL_ID;

// ---------------------------------------------------------------------------
// Access boundary contract (read before touching any query text here)
// ---------------------------------------------------------------------------
//
// Every query in this module takes a REQUIRED {@link MediaAccessBoundary}.
// There is no permissive default: a caller that wants unfiltered rows must say
// so with `unrestrictedAccess()`, which makes the decision greppable.
//
// ALIAS CONTRACT. `buildLibraryAccessFilter` hardcodes `mi.id` in both of its
// correlated subqueries and `buildAgeRatingFilter` defaults its alias to `mi`.
// Neither splice site below passes an alias override, so the surrounding query
// MUST alias the CANDIDATE TRACK's media_items row as `mi`. Aliasing it
// anything else throws a real Postgres "missing FROM-clause entry for table mi"
// — but ONLY for restricted callers, because both builders emit an empty
// fragment under an unrestricted boundary. That bug shipped once; the guard
// tests in sonic-similarity.queries.test.ts assert the outer SELECT contains
// `media_items mi`.
//
// PREDICATE GRAIN. In the album/artist queries the RESULT grain is album/artist
// but the boundary constrains `mi` — the track. An album whose tracks are all
// denied loses its entire GROUP BY input and vanishes; a MIXED album still
// surfaces, with similarity_score and track_count computed over the allowed
// tracks only. That is the intended semantics — do NOT also apply the boundary
// to the album/artist alias, which would change which rows restricted users see.
//
// CTE SCOPE. The `centroid` CTEs are deliberately UNFILTERED: the seed's own
// centroid is computed over all of its tracks. Callers gate the seed itself via
// checkMediaAccess before calling in, so the boundary is only ever enforced on
// the candidate side. The CTEs keep their own local `track` alias — a separate
// scope. Do not "fix" it to `mi`.
//
// DENY-ALL. Each query short-circuits to `[]` via `deniesEverything` before
// issuing SQL. Both builders would emit `AND false`, which is equally correct,
// but returning early skips a guaranteed-empty round trip.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single row returned by {@link findSonicNeighbors}. */
export interface SonicNeighborRow {
    /** Internal UUID of the track (`media_items.id`). */
    media_id: string;
    /**
     * Cosine similarity in [0, 1]: 1 = identical, 0 = orthogonal.
     * Derived from cosine *distance* (`embedding <=> seed`) as `1 - distance`.
     */
    similarity_score: number;
    title: string;
    custom_poster_url: string | null;
    custom_metadata: Record<string, unknown>;
    runtime_seconds: number | null;
    artist_title: string | null;
    track_artists?: Array<{ id: string | null; title: string }> | null;
    remixer_artists?: Array<{ id: string | null; title: string }> | null;
    album_id: string | null;
    album_title: string | null;
}

/** A single row returned by {@link findSonicNeighborAlbums}. */
export interface SonicAlbumNeighborRow {
    /** Internal UUID of the result album (`media_items.id`). */
    album_id: string;
    /**
     * Mean cosine similarity across the album's embedded tracks, in [0, 1].
     * Derived as `AVG(1 - distance)` of each track's cosine distance to the
     * centroid of the seed album's track embeddings.
     */
    similarity_score: number;
    title: string;
    custom_poster_url: string | null;
    year: number | null;
    artist_id: string | null;
    artist_title: string | null;
    track_count: number;
}

/** A single row returned by {@link findSonicNeighborArtists}. */
export interface SonicArtistNeighborRow {
    /** Internal UUID of the result artist (`media_items.id`). */
    artist_id: string;
    /**
     * Mean cosine similarity across all the artist's embedded tracks, in [0, 1].
     */
    similarity_score: number;
    title: string;
    custom_poster_url: string | null;
    album_count: number;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * kNN similarity search over `media_audio_embeddings` for the MSCLAP model.
 *
 * Algorithm:
 *   1. Fetch the seed track's 1024-dim embedding from `media_audio_embeddings`.
 *   2. Find the `limit` nearest neighbours using the HNSW `<=>` index.
 *   3. Join back to `media_items` for display metadata.
 *   4. Apply the library-group and age-rating boundary to the candidate track.
 *   5. Exclude the seed track itself.
 *
 * Returns an empty array when the seed track has no sonic embedding (the CTE
 * produces zero rows, so the main SELECT also returns zero rows), or when
 * `access` denies everything.
 *
 * @param sql     - postgres.Sql instance (parameterized — no sql.unsafe).
 * @param mediaId - Internal UUID of the seed track.
 * @param limit   - Maximum number of neighbours to return.
 * @param access  - REQUIRED access boundary. Use `searchAccessBoundary(ctx)` for
 *                  a real user, or `unrestrictedAccess()` to opt out explicitly.
 */
export async function findSonicNeighbors(
    sql: postgres.Sql,
    mediaId: string,
    limit: number,
    access: MediaAccessBoundary,
): Promise<SonicNeighborRow[]> {
    if (deniesEverything(access)) return [];

    return sql<SonicNeighborRow[]>`
        WITH seed AS (
            SELECT embedding
            FROM media_audio_embeddings
            WHERE media_id = ${mediaId}
              AND model_id = ${MODEL_ID}
            LIMIT 1
        ),
        page AS (
            -- Artist credits are resolved below, for the page only.
            SELECT
                mae.media_id,
                mae.embedding <=> seed.embedding                           AS distance,
                mi.title,
                mi.custom_poster_url,
                COALESCE(mi.custom_metadata, '{}'::jsonb)                  AS custom_metadata,
                mi.runtime_seconds,
                album.id                                                   AS album_id,
                album.title                                                AS album_title,
                artist.id                                                  AS album_artist_id
            FROM media_audio_embeddings mae
            CROSS JOIN seed
            JOIN media_items mi
                   ON mi.id = mae.media_id
                  AND mi.media_type = 'track'
                  AND mi.has_files = true
                  AND mae.media_id != ${mediaId}
            LEFT JOIN media_items album
                   ON album.id = mi.parent_id
                  AND album.media_type = 'album'
            LEFT JOIN media_items artist
                   ON artist.id = album.parent_id
                  AND artist.media_type = 'artist'
            WHERE mae.model_id = ${MODEL_ID}
            ${buildLibraryAccessFilter(sql, access.library)}
            ${buildAgeRatingFilter(sql, access.age)}
            ORDER BY mae.embedding <=> seed.embedding ASC
            LIMIT ${limit}
        )
        SELECT
            mi.media_id::text                                              AS media_id,
            1 - mi.distance                                                AS similarity_score,
            mi.title,
            mi.custom_poster_url,
            mi.custom_metadata,
            mi.runtime_seconds,
            ${trackDisplayArtistSql(sql, 'mi', trackCreditArtistsSql(sql))} AS artist_title,
            ${trackArtistsSql(sql, 'mi', trackCreditArtistsSql(sql))} AS track_artists,
            ${trackRemixerArtistsSql(sql, 'mi')} AS remixer_artists,
            mi.album_id::text                                              AS album_id,
            mi.album_title
        FROM page mi
        LEFT JOIN media_items artist ON artist.id = mi.album_artist_id
        ${canonicalTrackArtistsJoinSql(sql, 'mi')}
        ORDER BY mi.distance ASC
    `;
}

/**
 * kNN similarity search for albums similar to a seed album.
 *
 * Algorithm:
 *   1. Compute the centroid of the seed album's MSCLAP track embeddings by
 *      averaging all `media_audio_embeddings` rows whose track's `parent_id`
 *      equals `albumId`.
 *   2. Find the `limit` albums whose mean track-embedding cosine similarity to
 *      that centroid is highest (i.e. all embedded tracks of the candidate
 *      album average closest to the seed centroid).
 *   3. Exclude the seed album itself and apply the access boundary to the
 *      candidate TRACK (`mi`), not to the result album — see the grain note in
 *      the access-boundary contract above.
 *
 * Returns an empty array when the seed album has no sonic-embedded tracks
 * (the centroid CTE produces zero rows → the outer join returns nothing), or
 * when `access` denies everything.
 *
 * @param sql     - postgres.Sql instance (parameterized — no sql.unsafe).
 * @param albumId - Internal UUID of the seed album.
 * @param limit   - Maximum number of similar albums to return.
 * @param access  - REQUIRED access boundary. Use `searchAccessBoundary(ctx)` for
 *                  a real user, or `unrestrictedAccess()` to opt out explicitly.
 */
export async function findSonicNeighborAlbums(
    sql: postgres.Sql,
    albumId: string,
    limit: number,
    access: MediaAccessBoundary,
): Promise<SonicAlbumNeighborRow[]> {
    if (deniesEverything(access)) return [];

    return sql<SonicAlbumNeighborRow[]>`
        WITH centroid AS (
            -- Average embedding of all embedded tracks belonging to the seed album.
            SELECT AVG(mae.embedding) AS vec
            FROM media_audio_embeddings mae
            JOIN media_items track
                   ON track.id = mae.media_id
                  AND track.media_type = 'track'
                  AND track.parent_id = ${albumId}
            WHERE mae.model_id = ${MODEL_ID}
        )
        SELECT
            album.id::text                                              AS album_id,
            AVG(1 - (mae.embedding <=> centroid.vec))                   AS similarity_score,
            album.title,
            album.custom_poster_url,
            (album.custom_metadata->>'year')::int                       AS year,
            artist.id::text                                             AS artist_id,
            artist.title                                                AS artist_title,
            COUNT(mae.media_id)::int                                    AS track_count
        FROM centroid
        CROSS JOIN media_audio_embeddings mae
        JOIN media_items mi
               ON mi.id = mae.media_id
              AND mi.media_type = 'track'
              AND mi.has_files = true
        JOIN media_items album
               ON album.id = mi.parent_id
              AND album.media_type = 'album'
              AND album.id != ${albumId}
        LEFT JOIN media_items artist
               ON artist.id = album.parent_id
              AND artist.media_type = 'artist'
        WHERE mae.model_id = ${MODEL_ID}
        ${buildLibraryAccessFilter(sql, access.library)}
        ${buildAgeRatingFilter(sql, access.age)}
        GROUP BY album.id, album.title, album.custom_poster_url, album.custom_metadata, artist.id, artist.title
        ORDER BY AVG(mae.embedding <=> centroid.vec) ASC
        LIMIT ${limit}
    `;
}

/**
 * kNN similarity search for artists similar to a seed artist.
 *
 * Algorithm:
 *   1. Compute the centroid of ALL MSCLAP track embeddings belonging to the
 *      seed artist (tracks whose `album.parent_id = artistId`).
 *   2. For each candidate artist, compute the mean cosine similarity of their
 *      embedded tracks to that centroid.
 *   3. Exclude the seed artist and apply the access boundary to the candidate
 *      TRACK (`mi`), not to the result artist — see the grain note in the
 *      access-boundary contract above.
 *   4. Exclude any candidate flagged `is_various_artists` — VA is a metadata
 *      bucket, not a real neighbor.
 *
 * Returns an empty array when the seed artist has no sonic-embedded tracks, or
 * when `access` denies everything.
 *
 * @param sql      - postgres.Sql instance (parameterized — no sql.unsafe).
 * @param artistId - Internal UUID of the seed artist.
 * @param limit    - Maximum number of similar artists to return.
 * @param access   - REQUIRED access boundary. Use `searchAccessBoundary(ctx)` for
 *                   a real user, or `unrestrictedAccess()` to opt out explicitly.
 */
export async function findSonicNeighborArtists(
    sql: postgres.Sql,
    artistId: string,
    limit: number,
    access: MediaAccessBoundary,
): Promise<SonicArtistNeighborRow[]> {
    if (deniesEverything(access)) return [];

    return sql<SonicArtistNeighborRow[]>`
        WITH centroid AS (
            -- Average embedding of all embedded tracks belonging to the seed artist.
            SELECT AVG(mae.embedding) AS vec
            FROM media_audio_embeddings mae
            JOIN media_items track
                   ON track.id = mae.media_id
                  AND track.media_type = 'track'
                  AND track.has_files = true
            JOIN media_items album
                   ON album.id = track.parent_id
                  AND album.media_type = 'album'
                  AND album.parent_id = ${artistId}
            WHERE mae.model_id = ${MODEL_ID}
        )
        SELECT
            artist.id::text                                             AS artist_id,
            AVG(1 - (mae.embedding <=> centroid.vec))                   AS similarity_score,
            artist.title,
            artist.custom_poster_url,
            COUNT(DISTINCT album.id)::int                               AS album_count
        FROM centroid
        CROSS JOIN media_audio_embeddings mae
        JOIN media_items mi
               ON mi.id = mae.media_id
              AND mi.media_type = 'track'
              AND mi.has_files = true
        JOIN media_items album
               ON album.id = mi.parent_id
              AND album.media_type = 'album'
        JOIN media_items artist
               ON artist.id = album.parent_id
              AND artist.media_type = 'artist'
              AND artist.id != ${artistId}
              AND artist.is_various_artists = false
        WHERE mae.model_id = ${MODEL_ID}
        ${buildLibraryAccessFilter(sql, access.library)}
        ${buildAgeRatingFilter(sql, access.age)}
        GROUP BY artist.id, artist.title, artist.custom_poster_url
        ORDER BY AVG(mae.embedding <=> centroid.vec) ASC
        LIMIT ${limit}
    `;
}
