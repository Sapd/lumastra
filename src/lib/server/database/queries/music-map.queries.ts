// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music Map Query Module
 *
 * Pure SQL queries for the Music Map feature (/music/map).
 * Reads from media_audio_map_coords + media_items, access-scoped.
 *
 * All functions take `sql: postgres.Sql` as first parameter and have no side
 * effects.  Writes use upsert helpers called from the Node task only.
 *
 * @module queries/music-map
 */

import type postgres from 'postgres';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { MSCLAP_MODEL_ID } from './sonic-constants.js';
import { trackDisplayArtistSql } from './fragments/music-artist.fragments.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Projection model identifier — must match the Python script's MODEL_ID. */
export const MAP_MODEL_ID = MSCLAP_MODEL_ID;

// ---------------------------------------------------------------------------
// Access boundary contract (read before touching any query text here)
// ---------------------------------------------------------------------------
//
// Both read queries take a REQUIRED {@link MediaAccessBoundary}. There is no
// permissive default: a caller that wants unfiltered rows must say so with
// `unrestrictedAccess()`, which makes the decision greppable.
//
// ALIAS CONTRACT. `buildLibraryAccessFilter` hardcodes `mi.id` in both of its
// correlated subqueries and `buildAgeRatingFilter` defaults its alias to `mi`.
// Neither splice site below passes an alias override, so the candidate
// `media_items` row MUST be aliased `mi` — it is, in both queries.
//
// `getMapPoints` additionally LEFT JOINs `media_items` twice more (`album`,
// `artist`). Those aliases are deliberately NOT access-filtered: extending the
// boundary to them would change which rows a restricted caller sees, which this
// migration must not do. (They are also dead — `artist_title` comes from
// `trackDisplayArtistSql(sql, 'mi')` — but removing them is a separate change.)
//
// FRAGMENT POSITION. Both builders emit a bare leading `AND`, so every splice
// site must sit after a real WHERE predicate. `getMapPoints` splices after
// `WHERE mc.model_id = ...` and `countSonicEmbeddingCoverage` after
// `WHERE mi.media_type = 'track' AND ...`. Do not move them to the head of a
// WHERE clause; a denyAll boundary would emit a syntactically invalid bare
// `AND false`.
//
// DENY-ALL. Each query short-circuits before issuing SQL. That is equivalent to
// the `AND false` both builders would emit (an empty point list; `count(*)` over
// zero rows is 0), and skips a guaranteed-empty round trip. The short-circuit
// also lets callers that cache results detect the case and avoid sharing a
// cache entry with an unrestricted caller — see defs/music/map.ts.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single map point returned by {@link getMapPoints}. */
export interface MapPointRow {
    /** Internal UUID of the track. */
    media_id: string;
    /** Normalised X coordinate [0, 1]. */
    x: number;
    /** Normalised Y coordinate [0, 1]. */
    y: number;
    /** Track title. */
    title: string;
    /** Artist name (resolved from album parent or custom_metadata). */
    artist_title: string | null;
    /**
     * Dominant mood tag from custom_metadata.essentia.mood_tags[0].
     * Used to colour the dot via moodToColor().
     */
    top_mood: string | null;
    /** Cover art URL for tooltip display. */
    custom_poster_url: string | null;
}

/** Input for {@link upsertMapCoords} — one projected point. */
export interface MapCoordInput {
    mediaId: string;
    x: number;
    y: number;
}

// ---------------------------------------------------------------------------
// Read query
// ---------------------------------------------------------------------------

/**
 * Fetch all map points for the current projection model, access-scoped.
 *
 * Only returns tracks that:
 *   - Have a coord row in media_audio_map_coords for MAP_MODEL_ID.
 *   - Are media_type='track', has_files=true, status='active'.
 *   - Pass the caller's library-group and age-rating access filters.
 *
 * @param sql    - postgres.Sql instance.
 * @param access - REQUIRED access boundary. Use `searchAccessBoundary(ctx)` for
 *                 a real user, or `unrestrictedAccess()` to opt out explicitly.
 */
export async function getMapPoints(
    sql: postgres.Sql,
    access: MediaAccessBoundary,
): Promise<MapPointRow[]> {
    if (deniesEverything(access)) return [];

    return sql<MapPointRow[]>`
        SELECT
            mc.media_id::text                                               AS media_id,
            mc.x,
            mc.y,
            mi.title,
            ${trackDisplayArtistSql(sql, 'mi')}                             AS artist_title,
            -- Colour key for the dot. Prefer a real Essentia mood tag if present
            -- (rare — needs the licensed Gaia high-level models), then the track's
            -- first GENRE (custom_metadata->'genre' is a singular array, ~96%
            -- coverage on real libraries), then the nearest SONIC mood vector
            -- (model_id=MAP_MODEL_ID) as a last resort. The frontend maps whatever
            -- this returns through labelToColor() so genres get stable hues.
            COALESCE(
                NULLIF(mi.custom_metadata->'essentia'->'mood_tags'->>0, ''),
                NULLIF(mi.custom_metadata->'genre'->>0, ''),
                sonic_mood.mood_key
            )                                                              AS top_mood,
            mi.custom_poster_url
        FROM media_audio_map_coords mc
        JOIN media_items mi
               ON mi.id = mc.media_id
              AND mi.media_type = 'track'
              AND mi.has_files = true
              AND mi.status = 'active'
        LEFT JOIN media_audio_embeddings mae
               ON mae.media_id = mc.media_id
              AND mae.model_id = ${MAP_MODEL_ID}
        LEFT JOIN LATERAL (
                   SELECT mv.mood_key
                   FROM mood_vectors mv
                   WHERE mv.model_id = ${MAP_MODEL_ID}
                   ORDER BY mae.embedding <=> mv.vector
                   LIMIT 1
            ) sonic_mood ON mae.embedding IS NOT NULL
        LEFT JOIN media_items album
               ON album.id = mi.parent_id
              AND album.media_type = 'album'
        LEFT JOIN media_items artist
               ON artist.id = album.parent_id
              AND artist.media_type = 'artist'
        WHERE mc.model_id = ${MAP_MODEL_ID}
        ${buildLibraryAccessFilter(sql, access.library)}
        ${buildAgeRatingFilter(sql, access.age)}
        ORDER BY mc.media_id
    `;
}

