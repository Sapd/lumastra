// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Catalog Image Proxy
 *
 * Provider-agnostic image endpoint that auto-selects the best available
 * image provider for a media item.
 *
 * Supports:
 * - UUID lookup: /api/image/catalog/550e8400-e29b-41d4-a716-446655440000/poster
 *
 * Falls back through providers in configured priority order.
 */

import type { RequestHandler } from './$types';
import { Logger } from '$lib/server/utils/logger';
import { isUuid, parseMediaId } from '$lib/server/utils/media-key-parser.js';
import { FALLBACK_IMAGE } from '$lib/constants/images';
import {
    getImageProxyService,
    imageResponse,
    lookupLegacyJellyfinImageMediaId,
} from '$lib/server/services/image-proxy';
import { parseQualityParam } from '$lib/server/utils/image-proxy';
import {
    parseImageSize,
    applySaveDataDowngrade,
    resolveImageFormat,
} from '$lib/server/utils/image-params.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { withImageProxyRateLimit } from '$lib/server/middleware/valkey-rate-limit';
import { VALID_IMAGE_TYPES, isValidImageType } from '$lib/server/utils/image-validation.js';
import { problem } from '$lib/server/api/problem.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { toLibraryAccessUser } from '$lib/server/cache/library-group-permissions-cache.js';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { getDb } from '$lib/server/database/index.js';
import {
    resolveExternalArtworkAccess,
    fetchExternalArtwork,
} from '$lib/server/utils/external-artwork-access.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

const logger = Logger.for('CatalogImage');

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
                error: `Invalid image type. Valid types: ${VALID_IMAGE_TYPES.join(', ')}`,
            });
        }

        const parsed = parseMediaId(id);
        try {
            const externalAccess =
                parsed.type === 'composite'
                    ? await resolveExternalArtworkAccess(event, parsed, true)
                    : null;
            if (externalAccess instanceof Response) return externalAccess;
            const service = getImageProxyService();

            // Parse options from URL; downgrade one tier when client opts into
            // Save-Data so /api/image/foo?size=card from a data-saver client
            // returns medium (and full → card, medium → thumb).
            const size = applySaveDataDowngrade(parseImageSize(url), request);
            const quality = parseQualityParam(url);
            // Format negotiation: explicit ?format= wins, else AVIF if Accept
            // includes image/avif and IMAGE_AVIF_ENABLED, else WebP.
            const format = resolveImageFormat(url, request);
            // Optional explicit pixel cap; used by the backdrop srcset for 1280w/1920w
            // variants that exceed the named size presets.
            // Clamp to [1, 3840] (4K) to prevent oversized-render DoS; invalid/non-numeric → omit.
            const rawMaxWidth = url.searchParams.get('maxWidth');
            const parsedMaxWidth = rawMaxWidth ? parseInt(rawMaxWidth, 10) : NaN;
            const maxWidth = Number.isFinite(parsedMaxWidth)
                ? String(Math.min(Math.max(parsedMaxWidth, 1), 3840))
                : undefined;

            const options = {
                size,
                quality,
                format,
                maxWidth,
                // An unmapped Jellyfin id has no Lumastra item to gate: only an
                // admin may have it fetched from the Jellyfin server.
                allowUnmappedJellyfinFetch: localsIsAdmin(locals),
            };

            const isInternalImageId = isUuid(id);
            let result;

            if (isUuid(id)) {
                // Primary path: UUID catalog lookup
                const sqlForAccess = getDb();
                if (sqlForAccess && locals.user) {
                    if (!(await checkMediaAccess(sqlForAccess, id, locals.user))) {
                        return ApiResponses.notFound();
                    }
                    // A legacy Jellyfin id is served as the item it maps to: gate that item.
                    const legacyTarget = await lookupLegacyJellyfinImageMediaId(sqlForAccess, id);
                    if (
                        legacyTarget &&
                        !(await checkMediaAccess(sqlForAccess, legacyTarget, locals.user))
                    ) {
                        return ApiResponses.notFound();
                    }
                } else if (
                    !sqlForAccess &&
                    locals.user &&
                    !toLibraryAccessUser(locals.user)?.isAdmin
                ) {
                    return ApiResponses.error('Unable to verify content access');
                }
                result = await service.getImageByCatalogId(id, type, options);
            } else {
                // Fallback: composite key (e.g. tmdb:271607:tv) — resolve via provider
                if (parsed.type === 'composite') {
                    logger.debug('Catalog route received composite key, resolving via provider', {
                        id,
                        type,
                    });
                    result = externalAccess
                        ? await fetchExternalArtwork(service, externalAccess, type, options)
                        : null;
                } else {
                    return problem('validation_failed', {
                        error: 'Invalid catalog ID. Expected UUID or composite key format.',
                    });
                }
            }

            if (!result) {
                // Don't cache the "image not found" outcome — the underlying image
                // may appear later (TMDB sync, manual upload), and a cached redirect
                // or 404 would prevent the real image from showing without a hard reload.
                const noStore = { 'Cache-Control': 'no-store' };

                // Callers that treat the image as optional decoration (e.g. player logo)
                // can opt out of the popcorn placeholder by passing ?fallback=none.
                if (url.searchParams.get('fallback') === 'none') {
                    return new Response(null, {
                        status: 404,
                        headers: noStore,
                    });
                }
                logger.debug('Catalog image returned null, redirecting to placeholder', {
                    id,
                    type,
                });
                return new Response(null, {
                    status: 302,
                    headers: { Location: FALLBACK_IMAGE, ...noStore },
                });
            }

            const response = imageResponse(result, request);
            if (!isInternalImageId) response.headers.set('Cache-Control', 'private, no-cache');
            return response;
        } catch (error) {
            logger.error('Failed to fetch catalog image', error as Error, {
                id,
                type,
            });
            return problem('internal_error', { error: 'Failed to fetch catalog image' });
        }
    }),
);
