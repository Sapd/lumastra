// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Search Queries Module
 *
 * Complex search operations with full-text search, trigram similarity,
 * and multi-field matching across titles, actors, and directors.
 *
 * Note: These methods contain substantial SQL logic (700+ lines total).
 * Consider further modularization if needed.
 *
 * @module queries/search
 */

import type postgres from 'postgres';
import { buildMusicTsQuery } from '../../utils/music-search-normalize.js';
import { buildGenreMembershipFilter } from './browse.queries.js';
import { isAvailableExpr, canRequestExpr } from './availability.queries.js';
import { artistHasPlayableTrackSql } from './music.queries.js';
import { buildMetadataLateralJoinFragment } from './builders/provider-metadata.builder.js';
import { Logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import type { MediaEmbedding } from '../connection.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { audiobookSearchMatch } from './audiobook-browse.queries.js';
import { isSingleCjkAudiobookQuery } from '$lib/server/utils/audiobook-search.js';
import {
    buildAgeRatingFilter,
    buildSeriesOwnedAgeRatingFilter,
} from './builders/age-rating.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import {
    trackArtistsSql,
    canonicalTrackArtistsSql,
    trackRemixerArtistsSql,
} from './fragments/music-artist.fragments.js';
import {
    sanitizeForTsquery,
    buildTsQueryFromText,
    ftsMatchFragment,
    keywordMatchFragment,
    creditMatchRankFragment,
    peopleMatchFragment,
    mediaTitlesMatchFragment,
    buildLikePattern,
    escapeLikePattern,
    buildSearchFilter,
    searchNeedsTrigramThreshold,
    searchSupportsSubstringMatch,
} from './builders/search-filter.builder.js';
import { runWithTrigramThreshold } from './builders/trigram-threshold.builder.js';
import { buildFileBackedVideoItemFilter } from './builders/file-backed-media.builder.js';

const logger = Logger.for('SearchQueries');

// Get trigram threshold from config (catches typos like "milo farow" -> "Milo Farrow")
const SEARCH_TRIGRAM_THRESHOLD = config.SEARCH_TRIGRAM_THRESHOLD;

// =============================================================================
// Ranking Constants (ref: DL-003)
// =============================================================================
// Constants are co-located here (not a separate file) because they are tightly
// coupled to the SQL expressions that use them. Changing a value requires
// understanding the surrounding CASE expression context.
//
// The two functions use DIFFERENT ranking signals as their primary input:
//   searchMedia        -> trigram similarity primary, FTS supplements
//   searchMediaFulltext -> FTS primary, higher title boost required
// This is why RANK_FULLTEXT_TITLE_BOOST (2) < RANK_FT_TITLE_FTS_BOOST (3).
// Each function uses a different primary ranking signal; the values must differ accordingly.

/**
 * Ranking boost constants for searchMedia.
 * searchMedia uses stored search_vector with GIN index for fast FTS.
 * ts_rank with weight array {0,0,0,1} scores only weight-A matches (titles).
 */
/** Title FTS boost added to ts_rank score (0-1) to ensure title matches outrank actor/director. */
const RANK_TITLE_FTS_BOOST = 2;
/** Fallback rank for actor/director matches that do not match by title FTS. */
const RANK_ACTOR_DIRECTOR_BASE = 0.5;

/**
 * Ranking boost constants for searchMediaFulltext.
 * Uses search_vector for title FTS (weight A) and overview FTS (weight B).
 */
/** Title FTS boost (weight A). Higher than searchMedia because fulltext has more signal types to differentiate. */
const RANK_FT_TITLE_FTS_BOOST = 3;
/** Overview FTS boost (weight B) */
const RANK_FT_OVERVIEW_FTS_BOOST = 1.5;
/**
 * Localized / original / alias title match (media_titles side table). A title the
 * user actually searched for (e.g. German "Große Pause" for English-primary
 * "Hafentage") — ranked just below a primary-title FTS hit but above overview/keyword/
 * people, since matching a known title is a strong signal.
 */
const RANK_FT_LOCALIZED_TITLE = 2.5;
/** MDBList keyword match score */
const RANK_FT_MDBLIST_KEYWORD = 1.0;
/** Generic keyword match score (slightly below mdblist) */
const RANK_FT_KEYWORD = 0.9;
/** Base rank for actor/director matches in searchMediaFulltext */
const RANK_FT_ACTOR_DIRECTOR_BASE = 0.5;

/**
 * Ranking boost constants for trigram fuzzy search (typo tolerance).
 * Used by searchMediaTrigram which runs as a separate pass.
 */
/** Boost for title trigram match */
const RANK_TRIGRAM_TITLE_BOOST = 1.0;
/** Boost for original_title trigram match */
const RANK_TRIGRAM_ORIG_TITLE_BOOST = 0.8;
/** Boost for english_title trigram match */
const RANK_TRIGRAM_ENG_TITLE_BOOST = 0.8;

/**
 * Exact / prefix title boosts. ts_rank is positional/density-based and cannot tell
 * an exact whole-title match ("Up") from a prefix-of-a-longer-title match
 * ("Uptown Funk"). These additive boosts force a true exact title (or original
 * title) to the very top, and a starts-with match just below it. Compared against
 * immutable_unaccent(title) so they're accent/case-insensitive and index-aligned.
 */
const RANK_EXACT_TITLE_BOOST = 5;
const RANK_PREFIX_TITLE_BOOST = 1;

/**
 * Build the additive exact/prefix title boost for the rank expression of the
 * movie/tv/music search builders and the admin quick-nav search (all alias
 * media_items as `mi`). `query` is the raw user query.
 *
 * Both sides go through `lower()`: `immutable_unaccent` folds accents but not
 * case, so without it a viewer typing "money heist" never got the exact boost
 * for "Money Heist", only the (ILIKE, case-insensitive) prefix one.
 *
 * `includeLocalized` adds the same exact/prefix tiers for the titles in the
 * `media_titles` side table (localized / original / alias). They sit in the same
 * CASE as the primary tiers, so an item is boosted once and a primary exact
 * match skips the side-table probe. Without them every localized hit tied:
 * German "Haus des Geldes" (the exact German title of "Money Heist") and fuzzy
 * lookalikes such as "Die Farbe des Geldes" scored the same, and the popularity
 * tiebreak put the lookalikes first. Required, so each caller states whether
 * its rows can have media_titles (catalog and admin quick-nav: yes; music: no).
 * Only from 3 characters on, like the media_titles match arm.
 *
 * The query is trimmed and its LIKE wildcards escaped for every arm, so a
 * trailing space or a literal `%`/`_` scores the same on both kinds of title.
 */
export function buildExactPrefixTitleBoost(
    sql: postgres.Sql,
    query: string,
    opts: { includeLocalized: boolean },
): postgres.PendingQuery<postgres.Row[]> {
    const q = query.trim();
    const prefixPattern = `${escapeLikePattern(q)}%`;
    const localized = opts.includeLocalized && searchSupportsSubstringMatch(q);
    // Uncorrelated sets, each found once through idx_media_titles_title_trgm (an
    // ILIKE without wildcards is a case-insensitive equality the trigram index
    // still serves) and probed per row as a hashed subplan. A correlated per-row
    // lookup instead cost 1.9 s for "the" on prod (11.5k matched rows).
    const localizedExact = localized
        ? sql`OR mi.id IN (
                SELECT mt.media_id FROM media_titles mt
                WHERE immutable_unaccent(mt.title) ILIKE immutable_unaccent(${escapeLikePattern(q)})
            )`
        : sql``;
    const localizedPrefix = localized
        ? sql`OR mi.id IN (
                SELECT mt.media_id FROM media_titles mt
                WHERE immutable_unaccent(mt.title) ILIKE immutable_unaccent(${prefixPattern})
            )`
        : sql``;
    return sql`
        CASE
            WHEN lower(immutable_unaccent(mi.title)) = lower(immutable_unaccent(${q}))
                 OR lower(immutable_unaccent(mi.original_title)) = lower(immutable_unaccent(${q}))
                 ${localizedExact}
            THEN ${RANK_EXACT_TITLE_BOOST}
            WHEN immutable_unaccent(mi.title) ILIKE immutable_unaccent(${prefixPattern})
                 ${localizedPrefix}
            THEN ${RANK_PREFIX_TITLE_BOOST}
            ELSE 0
        END`;
}

/**
 * Trigram similarity threshold for fuzzy matching.
 * searchEpisode / findSeriesContext / findSeriesByName match series names with the
 * trigram `%` operator. They run inside `runWithTrigramThreshold`, which
 * `SET LOCAL`s `pg_trgm.similarity_threshold` to `config.SEARCH_TRIGRAM_THRESHOLD`
 * (default 0.25) for the duration of the query — no longer the bare PostgreSQL
 * session default (0.3).
 */

// =============================================================================
// Types
// =============================================================================

export interface SearchFilters {
    genres?: string[];
    yearMin?: number;
    yearMax?: number;
    /** Minimum rating — checked across ALL rating sources (imdb, rt, mdblist, letterboxd, metacritic, trakt) */
    ratingMin?: number;
}

/**
 * Query-shaping options. The access boundary is deliberately NOT a member:
 * every search function takes a required {@link MediaAccessBoundary} as its own
 * parameter, so an omitted boundary is a compile error rather than a silently
 * unfiltered result set.
 */
