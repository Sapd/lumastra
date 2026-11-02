// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Jellyfin (`/j`) browse query module.
 *
 * ## Access boundary
 *
 * Every exported query that filters on media access takes a REQUIRED
 * {@link MediaAccessBoundary}. There are no permissive defaults: a caller that
 * genuinely wants unrestricted rows must say so with `unrestrictedAccess()`,
 * which makes the decision greppable. `denyAll` on either axis makes the
 * builders emit `AND false`, so those queries return no rows.
 *
 * The `denyAll` case is deliberately NOT short-circuited in the functions that
 * return a `postgres.RowList` — there is no honest way to fabricate one, and
 * `AND false` keeps a single code path. `getDistinctGenresForLibrary` returns a
 * plain array and does short-circuit.
 *
 * ## Alias coupling (unchanged, but load-bearing)
 *
 * `buildLibraryAccessFilter` hardcodes the `mi` alias and takes no alias
 * parameter; `buildAgeRatingFilter` / `buildSeriesOwnedAgeRatingFilter`
 * default to `mi`. Every query below aliases
 * `media_items` as exactly `mi` at the scope where the filter is spliced in. If
 * a filter is ever moved into a scope with a different alias, library access
 * silently targets the wrong table.
 *
 * ## Age policy belongs to the series
 *
 * Seasons and episodes have no populated `age_rating`; a query whose `mi` rows
 * can be seasons or episodes uses `buildSeriesOwnedAgeRatingFilter`, which
 * judges them by their series (as `series-episode-counts.queries.ts` does for
 * the folder counts). Using the plain filter there hides every episode from a
 * profile without unrated access while the series card still counts them.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { deriveSortTitle } from '../../utils/sort-title.js';
import { MAX_FILTER_LIST, capDistinct } from '../../utils/filter-list.js';
import { buildMetadataLateralJoinFragment } from './builders/provider-metadata.builder';
import { buildLibraryAccessFilter } from './builders/library-access.builder';
import {
    buildAgeRatingFilter,
    buildSeriesOwnedAgeRatingFilter,
    seriesOwnedAgeRatingExpression,
} from './builders/age-rating.builder';
import { buildNextUpCandidateCtes } from './builders/next-up-candidates.builder.js';
import {
    buildMovedOnGateCtes,
    buildMovedOnKeepPredicate,
} from './builders/moved-on-gate.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { buildFileBackedVideoItemFilter } from './builders/file-backed-media.builder.js';
import { watchlistExistsFragment } from './builders/watchlist-exists.builder.js';
import { lastPlayedAtExpression } from './builders/last-played.builder.js';
import {
    personFilterFragment,
    studioFilterFragment,
    type CreditRole,
} from './jellyfin-people.queries.js';
import {
    buildAutoEpisodeOrderingJoinFragment,
    buildUnmappedEpisodeFilterFragment,
} from './episode-search.queries.js';

const JELLYFIN_TYPE_MAP: Record<string, string> = {
    Movie: 'movie',
    Series: 'tv',
    Episode: 'episode',
    Season: 'season',
    Audio: 'track',
    MusicAlbum: 'album',
    MusicArtist: 'artist',
};

export function mapJellyfinTypes(includeItemTypes: string): string[] {
    return includeItemTypes
        .split(',')
        .map((t) => t.trim())
        .map((t) => JELLYFIN_TYPE_MAP[t] ?? t.toLowerCase())
        .filter(Boolean);
}

/**
 * Jellyfin `ItemSortBy` keys the browse query can order by. Anything else a
 * client sends is skipped (never collapses the whole sort to name-asc).
 */
export const JELLYFIN_SORT_KEYS = [
    'SortName',
    'Name',
    'DateCreated',
    'PremiereDate',
    'ProductionYear',
    'CommunityRating',
    'CriticRating',
    'OfficialRating',
    'Runtime',
    'DatePlayed',
    'PlayCount',
    'Random',
    'SeriesSortName',
    'IndexNumber',
    'ParentIndexNumber',
    'AirTime',
    'StartDate',
    'IsFolder',
    'IsFavoriteOrLiked',
    'IsPlayed',
    'IsUnplayed',
] as const;
export type JellyfinSortKey = (typeof JELLYFIN_SORT_KEYS)[number];

export interface JellyfinSortSpec {
    key: JellyfinSortKey;
    descending: boolean;
}

const SORT_KEY_LOOKUP = new Map<string, JellyfinSortKey>(
    JELLYFIN_SORT_KEYS.map((k) => [k.toLowerCase(), k]),
);

