// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Music Query Module
 *
 * Pure SQL queries for music browsing, smart queue, and recently played.
 * All functions take sql: postgres.Sql as first parameter, no side effects.
 *
 * Hierarchy:
 *   Artist  → media_type = 'artist'
 *   Album   → media_type = 'album'
 *   Track   → media_type = 'track'
 *
 * Audio features (bpm, key, energy, beat_grid, etc.) are stored in
 * custom_metadata JSONB on track rows.
 *
 * @module queries/music
 */

import type postgres from 'postgres';
import { isVariousArtistsName } from '$lib/shared/various-artists.js';
import type { UserId } from '$lib/shared/user-id';
import {
    canonicalTrackArtistsSql,
    nonVariousArtistIdSql,
    resolvedTrackArtistsSql,
    trackRemixerArtistsSql,
    trackArtistIdSql,
    trackArtistsSql,
    trackDisplayArtistSql,
} from './fragments/music-artist.fragments.js';
import { trackFilePathJoin } from './fragments/music-file-path.fragments.js';
import type { AgeRatingFilterParams } from './builders/age-rating.builder.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { MSCLAP_MODEL_ID } from './sonic-constants.js';
import { musicMoodVectorKey } from './sonic-queue.queries.js';
import { getGenreTags } from '$lib/server/utils/music-genre-streak.js';
import { effectiveArtistKey, primaryCreditArtistName } from '$lib/server/utils/music-artist-key.js';
import {
    REMIX_TAG_REGEX,
    DASH_REMIX_SUFFIX_REGEX,
    BARE_REMIX_SUFFIX_REGEX,
    FEAT_TAG_REGEX,
    FEAT_DASH_SUFFIX_REGEX,
    VERSION_ONLY_SQL_PATTERN,
} from './music-title-normalize.js';

// Various-Artists artist-row exclusion patterns for `!~*` filters. Bound as
// query parameters, never inlined into sql`` templates: postgres.js builds
// query text from the template literal's COOKED strings, where `\s`/`\.`
// silently cook to `s`/`.` — the inlined originals of these patterns never
// matched "Various Artists" at all (see TRAILING_VARIANT_SEGMENT_SQL_PATTERN
// in music-title-normalize.ts for the full hazard write-up).
const VA_ARTIST_TITLE_SQL_PATTERN = '^(va|v\\.a\\.?|various(\\s+artists?)?)$';
const VA_ARTIST_SLASH_SUFFIX_SQL_PATTERN = '/\\s*(va|v\\.a\\.?|various(\\s+artists?)?)\\s*$';

// =============================================================================
// Types
// =============================================================================

export interface MusicArtistRow {
    id: string;
    title: string;
    overview: string | null;
    custom_poster_url: string | null;
    custom_backdrop_url: string | null;
    custom_metadata: Record<string, unknown>;
    album_count: number;
    track_count: number;
    created_at: string;
    is_various_artists: boolean;
}

export interface MusicAlbumRow {
    /** Validated by the consumer; only supplied for an inherited artist poster. */
    inherited_poster_credit_url?: string | null;
    id: string;
    title: string;
    overview: string | null;
    custom_poster_url: string | null;
    custom_backdrop_url: string | null;
    custom_metadata: Record<string, unknown>;
    year: number | null;
    artist_id: string | null;
    artist_title: string | null;
    track_count: number;
    total_duration: number | null;
    created_at: string;
}

export interface TrackRow {
    id: string;
    title: string;
    sort_order: number | null;
    runtime_seconds: number | null;
    custom_poster_url: string | null;
    custom_metadata: Record<string, unknown>;
    parent_id: string | null;
    track_artist_id: string | null;
    track_artist_title: string | null;
    remixer_artists?: Array<{ id: string | null; title: string }> | null;
    track_artists: Array<{
        id: string | null;
        title: string;
    }> | null;
    created_at: string;
    file_path: string | null;
}

export interface AlbumWithTracksRow {
    album: MusicAlbumRow;
    tracks: TrackRow[];
}

export interface ArtistWithAlbumsRow {
    artist: MusicArtistRow;
    albums: MusicAlbumRow[];
}

export interface ArtistTrackRow {
    id: string;
    title: string;
    sort_order: number | null;
    runtime_seconds: number | null;
    custom_poster_url: string | null;
    custom_metadata: Record<string, unknown>;
    album_id: string;
    album_title: string;
    album_custom_poster_url: string | null;
    year: number | null;
    play_count: number;
    last_played_at: string | null;
    file_path: string | null;
}

export interface ArtistWithAlbumsAndTracksRow {
    artist: MusicArtistRow;
    albums: MusicAlbumRow[];
    tracks: ArtistTrackRow[];
}

export interface GenreTrackRow {
    id: string;
    title: string;
    sort_order: number | null;
    runtime_seconds: number | null;
    custom_poster_url: string | null;
    custom_metadata: Record<string, unknown>;
    album_id: string;
    album_title: string;
    album_custom_poster_url: string | null;
    artist_id: string | null;
    artist_title: string | null;
    year: number | null;
    file_path: string | null;
}

export interface TrackDetailRow {
    id: string;
    title: string;
    sort_order: number | null;
    runtime_seconds: number | null;
    custom_poster_url: string | null;
    custom_metadata: Record<string, unknown>;
    parent_id: string | null;
    album_id: string | null;
    album_title: string | null;
    album_custom_poster_url: string | null;
    album_custom_metadata: Record<string, unknown> | null;
    album_year: number | null;
    artist_id: string | null;
    artist_title: string | null;
    track_artist_id: string | null;
    track_artist_title: string | null;
    remixer_artists?: Array<{ id: string | null; title: string }> | null;
    track_artists: Array<{
        id: string | null;
        title: string;
    }> | null;
    created_at: string;
    file_path: string | null;
}

export interface RecentTrackRow {
    id: string;
    title: string;
    sort_order: number | null;
    runtime_seconds: number | null;
    custom_poster_url: string | null;
    custom_metadata: Record<string, unknown>;
    album_id: string | null;
    album_title: string | null;
    album_custom_poster_url: string | null;
    artist_id: string | null;
    artist_title: string | null;
    last_played_at: string;
    hours_since_played: number | null;
    file_path: string | null;
}

export interface QueueCandidateRow {
    id: string;
    title: string;
    custom_metadata: Record<string, unknown>;
    custom_poster_url: string | null;
    parent_id: string | null;
    similarity_score: number;
    resolved_artist?: string;
    /**
     * UUID of the resolved artist media_item (album→artist hierarchy), or null
     * for orphan tracks and for compilations (where the hierarchy parent is the
     * Various Artists marker, not a real performer).
     */
    resolved_artist_id?: string | null;
    /**
     * Per-track artists in tag order, so a multi-artist line can be rendered as
     * separate links. Null when the track's artist is just the album artist.
     */
    remixer_artists?: Array<{ id: string | null; title: string }> | null;
    track_artists?: Array<{ id: string | null; title: string }> | null;
    /**
     * Music embedding for the candidate. Returned by getSmartQueueCandidates
     * so callers can run candidate-vs-candidate MMR diversity. Absent on
     * fallback paths and on rows that lack an embedding row.
     */
    embedding?: number[] | string | null;
}

export interface MusicQueryOptions {
    genre?: string;
    /**
     * Album browse only. Matches the album's HIERARCHY artist by display name
     * (`LOWER(artist.title) = LOWER(value)`) — i.e. the single artist the album
     * row is parented to.
     *
     * This cannot see an artist who only appears as a credit on someone else's
     * album, and on this library that is most of them: "21 Harbors" has one
     * album to its name, but that album is Katie Vale's "143", parented to Katie
     * Vale. A name filter therefore returns nothing while `album_count` says 1.
     * Prefer {@link MusicQueryOptions.artistId}, which resolves identity the
     * same way the artist's own counts and detail page do.
     */
    artist?: string;
    /**
     * Album browse only. Artist UUID, CREDIT-AWARE: matches albums the artist
     * owns in the hierarchy OR albums carrying a track that credits them via
     * `additional_artist_ids`. This is the filter that agrees with
     * `MusicArtistRow.album_count`.
     */
    artistId?: string;
    sort?: 'recent' | 'alpha' | 'year' | 'random';
    limit?: number;
    offset?: number;
    /**
     * REQUIRED access boundary. There is no permissive default: a caller that
     * genuinely wants unrestricted results must construct `unrestrictedAccess()`
     * so the decision is greppable. `all` / `any` emit no predicate (SQL is
     * identical to the previous unrestricted path); `limit` restricts the list
     * to artists / albums with at least one track within the caller's age cap.
     */
    access: MediaAccessBoundary;
    /**
     * Optional deterministic seed for `sort: 'random'`. When provided,
     * ordering becomes a stable per-row hash (`md5(id || seed)`) instead of
     * `RANDOM()`, so OFFSET-based pagination through a "random" listing
     * doesn't reshuffle already-seen rows between pages. Omit to keep the
     * previous non-deterministic RANDOM() behavior.
     */
    seed?: string;
    /**
     * When true, excludes rows flagged `is_various_artists = true` from the
     * result. Defaults to `false` for compat safety — Subsonic/Jellyfin
     * callers invoke `getArtists` without this option and must keep seeing
     * the "Various Artists" row. Only user-facing surfaces (artist grid,
     * top-artists) opt in.
     */
    excludeVariousArtists?: boolean;
}

// =============================================================================
// Internal helpers
// =============================================================================

function buildMusicSortFragment(
    sql: postgres.Sql,
    sort: 'recent' | 'alpha' | 'year' | 'random' | undefined,
    seed?: string,
): ReturnType<postgres.Sql> {
    // Every branch has an `mi.id ASC` tiebreaker appended — sort keys here
    // (title, year, created_at) are not unique, so without a tiebreaker
    // OFFSET-based pagination can reshuffle rows on ties across pages
    // (duplicates on one page, missing rows on the next).
    if (sort === 'alpha') return sql`mi.title ASC, mi.id ASC`;
    if (sort === 'year')
        return sql`COALESCE(NULLIF(regexp_replace(mi.custom_metadata->>'year','[^0-9]','','g'),'')::int, 0) DESC, mi.title ASC, mi.id ASC`;
    if (sort === 'random') {
        // A bare RANDOM() reshuffles on every call, which breaks OFFSET
        // pagination for callers that page through a "random" ordering
        // (e.g. Subsonic getAlbumList2 type=random — see
        // subsonic-compat/handlers/browse.ts). When a caller supplies a
        // seed, use a deterministic per-row hash instead so the ordering is
        // stable for the lifetime of that seed (e.g. one browsing session)
        // while still varying between seeds. Omit the seed to keep the
        // previous non-deterministic behavior — safe for one-shot,
        // non-paginated random fetches, and the default so existing callers
        // are unaffected.
        return seed ? sql`md5(mi.id::text || ${seed})` : sql`RANDOM()`;
    }
    return sql`mi.created_at DESC, mi.id ASC`;
}

// =============================================================================
// Artist queries
// =============================================================================

/** Available tracks are active, not dismissed, and have a surviving audio link.
 * EXISTS keeps one track row even when several files are linked. The file access
 * condition belongs inside that EXISTS so an allowed sidecar cannot grant access.
 */
function playableTrackSql(
    sql: postgres.Sql,
    alias: 't' | 'tracks' | 'track' | 'mi',
    access?: MediaAccessBoundary,
): ReturnType<postgres.Sql> {
    if (access && deniesEverything(access)) return sql`AND false`;
    const denied = access?.library.kind === 'denyGroups' ? access.library.ids : [];
    return sql`
        AND ${sql(alias)}.status = 'active'
        AND ${sql(alias)}.is_dismissed = false
        AND EXISTS (
            SELECT 1 FROM media_file_items playable_link
            JOIN media_files playable_file ON playable_file.id = playable_link.file_id
            WHERE playable_link.media_item_id = ${sql(alias)}.id
              AND playable_file.is_missing = false
              AND LOWER(playable_file.file_path) ~ '\\.(mp3|flac|m4a|opus|ogg|wav|aac|aiff|alac|wma)$'
              ${
                  denied.length
                      ? sql`AND (playable_file.library_group_id IS NULL
                  OR playable_file.library_group_id != ALL(${denied}::uuid[]))`
                      : sql``
              }
        )
        ${access ? buildAgeRatingFilter(sql, access.age, alias) : sql``}
    `;
}

function availableAlbumSql(
    sql: postgres.Sql,
    alias: 'mi' | 'album',
    access?: MediaAccessBoundary,
): ReturnType<postgres.Sql> {
    return sql`AND ${sql(alias)}.status = 'active'
               AND ${sql(alias)}.is_dismissed = false
               ${access ? buildAgeRatingFilter(sql, access.age, alias) : sql``}`;
}

/**
 * The set of tracks that belong to an artist, resolved the SAME way
 * {@link getArtistTracks} resolves them: the album→artist hierarchy UNION the
 * `additional_artist_ids` credit list ("&" / "feat." splits).
 *
 * WHY THIS EXISTS: `album_count` / `track_count` on MusicArtistRow used to count
 * the hierarchy alone, which reports "0 albums · 0 tracks" for every artist who
 * only ever appears as a credited (non-album) artist — a feature spot on someone
 * else's album, or the second name in "Darin Vale & Jon Fenwick" (the album is
 * parented to Darin Vale only). Measured on the production library that was
 * 2,481 of 2,822 artists — 88% — reporting zero while their own detail response
 * listed tracks. `getArtistSummary` (the hover card) already counted it this way
 * and was the only site that agreed with the page it links to; the list and
 * detail projections were never brought in line. Now they all share this shape.
 *
 * `artistIdExpr` is spliced, not bound, so callers pass either a correlated
 * column reference (sql`mi.id`) or a bound parameter (sql`${artistId}`).
 *
 * INDEX NOTE: the credit branch is written as a SUB-PATH containment probe
 * (`custom_metadata->'additional_artist_ids' @> …`) so it uses the dedicated
 * partial GIN index `idx_track_additional_artist_ids_gin` (migration 16.155.0).
 */
function artistMatchedTracksSql(
    sql: postgres.Sql,
    artistIdExpr: ReturnType<postgres.Sql>,
    access?: MediaAccessBoundary,
): ReturnType<postgres.Sql> {
    return sql`
        SELECT t.id, t.parent_id
        FROM media_items t
        INNER JOIN media_items album
                ON album.id = t.parent_id
               AND album.media_type = 'album'
        WHERE t.media_type = 'track'
          AND album.parent_id = ${artistIdExpr}
          ${availableAlbumSql(sql, 'album', access)}
          ${playableTrackSql(sql, 't', access)}
        UNION
        SELECT t.id, t.parent_id
        FROM media_items t
        INNER JOIN media_items album ON album.id = t.parent_id AND album.media_type = 'album'
        WHERE t.media_type = 'track'
          AND t.custom_metadata -> 'additional_artist_ids'
              @> to_jsonb(ARRAY[${artistIdExpr}::text])
          ${availableAlbumSql(sql, 'album', access)}
          ${playableTrackSql(sql, 't', access)}
    `;
}

/**
 * True when the artist has at least one playable track: the same set as
 * {@link artistMatchedTracksSql}, asked as two EXISTS probes. An existence test
 * needs no UNION de-duplication, and the second probe is skipped when the first
 * (album hierarchy) already answers. Prod artist browse: 877 -> 553 ms.
 */
export function artistHasPlayableTrackSql(
    sql: postgres.Sql,
    artistIdExpr: ReturnType<postgres.Sql>,
    access?: MediaAccessBoundary,
): ReturnType<postgres.Sql> {
    return sql`(
        EXISTS (
            SELECT 1
            FROM media_items t
            INNER JOIN media_items album
                    ON album.id = t.parent_id
                   AND album.media_type = 'album'
            WHERE t.media_type = 'track'
              AND album.parent_id = ${artistIdExpr}
              ${availableAlbumSql(sql, 'album', access)}
              ${playableTrackSql(sql, 't', access)}
        )
        OR EXISTS (
            SELECT 1
            FROM media_items t
            INNER JOIN media_items album ON album.id = t.parent_id AND album.media_type = 'album'
            WHERE t.media_type = 'track'
              AND t.custom_metadata -> 'additional_artist_ids'
                  @> to_jsonb(ARRAY[${artistIdExpr}::text])
              ${availableAlbumSql(sql, 'album', access)}
              ${playableTrackSql(sql, 't', access)}
        )
    )`;
}

/**
 * Shared WHERE fragments for the artist browse — genre, Various-Artists
 * exclusion, and the playable-track/access gate — so {@link getArtists} and
 * {@link countArtists} always describe the same set.
 *
 * The playable gate applies to every caller: an artist is listed only while at
 * least one of their tracks is playable for this boundary. Unrestricted callers
 * need it too, or artists whose music is gone stay browsable with 0 tracks.
 */
function artistBrowseFilters(
    sql: postgres.Sql,
    options: MusicQueryOptions,
): ReturnType<postgres.Sql> {
    const vaFilter = options.excludeVariousArtists ? sql`AND mi.is_various_artists = false` : sql``;
    const genreFilter = options.genre
        ? sql`AND EXISTS (
            SELECT 1 FROM (${artistMatchedTracksSql(sql, sql`mi.id`, options.access)}) mt
            JOIN media_items track ON track.id = mt.id
            WHERE music_genre_tags(track.custom_metadata) @> ARRAY[LOWER(${options.genre})]::text[]
        )`
        : sql``;
    const playableFilter = sql`AND ${artistHasPlayableTrackSql(sql, sql`mi.id`, options.access)}`;
    return sql`${vaFilter} ${genreFilter} ${playableFilter}`;
}

/**
 * Resolve an artist's internal UUID by name (case-insensitive exact match).
 * Returns null when no top-level artist row matches. Used to enrich live
 * radio now-playing metadata so the artist label can link to the artist
 * modal when the artist exists in our library.
 */
export async function findArtistIdByName(sql: postgres.Sql, name: string): Promise<string | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const rows = await sql<{ id: string }[]>`
        SELECT id
        FROM media_items
        WHERE media_type = 'artist'
          AND parent_id IS NULL
          AND LOWER(title) = LOWER(${trimmed})
        LIMIT 1
    `;
    return rows[0]?.id ?? null;
}

export interface ArtistNameRow {
    id: string;
    title: string;
}

/**
 * Find the first artist whose title matches the given name (case-insensitive).
 * Returns id + title so callers do not need a second lookup.
 */