export interface SearchOptions {
    limit?: number;
    offset?: number;
    mediaTypes?: ('movie' | 'tv' | 'episode' | 'music')[];
    availableOnly?: boolean;
    /** Require an actual file link for videos and a file-backed episode for series. */
    fileBackedOnly?: boolean;
    filters?: SearchFilters;
}

/** @see SearchOptions — the access boundary is a separate required parameter. */
export interface FulltextSearchOptions {
    /** False limits lexical matching to titles, while retaining people matches. */
    includeDescriptions?: boolean;
    limit?: number;
    offset?: number;
    /**
     * DB `media_items.media_type` values to restrict the scan to. `audiobook`
     * is a first-class member: books get their `search_vector` from the same
     * `trg_media_items_search_vector` trigger as everything else, so the
     * fulltext primitive answers them without a special case — see
     * `SearchService.searchAudiobookRows`.
     */
    mediaTypes?: ('movie' | 'tv' | 'episode' | 'music' | 'audiobook')[];
    availableOnly?: boolean;
    trigramThreshold?: number;
    filters?: SearchFilters;
}

/** @see SearchOptions — the access boundary is a separate required parameter. */
export interface MusicSearchOptions {
    offset?: number;
    /**
     * When true, excludes rows flagged `is_various_artists = true` from the
     * result. Defaults to `false` for compat safety — Subsonic/Jellyfin
     * callers invoke `searchMusic` without this option and must keep seeing
     * the "Various Artists" row. Only user-facing surfaces (universal
     * search, AI assistant music search) opt in.
     */
    excludeVariousArtists?: boolean;
    /**
     * When true, drops tracks and albums with no file on disk
     * (`has_files = false`). Such rows cannot be played or requested, so a
     * user-facing search that returns one hands the client a dead end: Siri
     * picked a file-less album for "One More Time", and its only track 404'd.
     * Artists are left alone — a credit-only artist legitimately has no files
     * of its own. Defaults to `true` on every music search surface.
     */
    playableOnly?: boolean;
    /**
     * Restricts which row TYPES are returned. Defaults to all three.
     *
     * Applied to the outer row only: hit discovery still walks the whole
     * track→album→artist chain, so `['track']` for an artist-name query
     * returns that artist's tracks (matched via parent/grandparent/credit),
     * just not the artist and album rows themselves. Lets a sectioned UI page
     * through songs without artists and albums eating the window.
     */
    mediaTypes?: ReadonlyArray<'artist' | 'album' | 'track'>;
    /**
     * `media_popularity.source` used to order tracks that tie on rank
     * (MUSIC_POPULARITY_PRIMARY_SOURCE). Defaults to 'lastfm'.
     */
    popularitySource?: string;
}

export interface MusicSearchResult {
    id: string;
    title: string;
    media_type: string;
    artist_name: string | null;
    artist_id: string | null;
    album_title: string | null;
    album_id: string | null;
    remixer_artists?: Array<{ id: string | null; title: string }> | null;
    track_artists: { id: string | null; title: string }[] | null;
    year: number | null;
    runtime_seconds: number | null;
    created_at: string | null;
    custom_metadata: Record<string, unknown>;
    custom_poster_url: string | null;
    image_source_id: string | null;
    rank: number;
    /** Track popularity (0-1) used only to order rank ties; 0 for other rows. */
    popularity: number;
}

export interface AdminQuickSearchRow {
    id: string;
    title: string | null;
    media_type: string;
    year: number | null;
    season_number: number | null;
    episode_number: number | null;
    parent_id: string | null;
    parent_title: string | null;
    grandparent_title: string | null;
    season_count: number | null;
    episode_count: number | null;
    has_file: boolean;
    rank: number;
}

/**
 * Admin quick-nav search across every media type (movie/tv/episode/season/
 * artist/album/track) with parent/child context.
 *
 * This is an admin-only surface, so its sole caller passes
 * `unrestrictedAccess()` — but the boundary is still a required parameter so
 * that "unfiltered" is an explicit, greppable decision rather than the absence
 * of an argument. An `unrestrictedAccess()` boundary emits no predicate, so the
 * SQL is byte-identical to the previous unscoped version.
 *
 * Relevance-ordered: the admin UI groups results by mediaType client-side, so
 * the SQL order only decides WHICH `limit` rows survive and the within-group
 * order. Rank mirrors searchMusic: direct FTS hit > parent > grandparent >
 * trigram-only similarity, plus the shared exact/prefix title boost; the
 * media-type bucket is kept as the tiebreak so equal-rank results still group
 * predictably.
 */
export async function searchAdminQuickNav(
    sql: postgres.Sql,
    query: string,
    access: MediaAccessBoundary,
    limit = 30,
    mediaType?: 'album' | 'tv',
): Promise<AdminQuickSearchRow[]> {
    const tsQuery = buildTsQueryFromText(query);
    if (!tsQuery) return [];
    // Short-circuit before the MATERIALIZED CTE — the CTE would otherwise still
    // materialize denied ids even though the outer WHERE drops them.
    if (deniesEverything(access)) return [];

    return runWithTrigramThreshold(sql, searchNeedsTrigramThreshold(query), (db) => {
        const searchFilter = buildSearchFilter(db, query, {
            searchParent: true,
            searchGrandparent: true,
        });

        return db<AdminQuickSearchRow[]>`
            ${searchFilter.cte}
            SELECT mi.id, mi.title, mi.media_type, mi.year,
                   mi.season_number, mi.episode_number, mi.parent_id,
                   parent.title AS parent_title,
                   grandparent.title AS grandparent_title,
                   (SELECT COUNT(*)::int FROM media_items c
                    WHERE c.parent_id = mi.id AND c.media_type = 'season'
                    AND c.status = 'active') AS season_count,
                   (SELECT COUNT(*)::int FROM media_items c
                    WHERE c.status = 'active' AND c.media_type = 'episode'
                    AND (c.parent_id = mi.id OR c.parent_id IN (
                        SELECT s.id FROM media_items s
                        WHERE s.parent_id = mi.id AND s.media_type = 'season'
                    ))) AS episode_count,
                   mi.has_files AS has_file,
                   CASE
                       WHEN mi.search_vector @@ to_tsquery('simple', immutable_unaccent(${tsQuery}))
                       THEN ts_rank(mi.search_vector, to_tsquery('simple', immutable_unaccent(${tsQuery}))) + 1.0
                       WHEN parent.search_vector @@ to_tsquery('simple', immutable_unaccent(${tsQuery}))
                       THEN 0.8
                       WHEN grandparent.search_vector @@ to_tsquery('simple', immutable_unaccent(${tsQuery}))
                       THEN 0.6
                       -- NOTE: there is no cast/people arm here, unlike searchMusic.
                       -- A cast match reaches this query through
                       -- buildMediaMatchPredicate's people arm but earns no rank, so it
                       -- lands in this trigram ELSE, which scores the QUERY against the
                       -- TITLE -- typically ~0 for an actor name. That is the same defect
                       -- that made credited music artists unfindable (see the credited-
                       -- artist arm in searchMusic below).
                       --
                       -- It is deliberately NOT fixed here, because it could not be shown
                       -- to bite: a cast-only match is only truncated away when many
                       -- higher-ranked TITLE hits compete for the same page, and the real
                       -- cases available all lack competitors -- "kaley cuoco" returns 12
                       -- credited rows and 0 FTS rows, so every one surfaces at any rank.
                       -- The exposure is a cast name that collides with common title
                       -- words at volume. If such a case ever turns up, the fix is the
                       -- arm searchMusic uses; until then, changing global movie/TV
                       -- ranking would be an unmeasured change to every search on the
                       -- platform to fix a defect nobody has observed.
                       ELSE GREATEST(
                           similarity(immutable_unaccent(mi.title), immutable_unaccent(${query})),
                           similarity(immutable_unaccent(mi.original_title), immutable_unaccent(${query})),
                           similarity(immutable_unaccent(mi.english_title), immutable_unaccent(${query}))
                       )
                   END + ${buildExactPrefixTitleBoost(db, query, { includeLocalized: true })} AS rank
            FROM media_items mi
            LEFT JOIN media_items parent ON mi.parent_id = parent.id
            LEFT JOIN media_items grandparent ON parent.parent_id = grandparent.id
            WHERE mi.media_type IN ('movie', 'tv', 'episode', 'season',
                  'artist', 'album', 'track')
              ${mediaType ? db`AND mi.media_type = ${mediaType}` : db``}
              AND mi.status = 'active'
              ${searchFilter.where}
              ${buildLibraryAccessFilter(db, access.library)}
              ${buildSeriesOwnedAgeRatingFilter(db, access.age)}
            ORDER BY
                rank DESC,
                CASE mi.media_type
                    WHEN 'tv' THEN 1
                    WHEN 'movie' THEN 2
                    WHEN 'artist' THEN 3
                    WHEN 'album' THEN 4
                    WHEN 'season' THEN 5
                    WHEN 'episode' THEN 6
                    WHEN 'track' THEN 7
                END,
                mi.title
            LIMIT ${limit}
        `;
    });
}

/**
 * Search music tracks and albums using full-text search on the search_vector column.
 * Returns tracks with their artist and album context from the parent chain.
 *
 * The access boundary (library group + age rating) is a required parameter to
 * prevent inadvertent cross-library / over-age disclosure. A caller that
 * genuinely has no restrictions must say so with `unrestrictedAccess()`. The
 * age filter is best-effort for containers (artists / albums) because they
 * have no `media_file_items` rows; track-level filtering still applies via the
 * tracks themselves matched in the CTE.
 *
 * @param sql - Postgres SQL instance
 * @param query - Search query string
 * @param limit - Maximum number of results
 * @param access - Required media access boundary
 * @param options - Query-shaping options (offset, excludeVariousArtists)
 * @returns Array of matching music items with artist/album context
 */
