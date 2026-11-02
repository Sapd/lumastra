// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/watch-together/[code]/stall.ts
 *
 *   POST /watch-together/{code}/stall → 204 No Content
 *
 * Reports that the caller's playback has stalled (buffering). Broadcasts the
 * stall event to all session participants via Valkey pub/sub.
 *
 * Auth: feature(FEATURE_WATCH_TOGETHER) → user
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { reportClientStall, getSession } from '$lib/server/services/watch-together.service.js';
import { sessionCodeParamsSchema, stallSchema } from '$lib/schemas/watch-together.js';

const logger = Logger.for('WatchTogether:Stall');

export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_WATCH_TOGETHER',
        then: { kind: 'user' },
    },
    request: {
        params: sessionCodeParamsSchema,
        body: stallSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.principal ?? event.locals.user;
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!user?.username || !userId) return ApiProblem.unauthorized();

            const code = ((ctx.input?.params as { code?: string })?.code ?? event.params.code)!;
            const clientId = (ctx.input?.body as { clientId?: string })?.clientId ?? '';
            const stallId = (ctx.input?.body as { stallId: string }).stallId;

            try {
                const ok = await reportClientStall(
                    code,
                    userId,
                    clientId,
                    stallId,
                    (ctx.input?.body as { expectedTimelineId?: string }).expectedTimelineId,
                );
                if (!ok) {
                    // reportClientStall returns false for BOTH an unknown session
                    // and a known session the caller isn't part of. Distinguish so
                    // a missing session is 404 and a non-participant is 403.
                    const session = await getSession(code);
                    return session
                        ? ApiProblem.forbidden('Not a participant in this session')
                        : ApiProblem.notFound('Session not found');
                }

                logger.info('Client reported stall', { code, userId });
                return new Response(null, { status: 204 });
            } catch (err) {
                logger.error('Stall report error', err as Error, { code });
                return ApiProblem.internalError('Failed to report stall');
            }
        },
    },
});
