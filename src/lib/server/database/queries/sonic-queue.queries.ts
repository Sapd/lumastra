// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sonic Smart Queue Query Module
 *
 * Blended kNN candidate retrieval over `media_audio_embeddings` (MSCLAP-2023)
 * for the sonic smart queue feature (gated on `features.sonicQueue`).
 *
 * ## Retrieval (MSCLAP vector space only)
 *
 *   Without mood seed (moodVector = null):
 *     queryVec = normalize( ALPHA_NO_MOOD * queueContextCentroid
 *                         + BETA_NO_MOOD  * sonicTasteVector )
 *
 *   With mood seed (moodVector present):
 *     queryVec = normalize( ALPHA * queueContextCentroid
 *                         + BETA  * sonicTasteVector
 *                         + GAMMA * audioMoodVector )
 *
 * The GAMMA arm is sourced from `mood_vectors` WHERE model_id = 'msclap-2023'
 * (written by generateAudioMoodVectors in mood-vector.service.ts). It is
 * geometrically compatible with the MSCLAP audio space used by this query.
 * Text mood-recommendations (model_id='text') are served by a separate path
 * and are unaffected.
 *
 * Missing arms (null) are skipped gracefully:
 *   - queueCentroid null  → cold start; caller should fall back to metadata path
 *   - tasteVector null    → cold start; BETA term is dropped silently
 *   - moodVector null     → no mood seed active; ALPHA_NO_MOOD/BETA_NO_MOOD used
 *
 * ## Score-level re-ranking (applied by the route after kNN)
 *
 * The route applies additional re-ranking signals on top of the raw kNN result:
 *   - Mixability tiebreak (see music-queue-scoring.ts): a small additive
 *     BPM/key blend term + energy-continuity term on top of raw similarity.
 *     There is no hard BPM/key/energy gate — similarity decides what plays,
 *     mixability only nudges ordering among near-equal candidates.
 *   - Genre-overlap boost (+0.12 × fraction of current-track genres in candidate)
 *   - MMR diversity pass (lambda = 0.7 over MSCLAP embeddings)
 *   - Per-album cap (max 2 tracks per parent_id)
 *
 * ## Dedup
 *
 * Remix/variant/cooldown exclusion runs inside the SQL (played_titles CTE +
 * pg_trgm NOT EXISTS), mirroring the metadata path. The route forwards
 * persistentPlayedTitles from getRecentlyPlayedVariants so the cross-session
 * cooldown applies here too.
 *
 * ## Post-retrieval penalties (in JS)
 *   - Session-skip demotion: flat SKIP_DEMOTION_PER_SKIP penalty per skipped track.
 *   - Hard-exclude: dislikedTrackIds are removed before returning.
 *
 * All functions take `sql: postgres.Sql` as the first parameter, no side effects.
 *
 * @module queries/sonic-queue
 */

import type postgres from 'postgres';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { normalizeVector, parseEmbedding } from '$lib/server/utils/embedding-utils.js';
import { computeWeightedCentroid } from './sonic-taste.queries.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import {
    nonVariousArtistIdSql,
    trackArtistIdSql,
    trackArtistsSql,
    trackRemixerArtistsSql,
    trackDisplayArtistSql,
    canonicalTrackArtistsJoinSql,
    trackCreditArtistsSql,
} from './fragments/music-artist.fragments.js';
import { MSCLAP_MODEL_ID } from './sonic-constants.js';
import {
    REMIX_TAG_REGEX,
    DASH_REMIX_SUFFIX_REGEX,
    BARE_REMIX_SUFFIX_REGEX,
    FEAT_TAG_REGEX,
    FEAT_DASH_SUFFIX_REGEX,
    VERSION_ONLY_SQL_PATTERN,
} from './music-title-normalize.js';

// ---------------------------------------------------------------------------
// Blend weight constants — export so tests can pin them without magic numbers
// ---------------------------------------------------------------------------

/**
 * Weight for the queue-context centroid arm when a mood seed is active.
 * Reduced from 0.5 to make room for the GAMMA arm (0.4 + 0.25 + 0.35 = 1.0).
 */
export const ALPHA = 0.4;

/**
 * Weight for the user's sonic taste vector when a mood seed is active.
 * Reduced from 0.3 to make room for the GAMMA arm.
 */
export const BETA = 0.25;

/**
 * Weight for the queue-context centroid arm when no mood seed is active.
 * Two-arm blend: ALPHA_NO_MOOD + BETA_NO_MOOD = 1.0 pre-normalize.
 */
export const ALPHA_NO_MOOD = 0.8;

/**
 * Default weight for the sonic taste vector when no mood seed is active.
 * Two-arm blend: ALPHA_NO_MOOD + BETA_NO_MOOD = 1.0 pre-normalize.
 *
 * Deliberately small: taste should tint the neighborhood around what is
 * currently playing, not co-steer it. At the original 0.5/0.5 blend the
 * taste arm dominated retrieval — measured against the production library,
 * a 1950s mambo seed returned hands-up/dance tracks as its TOP candidates
 * purely because the user's Rocchio taste centroid sits in that region, and
 * the queue-centroid feedback loop then locked the session into the taste
 * genre within ~3 autoplay picks. At 0.2 the same seeds stay in-lane
 * (latin/swing, new-wave/synth-pop) while taste still breaks ties.
 *
 * Runtime-tunable via MUSIC_SONIC_TASTE_WEIGHT (route passes it through as
 * `tasteWeight`); this constant is the fallback default.
 */