export async function searchMusic(
    sql: postgres.Sql,
    query: string,
    limit: number,
    access: MediaAccessBoundary,
    options: MusicSearchOptions = {},
): Promise<MusicSearchResult[]> {
    const tsQuery = buildTsQueryFromText(query);
    // Volume/number-tolerant title tokens ("vol.100" -> "100"); only matched
    // against music_title_search_vector, never against search_vector.
    const musicTsQuery = buildMusicTsQuery(query);
    if (!tsQuery && !musicTsQuery) return [];
    // Short-circuit before the MATERIALIZED CTE: buildSearchFilter's CTE would
    // still materialize denied ids, and only the outer WHERE drops them.
    if (deniesEverything(access)) return [];

    const {
        offset = 0,
        excludeVariousArtists = false,
        playableOnly = true,
        mediaTypes = ['artist', 'album', 'track'],
        popularitySource = 'lastfm',
    } = options;
    if (mediaTypes.length === 0) return [];

    const needsThreshold = searchNeedsTrigramThreshold(query);

    try {
        const results = await runWithTrigramThreshold(sql, needsThreshold, (db) => {
            // Library-group filter for music. Artists / albums never have direct
            // media_file_items rows of their own (only their descendant tracks do),
            // so a naive "row has no files = allowed" gate is fail-open for them.
            // For containers we require at least one descendant track whose file
            // sits in a non-denied library group; for tracks we check the file
            // directly.
            //
            // NOTE: this predicate is hierarchy-aware and deliberately NOT
            // buildLibraryAccessFilter — swapping in the generic builder would
            // change which rows music callers see. Only the scope *dispatch*
            // below is new; every emitted branch is byte-identical to before.
            const deniedGroupIds = access.library.kind === 'denyGroups' ? access.library.ids : null;
            const libraryFilter =
                access.library.kind === 'denyAll'
                    ? // Unreachable via the deniesEverything() short-circuit above;
                      // kept so the dispatch is total and a future short-circuit
                      // removal stays fail-closed.
                      db`AND false`
                    : deniedGroupIds && deniedGroupIds.length > 0
                      ? db`AND (
                CASE mi.media_type
                    WHEN 'track' THEN EXISTS (
                        SELECT 1 FROM media_file_items mfi
                        JOIN media_files mf ON mf.id = mfi.file_id
                        WHERE mfi.media_item_id = mi.id
                          AND (mf.library_group_id IS NULL
                               OR mf.library_group_id != ALL(${deniedGroupIds}::uuid[]))
                    )
                    WHEN 'album' THEN EXISTS (
                        SELECT 1
                        FROM media_items track
                        JOIN media_file_items mfi ON mfi.media_item_id = track.id
                        JOIN media_files mf ON mf.id = mfi.file_id
                        WHERE track.parent_id = mi.id
                          AND track.media_type = 'track'
                          AND (mf.library_group_id IS NULL
                               OR mf.library_group_id != ALL(${deniedGroupIds}::uuid[]))
                    )
                    WHEN 'artist' THEN (
                        EXISTS (
                            SELECT 1
                            FROM media_items track
                            JOIN media_items album ON album.id = track.parent_id
                              AND album.media_type = 'album'
                            JOIN media_file_items mfi ON mfi.media_item_id = track.id
                            JOIN media_files mf ON mf.id = mfi.file_id
                            WHERE album.parent_id = mi.id
                              AND track.media_type = 'track'
                              AND (mf.library_group_id IS NULL
                                   OR mf.library_group_id != ALL(${deniedGroupIds}::uuid[]))
                        )
                        -- Credit-only artist (bug: "Pimp! Code" search regression):
                        -- an artist can own zero albums of its own and still be a
                        -- legitimate, actively-referenced entity — ensureTrackArtistLinks
                        -- (file-scanner) links a track's non-album-owning performer via
                        -- custom_metadata.additional_artist_ids instead of parenting an
                        -- album under them. The hierarchy probe above only walks
                        -- track→album→artist, so a credit-only artist is invisible to
                        -- any library-restricted user even though it resolves fine via
                        -- direct-id lookup. Mirrors the same fix already applied to
                        -- softDeleteOrphanMediaStubs.
                        OR EXISTS (
                            SELECT 1
                            FROM media_items track
                            JOIN media_file_items mfi ON mfi.media_item_id = track.id
                            JOIN media_files mf ON mf.id = mfi.file_id
                            WHERE track.media_type = 'track'
                              AND track.status = 'active'
                              AND jsonb_typeof(track.custom_metadata->'additional_artist_ids') = 'array'
                              AND track.custom_metadata->'additional_artist_ids' @> jsonb_build_array(mi.id::text)
                              AND (mf.library_group_id IS NULL
                                   OR mf.library_group_id != ALL(${deniedGroupIds}::uuid[]))
                        )
                    )
                    ELSE FALSE
                END
            )`
                      : db``;

            // Age filter — `mi` is the outer media_items alias so the helper is
            // schema-compatible here. Containers (artist / album) typically have
            // age_rating IS NULL; allowUnrated drives whether they remain visible.
            const ageFilter = buildAgeRatingFilter(db, access.age);

            const searchFilter = buildSearchFilter(db, query, {
                normalizeMusicTitles: true,
                searchParent: true,
                searchGrandparent: true,
                includeMetadataMatch: false,
                // ...but DO match artist credits. Featured/secondary artists
                // live in media_people (source 'local', migration 16.237.0);
                // the parent chain below only carries the primary artist, so
                // without this a search for a featured artist finds nothing.
                includePeopleMatch: true,
                // Closed under the parent chain (track→album→artist), so hit
                // and candidate discovery stays inside the music domain.
                mediaTypes: ['artist', 'album', 'track'],
            });

            // CTE materializes matching IDs via GIN index (sub-ms), then expands
            // to children/grandchildren via PK lookups for parent chain search.
            // Trigram direct-only OR is appended by buildSearchFilter for typo tolerance.
            return db<MusicSearchResult[]>`
                ${searchFilter.cte}
                SELECT
                    mi.id::text AS id,
                    mi.title,
                    mi.media_type,
                    CASE
                        WHEN mi.media_type = 'track' THEN CASE
                            WHEN jsonb_typeof(NULLIF(mi.custom_metadata->'track_artist_credits', '[]'::jsonb)) = 'array'
                            THEN (SELECT string_agg(credit->>'title', ', ' ORDER BY ord)
                                FROM jsonb_array_elements(${canonicalTrackArtistsSql(db, 'mi')})
                                    WITH ORDINALITY credits(credit, ord))
                            ELSE COALESCE(NULLIF(mi.custom_metadata->>'artist', ''), grandparent.title)
                        END
                        ELSE parent.title
                    END AS artist_name,
                    CASE
                        WHEN mi.media_type = 'track' THEN CASE
                            WHEN jsonb_typeof(NULLIF(mi.custom_metadata->'track_artist_credits', '[]'::jsonb)) = 'array'
                            THEN ${canonicalTrackArtistsSql(db, 'mi')}->0->>'id'
                            WHEN lower(trim(mi.custom_metadata->>'artist')) = lower(trim(grandparent.title))
                                OR NULLIF(mi.custom_metadata->>'artist', '') IS NULL
                            THEN grandparent.id::text END
                        WHEN mi.media_type = 'album' THEN parent.id::text
                        ELSE NULL
                    END AS artist_id,
                    CASE
                        WHEN mi.media_type = 'track' THEN parent.title
                        ELSE NULL
                    END AS album_title,
                    CASE
                        WHEN mi.media_type = 'track' THEN parent.id::text
                        ELSE NULL
                    END AS album_id,
                    CASE
                        WHEN mi.media_type = 'track' THEN ${trackArtistsSql(db, 'mi')}
                        ELSE NULL
                    END AS track_artists,
                    CASE WHEN mi.media_type = 'track' THEN ${trackRemixerArtistsSql(db, 'mi')} END AS remixer_artists,
                    mi.year,
                    mi.runtime_seconds,
                    mi.created_at::text AS created_at,
                    COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
                    COALESCE(mi.custom_poster_url, CASE WHEN mi.media_type = 'track' THEN parent.custom_poster_url ELSE NULL END) AS custom_poster_url,
                    CASE
                        WHEN mi.custom_poster_url IS NOT NULL THEN mi.id::text
                        WHEN mi.media_type = 'track' AND parent.custom_poster_url IS NOT NULL THEN parent.id::text
                        ELSE NULL
                    END AS image_source_id,
                    CASE
                        ${
                            musicTsQuery
                                ? db`WHEN music_title_search_vector(mi.title, mi.original_title, mi.english_title)
                            @@ to_tsquery('simple', immutable_unaccent(${musicTsQuery}))
                        THEN CASE
                            WHEN music_search_normalize(mi.title) = music_search_normalize(${query})
                              OR music_search_normalize(mi.original_title) = music_search_normalize(${query})
                              OR music_search_normalize(mi.english_title) = music_search_normalize(${query})
                            THEN 6.0
                            ELSE ts_rank(music_title_search_vector(mi.title, mi.original_title, mi.english_title),
                                to_tsquery('simple', immutable_unaccent(${musicTsQuery}))) + 1.0 END`
                                : db``
                        }
                        WHEN mi.search_vector @@ to_tsquery('simple', immutable_unaccent(${tsQuery}))
                        THEN ts_rank(mi.search_vector, to_tsquery('simple', immutable_unaccent(${tsQuery}))) + 1.0
                        WHEN parent.search_vector @@ to_tsquery('simple', immutable_unaccent(${tsQuery}))
                        THEN 0.8
                        -- Credited-artist hit (media_people, source 'local').
                        --
                        -- Without this branch a credit match earns NO rank at all: it
                        -- falls through to the trigram ELSE, which scores the QUERY
                        -- against the TITLE. "Moi Lolita" vs "perfect pitch" is 0.0, so
                        -- the track the user is looking for lands at rank 0 and is
                        -- truncated away by LIMIT while songs merely titled "Perfect"
                        -- occupy the page. Measured on prod before this branch existed:
                        -- 30 rows matched via credits, ranked 0.0-0.8, against a 40th
                        -- place cutoff of 0.4 -- so the projection worked and the
                        -- ranking discarded it. Matching but unrankable is not findable.
                        --
                        -- Placed ABOVE the grandparent arm deliberately. media_people
                        -- carries EVERY credited artist including the primary, so a
                        -- primary-artist match would otherwise be caught by grandparent
                        -- at 0.6 while a featured-only credit scored higher here --
                        -- ranking featured credits above the main artist. Above it,
                        -- every artist credit scores the same 0.7 whichever way it is
                        -- reachable, and grandparent stays as the fallback for rows with
                        -- no projected credits (see the 377 VA-parented tracks).
                        --
                        -- GRADED, not flat -- see creditMatchRankFragment. A flat
                        -- score was the first attempt and it failed in a way only
                        -- the endpoint showed: peopleMatchFragment matches loosely
                        -- (substring + trigram), so "perfect pitch" also returns
                        -- tracks credited to "The Pitcher" and "Perplexer". Scoring
                        -- those equal to a real credit made one big tie, ties break
                        -- alphabetically by title, and the wanted row landed at
                        -- position 43 behind 16 trigram-only rows that happened to
                        -- sort earlier. Exact credit 0.95 / substring 0.75 /
                        -- trigram-only 0.35 separates them.
                        WHEN ${creditMatchRankFragment(db, query)} IS NOT NULL
                        THEN ${creditMatchRankFragment(db, query)}
                        WHEN grandparent.search_vector @@ to_tsquery('simple', immutable_unaccent(${tsQuery}))
                        THEN 0.6
                        -- Trigram-only (typo-tolerant) hit: score by closeness so the best
                        -- fuzzy match floats up instead of tying every fuzzy hit at 0 and
                        -- getting truncated away by LIMIT. Mirrors the trigram fragment's
                        -- title fields; GREATEST ignores NULL original/english titles.
                        ELSE GREATEST(
                            similarity(immutable_unaccent(mi.title), immutable_unaccent(${query})),
                            similarity(immutable_unaccent(mi.original_title), immutable_unaccent(${query})),
                            similarity(immutable_unaccent(mi.english_title), immutable_unaccent(${query}))
                        )
                    END
                    -- Same exact/prefix boost the movie/tv rank uses. Without it every
                    -- direct FTS hit ties (ts_rank has no length normalization), the
                    -- alphabetical tiebreak takes over, and a short query like "sum"
                    -- LIMIT-truncates "Sum 41" behind dozens of "…Summer…" tracks.
                    + ${buildExactPrefixTitleBoost(db, query, { includeLocalized: false })} AS rank,
                    -- Popularity tiebreak, a SORT KEY and never part of rank. An
                    -- artist-name query ties every track of that artist (own and
                    -- credited) at one credit tier, and the tie used to break A-Z,
                    -- so the songs people look for sank below whatever started with
                    -- "A". Added to rank (first attempt) it could lift a fuzzy hit
                    -- over a real tier, since the ts_rank and trigram arms are
                    -- continuous, and a popular track over its own artist row. As a
                    -- key after rank and type it only orders exact ties. Only the
                    -- service re-sort could undo it, which is why searchMusicRows
                    -- keeps this row order for equal ranks.
                    -- track_in_artist is normalized per artist, so across artists it
                    -- is a rough signal; it never outweighs relevance.
                    COALESCE(tpop.normalized_score, 0) AS popularity
                FROM media_items mi
                LEFT JOIN media_items parent ON parent.id = mi.parent_id
                LEFT JOIN media_items grandparent ON grandparent.id = parent.parent_id
                -- PK (media_id, source): at most one row per track.
                LEFT JOIN media_popularity tpop
                    ON tpop.media_id = mi.id
                   AND tpop.source = ${popularitySource}
                   AND tpop.score_context = 'track_in_artist'
                WHERE mi.media_type = ANY(${[...mediaTypes]}::text[])
                  AND mi.status = 'active'
                  -- Flagged VA rows are only ever the artist row itself
                  -- (album/track rows always default false), so this excludes
                  -- the VA artist without touching its children. Opt-in only:
                  -- Subsonic/Jellyfin compat callers must keep VA visible.
                  ${excludeVariousArtists ? db`AND mi.is_various_artists = false` : db``}
                  ${
                      playableOnly
                          ? db`AND CASE WHEN mi.media_type = 'artist'
                      THEN ${artistHasPlayableTrackSql(db, db`mi.id`, access)}
                      ELSE ${isAvailableExpr(db)} END`
                          : db``
                  }
                  ${searchFilter.where}
                  ${libraryFilter}
                  ${ageFilter}
                -- On equal rank prefer containers (artist > album > track): for a
                -- bare artist-name query the artist row is what the user wants, and
                -- it must survive the LIMIT window even when many same-rank tracks
                -- sort ahead of it alphabetically.
                ORDER BY rank DESC,
                    CASE mi.media_type WHEN 'artist' THEN 0 WHEN 'album' THEN 1 ELSE 2 END,
                    popularity DESC,
                    mi.title ASC,
                    -- Unique last key: same-titled tracks (one song on two albums)
                    -- tie on everything above, and an unstable order at the LIMIT
                    -- edge makes offset pages skip or repeat rows.
                    mi.id ASC
                LIMIT ${limit}
                OFFSET ${offset}
            `;
        });

        return results;
    } catch (error) {
        logger.error('Failed to search music', error as Error, { query });
        return [];
    }
}

