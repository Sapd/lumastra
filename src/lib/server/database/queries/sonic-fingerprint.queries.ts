// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sonic Fingerprint Query Module
 *
 * Computes a user's "sonic fingerprint" — a recency-weighted centroid over the
 * MSCLAP-2023 embeddings of their most-played tracks — then finds kNN neighbours
 * over `media_audio_embeddings`.
 *
 * All functions take `sql: postgres.Sql` as first parameter and have no side effects.
 *
 * The HNSW index on `media_audio_embeddings` uses `vector_cosine_ops`, so kNN
 * queries MUST use the `<=>` (cosine distance) operator.
 *
 * Algorithm:
 *   1. Fetch the user's top-N tracks by play_count from `user_music_state`,
 *      ordered by recency (last_played_at DESC), capped at SEED_LIMIT.
 *   2. Fetch embeddings for those tracks from `media_audio_embeddings`.
 *   3. Compute a recency-weighted centroid: tracks played more recently get
 *      higher weight via an exponential decay on rank position.
 *   4. Issue a kNN query using the centroid as the probe vector, excluding the
 *      seed tracks, with library-group and age-rating access scoping.
 *
 * @module queries/sonic-fingerprint
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { MSCLAP_MODEL_ID } from './sonic-constants.js';
import { parseEmbedding } from '$lib/server/utils/embedding-utils.js';
import {
    nonVariousArtistIdSql,
    trackArtistIdSql,
    trackArtistsSql,
    trackRemixerArtistsSql,
    trackDisplayArtistSql,
    canonicalTrackArtistsJoinSql,
    trackCreditArtistsSql,
} from './fragments/music-artist.fragments.js';
import { computeWeightedCentroid } from './sonic-taste.queries.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** MSCLAP model — must match every INSERT/WHERE in the pipeline. */
const MODEL_ID = MSCLAP_MODEL_ID;

/** Maximum number of most-played seed tracks to pull for the centroid. */
const SEED_LIMIT = 50;

/** Exponential decay half-life (in track-rank positions). */
const DECAY_HALF_LIFE = 10;

// ---------------------------------------------------------------------------
// Access boundary contract (read before touching any query text here)
// ---------------------------------------------------------------------------
//
// {@link findSonicFingerprintNeighbors} takes a REQUIRED {@link MediaAccessBoundary}.
// There is no permissive default: a caller that wants unfiltered rows must say so
// with `unrestrictedAccess()`, which makes the decision greppable.
//
// WHY fetchSeedRows TAKES NO BOUNDARY. Seeds are the requesting user's OWN play
// history (`user_music_state`), i.e. tracks that user already listened to — no
// row from it ever reaches the response. Access-filtering the seeds would change
// the centroid and therefore which neighbours a restricted user is shown, which
// this migration must not do. The boundary belongs on the surface that emits
// rows (the kNN below), and that is the only place it is enforced.
//
// ALIAS CONTRACT. `buildLibraryAccessFilter` hardcodes `mi.id` in both of its
// correlated subqueries and takes no alias parameter; `buildAgeRatingFilter`
// defaults its alias to `mi` and neither splice site overrides it. The kNN query
// MUST therefore keep aliasing the CANDIDATE TRACK's media_items row as `mi`.
// Both builders emit an EMPTY fragment under an unrestricted boundary, so an
// alias mistake here fails only for restricted callers — which is why the
// integration tests run the same fixture through both a restricted and an
// unrestricted boundary.
//
// PREDICATE GRAIN. The kNN also LEFT JOINs `media_items album` and
// `media_items artist` for display fields. Those container rows are deliberately
// NOT boundary-filtered: a permitted track whose album/artist row sits in a
// denied group still renders its album_title/artist_id. That is pre-existing
// behaviour; scoping those aliases would both change which fields a restricted
// user sees and turn the LEFT JOINs into row-dropping ones.
//
// DENY-ALL. The function short-circuits to an empty result via `deniesEverything`
// before any query runs. Both builders would emit `AND false`, which is equally
// correct, but returning early also skips the seed round trip (whose seed ids
// feed the `!= ALL(...)` exclusion) and a full ANN scan that could only ever
// return nothing. The short-circuit is reported as `meta.accessDenied` so callers
// can tell "you may see nothing" apart from "you have no play history".

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A seed track row from user_music_state + its embedding. */
interface SeedRow {
    track_id: string;
    play_count: number;
    last_played_at: Date;
    embedding: number[];
}