export const BETA_NO_MOOD = 0.2;

/**
 * GAMMA — mood vector arm, sourced from mood_vectors WHERE model_id='msclap-2023'.
 *
 * Audio-space mood vectors are generated by generateAudioMoodVectors() in
 * mood-vector.service.ts, which averages media_audio_embeddings (MSCLAP-2023)
 * of tracks matching the mood's genre/mood_tag keywords. They are geometrically
 * compatible with this query's MSCLAP embedding space.
 *
 * Three-arm weights when mood is active: ALPHA(0.4) + BETA(0.25) + GAMMA(0.35) = 1.0.
 * When no mood seed is active: ALPHA_NO_MOOD(0.8) + BETA_NO_MOOD(0.2) = 1.0.
 *
 * Graceful fallback: when the audio mood vector is missing (table not yet populated
 * or fetch error), moodVector = null → ALPHA_NO_MOOD/BETA_NO_MOOD are used instead.
 */
export const GAMMA = 0.35;

/** Per-skip demotion applied in JS post-filter (flat per skipped track). */
export const SKIP_DEMOTION_PER_SKIP = 0.02;

/**
 * Maximum cumulative skip demotion. Kept for API backwards-compatibility.
 * Note: because skippedTrackIds is a membership Set (no per-track counts),
 * the actual demotion is always exactly SKIP_DEMOTION_PER_SKIP per track —
 * one flat unit. This constant documents the intended cap if per-track counts
 * are added in future.
 */
export const MAX_SKIP_DEMOTION = 0.2;

// ---------------------------------------------------------------------------
// Score-level constants (used by the route's scoreSonicCandidates function)
// ---------------------------------------------------------------------------

/** Additive boost weight for genre overlap (fraction of current genres present in candidate). */
export const SONIC_GENRE_OVERLAP_BOOST = 0.12;

// ---------------------------------------------------------------------------
// Manual-intent weighting
// ---------------------------------------------------------------------------

/**
 * Centroid decay when the now-playing track was explicitly user-picked
 * (`intent=manual`), replacing the default 0.5.
 *
 * With the default decay the current track holds only ~52% of the centroid —
 * fine when autoplay picked it (weak evidence), but wrong for a manual pick:
 * choosing a track is the strongest intent signal the queue ever receives,
 * yet the previous session kept ~half the vote and could drag suggestions
 * back into its own lane (picked French electro-pop, got hands-up from the
 * prior session's centroid mass). At 0.15 the current track holds ~85% of a
 * full 5-track centroid; history still tints, it no longer co-steers.
 *
 * Self-limiting by construction: the boost applies only while the picked
 * track is index 0. Once autoplay continuations follow it, the pick slides
 * down the decay ladder and normal blending resumes.
 */
export const MANUAL_INTENT_CENTROID_DECAY = 0.15;

/**
 * Multiplier applied to the taste-arm weight when intent is manual. Taste is
 * the second force that pulls a manual pick back toward the library's
 * dominant genre; halving it (not zeroing — taste should still break ties)
 * keeps the picked track's own sound in charge of the refill.
 */
export const MANUAL_INTENT_TASTE_MULTIPLIER = 0.5;

/**
 * Floor weight held by the session's origin track in the queue centroid,
 * regardless of how many hops ago it played.
 *
 * The centroid is a 5-item sliding window with geometric decay, so the track
 * that started the session leaves it entirely after five autoplay hops and
 * the query vector becomes a pure function of the last five picks. In a dense
 * region of the library that is harmless — the neighbours are all in-lane. In
 * a SPARSE region it is not: with nothing close by, each hop lands slightly
 * off-lane, that pick enters the window, and the drift compounds until the
 * session has walked into the library's dominant genre and cannot get back
 * (observed: an indie-pop seed reaching hands-up in 7 hops via Latin pop and
 * house; a German-rap seed reaching US R&B in 3).
 *
 * The fix is a floor, not a rank: the origin keeps ~15% of a full auto-decay
 * centroid (Σ decayed weights ≈ 1.94) — enough to stop an unbounded walk,
 * far too little to pin the session to its first track. Deliberately below
 * the index-1 positional weight (0.5) so recent plays still lead.
 */
export const SESSION_ANCHOR_FLOOR_WEIGHT = 0.3;

/** How the now-playing track started, as reported by the client. */
export type NowPlayingIntent = 'manual' | 'auto';