/**
 * Trigram fuzzy search for typo tolerance.
 * Uses the % operator with GIN trigram indexes on title, original_title, english_title.
 * Runs inside a transaction with SET LOCAL to configure similarity threshold.
 *
 * Designed to run as a second pass after FTS, excluding IDs already found.
 * Results are tagged with search_source: 'fuzzy' for downstream identification.
 *
 * @param sql - Postgres SQL instance
 * @param query - Search query string
 * @param access - Required media access boundary
 * @param options - Search options
 * @param excludeIds - Internal IDs already found by FTS (to avoid duplicates)
 * @returns Array of matching media items with fuzzy relevance scoring
 */
export async function searchMediaTrigram(
    sql: postgres.Sql,
    query: string,
    access: MediaAccessBoundary,
    options: SearchOptions = {},
    excludeIds: string[] = [],
): Promise<
    Array<MediaEmbedding & { rank: number; search_source: 'fuzzy'; is_available?: boolean }>
> {
    // No offset here: the trigram (typo) pass is a first-page-only fallback merged
    // after FTS; the route skips it entirely when offset > 0.
    const {
        limit = 50,
        mediaTypes = ['movie', 'tv'],
        availableOnly = true,
        filters = {},
    } = options;

    // Checked BEFORE the short-query bail below so a deny-everything caller
    // always returns empty for the access reason, never incidentally.
    if (deniesEverything(access)) return [];

    // buildTsQueryFromText not used here — trigram uses raw query, not tsquery.
    // Bail when no word is long enough for meaningful trigram similarity
    // (< 3 chars degenerates on the GIN indexes and over-matches; the FTS
    // prefix pass covers short queries).
    if (!searchNeedsTrigramThreshold(query)) {
        return [];
    }

    const trigramThreshold = SEARCH_TRIGRAM_THRESHOLD;

    try {
        // Use sql.begin for transaction to SET LOCAL the similarity threshold
        const results = await sql.begin(async (txRaw) => {
            const tx = txRaw as unknown as postgres.Sql;
            // SET LOCAL only affects this transaction — no global side effects
            await tx`SELECT set_config('pg_trgm.similarity_threshold', ${String(trigramThreshold)}, true)`;

            return tx<Array<MediaEmbedding & { rank: number; search_source: 'fuzzy' }>>`
                SELECT
                    0 as id,
                    mi.id::text as internal_id,
                    COALESCE((SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1), '') as tmdb_id,
                    (SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = 'imdb' LIMIT 1) as imdb_id,
                    mi.media_type,
                    mi.title,
                    mi.original_title,
                    mi.english_title,
                    COALESCE(NULLIF(mi.overview, ''), NULLIF(pm.metadata->>'overview', ''))::text as overview,
                    CASE WHEN pm.metadata->'genres' IS NOT NULL AND jsonb_typeof(pm.metadata->'genres') = 'array'
                        THEN ARRAY(SELECT COALESCE((elem->>'id')::integer, (elem#>>'{}')::integer) FROM jsonb_array_elements(pm.metadata->'genres') AS elem WHERE elem IS NOT NULL AND elem != 'null'::jsonb AND (jsonb_typeof(elem) = 'object' OR jsonb_typeof(elem) = 'number' OR (jsonb_typeof(elem) = 'string' AND (elem#>>'{}') ~ '^[0-9]+$')))
                        ELSE NULL
                    END as genres,
                    CASE WHEN mi.year IS NOT NULL AND mi.year BETWEEN 1 AND 9999
                        THEN make_date(mi.year, 1, 1)
                        ELSE NULL
                    END as release_date,
                    (pm.metadata->>'vote_count')::integer as vote_count,
                    (pm.metadata->>'popularity')::float as popularity,
                    (pm.metadata->>'runtime_minutes')::integer as runtime_minutes,
                    CASE WHEN pm.metadata->'actors' IS NOT NULL AND jsonb_typeof(pm.metadata->'actors') = 'array'
                        THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'actors') AS elem)
                        ELSE NULL
                    END as actors,
                    CASE WHEN pm.metadata->'directors' IS NOT NULL AND jsonb_typeof(pm.metadata->'directors') = 'array'
                        THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'directors') AS elem)
                        ELSE NULL
                    END as directors,
                    (pm.metadata->>'imdb_rating')::float as imdb_rating,
                    (pm.metadata->>'popularity')::float as tmdb_rating,
                    (pm.metadata->>'rt_rating')::integer as rt_rating,
                    (pm.metadata->>'rt_audience_score')::integer as rt_audience_score,
                    (pm.metadata->>'mdblist_score')::float as mdblist_score,
                    (pm.metadata->>'letterboxd_rating')::float as letterboxd_rating,
                    (pm.metadata->>'metacritic_score')::integer as metacritic_score,
                    (pm.metadata->>'trakt_score')::float as trakt_score,
                    (pm.metadata->>'certification')::text as certification,
                    (pm.metadata->>'poster_path')::text as poster_path,
                    ${isAvailableExpr(tx)} AS is_available,
                    ${canRequestExpr(tx)} AS can_request,
                    mi.created_at,
                    mi.updated_at,
                    -- Ranking: best similarity across title fields + boost.
                    -- Two folds checked on both sides: immutable_unaccent
                    -- ("Shogun" vs "Shōgun") and german_digraph_fold
                    -- ("Mueller" vs "Müller"). rank takes the better of the two.
                    CASE
                        WHEN immutable_unaccent(mi.title) % immutable_unaccent(${query})
                          OR german_digraph_fold(mi.title) % german_digraph_fold(${query})
                        THEN GREATEST(
                            similarity(immutable_unaccent(mi.title), immutable_unaccent(${query})),
                            similarity(german_digraph_fold(mi.title), german_digraph_fold(${query}))
                        ) + ${RANK_TRIGRAM_TITLE_BOOST}
                        WHEN immutable_unaccent(mi.original_title) % immutable_unaccent(${query})
                          OR german_digraph_fold(mi.original_title) % german_digraph_fold(${query})
                        THEN GREATEST(
                            similarity(immutable_unaccent(COALESCE(mi.original_title, '')), immutable_unaccent(${query})),
                            similarity(german_digraph_fold(COALESCE(mi.original_title, '')), german_digraph_fold(${query}))
                        ) + ${RANK_TRIGRAM_ORIG_TITLE_BOOST}
                        WHEN immutable_unaccent(mi.english_title) % immutable_unaccent(${query})
                          OR german_digraph_fold(mi.english_title) % german_digraph_fold(${query})
                        THEN GREATEST(
                            similarity(immutable_unaccent(COALESCE(mi.english_title, '')), immutable_unaccent(${query})),
                            similarity(german_digraph_fold(COALESCE(mi.english_title, '')), german_digraph_fold(${query}))
                        ) + ${RANK_TRIGRAM_ENG_TITLE_BOOST}
                        ELSE 0
                    END as rank,
                    'fuzzy' as search_source
                FROM media_items mi
                ${buildMetadataLateralJoinFragment(tx)}
                WHERE mi.status = 'active'
                  AND mi.media_type = ANY(${mediaTypes})
                  ${availableOnly ? tx`AND mi.has_files = true` : tx`AND (mi.media_type <> 'episode' OR mi.has_files = true)`}
                  ${filters.yearMin !== undefined ? tx`AND mi.year >= ${filters.yearMin}` : tx``}
                  ${filters.yearMax !== undefined ? tx`AND mi.year <= ${filters.yearMax}` : tx``}
                  ${buildGenreMembershipFilter(tx, filters.genres)}
                  ${
                      filters.ratingMin !== undefined
                          ? tx`AND GREATEST(
                      COALESCE((pm.metadata->>'imdb_rating')::float, 0),
                      COALESCE((pm.metadata->>'rt_rating')::integer::float / 10.0, 0),
                      COALESCE((pm.metadata->>'mdblist_score')::float / 10.0, 0),
                      COALESCE((pm.metadata->>'letterboxd_rating')::float * 2.0, 0),
                      COALESCE((pm.metadata->>'metacritic_score')::integer::float / 10.0, 0),
                      COALESCE((pm.metadata->>'trakt_score')::float, 0)
                  ) >= ${filters.ratingMin}`
                          : tx``
                  }
                  ${buildLibraryAccessFilter(tx, access.library)}
                  ${buildSeriesOwnedAgeRatingFilter(tx, access.age)}
                  -- Trigram similarity using % operator, checked under both
                  -- folds: immutable_unaccent (accent) and german_digraph_fold
                  -- (umlaut digraphs). Each branch matches its expression GIN
                  -- index (idx_media_items_*_unaccent_trgm / _digraph_trgm).
                  AND (immutable_unaccent(mi.title) % immutable_unaccent(${query})
                       OR german_digraph_fold(mi.title) % german_digraph_fold(${query})
                       OR immutable_unaccent(mi.original_title) % immutable_unaccent(${query})
                       OR german_digraph_fold(mi.original_title) % german_digraph_fold(${query})
                       OR immutable_unaccent(mi.english_title) % immutable_unaccent(${query})
                       OR german_digraph_fold(mi.english_title) % german_digraph_fold(${query}))
                  -- Exclude IDs already found by FTS
                  ${excludeIds.length > 0 ? tx`AND mi.id != ALL(${excludeIds}::uuid[])` : tx``}
                ORDER BY
                    rank DESC,
                    popularity DESC NULLS LAST,
                    vote_count DESC NULLS LAST,
                    mi.id ASC
                LIMIT ${limit}
            `;
        });

        return results;
    } catch (error) {
        logger.error('Failed to trigram search media', error as Error, {
            query,
        });
        throw error;
    }
}

