// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `GET /Genres` and `GET /MusicGenres` (GenresController.GetGenres,
 * MusicGenresController.GetMusicGenres): by-name lists over the items the
 * user can see, with Jellyfin's ParentId / IncludeItemTypes / ExcludeItemTypes
 * scoping, name filters, sorting, paging and item counts.
 */

import type postgres from 'postgres';
import {
    getJellyfinGenres,
    JELLYFIN_ITEM_MEDIA_TYPES,
    type ScopedMusicGenre,
} from '$lib/server/database/queries/jellyfin-filters.queries';
import { mapJellyfinTypes } from '$lib/server/database/queries/jellyfin-browse.queries';
import { getGenreCoverAlbums } from '$lib/server/database/queries/music.queries.js';
import type { JellyfinAccessContext } from './access-context';
import {
    applyNameListQuery,
    DEFAULT_GENRE_MEDIA_TYPES,
    listVisibleVideoGenres,
    normalizedTypeKey,
    scopedGenreCache,
    parseNameListQuery,
    serializeGenre,
    type NameListQuery,
} from './genres';
import { resolveParentScope, type ParentScope } from './item-filters';
import { listMusicGenresUnder, listVisibleMusicGenres, serializeMusicGenre } from './music-genres';
import type { JellyfinItemsResponse } from './types';
import { getParam } from './utils';

/** Genres per page that get a cover image tag (the rest are sent without one). */
const COVER_LOOKUP_MAX = 200;

async function musicGenreRows(
    sql: postgres.Sql,
    scope: ParentScope,
    access: JellyfinAccessContext,
): Promise<ScopedMusicGenre[]> {
    if (scope.kind === 'root') return listVisibleMusicGenres(sql, access);
    // A track is no folder; Jellyfin would list that one track's genres. Not
    // worth a query of its own — no client browses genres under a song.
    if (scope.kind === 'item') return [];
    return listMusicGenresUnder(sql, scope.parentId, access);
}

/** Music genres carrying at least one item of the requested kinds. */
function filterMusicKinds(rows: ScopedMusicGenre[], q: NameListQuery): ScopedMusicGenre[] {
    const include = mapJellyfinTypes(q.includeItemTypes.join(','));
    const exclude = new Set(mapJellyfinTypes(q.excludeItemTypes.join(',')));
    const kinds = (include.length > 0 ? include : ['track', 'album', 'artist']).filter(
        (k) => !exclude.has(k),
    );
    return rows.filter(
        (r) =>
            (kinds.includes('track') && r.track_count > 0) ||
            (kinds.includes('album') && r.album_count > 0) ||
            // An artist row carries no genre of its own; a genre with tracks has artists.
            (kinds.includes('artist') && r.track_count > 0),
    );
}

async function musicGenrePage(
    sql: postgres.Sql,
    rows: ScopedMusicGenre[],
    q: NameListQuery,
    access: JellyfinAccessContext,
): Promise<JellyfinItemsResponse> {
    const { page, total } = applyNameListQuery(
        filterMusicKinds(rows, q),
        q,
        (r) => r.genre,
        (r) => r.track_count,
    );
    // One lateral probe per genre: bounded, so a Limit-less list of thousands
    // of tags does not turn into thousands of cover lookups.
    const covers = await getGenreCoverAlbums(
        sql,
        page.slice(0, COVER_LOOKUP_MAX).map((r) => r.genre),
        { deniedGroupIds: access.deniedGroupIds, ageRating: access.ageRating },
        1,
    );
    const coverByGenre = new Map(covers.map((c) => [c.genre.toLowerCase(), c.album_id]));
    return {
        Items: page.map((r) =>
            serializeMusicGenre(
                { name: r.genre, trackCount: r.track_count, albumCount: r.album_count },
                coverByGenre.get(r.genre.toLowerCase()) ?? null,
            ),
        ),
        TotalRecordCount: total,
        StartIndex: q.startIndex,
    };
}

/** `GET /Genres`. A music library ParentId lists music genres, like Jellyfin. */
export async function listGenres(
    sql: postgres.Sql,
    url: URL,
    access: JellyfinAccessContext,
): Promise<JellyfinItemsResponse> {
    const q = parseNameListQuery(url);
    const scope = await resolveParentScope(sql, getParam(url, 'ParentId'));
    if (scope.kind === 'library' && scope.music) {
        return musicGenrePage(sql, await musicGenreRows(sql, scope, access), q, access);
    }

    const include = mapJellyfinTypes(q.includeItemTypes.join(','));
    const exclude = mapJellyfinTypes(q.excludeItemTypes.join(','));
    // The movie/series default only fits a library or the root: below a
    // series, album or artist the genres come from its descendants.
    const mediaTypes =
        include.length > 0
            ? include
            : scope.kind === 'folder' || scope.kind === 'item'
              ? [...JELLYFIN_ITEM_MEDIA_TYPES]
              : DEFAULT_GENRE_MEDIA_TYPES;
    const genres =
        scope.kind === 'root' && include.length === 0 && exclude.length === 0
            ? await listVisibleVideoGenres(sql, access)
            : await scopedGenreCache.get(
                  access,
                  `${scope.kind === 'root' ? '' : scope.kind === 'item' ? scope.itemId : scope.parentId}|${scope.kind === 'item' ? 'i' : ''}|${normalizedTypeKey(mediaTypes)}|${normalizedTypeKey(exclude)}|r`,
                  () =>
                      getJellyfinGenres(sql, {
                          parentId:
                              scope.kind === 'library' || scope.kind === 'folder'
                                  ? scope.parentId
                                  : null,
                          itemIds: scope.kind === 'item' ? [scope.itemId] : undefined,
                          mediaTypes,
                          excludeMediaTypes: exclude,
                          recursive: true,
                          access: access.boundary,
                      }),
              );
    const { page, total } = applyNameListQuery(
        genres,
        q,
        (g) => g.name,
        (g) => g.total,
    );
    return {
        Items: page.map((g) => serializeGenre(g, q.itemCounts)),
        TotalRecordCount: total,
        StartIndex: q.startIndex,
    };
}

/** `GET /MusicGenres` (deprecated in Jellyfin 10.9, still called by music apps). */
export async function listMusicGenres(
    sql: postgres.Sql,
    url: URL,
    access: JellyfinAccessContext,
): Promise<JellyfinItemsResponse> {
    const q = parseNameListQuery(url);
    const scope = await resolveParentScope(sql, getParam(url, 'ParentId'));
    return musicGenrePage(sql, await musicGenreRows(sql, scope, access), q, access);
}