export async function findArtistByName(
    sql: postgres.Sql,
    name: string,
): Promise<ArtistNameRow | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const rows = await sql<ArtistNameRow[]>`
        SELECT id, title
        FROM media_items
        WHERE media_type = 'artist'
          AND parent_id IS NULL
          AND LOWER(title) = LOWER(${trimmed})
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/**
 * Find tracks matching a title (and optionally artist name through the parent chain).
 * Used by getLyrics to locate lyrics by song metadata.
 */
export async function findTracksByTitle(
    sql: postgres.Sql,
    title: string,
    artist?: string,
): Promise<Array<{ id: string }>> {
    if (artist) {
        return sql<Array<{ id: string }>>`
            SELECT mi.id FROM media_items mi
            WHERE mi.media_type = 'track'
              AND LOWER(mi.title) = LOWER(${title})
              AND EXISTS (
                  SELECT 1 FROM media_items album
                  JOIN media_items artist_item ON artist_item.id = album.parent_id
                  WHERE album.id = mi.parent_id
                    AND LOWER(artist_item.title) = LOWER(${artist})
              )
            LIMIT 5
        `;
    }
    return sql<Array<{ id: string }>>`
        SELECT id FROM media_items
        WHERE media_type = 'track'
          AND LOWER(title) = LOWER(${title})
        LIMIT 5
    `;
}

/**
 * List all artists (top-level music items: media_type = 'artist', parent_id IS NULL).
 * Includes album count and optional genre filter (genre must appear in at least
 * one child track's custom_metadata->'genre' JSON array, checked via jsonb_array_elements_text).
 */
export async function getArtists(
    sql: postgres.Sql,
    options: MusicQueryOptions,
): Promise<MusicArtistRow[]> {
    if (deniesEverything(options.access)) return [];
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const orderFragment = buildMusicSortFragment(sql, options.sort, options.seed);

    return sql<MusicArtistRow[]>`
        SELECT
            mi.id,
            mi.title,
            mi.overview,
            mi.custom_poster_url,
            mi.custom_backdrop_url,
            COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
            mi.created_at::text AS created_at,
            mi.is_various_artists,
            -- Counted over the artist's REAL track set (hierarchy ∪ credits),
            -- matching getArtistSummary and the detail response's own tracks
            -- list. See artistMatchedTracksSql for why the hierarchy alone is
            -- wrong for ~88% of this library's artists.
            (
                SELECT COUNT(DISTINCT mt.parent_id)::int
                FROM (${artistMatchedTracksSql(sql, sql`mi.id`, options.access)}) mt
            ) AS album_count,
            (
                SELECT COUNT(*)::int
                FROM (${artistMatchedTracksSql(sql, sql`mi.id`, options.access)}) mt
            ) AS track_count
        FROM media_items mi
        WHERE mi.media_type = 'artist'
          AND mi.parent_id IS NULL
          ${artistBrowseFilters(sql, options)}
        ORDER BY ${orderFragment}
        LIMIT ${limit}
        OFFSET ${offset}
    `;
}

/**
 * Total artists a browse would yield under the same boundary and filters.
 * Shares {@link artistBrowseFilters} with {@link getArtists} so `page.total`
 * can never describe a different set than the rows beside it.
 */
export async function countArtists(sql: postgres.Sql, options: MusicQueryOptions): Promise<number> {
    if (deniesEverything(options.access)) return 0;
    const rows = await sql<{ total: number }[]>`
        SELECT COUNT(*)::int AS total
        FROM media_items mi
        WHERE mi.media_type = 'artist'
          AND mi.parent_id IS NULL
          ${artistBrowseFilters(sql, options)}
    `;
    return rows[0]?.total ?? 0;
}

/**
 * Get a single artist with all their albums.
 * Albums are sorted by year (ascending), then title.
 */
export async function getArtistWithAlbums(
    sql: postgres.Sql,
    artistId: string,
    access: MediaAccessBoundary,
): Promise<ArtistWithAlbumsRow | null> {
    const artistRows = await sql<
        Array<{
            id: string;
            title: string;
            overview: string | null;
            custom_poster_url: string | null;
            custom_backdrop_url: string | null;
            custom_metadata: Record<string, unknown>;
            album_count: number;
            track_count: number;
            created_at: string;
            is_various_artists: boolean;
        }>
    >`
        SELECT
            mi.id,
            mi.title,
            mi.overview,
            mi.custom_poster_url,
            mi.custom_backdrop_url,
            COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
            mi.created_at::text AS created_at,
            mi.is_various_artists,
            (
                SELECT COUNT(DISTINCT mt.parent_id)::int
                FROM (${artistMatchedTracksSql(sql, sql`${artistId}`, access)}) mt
            ) AS album_count,
            (
                SELECT COUNT(*)::int
                FROM (${artistMatchedTracksSql(sql, sql`${artistId}`, access)}) mt
            ) AS track_count
        FROM media_items mi
        WHERE mi.id = ${artistId}
          AND mi.media_type = 'artist'
          AND mi.parent_id IS NULL
        LIMIT 1
    `;

    if (artistRows.length === 0) return null;

    const artist = artistRows[0];

    const albums = await sql<MusicAlbumRow[]>`
        SELECT
            mi.id,
            mi.title,
            mi.overview,
            mi.custom_poster_url,
            mi.custom_backdrop_url,
            COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
            mi.year,
            mi.parent_id AS artist_id,
            CASE
                WHEN artist.title IS NOT NULL AND artist.title != 'Unknown Artist'
                THEN artist.title
                ELSE (
                    SELECT t.custom_metadata->>'artist'
                    FROM media_items t
                    WHERE t.parent_id = mi.id AND t.media_type = 'track'
                      AND t.custom_metadata->>'artist' IS NOT NULL
                          ${playableTrackSql(sql, 't')}
                    GROUP BY t.custom_metadata->>'artist'
                    ORDER BY COUNT(*) DESC
                    LIMIT 1
                )
            END AS artist_title,
            mi.created_at::text AS created_at,
            (
                SELECT COUNT(*)::int
                FROM media_items tracks
                WHERE tracks.parent_id = mi.id
                  AND tracks.media_type = 'track'
                  ${playableTrackSql(sql, 'tracks', access)}
            ) AS track_count,
            (
                SELECT COALESCE(SUM(tracks.runtime_seconds), 0)::int
                FROM media_items tracks
                WHERE tracks.parent_id = mi.id
                  AND tracks.media_type = 'track'
                  ${playableTrackSql(sql, 'tracks', access)}
            ) AS total_duration
        FROM media_items mi
        LEFT JOIN media_items artist ON artist.id = mi.parent_id
        WHERE mi.media_type = 'album'
          AND mi.id IN (
              SELECT mt.parent_id
              FROM (${artistMatchedTracksSql(sql, sql`${artistId}`, access)}) mt
          )
        ORDER BY COALESCE(mi.year, 0) ASC, mi.title ASC
    `;

    return { artist, albums };
}

/**
 * Get all tracks by an artist across all their albums.
 *
 * Matches tracks in two ways:
 *   1. Hierarchy: track → album (parent_id) → artist (parent_id)
 *   2. Additional artists: track custom_metadata->'additional_artist_ids' contains artistId
 *      (for "&", "feat.", etc. splits — e.g. "Santiano & Nathan Evans" appears under both)
 *
 * Ordered by album year, then album title, then track sort_order, then title.
 */
export async function getArtistTracks(
    sql: postgres.Sql,
    artistId: string,
    userId: UserId,
    access: MediaAccessBoundary,
): Promise<ArtistTrackRow[]> {
    return sql<ArtistTrackRow[]>`
        WITH matched_tracks AS (
            ${artistMatchedTracksSql(sql, sql`${artistId}`, access)}
        ),
        user_plays AS (
            SELECT
                ums.track_id AS media_id,
                ums.play_count,
                ums.last_played_at::text AS last_played_at
            FROM user_music_state ums
            WHERE ums.user_id = ${userId}
              AND ums.track_id IN (SELECT id FROM matched_tracks)
        )
        SELECT
            t.id,
            t.title,
            t.sort_order,
            t.runtime_seconds,
            t.custom_poster_url,
            COALESCE(t.custom_metadata, '{}'::jsonb) AS custom_metadata,
            ${trackArtistsSql(sql, 't')} AS track_artists,
                ${trackRemixerArtistsSql(sql, 't')} AS remixer_artists,
            album.id AS album_id,
            album.title AS album_title,
            album.custom_poster_url AS album_custom_poster_url,
            album.year,
            COALESCE(up.play_count, 0) AS play_count,
            up.last_played_at,
            mf.file_path AS file_path
        FROM media_items t
        INNER JOIN media_items album ON album.id = t.parent_id AND album.media_type = 'album'
        LEFT JOIN user_plays up ON up.media_id = t.id
        ${trackFilePathJoin(sql, 't', access)}
        WHERE t.id IN (SELECT id FROM matched_tracks)
        ORDER BY COALESCE(album.year, 0) ASC, album.title ASC, COALESCE(t.sort_order, 0) ASC, t.title ASC
    `;
}

// =============================================================================
// Album queries
// =============================================================================

/**
 * List albums (media_type = 'album', parent_id IS NOT NULL).
 * Optional filters: genre (case-insensitive exact match against child track
 * custom_metadata->'genre' JSON array via jsonb_array_elements_text),
 * artist (exact match on parent title).
 */
/**
 * Shared WHERE fragments for the album browse, so {@link getAlbums} and
 * {@link countAlbums} cannot drift.
 *
 * The playable-audio and library-access predicates are ONE EXISTS on purpose:
 * both must be satisfied by the SAME file, so an album whose audio files are
 * all in denied groups stays hidden even if a non-audio sidecar sits in an
 * allowed group ("user can play this album", not "user can touch some file on
 * it"). For unrestricted users the extra branches are empty and this is
 * identical to the original audio-only EXISTS.
 */
function albumBrowseFilters(
    sql: postgres.Sql,
    options: MusicQueryOptions,
): ReturnType<postgres.Sql> {
    const playableAndAccess = sql`
        ${availableAlbumSql(sql, 'mi', options.access)}
        AND EXISTS (
            SELECT 1 FROM media_items t
            WHERE t.parent_id = mi.id AND t.media_type = 'track'
              ${playableTrackSql(sql, 't', options.access)}
        )`;

    const genreFilter = options.genre
        ? sql`AND EXISTS (
                SELECT 1 FROM media_items track
                WHERE track.parent_id = mi.id
                  AND track.media_type = 'track'
                  ${playableTrackSql(sql, 'track', options.access)}
                  AND music_genre_tags(track.custom_metadata) @> ARRAY[LOWER(${options.genre})]::text[]
            )`
        : sql``;

    // Name form: hierarchy parent only — see MusicQueryOptions.artist for why
    // that legitimately returns nothing for most artists in this library.
    const artistNameFilter = options.artist
        ? sql`AND LOWER(artist.title) = LOWER(${options.artist})`
        : sql``;

    // Identity form: hierarchy OR credit, so it agrees with the album_count
    // MusicArtistRow reports. Without the credit branch, an artist whose only
    // albums are other people's would show a count of N and an empty grid.
    // The credit branch mirrors artistMatchedTracksSql's indexed sub-path probe
    // (idx_track_additional_artist_ids_gin, migration 16.155.0).
    const artistIdFilter = options.artistId
        ? sql`AND (
                mi.parent_id = ${options.artistId}::uuid
                OR EXISTS (
                    SELECT 1 FROM media_items t
                    WHERE t.parent_id = mi.id
                      AND t.media_type = 'track'
                      ${playableTrackSql(sql, 't', options.access)}
                      AND t.custom_metadata -> 'additional_artist_ids'
                          @> to_jsonb(ARRAY[${options.artistId}::text])
                )
            )`
        : sql``;

    return sql`${playableAndAccess} ${genreFilter} ${artistNameFilter} ${artistIdFilter}`;
}

export async function getAlbums(
    sql: postgres.Sql,
    options: MusicQueryOptions,
): Promise<MusicAlbumRow[]> {
    if (deniesEverything(options.access)) return [];
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const orderFragment = buildMusicSortFragment(sql, options.sort, options.seed);

    return sql<MusicAlbumRow[]>`
        SELECT
            mi.id,
            mi.title,
            mi.overview,
            mi.custom_poster_url,
            mi.custom_backdrop_url,
            COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
            mi.year,
            mi.parent_id AS artist_id,
            CASE
                WHEN artist.title IS NOT NULL AND artist.title != 'Unknown Artist'
                THEN artist.title
                ELSE COALESCE(
                    (
                        SELECT t.custom_metadata->>'artist'
                        FROM media_items t
                        WHERE t.parent_id = mi.id AND t.media_type = 'track'
                          AND t.custom_metadata->>'artist' IS NOT NULL
                          ${playableTrackSql(sql, 't')}
                        GROUP BY t.custom_metadata->>'artist'
                        ORDER BY COUNT(*) DESC
                        LIMIT 1
                    ),
                    NULLIF(mi.custom_metadata->>'album_artist', ''),
                    NULLIF(mi.custom_metadata->>'artist', '')
                )
            END AS artist_title,
            mi.created_at::text AS created_at,
            (
                SELECT COUNT(*)::int
                FROM media_items tracks
                WHERE tracks.parent_id = mi.id
                  AND tracks.media_type = 'track'
                  ${playableTrackSql(sql, 'tracks', options.access)}
            ) AS track_count,
            (
                SELECT COALESCE(SUM(tracks.runtime_seconds), 0)::int
                FROM media_items tracks
                WHERE tracks.parent_id = mi.id
                  AND tracks.media_type = 'track'
                  ${playableTrackSql(sql, 'tracks', options.access)}
            ) AS total_duration
        FROM media_items mi
        LEFT JOIN media_items artist ON artist.id = mi.parent_id
        WHERE mi.media_type = 'album'
          AND mi.parent_id IS NOT NULL
          ${albumBrowseFilters(sql, options)}
        ORDER BY ${orderFragment}
        LIMIT ${limit}
        OFFSET ${offset}
    `;
}

/**
 * Total albums a browse would yield under the same boundary and filters.
 * Shares {@link albumBrowseFilters} with {@link getAlbums}.
 *
 * Needs the same `LEFT JOIN media_items artist` as the page query, because the
 * `?artist=<name>` filter reads `artist.title`.
 */
export async function countAlbums(sql: postgres.Sql, options: MusicQueryOptions): Promise<number> {
    if (deniesEverything(options.access)) return 0;
    const rows = await sql<{ total: number }[]>`
        SELECT COUNT(*)::int AS total
        FROM media_items mi
        LEFT JOIN media_items artist ON artist.id = mi.parent_id
        WHERE mi.media_type = 'album'
          AND mi.parent_id IS NOT NULL
          ${albumBrowseFilters(sql, options)}
    `;
    return rows[0]?.total ?? 0;
}

/**
 * Get a single album with its playable tracks.
 * Tracks are ordered by sort_order (track number), then by
 * disc_number from custom_metadata if present.
 *
 * An active album whose tracks are all unavailable still resolves, with an
 * empty track list: history, playlists and favorites link to it, and a 404
 * would break those links while the album row is retained.
 *
 * The disc term is GUARDED by `jsonb_typeof(...) = 'number'` rather than
 * cast bare. `custom_metadata` is a freeform jsonb column and
 * `PUT /api/admin/media/bulk-metadata` merges an arbitrary admin-supplied
 * object into it verbatim, so a string ("1/2", the raw ID3 combined form)
 * can reach this key even though the scanner only ever writes a JSON number
 * (`audio-tag-parser.ts` normalises "2/2" to 2). A bare
 * `(...->>'disc_number')::int` in an ORDER BY fails the WHOLE statement on
 * one such row — the entire album 500s rather than one track sorting oddly.
 * The guard yields NULL for those, and the enclosing COALESCE(..., 1) keeps
 * the pre-existing intent: an untagged (or unparseable) track sorts WITH
 * disc 1 rather than past the last disc. Same pattern as the music branch of
 * `namedOrder` in admin-media.queries.ts and the `book_series_sequence`
 * projection there.
 *
 * `normalized_artists` must stay a CTE joined by equality — do NOT fold it back
 * into a per-track `LEFT JOIN LATERAL`. Both sides of the match are computed
 * expressions (`regexp_replace(LOWER(TRIM(...)))`), so no index can serve them
 * and a correlated form re-scans every artist row for every track: on a
 * 162-track compilation against 2.7k artists that measured 3.06s (443k regexp
 * evaluations, 2.1M buffer hits) versus 13ms for this hash join.
 *
 * The `ORDER BY ... artist.id` tiebreak is load-bearing: ~144 artist titles are
 * exact duplicates, and the previous `ORDER BY artist.title LIMIT 1` picked
 * between them non-deterministically.
 */
export async function getAlbumWithTracks(
    sql: postgres.Sql,
    albumId: string,
): Promise<AlbumWithTracksRow | null> {
    type AlbumBaseRow = Omit<MusicAlbumRow, 'track_count' | 'total_duration'>;
    const albumRows = await sql<AlbumBaseRow[]>`
        SELECT
            mi.id,
            mi.title,
            mi.overview,
            mi.custom_poster_url,
            mi.custom_backdrop_url,
            COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
            CASE WHEN mi.custom_poster_url IS NULL
                AND NOT EXISTS (SELECT 1 FROM image_candidates own_art WHERE own_art.media_item_id = mi.id AND own_art.artwork_type = 'poster' AND own_art.source = 'local')
                AND artist.custom_metadata #>> '{artist_enrichment,provenance,poster,provider}' = 'discogs'
                AND artist.custom_metadata #>> '{artist_enrichment,provenance,poster,value}' = artist.custom_poster_url
                THEN artist.custom_metadata #>> '{artist_enrichment,provenance,poster,url}'
                ELSE NULL
            END AS inherited_poster_credit_url,
            mi.year,
            mi.parent_id AS artist_id,
            CASE
                WHEN artist.title IS NOT NULL AND artist.title != 'Unknown Artist'
                THEN artist.title
                ELSE COALESCE(
                    (
                        SELECT t.custom_metadata->>'artist'
                        FROM media_items t
                        WHERE t.parent_id = mi.id AND t.media_type = 'track'
                          AND t.custom_metadata->>'artist' IS NOT NULL
                          ${playableTrackSql(sql, 't')}
                        GROUP BY t.custom_metadata->>'artist'
                        ORDER BY COUNT(*) DESC
                        LIMIT 1
                    ),
                    NULLIF(mi.custom_metadata->>'album_artist', ''),
                    NULLIF(mi.custom_metadata->>'artist', '')
                )
            END AS artist_title,
            mi.created_at::text AS created_at
        FROM media_items mi
        LEFT JOIN media_items artist ON artist.id = mi.parent_id
        WHERE mi.id = ${albumId}
          AND mi.media_type = 'album'
          ${availableAlbumSql(sql, 'mi')}
        LIMIT 1
    `;

    if (albumRows.length === 0) return null;

    const tracks = await sql<TrackRow[]>`
        WITH normalized_artists AS MATERIALIZED (
            SELECT DISTINCT ON (LOWER(TRIM(artist.title)))
                LOWER(TRIM(artist.title)) AS norm_title,
                artist.id,
                artist.title,
                jsonb_build_array(
                    jsonb_build_object('id', artist.id, 'title', artist.title)
                ) AS artists
            FROM media_items artist
            WHERE artist.media_type = 'artist'
              AND artist.parent_id IS NULL
              AND artist.status = 'active'
            ORDER BY 1, artist.title, artist.id
        )
        SELECT
            mi.id,
            mi.title,
            mi.sort_order,
            mi.runtime_seconds,
            mi.custom_poster_url,
            COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
            mi.parent_id,
            CASE WHEN jsonb_typeof(NULLIF(mi.custom_metadata->'track_artist_credits', '[]'::jsonb)) = 'array'
                THEN (${canonicalTrackArtistsSql(sql, 'mi')}->0->>'id')::uuid
                ELSE COALESCE(track_artist.id, additional_artist.id) END AS track_artist_id,
            CASE WHEN jsonb_typeof(NULLIF(mi.custom_metadata->'track_artist_credits', '[]'::jsonb)) = 'array'
                THEN (SELECT string_agg(credit->>'title', ', ' ORDER BY ord)
                    FROM jsonb_array_elements(${canonicalTrackArtistsSql(sql, 'mi')})
                        WITH ORDINALITY credits(credit, ord))
                ELSE COALESCE(track_artist.title,
                    NULLIF(mi.custom_metadata->>'artist', ''), additional_artist.title)
            END AS track_artist_title,
            COALESCE(
                ${canonicalTrackArtistsSql(sql, 'mi')},
                ${resolvedTrackArtistsSql(sql)},
                CASE
                    WHEN NULLIF(mi.custom_metadata->>'artist', '') IS NOT NULL THEN
                        jsonb_build_array(
                            jsonb_build_object(
                                'id', NULL,
                                'title', mi.custom_metadata->>'artist'
                            )
                        )
                    ELSE NULL
                END
            ) AS track_artists,
            ${trackRemixerArtistsSql(sql, 'mi')} AS remixer_artists,
            mi.created_at::text AS created_at,
            mf.file_path AS file_path
        FROM media_items mi
        ${trackFilePathJoin(sql, 'mi')}
        LEFT JOIN normalized_artists track_artist
            ON track_artist.norm_title
             = LOWER(TRIM(NULLIF(mi.custom_metadata->>'artist', '')))
        LEFT JOIN LATERAL (
            SELECT artist.id, artist.title
            FROM jsonb_array_elements_text(
                CASE jsonb_typeof(mi.custom_metadata->'additional_artist_ids')
                    WHEN 'array' THEN mi.custom_metadata->'additional_artist_ids'
                    ELSE '[]'::jsonb
                END
            ) WITH ORDINALITY ids(id, ord)
            JOIN media_items artist
              ON artist.id = CASE WHEN ids.id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN ids.id::uuid END
             AND artist.media_type = 'artist'
             AND artist.parent_id IS NULL
              AND artist.status = 'active'
             AND artist.title !~* ${VA_ARTIST_TITLE_SQL_PATTERN}
             AND artist.title !~* ${VA_ARTIST_SLASH_SUFFIX_SQL_PATTERN}
            ORDER BY ids.ord
            LIMIT 1
        ) additional_artist ON true
        LEFT JOIN LATERAL (
            SELECT jsonb_agg(
                jsonb_build_object('id', artist.id, 'title', artist.title)
                ORDER BY ids.ord
            ) AS artists
            FROM jsonb_array_elements_text(
                CASE jsonb_typeof(mi.custom_metadata->'additional_artist_ids')
                    WHEN 'array' THEN mi.custom_metadata->'additional_artist_ids'
                    ELSE '[]'::jsonb
                END
            ) WITH ORDINALITY ids(id, ord)
            JOIN media_items artist
              ON artist.id = CASE WHEN ids.id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN ids.id::uuid END
             AND artist.media_type = 'artist'
             AND artist.parent_id IS NULL
              AND artist.status = 'active'
             AND artist.title !~* ${VA_ARTIST_TITLE_SQL_PATTERN}
             AND artist.title !~* ${VA_ARTIST_SLASH_SUFFIX_SQL_PATTERN}
        ) additional_artists ON true
        WHERE mi.parent_id = ${albumId}
          AND mi.media_type = 'track'
          ${playableTrackSql(sql, 'mi')}
        ORDER BY
            COALESCE(
                CASE WHEN jsonb_typeof(mi.custom_metadata #> '{disc_number}') = 'number'
                     THEN (mi.custom_metadata #>> '{disc_number}')::int
                END, 1) ASC,
            COALESCE(mi.sort_order, 9999) ASC,
            mi.title ASC
    `;

    // Compute track_count and total_duration from the fetched tracks rather than
    // running two extra correlated subqueries in the album SQL.
    const album: MusicAlbumRow = {
        ...albumRows[0],
        track_count: tracks.length,
        total_duration: tracks.reduce((sum, t) => sum + (t.runtime_seconds ?? 0), 0),
    };

    // A track with no performer at all (no artist tag, an empty canonical
    // credit list, nothing in additional_artist_ids) is credited to the
    // album's artist, as the album page showed before canonical credits. Never
    // to Various Artists: that is a compilation marker, not a performer.
    const owner = album.artist_id && album.artist_title ? album : null;
    if (owner && !isVariousArtistsName(owner.artist_title)) {
        for (const track of tracks) {
            if (track.track_artist_title || track.track_artists?.length) continue;
            track.track_artist_id = owner.artist_id;
            track.track_artist_title = owner.artist_title;
        }
    }

    return { album, tracks };
}

/**
 * Batch-fetch tracks for a list of album IDs in a single query.
 * Returns a Map from albumId → TrackRow[]. Tracks are ordered by disc/sort_order/title.
 * Uses a simplified artist join (no lateral) for performance over N+1 calls.
 */
export async function getTracksForAlbums(
    sql: postgres.Sql,
    albumIds: string[],
): Promise<Map<string, TrackRow[]>> {
    if (albumIds.length === 0) return new Map();

    const rows = await sql<(TrackRow & { album_id: string })[]>`
        SELECT
            mi.id,
            mi.title,
            mi.sort_order,
            mi.runtime_seconds,
            mi.custom_poster_url,
            COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
            mi.parent_id,
            mi.parent_id AS album_id,
            NULL::uuid AS track_artist_id,
            NULL::text AS track_artist_title,
            NULL::jsonb AS track_artists,
            mi.created_at::text AS created_at,
            mf.file_path AS file_path
        FROM media_items mi
        ${trackFilePathJoin(sql, 'mi')}
        WHERE mi.parent_id = ANY(${albumIds})
          AND mi.media_type = 'track'
          ${playableTrackSql(sql, 'mi')}
          AND EXISTS (SELECT 1 FROM media_items album WHERE album.id = mi.parent_id
              AND album.media_type = 'album' ${availableAlbumSql(sql, 'album')})
        ORDER BY
            -- disc_number is GUARDED, not cast bare: custom_metadata is freeform
            -- jsonb and PUT /api/admin/media/bulk-metadata merges arbitrary
            -- admin-supplied keys into it verbatim, so a string ("1/2") can land
            -- here. In an ORDER BY a bare ::int fails the WHOLE statement, so one
            -- such row 500s the entire page. See getAlbumWithTracks in
            -- music.queries.ts for the full rationale.
            COALESCE(
                CASE WHEN jsonb_typeof(mi.custom_metadata #> '{disc_number}') = 'number'
                     THEN (mi.custom_metadata #>> '{disc_number}')::int
                END, 1) ASC,
            COALESCE(mi.sort_order, 9999) ASC,
            mi.title ASC
    `;

    const map = new Map<string, TrackRow[]>();
    for (const row of rows) {
        const albumId = row.album_id;
        const existing = map.get(albumId);
        if (existing) {
            existing.push(row);
        } else {
            map.set(albumId, [row]);
        }
    }
    return map;
}

// =============================================================================
// Track queries
// =============================================================================

/**
 * Get full track detail including parent album and grandparent artist.
 */
export interface TrackStreamSourceRow {
    id: string;
    file_path: string | null;
    duration_seconds: number | null;
}

/**
 * The columns the stream route needs: the track id (for the access check),
 * its file path and the selected file duration. Same file pick as `getTrackDetail` (shared fragment).
 *
 * The stream route used `getTrackDetail`, whose `track_artist` LATERAL runs a
 * `regexp_replace` over every artist row — ~40ms on prod — to build artist
 * display fields the route never reads. AVFoundation sends several ranged
 * requests before a track starts, so that cost landed on every one of them.
 */
export async function getTrackStreamSource(
    sql: postgres.Sql,
    trackId: string,
): Promise<TrackStreamSourceRow | null> {
    const rows = await sql<TrackStreamSourceRow[]>`
        SELECT track.id, mf.file_path AS file_path, mf.duration_seconds
        FROM media_items track
        ${trackFilePathJoin(sql)}
        WHERE track.id = ${trackId}
          AND track.media_type = 'track'
        LIMIT 1
    `;
    return rows[0] ?? null;
}

export async function getTrackDetail(
    sql: postgres.Sql,
    trackId: string,
): Promise<TrackDetailRow | null> {
    const rows = await sql<TrackDetailRow[]>`
        SELECT
            track.id,
            track.title,
            track.sort_order,
            track.runtime_seconds,
            track.custom_poster_url,
            COALESCE(track.custom_metadata, '{}'::jsonb) AS custom_metadata,
            track.parent_id,
            album.id AS album_id,
            album.title AS album_title,
            album.custom_poster_url AS album_custom_poster_url,
            COALESCE(album.custom_metadata, '{}'::jsonb) AS album_custom_metadata,
            album.year AS album_year,
            ${trackArtistIdSql(sql)} AS artist_id,
            ${trackDisplayArtistSql(sql)} AS artist_title,
            CASE WHEN jsonb_typeof(NULLIF(track.custom_metadata->'track_artist_credits', '[]'::jsonb)) = 'array'
                THEN (${canonicalTrackArtistsSql(sql, 'track')}->0->>'id')::uuid
                ELSE COALESCE(track_artist.id, additional_artist.id) END AS track_artist_id,
            CASE WHEN jsonb_typeof(NULLIF(track.custom_metadata->'track_artist_credits', '[]'::jsonb)) = 'array'
                THEN (SELECT string_agg(credit->>'title', ', ' ORDER BY ord)
                    FROM jsonb_array_elements(${canonicalTrackArtistsSql(sql, 'track')})
                        WITH ORDINALITY credits(credit, ord))
                ELSE COALESCE(track_artist.title,
                    NULLIF(track.custom_metadata->>'artist', ''), additional_artist.title)
            END AS track_artist_title,
            COALESCE(
                ${canonicalTrackArtistsSql(sql, 'track')},
                ${resolvedTrackArtistsSql(sql)},
                CASE
                    WHEN NULLIF(track.custom_metadata->>'artist', '') IS NOT NULL THEN
                        jsonb_build_array(
                            jsonb_build_object(
                                'id', NULL,
                                'title', track.custom_metadata->>'artist'
                            )
                        )
                    ELSE NULL
                END
            ) AS track_artists,
            ${trackRemixerArtistsSql(sql, 'track')} AS remixer_artists,
            track.created_at::text AS created_at,
            mf.file_path AS file_path
        FROM media_items track
        LEFT JOIN media_items album ON album.id = track.parent_id
        LEFT JOIN media_items artist ON artist.id = album.parent_id
        ${trackFilePathJoin(sql)}
        LEFT JOIN LATERAL (
            SELECT
                artist.id,
                artist.title,
                jsonb_build_array(
                    jsonb_build_object('id', artist.id, 'title', artist.title)
                ) AS artists
            FROM media_items artist
            WHERE artist.media_type = 'artist'
              AND artist.parent_id IS NULL
              AND artist.status = 'active'
              AND NULLIF(track.custom_metadata->>'artist', '') IS NOT NULL
              AND LOWER(TRIM(artist.title))
                = LOWER(TRIM(track.custom_metadata->>'artist'))
            ORDER BY artist.title
            LIMIT 1
        ) track_artist ON true
        LEFT JOIN LATERAL (
            SELECT artist.id, artist.title
            FROM jsonb_array_elements_text(
                CASE jsonb_typeof(track.custom_metadata->'additional_artist_ids')
                    WHEN 'array' THEN track.custom_metadata->'additional_artist_ids'
                    ELSE '[]'::jsonb
                END
            ) WITH ORDINALITY ids(id, ord)
            JOIN media_items artist
              ON artist.id = CASE WHEN ids.id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN ids.id::uuid END
             AND artist.media_type = 'artist'
             AND artist.parent_id IS NULL
              AND artist.status = 'active'
             AND artist.title !~* ${VA_ARTIST_TITLE_SQL_PATTERN}
             AND artist.title !~* ${VA_ARTIST_SLASH_SUFFIX_SQL_PATTERN}
            ORDER BY ids.ord
            LIMIT 1
        ) additional_artist ON true
        LEFT JOIN LATERAL (
            SELECT jsonb_agg(
                jsonb_build_object('id', artist.id, 'title', artist.title)
                ORDER BY ids.ord
            ) AS artists
            FROM jsonb_array_elements_text(
                CASE jsonb_typeof(track.custom_metadata->'additional_artist_ids')
                    WHEN 'array' THEN track.custom_metadata->'additional_artist_ids'
                    ELSE '[]'::jsonb
                END
            ) WITH ORDINALITY ids(id, ord)
            JOIN media_items artist
              ON artist.id = CASE WHEN ids.id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN ids.id::uuid END
             AND artist.media_type = 'artist'
             AND artist.parent_id IS NULL
              AND artist.status = 'active'
             AND artist.title !~* ${VA_ARTIST_TITLE_SQL_PATTERN}
             AND artist.title !~* ${VA_ARTIST_SLASH_SUFFIX_SQL_PATTERN}
        ) additional_artists ON true
        WHERE track.id = ${trackId}
          AND track.media_type = 'track'
        LIMIT 1
    `;

    return rows[0] ?? null;
}

// =============================================================================
// Recently played / recently added
// =============================================================================

/**
 * Get recently played tracks for a user, ordered by most recent play.
 *
 * Reads from `user_music_state` (the authoritative source of music play
 * events) rather than `watch_history`. Per project convention, music plays
 * do NOT land in watch_history — only the aggregate state does. Reading
 * watch_history here would return 0 rows for every music user, silently
 * starving the Quick Picks recently-heard bucket and the /music Recently
 * Played carousel.
 *
 * `user_music_state` is already unique on (user_id, track_id), so no
 * deduplication CTE is needed.
 */
export async function getRecentlyPlayed(
    sql: postgres.Sql,
    userId: UserId,
    limit = 20,
): Promise<RecentTrackRow[]> {
    return sql<RecentTrackRow[]>`
        SELECT
            track.id,
            track.title,
            track.sort_order,
            track.runtime_seconds,
            track.custom_poster_url,
            COALESCE(track.custom_metadata, '{}'::jsonb) AS custom_metadata,
            album.id AS album_id,
            album.title AS album_title,
            album.custom_poster_url AS album_custom_poster_url,
            ${trackArtistIdSql(sql)} AS artist_id,
            ${trackDisplayArtistSql(sql)} AS artist_title,
            ${trackArtistsSql(sql, 'track')} AS track_artists,
            ${trackRemixerArtistsSql(sql, 'track')} AS remixer_artists,
            ums.last_played_at::text AS last_played_at,
            (EXTRACT(EPOCH FROM (NOW() - ums.last_played_at)) / 3600)::double precision AS hours_since_played,
            mf.file_path AS file_path
        FROM user_music_state ums
        JOIN media_items track
          ON track.id = ums.track_id AND track.media_type = 'track' AND track.has_files = true
        LEFT JOIN media_items album
          ON album.id = track.parent_id AND album.media_type = 'album'
        LEFT JOIN media_items artist
          ON artist.id = album.parent_id AND artist.media_type = 'artist'
        ${trackFilePathJoin(sql)}
        WHERE ums.user_id = ${userId}
          AND ums.last_played_at IS NOT NULL
        ORDER BY ums.last_played_at DESC
        LIMIT ${limit}
    `;
}

/** Collections that support an alphabetical seek index. */
export type AlphaIndexEntity = 'tracks' | 'albums' | 'artists';

export interface AlphaIndexBucket {
    /** Upper-case initial, or '#' for anything not A–Z. */
    key: string;
    /** Zero-based offset of this bucket's first row in the alpha listing. */
    offset: number;
    /**
     * Length of the listing segment that starts at {@link offset} — i.e. the
     * distance to the next bucket's offset, so `offset + count` is exactly
     * where the next letter begins and the counts sum to the listing total.
     *
     * This is NOT the number of rows whose initial is {@link key}: collation
     * scatters a few rows away from their own letter's run (see
     * `alphaBucketSql`), and a per-key population would disagree with the
     * offsets — which is what it used to do.
     */
    count: number;
}

/**
 * Per-initial offsets for an A–Z rail.
 *
 * The offsets are derived with ROW_NUMBER() over the SAME ordering and the
 * SAME filters the corresponding `sort=alpha` browse uses, rather than by
 * summing per-letter counts. That distinction is load-bearing: `ORDER BY title`
 * runs under the database collation, which does not sort strictly by first
 * character (punctuation, accents and case all move rows around), so a
 * cumulative-count offset would drift out of alignment with the page it is
 * supposed to address and the rail would jump to the wrong row. Taking
 * MIN(row_number) - 1 per bucket cannot drift, whatever the collation does.
 *
 * `count` is then the distance to the NEXT bucket's offset, for the same
 * reason: it has to describe the listing, not the letter. See the field doc on
 * {@link AlphaIndexBucket.count}.
 */
export async function getAlphaIndex(
    sql: postgres.Sql,
    entity: AlphaIndexEntity,
    access: MediaAccessBoundary,
    options: AlphaIndexOptions = {},
): Promise<AlphaIndexBucket[]> {
    if (deniesEverything(access)) return [];

    const numbered =
        entity === 'tracks'
            ? sql`
                SELECT ${alphaBucketSql(sql, sql`track.title`)} AS bucket,
                       ROW_NUMBER() OVER (ORDER BY track.title ASC, track.id ASC) AS rn
                FROM media_items track
                LEFT JOIN media_items album
                       ON album.id = track.parent_id AND album.media_type = 'album'
                LEFT JOIN media_items artist
                       ON artist.id = album.parent_id AND artist.media_type = 'artist'
                WHERE track.media_type = 'track'
                  AND track.has_files = true
                  ${trackBrowseFilters(sql, access, { genre: options.genre, artist: options.artist ?? options.artistId })}
            `
            : entity === 'albums'
              ? sql`
                SELECT ${alphaBucketSql(sql, sql`mi.title`)} AS bucket,
                       ROW_NUMBER() OVER (ORDER BY mi.title ASC, mi.id ASC) AS rn
                FROM media_items mi
                LEFT JOIN media_items artist ON artist.id = mi.parent_id
                WHERE mi.media_type = 'album'
                  AND mi.parent_id IS NOT NULL
                  ${albumBrowseFilters(sql, { ...options, access })}
            `
              : sql`
                SELECT ${alphaBucketSql(sql, sql`mi.title`)} AS bucket,
                       ROW_NUMBER() OVER (ORDER BY mi.title ASC, mi.id ASC) AS rn
                FROM media_items mi
                WHERE mi.media_type = 'artist'
                  AND mi.parent_id IS NULL
                  ${artistBrowseFilters(sql, { ...options, access, excludeVariousArtists: true })}
            `;

    // `count` is the LENGTH OF THE SEGMENT that starts at `offset`, i.e. the
    // distance to the next bucket's offset — NOT `COUNT(*)` of the rows whose
    // initial is this letter. Those two are not the same number, and shipping
    // the second one is what broke the rail's arithmetic: see the comment on
    // alphaBucketSql for why a bucket's rows are not contiguous in the
    // listing. Deriving the count from the offsets keeps the only invariants a
    // client can actually build on — `offset[i] + count[i] === offset[i+1]`,
    // and the counts summing to the listing total.
    const rows = await sql<AlphaIndexRow[]>`
        SELECT bucket,
               bucket_offset,
               (COALESCE(LEAD(bucket_offset) OVER (ORDER BY bucket_offset), total)
                    - bucket_offset)::int AS count
        FROM (
            SELECT bucket,
                   (MIN(rn) - 1)::int AS bucket_offset,
                   (SUM(COUNT(*)) OVER ())::int AS total
            FROM (${numbered}) x
            GROUP BY bucket
        ) b
        ORDER BY bucket_offset
    `;

    return rows.map((r) => ({ key: r.bucket, offset: r.bucket_offset, count: r.count }));
}

interface AlphaIndexRow {
    bucket: string;
    /** Named `bucket_offset`, not `offset`: OFFSET is a reserved word in Postgres. */
    bucket_offset: number;
    count: number;
}

/**
 * Every filter here must reach EVERY entity branch below. The index states
 * where a title sits in a browse, so a filter the browse applies and the index
 * does not makes every offset on the rail point at the wrong row — silently,
 * because both still return a plausible-looking set of buckets.
 */
export interface AlphaIndexOptions {
    genre?: string;
    artist?: string;
    /** Credit-aware artist identity; folded into `artist`, which accepts a UUID. */
    artistId?: string;
}

/**
 * Fold a title to its rail bucket: an upper-case A–Z initial, or '#'.
 *
 * Two details here are load-bearing, and getting either wrong mints a bucket
 * whose rows are scattered through the listing rather than sitting in one run
 * — which is what makes `offset` and `count` disagree.
 *
 * - The ASCII test is `POSITION(… IN 'ABC…Z')`, NOT `BETWEEN 'A' AND 'Z'`.
 *   BETWEEN is collation-aware, and under `en_US.utf8` 'Ä' genuinely does sort
 *   between A and Z, so the old guard let accented initials through and minted
 *   an 'Ä' bucket — a key the client's A–Z rail has no slot for, wedged into
 *   the middle of A's run (prod: "ÄTNA", 283 artists into a 321-row A).
 * - `NORMALIZE(…, NFD)` decomposes 'Ä' into 'A' plus a combining mark, so
 *   `LEFT(…, 1)` yields the base letter. That files "ÄTNA" under A, which is
 *   where the collation orders it anyway. The un-normalized branch is tried
 *   first purely so the overwhelming ASCII majority skips the decomposition.
 *
 * What this deliberately does NOT fix: glibc treats punctuation as
 * variable-weight, so "[theatre]" sorts under T and "“Weird Al” Yankovic"
 * under W while both bucket as '#'. There is no bucket key that can follow
 * them, which is exactly why `count` is derived from the offsets instead of
 * from per-key populations — such a row is simply absorbed into the segment it
 * physically lands in.
 *
 * Leading articles are deliberately NOT stripped — the browse ordering does
 * not strip them either, and a bucket that disagrees with the ordering is
 * worse than one that includes "The Lanterns" under T.
 */
function alphaBucketSql(
    sql: postgres.Sql,
    titleExpr: ReturnType<postgres.Sql>,
): ReturnType<postgres.Sql> {
    // POSITION('' IN anything) is 1, so an empty title would otherwise bucket
    // as '' and hand the rail a key it cannot render.
    return sql`CASE
        WHEN COALESCE(${titleExpr}, '') = '' THEN '#'
        WHEN POSITION(UPPER(LEFT(${titleExpr}, 1)) IN 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') > 0
            THEN UPPER(LEFT(${titleExpr}, 1))
        WHEN POSITION(UPPER(LEFT(NORMALIZE(${titleExpr}, NFD), 1)) IN 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') > 0
            THEN UPPER(LEFT(NORMALIZE(${titleExpr}, NFD), 1))
        ELSE '#'
    END`;
}

/** Sort orders accepted by the flat track browse. */
export type TrackBrowseSort = 'alpha' | 'artist' | 'recent';

export interface TrackBrowseOptions {
    /** Default 'alpha'. 'artist' groups by display artist → album year → disc order. */
    sort?: TrackBrowseSort;
    /** Genre tag (case-insensitive), matched against the TRACK's own tags. */
    genre?: string;
    /**
     * Artist filter. A UUID matches by artist identity and is CREDIT-AWARE
     * (album→artist hierarchy OR `additional_artist_ids`), so a "feat."-only
     * artist returns their tracks; anything else is matched as a display name.
     * Prefer the UUID form — name matching cannot see credited artists, which
     * is why `/music/albums?artist=<name>` returns nothing for most of them.
     */
    artist?: string;
}

/** Matches a canonical UUID; decides the artist filter's identity-vs-name branch. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Shared WHERE fragments for the flat track browse, so the page query and the
 * COUNT query can never drift apart (a `total` that disagrees with the rows it
 * describes is worse than no total at all).
 */
function trackBrowseFilters(
    sql: postgres.Sql,
    access: MediaAccessBoundary,
    options: TrackBrowseOptions,
): ReturnType<postgres.Sql> {
    const deniedGroupIds: string[] | null =
        access.library.kind === 'denyGroups' ? access.library.ids : null;
    const ageRating: AgeRatingFilterParams | null =
        access.age.kind === 'limit'
            ? { maxAgeRating: access.age.maxAgeRating, allowUnrated: access.age.allowUnrated }
            : null;

    const accessFilter = deniedGroupIds?.length
        ? sql`AND (
              NOT EXISTS (SELECT 1 FROM media_file_items WHERE media_item_id = track.id)
              OR EXISTS (
                  SELECT 1 FROM media_file_items mfi2
                  JOIN media_files mf2 ON mf2.id = mfi2.file_id
                  WHERE mfi2.media_item_id = track.id
                  AND (mf2.library_group_id IS NULL
                       OR mf2.library_group_id != ALL(${deniedGroupIds}::uuid[]))
              )
          )`
        : sql``;
    // Age gate on the track itself. Empty (and free) for unrestricted callers;
    // an age-restricted caller only sees a track within their age cap.
    const ageFilter =
        ageRating && ageRating.maxAgeRating !== null
            ? sql`AND ((track.age_rating IS NULL AND ${ageRating.allowUnrated}::boolean)
                       OR track.age_rating <= ${ageRating.maxAgeRating})`
            : sql``;

    const genreFilter = options.genre
        ? sql`AND music_genre_tags(track.custom_metadata) @> ARRAY[LOWER(${options.genre})]::text[]`
        : sql``;

    const artistFilter = !options.artist
        ? sql``
        : UUID_RE.test(options.artist)
          ? sql`AND (
                album.parent_id = ${options.artist}::uuid
                OR track.custom_metadata -> 'additional_artist_ids'
                   @> to_jsonb(ARRAY[${options.artist}::text])
            )`
          : sql`AND (
                artist.title ILIKE ${options.artist}
                OR track.custom_metadata->>'artist' ILIKE ${options.artist}
            )`;

    return sql`${accessFilter} ${ageFilter} ${genreFilter} ${artistFilter}`;
}

/**
 * Total number of tracks a flat browse would yield under the same boundary and
 * filters. Split out so `page.total` is opt-in — callers that only need
 * `hasMore` never pay for the COUNT.
 */
export async function countTracksPaged(
    sql: postgres.Sql,
    access: MediaAccessBoundary,
    options: TrackBrowseOptions = {},
): Promise<number> {
    if (deniesEverything(access)) return 0;
    const rows = await sql<{ total: number }[]>`
        SELECT COUNT(*)::int AS total
        FROM media_items track
        LEFT JOIN media_items album ON album.id = track.parent_id AND album.media_type = 'album'
        LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
        WHERE track.media_type = 'track'
          AND track.has_files = true
          ${trackBrowseFilters(sql, access, options)}
    `;
    return rows[0]?.total ?? 0;
}

export async function getTracksPaged(
    sql: postgres.Sql,
    userId: UserId,
    limit: number,
    offset: number,
    access: MediaAccessBoundary,
    options: TrackBrowseOptions = {},
): Promise<RecentTrackRow[]> {
    if (deniesEverything(access)) return [];
    const filters = trackBrowseFilters(sql, access, options);
    // Every branch ends in `track.id ASC`: the sort keys are not unique, and
    // without a tiebreaker OFFSET paging reshuffles rows on ties (duplicates on
    // one page, missing rows on the next). Same rule as buildMusicSortFragment.
    // PostgreSQL permits a SELECT alias only as a standalone ORDER BY item,
    // so COALESCE must use the display-artist expression rather than its alias.
    const orderFragment =
        options.sort === 'recent'
            ? sql`track.created_at DESC, track.id ASC`
            : options.sort === 'artist'
              ? sql`COALESCE(${trackDisplayArtistSql(sql)}, '') ASC, COALESCE(album.year, 0) ASC,
                    COALESCE(album.title, '') ASC, COALESCE(track.sort_order, 0) ASC,
                    track.title ASC, track.id ASC`
              : sql`track.title ASC, track.id ASC`;
    const columns = sql`
            track.id,
            track.title,
            track.sort_order,
            track.runtime_seconds,
            track.custom_poster_url,
            COALESCE(track.custom_metadata, '{}'::jsonb) AS custom_metadata,
            album.id AS album_id,
            album.title AS album_title,
            album.custom_poster_url AS album_custom_poster_url,
            ${trackArtistIdSql(sql)} AS artist_id,
            ${trackDisplayArtistSql(sql)} AS artist_title,
            ${trackArtistsSql(sql, 'track')} AS track_artists,
            ${trackRemixerArtistsSql(sql, 'track')} AS remixer_artists,
            track.created_at::text AS last_played_at,
            (EXTRACT(EPOCH FROM (NOW() - ums.last_played_at)) / 3600)::double precision AS hours_since_played,
            mf.file_path AS file_path`;
    const albumArtistJoins = sql`
        LEFT JOIN media_items album ON album.id = track.parent_id AND album.media_type = 'album'
        LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'`;
    const perUserJoins = sql`
        LEFT JOIN user_music_state ums ON ums.track_id = track.id AND ums.user_id = ${userId}
        ${trackFilePathJoin(sql)}`;
    const browseWhere = sql`
        WHERE track.media_type = 'track'
          AND track.has_files = true
          ${filters}`;

    if (offset === 0) {
        return sql<RecentTrackRow[]>`
            SELECT ${columns}
            FROM media_items track
            ${albumArtistJoins}
            ${perUserJoins}
            ${browseWhere}
            ORDER BY ${orderFragment}
            LIMIT ${limit}
        `;
    }
    // Past the first page, choose the page from ids first and compute the costly
    // columns (credited artist, file path) for that page only. In one SELECT,
    // Postgres builds them for every row OFFSET skips: 2 rows at offset 16,384
    // took ~1.2 s on prod, ~60 ms this way. Same filters, joins and total order,
    // and the joins added afterwards are 1:1 (user_music_state is unique per
    // user and track, the file lateral is LIMIT 1), so the rows are unchanged.
    // The first page keeps the single SELECT: nothing is skipped there, and it
    // keeps Postgres's parallel sort for the artist order (~230 vs ~500 ms).
    return sql<RecentTrackRow[]>`
        WITH page AS (
            SELECT track.id
            FROM media_items track
            ${albumArtistJoins}
            ${browseWhere}
            ORDER BY ${orderFragment}
            LIMIT ${limit}
            OFFSET ${offset}
        )
        SELECT ${columns}
        FROM page
        JOIN media_items track ON track.id = page.id
        ${albumArtistJoins}
        ${perUserJoins}
        ORDER BY ${orderFragment}
    `;
}

export async function getMostPlayedAlbums(
    sql: postgres.Sql,
    userId: UserId,
    limit: number,
    offset: number,
): Promise<MusicAlbumRow[]> {
    return sql<MusicAlbumRow[]>`
        SELECT
            mi.id,
            mi.title,
            mi.overview,
            mi.custom_poster_url,
            mi.custom_backdrop_url,
            COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
            mi.year,
            mi.parent_id AS artist_id,
            artist.title AS artist_title,
            COUNT(DISTINCT track.id)::int AS track_count,
            COALESCE(SUM(track.runtime_seconds), 0)::double precision AS total_duration,
            mi.created_at::text AS created_at,
            COALESCE(SUM(ums.play_count), 0) AS total_play_count
        FROM media_items mi
        JOIN media_items track
          ON track.parent_id = mi.id AND track.media_type = 'track' AND track.has_files = true
        JOIN user_music_state ums
          ON ums.track_id = track.id AND ums.user_id = ${userId} AND ums.play_count > 0
        LEFT JOIN media_items artist ON artist.id = mi.parent_id AND artist.media_type = 'artist'
        WHERE mi.media_type = 'album'
        GROUP BY mi.id, mi.title, mi.overview, mi.custom_poster_url, mi.custom_backdrop_url,
                 mi.custom_metadata, mi.year, mi.parent_id, artist.title, mi.created_at
        ORDER BY total_play_count DESC
        LIMIT ${limit}
        OFFSET ${offset}
    `;
}

// =============================================================================
// Genre-based browsing
// =============================================================================

/**
 * Get albums matching a genre string. Finds albums that contain at least one
 * track whose custom_metadata genre matches the genre (case-insensitive).
 * Handles both JSON array genres (["Electronic","Hardstyle"]) and scalar strings.
 */
export async function getMusicByGenre(
    sql: postgres.Sql,
    genre: string | string[],
    /**
     * Applied exactly as {@link getAlbums} applies it: the album's age rating,
     * and every track count / genre match only over tracks the caller can play.
     */
    access: MediaAccessBoundary,
    limit = 50,
    /**
     * Stable ordering seed, same idea as `getTracksByGenre`'s: the rail is
     * ordered by `md5(album_id || seed)` instead of by title.
     *
     * Without one this returns the alphabetically FIRST `limit` albums of the
     * genre, which is what shipped — every genre rail on `/api/v1/music`
     * opened on punctuation and compilations (`+`, `-`, `=`,
     * `100 Hits Rock Anthems - CD1`), and the same twenty albums every day
     * forever. All the ranking upstream picks WHICH genres get a rail; none of
     * it reached the items, so the shelf was `ORDER BY title LIMIT 20`.
     *
     * Seeded rather than `RANDOM()` because the caller caches the rail per
     * user per day: a fresh draw per request would reshuffle the shelf under
     * anyone who scrolled away and back, and would not match the cached rail
     * list it belongs to.
     */
    orderSeed?: string,
): Promise<MusicAlbumRow[]> {
    if (deniesEverything(access)) return [];
    // Accepts every stored spelling of one genre, not just the display name:
    // the ranker folds `Hip Hop`/`Hip-Hop`/`HipHop` into one rail, and matching
    // only the dominant variant would silently drop the others' tracks.
    // `&&` (overlap) instead of `@>` (contains) — still a GIN index scan.
    const variants = (Array.isArray(genre) ? genre : [genre]).map((g) => g.toLowerCase());
    // `DISTINCT ON (mi.title, mi.id)` used to sit here. It deduped nothing —
    // `mi.id` is the primary key, so the pair is unique by construction and no
    // two rows could ever collapse (the live rail happily returned three
    // different albums called "Alpha"). Its only real effect was to REQUIRE
    // `ORDER BY mi.title, mi.id`, which is how the alphabetical shelf got
    // locked in. Dropping it is what lets the ordering below be chosen freely.
    const ordering = orderSeed
        ? sql`ORDER BY md5(mi.id::text || ${orderSeed})`
        : sql`ORDER BY mi.title, mi.id`;
    return sql<MusicAlbumRow[]>`
        SELECT
            mi.id,
            mi.title,
            mi.overview,
            mi.custom_poster_url,
            mi.custom_backdrop_url,
            COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
            mi.year,
            mi.parent_id AS artist_id,
            CASE
                WHEN artist.title IS NOT NULL AND artist.title != 'Unknown Artist'
                THEN artist.title
                ELSE (
                    SELECT t.custom_metadata->>'artist'
                    FROM media_items t
                    WHERE t.parent_id = mi.id AND t.media_type = 'track'
                      AND t.custom_metadata->>'artist' IS NOT NULL
                          ${playableTrackSql(sql, 't')}
                    GROUP BY t.custom_metadata->>'artist'
                    ORDER BY COUNT(*) DESC
                    LIMIT 1
                )
            END AS artist_title,
            mi.created_at::text AS created_at,
            (
                SELECT COUNT(*)::int
                FROM media_items tracks
                WHERE tracks.parent_id = mi.id
                  AND tracks.media_type = 'track'
                  ${playableTrackSql(sql, 'tracks', access)}
            ) AS track_count,
            (
                SELECT COALESCE(SUM(tracks.runtime_seconds), 0)::int
                FROM media_items tracks
                WHERE tracks.parent_id = mi.id
                  AND tracks.media_type = 'track'
                  ${playableTrackSql(sql, 'tracks', access)}
            ) AS total_duration
        FROM media_items mi
        LEFT JOIN media_items artist ON artist.id = mi.parent_id
        WHERE mi.media_type = 'album'
          AND mi.parent_id IS NOT NULL
          ${availableAlbumSql(sql, 'mi', access)}
          AND EXISTS (
              SELECT 1 FROM media_items track
              WHERE track.parent_id = mi.id
                AND track.media_type = 'track'
                ${playableTrackSql(sql, 'track', access)}
                AND music_genre_tags(track.custom_metadata) && ${variants}::text[]
          )
        ${ordering}
        LIMIT ${limit}
    `;
}

/**
 * Get individual tracks matching a genre, with album and artist context.
 * Genre matching uses the same logic as getMusicByGenre (JSONB array unnesting).
 * Ordered alphabetically by title.
 */
export async function getTracksByGenre(
    sql: postgres.Sql,
    /**
     * One genre, or every stored spelling of it. The ranker folds
     * Hip Hop / Hip-Hop / HipHop into a single rail and hands over all of
     * them; matching only the dominant variant would silently drop the
     * others' tracks. Mirrors getMusicByGenre, which has always taken the
     * array form.
     */
    genre: string | string[],
    access: MediaAccessBoundary,
    limit = 500,
    excludeIds?: string[] | null,
    /**
     * Stable ordering seed. When given, the pool is ordered by
     * `md5(track_id || seed)` instead of `RANDOM()` — a different-looking but
     * DETERMINISTIC order, so the same caller asking for the same genre gets the
     * same candidates back.
     *
     * Without this the caller's own seeded shuffle is decorative: `RANDOM()`
     * redraws which 28 of (up to 8,000) tracks are even considered on every
     * request, so the rail reshuffled under the viewer no matter how carefully
     * the selection downstream was seeded. Omit it for callers that genuinely
     * want a fresh draw.
     */
    orderSeed?: string,
): Promise<GenreTrackRow[]> {
    if (deniesEverything(access)) return [];
    // Derive the legacy predicate inputs from the boundary; SQL is unchanged.
    const deniedGroupIds: string[] | null =
        access.library.kind === 'denyGroups' ? access.library.ids : null;
    const ageRating: AgeRatingFilterParams | null =
        access.age.kind === 'limit'
            ? { maxAgeRating: access.age.maxAgeRating, allowUnrated: access.age.allowUnrated }
            : null;
    const genreVariants = (Array.isArray(genre) ? genre : [genre]).map((g) => g.toLowerCase());
    // Exclude tracks already shown in the carousel so "load more" returns fresh
    // candidates (the base query orders by RANDOM(), so without this the next
    // page would overlap heavily with what's already on screen).
    const excludeFilter = excludeIds?.length ? sql`AND t.id != ALL(${excludeIds}::uuid[])` : sql``;
    // Deterministic when seeded, genuinely random otherwise. md5 over the id is
    // uniform enough to scatter a genre's tracks and costs nothing next to the
    // sort this already does.
    const orderFragment = orderSeed
        ? sql`ORDER BY md5(t.id::text || ${orderSeed})`
        : sql`ORDER BY RANDOM()`;
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
    return sql<GenreTrackRow[]>`
        SELECT
            t.id,
            t.title,
            t.sort_order,
            t.runtime_seconds,
            t.custom_poster_url,
            COALESCE(t.custom_metadata, '{}'::jsonb) AS custom_metadata,
            album.id AS album_id,
            album.title AS album_title,
            album.custom_poster_url AS album_custom_poster_url,
            -- Track-level, not the album-artist join. These rows back the
            -- genre carousels: artist_id lands in clickData.artistId and
            -- artist_title is the card subtitle. On a compilation the album
            -- artist is the Various Artists row -- the same bug 91aa562d9
            -- fixed in the quick-picks buckets.
            --
            -- BOTH move together on purpose. Here the pair was at least
            -- self-consistent (id and name were both the album artist), so
            -- changing only the id would have made them disagree, which is
            -- precisely the state 91aa562d9 was fixing elsewhere.
            --
            -- No backticks in this comment: it sits inside a tagged template
            -- literal and one would end the query mid-string.
            ${trackArtistIdSql(sql, 't')} AS artist_id,
            ${trackDisplayArtistSql(sql, 't')} AS artist_title,
            ${trackArtistsSql(sql, 't')} AS track_artists,
            ${trackRemixerArtistsSql(sql, 't')} AS remixer_artists,
            album.year,
            mf.file_path AS file_path
        FROM media_items t
        INNER JOIN media_items album ON album.id = t.parent_id AND album.media_type = 'album'
        LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
        ${trackFilePathJoin(sql, 't')}
        WHERE t.media_type = 'track'
          AND t.has_files = true
          -- Index-backed genre membership (idx_media_items_genre_tags, GIN).
          AND music_genre_tags(t.custom_metadata) && ${genreVariants}::text[]
          ${excludeFilter}
          ${accessFilter}
          ${ageFilter}
        ${orderFragment}
        LIMIT ${limit}
    `;
}

/** One genre's album-capped listening weight for a viewer. */
export interface UserGenreAffinityRow {
    /** Raw stored genre tag, lowercased by `music_genre_tags`. Fold to a key in TS. */
    genre: string;
    /** Album-capped weight — see {@link getUserGenreAffinity}. */
    weight: number;
}

/**
 * How much this viewer actually listens to each genre, album-capped.
 *
 * The evidence half of the genre-rail ranking (`genre-ranker.service.ts`); the
 * library's own genre sizes are the prior. Sourced from `user_music_state`
 * rather than `watch_history` (what Smart Mixes uses) because only this table
 * carries a SKIP signal, and skipping is the clearest "not for me" a listener
 * gives us.
 *
 *   w(track)  = clamp(complete_count, 0..3) − clamp(skip_count − complete_count, 0..3)
 *   w(album)  = min( Σ w(track) over that album's tracks in the genre, 6 )
 *   weight(g) = Σ w(album)
 *
 * Both caps exist to stop one obsession from owning a rail. Per-track: a song
 * played 200 times counts 3, the same as one played 3 times — a rail is a
 * "genres you like" signal, not a play counter. Per-album: measured on prod, the
 * heaviest listener's raw affinity ranks Avant-Garde Metal 17th off 11 completes
 * that all come from a SINGLE album in a 31-track genre. Without the album cap
 * that becomes a rail which cannot even fill itself.
 *
 * Access-scoped deliberately. The rows are the caller's own, but a track in a
 * library group they cannot see must not score a genre — otherwise we rank a
 * rail that renders empty for them.
 */
export async function getUserGenreAffinity(
    sql: postgres.Sql,
    userId: string,
    access: MediaAccessBoundary,
): Promise<UserGenreAffinityRow[]> {
    if (deniesEverything(access)) return [];
    const deniedGroupIds: string[] | null =
        access.library.kind === 'denyGroups' ? access.library.ids : null;
    const ageRating: AgeRatingFilterParams | null =
        access.age.kind === 'limit'
            ? { maxAgeRating: access.age.maxAgeRating, allowUnrated: access.age.allowUnrated }
            : null;

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

    const rows = await sql<{ genre: string; weight: string }[]>`
        WITH scored AS (
            SELECT
                t.id,
                COALESCE(t.parent_id, t.id) AS album_key,
                g.tag AS genre,
                GREATEST(
                    0,
                    LEAST(ums.complete_count, 3)
                        - LEAST(GREATEST(ums.skip_count - ums.complete_count, 0), 3)
                ) AS w
            FROM user_music_state ums
            JOIN media_items t ON t.id = ums.track_id AND t.media_type = 'track'
            CROSS JOIN LATERAL unnest(music_genre_tags(t.custom_metadata)) AS g(tag)
            WHERE ums.user_id = ${userId}::uuid
              AND t.has_files = true
              ${accessFilter}
              ${ageFilter}
        ),
        per_album AS (
            SELECT genre, album_key, LEAST(SUM(w), 6) AS album_weight
            FROM scored
            GROUP BY genre, album_key
        )
        SELECT genre, SUM(album_weight)::text AS weight
        FROM per_album
        WHERE album_weight > 0
        GROUP BY genre
        ORDER BY SUM(album_weight) DESC
    `;

    return rows.map((r) => ({ genre: r.genre, weight: Number.parseInt(r.weight, 10) || 0 }));
}

/**
 * Hydrate full track rows for a specific list of track IDs.
 * Preserves the caller's requested order (not DB natural order).
 * Silently drops IDs that don't correspond to a track (deleted, not music, etc.).
 * Used by the Phase 2 lazy genre endpoint to hydrate IDs from a pre-computed plan.
 */
export async function getTracksByIds(sql: postgres.Sql, ids: string[]): Promise<GenreTrackRow[]> {
    if (ids.length === 0) return [];
    const rows = await sql<GenreTrackRow[]>`
        SELECT
            t.id,
            t.title,
            t.sort_order,
            t.runtime_seconds,
            t.custom_poster_url,
            COALESCE(t.custom_metadata, '{}'::jsonb) AS custom_metadata,
            album.id AS album_id,
            album.title AS album_title,
            album.custom_poster_url AS album_custom_poster_url,
            -- Track-level, not the album-artist join. These rows back the
            -- genre carousels: artist_id lands in clickData.artistId and
            -- artist_title is the card subtitle. On a compilation the album
            -- artist is the Various Artists row -- the same bug 91aa562d9
            -- fixed in the quick-picks buckets.
            --
            -- BOTH move together on purpose. Here the pair was at least
            -- self-consistent (id and name were both the album artist), so
            -- changing only the id would have made them disagree, which is
            -- precisely the state 91aa562d9 was fixing elsewhere.
            --
            -- No backticks in this comment: it sits inside a tagged template
            -- literal and one would end the query mid-string.
            ${trackArtistIdSql(sql, 't')} AS artist_id,
            ${trackDisplayArtistSql(sql, 't')} AS artist_title,
            ${trackArtistsSql(sql, 't')} AS track_artists,
            ${trackRemixerArtistsSql(sql, 't')} AS remixer_artists,
            album.year,
            mf.file_path AS file_path
        FROM media_items t
        INNER JOIN media_items album ON album.id = t.parent_id AND album.media_type = 'album'
        LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
        ${trackFilePathJoin(sql, 't')}
        WHERE t.media_type = 'track'
          AND t.id = ANY(${ids})
    `;
    const byId = new Map<string, GenreTrackRow>();
    for (const row of rows) byId.set(row.id, row);
    return ids.map((id) => byId.get(id)).filter((r): r is GenreTrackRow => r !== undefined);
}

/**
 * Get all distinct genres present in the music library with track counts.
 * Handles both JSON array genres (["Electronic","Hardstyle"]) and scalar strings,
 * unnesting arrays into individual genre values before grouping.
 */
export interface MusicGenreRow {
    genre: string;
    track_count: number;
    album_count: number;
}

export async function getDistinctMusicGenres(
    sql: postgres.Sql,
    access: {
        deniedGroupIds: string[] | null;
        ageRating: AgeRatingFilterParams | null;
    },
): Promise<MusicGenreRow[]> {
    const denied = access.deniedGroupIds;
    const age = access.ageRating;
    return sql<MusicGenreRow[]>`
        WITH track_genre AS MATERIALIZED (
            -- Read custom_metadata->'genre' once per track. custom_metadata is
            -- TOASTed for most tracks (~4 KB), and every further ->/->> on it
            -- detoasts the whole value again; the old shape did that 4-5 times
            -- per row (640k buffer hits, ~2 s on prod). MATERIALIZED keeps the
            -- planner from inlining this back. genre_json #>> '{}' is the same
            -- text as custom_metadata->>'genre'.
            SELECT
                t.id,
                t.parent_id,
                t.custom_metadata -> 'genre' AS genre_json
            FROM media_items t
            WHERE t.media_type = 'track'
              ${playableTrackSql(sql, 't')}
              ${
                  denied && denied.length > 0
                      ? sql`AND EXISTS (
                  SELECT 1 FROM media_file_items mfi
                  JOIN media_files mf ON mf.id = mfi.file_id
                  WHERE mfi.media_item_id = t.id
                    AND NOT mf.is_missing
                    AND (mf.library_group_id IS NULL
                         OR mf.library_group_id != ALL(${denied}::uuid[]))
              )`
                      : sql``
              }
              ${
                  age && age.maxAgeRating !== null
                      ? sql`AND (
                  (t.age_rating IS NULL AND ${age.allowUnrated}::boolean)
                  OR t.age_rating <= ${age.maxAgeRating}
              )`
                      : sql``
              }
        ),
        genre_expanded AS (
            SELECT
                tg.id,
                tg.parent_id,
                TRIM(elem) AS genre
            FROM track_genre tg,
                jsonb_array_elements_text(
                    CASE jsonb_typeof(tg.genre_json)
                        WHEN 'array' THEN tg.genre_json
                        ELSE jsonb_build_array(tg.genre_json #>> '{}')
                    END
                ) AS elem
            WHERE (tg.genre_json #>> '{}') IS NOT NULL
              AND TRIM(tg.genre_json #>> '{}') != ''
        )
        SELECT
            genre,
            COUNT(DISTINCT id)::int AS track_count,
            COUNT(DISTINCT parent_id)::int AS album_count
        FROM genre_expanded
        WHERE genre != ''
        GROUP BY genre
        ORDER BY track_count DESC
    `;
}

/** One album chosen to represent a genre in a collage tile. */
export interface GenreCoverRow {
    genre: string;
    album_id: string;
}

/**
 * Pick up to `perGenre` representative album ids for each of `genres`.
 *
 * Feeds the genre collage tiles on /music/explore. Genres are the only browse
 * surface in the app with no artwork at all — they render as bare text while
 * albums, playlists, artists and radio stations all get covers — and a library
 * always has its own album art to build one from, so nothing needs generating.
 *
 * Returns album IDs, never URLs. The client resolves them through the CATALOG
 * image route, which walks the parent chain and falls through to provider art
 * and finally a placeholder; a `custom_poster_url` copied out of the row here
 * would 404 to a permanent grey tile the moment the paired artwork row was
 * purged. The column is still used as a SELECTION filter, because a local
 * cover is the one we know resolves — a ranking signal, not the thing handed
 * to the browser.
 *
 * SHAPE. One LATERAL per genre, driven by `idx_media_items_genre_tags` (the
 * GIN index on `music_genre_tags(custom_metadata)`), each stopping at
 * `perGenre` rows. The obvious alternative — expand every track's genre jsonb
 * in a CTE, aggregate per (genre, album), rank with ROW_NUMBER — cannot use
 * that index and measured 1551 ms / ~5 GB of buffers against a 30k-track
 * library to return 96 rows. This form measured 119 ms on the same data.
 * Four decorative tiles do not justify ranking every album in the library.
 *
 * `music_genre_tags` lowercases its output, so the genre names coming back
 * from `getDistinctMusicGenres` (original case) are folded with LOWER here.
 *
 * ACCESS. Filters sit on the TRACK rows, mirroring `getDistinctMusicGenres`
 * exactly, and the album is reached only THROUGH a track that passed them —
 * so no album surfaces whose content the viewer cannot already see. The album
 * row is deliberately not filtered again on library group: container rows own
 * no files, so an own-files predicate on an album is a no-op that would read
 * as protection without being any.
 */
export async function getGenreCoverAlbums(
    sql: postgres.Sql,
    genres: string[],
    access: {
        deniedGroupIds: string[] | null;
        ageRating: AgeRatingFilterParams | null;
    },
    perGenre = 4,
): Promise<GenreCoverRow[]> {
    if (genres.length === 0) return [];
    const denied = access.deniedGroupIds;
    const age = access.ageRating;
    return sql<GenreCoverRow[]>`
        SELECT g.genre, a.album_id
        FROM unnest(${genres}::text[]) AS g(genre)
        CROSS JOIN LATERAL (
            SELECT DISTINCT track.parent_id AS album_id
            FROM media_items track
            WHERE track.media_type = 'track'
              ${playableTrackSql(sql, 'track')}
              AND track.parent_id IS NOT NULL
              AND music_genre_tags(track.custom_metadata) @> ARRAY[LOWER(g.genre)]::text[]
              ${
                  denied && denied.length > 0
                      ? sql`AND EXISTS (
                  SELECT 1 FROM media_file_items mfi
                  JOIN media_files mf ON mf.id = mfi.file_id
                  WHERE mfi.media_item_id = track.id
                    AND NOT mf.is_missing
                    AND (mf.library_group_id IS NULL
                         OR mf.library_group_id != ALL(${denied}::uuid[]))
              )`
                      : sql``
              }
              ${
                  age && age.maxAgeRating !== null
                      ? sql`AND (
                  (track.age_rating IS NULL AND ${age.allowUnrated}::boolean)
                  OR track.age_rating <= ${age.maxAgeRating}
              )`
                      : sql``
              }
              AND EXISTS (
                  SELECT 1 FROM media_items alb
                  WHERE alb.id = track.parent_id
                    AND alb.media_type = 'album'
                    AND alb.status = 'active' AND NOT alb.is_dismissed
                    AND alb.custom_poster_url IS NOT NULL
                    AND alb.custom_poster_url != ''
              )
            ORDER BY track.parent_id
            LIMIT ${perGenre}
        ) a
        ORDER BY g.genre, a.album_id
    `;
}

// =============================================================================
// User-specific browsing
// =============================================================================

export interface TopArtistRow {
    id: string;
    title: string;
    custom_poster_url: string | null;
    album_count: number;
    play_count: number;
}

/**
 * Get a user's most-played artists, ranked by total play count across
 * all tracks by that artist. Only returns artists with at least one play.
 *
 * Reads from `user_music_state` (the authoritative source of music play
 * counts) rather than `watch_history`. Per project convention, music plays
 * do NOT land in watch_history — only the aggregate per-track state does
 * (see play-session-lifecycle.service.ts, which gates `!isMusicTrack` before
 * writing watch_history). Reading watch_history here always returned 0 rows,
 * permanently starving the /music "Top Artists" section and forcing the
 * album-count fallback in +page.server.ts.
 */
export async function getMostPlayedArtists(
    sql: postgres.Sql,
    userId: UserId,
    limit = 10,
    deniedGroupIds?: string[] | null,
    ageRating?: AgeRatingFilterParams | null,
): Promise<TopArtistRow[]> {
    return sql<TopArtistRow[]>`
        SELECT
            artist.id,
            artist.title,
            COALESCE(
                artist.custom_poster_url,
                (SELECT a.custom_poster_url FROM media_items a
                 WHERE a.parent_id = artist.id AND a.media_type = 'album'
                   AND a.status = 'active' AND NOT a.is_dismissed
                   AND EXISTS (SELECT 1 FROM media_items t WHERE t.parent_id = a.id
                       AND t.media_type = 'track' ${playableTrackSql(sql, 't')})
                   AND a.custom_poster_url IS NOT NULL
                 LIMIT 1)
            ) AS custom_poster_url,
            (
                SELECT COUNT(*)::int
                FROM media_items a
                WHERE a.parent_id = artist.id AND a.media_type = 'album'
                   AND a.status = 'active' AND NOT a.is_dismissed
                   AND EXISTS (SELECT 1 FROM media_items t WHERE t.parent_id = a.id
                       AND t.media_type = 'track' ${playableTrackSql(sql, 't')})
            ) AS album_count,
            SUM(ums.play_count)::int AS play_count
        FROM user_music_state ums
        JOIN media_items mi ON mi.id = ums.track_id AND mi.media_type = 'track'
        JOIN media_items album ON album.id = mi.parent_id AND album.media_type = 'album'
        JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
        WHERE ums.user_id = ${userId}
          AND ums.play_count > 0
          ${playableTrackSql(sql, 'mi')}
          ${availableAlbumSql(sql, 'album')}
          AND artist.is_various_artists = false
          ${buildLibraryAccessFilter(sql, deniedGroupIds)}
          ${buildAgeRatingFilter(sql, ageRating)}
        GROUP BY artist.id, artist.title, artist.custom_poster_url
        ORDER BY play_count DESC
        LIMIT ${limit}
    `;
}

// =============================================================================
// Library Genres
// =============================================================================

/**
 * Get available genres from the music library with track counts.
 */
export async function getLibraryGenres(
    sql: postgres.Sql,
    minTracks?: number,
): Promise<Array<{ genre: string; trackCount: number }>> {
    const min = minTracks ?? 1;
    return sql<Array<{ genre: string; trackCount: number }>>`
        WITH genre_expanded AS (
            SELECT
                id,
                TRIM(elem) AS genre
            FROM media_items,
                jsonb_array_elements_text(
                    CASE jsonb_typeof(custom_metadata->'genre')
                        WHEN 'array' THEN custom_metadata->'genre'
                        ELSE jsonb_build_array(custom_metadata->>'genre')
                    END
                ) AS elem
            WHERE media_type = 'track'
                AND custom_metadata->>'genre' IS NOT NULL
                AND TRIM(custom_metadata->>'genre') != ''
        )
        SELECT
            genre,
            COUNT(*)::int as "trackCount"
        FROM genre_expanded
        WHERE genre != ''
        GROUP BY genre
        HAVING COUNT(*) >= ${min}
        ORDER BY COUNT(*) DESC
    `;
}

// =============================================================================
// Smart Queue
// =============================================================================

// REMIX_TAG_REGEX and DASH_REMIX_SUFFIX_REGEX are imported from music-title-normalize.ts
// (shared with the sonic path). See that module for documentation.

/**
 * Get smart queue candidates using a blended embedding from multiple signals:
 *
 * **Positive signals** (pull toward):
 * 1. **Current track** (weight 0.5) — immediate context
 * 2. **Session context** (weight 0.3) — average of recently played tracks
 * 3. **User taste** (weight 0.2) — tracks with rating >= 4 (liked tracks
 *    `rating >= 8` are duplicated 3× via LATERAL generate_series so the
 *    taste centroid pulls harder toward them, mirroring Quick Picks' Fix D)
 * 4. **Seed anchor** (weight from MUSIC_AUTOPLAY_SEED_ANCHOR_WEIGHT, default
 *    0.15, additive) — similarity to the FIRST track of the current session
 *    (the LAST element of the client's newest-first history). Without this
 *    signal, after ~10 hops the seed
 *    scrolls out of the session window and the queue drifts toward the
 *    user's dominant taste cluster. The anchor stays in scope for the
 *    whole session and acts as gentle gravity back toward the original
 *    intent of the session.
 *
 * **Negative signals** (push away):
 * 5. **Skip penalty** (−0.3) — session skips
 * 6. **Dislike penalty** (−0.2 soft) — tracks similar to disliked tracks;
 *    disliked tracks themselves are hard-excluded via `dislikedTrackIds`
 * 7. **Burn-out demotion** — `LEAST(skip_count * 0.02, 0.2)` subtracted from
 *    similarity for tracks with persistent skips on `user_music_state`
 *
 * **Remix/variant exclusion**: Strips remix tags from titles and uses
 * pg_trgm `similarity()` to fuzzy-match against recently played tracks.
 * Threshold 0.6 catches "How Do You Do" vs "How Do U Do" while allowing
 * genuinely different songs through.
 *
 * excludeIds should include all tracks already played in this session
 * to prevent repeats. dislikedTrackIds adds explicit + behavioral dislikes
 * on top (see music-quick-picks.queries.ts:getDislikedTrackIds).
 */
export async function getSmartQueueCandidates(
    sql: postgres.Sql,
    trackId: string,
    excludeIds: string[],
    limit = 50,
    options?: {
        /** Recent track IDs from the current session (most recent first) */
        sessionTrackIds?: string[];
        /** User UUID for taste profile lookup */
        userId?: UserId;
        /** Track IDs skipped during this session (for skip penalty) */
        skippedTrackIds?: string[];
        /**
         * Hard-exclude IDs from feedback signals (rating <= 3, ur.skipped,
         * or behavioral skip-dominant). Folded into the candidate filter so
         * disliked tracks never reach the autoplay queue.
         */
        dislikedTrackIds?: string[];
        /**
         * The first track of the current listening session — the LAST
         * element of the client's newest-first history. Adds an additive
         * `anchor_sim * weight`
         * term to the score so each hop is gently pulled back toward the
         * session's origin. Slows the drift toward the user's dominant
         * taste cluster that otherwise dominates after ~10 hops.
         * Omit when there's no history yet, or when the anchor matches the
         * current track (the current_sim term already covers that case).
         */
        sessionAnchorTrackId?: string;
        /** Weight applied to anchor_sim. Default 0.15. Disable with 0. */
        sessionAnchorWeight?: number;
        /**
         * Minimum candidate track length (seconds). Excludes album
         * intros/interludes/skits from autoplay. NULL runtime is kept
         * (treated as long enough). Set 0 to disable.
         */
        minTrackSeconds?: number;
        maxTrackSeconds?: number;
        /**
         * Normalised title stems from the user's persistent play history
         * (see getRecentlyPlayedVariants). Candidates whose normalised
         * title fuzzy-matches any of these are excluded via the same
         * pg_trgm similarity filter used for session-derived titles.
         */
        persistentPlayedTitles?: string[];
        /** Optional seed to bias queue results toward a mood/genre/artist/album */
        seed?: {
            type: 'mood' | 'genre' | 'artist' | 'album';
            mood?: string;
            genre?: string;
            artistId?: string;
            albumId?: string;
        };
        /** Popularity ranking multiplier weight 0..1 (0 disables). */
        popularityWeight?: number;
        /** Power curve exponent for popularity (e.g., 0.5 = sqrt demotion). */
        popularityExponent?: number;
        /** Minimum popularity factor to prevent hard exclusion of deep cuts. */
        popularityFloor?: number;
        /** Primary popularity source identifier, e.g. 'lastfm'. */
        popularityPrimarySource?: string;
    },
): Promise<QueueCandidateRow[]> {
    // Cap disliked IDs at 1000 — long-tail users can accumulate thousands of
    // dislikes over years, and ALL($huge_array) would slow the plan / hit
    // postgres parameter limits. The hard exclude is best-effort safety on
    // top of the soft -0.2 dislike_emb penalty, so dropping the tail beyond
    // 1000 is acceptable. getDislikedTrackIds returns rows ordered newest-
    // first, so slice(0, MAX) keeps the most recent dislikes — those are
    // most load-bearing for current taste.
    const MAX_DISLIKES = 1000;
    const dislikedIds = (options?.dislikedTrackIds ?? []).slice(0, MAX_DISLIKES);
    const mergedExcludes = Array.from(new Set([...excludeIds, ...dislikedIds]));
    const safeExclude =
        mergedExcludes.length > 0 ? mergedExcludes : ['00000000-0000-0000-0000-000000000000'];
    // Keep the FRESHEST entries when trimming — the newest plays/skips
    // matter most for the title filter. The client store sends
    // sessionTrackIds NEWEST-first (historyWithOutgoing prepends), so the
    // head holds the fresh plays; skippedTrackIds is APPENDED oldest-first,
    // so its tail is freshest.
    const sessionIds = options?.sessionTrackIds?.length ? options.sessionTrackIds.slice(0, 10) : [];
    const userId = options?.userId;
    const skippedIds = options?.skippedTrackIds?.length ? options.skippedTrackIds.slice(-20) : [];
    const seed = options?.seed;
    const persistentTitles = options?.persistentPlayedTitles ?? [];
    const popularityWeight = options?.popularityWeight ?? 0;
    const popularityExponent = options?.popularityExponent ?? 0.5;
    const popularityFloor = options?.popularityFloor ?? 0.1;
    const primarySource = options?.popularityPrimarySource ?? 'lastfm';
    // Seed anchor: only emit the CTE row when we actually have an anchor.
    // Skip when the anchor === current track (current_sim already covers
    // that case) so we don't double-weight the same embedding.
    const anchorTrackId =
        options?.sessionAnchorTrackId && options.sessionAnchorTrackId !== trackId
            ? options.sessionAnchorTrackId
            : undefined;
    const anchorWeight = options?.sessionAnchorWeight ?? 0.15;
    const minTrackSeconds = Math.max(0, options?.minTrackSeconds ?? 0);
    const maxTrackSeconds = Math.max(0, options?.maxTrackSeconds ?? 0);

    // Combine current track + session + skipped for remix title matching.
    // Skipped tracks must participate — a rapid skip past a variant means
    // "not this song", which should exclude its siblings too.
    const titleMatchIds = Array.from(new Set([trackId, ...sessionIds, ...skippedIds]));

    // Two-phase ANN sizing: prod EXPLAIN ANALYZE showed the old single-phase
    // query (Seq Scan across all ~23,216 `source = 'music'` embeddings + hash
    // join + 2 sorts + WindowAgg to serve the blended-score ORDER BY, which no
    // index can satisfy) took 271ms per call, vs 39ms for a plain HNSW ANN
    // scan — and this runs on EVERY autoplay "next track" hop. Phase 1 below
    // probes each available positive signal vector via the raw `<=>` operator
    // (HNSW-eligible) and unions the neighbourhoods into a bounded pool;
    // phase 2 (the `distances`/`scored`/`title_deduped` chain, unchanged)
    // re-scores only that pool. `mergedExcludes.length` is folded in
    // additively because phase 2 still drops every hard-excluded id — a pool
    // sized only off `limit` would ignore that volume and could starve
    // phase 2 after filtering. Capped at 1000: pgvector rejects an
    // hnsw.ef_search above that.
    const perProbePool = Math.min(1000, Math.max(500, limit * 10 + mergedExcludes.length));

    return sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        // ef_search must cover perProbePool so the HNSW graph traversal for
        // each phase-1 probe actually visits enough nodes to return that many
        // neighbours (pgvector default is 40).
        await tx`SELECT set_config('hnsw.ef_search', ${String(perProbePool)}, true)`;
        return tx<QueueCandidateRow[]>`
        WITH
        -- Normalize titles of current + session + skipped tracks, plus the
        -- user's persistent-play cool-down stems, for remix/variant detection.
        played_titles AS (
            SELECT DISTINCT
                lower(regexp_replace(
                    regexp_replace(mi.title, ${REMIX_TAG_REGEX}, '', 'gi'),
                    ${DASH_REMIX_SUFFIX_REGEX}, '', 'gi'
                )) AS norm_title
            FROM media_items mi
            WHERE mi.id = ANY(${titleMatchIds})
            UNION
            SELECT DISTINCT unnest(${persistentTitles}::text[]) AS norm_title
        ),
        current_emb AS (
            SELECT me.embedding
            FROM media_embeddings me
            WHERE me.media_id = ${trackId}
              AND me.source = 'music'
            LIMIT 1
        ),
        -- Extract current track's genre tags for overlap scoring
        current_genres AS (
            SELECT array_agg(DISTINCT LOWER(g)) AS genres
            FROM media_items mi,
                 jsonb_array_elements_text(
                     CASE jsonb_typeof(mi.custom_metadata->'genre')
                         WHEN 'array' THEN mi.custom_metadata->'genre'
                         ELSE '[]'::jsonb
                     END
                 ) AS g
            WHERE mi.id = ${trackId}
        ),
        session_emb AS (
            SELECT AVG(me.embedding) AS embedding
            FROM media_embeddings me
            WHERE me.source = 'music'
              ${sessionIds.length > 0 ? sql`AND me.media_id = ANY(${sessionIds})` : sql`AND FALSE`}
        ),
        taste_emb AS (
            -- Like-weighted average: liked tracks (rating >= 8) are duplicated
            -- 3× via LATERAL generate_series so the taste centroid pulls
            -- harder toward them. Mirrors Quick Picks Fix D (LIKE_WEIGHT=3 in
            -- taste-clusters.service.ts). Explicit dislikes (rating <= 3) and
            -- session-dismissed (ur.skipped) are kept out so they can't shape
            -- the positive centroid.
            SELECT AVG(me.embedding) AS embedding
            FROM media_embeddings me
            JOIN (
                SELECT t.media_id
                FROM (
                    SELECT ums.track_id AS media_id,
                           LEAST(COALESCE(ums.play_count, 0), 20) + COALESCE(ur.rating, 0) AS score,
                           CASE WHEN COALESCE(ur.rating, 0) >= 8 THEN 3 ELSE 1 END AS weight
                    FROM user_music_state ums
                    JOIN media_items mi ON mi.id = ums.track_id AND mi.media_type = 'track'
                    LEFT JOIN user_ratings ur ON ur.media_id = ums.track_id AND ur.user_id = ums.user_id
                    WHERE ums.user_id = ${userId ?? null}::uuid
                      ${userId !== undefined ? sql`` : sql`AND FALSE`}
                      AND (ur.rating IS NULL OR ur.rating >= 4)
                      AND (ur.skipped IS NULL OR ur.skipped = FALSE)
                    ORDER BY score DESC
                    LIMIT 30
                ) t
                CROSS JOIN LATERAL generate_series(1, t.weight) AS dup
            ) top ON top.media_id = me.media_id
            WHERE me.source = 'music'
        ),
        -- Skip signal: average embedding of session-skipped tracks
        skip_emb AS (
            SELECT AVG(me.embedding) AS embedding
            FROM media_embeddings me
            WHERE me.source = 'music'
              ${skippedIds.length > 0 ? sql`AND me.media_id = ANY(${skippedIds})` : sql`AND FALSE`}
        ),
        -- Dislike signal: average embedding of persistently disliked tracks
        dislike_emb AS (
            SELECT AVG(me.embedding) AS embedding
            FROM media_embeddings me
            JOIN user_ratings ur ON ur.media_id = me.media_id
            WHERE me.source = 'music'
              AND ur.user_id = ${userId ?? null}::uuid
              ${userId !== undefined ? sql`` : sql`AND FALSE`}
              AND ur.rating <= 3
        ),
        -- Session-start anchor embedding. Set to the FIRST track of the
        -- current session (the oldest history entry, resolved by the route
        -- handler from the newest-first history param). Pulls every
        -- hop back toward the seed by anchorWeight × cosine; without this,
        -- the queue drifts to the user's dominant taste cluster after ~10
        -- hops because the actual seed scrolls out of session_emb's window.
        anchor_emb AS (
            ${
                anchorTrackId
                    ? sql`SELECT me.embedding FROM media_embeddings me WHERE me.media_id = ${anchorTrackId} AND me.source = 'music' LIMIT 1`
                    : sql`SELECT NULL::vector AS embedding WHERE FALSE`
            }
        ),
        -- Seed embedding: biases results toward a mood/artist/album context
        seed_emb AS (
            ${
                seed?.type === 'mood' && seed.mood
                    ? // The column is `vector`, and music moods are stored namespaced
                      // (music:chill) while the seed carries the bare key.
                      sql`SELECT vector AS embedding FROM mood_vectors WHERE mood_key = ${musicMoodVectorKey(seed.mood)} AND model_id = 'text' LIMIT 1`
                    : seed?.type === 'artist' && seed.artistId
                      ? sql`SELECT AVG(me.embedding) AS embedding FROM media_embeddings me JOIN media_items mi ON mi.id = me.media_id WHERE mi.media_type = 'track' AND mi.parent_id IN (SELECT id FROM media_items WHERE parent_id = ${seed.artistId} AND media_type = 'album') AND me.source = 'music'`
                      : seed?.type === 'album' && seed.albumId
                        ? sql`SELECT AVG(me.embedding) AS embedding FROM media_embeddings me JOIN media_items mi ON mi.id = me.media_id WHERE mi.media_type = 'track' AND mi.parent_id = ${seed.albumId} AND me.source = 'music'`
                        : // `genre` was in the seed type union from the start but had no
                          // branch here, so it fell through to the empty arm below: a
                          // client sending a genre seed got no seed vector AND lost the
                          // genre-streak signal (which any truthy seed disabled), i.e.
                          // strictly less genre coherence than sending nothing.
                          // Averaged over the genre's own tracks, matching how the
                          // artist and album arms work — same table, same source, so the
                          // vector lives in the space the scoring compares against.
                          seed?.type === 'genre' && seed.genre
                          ? sql`SELECT AVG(me.embedding) AS embedding FROM media_embeddings me JOIN media_items mi ON mi.id = me.media_id WHERE mi.media_type = 'track' AND me.source = 'music' AND music_genre_tags(mi.custom_metadata) && ARRAY[${seed.genre.toLowerCase()}]::text[]`
                          : sql`SELECT NULL::vector AS embedding WHERE FALSE`
            }
        ),
        -- Phase 1 (HNSW candidate pool): probe with each available POSITIVE
        -- signal vector — current track, session avg, taste avg, seed
        -- anchor, context seed — via the raw <=> operator so each arm is
        -- HNSW-index-eligible, then UNION the neighbourhoods into a bounded
        -- pool. Negative signals (skip_emb/dislike_emb) are deliberately NOT
        -- probed here: they are penalty-only, candidates near them would
        -- rank low in phase 2 anyway, and probing them would waste pool
        -- budget on rows we want to push away from, not surface. Each arm
        -- degrades gracefully to 0 rows when its source CTE has no
        -- embedding (WHERE ... IS NOT NULL guard), matching the previous
        -- behaviour where a missing signal simply didn't contribute.
        -- Each arm MUST be CROSS JOIN LATERAL with the ORDER BY <=> inside
        -- the lateral subquery: a plain join puts the probe vector on the
        -- other side of the join and the planner falls back to a seq scan
        -- + top-N sort per arm (prod EXPLAIN: seq ~147ms cold vs lateral
        -- parameterized HNSW index scan ~3ms warm).
        pool AS (
            (
                SELECT sub.media_id
                FROM current_emb ce
                CROSS JOIN LATERAL (
                    SELECT me.media_id
                    FROM media_embeddings me
                    WHERE me.source = 'music'
                    ORDER BY me.embedding <=> ce.embedding
                    LIMIT ${perProbePool}
                ) sub
                WHERE ce.embedding IS NOT NULL
            )
            UNION
            (
                SELECT sub.media_id
                FROM session_emb se
                CROSS JOIN LATERAL (
                    SELECT me.media_id
                    FROM media_embeddings me
                    WHERE me.source = 'music'
                    ORDER BY me.embedding <=> se.embedding
                    LIMIT ${perProbePool}
                ) sub
                WHERE se.embedding IS NOT NULL
            )
            UNION
            (
                SELECT sub.media_id
                FROM taste_emb te
                CROSS JOIN LATERAL (
                    SELECT me.media_id
                    FROM media_embeddings me
                    WHERE me.source = 'music'
                    ORDER BY me.embedding <=> te.embedding
                    LIMIT ${perProbePool}
                ) sub
                WHERE te.embedding IS NOT NULL
            )
            UNION
            (
                SELECT sub.media_id
                FROM anchor_emb ae
                CROSS JOIN LATERAL (
                    SELECT me.media_id
                    FROM media_embeddings me
                    WHERE me.source = 'music'
                    ORDER BY me.embedding <=> ae.embedding
                    LIMIT ${perProbePool}
                ) sub
                WHERE ae.embedding IS NOT NULL
            )
            UNION
            (
                SELECT sub.media_id
                FROM seed_emb seed_e
                CROSS JOIN LATERAL (
                    SELECT me.media_id
                    FROM media_embeddings me
                    WHERE me.source = 'music'
                    ORDER BY me.embedding <=> seed_e.embedding
                    LIMIT ${perProbePool}
                ) sub
                WHERE seed_e.embedding IS NOT NULL
            )
        ),
        distances AS (
            SELECT
                mi.id,
                mi.title,
                COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
                COALESCE(mi.custom_poster_url, album.custom_poster_url) AS custom_poster_url,
                mi.parent_id,
                1 - (me.embedding <=> ce.embedding) AS current_sim,
                CASE WHEN se.embedding IS NOT NULL
                     THEN 1 - (me.embedding <=> se.embedding)
                     ELSE NULL END AS session_sim,
                CASE WHEN te.embedding IS NOT NULL
                     THEN 1 - (me.embedding <=> te.embedding)
                     ELSE NULL END AS taste_sim,
                CASE WHEN ske.embedding IS NOT NULL
                     THEN 1 - (me.embedding <=> ske.embedding)
                     ELSE NULL END AS skip_sim,
                CASE WHEN dk.embedding IS NOT NULL
                     THEN 1 - (me.embedding <=> dk.embedding)
                     ELSE NULL END AS dislike_sim,
                CASE WHEN seed_e.embedding IS NOT NULL
                     THEN 1 - (me.embedding <=> seed_e.embedding)
                     ELSE NULL END AS seed_sim,
                CASE WHEN ae.embedding IS NOT NULL
                     THEN 1 - (me.embedding <=> ae.embedding)
                     ELSE NULL END AS anchor_sim,
                ${
                    seed?.type === 'genre' && seed.genre
                        ? sql`CASE WHEN EXISTS (
                            SELECT 1 FROM jsonb_array_elements_text(
                                CASE jsonb_typeof(mi.custom_metadata->'genre')
                                    WHEN 'array' THEN mi.custom_metadata->'genre'
                                    ELSE jsonb_build_array(COALESCE(mi.custom_metadata->>'genre', ''))
                                END
                            ) AS g WHERE LOWER(g) = LOWER(${seed.genre})
                        ) THEN 0.3 ELSE 0 END AS genre_boost`
                        : sql`0::float8 AS genre_boost`
                },
                -- Genre overlap: fraction of current track's genres found in candidate
                CASE WHEN cg.genres IS NOT NULL AND array_length(cg.genres, 1) > 0
                     THEN (
                         SELECT COUNT(*)::float8 / array_length(cg.genres, 1)
                         FROM jsonb_array_elements_text(
                             CASE jsonb_typeof(mi.custom_metadata->'genre')
                                 WHEN 'array' THEN mi.custom_metadata->'genre'
                                 ELSE '[]'::jsonb
                             END
                         ) AS cg2
                         WHERE LOWER(cg2) = ANY(cg.genres)
                     )
                     ELSE 0
                END AS genre_overlap,
                -- Resolve artist name: custom_metadata > hierarchy (album→artist).
                -- Cased as tagged — this is a DISPLAY value (toMusicTrack reads it
                -- as the track's artist name). The per-artist PARTITION BYs below
                -- apply LOWER() themselves; lowercasing here instead would leak
                -- into the UI as "dj amadeus, mario sebastian".
                COALESCE(${trackDisplayArtistSql(sql, 'mi')}, '') AS resolved_artist,
                -- Resolve artist UUID from the album→artist hierarchy.
                -- NULL for orphan tracks (no album parent or no artist grandparent)
                -- and for compilations, where the parent is the Various Artists
                -- marker rather than a real performer.
                CASE WHEN jsonb_typeof(NULLIF(mi.custom_metadata->'track_artist_credits', '[]'::jsonb)) = 'array'
                    THEN ${trackArtistIdSql(sql, 'mi')}::text
                    ELSE ${nonVariousArtistIdSql(sql)} END AS resolved_artist_id,
                -- Per-track artist list (tag order) so a multi-artist line can be
                -- rendered as separate links. NULL when the track's artist is just
                -- the album artist, which resolved_artist_id already covers.
                ${trackArtistsSql(sql, 'mi')} AS track_artists,
                ${trackRemixerArtistsSql(sql, 'mi')} AS remixer_artists,
                me.embedding AS embedding,
                -- Burn-out signal: persistent skip_count from user_music_state.
                -- Quick Picks demotes via (play_count - 0.5*skip_count) in the
                -- bucket ranking domain. Autoplay scores are in the [0..1]
                -- cosine-similarity range, so a smaller per-skip penalty keeps
                -- the "continue this set" feel intact while still honouring
                -- repeat-skip signal.
                COALESCE(burn.skip_count, 0) AS burn_skip_count,
                -- Popularity scores: NULL = not fetched (tri-state — see scored CTE)
                tpop.normalized_score AS track_pop_score,
                apop.normalized_score AS artist_pop_score
            FROM media_items mi
            JOIN media_embeddings me ON me.media_id = mi.id AND me.source = 'music'
            -- Phase-2 bound: restrict to the phase-1 HNSW candidate pool
            -- instead of scanning every source = 'music' embedding.
            JOIN pool ON pool.media_id = me.media_id
            LEFT JOIN media_items album ON album.id = mi.parent_id AND album.media_type = 'album'
            LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
            LEFT JOIN user_music_state burn
              ON burn.track_id = mi.id
             ${userId !== undefined && userId !== '' ? sql`AND burn.user_id = ${userId}` : sql`AND FALSE`}
            LEFT JOIN media_popularity tpop ON tpop.media_id = mi.id AND tpop.source = ${primarySource} AND tpop.score_context = 'track_in_artist'
            LEFT JOIN media_popularity apop ON apop.media_id = artist.id AND apop.source = ${primarySource} AND apop.score_context = 'artist_global'
            CROSS JOIN current_emb ce
            LEFT JOIN current_genres cg ON true
            LEFT JOIN session_emb se ON true
            LEFT JOIN taste_emb te ON true
            LEFT JOIN skip_emb ske ON true
            LEFT JOIN dislike_emb dk ON true
            LEFT JOIN seed_emb seed_e ON true
            LEFT JOIN anchor_emb ae ON true
            WHERE mi.media_type = 'track'
              AND mi.has_files = true
              AND mi.id != ${trackId}
              AND mi.id != ALL(${safeExclude})
              ${
                  minTrackSeconds > 0
                      ? sql`AND (mi.runtime_seconds IS NULL OR mi.runtime_seconds >= ${minTrackSeconds})`
                      : sql``
              }
              ${
                  maxTrackSeconds > 0
                      ? sql`AND (mi.runtime_seconds IS NULL OR mi.runtime_seconds <= ${maxTrackSeconds})`
                      : sql``
              }
              -- Remix/variant exclusion: fuzzy title match against played tracks
              AND NOT EXISTS (
                  SELECT 1 FROM played_titles pt
                  WHERE similarity(
                      lower(regexp_replace(
                          regexp_replace(mi.title, ${REMIX_TAG_REGEX}, '', 'gi'),
                          ${DASH_REMIX_SUFFIX_REGEX}, '', 'gi'
                      )),
                      pt.norm_title
                  ) > 0.6
              )
        ),
        scored AS (
            SELECT
                id,
                title,
                custom_metadata,
                custom_poster_url,
                parent_id,
                resolved_artist,
                resolved_artist_id,
                track_artists,
                remixer_artists,
                embedding,
                -- Tri-state popularity factor:
                --   track row present → use its score
                --   only artist row present → fetched but unmatched, use floor
                --   no artist row at all → cold start, use 1.0 (neutral)
                (1 - ${popularityWeight}::float8) + ${popularityWeight}::float8 * GREATEST(
                    POWER(
                        CASE
                            WHEN track_pop_score IS NOT NULL THEN track_pop_score::float8
                            WHEN artist_pop_score IS NOT NULL THEN ${popularityFloor}::float8
                            ELSE 1.0::float8
                        END,
                        ${popularityExponent}::float8
                    ),
                    ${popularityFloor}::float8
                ) AS popularity_factor,
                (CASE
                    -- Seed + session + taste
                    WHEN seed_sim IS NOT NULL AND session_sim IS NOT NULL AND taste_sim IS NOT NULL
                        THEN current_sim * 0.3 + seed_sim * 0.3 + session_sim * 0.2 + taste_sim * 0.2
                    -- Seed + session (no taste profile yet)
                    WHEN seed_sim IS NOT NULL AND session_sim IS NOT NULL
                        THEN current_sim * 0.3 + seed_sim * 0.4 + session_sim * 0.3
                    -- Seed + taste (first track in session)
                    WHEN seed_sim IS NOT NULL AND taste_sim IS NOT NULL
                        THEN current_sim * 0.3 + seed_sim * 0.4 + taste_sim * 0.3
                    -- Seed only
                    WHEN seed_sim IS NOT NULL
                        THEN current_sim * 0.4 + seed_sim * 0.6
                    -- All three positive signals (no seed)
                    WHEN session_sim IS NOT NULL AND taste_sim IS NOT NULL
                        THEN current_sim * 0.5 + session_sim * 0.3 + taste_sim * 0.2
                    -- Session only (no taste profile yet)
                    WHEN session_sim IS NOT NULL
                        THEN current_sim * 0.6 + session_sim * 0.4
                    -- Taste only (first track in session)
                    WHEN taste_sim IS NOT NULL
                        THEN current_sim * 0.7 + taste_sim * 0.3
                    -- Current track only (cold start)
                    ELSE current_sim
                END
                -- Genre seed boost
                + COALESCE(genre_boost, 0)
                -- Genre overlap boost: up to +0.15 for full genre match
                + COALESCE(genre_overlap * 0.15, 0)
                -- Seed anchor: keep gravity toward the session-start track so
                -- the queue doesn't drift to the user's dominant taste
                -- cluster over many hops. Additive (composes with the
                -- weight cases above without rebalancing them).
                + COALESCE(anchor_sim * ${anchorWeight}::float8, 0)
                -- Negative signals: penalize tracks similar to skipped/disliked
                - COALESCE(skip_sim * 0.3, 0)
                - COALESCE(dislike_sim * 0.2, 0)
                -- Burn-out demotion: persistent skip_count → small bounded
                -- penalty (capped at 0.2 of similarity score). Mirrors Quick
                -- Picks Fix E in spirit; smaller absolute weight because
                -- autoplay scores live in the [0..1] cosine range.
                - LEAST(burn_skip_count::float8 * 0.02, 0.2)
                ) * (1 - ${popularityWeight}::float8 + ${popularityWeight}::float8 * GREATEST(
                    POWER(
                        CASE
                            WHEN track_pop_score IS NOT NULL THEN track_pop_score::float8
                            WHEN artist_pop_score IS NOT NULL THEN ${popularityFloor}::float8
                            ELSE 1.0::float8
                        END,
                        ${popularityExponent}::float8
                    ),
                    ${popularityFloor}::float8
                )) AS similarity_score,
                -- Artist rank: cap per-artist results to ensure diversity
                -- Popularity factor also influences which track per artist wins
                -- LOWER() here (not on the projection) so the cap stays
                -- case-insensitive while resolved_artist keeps display casing.
                ROW_NUMBER() OVER (
                    PARTITION BY LOWER(resolved_artist)
                    ORDER BY current_sim * (1 - ${popularityWeight}::float8 + ${popularityWeight}::float8 * GREATEST(
                        POWER(
                            CASE
                                WHEN track_pop_score IS NOT NULL THEN track_pop_score::float8
                                WHEN artist_pop_score IS NOT NULL THEN ${popularityFloor}::float8
                                ELSE 1.0::float8
                            END,
                            ${popularityExponent}::float8
                        ),
                        ${popularityFloor}::float8
                    )) DESC
                ) AS artist_rank
            FROM distances
        ),
        title_deduped AS (
            -- Collapse remix/edit/live variants surviving the artist cap down
            -- to one per (artist, normalized title) (3-pass, matching
            -- normalizeTitle() and the sonic-queue path), preferring the
            -- untagged (original) title over a version-tagged one —
            -- featuring credits are stripped first so "(feat. X)" never
            -- counts as a version tag. Mirrors the metadata-path preference
            -- in music-recommendations.queries.ts (getMusicBecauseYouListened).
            -- COALESCE guards against NULL titles: a NULL ~* pattern match
            -- is NULL (falsy in the CASE), which would otherwise rank a
            -- NULL-titled row as "preferred original".
            -- resolved_artist is included in the PARTITION BY so two
            -- different artists who both happen to have a same-titled track
            -- (e.g. "Intro") don't collapse into a single row — only
            -- remix/edit/live variants of the SAME song by the SAME artist
            -- should be deduped here.
            SELECT
                s.*,
                ROW_NUMBER() OVER (
                    PARTITION BY
                        LOWER(s.resolved_artist),
                        lower(regexp_replace(
                        regexp_replace(
                            regexp_replace(COALESCE(s.title, ''), ${REMIX_TAG_REGEX}, '', 'gi'),
                            ${DASH_REMIX_SUFFIX_REGEX}, '', 'gi'
                        ),
                        ${BARE_REMIX_SUFFIX_REGEX}, '', 'gi'
                    ))
                    ORDER BY
                        CASE
                            WHEN regexp_replace(
                                regexp_replace(COALESCE(s.title, ''), ${FEAT_TAG_REGEX}, '', 'gi'),
                                ${FEAT_DASH_SUFFIX_REGEX}, '', 'gi'
                            ) ~* ${VERSION_ONLY_SQL_PATTERN}
                                THEN 1
                            ELSE 0
                        END ASC,
                        s.similarity_score DESC
                ) AS title_rank
            FROM scored s
            WHERE s.artist_rank <= 5
        )
        SELECT id, title, custom_metadata, custom_poster_url, parent_id,
               similarity_score, resolved_artist, resolved_artist_id, track_artists, remixer_artists, embedding
        FROM title_deduped
        WHERE title_rank = 1
        ORDER BY similarity_score DESC
        LIMIT ${limit}
    `;
    });
}

/**
 * Returns the set of normalised track-title stems the user has played
 * within the cool-down window. Used by the autoplay queue to exclude
 * recently-heard variants (remix/edit/version siblings of the same song).
 *
 * Source: user_music_state.last_played_at — updated by recordPlayStart
 * on every play-start, so this survives reloads, tab closes, and crashes
 * mid-track (unlike music_listen_events which is only written on play-end).
 *
 * Normalisation uses REMIX_TAG_REGEX (identical to the remix filter in
 * getSmartQueueCandidates), so e.g. "Here I Go (DJ Tht Remix Edit)" and
 * "Here I Go (Radio Edit)" both collapse to "here i go".
 *
 * @param cooldownHours 0 short-circuits to an empty array without querying.
 */
export async function getRecentlyPlayedVariants(
    sql: postgres.Sql,
    userId: UserId,
    cooldownHours: number,
): Promise<string[]> {
    if (cooldownHours <= 0) return [];
    const rows = await sql<{ norm_title: string }[]>`
        SELECT DISTINCT lower(regexp_replace(
            regexp_replace(mi.title, ${REMIX_TAG_REGEX}, '', 'gi'),
            ${DASH_REMIX_SUFFIX_REGEX}, '', 'gi'
        )) AS norm_title
        FROM user_music_state ums
        JOIN media_items mi ON mi.id = ums.track_id
        WHERE ums.user_id = ${userId}
          AND ums.last_played_at > NOW() - make_interval(hours => ${cooldownHours})
    `;
    return rows.map((r) => r.norm_title).filter((s): s is string => !!s);
}

/**
 * Batched genre-tag lookup for a small set of track IDs — used by the smart
 * queue route to build the session genre-streak profile (see
 * music-genre-streak.ts) from recent session history. Tracks with no genre
 * metadata are simply absent from the returned map.
 */
export async function getTrackGenreTags(
    sql: postgres.Sql,
    trackIds: string[],
): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (trackIds.length === 0) return map;

    const rows = await sql<{ id: string; genre: unknown }[]>`
        SELECT mi.id::text AS id, mi.custom_metadata->'genre' AS genre
        FROM media_items mi
        WHERE mi.id = ANY(${trackIds}::uuid[])
    `;
    for (const row of rows) {
        const tags = getGenreTags({ genre: row.genre });
        if (tags) map.set(row.id, tags);
    }
    return map;
}

/**
 * Per-artist diversity keys for a set of already-played session tracks.
 *
 * Feeds the smart queue's SESSION-level artist cap. Per-response diversity
 * (pickDiverse/pickDiverseSonic) caps repeats inside one payload, but every
 * autoplay hop is an independent request whose only session memory is a list
 * of track ids — so nothing stopped the same two artists from alternating for
 * a whole session once the seed sat in a sparse region of the library
 * (observed: Rise Anew + Green Harbor taking 7 of 8 hops off a Sum 43 seed,
 * Eloren + Sora-Vale 7 of 8 off an Eloren seed).
 *
 * Resolves the artist the same way the candidate projection does — structured
 * credit list first (`primaryCreditArtistName`), then the display-name chain —
 * so history keys and candidate keys land in one key space. Any divergence
 * here silently no-ops the cap rather than failing loudly, which is why both
 * sides share one helper.
 *
 * Tracks with no row (deleted since they were played) are omitted rather
 * than counted under a synthetic key — an unknown play must not consume
 * another artist's cap budget.
 */
export async function getSessionArtistKeys(
    sql: postgres.Sql,
    trackIds: string[],
): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (trackIds.length === 0) return map;

    const rows = await sql<
        {
            id: string;
            resolved_artist: string;
            parent_id: string | null;
            track_artists: Array<{ id: string | null; title: string }> | null;
        }[]
    >`
        SELECT mi.id::text AS id,
               COALESCE(${trackDisplayArtistSql(sql, 'mi')}, '') AS resolved_artist,
               mi.parent_id::text AS parent_id,
               -- Same projection the candidate rows use, so history keys and
               -- candidate keys are computed from identical input.
               ${trackArtistsSql(sql, 'mi')} AS track_artists
        FROM media_items mi
        LEFT JOIN media_items album ON album.id = mi.parent_id AND album.media_type = 'album'
        LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
        WHERE mi.id = ANY(${trackIds}::uuid[])
    `;
    for (const row of rows) {
        map.set(
            row.id,
            effectiveArtistKey({
                id: row.id,
                artistName:
                    primaryCreditArtistName(row.track_artists) ??
                    (row.resolved_artist || undefined),
                fallbackId: row.parent_id ?? undefined,
            }),
        );
    }
    return map;
}

/**
 * Random-track fallback used when the embedding-scored pool is empty.
 *
 * Projects the same shape as getSmartQueueCandidates (including
 * `resolved_artist` from the album → artist parent chain) so that the
 * caller's artist-diversity filtering still works. `excludedStems`
 * filters out normalised title siblings via pg_trgm similarity > 0.6;
 * pass `[]` to disable that filter (Stage 2 cool-down relaxation path).
 *
 * Results are ordered: same album first, then same artist's other
 * albums, then everything else — randomised within each tier.
 */
export async function getFallbackCandidates(
    sql: postgres.Sql,
    trackId: string,
    currentTrack: {
        parent_id: string | null;
        artist_id: string | null;
    },
    excludeIds: string[],
    excludedStems: string[],
    options?: {
        /** Minimum candidate length (seconds). 0 disables. NULL runtime kept. */
        minTrackSeconds?: number;
        /** Maximum candidate length (seconds). 0 disables. NULL runtime kept. */
        maxTrackSeconds?: number;
    },
): Promise<QueueCandidateRow[]> {
    const safeExclude =
        excludeIds.length > 0 ? excludeIds : ['00000000-0000-0000-0000-000000000000'];
    const minTrackSeconds = Math.max(0, options?.minTrackSeconds ?? 0);
    const maxTrackSeconds = Math.max(0, options?.maxTrackSeconds ?? 0);
    const stemFilter =
        excludedStems.length > 0
            ? sql`AND NOT EXISTS (
                    SELECT 1 FROM unnest(${excludedStems}::text[]) AS pt(norm_title)
                    WHERE similarity(
                        lower(regexp_replace(
                            regexp_replace(mi.title, ${REMIX_TAG_REGEX}, '', 'gi'),
                            ${DASH_REMIX_SUFFIX_REGEX}, '', 'gi'
                        )),
                        pt.norm_title
                    ) > 0.6
                )`
            : sql``;
    // B3: prefer the untagged (original) title within this random fallback
    // pool too. The final result is capped at FALLBACK_LIMIT, so the inner
    // candidate select overfetches 2x before the title_rank dedup narrows
    // back down.
    const FALLBACK_LIMIT = 10;
    const FALLBACK_OVERFETCH = FALLBACK_LIMIT * 2;
    return sql<QueueCandidateRow[]>`
        WITH candidates AS (
            SELECT
                mi.id,
                mi.title,
                COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
                COALESCE(mi.custom_poster_url, album.custom_poster_url) AS custom_poster_url,
                mi.parent_id,
                COALESCE(${trackDisplayArtistSql(sql, 'mi')}, '') AS resolved_artist,
                random() AS similarity_score,
                CASE WHEN ${currentTrack.parent_id ?? null}::uuid IS NOT NULL
                          AND mi.parent_id IS NOT DISTINCT FROM ${currentTrack.parent_id ?? null}
                     THEN 0
                     WHEN ${currentTrack.artist_id ?? null}::uuid IS NOT NULL
                          AND mi.parent_id IN (
                              SELECT id FROM media_items
                              WHERE parent_id = ${currentTrack.artist_id ?? null}
                                AND media_type = 'album'
                          )
                     THEN 1
                     ELSE 2
                END AS tier,
                random() AS rand_order
            FROM media_items mi
            LEFT JOIN media_items album
                ON album.id = mi.parent_id AND album.media_type = 'album'
            LEFT JOIN media_items artist
                ON artist.id = album.parent_id AND artist.media_type = 'artist'
            WHERE mi.media_type = 'track'
              AND mi.has_files = true
              AND mi.id != ${trackId}
              AND mi.id != ALL(${safeExclude})
              ${
                  minTrackSeconds > 0
                      ? sql`AND (mi.runtime_seconds IS NULL OR mi.runtime_seconds >= ${minTrackSeconds})`
                      : sql``
              }
              ${
                  maxTrackSeconds > 0
                      ? sql`AND (mi.runtime_seconds IS NULL OR mi.runtime_seconds <= ${maxTrackSeconds})`
                      : sql``
              }
              ${stemFilter}
            ORDER BY tier, rand_order
            LIMIT ${FALLBACK_OVERFETCH}
        ),
        title_deduped AS (
            -- Collapse remix/edit/live variants down to one per (artist,
            -- 3-pass normalized title), preferring the untagged (original)
            -- title — featuring credits are stripped first so "(feat. X)"
            -- never counts as a version tag. COALESCE guards NULL titles.
            -- resolved_artist is included in the PARTITION BY so two
            -- different artists with a same-titled track (e.g. "Intro")
            -- don't collapse into a single row.
            SELECT
                c.*,
                ROW_NUMBER() OVER (
                    PARTITION BY
                        c.resolved_artist,
                        lower(regexp_replace(
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
                        c.tier ASC,
                        c.rand_order ASC
                ) AS title_rank
            FROM candidates c
        )
        SELECT
            id, title, custom_metadata, custom_poster_url, parent_id,
            resolved_artist, similarity_score
        FROM title_deduped
        WHERE title_rank = 1
        ORDER BY tier ASC, rand_order ASC
        LIMIT ${FALLBACK_LIMIT}
    `;
}

/**
 * Get track suggestions for a playlist based on the average embedding
 * of all tracks already in the playlist.
 *
 * Excludes tracks already present in the playlist.
 * Returns top candidates ordered by cosine similarity to the playlist centroid.
 */
export interface PlaylistSuggestionFullRow {
    id: string;
    title: string;
    runtime_seconds: number | null;
    custom_poster_url: string | null;
    artist_title: string | null;
    album_title: string | null;
    similarity_score: number;
}

export async function getPlaylistSuggestionsFull(
    sql: postgres.Sql,
    playlistId: number,
    limit = 20,
): Promise<PlaylistSuggestionFullRow[]> {
    // hnsw.ef_search defaults to 40 (prod), which bounds the ANN scan to ~40
    // candidates BEFORE the playlist-membership / NULL-embedding filters are
    // applied — easily starved to 0 rows once those filters bite. Raise it
    // to cover the requested LIMIT (see for-you-helpers.queries.ts's
    // querySimilarMediaWithAvailabilityTwoPhase for the same pattern).
    const efSearch = Math.min(1000, Math.max(64, limit));
    return await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await tx`SELECT set_config('hnsw.ef_search', ${String(efSearch)}, true)`;
        return tx<PlaylistSuggestionFullRow[]>`
            WITH playlist_tracks AS (
                SELECT pi.media_id
                FROM playlist_items pi
                WHERE pi.playlist_id = ${playlistId}
            ),
            playlist_embedding AS (
                SELECT AVG(me.embedding) AS avg_embedding
                FROM media_embeddings me
                JOIN playlist_tracks pt ON pt.media_id = me.media_id
                WHERE me.source = 'music'
            )
            SELECT
                mi.id,
                mi.title,
                mi.runtime_seconds,
                COALESCE(mi.custom_poster_url, album.custom_poster_url) AS custom_poster_url,
                ${trackDisplayArtistSql(sql, 'mi')} AS artist_title,
            ${trackArtistsSql(sql, 'mi')} AS track_artists,
            ${trackRemixerArtistsSql(sql, 'mi')} AS remixer_artists,
                album.title AS album_title,
                1 - (me.embedding <=> pe.avg_embedding) AS similarity_score
            FROM media_items mi
            JOIN media_embeddings me ON me.media_id = mi.id AND me.source = 'music'
            CROSS JOIN playlist_embedding pe
            LEFT JOIN media_items album ON album.id = mi.parent_id
            LEFT JOIN media_items artist ON artist.id = album.parent_id
            WHERE mi.media_type = 'track'
              AND mi.has_files = true
              AND mi.id NOT IN (SELECT media_id FROM playlist_tracks)
              AND pe.avg_embedding IS NOT NULL
            ORDER BY me.embedding <=> pe.avg_embedding ASC
            LIMIT ${limit}
        `;
    });
}

