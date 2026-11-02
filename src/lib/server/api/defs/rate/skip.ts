// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/rate/skip.ts — POST /api/rate/skip
 *
 * Durable skip beacon for the /rate swipe trainer. Persists the given
 * internal-UUID media ids into `user_rate_skips` so `buildRateQueue`
 * (defs/rate/queue.ts) excludes them for SKIP_SUPPRESSION_DAYS — fixing the
 * old local-only skip, which only suppressed a title for the current
 * served-set session and reappeared on the next reload/filter toggle.
 *
 * Best-effort/fire-and-forget from the client's perspective: `mediaIds` may
 * be empty (a no-op), and this endpoint never blocks or reverses the
 * client-side skip — a failed beacon just falls back to today's behavior.
 *
 * Auth: user; age-restricted profiles excluded (mirrors defs/rate/queue.ts);
 * rate-limited 20 req / 60 s per IP+username.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { RateSkipBodySchema, RateSkipResponseSchema } from '$lib/schemas/api-ai-responses.js';
import { recordSkips } from '$lib/server/database/queries/rate-skips.queries.js';

const logger = Logger.for('RateSkipDef');

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    docs: {
        POST: {
            tags: ['AI'],
            summary: 'Persist skip(s) for the rating-trainer queue (durable suppression)',
            stability: 'beta',
            auth: 'bearer',
            body: RateSkipBodySchema,
            responses: {
                200: { schema: RateSkipResponseSchema, description: 'Skip(s) recorded' },
                401: 'Authentication required',
                403: 'AI features unavailable for age-restricted profiles',
                429: 'Rate limited',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    request: {
        body: RateSkipBodySchema,
    },

    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            // Age-restricted profiles cannot use AI rating (feeds the AI taste
            // profile) — mirrors defs/rate/queue.ts.
            if (user.isAgeRestricted) {
                return ApiProblem.forbidden(
                    'AI features are not available for age-restricted profiles',
                );
            }

            // Rate-limit: 20 req / 60 s per IP+username (mirrors defs/rate/queue.ts).
            {
                const { checkRateLimit } =
                    await import('$lib/server/middleware/valkey-rate-limit.js');
                const { getClientIp } = await import('$lib/server/utils/client-ip.js');
                const ip = getClientIp(event);
                const key = `${ip}:${user.username}:rate-skip`;
                const rl = await checkRateLimit(key, 20, 60);
                if (!rl.allowed) {
                    const retryAfter = rl.resetAt - Math.floor(Date.now() / 1000);
                    return ApiProblem.rateLimited(retryAfter > 0 ? retryAfter : 60);
                }
            }

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const { mediaIds } = ctx.input!.body;
            // Defensive clamp — the body schema already caps at 100 and requires
            // uuid items, but drop any empty/falsy stragglers and DEDUPE before
            // writing: recordSkips does an unnest + ON CONFLICT DO UPDATE, and a
            // duplicate id in the same batch makes Postgres raise 21000 ("ON
            // CONFLICT DO UPDATE command cannot affect row a second time") for an
            // otherwise-valid request. Dedupe first, then cap.
            const cleanIds = [...new Set(mediaIds.filter((id) => !!id))].slice(0, 100);

            try {
                await recordSkips(sql, user.userId, cleanIds);
            } catch (err) {
                logger.error('Failed to record rate skips', err as Error);
                return ApiProblem.dependencyUnavailable('Database not available');
            }

            return json(RateSkipResponseSchema.parse({ ok: true }));
        },
    },
});
