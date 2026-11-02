// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sonic Taste Profile Query Module
 *
 * Computes a user's "sonic taste vector" via a Rocchio-style algorithm in the
 * MSCLAP-2023 1024-dim audio-embedding space, then finds kNN "sonic taste picks"
 * around that vector from `media_audio_embeddings`.
 *
 * Algorithm (Rocchio):
 *   1. Collect POSITIVE embeddings:
 *        a. Loved tracks    — user_ratings.rating >= 8 AND skipped IS NOT TRUE
 *           (weight 3× as in existing taste-similar bucket)
 *        b. Non-skip plays  — user_music_state WHERE play_count > 0
 *           AND skip_count/play_count <= 0.5
 *           Recency-weighted by exp(-rank * ln2/DECAY_HALF_LIFE) on last_played_at DESC.
 *           Excludes tracks already in the loved set to avoid double-counting.
 *   2. Collect NEGATIVE embeddings (recency-weighted, newest first):
 *        a. Explicit dislikes — user_ratings.rating <= 3 OR skipped = TRUE
 *        b. Behavioral skips  — skip_count/play_count > 0.7 AND play_count >= 3
 *      Weighted by exp(-rank * ln2/NEG_DECAY_HALF_LIFE) on recency DESC so a
 *      stale "not in the mood" fades from the steering instead of suppressing
 *      that region of taste-space permanently.
 *   3. Compute normalized positive centroid (meanPos) and normalized negative
 *      centroid (meanNeg).  Rocchio taste = normalize(meanPos - BETA * meanNeg).
 *   4. Return null when the user has no signals with embeddings (cold start).
 *
 * getSonicTastePicks():
 *   kNN around the taste vector from media_audio_embeddings, excluding:
 *     - already-rated tracks (up or down)
 *     - recently played (within RECENT_PLAY_DAYS days)
 *     - tracks too close to the negative centroid (similarity > NEG_CENTROID_THRESHOLD)
 *
 * All functions take `sql: postgres.Sql` as first parameter with no side effects.
 *
 * @module queries/sonic-taste
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import {
    normalizeVector,
    subtractVectors,
    parseEmbedding,
} from '$lib/server/utils/embedding-utils.js';
import {
    trackArtistIdSql,
    trackDisplayArtistSql,
    trackArtistsSql,
    trackRemixerArtistsSql,
    canonicalTrackArtistsJoinSql,
    trackCreditArtistsSql,
} from './fragments/music-artist.fragments.js';
import { trackFilePathJoin } from './fragments/music-file-path.fragments.js';
import type { RecentTrackRow } from './music.queries.js';
import { MSCLAP_MODEL_ID } from './sonic-constants.js';
import { sonicAnnCandidates } from './fragments/sonic-ann.fragments.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** MSCLAP model — must match every INSERT/WHERE in the pipeline. */
const MODEL_ID = MSCLAP_MODEL_ID;

/** Exponential decay half-life (in track-rank positions) for play history. */
const DECAY_HALF_LIFE = 10;

/**
 * Exponential decay half-life (in track-rank positions) for the NEGATIVE arm,
 * ordered most-recent-first. Stale dislikes/skips contribute less to the
 * neighborhood steering so a past "not in the mood" fades instead of suppressing
 * that whole region of taste-space forever. Slightly longer than the play
 * half-life because an explicit dislike is more deliberate than a single play.
 * (This only softens the centroid steering — explicitly disliked / skip-dominant
 * tracks are still hard-excluded from picks elsewhere, regardless of age.)
 */
const NEG_DECAY_HALF_LIFE = 15;

/** Rocchio β — weight of the negative centroid subtraction. */
// Typed as `number` (not the `0.4` literal) so the `ROCCHIO_BETA === 0`
// retuning guard below stays valid rather than being flagged as a dead compare.
const ROCCHIO_BETA: number = 0.4;

/** Threshold above which a candidate's similarity to the negative centroid
 *  causes it to be excluded from picks. Range [0, 1]; 0.85 = very close. */
const NEG_CENTROID_THRESHOLD = 0.85;

/** Play weight cap — avoids one obsessively-repeated track dominating centroid. */
const PLAY_CAP = 20;

/**
 * Maximum seed tracks to pull per positive arm (loved / played).
 * Keeps the DB payload bounded while still producing a stable centroid.
 */