/** A single result row returned by {@link findSonicFingerprintNeighbors}. */
export interface FingerprintNeighborRow {
    media_id: string;
    /**
     * Cosine similarity [0, 1]: 1 = identical, 0 = orthogonal.
     * Derived from cosine *distance* as `1 - distance`.
     */
    similarity_score: number;
    title: string;
    custom_poster_url: string | null;
    custom_metadata: Record<string, unknown>;
    runtime_seconds: number | null;
    artist_title: string | null;
    /** Hierarchy artist UUID; NULL for orphans and Various-Artists compilations. */
    artist_id: string | null;
    /** Per-track artist list (tag order) for credit/title linkification. */
    track_artists: { id: string | null; title: string }[] | null;
    remixer_artists?: Array<{ id: string | null; title: string }> | null;
    album_id: string | null;
    album_title: string | null;
}

/** Metadata about the fingerprint computation returned alongside the tracks. */
export interface FingerprintMeta {
    /** Number of seed tracks used to compute the centroid. */
    seedCount: number;
    /** Whether any seeds were found (false = user has no play history). */
    hasSufficientHistory: boolean;
    /**
     * True when the empty result is the access boundary denying everything
     * rather than the user having no play history. Lets callers avoid writing a
     * "no history" negative cache entry for a caller who is simply shut out.
     */
    accessDenied: boolean;
}

