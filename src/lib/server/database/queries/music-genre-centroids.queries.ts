// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sonic genre centroids — the read/write side of the "New to You" rail.
 *
 * See `migrations/16.208.0_music_genre_centroids.ts` for why centroids are
 * stored pre-centered against a corpus mean. In short: raw cosine between
 * MSCLAP genre means is noise (everything lands 0.85–0.98 and `Blues` ranks 4th
 * for a hardstyle listener); centering both sides makes the ranking meaningful.
 */

import type postgres from 'postgres';
import { MSCLAP_MODEL_ID } from './sonic-constants.js';
import { deniesEverything, type MediaAccessBoundary } from './builders/media-access-boundary.js';
import type { AgeRatingFilterParams } from './builders/age-rating.builder.js';

/** Genres below this cannot sustain a rail — mirrors the ranker's own gate. */
const MIN_TRACKS_FOR_CENTROID = 120;

/** Completed tracks required before a taste vector is trustworthy. */
export const MIN_COMPLETES_FOR_ADJACENCY = 20;

/**
 * Centered-cosine floor for recommending a genre.
 *
 * Calibrated against the measured cliff on this library: the heaviest listener
 * scores 0.83 / 0.66 / 0.56 and then falls to 0.08, while a 6-completes user's
 * entire candidate list sits flat at ~0.48 — no real signal. 0.55 admits the
 * former and rejects the latter. Roughly half of accounts see this rail, which
 * is the intended selectivity, not a shortfall.
 */
export const MIN_ADJACENCY_SIMILARITY = 0.55;

/** Most recent completed tracks used to build the taste vector. */
const TASTE_SEED_LIMIT = 200;

export interface GenreCentroidInput {
    genreKey: string;
    displayName: string;
    variants: string[];
}

export interface GenreAdjacencyRow {
    genreKey: string;
    displayName: string;
    variants: string[];
    similarity: number;
    seedCount: number;
}

/**
 * Rebuild every genre centroid and the corpus mean, in ONE transaction.
 *
 * Clear-and-reload rather than incremental: the whole job measures ~600ms, so
 * incremental bookkeeping would be more code than the task. The transaction is
 * the point — the table is either entirely the previous generation or entirely
 * the new one, so a mid-run failure can never leave the rail reading half a
 * dataset (the failure mode `sonic-clustering` hit and now guards the same way).
 *
 * `genreKeyFor` folds a raw stored tag to the ranker's normalised key; it is
 * passed in rather than imported so this module stays free of service imports.
 */
