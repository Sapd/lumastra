// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music Alchemy Query Module
 *
 * Brew endpoint candidate pool + ranking — two modes:
 *
 * SONIC MODE (preferred): when all seeds have MSCLAP embeddings in
 * `media_audio_embeddings`, the candidate pool is ranked by cosine similarity
 * to the seed-embedding centroid (average of seed embeddings). Knobs
 * (energy/tempo/obscurity) still apply on top as a secondary sort via
 * `blendSonicWithKnobs`.
 *
 * SCALAR MODE (fallback): scalar-matching on JSONB acoustic fields
 * (bpm, energy, danceability, mood_tags) when embeddings are absent.
 *
 * All functions take sql: postgres.Sql as first param, no side effects.
 *
 * Scalar ranking weights (sum to 1):
 *   - BPM closeness (ratio distance capped at 1)
 *   - Energy closeness (absolute distance, capped at 1)
 *   - Danceability closeness (absolute distance, capped at 1)
 *   - Mood-tag Jaccard overlap (fraction of seed moods matched)
 *   - Popularity/play-count factor scaled by obscurity dial
 *
 * Candidate pool is capped at POOL_CAP rows before ranking so the query is
 * always O(pool_cap) rather than O(full library).
 *
 * @module queries/music-alchemy
 */

import type postgres from 'postgres';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { MSCLAP_MODEL_ID } from './sonic-constants.js';
import { parseEmbedding } from '$lib/server/utils/embedding-utils.js';

// =============================================================================
// Constants
// =============================================================================

/** Model identifier used for sonic embeddings — must match every INSERT/WHERE. */
const SONIC_MODEL_ID = MSCLAP_MODEL_ID;

// ---------------------------------------------------------------------------
// Access boundary contract (read before touching any query text here)
// ---------------------------------------------------------------------------
//
// Every access-filtered query in this module takes a REQUIRED
// {@link MediaAccessBoundary}. There is no permissive default: a caller that
// wants unfiltered rows must say so with `unrestrictedAccess()`, which makes
// the decision greppable.
//
// ALIAS CONTRACT. `buildLibraryAccessFilter` hardcodes `mi.id` in both of its
// correlated subqueries and `buildAgeRatingFilter` defaults its alias to `mi`.
// No splice site below passes an alias override, so every surrounding query
// MUST alias the candidate `media_items` row as `mi`. Aliasing it anything else
// throws "missing FROM-clause entry for table mi" — but ONLY for restricted
// callers, because both builders emit an empty fragment under an unrestricted
// boundary. `getBrewCandidatesBySonic` and `getBrewSeedEmbeddings` drive FROM
// `media_audio_embeddings` and reach `mi` via JOIN; the correlated EXISTS
// subqueries still resolve correctly from there.
//
// DENY-ALL. Each query short-circuits to `[]` via `deniesEverything` before
// issuing SQL. Both builders would emit `AND false`, which is equally correct,
// but returning early skips a guaranteed-empty round trip — and matters more
// here because `getBrewCandidates` builds a TABLESAMPLE scan and
// `getBrewCandidatesBySonic` an HNSW ordering before the predicate applies.
//
// DEAD BRANCH. `buildLibraryAccessFilter`'s "no file rows at all" branch admits
// file-less Jellyfin-only items. Every candidate query here already requires
// `mi.has_files = true`, so that branch is unreachable in this module. Do NOT
// "simplify" it away in the builder — it is live for other callers.

// =============================================================================
// Types
// =============================================================================

/**
 * Attestation that a caller-supplied ID list was ALREADY narrowed by a
 * {@link MediaAccessBoundary}, so the receiving query need not re-apply one.
 *
 * This is deliberately NOT a variant of `MediaAccessBoundary`: it does not
 * describe what a user may see, it records that the filtering already happened
 * somewhere else. Keeping it a separate, named type means "this query is
 * intentionally unscoped" is a grep away (`PreFilteredCandidates`) instead of
 * being a prose invariant a refactor can silently invalidate.
 *
 * `reason` is free text naming the scoped source, so a reviewer can verify the
 * claim without re-deriving the call graph.
 */
export interface PreFilteredCandidates {
    kind: 'preFiltered';
    /** Where the already-scoped IDs came from, e.g. the producing function. */
    reason: string;
}

/**
 * A single row from `media_audio_embeddings` for seed embedding lookup.
 * The `embedding` is returned as a Postgres `vector` string, e.g. "[0.1,0.2,...]".
 */
