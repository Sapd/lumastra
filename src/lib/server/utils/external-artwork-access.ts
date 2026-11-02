// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestEvent } from '@sveltejs/kit';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import { resolveMediaIdByProvider } from '$lib/server/database/queries/resolvers/media-id.resolver.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import {
    getDeniedLibraryGroups,
    toLibraryAccessUser,
} from '$lib/server/cache/library-group-permissions-cache.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';
import type { ImageProxyService } from '$lib/server/services/image-proxy/service.js';
import type {
    ImageOptions,
    ImageResponse,
    ImageType,
    MediaType,
} from '$lib/server/services/image-proxy/types.js';
import { isProviderImagePath } from './provider-image-path.js';
import type { ParsedMediaId } from './media-key-parser.js';

export type ExternalArtworkAccess =
    | { kind: 'catalog'; internalId: string }
    | { kind: 'tmdb'; externalId: string; mediaType: MediaType; path?: string }
    | { kind: 'jellyfin'; externalId: string };

/**
 * Predictable provider handles are lookups, not anonymous artwork capabilities.
 * Resolve afresh, with the complete type discriminator, and serve the checked
 * UUID. A cached miss must not bypass access after a title enters the library.
 * Only viewers without age or library restrictions may fetch upstream discovery art
 * without a local row. Episode/season discovery needs a validated direct
 * provider filename; it must never trigger another local hierarchy lookup.
 */
export async function resolveExternalArtworkAccess(
    event: Pick<RequestEvent, 'locals'>,
    parsed: ParsedMediaId,
    allowUpstream = false,
    directPath?: string,
): Promise<Response | ExternalArtworkAccess> {
    const user = event.locals.user;
    if (!user?.username) return ApiProblem.unauthorized();
    if (!parsed.provider || !parsed.externalId) return ApiProblem.notFound('Media item not found');
    // The upstream provider uses parseInt. Refuse aliases which could miss the
    // exact database key and later be reinterpreted as a different title's id.
    if (
        parsed.provider === 'tmdb' &&
        (!/^[1-9]\d*$/.test(parsed.externalId) || !Number.isSafeInteger(Number(parsed.externalId)))
    ) {
        return ApiProblem.notFound('Media item not found');
    }
    const sql = getDb();
    if (!sql) return ApiProblem.dependencyUnavailable('Unable to verify content access');
    const internalId = await resolveMediaIdByProvider(
        sql,
        parsed.provider,
        parsed.externalId,
        parsed.mediaType,
    );
    if (internalId) {
        if (!(await checkMediaAccess(sql, internalId, user))) {
            return ApiProblem.notFound('Media item not found');
        }
        return { kind: 'catalog', internalId };
    }
    if (allowUpstream && parsed.provider === 'jellyfin' && localsIsAdmin(event.locals)) {
        return { kind: 'jellyfin', externalId: parsed.externalId };
    }
    if (
        allowUpstream &&
        parsed.provider === 'tmdb' &&
        (parsed.mediaType === 'movie' ||
            parsed.mediaType === 'tv' ||
            ((parsed.mediaType === 'episode' || parsed.mediaType === 'season') &&
                directPath !== undefined &&
                isProviderImagePath(directPath))) &&
        !user.isAgeRestricted
    ) {
        try {
            if ((await getDeniedLibraryGroups(sql, toLibraryAccessUser(user)))?.length)
                return ApiProblem.notFound('Media item not found');
        } catch {
            return ApiProblem.dependencyUnavailable('Unable to verify content access');
        }
        return {
            kind: 'tmdb',
            externalId: parsed.externalId,
            mediaType: parsed.mediaType,
            ...(directPath && isProviderImagePath(directPath) ? { path: directPath } : {}),
        };
    }
    return ApiProblem.notFound('Media item not found');
}

/** Delivery never resolves an external key again after the authorization read. */
export async function fetchExternalArtwork(
    service: Pick<ImageProxyService, 'getImageByCatalogId' | 'getTmdbImage' | 'getJellyfinImage'>,
    access: ExternalArtworkAccess,
    role: ImageType,
    options: ImageOptions,
): Promise<ImageResponse | null> {
    if (access.kind === 'catalog') {
        return service.getImageByCatalogId(access.internalId, role, options);
    }
    // An unmapped upstream image has no catalog-owned artwork to serve.
    if (options.inherit === 'none') return null;
    if (access.kind === 'jellyfin') {
        return service.getJellyfinImage(access.externalId, role, options);
    }
    return service.getTmdbImage(access.externalId, access.mediaType, role, {
        ...options,
        ...(access.path ? { path: access.path } : {}),
    });
}