function splitCsv(value: string | null | undefined): string[] {
    return (value ?? '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
}

/**
 * Parse Jellyfin's `SortBy` / `SortOrder` comma lists the way
 * `RequestHelpers.GetOrderBy` does: the i-th order applies to the i-th key,
 * keys beyond the order list take the FIRST order (or Ascending when none was
 * sent). Pairing happens before unknown keys are dropped, so
 * `SortBy=Unknown,DateCreated&SortOrder=Ascending,Descending` keeps
 * DateCreated descending. Keys and orders are matched case-insensitively.
 */
export function parseJellyfinSort(
    sortBy: string | null | undefined,
    sortOrder: string | null | undefined,
): JellyfinSortSpec[] {
    const keys = splitCsv(sortBy);
    const orders = splitCsv(sortOrder).map((o) => o.toLowerCase() === 'descending');
    const fallback = orders[0] ?? false;
    const specs: JellyfinSortSpec[] = [];
    keys.forEach((raw, i) => {
        const key = SORT_KEY_LOOKUP.get(raw.toLowerCase());
        if (!key) return;
        if (specs.some((s) => s.key === key)) return;
        specs.push({ key, descending: orders[i] ?? fallback });
    });
    return specs;
}

/** Item kinds Jellyfin treats as folders (`IsFolder`). */
const FOLDER_MEDIA_TYPES = ['tv', 'season', 'album', 'artist'];

/**
 * Jellyfin's SortName for the row: episodes sort as `SSS - EEEE - name` and
 * seasons as `NNNN` (Episode/Season.CreateSortName), everything else on the
 * normalized sort key (Hangul romanized, diacritics folded) under COLLATE "C"
 * so non-Latin titles aren't dumped after "Z". Needs the `eo` ordering join.
 */
function sortNameExpression(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`(CASE
            WHEN mi.media_type = 'episode' THEN
                lpad(COALESCE(eo.order_season_number, mi.season_number, 0)::text, 3, '0') || ' - ' ||
                lpad(COALESCE(eo.order_episode_number, mi.episode_number, 0)::text, 4, '0') || ' - ' ||
                LOWER(mi.title)
            WHEN mi.media_type = 'season' THEN lpad(COALESCE(mi.season_number, 0)::text, 4, '0')
            ELSE COALESCE(NULLIF(mi.sort_title, ''), LOWER(mi.title))
        END) COLLATE "C"`;
}

/**
 * Folder-aware "played" predicate, Jellyfin's BuildIsPlayedFilter: a leaf is
 * played when the user's state says so; a series / season / album / artist is
 * played once no file-backed descendant is left unplayed.
 */
function playedPredicate(
    sql: postgres.Sql,
    userId: UserId | undefined,
): postgres.PendingQuery<postgres.Row[]> {
    const uid = sql`${userId ?? null}::uuid`;
    return sql`(
        (mi.media_type = 'tv' AND NOT EXISTS (
            SELECT 1 FROM media_items _s
            JOIN media_items _e ON _e.parent_id = _s.id
            WHERE _s.parent_id = mi.id AND _s.media_type = 'season'
              AND _e.media_type = 'episode' AND _e.status = 'active' AND _e.has_files = true
              AND NOT EXISTS (SELECT 1 FROM user_media_state _u
                              WHERE _u.media_id = _e.id AND _u.user_id = ${uid} AND _u.is_watched)
        ))
        OR (mi.media_type IN ('season', 'album') AND NOT EXISTS (
            SELECT 1 FROM media_items _e
            WHERE _e.parent_id = mi.id AND _e.media_type IN ('episode', 'track')
              AND _e.status = 'active' AND _e.has_files = true
              AND NOT EXISTS (SELECT 1 FROM user_media_state _u
                              WHERE _u.media_id = _e.id AND _u.user_id = ${uid} AND _u.is_watched)
        ))
        OR (mi.media_type = 'artist' AND NOT EXISTS (
            SELECT 1 FROM media_items _a
            JOIN media_items _e ON _e.parent_id = _a.id
            WHERE _a.parent_id = mi.id AND _e.media_type = 'track'
              AND _e.status = 'active' AND _e.has_files = true
              AND NOT EXISTS (SELECT 1 FROM user_media_state _u
                              WHERE _u.media_id = _e.id AND _u.user_id = ${uid} AND _u.is_watched)
        ))
        OR (mi.media_type NOT IN ('tv', 'season', 'album', 'artist') AND EXISTS (
            SELECT 1 FROM user_media_state _u
            WHERE _u.media_id = mi.id AND _u.user_id = ${uid} AND _u.is_watched
        ))
    )`;
}

/**
 * Jellyfin's IsResumable: a leaf with a saved position it has not finished; a
 * series or season with a descendant in progress, or with both watched and
 * unwatched file-backed episodes (partly watched).
 */
function resumablePredicate(
    sql: postgres.Sql,
    userId: UserId | undefined,
): postgres.PendingQuery<postgres.Row[]> {
    const uid = sql`${userId ?? null}::uuid`;
    const liveEpisode = sql`_e.media_type = 'episode' AND _e.status = 'active' AND _e.has_files = true`;
    // Split per kind (like playedPredicate) so every probe is a plain join
    // down idx_media_items_parent_id and then a user_media_state primary-key
    // lookup by (user_id, media_id) — an OR over "child or grandchild" made
    // the planner scan instead (review G1 #2).
    const folder = (
        from: postgres.PendingQuery<postgres.Row[]>,
        under: postgres.PendingQuery<postgres.Row[]>,
    ) => sql`(
        EXISTS (
            SELECT 1 FROM ${from}
            JOIN user_media_state _u ON _u.user_id = ${uid} AND _u.media_id = _e.id
            WHERE ${under} AND ${liveEpisode}
              AND _u.resume_position_ms > 0 AND NOT _u.is_watched
        )
        OR (
            EXISTS (
                SELECT 1 FROM ${from}
                JOIN user_media_state _u ON _u.user_id = ${uid} AND _u.media_id = _e.id
                WHERE ${under} AND ${liveEpisode} AND _u.is_watched
            )
            AND EXISTS (
                SELECT 1 FROM ${from}
                LEFT JOIN user_media_state _u ON _u.user_id = ${uid} AND _u.media_id = _e.id
                WHERE ${under} AND ${liveEpisode} AND NOT COALESCE(_u.is_watched, false)
            )
        )
    )`;
    const seriesFrom = sql`media_items _s JOIN media_items _e ON _e.parent_id = _s.id`;
    const seriesUnder = sql`_s.parent_id = mi.id AND _s.media_type = 'season'`;
    const seasonFrom = sql`media_items _e`;
    const seasonUnder = sql`_e.parent_id = mi.id`;
    return sql`(
        (mi.media_type = 'tv' AND ${folder(seriesFrom, seriesUnder)})
        OR (mi.media_type = 'season' AND ${folder(seasonFrom, seasonUnder)})
        OR (mi.media_type NOT IN ('tv', 'season') AND EXISTS (
            SELECT 1 FROM user_media_state _u
            WHERE _u.user_id = ${uid} AND _u.media_id = mi.id
              AND _u.resume_position_ms > 0 AND NOT _u.is_watched
        ))
    )`;
}

/**
 * ORDER BY expression for one Jellyfin sort key (OrderMapper.MapOrderByField).
 * A closed whitelist: every branch is a fixed SQL fragment, client input only
 * ever selects WHICH fragment, so no `sql.unsafe` is needed.
 */
function sortKeyExpression(
    sql: postgres.Sql,
    key: JellyfinSortKey,
    userId: UserId | undefined,
): postgres.PendingQuery<postgres.Row[]> {
    const uid = sql`${userId ?? null}::uuid`;
    switch (key) {
        case 'SortName':
        case 'AirTime':
            return sortNameExpression(sql);
        case 'Name':
            return sql`LOWER(mi.title) COLLATE "C"`;
        case 'DateCreated':
            return sql`mi.created_at`;
        case 'PremiereDate':
            // Jellyfin falls back to Jan 1 of the production year.
            return sql`COALESCE(mi.premiere_date, CASE WHEN mi.year BETWEEN 1 AND 9999 THEN make_date(mi.year, 1, 1) END)`;
        case 'StartDate':
            return sql`mi.premiere_date`;
        case 'ProductionYear':
            return sql`mi.year`;
        case 'CommunityRating':
            return sql`(pm.metadata->>'vote_average')::float`;
        case 'CriticRating':
            // Guarded like media-rail-metadata: one non-numeric value must not
            // fail the whole listing.
            return sql`(CASE WHEN pm.metadata->>'rt_rating' ~ '^[0-9]+(\\.[0-9]+)?$'
                             THEN (pm.metadata->>'rt_rating')::float END)`;
        case 'OfficialRating':
            return sql`mi.age_rating`;
        case 'Runtime':
            return sql`COALESCE(mi.runtime_seconds, (tmdb_pm.metadata->>'runtime')::int * 60, file_dur.duration_seconds)`;
        case 'DatePlayed':
            return sql`(SELECT _u.last_watched_at FROM user_media_state _u WHERE _u.media_id = mi.id AND _u.user_id = ${uid})`;
        case 'PlayCount':
            return sql`(SELECT _u.watch_count FROM user_media_state _u WHERE _u.media_id = mi.id AND _u.user_id = ${uid})`;
        case 'Random':
            return sql`RANDOM()`;
        case 'SeriesSortName':
            return sql`COALESCE(
                NULLIF(parent_series.sort_title, ''), LOWER(parent_series.title),
                CASE WHEN mi.media_type = 'tv' THEN COALESCE(NULLIF(mi.sort_title, ''), LOWER(mi.title)) END
            ) COLLATE "C"`;
        case 'IndexNumber':
            return sql`(CASE WHEN mi.media_type = 'season' THEN mi.season_number
                             ELSE COALESCE(eo.order_episode_number, mi.episode_number) END)`;
        case 'ParentIndexNumber':
            return sql`(CASE WHEN mi.media_type = 'episode'
                             THEN COALESCE(eo.order_season_number, mi.season_number) END)`;
        case 'IsFolder':
            return sql`(mi.media_type = ANY(${FOLDER_MEDIA_TYPES}::text[]))`;
        case 'IsFavoriteOrLiked':
            return watchlistExistsFragment(sql, sql`mi.id`, uid);
        case 'IsPlayed':
            return playedPredicate(sql, userId);
        case 'IsUnplayed':
            return sql`(NOT ${playedPredicate(sql, userId)})`;
    }
}

/**
 * `ORDER BY …` for the browse query. Direction follows SQLite (Jellyfin's
 * store): NULLs first ascending, last descending. SortName is appended as the
 * tiebreak unless a name key is already present, then `mi.id` so paging is
 * deterministic. No keys = SortName ascending.
 */
export function buildBrowseOrderBy(
    sql: postgres.Sql,
    specs: readonly JellyfinSortSpec[],
    userId: UserId | undefined,
): postgres.PendingQuery<postgres.Row[]> {
    const parts: postgres.PendingQuery<postgres.Row[]>[] = specs.map((s) =>
        s.descending
            ? sql`${sortKeyExpression(sql, s.key, userId)} DESC NULLS LAST`
            : sql`${sortKeyExpression(sql, s.key, userId)} ASC NULLS FIRST`,
    );
    if (!specs.some((s) => s.key === 'SortName' || s.key === 'Name' || s.key === 'AirTime')) {
        parts.push(sql`${sortNameExpression(sql)} ASC`);
    }
    parts.push(sql`mi.id ASC`);
    return parts.reduce((acc, part) => sql`${acc}, ${part}`);
}

function buildFileBackedEpisodeFilter(sql: postgres.Sql) {
    return sql`
        AND mi.has_files = true
        AND EXISTS (
            SELECT 1
            FROM media_file_items mfi
            WHERE mfi.media_item_id = mi.id
        )
    `;
}

export interface BrowseItemsOptions {
    mediaTypes: string[];
    parentId: string | null;
    searchTerm: string | null;
    genres: string[];
    years: number[];
    nameStartsWith: string | null;
    isFavoriteFilter: boolean;
    isPlayedFilter: boolean;
    isUnplayedFilter: boolean;
    enableUserData: boolean;
    userId: UserId | undefined;
    idList: string[];
    sortBy: string;
    sortOrder: string;
    limit: number;
    startIndex: number;
    /** Required media access boundary — no permissive default. */
    access: MediaAccessBoundary;
    /**
     * Season/episode order instead of `sortBy` — applied only when `parentId`
     * is a season or series (a library ParentId keeps `sortBy`, whose rows
     * have no season/episode numbers to order by).
     */
    forceEpisodeOrder?: boolean;
    /** Filter by artist/parent UUIDs (Jellyfin artistIds param). For albums: parent_id must be in this list. */
    artistIds?: string[];
    /**
     * Jellyfin `isFavorite` / `Filters=IsFavorite|IsFavoriteOrLikes`:
     * true = only the user's favourites, false = none of them. Wins over the
     * legacy `isFavoriteFilter` flag.
     */
    isFavorite?: boolean | null;
    /**
     * Jellyfin `isPlayed` / `Filters=IsPlayed|IsUnplayed`, folder-aware (a
     * series is played once no file-backed episode is left unplayed). Wins
     * over the legacy `isPlayedFilter` / `isUnplayedFilter` flags, which it
     * also replaces: those only ever looked at the row's own state.
     */
    isPlayed?: boolean | null;
    /** Jellyfin `Filters=IsResumable`: in progress (series/season: a descendant is, or partly watched). */
    isResumable?: boolean;
    /** Jellyfin `Filters=IsFolder` (true) / `IsNotFolder` (false). */
    isFolder?: boolean | null;
    /**
     * DB media types Jellyfin `MediaTypes` maps to (Video → movie/episode,
     * Audio → track). `undefined` = no filter; an empty list matches nothing
     * (the client asked only for media types Lumastra has none of).
     */
    playableMediaTypes?: string[];
    /** Jellyfin `ExcludeItemTypes`, mapped to DB media types. */
    excludeMediaTypes?: string[];
    /** Jellyfin `GenreIds`: the 32-hex ids `/j` emits in `GenreItems` (md5 of the lower-cased name). */
    genreIds?: string[];
    /**
     * Jellyfin `Recursive=true`: under an item ParentId (series, season,
     * artist) match descendants two levels down too, so
     * `ParentId=<series>&Recursive=true&IncludeItemTypes=Episode` (or
     * `Filters=IsNotFolder`) is every episode of the series — play-all /
     * shuffle. Library-group ParentIds are already recursive by membership.
     */
    recursive?: boolean;
    /**
     * Keep `idList` order (search relevance) instead of `sortBy`: Jellyfin
     * orders SearchTerm results by score and ignores SortBy.
     */
    orderByIdList?: boolean;
    /**
     * Jellyfin `PersonIds` / `Person` as person_key() ids (jellyfin-people.queries.ts):
     * titles crediting any of them. An empty list matches nothing (every id
     * the client named was malformed or unknown); undefined = no filter.
     */
    personIds?: string[];
    /** Jellyfin `PersonTypes` as credit roles, narrowing `personIds`. */
    personRoles?: CreditRole[];
    /** Jellyfin `StudioIds` / `Studios` as studio_key() ids; empty matches nothing. */
    studioIds?: string[];
    /** Jellyfin `ExcludeItemIds` (UUIDs; the caller drops malformed ones). */
    excludeIds?: string[];
    /**
     * `EnableTotalRecordCount=false`: no `COUNT(*) OVER()` and no fallback count
     * query; `totalCount` is then just the number of rows returned.
     */
    skipCount?: boolean;
    /** Jellyfin `NameLessThan`: sort key (as normalized for SortName) sorts before this. */
    nameLessThan?: string | null;
    /** Jellyfin `NameStartsWithOrGreater`: sort name sorts at or after this. */
    nameStartsWithOrGreater?: string | null;
    /** Jellyfin `OfficialRatings`: the item's own certification is one of these. */
    officialRatings?: string[];
    /** Jellyfin `Tags`: the item carries one of these (TMDB keywords, case-insensitive). */
    tags?: string[];
    /**
     * Jellyfin `AudioLanguages` / `SubtitleLanguages`: a stream (subtitles: or
     * a sidecar file) in one of these lower-cased codes, on the item or, for a
     * series / season / album, on one of its children. `und` also matches
     * streams without a language.
     */
    audioLanguages?: string[];
    subtitleLanguages?: string[];
    /** Jellyfin `ImageTypes`: the item has an image of one of these types. */
    imageTypes?: string[];
    /** Jellyfin `AlbumIds`: tracks of these albums. */
    albumIds?: string[];
    /** Jellyfin `AlbumArtistIds`: albums of these artists and their tracks. */
    albumArtistIds?: string[];
    /**
     * Jellyfin `HasParentalRating=false` without `MaxOfficialRating`: only
     * unrated items. (`true` filters nothing in Jellyfin; neither does it here.)
     */
    unratedOnly?: boolean;
    /**
     * Jellyfin `MaxOfficialRating` as an age: rated items above it are left
     * out, unrated items pass (blocking those is the profile's job).
     */
    maxAge?: number | null;
}

type Fragment = postgres.PendingQuery<postgres.Row[]>;

/** Jellyfin ImageType values; `ImageTypes` builds one EXISTS per value, so only these count. */
const KNOWN_IMAGE_TYPES = [
    'primary',
    'art',
    'backdrop',
    'banner',
    'logo',
    'thumb',
    'disc',
    'box',
    'screenshot',
    'menu',
    'chapter',
    'boxrear',
    'profile',
] as const;

/** `ImageTypes` reduced to distinct, known (lower-case) types. */
export function normalizeImageTypes(types: readonly string[]): string[] {
    const wanted = new Set(types.map((t) => t.trim().toLowerCase()));
    return KNOWN_IMAGE_TYPES.filter((t) => wanted.has(t));
}

/** `mi` or a child / grandchild of it (series → episodes, album → tracks). */
function selfOrDescendantFragment(
    sql: postgres.Sql,
    match: (alias: string) => Fragment,
    withDescendants: boolean,
): Fragment {
    if (!withDescendants) return sql`(${match('mi')})`;
    return sql`(
        ${match('mi')}
        OR (mi.media_type IN ('tv', 'season', 'album') AND EXISTS (
            SELECT 1 FROM media_items _d
            WHERE _d.status = 'active'
              AND (_d.parent_id = mi.id
                   OR _d.parent_id IN (SELECT _s.id FROM media_items _s WHERE _s.parent_id = mi.id))
              AND ${match('_d')}
        ))
    )`;
}

function streamLanguageFragment(
    sql: postgres.Sql,
    kind: 'audio' | 'subtitle',
    codes: readonly string[],
    withDescendants: boolean,
): Fragment {
    const und = codes.includes('und');
    const matches = (col: Fragment): Fragment =>
        und
            ? sql`(lower(${col}) = ANY(${codes as string[]}) OR COALESCE(btrim(${col}), '') = '')`
            : sql`lower(${col}) = ANY(${codes as string[]})`;
    return selfOrDescendantFragment(
        sql,
        (alias) => sql`(
            EXISTS (
                SELECT 1 FROM media_file_items _lf
                JOIN media_streams _ls ON _ls.file_id = _lf.file_id
                WHERE _lf.media_item_id = ${sql(alias)}.id
                  AND _ls.stream_type = ${kind}
                  AND ${matches(sql`_ls.language`)}
            )
            ${
                kind === 'subtitle'
                    ? sql`OR EXISTS (
                SELECT 1 FROM media_file_items _lf
                JOIN external_subtitle_files _le ON _le.file_id = _lf.file_id
                WHERE _lf.media_item_id = ${sql(alias)}.id
                  AND ${matches(sql`_le.language`)}
            )`
                    : sql``
            }
        )`,
        withDescendants,
    );
}

/**
 * Series / seasons / albums match a language through their children, which is
 * only worth the EXISTS when the request can return them: its types name one,
 * or it names none and is not a recursive scan (movies / episodes / tracks).
 */
function languageNeedsDescendants(mediaTypes: readonly string[], recursive: boolean): boolean {
    if (mediaTypes.length === 0) return !recursive;
    return mediaTypes.some((t) => t === 'tv' || t === 'season' || t === 'album');
}

/**
 * Does `mi` have an image of this Jellyfin type? The same sources the image
 * tags come from (jellyfin-item-images.queries.ts): stored provider paths,
 * custom URLs and local artwork, plus a TMDB / Jellyfin id the image route
 * would fetch live from (posters, stills, movie / series backdrops and logos).
 */
function imageTypeFragment(sql: postgres.Sql, type: string): Fragment {
    const meta = (path: Fragment): Fragment =>
        sql`EXISTS (
            SELECT 1 FROM provider_metadata _ip
            WHERE _ip.media_id = mi.id AND ${path} IS NOT NULL
        )`;
    const artwork = (artworkType: string): Fragment =>
        sql`EXISTS (
            SELECT 1 FROM image_candidates _ia
            WHERE _ia.media_item_id = mi.id AND _ia.artwork_type = ${artworkType}
              AND _ia.file_path IS NOT NULL AND NOT _ia.suppressed
        )`;
    const liveId = (providers: string[]): Fragment =>
        sql`EXISTS (
            SELECT 1 FROM external_ids _ie
            WHERE _ie.media_id = mi.id AND _ie.provider = ANY(${providers})
        )`;
    switch (type.toLowerCase()) {
        case 'primary':
            return sql`(mi.custom_poster_url IS NOT NULL
                OR ${meta(sql`COALESCE(_ip.metadata->>'poster_path', _ip.metadata->'artwork'->>'poster', _ip.metadata->>'still_path', _ip.metadata->'artwork'->>'still')`)}
                OR ${artwork('poster')}
                OR ${liveId(['tmdb', 'jellyfin', 'audiobookshelf'])})`;
        case 'backdrop':
            return sql`(mi.custom_backdrop_url IS NOT NULL
                OR ${meta(sql`COALESCE(_ip.metadata->>'backdrop_path', _ip.metadata->'artwork'->>'backdrop')`)}
                OR ${artwork('backdrop')}
                OR (mi.media_type IN ('movie', 'tv') AND ${liveId(['tmdb', 'jellyfin'])}))`;
        case 'logo':
            return sql`(mi.custom_logo_url IS NOT NULL
                OR ${meta(sql`COALESCE(_ip.metadata->>'logo_path', _ip.metadata->'artwork'->>'logo')`)}
                OR ${artwork('logo')}
                OR (mi.media_type IN ('movie', 'tv') AND ${liveId(['tmdb', 'jellyfin'])}))`;
        case 'thumb':
            return sql`(mi.media_type <> 'episode' AND (
                ${meta(sql`_ip.metadata->>'thumb_path'`)} OR ${artwork('thumb')}))`;
        default:
            // Art, Banner, Disc, Box, Screenshot, …: Lumastra has none.
            return sql`false`;
    }
}

function imageTypesFragment(sql: postgres.Sql, requested: readonly string[]): Fragment {
    const types = normalizeImageTypes(requested);
    // Only unknown types named: nothing has them.
    if (types.length === 0) return sql`AND false`;
    const parts = types.map((t) => imageTypeFragment(sql, t));
    return sql`AND (${parts.reduce((acc, part) => sql`${acc} OR ${part}`)})`;
}

/** Jellyfin `MediaTypes` → the DB media types that carry it. */
export function mapJellyfinMediaTypes(mediaTypes: string): string[] {
    const out = new Set<string>();
    for (const raw of mediaTypes.split(',')) {
        switch (raw.trim().toLowerCase()) {
            case 'video':
                out.add('movie');
                out.add('episode');
                break;
            case 'audio':
                out.add('track');
                break;
            default:
                // Photo / Book / Unknown: nothing in a Lumastra library has them.
                break;
        }
    }
    return [...out];
}

const UUID_SHAPE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Is `id` a season or series row (the parents served in episode order)? */
async function isSeasonOrSeries(sql: postgres.Sql, id: string): Promise<boolean> {
    if (!UUID_SHAPE.test(id)) return false;

    const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM media_items
        WHERE id = ${id}::uuid AND media_type IN ('season', 'tv')
    `;
    return rows.length > 0;
}

export async function browseMediaItems(
    sql: postgres.Sql,
    options: BrowseItemsOptions,
): Promise<{ rows: postgres.RowList<postgres.Row[]>; totalCount: number }> {
    const {
        mediaTypes,
        parentId,
        searchTerm,
        genres,
        years,
        nameStartsWith,
        isFavoriteFilter,
        isPlayedFilter,
        isUnplayedFilter,
        enableUserData,
        userId,
        idList,
        sortBy,
        sortOrder,
        limit,
        startIndex,
        access,
        forceEpisodeOrder,
        artistIds,
        isResumable,
        isFolder,
        playableMediaTypes,
        excludeMediaTypes,
        genreIds,
        recursive,
        orderByIdList,
        personIds,
        personRoles,
        studioIds,
        excludeIds,
        nameLessThan,
        nameStartsWithOrGreater,
        officialRatings,
        tags,
        audioLanguages,
        subtitleLanguages,
        imageTypes,
        albumIds,
        albumArtistIds,
        unratedOnly,
        maxAge,
        skipCount,
    } = options;
    // The very expression SortName orders by (episodes and seasons included), and
    // boundaries normalized like the stored sort keys, so NameLessThan /
    // NameStartsWithOrGreater paging (A-Z jump) never skips or repeats a row.
    const sortNameKey = sortNameExpression(sql);
    const lessThanKey = nameLessThan ? deriveSortTitle(nameLessThan) : null;
    const orGreaterKey = nameStartsWithOrGreater ? deriveSortTitle(nameStartsWithOrGreater) : null;
    const excludeIdList = capDistinct(excludeIds ?? []);
    const albumIdList = capDistinct(albumIds ?? []);
    const albumArtistIdList = capDistinct(albumArtistIds ?? []);
    const officialRatingList = capDistinct(
        (officialRatings ?? []).map((r) => r.trim()).filter(Boolean),
    );
    // Callers expand each code to its ISO spellings first, hence the wider cap.
    const audioLangList = capDistinct(audioLanguages ?? [], false, MAX_FILTER_LIST * 4);
    const subtitleLangList = capDistinct(subtitleLanguages ?? [], false, MAX_FILTER_LIST * 4);
    const languageDescendants = languageNeedsDescendants(mediaTypes, recursive ?? false);
    const lowerTags = capDistinct((tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean));
    const isFavorite = options.isFavorite ?? (isFavoriteFilter ? true : null);
    const isPlayed = options.isPlayed ?? (isPlayedFilter ? true : isUnplayedFilter ? false : null);
    const uid = sql`${userId ?? null}::uuid`;
    const normalizedGenreIds = (genreIds ?? []).map((g) => g.replace(/-/g, '').toLowerCase());

    const escapedSearchTerm = searchTerm
        ? searchTerm.replace(/%/g, '\\%').replace(/_/g, '\\_')
        : '';

    const sortSpecs = parseJellyfinSort(sortBy, sortOrder);
    const orderBy = buildBrowseOrderBy(sql, sortSpecs, userId);
    const episodeOrder =
        forceEpisodeOrder === true && parentId !== null && (await isSeasonOrSeries(sql, parentId));

    // A local helper (not a top-level export) so the page query and the count
    // query emit byte-identical WHERE predicates.
    // Runs in the page CTE and in the past-the-end count fallback, which join
    // only mi, pm, jf_pm, parent_season and seo/eo (plus tmdb_pm/file_dur for a
    // Runtime sort and parent_series for SeriesSortName). A predicate reading
    // any other alias (ws, series_pm, ...) must add that join to both.
    const wherePredicates = () => sql`
          ${idList.length > 0 ? sql`AND mi.id = ANY(${idList}::uuid[])` : sql``}
          ${buildFileBackedVideoItemFilter(sql, idList.length === 0, mediaTypes)}
          ${mediaTypes.length > 0 ? sql`AND mi.media_type = ANY(${mediaTypes})` : sql``}
          ${
              parentId
                  ? sql`AND (
              mi.parent_id = ${parentId}::uuid
              OR (jf_pm.metadata->>'jellyfin_library_id')::text = ${parentId}
              OR (
                  -- Own-file-in-this-library match. Without a type filter this
                  -- must exclude episodes: an episode's own file always lives
                  -- in the same library_group as its series, but an episode is
                  -- never a DIRECT child of a library folder (its real parent
                  -- is a season, already covered by mi.parent_id above) — so
                  -- unguarded this clause floods an unscoped "browse the TV
                  -- library" listing with individual episode rows instead of
                  -- just the series. When mediaTypes IS set (e.g. a recursive
                  -- IncludeItemTypes=Episode scan), the mi.media_type = ANY(...)
                  -- guard above already scopes rows correctly, so only
                  -- suppress episodes here in the unscoped case.
                  ${mediaTypes.length === 0 ? sql`mi.media_type != 'episode' AND` : sql``}
                  EXISTS (
                      SELECT 1 FROM media_file_items _mfi
                      JOIN media_files _mf ON _mf.id = _mfi.file_id
                      WHERE _mfi.media_item_id = mi.id AND _mf.library_group_id = ${parentId}::uuid
                  )
              )
              OR EXISTS (
                  SELECT 1 FROM media_items _ep
                  JOIN media_items _season ON _season.id = _ep.parent_id
                  JOIN media_file_items _mfi ON _mfi.media_item_id = _ep.id
                  JOIN media_files _mf ON _mf.id = _mfi.file_id
                  WHERE _season.parent_id = mi.id AND _mf.library_group_id = ${parentId}::uuid
              )
              OR EXISTS (
                  SELECT 1 FROM media_items _child
                  JOIN media_file_items _mfi ON _mfi.media_item_id = _child.id
                  JOIN media_files _mf ON _mf.id = _mfi.file_id
                  WHERE _child.parent_id = mi.id AND _mf.library_group_id = ${parentId}::uuid
              )
              ${
                  recursive
                      ? sql`OR mi.parent_id IN (
                  SELECT _p.id FROM media_items _p WHERE _p.parent_id = ${parentId}::uuid
              )`
                      : sql``
              }
          )`
                  : sql``
          }
          ${recursive && parentId ? buildUnmappedEpisodeFilterFragment(sql, 'mi') : sql``}
          ${searchTerm ? sql`AND mi.title ILIKE ${'%' + escapedSearchTerm + '%'}` : sql``}
          ${nameStartsWith ? (nameStartsWith === '#' ? sql`AND COALESCE(NULLIF(mi.sort_title, ''), LOWER(mi.title)) !~ '^[a-z]'` : sql`AND COALESCE(NULLIF(mi.sort_title, ''), LOWER(mi.title)) LIKE ${nameStartsWith.toLowerCase() + '%'}`) : sql``}
          ${years.length > 0 ? sql`AND mi.year = ANY(${years})` : sql``}
          ${
              genres.length > 0
                  ? sql`AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(pm.metadata->'genres') AS g
              WHERE (g->>'name')::text = ANY(${genres})
          )`
                  : sql``
          }
          ${
              normalizedGenreIds.length > 0
                  ? sql`AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(pm.metadata->'genres') = 'array' THEN pm.metadata->'genres' ELSE '[]'::jsonb END
              ) AS g
              WHERE md5(lower(btrim(g->>'name'))) = ANY(${normalizedGenreIds})
          )`
                  : sql``
          }
          ${isPlayed === true ? sql`AND ${playedPredicate(sql, userId)}` : sql``}
          ${isPlayed === false ? sql`AND NOT ${playedPredicate(sql, userId)}` : sql``}
          ${isResumable ? sql`AND ${resumablePredicate(sql, userId)}` : sql``}
          ${isFavorite === true ? sql`AND ${watchlistExistsFragment(sql, sql`mi.id`, uid)}` : sql``}
          ${isFavorite === false ? sql`AND NOT ${watchlistExistsFragment(sql, sql`mi.id`, uid)}` : sql``}
          ${isFolder === true ? sql`AND mi.media_type = ANY(${FOLDER_MEDIA_TYPES}::text[])` : sql``}
          ${isFolder === false ? sql`AND NOT (mi.media_type = ANY(${FOLDER_MEDIA_TYPES}::text[]))` : sql``}
          ${playableMediaTypes ? sql`AND mi.media_type = ANY(${playableMediaTypes}::text[])` : sql``}
          ${
              excludeMediaTypes && excludeMediaTypes.length > 0
                  ? sql`AND NOT (mi.media_type = ANY(${excludeMediaTypes}::text[]))`
                  : sql``
          }
          ${artistIds && artistIds.length > 0 ? sql`AND mi.parent_id = ANY(${artistIds}::uuid[])` : sql``}
          ${personIds ? personFilterFragment(sql, personIds, personRoles) : sql``}
          ${studioIds ? studioFilterFragment(sql, studioIds) : sql``}
          ${excludeIdList.length > 0 ? sql`AND NOT (mi.id = ANY(${excludeIdList}::uuid[]))` : sql``}
          ${lessThanKey ? sql`AND ${sortNameKey} < ${lessThanKey}` : sql``}
          ${orGreaterKey ? sql`AND ${sortNameKey} >= ${orGreaterKey}` : sql``}
          ${officialRatingList.length > 0 ? sql`AND btrim(pm.metadata->>'content_rating') = ANY(${officialRatingList})` : sql``}
          ${
              lowerTags.length > 0
                  ? sql`AND EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(
                  CASE WHEN jsonb_typeof(pm.metadata->'keywords') = 'array' THEN pm.metadata->'keywords' ELSE '[]'::jsonb END
              ) AS _kw
              WHERE lower(btrim(_kw)) = ANY(${lowerTags})
          )`
                  : sql``
          }
          ${audioLangList.length > 0 ? sql`AND ${streamLanguageFragment(sql, 'audio', audioLangList, languageDescendants)}` : sql``}
          ${subtitleLangList.length > 0 ? sql`AND ${streamLanguageFragment(sql, 'subtitle', subtitleLangList, languageDescendants)}` : sql``}
          ${imageTypes && imageTypes.length > 0 ? imageTypesFragment(sql, imageTypes) : sql``}
          ${albumIdList.length > 0 ? sql`AND mi.parent_id = ANY(${albumIdList}::uuid[])` : sql``}
          ${
              albumArtistIdList.length > 0
                  ? sql`AND (
              (mi.media_type = 'album' AND mi.parent_id = ANY(${albumArtistIdList}::uuid[]))
              OR (mi.media_type = 'track' AND EXISTS (
                  SELECT 1 FROM media_items _al
                  WHERE _al.id = mi.parent_id AND _al.media_type = 'album'
                    AND _al.parent_id = ANY(${albumArtistIdList}::uuid[])
              ))
          )`
                  : sql``
          }
          ${unratedOnly ? sql`AND ${seriesOwnedAgeRatingExpression(sql)} IS NULL` : sql``}
          ${maxAge !== null && maxAge !== undefined ? sql`AND COALESCE(${seriesOwnedAgeRatingExpression(sql)} <= ${maxAge}, true)` : sql``}
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildSeriesOwnedAgeRatingFilter(sql, access.age)}
    `;

    const idListOrder = orderByIdList === true && idList.length > 0;
    const orderClause = idListOrder
        ? sql`ORDER BY array_position(${idList}::uuid[], mi.id), mi.id`
        : episodeOrder
          ? sql`ORDER BY COALESCE(eo.order_season_number, mi.season_number) ASC NULLS LAST, COALESCE(eo.order_episode_number, mi.episode_number) ASC NULLS LAST, mi.sort_order ASC NULLS LAST, ${sortNameExpression(sql)} ASC, mi.id ASC`
          : sql`ORDER BY ${orderBy}`;
    // Only these two sort keys read joins that are otherwise page-only.
    const sortsByRuntime =
        !idListOrder && !episodeOrder && sortSpecs.some((s) => s.key === 'Runtime');
    const sortsBySeries =
        !idListOrder && !episodeOrder && sortSpecs.some((s) => s.key === 'SeriesSortName');

    const tmdbMetadataJoin = sql`
        LEFT JOIN LATERAL (
            SELECT metadata
            FROM provider_metadata
            WHERE media_id = mi.id AND provider = 'tmdb'
            LIMIT 1
        ) tmdb_pm ON true`;
    const jellyfinMetadataJoin = sql`
        LEFT JOIN LATERAL (
            SELECT metadata
            FROM provider_metadata
            WHERE media_id = mi.id AND provider = 'jellyfin'
            LIMIT 1
        ) jf_pm ON true`;
    const parentSeasonJoin = sql`
        LEFT JOIN media_items parent_season ON parent_season.id = mi.parent_id AND mi.media_type = 'episode'`;
    const parentSeriesJoin = sql`
        LEFT JOIN media_items parent_series ON (
            (mi.media_type = 'episode' AND parent_series.id = parent_season.parent_id)
            OR (mi.media_type = 'season' AND parent_series.id = mi.parent_id)
        )`;
    const fileDurationJoin = sql`
        LEFT JOIN LATERAL (
            SELECT mf.duration_seconds
            FROM media_file_items mfi
            JOIN media_files mf ON mf.id = mfi.file_id
            WHERE mfi.media_item_id = mi.id AND mf.duration_seconds IS NOT NULL
            LIMIT 1
        ) file_dur ON true`;

    // Pick the page first, then build the costly columns for those rows only.
    // COUNT(*) OVER() needs every matching row, and with the display joins
    // (series and TMDB metadata, file duration, user state) in the same SELECT
    // they were built for every one of those rows before LIMIT: 2.0 to 10 s
    // for a 100-row page of a large filter on prod (the Jellyfin library
    // browse). The `page` CTE carries just what the filters and the ORDER BY
    // read, the total, and the episode ordering numbers (that join can repeat
    // a row, so they travel with it). The display joins added afterwards are
    // 1:1 or LIMIT 1: user_media_state is unique per user and item, media_items
    // by id, the laterals take one row. Same rows, order and total as before.
    const rows = await sql`
        WITH page AS MATERIALIZED (
            SELECT p.*, row_number() OVER () AS rn
            FROM (
                SELECT
                    ${skipCount ? sql`0 AS total_count,` : sql`COUNT(*) OVER() AS total_count,`}
                    mi.id,
                    eo.order_season_number AS eo_season_number,
                    eo.order_episode_number AS eo_episode_number
                FROM media_items mi
                ${buildMetadataLateralJoinFragment(sql)}
                ${sortsByRuntime ? tmdbMetadataJoin : sql``}
                ${jellyfinMetadataJoin}
                ${parentSeasonJoin}
                ${sortsBySeries ? parentSeriesJoin : sql``}
                ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi', 'parent_season.parent_id')}
                ${sortsByRuntime ? fileDurationJoin : sql``}
                WHERE mi.status = 'active'
                  ${wherePredicates()}
                ${orderClause}
                LIMIT ${limit}
                OFFSET ${startIndex}
            ) p
        )
        SELECT
            page.total_count,
            mi.id,
            mi.title,
            mi.original_title,
            mi.sort_title,
            mi.media_type,
            mi.year,
            mi.created_at,
            COALESCE(mi.runtime_seconds, (tmdb_pm.metadata->>'runtime')::int * 60, file_dur.duration_seconds) as runtime_seconds,
            mi.parent_id,
            COALESCE(page.eo_season_number, mi.season_number) as season_number,
            COALESCE(page.eo_episode_number, mi.episode_number) as episode_number,
            mi.overview as mi_overview,
            mi.premiere_date,
            (pm.metadata->>'overview')::text as pm_overview,
            COALESCE((pm.metadata->>'poster_path')::text, (tmdb_pm.metadata->>'poster_path')::text) as poster_path,
            COALESCE((pm.metadata->>'backdrop_path')::text, (tmdb_pm.metadata->>'backdrop_path')::text) as backdrop_path,
            (pm.metadata->>'vote_average')::float as vote_average,
            (pm.metadata->>'content_rating')::text as content_rating,
            (pm.metadata->>'tagline')::text as tagline,
            CASE WHEN pm.metadata->'genres' IS NOT NULL AND jsonb_typeof(pm.metadata->'genres') = 'array'
                THEN ARRAY(SELECT (g->>'name')::text FROM jsonb_array_elements(pm.metadata->'genres') AS g WHERE g->>'name' IS NOT NULL)
                ELSE NULL
            END as genre_names,
            ${
                enableUserData
                    ? sql`
                ws.resume_position_ms,
                CASE WHEN ws.runtime_ms > 0 AND ws.resume_position_ms > 0
                    THEN (ws.resume_position_ms::float / ws.runtime_ms * 100)
                    ELSE 0
                END as played_percentage,
                COALESCE(ws.is_watched, false) as is_watched,
                ${lastPlayedAtExpression(sql, 'ws')} as last_played_at,
            `
                    : sql`
                NULL::bigint as resume_position_ms,
                0::float as played_percentage,
                false as is_watched,
                NULL::timestamptz as last_played_at,
            `
            }
            ${watchlistExistsFragment(sql, sql`mi.id`, sql`${userId ?? null}::uuid`)} as is_favorite,
            parent_series.id as series_id,
            parent_series.title as series_name,
            parent_season.id as season_id,
            parent_season.title as season_name,
            series_pm.poster_path as series_poster_path,
            series_pm.backdrop_path as series_backdrop_path
        FROM page
        JOIN media_items mi ON mi.id = page.id
        ${buildMetadataLateralJoinFragment(sql)}
        ${tmdbMetadataJoin}
        ${enableUserData ? sql`LEFT JOIN user_media_state ws ON ws.media_id = mi.id AND ws.user_id = ${userId ?? null}::uuid` : sql``}
        ${parentSeasonJoin}
        ${parentSeriesJoin}
        LEFT JOIN LATERAL (
            -- Extract the two paths inside the lateral: the outer SELECT list would
            -- otherwise detoast the series' whole tmdb jsonb once per output row per
            -- field (18 ms vs 2 ms for a 24-episode season of a large series).
            SELECT (metadata->>'poster_path')::text AS poster_path,
                   (metadata->>'backdrop_path')::text AS backdrop_path
            FROM provider_metadata
            WHERE media_id = parent_series.id AND provider = 'tmdb'
            LIMIT 1
        ) series_pm ON true
        ${fileDurationJoin}
        ORDER BY page.rn
    `;

    // EnableTotalRecordCount=false: the page is all the caller wants to know about.
    if (skipCount) return { rows, totalCount: rows.length };
    if (rows.length > 0) {
        return { rows, totalCount: parseInt(rows[0].total_count, 10) };
    }
    if (startIndex === 0) {
        // Genuinely empty result set — no fallback query needed.
        return { rows, totalCount: 0 };
    }

    // COUNT(*) OVER() has nothing to attach to when LIMIT/OFFSET excludes
    // every row (startIndex landed past the end — stale client pagination
    // state, or the set shrank between the caller's count and this fetch).
    // Rare: only in this edge case do we pay for a second query, with the same
    // joins that can repeat or filter a row.
    const countResult = await sql<[{ count: string }]>`
        SELECT COUNT(*) as count
        FROM media_items mi
        ${buildMetadataLateralJoinFragment(sql)}
        ${jellyfinMetadataJoin}
        ${parentSeasonJoin}
        ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi', 'parent_season.parent_id')}
        WHERE mi.status = 'active'
          ${wherePredicates()}
    `;
    return { rows, totalCount: parseInt(countResult[0]?.count ?? '0', 10) };
}

export interface LatestItemsOptions {
    limit: number;
    parentId: string | null | undefined;
    groupItems: boolean;
    /** Required media access boundary — no permissive default. */
    access: MediaAccessBoundary;
    /** Newest-file windows to try before the full listing (tests shrink these). */
    fileWindows?: readonly number[];
    /**
     * Media types to rank (subset of movie / tv / episode). Default: movies and
     * series when grouping, movies, series and episodes otherwise.
     */
    mediaTypes?: readonly string[];
    /**
     * Jellyfin `IsPlayed`: a movie / episode by its own watched state, a series
     * when it has a file-backed episode in that state (the episodes Jellyfin
     * groups under it). Needs `userId`. `null`/absent = no filter.
     */
    isPlayed?: boolean | null;
    userId?: UserId;
}

const LATEST_MEDIA_TYPES = ['movie', 'tv', 'episode'] as const;

function latestMediaTypes(options: LatestItemsOptions): string[] {
    const wanted =
        options.mediaTypes ?? (options.groupItems ? ['movie', 'tv'] : LATEST_MEDIA_TYPES);
    return LATEST_MEDIA_TYPES.filter((t) => wanted.includes(t));
}

/** {@link LatestItemsOptions.isPlayed} as a WHERE fragment on `mi`. */
function buildLatestPlayedFilter(
    sql: postgres.Sql,
    userId: UserId | undefined,
    isPlayed: boolean | null | undefined,
): postgres.PendingQuery<postgres.Row[]> {
    if (isPlayed === null || isPlayed === undefined) return sql``;
    const uid = sql`${userId ?? null}::uuid`;
    const watched = (id: postgres.PendingQuery<postgres.Row[]>) => sql`EXISTS (
        SELECT 1 FROM user_media_state _u
        WHERE _u.user_id = ${uid} AND _u.media_id = ${id} AND _u.is_watched
    )`;
    const state = (id: postgres.PendingQuery<postgres.Row[]>) =>
        isPlayed ? watched(id) : sql`NOT ${watched(id)}`;
    return sql`AND (
        (mi.media_type = 'tv' AND EXISTS (
            SELECT 1 FROM media_items _s
            JOIN media_items _e ON _e.parent_id = _s.id
            WHERE _s.parent_id = mi.id AND _s.media_type = 'season'
              AND _e.media_type = 'episode' AND _e.status = 'active' AND _e.has_files = true
              AND ${state(sql`_e.id`)}
        ))
        OR (mi.media_type <> 'tv' AND ${state(sql`mi.id`)})
    )`;
}

export interface SeriesEpisodesOptions {
    seriesId: string;
    seasonId: string | null | undefined;
    seasonNumber: string | null | undefined;
    enableUserData: boolean;
    userId: UserId | undefined;
    limit: number;
    startIndex: number;
    /** Required media access boundary — no permissive default. */
    access: MediaAccessBoundary;
}

/**
 * Options for {@link getSeriesSeasons}.
 *
 * `access` was missing entirely until C8 (2026-09-16 security review 3): the
 * route's `checkMediaAccess(seriesId)` gate only proves the SERIES is
 * visible, not that every SEASON under it is — `media_items.library_group_id`
 * is sticky (set once at first scan, only ever backfilled while NULL), so a
 * series that later gains a season in a new library group keeps listing that
 * season's title/overview/artwork/premiere_date/child_count to a user denied
 * that group. Required-by-shape like every other exported query in this file
 * — see the module doc's "Access boundary" section.
 *
 * Age axis: `season` (and `episode`) rows never get `age_rating` written
 * (only `movie`/`tv` do, via `updateMediaAgeRating`), so seasons and episodes
 * are judged by the SERIES row's rating, here and in `getSeriesEpisodes` —
 * the same rule as `series-episode-counts.queries.ts`. Filtering on the
 * season's own always-NULL column would empty the listing for every
 * age-restricted profile without unrated access.
 */
export interface SeriesSeasonsOptions {
    seriesId: string;
    enableUserData: boolean;
    userId: UserId | undefined;
    /** Required media access boundary — no permissive default. */
    access: MediaAccessBoundary;
}

/**
 * Newest-file windows tried before falling back to the full listing. Prod
 * (82k files, 2026-09-24): the Series library needs ~4k files to surface 20
 * titles because most new files land in other libraries; Movies needs far fewer.
 */
const LATEST_FILE_WINDOWS = [4_000, 32_000] as const;

/**
 * Candidate ids for {@link getLatestItems}: every item that owns one of the
 * `window` newest files, plus that item's grandparent (the series of an
 * episode filed under a season), limited to the media types the listing can
 * return. Returns `complete: true` when the window covers every file, i.e.
 * the candidates are ALL items with files.
 *
 * EXACTNESS: the listing ranks by latest_file = newest file among an item's
 * own files and its grandchildren's files, and every row that survives its
 * file-backed filter owns at least one such file. So a surviving item that is
 * NOT a candidate has latest_file < cutoff (the window's oldest file time;
 * the cutoff is inclusive, so ties at the boundary are candidates), while
 * every candidate has latest_file >= cutoff. The top `limit` over the
 * candidates is therefore the true top `limit` whenever at least `limit`
 * candidates survive the filters.
 */
async function findLatestCandidates(
    sql: postgres.Sql,
    window: number,
    types: readonly string[],
): Promise<{ ids: string[]; complete: boolean }> {
    // The cutoff is read first and passed back as a literal: as an InitPlan inside
    // one statement the planner cannot see its value, assumes ~12k of 90k files
    // qualify (~4k really do) and seq-scans media_files, media_file_items and
    // media_items. Text keeps the microseconds a JS Date would drop.
    const [{ cutoff }] = await sql<{ cutoff: string | null }[]>`
        SELECT (SELECT created_at::text FROM media_files
                 ORDER BY created_at DESC OFFSET ${window - 1} LIMIT 1) AS cutoff
    `;
    // Fewer files than the window (no cutoff row): the candidates are every item
    // with a file.
    const complete = cutoff === null;
    // Candidate ids only — the listing query that consumes them applies the
    // library/age access filters.
    const rows = await sql<{ id: string }[]>`
        WITH recent AS (
            SELECT mfi.media_item_id
            FROM media_files mf
            JOIN media_file_items mfi ON mfi.file_id = mf.id
            WHERE mf.created_at >= ${cutoff ?? '-infinity'}::text::timestamptz
        )
        SELECT DISTINCT t.id::text AS id
        FROM recent r
        JOIN media_items own ON own.id = r.media_item_id
        LEFT JOIN media_items p ON p.id = own.parent_id
        CROSS JOIN LATERAL (VALUES (own.id), (p.parent_id)) x(id)
        JOIN media_items t ON t.id = x.id AND t.media_type = ANY(${[...types]}::text[])
    `;
    return { ids: rows.map((r) => r.id), complete };
}

/**
 * `parentId|groupItems` -> expiry of "the windows fell through last time, go
 * straight to the full listing". Retried after the TTL, so a library that has
 * since gained enough new files returns to the cheaper windowed path.
 */
const fullListingHint = new Map<string, number>();

/**
 * Key for {@link fullListingHint}. With `isPlayed` the windows' outcome depends
 * on ONE user's watch state, so the hint is that user's alone — otherwise one
 * heavy watcher would send every user to the full listing for an hour. The
 * map's key cap bounds the per-user entries.
 */
export function latestHintKey(options: LatestItemsOptions, types: readonly string[]): string {
    const base = `${options.parentId ?? ''}|${types.join(',')}`;
    if (options.isPlayed === null || options.isPlayed === undefined) return base;
    return `${base}|${options.isPlayed}|${options.userId ?? ''}`;
}
const FULL_LISTING_HINT_TTL_MS = 60 * 60 * 1000;
const FULL_LISTING_HINT_MAX_KEYS = 256;

export async function getLatestItems(
    sql: postgres.Sql,
    options: LatestItemsOptions,
): Promise<postgres.RowList<postgres.Row[]>> {
    // Ranking every library title by its newest file before the LIMIT cost
    // ~560 ms on prod. Try the titles behind the newest files first; see
    // findLatestCandidates for why that is exact, not an approximation.
    //
    // One REPEATABLE READ snapshot for the candidate and listing queries: a file
    // landing between them would otherwise be absent from the candidates while
    // the listing's filter already sees it, breaking the exactness argument. A
    // caller that already holds a transaction handle (no `.begin`) runs inline.
    //
    // A small library (prod's Kids: 38 titles among 83k files) never gathers
    // `limit` titles inside any window, so every poll paid for every window and
    // then the full listing anyway. The windows are only a shortcut to the same
    // rows, so remembering "this library needed the full listing" changes speed,
    // never results. Only for the production windows: a caller passing its own
    // `fileWindows` (the exactness tests) always runs them.
    const types = latestMediaTypes(options);
    if (types.length === 0) return sql`SELECT 1 WHERE false`;
    const hintKey = latestHintKey(options, types);
    const useHint = options.fileWindows === undefined;
    const skipWindows = useHint && (fullListingHint.get(hintKey) ?? 0) > Date.now();
    const run = async (db: postgres.Sql): Promise<postgres.RowList<postgres.Row[]>> => {
        if (!skipWindows) {
            for (const window of options.fileWindows ?? LATEST_FILE_WINDOWS) {
                const { ids, complete } = await findLatestCandidates(db, window, types);
                const rows = await queryLatestItems(db, options, ids);
                if (complete || rows.length >= options.limit) return rows;
            }
        }
        const rows = await queryLatestItems(db, options, null);
        if (useHint && !skipWindows) {
            // parentId is client input: bound the map rather than grow it per id.
            if (fullListingHint.size >= FULL_LISTING_HINT_MAX_KEYS) fullListingHint.clear();
            fullListingHint.set(hintKey, Date.now() + FULL_LISTING_HINT_TTL_MS);
        }
        return rows;
    };
    if (typeof (sql as { begin?: unknown }).begin !== 'function') return run(sql);
    return (await sql.begin('isolation level repeatable read read only', (tx) =>
        run(tx as unknown as postgres.Sql),
    )) as postgres.RowList<postgres.Row[]>;
}

/**
 * The Latest listing's library filter: the item carries the library's Jellyfin
 * id, owns a file in the library group, or is the series of an episode that
 * does.
 *
 * Two spellings of the same set. The windowed pass already narrows `mi` to a
 * few hundred candidates, where the correlated form is cheapest. The full pass
 * would otherwise run the file-backed checks over every title in the catalogue
 * before this filter drops most of them (prod Kids library: 3,583 titles
 * checked, 38 kept, ~400 ms); there the library's own member set goes first
 * (~80 ms). `provider_metadata` is unique on (media_id, provider), so the
 * `jf_pm` lateral's single jellyfin row and the `media_id` list below agree.
 */
function buildLatestLibraryFilter(sql: postgres.Sql, parentId: string, libraryFirst: boolean) {
    if (libraryFirst) {
        return sql`AND mi.id IN (
              SELECT media_id FROM provider_metadata
               WHERE provider = 'jellyfin' AND (metadata->>'jellyfin_library_id')::text = ${parentId}
              UNION ALL
              SELECT _mfi.media_item_id FROM media_files _mf
                JOIN media_file_items _mfi ON _mfi.file_id = _mf.id
               WHERE _mf.library_group_id = ${parentId}::uuid
              UNION ALL
              SELECT _season.parent_id FROM media_files _mf
                JOIN media_file_items _mfi ON _mfi.file_id = _mf.id
                JOIN media_items _ep ON _ep.id = _mfi.media_item_id
                JOIN media_items _season ON _season.id = _ep.parent_id
               WHERE _mf.library_group_id = ${parentId}::uuid
          )`;
    }
    return sql`AND (
              (jf_pm.metadata->>'jellyfin_library_id')::text = ${parentId}
              OR EXISTS (
                  SELECT 1 FROM media_file_items _mfi
                  JOIN media_files _mf ON _mf.id = _mfi.file_id
                  WHERE _mfi.media_item_id = mi.id AND _mf.library_group_id = ${parentId}::uuid
              )
              OR EXISTS (
                  SELECT 1 FROM media_items _ep
                  JOIN media_items _season ON _season.id = _ep.parent_id
                  JOIN media_file_items _mfi ON _mfi.media_item_id = _ep.id
                  JOIN media_files _mf ON _mf.id = _mfi.file_id
                  WHERE _season.parent_id = mi.id AND _mf.library_group_id = ${parentId}::uuid
              )
          )`;
}

async function queryLatestItems(
    sql: postgres.Sql,
    options: LatestItemsOptions,
    candidateIds: string[] | null,
): Promise<postgres.RowList<postgres.Row[]>> {
    const { limit, parentId, access } = options;
    const types = latestMediaTypes(options);
    return sql`
        SELECT
            mi.id,
            mi.title,
            mi.original_title,
            mi.sort_title,
            mi.media_type,
            mi.year,
            mi.created_at,
            COALESCE(mi.runtime_seconds, (tmdb_pm.metadata->>'runtime')::int * 60) as runtime_seconds,
            mi.parent_id,
            mi.season_number,
            mi.episode_number,
            mi.overview as mi_overview,
            mi.premiere_date,
            (pm.metadata->>'overview')::text as pm_overview,
            COALESCE((pm.metadata->>'poster_path')::text, (tmdb_pm.metadata->>'poster_path')::text) as poster_path,
            COALESCE((pm.metadata->>'backdrop_path')::text, (tmdb_pm.metadata->>'backdrop_path')::text) as backdrop_path,
            (pm.metadata->>'vote_average')::float as vote_average,
            (pm.metadata->>'content_rating')::text as content_rating,
            parent_series.id as series_id,
            parent_series.title as series_name,
            parent_season.id as season_id,
            parent_season.title as season_name,
            COALESCE(latest_file.added, mi.created_at) AS latest_added
        FROM media_items mi
        ${buildMetadataLateralJoinFragment(sql)}
        LEFT JOIN LATERAL (
            SELECT metadata
            FROM provider_metadata
            WHERE media_id = mi.id AND provider = 'tmdb'
            LIMIT 1
        ) tmdb_pm ON true
        LEFT JOIN LATERAL (
            SELECT metadata
            FROM provider_metadata
            WHERE media_id = mi.id AND provider = 'jellyfin'
            LIMIT 1
        ) jf_pm ON true
        LEFT JOIN media_items parent_season ON parent_season.id = mi.parent_id AND mi.media_type = 'episode'
        LEFT JOIN media_items parent_series ON (
            (mi.media_type = 'episode' AND parent_series.id = parent_season.parent_id)
            OR (mi.media_type = 'season' AND parent_series.id = mi.parent_id)
        )
        -- "Recently added" must reflect when the FILE landed in the library, not
        -- when the catalog row was created. A title can be discovered (created_at)
        -- months before its file arrives (e.g. a request that downloads later);
        -- ordering by mi.created_at would bury it and it never surfaces in the
        -- Limit=N latest window (breaking Jellyseerr's recently-added scan, Infuse/
        -- Streamyfin "Recently Added" rows, etc.). Take the newest file-added time
        -- across the item's own files AND, for series, its episodes' files.
        LEFT JOIN LATERAL (
            SELECT MAX(added) AS added FROM (
                SELECT _mf.created_at AS added
                FROM media_file_items _mfi
                JOIN media_files _mf ON _mf.id = _mfi.file_id
                WHERE _mfi.media_item_id = mi.id
                UNION ALL
                SELECT _mf.created_at AS added
                FROM media_items _season
                JOIN media_items _ep ON _ep.parent_id = _season.id
                JOIN media_file_items _mfi ON _mfi.media_item_id = _ep.id
                JOIN media_files _mf ON _mf.id = _mfi.file_id
                WHERE _season.parent_id = mi.id
            ) _added
        ) latest_file ON true
        WHERE mi.status = 'active'

          ${buildFileBackedVideoItemFilter(sql, true)}
          ${parentId ? buildLatestLibraryFilter(sql, parentId, candidateIds === null) : sql``}
          AND mi.media_type = ANY(${types}::text[])
          ${buildLatestPlayedFilter(sql, options.userId, options.isPlayed)}
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildSeriesOwnedAgeRatingFilter(sql, access.age)}
          ${candidateIds ? sql`AND mi.id = ANY(${candidateIds}::uuid[])` : sql``}
        ORDER BY COALESCE(latest_file.added, mi.created_at) DESC, mi.created_at DESC
        LIMIT ${limit}
    `;
}

/** Jellyfin `/UserItems/Resume` query parameters (ItemsController.GetResumeItems). */
export interface ResumeFilters {
    /**
     * Resumable DB media types to list (movie / episode / track); default
     * movies and episodes. Empty = nothing (the client asked only for types
     * that cannot be resumed).
     */
    mediaTypes?: readonly string[];
    /** Library group, synced Jellyfin library id, series, season or album. */
    parentId?: string | null;
    /** Title (or the episode's series title) contains this, case-insensitively. */
    searchTerm?: string | null;
    startIndex?: number;
}

const RESUMABLE_MEDIA_TYPES = ['movie', 'episode', 'track'] as const;

function buildResumeParentFilter(
    sql: postgres.Sql,
    parentId: string | null | undefined,
): postgres.PendingQuery<postgres.Row[]> {
    if (!parentId) return sql``;
    const jellyfinLibrary = sql`EXISTS (
        SELECT 1 FROM provider_metadata _jf
        WHERE _jf.provider = 'jellyfin'
          AND _jf.media_id IN (mi.id, parent_series.id)
          AND (_jf.metadata->>'jellyfin_library_id')::text = ${parentId}
    )`;
    if (!UUID_SHAPE.test(parentId)) return sql`AND ${jellyfinLibrary}`;
    return sql`AND (
        mi.parent_id = ${parentId}::uuid
        OR parent_series.id = ${parentId}::uuid
        OR EXISTS (
            SELECT 1 FROM media_file_items _mfi
            JOIN media_files _mf ON _mf.id = _mfi.file_id
            WHERE _mfi.media_item_id = mi.id AND _mf.library_group_id = ${parentId}::uuid
        )
        OR ${jellyfinLibrary}
    )`;
}

export async function getResumeItems(
    sql: postgres.Sql,
    userId: UserId | undefined,
    limit: number,
    access: MediaAccessBoundary,
    filters: ResumeFilters = {},
): Promise<postgres.RowList<postgres.Row[]>> {
    const types = RESUMABLE_MEDIA_TYPES.filter((t) =>
        (filters.mediaTypes ?? ['movie', 'episode']).includes(t),
    );
    if (types.length === 0) return sql`SELECT 1 WHERE false`;
    const search = filters.searchTerm?.trim()
        ? `%${filters.searchTerm.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        : null;
    // "Continue Watching" = currently playing OR previously paused with progress.
    //
    // Two sources, deliberately separated by Lumastra's two-tier design:
    //   - play_sessions (live plane): updated every Progress heartbeat
    //   - user_media_state (durable plane): only written on session-end with
    //     engagement gates passed
    //
    // If we only sourced from user_media_state, an actively-watching item
    // wouldn't appear in Resume until the user explicitly stopped — Infuse's
    // home screen would skip the very thing they were just watching. Instead
    // we UNION live ACTIVE sessions on top, and prefer them when the same
    // media exists in both (their position is more current).
    //
    // 30-minute heartbeat window: filters out abandoned sessions that the
    // cleanup job hasn't promoted yet. After 30min of no Progress the item
    // falls back to whatever durable state has (often nothing — by design).
    return sql`
        WITH active_sessions AS (
            SELECT DISTINCT ON (ps.media_id)
                ps.media_id,
                ps.position_ms AS resume_position_ms,
                ps.runtime_ms,
                ps.last_heartbeat_at AS effective_at
            FROM play_sessions ps
            WHERE ps.user_id = ${userId ?? null}::uuid
              AND ps.status = 'ACTIVE'
              AND ps.purpose <> 'download'
              AND ps.position_ms > 0
              AND ps.last_heartbeat_at > NOW() - INTERVAL '30 minutes'
            ORDER BY ps.media_id, ps.last_heartbeat_at DESC
        ),
        unified AS (
            SELECT
                media_id,
                resume_position_ms,
                runtime_ms,
                effective_at,
                false AS is_watched,
                -- Live session is a real in-progress play — never a migration
                -- backfill. NULL never matches the migration guard below.
                NULL::text AS last_event_source,
                -- A live session is never "moved on" from.
                true AS is_live,
                NULL::timestamptz AS gate_clock
            FROM active_sessions
            UNION ALL
            SELECT
                ws.media_id,
                ws.resume_position_ms,
                ws.runtime_ms,
                COALESCE(ws.last_watched_at, ws.last_event_at) AS effective_at,
                COALESCE(ws.is_watched, false) AS is_watched,
                ws.last_event_source,
                false AS is_live,
                ws.last_event_at AS gate_clock
            FROM user_media_state ws
            WHERE ws.user_id = ${userId ?? null}::uuid
              AND ws.resume_position_ms > 0
              AND COALESCE(ws.is_watched, false) = false
              AND ws.media_id NOT IN (SELECT media_id FROM active_sessions)
        ),
        -- Series of the durable episode rows, for the moved-on gate (shared
        -- with the home rail, moved-on-gate.builder.ts). Live rows are never
        -- gated, so they are left out here.
        cand_series AS (
            SELECT gate_season.parent_id AS series_id, MIN(u.gate_clock) AS min_clock
            FROM unified u
            JOIN media_items gate_ep ON gate_ep.id = u.media_id AND gate_ep.media_type = 'episode'
            JOIN media_items gate_season ON gate_season.id = gate_ep.parent_id AND gate_season.media_type = 'season'
            WHERE NOT u.is_live
            GROUP BY gate_season.parent_id
        ),
        ${buildMovedOnGateCtes(sql, userId ?? null)},
        -- Candidates: all resumable items passing the completion upper-bound.
        -- Thresholds mirror getContinueWatchingFromDb so that episodes the
        -- homepage considers "done" are also absent from the /j Resume feed.
        -- u.runtime_ms may be 0/NULL for legacy rows — pass those through.
        candidates AS (
            SELECT
                mi.id,
                mi.title,
                mi.original_title,
                mi.sort_title,
                mi.media_type,
                mi.year,
                mi.created_at,
                COALESCE(mi.runtime_seconds, (tmdb_pm.metadata->>'runtime')::int * 60) as runtime_seconds,
                mi.parent_id,
                COALESCE(eo.order_season_number, mi.season_number) as season_number,
                COALESCE(eo.order_episode_number, mi.episode_number) as episode_number,
                mi.overview as mi_overview,
                mi.premiere_date,
                (pm.metadata->>'overview')::text as pm_overview,
                COALESCE((pm.metadata->>'poster_path')::text, (tmdb_pm.metadata->>'poster_path')::text) as poster_path,
                COALESCE((pm.metadata->>'backdrop_path')::text, (tmdb_pm.metadata->>'backdrop_path')::text) as backdrop_path,
                (pm.metadata->>'vote_average')::float as vote_average,
                (pm.metadata->>'content_rating')::text as content_rating,
                u.resume_position_ms,
                CASE WHEN u.runtime_ms > 0 AND u.resume_position_ms > 0
                    THEN (u.resume_position_ms::float / u.runtime_ms * 100)
                    ELSE 0
                END as played_percentage,
                u.is_watched,
                u.effective_at AS last_watched_at,
                parent_series.id as series_id,
                parent_series.title as series_name,
                parent_season.id as season_id,
                parent_season.title as season_name,
                series_pm.poster_path as series_poster_path,
                series_pm.backdrop_path as series_backdrop_path,
                -- Series dedup: rank episodes within the same series by recency.
                -- Movies have no series_id so each gets its own partition (rank = 1).
                -- Orphaned episodes whose series item is missing fall back to
                -- parent_season.parent_id (the FK value) so siblings still group.
                ROW_NUMBER() OVER (
                    PARTITION BY COALESCE(parent_series.id, parent_season.parent_id, mi.id)
                    ORDER BY u.effective_at DESC NULLS LAST, COALESCE(eo.order_episode_number, mi.episode_number) DESC NULLS LAST
                ) AS series_rank
            FROM unified u
            JOIN media_items mi ON mi.id = u.media_id
            ${buildMetadataLateralJoinFragment(sql)}
            LEFT JOIN LATERAL (
                SELECT metadata
                FROM provider_metadata
                WHERE media_id = mi.id AND provider = 'tmdb'
                LIMIT 1
            ) tmdb_pm ON true
            LEFT JOIN media_items parent_season ON parent_season.id = mi.parent_id AND mi.media_type = 'episode'
            ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi', 'parent_season.parent_id')}
            LEFT JOIN media_items parent_series ON (
                (mi.media_type = 'episode' AND parent_series.id = parent_season.parent_id)
                OR (mi.media_type = 'season' AND parent_series.id = mi.parent_id)
            )
            LEFT JOIN LATERAL (
                -- Extract the two paths inside the lateral: the outer SELECT list would
                -- otherwise detoast the series' whole tmdb jsonb once per output row per
                -- field (18 ms vs 2 ms for a 24-episode season of a large series).
                SELECT (metadata->>'poster_path')::text AS poster_path,
                       (metadata->>'backdrop_path')::text AS backdrop_path
                FROM provider_metadata
                WHERE media_id = parent_series.id AND provider = 'tmdb'
                LIMIT 1
            ) series_pm ON true
            WHERE mi.status = 'active'
              AND mi.has_files = true
              ${buildFileBackedEpisodeFilter(sql)}
              AND mi.media_type = ANY(${types}::text[])
              ${buildResumeParentFilter(sql, filters.parentId)}
              ${search ? sql`AND (mi.title ILIKE ${search} OR parent_series.title ILIKE ${search})` : sql``}
              -- Upper bound: drop items past the completion threshold.
              -- Matches the per-runtime-tier thresholds in getContinueWatchingFromDb.
              -- position >= runtime is treated as pass-through (corrupt/stale data).
              AND (
                  u.runtime_ms IS NULL OR u.runtime_ms <= 0
                  OR u.resume_position_ms >= u.runtime_ms
                  OR u.resume_position_ms::float / u.runtime_ms < CASE
                      WHEN u.runtime_ms < 90 * 60 * 1000  THEN 0.90
                      WHEN u.runtime_ms < 150 * 60 * 1000 THEN 0.95
                      ELSE 0.96
                  END
              )
              -- Migration phantom guard: mirror getContinueWatchingFromDb.
              -- The one-shot M0 backfill (last_event_source='migration') seeds
              -- a resume point it never actually measured, so a stale sub-1%
              -- legacy resume (e.g. a 66s scrub on a 193-min movie) must not
              -- surface here either. Unlike the homepage CW query this feed has
              -- no engagement/percent floor of its own, so migration rows are
              -- held to the same bar CW applies to them: real ≥10% progress
              -- (known runtime) or >5min (unknown runtime). Live sessions and
              -- lumastra/jellyfin plays carry a non-'migration' source and pass.
              AND NOT (
                  COALESCE(u.last_event_source, '') = 'migration'
                  AND (
                      (u.runtime_ms IS NOT NULL AND u.runtime_ms > 0
                       AND u.resume_position_ms::float / u.runtime_ms < 0.10)
                      OR ((u.runtime_ms IS NULL OR u.runtime_ms <= 0)
                       AND u.resume_position_ms <= 300000)
                  )
              )
              -- Moved-on gate, BEFORE the per-series ROW_NUMBER so a series
              -- falls back to a sibling instead of vanishing. Live rows are
              -- always kept; every durable row here is
              -- unwatched, so there is no re-watch exemption to honour.
              AND (
                  u.is_live
                  OR mi.media_type <> 'episode'
                  OR ${buildMovedOnKeepPredicate(sql, {
                      seriesId: sql`parent_series.id`,
                      mediaId: sql`mi.id`,
                      clock: sql`u.gate_clock`,
                      effSeason: sql`COALESCE(eo.order_season_number, mi.season_number)`,
                      effEpisode: sql`COALESCE(eo.order_episode_number, mi.episode_number)`,
                      laterGateApplies: sql`(mi.season_number IS NOT NULL AND mi.episode_number IS NOT NULL)`,
                  })}
              )
              ${buildSeriesOwnedAgeRatingFilter(sql, access.age)}
              ${buildLibraryAccessFilter(sql, access.library)}
        )
        SELECT
            COUNT(*) OVER() AS total_count,
            id, title, original_title, sort_title, media_type, year, created_at,
            runtime_seconds, parent_id, season_number, episode_number,
            mi_overview, premiere_date, pm_overview, poster_path,
            backdrop_path, vote_average, content_rating, resume_position_ms,
            played_percentage, is_watched, last_watched_at,
            last_watched_at AS last_played_at,
            series_id, series_name, season_id, season_name,
            series_poster_path, series_backdrop_path
        FROM candidates
        WHERE series_rank = 1
        ORDER BY last_watched_at DESC NULLS LAST, id
        LIMIT ${limit}
        OFFSET ${filters.startIndex ?? 0}
    `;
}

