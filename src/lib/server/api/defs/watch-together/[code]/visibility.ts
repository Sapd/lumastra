// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/watch-together/[code]/visibility.ts
 *
 *   POST /watch-together/{code}/visibility → 204 No Content
 *
 * Host toggles whether the session is publicly visible on the homepage.
 * Only the host may change visibility.
 *
 * Auth: feature(FEATURE_WATCH_TOGETHER) → user
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { setSessionVisibility } from '$lib/server/services/watch-together.service.js';
import { sessionCodeParamsSchema, visibilityChangeSchema } from '$lib/schemas/watch-together.js';

const logger = Logger.for('WatchTogether');

export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_WATCH_TOGETHER',
        then: { kind: 'user' },
    },
    request: {
        params: sessionCodeParamsSchema,
        body: visibilityChangeSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.principal ?? event.locals.user;
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!user?.username || !userId) return ApiProblem.unauthorized();

            const code = (ctx.input?.params as { code?: string })?.code ?? event.params.code!;
            const visibility =
                (ctx.input?.body as { visibility?: 'unlisted' | 'listed' })?.visibility ??
                'unlisted';

            try {
                const ok = await setSessionVisibility(code, userId, visibility);
                if (!ok) {
                    return ApiProblem.forbidden(
                        'Failed to change visibility — you may not be the host',
                    );
                }
                return new Response(null, { status: 204 });
            } catch (err) {
                logger.error('Visibility change error', err as Error, { code });
                return ApiProblem.internalError('Failed to change session visibility');
            }
        },
    },
});