const SEED_LIMIT = 60;

/**
 * Tracks played more recently than this many days are excluded from picks
 * (they are already surfaced by recently-heard / heavy-rotation buckets).
 */
const RECENT_PLAY_DAYS = 7;

/** Weight multiplier applied to loved (rating >= 8) embeddings. */
const LOVED_WEIGHT = 3;

// ---------------------------------------------------------------------------
// Access boundary contract (read before touching any query text here)
// ---------------------------------------------------------------------------
//
// {@link getSonicTastePicks} takes a REQUIRED {@link MediaAccessBoundary}. There
// is no permissive default: a caller that wants unfiltered rows must say so with
// `unrestrictedAccess()`, which makes the decision greppable.
//
// WHY computeSonicTasteVector TAKES NO BOUNDARY. It returns a 1024-dim vector,
// not media rows — nothing reaches the user through it. Its seeds are the
// requesting user's OWN ratings and play history, i.e. tracks that user already
// consumed. Access-filtering those seeds would change the taste centroid and
// therefore which picks a restricted user is shown, which this migration must
// not do. The boundary belongs on the surface that emits rows (the kNN below),
// and that is where it is enforced. Same reasoning for the private
// fetchLoved/fetchPlayed/fetchNegative helpers.
//
// ALIAS CONTRACT. `buildLibraryAccessFilter` hardcodes `mi.id` in both of its
// correlated subqueries and `buildAgeRatingFilter` defaults its alias to `mi`.
// Neither splice site passes an alias override, so the kNN query MUST keep
// aliasing the CANDIDATE TRACK's media_items row as `mi`. Both builders emit an
// EMPTY fragment under an unrestricted boundary, so an alias mistake here fails
// only for restricted callers — which is why the integration tests run the same
// fixture through both a restricted and an unrestricted boundary.
//
// PREDICATE GRAIN. The kNN also LEFT JOINs `media_items album` and
// `media_items artist` for display fields. Those container rows are deliberately
// NOT boundary-filtered: a permitted track whose album/artist row sits in a
// denied group still renders its album_title/artist_title. That is pre-existing
// behaviour; applying the boundary to those aliases would change which fields a
// restricted user sees and is therefore out of scope for this migration.
//
// NESTED SCOPE. `fetchNegativeEmbeddings` has a two-level nested UNION ALL whose
// inner branches declare their own local `mi` aliases. The outer FROM has no
// `mi` at all, so a boundary fragment could not be appended there even if the
// semantics called for it. Another reason the boundary lives only on the kNN.
//
// FILTER ORDER. The boundary predicates sit INSIDE the SQL, before
// `LIMIT ${overfetch}`. The negative-centroid post-filter in JS runs after. Do
// not move access filtering into the JS post-processing step: that would apply
// it after the LIMIT and silently shrink restricted users' result sets.
//
// DENY-ALL. `getSonicTastePicks` short-circuits to `[]` via `deniesEverything`
// before doing any work. Both builders would emit `AND false`, which is equally
// correct, but returning early also skips the Rocchio round trips, the negative
// centroid round trip, and a full transaction + ANN scan that could only ever
// return nothing.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EmbeddingRow {
    media_id: string;
    embedding: string; // pgvector text format '[a,b,c,...]'
}

interface WeightedEmbedding {
    embedding: number[];
    weight: number;
}

/**
 * Result of {@link computeSonicTasteVector}.
 *
 * When null, the caller should fall back to the metadata taste path.
 */
export type SonicTasteVector = number[] | null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute a weighted centroid from a list of (embedding, weight) pairs.
 * Returns null when the list is empty or all weights are zero.
 */
function computeWeightedCentroid(items: WeightedEmbedding[]): number[] | null {
    if (items.length === 0) return null;

    const dim = items[0].embedding.length;
    if (dim === 0) return null;

    const centroid = new Array<number>(dim).fill(0);
    let totalWeight = 0;

    for (const { embedding: emb, weight } of items) {
        if (weight <= 0 || emb.length !== dim) continue;
        for (let d = 0; d < dim; d++) {
            centroid[d] += emb[d] * weight;
        }
        totalWeight += weight;
    }

    if (totalWeight === 0) return null;

    for (let d = 0; d < dim; d++) {
        centroid[d] /= totalWeight;
    }

    return centroid;
}

