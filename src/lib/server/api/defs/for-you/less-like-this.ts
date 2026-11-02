// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/v1/for-you/less-like-this — record a soft taste damper.
 *
 * NOT a rating — only biases For-You ranking away from similar content
 * for a while, then decays. See TasteDamperService.
 *
 * Body: { externalIds, mediaType, title? }
 * Response: { ok: true }
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { LessLikeThisRequestSchema } from '$lib/schemas/api-for-you-responses.js';
import { Logger } from '$lib/server/utils/logger.js';
import { LessLikeThisResponseSchema } from '$lib/schemas/api-for-you-responses';

const logger = Logger.for('LessLikeThisDef');

export const def = defineEndpoint({
    docs: {
        POST: {
            tags: ['For You'],
            summary: 'Show less like this',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Records a soft taste damper that biases For-You ranking away from similar ' +
                'content for a while, then decays. Not a rating. A down dependency returns ' +
                '`503 dependency_unavailable`.',
            body: LessLikeThisRequestSchema,
            responses: {
                200: { schema: LessLikeThisResponseSchema, description: 'Damper recorded' },
                401: 'Authentication required',
                404: 'Media not found',
                422: 'Validation failed',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    request: {
        body: LessLikeThisRequestSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.user;
            if (!user?.userId) return ApiProblem.unauthorized();

            const body = ctx.input?.body;
            if (!body) return ApiProblem.validationFailed([{ field: 'body', message: 'Required' }]);

            const { externalIds } = body;
            // Normalize canonical 'series' → legacy 'tv' for internal service calls.
            const mediaType: 'movie' | 'tv' = body.mediaType === 'movie' ? 'movie' : 'tv';

            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const { resolveAndGate, MediaAccessDeniedError, MediaNotResolvableError } =
                await import('$lib/server/utils/resolve-and-gate.js');

            let mediaId: string;
            try {
                ({ mediaId } = await resolveAndGate(sql, externalIds, mediaType, user));
            } catch (err) {
                if (err instanceof MediaNotResolvableError) {
                    return ApiProblem.validationFailed([
                        { field: 'externalIds', message: 'Could not resolve media' },
                    ]);
                }
                if (err instanceof MediaAccessDeniedError) {
                    return ApiProblem.notFound('Media');
                }
                throw err;
            }

            const { getTasteDamperService } =
                await import('$lib/server/services/taste-damper.service.js');
            await getTasteDamperService(sql).recordDamper(user.userId, mediaId, mediaType);

            // Invalidate AI suggestion pool so the next load regenerates damper-aware.
            try {
                const { clearUserSuggestions } =
                    await import('$lib/server/database/queries/suggestion-management.queries.js');
                await clearUserSuggestions(sql, user.userId);

                const { buildSearchAccessContext, scopedCacheKey } =
                    await import('$lib/server/utils/search-access-context.js');
                const { cacheManager, CACHE_NAMESPACES } =
                    await import('$lib/server/cache/index.js');
                const accessCtx = await buildSearchAccessContext(sql, user);
                const cacheKey = scopedCacheKey('sections:v2', accessCtx);
                await cacheManager
                    .for(CACHE_NAMESPACES.aiSuggestions)
                    .delete(cacheKey, user.userId);
            } catch (e) {
                logger.warn('Failed to invalidate AI suggestions after damper', {
                    error: e instanceof Error ? e.message : String(e),
                });
            }

            logger.debug('Recorded show-less-like-this', {
                userId: user.userId,
                mediaId,
                mediaType,
            });

            return json({ ok: true });
        },
    },
});
