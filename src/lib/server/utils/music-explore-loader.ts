// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared genre-browse loader for the /music home feed AND the /music/explore
 * page — one implementation, no duplicated SQL. Wraps the cached library-genre
 * scan (single-flighted), pinned genres, the pinned-first carousel-name merge,
 * and the genre plan compute.
 */

import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';
import {
    getDistinctMusicGenres,
    getGenreCoverAlbums,
    type MusicGenreRow,
} from '$lib/server/database/queries/music.queries.js';
import { getPinnedGenreNames } from '$lib/server/database/queries/user-pinned-genres.queries.js';
import { computeGenrePlanCached } from '$lib/server/services/music/genre-plan-cached.service';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import { loadGenreRails } from '$lib/server/services/music/genre-ranker.service.js';
import { getOrComputeSingleFlight } from '$lib/server/cache/single-flight.js';
import {
    scopedCacheKey,
    searchAccessBoundary,
    type SearchAccessContext,
} from '$lib/server/utils/search-access-context.js';

const GENRE_CAROUSEL_LIMIT = 8;

export interface MusicExploreGenreData {
    libraryGenres: { genre: string; trackCount: number; albumCount: number }[];
    pinnedGenreNames: string[];
}

export interface MusicExploreData extends MusicExploreGenreData {
    genrePlan: Record<string, string[]>;
    genreCarouselNames: string[];
}

/** Cached, single-flighted library-genre scan (per access scope). */
export async function loadLibraryGenreRows(
    sql: Sql,
    accessCtx: SearchAccessContext,
): Promise<MusicGenreRow[]> {
    const genresCache = cacheManager.for(CACHE_NAMESPACES.musicLibraryGenres);
    const genresKey = scopedCacheKey('music-library-genres', accessCtx);
    const cachedGenres = await genresCache.get<MusicGenreRow[]>(genresKey);
    if (cachedGenres) return cachedGenres;
    const ns = CACHE_NAMESPACES.musicLibraryGenres;
    const rawKey = `${ns.name}:${genresKey}`;
    const ttlSeconds = Math.floor(ns.l2TTL / 1000);
    const jsonStr = await getOrComputeSingleFlight({
        cacheKey: rawKey,
        ttlSeconds,
        compute: async () =>
            JSON.stringify(
                await getDistinctMusicGenres(sql, {
                    deniedGroupIds: accessCtx.deniedGroupIds,
                    ageRating: accessCtx.ageRating,
                }),
            ),
    });
    const genreRows = JSON.parse(jsonStr) as MusicGenreRow[];
    void genresCache.set(genresKey, genreRows);
    return genreRows;
}

/** How many genres get a collage tile. Beyond this the chip browser takes over. */
export const GENRE_COVER_LIMIT = 24;

/** Tiles per collage — a 2x2 grid. */
export const GENRE_COVER_TILES = 4;

/**
 * Album ids backing each genre's collage tile, keyed by genre name.
 *
 * Cached on the same access-scoped namespace as the genre list itself: the
 * inputs are identical (library contents filtered by the viewer's denied
 * groups and age ceiling), so the two must expire together or a tile could
 * outlive the genre it belongs to.
 */
export async function loadGenreCovers(
    sql: Sql,
    accessCtx: SearchAccessContext,
    genres: string[],
): Promise<Record<string, string[]>> {
    if (genres.length === 0) return {};
    const cache = cacheManager.for(CACHE_NAMESPACES.musicLibraryGenres);
    // The genre list is part of the key: a library that gains a genre must not
    // be served a covers map computed before it existed.
    //
    // HASHED, not interpolated. `scopedCacheKey` reserves both `|` (it separates
    // the access suffix) and `:` (it separates extras) and THROWS on a prefix
    // containing them — so joining genre names into the key raised on every
    // library with two or more genres, which in a `load()` with no catch means
    // SvelteKit renders the error page for all of /music/explore. Genre names
    // are operator data and can contain either character on their own, so
    // hashing is also the only form that stays safe as libraries change.
    const genreDigest = createHash('sha1').update(genres.join('\u0000')).digest('hex').slice(0, 16);
    const key = scopedCacheKey(`music-genre-covers:${genreDigest}`, accessCtx);
    const cached = await cache.get<Record<string, string[]>>(key);
    if (cached) return cached;

    const rows = await getGenreCoverAlbums(
        sql,
        genres,
        { deniedGroupIds: accessCtx.deniedGroupIds, ageRating: accessCtx.ageRating },
        GENRE_COVER_TILES,
    );
    const covers: Record<string, string[]> = {};
    for (const row of rows) {
        (covers[row.genre] ??= []).push(row.album_id);
    }
    void cache.set(key, covers);
    return covers;
}

export interface LoadMusicExploreDataOptions {
    recentlyPlayedIds?: string[];
    /**
     * Compute the per-genre carousel plan (`computeGenrePlanCached` — an extra
     * query on cache miss) and the carousel name ordering it needs as input.
     * Defaults to true. Pass `false` for callers that only render the genre
     * list + pinned names (e.g. /music/explore) so they don't pay for a plan
     * they never send to the client.
     */
    includeGenrePlan?: boolean;
}

/**
 * Genre-browse dataset shared by /music and /music/explore. By default
 * computes the full dataset including the genre-plan; pass `includeGenrePlan:
 * false` (as /music/explore does) to skip that compute (`computeGenrePlanCached`
 * — an extra query on cache miss) entirely and get back just the genre list +
 * pinned names. The return type is a union of the two shapes, so a caller
 * that skips the plan can't accidentally read `genrePlan` / `genreCarouselNames`
 * off the result without narrowing first.
 */
export async function loadMusicExploreData(
    sql: Sql,
    userId: UserId,
    accessCtx: SearchAccessContext,
    opts: LoadMusicExploreDataOptions = {},
): Promise<MusicExploreGenreData | MusicExploreData> {
    const { recentlyPlayedIds = [], includeGenrePlan = true } = opts;

    const [genreRows, pinnedRows] = await Promise.all([
        loadLibraryGenreRows(sql, accessCtx),
        getPinnedGenreNames.all(sql, { userId }),
    ]);

    const pinnedNames = pinnedRows.map((r) => r.genre);
    const libraryGenres = genreRows.map((g) => ({
        genre: g.genre,
        trackCount: g.track_count,
        albumCount: g.album_count,
    }));

    if (!includeGenrePlan) {
        return { libraryGenres, pinnedGenreNames: pinnedNames };
    }

    // Ranked, not merely the largest genres: library size is the prior and this
    // viewer's own listening is the evidence (genre-ranker.service.ts). The
    // ranker handles pinned-first itself, so the old manual merge is gone — as
    // is the hardcoded fallback list, which described some other library.
    const rails = await loadGenreRails(sql, userId, accessCtx, pinnedNames, genreRows);
    const genreCarouselNames = rails.slice(0, GENRE_CAROUSEL_LIMIT).map((r) => r.title);

    const genrePlan = await computeGenrePlanCached(sql, userId, {
        recentlyPlayedIds,
        genreCarouselNames,
        access: searchAccessBoundary(accessCtx),
    });

    return {
        libraryGenres,
        pinnedGenreNames: pinnedNames,
        genrePlan,
        genreCarouselNames,
    };
}
