// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `GET /Items/Filters` (QueryFiltersLegacy) and `GET /Items/Filters2`
 * (QueryFilters) — the values a client's filter menu offers for a library or
 * folder (Jellyfin FilterController).
 *
 * Values are computed over the items the user can access in that scope, with
 * the same scope and genre source `/Items` filters on, so every offered video
 * genre, rating and year returns rows when picked. Music genres are the track
 * genre tags `/MusicGenres` serves (Ids resolve there and in the genre
 * mixes); `/Items` cannot filter on those yet.
 *
 * Tags are the TMDB keywords items carry as `Tags` and `/Items?Tags=`
 * filters on (empty for music, which has none).
 */

import type postgres from 'postgres';
import {
    getItemMediaType,
    getJellyfinFilterValues,
    type JellyfinFilterValues,
    isMusicLibraryGroup,
    JELLYFIN_MUSIC_MEDIA_TYPES,
    type JellyfinScope,
} from '$lib/server/database/queries/jellyfin-filters.queries';
import {
    mapJellyfinMediaTypes,
    mapJellyfinTypes,
} from '$lib/server/database/queries/jellyfin-browse.queries';
import type { JellyfinAccessContext } from './access-context';
import { AccessKeyedCache } from './access-keyed-cache';
import {
    csvParam,
    genreId,
    normalizedTypeKey,
    normalizeParentId,
    parseBoolParam,
    parseProgramFlags,
    programFlagsExcludeLibraryItems,
} from './genres';
import { listMusicGenresUnder, listVisibleMusicGenres, musicGenreId } from './music-genres';
import type { JellyfinQueryFilters, JellyfinQueryFiltersLegacy } from './types';
import { getParam } from './utils';

const FOLDER_TYPES = ['tv', 'season', 'album', 'artist'];

export const EMPTY_FILTERS_LEGACY: JellyfinQueryFiltersLegacy = {
    Genres: [],
    Tags: [],
    OfficialRatings: [],
    Years: [],
};

export const EMPTY_FILTERS: JellyfinQueryFilters = { Genres: [], Tags: [] };

/** What a `ParentId` names. */
export type ParentScope =
    | { kind: 'root' }
    | { kind: 'library'; parentId: string; music: boolean }
    | { kind: 'folder'; parentId: string }
    /** A playable item (movie, episode, track): not a folder in Jellyfin. */
    | { kind: 'item'; itemId: string };

export async function resolveParentScope(
    sql: postgres.Sql,
    rawParentId: string | null,
): Promise<ParentScope> {
    const parentId = normalizeParentId(rawParentId);
    if (!parentId) return { kind: 'root' };
    const mediaType = await getItemMediaType(sql, parentId);
    if (mediaType === null) {
        // A library group (or a Jellyfin-imported library id). An id that names
        // nothing scopes to nothing — the parent predicate matches no row.
        return { kind: 'library', parentId, music: await isMusicLibraryGroup(sql, parentId) };
    }
    if (FOLDER_TYPES.includes(mediaType)) return { kind: 'folder', parentId };
    return { kind: 'item', itemId: parentId };
}

/**
 * Filter values are cached briefly per access boundary and normalised scope
 * (parent, sorted/deduped/lowercased types, canonical recursive flag): clients
 * ask for them on every library screen and the aggregate reads every item in
 * scope. IncludeItemTypes/Recursive/ParentId are client-controlled, so each
 * access key may hold at most FILTER_CACHE_MAX_PER_ACCESS variants (oldest of
 * its own evicted first); one user cannot push others' entries out.
 */
const FILTER_CACHE_TTL_MS = 60_000;
const FILTER_CACHE_MAX_PER_ACCESS = 32;
const rootFilterCache = new AccessKeyedCache<JellyfinFilterValues>(
    FILTER_CACHE_TTL_MS,
    256,
    FILTER_CACHE_MAX_PER_ACCESS,
);

/** Test hook. */
export function clearItemFilterCache(): void {
    rootFilterCache.clear();
}

function filterValues(
    sql: postgres.Sql,
    scope: JellyfinScope,
    access: JellyfinAccessContext,
): Promise<JellyfinFilterValues> {
    if (scope.itemIds) return getJellyfinFilterValues(sql, scope);
    const key = `${scope.parentId?.toLowerCase() ?? ''}|${normalizedTypeKey(scope.mediaTypes)}|${scope.recursive ? 'r' : ''}`;
    return rootFilterCache.get(access, key, () => getJellyfinFilterValues(sql, scope));
}

