// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Genres and other by-name lists on the /j surface (`/Genres`, `/MusicGenres`,
 * the genre branch of `/Search/Hints`, `/Items/Filters2`).
 *
 * A (video) genre's Id is the md5 of its lower-cased trimmed name, the same
 * hex `/j` items carry in `GenreItems[].Id`, dashed as a UUID. That is the Id
 * `/Items?GenreIds=` matches, so a genre picked from any list filters items.
 * `/Genres` used to issue md5("genre:" + name); {@link genreIdCandidates}
 * still resolves it.
 */

import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import {
    getJellyfinGenres,
    JELLYFIN_ITEM_MEDIA_TYPES,
    type ScopedGenre,
} from '$lib/server/database/queries/jellyfin-filters.queries';
import { UUID_RE_LOOSE } from '$lib/utils/id-patterns';
import type { JellyfinAccessContext } from './access-context';
import { AccessKeyedCache } from './access-keyed-cache';
import { JELLYFIN_SERVER_ID, USER_ROOT_FOLDER_ID } from './constants';
import type { JellyfinBaseItemDto } from './types';
import { getParam, getSearchTermParam } from './utils';

function md5Hex(value: string): string {
    return createHash('md5').update(value).digest('hex');
}

function dashed(hex: string): string {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The Id of a video genre (dashed form of the item `GenreItems[].Id`). */
export function genreId(name: string): string {
    return dashed(md5Hex(name.trim().toLowerCase()));
}

/** Every Id a /j response may have used for this genre, lower-cased and undashed. */
export function genreIdCandidates(name: string): string[] {
    return [md5Hex(name.trim().toLowerCase()), md5Hex('genre:' + name.toLowerCase())];
}

/** `ParentId=<user root folder>` (from `/Items/Root`) means no parent, like Jellyfin. */
export function normalizeParentId(parentId: string | null): string | null {
    const trimmed = parentId?.trim();
    if (!trimmed) return null;
    return trimmed.replace(/-/g, '').toLowerCase() === USER_ROOT_FOLDER_ID ? null : trimmed;
}

/**
 * Jellyfin binds `ParentId` as a Guid: anything else is a model-binding
 * error (400; here the project's validation error). Absent or blank is fine.
 */
export function hasValidParentId(url: URL): boolean {
    const raw = getParam(url, 'ParentId')?.trim();
    return !raw || UUID_RE_LOOSE.test(raw);
}

export function parseBoolParam(value: string | null): boolean | null {
    if (value === null) return null;
    const v = value.trim().toLowerCase();
    return v === 'true' ? true : v === 'false' ? false : null;
}

export function csvParam(value: string | null): string[] {
    return value
        ? value
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean)
        : [];
}

// ---------------------------------------------------------------------------
// Jellyfin program flags (IsMovie / IsSeries / IsKids / IsNews / IsSports / IsAiring)
// ---------------------------------------------------------------------------

export interface ProgramFlags {
    isMovie: boolean | null;
    isSeries: boolean | null;
    isKids: boolean | null;
    isNews: boolean | null;
    isSports: boolean | null;
    isAiring: boolean | null;
}

export function parseProgramFlags(url: URL): ProgramFlags {
    return {
        isMovie: parseBoolParam(getParam(url, 'IsMovie')),
        isSeries: parseBoolParam(getParam(url, 'IsSeries')),
        isKids: parseBoolParam(getParam(url, 'IsKids')),
        isNews: parseBoolParam(getParam(url, 'IsNews')),
        isSports: parseBoolParam(getParam(url, 'IsSports')),
        isAiring: parseBoolParam(getParam(url, 'IsAiring')),
    };
}

