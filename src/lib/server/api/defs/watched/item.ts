// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET/POST/DELETE /api/watched/[itemId]
 *
 * Cookie-session watched-state write/read for the SPA surface.
 * Delegates to the shared watched-state-ops implementation (same logic
 * as /api/v1/watch-state/[id]) so behaviour is defined exactly once.
 *
 * Response shape: bare object { watched, itemId }
 *   GET    → { watched: boolean, itemId: string }
 *   POST   → { watched: true,    itemId: string }  — mark watched
 *   DELETE → { watched: false,   itemId: string }  — mark unwatched
 *
 * ID resolution is performed inline: the def accepts a UUID, composite key,
 * or ?externalId= query param and resolves to the internal UUID via the
 * shared media-id-resolver. When the item cannot be resolved:
 *   GET    → { watched: false, itemId } (legacy behaviour)
 *   POST/DELETE → 404 not_found
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestEvent } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { watchedBodySchema } from '$lib/schemas/common.js';
import { Logger } from '$lib/server/utils/logger.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';

const logger = Logger.for('WatchedItemDef');

// Bare-object response — { watched, itemId }.
const _WatchedStatusResponseSchema = z.object({
    watched: z.boolean(),
    itemId: z.string().optional(),
});
export type WatchedStatusResponse = z.infer<typeof _WatchedStatusResponseSchema>;

/**
 * Resolve the `itemId` path param (UUID, composite key, or dashless UUID)
 * to an internal media UUID. Returns null when unresolvable.
 *
 * Mirrors the resolution contract of resolveCatalogInternalId but reads
 * `params.itemId` (not `params.id`) so the shared helper cannot be used
 * directly here.
 */
async function resolveItemId(event: RequestEvent): Promise<string | null> {
    // 1. Pre-resolved by optional middleware (rare — route file uses bare mount).
    const fromMiddleware = event.locals.resolvedIds?.internalId;
    if (fromMiddleware) return fromMiddleware;

    const rawId = event.params.itemId ?? '';

    // 2. Fast-path: bare UUID — no resolver round-trip.
    if (UUID_RE.test(rawId)) return rawId;

    // 3. Composite key or dashless UUID — resolve via shared resolver.
    if (rawId) {
        try {
            const { mediaIdResolver } = await import('$lib/server/services/media-id-resolver.js');
            const resolved = await mediaIdResolver.resolveAnyMediaId(rawId);
            return resolved.internalId ?? null;
        } catch {
            return null;
        }
    }

    return null;
}

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    request: {
        body: watchedBodySchema,
    },

    handlers: {
        GET: async (event) => {
            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const itemId = event.params.itemId;
            if (!itemId) {
                return ApiProblem.validationFailed([{ field: 'itemId', message: 'Required' }]);
            }

            const mediaUuid = await resolveItemId(event);
            if (!mediaUuid) {
                // Unresolvable id → treat as not-watched (legacy behaviour).
                return json({ watched: false, itemId } satisfies WatchedStatusResponse);
            }

            const { readWatchedStatus } = await import('$lib/server/services/watched-state-ops.js');
            const result = await readWatchedStatus(userId, mediaUuid, event.locals.user);
            if (result.kind === 'denied') return ApiProblem.notFound('Media');

            return json({ watched: result.watched, itemId } satisfies WatchedStatusResponse);
        },

        POST: async (event) => {
            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const itemId = event.params.itemId;
            if (!itemId) {
                return ApiProblem.validationFailed([{ field: 'itemId', message: 'Required' }]);
            }

            const mediaUuid = await resolveItemId(event);
            if (!mediaUuid) {
                logger.warn('POST /watched: could not resolve media UUID', { itemId });
                return ApiProblem.notFound('Could not resolve media item');
            }

            const { markWatchedOp } = await import('$lib/server/services/watched-state-ops.js');
            try {
                const result = await markWatchedOp(userId, mediaUuid, event.locals.user);
                if (result.kind === 'denied') return ApiProblem.notFound('Media');
            } catch (wsError) {
                logger.error(
                    'Failed to update watched status',
                    wsError instanceof Error ? wsError : new Error(String(wsError)),
                );
                return ApiProblem.internalError('Failed to update watched status');
            }

            return json({ watched: true, itemId } satisfies WatchedStatusResponse);
        },

        DELETE: async (event) => {
            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const itemId = event.params.itemId;
            if (!itemId) {
                return ApiProblem.validationFailed([{ field: 'itemId', message: 'Required' }]);
            }

            const mediaUuid = await resolveItemId(event);
            if (!mediaUuid) {
                logger.warn('DELETE /watched: could not resolve media UUID', { itemId });
                return ApiProblem.notFound('Could not resolve media item');
            }

            const { markUnwatchedOp } = await import('$lib/server/services/watched-state-ops.js');
            try {
                const result = await markUnwatchedOp(userId, mediaUuid, event.locals.user);
                if (result.kind === 'denied') return ApiProblem.notFound('Media');
            } catch (wsError) {
                logger.error(
                    'Failed to update watched status',
                    wsError instanceof Error ? wsError : new Error(String(wsError)),
                );
                return ApiProblem.internalError('Failed to update watched status');
            }

            return json({ watched: false, itemId } satisfies WatchedStatusResponse);
        },
    },
});
