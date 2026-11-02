// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sonic Path Query Module
 *
 * Interpolates a sonic bridge between two seed tracks by stepping through the
 * audio-embedding space in equal increments and picking the nearest unused
 * track at each waypoint.
 *
 * Algorithm:
 *   1. Fetch the 1024-dim MSCLAP embeddings for the `from` and `to` seeds.
 *   2. Linearly interpolate N+1 waypoints between them (exclusive of endpoints).
 *   3. For each waypoint, fetch the nearest track in `media_audio_embeddings`
 *      (excluding already-selected tracks and the seeds themselves).
 *   4. Apply artist-cap: no more than MAX_TRACKS_PER_ARTIST from the same
 *      artist in the result (artist resolved via album → artist hierarchy).
 *   5. Deduplicate: each track appears at most once in the bridge, and
 *      title-normalized duplicates (same normalized title + artist — e.g. the
 *      same song on another album/release, or a remix/edit variant) of the
 *      seeds or of an already-selected track are skipped, so the bridge never
 *      wastes a hop on another copy of the seed (shared helpers from
 *      music-title-normalize — never ad-hoc title dedup).
 *
 * The `media_audio_embeddings` HNSW index uses `vector_cosine_ops`, so every
 * kNN step uses `<=>` (cosine distance). L2 / inner-product operators would
 * bypass the index.
 *
 * All functions take `sql: postgres.Sql` as the first parameter and have no
 * side effects.
 *
 * @module queries/sonic-path
 */

import type postgres from 'postgres';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { MSCLAP_MODEL_ID } from './sonic-constants.js';
import { parseEmbedding as parseEmbeddingUtil } from '$lib/server/utils/embedding-utils.js';
import {
    trackDisplayArtistSql,
    trackArtistIdSql,
    trackArtistsSql,
    trackRemixerArtistsSql,
    canonicalTrackArtistsJoinSql,
    trackCreditArtistsSql,
} from './fragments/music-artist.fragments.js';
import { normalizeTitle } from './music-title-normalize.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hardcoded model identifier — matches every INSERT/WHERE in the embedder pipeline. */
const MODEL_ID = MSCLAP_MODEL_ID;

/** Maximum number of bridge steps (user-requested `steps` is clamped to this). */
export const SONIC_PATH_MAX_STEPS = 20;

/** Minimum bridge steps. */
export const SONIC_PATH_MIN_STEPS = 1;

/** Default bridge length when the caller omits `steps`. */
export const SONIC_PATH_DEFAULT_STEPS = 8;

/** Per-artist cap — at most this many tracks from the same artist in one bridge. */
const MAX_TRACKS_PER_ARTIST = 2;

// ---------------------------------------------------------------------------
// Access boundary contract (read before touching any query text here)
// ---------------------------------------------------------------------------
//
// Every exported function in this module takes a REQUIRED
// {@link MediaAccessBoundary}. There is no permissive default: a caller that
// wants unfiltered rows must say so with `unrestrictedAccess()`, which makes the
// decision greppable. Route/def callers project their SearchAccessContext with
// `searchAccessBoundary(ctx)` rather than hand-passing a
// `{ deniedGroupIds, ageRating }` pair.
//
// EMPTY-FRAGMENT INVARIANT. `{ kind: 'all' }` and `{ kind: 'any' }` make the two
// builders emit a literally EMPTY sql fragment — byte-identical to what the old
// `null` inputs produced. That matters more here than anywhere else: the kNN
// query below is `ORDER BY mae.embedding <=> waypoint LIMIT 1` against a
// `vector_cosine_ops` HNSW index, and an "always true" tautology spliced into
// the WHERE (AND true / AND 1=1) can push the planner off that index into a full
// scan. Never make the unrestricted path emit a predicate.
//
// ALIAS CONTRACT. `buildLibraryAccessFilter` hardcodes `mi.id` in both of its
// correlated subqueries and `buildAgeRatingFilter` defaults its alias to `mi`.
// Neither splice site passes an alias override, so the surrounding query MUST
// alias the CANDIDATE media_items row as `mi`. Both queries below do. Note the
// boundary constrains `mi` while `ORDER BY` and the exclusion filter target
// `mae` — the `mi.id = mae.media_id` join is what ties the boundary to the
// ranked rows. Aliasing `mi` anything else raises a real Postgres
// "missing FROM-clause entry for table mi", but ONLY for restricted callers,
// because both builders are empty under an unrestricted boundary.
//
// SEED READS ARE IN SCOPE. `fetchSeedEmbedding` applies the boundary too, so a
// caller that may see nothing (or may not see the seed's library group) cannot
// bootstrap a bridge from a track it is not allowed to read. This is enforced in
// the query layer rather than left to a route-level `checkMediaAccess` a future
// caller could forget. The join it adds is lossless: `media_audio_embeddings`
// has an ON DELETE CASCADE FK to `media_items`, so no embedding row can outlive
// its media item.
//
// DENY-ALL. `buildSonicPath` short-circuits to an empty bridge via
// `deniesEverything` BEFORE issuing any SQL. That guard earns its keep here:
// a full run issues up to 20 steps x 10 retry attempts x ~5 sql invocations, all
// of which would be guaranteed-empty round trips under `AND false`.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single bridge step returned by {@link buildSonicPath}. */
export interface SonicPathStep {
    /** Internal UUID of the track. */
    media_id: string;
    /** Step index (0-based, 0 = closest to `from`, steps-1 = closest to `to`). */
    step: number;
    /**
     * Cosine similarity [0, 1] between this track and the interpolated waypoint.
     * 1 = identical, 0 = orthogonal. Used by the UI for visual encoding.
     */
    similarity_score: number;
    title: string;
    custom_poster_url: string | null;
    custom_metadata: Record<string, unknown>;
    runtime_seconds: number | null;
    artist_title: string | null;
    artist_id: string | null;
    track_artists?: Array<{ id: string | null; title: string }> | null;
    remixer_artists?: Array<{ id: string | null; title: string }> | null;
    album_id: string | null;
    album_title: string | null;
}