export interface SeedEmbeddingRow {
    media_id: string;
    /** Raw pgvector string representation, e.g. "[0.123,...]". */
    embedding_text: string;
}

/** A scored brew candidate when ranked by sonic cosine similarity. */
export interface SonicScoredBrewCandidate extends BrewCandidateRow {
    /**
     * Cosine similarity to the seed centroid in [0, 1].
     * Derived as `1 - cosine_distance` by pgvector `<=>`.
     */
    sonicScore: number;
    /** Brew score blended from sonicScore + knob adjustments. */
    brewScore: number;
}

/** A single candidate row returned by the brew candidate query. */
export interface BrewCandidateRow {
    id: string;
    title: string;
    custom_metadata: Record<string, unknown>;
    custom_poster_url: string | null;
    /** Parent album id */
    parent_id: string | null;
    /** Duration in seconds — may be null when not set */
    runtime_seconds: number | null;
    /** Raw play_count from user_music_state — 0 when not played */
    play_count: number;
    /** Listener count from popularity JSONB — null when absent */
    popularity_listeners: number | null;
}

/** Seed track acoustic data extracted from the candidate pool. */
export interface BrewSeedAcoustics {
    /** Average BPM across seeds that have acoustic data */
    bpm: number | undefined;
    /** Average energy [0–1] across seeds */
    energy: number | undefined;
    /** Average danceability across seeds */
    danceability: number | undefined;
    /** Union of all mood_tags present across seeds */
    moodTags: string[];
}

/** A scored brew candidate — all fields from BrewCandidateRow plus score. */
export interface ScoredBrewCandidate extends BrewCandidateRow {
    /** Brew score in [0, 1] — higher is better fit */
    brewScore: number;
}

// =============================================================================
// Sonic embedding queries
// =============================================================================

/**
 * Fetch MSCLAP embeddings for the given seed track IDs.
 *
 * Returns only rows where an embedding exists — if a seed has no embedding,
 * it is simply absent from the result set. The caller must check whether
 * ALL seeds are covered before switching to sonic mode.
 *
 * The embedding is returned as a raw Postgres vector text so the application
 * layer can parse it into a number[] for centroid computation.
 *
 * SEED SCOPING. Seed IDs are caller-supplied, so an unscoped lookup here lets a
 * user steer the centroid with tracks outside their library/age scope, and the
 * returned row COUNT leaks their existence (the caller branches observably on
 * "all seeds have embeddings"). Returned candidates stay correctly scoped by
 * {@link getBrewCandidatesBySonic}, so this is an inference oracle rather than
 * direct data leakage — but it is a real gap, which is why the boundary is
 * required here rather than assumed.
 *
 * The `media_items` JOIN is row-preserving under an unrestricted boundary:
 * `media_audio_embeddings.media_id` is a FK to `media_items(id)` with
 * ON DELETE CASCADE, so an embedding row can never outlive its media row. It
 * deliberately adds NO predicates of its own (no `media_type`/`has_files`
 * filter) — only the boundary constrains it — so an unrestricted caller sees
 * exactly the rows it saw before.
 *
 * @param access - REQUIRED access boundary. Use `searchAccessBoundary(ctx)` for
 *                 a real user, or `unrestrictedAccess()` to opt out explicitly.
 */
export async function getBrewSeedEmbeddings(
    sql: postgres.Sql,
    seedIds: string[],
    access: MediaAccessBoundary,
): Promise<SeedEmbeddingRow[]> {
    if (seedIds.length === 0) return [];
    if (deniesEverything(access)) return [];

    return sql<SeedEmbeddingRow[]>`
        SELECT
            mae.media_id::text,
            mae.embedding::text AS embedding_text
        FROM media_audio_embeddings mae
        JOIN media_items mi ON mi.id = mae.media_id
        WHERE mae.media_id = ANY(${seedIds}::uuid[])
          AND mae.model_id = ${SONIC_MODEL_ID}
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildAgeRatingFilter(sql, access.age)}
    `;
}

/**
 * Parse a Postgres vector text string ("[0.1,0.2,...]") into a number[].
 * Returns null if the string is malformed or contains non-finite values.
 *
 * Wraps the shared parseEmbedding utility and additionally validates that all
 * parsed values are finite numbers (Number.isFinite check). This extra gate
 * is intentional: it rejects embeddings that contain NaN or ±Infinity, which
 * parseEmbedding itself does not check.
 */
export function parsePgVectorText(text: string): number[] | null {
    const v = parseEmbedding(text);
    if (!v) return null;
    return v.every(Number.isFinite) ? v : null;
}

