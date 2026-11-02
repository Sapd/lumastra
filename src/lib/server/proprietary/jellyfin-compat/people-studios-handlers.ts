// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * PersonsController and StudiosController on `/j`:
 *
 *   GET /Persons            — people credited on titles the caller can see
 *   GET /Persons/{name}     — one Person item (biography from the provider)
 *   GET /Studios            — studios / networks of those titles
 *   GET /Studios/{name}     — one Studio item
 *
 * plus `resolveNameItem`, which lets `/Items/{id}` (and the legacy
 * `/Users/{u}/Items/{id}`) answer for a person or studio id: clients open a
 * cast member from `BaseItemDto.People` by `getItem(person.Id)`.
 *
 * A person or studio only exists for a caller through a movie or series that
 * caller can see; anything else is a 404, exactly like an unknown name.
 */

import { json, type RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import { getDb } from '$lib/server/database';
import { getImageProxyService, imageResponse } from '$lib/server/services/image-proxy';
import { normalizeImageType } from '$lib/server/utils/image-validation';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import type { UserContext } from '$lib/server/types';
import {
    findVisiblePerson,
    findVisibleStudio,
    getItemCredits,
    listVisiblePersons,
    listVisibleStudios,
    normalizeUuids,
    personKeyForName,
    studioKeyForName,
    type OwnerType,
} from '$lib/server/database/queries/jellyfin-people.queries';
import { buildJellyfinAccessContext } from './access-context';
import { USER_ROOT_FOLDER_ID } from './constants';
import { getParam, getSearchTermParam } from './utils';
import {
    loadPersonBio,
    parsePersonTypes,
    serializePersonItem,
    serializeStudioItem,
} from './people-studios';
import type { JellyfinBaseItemDto, JellyfinItemsResponse } from './types';

const logger = Logger.for('JellyfinCompat:PeopleStudios');

/** Jellyfin returns every person without a Limit; this bounds one page. */
const MAX_PAGE = 500;

function paging(url: URL): { startIndex: number; limit: number } {
    const rawLimit = Number.parseInt(getParam(url, 'Limit') ?? '', 10);
    return {
        startIndex: Math.max(0, Number.parseInt(getParam(url, 'StartIndex') ?? '0', 10) || 0),
        limit: Number.isNaN(rawLimit) ? MAX_PAGE : Math.min(Math.max(0, rawLimit), MAX_PAGE),
    };
}

function bool(value: string | null): boolean | null {
    const v = value?.trim().toLowerCase();
    return v === 'true' ? true : v === 'false' ? false : null;
}

/** `ParentId` as a library group id; the user root folder means no parent. */
function libraryParent(url: URL): string | null {
    const raw = getParam(url, 'ParentId');
    if (!raw) return null;
    return raw.replace(/-/g, '').toLowerCase() === USER_ROOT_FOLDER_ID ? null : raw;
}

/** Lumastra keeps no person or studio favourites: isFavorite=true matches nothing. */
function favoritesOnly(url: URL): boolean {
    const filters = (getParam(url, 'Filters') ?? '').toLowerCase().split(',');
    return (
        bool(getParam(url, 'IsFavorite')) === true ||
        filters.includes('isfavorite') ||
        filters.includes('isfavoriteorlikes')
    );
}

function emptyPage(startIndex: number): Response {
    return json({ Items: [], TotalRecordCount: 0, StartIndex: startIndex });
}

// ---------------------------------------------------------------------------
// /Persons
// ---------------------------------------------------------------------------

export async function handlePersonsList(event: RequestEvent): Promise<Response> {
    const { url, locals } = event;
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');
    const { startIndex, limit } = paging(url);
    const roles = parsePersonTypes(
        getParam(url, 'PersonTypes'),
        getParam(url, 'ExcludePersonTypes'),
    );
    if (roles.length === 0 || favoritesOnly(url)) return emptyPage(startIndex);

    try {
        const access = await buildJellyfinAccessContext(sql, locals.user);
        const appearsIn = getParam(url, 'AppearsInItemId');
        let personIds: string[] | undefined;
        let order: Map<string, number> | undefined;
        let tmdb: Map<string, { tmdb_id: string | null; has_profile: boolean | null }> | undefined;
        if (appearsIn) {
            const [itemId] = normalizeUuids([appearsIn]);
            if (!itemId || !(await checkMediaAccess(sql, itemId, locals.user))) {
                return emptyPage(startIndex);
            }
            const credits = (await getItemCredits(sql, [itemId])).filter((c) =>
                roles.includes(c.role),
            );
            personIds = [...new Set(credits.map((c) => c.person_id))];
            if (personIds.length === 0) return emptyPage(startIndex);
            order = new Map(personIds.map((id, i) => [id, i]));
            tmdb = new Map();
            for (const c of credits) {
                if (c.tmdb_id && !tmdb.has(c.person_id)) tmdb.set(c.person_id, c);
            }
        }

        const opts = {
            roles,
            searchTerm: getSearchTermParam(url),
            nameStartsWith: getParam(url, 'NameStartsWith'),
            nameStartsWithOrGreater: getParam(url, 'NameStartsWithOrGreater'),
            nameLessThan: getParam(url, 'NameLessThan'),
            parentId: libraryParent(url),
            personIds,
        };
        let rows;
        let totalCount;
        if (order) {
            // One title's people, in its billing order (Jellyfin's ListOrder).
            const all = await listVisiblePersons(sql, access.boundary, {
                ...opts,
                startIndex: 0,
                limit: MAX_PAGE,
            });
            const sorted = all.rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
            totalCount = sorted.length;
            rows = sorted.slice(startIndex, startIndex + limit);
        } else {
            ({ rows, totalCount } = await listVisiblePersons(sql, access.boundary, {
                ...opts,
                startIndex,
                limit,
            }));
        }
        const items = rows.map((r) => serializePersonItem({ ...r, ...(tmdb?.get(r.id) ?? {}) }));
        const response: JellyfinItemsResponse = {
            Items: items,
            TotalRecordCount: totalCount,
            StartIndex: startIndex,
        };
        return json(response);
    } catch (error) {
        logger.error('Persons query failed', error as Error);
        return ApiResponses.error('Failed to get persons');
    }
}

async function personItem(
    sql: postgres.Sql,
    personId: string,
    user: UserContext,
): Promise<JellyfinBaseItemDto | null> {
    const access = await buildJellyfinAccessContext(sql, user);
    const row = await findVisiblePerson(sql, personId, access.boundary);
    if (!row) return null;
    return serializePersonItem(row, await loadPersonBio(row.tmdb_id));
}

export async function handlePersonByName(event: RequestEvent): Promise<Response> {
    const name = (event.params as { name?: string }).name?.trim();
    if (!name) return ApiResponses.badRequest('Name is required');
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');
    try {
        const id = await personKeyForName(sql, name);
        const item = id ? await personItem(sql, id, event.locals.user) : null;
        return item ? json(item) : ApiResponses.notFound('Person not found');
    } catch (error) {
        logger.error('Person lookup failed', error as Error);
        return ApiResponses.error('Failed to get person');
    }
}

/**
 * `GET /Persons/{name}/Images/{type}[/{index}]` (ImageController by-name):
 * the person's TMDB headshot. Authenticated, unlike `/Items/{id}/Images`, and
 * a miss is a 404 (Jellyfin's answer): a name the caller has no visible title
 * for, a type other than Primary, an index past 0, or no headshot.
 */
export async function handlePersonImageByName(event: RequestEvent): Promise<Response> {
    const params = event.params as Partial<Record<'name' | 'imageType' | 'imageIndex', string>>;
    const name = params.name?.trim();
    if (!name) return ApiResponses.badRequest('Name is required');
    if (params.imageIndex !== undefined) {
        if (!/^\d+$/.test(params.imageIndex)) return ApiResponses.badRequest('Invalid image index');
        if (Number.parseInt(params.imageIndex, 10) > 0)
            return ApiResponses.notFound('Image not found');
    }
    if (normalizeImageType(params.imageType ?? '') !== 'primary') {
        return ApiResponses.notFound('Image not found');
    }
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');
    try {
        const id = await personKeyForName(sql, name);
        const access = await buildJellyfinAccessContext(sql, event.locals.user);
        const row = id ? await findVisiblePerson(sql, id, access.boundary) : null;
        if (!row?.tmdb_id || row.has_profile === false)
            return ApiResponses.notFound('Image not found');
        const image = await getImageProxyService()
            .getPersonImage(row.tmdb_id, { rawSize: 'h632' })
            .catch(() => null);
        return image
            ? imageResponse(image, event.request, { keepCacheControl: true })
            : ApiResponses.notFound('Image not found');
    } catch (error) {
        logger.error('Person image lookup failed', error as Error);
        return ApiResponses.error('Failed to get person image');
    }
}

// ---------------------------------------------------------------------------
// /Studios
// ---------------------------------------------------------------------------

/** IncludeItemTypes / ExcludeItemTypes → the title kinds that carry studios. */
export function studioOwnerTypes(include: string | null, exclude: string | null): OwnerType[] {
    const map = (v: string | null): Set<OwnerType> => {
        const out = new Set<OwnerType>();
        for (const t of (v ?? '').split(',')) {
            const k = t.trim().toLowerCase();
            if (k === 'movie') out.add('movie');
            if (k === 'series') out.add('tv');
        }
        return out;
    };
    const inc = map(include);
    const exc = map(exclude);
    const base: OwnerType[] = include ? [...inc] : ['movie', 'tv'];
    return base.filter((t) => !exc.has(t));
}

export async function handleStudiosList(event: RequestEvent): Promise<Response> {
    const { url, locals } = event;
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');
    const { startIndex, limit } = paging(url);
    const types = studioOwnerTypes(
        getParam(url, 'IncludeItemTypes'),
        getParam(url, 'ExcludeItemTypes'),
    );
    if (types.length === 0 || favoritesOnly(url)) return emptyPage(startIndex);
    try {
        const access = await buildJellyfinAccessContext(sql, locals.user);
        const { rows, totalCount } = await listVisibleStudios(sql, access.boundary, {
            types,
            parentId: libraryParent(url),
            searchTerm: getSearchTermParam(url),
            nameStartsWith: getParam(url, 'NameStartsWith'),
            nameStartsWithOrGreater: getParam(url, 'NameStartsWithOrGreater'),
            nameLessThan: getParam(url, 'NameLessThan'),
            startIndex,
            limit,
        });
        const response: JellyfinItemsResponse = {
            Items: rows.map(serializeStudioItem),
            TotalRecordCount: totalCount,
            StartIndex: startIndex,
        };
        return json(response);
    } catch (error) {
        logger.error('Studios query failed', error as Error);
        return ApiResponses.error('Failed to get studios');
    }
}

async function studioItem(
    sql: postgres.Sql,
    studioId: string,
    user: UserContext,
): Promise<JellyfinBaseItemDto | null> {
    const access = await buildJellyfinAccessContext(sql, user);
    const row = await findVisibleStudio(sql, studioId, access.boundary);
    return row ? serializeStudioItem(row) : null;
}

export async function handleStudioByName(event: RequestEvent): Promise<Response> {
    const name = (event.params as { name?: string }).name?.trim();
    if (!name) return ApiResponses.badRequest('Name is required');
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');
    try {
        const id = await studioKeyForName(sql, name);
        const item = id ? await studioItem(sql, id, event.locals.user) : null;
        return item ? json(item) : ApiResponses.notFound('Studio not found');
    } catch (error) {
        logger.error('Studio lookup failed', error as Error);
        return ApiResponses.error('Failed to get studio');
    }
}

// ---------------------------------------------------------------------------
// /Items/{id} for person and studio ids
// ---------------------------------------------------------------------------

/**
 * The Person or Studio item `id` names, for this user, or null when `id` is
 * no person or studio the user can see through a title. Both lookups are
 * index scans; the item routes only ask once `id` is no media item.
 */
export async function resolveNameItem(
    sql: postgres.Sql,
    id: string,
    user: UserContext,
): Promise<JellyfinBaseItemDto | null> {
    if (normalizeUuids([id]).length === 0) return null;
    return (await personItem(sql, id, user)) ?? (await studioItem(sql, id, user));
}