/**
 * {@link getResumeItems} with Jellyfin paging: the page plus the total across
 * all pages. `countPastEnd=false` (EnableTotalRecordCount=false) skips the
 * extra count query when StartIndex lands past the end.
 */
export async function getResumeItemsPage(
    sql: postgres.Sql,
    userId: UserId | undefined,
    limit: number,
    access: MediaAccessBoundary,
    filters: ResumeFilters,
    countPastEnd = true,
): Promise<{ rows: postgres.RowList<postgres.Row[]>; totalCount: number }> {
    const rows = await getResumeItems(sql, userId, limit, access, filters);
    if (rows.length > 0) return { rows, totalCount: Number(rows[0].total_count) };
    if (!filters.startIndex || !countPastEnd) return { rows, totalCount: 0 };
    const probe = await getResumeItems(sql, userId, 1, access, { ...filters, startIndex: 0 });
    return { rows, totalCount: probe.length > 0 ? Number(probe[0].total_count) : 0 };
}

export interface NextUpPageOptions {
    /** Rows to skip (Jellyfin `StartIndex`). */
    startIndex?: number;
    /**
     * Jellyfin `ParentId`: a library (library group or synced Jellyfin
     * library id) or a series.
     */
    parentId?: string | null;
    /** Jellyfin `enableRewatching=false`: only unwatched next episodes. */
    requireUnwatchedNext?: boolean;
    /** Jellyfin `enableResumable=false`: drop next episodes already in progress. */
    excludeResumable?: boolean;
    /** Jellyfin `nextUpDateCutoff`. */
    minLastWatchedAt?: Date | null;
}

