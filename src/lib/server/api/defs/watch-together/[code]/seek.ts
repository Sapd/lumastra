// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/watch-together/[code]/seek.ts
 *
 *   POST /watch-together/{code}/seek → 204 No Content
 *
 * Broadcasts a seek event to all session participants.
 * Host only: participants who are not the host are refused.
 *
 * Auth: feature(FEATURE_WATCH_TOGETHER) → user
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { broadcastSeek } from '$lib/server/services/watch-together.service.js';
import { sessionCodeParamsSchema, seekSchema } from '$lib/schemas/watch-together.js';

const logger = Logger.for('WatchTogether');

export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_WATCH_TOGETHER',
        then: { kind: 'user' },
    },
    request: {
        params: sessionCodeParamsSchema,
        body: seekSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.principal ?? event.locals.user;
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!user?.username || !userId) return ApiProblem.unauthorized();

            const code = (ctx.input?.params as { code?: string })?.code ?? event.params.code!;
            const body = ctx.input?.body as
                | {
                      currentTime: number;
                      clientId: string;
                      isPlaying?: boolean;
                      itemId?: string;
                      expectedTimelineId?: string;
                  }
                | undefined;
            const currentTime = body?.currentTime ?? 0;
            const clientId = body?.clientId ?? '';
            // undefined = legacy client → service falls back to session.isPlaying
            const isPlaying = body?.isPlaying;

            try {
                const ok = await broadcastSeek(
                    code,
                    userId,
                    currentTime,
                    clientId,
                    isPlaying,
                    body?.itemId,
                    body?.expectedTimelineId,
                );
                if (!ok) {
                    return ApiProblem.forbidden('Not a participant or session not found');
                }
                return new Response(null, { status: 204 });
            } catch (err) {
                logger.error('Broadcast seek error', err as Error, { code });
                return ApiProblem.internalError('Failed to broadcast seek');
            }
        },
    },
});
