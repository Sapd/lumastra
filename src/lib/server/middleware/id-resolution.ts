// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media ID Resolution Middleware
 *
 * Resolves media IDs before passing to route handlers.
 * Injects resolved IDs into event.locals.resolvedIds for use by the handler.
 *
 * Accepts any ID format:
 * - UUID: 550e8400-e29b-41d4-a716-446655440000 (internal UUID)
 * - Composite: tmdb:550:movie (provider:id:mediaType)
 * - Dashless UUID: 550e8400e29b41d4a716446655440000
 * - A legacy Jellyfin item id an older client still holds, mapped through
 *   `external_ids` to the internal UUID (database lookup only)
 *
 * Usage:
 * export const GET = withIdResolution(async ({ locals }) => {
 *   const { internalId } = locals.resolvedIds;
 *   if (!internalId) return ApiResponses.notFound('...');
 * });
 */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { ApiResponses, getEndpointName } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { mediaIdResolver } from '../services/media-id-resolver.js';

const logger = Logger.for('IdResolutionMiddleware');

/**
 * Middleware that resolves media IDs before passing to handler.
 * Injects resolvedIds into locals for handler use.
 */
export function withIdResolution(handler: RequestHandler): RequestHandler {
    return async (event: RequestEvent): Promise<Response> => {
        const endpoint = getEndpointName(event);

        // Extract ID from params (try common param names)
        const params = event.params as Record<string, string | undefined>;
        const rawId = params.id || params.mediaId || params.itemId || params.seriesId;

        if (!rawId) {
            // No ID to resolve - let handler deal with it
            logger.debug('No ID to resolve', { endpoint });
            return handler(event);
        }

        try {
            // Resolve ID with caching
            const resolved = await mediaIdResolver.resolveAnyMediaId(rawId);

            // Inject into locals for handler
            event.locals.resolvedIds = resolved;

            logger.debug('ID resolved successfully', {
                endpoint,
                rawId,
                internalId: resolved.internalId,
                source: resolved.source,
                wasCanonicalized: resolved.wasCanonicalized,
                hasExternalIds: !!resolved.externalIds,
            });

            return handler(event);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            logger.warn('ID resolution failed', {
                endpoint,
                rawId,
                error: errorMessage,
            });

            // Return 400 for invalid format
            // For "not found" errors, only fail if it's truly unresolvable
            // (TMDB composite keys may resolve partially and allow API fallback)
            if (errorMessage.includes('Invalid media ID format')) {
                return ApiResponses.badRequest(
                    'Invalid media ID',
                    `Could not parse ID: ${errorMessage}`,
                    endpoint,
                );
            } else if (errorMessage.includes('not found')) {
                return ApiResponses.notFound('Media', endpoint);
            } else if (errorMessage.includes('Database connection not available')) {
                return ApiResponses.serviceUnavailable(
                    'Database',
                    'Database connection not available',
                    endpoint,
                );
            } else {
                return ApiResponses.error('ID resolution failed', errorMessage, 500, endpoint);
            }
        }
    };
}

/**
 * Optional: Middleware variant that only resolves if ID is present,
 * doesn't fail if ID is missing (for routes that accept optional IDs)
 */
export function withOptionalIdResolution(handler: RequestHandler): RequestHandler {
    return async (event: RequestEvent): Promise<Response> => {
        const endpoint = getEndpointName(event);

        // Extract ID from params
        const params = event.params as Record<string, string | undefined>;
        const rawId = params.id || params.mediaId || params.itemId || params.seriesId;

        if (!rawId) {
            // No ID provided - continue without resolution
            return handler(event);
        }

        try {
            // Attempt resolution
            const resolved = await mediaIdResolver.resolveAnyMediaId(rawId);
            event.locals.resolvedIds = resolved;

            logger.debug('Optional ID resolved', {
                endpoint,
                rawId,
                source: resolved.source,
            });

            return handler(event);
        } catch (error) {
            // Log but don't fail - handler can decide how to handle missing resolution
            logger.debug('Optional ID resolution failed', {
                endpoint,
                rawId,
                error: error instanceof Error ? error.message : 'Unknown error',
            });

            return handler(event);
        }
    };
}