/**
 * Get track suggestions for a playlist using the MSCLAP sonic embedding centroid.
 *
 * Mirrors {@link getPlaylistSuggestionsFull} but operates over
 * `media_audio_embeddings` (model: msclap-2023) rather than the metadata
 * embeddings in `media_embeddings`. The centroid is the arithmetic mean of the
 * sonic embeddings of every playlist track that has one. kNN search uses the
 * HNSW `<=>` (cosine distance) index on `media_audio_embeddings`.
 *
 * Returns an empty array when no playlist track has a sonic embedding (the
 * `playlist_sonic_embedding` CTE produces a NULL avg_embedding, and the WHERE
 * clause `pse.avg_embedding IS NOT NULL` filters the whole result set out).
 *
 * Access filtering is NOT applied here — the caller (endpoint) is responsible
 * for running `filterAccessibleRows` on the returned rows, consistent with the
 * behaviour of {@link getPlaylistSuggestionsFull}.
 *
 * @param sql        - postgres.Sql instance (parameterized — no sql.unsafe).
 * @param playlistId - Numeric playlist ID.
 * @param limit      - Maximum number of candidate tracks to return.
 */
export async function getPlaylistSuggestionsViaSonic(
    sql: postgres.Sql,
    playlistId: number,
    limit = 20,
): Promise<PlaylistSuggestionFullRow[]> {
    // See getPlaylistSuggestionsFull: raise ef_search above the pgvector
    // default (40) so the ANN scan isn't starved by the playlist-membership
    // / NULL-embedding filters applied on top of it.
    const efSearch = Math.min(1000, Math.max(64, limit));
    return await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await tx`SELECT set_config('hnsw.ef_search', ${String(efSearch)}, true)`;
        return tx<PlaylistSuggestionFullRow[]>`
            WITH playlist_tracks AS (
                SELECT pi.media_id
                FROM playlist_items pi
                WHERE pi.playlist_id = ${playlistId}
            ),
            playlist_sonic_embedding AS (
                SELECT AVG(mae.embedding) AS avg_embedding
                FROM media_audio_embeddings mae
                JOIN playlist_tracks pt ON pt.media_id = mae.media_id
                WHERE mae.model_id = ${MSCLAP_MODEL_ID}
            )
            SELECT
                mi.id,
                mi.title,
                mi.runtime_seconds,
                COALESCE(mi.custom_poster_url, album.custom_poster_url) AS custom_poster_url,
                ${trackDisplayArtistSql(sql, 'mi')} AS artist_title,
            ${trackArtistsSql(sql, 'mi')} AS track_artists,
            ${trackRemixerArtistsSql(sql, 'mi')} AS remixer_artists,
                album.title AS album_title,
                1 - (mae.embedding <=> pse.avg_embedding) AS similarity_score
            FROM media_audio_embeddings mae
            JOIN media_items mi ON mi.id = mae.media_id
                AND mi.media_type = 'track'
                AND mi.has_files = true
            CROSS JOIN playlist_sonic_embedding pse
            LEFT JOIN media_items album ON album.id = mi.parent_id
                AND album.media_type = 'album'
            LEFT JOIN media_items artist ON artist.id = album.parent_id
                AND artist.media_type = 'artist'
            WHERE mae.model_id = ${MSCLAP_MODEL_ID}
              AND mi.id NOT IN (SELECT media_id FROM playlist_tracks)
              AND pse.avg_embedding IS NOT NULL
            ORDER BY mae.embedding <=> pse.avg_embedding ASC
            LIMIT ${limit}
        `;
    });
}