/**
 * Next-up episode per watched series.
 *
 * Pre-existing (deliberately preserved) behaviour: the `next_episodes` CTE picks
 * the single next unwatched episode per series with `DISTINCT ON` BEFORE the
 * access boundary is applied on the outer query. If that one episode is denied,
 * the series drops out of Next Up entirely rather than falling through to the
 * next permitted episode. Do not "fix" this here — it is a semantics change.
 */
/**
 * Next Up for the Jellyfin compatibility layer.
 *
 * Shares `buildNextUpCandidateCtes` with the web strip's `getNextUpFromDb`:
 * both anchor on the most-recently-watched episode and return the first
 * episode ordered after it. This query used to pick the *first unwatched
 * episode in the whole series* instead, so any gap behind the anchor —
 * an unwatched pilot, a skipped filler episode, a season the user never
 * needed — pinned Next Up to the start of the show forever. Finished shows
 * came back as "next" (TNG at S01E02 with 176/178 watched) and a re-watcher
 * on Sky Harbor S23 was offered S01E01.
 *
 * `seriesId` scopes the whole thing to one series (Jellyfin's `?seriesId=`).
 */
export async function getNextUpEpisodes(
    sql: postgres.Sql,
    userId: UserId,
    limit: number,
    access: MediaAccessBoundary,
    seriesId?: string | null,
    maxAgeDays = 0,
    page: NextUpPageOptions = {},
): Promise<postgres.RowList<postgres.Row[]>> {
    const { startIndex = 0, parentId = null, excludeResumable = false } = page;
    return sql`
        ${buildNextUpCandidateCtes(sql, {
            userId,
            maxAgeDays,
            seriesId,
            requireActiveStatus: true,
            requireUnwatchedNext: page.requireUnwatchedNext ?? false,
            minLastWatchedAt: page.minLastWatchedAt ?? null,
        })}
        SELECT
            COUNT(*) OVER() AS total_count,
            mi.id,
            mi.title,
            mi.original_title,
            mi.sort_title,
            mi.media_type,
            mi.year,
            mi.created_at,
            COALESCE(mi.runtime_seconds, (tmdb_pm.metadata->>'runtime')::int * 60) as runtime_seconds,
            mi.parent_id,
            ne.season_number,
            ne.episode_number,
            mi.overview as mi_overview,
            mi.premiere_date,
            (pm.metadata->>'overview')::text as pm_overview,
            COALESCE((pm.metadata->>'poster_path')::text, (tmdb_pm.metadata->>'poster_path')::text) as poster_path,
            COALESCE((pm.metadata->>'backdrop_path')::text, (tmdb_pm.metadata->>'backdrop_path')::text) as backdrop_path,
            (pm.metadata->>'vote_average')::float as vote_average,
            ne.series_id,
            series.title as series_name,
            season.id as season_id,
            season.title as season_name,
            ne.last_watched_at as last_activity,
            series_pm.poster_path as series_poster_path,
            series_pm.backdrop_path as series_backdrop_path
        FROM next_up_candidates ne
        JOIN media_items mi ON mi.id = ne.media_id
        JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
        LEFT JOIN media_items series ON series.id = ne.series_id
        ${buildMetadataLateralJoinFragment(sql)}
        LEFT JOIN LATERAL (
            SELECT metadata
            FROM provider_metadata
            WHERE media_id = mi.id AND provider = 'tmdb'
            LIMIT 1
        ) tmdb_pm ON true
        LEFT JOIN LATERAL (
            -- Extract the two paths inside the lateral: the outer SELECT list would
            -- otherwise detoast the series' whole tmdb jsonb once per output row per
            -- field (18 ms vs 2 ms for a 24-episode season of a large series).
            SELECT (metadata->>'poster_path')::text AS poster_path,
                   (metadata->>'backdrop_path')::text AS backdrop_path
            FROM provider_metadata
            WHERE media_id = ne.series_id AND provider = 'tmdb'
            LIMIT 1
        ) series_pm ON true
        WHERE 1=1
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildAgeRatingFilter(sql, access.age, 'series')}
          ${
              parentId
                  ? sql`AND (
              ne.series_id = ${parentId}::uuid
              OR EXISTS (
                  SELECT 1 FROM media_file_items _mfi
                  JOIN media_files _mf ON _mf.id = _mfi.file_id
                  WHERE _mfi.media_item_id = mi.id AND _mf.library_group_id = ${parentId}::uuid
              )
              OR EXISTS (
                  SELECT 1 FROM provider_metadata _jf
                  WHERE _jf.media_id = ne.series_id AND _jf.provider = 'jellyfin'
                    AND (_jf.metadata->>'jellyfin_library_id')::text = ${parentId}
              )
          )`
                  : sql``
          }
          ${
              excludeResumable
                  ? sql`AND NOT EXISTS (
              SELECT 1 FROM user_media_state _r
              WHERE _r.media_id = mi.id AND _r.user_id = ${userId}
                AND _r.resume_position_ms > 0 AND NOT _r.is_watched
          )`
                  : sql``
          }
        ORDER BY ne.last_watched_at DESC NULLS LAST, ne.series_id
        LIMIT ${limit}
        OFFSET ${startIndex}
    `;
}

