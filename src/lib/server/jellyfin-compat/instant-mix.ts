// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin Instant Mix for the /j surface.
 *
 * Every Jellyfin InstantMix route (`Items|Songs|Albums|Artists|Playlists/{id}/
 * InstantMix`, `Artists/InstantMix?id=`, `MusicGenres/InstantMix?id=`) loads
 * the item and dispatches on its ACTUAL type (`MusicManager.GetInstantMixFromItem`),
 * so a song id on the Albums route still yields a song mix. `MusicGenres/{name}/
 * InstantMix` is the one by-name entry. The pool is capped at 200 tracks;
 * `TotalRecordCount` is the pool size and `Limit` only cuts the page (Jellyfin's
 * `GetResult`).
 *
 * Jellyfin builds the pool from random tracks sharing the seed's genres. Lumastra
 * ranks by its music embeddings instead (nearest tracks to the centroid of the
 * seed's tracks — the space the Subsonic similar-songs endpoints use), then tops
 * up from the seed's genres, then — only when there is nothing else to go on,
 * which is Jellyfin's behaviour for a genre-less seed — from random tracks.
 * A song mix starts with the song itself, as in Jellyfin.
 */

import { json, type RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { isUuid, normalizeUuid } from '$lib/server/utils/media-key-parser';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getMediaType } from '$lib/server/database/queries/media-type-cache.queries.js';
import { getTracksByGenre } from '$lib/server/database/queries/music.queries.js';
import { getPlaylistItems } from '$lib/server/database/queries/playlists.queries';
import { browseMediaItems } from '$lib/server/database/queries/jellyfin-browse.queries';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { getUserRole } from '$lib/server/utils/playlist-utils';
import type { UserContext } from '$lib/server/types';
import { buildJellyfinAccessContext } from './access-context';
import { uuidToPlaylistId } from './playlist-id';
import { resolveMusicGenre } from './music-genres';
import { serializeBaseItems, mapRowToMediaItem } from './serializers/base-item';
import { applyJellyfinContentLanguage } from './content-language';
import { enrichItemsWithMediaSources, dropFilelessPlayables } from './media-source-enrichment';
import { enrichItemsWithProviderIds } from './provider-ids-enrichment';
import { enrichItemsWithMusicArtists } from './music-artists-enrichment';
import { getJfToken, getParam } from './utils';
import type { JellyfinBaseItemDto, JellyfinItemsResponse } from './types';
import { parseDtoOptions as parseListDtoOptions, shapeItemsResponse } from './dto-options';
import {
    findRandomTrackIds,
    findTracksNearSeeds,
    getAlbumTrackIds,
    getArtistTrackIds,
    getTopGenresForTracks,
} from './music-mix.queries';

const logger = Logger.for('JellyfinCompat:InstantMix');

/** `MusicManager.GetInstantMixFromGenreIds`'s `Limit = 200`. */
export const INSTANT_MIX_POOL_SIZE = 200;

/** One seed track every this many slots in an album/artist/playlist mix. */
const SEED_INTERLEAVE_EVERY = 4;

export type InstantMixSeed =
    | { kind: 'track'; id: string }
    | { kind: 'album'; id: string }
    | { kind: 'artist'; id: string }
    | { kind: 'playlist'; trackIds: string[] }
    | { kind: 'genre'; name: string };

/**
 * Put one seed track after every `every - 1` neighbours, at most a quarter of
 * the pool, so an album/artist mix still sounds like its seed without being the
 * album on repeat. Pure; exported for tests.
 */
export function interleaveSeedTracks(
    neighbours: string[],
    seedTracks: string[],
    every: number = SEED_INTERLEAVE_EVERY,
): string[] {
    const out: string[] = [];
    let s = 0;
    for (const id of neighbours) {
        if (s < seedTracks.length && out.length % every === every - 1) out.push(seedTracks[s++]);
        out.push(id);
    }
    // Neighbours ran out (small library): the seed tracks fill the rest.
    while (s < seedTracks.length) out.push(seedTracks[s++]);
    return out;
}

/** The ordered pool of track ids for a seed, all visible under `access`. */
export async function buildInstantMixIds(
    sql: postgres.Sql,
    seed: InstantMixSeed,
    access: MediaAccessBoundary,
    poolSize: number = INSTANT_MIX_POOL_SIZE,
): Promise<string[]> {
    if (seed.kind === 'genre') {
        const rows = await getTracksByGenre(sql, seed.name, access, poolSize);
        return rows.map((r) => r.id);
    }

    const seedTracks =
        seed.kind === 'track'
            ? [seed.id]
            : seed.kind === 'album'
              ? await getAlbumTrackIds(sql, seed.id, access)
              : seed.kind === 'artist'
                ? await getArtistTrackIds(sql, seed.id, access)
                : seed.trackIds;

    const neighbours = await findTracksNearSeeds(sql, seedTracks, poolSize, [], access);
    let pool =
        seed.kind === 'track'
            ? [seed.id, ...neighbours]
            : interleaveSeedTracks(neighbours, seedTracks);
    pool = [...new Set(pool)].slice(0, poolSize);

    if (pool.length < poolSize) {
        const genres = await getTopGenresForTracks(sql, seedTracks);
        if (genres.length > 0) {
            const byGenre = await getTracksByGenre(
                sql,
                genres,
                access,
                poolSize - pool.length,
                pool,
            );
            pool = [...pool, ...byGenre.map((r) => r.id)];
        } else if (pool.length <= (seed.kind === 'track' ? 1 : 0)) {
            pool = [
                ...pool,
                ...(await findRandomTrackIds(sql, poolSize - pool.length, pool, access)),
            ];
        }
    }
    return [...new Set(pool)].slice(0, poolSize);
}

export interface TrackListOptions {
    enableUserData: boolean;
    enableImages: boolean;
}

/** `EnableUserData` / `EnableImages` (both default true, as in Jellyfin's DtoOptions). */
export function parseDtoOptions(url: URL): TrackListOptions {
    return {
        enableUserData: (getParam(url, 'EnableUserData') ?? '').toLowerCase() !== 'false',
        enableImages: (getParam(url, 'EnableImages') ?? '').toLowerCase() !== 'false',
    };
}

/** Requested `Limit` (null = no limit); invalid or negative values are ignored. */
export function parseLimit(url: URL): number | null {
    const raw = getParam(url, 'Limit');
    if (raw === null || !/^\d+$/.test(raw.trim())) return null;
    return parseInt(raw, 10);
}

/**
 * Hydrate ids (any media type) into serialized `BaseItemDto`s in the given
 * order. `browseMediaItems` re-applies the access boundary, so an id that slips
 * through a seed query unfiltered is still dropped here.
 */
export async function hydrateOrderedItems(
    sql: postgres.Sql,
    user: UserContext,
    access: MediaAccessBoundary,
    ids: string[],
    options: TrackListOptions & { apiKey: string },
): Promise<JellyfinBaseItemDto[]> {
    if (ids.length === 0) return [];
    const { rows } = await browseMediaItems(sql, {
        mediaTypes: [],
        parentId: null,
        searchTerm: null,
        genres: [],
        years: [],
        nameStartsWith: null,
        isFavoriteFilter: false,
        isPlayedFilter: false,
        isUnplayedFilter: false,
        enableUserData: options.enableUserData,
        userId: user.userId,
        idList: ids,
        sortBy: 'SortName',
        sortOrder: 'Ascending',
        limit: ids.length,
        startIndex: 0,
        access,
        forceEpisodeOrder: false,
    });
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    const ordered = ids
        .map((id) => byId.get(id))
        .filter((r): r is NonNullable<typeof r> => r != null);
    const items = ordered.map(mapRowToMediaItem);
    await applyJellyfinContentLanguage(sql, user.userId, items);
    const serialized = serializeBaseItems(items);
    await enrichItemsWithMediaSources(sql, serialized, options.apiKey);
    await enrichItemsWithProviderIds(sql, serialized);
    await enrichItemsWithMusicArtists(sql, serialized);
    const playable = dropFilelessPlayables(serialized);
    if (!options.enableUserData) {
        for (const item of playable) delete item.UserData;
    }
    if (!options.enableImages) {
        for (const item of playable) {
            item.ImageTags = {};
            item.BackdropImageTags = [];
            item.ImageBlurHashes = {};
        }
    }
    return playable;
}

/**
 * Serialize the pool as Jellyfin's `GetResult` does: `TotalRecordCount` is the
 * whole pool, `Items` the first `Limit` of it.
 */
export async function respondWithItemPool(
    sql: postgres.Sql,
    event: RequestEvent,
    access: MediaAccessBoundary,
    pool: string[],
): Promise<Response> {
    const limit = parseLimit(event.url);
    const page = limit !== null ? pool.slice(0, limit) : pool;
    const items = await hydrateOrderedItems(sql, event.locals.user as UserContext, access, page, {
        ...parseDtoOptions(event.url),
        apiKey: getJfToken(event.locals as unknown as Record<string, unknown>),
    });
    const response: JellyfinItemsResponse = {
        Items: items,
        // Anything hydration dropped (gone or fileless since the pool query) is
        // gone from the total too, so a client paging by the count never asks
        // for rows that are not there.
        TotalRecordCount: pool.length - (page.length - items.length),
        StartIndex: 0,
    };
    return json(shapeItemsResponse(response, parseListDtoOptions(event.url)));
}

export type InstantMixTarget = { kind: 'item'; id: string } | { kind: 'genreName'; name: string };

const EMPTY: JellyfinItemsResponse = { Items: [], TotalRecordCount: 0, StartIndex: 0 };

/**
 * Turn an id into a seed: media items by type, Lumastra playlists by their UUID
 * encoding (gated by playlist role), and music genre Ids. Null → 404; a
 * non-music item yields an empty mix (Jellyfin's fall-through), not an error.
 */
async function resolveSeed(
    sql: postgres.Sql,
    user: UserContext,
    target: InstantMixTarget,
    access: Awaited<ReturnType<typeof buildJellyfinAccessContext>>,
): Promise<InstantMixSeed | 'empty' | null> {
    if (target.kind === 'genreName') {
        const genre = await resolveMusicGenre(sql, target.name, access);
        return genre ? { kind: 'genre', name: genre.name } : null;
    }

    const id = target.id.trim();
    const playlistId = uuidToPlaylistId(id);
    if (playlistId !== null) {
        // Sequential ids behind a UUID encoding: gate on role, 404 when none.
        const { role } = await getUserRole(sql, playlistId, null, user.userId);
        if (!role) return null;
        const items = await getPlaylistItems(
            sql,
            playlistId,
            user.userId,
            'music',
            access.boundary,
            { mode: 'offset', availableOnly: true },
        );
        return {
            kind: 'playlist',
            trackIds: items.filter((i) => i.media_type === 'track').map((i) => i.media_id),
        };
    }

    if (isUuid(id)) {
        const itemId = normalizeUuid(id);
        const mediaType = await getMediaType(sql, itemId);
        if (mediaType) {
            if (!(await checkMediaAccess(sql, itemId, user))) return null;
            switch (mediaType) {
                case 'track':
                    return { kind: 'track', id: itemId };
                case 'album':
                    return { kind: 'album', id: itemId };
                case 'artist':
                    return { kind: 'artist', id: itemId };
                default:
                    return 'empty';
            }
        }
    }

    // Not an item: maybe a music genre Id (`/MusicGenres/InstantMix?id=`).
    const genre = await resolveMusicGenre(sql, id, access);
    return genre ? { kind: 'genre', name: genre.name } : null;
}

/** The whole InstantMix request: resolve, build the pool, serialize. */
export async function handleInstantMix(
    event: RequestEvent,
    target: InstantMixTarget | null,
): Promise<Response> {
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');
    if (!target || (target.kind === 'item' ? !target.id.trim() : !target.name.trim())) {
        return ApiResponses.badRequest('Item ID is required');
    }
    const user = event.locals.user as UserContext;
    try {
        const access = await buildJellyfinAccessContext(sql, user);
        const seed = await resolveSeed(sql, user, target, access);
        if (seed === null) return ApiResponses.notFound('Item not found');
        if (seed === 'empty') return json(EMPTY);
        const pool = await buildInstantMixIds(sql, seed, access.boundary);
        return await respondWithItemPool(sql, event, access.boundary, pool);
    } catch (error) {
        logger.error('Instant mix failed', error as Error, { target });
        return ApiResponses.error('Failed to build instant mix');
    }
}
