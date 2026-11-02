// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Audio Clusters Query Module
 *
 * Pure SQL queries for the Sonic Clustering feature (media_audio_clusters).
 * All functions take `sql: postgres.Sql` as first parameter and have no side effects,
 * except upsertClusterAssignments which is write-only (called from the task).
 *
 * Access scoping uses buildLibraryAccessFilter + buildAgeRatingFilter, identical
 * to the sonic-similarity and music-map query modules.
 *
 * @module queries/audio-clusters
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

/** Hardcoded model identifier — matches media_audio_embeddings.model_id. */
export const CLUSTER_MODEL_ID = MSCLAP_MODEL_ID;

// ---------------------------------------------------------------------------
// Access boundary contract (read before touching any query text here)
// ---------------------------------------------------------------------------
//
// The two READ queries take a REQUIRED {@link MediaAccessBoundary}. There is no
// permissive default: a caller that wants unfiltered rows must say so with
// `unrestrictedAccess()`, which makes the decision greppable. API callers holding
// a SearchAccessContext should project it with `searchAccessBoundary(ctx)`.
//
// The WRITE helpers (upsert/clear/count) and `getClusterCentroid` take no
// boundary by design: the first three are called only from the sonic-clustering
// task (no user), and the last is an internal centroid computation over an
// already-access-gated member id list supplied by taste-clusters.service.
//
// ALIAS CONTRACT. `buildLibraryAccessFilter` hardcodes `mi.id` in both of its
// correlated subqueries and `buildAgeRatingFilter` defaults its alias to `mi`.
// Neither splice site below passes an alias override, so the TRACK's media_items
// row must stay aliased `mi`. In getClusterMembers media_items is joined THREE
// times — `mi` (the track), `album`, and `artist`. Only `mi` is boundary-scoped;
// the album/artist joins are display-title lookups and are deliberately
// unfiltered. Do NOT parameterize the filters onto those aliases.
//
// CTE SCOPE. In getClusters both filters sit inside the `accessible_tracks` CTE,
// which is the single scope point: every downstream CTE (counts, genre_freq,
// artist_freq, cover_distinct) reads only from it and the final SELECT never
// touches media_items. Moving the filters to the outer query would silently leak
// aggregate track counts and cover-collage ids for denied tracks.
//
// The `centroid` CTE in getClusterMembers is deliberately UNFILTERED: it averages
// every member's embedding over the WHOLE cluster so member ordering stays stable
// regardless of who is asking. Threading the boundary into it would reorder rows
// for restricted users, which this migration must not do. It leaks nothing — the
// outer WHERE still gates every returned row.
//
// DENY-ALL. Both queries short-circuit to `[]` via `deniesEverything` before
// issuing SQL. Both builders would emit `AND false`, which is equally correct,
// but returning early skips a guaranteed-empty round trip.
//
// CACHE KEYS. Callers that cache these results MUST partition the cache by the
// same boundary (see `scopedCacheKey` in search-access-context.ts). A correct SQL
// predicate paired with an unpartitioned cache key still leaks.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One cluster entry returned by {@link getClusters}. */
export interface ClusterRow {
    /** KMeans cluster integer label. */
    cluster_id: number;
    /** Human-readable label derived from the dominant genres or fallback. */
    label: string;
    /** Number of accessible tracks in this cluster. */
    track_count: number;
    /** Up to ~3 most-frequent genres across the cluster's accessible tracks. */
    top_genres: string[];
    /** Up to ~3 most-frequent track artists across the cluster's accessible tracks. */
    top_artists: string[];
    /**
     * Up to 4 representative track UUIDs (from distinct albums where possible) for a
     * 2×2 cover-art collage. May be empty when no accessible tracks have covers.
     */
    cover_media_ids: string[];
}