/**
 * {@link getNextUpEpisodes} with Jellyfin paging: the page of rows plus the
 * total across all pages (also when StartIndex lands past the end).
 */
export async function getNextUpEpisodesPage(
    sql: postgres.Sql,
    userId: UserId,
    limit: number,
    access: MediaAccessBoundary,
    seriesId: string | null,
    maxAgeDays: number,
    page: NextUpPageOptions,
): Promise<{ rows: postgres.RowList<postgres.Row[]>; totalCount: number }> {
    const rows = await getNextUpEpisodes(sql, userId, limit, access, seriesId, maxAgeDays, page);
    if (rows.length > 0) return { rows, totalCount: Number(rows[0].total_count) };
    if (!page.startIndex) return { rows, totalCount: 0 };
    const probe = await getNextUpEpisodes(sql, userId, 1, access, seriesId, maxAgeDays, {
        ...page,
        startIndex: 0,
    });
    return { rows, totalCount: probe.length > 0 ? Number(probe[0].total_count) : 0 };
}

export async function getSeriesEpisodes(
    sql: postgres.Sql,
    options: SeriesEpisodesOptions,
): Promise<postgres.RowList<postgres.Row[]>> {
    const { enableUserData, userId, limit, startIndex } = options;
    return sql`
        SELECT
            mi.id,
            mi.title,
            mi.original_title,
            mi.sort_title,
            mi.media_type,
            mi.year,
            mi.created_at,
            COALESCE(mi.runtime_seconds, (tmdb_pm.metadata->>'runtime')::int * 60) as runtime_seconds,
            mi.parent_id,
            COALESCE(eo.order_season_number, mi.season_number) as season_number,
            COALESCE(eo.order_episode_number, mi.episode_number) as episode_number,
            mi.overview as mi_overview,
            mi.premiere_date,
            (pm.metadata->>'overview')::text as pm_overview,
            COALESCE((pm.metadata->>'poster_path')::text, (tmdb_pm.metadata->>'poster_path')::text) as poster_path,
            COALESCE((pm.metadata->>'backdrop_path')::text, (tmdb_pm.metadata->>'backdrop_path')::text) as backdrop_path,
            (pm.metadata->>'vote_average')::float as vote_average,
            (pm.metadata->>'content_rating')::text as content_rating,
            season.id as season_id,
            season.title as season_name,
            series.id as series_id,
            series.title as series_name,
            series_pm.poster_path as series_poster_path,
            series_pm.backdrop_path as series_backdrop_path,
            ${
                enableUserData
                    ? sql`
                ws.resume_position_ms,
                CASE WHEN ws.runtime_ms > 0 AND ws.resume_position_ms > 0
                    THEN (ws.resume_position_ms::float / ws.runtime_ms * 100)
                    ELSE 0
                END as played_percentage,
                COALESCE(ws.is_watched, false) as is_watched,
                ${lastPlayedAtExpression(sql, 'ws')} as last_played_at,
            `
                    : sql`
                NULL::bigint as resume_position_ms,
                0::float as played_percentage,
                false as is_watched,
                NULL::timestamptz as last_played_at,
            `
            }
            ${watchlistExistsFragment(sql, sql`mi.id`, sql`${userId ?? null}::uuid`)} as is_favorite
        FROM media_items mi
        JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
        JOIN media_items series ON series.id = season.parent_id AND series.media_type = 'tv'
        ${buildMetadataLateralJoinFragment(sql, undefined, 'mi.id', 'episode')}
        LEFT JOIN LATERAL (
            SELECT metadata
            FROM provider_metadata
            WHERE media_id = mi.id AND provider = 'tmdb' AND mi.media_type != 'episode'
            LIMIT 1
        ) tmdb_pm ON true
        LEFT JOIN LATERAL (
            -- Extract the two paths inside the lateral: the outer SELECT list would
            -- otherwise detoast the series' whole tmdb jsonb once per output row per
            -- field (18 ms vs 2 ms for a 24-episode season of a large series).
            SELECT (metadata->>'poster_path')::text AS poster_path,
                   (metadata->>'backdrop_path')::text AS backdrop_path
            FROM provider_metadata
            WHERE media_id = series.id AND provider = 'tmdb'
            LIMIT 1
        ) series_pm ON true
        ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi', 'season.parent_id')}
        ${enableUserData ? sql`LEFT JOIN user_media_state ws ON ws.media_id = mi.id AND ws.user_id = ${userId ?? null}::uuid` : sql``}
        WHERE ${seriesEpisodesWhere(sql, options)}
        ORDER BY ${seriesEpisodeOrder(sql)}
        LIMIT ${limit}
        OFFSET ${startIndex}
    `;
}