/** Map the client-reported intent onto a centroid decay factor. */
export function centroidDecayForIntent(intent: NowPlayingIntent | undefined): number {
    return intent === 'manual' ? MANUAL_INTENT_CENTROID_DECAY : 0.5;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** MSCLAP model — must match every INSERT/WHERE in the pipeline. */
const MODEL_ID = MSCLAP_MODEL_ID;

/**
 * Recency-decay weight for the i-th most-recent queue item.
 * Index 0 = current track (weight 1.0), each subsequent item multiplies by
 * `decay` (0.5 default; MANUAL_INTENT_CENTROID_DECAY for a manual pick).
 * We use 5 items maximum (current + 4 recent).
 */
function queueDecayWeight(index: number, decay: number): number {
    return Math.pow(decay, index);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A row returned by {@link getSonicQueueCandidates}. Shape matches QueueCandidateRow. */
export interface SonicQueueCandidateRow {
    id: string;
    title: string;
    runtime_seconds: number | null;
    custom_metadata: Record<string, unknown>;
    custom_poster_url: string | null;
    parent_id: string | null;
    similarity_score: number;
    resolved_artist: string | null;
    /**
     * UUID of the resolved artist media_item (album→artist hierarchy), or null
     * for orphan tracks and for compilations (where the hierarchy parent is the
     * Various Artists marker, not a real performer).
     */
    resolved_artist_id: string | null;
    /**
     * Per-track artists in tag order, so a multi-artist line can be rendered as
     * separate links. Null when the track's artist is just the album artist.
     */
    track_artists?: Array<{ id: string | null; title: string }> | null;
    remixer_artists?: Array<{ id: string | null; title: string }> | null;
    /**
     * Raw MSCLAP embedding for this candidate row.
     * Returned so the route can run MMR (candidate-vs-candidate diversity)
     * using the same embedding space as the retrieval query — no extra fetch.
     * Parsed from pgvector text format on arrival; null when unavailable.
     */
    embedding: number[] | null;
    /**
     * Genre tags from custom_metadata.genre (JSON array), lowercased.
     * Used by the route's genre-overlap boost calculation.
     * Null/empty when the track has no genre metadata.
     */
    genres: string[] | null;
}

// ---------------------------------------------------------------------------
// Access boundary contract (read before touching any query text here)
// ---------------------------------------------------------------------------
//
// {@link getSonicQueueCandidates} takes a REQUIRED {@link MediaAccessBoundary}
// on {@link SonicQueueParams.access}. There is no permissive default: a caller
// that wants unfiltered rows must say so with `unrestrictedAccess()`, which
// makes the decision greppable. The previous `SonicQueueAccessCtx` was a
// `Pick<SearchAccessContext, 'deniedGroupIds' | 'ageRating'>`, i.e. a structural
// derivation of the permissive pair — deliberately deleted rather than retyped,
// because a structural alias keeps compiling against the old shape and hides the
// fact that the boundary never moved.
//
// ALIAS CONTRACT. `buildLibraryAccessFilter` hardcodes `mi.id` in its correlated
// subqueries and takes NO alias parameter; `buildAgeRatingFilter` defaults its
// alias to `mi` and is spliced here without an override. The `candidates` CTE
// must therefore keep aliasing the CANDIDATE TRACK's media_items row as `mi`.
// Both builders emit an EMPTY fragment under an unrestricted boundary, so an
// alias mistake fails only for restricted callers — which is why the tests run
// the same fixture through both a restricted and an unrestricted boundary.
//
// PREDICATE GRAIN — the boundary constrains the TRACK ROW ONLY, never its
// album/artist ancestors. The same CTE LEFT JOINs media_items twice more, as
// `album` and `artist`; the final SELECT joins `artist` again by id and the
// credit fragments join it as `credited`/`va_credit`/`ta`/`remixer`. Those
// aliases are NOT boundary-filtered: a permitted track whose album row
// sits in a denied group still renders that album's artist name. That is
// pre-existing behaviour. Do NOT "fix" it here — filtering those aliases would
// change which data a restricted user sees, which this migration forbids.
//
// FILTER ORDER. The predicates live in the `candidates` CTE WHERE clause,
// BEFORE `LIMIT ${candidatePoolSize}`. `ranked` selects `c.*` FROM candidates
// and the final SELECT reads FROM ranked, so the filter dominates the output.
// Moving or duplicating the boundary below the pool LIMIT would change which
// rows a restricted user sees.
//
// UNFILTERED CTE (intentional). `played_titles` reads media_items as `mi_pt`
// with no access filter. It is an exclusion set built from the caller's OWN
// queue/session/skip IDs, so it can only REMOVE candidates, never surface
// inaccessible ones. Note `mi_pt` would also break `buildLibraryAccessFilter`'s
// hardcoded `mi`, so do not add a filter there.
//
// DENY-ALL. `getSonicQueueCandidates` short-circuits to `[]` via
// `deniesEverything` before any round trip. Both builders would emit `AND false`
// anyway, but returning early also skips the queue-embedding fetch and the ANN
// scan that could only ever return nothing.
//
// {@link getMoodVector} deliberately carries no boundary: it returns a 1024-dim
// vector for a mood seed the caller already resolved, not media rows.

/** Parameters for {@link getSonicQueueCandidates}. */
export interface SonicQueueParams {
    /** Current track id + recent queue item ids (most-recent first, ≤5). */
    queueTrackIds: string[];
    /** Rocchio taste vector from computeSonicTasteVector (null = cold-start). */
    tasteVector: number[] | null;
    /**
     * Audio-space mood embedding from mood_vectors WHERE model_id='msclap-2023'.
     * Null when no mood seed is active, when the audio row has not been generated
     * yet, or when the fetch failed (graceful degradation to ALPHA_NO_MOOD/BETA_NO_MOOD).
     */
    moodVector: number[] | null;
    /** Track IDs to hard-exclude from results. */
    excludeIds: string[];
    /** Track IDs that are skip-dominant (soft demotion). */
    skippedTrackIds?: string[];
    /** Maximum number of candidates to return (before JS picks). */
    limit: number;
    /**
     * REQUIRED library-group and age-rating access boundary. Use
     * `searchAccessBoundary(ctx)` for a real user, or `unrestrictedAccess()`
     * to opt out explicitly. See the access boundary contract above.
     */
    access: MediaAccessBoundary;
    /**
     * Deduped list of track IDs whose titles should be used for remix/variant
     * exclusion (current + session + skipped IDs). Normalized via three-pass
     * regex → pg_trgm similarity > 0.6 against candidates. Same set the
     * metadata path uses for its played_titles CTE.
     */
    titleMatchIds?: string[];
    /**
     * Normalised title stems from the user's persistent play history,
     * as returned by getRecentlyPlayedVariants. Candidates whose normalised
     * title fuzzy-matches any stem are excluded — enforces the cross-session
     * cooldown on the sonic path (was metadata-path-only before).
     */
    persistentPlayedTitles?: string[];
    /**
     * Weight of the taste-vector arm in the no-mood two-arm blend
     * (centroid arm gets 1 − tasteWeight). Defaults to BETA_NO_MOOD.
     * The route shrinks this during a cohesive same-genre listening streak
     * so "what I'm in the mood for right now" outranks "what I like overall".
     * Ignored when a mood seed is active (three-arm ALPHA/BETA/GAMMA blend).
     */
    tasteWeight?: number;
    /**
     * How the now-playing track started. 'manual' (explicit user pick)
     * steepens the centroid decay to MANUAL_INTENT_CENTROID_DECAY so the
     * picked track dominates retrieval (~85% of the centroid) instead of
     * splitting the vote with session history. Absent/'auto' keeps the
     * default 0.5 decay.
     */
    intent?: NowPlayingIntent;
    /**
     * The session's origin track (oldest known play), pinned into the centroid
     * at SESSION_ANCHOR_FLOOR_WEIGHT so it cannot decay out of the sliding
     * window. Omit for a cold session — with no history there is nothing to
     * anchor to and the current track already IS the origin.
     */
    anchorTrackId?: string;
    /**
     * Weight of the ARTIST-popularity re-rank, 0..1. 0 (default) = feature off,
     * factor is always 1. See the factor SQL in getSonicQueueCandidates.
     */
    popularityWeight?: number;
    /** Power curve on the normalized score. 0.5 = gentle (sqrt). */
    popularityExponent?: number;
    /** Floor under the scaled score, so a deep cut is demoted, never excluded. */
    popularityFloor?: number;
    /** Popularity provider whose rows to read, e.g. 'lastfm'. */
    popularityPrimarySource?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fetch MSCLAP embeddings for a set of track IDs, keyed by media_id.
 * Tracks without an embedding row are silently omitted.
 */
async function fetchQueueEmbeddings(
    sql: postgres.Sql,
    trackIds: string[],
): Promise<Map<string, number[]>> {
    if (trackIds.length === 0) return new Map();

    const rows = await sql<Array<{ media_id: string; embedding: string }>>`
        SELECT mae.media_id::text, mae.embedding::text
        FROM media_audio_embeddings mae
        WHERE mae.media_id = ANY(${trackIds}::uuid[])
          AND mae.model_id = ${MODEL_ID}
    `;

    const result = new Map<string, number[]>();
    for (const row of rows) {
        const embedding = parseEmbedding(row.embedding);
        if (embedding) result.set(row.media_id, embedding);
    }
    return result;
}

/**
 * Compute the queue-context centroid: a recency-weighted average of the
 * current track (weight 1.0) and up to 4 recent queue tracks (decaying).
 *
 * Returns null when no embeddings are found (no MSCLAP data in library yet).
 */
export function computeQueueCentroid(
    queueTrackIds: string[],
    embeddingMap: Map<string, number[]>,
    decay: number = 0.5,
    anchorTrackId?: string,
): number[] | null {
    const weightedEmbeddings: Array<{ embedding: number[]; weight: number }> = [];
    let anchorSeen = false;

    for (let i = 0; i < queueTrackIds.length; i++) {
        const id = queueTrackIds[i];
        const emb = embeddingMap.get(id);
        if (emb) {
            const positional = queueDecayWeight(i, decay);
            // The anchor may still be inside the window (early in a session, or
            // when it IS the current track). Take the greater of the two rather
            // than pushing a second entry: double-counting one track would give
            // the origin up to 1 + floor of the mass and pin the session to it.
            const isAnchor = anchorTrackId !== undefined && id === anchorTrackId;
            if (isAnchor) anchorSeen = true;
            weightedEmbeddings.push({
                embedding: emb,
                weight: isAnchor ? Math.max(positional, SESSION_ANCHOR_FLOOR_WEIGHT) : positional,
            });
        }
    }

    // Anchor has already decayed out of the window — re-add it at the floor.
    if (anchorTrackId !== undefined && !anchorSeen) {
        const anchorEmb = embeddingMap.get(anchorTrackId);
        if (anchorEmb) {
            weightedEmbeddings.push({
                embedding: anchorEmb,
                weight: SESSION_ANCHOR_FLOOR_WEIGHT,
            });
        }
    }

    if (weightedEmbeddings.length === 0) return null;
    return computeWeightedCentroid(weightedEmbeddings);
}

/**
 * Build a blended query vector from the available retrieval arms.
 *
 * When a moodVector is supplied (GAMMA arm active), weights are
 *   ALPHA(0.4) × centroid + BETA(0.25) × taste + GAMMA(0.35) × mood = 1.0 pre-norm.
 * When moodVector is null (two-arm blend), weights are
 *   (1 − tasteWeight) × centroid + tasteWeight × taste = 1.0 pre-norm,
 * where tasteWeight defaults to BETA_NO_MOOD and can be overridden per
 * request (the route shrinks it during a cohesive same-genre streak).
 *
 * Normalizes the result so pgvector cosine distance is meaningful.
 * Returns null when all arms are null (complete cold start → caller falls back).
 */
export function buildBlendedVector(
    queueCentroid: number[] | null,
    tasteVector: number[] | null,
    moodVector: number[] | null,
    tasteWeight: number = BETA_NO_MOOD,
): number[] | null {
    const hasCentroid = queueCentroid !== null && queueCentroid.length > 0;
    const hasTaste = tasteVector !== null && tasteVector.length > 0;
    const hasMood = moodVector !== null && moodVector.length > 0;

    // Need at least one arm to build a query vector
    if (!hasCentroid && !hasTaste && !hasMood) return null;

    // Choose weight set: mood-active (3-arm) vs mood-inactive (2-arm).
    // Clamped so a bad override can never flip the blend past all-taste.
    const betaNoMood = Math.min(Math.max(tasteWeight, 0), 1);
    const alpha = hasMood ? ALPHA : 1 - betaNoMood;
    const beta = hasMood ? BETA : betaNoMood;
    const gamma = hasMood ? GAMMA : 0.0;

    // Use the dimension from the first present arm
    const dim = (queueCentroid ?? tasteVector ?? moodVector)!.length;
    const blended = new Array<number>(dim).fill(0);

    if (hasCentroid && queueCentroid !== null) {
        const vec = normalizeVector(queueCentroid);
        for (let d = 0; d < dim; d++) {
            blended[d] += alpha * vec[d];
        }
    }
    if (hasTaste && tasteVector !== null) {
        const vec = normalizeVector(tasteVector);
        for (let d = 0; d < dim; d++) {
            blended[d] += beta * vec[d];
        }
    }
    if (hasMood && moodVector !== null) {
        const vec = normalizeVector(moodVector);
        for (let d = 0; d < dim; d++) {
            blended[d] += gamma * vec[d];
        }
    }

    const normalized = normalizeVector(blended);

    // Guard: collapsed to zero (e.g. centroid and taste cancel perfectly)
    const mag = Math.sqrt(normalized.reduce((s, v) => s + v * v, 0));
    if (mag < 1e-9) return null;

    return normalized;
}

/**
 * Apply a flat score penalty to tracks the user skipped this session.
 * The input is a membership Set (not per-track skip counts), so the demotion
 * is a flat SKIP_DEMOTION_PER_SKIP per track. Skip-DOMINANT tracks
 * (high skip_count/play_count) are excluded upstream in the candidate query;
 * this is only a soft nudge for tracks skipped in the current session.
 */
export function applySkipDemotion(
    candidates: SonicQueueCandidateRow[],
    skippedTrackIds: Set<string>,
): SonicQueueCandidateRow[] {
    return candidates.map((c) => {
        if (!skippedTrackIds.has(c.id)) return c;
        // Flat demotion per skipped track — no Math.min needed since Set has
        // no per-track counts. MAX_SKIP_DEMOTION documents the cap intent if
        // per-track counts are added later.
        const demotion = SKIP_DEMOTION_PER_SKIP;
        return { ...c, similarity_score: Math.max(0, c.similarity_score - demotion) };
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch sonic smart queue candidates via a blended kNN query over MSCLAP.
 *
 * Steps:
 *   1. Fetch MSCLAP embeddings for the current queue track IDs.
 *   2. Compute the queue-context centroid (recency-weighted average).
 *   3. Build the blended query vector: ALPHA/BETA/GAMMA (mood active) or ALPHA_NO_MOOD/BETA_NO_MOOD (no mood).
 *   4. Run kNN via `<=>` (cosine distance) on `media_audio_embeddings`.
 *   5. Apply library-group / age-rating access filters inline via SQL.
 *   6. Apply remix/variant exclusion (played_titles CTE + pg_trgm NOT EXISTS).
 *   7. Return rows ordered by ascending cosine distance (highest similarity first),
 *      including the raw MSCLAP embedding and genre tags for route-level re-ranking.
 *
 * Returns an empty array (not null) when:
 *   - `params.access` denies everything (short-circuits before any round trip).
 *   - The blended vector is null (all arms null → caller falls back).
 *   - No candidates match the access filters.
 *
 * @param sql        - postgres.Sql instance (parameterized — no sql.unsafe).
 * @param params     - {@link SonicQueueParams}
 */
export async function getSonicQueueCandidates(
    sql: postgres.Sql,
    params: SonicQueueParams,
): Promise<SonicQueueCandidateRow[]> {
    const {
        queueTrackIds,
        tasteVector,
        moodVector,
        excludeIds,
        skippedTrackIds = [],
        limit,
        access,
        titleMatchIds = [],
        persistentPlayedTitles = [],
        tasteWeight = BETA_NO_MOOD,
        intent,
        anchorTrackId,
        popularityWeight = 0,
        popularityExponent = 0.5,
        popularityFloor = 0.1,
        popularityPrimarySource = 'lastfm',
    } = params;

    // Short-circuit before any round trip — see the DENY-ALL note in the access
    // boundary contract at the top of this module.
    if (deniesEverything(access)) return [];

    // Step 1 + 2: queue centroid from MSCLAP embeddings
    const centroidIds = queueTrackIds.slice(0, 5);
    // The anchor sits outside the 5-item window once it has decayed out, so it
    // must be fetched explicitly or computeQueueCentroid finds no embedding for
    // it and the floor silently never applies.
    const embeddingFetchIds =
        anchorTrackId !== undefined && !centroidIds.includes(anchorTrackId)
            ? [...centroidIds, anchorTrackId]
            : centroidIds;
    const embeddingMap = await fetchQueueEmbeddings(sql, embeddingFetchIds);
    const queueCentroid = computeQueueCentroid(
        centroidIds,
        embeddingMap,
        centroidDecayForIntent(intent),
        anchorTrackId,
    );

    // Step 3: blended query vector (ALPHA/BETA/GAMMA when mood active; centroid/taste otherwise)
    const blendedVector = buildBlendedVector(queueCentroid, tasteVector, moodVector, tasteWeight);
    if (!blendedVector) {
        // All arms null → cold start; signal fallback to caller
        return [];
    }

    // Serialize as pgvector literal
    const vectorLiteral = `[${blendedVector.map((n) => n.toFixed(8)).join(',')}]`;

    // Over-fetch to allow post-filtering by access + skip demotion + MMR
    const fetchLimit = Math.min(limit * 3, 200);

    // Build exclude array (deduped)
    const excludeSet = new Set(excludeIds);
    const excludeArray = [...excludeSet];

    // Deduplicate title match IDs (same set the metadata path uses)
    const titleIds = Array.from(new Set(titleMatchIds));
    const hasTitleFilter = titleIds.length > 0 || persistentPlayedTitles.length > 0;

    // Internal row shape from the SQL — embedding arrives as text
    type RawSonicRow = Omit<SonicQueueCandidateRow, 'embedding' | 'genres'> & {
        embedding_text: string | null;
        genres_raw: string | null;
    };

    // Overfetch the kNN pool beyond fetchLimit so the title_rank dedup below
    // (which can drop version-tagged siblings) still leaves a full fetchLimit
    // worth of candidates for the route's post-filtering/MMR pass. Capped
    // the same way fetchLimit is.
    const candidatePoolSize = Math.min(fetchLimit * 2, 400);

    // Step 4: kNN query with dedup
    const rows = await sql<RawSonicRow[]>`
        WITH
        ${
            hasTitleFilter
                ? sql`played_titles AS (
            SELECT DISTINCT
                lower(regexp_replace(
                    regexp_replace(
                        regexp_replace(mi_pt.title, ${REMIX_TAG_REGEX}, '', 'gi'),
                        ${DASH_REMIX_SUFFIX_REGEX}, '', 'gi'
                    ),
                    ${BARE_REMIX_SUFFIX_REGEX}, '', 'gi'
                )) AS norm_title
            FROM media_items mi_pt
            WHERE mi_pt.id = ANY(${titleIds}::uuid[])
            UNION
            SELECT DISTINCT unnest(${persistentPlayedTitles}::text[]) AS norm_title
        ),`
                : sql``
        }
        candidates AS (
            SELECT
                mi.id::text                                                             AS id,
                mi.title,
                mi.runtime_seconds,
                COALESCE(mi.custom_metadata, '{}'::jsonb)                              AS custom_metadata,
                mi.custom_poster_url,
                mi.parent_id::text                                                      AS parent_id,
                -- Similarity, scaled by an ARTIST-popularity factor.
                --
                -- Artist-level ('artist_global'), NOT the metadata path's
                -- track-first tri-state: on this library artist_global covers
                -- 2650/2650 artists while track_in_artist covers only
                -- 13472/23842 tracks, so a track-first formula would demote 43%
                -- of the library for MISSING DATA rather than for being
                -- unpopular. Artist notability is also the axis on which this
                -- queue actually differs from commercial services.
                --
                -- NO DATA IS NEUTRAL, never the floor. 149 of 2650 artist rows
                -- carry normalized_score = 0 with NULL raw_listeners — a
                -- Last.fm lookup that never matched, not an unpopular artist.
                -- ItaloBrothers is one of them, and it is an act BOTH YouTube
                -- Music and Apple Music recommend for these seeds; flooring it
                -- would demote exactly what this term exists to promote.
                --
                -- PURE DEMOTION by construction. The factor maxes out at 1.0
                -- (a top-scoring artist and a no-data artist both get 1.0), so
                -- nothing is ever ranked ABOVE where it stands today — the term
                -- only pushes down artists we have positive evidence are
                -- obscure. Measured at weight 0.3: Captain Jack (294k
                -- listeners) 0.971 vs Vince Tayler (153 listeners) 0.871.
                --
                -- The CTE's ORDER BY stays the raw vector distance, so this
                -- re-ranks the retrieved pool without changing which rows get
                -- retrieved.
                (
                    (1 - (mae.embedding <=> ${vectorLiteral}::vector))::double precision
                    * (
                        (1 - ${popularityWeight}::float8)
                        + ${popularityWeight}::float8 * COALESCE(
                            CASE
                                WHEN apop.raw_listeners IS NULL OR apop.raw_listeners = 0
                                    THEN 1.0::float8
                                ELSE GREATEST(
                                    POWER(apop.normalized_score, ${popularityExponent}::float8),
                                    ${popularityFloor}::float8
                                )
                            END,
                            1.0::float8
                        )
                    )
                )                                                                       AS similarity_score,
                -- Artist credits are resolved in the final SELECT, for the page only.
                artist.id                                                               AS album_artist_id,
                mae.embedding::text                                                     AS embedding_text,
                CASE
                    WHEN jsonb_typeof(mi.custom_metadata->'genre') = 'array'
                    THEN (
                        SELECT array_agg(LOWER(g))
                        FROM jsonb_array_elements_text(mi.custom_metadata->'genre') AS g
                    )
                    ELSE NULL
                END                                                                     AS genres_raw
            FROM media_audio_embeddings mae
            JOIN media_items mi
                   ON mi.id = mae.media_id
                  AND mi.media_type = 'track'
                  AND mi.has_files = true
                  AND mi.status = 'active'
            LEFT JOIN media_items album
                   ON album.id = mi.parent_id
                  AND album.media_type = 'album'
            LEFT JOIN media_items artist
                   ON artist.id = album.parent_id
                  AND artist.media_type = 'artist'
            LEFT JOIN media_popularity apop
                   ON apop.media_id = artist.id
                  AND apop.source = ${popularityPrimarySource}
                  AND apop.score_context = 'artist_global'
            WHERE mae.model_id = ${MODEL_ID}
              ${excludeArray.length > 0 ? sql`AND mi.id != ALL(${excludeArray}::uuid[])` : sql``}
              ${buildLibraryAccessFilter(sql, access.library)}
              ${buildAgeRatingFilter(sql, access.age)}
              ${
                  hasTitleFilter
                      ? sql`
              AND NOT EXISTS (
                  SELECT 1 FROM played_titles pt
                  WHERE similarity(
                      lower(regexp_replace(
                          regexp_replace(
                              regexp_replace(mi.title, ${REMIX_TAG_REGEX}, '', 'gi'),
                              ${DASH_REMIX_SUFFIX_REGEX}, '', 'gi'
                          ),
                          ${BARE_REMIX_SUFFIX_REGEX}, '', 'gi'
                      )),
                      pt.norm_title
                  ) > 0.6
              )`
                      : sql``
              }
            ORDER BY mae.embedding <=> ${vectorLiteral}::vector ASC
            LIMIT ${candidatePoolSize}
        ),
        ranked AS (
            -- Collapse remix/edit/live variants down to one per normalized
            -- title, preferring the untagged (original) title — featuring
            -- credits are stripped first so "(feat. X)" never counts as a
            -- version tag. Mirrors the metadata-path preference in
            -- music-recommendations.queries.ts / music.queries.ts.
            -- COALESCE guards NULL titles: a NULL ~* pattern match is NULL
            -- (falsy in the CASE), which would otherwise rank a NULL-titled
            -- row as "preferred original".
            SELECT
                c.*,
                ROW_NUMBER() OVER (
                    PARTITION BY lower(regexp_replace(
                        regexp_replace(
                            regexp_replace(COALESCE(c.title, ''), ${REMIX_TAG_REGEX}, '', 'gi'),
                            ${DASH_REMIX_SUFFIX_REGEX}, '', 'gi'
                        ),
                        ${BARE_REMIX_SUFFIX_REGEX}, '', 'gi'
                    ))
                    ORDER BY
                        CASE
                            WHEN regexp_replace(
                                regexp_replace(COALESCE(c.title, ''), ${FEAT_TAG_REGEX}, '', 'gi'),
                                ${FEAT_DASH_SUFFIX_REGEX}, '', 'gi'
                            ) ~* ${VERSION_ONLY_SQL_PATTERN}
                                THEN 1
                            ELSE 0
                        END ASC,
                        c.similarity_score DESC
                ) AS title_rank
            FROM candidates c
        )
        SELECT
            mi.id, mi.title, mi.runtime_seconds, mi.custom_metadata, mi.custom_poster_url, mi.parent_id,
            mi.similarity_score,
            COALESCE(
                ${trackDisplayArtistSql(sql, 'mi', trackCreditArtistsSql(sql))},
                'Unknown Artist'
            )                                                                           AS resolved_artist,
            CASE WHEN jsonb_typeof(NULLIF(mi.custom_metadata->'track_artist_credits', '[]'::jsonb)) = 'array'
                THEN ${trackArtistIdSql(sql, 'mi', trackCreditArtistsSql(sql))}::text ELSE ${nonVariousArtistIdSql(sql)} END AS resolved_artist_id,
            ${trackArtistsSql(sql, 'mi', trackCreditArtistsSql(sql))}                  AS track_artists,
            ${trackRemixerArtistsSql(sql, 'mi')}                                        AS remixer_artists,
            mi.embedding_text, mi.genres_raw
        FROM (
            SELECT *
            FROM ranked
            WHERE title_rank = 1
            ORDER BY similarity_score DESC
            LIMIT ${fetchLimit}
        ) AS mi
        LEFT JOIN media_items artist ON artist.id = mi.album_artist_id
        ${canonicalTrackArtistsJoinSql(sql, 'mi')}
        ORDER BY mi.similarity_score DESC
    `;

    // Parse the text-format embedding + genres for each row
    const parsed: SonicQueueCandidateRow[] = rows.map((r) => ({
        id: r.id,
        title: r.title,
        runtime_seconds: r.runtime_seconds,
        custom_metadata: r.custom_metadata,
        custom_poster_url: r.custom_poster_url,
        parent_id: r.parent_id,
        similarity_score: r.similarity_score,
        resolved_artist: r.resolved_artist,
        resolved_artist_id: r.resolved_artist_id,
        track_artists: r.track_artists,
        remixer_artists: r.remixer_artists,
        embedding: r.embedding_text ? parseEmbedding(r.embedding_text) : null,
        genres: r.genres_raw as unknown as string[] | null,
    }));

    // Step 7: apply skip demotion, then re-sort + cap
    const skippedSet = new Set(skippedTrackIds);
    const demoted = applySkipDemotion(parsed, skippedSet);
    demoted.sort((a, b) => b.similarity_score - a.similarity_score);

    return demoted.slice(0, limit);
}

/**
 * Fetch the audio-space mood vector for a given mood key from the `mood_vectors`
 * table (model_id = 'msclap-2023' by default).
 *
 * Returns null when no matching row exists (e.g. generateAudioMoodVectors has
 * not been run yet, or the mood has no MSCLAP-covered seed tracks). The caller
 * should treat null as "no mood arm" and fall back to the two-arm blend.
 *
 * @param sql      - postgres.Sql instance.
 * @param moodKey  - The mood identifier (e.g. "music:chill").
 * @param modelId  - Embedding model discriminator; defaults to MSCLAP_MODEL_ID.
 */
export async function getMoodVector(
    sql: postgres.Sql,
    moodKey: string,
    modelId: string = MODEL_ID,
): Promise<number[] | null> {
    const rows = await sql<Array<{ vector: string }>>`
        SELECT vector::text
        FROM mood_vectors
        WHERE mood_key = ${moodKey}
          AND model_id = ${modelId}
        LIMIT 1
    `;

    if (rows.length === 0 || !rows[0].vector) return null;
    return parseEmbedding(rows[0].vector);
}

/**
 * The `mood_vectors.mood_key` for a bare API mood key (`chill` → `music:chill`).
 *
 * Music rows are written with the `music:` namespace (generateMusicMoodVectors
 * via MUSIC_MOOD_SEEDS) while every API surface — `music/moods`, the mood
 * sections, the queue's `{"type":"mood"}` seed — speaks the bare key. A lookup
 * with the bare key finds no row and reads as "no mood vector", silently.
 */
export function musicMoodVectorKey(mood: string): string {
    return `music:${mood}`;
}

/**
 * List the mood keys that actually have a usable vector on THIS install.
 *
 * Which moods work is per-install: `mood_vectors` is populated by the
 * `mood-vector-generation` task against the local library, so a key in the
 * seed list may simply have no row here. Mood lookups return empty rather
 * than erroring for a missing key, so without this a client cannot tell an
 * unavailable mood from one that merely matched nothing — it would render a
 * chip that is silently always empty.
 *
 * Defaults to MSCLAP_MODEL_ID because mood matching happens in audio space
 * with no text-space fallback; a `text`-only row is not usable for it.
 *
 * @returns Namespaced keys as stored (e.g. `music:chill`).
 */
export async function listMoodKeysWithVectors(
    sql: postgres.Sql,
    modelId: string = MODEL_ID,
): Promise<string[]> {
    const rows = await sql<Array<{ mood_key: string }>>`
        SELECT mood_key
        FROM mood_vectors
        WHERE model_id = ${modelId}
        ORDER BY mood_key
    `;
    return rows.map((r) => r.mood_key);
}