/**
 * Count how many tracks in a playlist have a sonic (MSCLAP) embedding.
 *
 * Used by the suggestions endpoint to decide whether the sonic path has
 * enough coverage for a stable centroid (threshold: >= 3 tracks).
 *
 * @param sql        - postgres.Sql instance.
 * @param playlistId - Numeric playlist ID.
 */
export async function countPlaylistSonicEmbeddings(
    sql: postgres.Sql,
    playlistId: number,
): Promise<number> {
    const rows = await sql<{ sonic_count: string }[]>`
        SELECT COUNT(*) AS sonic_count
        FROM playlist_items pi
        JOIN media_audio_embeddings mae
            ON mae.media_id = pi.media_id
           AND mae.model_id = ${MSCLAP_MODEL_ID}
        WHERE pi.playlist_id = ${playlistId}
    `;
    return Number(rows[0]?.sonic_count ?? 0);
}

// =============================================================================
// Non-Personalized Discovery Queries
// =============================================================================

/**
 * Get top artists by album count (no play history needed).
 * Excludes "Unknown Artist" entries.
 * Respects library access and age rating filters.
 */
export async function getTopArtistsByAlbumCount(
    sql: postgres.Sql,
    limit = 12,
    deniedGroupIds?: string[] | null,
    ageRating?: AgeRatingFilterParams | null,
): Promise<TopArtistRow[]> {
    return sql<TopArtistRow[]>`
        SELECT
            artist.id,
            artist.title,
            COALESCE(
                artist.custom_poster_url,
                (SELECT a.custom_poster_url FROM media_items a
                 WHERE a.parent_id = artist.id AND a.media_type = 'album'
                   AND a.status = 'active' AND NOT a.is_dismissed
                   AND EXISTS (SELECT 1 FROM media_items t WHERE t.parent_id = a.id
                       AND t.media_type = 'track' ${playableTrackSql(sql, 't')})
                   AND a.custom_poster_url IS NOT NULL
                 LIMIT 1)
            ) AS custom_poster_url,
            COUNT(DISTINCT album.id)::int AS album_count,
            0 AS play_count
        FROM media_items artist
        JOIN media_items album
            ON album.parent_id = artist.id AND album.media_type = 'album'
        JOIN media_items mi
            ON mi.parent_id = album.id AND mi.media_type = 'track' AND mi.has_files = true
        WHERE artist.media_type = 'artist'
          AND artist.parent_id IS NULL
              AND artist.status = 'active'
          AND artist.title != 'Unknown Artist'
          AND artist.is_various_artists = false
          ${buildLibraryAccessFilter(sql, deniedGroupIds)}
          ${buildAgeRatingFilter(sql, ageRating)}
        GROUP BY artist.id, artist.title, artist.custom_poster_url
        ORDER BY album_count DESC
        LIMIT ${limit}
    `;
}