/** `Season` as a number, or null when absent / not numeric. */
function seasonNumberOf(seasonNumber: string | null | undefined): number | null {
    if (seasonNumber === null || seasonNumber === undefined) return null;
    const n = parseInt(seasonNumber, 10);
    return isNaN(n) ? null : n;
}

/**
 * The episode order of {@link getSeriesEpisodes} (display ordering first,
 * then the id so equal numbers still have one position).
 */
function seriesEpisodeOrder(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`
            COALESCE(eo.order_season_number, mi.season_number) ASC NULLS LAST,
            COALESCE(eo.order_episode_number, mi.episode_number) ASC NULLS LAST,
            mi.sort_order ASC NULLS LAST,
            mi.id ASC`;
}

/**
 * The rows {@link getSeriesEpisodes} lists. Shared with
 * {@link getSeriesEpisodePosition} so a position always indexes the listing.
 * Expects the aliases `mi` (episode), `season`, `series` and the ordering
 * joins (`seo`, `eo`).
 */
function seriesEpisodesWhere(
    sql: postgres.Sql,
    options: Pick<SeriesEpisodesOptions, 'seriesId' | 'seasonId' | 'seasonNumber' | 'access'>,
): postgres.PendingQuery<postgres.Row[]> {
    const { seriesId, seasonId, access } = options;
    const seasonNumberInt = seasonNumberOf(options.seasonNumber);
    return sql`mi.media_type = 'episode'
          AND mi.status = 'active'
          AND series.id = ${seriesId}
          ${buildFileBackedEpisodeFilter(sql)}
          ${seasonId ? sql`AND season.id = ${seasonId}` : sql``}
          ${seasonNumberInt !== null ? sql`AND COALESCE(eo.order_season_number, mi.season_number) = ${seasonNumberInt}` : sql``}
          ${buildAgeRatingFilter(sql, access.age, 'series')}
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildUnmappedEpisodeFilterFragment(sql, 'mi')}`;
}