/**
 * Whether Jellyfin's program flags rule out every library item
 * (BaseItemRepository.TranslateQuery). Those flags are Live TV program
 * attributes: a library item has IsMovie = IsSeries = false, no start/end
 * date and (in Lumastra) no Kids/News/Sports tags. So
 * - `IsMovie=true` filters nothing when no type or Movie/Trailer is asked
 *   for, otherwise it wants IsMovie items: none;
 * - `IsSeries=true` and `IsKids|IsNews|IsSports=true` want flagged items: none;
 * - `IsAiring` (either value) compares dates the items do not have: none;
 * - every `=false` form matches every library item.
 *
 * @param includeItemTypes Jellyfin `IncludeItemTypes` names as sent.
 */
export function programFlagsExcludeLibraryItems(
    flags: ProgramFlags,
    includeItemTypes: string[],
): boolean {
    if (flags.isAiring !== null) return true;
    if (flags.isSeries === true || flags.isKids === true) return true;
    if (flags.isNews === true || flags.isSports === true) return true;
    if (flags.isMovie === true) {
        const kinds = includeItemTypes.map((t) => t.toLowerCase());
        const movieAllowed =
            kinds.length === 0 || kinds.includes('movie') || kinds.includes('trailer');
        if (!movieAllowed) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// By-name list parameters (GenresController / MusicGenresController)
// ---------------------------------------------------------------------------

type NameSortKey = 'name' | 'count' | 'random';

export interface NameListQuery {
    startIndex: number;
    limit: number | null;
    searchTerm: string | null;
    nameStartsWith: string | null;
    nameStartsWithOrGreater: string | null;
    nameLessThan: string | null;
    sort: { key: NameSortKey; descending: boolean }[];
    isFavorite: boolean | null;
    enableTotalRecordCount: boolean;
    /** `Fields=ItemCounts`, or any `IncludeItemTypes` (Jellyfin adds ItemCounts then). */
    itemCounts: boolean;
    includeItemTypes: string[];
    excludeItemTypes: string[];
}

/** Hard cap on one page; a genre list is small, so no Limit means "all of it". */
export const NAME_LIST_MAX = 5000;

const SORT_KEYS: Record<string, NameSortKey> = {
    sortname: 'name',
    name: 'name',
    random: 'random',
    // Not Jellyfin ItemSortBy values, but what some clients send for "most items".
    itemcounts: 'count',
    childcount: 'count',
    songcount: 'count',
    albumcount: 'count',
    moviecount: 'count',
    seriescount: 'count',
};

export function parseNameListQuery(url: URL): NameListQuery {
    const rawLimit = getParam(url, 'Limit');
    const parsedLimit = rawLimit === null ? NaN : parseInt(rawLimit, 10);
    const keys = csvParam(getParam(url, 'SortBy'));
    const orders = csvParam(getParam(url, 'SortOrder')).map(
        (o) => o.toLowerCase() === 'descending',
    );
    const sort: NameListQuery['sort'] = [];
    keys.forEach((raw, i) => {
        const key = SORT_KEYS[raw.toLowerCase()];
        if (!key || sort.some((s) => s.key === key)) return;
        sort.push({ key, descending: orders[i] ?? orders[0] ?? false });
    });
    const includeItemTypes = csvParam(getParam(url, 'IncludeItemTypes'));
    const fields = csvParam(getParam(url, 'Fields')).map((f) => f.toLowerCase());
    return {
        startIndex: Math.max(0, parseInt(getParam(url, 'StartIndex') ?? '0', 10) || 0),
        limit: isNaN(parsedLimit) ? null : Math.min(Math.max(0, parsedLimit), NAME_LIST_MAX),
        searchTerm: getSearchTermParam(url)?.trim() || null,
        nameStartsWith: getParam(url, 'NameStartsWith') || null,
        nameStartsWithOrGreater: getParam(url, 'NameStartsWithOrGreater') || null,
        nameLessThan: getParam(url, 'NameLessThan') || null,
        sort,
        isFavorite: parseBoolParam(getParam(url, 'IsFavorite')),
        enableTotalRecordCount: parseBoolParam(getParam(url, 'EnableTotalRecordCount')) !== false,
        itemCounts: includeItemTypes.length > 0 || fields.includes('itemcounts'),
        includeItemTypes,
        excludeItemTypes: csvParam(getParam(url, 'ExcludeItemTypes')),
    };
}

/** Jellyfin's search-term normalisation (lower-case, no diacritics). */
export function foldName(value: string): string {
    return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function matchesNameFilters(name: string, q: NameListQuery): boolean {
    const sortName = name.toLowerCase();
    if (q.searchTerm && !foldName(name).includes(foldName(q.searchTerm))) return false;
    if (q.nameStartsWith) {
        const prefix = q.nameStartsWith.toLowerCase();
        if (prefix === '#' ? /^[a-z]/.test(sortName) : !sortName.startsWith(prefix)) return false;
    }
    if (q.nameStartsWithOrGreater && sortName < q.nameStartsWithOrGreater.toLowerCase()) {
        return false;
    }
    if (q.nameLessThan && sortName >= q.nameLessThan.toLowerCase()) return false;
    return true;
}

export interface NameListPage<T> {
    page: T[];
    total: number;
}

/**
 * Filter, sort and page a by-name list the way Jellyfin's GetItemsByName does.
 * Lumastra has no favourite genres, so `IsFavorite=true` is empty and
 * `IsFavorite=false` is everything. Without EnableTotalRecordCount the total
 * is the page length (Jellyfin's QueryResult with a null count).
 */
export function applyNameListQuery<T>(
    entries: T[],
    q: NameListQuery,
    name: (entry: T) => string,
    count: (entry: T) => number,
): NameListPage<T> {
    if (q.isFavorite === true) return { page: [], total: 0 };
    const filtered = entries.filter((e) => matchesNameFilters(name(e), q));
    const byName = (a: T, b: T): number =>
        name(a).toLowerCase().localeCompare(name(b).toLowerCase());
    const sort = q.sort.length > 0 ? q.sort : [{ key: 'name' as const, descending: false }];
    if (sort[0].key === 'random') {
        for (let i = filtered.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
        }
    } else {
        filtered.sort((a, b) => {
            for (const s of sort) {
                if (s.key === 'random') continue;
                const d = s.key === 'count' ? count(a) - count(b) : byName(a, b);
                if (d !== 0) return s.descending ? -d : d;
            }
            return byName(a, b);
        });
    }
    const limit = q.limit ?? NAME_LIST_MAX;
    const page = filtered.slice(q.startIndex, q.startIndex + limit);
    return { page, total: q.enableTotalRecordCount ? filtered.length : page.length };
}

// ---------------------------------------------------------------------------
// Genre DTOs
// ---------------------------------------------------------------------------

/** `BaseItemDto` of Type Genre, the shape Jellyfin's GenresController returns. */
export function serializeGenre(genre: ScopedGenre, itemCounts: boolean): JellyfinBaseItemDto {
    const id = genreId(genre.name);
    const dto: JellyfinBaseItemDto = {
        Name: genre.name,
        Id: id,
        ServerId: JELLYFIN_SERVER_ID,
        Type: 'Genre',
        Etag: id.replace(/-/g, ''),
        IsFolder: true,
        ChannelId: null,
        SortName: genre.name.toLowerCase(),
        MediaType: 'Unknown',
        LocationType: 'FileSystem',
        // Always sent: clients (Moonfin) drop genres whose count is 0 or absent.
        ChildCount: genre.total,
        ImageTags: {},
        BackdropImageTags: [],
        ImageBlurHashes: {},
        ProviderIds: {},
        ExternalUrls: [],
        Genres: [],
        GenreItems: [],
        Taglines: [],
    };
    if (itemCounts) {
        dto.MovieCount = genre.counts.movie ?? 0;
        dto.SeriesCount = genre.counts.tv ?? 0;
        dto.EpisodeCount = genre.counts.episode ?? 0;
        dto.AlbumCount = genre.counts.album ?? 0;
        dto.SongCount = genre.counts.track ?? 0;
        dto.ArtistCount = genre.counts.artist ?? 0;
    }
    return dto;
}

/** The DB types `/Genres` counts when the client names none (movies and series). */
export const DEFAULT_GENRE_MEDIA_TYPES = ['movie', 'tv'];

// ---------------------------------------------------------------------------
// Cached library-wide genre list (search hints, /Genres/{name})
// ---------------------------------------------------------------------------

/**
 * Library-wide genres for one access boundary, cached briefly: the aggregate
 * reads every provider row in scope, and the search-hints genre branch would
 * otherwise run it on every keystroke.
 */
export const GENRE_CACHE_TTL_MS = 60_000;
export const genreCache = new AccessKeyedCache<ScopedGenre[]>(GENRE_CACHE_TTL_MS, 128);

/**
 * Genres for an explicit scope (ParentId and/or IncludeItemTypes/ExcludeItemTypes).
 * Keys are client-controlled, so they are normalised ({@link scopedGenreKey}) and
 * capped per access key: one user cycling variants evicts only their own entries.
 */
export const SCOPED_GENRE_MAX_PER_ACCESS = 32;
export const scopedGenreCache = new AccessKeyedCache<ScopedGenre[]>(
    GENRE_CACHE_TTL_MS,
    256,
    SCOPED_GENRE_MAX_PER_ACCESS,
);

/** Canonical cache-key part for a type list: lowercase, deduped, sorted. */
export function normalizedTypeKey(types: readonly string[]): string {
    return [...new Set(types.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort().join(',');
}

/** Movie and series genres (what `/Genres` lists by default). */
export function listVisibleVideoGenres(
    sql: postgres.Sql,
    access: JellyfinAccessContext,
): Promise<ScopedGenre[]> {
    return genreCache.get(access, 'video', () =>
        getJellyfinGenres(sql, {
            parentId: null,
            mediaTypes: DEFAULT_GENRE_MEDIA_TYPES,
            access: access.boundary,
        }),
    );
}

/** Genres of every /j item type (episodes and music items included). */
function listAllVisibleGenres(
    sql: postgres.Sql,
    access: JellyfinAccessContext,
): Promise<ScopedGenre[]> {
    return genreCache.get(access, 'all', () =>
        getJellyfinGenres(sql, {
            parentId: null,
            mediaTypes: [...JELLYFIN_ITEM_MEDIA_TYPES],
            access: access.boundary,
        }),
    );
}

/** Test hook. */
export function clearVideoGenreCache(): void {
    genreCache.clear();
    scopedGenreCache.clear();
}

/**
 * A visible video genre by name (case-insensitive), by any of its Ids, or by
 * Jellyfin's slug spelling (`-` standing for `&`, `/` or `?`). Null when the
 * user can see no item carrying it.
 */
export async function resolveGenre(
    sql: postgres.Sql,
    nameOrId: string,
    access: JellyfinAccessContext,
): Promise<ScopedGenre | null> {
    const needle = nameOrId.trim().toLowerCase();
    if (!needle) return null;
    // Movie/series genres first (cached for /Genres and search anyway); a genre
    // only episodes or music items carry is looked up in the full list.
    return (
        findGenre(await listVisibleVideoGenres(sql, access), needle) ??
        findGenre(await listAllVisibleGenres(sql, access), needle)
    );
}

function findGenre(genres: ScopedGenre[], needle: string): ScopedGenre | null {
    const byName = (n: string): ScopedGenre | undefined =>
        genres.find((g) => g.name.trim().toLowerCase() === n);
    const compactId = needle.replace(/-/g, '');
    return (
        byName(needle) ??
        (needle.includes('-')
            ? (byName(needle.replace(/-/g, '&')) ??
              byName(needle.replace(/-/g, '/')) ??
              byName(needle.replace(/-/g, '?')))
            : undefined) ??
        genres.find((g) => genreIdCandidates(g.name).includes(compactId)) ??
        null
    );
}