/** Embedding vector row fetched from media_audio_embeddings. */
interface EmbeddingRow {
    media_id: string;
    embedding: number[] | string;
}

/** Raw kNN candidate row before artist-cap / dedup processing. */
interface CandidateRow {
    media_id: string;
    similarity_score: number;
    title: string;
    custom_poster_url: string | null;
    custom_metadata: Record<string, unknown>;
    runtime_seconds: number | null;
    artist_title: string | null;
    artist_id: string | null;
    track_artists?: Array<{ id: string | null; title: string }> | null;
    remixer_artists?: Array<{ id: string | null; title: string }> | null;
    album_id: string | null;
    album_title: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalise an embedding returned by postgres.js.
 *
 * pgvector returns vector columns as a string like `[0.1,0.2,...]` or as a
 * pre-parsed number array depending on the driver version / configuration.
 * We accept both and always return a plain `number[]`.
 * Delegates to the shared parseEmbedding utility from embedding-utils.
 */
function parseEmbedding(raw: number[] | string): number[] {
    return parseEmbeddingUtil(raw) ?? [];
}

/**
 * Linear interpolation between two vectors at parameter `t ∈ [0, 1]`.
 * t=0 → `a`, t=1 → `b`. The result is NOT normalised (cosine distance does
 * not require unit vectors — pgvector normalises internally for cosine ops).
 */
function lerp(a: number[], b: number[], t: number): number[] {
    return a.map((v, i) => v * (1 - t) + (b[i] ?? 0) * t);
}

/**
 * Serialise a vector back to the `[v1,v2,...]::vector` string literal expected
 * by the pgvector `<=>` operator when passed as a parameter.
 */
function vectorLiteral(v: number[]): string {
    return `[${v.join(',')}]`;
}

/**
 * Dedup key for title-normalized duplicate suppression: shared
 * `normalizeTitle` stem + lowercased artist title (the same convention the
 * genre-plan / stations rec surfaces use). Returns `null` when the title
 * normalizes to nothing (never dedup on an empty stem).
 */
function titleVariantKey(title: string, artistTitle: string | null): string | null {
    const norm = normalizeTitle(title);
    if (!norm) return null;
    return `${norm}::${(artistTitle ?? '').toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Seed embedding fetch
// ---------------------------------------------------------------------------

/**
 * Fetch the MSCLAP embedding for a single track.
 *
 * Returns `null` when the track has no embedding in `media_audio_embeddings`
 * (e.g. the embedder hasn't processed it yet) OR when the track lies outside the
 * caller's access boundary, so callers can surface a meaningful error rather
 * than silently returning an empty path. The two cases are deliberately
 * indistinguishable to the caller — that is the same existence-leak posture the
 * media routes take (404, never 403).
 *
 * @param access - REQUIRED access boundary. Use `searchAccessBoundary(ctx)` for
 *                 a real user, or `unrestrictedAccess()` to opt out explicitly.
 */
export async function fetchSeedEmbedding(
    sql: postgres.Sql,
    mediaId: string,
    access: MediaAccessBoundary,
): Promise<number[] | null> {
    if (deniesEverything(access)) return null;

    const rows = await sql<EmbeddingRow[]>`
        SELECT mae.media_id, mae.embedding
        FROM media_audio_embeddings mae
        JOIN media_items mi ON mi.id = mae.media_id
        WHERE mae.media_id = ${mediaId}
          AND mae.model_id = ${MODEL_ID}
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildAgeRatingFilter(sql, access.age)}
        LIMIT 1
    `;
    if (rows.length === 0) return null;
    return parseEmbedding(rows[0].embedding);
}

/** Title + display artist for a set of seed tracks (for title-dedup keys). */
interface SeedTitleMetaRow {
    media_id: string;
    title: string;
    artist_title: string | null;
}

/**
 * Fetch title + display artist for the seed tracks, so bridge candidates that
 * are title-normalized duplicates of a seed (the same song on another
 * album/release) can be excluded from the hops.
 */
async function fetchSeedTitleMeta(
    sql: postgres.Sql,
    mediaIds: string[],
): Promise<SeedTitleMetaRow[]> {
    return sql<SeedTitleMetaRow[]>`
        SELECT
            mi.id::text                         AS media_id,
            mi.title,
            ${trackDisplayArtistSql(sql, 'mi')} AS artist_title
        FROM media_items mi
        LEFT JOIN media_items album
               ON album.id = mi.parent_id
              AND album.media_type = 'album'
        LEFT JOIN media_items artist
               ON artist.id = album.parent_id
              AND artist.media_type = 'artist'
        WHERE mi.id = ANY(${mediaIds}::uuid[])
    `;
}

// ---------------------------------------------------------------------------
// Per-step kNN query
// ---------------------------------------------------------------------------

/**
 * Find the single nearest track to `waypoint` that is not in `excludeIds`,
 * applying library-group and age-rating access filters.
 *
 * Returns `null` when no accessible candidate exists (rare: very restricted
 * library with few embeddings, or all candidates excluded).
 *
 * The query is intentionally restricted to `LIMIT 1` to minimise index scans
 * while keeping the per-step latency low. Artist-cap is enforced by the caller
 * by adding the artist to the exclusion window when the cap is reached.
 */
async function findNearestToWaypoint(
    sql: postgres.Sql,
    waypoint: number[],
    excludeIds: string[],
    access: MediaAccessBoundary,
): Promise<CandidateRow | null> {
    if (deniesEverything(access)) return null;

    const waypointStr = vectorLiteral(waypoint);

    const excludeFilter: ReturnType<typeof sql> =
        excludeIds.length > 0 ? sql`AND mae.media_id != ALL(${excludeIds}::uuid[])` : sql``;

    const rows = await sql<CandidateRow[]>`
        WITH page AS (
            -- Artist credits are resolved below, for the chosen row only.
            SELECT
                mae.media_id,
                mae.embedding <=> ${waypointStr}::vector                   AS distance,
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
            LEFT JOIN media_items album
                   ON album.id = mi.parent_id
                  AND album.media_type = 'album'
            LEFT JOIN media_items artist
                   ON artist.id = album.parent_id
                  AND artist.media_type = 'artist'
            WHERE mae.model_id = ${MODEL_ID}
              ${excludeFilter}
              ${buildLibraryAccessFilter(sql, access.library)}
              ${buildAgeRatingFilter(sql, access.age)}
            ORDER BY mae.embedding <=> ${waypointStr}::vector ASC
            LIMIT 1
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
            ${trackArtistIdSql(sql, 'mi', trackCreditArtistsSql(sql))}::text AS artist_id,
            mi.album_id::text                                              AS album_id,
            mi.album_title
        FROM page mi
        LEFT JOIN media_items artist ON artist.id = mi.album_artist_id
        ${canonicalTrackArtistsJoinSql(sql, 'mi')}
    `;

    return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Main path builder
// ---------------------------------------------------------------------------

/**
 * Build a sonic bridge between two seed tracks by interpolating through their
 * audio embedding space.
 *
 * @param sql       - postgres.Sql instance (parameterized — no sql.unsafe).
 * @param fromId    - Internal UUID of the start track.
 * @param toId      - Internal UUID of the end track.
 * @param steps  - Number of bridge tracks to insert (1–20, default 8).
 * @param access - REQUIRED access boundary. Use `searchAccessBoundary(ctx)` for
 *                 a real user, or `unrestrictedAccess()` to opt out explicitly.
 *
 * Returns an ordered array of bridge steps. Each step is the nearest unused
 * track at the corresponding interpolation waypoint.
 *
 * Returns `{ steps: [], error: 'no_embedding_from' | 'no_embedding_to' }` when
 * either seed lacks an embedding, so the caller can surface a useful message.
 *
 * A `denyAll` boundary returns `{ steps: [], missingEmbedding: null }` without
 * issuing a single query — see the DENY-ALL note in the boundary contract above.
 */
export async function buildSonicPath(
    sql: postgres.Sql,
    fromId: string,
    toId: string,
    steps: number,
    access: MediaAccessBoundary,
): Promise<{ steps: SonicPathStep[]; missingEmbedding: 'from' | 'to' | null }> {
    // A caller that may see nothing gets an empty bridge, not up to 200
    // guaranteed-empty round trips. Reported as "no bridge" rather than
    // "missing embedding": nothing is known about the seeds' embeddings.
    if (deniesEverything(access)) return { steps: [], missingEmbedding: null };

    const clampedSteps = Math.min(
        Math.max(Math.floor(steps), SONIC_PATH_MIN_STEPS),
        SONIC_PATH_MAX_STEPS,
    );

    // Fetch both seed embeddings in parallel.
    const [fromEmbed, toEmbed] = await Promise.all([
        fetchSeedEmbedding(sql, fromId, access),
        fetchSeedEmbedding(sql, toId, access),
    ]);

    if (!fromEmbed) return { steps: [], missingEmbedding: 'from' };
    if (!toEmbed) return { steps: [], missingEmbedding: 'to' };

    // Build the list of waypoints. We interpolate BETWEEN the two seeds
    // (exclusive), so t runs from 1/(N+1) to N/(N+1) for N steps.
    const N = clampedSteps;
    const waypoints: number[][] = [];
    for (let i = 1; i <= N; i++) {
        waypoints.push(lerp(fromEmbed, toEmbed, i / (N + 1)));
    }

    // Title-dedup window: bridge hops must not be title-normalized duplicates
    // of either seed or of each other (duplicate copies of the seed across
    // albums/releases sit at distance ~0 in embedding space, so without this
    // the first hop is routinely "the same song again").
    const usedTitleKeys = new Set<string>();
    for (const seed of await fetchSeedTitleMeta(sql, [fromId, toId])) {
        const key = titleVariantKey(seed.title, seed.artist_title);
        if (key) usedTitleKeys.add(key);
    }

    // Walk each waypoint, picking the nearest unused track. The exclusion set
    // grows with each step: seeds + already-selected tracks. Artist counts
    // track how many tracks per artist have been selected so far.
    const excludeIds = new Set<string>([fromId, toId]);
    const artistCounts = new Map<string, number>();
    const bridgeSteps: SonicPathStep[] = [];

    for (let stepIdx = 0; stepIdx < waypoints.length; stepIdx++) {
        const waypoint = waypoints[stepIdx];
        if (!waypoint) continue;

        // We may need to retry with an expanded exclusion if the nearest
        // candidate is over the artist cap. We use a secondary oversize fetch
        // via repeated single-row queries with expanding exclusion.
        let candidate: CandidateRow | null = null;
        let attempt = 0;
        const trialExcludes = new Set(excludeIds);

        while (attempt < 10) {
            // Find nearest not in trialExcludes
            const nearest = await findNearestToWaypoint(
                sql,
                waypoint,
                Array.from(trialExcludes),
                access,
            );
            if (!nearest) break; // no more candidates

            // Title-normalized duplicate of a seed or an already-selected
            // track — skip it and try again (same retry mechanic as the
            // artist cap below).
            const titleKey = titleVariantKey(nearest.title, nearest.artist_title);
            if (titleKey && usedTitleKeys.has(titleKey)) {
                trialExcludes.add(nearest.media_id);
                attempt++;
                continue;
            }

            const artistId = nearest.artist_id ?? nearest.artist_title ?? '__unknown__';
            const currentArtistCount = artistCounts.get(artistId) ?? 0;

            if (currentArtistCount < MAX_TRACKS_PER_ARTIST) {
                // Acceptable
                candidate = nearest;
                break;
            } else {
                // Artist cap reached — skip this track and try again
                trialExcludes.add(nearest.media_id);
                attempt++;
            }
        }

        if (candidate) {
            excludeIds.add(candidate.media_id);
            const artistId = candidate.artist_id ?? candidate.artist_title ?? '__unknown__';
            artistCounts.set(artistId, (artistCounts.get(artistId) ?? 0) + 1);
            const candidateTitleKey = titleVariantKey(candidate.title, candidate.artist_title);
            if (candidateTitleKey) usedTitleKeys.add(candidateTitleKey);

            bridgeSteps.push({
                ...candidate,
                step: stepIdx,
                similarity_score: Math.round(candidate.similarity_score * 10000) / 10000,
            });
        }
        // If no candidate found for this step, we silently omit it (the bridge
        // may be shorter than requested when the library is very small).
    }

    return { steps: bridgeSteps, missingEmbedding: null };
}