export async function rebuildGenreCentroids(
    sql: postgres.Sql,
    genres: GenreCentroidInput[],
): Promise<{ centroids: number; corpusTracks: number }> {
    if (genres.length === 0) return { centroids: 0, corpusTracks: 0 };

    return sql.begin(async (tx) => {
        const [meanRow] = await tx<{ track_count: string }[]>`
            INSERT INTO music_sonic_model_stats (model_id, global_mean, track_count)
            SELECT
                ${MSCLAP_MODEL_ID},
                AVG(e.embedding)::vector(1024),
                COUNT(*)::int
            FROM media_audio_embeddings e
            WHERE e.model_id = ${MSCLAP_MODEL_ID}
            HAVING COUNT(*) > 0
            ON CONFLICT (model_id) DO UPDATE
                SET global_mean = EXCLUDED.global_mean,
                    track_count = EXCLUDED.track_count,
                    computed_at = NOW()
            RETURNING track_count::text
        `;
        if (!meanRow) return { centroids: 0, corpusTracks: 0 };

        // Stale generation goes first, inside the same transaction.
        await tx`DELETE FROM music_genre_centroids WHERE model_id = ${MSCLAP_MODEL_ID}`;

        const variantsByKey = genres.map((g) => ({
            genre_key: g.genreKey,
            display_name: g.displayName,
            variants: g.variants,
        }));

        // Shape matters here — the obvious form of this statement OOM-killed prod's
        // Postgres every night (2026-10-02..05, 8 Gi pod, PG 18.6). It joined every
        // genre against every track with `music_genre_tags(...) && variants` (3.5M
        // function calls on a 31.7k-track library) and grouped the 4 KB embeddings
        // under a sort keyed on the variants array AND the 4 KB global-mean vector,
        // with COUNT(DISTINCT) on top: a synthetic copy at prod scale peaked one
        // backend at 2.9 GB. Now:
        //   - each track's tags are computed ONCE and matched to genres by an
        //     equality hash join on the exploded variant list;
        //   - the (genre, track) pairs carry no vectors, so the COUNT(DISTINCT)
        //     sort is of narrow rows;
        //   - the vector mean is a plain hashed AVG keyed on genre_key alone;
        //   - the global mean is subtracted once per genre after aggregation.
        // Same output (verified equal: track/album counts and every centroid
        // component), ~2 s and no measurable memory growth at prod scale.
        const inserted = await tx<{ genre_key: string }[]>`
            WITH wanted AS (
                -- sql.json() so postgres.js sends a real json value; passing a
                -- JSON.stringify'd string instead arrives double-encoded and
                -- json_to_recordset rejects it as a scalar.
                -- DISTINCT ON: one row per key, so a duplicated input key can
                -- never insert two rows for one genre.
                SELECT DISTINCT ON (genre_key) *
                FROM json_to_recordset(${sql.json(variantsByKey)}::json)
                    AS w(genre_key text, display_name text, variants text[])
            ),
            variant_map AS (
                SELECT DISTINCT w.genre_key, v.tag
                FROM wanted w
                CROSS JOIN LATERAL unnest(w.variants) AS v(tag)
            ),
            pairs AS MATERIALIZED (
                SELECT DISTINCT vm.genre_key, t.id AS media_id, t.parent_id
                FROM media_items t
                CROSS JOIN LATERAL unnest(music_genre_tags(t.custom_metadata)) AS g(tag)
                JOIN variant_map vm ON vm.tag = g.tag
                WHERE t.media_type = 'track'
                  AND t.has_files = true
                  AND EXISTS (
                      SELECT 1 FROM media_audio_embeddings e
                      WHERE e.media_id = t.id AND e.model_id = ${MSCLAP_MODEL_ID}
                  )
            ),
            counts AS (
                SELECT genre_key,
                       COUNT(*)::int                    AS track_count,
                       COUNT(DISTINCT parent_id)::int   AS album_count
                FROM pairs
                GROUP BY genre_key
                HAVING COUNT(*) >= ${MIN_TRACKS_FOR_CENTROID}
            ),
            means AS (
                SELECT p.genre_key, AVG(e.embedding) AS mean
                FROM pairs p
                JOIN counts c ON c.genre_key = p.genre_key
                JOIN media_audio_embeddings e
                  ON e.media_id = p.media_id AND e.model_id = ${MSCLAP_MODEL_ID}
                GROUP BY p.genre_key
            )
            INSERT INTO music_genre_centroids
                (genre_key, model_id, display_name, variants, track_count, album_count, centroid)
            SELECT c.genre_key, ${MSCLAP_MODEL_ID}, w.display_name, w.variants,
                   c.track_count, c.album_count,
                   (m.mean - gm.global_mean)::vector(1024)
            FROM counts c
            JOIN means m ON m.genre_key = c.genre_key
            JOIN wanted w ON w.genre_key = c.genre_key
            CROSS JOIN (
                SELECT global_mean FROM music_sonic_model_stats
                WHERE model_id = ${MSCLAP_MODEL_ID}
            ) gm
            RETURNING genre_key
        `;

        return {
            centroids: inserted.length,
            corpusTracks: Number.parseInt(meanRow.track_count, 10) || 0,
        };
    });
}

