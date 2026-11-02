// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Read queries behind the /j music endpoints: Instant Mix, Albums/Artists
 * Similar and the by-name artist lookup.
 *
 * Every function takes a REQUIRED {@link MediaAccessBoundary} and applies it to
 * the CANDIDATE track (`mi`), the same contract `sonic-similarity.queries.ts`
 * documents: seed centroids are computed over the seed's own tracks (the caller
 * gates the seed with `checkMediaAccess` first), the boundary filters what
 * comes back. Functions return ids only; the routes hydrate them through
 * `browseMediaItems`, which applies the boundary a second time.
 */

import type postgres from 'postgres';
import { buildLibraryAccessFilter } from '$lib/server/database/queries/builders/library-access.builder.js';
import { buildAgeRatingFilter } from '$lib/server/database/queries/builders/age-rating.builder.js';
import { buildMetadataLateralJoinFragment } from '$lib/server/database/queries/builders/provider-metadata.builder.js';
import { deniesEverything } from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { buildArtistLibraryAccessFilter } from './artists-query';

/** At most this many seed tracks feed a centroid (an artist can own thousands). */
const MAX_SEED_TRACKS = 500;

function accessFragment(sql: postgres.Sql, access: MediaAccessBoundary) {
    return sql`${buildLibraryAccessFilter(sql, access.library)} ${buildAgeRatingFilter(sql, access.age)}`;
}

/** Accessible, playable tracks of an album, in disc/track order. */
export async function getAlbumTrackIds(
    sql: postgres.Sql,
    albumId: string,
    access: MediaAccessBoundary,
): Promise<string[]> {
    if (deniesEverything(access)) return [];
    const rows = await sql<{ id: string }[]>`
        SELECT mi.id::text AS id
        FROM media_items mi
        WHERE mi.parent_id = ${albumId}::uuid
          AND mi.media_type = 'track'
          AND mi.status = 'active'
          AND mi.has_files = true
          ${accessFragment(sql, access)}
        ORDER BY mi.sort_order NULLS LAST, mi.title
        LIMIT ${MAX_SEED_TRACKS}
    `;
    return rows.map((r) => r.id);
}

/** Accessible, playable tracks on an artist's albums. */
export async function getArtistTrackIds(
    sql: postgres.Sql,
    artistId: string,
    access: MediaAccessBoundary,
): Promise<string[]> {
    if (deniesEverything(access)) return [];
    const rows = await sql<{ id: string }[]>`
        SELECT mi.id::text AS id
        FROM media_items album
        JOIN media_items mi ON mi.parent_id = album.id AND mi.media_type = 'track'
        WHERE album.parent_id = ${artistId}::uuid
          AND album.media_type = 'album'
          AND mi.status = 'active'
          AND mi.has_files = true
          ${accessFragment(sql, access)}
        ORDER BY album.year NULLS LAST, album.title, mi.sort_order NULLS LAST
        LIMIT ${MAX_SEED_TRACKS}
    `;
    return rows.map((r) => r.id);
}

/**
 * Nearest tracks to the centroid of the seed tracks' music embeddings
 * (`media_embeddings.source = 'music'`, the space `getSimilarTracks` and the
 * Subsonic similar-songs endpoints use). Empty when no seed has an embedding.
 *
 * The probe MUST be a `CROSS JOIN LATERAL` with the `ORDER BY <=>` inside it:
 * with the centroid on the other side of a plain join the planner cannot use
 * the HNSW index and falls back to a full scan + sort of every music embedding
 * per mix (music.queries.ts, getPlaylistSuggestionsFull's pool CTE: seq ~147 ms
 * vs parameterised HNSW scan ~3 ms on prod). The access, playability and
 * exclusion filters sit inside the lateral too, so its LIMIT counts only rows
 * the caller may get; HNSW post-filters, so ef_search is over-fetched to cover
 * what they remove.
 */
