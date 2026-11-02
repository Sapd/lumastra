// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Text-to-Sound Search Query Module
 *
 * kNN search over `media_audio_embeddings` using a CLAP text vector instead of
 * a seed-track audio vector. Because CLAP is a joint audio+text model, the text
 * vector from embed_text.py lives in the same 1024-dim cosine space as the
 * stored audio vectors — direct <=> comparison is valid and uses the HNSW index.
 *
 * All functions take `sql: postgres.Sql` as first parameter and have no side effects.
 *
 * HNSW index: `media_audio_embeddings` uses `vector_cosine_ops`, so queries MUST
 * use `<=>` (cosine distance) — never `<->` (L2) or `<#>` (inner product).
 *
 * @module queries/text-sound-search
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
} from './fragments/music-artist.fragments.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Canonical model identifier — matches every row in media_audio_embeddings. */
const MODEL_ID = MSCLAP_MODEL_ID;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single row returned by {@link textSoundSearch}. */
export interface TextSoundSearchRow {
    /** Internal UUID of the track (`media_items.id`). */
    media_id: string;
    /**
     * Cosine similarity in [0, 1]: 1 = identical, 0 = orthogonal.
     * Derived from cosine *distance* (`embedding <=> text_vec`) as `1 - distance`.
     */
    similarity_score: number;
    title: string;
    custom_poster_url: string | null;
    album_custom_poster_url?: string | null;
    custom_metadata: Record<string, unknown>;
    runtime_seconds: number | null;
    artist_title: string | null;
    track_artists?: Array<{ id: string | null; title: string }> | null;
    remixer_artists?: Array<{ id: string | null; title: string }> | null;
    album_id: string | null;
    album_title: string | null;
    /**
     * Year stamped on the parent album row, or null.
     *
     * NOT the recording/release year, and NOT usable as one. `media_items.year`
     * for an album comes from the audio file's own date tag (the file scanner's
     * `tags.year ?? extractYearFromFolder(...)`), and there is no provider
     * enrichment for music anywhere in this pipeline — so it is the year of
     * THIS pressing. On production: Yes - Fragile (1971) stores 2024, Toto -
     * Hydra (1979) stores 2020, Nirvana - Bleach (1989) stores 2013; 64% of
     * albums claim 2010 or later. Do not build a decade filter on it and do not
     * surface it to a model that is allowed to repeat what a tool returned.
     */
    album_edition_year: number | null;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * kNN search over `media_audio_embeddings` using a CLAP text embedding.
 *
 * Algorithm:
 *   1. Receive the 1024-dim text vector produced by embed_text.py.
 *   2. Format it as the pgvector literal `'[f1,f2,...,f1024]'::vector`.
 *   3. Find the `limit` nearest audio embeddings via the HNSW `<=>` index.
 *   4. Join back to `media_items` for display metadata.
 *   5. Apply library-group and age-rating access filters from `access`.
 *
 * The boundary is REQUIRED — there is no permissive default. A caller that
 * genuinely wants unfiltered results must construct `unrestrictedAccess()`
 * explicitly so the decision is greppable; a caller holding a
 * `SearchAccessContext` should project it via `searchAccessBoundary(ctx)`
 * rather than hand-rebuilding a two-field literal (dropping a field there
 * silently widened access under the old shape).
 *
 * A `denyAll` boundary short-circuits to `[]` before any SQL is issued. That
 * matters more here than elsewhere: the boundary predicates are evaluated
 * alongside the `ORDER BY embedding <=> vec LIMIT n` HNSW scan, and a
 * never-satisfiable predicate can make the planner walk the whole index
 * hunting for `limit` survivors that do not exist.
 *
 * Both filters intentionally gate the TRACK row only (`mi`). The `album` /
 * `artist` LEFT JOINs are parents reached via `mi.parent_id` whose titles are
 * pure display decoration on an already-gated track — gating them would change
 * which rows return.
 *
 * @param sql    - postgres.Sql instance (parameterized — no sql.unsafe).
 * @param vector - 1024-element float array from the CLAP text encoder.
 * @param limit  - Maximum number of results to return.
 * @param access - REQUIRED media access boundary.
 */
export async function textSoundSearch(
    sql: postgres.Sql,
    vector: number[],
    limit: number,
    access: MediaAccessBoundary,
): Promise<TextSoundSearchRow[]> {
    if (deniesEverything(access)) return [];

    // Format the text vector as a pgvector literal.
    // The HNSW index requires the cast to ::vector so the index is used.
    // We use a string literal in sql`` (not sql.unsafe) — the array values
    // come from the Python embedder and are floats, not user input, but we
    // still build the literal safely via join() rather than template injection.
    const vectorLiteral = `[${vector.join(',')}]`;

    return sql<TextSoundSearchRow[]>`
        SELECT
            mae.media_id::text                                              AS media_id,
            1 - (mae.embedding <=> ${vectorLiteral}::vector)               AS similarity_score,
            mi.title,
            mi.custom_poster_url,
            album.custom_poster_url AS album_custom_poster_url,
            COALESCE(mi.custom_metadata, '{}'::jsonb)                      AS custom_metadata,
            mi.runtime_seconds,
            ${trackDisplayArtistSql(sql, 'mi')}                            AS artist_title,
            ${trackArtistsSql(sql, 'mi')} AS track_artists,
            ${trackRemixerArtistsSql(sql, 'mi')} AS remixer_artists,
            album.id::text                                                 AS album_id,
            album.title                                                    AS album_title,
            album.year                                                     AS album_edition_year
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
        WHERE mae.model_id = ${MODEL_ID}
        ${buildLibraryAccessFilter(sql, access.library)}
        ${buildAgeRatingFilter(sql, access.age)}
        ORDER BY mae.embedding <=> ${vectorLiteral}::vector ASC
        LIMIT ${limit}
    `;
}