/**
 * Compute cosine similarity between two L2-normalised vectors.
 * Assumes both are already unit-norm (dot product = cosine similarity).
 */
function dotProduct(a: number[], b: number[]): number {
    const len = Math.min(a.length, b.length);
    let sum = 0;
    for (let i = 0; i < len; i++) {
        sum += a[i] * b[i];
    }
    return sum;
}

// ---------------------------------------------------------------------------
// Positive arm fetchers
// ---------------------------------------------------------------------------

/**
 * Fetch embeddings for tracks the user explicitly loved (rating >= 8).
 * Each loved track is included with weight=LOVED_WEIGHT (3×).
 */
async function fetchLovedEmbeddings(
    sql: postgres.Sql,
    userId: UserId,
    excludeIds: Set<string>,
): Promise<WeightedEmbedding[]> {
    const rows = await sql<EmbeddingRow[]>`
        SELECT mae.media_id::text, mae.embedding::text
        FROM user_ratings ur
        JOIN media_audio_embeddings mae
               ON mae.media_id = ur.media_id
              AND mae.model_id = ${MODEL_ID}
        JOIN media_items mi
               ON mi.id = ur.media_id
              AND mi.media_type = 'track'
              AND mi.has_files = true
        WHERE ur.user_id = ${userId}
          AND ur.rating >= 8
          AND (ur.skipped IS NULL OR ur.skipped = FALSE)
        LIMIT ${SEED_LIMIT}
    `;

    return rows
        .filter((r) => !excludeIds.has(r.media_id))
        .flatMap((r) => {
            const embedding = parseEmbedding(r.embedding);
            if (!embedding) return [];
            return [{ embedding, weight: LOVED_WEIGHT }];
        });
}

/**
 * Fetch embeddings for non-skip-dominant played tracks, recency-weighted.
 * Excludes tracks already fetched by the loved arm.
 */
async function fetchPlayedEmbeddings(
    sql: postgres.Sql,
    userId: UserId,
    excludeIds: Set<string>,
): Promise<WeightedEmbedding[]> {
    const rows = await sql<
        Array<{
            media_id: string;
            play_count: number;
            last_played_at: Date;
            embedding: string;
        }>
    >`
        SELECT
            ums.track_id::text AS media_id,
            ums.play_count,
            ums.last_played_at,
            mae.embedding::text
        FROM user_music_state ums
        JOIN media_audio_embeddings mae
               ON mae.media_id = ums.track_id
              AND mae.model_id = ${MODEL_ID}
        JOIN media_items mi
               ON mi.id = ums.track_id
              AND mi.media_type = 'track'
              AND mi.has_files = true
        WHERE ums.user_id = ${userId}
          AND ums.play_count > 0
          AND (
              ums.skip_count IS NULL
              OR ums.skip_count::float / GREATEST(ums.play_count, 1) <= 0.5
          )
        ORDER BY ums.last_played_at DESC
        LIMIT ${SEED_LIMIT}
    `;

    const ln2OverHalfLife = Math.LN2 / DECAY_HALF_LIFE;
    const result: WeightedEmbedding[] = [];
    let rank = 0;

    for (const r of rows) {
        if (excludeIds.has(r.media_id)) continue;
        const embedding = parseEmbedding(r.embedding);
        if (!embedding) continue;
        const playStrength = Math.min(r.play_count, PLAY_CAP) / PLAY_CAP; // [0,1]
        const decayWeight = Math.exp(-rank * ln2OverHalfLife);
        result.push({
            embedding,
            // Combined weight: recency-decay × play-strength
            weight: decayWeight * (0.5 + 0.5 * playStrength), // [0.5*decay, 1*decay]
        });
        rank++;
    }

    return result;
}

// ---------------------------------------------------------------------------
// Negative arm fetchers
// ---------------------------------------------------------------------------

/**
 * Fetch embeddings for explicitly disliked and skip-dominant tracks,
 * recency-weighted (newest negatives steer hardest, stale ones fade) — mirrors
 * the positive played arm. Recency is the rating's `updated_at` for explicit
 * dislikes/skips and `last_played_at` for behavioral skip-dominant tracks; a
 * track appearing in both arms keeps its most-recent timestamp.
 */