/** Result of {@link countSonicEmbeddingCoverage}. */
export interface SonicCoverageRow {
    /** Accessible music tracks that have a row in media_audio_embeddings. */
    embedded: number;
    /** Total accessible music tracks (the backfill denominator). */
    total: number;
}

/**
 * Count sonic-embedding coverage for the accessible music library.
 *
 * Returns `{ embedded, total }` where:
 *   - `total`    = accessible `media_type='track'` rows (has_files, active),
 *   - `embedded` = of those, how many have a media_audio_embeddings row for
 *                  the current MSCLAP model.
 *
 * Uses the SAME access scoping as {@link getMapPoints} (library-group + age
 * filters keyed off the `mi` alias) so the progress bar denominator matches
 * what the caller can actually see on the map.
 *
 * NOTE: `total` is access-scoped, so a denyAll caller gets `{ embedded: 0,
 * total: 0 }`. Anything dividing by `total` for a progress bar must guard the
 * zero case (the /music/map page does — it gates on `totalTracks > 0`).
 *
 * @param sql    - postgres.Sql instance.
 * @param access - REQUIRED access boundary. Use `searchAccessBoundary(ctx)` for
 *                 a real user, or `unrestrictedAccess()` to opt out explicitly.
 */
export async function countSonicEmbeddingCoverage(
    sql: postgres.Sql,
    access: MediaAccessBoundary,
): Promise<SonicCoverageRow> {
    if (deniesEverything(access)) return { embedded: 0, total: 0 };

    const rows = await sql<{ embedded: string; total: string }[]>`
        SELECT
            count(*) FILTER (WHERE mae.media_id IS NOT NULL) AS embedded,
            count(*)                                         AS total
        FROM media_items mi
        LEFT JOIN media_audio_embeddings mae
               ON mae.media_id = mi.id
              AND mae.model_id = ${MAP_MODEL_ID}
        WHERE mi.media_type = 'track'
          AND mi.has_files = true
          AND mi.status = 'active'
        ${buildLibraryAccessFilter(sql, access.library)}
        ${buildAgeRatingFilter(sql, access.age)}
    `;

    return {
        embedded: parseInt(rows[0]?.embedded ?? '0', 10),
        total: parseInt(rows[0]?.total ?? '0', 10),
    };
}

// ---------------------------------------------------------------------------
// Write helpers (called from the sonic-map-projection task only)
// ---------------------------------------------------------------------------

/**
 * Upsert a batch of map coordinates.  Idempotent — replaces x, y, and
 * computed_at when a row for the same (media_id, model_id) already exists.
 *
 * Uses the established pgvector/JSONB idiom: build the VALUES list and
 * execute a single multi-row INSERT for efficiency.
 *
 * @param sql    - postgres.Sql instance.
 * @param coords - Array of (mediaId, x, y) tuples.
 */
export async function upsertMapCoords(sql: postgres.Sql, coords: MapCoordInput[]): Promise<void> {
    if (coords.length === 0) return;

    // postgres.js tagged-template bulk insert.
    await sql`
        INSERT INTO media_audio_map_coords (media_id, model_id, x, y, computed_at)
        SELECT
            input.media_id::uuid,
            ${MAP_MODEL_ID},
            input.x::real,
            input.y::real,
            now()
        FROM (VALUES ${sql(coords.map((c) => [c.mediaId, c.x, c.y]))}) AS input(media_id, x, y)
        ON CONFLICT (media_id)
        DO UPDATE SET
            model_id    = EXCLUDED.model_id,
            x           = EXCLUDED.x,
            y           = EXCLUDED.y,
            computed_at = EXCLUDED.computed_at
    `;
}

/**
 * Delete all map coords for the current model.
 * Called at the start of a projection run to ensure stale points are removed.
 */
export async function clearMapCoords(sql: postgres.Sql): Promise<void> {
    await sql`
        DELETE FROM media_audio_map_coords
        WHERE model_id = ${MAP_MODEL_ID}
    `;
}

/**
 * Count how many map coords exist for the current model.
 * Used by the API to decide whether to return data or the empty-state, and by
 * the sonic-map-projection task to log how many points it wrote.
 *
 * DELIBERATELY UNSCOPED — takes no {@link MediaAccessBoundary}. It counts rows
 * in `media_audio_map_coords` alone and never joins `media_items`, so there is
 * no `mi` alias for the boundary builders to attach to.
 *
 * KNOWN (pre-existing, count-only) LEAK: `defs/music/map.ts` falls back to this
 * global count for `projectedCount` when a caller's own point list is empty, so
 * a fully-restricted user learns the size of the global projection. Preserved
 * verbatim here because closing it changes what a restricted user is shown,
 * which the access-boundary migration must not do. Fix it separately.
 */
export async function countMapCoords(sql: postgres.Sql): Promise<number> {
    const rows = await sql<{ count: string }[]>`
        SELECT count(*) AS count
        FROM media_audio_map_coords
        WHERE model_id = ${MAP_MODEL_ID}
    `;
    return parseInt(rows[0]?.count ?? '0', 10);
}