/** One member track returned by {@link getClusterMembers}. */
export interface ClusterMemberRow {
    /** Internal UUID of the track. */
    media_id: string;
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

/** Input record for {@link upsertClusterAssignments}. */
export interface ClusterAssignmentInput {
    mediaId: string;
    clusterId: number;
}

// ---------------------------------------------------------------------------
// Read: cluster listing
// ---------------------------------------------------------------------------

/**
 * Return the list of distinct clusters for the given model, access-scoped.
 *
 * For each cluster, derives a human-readable label:
 *   1. The top ~3 most-frequent genres joined by ' · ' (the real signal on
 *      real libraries — ~96% genre coverage via custom_metadata.genre).
 *   2. Fallback: 'Sonic Mix <cluster_id + 1>' (1-indexed for display).
 *
 * Also returns the top genres and top artists per cluster for richer cards.
 *
 * Only clusters with at least one accessible track are returned.
 *
 * @param sql     - postgres.Sql instance.
 * @param modelId - Embedding model (always 'msclap-2023').
 * @param access  - REQUIRED access boundary. Use `searchAccessBoundary(ctx)` for
 *                  a real user, or `unrestrictedAccess()` to opt out explicitly.
 */
export async function getClusters(
    sql: postgres.Sql,
    modelId: string,
    access: MediaAccessBoundary,
): Promise<ClusterRow[]> {
    if (deniesEverything(access)) return [];

    return sql<ClusterRow[]>`
        -- Materialize the small extracted values, rather than TOAST pointers to
        -- full metadata that genre and artist aggregations repeatedly detoast.
        WITH accessible_tracks AS MATERIALIZED (
            SELECT
                mac.cluster_id,
                mi.id AS media_id,
                mi.parent_id AS parent_id,
                CASE WHEN jsonb_typeof(mi.custom_metadata->'genre') = 'array'
                     THEN mi.custom_metadata->'genre' ELSE '[]'::jsonb END AS genres,
                NULLIF(mi.custom_metadata->>'artist', '') AS artist
            FROM media_audio_clusters mac
            JOIN media_items mi
                   ON mi.id = mac.media_id
                  AND mi.media_type = 'track'
                  AND mi.has_files = true
                  AND mi.status = 'active'
            WHERE mac.model_id = ${modelId}
            ${buildLibraryAccessFilter(sql, access.library)}
            ${buildAgeRatingFilter(sql, access.age)}
        ),
        counts AS (
            SELECT cluster_id, count(*) AS track_count
            FROM accessible_tracks
            GROUP BY cluster_id
        ),
        -- Genres live under custom_metadata->'genre' (singular JSON array, ~96%
        -- coverage). Unnest, count per (cluster_id, genre), keep the top 3.
        genre_freq AS (
            SELECT
                at.cluster_id,
                g.genre,
                count(*) AS freq
            FROM accessible_tracks at
            CROSS JOIN LATERAL jsonb_array_elements_text(
                at.genres
            ) AS g(genre)
            WHERE g.genre IS NOT NULL AND g.genre <> ''
            GROUP BY at.cluster_id, g.genre
        ),
        -- Corpus-wide share of each genre, the denominator for lift below.
        genre_totals AS (
            SELECT genre, SUM(freq) AS total_freq, SUM(SUM(freq)) OVER () AS corpus_freq
            FROM genre_freq
            GROUP BY genre
        ),
        -- Per-cluster share, computed BEFORE ranking: a window function may
        -- not appear inside another window's ORDER BY, so lift needs its own
        -- step rather than being inlined into the row_number().
        genre_share AS (
            SELECT
                cluster_id,
                genre,
                freq,
                freq::float / NULLIF(SUM(freq) OVER (PARTITION BY cluster_id), 0) AS in_cluster_share
            FROM genre_freq
        ),
        genre_ranked AS (
            SELECT
                gs.cluster_id,
                gs.genre,
                gs.freq,
                -- LIFT, not raw frequency: the genre's share WITHIN this cluster
                -- divided by its share of the whole library.
                --
                -- Ranking by raw count labelled clusters with whatever the
                -- library has most of, which describes nothing. On production
                -- that produced TWO collections named identically
                -- ("Rock · Pop · Pop Rock") and 11 of 12 labels leading with
                -- Rock or Electronic — Rock alone is about a third of the
                -- library, so it topped nearly every cluster regardless of what
                -- actually made that cluster distinct. Lift surfaces what is
                -- OVER-represented here instead, which is the thing a listener
                -- is choosing between.
                gs.in_cluster_share
                    / NULLIF(gt.total_freq::float / NULLIF(gt.corpus_freq, 0), 0) AS lift,
                -- Lift ALONE over-corrects: a tag on 10 tracks of a 2,000-track
                -- cluster posts enormous lift on noise, which on production
                -- labelled a Depeche Mode / Yes / Joe Jackson cluster
                -- "Bluegrass · Cool Jazz · Cyberpunk" and surfaced junk tags
                -- ("Non-Music", "Dans"). So a genre must first hold at least
                -- MIN_LABEL_SHARE of the cluster to be eligible; below that it
                -- scores zero and only fills a slot no qualifying genre wanted,
                -- ordered by raw frequency. Verified against the production
                -- clustering: all 12 labels come out distinct and meaningful.
                row_number() OVER (
                    PARTITION BY gs.cluster_id
                    ORDER BY
                        CASE
                            WHEN gs.in_cluster_share >= 0.02
                            THEN gs.in_cluster_share
                                / NULLIF(gt.total_freq::float / NULLIF(gt.corpus_freq, 0), 0)
                            ELSE 0
                        END DESC,
                        gs.freq DESC,
                        gs.genre ASC
                ) AS rn
            FROM genre_share gs
            JOIN genre_totals gt ON gt.genre = gs.genre
        ),
        top_genres AS (
            SELECT
                cluster_id,
                array_agg(genre ORDER BY rn) AS genres
            FROM genre_ranked
            WHERE rn <= 3
            GROUP BY cluster_id
        ),
        -- Track artist lives under custom_metadata->>'artist'.
        artist_freq AS (
            SELECT
                at.cluster_id,
                at.artist AS artist,
                count(*) AS freq
            FROM accessible_tracks at
            WHERE at.artist IS NOT NULL
            GROUP BY at.cluster_id, at.artist
        ),
        artist_ranked AS (
            SELECT
                cluster_id,
                artist,
                freq,
                row_number() OVER (PARTITION BY cluster_id ORDER BY freq DESC, artist ASC) AS rn
            FROM artist_freq
        ),
        top_artists AS (
            SELECT
                cluster_id,
                array_agg(artist ORDER BY freq DESC, artist ASC) AS artists
            FROM artist_ranked
            WHERE rn <= 3
            GROUP BY cluster_id
        ),
        -- Cover collage: pick one representative track per distinct album
        -- (parent_id) so a 2×2 grid shows 4 different covers. DISTINCT ON
        -- collapses each album to its lexically-first track id (stable), then
        -- the outer query keeps up to 4 per cluster.
        cover_distinct AS (
            SELECT DISTINCT ON (at.cluster_id, at.parent_id)
                at.cluster_id,
                at.parent_id,
                at.media_id
            FROM accessible_tracks at
            ORDER BY at.cluster_id, at.parent_id NULLS LAST, at.media_id
        ),
        cover_ranked AS (
            SELECT
                cluster_id,
                media_id,
                row_number() OVER (PARTITION BY cluster_id ORDER BY media_id) AS rn
            FROM cover_distinct
        ),
        cover_ids AS (
            SELECT
                cluster_id,
                array_agg(media_id::text ORDER BY rn) AS ids
            FROM cover_ranked
            WHERE rn <= 4
            GROUP BY cluster_id
        )
        SELECT
            c.cluster_id,
            COALESCE(
                NULLIF(array_to_string(tg.genres, ' · '), ''),
                'Sonic Mix ' || (c.cluster_id + 1)::text
            ) AS label,
            c.track_count::int AS track_count,
            COALESCE(tg.genres, ARRAY[]::text[]) AS top_genres,
            COALESCE(ta.artists, ARRAY[]::text[]) AS top_artists,
            COALESCE(ci.ids, ARRAY[]::text[]) AS cover_media_ids
        FROM counts c
        LEFT JOIN top_genres tg ON tg.cluster_id = c.cluster_id
        LEFT JOIN top_artists ta ON ta.cluster_id = c.cluster_id
        LEFT JOIN cover_ids ci ON ci.cluster_id = c.cluster_id
        ORDER BY c.cluster_id
    `;
}

// ---------------------------------------------------------------------------
// Read: cluster members
// ---------------------------------------------------------------------------

/**
 * Return the accessible member tracks for one cluster.
 *
 * Includes artist and album metadata for display.
 *
 * @param sql       - postgres.Sql instance.
 * @param modelId   - Embedding model (always 'msclap-2023').
 * @param clusterId - Integer cluster label.
 * @param access    - REQUIRED access boundary. Use `searchAccessBoundary(ctx)`
 *                    for a real user, or `unrestrictedAccess()` to opt out
 *                    explicitly.
 * @param limit     - Max tracks to return (default 200).
 * @param offset    - Number of visible, ordered tracks to skip (default 0).
 */
export async function getClusterMembers(
    sql: postgres.Sql,
    modelId: string,
    clusterId: number,
    access: MediaAccessBoundary,
    limit = 200,
    offset = 0,
): Promise<ClusterMemberRow[]> {
    if (deniesEverything(access)) return [];

    // Order members by SONIC representativeness — closest to the cluster centroid
    // first — so a "Sonic Mix" leads with its most defining tracks, not A→Z. The
    // centroid is the mean of every member's MSCLAP embedding (computed over the
    // whole cluster, not just the accessible/limited slice, so it stays stable).
    return sql<ClusterMemberRow[]>`
        WITH centroid AS (
            SELECT AVG(mae.embedding) AS vec
            FROM media_audio_clusters mac
            JOIN media_audio_embeddings mae
                   ON mae.media_id = mac.media_id
                  AND mae.model_id = mac.model_id
            WHERE mac.model_id = ${modelId}
              AND mac.cluster_id = ${clusterId}
        ),
        page AS (
            -- Artist credits are resolved below, for the page only.
            SELECT
                mac.media_id,
                mi.id,
                mi.title,
                mi.custom_poster_url,
                COALESCE(mi.custom_metadata, '{}'::jsonb)                  AS custom_metadata,
                mi.runtime_seconds,
                album.id                                                    AS album_id,
                album.title                                                 AS album_title,
                artist.id                                                   AS album_artist_id,
                mae.embedding <=> centroid.vec                              AS distance
            FROM media_audio_clusters mac
            JOIN media_items mi
                   ON mi.id = mac.media_id
                  AND mi.media_type = 'track'
                  AND mi.has_files = true
                  AND mi.status = 'active'
            JOIN media_audio_embeddings mae
                   ON mae.media_id = mac.media_id
                  AND mae.model_id = mac.model_id
            LEFT JOIN media_items album
                   ON album.id = mi.parent_id
                  AND album.media_type = 'album'
            LEFT JOIN media_items artist
                   ON artist.id = album.parent_id
                  AND artist.media_type = 'artist'
            CROSS JOIN centroid
            WHERE mac.model_id = ${modelId}
              AND mac.cluster_id = ${clusterId}
            ${buildLibraryAccessFilter(sql, access.library)}
            ${buildAgeRatingFilter(sql, access.age)}
            ORDER BY mae.embedding <=> centroid.vec ASC, mi.id ASC
            LIMIT ${limit} OFFSET ${offset}
        )
        SELECT
            mi.media_id::text                                               AS media_id,
            mi.title,
            mi.custom_poster_url,
            mi.custom_metadata,
            mi.runtime_seconds,
            ${trackDisplayArtistSql(sql, 'mi', trackCreditArtistsSql(sql))} AS artist_title,
            ${trackArtistsSql(sql, 'mi', trackCreditArtistsSql(sql))} AS track_artists,
            ${trackRemixerArtistsSql(sql, 'mi')} AS remixer_artists,
            mi.album_id::text                                               AS album_id,
            mi.album_title
        FROM page mi
        LEFT JOIN media_items artist ON artist.id = mi.album_artist_id
        ${canonicalTrackArtistsJoinSql(sql, 'mi')}
        ORDER BY mi.distance ASC, mi.id ASC
    `;
}

/**
 * Whether the model has any assignment for this cluster id, regardless of who
 * may see its tracks. Lets a caller tell "unknown cluster" (404) from "known
 * cluster, nothing visible to this caller" (200, empty). Returns only a
 * boolean, so no track data leaks past the access boundary.
 *
 * @param sql       - postgres.Sql instance.
 * @param modelId   - Embedding model (always 'msclap-2023').
 * @param clusterId - Integer cluster label.
 */
export async function clusterExists(
    sql: postgres.Sql,
    modelId: string,
    clusterId: number,
): Promise<boolean> {
    const rows = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
            SELECT 1
            FROM media_audio_clusters
            WHERE model_id = ${modelId}
              AND cluster_id = ${clusterId}
        ) AS exists
    `;
    return rows[0]?.exists === true;
}

// ---------------------------------------------------------------------------
// Write: upsert cluster assignments (called from sonic-clustering task only)
// ---------------------------------------------------------------------------

/**
 * Bulk-upsert cluster assignments into media_audio_clusters.
 *
 * Uses ON CONFLICT to update cluster_id and computed_at when a row for the
 * same (media_id, model_id) already exists. Idempotent.
 *
 * @param sql         - postgres.Sql instance.
 * @param modelId     - Embedding model (always 'msclap-2023').
 * @param assignments - Array of {mediaId, clusterId} pairs.
 */
export async function upsertClusterAssignments(
    sql: postgres.Sql,
    modelId: string,
    assignments: ClusterAssignmentInput[],
): Promise<void> {
    if (assignments.length === 0) return;

    await sql`
        INSERT INTO media_audio_clusters (media_id, model_id, cluster_id, computed_at)
        SELECT
            input.media_id::uuid,
            ${modelId},
            input.cluster_id::int,
            now()
        FROM (VALUES ${sql(assignments.map((a) => [a.mediaId, a.clusterId]))}) AS input(media_id, cluster_id)
        ON CONFLICT (media_id, model_id)
        DO UPDATE SET
            cluster_id  = EXCLUDED.cluster_id,
            computed_at = EXCLUDED.computed_at
    `;
}

// ---------------------------------------------------------------------------
// Read: per-cluster centroid in the sonic audio embedding space
// ---------------------------------------------------------------------------

/**
 * Compute the centroid (mean embedding) for a set of member track IDs within
 * one cluster in the audio embedding space (media_audio_embeddings).
 *
 * The average is computed in SQL using `AVG()` over the vector components
 * (cast to `double precision[]` then back to `vector`) so no large payload
 * is transferred to Node. Returns null when the cluster is empty or no
 * member has an audio embedding.
 *
 * Called by getUserSonicTasteClusters in taste-clusters.service.ts.
 *
 * @param sql       - postgres.Sql instance.
 * @param modelId   - Embedding model (always 'msclap-2023').
 * @param memberIds - Internal UUIDs of the tracks in this cluster.
 */
export async function getClusterCentroid(
    sql: postgres.Sql,
    modelId: string,
    memberIds: string[],
): Promise<number[] | null> {
    if (memberIds.length === 0) return null;

    // AVG each dimension individually then rebuild the vector.
    // pgvector 0.5+ supports `avg(embedding)` directly — use it.
    // Cast the result to text so postgres.js hands it back as a string we can
    // parse with parseEmbedding (same path as every other kNN query).
    const rows = await sql<{ centroid: string | null }[]>`
        SELECT avg(mae.embedding)::text AS centroid
        FROM media_audio_embeddings mae
        WHERE mae.model_id = ${modelId}
          AND mae.media_id = ANY(${memberIds}::uuid[])
    `;
    const raw = rows[0]?.centroid;
    if (!raw) return null;

    // Parse "[n1,n2,...]" text format emitted by pgvector ::text cast.
    try {
        const trimmed = raw.startsWith('[') ? raw.slice(1, -1) : raw;
        const vec = trimmed.split(',').map(Number);
        if (vec.length === 0 || vec.some((v) => !Number.isFinite(v))) return null;
        return vec;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Write: upsert / delete (called from sonic-clustering task only)
// ---------------------------------------------------------------------------

/**
 * Delete all cluster assignments for the given model.
 * Called at the start of a clustering run to ensure stale assignments
 * are removed before the new ones are written.
 *
 * @param sql     - postgres.Sql instance.
 * @param modelId - Embedding model (always 'msclap-2023').
 */
export async function clearClusterAssignments(sql: postgres.Sql, modelId: string): Promise<void> {
    await sql`
        DELETE FROM media_audio_clusters
        WHERE model_id = ${modelId}
    `;
}

/**
 * Count the number of cluster assignments for the given model.
 * Used by the task to log progress and by tests.
 *
 * @param sql     - postgres.Sql instance.
 * @param modelId - Embedding model (always 'msclap-2023').
 */
export async function countClusterAssignments(sql: postgres.Sql, modelId: string): Promise<number> {
    const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM media_audio_clusters
        WHERE model_id = ${modelId}
    `;
    return parseInt(rows[0]?.count ?? '0', 10);
}