// =============================================================================
// Similar tracks
// =============================================================================

export interface SimilarTrackRow {
    id: string;
    title: string;
    custom_poster_url: string | null;
    own_custom_poster_url?: string | null;
    album_custom_poster_url?: string | null;
    custom_metadata: Record<string, unknown>;
    runtime_seconds: number | null;
    artist_id: string | null;
    artist_title: string | null;
    album_id: string | null;
    album_title: string | null;
    similarity_score: number;
    file_path: string | null;
}

/**
 * Get tracks similar to a given track using cosine similarity on music embeddings.
 * Pure embedding similarity — no queue scoring, skip/dislike penalties, or session blending.
 * Excludes the source track itself and any caller-supplied IDs.
 */
export async function getSimilarTracks(
    sql: postgres.Sql,
    trackId: string,
    limit = 20,
    excludeIds: string[] = [],
): Promise<SimilarTrackRow[]> {
    const safeExclude = excludeIds.length > 0 ? [...new Set([trackId, ...excludeIds])] : [trackId];
    // See getPlaylistSuggestionsFull: raise ef_search above the pgvector
    // default (40) so the ANN scan isn't starved by the exclusion filter —
    // size it to cover both the requested LIMIT and everything safeExclude
    // can eat out of the candidate pool.
    const efSearch = Math.min(1000, Math.max(64, limit + safeExclude.length));

    return await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await tx`SELECT set_config('hnsw.ef_search', ${String(efSearch)}, true)`;
        return tx<SimilarTrackRow[]>`
            WITH source_emb AS (
                SELECT me.embedding
                FROM media_embeddings me
                WHERE me.media_id = ${trackId}
                  AND me.source = 'music'
                LIMIT 1
            )
            SELECT
                mi.id,
                mi.title,
                COALESCE(mi.custom_poster_url, album.custom_poster_url) AS custom_poster_url,
                mi.custom_poster_url AS own_custom_poster_url,
                album.custom_poster_url AS album_custom_poster_url,
                COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
                mi.runtime_seconds,
                ${trackArtistIdSql(sql, 'mi')} AS artist_id,
                ${trackDisplayArtistSql(sql, 'mi')} AS artist_title,
            ${trackArtistsSql(sql, 'mi')} AS track_artists,
            ${trackRemixerArtistsSql(sql, 'mi')} AS remixer_artists,
                album.id AS album_id,
                album.title AS album_title,
                1 - (me.embedding <=> se.embedding) AS similarity_score,
                mf.file_path AS file_path
            FROM media_items mi
            JOIN media_embeddings me ON me.media_id = mi.id AND me.source = 'music'
            LEFT JOIN media_items album ON album.id = mi.parent_id AND album.media_type = 'album'
            LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
            ${trackFilePathJoin(sql, 'mi')}
            CROSS JOIN source_emb se
            WHERE mi.media_type = 'track'
              AND mi.has_files = true
              AND mi.id != ALL(${safeExclude})
            ORDER BY me.embedding <=> se.embedding ASC
            LIMIT ${limit}
        `;
    });
}