/**
 * Compute the centroid (element-wise mean) of a list of embedding vectors.
 * All vectors must have the same dimension; returns null if the list is empty
 * or any vector has a different dimension.
 */
export function computeEmbeddingCentroid(vectors: number[][]): number[] | null {
    if (vectors.length === 0) return null;
    const dim = vectors[0].length;
    if (dim === 0) return null;

    const centroid = new Array<number>(dim).fill(0);
    for (const vec of vectors) {
        if (vec.length !== dim) return null; // dimension mismatch — bail out
        for (let i = 0; i < dim; i++) {
            centroid[i] += vec[i];
        }
    }
    const n = vectors.length;
    for (let i = 0; i < dim; i++) {
        centroid[i] /= n;
    }
    return centroid;
}

/**
 * Brew candidate pool ranked by MSCLAP cosine distance to the seed centroid.
 *
 * This query uses the HNSW `<=>` (cosine distance) operator so the pgvector
 * index is exercised. Candidates are filtered by access scope and exclude
 * seedIds and avoidIds. Returns a flat result set with `sonic_score` so the
 * application layer can blend it with knob values.
 *
 * @param centroidLiteral - The centroid vector formatted as a Postgres-compatible
 *   literal string `"[0.1,0.2,...]"` (build from `computeEmbeddingCentroid`).
 * @param opts.access - REQUIRED access boundary. Use `searchAccessBoundary(ctx)`
 *   for a real user, or `unrestrictedAccess()` to opt out explicitly.
 */
export async function getBrewCandidatesBySonic(
    sql: postgres.Sql,
    opts: {
        seedIds: string[];
        avoidIds: string[];
        access: MediaAccessBoundary;
        limit: number;
    },
    centroidLiteral: string,
): Promise<(BrewCandidateRow & { sonic_score: number })[]> {
    const { seedIds, avoidIds, access, limit } = opts;
    if (deniesEverything(access)) return [];

    const excludeIds = Array.from(new Set([...seedIds, ...avoidIds]));

    const excludeFilter: ReturnType<typeof sql> =
        excludeIds.length > 0 ? sql`AND mi.id != ALL(${excludeIds}::uuid[])` : sql``;

    // Use the centroid literal as a parameterized vector cast.
    // The pgvector <=> operator returns cosine distance in [0, 2];
    // 1 - distance gives similarity in [-1, 1], clamped to [0, 1] here.
    return sql<(BrewCandidateRow & { sonic_score: number })[]>`
        SELECT
            mi.id,
            mi.title,
            COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
            mi.custom_poster_url,
            mi.parent_id,
            mi.runtime_seconds,
            COALESCE(ums.play_count, 0)                                         AS play_count,
            (mi.custom_metadata->'popularity'->>'listeners')::bigint             AS popularity_listeners,
            GREATEST(0, 1 - (mae.embedding <=> ${centroidLiteral}::vector))     AS sonic_score
        FROM media_audio_embeddings mae
        JOIN media_items mi
               ON mi.id = mae.media_id
              AND mi.media_type = 'track'
              AND mi.has_files = true
              AND mi.status = 'active'
        LEFT JOIN user_music_state ums ON ums.track_id = mi.id
        WHERE mae.model_id = ${SONIC_MODEL_ID}
          ${excludeFilter}
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildAgeRatingFilter(sql, access.age)}
        ORDER BY mae.embedding <=> ${centroidLiteral}::vector ASC
        LIMIT ${limit * 3}
    `;
}

/**
 * Blend sonic cosine score with obscurity dial into a final brew score.
 *
 * Sonic cosine similarity is the primary signal (weight 0.80); the obscurity
 * factor from the knob is secondary (weight 0.20). Energy/tempo knobs are not
 * re-applied here because the MSCLAP embedding already encodes spectral energy
 * and tempo characteristics — adjusting them post-hoc would overcorrect.
 */
export function blendSonicWithKnobs(
    candidate: BrewCandidateRow & { sonic_score: number },
    knobs: { obscurity: number },
): number {
    const W_SONIC = 0.8;
    const W_POPULAR = 0.2;

    const personalScore = Math.min(
        1,
        candidate.play_count > 0 ? Math.log10(candidate.play_count + 1) / 2 : 0,
    );
    const listeners = candidate.popularity_listeners ?? 0;
    const globalScore =
        listeners > 0 ? Math.min(1, Math.log10(listeners + 1) / Math.log10(1_000_000 + 1)) : 0;
    const rawPopularity = personalScore * 0.4 + globalScore * 0.6;

    const popularityFactor =
        knobs.obscurity <= 0.5
            ? rawPopularity + (0.5 - rawPopularity) * (knobs.obscurity * 2)
            : 0.5 + (1 - rawPopularity - 0.5) * ((knobs.obscurity - 0.5) * 2);

    return candidate.sonic_score * W_SONIC + popularityFactor * W_POPULAR;
}

