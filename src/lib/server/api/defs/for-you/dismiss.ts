// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/v1/for-you/dismiss  — set a for-you dismissal flag.
 * DELETE /api/v1/for-you/dismiss — clear the same flag.
 *
 * POST body: { targetId, targetType, flagType }
 * DELETE query: ?targetId=&targetType=&flagType= (same fields, no request body)
 *
 * flagType is limited to 'request_dismissed' | 'new_episode_alert_dismissed'.
 * 'dismissed_cw' is handled separately at /continue-watching/dismissals.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { ForYouDismissBodySchema } from '$lib/schemas/api-for-you-responses.js';
import { Logger } from '$lib/server/utils/logger.js';
import { OkAckResponseSchema } from '$lib/schemas/api-for-you-responses';

const logger = Logger.for('ForYouDismissDef');

const ForYouDismissQuerySchema = z.object(ForYouDismissBodySchema.shape);

export const def = defineEndpoint({
    docs: {
        POST: {
            tags: ['For You'],
            summary: 'Dismiss a home feed suggestion',
            stability: 'beta',
            auth: 'bearer',
            body: ForYouDismissBodySchema,
            responses: {
                200: { schema: OkAckResponseSchema, description: 'Dismissal flag set' },
                401: 'Authentication required',
                422: 'Validation failed',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['For You'],
            summary: 'Bring back a dismissed suggestion',
            stability: 'beta',
            auth: 'bearer',
            query: ForYouDismissQuerySchema,
            responses: {
                200: { schema: OkAckResponseSchema, description: 'Dismissal flag cleared' },
                401: 'Authentication required',
                422: 'Validation failed',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    request: {
        body: ForYouDismissBodySchema,
        bodyMethods: ['POST'],
        query: ForYouDismissQuerySchema,
        queryMethods: ['DELETE'],
    },
    handlers: {
        POST: async (event, ctx) => {
            const userId = event.locals.user?.userId;
            const username = event.locals.user?.username;
            if (!userId || !username) return ApiProblem.unauthorized();

            const body = ctx.input?.body;
            if (!body) return ApiProblem.validationFailed([{ field: 'body', message: 'Required' }]);

            const { targetId, targetType, flagType } = body;

            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const { setFlag } =
                await import('$lib/server/database/queries/user-media-flags.queries.js');

            try {
                await setFlag.execute(sql, { userId, targetId, targetType, flagType });

                if (flagType === 'request_dismissed') {
                    // Reconcile outward: this wrote the K-UUID flag shape only,
                    // which the popup's dismissedMap (keyed on the external-id
                    // composite) cannot see, and it left any unread
                    // `request.available` inbox row still unread. The sync
                    // service owns both — including this rail's own cache
                    // invalidation, so it is not repeated here.
                    // `targetId` for a request dismissal IS the internal UUID
                    // (see RecommendationFeed's handleItemRemove) and
                    // `targetType` is the dismissal taxonomy ('movie'/'series'),
                    // which `toStorageRequestType` normalizes.
                    const { scheduleRequestDismissalSync } =
                        await import('$lib/server/services/request-dismissal-sync.service.js');
                    scheduleRequestDismissalSync(
                        sql,
                        userId,
                        { mediaId: targetId, mediaType: targetType },
                        'for-you',
                    );
                }

                logger.debug('Dismissed for-you item', {
                    username,
                    targetId,
                    targetType,
                    flagType,
                });
                return json({ ok: true });
            } catch (err) {
                logger.error('Failed to dismiss for-you item', err as Error);
                return ApiProblem.internalError();
            }
        },

        DELETE: async (event, ctx) => {
            const userId = event.locals.user?.userId;
            const username = event.locals.user?.username;
            if (!userId || !username) return ApiProblem.unauthorized();

            const query = ctx.input?.query;
            if (!query)
                return ApiProblem.validationFailed([{ field: 'query', message: 'Required' }]);

            const { targetId, targetType, flagType } = query;

            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const { removeFlag } =
                await import('$lib/server/database/queries/user-media-flags.queries.js');

            try {
                await removeFlag(sql, { userId, targetId, flagType });

                if (flagType === 'request_dismissed') {
                    // Symmetry with the POST branch: clear the mirrored K-EXT
                    // row as well, or the popup stays suppressed by a flag the
                    // user just cleared here.
                    const { scheduleRequestUndismissalSync } =
                        await import('$lib/server/services/request-dismissal-sync.service.js');
                    scheduleRequestUndismissalSync(
                        sql,
                        userId,
                        { mediaId: targetId, mediaType: targetType },
                        'for-you',
                    );
                }

                logger.debug('Un-dismissed for-you item', {
                    username,
                    targetId,
                    targetType,
                    flagType,
                });
                return json({ ok: true });
            } catch (err) {
                logger.error('Failed to un-dismiss for-you item', err as Error);
                return ApiProblem.internalError();
            }
        },
    },
});