/**
 * Cosine similarity between two tracks' music embeddings.
 * Returns a value in [0, 1], or null if either track has no embedding.
 */
export async function getTrackPairSimilarity(
    sql: postgres.Sql,
    trackId1: string,
    trackId2: string,
): Promise<number | null> {
    const rows = await sql<{ similarity: number }[]>`
        SELECT 1 - (a.embedding <=> b.embedding) AS similarity
        FROM media_embeddings a, media_embeddings b
        WHERE a.media_id = ${trackId1} AND a.source = 'music'
          AND b.media_id = ${trackId2} AND b.source = 'music'
        LIMIT 1
    `;
    return rows[0]?.similarity ?? null;
}

// =============================================================================
// Mood radio bootstrap
// =============================================================================

/**
 * Mood-to-feature profiles for audio-feature-based mood matching.
 *
 * Each mood defines preferred ranges for energy, danceability, and BPM.
 * Tracks are scored 0-1 based on how well their audio features match.
 * Key scale (major/minor) provides a small bonus for happy/sad moods.
 *
 * These replace the Essentia SVM mood_tags (which are always empty because
 * the pre-built static binary lacks Gaia support).
 */
/** Genres to exclude from calm/soft moods (chill, sad, romantic, focus, ambient) */
const HEAVY_GENRES = [
    'Heavy Metal',
    'Power Metal',
    'Metal',
    'Symphonic Metal',
    'Death Metal',
    'Black Metal',
    'Thrash Metal',
    'Metalcore',
    'Hardcore',
    'Punk',
    'Hardstyle',
    'Hardcore Techno',
    'Folk Metal',
    'Viking Metal',
    'Speed Metal',
    'Nu Metal',
    'Doom Metal',
    'Progressive Metal',
];

