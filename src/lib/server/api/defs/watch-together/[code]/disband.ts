// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/watch-together/[code]/disband.ts
 *
 *   POST /watch-together/{code}/disband → 204 No Content
 *
 * Host disbands (ends) the session and broadcasts a session_ended event to all
 * participants. Only the session host may disband.
 *
 * Auth: feature(FEATURE_WATCH_TOGETHER) → user
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { disbandSession } from '$lib/server/services/watch-together.service.js';
import { sessionCodeParamsSchema } from '$lib/schemas/watch-together.js';

const logger = Logger.for('WatchTogether');

export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_WATCH_TOGETHER',
        then: { kind: 'user' },
    },
    request: {
        params: sessionCodeParamsSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.principal ?? event.locals.user;
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!user?.username || !userId) return ApiProblem.unauthorized();

            const code = ((ctx.input?.params as { code?: string })?.code ?? event.params.code)!;

            try {
                const ok = await disbandSession(code, userId);
                if (!ok) {
                    return ApiProblem.forbidden(
                        'Failed to disband session — you may not be the host',
                    );
                }
                return new Response(null, { status: 204 });
            } catch (err) {
                logger.error('Disband session error', err as Error, { code });
                return ApiProblem.internalError('Failed to disband session');
            }
        },
    },
});
