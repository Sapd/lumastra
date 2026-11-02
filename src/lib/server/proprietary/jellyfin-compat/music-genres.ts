// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Music genres on the /j surface.
 *
 * Lumastra has no genre rows: a music genre is a tag on its tracks
 * (`music_genre_tags(custom_metadata)`). Jellyfin clients still address a genre
 * by Id (`/MusicGenres/InstantMix?id=`) or by name (`/MusicGenres/{name}`), so
 * the Id is derived from the name and resolved back by matching it against the
 * genres the caller can see.
 *
 * Three Id spellings are in circulation on /j and all of them resolve:
 * - `musicGenreId` — what `GET /j/MusicGenres` and `GET /j/MusicGenres/{name}` return;
 * - `GET /j/Genres`'s md5("genre:" + lowercased name), formatted as a UUID;
 * - `GenreItems[].Id` on items: md5(lowercased trimmed name), bare hex.
 */

import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import {
    getDistinctMusicGenres,
    getGenreCoverAlbums,
    type MusicGenreRow,
} from '$lib/server/database/queries/music.queries.js';
import {
    getJellyfinMusicGenresUnder,
    type ScopedMusicGenre,
} from '$lib/server/database/queries/jellyfin-filters.queries';
import type { JellyfinAccessContext } from './access-context';
import { AccessKeyedCache } from './access-keyed-cache';
import { JELLYFIN_SERVER_ID } from './constants';
import type { JellyfinBaseItemDto } from './types';

/** The Id `GET /j/MusicGenres` has always issued (stable 32-bit name hash). */
export function musicGenreId(genre: string): string {
    let hash = 0;
    for (let i = 0; i < genre.length; i++) {
        const char = genre.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash |= 0;
    }
    const h = (hash >>> 0).toString(16).padStart(8, '0');
    return `${h.slice(0, 8)}-0000-4000-8000-000000000000`;
}

function md5Hex(value: string): string {
    return createHash('md5').update(value).digest('hex');
}

function dashed(hex: string): string {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Every Id a /j response may have used for this genre, lowercased. */
export function musicGenreIdCandidates(genre: string): string[] {
    const lower = genre.trim().toLowerCase();
    const itemHex = md5Hex(lower);
    return [
        musicGenreId(genre),
        dashed(md5Hex('genre:' + genre.toLowerCase())),
        itemHex,
        dashed(itemHex),
    ].map((id) => id.toLowerCase());
}

export interface ResolvedMusicGenre {
    name: string;
    trackCount: number;
    albumCount: number;
}

/**
 * The genre list behind {@link resolveMusicGenre}, cached briefly per access
 * boundary. `getDistinctMusicGenres` aggregates every track's genre tags
 * (TOAST-heavy, seconds on a large library) and one genre lookup by Id can only
 * be answered from the whole list (the Ids are name hashes), so without this
 * every MusicGenres/{name}, genre mix and genre image request would re-run it.
 * Keyed by the denied library groups AND the age rule: two callers share an
 * entry only when they see exactly the same tracks.
 */
export const MUSIC_GENRE_CACHE_TTL_MS = 60_000;
const MUSIC_GENRE_CACHE_MAX = 64;
const genreListCache = new AccessKeyedCache<MusicGenreRow[]>(
    MUSIC_GENRE_CACHE_TTL_MS,
    MUSIC_GENRE_CACHE_MAX,
);

/** Genres under one parent (library group / album / artist), same TTL and boundary keying. */
const genresUnderCache = new AccessKeyedCache<ScopedMusicGenre[]>(
    MUSIC_GENRE_CACHE_TTL_MS,
    256,
    32,
);

function visibleMusicGenres(
    sql: postgres.Sql,
    access: JellyfinAccessContext,
): Promise<MusicGenreRow[]> {
    // A failed lookup is not remembered (AccessKeyedCache drops rejected loads).
    return genreListCache.get(access, 'all', () =>
        getDistinctMusicGenres(sql, {
            deniedGroupIds: access.deniedGroupIds,
            ageRating: access.ageRating,
        }),
    );
}

/**
 * Music genres under a parent, cached per access boundary. The query
 * materialises every track's custom_metadata under the parent, so a client
 * opening the same library's genre screen repeatedly must not re-run it.
 */
export function listMusicGenresUnder(
    sql: postgres.Sql,
    parentId: string,
    access: JellyfinAccessContext,
): Promise<ScopedMusicGenre[]> {
    return genresUnderCache.get(access, parentId.toLowerCase(), () =>
        getJellyfinMusicGenresUnder(sql, parentId, access.boundary),
    );
}

/** Every music genre the caller can see, with track/album counts (cached, see above). */
export function listVisibleMusicGenres(
    sql: postgres.Sql,
    access: JellyfinAccessContext,
): Promise<MusicGenreRow[]> {
    return visibleMusicGenres(sql, access);
}

/** Test hook. */
export function clearMusicGenreCache(): void {
    genreListCache.clear();
    genresUnderCache.clear();
}

/**
 * Find a genre the caller can see by name (case-insensitive) or by any of its
 * Ids. Null when nothing visible matches — the route answers 404, so a genre
 * that only exists in a denied library is indistinguishable from none.
 */
export async function resolveMusicGenre(
    sql: postgres.Sql,
    nameOrId: string,
    access: JellyfinAccessContext,
): Promise<ResolvedMusicGenre | null> {
    const needle = nameOrId.trim().toLowerCase();
    if (!needle) return null;
    const genres = await visibleMusicGenres(sql, access);
    const match =
        genres.find((g) => g.genre.trim().toLowerCase() === needle) ??
        genres.find((g) => musicGenreIdCandidates(g.genre).includes(needle));
    if (!match) return null;
    return { name: match.genre, trackCount: match.track_count, albumCount: match.album_count };
}

/**
 * The album whose cover stands in for the genre's Primary image (one the
 * caller can see), or null when the genre has none.
 */
export async function getMusicGenreCoverAlbumId(
    sql: postgres.Sql,
    genreName: string,
    access: JellyfinAccessContext,
): Promise<string | null> {
    const [cover] = await getGenreCoverAlbums(
        sql,
        [genreName],
        { deniedGroupIds: access.deniedGroupIds, ageRating: access.ageRating },
        1,
    );
    return cover?.album_id ?? null;
}

/** `BaseItemDto` of Type MusicGenre, the shape Jellyfin's MusicGenresController returns. */
export function serializeMusicGenre(
    genre: ResolvedMusicGenre,
    coverAlbumId: string | null = null,
): JellyfinBaseItemDto {
    const id = musicGenreId(genre.name);
    return {
        Name: genre.name,
        Id: id,
        ServerId: JELLYFIN_SERVER_ID,
        Type: 'MusicGenre',
        Etag: id.replace(/-/g, ''),
        IsFolder: true,
        ChannelId: null,
        SortName: genre.name,
        MediaType: 'Unknown',
        LocationType: 'FileSystem',
        ChildCount: genre.trackCount,
        SongCount: genre.trackCount,
        AlbumCount: genre.albumCount,
        // The Primary that /MusicGenres/{name}/Images/Primary serves (an album
        // cover); without a tag clients never ask for it.
        ImageTags: coverAlbumId ? { Primary: coverAlbumId.replace(/-/g, '') } : {},
        BackdropImageTags: [],
        ImageBlurHashes: {},
        ProviderIds: {},
        ExternalUrls: [],
        Genres: [],
        GenreItems: [],
        Taglines: [],
    };
}
