// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/continue-watching/clear
 *
 * Bulk-clear continue-watching items by resetting playback positions to 0.
 * Accepts a `type` discriminator to target movies, episodes, or both.
 *
 * Body: { type: 'movies' | 'episodes' | 'both' }
 * Response: bare object { cleared: number, total?: number, message?: string }
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { clearContinueWatchingBodySchema } from '$lib/schemas/common.js';
import { ClearContinueWatchingResponseSchema } from '$lib/schemas/api-for-you-responses.js';
import { isMovie, isEpisode } from '$lib/server/utils/media-types.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('ContinueWatchingClearDef');

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    request: {
        body: clearContinueWatchingBodySchema,
    },

    handlers: {
        POST: async (event, ctx) => {
            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const body = ctx.input?.body;
            if (!body) return ApiProblem.validationFailed([{ field: 'body', message: 'Required' }]);

            const { type } = body;
            const { watchManager } = await import('$lib/server/services/watch-manager.service.js');

            try {
                const rows = await watchManager.getContinueWatching(userId, 500);

                const itemsToClear = rows.filter((row) => {
                    if (type === 'both') return true;
                    if (type === 'movies') return isMovie(row.media_type);
                    if (type === 'episodes') return isEpisode(row.media_type);
                    return false;
                });

                if (itemsToClear.length === 0) {
                    return json(
                        ClearContinueWatchingResponseSchema.parse({
                            cleared: 0,
                            message: 'No items to clear',
                        }),
                    );
                }

                let clearedCount = 0;
                if (type === 'both') {
                    await watchManager.clearWatchProgress({ userId });
                    clearedCount = itemsToClear.length;
                } else {
                    for (const row of itemsToClear) {
                        try {
                            await watchManager.clearWatchProgress({
                                userId,
                                mediaId: row.media_id,
                            });
                            clearedCount++;
                        } catch (err) {
                            logger.warn(
                                `Failed to clear progress for ${row.media_id}`,
                                err as Error,
                            );
                        }
                    }
                }

                logger.info(
                    `Cleared ${clearedCount}/${itemsToClear.length} continue watching items for ${userId} (type: ${type})`,
                );

                return json(
                    ClearContinueWatchingResponseSchema.parse({
                        cleared: clearedCount,
                        total: itemsToClear.length,
                    }),
                );
            } catch (error) {
                logger.error('Failed to clear continue watching', error as Error);
                return ApiProblem.internalError('Failed to clear continue watching');
            }
        },
    },
});
