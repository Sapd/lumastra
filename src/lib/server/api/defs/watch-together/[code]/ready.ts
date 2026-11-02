// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/watch-together/[code]/ready.ts
 *
 *   POST /watch-together/{code}/ready → 204 No Content
 *
 * Signals that the caller's buffer is full and they are ready to resume playback.
 * The host additionally sends their current position for accurate sync.
 *
 * Auth: feature(FEATURE_WATCH_TOGETHER) → user
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    getSessionWithParticipant,
    isHostClient,
    signalReady,
} from '$lib/server/services/watch-together.service.js';
import { sessionCodeParamsSchema, readySchema } from '$lib/schemas/watch-together.js';

const logger = Logger.for('WatchTogether');

export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_WATCH_TOGETHER',
        then: { kind: 'user' },
    },
    request: {
        params: sessionCodeParamsSchema,
        body: readySchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.principal ?? event.locals.user;
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!user?.username || !userId) return ApiProblem.unauthorized();

            const code = ((ctx.input?.params as { code?: string })?.code ?? event.params.code)!;
            const body = ctx.input?.body as
                { clientId: string; checkId: string; currentTime?: number } | undefined;
            const clientId = body?.clientId ?? '';
            const checkId = body?.checkId ?? '';
            const currentTime = body?.currentTime;

            try {
                const result = await getSessionWithParticipant(code, userId, clientId);
                if (!result) {
                    return ApiProblem.forbidden('Not a participant in this session');
                }
                const isHost = isHostClient(result.session, clientId, userId);
                await signalReady(code, clientId, checkId, isHost ? currentTime : undefined);
                return new Response(null, { status: 204 });
            } catch (err) {
                logger.error('Ready signal error', err as Error, { code });
                return ApiProblem.internalError('Failed to signal ready');
            }
        },
    },
});