/** How many episodes {@link getSeriesEpisodes} lists for these options. */
export async function countSeriesEpisodes(
    sql: postgres.Sql,
    options: Pick<SeriesEpisodesOptions, 'seriesId' | 'seasonId' | 'seasonNumber' | 'access'>,
): Promise<number> {
    const rows = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM media_items mi
        JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
        JOIN media_items series ON series.id = season.parent_id AND series.media_type = 'tv'
        ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi', 'season.parent_id')}
        WHERE ${seriesEpisodesWhere(sql, options)}
    `;
    return rows[0]?.count ?? 0;
}

export interface SeriesEpisodePosition {
    /** 0-based index of the episode in the listing. */
    index: number;
    /** Number of episodes in the listing. */
    total: number;
}

/**
 * Where `episodeId` sits in the {@link getSeriesEpisodes} listing for the
 * same series / season / access, and the listing's size. Null when the
 * episode is not part of it (other series, filtered out, not visible).
 * Serves `startItemId` and `AdjacentTo` on `/Shows/{id}/Episodes`.
 */
export async function getSeriesEpisodePosition(
    sql: postgres.Sql,
    options: Pick<SeriesEpisodesOptions, 'seriesId' | 'seasonId' | 'seasonNumber' | 'access'> & {
        episodeId: string;
    },
): Promise<SeriesEpisodePosition | null> {
    const rows = await sql<{ idx: number; total: number }[]>`
        SELECT idx, total FROM (
            SELECT mi.id,
                   (ROW_NUMBER() OVER (ORDER BY ${seriesEpisodeOrder(sql)}) - 1)::int AS idx,
                   (COUNT(*) OVER ())::int AS total
            FROM media_items mi
            JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
            JOIN media_items series ON series.id = season.parent_id AND series.media_type = 'tv'
            ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi', 'season.parent_id')}
            WHERE ${seriesEpisodesWhere(sql, options)}
        ) ordered
        WHERE id = ${options.episodeId}::uuid
    `;
    return rows[0] ? { index: rows[0].idx, total: rows[0].total } : null;
}

export async function getSeriesSeasons(
    sql: postgres.Sql,
    options: SeriesSeasonsOptions,
): Promise<postgres.RowList<postgres.Row[]>> {
    const { seriesId, enableUserData, userId, access } = options;
    return sql`
        SELECT
            mi.id,
            mi.title,
            mi.original_title,
            mi.sort_title,
            mi.media_type,
            mi.year,
            mi.created_at,
            COALESCE(mi.runtime_seconds, (tmdb_pm.metadata->>'runtime')::int * 60) as runtime_seconds,
            mi.parent_id,
            mi.season_number,
            mi.overview as mi_overview,
            mi.premiere_date,
            (pm.metadata->>'overview')::text as pm_overview,
            COALESCE((pm.metadata->>'poster_path')::text, (tmdb_pm.metadata->>'poster_path')::text) as poster_path,
            COALESCE((pm.metadata->>'backdrop_path')::text, (tmdb_pm.metadata->>'backdrop_path')::text) as backdrop_path,
            (pm.metadata->>'vote_average')::float as vote_average,
            series.id as series_id,
            series.title as series_name,
            (
                SELECT COUNT(*)::int
                FROM media_items ep
                WHERE ep.parent_id = mi.id
                  AND ep.media_type = 'episode'
                  AND ep.status = 'active'
                  AND ep.has_files = true
                  AND EXISTS (
                      SELECT 1
                      FROM media_file_items mfi
                      WHERE mfi.media_item_id = ep.id
                  )
            ) as child_count,
            ${
                enableUserData
                    ? sql`
                (
                    SELECT COUNT(*)::int
                    FROM media_items ep
                    LEFT JOIN user_media_state ep_ws ON ep_ws.media_id = ep.id AND ep_ws.user_id = ${userId ?? null}::uuid
                    WHERE ep.parent_id = mi.id
                      AND ep.media_type = 'episode'
                      AND ep.status = 'active'
                      AND ep.has_files = true
                      AND EXISTS (
                          SELECT 1
                          FROM media_file_items mfi
                          WHERE mfi.media_item_id = ep.id
                      )
                      AND COALESCE(ep_ws.is_watched, false) = false
                ) as unplayed_count,
                false as is_watched,
                false as is_favorite,
                NULL::bigint as resume_position_ms,
                0::float as played_percentage,
            `
                    : sql`
                NULL::int as unplayed_count,
                false as is_watched,
                false as is_favorite,
                NULL::bigint as resume_position_ms,
                0::float as played_percentage,
            `
            }
            NULL::text as season_id,
            NULL::text as season_name
        FROM media_items mi
        JOIN media_items series ON series.id = mi.parent_id AND series.media_type = 'tv'
        ${buildMetadataLateralJoinFragment(sql)}
        LEFT JOIN LATERAL (
            SELECT metadata
            FROM provider_metadata
            WHERE media_id = mi.id AND provider = 'tmdb'
            LIMIT 1
        ) tmdb_pm ON true
        WHERE mi.media_type = 'season'
          AND mi.status = 'active'
          AND series.id = ${seriesId}
          AND EXISTS (
              SELECT 1
              FROM media_items ep
              JOIN media_file_items mfi ON mfi.media_item_id = ep.id
              WHERE ep.parent_id = mi.id
                AND ep.media_type = 'episode'
                AND ep.status = 'active'
                AND ep.has_files = true
          )
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildAgeRatingFilter(sql, access.age, 'series')}
        ORDER BY
            mi.season_number ASC NULLS LAST,
            COALESCE(mi.sort_order, mi.season_number) ASC NULLS LAST
    `;
}

export async function enrichMediaItemsByIds(
    sql: postgres.Sql,
    mediaIds: string[],
    access: MediaAccessBoundary,
): Promise<postgres.RowList<postgres.Row[]>> {
    return sql`
        SELECT
            mi.id,
            mi.title,
            mi.original_title,
            mi.sort_title,
            mi.media_type,
            mi.year,
            mi.created_at,
            mi.runtime_seconds,
            mi.overview as mi_overview,
            mi.premiere_date,
            (pm.metadata->>'overview')::text as pm_overview,
            (pm.metadata->>'poster_path')::text as poster_path,
            (pm.metadata->>'backdrop_path')::text as backdrop_path,
            (pm.metadata->>'vote_average')::float as vote_average,
            (pm.metadata->>'content_rating')::text as content_rating,
            (pm.metadata->>'tagline')::text as tagline
        FROM media_items mi
        ${buildMetadataLateralJoinFragment(sql)}
        WHERE mi.id = ANY(${mediaIds}::uuid[])
          AND mi.status = 'active'
          AND mi.has_files = true
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildSeriesOwnedAgeRatingFilter(sql, access.age)}
    `;
}

export interface GenreWithCount {
    name: string;
    /** Movies + series (non-episode) carrying this genre, within the scoped library. */
    itemCount: number;
}

/**
 * Return distinct genres (with item counts) for all active media items in a
 * library group. When parentId is null, returns genres across all items.
 *
 * Only file-backed items count — the same availability rule /j Items browsing
 * applies (buildFileBackedVideoItemFilter). Without it, TMDB discovery rows
 * that never had files and items whose files were lost would add genre names
 * and inflate counts that browsing the genre then can't show.
 *
 * The count matters, not just the name: Jellyfin clients (e.g. Moonfin) fetch
 * ChildCount/ItemCounts alongside a genre list and drop any genre whose count
 * is 0 before rendering — an accurate list with no counts still renders as
 * "no genres found" client-side.
 *
 * Access filters are required so the genre taxonomy doesn't leak categories
 * that only exist on restricted media. When parentId is null and the user
 * has denied groups, only genres reachable through non-denied files (or
 * via items with no file rows) survive. age_rating applies to `mi`.
 */
export async function getDistinctGenresForLibrary(
    sql: postgres.Sql,
    parentId: string | null,
    access: MediaAccessBoundary,
): Promise<GenreWithCount[]> {
    // Plain-array return type, so the deny-everything case can short-circuit
    // without a round trip (the RowList-returning queries above cannot).
    if (deniesEverything(access)) return [];

    const libraryFilter = buildLibraryAccessFilter(sql, access.library);
    const ageFilter = buildSeriesOwnedAgeRatingFilter(sql, access.age);

    const rows = await sql<{ genre_name: string; item_count: number }[]>`
        SELECT (g->>'name')::text AS genre_name, COUNT(DISTINCT mi.id)::int AS item_count
        FROM media_items mi
        JOIN provider_metadata pm ON pm.media_id = mi.id
            AND pm.provider IN ('tmdb', 'musicbrainz', 'jellyfin')
            AND mi.media_type != 'episode'
        ${
            parentId
                ? sql`LEFT JOIN LATERAL (
              SELECT metadata
              FROM provider_metadata
              WHERE media_id = mi.id AND provider = 'jellyfin'
              LIMIT 1
          ) jf_pm ON true`
                : sql``
        }
        CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN pm.metadata->'genres' IS NOT NULL
                      AND jsonb_typeof(pm.metadata->'genres') = 'array'
                 THEN pm.metadata->'genres'
                 ELSE '[]'::jsonb
            END
        ) AS g
        WHERE mi.status = 'active'
          ${
              parentId
                  ? sql`AND (
              mi.parent_id = ${parentId}::uuid
              OR (jf_pm.metadata->>'jellyfin_library_id')::text = ${parentId}
              OR EXISTS (
                  SELECT 1 FROM media_file_items _mfi
                  JOIN media_files _mf ON _mf.id = _mfi.file_id
                  WHERE _mfi.media_item_id = mi.id AND _mf.library_group_id = ${parentId}::uuid
              )
              OR EXISTS (
                  -- TV/anime: the series itself has no files — only its
                  -- episodes (via season) do. Same chain browseMediaItems uses.
                  SELECT 1 FROM media_items _ep
                  JOIN media_items _season ON _season.id = _ep.parent_id
                  JOIN media_file_items _mfi ON _mfi.media_item_id = _ep.id
                  JOIN media_files _mf ON _mf.id = _mfi.file_id
                  WHERE _season.parent_id = mi.id AND _mf.library_group_id = ${parentId}::uuid
              )
              OR EXISTS (
                  SELECT 1 FROM media_items _child
                  JOIN media_file_items _mfi ON _mfi.media_item_id = _child.id
                  JOIN media_files _mf ON _mf.id = _mfi.file_id
                  WHERE _child.parent_id = mi.id AND _mf.library_group_id = ${parentId}::uuid
              )
          )`
                  : sql``
          }
          AND (g->>'name') IS NOT NULL
          ${buildFileBackedVideoItemFilter(sql, true)}
          ${libraryFilter}
          ${ageFilter}
        GROUP BY genre_name
        ORDER BY genre_name
    `;
    return rows.map((r) => ({ name: r.genre_name, itemCount: r.item_count }));
}

/** Jellyfin `ItemCounts` inputs, per Lumastra media type. */
export interface LibraryItemCounts {
    movie: number;
    tv: number;
    episode: number;
    artist: number;
    album: number;
    track: number;
}

/**
 * Item counts behind Jellyfin's `GET /Items/Counts`: file-backed items the
 * user may see (library + age boundary), optionally only their favourites
 * (`isFavorite=true`) or only the rest (`false`). Same availability rule as
 * /Items browsing, so a count never promises rows a listing can't show.
 */
export async function getLibraryItemCounts(
    sql: postgres.Sql,
    options: { access: MediaAccessBoundary; userId: UserId; isFavorite?: boolean | null },
): Promise<LibraryItemCounts> {
    const counts: LibraryItemCounts = {
        movie: 0,
        tv: 0,
        episode: 0,
        artist: 0,
        album: 0,
        track: 0,
    };
    if (deniesEverything(options.access)) return counts;
    const types = Object.keys(counts);
    const fav = watchlistExistsFragment(sql, sql`mi.id`, sql`${options.userId}::uuid`);
    const rows = await sql<{ media_type: keyof LibraryItemCounts; n: number }[]>`
        SELECT mi.media_type, COUNT(*)::int AS n
        FROM media_items mi
        WHERE mi.status = 'active'
          AND mi.media_type = ANY(${types}::text[])
          ${buildFileBackedVideoItemFilter(sql, true, types)}
          ${options.isFavorite === true ? sql`AND ${fav}` : sql``}
          ${options.isFavorite === false ? sql`AND NOT ${fav}` : sql``}
          ${buildLibraryAccessFilter(sql, options.access.library)}
          ${buildSeriesOwnedAgeRatingFilter(sql, options.access.age)}
        GROUP BY mi.media_type
    `;
    for (const r of rows) counts[r.media_type] = r.n;
    return counts;
}
