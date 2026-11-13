// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Images addressed by NAME: `/Artists/{name}/Images/{type}[/{index}]` and
 * `/MusicGenres/{name}/Images/{type}[/{index}]` (ImageController's by-name
 * routes). The bytes come from the same image proxy `/Items/{id}/Images` uses.
 *
 * Unlike `/Items/{id}/Images` these routes sit behind `withJellyfinAuth`: an id
 * is an unguessable UUID, a name is not, so an unauthenticated by-name lookup
 * would tell anyone whether the library holds a given artist. Clients address
 * artwork by item id almost everywhere; the by-name form is a legacy path.
 *
 * A miss is a 404 (Jellyfin's answer), never the placeholder: an artist or genre
 * the caller cannot see, an image type we do not keep, or an index past 0.
 */

import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { normalizeImageType } from '$lib/server/utils/image-validation';
import { parseQualityParam } from '$lib/server/utils/image-proxy';
import { getImageProxyService, imageResponse } from '$lib/server/services/image-proxy';
import type { ImageType } from '$lib/server/services/image-proxy';
import { buildJellyfinAccessContext, type JellyfinAccessContext } from './access-context';
import { findVisibleArtistByName } from './music-mix.queries';
import { getMusicGenreCoverAlbumId, resolveMusicGenre } from './music-genres';
import { getParam } from './utils';

const TYPE_MAP: Record<string, ImageType> = {
    primary: 'poster',
    backdrop: 'backdrop',
    logo: 'logo',
    thumb: 'thumb',
    banner: 'banner',
};

type NameImageParams = Partial<Record<'name' | 'imageType' | 'imageIndex', string>>;

/** Catalog id + image type to serve, or null for a 404. */
type Resolver = (
    sql: postgres.Sql,
    name: string,
    type: ImageType,
    access: JellyfinAccessContext,
) => Promise<{ catalogId: string; type: ImageType } | null>;

const resolveArtist: Resolver = async (sql, name, type, access) => {
    const row = await findVisibleArtistByName(sql, name, access.boundary);
    return row ? { catalogId: String(row.id), type } : null;
};

/**
 * A genre has no artwork of its own: its Primary/Thumb is the cover of one of
 * its albums the caller can see (what /music/explore's genre tiles show).
 */
const resolveGenre: Resolver = async (sql, name, type, access) => {
    if (type !== 'poster' && type !== 'thumb') return null;
    const genre = await resolveMusicGenre(sql, name, access);
    if (!genre) return null;
    const coverId = await getMusicGenreCoverAlbumId(sql, genre.name, access);
    return coverId ? { catalogId: coverId, type: 'poster' } : null;
};

async function serveNameImage(event: RequestEvent, resolve: Resolver): Promise<Response> {
    const { url, request } = event;
    const params = event.params as NameImageParams;
    const name = params.name?.trim();
    if (!name) return ApiResponses.badRequest('Name is required');
    const normalized = normalizeImageType(params.imageType ?? '');
    const type = normalized !== null ? TYPE_MAP[normalized] : undefined;
    if (!type) return ApiResponses.notFound('Image not found');
    if (params.imageIndex !== undefined) {
        if (!/^\d+$/.test(params.imageIndex)) return ApiResponses.badRequest('Invalid image index');
        if (parseInt(params.imageIndex, 10) > 0) return ApiResponses.notFound('Image not found');
    }

    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');
    const access = await buildJellyfinAccessContext(sql, event.locals.user);
    const target = await resolve(sql, name, type, access);
    if (!target) return ApiResponses.notFound('Image not found');

    const rawFormat = getParam(url, 'format');
    const format =
        rawFormat === 'webp' || rawFormat === 'jpg' || rawFormat === 'png' ? rawFormat : null;
    const result = await getImageProxyService().getImageByCatalogId(target.catalogId, target.type, {
        quality: parseQualityParam(url),
        maxWidth: getParam(url, 'maxWidth') ?? undefined,
        maxHeight: getParam(url, 'maxHeight') ?? undefined,
        ...(format ? { format } : {}),
    });
    if (!result) return ApiResponses.notFound('Image not found');
    return imageResponse(result, request, { keepCacheControl: true });
}

export function serveArtistImage(event: RequestEvent): Promise<Response> {
    return serveNameImage(event, resolveArtist);
}

export function serveMusicGenreImage(event: RequestEvent): Promise<Response> {
    return serveNameImage(event, resolveGenre);
}