export interface EpisodeByNumberResult {
    id: string;
    series_internal_id: string;
    /** Best available series external ID (primary provider preferred, then fallbacks) */
    series_ext_id: string | null;
    /** Provider name corresponding to series_ext_id */
    series_ext_provider: string | null;
    season_number: number;
    episode_number: number;
    title: string;
    overview: string | null;
    series_name: string;
    series_year: number | null;
    series_imdb_rating: number | null;
    series_tmdb_rating: number | null;
    /** The episode itself has a file (`media_items.has_files`). */
    is_available: boolean;
}

export interface SeriesSearchContext {
    found: boolean;
    /** Series internal UUID (media_items.id). UUID-first: Jellyfin is sync-only. */
    internal_id?: string;
    tmdb_id?: string;
    title?: string;
    available_seasons?: number[];
}

// =============================================================================
// Search Functions
// =============================================================================

/**
 * Search media using stored search_vector with GIN index for fast FTS.
 * Searches titles (via search_vector weight A), actors, and directors.
 *
 * Search strategy:
 * 1. FTS on search_vector (GIN index, sub-ms) — matches all title fields
 * 2. OR actor/director ILIKE — secondary signal
 *
 * Typo tolerance (trigram) is handled separately by searchMediaTrigram,
 * orchestrated by the search endpoint based on SEARCH_TYPO_TOLERANCE config.
 *
 * @param sql - Postgres SQL instance
 * @param query - Search query string
 * @param access - Required media access boundary
 * @param options - Search options (limit, mediaTypes, availableOnly)
 * @returns Array of matching media items with relevance scoring
 */
