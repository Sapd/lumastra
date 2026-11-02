// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/requests/quota.ts — GET /requests/quota
 *
 * Returns per-user, per-rolling-period request quota for `movie` and `series` buckets.
 *
 * Auth: user.
 * Rate-limit: 100 / 60 s (STANDARD preset).
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { config } from '$lib/server/config.js';
import { jellyseerrClient } from '$lib/server/jellyseerr.js';
import { getEffectiveUser } from '$lib/server/dev-user.js';
import { z } from 'zod';

const QuotaBucketSchema = z.object({
    limit: z.number().int().meta({ description: '0 = unlimited' }),
    used: z.number(),
    remaining: z.number().nullable().meta({ description: 'null when limit = 0 (unlimited)' }),
    days: z.number().meta({ description: 'Rolling window in days' }),
    restricted: z.boolean(),
});

const QuotaResponseSchema = z.object({
    quota: z
        .object({
            movie: QuotaBucketSchema,
            series: QuotaBucketSchema,
        })
        .nullable()
        .meta({ description: 'null when quota lookup is unavailable despite being linked' }),
    linked: z.boolean().meta({ description: 'Whether the user has a Jellyseerr account linked' }),
});

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Request'],
            summary: "Get the caller's request quota",
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns per-user, per-rolling-period request quota for `movie` and `series` buckets. ' +
                '`remaining: null` means unlimited (limit = 0). ' +
                '`linked: false` means the user has no Jellyseerr account — quota is not applicable. ' +
                'Rate-limited: 100 requests per 60 seconds.',
            responses: {
                200: {
                    schema: QuotaResponseSchema,
                    description: 'Request quota for movie and series buckets',
                },
                401: 'Authentication required',
                429: 'Request quota lookup budget exceeded',
                503: 'Jellyseerr unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    rateLimit: { limit: 100, windowSec: 60 },
    handlers: {
        /**
         * GET /requests/quota
         *
         * Returns the caller's request quota for `movie` and `series` buckets.
         *
         * Response shape:
         * ```jsonc
         * {
         *   "quota": {
         *     "movie":  { "limit": 5, "used": 1, "remaining": 4, "days": 7, "restricted": false },
         *     "series": { "limit": 3, "used": 0, "remaining": 3, "days": 7, "restricted": false }
         *   },
         *   "linked": true          // omitted when unavailable; false when not-linked
         * }
         * ```
         * `remaining: null` means unlimited (limit === 0).
         */
        GET: async (event, _ctx) => {
            const effectiveUsername = getEffectiveUser(
                event.request,
                event.locals.user?.username || config.DEFAULT_USER,
            );

            const link = await jellyseerrClient.resolveUserLink(effectiveUsername);
            if (link.state === 'unavailable') {
                // Dependency down → 503
                return ApiProblem.dependencyUnavailable('Jellyseerr is not reachable');
            }
            if (link.state === 'not_linked') {
                // Distinct signal: reachable but no account
                return json({ quota: null, linked: false });
            }

            try {
                const quota = await jellyseerrClient.getUserQuota(link.user.id);
                if (!quota) {
                    // Reachable + linked, but quota lookup failed (transient)
                    return json({ quota: null, linked: true });
                }

                // Canonicalise `tv` → `series`
                return json({
                    quota: {
                        movie: {
                            limit: quota.movie.limit,
                            used: quota.movie.used,
                            remaining: quota.movie.limit === 0 ? null : quota.movie.remaining,
                            days: quota.movie.days,
                            restricted: quota.movie.restricted,
                        },
                        series: {
                            limit: quota.tv.limit,
                            used: quota.tv.used,
                            remaining: quota.tv.limit === 0 ? null : quota.tv.remaining,
                            days: quota.tv.days,
                            restricted: quota.tv.restricted,
                        },
                    },
                    linked: true,
                });
            } catch {
                return ApiProblem.internalError('Failed to fetch request quota');
            }
        },
    },
});