// ---------------------------------------------------------------------------
// Stable ids (called from sonic-clustering task only)
// ---------------------------------------------------------------------------

/**
 * The current assignments as media id → cluster id. The task reads them
 * before clearing, to carry each cluster's id over to the new run.
 */
export async function getClusterAssignmentMap(
    sql: postgres.Sql,
    modelId: string,
): Promise<Map<string, number>> {
    const rows = await sql<{ media_id: string; cluster_id: number }[]>`
        SELECT media_id::text AS media_id, cluster_id
        FROM media_audio_clusters
        WHERE model_id = ${modelId}
    `;
    return new Map(rows.map((r) => [r.media_id, r.cluster_id]));
}

/** Highest cluster id ever issued for the model (audio_cluster_ids), -1 when none. */
export async function getHighestIssuedClusterId(
    sql: postgres.Sql,
    modelId: string,
): Promise<number> {
    const rows = await sql<{ max: number | null }[]>`
        SELECT max(cluster_id) AS max FROM audio_cluster_ids WHERE model_id = ${modelId}
    `;
    return rows[0]?.max ?? -1;
}

/** Record newly issued ids so they are never handed out again. */
export async function recordIssuedClusterIds(
    sql: postgres.Sql,
    modelId: string,
    clusterIds: number[],
): Promise<void> {
    if (clusterIds.length === 0) return;
    await sql`
        INSERT INTO audio_cluster_ids (model_id, cluster_id)
        SELECT ${modelId}, unnest(${clusterIds}::int[])
        ON CONFLICT DO NOTHING
    `;
}