export async function searchMedia(
    sql: postgres.Sql,
    query: string,
    access: MediaAccessBoundary,
    options: SearchOptions = {},
): Promise<Array<MediaEmbedding & { rank: number; is_available?: boolean }>> {
    const {
        limit = 50,
        offset = 0,
        mediaTypes = ['movie', 'tv'],
        availableOnly = true,
        fileBackedOnly = false,
        filters = {},
    } = options;

    // Ranking with title-only weights does not restrict the WHERE predicate.
    const tsQuery = buildTsQueryFromText(query, 2, 'A') ?? '';
    const filterOnly = query.trim() === '*';
    if (!tsQuery && !filterOnly) return [];
    if (deniesEverything(access)) return [];

    try {
        const results = await sql<Array<MediaEmbedding & { rank: number }>>`
            SELECT
                0 as id,
                mi.id::text as internal_id,
                COALESCE((SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1), '') as tmdb_id,
                (SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = 'imdb' LIMIT 1) as imdb_id,
                mi.media_type,
                mi.title,
                mi.original_title,
                mi.english_title,
                COALESCE(NULLIF(mi.overview, ''), NULLIF(pm.metadata->>'overview', ''))::text as overview,
                CASE WHEN pm.metadata->'genres' IS NOT NULL AND jsonb_typeof(pm.metadata->'genres') = 'array'
                    THEN ARRAY(SELECT COALESCE((elem->>'id')::integer, (elem#>>'{}')::integer) FROM jsonb_array_elements(pm.metadata->'genres') AS elem WHERE elem IS NOT NULL AND elem != 'null'::jsonb AND (jsonb_typeof(elem) = 'object' OR jsonb_typeof(elem) = 'number' OR (jsonb_typeof(elem) = 'string' AND (elem#>>'{}') ~ '^[0-9]+$')))
                    ELSE NULL
                END as genres,
                CASE WHEN mi.year IS NOT NULL AND mi.year BETWEEN 1 AND 9999
                    THEN make_date(mi.year, 1, 1)
                    ELSE NULL
                END as release_date,
                (pm.metadata->>'vote_count')::integer as vote_count,
                (pm.metadata->>'popularity')::float as popularity,
                (pm.metadata->>'runtime_minutes')::integer as runtime_minutes,
                CASE WHEN pm.metadata->'actors' IS NOT NULL AND jsonb_typeof(pm.metadata->'actors') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'actors') AS elem)
                    ELSE NULL
                END as actors,
                CASE WHEN pm.metadata->'directors' IS NOT NULL AND jsonb_typeof(pm.metadata->'directors') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'directors') AS elem)
                    ELSE NULL
                END as directors,
                (pm.metadata->>'imdb_rating')::float as imdb_rating,
                (pm.metadata->>'popularity')::float as tmdb_rating,
                (pm.metadata->>'rt_rating')::integer as rt_rating,
                (pm.metadata->>'rt_audience_score')::integer as rt_audience_score,
                (pm.metadata->>'mdblist_score')::float as mdblist_score,
                (pm.metadata->>'letterboxd_rating')::float as letterboxd_rating,
                (pm.metadata->>'metacritic_score')::integer as metacritic_score,
                (pm.metadata->>'trakt_score')::float as trakt_score,
                (pm.metadata->>'certification')::text as certification,
                (pm.metadata->>'poster_path')::text as poster_path,
                ${isAvailableExpr(sql)} AS is_available,
                ${canRequestExpr(sql)} AS can_request,
                mi.created_at,
                mi.updated_at,
                -- Ranking: ts_rank with {0,0,0,1} weights scores only weight-A (title) matches
                CASE
                    WHEN mi.search_vector @@ to_tsquery('simple', immutable_unaccent(${tsQuery}))
                    THEN ts_rank('{0,0,0,1}', mi.search_vector, to_tsquery('simple', immutable_unaccent(${tsQuery}))) + ${RANK_TITLE_FTS_BOOST}
                    ELSE ${RANK_ACTOR_DIRECTOR_BASE}
                END
                + ${buildExactPrefixTitleBoost(sql, query, { includeLocalized: true })} as rank
            FROM media_items mi
            ${buildMetadataLateralJoinFragment(sql)}
            WHERE mi.status = 'active'
              AND mi.media_type = ANY(${mediaTypes})
              ${
                  fileBackedOnly
                      ? buildFileBackedVideoItemFilter(sql, true, mediaTypes)
                      : availableOnly
                        ? sql`AND mi.has_files = true`
                        : sql`AND (mi.media_type <> 'episode' OR mi.has_files = true)`
              }
              ${filters.yearMin !== undefined ? sql`AND mi.year >= ${filters.yearMin}` : sql``}
              ${filters.yearMax !== undefined ? sql`AND mi.year <= ${filters.yearMax}` : sql``}
              ${buildGenreMembershipFilter(sql, filters.genres)}
              ${
                  filters.ratingMin !== undefined
                      ? sql`AND GREATEST(
                  COALESCE((pm.metadata->>'imdb_rating')::float, 0),
                  COALESCE((pm.metadata->>'rt_rating')::integer::float / 10.0, 0),
                  COALESCE((pm.metadata->>'mdblist_score')::float / 10.0, 0),
                  COALESCE((pm.metadata->>'letterboxd_rating')::float * 2.0, 0),
                  COALESCE((pm.metadata->>'metacritic_score')::integer::float / 10.0, 0),
                  COALESCE((pm.metadata->>'trakt_score')::float, 0)
              ) >= ${filters.ratingMin}`
                      : sql``
              }
              ${buildLibraryAccessFilter(sql, access.library)}
              ${buildSeriesOwnedAgeRatingFilter(sql, access.age)}
              AND (
                  ${filterOnly} OR
                  -- FTS on stored search_vector (uses GIN index idx_media_items_search)
                  mi.search_vector @@ to_tsquery('simple', immutable_unaccent(${tsQuery}))
                  -- Actor/director match via the trigram-indexed media_people side
                  -- table (hashed subplan), not a per-row JSONB unnest.
                  OR ${peopleMatchFragment(sql, query)}
                  -- Localized/original/alias titles (e.g. German "Große Pause" for "Hafentage")
                  OR ${mediaTitlesMatchFragment(sql, query)}
              )
            ORDER BY
                rank DESC,
                popularity DESC NULLS LAST,
                vote_count DESC NULLS LAST,
                mi.id ASC
            LIMIT ${limit}
            OFFSET ${offset}
        `;

        return results;
    } catch (error) {
        logger.error('Failed to search media', error as Error, { query });
        throw error;
    }
}

/**
 * Full-text search using stored search_vector with GIN index.
 * Searches titles (weight A), overviews (weight B), keywords, actors, and directors.
 * Returns results with match source tracking and snippet extraction.
 *
 * Single-pass query replaces the old 3-CTE structure (base_data full scan → matches → final).
 * search_vector contains: title(A) + english_title(A) + original_title(A) + overview(B).
 * Weight-based ts_rank differentiates title hits from overview hits without separate tsvector calls.
 *
 * Typo tolerance (trigram) is handled separately by searchMediaTrigram.
 *
 * @param sql - Postgres SQL instance
 * @param query - Search query string
 * @param access - Required media access boundary
 * @param options - Search options
 * @returns Array of matching media items with match snippets
 */
export async function searchMediaFulltext(
    sql: postgres.Sql,
    query: string,
    access: MediaAccessBoundary,
    options: FulltextSearchOptions = {},
): Promise<
    Array<
        MediaEmbedding & {
            match_snippet?: string;
            match_source?: 'title' | 'overview' | 'actor' | 'director' | 'keyword';
            rank: number;
            is_available?: boolean;
        }
    >