/**
 * Score and rank a sonic candidate pool, returning the top `limit` entries.
 */
export function rankBrewCandidatesBySonic(
    candidates: (BrewCandidateRow & { sonic_score: number })[],
    knobs: { obscurity: number },
    limit: number,
): SonicScoredBrewCandidate[] {
    const scored: SonicScoredBrewCandidate[] = candidates.map((c) => ({
        ...c,
        // Map snake_case DB column to camelCase interface field
        sonicScore: c.sonic_score,
        brewScore: blendSonicWithKnobs(c, knobs),
    }));
    scored.sort((a, b) => b.brewScore - a.brewScore);
    return scored.slice(0, limit);
}

// =============================================================================
// Candidate pool query (scalar mode)
// =============================================================================

/**
 * Fetch the brew candidate pool: all library tracks that have acoustic data
 * (bpm or energy in custom_metadata.essentia), access-scoped, excluding
 * seedIds and avoidIds. Capped at POOL_CAP rows.
 *
 * The query is intentionally lightweight — ranking happens in application
 * code so we can implement the blended scalar scoring without falling back
 * to sql.unsafe().
 */
const POOL_CAP = 500;

/**
 * @param opts.access - REQUIRED access boundary. Use `searchAccessBoundary(ctx)`
 *   for a real user, or `unrestrictedAccess()` to opt out explicitly.
 */
export async function getBrewCandidates(
    sql: postgres.Sql,
    opts: {
        seedIds: string[];
        avoidIds: string[];
        access: MediaAccessBoundary;
    },
): Promise<BrewCandidateRow[]> {
    const { seedIds, avoidIds, access } = opts;
    if (deniesEverything(access)) return [];

    // Build safe exclusion set — avoidIds is caller-controlled but validated
    // upstream as UUIDs. seedIds are also excluded from candidates.
    const excludeIds = Array.from(new Set([...seedIds, ...avoidIds]));

    const excludeFilter: ReturnType<typeof sql> =
        excludeIds.length > 0 ? sql`AND mi.id != ALL(${excludeIds}::uuid[])` : sql``;

    return sql<BrewCandidateRow[]>`
        SELECT
            mi.id,
            mi.title,
            COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
            mi.custom_poster_url,
            mi.parent_id,
            mi.runtime_seconds,
            COALESCE(ums.play_count, 0) AS play_count,
            (mi.custom_metadata->'popularity'->>'listeners')::bigint AS popularity_listeners
        FROM media_items mi TABLESAMPLE BERNOULLI(20)
        LEFT JOIN user_music_state ums ON ums.track_id = mi.id
        WHERE mi.media_type = 'track'
          AND mi.has_files = true
          AND mi.status = 'active'
          AND (
              mi.custom_metadata->'essentia'->>'bpm' IS NOT NULL
              OR mi.custom_metadata->'essentia'->>'energy' IS NOT NULL
          )
          ${excludeFilter}
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildAgeRatingFilter(sql, access.age)}
        ORDER BY RANDOM()
        LIMIT ${POOL_CAP}
    `;
}

/**
 * Fetch full acoustic data for the seed tracks so we can compute centroid
 * target values (bpm, energy, danceability, mood_tags).
 *
 * Access-scoped identically to getBrewCandidates so a user cannot extract
 * acoustic data for tracks outside their permitted library/age scope.
 *
 * @param access - REQUIRED access boundary. Use `searchAccessBoundary(ctx)` for
 *                 a real user, or `unrestrictedAccess()` to opt out explicitly.
 */
export async function getBrewSeedRows(
    sql: postgres.Sql,
    seedIds: string[],
    access: MediaAccessBoundary,
): Promise<Pick<BrewCandidateRow, 'id' | 'custom_metadata'>[]> {
    if (seedIds.length === 0) return [];
    if (deniesEverything(access)) return [];

    return sql<Pick<BrewCandidateRow, 'id' | 'custom_metadata'>[]>`
        SELECT
            mi.id,
            COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata
        FROM media_items mi
        WHERE mi.id = ANY(${seedIds}::uuid[])
          AND mi.media_type = 'track'
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildAgeRatingFilter(sql, access.age)}
    `;
}

