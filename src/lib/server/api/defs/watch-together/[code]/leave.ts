// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/watch-together/[code]/leave.ts
 *
 *   POST /watch-together/{code}/leave → 204 No Content
 *
 * Idempotent — succeeds even if the user is not a participant.
 *
 * Auth: feature(FEATURE_WATCH_TOGETHER) → user
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { leaveSession } from '$lib/server/services/watch-together.service.js';
import { sessionCodeParamsSchema, leaveSessionSchema } from '$lib/schemas/watch-together.js';

const logger = Logger.for('WatchTogether');

export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_WATCH_TOGETHER',
        then: { kind: 'user' },
    },
    request: {
        params: sessionCodeParamsSchema,
        body: leaveSessionSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.principal ?? event.locals.user;
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!user?.username || !userId) return ApiProblem.unauthorized();

            const code = (ctx.input?.params as { code?: string })?.code ?? event.params.code!;
            const clientId = (ctx.input?.body as { clientId?: string })?.clientId;

            try {
                await leaveSession(code, userId, clientId);
                return new Response(null, { status: 204 });
            } catch (err) {
                logger.error('Leave session error', err as Error, { code });
                return ApiProblem.internalError('Failed to leave session');
            }
        },
    },
});
