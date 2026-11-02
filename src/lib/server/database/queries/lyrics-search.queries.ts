// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Lyrics Search Query Module
 *
 * Pure SQL kNN search over `media_lyrics_embeddings` using the HNSW cosine
 * index. The query embedding must be computed by the caller using the SAME
 * text-embedding model/dimension that was used to stamp the column — calling
 * `resolveEffectiveEmbedding()` from `ai/embedding-models.ts` at runtime is
 * the guarantee (same pure function used by the migration DDL).
 *
 * All functions take `sql: postgres.Sql` as first param and have no side
 * effects. Access scoping mirrors the sonic-similarity pattern.
 *
 * @module queries/lyrics-search
 */

import type postgres from 'postgres';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import {
    trackDisplayArtistSql,
    trackArtistsSql,
    trackRemixerArtistsSql,
} from './fragments/music-artist.fragments.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Source tag used when ingesting .lrc sidecar files. */
export const LYRICS_SOURCE_LRC_SIDECAR = 'lrc-sidecar';

/**
 * Source tag used when ingesting lyrics fetched from LRCLIB (stored in
 * `custom_metadata.lyrics` by the lyrics-lrclib-fetch task).
 */
export const LYRICS_SOURCE_DB_FETCH = 'db-fetch';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single row returned by {@link searchByLyricsEmbedding}. */
export interface LyricsSearchRow {
    /** Internal UUID of the track (`media_items.id`). */
    media_id: string;
    /**
     * Cosine similarity in [0, 1]: 1 = identical, 0 = orthogonal.
     * Derived from cosine *distance* (`embedding <=> query`) as `1 - distance`.
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
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * kNN similarity search over `media_lyrics_embeddings`.
 *
 * The query vector must have the same dimension as the column (stamped at
 * migration time by `getLyricsEmbeddingDimension()`). Passing a mismatched
 * vector produces a pgvector dimension error at query time.
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
 * alongside the `ORDER BY embedding <=> vec LIMIT n` HNSW scan, so a
 * never-satisfiable predicate would make the planner walk the whole index
 * hunting for `limit` survivors that do not exist.
 *
 * Both filters intentionally gate the TRACK row only (`mi`). The `album` /
 * `artist` LEFT JOINs are parents reached via `mi.parent_id` whose titles are
 * pure display decoration on an already-gated track — gating them would change
 * which rows return.
 *
 * @param sql        - postgres.Sql instance (parameterized — no sql.unsafe).
 * @param embedding  - Query vector (number[]) from `generateVoyageQueryEmbedding`.
 * @param limit      - Maximum number of results to return.
 * @param access     - REQUIRED media access boundary.
 */
export async function searchByLyricsEmbedding(
    sql: postgres.Sql,
    embedding: number[],
    limit: number,
    access: MediaAccessBoundary,
): Promise<LyricsSearchRow[]> {
    if (deniesEverything(access)) return [];

    // Serialize the embedding vector using the established idiom:
    // '[v1,v2,...]'::vector — pgvector inserts use this string idiom, see
    // mood-vector.service.ts and sonic-similarity.queries.ts. Parameterized
    // values cannot be used inside the ::vector cast; the string is built from
    // a validated number[] (never user-supplied text), so there is no injection
    // risk.
    const vectorLiteral = `[${embedding.join(',')}]`;

    return sql<LyricsSearchRow[]>`
        SELECT
            mle.media_id::text                                              AS media_id,
            1 - (mle.embedding <=> ${vectorLiteral}::vector)               AS similarity_score,
            mi.title,
            mi.custom_poster_url,
            album.custom_poster_url AS album_custom_poster_url,
            COALESCE(mi.custom_metadata, '{}'::jsonb)                      AS custom_metadata,
            mi.runtime_seconds,
            ${trackDisplayArtistSql(sql, 'mi')}                            AS artist_title,
            ${trackArtistsSql(sql, 'mi')} AS track_artists,
            ${trackRemixerArtistsSql(sql, 'mi')} AS remixer_artists,
            album.id::text                                                 AS album_id,
            album.title                                                    AS album_title
        FROM media_lyrics_embeddings mle
        JOIN media_items mi
               ON mi.id = mle.media_id
              AND mi.media_type = 'track'
              AND mi.has_files = true
        LEFT JOIN media_items album
               ON album.id = mi.parent_id
              AND album.media_type = 'album'
        LEFT JOIN media_items artist
               ON artist.id = album.parent_id
              AND artist.media_type = 'artist'
        WHERE TRUE
        ${buildLibraryAccessFilter(sql, access.library)}
        ${buildAgeRatingFilter(sql, access.age)}
        ORDER BY mle.embedding <=> ${vectorLiteral}::vector ASC
        LIMIT ${limit}
    `;
}

// ---------------------------------------------------------------------------
// Ingestion state helpers
// ---------------------------------------------------------------------------

/** Valid ingestion state values for `media_lyrics_embedding_state.status`. */
export type LyricsEmbeddingStatus = 'pending' | 'processing' | 'done' | 'failed' | 'no_lyrics';

export interface PendingLyricsTrackRow {
    media_item_id: string;
    file_path: string;
    /**
     * Plain-text lyrics fetched from LRCLIB (stored by the lyrics-lrclib-fetch task
     * in `custom_metadata.lyrics.plain`). Null when no DB-fetched lyrics exist.
     * Used as fallback when no .lrc sidecar file is present on disk.
     */
    db_plain_lyrics: string | null;
    /**
     * Synced LRC lyrics from LRCLIB (`custom_metadata.lyrics.synced`).
     * Only present when the LRCLIB response included timestamped lyrics.
     * Preferred over plain lyrics when available (timestamps are stripped
     * by the backfill task before embedding, same as .lrc sidecar handling).
     */
    db_synced_lyrics: string | null;
}

/**
 * Fetch the next batch of tracks that need lyrics embedding.
 *
 * Eligible when:
 *   - media_items.media_type = 'track'
 *   - Has a media_files row with a non-missing file_path
 *   - Does NOT have a 'done' or 'no_lyrics' row in media_lyrics_embedding_state
 *
 * Also returns `db_plain_lyrics` / `db_synced_lyrics` from `custom_metadata.lyrics`
 * so the ingestion task can fall back to DB-fetched LRCLIB lyrics when no .lrc
 * sidecar is present on disk.
 */
export async function fetchPendingLyricsTracks(
    sql: postgres.Sql,
    limit: number,
): Promise<PendingLyricsTrackRow[]> {
    return sql<PendingLyricsTrackRow[]>`
        SELECT DISTINCT ON (mfi.media_item_id)
            mfi.media_item_id::text AS media_item_id,
            mf.file_path,
            mi.custom_metadata->'lyrics'->>'plain'   AS db_plain_lyrics,
            mi.custom_metadata->'lyrics'->>'synced'  AS db_synced_lyrics
        FROM media_file_items mfi
        JOIN media_files mf
          ON mf.id = mfi.file_id
        JOIN media_items mi
          ON mi.id = mfi.media_item_id
        WHERE mi.media_type = 'track'
          AND mf.file_path IS NOT NULL
          AND NOT mf.is_missing
          AND NOT EXISTS (
              SELECT 1
              FROM media_lyrics_embedding_state s
              WHERE s.media_id = mfi.media_item_id
                AND s.status IN ('done', 'no_lyrics')
          )
        ORDER BY mfi.media_item_id
        LIMIT ${limit}
    `;
}

/**
 * Upsert a lyrics embedding vector for a track.
 * Uses the pgvector string-literal idiom: `'[v1,v2,...]'::vector`.
 */
export async function upsertLyricsEmbedding(
    sql: postgres.Sql,
    mediaId: string,
    embedding: number[],
    source: string,
): Promise<void> {
    const vector = `[${embedding.join(',')}]`;
    await sql`
        INSERT INTO media_lyrics_embeddings (media_id, source, embedding, created_at)
        VALUES (${mediaId}::uuid, ${source}, ${vector}::vector, now())
        ON CONFLICT (media_id, source)
        DO UPDATE SET embedding   = EXCLUDED.embedding,
                      created_at  = EXCLUDED.created_at
    `;
}

/**
 * Upsert the ingestion state for a track.
 */
export async function upsertLyricsEmbeddingState(
    sql: postgres.Sql,
    mediaId: string,
    status: LyricsEmbeddingStatus,
): Promise<void> {
    await sql`
        INSERT INTO media_lyrics_embedding_state
            (media_id, status, processing_version, updated_at)
        VALUES
            (${mediaId}::uuid, ${status}, 1, now())
        ON CONFLICT (media_id)
        DO UPDATE SET status             = EXCLUDED.status,
                      updated_at         = EXCLUDED.updated_at
    `;
}