async function fetchNegativeEmbeddings(
    sql: postgres.Sql,
    userId: UserId,
): Promise<WeightedEmbedding[]> {
    const rows = await sql<EmbeddingRow[]>`
        SELECT neg.media_id::text, mae.embedding::text
        FROM (
            SELECT media_id, MAX(recency) AS recency
            FROM (
                -- Explicit dislikes and dismissals (recency = when rated)
                SELECT ur.media_id, ur.updated_at AS recency
                FROM user_ratings ur
                JOIN media_items mi ON mi.id = ur.media_id AND mi.media_type = 'track'
                WHERE ur.user_id = ${userId}
                  AND (ur.rating <= 3 OR ur.skipped = TRUE)

                UNION ALL

                -- Behavioral skip-dominant (>70% of ≥3 plays; recency = last play)
                SELECT ums.track_id AS media_id, ums.last_played_at AS recency
                FROM user_music_state ums
                JOIN media_items mi ON mi.id = ums.track_id AND mi.media_type = 'track'
                WHERE ums.user_id = ${userId}
                  AND ums.play_count >= 3
                  AND ums.skip_count::float / GREATEST(ums.play_count, 1) > 0.7
            ) neg_sources
            GROUP BY media_id
        ) neg
        JOIN media_audio_embeddings mae
               ON mae.media_id = neg.media_id
              AND mae.model_id = ${MODEL_ID}
        ORDER BY neg.recency DESC NULLS LAST, neg.media_id
        LIMIT ${SEED_LIMIT}
    `;

    // Rank-based exponential decay over the recency-sorted negatives, mirroring
    // fetchPlayedEmbeddings so positive and negative arms age consistently.
    const ln2OverHalfLife = Math.LN2 / NEG_DECAY_HALF_LIFE;
    const result: WeightedEmbedding[] = [];
    let rank = 0;
    for (const r of rows) {
        const embedding = parseEmbedding(r.embedding);
        if (!embedding) continue;
        result.push({ embedding, weight: Math.exp(-rank * ln2OverHalfLife) });
        rank++;
    }
    return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the user's Rocchio sonic taste vector in the MSCLAP-2023 space.
 *
 * Returns null when the user has no signal with embeddings (cold start) or
 * when the positive centroid is undefined.
 *
 * @param sql       - postgres.Sql instance (parameterized — no sql.unsafe).
 * @param userId    - The requesting user's ID.
 */
export async function computeSonicTasteVector(
    sql: postgres.Sql,
    userId: UserId,
): Promise<SonicTasteVector> {
    // Step 1: fetch loved tracks (positive arm, high-weight)
    const lovedItems = await fetchLovedEmbeddings(sql, userId, new Set());
    // IDs of loved tracks so the played arm doesn't double-count them
    const lovedIds = new Set(
        await sql<{ media_id: string }[]>`
            SELECT ur.media_id::text
            FROM user_ratings ur
            JOIN media_audio_embeddings mae
                   ON mae.media_id = ur.media_id AND mae.model_id = ${MODEL_ID}
            WHERE ur.user_id = ${userId}
              AND ur.rating >= 8
              AND (ur.skipped IS NULL OR ur.skipped = FALSE)
            LIMIT ${SEED_LIMIT}
        `.then((rows) => rows.map((r) => r.media_id)),
    );

    // Step 2: fetch non-skip-dominant played tracks (positive arm, decay-weighted)
    const playedItems = await fetchPlayedEmbeddings(sql, userId, lovedIds);

    // Combined positive set
    const positiveItems = [...lovedItems, ...playedItems];

    // Cold-start: no signal at all
    if (positiveItems.length === 0) return null;

    // Step 3: positive centroid
    const posCentroid = computeWeightedCentroid(positiveItems);
    if (!posCentroid) return null;

    // Step 4: negative centroid
    const negativeItems = await fetchNegativeEmbeddings(sql, userId);
    const negCentroid = computeWeightedCentroid(negativeItems); // null OK (no dislikes yet)

    // Step 5: Rocchio: taste = normalize(meanPos - BETA * meanNeg)
    const normalized_pos = normalizeVector(posCentroid);

    if (!negCentroid || ROCCHIO_BETA === 0) {
        // No negatives yet → taste = normalize(meanPos)
        return normalized_pos;
    }

    const normalizedNeg = normalizeVector(negCentroid);
    const rocchio = subtractVectors(normalized_pos, normalizedNeg, ROCCHIO_BETA);
    const tasteVector = normalizeVector(rocchio);

    // Guard: if subtraction collapsed to zero, return positive centroid
    const magnitude = Math.sqrt(tasteVector.reduce((s, v) => s + v * v, 0));
    if (magnitude < 1e-9) return normalized_pos;

    return tasteVector;
}

/**
 * Find tracks that match the user's sonic taste profile (kNN over MSCLAP).
 *
 * Excludes:
 *   1. Tracks already rated (up or down) by the user.
 *   2. Tracks played within RECENT_PLAY_DAYS days.
 *   3. Tracks too close to the negative centroid (similarity > NEG_CENTROID_THRESHOLD).
 *
 * Returns an empty array when the taste vector is null (cold start), when no
 * matching tracks are found, or when `access` denies everything.
 *
 * @param sql    - postgres.Sql instance.
 * @param userId - The requesting user's ID.
 * @param limit  - Maximum number of results.
 * @param access - REQUIRED access boundary. Use `searchAccessBoundary(ctx)` for
 *                 a real user, or `unrestrictedAccess()` to opt out explicitly.
 */
export async function getSonicTastePicks(
    sql: postgres.Sql,
    userId: UserId,
    limit: number,
    access: MediaAccessBoundary,
): Promise<RecentTrackRow[]> {
    // Short-circuit before any round trip — see the DENY-ALL note in the access
    // boundary contract at the top of this module.
    if (deniesEverything(access)) return [];

    const tasteVector = await computeSonicTasteVector(sql, userId);
    if (!tasteVector) return [];

    const vectorLiteral = `[${tasteVector.map((n) => n.toFixed(8)).join(',')}]`;

    // Compute negative centroid for the SUBTRACT mechanic (filter too-close-to-neg).
    // We recompute it here independently (no caching) so it always reflects the latest votes.
    // This is cheap: the negative set is typically small (< 60 tracks).
    const negItems = await fetchNegativeEmbeddings(sql, userId);
    const negCentroid = computeWeightedCentroid(negItems);
    const normalizedNeg = negCentroid ? normalizeVector(negCentroid) : null;
    const negVectorLiteral = normalizedNeg
        ? `[${normalizedNeg.map((n) => n.toFixed(8)).join(',')}]`
        : null;

    // Fetch candidates — over-fetch to allow post-filtering by negative centroid.
    // The kNN ORDER BY already prioritises proximity to the taste vector.
    const overfetch = Math.min(limit * 4, 200);

    // HNSW recall guard: prod runs hnsw.ef_search=40, so the bare ANN
    // `ORDER BY mae.embedding <=> vectorLiteral` below only visits ~40
    // candidates before the already-rated / recently-played filters are
    // applied. Unlike the centroid queries above there's no explicit
    // exclude array here — the exclusions are a NOT EXISTS (rated tracks)
    // and a recency window (RECENT_PLAY_DAYS) — but both are state-based
    // filters that cluster near the taste centroid (the very tracks the
    // taste vector was built from), so give this the same generous 2x
    // slack used for the never-played centroid queries.
    const excludeCount = 2 * overfetch;
    const efSearch = Math.min(1000, Math.max(64, overfetch + excludeCount));
    // ANN pool the outer filters whittle down — see {@link sonicAnnCandidates}.
    // Tied to efSearch: HNSW returns at most ef_search candidates, so a larger
    // pool would silently come back short.
    const annLimit = efSearch;

    type CandidateRow = RecentTrackRow & { similarity_to_negative: number };

    const candidates = await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await tx`SELECT set_config('hnsw.ef_search', ${String(efSearch)}, true)`;

        // Force the ANN stage onto the HNSW index. Without this the planner
        // prices a full scan of the ~30k-row embedding table below the index
        // and top-N heapsorts it — 667ms on prod, with
        // idx_media_audio_embeddings_hnsw left unused. is_local=true scopes
        // this to the surrounding transaction.
        await tx`SELECT set_config('enable_seqscan', 'off', true)`;

        return tx<CandidateRow[]>`
            WITH ann AS MATERIALIZED (
                ${sonicAnnCandidates(sql, vectorLiteral, MODEL_ID, annLimit)}
            ),
            page AS (
                -- Artist credits are resolved below, for the page only.
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
                    artist.id AS album_artist_id,
                    ann.ann_distance,
                    mi.created_at::text AS last_played_at,
                    (EXTRACT(EPOCH FROM (NOW() - ums.last_played_at)) / 3600)::double precision
                        AS hours_since_played,
                    mf.file_path AS file_path,
                    ${
                        negVectorLiteral
                            ? sql`(1 - (ann.embedding <=> ${negVectorLiteral}::vector))::double precision`
                            : sql`0::double precision`
                    } AS similarity_to_negative
                FROM ann
                JOIN media_items mi
                       ON mi.id = ann.media_id
                      AND mi.media_type = 'track'
                      AND mi.has_files = true
                      AND mi.status = 'active'
                LEFT JOIN media_items album
                       ON album.id = mi.parent_id
                      AND album.media_type = 'album'
                LEFT JOIN media_items artist
                       ON artist.id = album.parent_id
                      AND artist.media_type = 'artist'
                LEFT JOIN user_music_state ums
                       ON ums.track_id = mi.id
                      AND ums.user_id = ${userId}
                ${trackFilePathJoin(sql, 'mi')}
                -- model_id is filtered inside the ANN stage above, so this
                -- WHERE now opens on the rated-tracks exclusion.
                WHERE
                  -- Exclude already-rated tracks (up or down) — these are the
                  -- tracks the sonic taste was *built from*, no point re-surfacing.
                  NOT EXISTS (
                      SELECT 1 FROM user_ratings ur2
                      WHERE ur2.media_id = mi.id AND ur2.user_id = ${userId}
                  )
                  -- Exclude recently played (already surfaced by recency buckets).
                  AND (
                      ums.last_played_at IS NULL
                      OR ums.last_played_at < NOW() - make_interval(days => ${RECENT_PLAY_DAYS})
                  )
                  ${buildLibraryAccessFilter(sql, access.library)}
                  ${buildAgeRatingFilter(sql, access.age)}
                ORDER BY ann.ann_distance ASC
                LIMIT ${overfetch}
            )
            SELECT
                mi.id,
                mi.title,
                mi.sort_order,
                mi.runtime_seconds,
                mi.custom_poster_url,
                mi.custom_metadata,
                mi.album_id,
                mi.album_title,
                mi.album_custom_poster_url,
                ${trackArtistIdSql(sql, 'mi', trackCreditArtistsSql(sql))} AS artist_id,
                ${trackDisplayArtistSql(sql, 'mi', trackCreditArtistsSql(sql))} AS artist_title,
                ${trackArtistsSql(sql, 'mi', trackCreditArtistsSql(sql))} AS track_artists,
                ${trackRemixerArtistsSql(sql, 'mi')} AS remixer_artists,
                mi.last_played_at,
                mi.hours_since_played,
                mi.file_path,
                mi.similarity_to_negative
            FROM page mi
            LEFT JOIN media_items artist ON artist.id = mi.album_artist_id
            ${canonicalTrackArtistsJoinSql(sql, 'mi')}
            ORDER BY mi.ann_distance ASC
        `;
    });

    // Post-filter: drop tracks too similar to the negative centroid.
    const filtered = negVectorLiteral
        ? candidates.filter((c) => c.similarity_to_negative <= NEG_CENTROID_THRESHOLD)
        : candidates;

    return filtered.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Exports for unit tests
// ---------------------------------------------------------------------------

// parseEmbeddingText is re-exported as a thin alias for parseEmbedding to
// maintain backward compatibility with unit tests and sonic-queue.queries.ts.
// The canonical function to use in new code is parseEmbedding from
// $lib/server/utils/embedding-utils.js.
function parseEmbeddingText(text: string): number[] {
    return parseEmbedding(text) ?? [];
}

export {
    parseEmbeddingText,
    computeWeightedCentroid,
    dotProduct,
    ROCCHIO_BETA,
    LOVED_WEIGHT,
    PLAY_CAP,
    DECAY_HALF_LIFE,
    NEG_DECAY_HALF_LIFE,
    NEG_CENTROID_THRESHOLD,
};