export async function findTracksNearSeeds(
    sql: postgres.Sql,
    seedTrackIds: string[],
    limit: number,
    excludeIds: string[],
    access: MediaAccessBoundary,
): Promise<string[]> {
    if (deniesEverything(access) || seedTrackIds.length === 0 || limit <= 0) return [];
    const seeds = seedTrackIds.slice(0, MAX_SEED_TRACKS);
    const exclude = [...new Set([...seeds, ...excludeIds])];
    // Over-fetch: twice the page plus everything excluded, within pgvector's cap.
    const efSearch = Math.min(1000, Math.max(64, limit * 2 + Math.min(exclude.length, 500)));
    return sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await tx`SELECT set_config('hnsw.ef_search', ${String(efSearch)}, true)`;
        const rows = await tx<{ id: string }[]>`
            WITH centroid AS (
                SELECT AVG(me.embedding) AS vec
                FROM media_embeddings me
                WHERE me.media_id = ANY(${seeds}::uuid[])
                  AND me.source = 'music'
            )
            SELECT near.id
            FROM centroid
            CROSS JOIN LATERAL (
                SELECT mi.id::text AS id, me.embedding <=> centroid.vec AS distance
                FROM media_embeddings me
                JOIN media_items mi ON mi.id = me.media_id
                WHERE me.source = 'music'
                  AND mi.media_type = 'track'
                  AND mi.status = 'active'
                  AND mi.has_files = true
                  AND mi.id != ALL(${exclude}::uuid[])
                  ${accessFragment(sql, access)}
                ORDER BY me.embedding <=> centroid.vec
                LIMIT ${limit}
            ) near
            WHERE centroid.vec IS NOT NULL
            ORDER BY near.distance
        `;
        return rows.map((r) => r.id);
    });
}

/**
 * The seed tracks' genre tags, most frequent first (lowercased by
 * `music_genre_tags`, which is also what `getTracksByGenre` matches on).
 */
export async function getTopGenresForTracks(
    sql: postgres.Sql,
    trackIds: string[],
    limit = 5,
): Promise<string[]> {
    if (trackIds.length === 0) return [];
    const rows = await sql<{ genre: string }[]>`
        SELECT g AS genre
        FROM media_items mi
        CROSS JOIN LATERAL unnest(music_genre_tags(mi.custom_metadata)) AS g
        WHERE mi.id = ANY(${trackIds.slice(0, MAX_SEED_TRACKS)}::uuid[])
          AND g <> ''
        GROUP BY g
        ORDER BY COUNT(*) DESC, g
        LIMIT ${limit}
    `;
    return rows.map((r) => r.genre);
}

/** Random accessible, playable tracks: Jellyfin's mix for a seed with no genres. */
export async function findRandomTrackIds(
    sql: postgres.Sql,
    limit: number,
    excludeIds: string[],
    access: MediaAccessBoundary,
): Promise<string[]> {
    if (deniesEverything(access) || limit <= 0) return [];
    const rows = await sql<{ id: string }[]>`
        SELECT mi.id::text AS id
        FROM media_items mi
        WHERE mi.media_type = 'track'
          AND mi.status = 'active'
          AND mi.has_files = true
          AND mi.id != ALL(${excludeIds}::uuid[])
          ${accessFragment(sql, access)}
        ORDER BY RANDOM()
        LIMIT ${limit}
    `;
    return rows.map((r) => r.id);
}

/**
 * Albums sharing the most genre tags with the seed album, counted over
 * accessible tracks. The fallback for Albums/{id}/Similar when the library has
 * no sonic embeddings.
 */
export async function findAlbumsByGenreOverlap(
    sql: postgres.Sql,
    albumId: string,
    limit: number,
    access: MediaAccessBoundary,
): Promise<string[]> {
    if (deniesEverything(access) || limit <= 0) return [];
    const rows = await sql<{ id: string }[]>`
        WITH seed AS (
            SELECT DISTINCT g
            FROM media_items t
            CROSS JOIN LATERAL unnest(music_genre_tags(t.custom_metadata)) AS g
            WHERE t.parent_id = ${albumId}::uuid AND t.media_type = 'track' AND g <> ''
        )
        SELECT album.id::text AS id
        FROM media_items mi
        JOIN media_items album ON album.id = mi.parent_id AND album.media_type = 'album'
        CROSS JOIN LATERAL unnest(music_genre_tags(mi.custom_metadata)) AS g
        WHERE mi.media_type = 'track'
          AND mi.status = 'active'
          AND mi.has_files = true
          AND album.id != ${albumId}::uuid
          AND g IN (SELECT g FROM seed)
          ${accessFragment(sql, access)}
        GROUP BY album.id
        ORDER BY COUNT(DISTINCT g) DESC, COUNT(*) DESC, album.id
        LIMIT ${limit}
    `;
    return rows.map((r) => r.id);
}

