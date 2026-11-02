// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DELETE /api/continue-watching/[itemId]
 *
 * Clears a single continue-watching item by resetting its playback
 * position to 0 (removes it from the "Continue Watching" row).
 *
 * Response: bare object { cleared: boolean, itemId: string }
 *
 * ID resolution: inline via mediaIdResolver (reads the bound path param —
 * `itemId` on the internal mount, `id` on the v1 mount; see rawItemId).
 * When the item cannot be resolved returns { cleared: false, itemId }
 * (preserving legacy behaviour — the UI treats unresolvable IDs as no-op).
 */

import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import { ContinueWatchingDeleteResponseSchema } from '$lib/schemas/api-for-you-responses.js';

const logger = Logger.for('ContinueWatchingItemDef');

// Typed response — no passthrough.
const _ClearItemResponseSchema = z.object({
    cleared: z.boolean(),
    itemId: z.string(),
});
export type ClearItemResponse = z.infer<typeof _ClearItemResponseSchema>;

/**
 * The item id as bound by whichever route mounted this def.
 *
 * The internal route (/api/continue-watching/[itemId]) supplies `itemId`; the
 * public v1 route is mounted under `[id]` — the near-universal param name on
 * that surface, and the one already published in api-v1.yaml as
 * `/api/v1/continue-watching/{id}` — so it supplies `id`. Reading only one key
 * makes the other mount answer 422 to every request, which no client can
 * satisfy: a path param the route does not declare cannot be added by any
 * request shape. Accept either. Same fix as defs/playback/chapters.ts and
 * defs/lists/[id].ts.
 */
function rawItemId(event: RequestEvent): string {
    return event.params.itemId ?? event.params.id ?? '';
}

/**
 * Resolve the bound item path param to an internal UUID.
 * Prefers middleware-populated value; falls back to inline resolution.
 */
async function resolveMediaId(event: RequestEvent): Promise<string | null> {
    const fromMiddleware = event.locals.resolvedIds?.internalId;
    if (fromMiddleware) return fromMiddleware;

    const rawId = rawItemId(event);

    if (UUID_RE.test(rawId)) return rawId;

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

    // OpenAPI docs for the /api/v1/continue-watching/{id} (public/native)
    // surface. Migrated verbatim from the retired
    // src/routes/api/v1/continue-watching/[id]/_openapi.ts. `auth: 'bearer'`
    // + `stability: 'stable'` are carried over so the published security scheme
    // and stability tier stay byte-identical.
    docs: {
        DELETE: {
            tags: ['Continue Watching'],
            summary: 'Remove item from continue watching',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: ContinueWatchingDeleteResponseSchema,
                    description: 'Item removed from continue watching',
                },
                401: 'Authentication required',
                404: 'Not found',
                500: 'Internal server error',
            },
        },
    },

    handlers: {
        DELETE: async (event) => {
            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const itemId = rawItemId(event);
            if (!itemId) {
                return ApiProblem.validationFailed([{ field: 'itemId', message: 'Required' }]);
            }

            const mediaId = await resolveMediaId(event);

            if (!mediaId) {
                logger.warn('Could not resolve media ID for continue-watching clear', { itemId });
                return json({ cleared: false, itemId } satisfies ClearItemResponse);
            }

            const { watchManager } = await import('$lib/server/services/watch-manager.service.js');

            try {
                await watchManager.clearWatchProgress({ userId, mediaId });
                logger.debug(`Cleared local watch state for item ${itemId} (media_id: ${mediaId})`);
                logger.info(`Cleared progress for item ${itemId} by user ${userId}`);
                return json({ cleared: true, itemId } satisfies ClearItemResponse);
            } catch (error) {
                logger.error('Failed to clear continue watching item', error as Error);
                return ApiProblem.internalError('Failed to clear item');
            }
        },
    },
});