// =============================================================================
// Application-layer scoring (pure functions, no SQL)
// =============================================================================

/**
 * Extract Essentia acoustic sub-object from custom_metadata.
 * Returns an empty object rather than null so callers can destructure safely.
 */
export function extractEssentia(meta: Record<string, unknown>): Record<string, unknown> {
    const ess = meta.essentia;
    return ess && typeof ess === 'object' && !Array.isArray(ess)
        ? (ess as Record<string, unknown>)
        : {};
}

/**
 * Extract numeric BPM from essentia object — handles both number and string.
 */
export function extractBpm(essentia: Record<string, unknown>): number | undefined {
    const raw = essentia.bpm;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string') {
        const n = parseFloat(raw);
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
}

/**
 * Extract numeric value from essentia — same safe coercion as extractBpm.
 */
function extractNum(essentia: Record<string, unknown>, key: string): number | undefined {
    const raw = essentia[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string') {
        const n = parseFloat(raw);
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
}

/**
 * Extract mood_tags array from essentia. Returns [] when absent.
 */
export function extractMoodTags(essentia: Record<string, unknown>): string[] {
    const tags = essentia.mood_tags;
    if (!Array.isArray(tags)) return [];
    return tags.filter((t): t is string => typeof t === 'string');
}

/**
 * Compute the acoustic centroid from a list of seed rows.
 * Returns undefined for each dimension that has no data across all seeds.
 */
export function computeSeedCentroid(
    seedRows: Pick<BrewCandidateRow, 'custom_metadata'>[],
): BrewSeedAcoustics {
    let bpmSum = 0;
    let bpmCount = 0;
    let energySum = 0;
    let energyCount = 0;
    let danceabilitySum = 0;
    let danceabilityCount = 0;
    const allMoodTags = new Set<string>();

    for (const row of seedRows) {
        const ess = extractEssentia(row.custom_metadata);
        const bpm = extractBpm(ess);
        const energy = extractNum(ess, 'energy');
        const danceability = extractNum(ess, 'danceability');
        const tags = extractMoodTags(ess);

        if (bpm !== undefined) {
            bpmSum += bpm;
            bpmCount++;
        }
        if (energy !== undefined) {
            energySum += energy;
            energyCount++;
        }
        if (danceability !== undefined) {
            danceabilitySum += danceability;
            danceabilityCount++;
        }
        for (const tag of tags) allMoodTags.add(tag.toLowerCase().trim());
    }

    return {
        bpm: bpmCount > 0 ? bpmSum / bpmCount : undefined,
        energy: energyCount > 0 ? energySum / energyCount : undefined,
        danceability: danceabilityCount > 0 ? danceabilitySum / danceabilityCount : undefined,
        moodTags: Array.from(allMoodTags),
    };
}

/**
 * Score a single candidate against the brew parameters.
 *
 * Formula (all sub-scores are [0, 1], higher = better):
 *
 *   targetEnergy = energy knob value (default 0.5)
 *   targetBpm    = seed centroid BPM scaled by tempo knob:
 *                  tempo < 0.5 → slower, tempo > 0.5 → faster
 *                  Δbpm = (tempo - 0.5) * 2 * seed_bpm * 0.3  (±30% at extremes)
 *
 *   score = w_bpm     × bpm_closeness
 *         + w_energy  × energy_closeness
 *         + w_dance   × danceability_closeness
 *         + w_mood    × mood_jaccard
 *         + w_popular × popularity_factor
 *
 * Weights (sum to 1):
 *   BPM: 0.20, Energy: 0.30, Danceability: 0.15, Mood: 0.25, Popularity: 0.10
 *
 * The popularity_factor blends play_count + listener data to implement the
 * obscurity dial: obscurity=0 boosts popular tracks, obscurity=1 boosts
 * deep cuts, obscurity=0.5 is neutral.
 */
export function scoreCandidate(
    candidate: BrewCandidateRow,
    centroid: BrewSeedAcoustics,
    knobs: { energy: number; tempo: number; obscurity: number },
): number {
    const ess = extractEssentia(candidate.custom_metadata);

    // ── Acoustic sub-scores ──────────────────────────────────────────────────

    // BPM closeness
    let bpmScore = 0.5; // neutral when no data on either side
    const candidateBpm = extractBpm(ess);
    if (candidateBpm !== undefined && centroid.bpm !== undefined && centroid.bpm > 0) {
        // Shift centroid BPM by tempo knob: ±30% of centroid at extremes
        const tempoShift = (knobs.tempo - 0.5) * 2 * centroid.bpm * 0.3;
        const targetBpm = centroid.bpm + tempoShift;
        // Ratio distance — 0 = perfect match, caps at 1
        const ratio = Math.abs(candidateBpm - targetBpm) / targetBpm;
        bpmScore = Math.max(0, 1 - ratio * 3); // 3× so 33% off = score 0
    }

    // Energy closeness
    let energyScore = 0.5;
    const candidateEnergy = extractNum(ess, 'energy');
    if (candidateEnergy !== undefined) {
        const targetEnergy = knobs.energy;
        energyScore = Math.max(0, 1 - Math.abs(candidateEnergy - targetEnergy) * 2);
    }

    // Danceability closeness
    let danceScore = 0.5;
    const candidateDance = extractNum(ess, 'danceability');
    if (candidateDance !== undefined && centroid.danceability !== undefined) {
        // Normalize: Essentia danceability typically ranges 0–2+; treat 1.0 as neutral.
        // We compare relative closeness to centroid, normalized by centroid magnitude.
        const refDance = centroid.danceability > 0 ? centroid.danceability : 1;
        const ratio = Math.abs(candidateDance - centroid.danceability) / refDance;
        danceScore = Math.max(0, 1 - ratio * 2);
    }

    // Mood-tag Jaccard overlap
    let moodScore = 0.5; // neutral when no seed moods
    if (centroid.moodTags.length > 0) {
        const candidateTags = new Set(extractMoodTags(ess).map((t) => t.toLowerCase().trim()));
        if (candidateTags.size === 0) {
            moodScore = 0; // candidate has no mood data — penalise
        } else {
            let intersection = 0;
            for (const tag of centroid.moodTags) {
                if (candidateTags.has(tag)) intersection++;
            }
            const union = new Set([...centroid.moodTags, ...candidateTags]).size;
            moodScore = union > 0 ? intersection / union : 0;
        }
    }

    // ── Popularity factor ────────────────────────────────────────────────────
    // Combines play_count (personal) and listener count (global).
    // normalised to [0, 1] then inverted / not based on obscurity dial.
    //
    // personalScore: log scale on play_count (0→0, 10→0.5, 100→1)
    // globalScore:   log scale on listener count (0→0, 1k→0.3, 100k→0.8, 1M→1)
    const personalScore = Math.min(
        1,
        candidate.play_count > 0 ? Math.log10(candidate.play_count + 1) / 2 : 0,
    );
    const listeners = candidate.popularity_listeners ?? 0;
    const globalScore =
        listeners > 0 ? Math.min(1, Math.log10(listeners + 1) / Math.log10(1_000_000 + 1)) : 0;
    const rawPopularity = personalScore * 0.4 + globalScore * 0.6;

    // obscurity=0 → boost popular (popularity factor = rawPopularity)
    // obscurity=0.5 → neutral (popularity factor = 0.5)
    // obscurity=1 → boost obscure (popularity factor = 1 - rawPopularity)
    const popularityFactor =
        knobs.obscurity <= 0.5
            ? // interpolate: 0→rawPopularity, 0.5→0.5
              rawPopularity + (0.5 - rawPopularity) * (knobs.obscurity * 2)
            : // interpolate: 0.5→0.5, 1→(1-rawPopularity)
              0.5 + (1 - rawPopularity - 0.5) * ((knobs.obscurity - 0.5) * 2);

    // ── Weighted sum ─────────────────────────────────────────────────────────
    const W_BPM = 0.2;
    const W_ENERGY = 0.3;
    const W_DANCE = 0.15;
    const W_MOOD = 0.25;
    const W_POPULAR = 0.1;

    return (
        bpmScore * W_BPM +
        energyScore * W_ENERGY +
        danceScore * W_DANCE +
        moodScore * W_MOOD +
        popularityFactor * W_POPULAR
    );
}

/**
 * Score and rank a candidate pool, returning the top `limit` entries.
 */
export function rankBrewCandidates(
    candidates: BrewCandidateRow[],
    centroid: BrewSeedAcoustics,
    knobs: { energy: number; tempo: number; obscurity: number },
    limit: number,
): ScoredBrewCandidate[] {
    const scored: ScoredBrewCandidate[] = candidates.map((c) => ({
        ...c,
        brewScore: scoreCandidate(c, centroid, knobs),
    }));
    scored.sort((a, b) => b.brewScore - a.brewScore);
    return scored.slice(0, limit);
}

// =============================================================================
// Mood-island clustering (k-means over energy × danceability dims)
// =============================================================================

/** A raw mood island cluster before color assignment. */
export interface RawMoodIsland {
    label: string;
    /** Normalised X [0,1]: derived from energy centroid */
    x: number;
    /** Normalised Y [0,1]: derived from danceability centroid */
    y: number;
    size: number;
}

/**
 * One row from {@link getSonicMoodGroupCounts}: a mood and how many of the
 * supplied candidate tracks have that mood as their nearest audio mood vector.
 */
export interface SonicMoodGroupRow {
    /** Stable mood identifier from mood_vectors.mood_key (e.g. "music:chill"). */
    mood_key: string;
    /** Human-readable display name from mood_vectors.display_name. */
    display_name: string;
    /** Number of candidates whose nearest mood vector is this mood. */
    count: number;
}

/**
 * Build mood-island anchors from the candidate pool by grouping tracks by
 * their dominant mood tag and computing energy × danceability centroids.
 *
 * Uses a simple label-based grouping (not full k-means) over the acoustic
 * dims: group by dominant mood_tag[0], compute mean energy and danceability.
 * The position mapping is:
 *   x = energy centroid (already normalised [0,1] by Essentia)
 *   y = danceability centroid / 2.0 (Essentia danceability is ~[0,2+]; dividing
 *       by 2 gives a reasonable [0,1] spread; clamped to [0,1])
 *
 * Returns at most MAX_ISLANDS anchors sorted by size descending.
 * Returns [] when < 2 tracks have mood data.
 */
const MAX_ISLANDS = 8;
const MIN_ISLAND_SIZE = 2;

export function buildMoodIslandAnchors(candidates: BrewCandidateRow[]): RawMoodIsland[] {
    // Group by dominant mood (mood_tags[0] after normalisation).
    const groups = new Map<
        string,
        { energySum: number; danceSum: number; count: number; energyN: number; danceN: number }
    >();

    for (const c of candidates) {
        const ess = extractEssentia(c.custom_metadata);
        const tags = extractMoodTags(ess);
        if (tags.length === 0) continue;

        const label = tags[0].toLowerCase().trim();
        const energy = extractNum(ess, 'energy');
        const danceability = extractNum(ess, 'danceability');

        const existing = groups.get(label) ?? {
            energySum: 0,
            danceSum: 0,
            count: 0,
            energyN: 0,
            danceN: 0,
        };
        existing.count++;
        if (energy !== undefined) {
            existing.energySum += energy;
            existing.energyN++;
        }
        if (danceability !== undefined) {
            existing.danceSum += danceability;
            existing.danceN++;
        }
        groups.set(label, existing);
    }

    const islands: RawMoodIsland[] = [];

    for (const [label, g] of groups) {
        if (g.count < MIN_ISLAND_SIZE) continue;

        const energyCentroid = g.energyN > 0 ? g.energySum / g.energyN : 0.5;
        const danceabilityCentroid = g.danceN > 0 ? g.danceSum / g.danceN : 0.5;

        // Normalise danceability: Essentia range is ~0–3; clamp to [0,1] via /2
        const y = Math.min(1, Math.max(0, danceabilityCentroid / 2));
        const x = Math.min(1, Math.max(0, energyCentroid));

        islands.push({ label, x, y, size: g.count });
    }

    // Sort largest first, cap at MAX_ISLANDS
    islands.sort((a, b) => b.size - a.size);
    return islands.slice(0, MAX_ISLANDS);
}

// =============================================================================
// Sonic mood-island clustering (nearest audio mood vector)
// =============================================================================

/**
 * For the supplied candidate track IDs, assign each candidate to its NEAREST
 * audio mood vector (`mood_vectors` rows with `model_id = MSCLAP_MODEL_ID`) by
 * cosine distance (`<=>`) over its MSCLAP embedding, then return per-mood counts.
 *
 * This mirrors the sonic-mood coloring in `getMapPoints` (music-map.queries):
 * each track's MSCLAP embedding is compared against every audio mood vector and
 * the closest mood wins. Here we aggregate the assignment into group counts so
 * the brew endpoint can emit one mood-island anchor per non-empty mood.
 *
 * Returns `[]` when there are no candidate IDs, no MSCLAP embeddings for them,
 * or no audio mood vectors — the caller must treat `[]` as "no sonic islands"
 * and fall back to the acoustic mood-island path.
 *
 * ACCESS SCOPING IS DELEGATED, NOT ABSENT. This query applies no library/age
 * predicate: it aggregates over IDs the caller already filtered, and re-scoping
 * would mean a redundant `media_items` join purely to re-derive a decision
 * already made. That is exactly the "trust the caller" pattern that
 * required-by-shape exists to kill, so the trust is not left in prose — the
 * caller must pass an explicit {@link PreFilteredCandidates} token naming where
 * the IDs came from. The obligation is unchanged; it is now greppable and
 * survives refactors that would silently drop a plain comment.
 *
 * @param sql          - postgres.Sql instance.
 * @param candidateIds - Track UUIDs from an ALREADY access-scoped candidate pool.
 * @param scope        - REQUIRED pre-filtered attestation naming the scoped source.
 */
export async function getSonicMoodGroupCounts(
    sql: postgres.Sql,
    candidateIds: string[],
    scope: PreFilteredCandidates,
): Promise<SonicMoodGroupRow[]> {
    // `scope` is an attestation, not a filter — referenced so the parameter can
    // never be quietly dropped as unused.
    void scope;
    if (candidateIds.length === 0) return [];

    return sql<SonicMoodGroupRow[]>`
        SELECT
            nearest.mood_key                          AS mood_key,
            nearest.display_name                      AS display_name,
            count(*)::int                             AS count
        FROM media_audio_embeddings mae
        CROSS JOIN LATERAL (
            SELECT mv.mood_key, mv.display_name
            FROM mood_vectors mv
            WHERE mv.model_id = ${SONIC_MODEL_ID}
            ORDER BY mae.embedding <=> mv.vector
            LIMIT 1
        ) nearest
        WHERE mae.media_id = ANY(${candidateIds}::uuid[])
          AND mae.model_id = ${SONIC_MODEL_ID}
        GROUP BY nearest.mood_key, nearest.display_name
        ORDER BY count(*) DESC, nearest.mood_key ASC
    `;
}

/**
 * Build deterministic mood-island anchors from nearest-mood group counts.
 *
 * Layout: moods are sorted by `mood_key` (stable, alphabetical) and spread
 * evenly around a circle inscribed in the [0,1]² canvas. The same mood always
 * lands at the same angle for a given set of present moods, so islands never
 * teleport across brews as long as the mood set is stable — and even when it
 * changes, each mood's slot is derived purely from its sorted position.
 *
 * `size` carries the group's candidate count (the schema's island-size field);
 * the Canvas component derives bubble radius from it via log scaling.
 *
 * Pure + deterministic: no Date.now / random. Returns at most MAX_ISLANDS
 * anchors (the largest groups), and skips groups below MIN_ISLAND_SIZE.
 */
export function buildSonicMoodIslandAnchors(groups: SonicMoodGroupRow[]): RawMoodIsland[] {
    // Keep only groups that clear the minimum size, then cap to the largest.
    const eligible = groups
        .filter((g) => g.count >= MIN_ISLAND_SIZE)
        .sort((a, b) => b.count - a.count || a.mood_key.localeCompare(b.mood_key))
        .slice(0, MAX_ISLANDS);

    if (eligible.length === 0) return [];

    // Deterministic angular layout: sort the SELECTED moods by key so each
    // mood occupies a fixed slot independent of count ordering.
    const ordered = [...eligible].sort((a, b) => a.mood_key.localeCompare(b.mood_key));
    const n = ordered.length;

    // Circle inscribed in [0,1]² with a margin so islands never clip the edge.
    const CENTER = 0.5;
    const RADIUS = 0.34;

    return ordered.map((g, i) => {
        // Single mood → place at center; otherwise spread around the circle,
        // starting at the top (-π/2) and going clockwise.
        let x = CENTER;
        let y = CENTER;
        if (n > 1) {
            const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
            x = CENTER + RADIUS * Math.cos(angle);
            y = CENTER + RADIUS * Math.sin(angle);
        }
        return {
            // Strip any "namespace:" prefix (audio mood keys are e.g.
            // "music:chill") so the label renders cleanly AND matches the
            // moodToColor palette keys ("chill", "party", ...).
            label: stripMoodNamespace(g.mood_key),
            x: Math.min(1, Math.max(0, x)),
            y: Math.min(1, Math.max(0, y)),
            size: g.count,
        };
    });
}

/**
 * Strip a leading "namespace:" segment from a mood key.
 * "music:chill" → "chill"; "happy" → "happy". Trimmed + lowercased so the
 * result is a stable palette key for moodToColor().
 */
export function stripMoodNamespace(moodKey: string): string {
    const colon = moodKey.indexOf(':');
    const bare = colon >= 0 ? moodKey.slice(colon + 1) : moodKey;
    return bare.trim().toLowerCase();
}
