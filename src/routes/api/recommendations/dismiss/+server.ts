// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Dismiss API Endpoint
 *
 * Records when users dismiss items in "Because you watched" rows.
 * Used for real-time vector steering in recommendations.
 *
 * POST /api/recommendations/dismiss
 * Body: { sourceMediaKey: string, dismissedMediaKey: string }
 * Response: { dismissed: true, dismissCount: number }
 *
 * GET /api/recommendations/dismiss?source=tmdb:550:movie
 * Response: { sourceMediaKey, dismissCount, dismissedMediaKeys }
 *
 * DELETE /api/recommendations/dismiss?source=tmdb:550:movie
 * Response: { cleared: true, sourceMediaKey }
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { mount } from '$lib/server/api/mount.js';
import { aiDbService } from '$lib/server/services/database.service';
import { getDismissService } from '$lib/server/services/dismiss.service';
import { Logger } from '$lib/server/utils/logger';
import { dismissBodySchema, dismissQuerySchema } from '$lib/schemas/ai';
import {
    DismissRecommendationResponseSchema,
    GetDismissStateResponseSchema,
    ClearDismissStateResponseSchema,
} from '$lib/schemas/api-for-you-responses';

const logger = Logger.for('DismissEndpoint');

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: {
        // Shared query schema for GET and DELETE (source key).
        // POST body is read manually because mount() only carries one body schema
        // and the GET/DELETE methods do not have a body. We validate the POST body
        // inline using the existing dismissBodySchema.
        query: dismissQuerySchema,
        queryMethods: ['GET', 'DELETE'],
    },
    handlers: {
        /**
         * GET /api/recommendations/dismiss?source=<mediaKey>
         * Returns the current dismiss state (count + dismissed keys) for a source.
         */
        GET: async (event, ctx) => {
            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized('User not authenticated');

            const { source: sourceMediaKey } = ctx.input!.query;

            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('AI database unavailable');
            }

            try {
                const dismissService = getDismissService(sql);
                const dismissCount = await dismissService.getDismissCount(userId, sourceMediaKey);
                const dismissedKeys = await dismissService.getDismissedMediaKeys(
                    userId,
                    sourceMediaKey,
                );

                return json(
                    GetDismissStateResponseSchema.parse({
                        sourceMediaKey,
                        dismissCount,
                        dismissedMediaKeys: dismissedKeys,
                    }),
                );
            } catch (error) {
                logger.error('Failed to get dismiss state', error as Error, {
                    userId,
                    sourceMediaKey,
                });
                return ApiProblem.internalError('Failed to get dismiss state');
            }
        },

        /**
         * POST /api/recommendations/dismiss
         * Records a dismiss action for a source/dismissed pair.
         */
        POST: async (event, _ctx) => {
            const { locals } = event;
            const username = locals.user?.username;
            const userId = locals.user?.userId;
            if (!username || !userId) return ApiProblem.unauthorized('User not authenticated');

            // Age-restricted profiles cannot use dismiss feature (AI-powered)
            if (locals.user?.isAgeRestricted) {
                return ApiProblem.forbidden(
                    'This feature is not available for age-restricted profiles',
                );
            }

            // Parse and validate POST body manually (mount() skips body for shared query schema)
            let body: { sourceMediaKey: string; dismissedMediaKey: string };
            try {
                const raw: unknown = await readBoundedJson(event.request);
                const parsed = dismissBodySchema.safeParse(raw);
                if (!parsed.success) {
                    return ApiProblem.validationFailed(
                        parsed.error.issues.map((i) => ({
                            field: `body.${i.path.join('.')}`,
                            message: i.message,
                        })),
                    );
                }
                body = parsed.data;
            } catch {
                return ApiProblem.validationFailed('Request body must be valid JSON');
            }

            const { sourceMediaKey, dismissedMediaKey } = body;

            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('AI database unavailable');
            }

            try {
                const dismissService = getDismissService(sql);
                const result = await dismissService.recordDismiss(
                    userId,
                    sourceMediaKey,
                    dismissedMediaKey,
                );

                if (!result.success) {
                    return ApiProblem.internalError('Failed to record dismiss');
                }

                logger.info('Item dismissed', {
                    userId,
                    sourceMediaKey,
                    dismissedMediaKey,
                    dismissCount: result.dismissCount,
                });

                return json(
                    DismissRecommendationResponseSchema.parse({
                        dismissed: true,
                        dismissCount: result.dismissCount,
                    }),
                );
            } catch (error) {
                logger.error('Failed to dismiss item', error as Error, {
                    userId,
                    sourceMediaKey,
                    dismissedMediaKey,
                });
                return ApiProblem.internalError('Failed to dismiss item');
            }
        },

        /**
         * DELETE /api/recommendations/dismiss?source=<mediaKey>
         * Clears all dismiss state for a source media key.
         */
        DELETE: async (event, ctx) => {
            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized('User not authenticated');

            const { source: sourceMediaKey } = ctx.input!.query;

            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('AI database unavailable');
            }

            try {
                const dismissService = getDismissService(sql);
                await dismissService.clearDismissState(userId, sourceMediaKey);

                logger.info('Dismiss state cleared', { userId, sourceMediaKey });

                return json(
                    ClearDismissStateResponseSchema.parse({
                        cleared: true,
                        sourceMediaKey,
                    }),
                );
            } catch (error) {
                logger.error('Failed to clear dismiss state', error as Error, {
                    userId,
                    sourceMediaKey,
                });
                return ApiProblem.internalError('Failed to clear dismiss state');
            }
        },
    },
});

export const { GET, POST, DELETE } = mount(def, { surface: 'internal' });