// ---------------------------------------------------------------------------
// Read: one track of a seeded shuffle
// ---------------------------------------------------------------------------

/** The track {@link getClusterShuffleTrack} picked, plus where it sits in the order. */
export interface ClusterShuffleTrackRow {
    media_id: string;
    title: string;
    artist_title: string | null;
    /** 0-based position actually served: `i mod track_count`. */
    position: number;
    /** Accessible tracks in the cluster — the length of one shuffled round. */
    track_count: number;
}

/**
 * Track `index` of the cluster's accessible members shuffled by `seed`.
 *
 * Stateless: the order is `md5(seed:media_id)`, so the same seed and index
 * give the same track until the cluster's membership or the caller's access
 * changes, and a new seed gives a new order. `index` wraps modulo the track
 * count, so a device can keep counting. Null when the cluster does not exist
 * (or was retired) or nothing in it is visible to the caller.
 */
export async function getClusterShuffleTrack(
    sql: postgres.Sql,
    modelId: string,
    clusterId: number,
    seed: number,
    index: number,
    access: MediaAccessBoundary,
): Promise<ClusterShuffleTrackRow | null> {
    if (deniesEverything(access)) return null;

    const rows = await sql<ClusterShuffleTrackRow[]>`
        WITH shuffled AS (
            SELECT
                mi.id,
                (row_number() OVER (
                    ORDER BY md5(${String(seed)} || ':' || mi.id::text), mi.id
                ) - 1)::int                    AS position,
                (count(*) OVER ())::int        AS track_count
            FROM media_audio_clusters mac
            JOIN media_items mi
                   ON mi.id = mac.media_id
                  AND mi.media_type = 'track'
                  AND mi.has_files = true
                  AND mi.status = 'active'
            WHERE mac.model_id = ${modelId}
              AND mac.cluster_id = ${clusterId}
            ${buildLibraryAccessFilter(sql, access.library)}
            ${buildAgeRatingFilter(sql, access.age)}
        )
        SELECT
            s.id::text                          AS media_id,
            mi.title,
            ${trackDisplayArtistSql(sql, 'mi')} AS artist_title,
            s.position,
            s.track_count
        FROM shuffled s
        JOIN media_items mi ON mi.id = s.id
        LEFT JOIN media_items album
               ON album.id = mi.parent_id
              AND album.media_type = 'album'
        LEFT JOIN media_items artist
               ON artist.id = album.parent_id
              AND artist.media_type = 'artist'
        WHERE s.position = ${index} % s.track_count
    `;
    return rows[0] ?? null;
}
