// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/trending/clear-cache — clear all trending cache keys.
 *
 * Auth: user (any authenticated user may clear their own trending cache).
 * Response: bare object { cleared: number }
 * Errors: problem+json
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';

// Response shape — typed, no passthrough/any
export const TrendingCacheResponseSchema = z.object({
    cleared: z.number().int().min(0),
});

export type TrendingCacheResponse = z.infer<typeof TrendingCacheResponseSchema>;

const logger = Logger.for('TrendingCacheDef');

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    handlers: {
        POST: async (_event, _ctx) => {
            try {
                const { isValkeyReady, deleteKeysByPattern } =
                    await import('$lib/server/cache/valkey.js');

                if (!isValkeyReady()) {
                    return json({ cleared: 0 } satisfies TrendingCacheResponse);
                }

                const deleted = await deleteKeysByPattern('trending:*');
                if (deleted > 0) {
                    logger.info('Cleared trending cache keys', { cleared: deleted });
                }

                return json({ cleared: deleted } satisfies TrendingCacheResponse);
            } catch (err) {
                logger.error('Error clearing trending cache', err as Error);
                return ApiProblem.internalError('Failed to clear trending cache');
            }
        },
    },
});
