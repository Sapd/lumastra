// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Local trailers, special features and theme media for /j (Jellyfin
 * UserLibraryController.GetLocalTrailers / GetSpecialFeatures,
 * LibraryController.GetThemeSongs / GetThemeVideos / GetThemeMedia,
 * TrailersController.GetTrailers), plus the LocalTrailerCount /
 * SpecialFeatureCount / RemoteTrailers fields an item's detail carries.
 *
 * Extras are `media_items` rows (`media_type = 'extra'`) the scanner links to
 * a movie or series. Every listing gates on the PARENT item; the extra itself
 * has no artwork, so its DTO points at the parent's images.
 */

import { json, type RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { isUuid, normalizeUuid } from '$lib/server/utils/media-key-parser.js';
import {
    countItemExtras,
    getRemoteTrailerUrls,
    getVisibleItemType,
    listAccessibleLocalTrailers,
    listItemExtras,
    type ExtrasKind,
    type ItemExtraRow,
} from '$lib/server/database/queries/related-media.queries';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { buildJellyfinAccessContext, type JellyfinAccessUser } from './access-context';
import { imageTagFor, serializeBaseItem } from './serializers/base-item';
import { enrichItemsWithMediaSources, dropFilelessPlayables } from './media-source-enrichment';
import { getJfToken, getParam, getSearchTermParam } from './utils';
import type {
    JellyfinBaseItemDto,
    JellyfinExtraType,
    JellyfinItemsResponse,
    JellyfinThemeMediaResult,
} from './types';

const logger = Logger.for('JellyfinCompat:RelatedMedia');

const EXTRA_TYPE_MAP: Record<string, JellyfinExtraType> = {
    trailer: 'Trailer',
    behind_the_scenes: 'BehindTheScenes',
    featurette: 'Featurette',
    deleted_scene: 'DeletedScene',
    interview: 'Interview',
    scene: 'Scene',
    short: 'Short',
    extra: 'Unknown',
};

/** Lumastra extra_type → Jellyfin ExtraType (`extras/`, `bonus/` → Unknown, as Jellyfin's "Extras"). */
export function toJellyfinExtraType(extraType: string | null): JellyfinExtraType {
    return (extraType && EXTRA_TYPE_MAP[extraType]) || 'Unknown';
}

/**
 * One extra as Jellyfin serializes it: a local trailer is a `Trailer` item, any
 * other extra a `Video`, both with `ExtraType` and `ParentId` set. Images come
 * from the parent (the extra has none of its own), as Jellyfin's DtoService
 * falls back to the owner's backdrop.
 */
export function serializeExtra(
    row: ItemExtraRow,
    opts: { nameFromParent?: boolean } = {},
): JellyfinBaseItemDto {
    const extraType = toJellyfinExtraType(row.extra_type);
    const dto = serializeBaseItem({
        id: row.id,
        title: row.title,
        media_type: 'extra',
        runtime_seconds: row.runtime_seconds,
        created_at: row.created_at,
        parent_id: row.parent_id,
    });
    const parentTag = imageTagFor(row.parent_id);
    return {
        ...dto,
        Type: extraType === 'Trailer' ? 'Trailer' : 'Video',
        ExtraType: extraType,
        // A bare "trailer.mkv" is titled "trailer"; the /Trailers list needs the movie's name.
        Name:
            opts.nameFromParent || !row.title || row.title.toLowerCase() === 'trailer'
                ? row.parent_title
                : row.title,
        ProductionYear: extraType === 'Trailer' ? (row.parent_year ?? undefined) : undefined,
        ImageTags: {},
        BackdropImageTags: [],
        ...(row.parent_poster_path
            ? { ParentPrimaryImageItemId: row.parent_id, ParentPrimaryImageTag: parentTag }
            : {}),
        ...(row.parent_backdrop_path
            ? { ParentBackdropItemId: row.parent_id, ParentBackdropImageTags: [parentTag] }
            : {}),
    };
}

async function serializeExtraRows(
    sql: postgres.Sql,
    rows: ItemExtraRow[],
    apiKey: string,
    opts: { nameFromParent?: boolean } = {},
): Promise<JellyfinBaseItemDto[]> {
    const items = rows.map((r) => serializeExtra(r, opts));
    await enrichItemsWithMediaSources(sql, items, apiKey);
    return dropFilelessPlayables(items);
}

/** Movie and Series detail: the counts behind Jellyfin's Trailer / Special Features buttons. */
const EXTRAS_OWNER_TYPES = new Set(['Movie', 'Series']);

/**
 * Set LocalTrailerCount, SpecialFeatureCount and RemoteTrailers on Movie and
 * Series DTOs (two indexed queries for the whole batch). Mutates in place.
 * Callers pass only items the user may see; `user` scopes which extras count
 * (the ones LocalTrailers / SpecialFeatures would list).
 */
export async function enrichItemsWithRelatedMediaCounts(
    sql: postgres.Sql,
    items: JellyfinBaseItemDto[],
    user: JellyfinAccessUser | undefined,
): Promise<void> {
    const owners = items.filter((i) => EXTRAS_OWNER_TYPES.has(i.Type) && isUuid(i.Id));
    if (owners.length === 0) return;
    const ids = owners.map((i) => i.Id);
    let counts: Map<string, { localTrailers: number; specialFeatures: number }>;
    let trailers: Map<string, string>;
    try {
        const access = await buildJellyfinAccessContext(sql, user);
        [counts, trailers] = await Promise.all([
            countItemExtras(sql, ids, access.boundary),
            getRemoteTrailerUrls(sql, ids),
        ]);
    } catch (error) {
        // Cosmetic fields: a failure here must not fail the item's detail.
        logger.warn('Related-media counts failed', {}, error as Error);
        return;
    }
    for (const item of owners) {
        const c = counts.get(item.Id);
        item.LocalTrailerCount = c?.localTrailers ?? 0;
        item.SpecialFeatureCount = c?.specialFeatures ?? 0;
        const url = trailers.get(item.Id);
        item.RemoteTrailers = url ? [{ Url: url, Name: 'Trailer' }] : [];
    }
}

type ItemGate =
    | { ok: true; sql: postgres.Sql; itemId: string; access: MediaAccessBoundary }
    | { ok: false; res: Response };

/** 404 unless the item exists, is active and the user can see it (both gates, like Similar). */
async function gateItem(event: RequestEvent): Promise<ItemGate> {
    const sql = getDb();
    if (!sql) return { ok: false, res: ApiResponses.error('Database unavailable') };
    const rawId = event.params.itemId;
    if (!rawId || !isUuid(rawId)) {
        return { ok: false, res: ApiResponses.notFound('Item not found') };
    }
    const itemId = normalizeUuid(rawId);
    if (!(await checkMediaAccess(sql, itemId, event.locals.user))) {
        return { ok: false, res: ApiResponses.notFound('Item not found') };
    }
    const access = await buildJellyfinAccessContext(sql, event.locals.user);
    if (!(await getVisibleItemType(sql, itemId, access.boundary))) {
        return { ok: false, res: ApiResponses.notFound('Item not found') };
    }
    return { ok: true, sql, itemId, access: access.boundary };
}

/**
 * GET /Items/{itemId}/LocalTrailers and /SpecialFeatures (+ the legacy
 * /Users/{userId}/Items/{itemId}/… paths): a bare BaseItemDto array.
 */
export async function handleItemExtras(event: RequestEvent, kind: ExtrasKind): Promise<Response> {
    try {
        const gate = await gateItem(event);
        if (!gate.ok) return gate.res;
        const rows = await listItemExtras(gate.sql, gate.itemId, kind, gate.access);
        const apiKey = getJfToken(event.locals as unknown as Record<string, unknown>);
        return json(await serializeExtraRows(gate.sql, rows, apiKey));
    } catch (error) {
        logger.error('Item extras query failed', error as Error, { kind });
        return ApiResponses.error('Failed to get item extras');
    }
}

function emptyThemeResult(ownerId: string): JellyfinThemeMediaResult {
    return { Items: [], TotalRecordCount: 0, StartIndex: 0, OwnerId: ownerId };
}

/**
 * GET /Items/{itemId}/ThemeSongs, /ThemeVideos, /ThemeMedia.
 *
 * Lumastra does not ingest theme assets (`theme.mp3`, `theme-music/`,
 * `backdrops/` — see isThemeAssetPath), so every result is empty, as on a
 * Jellyfin server whose library has none.
 *
 * Deliberately no item lookup: clients ask for theme media on library views,
 * collections and people too (ids that are not media items), and those must
 * keep their empty 200. Answering 404 only for a hidden MEDIA item would turn
 * this route into an existence oracle for ids the user cannot see; an empty
 * result reveals nothing. A malformed id is 404.
 */
export function handleThemeMedia(event: RequestEvent, which: 'songs' | 'videos' | 'all'): Response {
    const rawId = event.params.itemId;
    if (!rawId || !isUuid(rawId)) return ApiResponses.notFound('Item not found');
    const ownerId = normalizeUuid(rawId);
    if (which !== 'all') return json(emptyThemeResult(ownerId));
    return json({
        ThemeVideosResult: emptyThemeResult(ownerId),
        ThemeSongsResult: emptyThemeResult(ownerId),
        SoundtrackSongsResult: emptyThemeResult(ownerId),
    });
}

/**
 * GET /Trailers: every local trailer whose movie/series the user can see, as
 * `Trailer` items, paged (`StartIndex`, `Limit`), sorted (`SortBy` SortName |
 * DateCreated | PremiereDate | ProductionYear | Random, `SortOrder`) and
 * searchable (`SearchTerm`). Lumastra has no standalone trailer library or
 * trailer channels, so local trailers are the trailers it has.
 */
export async function handleTrailers(event: RequestEvent): Promise<Response> {
    const { locals, url } = event;
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');

    const startIndex = Math.max(0, parseInt(getParam(url, 'StartIndex') ?? '0', 10) || 0);
    const limit = Math.min(Math.max(1, parseInt(getParam(url, 'Limit') ?? '100', 10) || 100), 500);
    const sortBy = (getParam(url, 'SortBy') ?? 'SortName').split(',')[0].trim();
    const descending = (getParam(url, 'SortOrder') ?? '').split(',')[0].trim() === 'Descending';
    const searchTerm = getSearchTermParam(url)?.trim() || null;

    try {
        const access = await buildJellyfinAccessContext(sql, locals.user);
        const { rows, totalCount } = await listAccessibleLocalTrailers(sql, {
            access: access.boundary,
            startIndex,
            limit,
            sortBy,
            descending,
            searchTerm,
        });
        const apiKey = getJfToken(locals as unknown as Record<string, unknown>);
        const items = await serializeExtraRows(sql, rows, apiKey, { nameFromParent: true });
        const response: JellyfinItemsResponse = {
            // The query already requires a present file, so dropFilelessPlayables
            // removes nothing in practice; the total stays the query's, the same
            // on every page.
            Items: items,
            TotalRecordCount: totalCount,
            StartIndex: startIndex,
        };
        return json(response);
    } catch (error) {
        logger.error('Trailers query failed', error as Error);
        return ApiResponses.error('Failed to get trailers');
    }
}