> {
    const {
        includeDescriptions = true,
        limit = 50,
        offset = 0,
        mediaTypes: requestedMediaTypes = ['movie', 'tv'],
        availableOnly = true,
        filters = {},
    } = options;

    const filterOnly = query.trim() === '*';
    const queryLength = [...query.trim()].length;
    const shortAudiobookQuery =
        isSingleCjkAudiobookQuery(query) && requestedMediaTypes.includes('audiobook');
    if (!filterOnly && queryLength < 2 && !shortAudiobookQuery) return [];
    const tsQuery = buildTsQueryFromText(query, 2, includeDescriptions ? undefined : 'A') ?? '';
    const titleTsQuery = buildTsQueryFromText(query, 2, 'A') ?? '';
    const mediaTypes = shortAudiobookQuery ? ['audiobook'] : requestedMediaTypes;
    const searchesAudiobooks =
        mediaTypes.includes('audiobook') && (queryLength >= 2 || shortAudiobookQuery);
    if (!tsQuery && !filterOnly && !searchesAudiobooks) return [];
    if (deniesEverything(access)) return [];

    // First word for snippet extraction
    const firstWord =
        query
            .trim()
            .split(/\s+/)
            .map(sanitizeForTsquery)
            .filter((w) => w.length >= 2)[0] ?? '';

    // Escaped ILIKE pattern for keyword/actor/director (was `%${query}%` — unescaped).
    const searchPattern = buildLikePattern(query);

    // Substring arms (keywords/actors/directors) are disabled for short
    // queries — a 2-char '%aa%' is semantically noise and degenerates on the
    // trigram indexes (see MIN_SUBSTRING_QUERY_LENGTH). `false` arms are
    // planner-eliminated.
    const substringOk = searchSupportsSubstringMatch(query);
    const kwAnyArm =
        substringOk && includeDescriptions
            ? sql`mi.id IN (SELECT mk.media_id FROM media_keywords mk WHERE immutable_unaccent(mk.keyword) ILIKE immutable_unaccent(${searchPattern}))`
            : sql`false`;
    const kwMdblistArm =
        substringOk && includeDescriptions
            ? sql`mi.id IN (SELECT mk.media_id FROM media_keywords mk WHERE mk.keyword_type = 'mdblist' AND immutable_unaccent(mk.keyword) ILIKE immutable_unaccent(${searchPattern}))`
            : sql`false`;
    const actorArm = substringOk
        ? sql`pm.metadata->'actors' IS NOT NULL AND jsonb_typeof(pm.metadata->'actors') = 'array'
                         AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(pm.metadata->'actors') AS actor WHERE immutable_unaccent(actor) ILIKE immutable_unaccent(${searchPattern}))`
        : sql`false`;
    const directorArm = substringOk
        ? sql`pm.metadata->'directors' IS NOT NULL AND jsonb_typeof(pm.metadata->'directors') = 'array'
                         AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(pm.metadata->'directors') AS director WHERE immutable_unaccent(director) ILIKE immutable_unaccent(${searchPattern}))`
        : sql`false`;

    try {
        const results = await sql<
            Array<
                MediaEmbedding & {
                    match_snippet?: string;
                    match_source?: string;
                    rank: number;
                }
            >
        >`
            SELECT
                0 as id,
                mi.id::text as internal_id,
                COALESCE((SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1), '') as tmdb_id,
                (SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = 'imdb' LIMIT 1) as imdb_id,
                mi.media_type,
                mi.title,
                mi.original_title,
                mi.english_title,
                COALESCE(NULLIF(mi.overview, ''), NULLIF(pm.metadata->>'overview', ''))::text as overview,
                CASE WHEN pm.metadata->'genres' IS NOT NULL AND jsonb_typeof(pm.metadata->'genres') = 'array'
                    THEN ARRAY(SELECT COALESCE((elem->>'id')::integer, (elem#>>'{}')::integer) FROM jsonb_array_elements(pm.metadata->'genres') AS elem WHERE elem IS NOT NULL AND elem != 'null'::jsonb AND (jsonb_typeof(elem) = 'object' OR jsonb_typeof(elem) = 'number' OR (jsonb_typeof(elem) = 'string' AND (elem#>>'{}') ~ '^[0-9]+$')))
                    ELSE NULL
                END as genres,
                CASE WHEN mi.year IS NOT NULL AND mi.year BETWEEN 1 AND 9999
                    THEN make_date(mi.year, 1, 1)
                    ELSE NULL
                END as release_date,
                (pm.metadata->>'vote_count')::integer as vote_count,
                (pm.metadata->>'popularity')::float as popularity,
                (pm.metadata->>'runtime_minutes')::integer as runtime_minutes,
                CASE WHEN pm.metadata->'actors' IS NOT NULL AND jsonb_typeof(pm.metadata->'actors') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'actors') AS elem)
                    ELSE NULL
                END as actors,
                CASE WHEN pm.metadata->'directors' IS NOT NULL AND jsonb_typeof(pm.metadata->'directors') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'directors') AS elem)
                    ELSE NULL
                END as directors,
                (pm.metadata->>'imdb_rating')::float as imdb_rating,
                (pm.metadata->>'popularity')::float as tmdb_rating,
                ${isAvailableExpr(sql)} AS is_available,
                ${canRequestExpr(sql)} AS can_request,
                mi.created_at,
                mi.updated_at,
                -- Match source: title (weight A) vs overview (weight B) vs keyword/actor/director
                CASE
                    -- Every token must match title weight A, not just one token.
                    WHEN mi.search_vector @@ to_tsquery('simple', immutable_unaccent(${titleTsQuery}))
                    THEN 'title'
                    -- Localized/original/alias title match (media_titles side table)
                    WHEN ${mediaTitlesMatchFragment(sql, query)}
                    THEN 'title'
                    -- Description-dependent FTS, including mixed title/overview terms.
                    WHEN mi.search_vector @@ to_tsquery('simple', immutable_unaccent(${tsQuery}))
                    THEN 'overview'
                    -- Keyword match (media_keywords side table, all providers —
                    -- same source keywordMatchFragment filters on)
                    WHEN ${kwAnyArm}
                    THEN 'keyword'
                    -- Actor/director match
                    WHEN ${actorArm}
                    THEN 'actor'
                    WHEN ${directorArm}
                    THEN 'director'
                    ELSE NULL
                END as match_source,
                -- Ranking: weight-based ts_rank differentiates title (A) from overview (B)
                CASE
                    -- Title FTS match (highest)
                    WHEN mi.search_vector @@ to_tsquery('simple', immutable_unaccent(${titleTsQuery}))
                    THEN ts_rank('{0,0,0,1}', mi.search_vector, to_tsquery('simple', immutable_unaccent(${tsQuery}))) + ${RANK_FT_TITLE_FTS_BOOST}
                    -- Localized/original/alias title match (media_titles side table)
                    WHEN ${mediaTitlesMatchFragment(sql, query)}
                    THEN ${RANK_FT_LOCALIZED_TITLE}
                    -- Overview FTS match (medium)
                    WHEN mi.search_vector @@ to_tsquery('simple', immutable_unaccent(${tsQuery}))
                    THEN ts_rank('{0,0,1,0}', mi.search_vector, to_tsquery('simple', immutable_unaccent(${tsQuery}))) + ${RANK_FT_OVERVIEW_FTS_BOOST}
                    -- Keyword matches (media_keywords side table; mdblist
                    -- keywords rank slightly above plain provider keywords)
                    WHEN ${kwMdblistArm}
                    THEN ${RANK_FT_MDBLIST_KEYWORD}
                    WHEN ${kwAnyArm}
                    THEN ${RANK_FT_KEYWORD}
                    -- Actor/director matches (lowest)
                    ELSE ${RANK_FT_ACTOR_DIRECTOR_BASE}
                END
                + ${buildExactPrefixTitleBoost(sql, query, { includeLocalized: true })} as rank,
                -- Overview snippet for overview matches
                CASE
                    WHEN mi.search_vector @@ to_tsquery('simple', immutable_unaccent(${tsQuery}))
                         AND ts_rank('{0,0,0,1}', mi.search_vector, to_tsquery('simple', immutable_unaccent(${tsQuery}))) = 0
                         AND COALESCE(NULLIF(mi.overview, ''), NULLIF(pm.metadata->>'overview', '')) IS NOT NULL
                    THEN (
                        SELECT
                            CASE WHEN pos > 0 THEN
                                '...' || SUBSTRING(COALESCE(NULLIF(mi.overview, ''), NULLIF(pm.metadata->>'overview', '')) FROM GREATEST(1, pos - 40) FOR 120) || '...'
                                ELSE NULL
                            END
                        FROM (SELECT POSITION(LOWER(${firstWord}) IN LOWER(COALESCE(NULLIF(mi.overview, ''), NULLIF(pm.metadata->>'overview', '')))) as pos) subq
                    )
                    ELSE NULL
                END as match_snippet
            FROM media_items mi
            ${buildMetadataLateralJoinFragment(sql)}
            WHERE mi.status = 'active'
              AND mi.media_type = ANY(${mediaTypes})
              AND (mi.media_type <> 'audiobook' OR (mi.has_files AND NOT mi.is_dismissed))
              ${availableOnly ? sql`AND mi.has_files = true` : sql`AND (mi.media_type <> 'episode' OR mi.has_files = true)`}
              ${filters.yearMin !== undefined ? sql`AND mi.year >= ${filters.yearMin}` : sql``}
              ${filters.yearMax !== undefined ? sql`AND mi.year <= ${filters.yearMax}` : sql``}
              ${buildGenreMembershipFilter(sql, filters.genres)}
              ${
                  filters.ratingMin !== undefined
                      ? sql`AND GREATEST(
                  COALESCE((pm.metadata->>'imdb_rating')::float, 0),
                  COALESCE((pm.metadata->>'rt_rating')::integer::float / 10.0, 0),
                  COALESCE((pm.metadata->>'mdblist_score')::float / 10.0, 0),
                  COALESCE((pm.metadata->>'letterboxd_rating')::float * 2.0, 0),
                  COALESCE((pm.metadata->>'metacritic_score')::integer::float / 10.0, 0),
                  COALESCE((pm.metadata->>'trakt_score')::float, 0)
              ) >= ${filters.ratingMin}`
                      : sql``
              }
              ${buildLibraryAccessFilter(sql, access.library)}
              ${buildSeriesOwnedAgeRatingFilter(sql, access.age)}
              AND (
                  ${filterOnly} OR
                  ${ftsMatchFragment(sql, tsQuery)}
                  OR ${includeDescriptions ? keywordMatchFragment(sql, searchPattern) : sql`false`}
                  OR ${peopleMatchFragment(sql, query)}
                  OR ${mediaTitlesMatchFragment(sql, query)}
                  OR ${searchesAudiobooks ? sql`(mi.media_type = 'audiobook' AND ${audiobookSearchMatch(sql, query)})` : sql`false`}
              )
            ORDER BY
                rank DESC,
                popularity DESC NULLS LAST,
                vote_count DESC NULLS LAST,
                mi.id ASC
            LIMIT ${limit}
            OFFSET ${offset}
        `;

        return results.map((r) => ({
            ...r,
            match_source: r.match_source as
                'title' | 'overview' | 'actor' | 'director' | 'keyword' | undefined,
        }));
    } catch (error) {
        logger.error('Failed to fulltext search media', error as Error, {
            query,
        });
        throw error;
    }
}

/**
 * Search for a specific episode by series name, season, and episode number.
 * Uses fuzzy matching on series name to handle typos and variations.
 * Uses UUID-based tables directly instead of media_catalog view.
 *
 * @param sql - Postgres SQL instance
 * @param seriesName - Series name to search for
 * @param season - Season number
 * @param episode - Episode number
 * @param access - Required media access boundary
 * @param options.availableOnly - Drop episodes without a file (`has_files = false`)
 * @returns Array of matching episodes
 */
