// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/watched/series/[seriesId]/set-progress
 *
 * "I'm at this episode." Marks every episode <= throughEpisodeId as watched
 * and every episode > as unwatched in one transaction, using effective custom
 * ordering numbers. Accepts two body shapes (discriminated union):
 *
 *   { throughEpisodeId: uuid }                    — mark up to episode
 *   { watchedIds: uuid[], unwatchedIds: uuid[] }  — explicit per-episode set
 *
 * Response: bare object { markedWatched, markedUnwatched }
 *
 * ID resolution: inline via mediaIdResolver (reads params.seriesId). Falls back
 * to the raw param when the value is already a UUID.
 */

import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import {
    SetSeriesProgressRequestSchema,
    SetSeriesProgressResponseSchema,
} from '$lib/schemas/api-admin-responses.js';
import { Logger } from '$lib/server/utils/logger.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';

const logger = Logger.for('SetSeriesProgressDef');

// Service-level validation errors that map to 422.
const VALIDATION_FRAGMENTS = [
    'Through-episode does not belong to this series',
    'Through-episode cannot be a special',
    'Episode(s) not in this series',
];

function isValidationError(message: string): boolean {
    return VALIDATION_FRAGMENTS.some((f) => message.includes(f));
}

/**
 * Resolve the `seriesId` path param to an internal UUID.
 * Prefers the middleware-populated value, falls back to inline resolution.
 */
async function resolveSeriesId(event: RequestEvent): Promise<string | null> {
    // 1. Pre-resolved by middleware (if the route applies withOptionalIdResolution).
    const fromMiddleware = event.locals.resolvedIds?.internalId;
    if (fromMiddleware) return fromMiddleware;

    const rawId = event.params.seriesId ?? '';

    // 2. Fast-path: bare UUID.
    if (UUID_RE.test(rawId)) return rawId;

    // 3. Composite key or other form — resolve inline.
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

    docs: {
        POST: {
            tags: ['Media'],
            summary: 'Set series watch progress',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Marks every episode up to `throughEpisodeId` as watched and every later episode as unwatched in one transaction, using effective custom ordering numbers — or applies an explicit watchedIds/unwatchedIds set.',
            body: SetSeriesProgressRequestSchema,
            responses: {
                200: {
                    schema: SetSeriesProgressResponseSchema,
                    description: 'Progress applied',
                },
                401: 'Authentication required',
                422: 'Validation failed — an unresolvable series, or an episode/through-episode not in this series',
                413: 'Request body exceeds the maximum size allowed for this endpoint',
            },
        },
    },

    request: {
        body: SetSeriesProgressRequestSchema,
        // watchedIds/unwatchedIds each allow up to SET_PROGRESS_MAX_IDS (5000)
        // GUIDs — ~390KB worst case, over mount()'s 256KB default (C15).
        maxBodyBytes: 1_000_000,
    },

    handlers: {
        POST: async (event, ctx) => {
            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const seriesId = await resolveSeriesId(event);
            if (!seriesId) {
                return ApiProblem.validationFailed([
                    { field: 'seriesId', message: 'Required or unresolvable' },
                ]);
            }

            const body = ctx.input?.body;
            if (!body) {
                return ApiProblem.validationFailed([{ field: 'body', message: 'Required' }]);
            }

            const { watchManager } = await import('$lib/server/services/watch-manager.service.js');

            try {
                const result = await watchManager.setSeriesProgress({
                    userId,
                    seriesId,
                    ...body,
                });

                const parsed = SetSeriesProgressResponseSchema.safeParse(result);
                if (!parsed.success) {
                    logger.error('setSeriesProgress returned unexpected shape', undefined);
                    return ApiProblem.internalError();
                }

                return json(parsed.data);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logger.warn(
                    'setSeriesProgress failed',
                    err instanceof Error ? err : new Error(message),
                );

                if (isValidationError(message)) {
                    return ApiProblem.validationFailed(message);
                }
                return ApiProblem.internalError(message);
            }
        },
    },
});
