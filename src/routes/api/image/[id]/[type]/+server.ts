// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Provider-Agnostic Image Proxy
 *
 * Accepts composite keys (tmdb:123:movie) or UUIDs for image requests.
 * Auto-detects provider and forwards to appropriate image handler.
 *
 * Supports:
 * - Composite keys: /api/image/tmdb:550:movie/poster
 * - UUIDs: /api/image/550e8400-e29b-41d4-a716-446655440000/poster
 *
 * Query parameters:
 * - size: 'thumb', 'medium', or 'full' (default: 'full')
 * - path: Direct image path (optional, skips API lookup)
 * - format: 'webp', 'jpg', or 'png' (optional)
 * - quality: 1-100 (optional)
 */

import type { RequestHandler } from './$types';
import { Logger } from '$lib/server/utils/logger';
import { parseMediaId, type ParsedMediaId } from '$lib/server/utils/media-key-parser.js';
import { getImageProxyService, imageResponse } from '$lib/server/services/image-proxy';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { withImageProxyRateLimit } from '$lib/server/middleware/valkey-rate-limit';
import { VALID_IMAGE_TYPES, isValidImageType } from '$lib/server/utils/image-validation.js';
import {
    parseImageSize,
    applySaveDataDowngrade,
    resolveImageFormat,
} from '$lib/server/utils/image-params.js';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { problem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { toLibraryAccessUser } from '$lib/server/cache/library-group-permissions-cache.js';
import {
    resolveExternalArtworkAccess,
    fetchExternalArtwork,
} from '$lib/server/utils/external-artwork-access.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

const logger = Logger.for('ImageProxy');

export const GET: RequestHandler = withImageProxyRateLimit(
    withErrorHandler(async (event) => {
        const { params, url, request, locals } = event;
        if (!params.id || !params.type) {
            return problem('validation_failed', { error: 'Missing required parameters' });
        }
        const id: string = params.id;
        const type: string = params.type;

        // Validate image type
        if (!isValidImageType(type)) {
            return problem('validation_failed', {
                error: `Image type "${type}" is not valid. Valid types: ${VALID_IMAGE_TYPES.join(', ')}`,
            });
        }

        // Parse the ID (composite key or UUID)
        const parsed = parseMediaId(id);
        if (id.includes(':') && parsed.type === 'uuid') {
            return problem('validation_failed', {
                error: 'Composite keys must include provider, id, and media type (e.g., tmdb:123:movie).',
            });
        }

        try {
            const externalAccess =
                parsed.type === 'composite'
                    ? await resolveExternalArtworkAccess(
                          event,
                          parsed,
                          true,
                          url.searchParams.get('path') ?? undefined,
                      )
                    : null;
            if (externalAccess instanceof Response) return externalAccess;
            const service = getImageProxyService();

            // Parse options from URL; downgrade one tier when client opts into
            // Save-Data so a saver request gets a lighter variant from the same URL.
            const size = applySaveDataDowngrade(parseImageSize(url), request);
            const quality = url.searchParams.get('quality')
                ? parseInt(url.searchParams.get('quality')!, 10)
                : undefined;
            // Format negotiation: explicit ?format= wins, else AVIF if Accept
            // includes image/avif and IMAGE_AVIF_ENABLED, else WebP.
            const format = resolveImageFormat(url, request);
            const path = url.searchParams.get('path') ?? undefined;

            const options = {
                size,
                quality,
                format,
                ...(path ? { path } : {}),
                // `jellyfin:` keys reach the Jellyfin server ungated: admin only.
                allowUnmappedJellyfinFetch: localsIsAdmin(locals),
            };

            const isInternalImageId = parsed.type === 'uuid';
            let result;

            if (parsed.type === 'uuid') {
                if (!parsed.uuid) {
                    return problem('validation_failed', { error: 'UUID is missing or invalid.' });
                }

                // Library + age gate. Previously library-only; an age-
                // restricted caller could fetch posters/backdrops for over-
                // age UUIDs they otherwise can't browse.
                const sqlForAccess = getDb();
                if (sqlForAccess && locals.user) {
                    if (!(await checkMediaAccess(sqlForAccess, parsed.uuid, locals.user))) {
                        return ApiResponses.notFound();
                    }
                } else if (
                    !sqlForAccess &&
                    locals.user &&
                    !toLibraryAccessUser(locals.user)?.isAdmin
                ) {
                    return ApiResponses.error('Unable to verify content access');
                }

                result = await service.getImageByCatalogId(parsed.uuid, type, options);
            } else if (parsed.type === 'composite') {
                result = externalAccess
                    ? await fetchExternalArtwork(service, externalAccess, type, options)
                    : null;
            } else {
                logger.warn('Could not determine provider route', {
                    id,
                    type,
                    parsed,
                });
                return problem('validation_failed', {
                    error: 'Could not parse media ID or determine provider',
                    details: describeParsedId(parsed),
                });
            }

            if (!result) {
                logger.debug('Image not found', { id, type });
                // Don't cache 404s — the image may appear later (sync, manual upload).
                return new Response(null, {
                    status: 404,
                    headers: { 'Cache-Control': 'no-store' },
                });
            }

            const response = imageResponse(result, request);
            if (!isInternalImageId) response.headers.set('Cache-Control', 'private, no-cache');
            return response;
        } catch (error) {
            logger.error('Failed to fetch image', error as Error, {
                id,
                type,
            });
            return problem('internal_error', { error: 'Failed to fetch image' });
        }
    }),
);

/**
 * Describe parsed ID for error messages
 */
function describeParsedId(parsed: ParsedMediaId): string {
    if (parsed.type === 'uuid') {
        return `UUID: ${parsed.uuid}`;
    }
    if (parsed.type === 'composite') {
        return `Composite: ${parsed.provider}:${parsed.externalId}:${parsed.mediaType || 'unknown'}`;
    }
    return 'Unknown format';
}