export async function searchEpisode(
    sql: postgres.Sql,
    seriesName: string,
    season: number,
    episode: number,
    access: MediaAccessBoundary,
    options: { availableOnly?: boolean } = {},
): Promise<EpisodeByNumberResult[]> {
    const { availableOnly = false } = options;
    if (deniesEverything(access)) return [];
    // Create search patterns for the series name
    const searchPattern = `%${seriesName}%`;

    try {
        const results = await runWithTrigramThreshold(sql, true, (db) => {
            // Age filter against the series row (aliased `series`) — a series'
            // age rating governs its episodes, so that axis stays at the series
            // level.
            //
            // The LIBRARY axis does not: this query RETURNS episode rows, and
            // the episode is the leaf that actually carries a
            // `media_files.library_group_id`. The predicate used to be inlined
            // here correlated to `series.id`, and no `tv` row owns
            // `media_file_items` (0 of 6,570 on production, 2026-09-15), so its
            // `NOT EXISTS (own files)` arm was ALWAYS true and the library axis
            // was a no-op — a restricted user got episodes of a series every
            // one of whose files is in a group they may not access. The shared
            // builder now takes an alias, so `ep` is filtered by the leaf rule
            // (including the deliberate fail-open for a file-less,
            // Jellyfin-only episode) with no second copy of the predicate.
            const seriesAgeFilter = buildAgeRatingFilter(db, access.age, 'series');
            const episodeLibraryFilter = buildLibraryAccessFilter(db, access.library, 'ep');

            return db<EpisodeByNumberResult[]>`
            SELECT
                ep.id::text,
                series.id::text as series_internal_id,
                series_meta.external_id as series_ext_id,
                series_meta.provider as series_ext_provider,
                ep.season_number,
                ep.episode_number,
                ep.title,
                ep.overview,
                series.title as series_name,
                series.year as series_year,
                (pm.metadata->>'imdb_rating')::float as series_imdb_rating,
                (pm.metadata->>'popularity')::float as series_tmdb_rating,
                ep.has_files as is_available
            FROM media_items ep
            JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
            JOIN media_items series ON series.id = season.parent_id AND series.media_type = 'tv' AND series.status = 'active'
            ${buildMetadataLateralJoinFragment(db, undefined, 'series.id')}
            LEFT JOIN LATERAL (
                SELECT external_id, provider
                FROM external_ids
                WHERE media_id = series.id
                  AND provider IN ('tmdb', 'tvdb', 'imdb', 'trakt')
                ORDER BY CASE provider
                    WHEN ${getPrimaryExternalIdProvider()} THEN 1
                    WHEN 'tmdb' THEN 2
                    WHEN 'tvdb' THEN 3
                    WHEN 'imdb' THEN 4
                    ELSE 5
                END
                LIMIT 1
            ) series_meta ON true
            WHERE ep.media_type = 'episode'
              AND ep.season_number = ${season}
              AND ep.episode_number = ${episode}
              AND (
                  -- Fuzzy match on series title, under both the accent fold and
                  -- the German digraph fold ("Ueber" matches "Über").
                  -- ILIKE (substring) + trigram percent op (fuzzy; threshold is
                  -- config.SEARCH_TRIGRAM_THRESHOLD via runWithTrigramThreshold,
                  -- not the bare pg_trgm session default). Both GIN-indexable on
                  -- the expression trigram indexes (incl. the TV-scoped partials
                  -- from 16.80.0); the old similarity(...) >= function form was not.
                  immutable_unaccent(series.title) ILIKE immutable_unaccent(${searchPattern})
                  OR immutable_unaccent(series.original_title) ILIKE immutable_unaccent(${searchPattern})
                  OR german_digraph_fold(series.title) ILIKE german_digraph_fold(${searchPattern})
                  OR german_digraph_fold(series.original_title) ILIKE german_digraph_fold(${searchPattern})
                  OR immutable_unaccent(series.title) % immutable_unaccent(${seriesName})
                  OR immutable_unaccent(series.original_title) % immutable_unaccent(${seriesName})
                  OR german_digraph_fold(series.title) % german_digraph_fold(${seriesName})
                  OR german_digraph_fold(series.original_title) % german_digraph_fold(${seriesName})
              )
              ${availableOnly ? db`AND ep.has_files = true` : db``}
              ${episodeLibraryFilter}
              ${seriesAgeFilter}
            ORDER BY
                -- Prefer exact matches, then similarity
                CASE
                    WHEN immutable_unaccent(series.title) ILIKE immutable_unaccent(${searchPattern}) THEN 2
                    WHEN immutable_unaccent(series.original_title) ILIKE immutable_unaccent(${searchPattern}) THEN 1.8
                    ELSE similarity(immutable_unaccent(COALESCE(series.title, '')), immutable_unaccent(${seriesName}))
                END DESC,
                (pm.metadata->>'popularity')::float DESC NULLS LAST
            LIMIT 10
        `;
        });

        return results;
    } catch (error) {
        logger.error('Failed to search episode', error as Error, {
            seriesName,
            season,
            episode,
        });
        return [];
    }
}

/**
 * Find series by name and get available seasons.
 * Used to provide context when an episode search returns no results.
 * Uses UUID-based tables directly instead of media_catalog view.
 *
 * @param sql - Postgres SQL instance
 * @param seriesName - Series name to search for
 * @param access - Required media access boundary
 * @returns Series context with metadata
 */
export async function findSeriesContext(
    sql: postgres.Sql,
    seriesName: string,
    access: MediaAccessBoundary,
): Promise<SeriesSearchContext> {
    const searchPattern = `%${seriesName}%`;
    if (deniesEverything(access)) return { found: false };

    try {
        // Find the series using UUID tables
        const seriesResults = await runWithTrigramThreshold(sql, true, (db) => {
            // Was `deniedGroupIds ?? []` — a coercion that only happened to be a
            // no-op because the builder treated null and [] identically. The
            // scope is now passed through unchanged.
            const dbLibraryFilter = buildLibraryAccessFilter(db, access.library);
            const dbAgeFilter = buildAgeRatingFilter(db, access.age);
            return db<
                Array<{
                    internal_id: string;
                    tmdb_id: string | null;
                    title: string;
                }>
            >`
            SELECT
                mi.id::text as internal_id,
                primary_ext.external_id as tmdb_id,
                mi.title
            FROM media_items mi
            LEFT JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
            ${buildMetadataLateralJoinFragment(db)}
            WHERE mi.media_type = 'tv'
              AND mi.status = 'active'
              AND mi.has_files
              AND (
                  -- ILIKE (substring) + trigram percent op (fuzzy; threshold is
                  -- config.SEARCH_TRIGRAM_THRESHOLD via runWithTrigramThreshold,
                  -- not the bare pg_trgm session default). Both are GIN-indexable
                  -- on the expression trigram indexes (incl. the TV-scoped
                  -- partials from 16.80.0); the old similarity(...) >= function
                  -- form was not, so the OR fell back to a full active-tv heap scan.
                  immutable_unaccent(mi.title) ILIKE immutable_unaccent(${searchPattern})
                  OR immutable_unaccent(mi.original_title) ILIKE immutable_unaccent(${searchPattern})
                  OR german_digraph_fold(mi.title) ILIKE german_digraph_fold(${searchPattern})
                  OR german_digraph_fold(mi.original_title) ILIKE german_digraph_fold(${searchPattern})
                  OR immutable_unaccent(mi.title) % immutable_unaccent(${seriesName})
                  OR immutable_unaccent(mi.original_title) % immutable_unaccent(${seriesName})
                  OR german_digraph_fold(mi.title) % german_digraph_fold(${seriesName})
                  OR german_digraph_fold(mi.original_title) % german_digraph_fold(${seriesName})
              )
              ${dbLibraryFilter}
              ${dbAgeFilter}
            ORDER BY
                CASE
                    WHEN immutable_unaccent(mi.title) ILIKE immutable_unaccent(${searchPattern}) THEN 2
                    WHEN immutable_unaccent(mi.original_title) ILIKE immutable_unaccent(${searchPattern}) THEN 1.8
                    ELSE similarity(immutable_unaccent(COALESCE(mi.title, '')), immutable_unaccent(${seriesName}))
                END DESC,
                (pm.metadata->>'popularity')::float DESC NULLS LAST
            LIMIT 1
        `;
        });

        if (seriesResults.length === 0) {
            return { found: false };
        }

        const series = seriesResults[0];

        // Get available seasons for this series — walk the hierarchy by the
        // series' internal UUID (UUID-first; no Jellyfin id lookup).
        const seasonResults = await sql<Array<{ season_number: number }>>`
            SELECT DISTINCT ep.season_number
            FROM media_items ep
            JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
            WHERE season.parent_id = ${series.internal_id}::uuid
              AND ep.media_type = 'episode'
            ORDER BY ep.season_number
        `;

        return {
            found: true,
            internal_id: series.internal_id,
            tmdb_id: series.tmdb_id ?? undefined,
            title: series.title,
            available_seasons: seasonResults.map((r) => r.season_number),
        };
    } catch (error) {
        logger.error('Failed to find series context', error as Error, {
            seriesName,
        });
        return { found: false };
    }
}

/**
 * Batch-count seasons for a set of series, keyed by the series' internal UUID.
 *
 * UUID-first: matches on `season.parent_id` (the series media_items UUID) rather
 * than joining Jellyfin external_ids. Non-UUID ids (e.g. discovery composite keys
 * like `tmdb:550:tv`, which have no local seasons) are filtered out so the
 * `::uuid[]` cast stays safe. Returns a Map of series UUID → season count;
 * series with zero local seasons are simply absent from the map.
 */
export async function getSeasonCountsBySeriesIds(
    sql: postgres.Sql,
    seriesIds: string[],
): Promise<Map<string, number>> {
    const ids = [...new Set(seriesIds.filter((id) => UUID_RE.test(id)))];
    const counts = new Map<string, number>();
    if (ids.length === 0) return counts;

    const rows = await sql<{ series_internal_id: string; season_count: number }[]>`
        SELECT
            season.parent_id::text as series_internal_id,
            COUNT(*)::int as season_count
        FROM media_items season
        WHERE season.media_type = 'season'
          AND season.parent_id = ANY(${ids}::uuid[])
        GROUP BY season.parent_id
    `;
    for (const row of rows) {
        counts.set(row.series_internal_id, row.season_count);
    }
    return counts;
}
