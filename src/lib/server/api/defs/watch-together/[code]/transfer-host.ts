// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/watch-together/[code]/transfer-host.ts
 *
 *   POST /watch-together/{code}/transfer-host → 204 No Content
 *
 * Current host transfers host status to another participant.
 * Only the current host may call this endpoint.
 *
 * Auth: feature(FEATURE_WATCH_TOGETHER) → user
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { transferHost } from '$lib/server/services/watch-together.service.js';
import { sessionCodeParamsSchema, transferHostSchema } from '$lib/schemas/watch-together.js';

const logger = Logger.for('WatchTogether');

export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_WATCH_TOGETHER',
        then: { kind: 'user' },
    },
    request: {
        params: sessionCodeParamsSchema,
        body: transferHostSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.principal ?? event.locals.user;
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!user?.username || !userId) return ApiProblem.unauthorized();

            const code = (ctx.input?.params as { code?: string })?.code ?? event.params.code!;
            const newHostUserId =
                (ctx.input?.body as { newHostUserId?: string })?.newHostUserId ?? '';

            try {
                const ok = await transferHost(code, userId, newHostUserId);
                if (!ok) {
                    return ApiProblem.forbidden(
                        'Failed to transfer host — you may not be the host or the target user is not a participant',
                    );
                }
                return new Response(null, { status: 204 });
            } catch (err) {
                logger.error('Transfer host error', err as Error, { code });
                return ApiProblem.internalError('Failed to transfer host');
            }
        },
    },
});