const MOOD_FEATURE_PROFILES: Record<
    string,
    {
        energy: [number, number];
        danceability: [number, number];
        bpm: [number, number];
        keyScale?: 'major' | 'minor';
        /** Exclude tracks whose genre array contains any of these */
        excludeGenres?: string[];
    }
> = {
    chill: {
        energy: [0, 0.5],
        danceability: [0, 0.9],
        bpm: [60, 110],
        excludeGenres: HEAVY_GENRES,
    },
    workout: { energy: [0.7, 1], danceability: [1.0, 3], bpm: [120, 160] },
    focus: {
        energy: [0.2, 0.6],
        danceability: [0, 0.8],
        bpm: [70, 120],
        excludeGenres: HEAVY_GENRES,
    },
    party: { energy: [0.6, 1], danceability: [1.0, 3], bpm: [115, 140] },
    energetic: { energy: [0.7, 1], danceability: [0.8, 3], bpm: [120, 170] },
    sad: {
        energy: [0, 0.5],
        danceability: [0, 0.8],
        bpm: [60, 100],
        keyScale: 'minor',
        excludeGenres: HEAVY_GENRES,
    },
    happy: {
        energy: [0.5, 1],
        danceability: [0.8, 3],
        bpm: [100, 140],
        keyScale: 'major',
    },
    romantic: {
        energy: [0.2, 0.6],
        danceability: [0, 0.9],
        bpm: [60, 110],
        excludeGenres: HEAVY_GENRES,
    },
    aggressive: { energy: [0.8, 1], danceability: [0.6, 3], bpm: [130, 200] },
    ambient: {
        energy: [0, 0.4],
        danceability: [0, 0.6],
        bpm: [50, 100],
        excludeGenres: HEAVY_GENRES,
    },
    groovy: { energy: [0.5, 0.9], danceability: [1.0, 3], bpm: [90, 130] },
};