/** Full result of {@link findSonicFingerprintNeighbors}. */
export interface SonicFingerprintResult {
    tracks: FingerprintNeighborRow[];
    meta: FingerprintMeta;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fetch seed tracks: the user's most-played tracks that have a sonic embedding.
 * Ordered by last_played_at DESC so the most recent listens are ranked first
 * (rank 0 = most recently played), giving them higher centroid weight.
 */
async function fetchSeedRows(sql: postgres.Sql, userId: UserId): Promise<SeedRow[]> {
    const rows = await sql<
        Array<{
            track_id: string;
            play_count: number;
            last_played_at: Date;
            embedding: string; // pgvector returns as '[a,b,c,...]' text
        }>
    >`
        SELECT
            ums.track_id::text,
            ums.play_count,
            ums.last_played_at,
            mae.embedding::text
        FROM user_music_state ums
        JOIN media_audio_embeddings mae
               ON mae.media_id = ums.track_id
              AND mae.model_id = ${MODEL_ID}
        WHERE ums.user_id = ${userId}
          AND ums.play_count > 0
        ORDER BY ums.last_played_at DESC
        LIMIT ${SEED_LIMIT}
    `;

    return rows
        .map((r) => {
            const embedding = parseEmbedding(r.embedding);
            if (!embedding) return null;
            return {
                track_id: r.track_id,
                play_count: r.play_count,
                last_played_at: r.last_played_at,
                embedding,
            };
        })
        .filter((r): r is SeedRow => r !== null);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find tracks that match the user's "sonic fingerprint".
 *
 * The fingerprint is derived from a recency-weighted centroid of the user's
 * most-played tracks' MSCLAP embeddings. If the user has no play history or
 * no embeddings for their played tracks, returns an empty result with
 * `hasSufficientHistory: false`.
 *
 * @param sql    - postgres.Sql instance (parameterized — no sql.unsafe).
 * @param userId - The requesting user's ID.
 * @param limit  - Maximum number of neighbours to return.
 * @param access - REQUIRED access boundary. Use `searchAccessBoundary(ctx)` for a
 *                 real user, or `unrestrictedAccess()` to opt out explicitly.
 */
export async function findSonicFingerprintNeighbors(
    sql: postgres.Sql,
    userId: UserId,
    limit: number,
    access: MediaAccessBoundary,
): Promise<SonicFingerprintResult> {
    // Step 0: deny-everything callers can see nothing — skip both round trips.
    // See the access boundary contract at the top of this module.
    if (deniesEverything(access)) {
        return {
            tracks: [],
            meta: { seedCount: 0, hasSufficientHistory: false, accessDenied: true },
        };
    }

    // Step 1: Fetch seed embeddings from the user's play history.
    const seeds = await fetchSeedRows(sql, userId);

    if (seeds.length === 0) {
        return {
            tracks: [],
            meta: { seedCount: 0, hasSufficientHistory: false, accessDenied: false },
        };
    }

    // Step 2: Compute recency-weighted centroid.
    // Build WeightedEmbedding[] using exponential decay on rank position
    // (rank 0 = most recently played → weight 1.0, half-life = DECAY_HALF_LIFE).
    const ln2OverHalfLife = Math.LN2 / DECAY_HALF_LIFE;
    const weightedSeeds = seeds.map((seed, rank) => ({
        embedding: seed.embedding,
        weight: Math.exp(-rank * ln2OverHalfLife),
    }));
    const centroid = computeWeightedCentroid(weightedSeeds);
    if (!centroid) {
        return {
            tracks: [],
            meta: { seedCount: seeds.length, hasSufficientHistory: false, accessDenied: false },
        };
    }

    // Step 3: Build exclusion list (seed track IDs).
    const seedIds = seeds.map((s) => s.track_id);

    // Step 4: Format centroid as pgvector literal.
    // This matches the established idiom in mood-vector.service.ts:
    //   `'[${arr.join(",")}]'::vector`
    const vectorLiteral = `[${centroid.join(',')}]`;

    // Step 5: kNN query using the centroid as probe vector.
    const rows = await sql<FingerprintNeighborRow[]>`
        WITH page AS (
            -- Artist credits are resolved below, for the page only.
            SELECT
                mae.media_id,
                mae.embedding <=> ${vectorLiteral}::vector                 AS distance,
                mi.title,
                mi.custom_poster_url,
                COALESCE(mi.custom_metadata, '{}'::jsonb)                  AS custom_metadata,
                mi.runtime_seconds,
                album.id                                                   AS album_id,
                album.title                                                AS album_title,
                artist.id                                                  AS album_artist_id
            FROM media_audio_embeddings mae
            JOIN media_items mi
                   ON mi.id = mae.media_id
                  AND mi.media_type = 'track'
                  AND mi.has_files = true
                  AND mae.media_id != ALL(${seedIds}::uuid[])
            LEFT JOIN media_items album
                   ON album.id = mi.parent_id
                  AND album.media_type = 'album'
            LEFT JOIN media_items artist
                   ON artist.id = album.parent_id
                  AND artist.media_type = 'artist'
            WHERE mae.model_id = ${MODEL_ID}
            ${buildLibraryAccessFilter(sql, access.library)}
            ${buildAgeRatingFilter(sql, access.age)}
            ORDER BY mae.embedding <=> ${vectorLiteral}::vector ASC
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
            CASE WHEN jsonb_typeof(NULLIF(mi.custom_metadata->'track_artist_credits', '[]'::jsonb)) = 'array'
                    THEN ${trackArtistIdSql(sql, 'mi', trackCreditArtistsSql(sql))}::text ELSE ${nonVariousArtistIdSql(sql)} END AS artist_id,
            ${trackArtistsSql(sql, 'mi', trackCreditArtistsSql(sql))} AS track_artists,
            ${trackRemixerArtistsSql(sql, 'mi')} AS remixer_artists,
            mi.album_id::text                                              AS album_id,
            mi.album_title
        FROM page mi
        LEFT JOIN media_items artist ON artist.id = mi.album_artist_id
        ${canonicalTrackArtistsJoinSql(sql, 'mi')}
        ORDER BY mi.distance ASC
    `;

    return {
        tracks: rows,
        meta: { seedCount: seeds.length, hasSufficientHistory: true, accessDenied: false },
    };
}
