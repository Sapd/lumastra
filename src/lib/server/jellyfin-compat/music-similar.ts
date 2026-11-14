// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `GET /Albums/{itemId}/Similar` and `GET /Artists/{itemId}/Similar`.
 *
 * Jellyfin answers both with items of the seed's own type (albums for an
 * album, artists for an artist), `Limit` defaulting to 50, `excludeArtistIds`
 * dropping results by those artists, and `TotalRecordCount` = what it returned.
 *
 * Ranking: sonic neighbours first (`findSonicNeighborAlbums` /
 * `findSonicNeighborArtists`, MSCLAP audio-embedding centroids — the same
 * queries Lumastra's own "sounds like" rails use), topped up by shared genre
 * tags when the library has few or no sonic embeddings. Both queries apply the
 * access boundary to the candidate tracks, and hydration applies it again.
 */

import { json, type RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { isUuid, normalizeUuid } from '$lib/server/utils/media-key-parser';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getMediaType } from '$lib/server/database/queries/media-type-cache.queries.js';
import {
    findSonicNeighborAlbums,
    findSonicNeighborArtists,
} from '$lib/server/database/queries/sonic-similarity.queries.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { UserContext } from '$lib/server/types';
import { buildJellyfinAccessContext } from './access-context';
import { hydrateOrderedItems, parseDtoOptions } from './instant-mix';
import {
    findAlbumsByGenreOverlap,
    findArtistsByGenreOverlap,
    getAlbumArtistIds,
} from './music-mix.queries';
import { getJfToken, getParam, getParamAll } from './utils';
import type { JellyfinItemsResponse } from './types';

const logger = Logger.for('JellyfinCompat:MusicSimilar');

/** `SimilarItemsManager`: `limit ?? 50`. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** `excludeArtistIds` (comma-delimited and/or repeated), normalized; junk dropped. */
export function parseExcludeArtistIds(url: URL): Set<string> {
    const raw = getParamAll(url, 'ExcludeArtistIds').flatMap((v) => v.split(','));
    return new Set(
        raw
            .map((v) => v.trim())
            .filter((v) => isUuid(v))
            .map((v) => normalizeUuid(v).toLowerCase()),
    );
}

function parseSimilarLimit(url: URL): number {
    const raw = getParam(url, 'Limit');
    const n = raw !== null && /^\d+$/.test(raw.trim()) ? parseInt(raw, 10) : DEFAULT_LIMIT;
    return Math.min(Math.max(n, 0), MAX_LIMIT);
}

async function similarAlbumIds(
    sql: postgres.Sql,
    albumId: string,
    limit: number,
    exclude: Set<string>,
    access: MediaAccessBoundary,
): Promise<string[]> {
    // Over-fetch so excludeArtistIds can drop rows without starving the page.
    const want = limit + exclude.size * 5;
    const sonic = await findSonicNeighborAlbums(sql, albumId, want, access);
    let ids = sonic.map((r) => r.album_id);
    if (ids.length < want) {
        const byGenre = await findAlbumsByGenreOverlap(sql, albumId, want, access);
        ids = [...new Set([...ids, ...byGenre])];
    }
    if (exclude.size > 0) {
        const artistOf = await getAlbumArtistIds(sql, ids);
        ids = ids.filter((id) => {
            const artist = artistOf.get(id);
            return !artist || !exclude.has(artist.toLowerCase());
        });
    }
    return ids.slice(0, limit);
}

async function similarArtistIds(
    sql: postgres.Sql,
    artistId: string,
    limit: number,
    exclude: Set<string>,
    access: MediaAccessBoundary,
): Promise<string[]> {
    const want = limit + exclude.size;
    const sonic = await findSonicNeighborArtists(sql, artistId, want, access);
    let ids = sonic.map((r) => r.artist_id);
    if (ids.length < want) {
        const byGenre = await findArtistsByGenreOverlap(sql, artistId, want, access);
        ids = [...new Set([...ids, ...byGenre])];
    }
    return ids.filter((id) => !exclude.has(id.toLowerCase())).slice(0, limit);
}

export async function handleMusicSimilar(event: RequestEvent, rawId: string): Promise<Response> {
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');
    const id = rawId?.trim() ?? '';
    if (!id) return ApiResponses.badRequest('Item ID is required');
    if (!isUuid(id)) return ApiResponses.notFound('Item not found');

    const itemId = normalizeUuid(id);
    const user = event.locals.user as UserContext;
    try {
        const mediaType = await getMediaType(sql, itemId);
        if (!mediaType || !(await checkMediaAccess(sql, itemId, user))) {
            return ApiResponses.notFound('Item not found');
        }
        const empty: JellyfinItemsResponse = { Items: [], TotalRecordCount: 0, StartIndex: 0 };
        if (mediaType !== 'album' && mediaType !== 'artist') return json(empty);

        const access = await buildJellyfinAccessContext(sql, user);
        const limit = parseSimilarLimit(event.url);
        const exclude = parseExcludeArtistIds(event.url);
        const ids =
            limit === 0
                ? []
                : mediaType === 'album'
                  ? await similarAlbumIds(sql, itemId, limit, exclude, access.boundary)
                  : await similarArtistIds(sql, itemId, limit, exclude, access.boundary);

        const items = await hydrateOrderedItems(sql, user, access.boundary, ids, {
            ...parseDtoOptions(event.url),
            apiKey: getJfToken(event.locals as unknown as Record<string, unknown>),
        });
        const response: JellyfinItemsResponse = {
            Items: items,
            TotalRecordCount: items.length,
            StartIndex: 0,
        };
        return json(response);
    } catch (error) {
        logger.error('Music similar query failed', error as Error, { itemId });
        return ApiResponses.error('Failed to get similar items');
    }
}