/**
 * Build a SQL CASE expression that scores a track's audio features against
 * a mood profile. Returns a value 0-1 where 1 = perfect match.
 *
 * Scoring:
 * - Energy in range: +0.35
 * - Danceability in range: +0.25
 * - BPM in range: +0.30
 * - Key scale match (for happy/sad): +0.10
 */
export function buildMoodMatchSql(
    sql: postgres.Sql,
    mood: string,
): postgres.PendingQuery<postgres.Row[]> {
    const profile = Object.hasOwn(MOOD_FEATURE_PROFILES, mood)
        ? MOOD_FEATURE_PROFILES[mood]
        : undefined;
    if (!profile) {
        // Unknown mood — no feature-based matching
        return sql`0.0`;
    }

    const [eMin, eMax] = profile.energy;
    const [dMin, dMax] = profile.danceability;
    const [bMin, bMax] = profile.bpm;

    // Key scale bonus (only for happy/sad where major/minor matters).
    // Minor keys are conventionally suffixed 'm' (e.g. "Am", "F#m"); major
    // keys have no suffix. So "minor" = key LIKE '%m', "major" = key NOT
    // LIKE '%m' — a single predicate, not an AND of both (the previous form
    // ANDed `LIKE '%m'` with `NOT LIKE '%'` for minor, and `NOT LIKE '%m'`
    // was never reached — `NOT LIKE '%'` is always false, so the bonus was
    // unreachable for every mood).
    const keyBonus = profile.keyScale
        ? sql`+ CASE WHEN mi.custom_metadata->'essentia'->>'key' ${
              profile.keyScale === 'minor' ? sql`LIKE ${'%m'}` : sql`NOT LIKE ${'%m'}`
          }
                     THEN 0.10 ELSE 0.0 END`
        : sql``;

    // Genre penalty: heavy/aggressive genres get a large negative score
    // for calm moods (chill, sad, romantic, focus, ambient).
    // Uses -0.50 penalty so a perfect feature match (0.90) still loses
    // to a partial match (0.60) from a genre-appropriate track.
    const genrePenalty =
        profile.excludeGenres && profile.excludeGenres.length > 0
            ? sql`+ CASE WHEN mi.custom_metadata->'genre' ?| ${sql.array(profile.excludeGenres)}
                       THEN -0.50 ELSE 0.0 END`
            : sql``;

    return sql`(
        CASE WHEN (mi.custom_metadata->'essentia'->>'energy')::numeric BETWEEN ${eMin} AND ${eMax}
             THEN 0.35 ELSE 0.0 END
        + CASE WHEN (mi.custom_metadata->'essentia'->>'danceability')::numeric BETWEEN ${dMin} AND ${dMax}
               THEN 0.25 ELSE 0.0 END
        + CASE WHEN (mi.custom_metadata->'essentia'->>'bpm')::numeric BETWEEN ${bMin} AND ${bMax}
               THEN 0.30 ELSE 0.0 END
        ${keyBonus}
        ${genrePenalty}
    )`;
}

/**
 * Find a seed track for mood radio, combining user taste with mood filtering.
 *
 * Strategy:
 *   1. Build user taste embedding from top played/rated tracks
 *   2. Find tracks closest to taste embedding
 *   3. Score tracks by audio feature match to the mood profile
 *      (energy, danceability, BPM, key scale)
 *   4. Add randomness so each session starts differently
 *
 * Returns a single track or null if none found.
 */
export async function getMoodBootstrapTrack(
    sql: postgres.Sql,
    mood: string,
    userId?: UserId,
): Promise<QueueCandidateRow | null> {
    const moodMatchExpr = buildMoodMatchSql(sql, mood);

    const rows = await sql<QueueCandidateRow[]>`
        WITH taste_emb AS (
            SELECT AVG(me.embedding) AS embedding
            FROM media_embeddings me
            JOIN (
                SELECT ums.track_id AS media_id,
                       LEAST(COALESCE(ums.play_count, 0), 20) + COALESCE(ur.rating, 0) AS score
                FROM user_music_state ums
                JOIN media_items mi ON mi.id = ums.track_id AND mi.media_type = 'track'
                LEFT JOIN user_ratings ur ON ur.media_id = ums.track_id AND ur.user_id = ums.user_id
                WHERE ums.user_id = ${userId ?? null}::uuid
                  ${userId ? sql`` : sql`AND FALSE`}
                  AND (ur.rating IS NULL OR ur.rating >= 4)
                ORDER BY score DESC
                LIMIT 30
            ) top ON top.media_id = me.media_id
            WHERE me.source = 'music'
        ),
        candidates AS (
            SELECT
                mi.id,
                mi.title,
                COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
                COALESCE(mi.custom_poster_url, album.custom_poster_url) AS custom_poster_url,
                mi.parent_id,
                COALESCE(${trackDisplayArtistSql(sql, 'mi')}, 'Unknown Artist') AS resolved_artist,
                -- Taste similarity (0-1, higher = better)
                CASE
                    WHEN te.embedding IS NOT NULL
                    THEN 1 - (me.embedding <=> te.embedding)
                    ELSE 0.5
                END AS taste_sim,
                -- Audio-feature mood match (0-1, based on energy/danceability/BPM/key)
                ${moodMatchExpr} AS mood_match,
                random() AS rand
            FROM media_items mi
            JOIN media_embeddings me ON me.media_id = mi.id AND me.source = 'music'
            LEFT JOIN media_items album ON album.id = mi.parent_id AND album.media_type = 'album'
            LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
            LEFT JOIN taste_emb te ON true
            WHERE mi.media_type = 'track'
              AND mi.has_files = true
              AND mi.custom_metadata->'essentia'->>'bpm' IS NOT NULL
              -- Exclude intros/interludes/silence (near-zero energy or very short)
              AND COALESCE(mi.runtime_seconds, 0) >= 60
              AND COALESCE((mi.custom_metadata->'essentia'->>'energy')::numeric, 0) >= 0.05
        )
        SELECT
            id, title, custom_metadata, custom_poster_url, parent_id, resolved_artist,
            (taste_sim * 0.35 + mood_match * 0.45 + rand * 0.20) AS similarity_score
        FROM candidates
        ORDER BY (taste_sim * 0.35 + mood_match * 0.45 + rand * 0.20) DESC
        LIMIT 1
    `;
    return rows[0] ?? null;
}

export async function hasRecentMusicListening(
    sql: postgres.Sql,
    userId: UserId,
    days: number,
): Promise<boolean> {
    const rows = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
            SELECT 1
            FROM user_music_state
            WHERE user_id = ${userId}
              AND play_count > 0
              AND last_played_at > NOW() - make_interval(days => ${days})
            LIMIT 1
        ) AS exists
    `;
    return rows[0]?.exists ?? false;
}

/**
 * Batch-load play counts for a set of track IDs for a given user.
 * Returns a Map<trackId, playCount>. Tracks with no entry are absent (treat as 0).
 */
export async function getTrackPlayCounts(
    sql: postgres.Sql,
    userId: UserId,
    trackIds: string[],
): Promise<Map<string, number>> {
    if (trackIds.length === 0) return new Map();
    const rows = await sql<{ track_id: string; play_count: number }[]>`
        SELECT track_id::text, play_count
        FROM user_music_state
        WHERE user_id = ${userId}::uuid
          AND track_id = ANY(${trackIds})
    `;
    return new Map(rows.map((r) => [r.track_id, r.play_count]));
}

/**
 * Whether any radio station is configured on this server.
 *
 * Radio stations are `media_items` rows with `media_type = 'radio'`. This is a
 * GLOBAL, non-access-scoped check — the question is "is radio configured on this
 * server at all", used to gate the Radio navigation item and page. (Per-user
 * library/age scoping for which stations a caller can SEE happens at the
 * station-listing query, not here.)
 */
export async function hasRadioStations(sql: postgres.Sql): Promise<boolean> {
    const rows = await sql<{ has: boolean }[]>`
        SELECT EXISTS(
            SELECT 1 FROM media_items WHERE media_type = 'radio'
        ) AS has
    `;
    return rows[0]?.has === true;
}

/**
 * Whether any active artist/album/track row is playable (`has_files = true`).
 *
 * Exactly `artists + albums + tracks > 0` of `getMediaBrowserStats`, without
 * that function's full scan of media_items (two external_ids probes per row,
 * ~0.4–3 s on a 160k-row library). The predicate matches the partial index
 * `idx_media_items_browse` (media_type, … WHERE status = 'active' AND
 * has_files), so this is one index probe whether or not music exists.
 * GLOBAL, non-access-scoped — mirrors `hasRadioStations` above.
 *
 * Unlike `hasMusicLibraryOrContent` below, a file-less artist and the Various
 * Artists placeholder do NOT count unless they carry has_files.
 */
export async function hasPlayableMusic(sql: postgres.Sql): Promise<boolean> {
    const rows = await sql<{ has: boolean }[]>`
        SELECT EXISTS(
            SELECT 1 FROM media_items
             WHERE media_type IN ('artist', 'album', 'track')
               AND status = 'active'
               AND has_files = true
        ) AS has
    `;
    return rows[0]?.has === true;
}

/**
 * Whether this install has any music library or content: either an enabled
 * `library_paths` row of type `music`, or at least one real (non-placeholder)
 * artist/album/track `media_items` row.
 *
 * Used to gate music-scoped attention nudges (Last.fm / Discogs "not
 * configured") so a Movies & TV-only install stays quiet about integrations
 * it has no use for. GLOBAL, non-access-scoped check — mirrors
 * `hasRadioStations` above.
 *
 * The media_items branch excludes `is_various_artists = true` rows: the
 * canonical "Various Artists" placeholder (migration 16.132.0) is seeded on
 * EVERY install regardless of whether a music library exists, so counting it
 * here would defeat the gate on a fresh, zero-music install.
 */
export async function hasMusicLibraryOrContent(sql: postgres.Sql): Promise<boolean> {
    const rows = await sql<{ has: boolean }[]>`
        SELECT (
            EXISTS(SELECT 1 FROM library_paths WHERE media_type = 'music' AND enabled = true)
            OR EXISTS(
                SELECT 1 FROM media_items
                 WHERE media_type IN ('artist', 'album', 'track')
                   AND status = 'active'
                   AND (media_type = 'artist' OR has_files = true)
                   AND (media_type != 'artist' OR is_various_artists = false)
            )
        ) AS has
    `;
    return rows[0]?.has === true;
}

// ---------------------------------------------------------------------------
// Hover-card summaries
// ---------------------------------------------------------------------------

/**
 * Minimal artist projection for the music hover card.
 *
 * Exists because `getArtistWithAlbums` + `getArtistTracks` pull the artist's
 * entire discography *and* every track, plus popularity joins — far too heavy
 * to fire on a 150ms hover. Every field here comes off the artist row itself
 * (the counts are correlated subqueries over an indexed parent_id), so this is
 * one cheap lookup no matter how large the artist is.
 */
export interface MusicArtistSummaryRow {
    id: string;
    title: string;
    custom_poster_url: string | null;
    album_count: number;
    track_count: number;
    is_various_artists: boolean;
}

/** Minimal album projection for the music hover card. See {@link MusicArtistSummaryRow}. */
export interface MusicAlbumSummaryRow {
    id: string;
    title: string;
    custom_poster_url: string | null;
    year: number | null;
    artist_title: string | null;
    track_count: number;
    total_duration: number | null;
}

/**
 * Whether the id belongs to a media item of the given type. Callers MUST gate
 * the id for library/age access (and for UUID shape) before relying on it.
 */
export async function isMediaItemOfType(
    sql: postgres.Sql,
    id: string,
    mediaType: 'album' | 'artist' | 'track',
): Promise<boolean> {
    const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM media_items WHERE id = ${id} AND media_type = ${mediaType} LIMIT 1
    `;
    return rows.length > 0;
}

/**
 * Fetch the hover-card summary for one artist, or null when the id is not an
 * artist. Callers MUST gate the id for library/age access before returning it.
 */
export async function getArtistSummary(
    sql: postgres.Sql,
    artistId: string,
): Promise<MusicArtistSummaryRow | null> {
    const rows = await sql<MusicArtistSummaryRow[]>`
        WITH matched_tracks AS (
            ${artistMatchedTracksSql(sql, sql`${artistId}`)}
        )
        SELECT
            mi.id,
            mi.title,
            mi.custom_poster_url,
            mi.is_various_artists,
            (SELECT COUNT(DISTINCT parent_id)::int FROM matched_tracks) AS album_count,
            (SELECT COUNT(*)::int FROM matched_tracks) AS track_count
        FROM media_items mi
        WHERE mi.id = ${artistId}
          AND mi.media_type = 'artist'
          AND mi.parent_id IS NULL
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/**
 * Fetch the hover-card summary for one album, or null when the id is not an
 * album. Callers MUST gate the id for library/age access before returning it.
 *
 * `artist_title` mirrors getArtistWithAlbums: the hierarchy artist unless it is
 * the "Unknown Artist" placeholder, in which case the most common per-track
 * artist tag stands in.
 */
export async function getAlbumSummary(
    sql: postgres.Sql,
    albumId: string,
): Promise<MusicAlbumSummaryRow | null> {
    const rows = await sql<MusicAlbumSummaryRow[]>`
        SELECT
            mi.id,
            mi.title,
            mi.custom_poster_url,
            mi.year,
            CASE
                WHEN artist.title IS NOT NULL AND artist.title != 'Unknown Artist'
                THEN artist.title
                ELSE (
                    SELECT t.custom_metadata->>'artist'
                    FROM media_items t
                    WHERE t.parent_id = mi.id AND t.media_type = 'track'
                      AND t.custom_metadata->>'artist' IS NOT NULL
                          ${playableTrackSql(sql, 't')}
                    GROUP BY t.custom_metadata->>'artist'
                    ORDER BY COUNT(*) DESC
                    LIMIT 1
                )
            END AS artist_title,
            (
                SELECT COUNT(*)::int
                FROM media_items tracks
                WHERE tracks.parent_id = mi.id
                  AND tracks.media_type = 'track'
                  ${playableTrackSql(sql, 'tracks')}
            ) AS track_count,
            (
                SELECT COALESCE(SUM(tracks.runtime_seconds), 0)::int
                FROM media_items tracks
                WHERE tracks.parent_id = mi.id
                  AND tracks.media_type = 'track'
                  ${playableTrackSql(sql, 'tracks')}
            ) AS total_duration
        FROM media_items mi
        LEFT JOIN media_items artist
               ON artist.id = mi.parent_id
              AND artist.media_type = 'artist'
        WHERE mi.id = ${albumId}
          AND mi.media_type = 'album'
          ${availableAlbumSql(sql, 'mi')}
          AND EXISTS (SELECT 1 FROM media_items t WHERE t.parent_id = mi.id
              AND t.media_type = 'track' ${playableTrackSql(sql, 't')})
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/** Access-scoped summaries for a page. Legacy single-item helpers stay unchanged. */
export async function getArtistSummaries(
    sql: postgres.Sql,
    artistIds: string[],
    access: MediaAccessBoundary,
): Promise<MusicArtistSummaryRow[]> {
    if (!artistIds.length || deniesEverything(access)) return [];
    return sql<MusicArtistSummaryRow[]>`
        SELECT mi.id, mi.title, mi.custom_poster_url, mi.is_various_artists,
               counts.album_count, counts.track_count
        FROM media_items mi
        CROSS JOIN LATERAL (
            SELECT COUNT(DISTINCT mt.parent_id)::int AS album_count,
                   COUNT(*)::int AS track_count
            FROM (${artistMatchedTracksSql(sql, sql`mi.id`, access)}) mt
        ) counts
        WHERE mi.id = ANY(${artistIds}::uuid[])
          AND mi.media_type = 'artist'
          AND mi.parent_id IS NULL
    `;
}

export interface MusicAlbumPageSummaryRow extends MusicAlbumSummaryRow {
    artist_id: string | null;
}

/** One query for the page, with the same access boundary on counts and duration. */
export async function getAlbumSummaries(
    sql: postgres.Sql,
    albumIds: string[],
    access: MediaAccessBoundary,
): Promise<MusicAlbumPageSummaryRow[]> {
    if (!albumIds.length || deniesEverything(access)) return [];
    return sql<MusicAlbumPageSummaryRow[]>`
        SELECT album.id, album.title, album.custom_poster_url, album.year,
               artist.id AS artist_id,
               CASE WHEN artist.title IS NOT NULL AND artist.title != 'Unknown Artist'
                    THEN artist.title
                    ELSE counts.artist_title END AS artist_title,
               counts.track_count, counts.total_duration
        FROM media_items album
        LEFT JOIN media_items artist
               ON artist.id = album.parent_id AND artist.media_type = 'artist'
        CROSS JOIN LATERAL (
            SELECT COUNT(*)::int AS track_count,
                   COALESCE(SUM(t.runtime_seconds), 0)::int AS total_duration,
                   mode() WITHIN GROUP (ORDER BY t.custom_metadata->>'artist') AS artist_title
            FROM media_items t
            WHERE t.parent_id = album.id AND t.media_type = 'track'
              ${playableTrackSql(sql, 't', access)}
        ) counts
        WHERE album.id = ANY(${albumIds}::uuid[])
          AND counts.track_count > 0
          AND album.media_type = 'album'
          ${availableAlbumSql(sql, 'album', access)}
    `;
}