/** `IncludeItemTypes` ∩ `MediaTypes`, as DB media types; null = no restriction. */
function requestedTypes(url: URL): string[] | null {
    const include = getParam(url, 'IncludeItemTypes');
    const media = getParam(url, 'MediaTypes');
    let types: string[] | null = include ? mapJellyfinTypes(include) : null;
    if (media) {
        const playable = mapJellyfinMediaTypes(media);
        types = types ? types.filter((t) => playable.includes(t)) : playable;
    }
    return types;
}

/** Every requested type is a music type (Jellyfin then lists music genres). */
function isMusicRequest(types: string[] | null, scope: ParentScope): boolean {
    if (types && types.length > 0) {
        return types.every((t) => JELLYFIN_MUSIC_MEDIA_TYPES.includes(t));
    }
    return scope.kind === 'library' && scope.music;
}

async function musicGenreNames(
    sql: postgres.Sql,
    scope: ParentScope,
    access: JellyfinAccessContext,
): Promise<string[]> {
    const rows =
        scope.kind === 'root'
            ? await listVisibleMusicGenres(sql, access)
            : scope.kind === 'item'
              ? []
              : await listMusicGenresUnder(sql, scope.parentId, access);
    return rows.map((r) => r.genre).sort((a, b) => a.localeCompare(b));
}

function scopeFor(
    scope: ParentScope,
    types: string[] | null,
    recursive: boolean,
    access: JellyfinAccessContext,
): JellyfinScope {
    return {
        parentId: scope.kind === 'library' || scope.kind === 'folder' ? scope.parentId : null,
        mediaTypes: types ?? [],
        // A library is searched recursively whatever the client says (Jellyfin:
        // a CollectionFolder parent always becomes an ancestor filter).
        recursive: scope.kind === 'library' || recursive,
        access: access.boundary,
    };
}

/** `GET /Items/Filters` — genres, tags, official ratings and years in scope (always recursive). */
export async function getLegacyQueryFilters(
    sql: postgres.Sql,
    url: URL,
    access: JellyfinAccessContext,
): Promise<JellyfinQueryFiltersLegacy> {
    const types = requestedTypes(url);
    if (types !== null && types.length === 0) return EMPTY_FILTERS_LEGACY;
    const scope = await resolveParentScope(sql, getParam(url, 'ParentId'));
    // Jellyfin: a parent that is not a folder has no filters.
    if (scope.kind === 'item') return EMPTY_FILTERS_LEGACY;

    const values = await filterValues(sql, scopeFor(scope, types, true, access), access);
    const genres = isMusicRequest(types, scope)
        ? await musicGenreNames(sql, scope, access)
        : values.genres;
    return {
        Genres: genres,
        Tags: values.tags,
        OfficialRatings: values.officialRatings,
        Years: values.years,
    };
}

/** `GET /Items/Filters2` — genres (name + Id) and tags in scope. */
export async function getQueryFilters(
    sql: postgres.Sql,
    url: URL,
    access: JellyfinAccessContext,
): Promise<JellyfinQueryFilters> {
    const includeItemTypes = csvParam(getParam(url, 'IncludeItemTypes'));
    if (programFlagsExcludeLibraryItems(parseProgramFlags(url), includeItemTypes)) {
        return EMPTY_FILTERS;
    }
    const types = includeItemTypes.length > 0 ? mapJellyfinTypes(includeItemTypes.join(',')) : null;
    const scope = await resolveParentScope(sql, getParam(url, 'ParentId'));
    // A movie/episode/track has no descendants to take genres from.
    if (scope.kind === 'item') return EMPTY_FILTERS;

    if (isMusicRequest(types, scope)) {
        const names = await musicGenreNames(sql, scope, access);
        return { Genres: names.map((Name) => ({ Name, Id: musicGenreId(Name) })), Tags: [] };
    }
    const recursive = parseBoolParam(getParam(url, 'Recursive')) ?? true;
    const values = await filterValues(sql, scopeFor(scope, types, recursive, access), access);
    return {
        Genres: values.genres.map((Name) => ({ Name, Id: genreId(Name) })),
        Tags: values.tags,
    };
}
