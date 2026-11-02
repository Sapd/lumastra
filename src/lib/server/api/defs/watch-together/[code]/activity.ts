// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/watch-together/[code]/activity.ts
 *
 *   POST /watch-together/{code}/activity → 204 No Content
 *
 * Host broadcasts an activity status (watching / searching / browsing) to guests.
 * Only the session host may broadcast activity.
 *
 * Auth: feature(FEATURE_WATCH_TOGETHER) → user
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { broadcastHostActivity } from '$lib/server/services/watch-together.service.js';
import {
    sessionCodeParamsSchema,
    hostActivitySchema,
    type HostActivityInput,
} from '$lib/schemas/watch-together.js';

const logger = Logger.for('WatchTogether');

export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_WATCH_TOGETHER',
        then: { kind: 'user' },
    },
    request: {
        params: sessionCodeParamsSchema,
        body: hostActivitySchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.principal ?? event.locals.user;
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!user?.username || !userId) return ApiProblem.unauthorized();

            const code = ((ctx.input?.params as { code?: string })?.code ?? event.params.code)!;
            const body = ctx.input?.body as HostActivityInput | undefined;
            const activity = body?.activity ?? 'watching';
            const message = body?.message;

            try {
                const ok = await broadcastHostActivity(code, userId, activity, message);
                if (!ok) {
                    return ApiProblem.forbidden('Only the host can broadcast activity');
                }
                return new Response(null, { status: 204 });
            } catch (err) {
                logger.error('Activity broadcast error', err as Error, { code });
                return ApiProblem.internalError('Failed to broadcast activity');
            }
        },
    },
});
