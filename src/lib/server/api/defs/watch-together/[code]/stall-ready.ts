// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/watch-together/[code]/stall-ready.ts
 *
 *   POST /watch-together/{code}/stall-ready → 204 No Content
 *
 * Reports that the caller's previously stalled playback has recovered and they
 * are ready to resume. Broadcasts a 'resume' event to all session participants.
 *
 * Auth: feature(FEATURE_WATCH_TOGETHER) → user
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { reportClientStallReady } from '$lib/server/services/watch-together.service.js';
import { sessionCodeParamsSchema, stallReadySchema } from '$lib/schemas/watch-together.js';

const logger = Logger.for('WatchTogether:StallReady');

export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_WATCH_TOGETHER',
        then: { kind: 'user' },
    },
    request: {
        params: sessionCodeParamsSchema,
        body: stallReadySchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.principal ?? event.locals.user;
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!user?.username || !userId) return ApiProblem.unauthorized();

            const code = (ctx.input?.params as { code?: string })?.code ?? event.params.code!;
            const clientId = (ctx.input?.body as { clientId?: string })?.clientId ?? '';
            const stallId = (ctx.input?.body as { stallId: string }).stallId;

            try {
                const ok = await reportClientStallReady(code, userId, clientId, stallId);
                if (!ok) return ApiProblem.forbidden('Not a participant in this session');

                logger.info('Client recovered from stall', { code, userId });
                return new Response(null, { status: 204 });
            } catch (err) {
                logger.error('Stall ready report error', err as Error, { code });
                return ApiProblem.internalError('Failed to report stall ready');
            }
        },
    },
});