/** Artists sharing the most genre tags with the seed artist (accessible tracks only). */
export async function findArtistsByGenreOverlap(
    sql: postgres.Sql,
    artistId: string,
    limit: number,
    access: MediaAccessBoundary,
): Promise<string[]> {
    if (deniesEverything(access) || limit <= 0) return [];
    const rows = await sql<{ id: string }[]>`
        WITH seed AS (
            SELECT DISTINCT g
            FROM media_items album
            JOIN media_items t ON t.parent_id = album.id AND t.media_type = 'track'
            CROSS JOIN LATERAL unnest(music_genre_tags(t.custom_metadata)) AS g
            WHERE album.parent_id = ${artistId}::uuid AND album.media_type = 'album' AND g <> ''
        )
        SELECT artist.id::text AS id
        FROM media_items mi
        JOIN media_items album ON album.id = mi.parent_id AND album.media_type = 'album'
        JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
        CROSS JOIN LATERAL unnest(music_genre_tags(mi.custom_metadata)) AS g
        WHERE mi.media_type = 'track'
          AND mi.status = 'active'
          AND mi.has_files = true
          AND artist.id != ${artistId}::uuid
          AND artist.is_various_artists = false
          AND g IN (SELECT g FROM seed)
          ${accessFragment(sql, access)}
        GROUP BY artist.id
        ORDER BY COUNT(DISTINCT g) DESC, COUNT(*) DESC, artist.id
        LIMIT ${limit}
    `;
    return rows.map((r) => r.id);
}

/** The artist ids each album belongs to (`album.parent_id`), for excludeArtistIds. */
export async function getAlbumArtistIds(
    sql: postgres.Sql,
    albumIds: string[],
): Promise<Map<string, string | null>> {
    if (albumIds.length === 0) return new Map();
    const rows = await sql<{ id: string; artist_id: string | null }[]>`
        SELECT id::text AS id, parent_id::text AS artist_id
        FROM media_items
        WHERE id = ANY(${albumIds}::uuid[])
    `;
    return new Map(rows.map((r) => [r.id, r.artist_id]));
}

/**
 * A top-level artist by exact (case-insensitive) name, visible under `access`
 * by the same predicate `GET /j/Artists` lists with, so an artist the caller
 * cannot browse to cannot be fetched by name either. Row shape matches
 * `listArtists` (for `mapRowToMediaItem`).
 */
export async function findVisibleArtistByName(
    sql: postgres.Sql,
    name: string,
    access: MediaAccessBoundary,
): Promise<Record<string, unknown> | null> {
    const trimmed = name.trim();
    if (!trimmed || deniesEverything(access)) return null;
    const rows = await sql<Record<string, unknown>[]>`
        SELECT
            mi.id,
            mi.title,
            mi.media_type,
            mi.overview,
            mi.created_at,
            (pm.metadata->>'poster_path')::text as poster_path,
            (pm.metadata->>'backdrop_path')::text as backdrop_path,
            (pm.metadata->>'logo_path')::text as logo_path,
            (SELECT COUNT(*)::int FROM media_items WHERE parent_id = mi.id AND status = 'active') as child_count
        FROM media_items mi
        ${buildMetadataLateralJoinFragment(sql)}
        WHERE mi.media_type = 'artist'
          AND mi.status = 'active'
          AND mi.parent_id IS NULL
          AND LOWER(mi.title) = LOWER(${trimmed})
          ${buildArtistLibraryAccessFilter(sql, access.library)}
          ${buildAgeRatingFilter(sql, access.age, 'mi')}
        ORDER BY mi.is_various_artists ASC, mi.created_at ASC
        LIMIT 1
    `;
    return rows[0] ?? null;
}
