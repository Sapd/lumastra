// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/ops/cache-warming — cache warming status and trigger endpoint def.
 *
 * GET  /api/admin/cache-warming → bare CacheWarmingStatus object.
 * POST /api/admin/cache-warming → { message } or 409 conflict.
 * Auth: admin. Errors: problem+json.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { json } from '@sveltejs/kit';
import { Logger } from '$lib/server/utils/logger.js';
import { getCacheWarmingStatus, triggerCacheWarming } from '$lib/server/cache/warming.js';
import { z } from 'zod';

const logger = Logger.for('CacheWarmingAPI');

const CacheWarmingBody = z.object({
    type: z.enum(['full', 'frequent', 'regular']).default('full'),
});

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: CacheWarmingBody,
    },
    handlers: {
        GET: async (_event, _ctx) => {
            const status = await getCacheWarmingStatus();
            return json({
                ...status,
                progress: {
                    ...status.progress,
                    startTime: status.progress.startTime?.toISOString() ?? null,
                    endTime: status.progress.endTime?.toISOString() ?? null,
                },
                lastRuns: {
                    frequent: {
                        ...status.lastRuns.frequent,
                        timestamp: status.lastRuns.frequent.timestamp?.toISOString() ?? null,
                    },
                    regular: {
                        ...status.lastRuns.regular,
                        timestamp: status.lastRuns.regular.timestamp?.toISOString() ?? null,
                    },
                    nightly: {
                        ...status.lastRuns.nightly,
                        timestamp: status.lastRuns.nightly.timestamp?.toISOString() ?? null,
                    },
                },
            });
        },

        POST: async (_event, ctx) => {
            const { type } = ctx.input!.body;

            logger.info('Manual cache warming triggered', { type });

            const result = await triggerCacheWarming(type);

            if (result.success) {
                return json({ message: result.message });
            } else {
                return ApiProblem.conflict(result.message);
            }
        },
    },
});