/**
 * The single best zero-play genre for this viewer, or null.
 *
 * `candidateKeys` must already exclude genres the viewer plays and genres they
 * cannot see — the caller has both sets in the ranker's cached payload, so this
 * costs no extra query.
 *
 * Deliberately NOT built on `computeSonicTasteVector`: that returns a
 * normalised, Rocchio-adjusted vector (positive centroid minus 0.4x the
 * negative). Rocchio subtracts the user's DISLIKES; what makes genre cosine
 * meaningful here is subtracting the LIBRARY's mean. Mixing the two compares
 * vectors from different spaces — it would look tidier and be wrong.
 */
export async function getUserGenreAdjacency(
    sql: postgres.Sql,
    userId: string,
    candidateKeys: string[],
    access: MediaAccessBoundary,
): Promise<GenreAdjacencyRow | null> {
    if (candidateKeys.length === 0) return null;
    if (deniesEverything(access)) return null;

    const deniedGroupIds: string[] | null =
        access.library.kind === 'denyGroups' ? access.library.ids : null;
    const ageRating: AgeRatingFilterParams | null =
        access.age.kind === 'limit'
            ? { maxAgeRating: access.age.maxAgeRating, allowUnrated: access.age.allowUnrated }
            : null;

    // The seed set is the viewer's own completed listening; scope it anyway so a
    // track they have since lost access to cannot steer the recommendation.
    const accessFilter = deniedGroupIds?.length
        ? sql`AND (
              NOT EXISTS (SELECT 1 FROM media_file_items WHERE media_item_id = t.id)
              OR EXISTS (
                  SELECT 1 FROM media_file_items mfi2
                  JOIN media_files mf2 ON mf2.id = mfi2.file_id
                  WHERE mfi2.media_item_id = t.id
                  AND (mf2.library_group_id IS NULL
                       OR mf2.library_group_id != ALL(${deniedGroupIds}::uuid[]))
              )
          )`
        : sql``;
    const ageFilter =
        ageRating && ageRating.maxAgeRating !== null
            ? sql`AND (
                (t.age_rating IS NULL AND ${ageRating.allowUnrated}::boolean)
                OR t.age_rating <= ${ageRating.maxAgeRating}
            )`
            : sql``;

    const rows = await sql<
        {
            genre_key: string;
            display_name: string;
            variants: string[];
            sim: number;
            seed_count: string;
        }[]
    >`
        WITH gmean AS (
            SELECT global_mean AS m FROM music_sonic_model_stats
             WHERE model_id = ${MSCLAP_MODEL_ID}
        ),
        seeds AS (
            SELECT ums.track_id
            FROM user_music_state ums
            JOIN media_items t ON t.id = ums.track_id AND t.media_type = 'track'
            WHERE ums.user_id = ${userId}::uuid
              AND ums.complete_count > 0
              AND t.has_files = true
              ${accessFilter}
              ${ageFilter}
            ORDER BY ums.last_played_at DESC
            LIMIT ${TASTE_SEED_LIMIT}
        ),
        taste AS (
            SELECT (AVG(e.embedding) - gmean.m)::vector(1024) AS v, COUNT(*)::int AS n
            FROM seeds s
            JOIN media_audio_embeddings e
              ON e.media_id = s.track_id AND e.model_id = ${MSCLAP_MODEL_ID}
            CROSS JOIN gmean
            GROUP BY gmean.m
            HAVING COUNT(*) >= ${MIN_COMPLETES_FOR_ADJACENCY}
        )
        SELECT c.genre_key,
               c.display_name,
               c.variants,
               (1 - (c.centroid <=> taste.v))::double precision AS sim,
               taste.n::text AS seed_count
        FROM music_genre_centroids c, taste
        WHERE c.model_id = ${MSCLAP_MODEL_ID}
          AND c.genre_key = ANY(${candidateKeys}::text[])
        ORDER BY c.centroid <=> taste.v
        LIMIT 1
    `;

    const row = rows[0];
    if (!row) return null;
    if (row.sim < MIN_ADJACENCY_SIMILARITY) return null;

    return {
        genreKey: row.genre_key,
        displayName: row.display_name,
        variants: row.variants,
        similarity: row.sim,
        seedCount: Number.parseInt(row.seed_count, 10) || 0,
    };
}
